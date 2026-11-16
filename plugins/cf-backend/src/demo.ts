import { createHash, randomUUID } from 'node:crypto';
import {
  AuthService,
  DatabaseService,
  DiscoveryService,
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import express from 'express';
import YAML from 'yaml';

const repository = 'amirasyraf/compute-factory-platform';
const api = `https://api.github.com/repos/${repository}`;
const limit = 3;
const lifetime = 5 * 60 * 1000;
const maxCleanupAttempts = 3;
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
  provision_run_id: string | null;
  cleanup_generation: string | null;
  cleanup_reason: string | null;
  cleanup_run_id: string | null;
  cleanup_attempt_at: number | null;
  cleanup_attempts: number;
  error: string | null;
};
type Run = {
  id: number;
  display_title: string;
  status: string;
  conclusion: string | null;
  updated_at?: string;
};
class GitHubError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`GitHub API HTTP ${status}: ${detail}`);
  }
}
const rejected = (error: unknown) =>
  error instanceof GitHubError && error.status >= 400 && error.status < 500;
const timestamp = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Unknown error';
const expiresAt = (vm: Vm, mode: Mode) => {
  const starts = [vm.ready_at, vm.failed_at]
    .filter((value): value is number => value !== null)
    .map(Number);
  const start = starts.length ? Math.min(...starts) : null;
  return mode.enabled && start !== null
    ? Math.max(Number(start), Number(mode.enabled_at)) + lifetime
    : null;
};

// Conditional GETs: the 15-second reconcile mostly gets 304s, which do not count
// against GitHub's hourly rate limit. Bounded; cleared when it grows too large.
const etags = new Map<string, { etag: string; body: unknown }>();

