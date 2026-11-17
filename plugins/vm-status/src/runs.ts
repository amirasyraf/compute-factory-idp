import { useEffect, useMemo, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

export type StageView = {
  id: string;
  status:
    | 'pending'
    | 'running'
    | 'retrying'
    | 'success'
    | 'failed'
    | 'skipped'
    | 'cancelled';
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  skippable: boolean;
  skippedBy: string | null;
  retriedBy: string | null;
  outcome: 'ready' | 'failed' | null;
  summary: string | null;
  runUrl: string | null;
  steps: { name: string; status: string }[];
  attempts: {
    attempt: number;
    runUrl: string | null;
    conclusion: string;
    error: string | null;
    finishedAt: string;
  }[];
};
export type RunKind =
  | 'provision'
  | 'modify'
  | 'reapply'
  | 'power'
  | 'update'
  | 'destroy';
export type RunView = {
  id: number;
  kind: RunKind;
  name: string;
  team: string;
  requestId: string;
  requestedBy: string;
  status: 'running' | 'failed' | 'succeeded' | 'cancelled';
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  actions: { retry: boolean; skip: boolean };
  stages: StageView[];
};

/** The VM's instance as the IDP health check last saw it in AWS. */
export type ObservedVm = {
  instanceId: string;
  state: string; // pending | running | stopping | stopped | shutting-down
  health: 'ok' | 'impaired' | 'initializing' | 'unknown' | null;
  instanceType: string | null;
  publicIp: string | null;
  requestId: string | null;
  team: string | null;
  launchedAt: string | null;
};
export type ObservedResponse = {
  enabled: boolean;
  checkedAt: string | null;
  error: string | null;
  vm: ObservedVm | null;
};
export type VmOperation =
  | 'modify'
  | 'reapply'
  | 'start'
  | 'stop'
  | 'reboot'
  | 'update'
  | 'destroy';

export function useVmsApi() {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  return useMemo(() => {
    async function request<T>(
      path: string,
      method = 'GET',
      payload?: unknown,
    ): Promise<T> {
      const base = await discovery.getBaseUrl('vms');
      const response = await fetchApi.fetch(`${base}${path}`, {
        method,
        ...(payload === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body === undefined) {
        let message = `VM API: ${response.status}`;
        if (typeof body?.error === 'string') message = body.error;
        else if (typeof body?.error?.message === 'string')
          message = body.error.message;
        throw new Error(message);
      }
      return body;
    }
    return {
      getRun: (id: string | number) =>
        request<RunView>(`/runs/${encodeURIComponent(id)}`),
      list: (name: string, limit = 10) =>
        request<{ runs: RunView[] }>(
          `/runs?name=${encodeURIComponent(name)}&limit=${limit}`,
        ),
      observed: (name: string) =>
        request<ObservedResponse>(`/observed/${encodeURIComponent(name)}`),
      summary: () =>
        request<{
          observedAt: string | null;
          vms: {
            name: string;
            latest: RunView;
            observed: ObservedVm | null;
          }[];
        }>('/summary'),
      action: (id: number, action: 'retry' | 'skip') =>
        request<RunView>(`/runs/${id}/${action}`, 'POST'),
      /** Start a day-2 run; `requestKey` makes a repeated submit return the same run. */
      operate: (body: {
        operation: VmOperation;
        vm: string;
        requestKey: string;
      }) => request<{ runId: number; runUrl: string }>('/runs', 'POST', body),
      /** Browser terminal: one SSH session from the IDP to the VM (long-polled output). */
      terminal: {
        open: (vm: string, cols: number, rows: number) =>
          request<{ id: string; host: string; user: string }>(
            '/terminal',
            'POST',
            { vm, cols, rows },
          ),
        output: (id: string, after: number) =>
          request<{ seq: number; data: string; closed: string | null }>(
            `/terminal/${encodeURIComponent(id)}/output?after=${after}`,
          ),
        input: (id: string, data: string) =>
          request<{}>(`/terminal/${encodeURIComponent(id)}/input`, 'POST', {
            data,
          }),
        resize: (id: string, cols: number, rows: number) =>
          request<{}>(`/terminal/${encodeURIComponent(id)}/input`, 'POST', {
            cols,
            rows,
          }),
        close: (id: string) =>
          request<{}>(`/terminal/${encodeURIComponent(id)}`, 'DELETE'),
      },
    };
  }, [discovery, fetchApi]);
}

/** One summary request per list, never a request per row. */
export function useRunSummary() {
  const api = useVmsApi();
  const [runs, setRuns] = useState<Record<string, RunView>>({});
  // A VM name maps to null when the health check ran but found no instance of it.
  const [observed, setObserved] = useState<Record<string, ObservedVm | null>>(
    {},
  );
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let fetching = false;
    async function load() {
      if (fetching) return;
      fetching = true;
      try {
        const result = await api.summary();
        if (disposed) return;
        setRuns(Object.fromEntries(result.vms.map(vm => [vm.name, vm.latest])));
        setObserved(
          result.observedAt
            ? Object.fromEntries(result.vms.map(vm => [vm.name, vm.observed]))
            : {},
        );
        setError(undefined);
      } catch (e) {
        if (!disposed) {
          setRuns({});
          setObserved({});
          setError((e as Error).message);
        }
      } finally {
        fetching = false;
        if (!disposed) timer = window.setTimeout(load, 5000);
      }
    }
    load();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [api]);
  return { runs, observed, error };
}

/**
 * Coarse VM status: the latest run while it is active or failed, else the catalog status refined
 * by the health check (`observed`: undefined = not known, null = no instance found).
 */
export function runVmStatus(
  run: RunView | undefined,
  fallback?: string,
  observed?: ObservedVm | null,
) {
  let status = fallback;
  if (run) {
    // Includes the short window in which finalize records a stage that failed for good.
    const failedStage = run.stages.some(
      stage => stage.status === 'failed' && stage.id !== 'finalize',
    );
    if (run.status === 'failed' || (run.status === 'running' && failedStage))
      return 'failed';
    if (run.kind === 'destroy' && run.status !== 'cancelled')
      return 'destroying';
    if (run.status === 'running') return 'frying';
    if (run.status === 'succeeded') status = 'ready';
  }
  if (status !== 'ready' || observed === undefined) return status;
  if (observed === null) return 'missing';
  return observed.state === 'running' ? 'ready' : observed.state;
}
