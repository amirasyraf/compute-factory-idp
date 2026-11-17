import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService, LoggerService } from '@backstage/backend-plugin-api';
import YAML from 'yaml';
import { github, mapConcurrent, message } from './github';
import { Orchestrator, Run, RunConflict } from './orchestrator';

const limit = 3;
const lifetime = 5 * 60 * 1000;
// While demo mode is on, Advanced instance-type requests are limited to these (cost control).
// Size letters are allowed: sizes.json maps XS-L to exactly these types.
export const demoInstanceTypes = [
  't3.micro',
  't3.small',
  't3.medium',
  't3.large',
];
type Database = Awaited<ReturnType<DatabaseService['getClient']>>;
type Mode = {
  id: number;
  enabled: boolean;
  enabled_at: number | null;
  generation: string;
};
type Vm = {
  name: string;
  request_id: string;
  requested_by: string;
  team: string;
  requested_at: number;
  ready_at: number | null;
  failed_at: number | null;
  status: string;
  seen: boolean;
  spec_hash: string;
  provision_run_id: number | null;
  cleanup_generation: string | null;
  cleanup_reason: string | null;
  cleanup_run_id: number | null;
  error: string | null;
};
export type Caller = {
  userEntityRef: string;
  ownershipEntityRefs: string[];
  user: string;
  teams: string[];
  admin: boolean;
};
export type Reply = { status: number; body: unknown };

const timestamp = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const expiresAt = (vm: Vm, mode: Mode) => {
  const starts = [vm.ready_at, vm.failed_at]
    .filter((value): value is number => value !== null)
    .map(Number);
  const start = starts.length ? Math.min(...starts) : null;
  return mode.enabled && start !== null
    ? Math.max(Number(start), Number(mode.enabled_at)) + lifetime
    : null;
};
const cleanupKey = (generation: string, vm: Vm) =>
  `demo:${generation}:${vm.name}:${vm.request_id}`;

export async function initializeDemo(db: Database) {
  if (!(await db.schema.hasTable('demo_settings'))) {
    await db.schema.createTable('demo_settings', table => {
      table.integer('id').primary();
      table.boolean('enabled').notNullable();
      table.bigInteger('enabled_at').nullable();
      table.string('generation').notNullable();
    });
    await db<Mode>('demo_settings').insert({
      id: 1,
      enabled: false,
      enabled_at: null,
      generation: randomUUID(),
    });
  }
  if (!(await db.schema.hasTable('demo_vms'))) {
    await db.schema.createTable('demo_vms', table => {
      table.string('name').primary();
      table.string('request_id').notNullable().unique();
      table.string('requested_by').notNullable().index();
      table.string('team').notNullable();
      table.bigInteger('requested_at').notNullable();
      table.bigInteger('ready_at').nullable();
      table.bigInteger('failed_at').nullable();
      table.string('status').notNullable();
      table.boolean('seen').notNullable();
      table.string('spec_hash').notNullable();
      table.integer('provision_run_id').nullable();
      table.string('cleanup_generation').nullable();
      table.string('cleanup_reason').nullable();
      table.integer('cleanup_run_id').nullable();
      table.text('error').nullable();
    });
  }
}

/**
 * Demo-mode admission (quota, instance types), lifetime policy and automatic cleanup.
 * Callers serialize every function here with the orchestrator (one backend instance).
 */
