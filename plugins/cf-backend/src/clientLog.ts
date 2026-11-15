import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import express from 'express';

const perUserPerMinute = 60;
const clip = (value: unknown, max: number) =>
  typeof value === 'string' ? value.slice(0, max) : '';

// Browser-side failures (task update polling, uncaught errors, stale bundles) are otherwise
// invisible on the server. Signed-in users only; bounded size and rate.
export const clientLogPlugin = createBackendPlugin({
  pluginId: 'client-log',
  register(reg) {
    reg.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        logger: coreServices.logger,
      },
      async init({ httpRouter, httpAuth, logger }) {
        const windows = new Map<string, { start: number; count: number }>();
        const router = express.Router();
        router.use(express.json({ limit: '8kb' }));
        router.post('/events', async (req, res, next) => {
          try {
            const credentials = await httpAuth.credentials(req, {
              allow: ['user'],
            });
            const user = credentials.principal.userEntityRef;
            const now = Date.now();
            let bucket = windows.get(user);
            if (!bucket || now - bucket.start > 60_000) {
              bucket = { start: now, count: 0 };
              windows.set(user, bucket);
            }
            if (++bucket.count > perUserPerMinute) {
              res.status(429).end();
              return;
            }
            const { kind, message } = req.body ?? {};
            if (
              typeof kind !== 'string' ||
              !/^[a-z][a-z0-9-]{1,40}$/.test(kind) ||
              typeof message !== 'string'
            ) {
              res.status(400).json({ error: 'Expected kind and message' });
              return;
            }
            logger.warn(`Browser ${kind}: ${clip(message, 500)}`, {
              type: 'clientEvent',
              kind,
              user,
              ip: req.ip ?? '',
              userAgent: clip(req.get('user-agent'), 200),
              page: clip(req.body.page, 200),
              bundle: clip(req.body.bundle, 40),
              detail: clip(req.body.detail, 2000),
            });
            res.status(204).end();
          } catch (error) {
            next(error);
          }
        });
        httpRouter.use(router);
      },
    });
  },
});