async function github<T>(path: string, body?: unknown): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required for demo controls');
  const cached = body === undefined ? etags.get(path) : undefined;
  const response = await fetch(`${api}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(cached ? { 'If-None-Match': cached.etag } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (response.status === 304 && cached) return cached.body as T;
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new GitHubError(
      response.status,
      `${failure.message ?? 'no message'} (${path.split('?')[0]}, request ${
        response.headers.get('x-github-request-id') ?? 'unknown'
      })`,
    );
  }
  if (response.status === 204)
    throw new Error(
      'GitHub did not return workflow run details; dispatch outcome uncertain',
    );
  const result = (await response.json()) as T;
  const etag = response.headers.get('etag');
  if (body === undefined && etag) {
    if (etags.size > 2000) etags.clear();
    etags.set(path, { etag, body: result });
  }
  return result;
}

// Bounded concurrency for inventory blobs and run lookups, not one request per row in series.
async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        results[current] = await fn(items[current]);
      }
    }),
  );
  return results;
}

async function initialize(db: Database) {
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
      table.string('provision_run_id').nullable();
      table.string('cleanup_generation').nullable();
      table.string('cleanup_reason').nullable();
      table.string('cleanup_run_id').nullable();
      table.bigInteger('cleanup_attempt_at').nullable();
      table.text('error').nullable();
    });
  }
  if (!(await db.schema.hasColumn('demo_vms', 'cleanup_attempts'))) {
    await db.schema.alterTable('demo_vms', table => {
      table.integer('cleanup_attempts').notNullable().defaultTo(0);
    });
  }
}

export const demoModePlugin = createBackendPlugin({
  pluginId: 'demo-mode',
  register(reg) {
    reg.registerInit({
      deps: {
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
      },
      async init({
        database,
        scheduler,
        httpRouter,
        httpAuth,
        userInfo,
        logger,
        config,
      }) {
        // Local development/smoke must never launch or clean up production VMs in the background.
        const automation =
          config.getOptionalBoolean('computeFactory.demoAutomation') ?? false;
        const db = await database.getClient();
        await initialize(db);
        // This POC has one backend instance. Serialize admission, toggles and reconciliation;
        // persist intent BEFORE external dispatch so a restart cannot lose a quota reservation.
        let queue: Promise<unknown> = Promise.resolve();
        function exclusive<T>(fn: () => Promise<T>): Promise<T> {
          const result = queue.then(fn);
          queue = result.catch(() => {});
          return result;
        }
        let lastScan: number | null = null;
        let scanError: string | null = null;
        let blobs = new Map<string, any>();
        const getMode = async () =>
          (await db<Mode>('demo_settings').where({ id: 1 }).first())!;
        const getVms = () => db<Vm>('demo_vms').select();
        const dispatch = async (
          workflow: string,
          inputs: Record<string, string>,
        ) => {
          const result = await github<{ workflow_run_id: number }>(
            `/actions/workflows/${workflow}/dispatches`,
            {
              ref: 'main',
              inputs,
              return_run_details: true,
            },
          );
          if (!Number.isSafeInteger(result.workflow_run_id))
            throw new Error(
              'Dispatch response missing run ID; outcome uncertain',
            );
          return String(result.workflow_run_id);
        };

        async function sync() {
          const rows = await getVms();
          const runs = new Map<string, Run>();
          // Recover a lost dispatch response by its unique run title; never blindly redispatch provision.
          for (const workflow of ['provision', 'destroy']) {
            const unknown = rows.filter(row =>
              workflow === 'provision'
                ? !row.seen && !row.provision_run_id
                : row.cleanup_attempt_at && !row.cleanup_run_id,
            );
            if (!unknown.length) continue;
            const result = await github<{ workflow_runs: Run[] }>(
              `/actions/workflows/${workflow}.yml/runs?event=workflow_dispatch&per_page=100`,
            );
            for (const row of unknown) {
              const suffix =
                workflow === 'provision'
                  ? `[${row.request_id}]`
                  : `[${row.cleanup_generation}:${row.request_id}]`;
              const run = result.workflow_runs.find(item =>
                item.display_title.endsWith(suffix),
              );
              if (run) {
                const field =
                  workflow === 'provision'
                    ? 'provision_run_id'
                    : 'cleanup_run_id';
                await db<Vm>('demo_vms')
                  .where({ name: row.name, request_id: row.request_id })
                  .update({ [field]: String(run.id), error: null });
                row[field] = String(run.id);
                runs.set(String(run.id), run);
              }
            }
          }
          const ids = [
            ...new Set(
              rows
                .flatMap(row => [
                  !row.seen ||
                  !['ready', 'failed', 'destroying'].includes(row.status)
                    ? row.provision_run_id
                    : null,
                  row.cleanup_run_id,
                ])
                .filter((id): id is string => Boolean(id)),
            ),
          ];
          await mapConcurrent(
            ids.filter(id => !runs.has(id)),
            async id => {
              runs.set(id, await github<Run>(`/actions/runs/${id}`));
            },
          );
          // Immutable tree/blob SHAs are authoritative, unlike the eventually consistent catalog.
          // Fetch AFTER run state so a completed run's absent inventory can safely release its slot.
          const tree = await github<{
            truncated: boolean;
            tree: { path: string; sha: string }[];
          }>('/git/trees/main?recursive=1');
          if (tree.truncated)
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
              if (blob.encoding !== 'base64')
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
            const provisionId =
              a['cf/provision-run-id'] || same?.provision_run_id || null;
            const provision = provisionId ? runs.get(provisionId) : undefined;
            const terminalFailure =
              provision?.status === 'completed' &&
              provision.conclusion !== 'success';
            let observedFailure =
              a['cf/status'] === 'failed' ? Date.now() : null;
            if (terminalFailure)
              observedFailure = timestamp(provision?.updated_at) ?? Date.now();
            const vm: Vm = {
              name,
              request_id: requestId,
              requested_by: a['cf/requested-by'],
              team,
              requested_at: same?.requested_at ?? requestedAt,
              seen: true,
              spec_hash: same?.spec_hash ?? '',
              status:
                terminalFailure && a['cf/status'] !== 'destroying'
                  ? 'failed'
                  : a['cf/status'],
              provision_run_id: provisionId,
              ready_at:
                timestamp(a['cf/ready-at']) ??
                same?.ready_at ??
                (a['cf/status'] === 'ready' ? Date.now() : null),
              failed_at:
                timestamp(a['cf/failed-at']) ??
                same?.failed_at ??
                observedFailure,
              cleanup_generation: same?.cleanup_generation ?? null,
              cleanup_reason: same?.cleanup_reason ?? null,
              cleanup_run_id: same?.cleanup_run_id ?? null,
              cleanup_attempt_at: same?.cleanup_attempt_at ?? null,
              cleanup_attempts: same?.cleanup_attempts ?? 0,
              error: same?.error ?? null,
            };
            return vm;
          });
          await db.transaction(async trx => {
            if (inventory.length)
              await trx<Vm>('demo_vms')
                .insert(inventory)
                .onConflict('name')
                .merge();
            const present = new Set(inventory.map(vm => vm.name));
            for (const row of rows.filter(vm => !present.has(vm.name))) {
              const run = row.provision_run_id
                ? runs.get(row.provision_run_id)
                : undefined;
              if (row.seen || run?.status === 'completed') {
                await trx<Vm>('demo_vms')
                  .where({ name: row.name, request_id: row.request_id })
                  .delete();
              }
            }
          });
          blobs = nextBlobs;
          lastScan = Date.now();
          scanError = null;
          return runs;
        }

        async function sweep() {
          if (!automation) return;
          const runs = await sync();
          const mode = await getMode();
          if (!mode.enabled) return;
          let rows = await getVms();
          const available = rows.filter(
            vm =>
              vm.status !== 'destroying' &&
              vm.cleanup_generation !== mode.generation,
          );
          const users = new Set(available.map(vm => vm.requested_by));
          for (const user of users) {
            const owned = available
              .filter(vm => vm.requested_by === user)
              .sort(
                (a, b) =>
                  Number(a.requested_at) - Number(b.requested_at) ||
                  a.name.localeCompare(b.name),
              );
            for (const vm of owned.slice(
              0,
              Math.max(0, owned.length - limit),
            )) {
              await db<Vm>('demo_vms').where({ name: vm.name }).update({
                cleanup_generation: mode.generation,
                cleanup_reason: 'quota',
                cleanup_attempts: 0,
              });
            }
          }
          rows = await getVms();
          for (const vm of rows) {
            if (vm.status === 'destroying') continue;
            const expires = expiresAt(vm, mode);
            if (
              vm.cleanup_generation !== mode.generation &&
              expires !== null &&
              expires <= Date.now()
            ) {
              await db<Vm>('demo_vms').where({ name: vm.name }).update({
                cleanup_generation: mode.generation,
                cleanup_reason: 'expired',
                cleanup_attempts: 0,
              });
              vm.cleanup_generation = mode.generation;
              vm.cleanup_reason = 'expired';
              vm.cleanup_attempts = 0;
            }
            if (vm.cleanup_generation !== mode.generation || !vm.seen) continue;
            // A running/queued older generation must finish or skip before a new cleanup is sent.
            const run = vm.cleanup_run_id
              ? runs.get(vm.cleanup_run_id)
              : undefined;
            if (vm.cleanup_run_id && run?.status !== 'completed') continue;
            if (
              vm.cleanup_attempt_at &&
              Date.now() - Number(vm.cleanup_attempt_at) < 120000
            )
              continue;
            if (
              vm.cleanup_attempt_at &&
              !vm.cleanup_run_id &&
              !vm.error?.startsWith('Cleanup rejected:')
            ) {
              // Ambiguous dispatches stay reserved, visible to the operator; do not create duplicate runs.
              continue;
            }
            // Stop after repeated failed destroys (e.g. a broken Terraform destroy); an operator
            // fixes the cause, then toggling demo mode starts a new generation and new attempts.
            if (Number(vm.cleanup_attempts) >= maxCleanupAttempts) {
              const stopped = `Cleanup stopped after ${maxCleanupAttempts} attempts; operator action needed`;
              if (vm.error !== stopped) {
                logger.warn(`Demo cleanup ${vm.name}: ${stopped}`);
                await db<Vm>('demo_vms')
                  .where({ name: vm.name })
                  .update({ error: stopped });
              }
              continue;
            }
            await db<Vm>('demo_vms')
              .where({ name: vm.name })
              .update({
                cleanup_attempt_at: Date.now(),
                cleanup_attempts: Number(vm.cleanup_attempts) + 1,
                cleanup_run_id: null,
                error: null,
              });
            try {
              const id = await dispatch('destroy.yml', {
                name: vm.name,
                requested_by: 'demo-mode',
                requester_teams: vm.team,
                demo_generation: mode.generation,
                expected_request_id: vm.request_id,
              });
              await db<Vm>('demo_vms')
                .where({ name: vm.name })
                .update({ cleanup_run_id: id });
              logger.info(
                `Demo cleanup ${vm.cleanup_reason}: ${vm.name}, run ${id}`,
              );
            } catch (error) {
              const failure = `${
                rejected(error)
                  ? 'Cleanup rejected'
                  : 'Cleanup dispatch uncertain'
              }: ${message(error)}`;
              logger.warn(`Demo cleanup ${vm.name}: ${failure}`);
              await db<Vm>('demo_vms')
                .where({ name: vm.name })
                .update({ error: failure });
            }
          }
        }

        const router = express.Router();
        router.use(express.json({ limit: '32kb' }));
        const caller = async (req: express.Request) => {
          const credentials = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const info = await userInfo.getUserInfo(credentials);
          return {
            ...info,
            admin: info.ownershipEntityRefs.includes(
              'group:default/platform-admins',
            ),
          };
        };
        router.get('/state', async (req, res, next) => {
          try {
            const info = await caller(req);
            const result = await exclusive(async () => {
              const mode = await getMode();
              const own = info.userEntityRef.split('/').pop()!;
              const all = await getVms();
              const visible = info.admin
                ? all
                : all.filter(vm => vm.requested_by === own);
              let visibleError = scanError;
              if (scanError && !info.admin)
                visibleError = 'Automatic cleanup paused; contact the operator';
              return {
                enabled: Boolean(mode.enabled),
                enabledAt: mode.enabled_at ? Number(mode.enabled_at) : null,
                generation: mode.generation,
                isAdmin: info.admin,
                automationAvailable: automation,
                limit,
                instanceTypes: demoInstanceTypes,
                ttlSeconds: lifetime / 1000,
                ownedCount: all.filter(vm => vm.requested_by === own).length,
                lastScan,
                error: visibleError,
                vms: visible.map(vm => ({
                  name: vm.name,
                  requestedBy: vm.requested_by,
                  status: vm.status,
                  expiresAt: expiresAt(vm, mode),
                  cleanupReason:
                    vm.cleanup_generation === mode.generation
                      ? vm.cleanup_reason
                      : null,
                  error: vm.error,
                  runUrl: vm.cleanup_run_id
                    ? `https://github.com/${repository}/actions/runs/${vm.cleanup_run_id}`
                    : null,
                })),
              };
            });
            res.json(result);
          } catch (error) {
            next(error);
          }
        });
        router.post('/settings', async (req, res, next) => {
          try {
            const info = await caller(req);
            if (!info.admin) {
              res
                .status(403)
                .json({ error: 'Only platform admins can change demo mode' });
              return;
            }
            if (
              typeof req.body.enabled !== 'boolean' ||
              typeof req.body.generation !== 'string'
            ) {
              res
                .status(400)
                .json({ error: 'Expected enabled and generation' });
              return;
            }
            await exclusive(async () => {
              const mode = await getMode();
              if (req.body.generation !== mode.generation) {
                res
                  .status(409)
                  .json({ error: 'Demo settings changed; refresh and retry' });
                return;
              }
              if (Boolean(mode.enabled) === req.body.enabled) {
                res.json({ enabled: Boolean(mode.enabled) });
                return;
              }
              // Enable only after a complete inventory scan; disabling must work even during GitHub outages.
              if (req.body.enabled && automation) await sync();
              await db<Mode>('demo_settings')
                .where({ id: 1 })
                .update({
                  enabled: req.body.enabled,
                  enabled_at: req.body.enabled ? Date.now() : null,
                  generation: randomUUID(),
                });
              logger.info(
                `Demo mode ${req.body.enabled ? 'enabled' : 'disabled'} by ${
                  info.userEntityRef
                }`,
              );
              res.json({ enabled: req.body.enabled });
            });
          } catch (error) {
            next(error);
          }
        });
        router.get('/cleanup-check/:name', async (req, res, next) => {
          try {
            const credentials = await httpAuth.credentials(req, {
              allow: ['service'],
            });
            if (credentials.principal.subject !== 'compute-factory-workflows') {
              res.status(403).json({ error: 'Workflow credential required' });
              return;
            }
            const allowed = await exclusive(async () => {
              const mode = await getMode();
              const vm = await db<Vm>('demo_vms')
                .where({ name: req.params.name })
                .first();
              return Boolean(
                automation &&
                  mode.enabled &&
                  vm &&
                  mode.generation === req.query.generation &&
                  vm.request_id === req.query.request_id &&
                  vm.cleanup_generation === mode.generation,
              );
            });
            res.json({ destroy: allowed });
          } catch (error) {
            next(error);
          }
        });
        router.post('/requests', async (req, res, next) => {
          try {
            const info = await caller(req);
            if (!automation) {
              res.status(503).json({
                error: 'VM automation is disabled in this environment',
              });
              return;
            }
            const { name, requestId, specJson } = req.body;
            if (
              !/^[a-z][a-z0-9-]{2,20}$/.test(name ?? '') ||
              typeof requestId !== 'string' ||
              !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId) ||
              typeof specJson !== 'string'
            ) {
              res.status(400).json({ error: 'Invalid VM request' });
              return;
            }
            let spec;
            try {
              spec = JSON.parse(specJson);
            } catch {
              res.status(400).json({ error: 'Invalid spec JSON' });
              return;
            }
            if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
              res.status(400).json({ error: 'Invalid spec' });
              return;
            }
            const billing = spec.billing ?? {};
            if (
              typeof billing.costCenter !== 'string' ||
              !billing.costCenter.trim() ||
              typeof billing.projectCode !== 'string' ||
              !billing.projectCode.trim()
            ) {
              res.status(400).json({
                error: 'Tags cost_center and project_code are required',
              });
              return;
            }
            const team = /^group:default\/([a-z][a-z0-9-]*)$/.exec(
              spec.owner ?? '',
            )?.[1];
            if (
              !team ||
              (!info.admin &&
                !info.ownershipEntityRefs.includes(`group:default/${team}`))
            ) {
              res
                .status(403)
                .json({ error: 'VM team must be one of your teams' });
              return;
            }
            const user = info.userEntityRef.split('/').pop()!;
            await exclusive(async () => {
              // Demo quota needs a complete scan (fail closed). Without demo mode, inventory
              // drift only affects the name check, which provision validation repeats anyway.
              try {
                await sync();
              } catch (error) {
                if ((await getMode()).enabled) {
                  res.status(503).json({
                    error: `Demo quota check failed; try again shortly (${message(
                      error,
                    )})`,
                  });
                  return;
                }
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
                  existing.requested_by !== user ||
                  existing.name !== name ||
                  existing.spec_hash !== hash
                ) {
                  res.status(409).json({
                    error: 'Request ID already used for a different request',
                  });
                  return;
                }
                if (!existing.provision_run_id) {
                  res.status(409).json({
                    error:
                      'Dispatch outcome uncertain; do not resubmit. Check Actions or ask the operator.',
                  });
                  return;
                }
                res.json({
                  workflowRunId: Number(existing.provision_run_id),
                  workflowRunHtmlUrl: `https://github.com/${repository}/actions/runs/${existing.provision_run_id}`,
                });
                return;
              }
              if (await db<Vm>('demo_vms').where({ name }).first()) {
                res.status(409).json({ error: 'VM name already reserved' });
                return;
              }
              const mode = await getMode();
              const instanceType = spec.compute?.instanceType;
              if (
                mode.enabled &&
                instanceType !== undefined &&
                !demoInstanceTypes.includes(instanceType)
              ) {
                res.status(403).json({
                  error: `Demo mode allows only ${demoInstanceTypes.join(
                    ', ',
                  )}. Pick one of those or a size.`,
                });
                return;
              }
              const rows = await getVms();
              if (
                mode.enabled &&
                rows.filter(vm => vm.requested_by === user).length >= limit
              ) {
                res.status(409).json({
                  error:
                    '3 VM limit reached. Wait until a VM is fully destroyed before requesting another.',
                });
                return;
              }
              await db<Vm>('demo_vms').insert({
                name,
                request_id: requestId,
                requested_by: user,
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
                cleanup_attempt_at: null,
                cleanup_attempts: 0,
                error: null,
              });
              try {
                const id = await dispatch('provision.yml', {
                  name,
                  spec_json: specJson,
                  requested_by: user,
                  requester_teams: info.ownershipEntityRefs
                    .filter(ref => ref.startsWith('group:default/'))
                    .map(ref => ref.split('/').pop())
                    .join(','),
                  request_id: requestId,
                });
                await db<Vm>('demo_vms')
                  .where({ name })
                  .update({ provision_run_id: id });
                res.json({
                  workflowRunId: Number(id),
                  workflowRunHtmlUrl: `https://github.com/${repository}/actions/runs/${id}`,
                });
              } catch (error) {
                logger.warn(
                  `Provision dispatch for ${name} (task ${requestId}) failed: ${message(
                    error,
                  )}`,
                );
                if (rejected(error)) {
                  await db<Vm>('demo_vms')
                    .where({ name, request_id: requestId })
                    .delete();
                  res.status(502).json({
                    error: `GitHub rejected dispatch: ${message(
                      error,
                    )}. No quota slot was consumed.`,
                  });
                  return;
                }
                await db<Vm>('demo_vms')
                  .where({ name })
                  .update({
                    error: `Provision dispatch uncertain: ${message(error)}`,
                  });
                res.status(503).json({
                  error:
                    'Dispatch could not be confirmed. Reservation kept; do not resubmit. Check Actions or ask the operator.',
                });
              }
            });
          } catch (error) {
            next(error);
          }
        });
        httpRouter.use(router);
        await scheduler.scheduleTask({
          id: 'demo-reconcile',
          frequency: { seconds: 15 },
          timeout: { minutes: 5 },
          fn: () =>
            exclusive(async () => {
              try {
                await sweep();
              } catch (error) {
                scanError = message(error);
                logger.warn(`Demo reconciliation paused: ${scanError}`);
              }
            }),
        });
      },
    });
  },
});

