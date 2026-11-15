import { passwordProviderFactory } from './auth';
import { hashPassword } from './passwords';

const originalUsers = process.env.IDP_USERS_B64;
beforeAll(async () => {
  const hash = await hashPassword('test-password');
  process.env.IDP_USERS_B64 = Buffer.from(`alice:${hash}\n`).toString('base64');
});
afterAll(() => {
  if (originalUsers === undefined) delete process.env.IDP_USERS_B64;
  else process.env.IDP_USERS_B64 = originalUsers;
});
function setup() {
  const claims = {
    sub: 'user:default/alice',
    ent: ['user:default/alice', 'group:default/alpha'],
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const resolve = jest.fn().mockResolvedValue({
    token: `header.${Buffer.from(JSON.stringify(claims)).toString(
      'base64url',
    )}.signature`,
  });
  const provider = passwordProviderFactory({
    appUrl: 'https://idp.example.test',
    baseUrl: 'https://idp.example.test/api/auth',
    providerId: 'password',
    isOriginAllowed: (origin: string) => origin === 'https://idp.example.test',
    resolverContext: { signInWithCatalogUser: resolve },
  } as any);
  const req = (method: string, body?: unknown, cookie?: string) =>
    ({
      method,
      body,
      cookies: { 'cf-idp-session': cookie },
      get: (name: string) =>
        name.toLowerCase() === 'origin'
          ? 'https://idp.example.test'
          : 'XMLHttpRequest',
      is: (type: string) => type === 'application/json',
    } as any);
  const response = () => {
    const res: any = {
      setHeader: jest.fn(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
      json: jest.fn(),
      end: jest.fn(),
    };
    res.status = jest.fn().mockReturnValue(res);
    return res;
  };
  return { provider, resolve, req, response };
}
it('issues a secure 12h cookie and catalog identity, then restores without a password', async () => {
  const { provider, resolve, req, response } = setup();
  const res = response();
  await provider.refresh!(
    req('POST', { username: 'alice', password: 'test-password' }),
    res,
  );
  expect(resolve).toHaveBeenCalledWith({
    entityRef: { kind: 'User', namespace: 'default', name: 'alice' },
  });
  expect(res.cookie).toHaveBeenCalledWith(
    'cf-idp-session',
    expect.any(String),
    expect.objectContaining({
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 43200000,
    }),
  );
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({
      backstageIdentity: expect.objectContaining({
        identity: expect.objectContaining({
          ownershipEntityRefs: ['user:default/alice', 'group:default/alpha'],
        }),
      }),
    }),
  );
  const cookie = res.cookie.mock.calls[0][1];
  const restored = response();
  await provider.refresh!(req('GET', undefined, cookie), restored);
  expect(restored.json).toHaveBeenCalled();
  expect(restored.cookie).not.toHaveBeenCalled(); // No sliding renewal.
  const tampered = response();
  await provider.refresh!(req('GET', undefined, `${cookie}x`), tampered);
  expect(tampered.status).toHaveBeenCalledWith(204);
  const now = jest
    .spyOn(Date, 'now')
    .mockReturnValue(Date.now() + 13 * 3600000);
  try {
    const expired = response();
    await provider.refresh!(req('GET', undefined, cookie), expired);
    expect(expired.status).toHaveBeenCalledWith(204);
  } finally {
    now.mockRestore();
  }
});
it.each([
  ['alice', 'wrong'],
  ['unknown', 'test-password'],
])('rejects %s with the same generic message', async (username, password) => {
  const { provider, resolve, req, response } = setup();
  const res = response();
  await provider.refresh!(req('POST', { username, password }), res);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({
    error: 'Invalid username or password',
  });
  expect(resolve).not.toHaveBeenCalled();
});
it('rejects a configured password for a missing catalog user', async () => {
  const { provider, resolve, req, response } = setup();
  resolve.mockRejectedValue(new Error('User not found'));
  const res = response();
  await provider.refresh!(
    req('POST', { username: 'alice', password: 'test-password' }),
    res,
  );
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({
    error: 'Invalid username or password',
  });
  expect(res.cookie).not.toHaveBeenCalled();
});
it('clears the cookie on sign out and rejects cross-origin login', async () => {
  const { provider, req, response } = setup();
  const res = response();
  await provider.logout!(req('POST'), res);
  expect(res.clearCookie).toHaveBeenCalledWith(
    'cf-idp-session',
    expect.objectContaining({ path: '/api/auth/password' }),
  );
  const foreign = req('POST', { username: 'alice', password: 'test-password' });
  foreign.get = (name: string) =>
    name.toLowerCase() === 'origin'
      ? 'https://evil.example.test'
      : 'XMLHttpRequest';
  const denied = response();
  await provider.refresh!(foreign, denied);
  expect(denied.status).toHaveBeenCalledWith(403);
});
