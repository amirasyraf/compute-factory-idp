import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { parseEntityRef } from '@backstage/catalog-model';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import express from 'express';
import { Caller, Reply, createDemo, initializeDemo } from './demo';
import { message } from './github';
import {
  FRY_STAGES,
  Run,
  RunConflict,
  createOrchestrator,
  initializeOrchestrator,
} from './orchestrator';

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
        let queue: Promise<unknown> = Promise.resolve();
        function exclusive<T>(fn: () => Promise<T>): Promise<T> {
          const result = queue.then(fn);
          queue = result.catch(() => {});
          return result;
        }
        const orchestrator = createOrchestrator({
          db,
          logger,
          appBaseUrl: config.getString('app.baseUrl').replace(/\/$/, ''),
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

        // Refry and destroy of an existing VM, created by the `cf:vm:run` scaffolder action.
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
            const { operation, vm, stage, software, requestKey } =
              req.body ?? {};
            let ref;
            try {
              ref = parseEntityRef(String(vm ?? ''));
            } catch {
              ref = undefined;
            }
            const valid =
              ['refry', 'destroy'].includes(operation) &&
              typeof requestKey === 'string' &&
              /^[a-zA-Z0-9_-]{1,100}$/.test(requestKey) &&
              ref?.kind.toLowerCase() === 'resource' &&
              ref.namespace === 'default' &&
              /^[a-z][a-z0-9-]{2,20}$/.test(ref.name) &&
              (operation === 'destroy' ||
                (FRY_STAGES.includes(stage) &&
                  (software === undefined ||
                    (Array.isArray(software) &&
                      software.length <= 20 &&
                      software.every(
                        (item: unknown) =>
                          typeof item === 'string' &&
                          /^[a-z0-9][a-z0-9-]{0,40}$/.test(item),
                      )))));
            if (!valid || !ref) {
              res.status(400).json({ error: 'Invalid VM operation' });
              return;
            }
            // The catalog permission policy only lets owners (and admins) read VM entities.
            const entity = await catalog.getEntityByRef(
              { kind: 'Resource', namespace: 'default', name: ref.name },
              { credentials },
            );
            const team = /^group:default\/([a-z][a-z0-9-]*)$/.exec(
              String(entity?.spec?.owner ?? ''),
            )?.[1];
            if (!entity || entity.spec?.type !== 'vm' || !team) {
              res.status(404).json({ error: `VM ${ref.name} not found` });
              return;
            }
            if (!info.admin && !info.teams.includes(team)) {
              res.status(403).json({ error: 'VM belongs to another team' });
              return;
            }
            const requestId = entity.metadata.annotations?.['cf/request-id'];
            if (!requestId) {
              res.status(409).json({ error: 'VM inventory has no request ID' });
              return;
            }
            const { run, created } = await exclusive(() =>
              orchestrator.createRun({
                kind: operation,
                name: ref!.name,
                team,
                requestId,
                requestKey: `${operation}:${requestKey}`,
                requestedBy: info.user,
                requesterTeams: info.teams,
                params:
                  operation === 'refry'
                    ? {
                        stage,
                        software: stage === 'software' ? software ?? [] : [],
                      }
                    : {},
              }),
            );
            if (!created && run.requested_by !== info.user) {
              res.status(409).json({ error: 'Request key already used' });
              return;
            }
            res.json({ runId: run.id, runUrl: orchestrator.runUrl(run.id) });
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
            res.json({
              vms: await Promise.all(
                runs.map(async run => ({
                  name: run.name,
                  latest: await orchestrator.view(run, true),
                })),
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
