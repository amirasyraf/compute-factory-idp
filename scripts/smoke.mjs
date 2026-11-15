// Run after the image build. No AWS calls or workflow dispatches.
import { execFile, spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../plugins/cf-backend/src/passwords/index.js';

const run = promisify(execFile);
const password = randomUUID();
const users = Buffer.from(
  `amirasyraf:${await hashPassword(password)}`,
).toString('base64');

const configPath = resolve('app-config.smoke.local.yaml');
const port = 17007;
const baseUrl = `http://localhost:${port}`;
const proxyPort = 17008;
const proxyUrl = `http://localhost:${proxyPort}`;
const failureConfigPath = resolve('Caddyfile.smoke.local');
const token = 'local-smoke-static-catalog-token';
const containerName = `cf-idp-smoke-${process.pid}`;
const proxyName = `${containerName}-caddy`;
const networkName = `${containerName}-network`;
const config = {
  app: { baseUrl: proxyUrl },
  computeFactory: { mockServiceNowUrl: `${proxyUrl}/mock-rest/servicenow` },
  backend: {
    baseUrl: proxyUrl,
    listen: { port: 7007, host: '0.0.0.0' },
    cors: { origin: proxyUrl },
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
await writeFile(
  failureConfigPath,
  `http://:${proxyPort} {\n  respond /mock-rest/servicenow 503\n  reverse_proxy backstage:7007\n}\n`,
);
await run('docker', ['network', 'create', networkName]);
const child = spawn(
  'docker',
  [
    'run',
    '--rm',
    '--name',
    containerName,
    '--network',
    networkName,
    '--network-alias',
    'backstage',
    '--memory=2g',
    '--cpus=2',
    '-p',
    `127.0.0.1:${port}:7007`,
    '-p',
    `127.0.0.1:${proxyPort}:${proxyPort}`,
    '-e',
    'GITHUB_TOKEN',
    '-e',
    'IDP_USERS_B64',
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
    env: { ...process.env, IDP_USERS_B64: users, NODE_ENV: 'development' },
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
  await run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    proxyName,
    // Share loopback so both the browser and backend use the same public URL.
    '--network',
    `container:${containerName}`,
    '--memory=128m',
    '--cpus=0.5',
    '-e',
    `IDP_DOMAIN=http://:${proxyPort}`,
    '-v',
    `${resolve('deploy/Caddyfile')}:/etc/caddy/Caddyfile:ro`,
    '-v',
    `${failureConfigPath}:/etc/caddy/failure.Caddyfile:ro`,
    'caddy:2',
  ]);
  ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      ready = (await fetch(`${proxyUrl}/.backstage/health/v1/readiness`)).ok;
    } catch {
      /* proxy starting */
    }
    if (ready) break;
    await delay(1000);
  }
  if (!ready) throw new Error('Caddy readiness timed out');
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
    'user:default/bob',
    'location:default/cf-vms',
    'template:default/ssh-cert',
  ]) {
    if (!refs.includes(ref)) throw new Error(`Missing ${ref}`);
  }
  const platformTemplates = refs.filter(ref =>
    /^template:default\/vm-/.test(ref),
  );
  const mockUrl = `${proxyUrl}/mock-rest/servicenow`;
  const payload = {
    vmName: 'rest-smoke',
    team: 'group:default/alpha',
    platform: 'aws',
    os: 'ubuntu',
    size: 'S',
  };
  const anonymous = await fetch(mockUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (anonymous.status !== 401)
    throw new Error(`Anonymous mock access: ${anonymous.status}`);
  const catalogOnly = await fetch(mockUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (catalogOnly.status !== 403)
    throw new Error(`Catalog-only token mock access: ${catalogOnly.status}`);
  const login = await fetch(`${proxyUrl}/api/auth/password/refresh`, {
    method: 'POST',
    headers: {
      Origin: proxyUrl,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username: 'amirasyraf', password }),
  });
  if (!login.ok) throw new Error(`Local login failed: ${login.status}`);
  const identity = (await login.json()).backstageIdentity;
  const userHeaders = {
    Authorization: `Bearer ${identity.token}`,
    'Content-Type': 'application/json',
  };
  const userAccess = await fetch(mockUrl, {
    method: 'POST',
    headers: userHeaders,
    body: JSON.stringify(payload),
  });
  if (userAccess.status !== 403)
    throw new Error(`Direct user mock access: ${userAccess.status}`);
  const template = {
    apiVersion: 'scaffolder.backstage.io/v1beta3',
    kind: 'Template',
    metadata: { name: 'mock-rest-smoke' },
    spec: {
      owner: 'group:default/alpha',
      type: 'service',
      steps: [
        {
          id: 'servicenow',
          name: 'Create ServiceNow request (mock)',
          action: 'cf:servicenow:create',
          input: payload,
        },
      ],
      output: {
        number: '${{ steps.servicenow.output.number }}',
        httpStatus: '${{ steps.servicenow.output.httpStatus }}',
      },
    },
  };
  const dryRun = await fetch(`${proxyUrl}/api/scaffolder/v2/dry-run`, {
    method: 'POST',
    headers: userHeaders,
    body: JSON.stringify({ template, values: {}, directoryContents: [] }),
  });
  const result = await dryRun.json();
  if (!dryRun.ok)
    throw new Error(`Mock REST dry-run failed: ${JSON.stringify(result)}`);
  if (
    result.output.httpStatus !== 201 ||
    !/^RITM\d{10}$/.test(result.output.number)
  ) {
    throw new Error(
      `Invalid mock REST output: ${JSON.stringify(result.output)}`,
    );
  }
  if (
    !result.log.some(event => event.body.message.includes('HTTP 201 Created'))
  ) {
    throw new Error('Missing REST response evidence in Scaffolder logs');
  }
  const receiverLogs = (await run('docker', ['logs', containerName])).stdout;
  if (
    !receiverLogs.includes('Mock ServiceNow received POST:') ||
    !receiverLogs.includes(result.output.number)
  ) {
    throw new Error('Missing matching receiver-side HTTP evidence');
  }
  const browser = await run('node', ['scripts/workflow-ui.mjs'], {
    env: { ...process.env, WORKFLOW_UI_URL: proxyUrl },
    timeout: 90000,
  });
  console.log(browser.stdout);
  // Make the real REST hop return 503; no following action may execute.
  await run('docker', [
    'exec',
    proxyName,
    'caddy',
    'reload',
    '--config',
    '/etc/caddy/failure.Caddyfile',
    '--adapter',
    'caddyfile',
  ]);
  const failedTemplate = structuredClone(template);
  failedTemplate.spec.steps.push({
    id: 'must-not-run',
    action: 'debug:log',
    input: { message: 'UNEXPECTED_DOWNSTREAM_STEP' },
  });
  const failure = await fetch(`${proxyUrl}/api/scaffolder/v2/dry-run`, {
    method: 'POST',
    headers: userHeaders,
    body: JSON.stringify({
      template: failedTemplate,
      values: {},
      directoryContents: [],
    }),
  });
  const failureBody = await failure.text();
  const failureLogs = (await run('docker', ['logs', containerName])).stdout;
  if (
    failure.ok ||
    !failureBody.includes('Mock ServiceNow returned HTTP 503') ||
    failureLogs.includes('UNEXPECTED_DOWNSTREAM_STEP')
  ) {
    throw new Error(
      `Pre-GHA failure did not stop execution: ${failure.status} ${failureBody}`,
    );
  }
  console.log(
    'SMOKE PASS',
    JSON.stringify({
      readiness: 200,
      refs,
      platformTemplates,
      mockRest: result.output,
      anonymous: anonymous.status,
      catalogOnly: catalogOnly.status,
      directUser: userAccess.status,
      failedPreGha: failure.status,
    }),
  );
  if (platformTemplates.length !== 3)
    console.warn(
      'Platform templates not all available yet; see catalog processing logs.',
    );
} finally {
  await run('docker', ['stop', '-t', '5', proxyName]).catch(() => {});
  if (!exited)
    await run('docker', ['stop', '-t', '10', containerName]).catch(() => {});
  await Promise.race([done, delay(10000)]);
  if (!exited) {
    await run('docker', ['rm', '-f', containerName]).catch(() => {});
    child.kill('SIGKILL');
    await done;
  }
  await rm(configPath, { force: true });
  await rm(failureConfigPath, { force: true });
  await run('docker', ['network', 'rm', networkName]).catch(() => {});
}
