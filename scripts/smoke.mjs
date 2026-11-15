// Run after the image build. No AWS calls or workflow dispatches.
import { execFile, spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const configPath = resolve('app-config.smoke.local.yaml');
const port = 17007;
const baseUrl = `http://localhost:${port}`;
const token = 'local-smoke-static-catalog-token';
const containerName = `cf-idp-smoke-${process.pid}`;
const config = {
  app: { baseUrl },
  backend: {
    baseUrl,
    listen: { port, host: '0.0.0.0' },
    auth: {
      externalAccess: [
        {
          type: 'static',
          options: { token, subject: 'smoke' },
          accessRestrictions: [{ plugin: 'catalog' }],
        },
      ],
    },
  },
  auth: { providers: { guest: { userEntityRef: 'user:default/amirasyraf' } } },
  catalog: {
    locations: [
      'org.yaml',
      'locations.yaml',
      'templates/ssh-cert/template.yaml',
    ].map(file => ({ type: 'file', target: `/app/catalog/${file}` })),
  },
};
// Contains only dummy local credentials, never the GitHub token.
await writeFile(configPath, JSON.stringify(config), { mode: 0o644 });
const child = spawn(
  'docker',
  [
    'run',
    '--rm',
    '--name',
    containerName,
    '--memory=2g',
    '--cpus=2',
    '-p',
    `127.0.0.1:${port}:${port}`,
    '-e',
    'GITHUB_TOKEN',
    '-e',
    'NODE_ENV=development',
    '-v',
    `${configPath}:/app/app-config.smoke.local.yaml:ro`,
    'compute-factory-idp:latest',
    'node',
    'packages/backend',
    '--config',
    'app-config.yaml',
    '--config',
    '/app/app-config.smoke.local.yaml',
  ],
  {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, NODE_ENV: 'development' },
  },
);
let exited = false;
const done = new Promise(resolveDone =>
  child.once('exit', code => {
    exited = true;
    resolveDone(code);
  }),
);
try {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (exited) throw new Error('Backend exited before readiness');
    try {
      ready = (await fetch(`${baseUrl}/.backstage/health/v1/readiness`)).ok;
    } catch {
      /* starting */
    }
    if (ready) break;
    await delay(1000);
  }
  if (!ready) throw new Error('Backend readiness timed out');
  let refs = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${baseUrl}/api/catalog/entities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new Error(
        `Catalog HTTP ${response.status}: ${await response.text()}`,
      );
    refs = (await response.json()).map(
      entity =>
        `${entity.kind.toLowerCase()}:${
          entity.metadata.namespace ?? 'default'
        }/${entity.metadata.name}`,
    );
    if (
      [
        'user:default/amirasyraf',
        'location:default/cf-vms',
        'template:default/ssh-cert',
        'template:default/vm-request',
        'template:default/vm-destroy',
        'template:default/vm-refry',
      ].every(ref => refs.includes(ref))
    )
      break;
    await delay(1000);
  }
  for (const ref of [
    'group:default/alpha',
    'group:default/bravo',
    'group:default/platform-admins',
    'user:default/amirasyraf',
    'location:default/cf-vms',
    'template:default/ssh-cert',
  ]) {
    if (!refs.includes(ref)) throw new Error(`Missing ${ref}`);
  }
  const platformTemplates = refs.filter(ref =>
    /^template:default\/vm-/.test(ref),
  );
  console.log(
    'SMOKE PASS',
    JSON.stringify({ readiness: 200, refs, platformTemplates }),
  );
  if (platformTemplates.length !== 3)
    console.warn(
      'Platform templates not all available yet; see catalog processing logs.',
    );
} finally {
  if (!exited)
    await run('docker', ['stop', '-t', '10', containerName]).catch(() => {});
  await Promise.race([done, delay(10000)]);
  if (!exited) {
    await run('docker', ['rm', '-f', containerName]).catch(() => {});
    child.kill('SIGKILL');
    await done;
  }
  await rm(configPath, { force: true });
}
