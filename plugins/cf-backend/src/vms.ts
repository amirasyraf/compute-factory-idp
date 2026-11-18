import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { parseEntityRef } from '@backstage/catalog-model';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import express from 'express';
import { Caller, Reply, createDemo, initializeDemo } from './demo';
import { message } from './github';
import { createServiceNowClient } from './servicenow';
import {
  Run,
  RunKind,
  RunConflict,
  createOrchestrator,
  initializeOrchestrator,
} from './orchestrator';
import { createObserver } from './observed';
import {
  allowsInstanceType,
  loadPlatform,
  platformLabel,
  validPlatform,
} from './platforms';
import { TerminalLimit, createTerminals } from './terminal';

const OPERATIONS: Record<string, RunKind> = {
  modify: 'modify',
  reapply: 'reapply',
  start: 'power',
  stop: 'power',
  reboot: 'power',
  update: 'update',
  destroy: 'destroy',
};
// A health check older than this is not used to refuse an operation.
const OBSERVED_FRESH_MS = 2 * 60_000;
const SOFTWARE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 20 &&
  new Set(value).size === value.length &&
  value.every(item => typeof item === 'string' && SOFTWARE.test(item));
const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};

/**
 * The requested compute, or undefined when malformed. Exactly one of size or instanceType; the
 * instance type is checked against the platform's own pattern later.
 */
function parseCompute(value: unknown) {
  const compute = record(value);
  const { platform, os, size, instanceType } = compute;
  if (
    !validPlatform(platform) ||
    typeof os !== 'string' ||
    Object.keys(compute).some(
      key => !['platform', 'os', 'size', 'instanceType'].includes(key),
    ) ||
    (size === undefined) === (instanceType === undefined) ||
    (size !== undefined &&
      (typeof size !== 'string' || !/^[A-Z]{1,3}$/.test(size))) ||
    (instanceType !== undefined &&
      (typeof instanceType !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(instanceType)))
  )
    return undefined;
  return size !== undefined
    ? { platform, os, size: size as string }
    : { platform, os, instanceType: instanceType as string };
}

/** The VM entity's `spec.compute.platform`; inventory predating Azure is AWS. */
const platformOf = (entity: { spec?: Record<string, any> }) => {
  const platform = record(record(entity.spec).compute).platform;
  return validPlatform(platform) ? platform : 'aws';
};

const teamsOf = (refs: string[]) =>
  refs
    .filter(ref => ref.startsWith('group:default/'))
    .map(ref => ref.split('/').pop()!);

/**
 * VM lifecycle: orchestrator (runs, stages, retries) plus demo-mode admission and cleanup.
 * One backend instance; every state change is serialized through `exclusive`.
 */
