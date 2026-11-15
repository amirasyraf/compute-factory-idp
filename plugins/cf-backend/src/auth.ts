import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  AuthProviderFactory,
  prepareBackstageIdentityResponse,
} from '@backstage/plugin-auth-node';
import { readUsers, verifyUserPassword } from './passwords';

const lifetime = 12 * 60 * 60;
const cookieName = 'cf-idp-session';
const invalid = { error: 'Invalid username or password' };

export const passwordProviderFactory: AuthProviderFactory = options => {
  const encoded = process.env.IDP_USERS_B64;
  const users = readUsers(encoded);
  // Hash records are secret configuration. Changing any record rotates the
  // signing key and invalidates all sessions, including across backend restarts.
  const signingKey = createHash('sha256')
    .update('compute-factory-session-v1\0')
    .update(encoded!)
    .digest();
  const sign = (value: string) =>
    createHmac('sha256', signingKey).update(value).digest('base64url');
  const secure = new URL(options.appUrl).protocol === 'https:';
  if (!secure && process.env.NODE_ENV === 'production')
    throw new Error('Password login requires HTTPS in production');
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: new URL(`${options.baseUrl}/${options.providerId}`).pathname,
  };

  function sessionUser(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 2048) return undefined;
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra) return undefined;
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return undefined;
    try {
      const session = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      );
      if (
        typeof session.username === 'string' &&
        users.has(session.username) &&
        Number.isSafeInteger(session.expires) &&
        session.expires > Date.now()
      )
        return session.username;
    } catch {
      /* invalid session */
    }
    return undefined;
  }

  return {
    async start(_req, res) {
      res.status(405).end();
    },
    async frameHandler(_req, res) {
      res.status(405).end();
    },
    async refresh(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      // Both POST login and cookie refresh require a same-app AJAX request.
      const origin = req.get('origin');
      if (
        req.get('X-Requested-With') !== 'XMLHttpRequest' ||
        (origin && !options.isOriginAllowed(origin))
      ) {
        res.status(403).json(invalid);
        return;
      }
      let username: string | undefined;
      if (req.method === 'POST') {
        if (
          !req.is('application/json') ||
          !origin ||
          !options.isOriginAllowed(origin)
        ) {
          res.status(403).json(invalid);
          return;
        }
        const body = req.body ?? {};
        if (
          typeof body.username !== 'string' ||
          typeof body.password !== 'string' ||
          !(await verifyUserPassword(users, body.username, body.password))
        ) {
          res.status(401).json(invalid);
          return;
        }
        username = body.username;
      } else {
        username = sessionUser(req.cookies?.[cookieName]);
        if (!username) {
          res.clearCookie(cookieName, cookieOptions);
          res.status(204).end();
          return;
        }
      }
      try {
        // Default resolver emits the user plus direct catalog groups; no fallback.
        const identity = await options.resolverContext.signInWithCatalogUser({
          entityRef: { kind: 'User', namespace: 'default', name: username! },
        });
        if (req.method === 'POST') {
          const payload = Buffer.from(
            JSON.stringify({ username, expires: Date.now() + lifetime * 1000 }),
          ).toString('base64url');
          res.cookie(cookieName, `${payload}.${sign(payload)}`, {
            ...cookieOptions,
            maxAge: lifetime * 1000,
          });
        }
        res.json({
          profile: { displayName: username },
          providerInfo: {},
          backstageIdentity: prepareBackstageIdentityResponse(identity),
        });
      } catch {
        res.clearCookie(cookieName, cookieOptions);
        res.status(401).json(invalid);
      }
    },
    async logout(req, res) {
      const origin = req.get('origin');
      if (
        req.get('X-Requested-With') !== 'XMLHttpRequest' ||
        !origin ||
        !options.isOriginAllowed(origin)
      ) {
        res.status(403).end();
        return;
      }
      res.clearCookie(cookieName, cookieOptions);
      res.setHeader('Cache-Control', 'no-store');
      res.status(204).end();
    },
  };
};
