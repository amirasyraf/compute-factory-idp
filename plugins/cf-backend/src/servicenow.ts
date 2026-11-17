import { createHash } from 'node:crypto';
import {
  AuthService,
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import express from 'express';

const sizePattern = /^([A-Z]{1,4}|[a-z][a-z0-9-]*\.[a-z0-9]+)$/;

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
            if (credentials.principal.subject !== 'plugin:vms') {
              res
                .status(403)
                .json({ error: 'Only the VM orchestrator may call this mock' });
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
              !sizePattern.test(body.size)
            ) {
              res.status(400).json({ error: 'Invalid mock VM request' });
              return;
            }
            // Stable for retries of the same request; no records are persisted.
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

export type ServiceNowRequest = {
  requestId: string;
  vmName: string;
  team: string;
  requestedBy: string;
  platform: string;
  os: string;
  size: string;
};

/** An error the orchestrator must not retry automatically. */
export class PermanentError extends Error {
  readonly permanent = true;
}

/**
 * Client for the mock ServiceNow receiver, used by the orchestrator's in-IDP `servicenow` stage.
 * HTTP 5xx/429, timeouts and network errors are transient; anything else unexpected is permanent.
 */
export function createServiceNowClient(auth: AuthService, config: Config) {
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
  return async (body: ServiceNowRequest): Promise<string> => {
    if (
      !/^[a-z][a-z0-9-]{2,20}$/.test(body.vmName) ||
      body.platform !== 'aws' ||
      body.os !== 'ubuntu' ||
      !sizePattern.test(body.size)
    )
      throw new PermanentError('Invalid VM details for the ServiceNow request');
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: await auth.getOwnServiceCredentials(),
      targetPluginId: 'mock-rest',
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // Never follow a redirect; a 3xx is an unexpected (permanent) answer below.
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 201) {
      const failure = `Mock ServiceNow returned HTTP ${response.status}`;
      if (response.status >= 500 || response.status === 429)
        throw new Error(failure);
      throw new PermanentError(failure);
    }
    // A body read that times out or breaks propagates as a transient error; only a
    // complete but malformed body is permanent.
    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      result = undefined;
    }
    if (
      !result ||
      result.mock !== true ||
      result.status !== 'created' ||
      result.requestId !== body.requestId ||
      typeof result.number !== 'string' ||
      !/^RITM\d{10}$/.test(result.number)
    )
      throw new PermanentError('Invalid mock ServiceNow response');
    return result.number;
  };
}