export const vmsPlugin = createBackendPlugin({
  pluginId: 'vms',
  register(reg) {
    reg.registerInit({
      deps: {
        database: coreServices.database,
        auth: coreServices.auth,
        scheduler: coreServices.scheduler,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        catalog: catalogServiceRef,
      },
      async init({
        database,
        auth,
        scheduler,
        httpRouter,
        httpAuth,
        userInfo,
        logger,
        config,
        catalog,
      }) {
        // Local development/smoke must never launch, orchestrate or clean up production VMs.
        const automation =
          config.getOptionalBoolean('computeFactory.demoAutomation') ?? false;
        const db = await database.getClient();
        await initializeOrchestrator(db);
        await initializeDemo(db);
        const serviceNow = createServiceNowClient(auth, config);
        // The provision run's first stage: the (mock) ServiceNow request, made by the IDP itself.
        const requestServiceNow = async (run: Run) => {
          const compute =
            JSON.parse(run.params || '{}')?.spec?.compute ?? ({} as any);
          const number = await serviceNow({
            requestId: run.request_id,
            vmName: run.name,
            team: run.team,
            requestedBy: `user:default/${run.requested_by}`,
            platform: String(compute.platform ?? ''),
            os: String(compute.os ?? ''),
            size: String(compute.instanceType ?? compute.size ?? ''),
          });
          return `${number} created (mock ServiceNow)`;
        };
        let queue: Promise<unknown> = Promise.resolve();
        function exclusive<T>(fn: () => Promise<T>): Promise<T> {
          const result = queue.then(fn);
          queue = result.catch(() => {});
          return result;
        }
        // The health check reads the clouds only where VM automation runs (production).
        const observer = automation ? createObserver(logger) : undefined;
        // The terminal reaches real VMs with a CA-signed key: production only, like automation.
        const terminals = automation ? createTerminals(logger) : undefined;
        const orchestrator = createOrchestrator({
          db,
          logger,
          appBaseUrl: config.getString('app.baseUrl').replace(/\/$/, ''),
          inProcess: { servicenow: requestServiceNow },
          // Show the new power state or size without waiting for the next scheduled check.
          onFinished: run => {
            if (run.kind !== 'provision') observer?.poll();
          },
        });
        const vmDemo = createDemo({ db, logger, automation, orchestrator });

        const caller = async (req: express.Request): Promise<Caller> => {
          const credentials = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const info = await userInfo.getUserInfo(credentials);
          return {
            ...info,
            user: info.userEntityRef.split('/').pop()!,
            teams: teamsOf(info.ownershipEntityRefs),
            admin: info.ownershipEntityRefs.includes(
              'group:default/platform-admins',
            ),
          };
        };
        const allowed = (info: Caller, run: Run) =>
          info.admin || info.teams.includes(run.team);
        const send = (res: express.Response, reply: Reply) =>
          res.status(reply.status).json(reply.body);
        const route =
          (
            fn: (
              req: express.Request,
              res: express.Response,
            ) => Promise<unknown>,
          ) =>
          async (
            req: express.Request,
            res: express.Response,
            next: express.NextFunction,
          ) => {
            try {
              await fn(req, res);
            } catch (error) {
              if (error instanceof RunConflict)
                res.status(409).json({ error: error.message });
              else next(error);
            }
          };

        /** A VM the caller may operate on: its entity, team and incarnation (request ID). */
        const readVm = async (
          credentials: Awaited<ReturnType<typeof httpAuth.credentials>>,
          info: Caller,
          name: string,
        ) => {
          // The catalog permission policy only lets owners (and admins) read VM entities.
          const entity = await catalog.getEntityByRef(
            { kind: 'Resource', namespace: 'default', name },
            { credentials },
          );
          const team = /^group:default\/([a-z][a-z0-9-]*)$/.exec(
            String(entity?.spec?.owner ?? ''),
          )?.[1];
          if (!entity || entity.spec?.type !== 'vm' || !team)
            return {
              ok: false,
              status: 404,
              error: `VM ${name} not found`,
            } as const;
          if (!info.admin && !info.teams.includes(team))
            return {
              status: 403,
              error: 'VM belongs to another team',
            } as const;
          const requestId = entity.metadata.annotations?.['cf/request-id'];
          if (!requestId)
            return {
              ok: false,
              status: 409,
              error: 'VM inventory has no request ID',
            } as const;
          return { ok: true, entity, team, requestId } as const;
        };

        const router = express.Router();
        router.use(express.json({ limit: '64kb' }));

        router.get(
          '/demo/state',
          route(async (req, res) => {
            const info = await caller(req);
            res.json(await exclusive(() => vmDemo.state(info)));
          }),
        );
        router.post(
          '/demo/settings',
          route(async (req, res) => {
            const info = await caller(req);
            send(res, await exclusive(() => vmDemo.settings(info, req.body)));
          }),
        );
        router.get(
          '/cleanup-check/:name',
          route(async (req, res) => {
            const credentials = await httpAuth.credentials(req, {
              allow: ['service'],
            });
            if (credentials.principal.subject !== 'compute-factory-workflows') {
              res.status(403).json({ error: 'Workflow credential required' });
              return;
            }
            const destroy = await exclusive(() =>
              vmDemo.cleanupCheck(
                req.params.name,
                req.query.generation,
                req.query.request_id,
              ),
            );
            res.json({ destroy });
          }),
        );
        router.post(
          '/requests',
          route(async (req, res) => {
            const info = await caller(req);
            send(res, await exclusive(() => vmDemo.request(info, req.body)));
          }),
        );

        // Day-2 operations on an existing VM: the VM page (power, updates, re-apply, destroy) and the
        // `cf:vm:run` scaffolder action (vm-modify) both create runs here.
        router.post(
          '/runs',
          route(async (req, res) => {
            const credentials = await httpAuth.credentials(req, {
              allow: ['user'],
            });
            const info = await caller(req);
            if (!automation) {
              res.status(503).json({
                error: 'VM automation is disabled in this environment',
              });
              return;
            }
            const { operation, vm, requestKey } = req.body ?? {};
            let ref;
            try {
              ref = parseEntityRef(String(vm ?? ''));
            } catch {
              ref = undefined;
            }
            const kind = Object.prototype.hasOwnProperty.call(
              OPERATIONS,
              operation,
            )
              ? OPERATIONS[operation]
              : undefined;
            const compute =
              operation === 'modify' ? parseCompute(req.body.compute) : null;
            const valid =
              kind &&
              typeof requestKey === 'string' &&
              /^[a-zA-Z0-9_-]{1,100}$/.test(requestKey) &&
              ref?.kind.toLowerCase() === 'resource' &&
              ref.namespace === 'default' &&
              /^[a-z][a-z0-9-]{2,20}$/.test(ref.name) &&
              (operation !== 'modify' ||
                (compute &&
                  stringList(req.body.software) &&
                  typeof req.body.adJoin === 'boolean'));
            if (!valid || !ref || !kind) {
              res.status(400).json({ error: 'Invalid VM operation' });
              return;
            }
            const found = await readVm(credentials, info, ref.name);
            if (!found.ok) {
              res.status(found.status).json({ error: found.error });
              return;
            }
            const { entity, team, requestId } = found;
            const key = `${operation}:${requestKey}`;
            const repeated = await orchestrator.findByRequestKey(key);
            const spec = record(entity.spec);
            const configuration = record(spec.configuration);
            const currentSoftware: string[] = Array.isArray(
              configuration.software,
            )
              ? configuration.software
              : [];
            let params: Record<string, unknown> = {};
            if (operation === 'modify' && compute) {
              const current = record(spec.compute);
              if (
                current.platform !== compute.platform ||
                current.os !== compute.os
              ) {
                res.status(400).json({
                  error: 'Modify cannot change the platform or OS',
                });
                return;
              }
              const software: string[] = req.body.software;
              const changes = {
                compute:
                  current.size !== compute.size ||
                  current.instanceType !== compute.instanceType,
                software:
                  software.length !== currentSoftware.length ||
                  software.some(item => !currentSoftware.includes(item)),
                adJoin: req.body.adJoin !== (configuration.adJoin === true),
              };
              if (!repeated && !Object.values(changes).some(Boolean)) {
                res.status(400).json({
                  error: 'Nothing to change: this is the current configuration',
                });
                return;
              }
              if (compute.instanceType !== undefined) {
                let platform;
                try {
                  platform = await loadPlatform(compute.platform, logger);
                } catch (error) {
                  res.status(503).json({
                    error: `Platform definition unavailable: ${message(error)}`,
                  });
                  return;
                }
                if (!allowsInstanceType(platform, compute.instanceType)) {
                  res.status(400).json({
                    error: `${compute.instanceType} is not a ${platform.label} instance type`,
                  });
                  return;
                }
              }
              const refusal = await vmDemo.refuseInstanceType(
                compute.instanceType,
              );
              if (refusal) {
                send(res, refusal);
                return;
              }
              params = {
                compute,
                configuration: { software, adJoin: req.body.adJoin },
                remove: currentSoftware.filter(
                  item => !software.includes(item),
                ),
                changes,
              };
            } else if (operation === 'reapply')
              params = {
                configuration: {
                  software: currentSoftware,
                  adJoin: configuration.adJoin === true,
                },
              };
            else if (kind === 'power') params = { action: operation };
            // Refuse what the VM platform's health check already shows cannot work (a
            // repeated request returns its run instead).
            const platform = platformOf(entity);
            const observedAt = Date.parse(
              observer?.status(platform).checkedAt ?? '',
            );
            if (
              !repeated &&
              operation !== 'destroy' &&
              observer &&
              Date.now() - observedAt < OBSERVED_FRESH_MS
            ) {
              const instance = observer.get(ref.name, requestId);
              let refusal: string | undefined;
              if (!instance)
                refusal = `No instance for this VM was found in ${await platformLabel(
                  platform,
                  logger,
                )}`;
              else if (operation === 'start') {
                if (instance.state === 'running')
                  refusal = 'The VM is already running';
              } else if (operation === 'stop' && instance.state === 'stopped')
                refusal = 'The VM is already stopped';
              else if (instance.state !== 'running')
                refusal = `The VM is ${instance.state}; start it first`;
              if (refusal) {
                res.status(409).json({ error: refusal });
                return;
              }
            }
            const { run, created } = await exclusive(() =>
              orchestrator.createRun({
                kind,
                name: ref!.name,
                team,
                requestId,
                requestKey: key,
                requestedBy: info.user,
                requesterTeams: info.teams,
                params,
              }),
            );
            if (!created && run.requested_by !== info.user) {
              res.status(409).json({ error: 'Request key already used' });
              return;
            }
            res.json({ runId: run.id, runUrl: orchestrator.runUrl(run.id) });
          }),
        );

        // Browser terminal (CONTRACTS.md §8.4): open, then exchange input/output by short requests.
        router.post(
          '/terminal',
          route(async (req, res) => {
            const credentials = await httpAuth.credentials(req, {
              allow: ['user'],
            });
            const info = await caller(req);
            if (!terminals) {
              res.status(503).json({
                error: 'The terminal is disabled in this environment',
              });
              return;
            }
            const { vm, cols, rows } = req.body ?? {};
            const size = (value: unknown, max: number) =>
              Number.isInteger(value) &&
              Number(value) >= 10 &&
              Number(value) <= max;
            let name: string | undefined;
            try {
              const ref = parseEntityRef(String(vm ?? ''));
              if (
                ref.kind.toLowerCase() === 'resource' &&
                ref.namespace === 'default'
              )
                name = ref.name;
            } catch {
              name = undefined;
            }
            if (
              !name ||
              !/^[a-z][a-z0-9-]{2,20}$/.test(name) ||
              !size(cols, 500) ||
              !size(rows, 200)
            ) {
              res.status(400).json({ error: 'Invalid terminal request' });
              return;
            }
            const found = await readVm(credentials, info, name);
            if (!found.ok) {
              res.status(found.status).json({ error: found.error });
              return;
            }
            // Connect to the address the cloud reports for this incarnation (inventory can lag
            // a console start); freshness is that of the VM's own platform.
            const platform = platformOf(found.entity);
            const instance = observer?.get(name, found.requestId) ?? null;
            const fresh =
              Date.now() -
                Date.parse(observer?.status(platform).checkedAt ?? '') <
              OBSERVED_FRESH_MS;
            if (fresh && instance?.state !== 'running') {
              res.status(409).json({
                error: instance
                  ? `The VM is ${instance.state}; start it first`
                  : `No instance for this VM was found in ${await platformLabel(
                      platform,
                      logger,
                    )}`,
              });
              return;
            }
            const sshUser = found.entity.metadata.annotations?.['cf/ssh-user'];
            if (!sshUser || !/^[a-z_][a-z0-9_-]{0,31}$/.test(sshUser)) {
              res
                .status(409)
                .json({ error: 'The VM has no valid SSH user (cf/ssh-user)' });
              return;
            }
            const host =
              instance?.publicIp ||
              found.entity.metadata.annotations?.['cf/public-ip'];
            if (!host || !/^[0-9]+(\.[0-9]+){3}$/.test(host)) {
              res
                .status(409)
                .json({ error: 'The VM has no public IP address' });
              return;
            }
            try {
              const session = await terminals.open({
                user: info.user,
                vm: name,
                host,
                sshUser,
                // The VM trusts team-<owner> and team-platform-admins (CONTRACTS.md §3).
                principal: info.teams.includes(found.team)
                  ? `team-${found.team}`
                  : 'team-platform-admins',
                cols,
                rows,
              });
              res.json({ ...session, host, user: sshUser });
            } catch (error) {
              if (error instanceof TerminalLimit)
                res.status(429).json({ error: error.message });
              else throw error;
            }
          }),
        );
        router.get(
          '/terminal/:id/output',
          route(async (req, res) => {
            const info = await caller(req);
            const after = Number(req.query.after ?? 0);
            const output = await terminals?.read(
              req.params.id,
              info.user,
              Number.isSafeInteger(after) ? after : 0,
            );
            if (!output)
              res.status(404).json({ error: 'Terminal session not found' });
            else res.json(output);
          }),
        );
        router.post(
          '/terminal/:id/input',
          route(async (req, res) => {
            const info = await caller(req);
            const { data, cols, rows } = req.body ?? {};
            let ok = false;
            if (typeof data === 'string' && data.length <= 16384)
              ok = Boolean(terminals?.input(req.params.id, info.user, data));
            else if (Number.isInteger(cols) && Number.isInteger(rows))
              ok = Boolean(
                terminals?.resize(
                  req.params.id,
                  info.user,
                  Math.min(Math.max(cols, 10), 500),
                  Math.min(Math.max(rows, 5), 200),
                ),
              );
            if (ok) res.json({});
            else
              res
                .status(404)
                .json({ error: 'Terminal session not found or closed' });
          }),
        );
        router.delete(
          '/terminal/:id',
          route(async (req, res) => {
            const info = await caller(req);
            terminals?.close(req.params.id, info.user);
            res.json({});
          }),
        );

        // Latest health check of one VM. Visible to the VM's team (instance tag cf:team) and admins.
        // `?platform=` (the entity's spec.compute.platform) selects that platform's scan status.
        router.get(
          '/observed/:name',
          route(async (req, res) => {
            const info = await caller(req);
            const platform = validPlatform(req.query.platform)
              ? req.query.platform
              : undefined;
            const seen = observer?.get(req.params.name) ?? null;
            const visible =
              seen && (info.admin || info.teams.includes(seen.team ?? ''))
                ? seen
                : null;
            res.json({
              enabled: Boolean(observer),
              ...(observer?.status(platform) ?? {
                checkedAt: null,
                error: null,
              }),
              vm: visible,
            });
          }),
        );

        const visibleRun = async (req: express.Request, info: Caller) => {
          const id = Number(req.params.id);
          const run = Number.isSafeInteger(id)
            ? await orchestrator.getRun(id)
            : undefined;
          return run && allowed(info, run) ? run : undefined;
        };
        router.get(
          '/runs/:id',
          route(async (req, res) => {
            const info = await caller(req);
            const run = await visibleRun(req, info);
            if (!run) res.status(404).json({ error: 'Run not found' });
            else res.json(await orchestrator.view(run, true));
          }),
        );
        router.get(
          '/runs',
          route(async (req, res) => {
            const info = await caller(req);
            const name = String(req.query.name ?? '');
            const count = Math.min(
              20,
              Math.max(1, Number(req.query.limit ?? 10) || 10),
            );
            if (!/^[a-z][a-z0-9-]{2,20}$/.test(name)) {
              res.status(400).json({ error: 'Expected a VM name' });
              return;
            }
            const runs = (await orchestrator.runsFor(name, count)).filter(run =>
              allowed(info, run),
            );
            res.json({
              runs: await Promise.all(
                runs.map(run => orchestrator.view(run, true)),
              ),
            });
          }),
        );
        router.get(
          '/summary',
          route(async (req, res) => {
            const info = await caller(req);
            const runs = (await orchestrator.latestRuns()).filter(run =>
              allowed(info, run),
            );
            const health = observer?.status();
            const platforms = observer
              ? await orchestrator.platforms(runs.map(run => run.request_id))
              : new Map<string, string>();
            res.json({
              observedAt: health?.checkedAt ?? null,
              observedError: health?.error ?? null,
              vms: await Promise.all(
                runs.map(async run => {
                  // Only the instance of this VM incarnation. `observed` is absent (not known)
                  // until the VM's platform has completed a scan; null = no instance there.
                  const seen = observer?.get(run.name, run.request_id) ?? null;
                  const platform =
                    seen?.platform ?? (platforms.get(run.request_id) || 'aws');
                  const known =
                    seen || observer?.status(platform).checkedAt
                      ? { observed: seen }
                      : {};
                  return {
                    name: run.name,
                    latest: await orchestrator.view(run, true),
                    ...known,
                  };
                }),
              ),
            });
          }),
        );
        for (const action of ['retry', 'skip'] as const) {
          router.post(
            `/runs/:id/${action}`,
            route(async (req, res) => {
              const info = await caller(req);
              const run = await visibleRun(req, info);
              if (!run) {
                res.status(404).json({ error: 'Run not found' });
                return;
              }
              await exclusive(async () => {
                // Re-read inside the queue: the engine may have changed the run meanwhile.
                const current = (await orchestrator.getRun(run.id))!;
                await orchestrator[action](current, info.user);
              });
              res.json(
                await orchestrator.view(
                  (await orchestrator.getRun(run.id))!,
                  true,
                ),
              );
            }),
          );
        }
        httpRouter.use(router);

        if (observer) {
          await scheduler.scheduleTask({
            id: 'vm-health',
            frequency: { seconds: 30 },
            timeout: { minutes: 2 },
            fn: () => observer.poll(),
          });
        }
        if (automation) {
          await scheduler.scheduleTask({
            id: 'vm-orchestrator',
            frequency: { seconds: 10 },
            timeout: { minutes: 5 },
            fn: () =>
              exclusive(() =>
                orchestrator
                  .tick()
                  .catch(error =>
                    logger.warn(`VM orchestration paused: ${message(error)}`),
                  ),
              ),
          });
        }
        await scheduler.scheduleTask({
          id: 'demo-reconcile',
          frequency: { seconds: 15 },
          timeout: { minutes: 5 },
          fn: () => exclusive(() => vmDemo.sweep()),
        });
      },
    });
  },
});
