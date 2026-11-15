import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { UserEntity } from '@backstage/catalog-model';
import { CatalogService } from '@backstage/plugin-catalog-node';
import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import { createSshSignAction, signPublicKey } from './sign';

const run = promisify(execFile);
const user: UserEntity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'User',
  metadata: { name: 'alice' },
  spec: { memberOf: ['alpha', 'group:default/bravo'] },
};
let dir: string;
let key: string;
let ca: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cf-sign-test-'));
  for (const name of ['ca', 'user']) {
    await run('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-f',
      join(dir, name),
    ]);
  }
  key = await readFile(join(dir, 'user.pub'), 'utf8');
  ca = await readFile(join(dir, 'ca'), 'utf8');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('signs a real certificate with catalog principals, username and exactly 12h validity', async () => {
  const getCa = jest.fn().mockResolvedValue(ca);
  const result = await signPublicKey(key, user, getCa);
  await writeFile(join(dir, 'cert.pub'), result.certificate);
  const { stdout } = await run('ssh-keygen', [
    '-L',
    '-f',
    join(dir, 'cert.pub'),
  ]);
  expect(stdout).toContain('Key ID: "alice"');
  expect(stdout).toContain('team-alpha');
  expect(stdout).toContain('team-bravo');
  const dates = stdout.match(/Valid: from (\S+) to (\S+)/)!;
  expect(new Date(dates[2]).getTime() - new Date(dates[1]).getTime()).toBe(
    43200000,
  );
  expect(new Date(result.validUntil).getTime() - Date.now()).toBeGreaterThan(
    43190000,
  );
  expect(getCa).toHaveBeenCalledTimes(1);
});

it.each([
  'bad',
  'ssh-ed25519 AAAA',
  'ssh-ed25519 AAAA\nssh-ed25519 AAAA',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
])('rejects bad keys: %s', async bad => {
  const getCa = jest.fn();
  await expect(signPublicKey(bad, user, getCa)).rejects.toThrow();
  expect(getCa).not.toHaveBeenCalled();
});

it('action reads initiating catalog user, ignores attempted principal input', async () => {
  const credentials = mockCredentials.user('user:default/alice');
  const getEntityByRef = jest.fn().mockResolvedValue(user);
  const action = createSshSignAction(
    { getEntityByRef } as unknown as CatalogService,
    mockServices.auth(),
    async () => ca,
  );
  const output = jest.fn();
  await action.handler({
    input: {
      publicKey: key,
      principals: ['team-platform-admins'],
      username: 'root',
    },
    getInitiatorCredentials: async () => credentials,
    output,
  } as any);
  expect(getEntityByRef).toHaveBeenCalledWith('user:default/alice', {
    credentials,
  });
  expect(output).toHaveBeenCalledWith('principals', [
    'team-alpha',
    'team-bravo',
  ]);
  const cert = output.mock.calls.find(([name]) => name === 'certificate')![1];
  await writeFile(join(dir, 'action-cert.pub'), cert);
  const { stdout } = await run('ssh-keygen', [
    '-L',
    '-f',
    join(dir, 'action-cert.pub'),
  ]);
  expect(stdout).toContain('Key ID: "alice"');
  expect(stdout).not.toContain('team-platform-admins');
});

it('rejects a user without teams', async () => {
  await expect(
    signPublicKey(key, { ...user, spec: { memberOf: [] } }),
  ).rejects.toThrow('no team');
});
