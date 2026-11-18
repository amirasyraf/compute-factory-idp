import {
  DescribeInstanceStatusCommand,
  EC2Client,
  Instance,
  paginateDescribeInstances,
} from '@aws-sdk/client-ec2';
import { LoggerService } from '@backstage/backend-plugin-api';
import { ARM_VERSIONS, armList, azureConfigured } from './azure';
import { message } from './github';
import { PLATFORMS, fallbackLabel, platformLabel } from './platforms';

/** What the cloud reports for a VM's instance right now (CONTRACTS.md §8.3). */
export type ObservedVm = {
  platform: string;
  instanceId: string; // EC2 instance ID, or the Azure VM's ARM resource ID
  state: string; // pending | running | stopping | stopped | shutting-down
  health: 'ok' | 'impaired' | 'initializing' | 'unknown' | null; // null unless running
  instanceType: string | null;
  publicIp: string | null;
  requestId: string | null;
  team: string | null;
  launchedAt: string | null;
};
export type ObservedStatus = { checkedAt: string | null; error: string | null };

type Scanned = [string, ObservedVm][];

const ALIVE = ['running', 'pending', 'stopping', 'stopped', 'shutting-down'];

const tag = (instance: Instance, key: string) =>
  instance.Tags?.find(item => item.Key === key)?.Value ?? null;

function health(statuses: (string | undefined)[]): ObservedVm['health'] {
  if (statuses.includes('impaired')) return 'impaired';
  if (statuses.every(status => status === 'ok')) return 'ok';
  if (statuses.includes('initializing')) return 'initializing';
  return 'unknown';
}

/** One DescribeInstances (tag `cf:poc=true`) plus status checks for the running ones. */
async function scanAws(client: EC2Client): Promise<Scanned> {
  const instances: Instance[] = [];
  for await (const page of paginateDescribeInstances(
    { client },
    {
      Filters: [
        { Name: 'tag:cf:poc', Values: ['true'] },
        { Name: 'instance-state-name', Values: ALIVE },
      ],
    },
  ))
    for (const reservation of page.Reservations ?? [])
      instances.push(...(reservation.Instances ?? []));
  const running = instances
    .filter(item => item.State?.Name === 'running')
    .map(item => item.InstanceId!);
  const checks = new Map<string, ObservedVm['health']>();
  for (let i = 0; i < running.length; i += 100) {
    const result = await client.send(
      new DescribeInstanceStatusCommand({
        InstanceIds: running.slice(i, i + 100),
      }),
    );
    for (const status of result.InstanceStatuses ?? [])
      checks.set(
        status.InstanceId!,
        health([status.InstanceStatus?.Status, status.SystemStatus?.Status]),
      );
  }
  return instances
    .filter(instance => instance.InstanceId && tag(instance, 'cf:vm'))
    .map((instance): [string, ObservedVm] => {
      const state = instance.State?.Name ?? 'unknown';
      const view: ObservedVm = {
        platform: 'aws',
        instanceId: instance.InstanceId!,
        state,
        health:
          state === 'running'
            ? checks.get(instance.InstanceId!) ?? 'initializing'
            : null,
        instanceType: instance.InstanceType ?? null,
        publicIp: instance.PublicIpAddress ?? null,
        requestId: tag(instance, 'cf:request-id'),
        team: tag(instance, 'cf:team'),
        launchedAt: instance.LaunchTime?.toISOString() ?? null,
      };
      return [tag(instance, 'cf:vm')!, view];
    });
}

type Tags = Record<string, string> | undefined;
type AzureVm = {
  id: string;
  tags?: Tags;
  properties?: {
    provisioningState?: string;
    timeCreated?: string;
    hardwareProfile?: { vmSize?: string };
    instanceView?: { statuses?: { code?: string }[] };
  };
};
type PublicIp = { tags?: Tags; properties?: { ipAddress?: string } };
type Availability = {
  id?: string;
  properties?: { availabilityState?: string };
};

// Azure power states; "stopped" (guest shut down, still allocated) counts as stopped.
const POWER: Record<string, string> = {
  starting: 'pending',
  running: 'running',
  stopping: 'stopping',
  deallocating: 'stopping',
  stopped: 'stopped',
  deallocated: 'stopped',
};
const AVAILABILITY: Record<string, ObservedVm['health']> = {
  Available: 'ok',
  Unavailable: 'impaired',
  Degraded: 'impaired',
  Unknown: 'unknown',
};

