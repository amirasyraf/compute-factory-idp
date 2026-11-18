import { useEffect, useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

export type InstanceSpecs = {
  vcpus: number | null;
  memoryMiB: number | null;
  architectures: string[];
  network: string | null;
  burstable: boolean;
  /** Enough free vCPU quota to launch it now; null = not known (AWS). */
  quotaOk?: boolean | null;
};
export type VmSize = {
  size: string;
  instanceType: string;
  specs: InstanceSpecs | null;
};
export type VmSizes = {
  platform?: string;
  label?: string;
  sizes: VmSize[];
  error: string | null;
};
/** A platform of the platform repo (`terraform/platforms/<id>`), or a "Coming soon" one. */
export type PlatformInfo = {
  id: string;
  label: string;
  available: boolean;
  os: { id: string; label: string; versions: string[] }[];
  reservedTagPrefixes: string[];
  forbiddenTagKeyCharacters: string;
  error: string | null;
};
export type CatalogInstanceType = InstanceSpecs & {
  type: string;
  family: string;
  category: string;
  currentGeneration: boolean;
  bareMetal: boolean;
  gpus: string | null;
};
export type InstanceTypeCatalog = {
  types: CatalogInstanceType[];
  error: string | null;
};
/** Demo mode on: only `allowed` instance types may be requested. */
export type DemoRestriction = { enabled: boolean; allowed: string[] };

type Cached<T> = { at: number; value: Promise<T> };
const caches = new Map<string, Cached<unknown>>();
const ttlMs = 5 * 60 * 1000;

// One request per page for every component that needs the same data.
function useCachedJson<T>(
  plugin: string,
  path: string,
  enabled: boolean,
  fallback: (error: Error) => T,
): T | undefined {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [state, setState] = useState<T>();
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const key = `${plugin}${path}`;
    let cached = caches.get(key) as Cached<T> | undefined;
    if (!cached || Date.now() - cached.at > ttlMs) {
      const value = (async () => {
        const base = await discovery.getBaseUrl(plugin);
        const response = await fetchApi.fetch(`${base}${path}`);
        const body = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(body.error ?? `HTTP ${response.status}`);
        return body as T;
      })();
      cached = { at: Date.now(), value };
      caches.set(key, cached);
      value.catch(() => caches.delete(key));
    }
    cached.value.then(
      value => live && setState(value),
      (error: Error) => live && setState(fallback(error)),
    );
    return () => {
      live = false;
    };
  }, [discovery, fetchApi, plugin, path, enabled, fallback]);
  return state;
}

const sizesFallback = (error: Error): VmSizes => ({
  sizes: [],
  error: `Sizes unavailable: ${error.message}`,
});
const catalogFallback = (error: Error): InstanceTypeCatalog => ({
  types: [],
  error: `Instance types unavailable: ${error.message}`,
});
const demoFallback = () => ({ enabled: false, instanceTypes: [] });
const platformsFallback = () => ({ platforms: [] as PlatformInfo[] });
const query = (platform: string) => `?platform=${encodeURIComponent(platform)}`;

/** Size -> instance type (that platform's `sizes.json`) with live specs; undefined while loading. */
export function useVmSizes(platform = 'aws'): VmSizes | undefined {
  return useCachedJson(
    'vm-sizes',
    `/sizes${query(platform)}`,
    true,
    sizesFallback,
  );
}

/** Every x86_64 instance type the platform offers in its region, with specs. Fetched only when `enabled`. */
export function useInstanceTypeCatalog(
  enabled = true,
  platform = 'aws',
): InstanceTypeCatalog | undefined {
  const value = useCachedJson<{
    types?: CatalogInstanceType[];
    error?: string | null;
  }>('vm-sizes', `/instance-types${query(platform)}`, enabled, catalogFallback);
  return value && { types: value.types ?? [], error: value.error ?? null };
}

