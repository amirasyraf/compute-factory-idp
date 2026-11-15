import {
  hashPassword,
  verifyPassword,
  readUsers,
  verifyUserPassword,
} from './passwords';

let hash: string;
beforeAll(async () => {
  hash = await hashPassword('correct horse battery staple');
});
it('verifies a good password and uses independently salted hashes', async () => {
  expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  expect(await hashPassword('correct horse battery staple')).not.toBe(hash);
});
it('rejects a bad password', async () => {
  expect(await verifyPassword('wrong password', hash)).toBe(false);
});
it('rejects an unknown user', async () => {
  const users = readUsers(Buffer.from(`alice:${hash}\n`).toString('base64'));
  expect(
    await verifyUserPassword(users, 'unknown', 'correct horse battery staple'),
  ).toBe(false);
  expect(
    await verifyUserPassword(users, 'alice', 'correct horse battery staple'),
  ).toBe(true);
});
it.each(['', 'bad', 'scrypt$999999999$8$1$AAAA$AAAA', 'scrypt$16384$8$1$!$!'])(
  'rejects malformed hashes: %s',
  async bad => {
    expect(await verifyPassword('correct horse battery staple', bad)).toBe(
      false,
    );
  },
);
it('rejects malformed user configuration', () => {
  expect(() => readUsers('!')).toThrow();
  expect(() =>
    readUsers(Buffer.from('alice:hash\nalice:hash').toString('base64')),
  ).toThrow();
});