/** VMs tagged `cf:poc=true` with their power state, Resource Health and public IP (Reader role). */
async function scanAzure(): Promise<Scanned> {
  const compute = `/providers/Microsoft.Compute/virtualMachines?api-version=${ARM_VERSIONS.compute}`;
  const ours = (await armList<AzureVm>(compute)).filter(
    vm => vm.tags?.['cf:poc'] === 'true' && vm.tags['cf:vm'],
  );
  if (!ours.length) return [];
  const [statuses, ips, availability] = await Promise.all([
    armList<AzureVm>(`${compute}&statusOnly=true`),
    armList<PublicIp>(
      `/providers/Microsoft.Network/publicIPAddresses?api-version=${ARM_VERSIONS.network}`,
    ),
    armList<Availability>(
      `/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=${ARM_VERSIONS.health}`,
    ),
  ]);
  // ARM resource IDs are case-insensitive.
  const power = new Map(
    statuses.map(vm => [
      vm.id.toLowerCase(),
      vm.properties?.instanceView?.statuses
        ?.find(status => status.code?.startsWith('PowerState/'))
        ?.code?.split('/')[1],
    ]),
  );
  const healthOf = new Map(
    availability
      .filter(item => item.id)
      .map(item => [
        item.id!.toLowerCase().split('/providers/microsoft.resourcehealth/')[0],
        item.properties?.availabilityState,
      ]),
  );
  return ours.map((vm): [string, ObservedVm] => {
    const tags = vm.tags!;
    const state =
      vm.properties?.provisioningState === 'Deleting'
        ? 'shutting-down'
        : POWER[power.get(vm.id.toLowerCase()) ?? ''] ?? 'pending';
    const ip = ips.find(
      item =>
        item.tags?.['cf:vm'] === tags['cf:vm'] &&
        item.tags?.['cf:request-id'] === tags['cf:request-id'] &&
        item.properties?.ipAddress,
    );
    const view: ObservedVm = {
      platform: 'azure',
      instanceId: vm.id,
      state,
      health:
        state === 'running'
          ? AVAILABILITY[healthOf.get(vm.id.toLowerCase()) ?? ''] ??
            'initializing'
          : null,
      instanceType: vm.properties?.hardwareProfile?.vmSize ?? null,
      publicIp: ip?.properties?.ipAddress ?? null,
      requestId: tags['cf:request-id'] ?? null,
      team: tags['cf:team'] ?? null,
      launchedAt: vm.properties?.timeCreated ?? null,
    };
    return [tags['cf:vm'], view];
  });
}

// Prefer the live instance over an older incarnation that is still shutting down.
const better = (a: ObservedVm, b: ObservedVm | undefined) =>
  !b || ALIVE.indexOf(a.state) < ALIVE.indexOf(b.state);

/**
 * Periodic VM health check of every platform, kept in memory per platform: one platform's failure
 * keeps its previous result and never affects the others. Read-only cloud calls only.
 */
export function createObserver(logger: LoggerService) {
  const ec2 = new EC2Client({ region: process.env.AWS_REGION });
  const scanners: Record<string, (() => Promise<Scanned>) | undefined> = {
    aws: () => scanAws(ec2),
    azure: azureConfigured() ? scanAzure : undefined,
  };
  const scans = new Map(
    PLATFORMS.map(id => [
      id,
      {
        checkedAt: null as string | null,
        error: scanners[id]
          ? null
          : `${fallbackLabel(id)} health check not configured`,
        label: fallbackLabel(id),
        vms: new Map<string, ObservedVm>(),
        inFlight: undefined as Promise<void> | undefined,
      },
    ]),
  );

  function pollOne(id: string) {
    const scan = scans.get(id)!;
    const scanner = scanners[id];
    if (!scanner) return Promise.resolve();
    scan.inFlight ??= (async () => {
      scan.label = await platformLabel(id, logger);
      const next = new Map<string, ObservedVm>();
      for (const [name, view] of await scanner())
        if (better(view, next.get(name))) next.set(name, view);
      scan.vms = next;
      scan.checkedAt = new Date().toISOString();
      scan.error = null;
    })()
      .catch(e => {
        scan.error = message(e);
        logger.warn(`VM health check (${id}) failed: ${scan.error}`);
      })
      .finally(() => {
        scan.inFlight = undefined;
      });
    return scan.inFlight;
  }

  return {
    /** Scan every platform now; concurrent callers share one scan per platform. Never throws. */
    async poll() {
      await Promise.all(PLATFORMS.map(pollOne));
    },
    /** The VM's instance on any platform: of incarnation `requestId` if given, else the liveliest. */
    get(name: string, requestId?: string): ObservedVm | null {
      let found: ObservedVm | undefined;
      for (const scan of scans.values()) {
        const view = scan.vms.get(name);
        if (!view || (requestId !== undefined && view.requestId !== requestId))
          continue;
        if (better(view, found)) found = view;
      }
      return found ?? null;
    },
    /**
     * One platform's last scan; without a platform, all of them: the oldest `checkedAt` (null
     * until every configured platform has completed a scan) and every error, prefixed with its platform.
     */
    status(platform?: string): ObservedStatus {
      if (platform !== undefined) {
        const scan = scans.get(platform);
        return scan
          ? { checkedAt: scan.checkedAt, error: scan.error }
          : {
              checkedAt: null,
              error: `No health check for platform ${platform}`,
            };
      }
      const all = [...scans.values()];
      // Unconfigured platforms never scan; they report their error but do not hold back checkedAt.
      const times = PLATFORMS.filter(id => scanners[id]).map(
        id => scans.get(id)!.checkedAt,
      );
      const errors = all
        .filter(scan => scan.error)
        .map(scan => `${scan.label}: ${scan.error}`);
      return {
        checkedAt: times.includes(null) ? null : times.sort()[0],
        error: errors.length ? errors.join('; ') : null,
      };
    },
  };
}

export type Observer = ReturnType<typeof createObserver>;
