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
export type RunView = {
  id: number;
  kind: 'provision' | 'refry' | 'destroy';
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

export function useVmsApi() {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  return useMemo(() => {
    async function request<T>(path: string, method = 'GET'): Promise<T> {
      const base = await discovery.getBaseUrl('vms');
      const response = await fetchApi.fetch(`${base}${path}`, { method });
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
      latest: (name: string) =>
        request<{ runs: RunView[] }>(
          `/runs?name=${encodeURIComponent(name)}&limit=1`,
        ),
      summary: () =>
        request<{ vms: { name: string; latest: RunView }[] }>('/summary'),
      action: (id: number, action: 'retry' | 'skip') =>
        request<RunView>(`/runs/${id}/${action}`, 'POST'),
    };
  }, [discovery, fetchApi]);
}

/** One summary request per list, never a request per row. */
export function useRunSummary() {
  const api = useVmsApi();
  const [runs, setRuns] = useState<Record<string, RunView>>({});
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
        setError(undefined);
      } catch (e) {
        if (!disposed) {
          setRuns({});
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
  return { runs, error };
}

export function runVmStatus(run: RunView | undefined, fallback?: string) {
  if (!run) return fallback;
  if (run.status === 'failed') return 'failed';
  if (run.status === 'cancelled') return fallback;
  if (run.kind === 'destroy') return 'destroying';
  return run.status === 'succeeded' ? 'ready' : 'frying';
}