type DispatchResult = { workflowRunId: number; workflowRunHtmlUrl: string };

export function createDemoDispatchAction(
  auth: AuthService,
  discovery: DiscoveryService,
) {
  return createTemplateAction({
    id: 'cf:vm:dispatch',
    description:
      'Reserve quota and dispatch a VM using authenticated requester identity',
    schema: {
      input: { name: z => z.string(), specJson: z => z.string() },
      output: {
        workflowRunId: z => z.number(),
        workflowRunHtmlUrl: z => z.string(),
      },
    },
    async handler(ctx) {
      const credentials = await ctx.getInitiatorCredentials();
      if (!auth.isPrincipal(credentials, 'user'))
        throw new Error('A signed-in user is required');
      const result = await ctx.checkpoint({
        key: 'cf.vm.dispatch',
        fn: async () => {
          const base = await discovery.getBaseUrl('demo-mode');
          // The endpoint is idempotent per task ID and serialized, so a retry after a
          // timeout or transient server error returns the first attempt's run instead
          // of starting a second VM. Only deliberate refusals (string `error`) are final.
          const deadline = Date.now() + 10 * 60 * 1000;
          for (let attempt = 1; ; attempt++) {
            const { token } = await auth.getPluginRequestToken({
              onBehalfOf: credentials,
              targetPluginId: 'demo-mode',
            });
            const timeout = AbortSignal.timeout(120000);
            let response: Response | undefined;
            let failure = '';
            try {
              response = await fetch(`${base}/requests`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  name: ctx.input.name,
                  specJson: ctx.input.specJson,
                  requestId: ctx.task.id,
                }),
                signal: ctx.signal
                  ? AbortSignal.any([timeout, ctx.signal])
                  : timeout,
              });
            } catch (error) {
              if (ctx.signal?.aborted) throw error;
              failure = `VM dispatch request failed (${message(error)})`;
            }
            if (response) {
              const body = await response.json().catch(() => undefined as any);
              if (response.ok && body) return body as DispatchResult;
              // Our endpoint's deliberate answers carry a string; Backstage's generic
              // error handler sends { error: { name, message } }.
              if (typeof body?.error === 'string') throw new Error(body.error);
              failure = `VM dispatch HTTP ${response.status}${
                typeof body?.error?.message === 'string'
                  ? `: ${body.error.message}`
                  : ''
              }`;
              if (response.status < 500) throw new Error(failure);
            }
            if (Date.now() > deadline)
              throw new Error(
                `${failure}. The VM may still have been requested; check the VM catalog before resubmitting.`,
              );
            ctx.logger.warn(
              `${failure}; retrying the same request (attempt ${attempt + 1})`,
            );
            await new Promise(resolve =>
              setTimeout(resolve, Math.min(5000 * attempt, 30000)),
            );
          }
        },
      });
      ctx.output('workflowRunId', result.workflowRunId);
      ctx.output('workflowRunHtmlUrl', result.workflowRunHtmlUrl);
      ctx.logger.info(`VM workflow: ${result.workflowRunHtmlUrl}`);
    },
  });
}