/** Every platform with its images, including "Coming soon" ones; undefined while loading. */
export function usePlatforms(): PlatformInfo[] | undefined {
  return useCachedJson('vm-sizes', '/platforms', true, platformsFallback)
    ?.platforms;
}

const fallbackLabels: Record<string, string> = { aws: 'AWS', azure: 'Azure' };
/** Display name of a platform, e.g. "Azure". */
export function platformLabel(
  id: string | undefined,
  platforms: PlatformInfo[] | undefined,
): string {
  if (!id) return 'the cloud';
  return (
    platforms?.find(item => item.id === id)?.label ??
    fallbackLabels[id] ??
    id.toUpperCase()
  );
}
/** Display name of an OS image, e.g. "Ubuntu". */
export function osLabel(
  platform: string | undefined,
  os: string | undefined,
  platforms: PlatformInfo[] | undefined,
): string {
  if (!os) return '—';
  return (
    platforms
      ?.find(item => item.id === platform)
      ?.os.find(item => item.id === os)?.label ?? os
  );
}

export function useDemoRestriction(): DemoRestriction | undefined {
  const value = useCachedJson<{ enabled?: boolean; instanceTypes?: string[] }>(
    'vms',
    '/demo/state',
    true,
    demoFallback,
  );
  return (
    value && {
      enabled: Boolean(value.enabled),
      allowed: value.instanceTypes ?? [],
    }
  );
}

export function memoryText(memoryMiB: number | null): string {
  if (memoryMiB === null) return '—';
  return `${Number((memoryMiB / 1024).toFixed(memoryMiB < 1024 ? 2 : 1))} GiB`;
}

export function describeSpecs(specs: InstanceSpecs): string {
  const parts = [];
  if (specs.vcpus !== null) parts.push(`${specs.vcpus} vCPU`);
  if (specs.memoryMiB !== null) parts.push(memoryText(specs.memoryMiB));
  if (specs.architectures.length) parts.push(specs.architectures.join('/'));
  return parts.join(' · ');
}

function compute(entity: Entity | undefined): Record<string, unknown> {
  const value = (entity?.spec as { compute?: unknown } | undefined)?.compute;
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * "S · t3.small · 2 vCPU · 2 GiB · x86_64", or "Custom · m7i.large · …" for an Advanced pick.
 * Prefers the launched type recorded by the platform (`cf/instance-type`), then the requested
 * `compute.instanceType`, then the type the size maps to now. Specs for custom types come from
 * the region catalog, fetched only when such a VM is shown.
 */
export function useVmSizeText(entity: Entity | undefined): string {
  const spec = compute(entity);
  const platform =
    typeof spec.platform === 'string' && spec.platform ? spec.platform : 'aws';
  const sizes = useVmSizes(platform);
  const size = typeof spec.size === 'string' ? spec.size : undefined;
  const requested =
    typeof spec.instanceType === 'string' ? spec.instanceType : undefined;
  const launched = entity?.metadata.annotations?.['cf/instance-type'];
  const type =
    launched ||
    requested ||
    sizes?.sizes.find(item => item.size === size)?.instanceType;
  const sizeSpecs = sizes?.sizes.find(
    item => item.instanceType === type,
  )?.specs;
  const catalog = useInstanceTypeCatalog(
    Boolean(type && sizes && !sizeSpecs),
    platform,
  );
  const specs =
    sizeSpecs ?? catalog?.types.find(item => item.type === type) ?? null;
  const label = size ?? (requested ? 'Custom' : '—');
  if (!type) return label;
  return [label, type, specs ? describeSpecs(specs) : '']
    .filter(Boolean)
    .join(' · ');
}

/** Short badge text: the size letter(s), or a mark for an Advanced instance type. */
export function sizeBadge(entity: Entity | undefined): string {
  const spec = compute(entity);
  if (typeof spec.size === 'string') return spec.size.slice(0, 2);
  return typeof spec.instanceType === 'string' ? '◆' : '?';
}
