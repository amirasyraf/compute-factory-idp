import { createHash } from 'node:crypto';
import {
  AuthService,
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import express from 'express';

// A stateless demo receiver, not a ServiceNow emulator or a ticket database.
export const mockRestPlugin = createBackendPlugin({
  pluginId: 'mock-rest',
  register(reg) {
    reg.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        logger: coreServices.logger,
      },
      async init({ httpRouter, httpAuth, logger }) {
        const router = express.Router();
        router.use(express.json({ limit: '8kb' }));
        router.post('/servicenow', async (req, res, next) => {
          try {
            const credentials = await httpAuth.credentials(req, {
              allow: ['service'],
            });
            if (credentials.principal.subject !== 'plugin:scaffolder') {
              res
                .status(403)
                .json({ error: 'Only the Scaffolder may call this mock' });
              return;
            }
            const body = req.body;
            const fields = [
              'requestId',
              'vmName',
              'team',
              'requestedBy',
              'platform',
              'os',
              'size',
            ];
            if (
              !req.is('application/json') ||
              !body ||
              fields.some(
                key =>
                  typeof body[key] !== 'string' ||
                  !body[key].length ||
                  body[key].length > 200 ||
                  body[key]
                    .split('')
                    .some(
                      (character: string) =>
                        character.charCodeAt(0) < 32 ||
                        character.charCodeAt(0) === 127,
                    ),
              ) ||
              !/^[a-z][a-z0-9-]{2,20}$/.test(body.vmName) ||
              body.platform !== 'aws' ||
              body.os !== 'ubuntu' ||
              !['S', 'M', 'L'].includes(body.size)
            ) {
              res.status(400).json({ error: 'Invalid mock VM request' });
              return;
            }
            // Stable for retries of the same task; no records are persisted.
            const suffix = createHash('sha256')
              .update(body.requestId)
              .digest()
              .readUInt32BE(0)
              .toString()
              .padStart(10, '0');
            const result = {
              number: `RITM${suffix}`,
              status: 'created',
              mock: true,
              requestId: body.requestId,
            };
            logger.info(
              `Mock ServiceNow received POST: ${JSON.stringify({
                requestId: body.requestId,
                vmName: body.vmName,
                number: result.number,
              })}`,
            );
            res.status(201).json(result);
          } catch (error) {
            next(error);
          }
        });
        httpRouter.use(router);
      },
    });
  },
});

export function createServiceNowRequestAction(
  auth: AuthService,
  config: Config,
) {
  const url = new URL(config.getString('computeFactory.mockServiceNowUrl'));
  const backendUrl = new URL(config.getString('backend.baseUrl'));
  // Never send a plugin credential to a user-controlled destination or redirect.
  if (
    url.origin !== backendUrl.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['/mock-rest/servicenow', '/api/mock-rest/servicenow'].includes(
      url.pathname,
    )
  ) {
    throw new Error('Mock ServiceNow URL must point to this IDP mock endpoint');
  }
  return createTemplateAction({
    id: 'cf:servicenow:create',
    description:
      'POST VM details to the mock ServiceNow REST endpoint before GHA',
    // Safe to exercise in Template Editor: the receiver persists no records.
    supportsDryRun: true,
    schema: {
      input: {
        vmName: z => z.string().regex(/^[a-z][a-z0-9-]{2,20}$/),
        team: z =>
          z
            .string()
            .min(1)
            .max(200)
            .regex(/^[a-zA-Z0-9_./:-]+$/),
        platform: z => z.enum(['aws']),
        os: z => z.enum(['ubuntu']),
        size: z => z.enum(['S', 'M', 'L']),
      },
      output: {
        number: z => z.string(),
        httpStatus: z => z.number(),
      },
    },
    async handler(ctx) {
      const initiator = await ctx.getInitiatorCredentials();
      if (!auth.isPrincipal(initiator, 'user')) {
        throw new Error('A signed-in user is required');
      }
      const requestId = ctx.task.id;
      const { token } = await auth.getPluginRequestToken({
        onBehalfOf: await auth.getOwnServiceCredentials(),
        targetPluginId: 'mock-rest',
      });
      ctx.logger.info(
        `POST ${url.href} (mock ServiceNow; no real ticket is created)`,
      );
      const signal = AbortSignal.timeout(10000);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...ctx.input,
          requestId,
          requestedBy: initiator.principal.userEntityRef,
        }),
        redirect: 'error',
        signal: ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal,
      });
      if (response.status !== 201) {
        throw new Error(
          `Mock ServiceNow returned HTTP ${response.status}; VM pipeline not started`,
        );
      }
      const result = await response.json();
      if (
        !result ||
        result.mock !== true ||
        result.status !== 'created' ||
        result.requestId !== requestId ||
        typeof result.number !== 'string' ||
        !/^RITM\d{10}$/.test(result.number)
      ) {
        throw new Error(
          'Invalid mock ServiceNow response; VM pipeline not started',
        );
      }
      ctx.logger.info(
        `HTTP 201 Created — mock ServiceNow request ${result.number} accepted for ${ctx.input.vmName}`,
      );
      ctx.output('number', result.number);
      ctx.output('httpStatus', response.status);
    },
  });
}
