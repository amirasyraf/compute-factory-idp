import {
  DescribeInstanceStatusCommand,
  EC2Client,
  Instance,
  paginateDescribeInstances,
} from '@aws-sdk/client-ec2';
import { LoggerService } from '@backstage/backend-plugin-api';
import { message } from './github';

/** What AWS reports for a VM's instance right now (CONTRACTS.md §8.3). */
export type ObservedVm = {
  instanceId: string;
  state: string; // pending | running | stopping | stopped | shutting-down
  health: 'ok' | 'impaired' | 'initializing' | 'unknown' | null; // EC2 status checks; null unless running
  instanceType: string | null;
  publicIp: string | null;
  requestId: string | null;
  team: string | null;
  launchedAt: string | null;
};

const ALIVE = ['running', 'pending', 'stopping', 'stopped', 'shutting-down'];

const tag = (instance: Instance, key: string) =>
  instance.Tags?.find(item => item.Key === key)?.Value ?? null;

function health(statuses: (string | undefined)[]): ObservedVm['health'] {
  if (statuses.includes('impaired')) return 'impaired';
  if (statuses.every(status => status === 'ok')) return 'ok';
  if (statuses.includes('initializing')) return 'initializing';
  return 'unknown';
}

/**
 * Periodic VM health check: one DescribeInstances (tag `cf:poc=true`) plus status checks for the
 * running ones. Kept in memory; the IDP host role grants only these read-only calls.
 */
export function createObserver(logger: LoggerService) {
  const client = new EC2Client({ region: process.env.AWS_REGION });
  let checkedAt: string | null = null;
  let error: string | null = null;
  let vms = new Map<string, ObservedVm>();
  let inFlight: Promise<void> | undefined;

  async function scan() {
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
    const next = new Map<string, ObservedVm>();
    for (const instance of instances) {
      const name = tag(instance, 'cf:vm');
      if (!name || !instance.InstanceId) continue;
      const state = instance.State?.Name ?? 'unknown';
      const view: ObservedVm = {
        instanceId: instance.InstanceId,
        state,
        health:
          state === 'running'
            ? checks.get(instance.InstanceId) ?? 'initializing'
            : null,
        instanceType: instance.InstanceType ?? null,
        publicIp: instance.PublicIpAddress ?? null,
        requestId: tag(instance, 'cf:request-id'),
        team: tag(instance, 'cf:team'),
        launchedAt: instance.LaunchTime?.toISOString() ?? null,
      };
      // An older incarnation can still be shutting down; prefer the live one.
      const current = next.get(name);
      if (!current || ALIVE.indexOf(state) < ALIVE.indexOf(current.state))
        next.set(name, view);
    }
    vms = next;
    checkedAt = new Date().toISOString();
    error = null;
  }

  return {
    /** Scan now; concurrent callers share one scan. Never throws. */
    poll() {
      inFlight ??= scan()
        .catch(e => {
          error = message(e);
          logger.warn(`VM health check failed: ${error}`);
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
    get(name: string) {
      return vms.get(name) ?? null;
    },
    status() {
      return { checkedAt, error };
    },
  };
}

export type Observer = ReturnType<typeof createObserver>;
