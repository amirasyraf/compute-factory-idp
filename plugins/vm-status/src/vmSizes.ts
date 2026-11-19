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
  /** The OS family whose sizes these are (`linux`, `windows`). */
  family?: string;
  /** Instance types with less memory cannot run the OS (Windows: 4096). */
  minMemoryMiB?: number;
  sizes: VmSize[];
  error: string | null;
};
/** A platform of the platform repo (`terraform/platforms/<id>`), or a "Coming soon" one. */
export type PlatformInfo = {
  id: string;
  label: string;
  available: boolean;
  os: {
    id: string;
    label: string;
    versions: string[];
    family?: string;
    minMemoryMiB?: number;
  }[];
  reservedTagPrefixes: string[];
  forbiddenTagKeyCharacters: string;
  /** The public IP survives stop/start and resize. */
  staticPublicIp?: boolean;
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

/**
 * Size -> instance type (that platform's `sizes.json`, for the OS's family) with live specs;
 * undefined while loading. Without an OS, Linux sizes.
 */
export function useVmSizes(platform = 'aws', os?: string): VmSizes | undefined {
  return useCachedJson(
    'vm-sizes',
    `/sizes${query(platform)}${os ? `&os=${encodeURIComponent(os)}` : ''}`,
    true,
    sizesFallback,
  );
}

/** One software catalog entry and the OS families that offer it. */
export type SoftwareItem = { id: string; label: string; families: string[] };
const softwareFallback = (error: Error) => ({
  software: [] as SoftwareItem[],
  error: `Software catalog unavailable: ${error.message}`,
});
/** The platform repo's software catalog; undefined while loading. */
export function useSoftwareCatalog():
  | { software: SoftwareItem[]; error?: string }
  | undefined {
  return useCachedJson('vm-sizes', '/software', true, softwareFallback);
}

/** The OS family (`linux`, `windows`) of a platform's OS, once platforms are loaded. */
export function osFamily(
  platform: string | undefined,
  os: string | undefined,
  platforms: PlatformInfo[] | undefined,
): string | undefined {
  return platforms
    ?.find(item => item.id === platform)
    ?.os.find(item => item.id === os)?.family;
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

type ImageAvailability = { os: string; version: string; available: boolean };

/** Refresh only while the launch image picker is open. Unknown images are not selectable. */
export function useImageAvailability(platform: string | undefined) {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [state, setState] = useState<{
    platform: string;
    images: ImageAvailability[];
  }>();
  useEffect(() => {
    if (!platform) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh(id: string) {
      let images: ImageAvailability[] = [];
      try {
        const base = await discovery.getBaseUrl('vm-sizes');
        const response = await fetchApi.fetch(
          `${base}/image-availability${query(id)}`,
          { signal: controller.signal },
        );
        if (response.ok) {
          const result = (await response.json()).images;
          if (Array.isArray(result)) images = result;
        }
      } catch {
        // Fail closed rather than retaining a stale positive result.
      }
      if (!controller.signal.aborted) {
        setState({ platform: id, images });
        timer = setTimeout(() => void refresh(id), 20_000);
      }
    }
    void refresh(platform);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [discovery, fetchApi, platform]);
  return state?.platform === platform ? state?.images : undefined;
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
  const sizes = useVmSizes(
    platform,
    typeof spec.os === 'string' ? spec.os : undefined,
  );
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
