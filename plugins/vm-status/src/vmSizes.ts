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
};
export type VmSize = {
  size: string;
  instanceType: string;
  specs: InstanceSpecs | null;
};
export type VmSizes = { sizes: VmSize[]; error: string | null };

// One request per page for every row/card that needs it; refreshed after 5 minutes.
let cache: { at: number; value: Promise<VmSizes> } | undefined;

/** Size -> instance type (platform `sizes.json`) with live AWS specs; undefined while loading. */
export function useVmSizes(): VmSizes | undefined {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [state, setState] = useState<VmSizes>();
  useEffect(() => {
    let live = true;
    if (!cache || Date.now() - cache.at > 5 * 60 * 1000) {
      const value = (async () => {
        const base = await discovery.getBaseUrl('vm-sizes');
        const response = await fetchApi.fetch(`${base}/sizes`);
        if (!response.ok) throw new Error(`VM sizes HTTP ${response.status}`);
        return (await response.json()) as VmSizes;
      })();
      cache = { at: Date.now(), value };
      value.catch(() => {
        cache = undefined;
      });
    }
    cache.value.then(
      value => live && setState(value),
      (error: Error) =>
        live && setState({ sizes: [], error: `Sizes unavailable: ${error.message}` }),
    );
    return () => {
      live = false;
    };
  }, [discovery, fetchApi]);
  return state;
}

export function describeSpecs(specs: InstanceSpecs): string {
  const parts = [];
  if (specs.vcpus !== null) parts.push(`${specs.vcpus} vCPU`);
  if (specs.memoryMiB !== null)
    parts.push(`${Number((specs.memoryMiB / 1024).toFixed(1))} GiB`);
  if (specs.architectures.length) parts.push(specs.architectures.join('/'));
  return parts.join(' · ');
}

/**
 * "S · t3.small · 2 vCPU · 2 GiB · x86_64". Uses the launched type recorded by the platform
 * (`cf/instance-type`) when present, otherwise the type the size currently maps to.
 */
export function vmSizeText(
  entity: Entity,
  size: string,
  sizes: VmSizes | undefined,
): string {
  const launched = entity.metadata.annotations?.['cf/instance-type'];
  const type =
    launched || sizes?.sizes.find(item => item.size === size)?.instanceType;
  if (!type) return size;
  const specs = sizes?.sizes.find(item => item.instanceType === type)?.specs;
  return [size, type, specs ? describeSpecs(specs) : '']
    .filter(Boolean)
    .join(' · ');
}