export function createDemo(options: {
  db: Database;
  logger: LoggerService;
  automation: boolean;
  orchestrator: Orchestrator;
}) {
  const { db, logger, automation, orchestrator } = options;
  let lastScan: number | null = null;
  let scanError: string | null = null;
  let blobs = new Map<string, any>();
  const getMode = async () =>
    (await db<Mode>('demo_settings').where({ id: 1 }).first())!;
  const getVms = () => db<Vm>('demo_vms').select();

  // Immutable Git inventory (tree/blob SHAs) is authoritative, unlike the eventually consistent catalog.
  async function sync() {
    const rows = await getVms();
    const tree = await github<{
      truncated: boolean;
      tree: { path: string; sha: string }[];
    }>('/git/trees/main?recursive=1');
    if (!tree || tree.truncated)
      throw new Error(
        'Inventory tree is truncated; refusing partial reconciliation',
      );
    const files = tree.tree.filter(item =>
      /^vms\/[a-z][a-z0-9-]{2,20}\/catalog-info\.yaml$/.test(item.path),
    );
    const nextBlobs = new Map<string, any>();
    const inventory = await mapConcurrent(files, async file => {
      let entity = blobs.get(file.sha);
      if (!entity) {
        const blob = await github<{ encoding: string; content: string }>(
          `/git/blobs/${file.sha}`,
        );
        if (blob?.encoding !== 'base64')
          throw new Error('Unexpected inventory encoding');
        entity = YAML.parse(
          Buffer.from(blob.content, 'base64').toString('utf8'),
        );
      }
      nextBlobs.set(file.sha, entity);
      const a = entity?.metadata?.annotations ?? {};
      const name = file.path.split('/')[1];
      const requestedAt = timestamp(a['cf/requested-at']);
      const team = /^group:default\/([a-z][a-z0-9-]*)$/.exec(
        entity?.spec?.owner ?? '',
      )?.[1];
      if (
        entity?.metadata?.name !== name ||
        !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(a['cf/requested-by'] ?? '') ||
        !team ||
        requestedAt === null
      ) {
        throw new Error(
          `Invalid inventory provenance for ${name}; refusing cleanup`,
        );
      }
      const old = rows.find(row => row.name === name);
      const requestId =
        a['cf/request-id'] || `legacy:${name}:${a['cf/requested-at']}`;
      const same = old?.request_id === requestId ? old : undefined;
      const vm: Vm = {
        name,
        request_id: requestId,
        requested_by: a['cf/requested-by'],
        team,
        requested_at: same?.requested_at ?? requestedAt,
        seen: true,
        spec_hash: same?.spec_hash ?? '',
        status: a['cf/status'],
        provision_run_id: same?.provision_run_id ?? null,
        ready_at:
          timestamp(a['cf/ready-at']) ??
          same?.ready_at ??
          (a['cf/status'] === 'ready' ? Date.now() : null),
        // `failed` is written only after the orchestrator gives up, never while retrying.
        failed_at:
          timestamp(a['cf/failed-at']) ??
          same?.failed_at ??
          (a['cf/status'] === 'failed' ? Date.now() : null),
        cleanup_generation: same?.cleanup_generation ?? null,
        cleanup_reason: same?.cleanup_reason ?? null,
        cleanup_run_id: same?.cleanup_run_id ?? null,
        error: same?.error ?? null,
      };
      return vm;
    });
    const present = new Set(inventory.map(vm => vm.name));
    const released: { row: Vm; run?: Run }[] = [];
    for (const row of rows.filter(vm => !present.has(vm.name))) {
      const run = row.provision_run_id
        ? await orchestrator.getRun(Number(row.provision_run_id))
        : undefined;
      // Destroyed, or a provision run that ended before registering inventory.
      if (
        row.seen ||
        !run ||
        ['failed', 'cancelled', 'succeeded'].includes(run.status)
      )
        released.push({ row, run });
    }
    await db.transaction(async trx => {
      if (inventory.length)
        await trx<Vm>('demo_vms').insert(inventory).onConflict('name').merge();
      for (const { row, run } of released) {
        await trx<Vm>('demo_vms')
          .where({ name: row.name, request_id: row.request_id })
          .delete();
        // A failed provision that never registered cannot come back once its slot is
        // released; retire it so the name is free for a new request.
        if (!row.seen && run?.status === 'failed')
          await orchestrator.cancel(
            run,
            'Released: the VM was never registered; submit a new request',
            trx,
          );
      }
    });
    blobs = nextBlobs;
    lastScan = Date.now();
    scanError = null;
  }

  async function sweep() {
    if (!automation) return;
    try {
      await sync();
      const mode = await getMode();
      if (!mode.enabled) return;
      let rows = await getVms();
      const available = rows.filter(
        vm =>
          vm.status !== 'destroying' &&
          vm.cleanup_generation !== mode.generation,
      );
      for (const user of new Set(available.map(vm => vm.requested_by))) {
        const owned = available
          .filter(vm => vm.requested_by === user)
          .sort(
            (a, b) =>
              Number(a.requested_at) - Number(b.requested_at) ||
              a.name.localeCompare(b.name),
          );
        for (const vm of owned.slice(0, Math.max(0, owned.length - limit))) {
          await db<Vm>('demo_vms').where({ name: vm.name }).update({
            cleanup_generation: mode.generation,
            cleanup_reason: 'quota',
          });
        }
      }
      rows = await getVms();
      for (const vm of rows) {
        const expires = expiresAt(vm, mode);
        if (
          vm.status !== 'destroying' &&
          vm.cleanup_generation !== mode.generation &&
          expires !== null &&
          expires <= Date.now()
        ) {
          await db<Vm>('demo_vms').where({ name: vm.name }).update({
            cleanup_generation: mode.generation,
            cleanup_reason: 'expired',
          });
          vm.cleanup_generation = mode.generation;
          vm.cleanup_reason = 'expired';
        }
        if (vm.cleanup_generation !== mode.generation || !vm.seen) continue;
        // One destroy run per VM incarnation per generation; the orchestrator retries it.
        const key = cleanupKey(mode.generation, vm);
        const current = vm.cleanup_run_id
          ? await orchestrator.getRun(Number(vm.cleanup_run_id))
          : undefined;
        if (current?.request_key === key) {
          const stopped =
            'Cleanup stopped: the destroy run failed; an operator can retry it from the run page';
          const error = current.status === 'failed' ? stopped : null;
          if (vm.error !== error) {
            if (error) logger.warn(`Demo cleanup ${vm.name}: ${error}`);
            await db<Vm>('demo_vms').where({ name: vm.name }).update({ error });
          }
          continue;
        }
        const { run } = await orchestrator.createRun({
          kind: 'destroy',
          name: vm.name,
          team: vm.team,
          requestId: vm.request_id,
          requestKey: key,
          requestedBy: 'demo-mode',
          requesterTeams: [vm.team],
          params: { demoGeneration: mode.generation },
        });
        await db<Vm>('demo_vms')
          .where({ name: vm.name })
          .update({ cleanup_run_id: run.id, error: null });
        logger.info(
          `Demo cleanup ${vm.cleanup_reason}: ${vm.name}, run ${run.id}`,
        );
      }
    } catch (error) {
      scanError = message(error);
      logger.warn(`Demo reconciliation paused: ${scanError}`);
    }
  }

  async function state(info: Caller) {
    const mode = await getMode();
    const all = await getVms();
    const visible = info.admin
      ? all
      : all.filter(vm => vm.requested_by === info.user);
    return {
      enabled: Boolean(mode.enabled),
      enabledAt: mode.enabled_at ? Number(mode.enabled_at) : null,
      generation: mode.generation,
      isAdmin: info.admin,
      automationAvailable: automation,
      limit,
      instanceTypes: demoInstanceTypes,
      ttlSeconds: lifetime / 1000,
      ownedCount: all.filter(vm => vm.requested_by === info.user).length,
      lastScan,
      error:
        scanError && !info.admin
          ? 'Automatic cleanup paused; contact the operator'
          : scanError,
      vms: visible.map(vm => ({
        name: vm.name,
        requestedBy: vm.requested_by,
        status: vm.status,
        expiresAt: expiresAt(vm, mode),
        cleanupReason:
          vm.cleanup_generation === mode.generation ? vm.cleanup_reason : null,
        error: vm.error,
        runUrl: vm.cleanup_run_id
          ? orchestrator.runUrl(Number(vm.cleanup_run_id))
          : null,
      })),
    };
  }

  async function settings(info: Caller, body: any): Promise<Reply> {
    if (!info.admin)
      return {
        status: 403,
        body: { error: 'Only platform admins can change demo mode' },
      };
    if (
      typeof body?.enabled !== 'boolean' ||
      typeof body?.generation !== 'string'
    )
      return {
        status: 400,
        body: { error: 'Expected enabled and generation' },
      };
    const mode = await getMode();
    if (body.generation !== mode.generation)
      return {
        status: 409,
        body: { error: 'Demo settings changed; refresh and retry' },
      };
    if (Boolean(mode.enabled) === body.enabled)
      return { status: 200, body: { enabled: Boolean(mode.enabled) } };
    // Enable only after a complete inventory scan; disabling must work even during GitHub outages.
    if (body.enabled && automation) await sync();
    await db<Mode>('demo_settings')
      .where({ id: 1 })
      .update({
        enabled: body.enabled,
        enabled_at: body.enabled ? Date.now() : null,
        generation: randomUUID(),
      });
    logger.info(
      `Demo mode ${body.enabled ? 'enabled' : 'disabled'} by ${
        info.userEntityRef
      }`,
    );
    return { status: 200, body: { enabled: body.enabled } };
  }

  async function cleanupCheck(
    name: string,
    generation: unknown,
    requestId: unknown,
  ) {
    const mode = await getMode();
    const vm = await db<Vm>('demo_vms').where({ name }).first();
    return Boolean(
      automation &&
        mode.enabled &&
        vm &&
        mode.generation === generation &&
        vm.request_id === requestId &&
        vm.cleanup_generation === mode.generation,
    );
  }

  /** Admission for a new VM: validate, reserve quota, create the provision run. */
  async function request(info: Caller, body: any): Promise<Reply> {
    if (!automation)
      return {
        status: 503,
        body: { error: 'VM automation is disabled in this environment' },
      };
    const { name, requestId, specJson } = body ?? {};
    if (
      !/^[a-z][a-z0-9-]{2,20}$/.test(name ?? '') ||
      typeof requestId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId) ||
      typeof specJson !== 'string'
    )
      return { status: 400, body: { error: 'Invalid VM request' } };
    let spec;
    try {
      spec = JSON.parse(specJson);
    } catch {
      return { status: 400, body: { error: 'Invalid spec JSON' } };
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec))
      return { status: 400, body: { error: 'Invalid spec' } };
    const billing = spec.billing ?? {};
    if (
      typeof billing.costCenter !== 'string' ||
      !billing.costCenter.trim() ||
      typeof billing.projectCode !== 'string' ||
      !billing.projectCode.trim()
    )
      return {
        status: 400,
        body: { error: 'Tags cost_center and project_code are required' },
      };
    const team = /^group:default\/([a-z][a-z0-9-]*)$/.exec(
      spec.owner ?? '',
    )?.[1];
    if (!team || (!info.admin && !info.teams.includes(team)))
      return {
        status: 403,
        body: { error: 'VM team must be one of your teams' },
      };
    // Demo quota needs a complete scan (fail closed). Without demo mode, inventory drift
    // only affects the name check, which the register stage repeats anyway.
    try {
      await sync();
    } catch (error) {
      if ((await getMode()).enabled)
        return {
          status: 503,
          body: {
            error: `Demo quota check failed; try again shortly (${message(
              error,
            )})`,
          },
        };
      logger.warn(
        `Inventory scan failed; admitting ${name} without it: ${message(
          error,
        )}`,
      );
    }
    const hash = createHash('sha256').update(specJson).digest('hex');
    const existing = await db<Vm>('demo_vms')
      .where({ request_id: requestId })
      .first();
    if (existing) {
      if (
        existing.requested_by !== info.user ||
        existing.name !== name ||
        existing.spec_hash !== hash ||
        !existing.provision_run_id
      )
        return {
          status: 409,
          body: { error: 'Request ID already used for a different request' },
        };
      const runId = Number(existing.provision_run_id);
      return {
        status: 200,
        body: { runId, runUrl: orchestrator.runUrl(runId) },
      };
    }
    if (await db<Vm>('demo_vms').where({ name }).first())
      return { status: 409, body: { error: 'VM name already reserved' } };
    const mode = await getMode();
    const instanceType = spec.compute?.instanceType;
    if (
      mode.enabled &&
      instanceType !== undefined &&
      !demoInstanceTypes.includes(instanceType)
    )
      return {
        status: 403,
        body: {
          error: `Demo mode allows only ${demoInstanceTypes.join(
            ', ',
          )}. Pick one of those or a size.`,
        },
      };
    const rows = await getVms();
    if (
      mode.enabled &&
      rows.filter(vm => vm.requested_by === info.user).length >= limit
    )
      return {
        status: 409,
        body: {
          error:
            '3 VM limit reached. Wait until a VM is fully destroyed before requesting another.',
        },
      };
    try {
      // Reservation, run and their link commit together.
      const runId = await db.transaction(async trx => {
        await trx<Vm>('demo_vms').insert({
          name,
          request_id: requestId,
          requested_by: info.user,
          team,
          requested_at: Date.now(),
          ready_at: null,
          failed_at: null,
          status: 'reserved',
          seen: false,
          spec_hash: hash,
          provision_run_id: null,
          cleanup_generation: null,
          cleanup_reason: null,
          cleanup_run_id: null,
          error: null,
        });
        const { run } = await orchestrator.createRun(
          {
            kind: 'provision',
            name,
            team,
            requestId,
            requestKey: `provision:${requestId}`,
            requestedBy: info.user,
            requesterTeams: info.teams,
            params: { spec },
          },
          trx,
        );
        await trx<Vm>('demo_vms')
          .where({ name })
          .update({ provision_run_id: run.id });
        return run.id;
      });
      return {
        status: 200,
        body: { runId, runUrl: orchestrator.runUrl(runId) },
      };
    } catch (error) {
      if (error instanceof RunConflict)
        return { status: 409, body: { error: error.message } };
      throw error;
    }
  }

  /** Demo mode limits explicit instance types (requests and Modify); sizes are always allowed. */
  async function allowsInstanceType(instanceType: string | undefined) {
    return (
      instanceType === undefined ||
      !(await getMode()).enabled ||
      demoInstanceTypes.includes(instanceType)
    );
  }

  return { sweep, state, settings, cleanupCheck, request, allowsInstanceType };
}
