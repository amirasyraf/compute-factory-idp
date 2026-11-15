import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { UserEntity, parseEntityRef } from '@backstage/catalog-model';
import { CatalogService } from '@backstage/plugin-catalog-node';
import { AuthService } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

const run = promisify(execFile);
export async function fetchCa(): Promise<string> {
  const secretId = process.env.SSH_CA_SECRET_ID;
  if (!secretId || !process.env.AWS_REGION)
    throw new Error('SSH_CA_SECRET_ID and AWS_REGION are required');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    if (!result.SecretString) throw new Error('SSH CA SecretString is empty');
    return result.SecretString;
  } finally {
    client.destroy();
  }
}

// Separate from action plumbing so real ssh-keygen signing is easy to test.
export async function signPublicKey(
  publicKey: string,
  user: UserEntity,
  getCa = fetchCa,
) {
  const key = publicKey.trim();
  if (
    key.length > 16384 ||
    !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/.test(
      key,
    )
  ) {
    throw new Error('Provide exactly one OpenSSH public key line');
  }
  const username = user.metadata.name;
  const groups = user.spec.memberOf ?? [];
  const principals = [
    ...new Set(
      groups.map(group => {
        const ref = parseEntityRef(group, { defaultKind: 'Group' });
        if (
          ref.kind.toLowerCase() !== 'group' ||
          !/^[a-zA-Z0-9_.-]+$/.test(ref.name)
        ) {
          throw new Error('Invalid group membership');
        }
        return `team-${ref.name}`;
      }),
    ),
  ];
  if (!principals.length) throw new Error('User has no team memberships');
  const dir = await mkdtemp(join(tmpdir(), 'cf-ssh-'));
  const validAfter = Math.floor(Date.now() / 1000);
  const validBefore = validAfter + 12 * 60 * 60;
  try {
    const caFile = join(dir, 'ca');
    const keyFile = join(dir, 'user.pub');
    await writeFile(keyFile, `${key}\n`, { mode: 0o600 });
    // ssh-keygen validates the key blob, not just its textual envelope.
    await run('ssh-keygen', ['-l', '-f', keyFile], { timeout: 10000 });
    await writeFile(caFile, `${(await getCa()).trim()}\n`, { mode: 0o600 });
    await run(
      'ssh-keygen',
      [
        '-q',
        '-s',
        caFile,
        '-I',
        username,
        '-n',
        principals.join(','),
        '-V',
        `0x${validAfter.toString(16)}:0x${validBefore.toString(16)}`,
        keyFile,
      ],
      { timeout: 10000 },
    );
    return {
      certificate: (await readFile(join(dir, 'user-cert.pub'), 'utf8')).trim(),
      principals,
      validUntil: new Date(validBefore * 1000).toISOString(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createSshSignAction(
  catalog: CatalogService,
  auth: AuthService,
  getCa = fetchCa,
) {
  return createTemplateAction({
    id: 'cf:ssh:sign',
    description:
      'Sign your OpenSSH public key for your catalog team memberships (12h)',
    schema: {
      input: { publicKey: z => z.string() },
      output: {
        certificate: z => z.string(),
        principals: z => z.array(z.string()),
        validUntil: z => z.string(),
      },
    },
    async handler(ctx) {
      const credentials = await ctx.getInitiatorCredentials();
      if (!auth.isPrincipal(credentials, 'user'))
        throw new Error('A signed-in user is required');
      // Never trust input or the template's user object for memberships.
      const entity = await catalog.getEntityByRef(
        credentials.principal.userEntityRef,
        { credentials },
      );
      if (!entity || entity.kind.toLowerCase() !== 'user')
        throw new Error('Initiating user is not in the catalog');
      const result = await signPublicKey(
        ctx.input.publicKey,
        entity as UserEntity,
        getCa,
      );
      ctx.output('certificate', result.certificate);
      ctx.output('principals', result.principals);
      ctx.output('validUntil', result.validUntil);
    },
  });
}
