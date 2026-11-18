import { useCallback, useSyncExternalStore } from 'react';
import { Entity } from '@backstage/catalog-model';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import {
  ObservedResponse,
  ObservedVm,
  RunView,
  runVmStatus,
  useVmsApi,
} from './runs';
import { vmRunLabel, vmState } from './pipeline';

export type VmLive = {
  /** The catalog entity as last fetched; `removed` once it is gone (destroy deletes it last). */
  entity?: Entity;
  removed?: boolean;
  entityError?: string;
  entityCheckedAt?: Date;
  /** Newest first; undefined until the first load. */
  runs?: RunView[];
  runsError?: string;
  observed?: ObservedResponse;
  observedError?: string;
};

type Api = ReturnType<typeof useVmsApi>;
type Catalog = typeof catalogApiRef.T;
type Store = {
  value: VmLive;
  listeners: Set<() => void>;
  refresh: () => void;
  stop: () => void;
};

const RUNS_MS = 5000;
const OBSERVED_MS = 15000;
const ENTITY_MS = 10000;
const stores = new Map<string, Store>();
const empty: VmLive = {};

// One poller per VM name, shared by the VM page header and its cards.
function createStore(name: string, api: Api, catalog: Catalog): Store {
  const store: Store = {
    value: {},
    listeners: new Set(),
    refresh: () => {},
    stop: () => {},
  };
  const set = (patch: Partial<VmLive>) => {
    store.value = { ...store.value, ...patch };
    store.listeners.forEach(listener => listener());
  };
  let disposed = false;
  const timers: Record<string, number> = {};
  const loop = (key: string, ms: number, load: () => Promise<void>) => {
    const tick = async () => {
      window.clearTimeout(timers[key]);
      await load();
      // A destroyed VM has nothing left to poll.
      if (!disposed && !store.value.removed)
        timers[key] = window.setTimeout(tick, ms);
    };
    tick();
    return tick;
  };
  const runs = loop('runs', RUNS_MS, async () => {
    try {
      const result = await api.list(name, 10);
      if (!disposed) set({ runs: result.runs, runsError: undefined });
    } catch (e) {
      if (!disposed) set({ runsError: (e as Error).message });
    }
  });
  const observed = loop('observed', OBSERVED_MS, async () => {
    try {
      const result = await api.observed(name);
      if (!disposed) set({ observed: result, observedError: undefined });
    } catch (e) {
      if (!disposed) set({ observedError: (e as Error).message });
    }
  });
  const entity = loop('entity', ENTITY_MS, async () => {
    try {
      const result = await catalog.getEntityByRef({
        kind: 'resource',
        namespace: 'default',
        name,
      });
      if (!disposed)
        set({
          entity: result,
          removed: !result,
          entityError: undefined,
          entityCheckedAt: new Date(),
        });
    } catch (e) {
      if (!disposed) set({ entityError: (e as Error).message });
    }
  });
  store.refresh = () => {
    runs();
    observed();
    entity();
  };
  store.stop = () => {
    disposed = true;
    Object.values(timers).forEach(timer => window.clearTimeout(timer));
  };
  return store;
}

/** Latest runs and health check for one VM, polled while any component uses them. */
export function useVmLive(name: string): VmLive & { refresh: () => void } {
  const api = useVmsApi();
  const catalog = useApi(catalogApiRef);
  const subscribe = useCallback(
    (listener: () => void) => {
      let store = stores.get(name);
      if (!store) {
        store = createStore(name, api, catalog);
        stores.set(name, store);
      }
      store.listeners.add(listener);
      return () => {
        store!.listeners.delete(listener);
        if (!store!.listeners.size) {
          store!.stop();
          stores.delete(name);
        }
      };
    },
    [name, api, catalog],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => stores.get(name)?.value ?? empty,
  );
  const refresh = useCallback(() => stores.get(name)?.refresh(), [name]);
  return { ...value, refresh };
}

/** Display state of one VM from its entity, latest run and health check. */
export function deriveVm(entity: Entity, live: VmLive) {
  const annotations = entity.metadata.annotations ?? {};
  const latest = live.runs?.[0];
  const health = live.observed;
  // undefined: no health check yet (or none in this environment); null: no instance found.
  let observed: ObservedVm | null | undefined;
  if (health?.checkedAt)
    observed =
      health.vm && health.vm.requestId === annotations['cf/request-id']
        ? health.vm
        : null;
  const status = runVmStatus(latest, annotations['cf/status'], observed);
  const state = vmState(status);
  return {
    latest,
    observed,
    status,
    state,
    label: vmRunLabel(latest, annotations['cf/status'], observed),
    /** A run is in progress, so only Destroy is offered. */
    busy: latest?.status === 'running',
    /** An unfinished provision must be retried, skipped or destroyed first. */
    incomplete: latest?.kind === 'provision' && latest.status !== 'succeeded',
    power: observed?.state,
    ip:
      (observed === undefined
        ? annotations['cf/public-ip']
        : observed?.publicIp) || '',
    // Every VM's inventory records its login user; the fallback covers only older entries.
    user: annotations['cf/ssh-user'] || 'ubuntu',
  };
}
