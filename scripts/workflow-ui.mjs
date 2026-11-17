// Exercise the actual served frontend with fixture APIs only. No login credentials,
// workflow dispatches, VM creation or backend writes. Run against local or deployed UI.
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.WORKFLOW_UI_URL;
if (!base) throw new Error('Set WORKFLOW_UI_URL to the frontend URL');
let admin = false;
const template = {
  apiVersion: 'scaffolder.backstage.io/v1beta3',
  kind: 'Template',
  metadata: { name: 'vm-request', namespace: 'default', title: 'Request a VM' },
  spec: { type: 'vm', owner: 'group:default/alpha' },
};
const vm = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: {
    name: 'spec-vm',
    namespace: 'default',
    uid: 'spec-vm-fixture',
    annotations: {
      'cf/status': 'ready',
      'cf/instance-type': 't3.medium',
      'cf/public-ip': '203.0.113.42',
      'cf/ssh-user': 'ubuntu',
      'cf/requested-at': '2026-11-17T08:00:00Z',
      'cf/ready-at': '2026-11-17T08:05:00Z',
    },
  },
  spec: {
    type: 'vm',
    owner: 'group:default/alpha',
    lifecycle: 'poc',
    compute: { platform: 'aws', os: 'ubuntu', size: 'M' },
    configuration: { software: ['git', 'nginx'], adJoin: false },
    billing: { costCenter: 'CC-1234' },
    cloudTags: { environment: 'test' },
  },
  relations: [{ type: 'ownedBy', targetRef: 'group:default/alpha' }],
};
const task = {
  id: 'workflow-ui-fixture',
  status: 'processing',
  createdAt: '2026-11-15T00:00:00Z',
  spec: {
    apiVersion: 'scaffolder.backstage.io/v1beta3',
    parameters: {},
    output: {},
    templateInfo: {
      entityRef: 'template:default/vm-request',
      entity: template,
    },
    steps: [
      {
        id: 'dispatch',
        name: 'Start VM pipeline',
        action: 'cf:vm:dispatch',
      },
    ],
  },
};
const stage = (id, status, steps = []) => ({
  id,
  status,
  attempt: ['pending', 'skipped'].includes(status) ? 0 : 1,
  maxAttempts: 4,
  nextAttemptAt: null,
  startedAt: ['pending', 'skipped'].includes(status)
    ? null
    : new Date(Date.now() - 125000).toISOString(),
  finishedAt:
    status === 'success' ? new Date(Date.now() - 65000).toISOString() : null,
  error: null,
  skippable: ['software', 'ad-join'].includes(id),
  skippedBy: null,
  retriedBy: null,
  outcome: null,
  summary: null,
  runUrl:
    id === 'servicenow' || ['pending', 'skipped'].includes(status)
      ? null
      : 'https://github.com/example/platform/actions/runs/123',
  steps,
  attempts: [],
});
let demoOn = false;
let streamRequests = 0;
let runReads = 0;
let actionError = false;
let actionPosts = 0;
let summaryReads = 0;
let demoSettings = 0;
let noSummary = false;
let runReadError = false;
let latestReads = 0;
let entityGone = false;
let taskResult = 'processing';
let taskOutput = {
  links: [{ title: 'Follow provisioning', url: `${base}/vms/runs/42` }],
};
let listVms = [vm];
let summaryMatrix;
let snapshot = {
  id: 42,
  kind: 'provision',
  name: 'spec-vm',
  team: 'alpha',
  requestId: 'fixture-request',
  requestedBy: 'user:default/amirasyraf',
  createdAt: new Date(Date.now() - 360000).toISOString(),
  updatedAt: new Date().toISOString(),
  finishedAt: null,
  error: null,
  status: 'running',
  actions: { retry: false, skip: false },
  stages: [
    {
      ...stage('servicenow', 'success'),
      summary: 'RITM0123456789 created (mock ServiceNow)',
    },
    { ...stage('register', 'success'), summary: 'Inventory registered' },
    stage('provision', 'running', [
      {
        name: 'Terraform apply',
        status: 'in_progress',
      },
    ]),
    stage('baseline', 'pending'),
    stage('software', 'pending'),
    stage('ad-join', 'skipped'),
    stage('access', 'pending'),
    stage('finalize', 'pending'),
  ],
};
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  const screenshotDir = process.env.WORKFLOW_UI_SCREENSHOTS;
  async function capture(name) {
    if (!screenshotDir) return;
    await mkdir(screenshotDir, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({
        width,
        height: width === 1440 ? 1100 : name.includes('wording') ? 2600 : 1400,
      });
      await page.evaluate(() => document.fonts.ready);
      await assertLineFits();
      await page.screenshot({
        path: path.join(screenshotDir, `${name}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  async function assertLineFits() {
    const fits = await page.getByLabel('Pipeline stages').evaluateAll(lines =>
      lines.every(line => {
        const box = line.getBoundingClientRect();
        const parent = line.parentElement.getBoundingClientRect();
        const withinViewport =
          window.location.pathname === '/catalog' ||
          (box.left >= -1 && box.right <= window.innerWidth + 1);
        return (
          withinViewport &&
          box.width <= parent.width + 1 &&
          [...line.children].every(station => {
            const r = station.getBoundingClientRect();
            return r.left >= box.left - 1 && r.right <= box.right + 1;
          })
        );
      }),
    );
    if (!fits) throw new Error('Pipeline stations overflow their container');
  }
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json = {};
    if (path.endsWith('/password/refresh')) {
      json = {
        profile: { displayName: 'UI fixture' },
        backstageIdentity: {
          token: 'fixture-not-a-real-token',
          expiresInSeconds: 3600,
          identity: {
            type: 'user',
            userEntityRef: 'user:default/amirasyraf',
            ownershipEntityRefs: [
              'user:default/amirasyraf',
              'group:default/alpha',
              ...(admin ? ['group:default/platform-admins'] : []),
            ],
          },
        },
      };
    } else if (path.endsWith('/user-settings/multiget')) {
      json = { items: [] };
    } else if (path.endsWith('/authorize')) {
      json = {
        items: (route.request().postDataJSON()?.items ?? []).map(item => ({
          id: item.id,
          result: 'ALLOW',
        })),
      };
    } else if (path.endsWith('/eventstream')) {
      // The app must long-poll /events; SSE is buffered by corporate TLS proxies.
      streamRequests++;
      await route.fulfill({ status: 500, json: { error: 'SSE not expected' } });
      return;
    } else if (
      path.endsWith('/scaffolder/v2/tasks') &&
      route.request().method() === 'POST'
    ) {
      await route.fulfill({ status: 201, json: { id: task.id } });
      return;
    } else if (path.endsWith('/events')) {
      // Long-poll fixture: return events newer than `after`, else a short idle wait and [].
      const after = Number(
        new URL(route.request().url()).searchParams.get('after') ?? 0,
      );
      const events = [
        {
          id: 1,
          type: 'log',
          body: {
            stepId: 'dispatch',
            status: taskResult === 'failed' ? 'failed' : 'processing',
            message:
              taskResult === 'failed'
                ? 'Quota exceeded'
                : 'Creating pipeline run',
          },
        },
        ...(taskResult === 'processing'
          ? []
          : [
              {
                id: 2,
                type: taskResult === 'cancelled' ? 'cancelled' : 'completion',
                body: {
                  output: taskOutput,
                  ...(taskResult === 'failed'
                    ? {
                        error: {
                          name: 'ConflictError',
                          message: 'Quota exceeded',
                        },
                      }
                    : {}),
                },
              },
            ]),
      ]
        .filter(event => event.id > after)
        .map(event => ({
          ...event,
          taskId: task.id,
          createdAt: '2026-11-15T00:00:01Z',
        }));
      if (!events.length) await delay(500);
      await route.fulfill({ json: events }).catch(() => {});
      return;
    } else if (path.includes(`/tasks/${task.id}`)) {
      json = { ...task, status: taskResult };
    } else if (path.endsWith('/entity-facets')) {
      json = {
        facets: {
          kind: ['Resource', 'Group', 'User', 'Template', 'Location'].map(
            value => ({ value, count: 1 }),
          ),
        },
      };
    } else if (path.endsWith('/entities/by-query')) {
      const query = `${decodeURIComponent(
        new URL(route.request().url()).search,
      )} ${route.request().postData() ?? ''}`;
      const resources = /kind\W+resource/i.test(query);
      json = resources
        ? { items: listVms, totalItems: listVms.length, pageInfo: {} }
        : { items: [], totalItems: 0, pageInfo: {} };
    } else if (path.endsWith('/vm-sizes/sizes')) {
      const specs = memoryMiB => ({
        vcpus: 2,
        memoryMiB,
        architectures: ['x86_64'],
        network: 'Up to 5 Gigabit',
        burstable: true,
      });
      json = {
        sizes: [
          { size: 'XS', instanceType: 't3.micro', specs: specs(1024) },
          { size: 'S', instanceType: 't3.small', specs: specs(2048) },
          { size: 'M', instanceType: 't3.medium', specs: specs(4096) },
          { size: 'L', instanceType: 't3.large', specs: specs(8192) },
        ],
        error: null,
      };
    } else if (path.endsWith('/vm-sizes/instance-types')) {
      const type = (name, category, vcpus, gib, extra = {}) => ({
        type: name,
        family: name.split('.')[0],
        category,
        currentGeneration: true,
        bareMetal: false,
        gpus: null,
        vcpus,
        memoryMiB: gib * 1024,
        architectures: ['x86_64'],
        network: 'Up to 12.5 Gigabit',
        burstable: false,
        ...extra,
      });
      json = {
        region: 'ap-southeast-2',
        types: [
          ...[
            ['micro', 2, 1],
            ['small', 2, 2],
            ['medium', 2, 4],
            ['large', 2, 8],
          ].map(([size, vcpus, gib]) =>
            type(`t3.${size}`, 'General purpose', vcpus, gib, {
              burstable: true,
            }),
          ),
          type('m7i.large', 'General purpose', 2, 8),
          type('m7i.xlarge', 'General purpose', 4, 16),
          type('m4.large', 'General purpose', 2, 8, {
            currentGeneration: false,
          }),
          type('c7i.xlarge', 'Compute optimized', 4, 8),
          type('r7i.large', 'Memory optimized', 2, 16),
          type('g5.xlarge', 'Accelerated computing', 4, 16, {
            gpus: '1× NVIDIA A10G',
          }),
        ],
      };
    } else if (path.endsWith('/vms/summary')) {
      summaryReads++;
      json = {
        vms: noSummary
          ? []
          : summaryMatrix ?? [{ name: 'spec-vm', latest: snapshot }],
      };
    } else if (path.endsWith('/vms/runs')) {
      latestReads++;
      const query = new URL(route.request().url()).searchParams;
      if (query.get('name') !== 'spec-vm' || query.get('limit') !== '1')
        throw new Error('Latest run query mismatch');
      json = { runs: [snapshot] };
    } else if (/\/vms\/runs\/42\/(retry|skip)$/.test(path)) {
      actionPosts++;
      await delay(500);
      if (route.request().method() !== 'POST')
        throw new Error('Expected action POST');
      if (actionError) {
        await route.fulfill({
          status: 409,
          json: { error: 'Fixture conflict: stage changed' },
        });
        return;
      }
      snapshot = {
        ...snapshot,
        status: 'running',
        actions: { retry: false, skip: false },
        stages: snapshot.stages.map(s =>
          s.id === 'software'
            ? {
                ...s,
                status: path.endsWith('/skip') ? 'skipped' : 'running',
                skippedBy: path.endsWith('/skip')
                  ? 'user:default/amirasyraf'
                  : null,
                retriedBy: path.endsWith('/retry')
                  ? 'user:default/amirasyraf'
                  : null,
              }
            : s,
        ),
      };
      json = snapshot;
    } else if (path.endsWith('/vms/runs/42')) {
      runReads++;
      if (runReadError) {
        await route.fulfill({
          status: 404,
          json: { error: 'Run not found or not visible' },
        });
        return;
      }
      json = snapshot;
    } else if (path.endsWith('/vms/demo/settings')) {
      demoSettings++;
      demoOn = route.request().postDataJSON().enabled;
      json = {};
    } else if (path.endsWith('/vms/demo/state')) {
      json = {
        enabled: demoOn,
        generation: 'fixture-generation',
        isAdmin: admin,
        automationAvailable: false,
        ownedCount: 1,
        lastScan: Date.now(),
        error: null,
        vms: [],
        instanceTypes: ['t3.micro', 't3.small', 't3.medium', 't3.large'],
      };
    } else if (path.endsWith('/vm-request/parameter-schema')) {
      json = {
        title: 'Request a VM',
        steps: [
          {
            title: 'Compute',
            schema: {
              type: 'object',
              properties: {
                compute: {
                  title: 'Compute',
                  type: 'object',
                  required: ['platform', 'os'],
                  'ui:field': 'VmComputePicker',
                  properties: {
                    platform: { type: 'string', default: 'aws', enum: ['aws'] },
                    os: { type: 'string', default: 'ubuntu', enum: ['ubuntu'] },
                    size: {
                      title: 'Size',
                      type: 'string',
                      enum: ['XS', 'S', 'M', 'L'],
                    },
                    instanceType: { type: 'string' },
                  },
                },
                tags: {
                  title: 'Tags',
                  type: 'object',
                  required: ['costCenter', 'projectCode'],
                  'ui:field': 'VmTagsEditor',
                  properties: {
                    costCenter: { type: 'string', minLength: 1 },
                    projectCode: { type: 'string', minLength: 1 },
                    extra: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        ],
      };
    } else if (path.endsWith('/entities/by-refs')) {
      json = { items: [template] };
    } else if (path.endsWith('/ancestry')) {
      json = { items: [{ entity: vm, parentEntityRefs: [] }] };
    } else if (path.includes('/entities/by-name/')) {
      if (entityGone && path.includes('/resource/')) {
        await route.fulfill({
          status: 404,
          json: { error: { name: 'NotFoundError', message: 'Entity removed' } },
        });
        return;
      }
      json = path.includes('/resource/') ? vm : template;
    } else if (path.endsWith('/entities')) {
      json = listVms;
    }
    await route.fulfill({ json });
  });
  // Real form navigation, but every API including Create is intercepted above.
  await page.goto(`${base}/create/templates/default/vm-request`);
  await page.getByLabel('cost_center value').fill('CC-fixture');
  await page.getByLabel('project_code value').fill('PROJECT-fixture');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/create/tasks/${task.id}$`));
  await expect(
    page.getByText('Start VM pipeline', { exact: true }),
  ).toBeVisible();
  taskResult = 'completed';
  await expect(page).toHaveURL(`${base}/vms/runs/42`, { timeout: 15000 });
  await expect(
    page.getByText('RITM0123456789 created (mock ServiceNow)', { exact: true }),
  ).toBeVisible();
  await capture('create-redirect');
  await page.goBack();
  await expect(page).toHaveURL(`${base}/create/templates/default/vm-request`);
  for (const name of ['vm-refry', 'vm-destroy']) {
    task.spec.templateInfo.entityRef = `template:default/${name}`;
    taskOutput =
      name === 'vm-refry'
        ? { runId: 42 }
        : { links: [{ title: 'Follow run', url: '/vms/runs/42' }] };
    await page.goto(`${base}/create/tasks/${task.id}`);
    await expect(page).toHaveURL(`${base}/vms/runs/42`, { timeout: 15000 });
  }
  task.spec.templateInfo.entityRef = 'template:default/vm-request';
  taskResult = 'failed';
  await page.goto(`${base}/create/tasks/${task.id}`);
  await expect(
    page.getByText('Quota exceeded', { exact: false }).first(),
  ).toBeVisible();
  await expect(page).toHaveURL(`${base}/create/tasks/${task.id}`);
  await capture('task-failed');
  taskResult = 'completed';
  task.spec.templateInfo.entityRef = 'template:default/ssh-cert';
  await page.goto(`${base}/create/tasks/${task.id}`);
  await expect(page.getByRole('link', { name: 'Follow run' })).toBeVisible();
  await expect(page).toHaveURL(`${base}/create/tasks/${task.id}`);
  task.spec.templateInfo.entityRef = 'template:default/vm-request';
  taskOutput = {
    links: [
      { title: 'External run', url: 'https://example.invalid/vms/runs/42' },
    ],
  };
  await page.goto(`${base}/create/tasks/${task.id}`);
  await expect(page.getByRole('link', { name: 'External run' })).toBeVisible();
  await expect(page).toHaveURL(`${base}/create/tasks/${task.id}`);
  taskResult = 'cancelled';
  await page.goto(`${base}/create/tasks/${task.id}`);
  await expect(
    page.getByText('Start VM pipeline', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(`${base}/create/tasks/${task.id}`);
  console.log(
    'TASK HANDOFF PASS: Create → run with history replacement, refry runId, destroy run link; failed/cancelled/non-VM/external URL remain stock; long polling retained',
  );
  runReadError = true;
  await expect(
    page.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Workflow stages', { exact: true })).toHaveCount(
    0,
  );
  if (streamRequests)
    throw new Error(`Task page opened ${streamRequests} SSE stream(s)`);
  await page.goto(`${base}/vms/runs/42`);
  await expect(page.getByRole('alert')).toContainText(
    'Run not found or not visible',
  );
  runReadError = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  const runView = page.getByRole('region', { name: 'VM run 42', exact: true });
  await expect(runView).toBeVisible();
  const serviceNow = page
    .getByLabel('Run stages')
    .getByRole('listitem')
    .filter({ hasText: 'ServiceNow request' });
  await expect(serviceNow).toContainText(
    'RITM0123456789 created (mock ServiceNow)',
  );
  await expect(serviceNow.locator('details')).toHaveCount(0);
  await expect(serviceNow.getByRole('link')).toHaveCount(0);
  await expect(
    page
      .getByLabel('Run stages')
      .getByText('Inventory registered', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Pipeline stages').locator('li')).toHaveCount(8);
  await expect(runView.getByText('In progress', { exact: true })).toHaveCount(
    2,
  );
  await expect(runView.getByText('Attempt 0/4')).toHaveCount(0);
  await expect(runView.getByText('Job steps (0)')).toHaveCount(0);
  await expect(runView.getByText('Not needed', { exact: true })).toBeVisible();
  await assertLineFits();
  await capture('run-running');
  await runView.getByText('Provision details', { exact: true }).click();
  await expect(
    runView.getByText('Terraform apply', { exact: false }),
  ).toBeVisible();
  await expect(
    runView.getByRole('link', { name: /Open VM in catalog/ }),
  ).toHaveAttribute('href', '/catalog/default/resource/spec-vm');
  await runView.getByText('Provision details', { exact: true }).click();
  snapshot = {
    ...snapshot,
    stages: snapshot.stages.map(s => {
      if (s.id === 'software')
        return {
          ...s,
          status: 'retrying',
          attempt: 3,
          startedAt: new Date(Date.now() - 80000).toISOString(),
          runUrl: 'https://github.com/example/platform/actions/runs/456',
          nextAttemptAt: new Date(Date.now() + 120000).toISOString(),
          error: 'Package mirror unavailable',
          attempts: [
            {
              attempt: 1,
              runUrl: 'https://github.com/example/platform/actions/runs/123',
              conclusion: 'failure',
              error: 'First failure',
              finishedAt: snapshot.updatedAt,
            },
          ],
        };
      if (['provision', 'baseline'].includes(s.id))
        return stage(s.id, 'success');
      return s;
    }),
  };
  await expect(runView.getByText(/^Retrying in \d+m \d+s/)).toBeVisible({
    timeout: 10000,
  });
  await capture('run-retrying');
  await runView.getByText('Software details', { exact: true }).click();
  await expect(
    runView.getByText('Earlier attempts (1)', { exact: true }),
  ).toBeVisible();
  await expect(
    runView.getByText('First failure', { exact: true }),
  ).toBeVisible();
  await capture('run-expanded');
  await runView.getByText('Software details', { exact: true }).click();
  snapshot = {
    ...snapshot,
    status: 'failed',
    error: 'Software failed',
    finishedAt: new Date().toISOString(),
    actions: { retry: true, skip: true },
    stages: snapshot.stages.map(s =>
      s.id === 'software'
        ? { ...s, status: 'failed', finishedAt: new Date().toISOString() }
        : s,
    ),
  };
  await expect(
    runView.getByRole('button', { name: 'Retry', exact: true }),
  ).toBeVisible({ timeout: 15000 });
  const stoppedReads = runReads;
  await capture('run-failed');
  await page.waitForTimeout(5500);
  if (runReads !== stoppedReads) throw new Error('Terminal run kept polling');
  actionError = true;
  await runView.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    runView.getByRole('button', { name: 'Retrying…', exact: true }),
  ).toBeDisabled();
  await expect(runView.getByRole('alert')).toHaveText(
    'Fixture conflict: stage changed',
  );
  actionError = false;
  const beforeDismiss = actionPosts;
  await runView.getByRole('button', { name: 'Skip', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  if (actionPosts !== beforeDismiss)
    throw new Error('Cancelled skip posted an action');
  await runView.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText(/work will not be applied/),
  ).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Skip stage', exact: true })
    .click();
  await expect(
    runView.getByText('Skipped by amirasyraf', { exact: true }),
  ).toBeVisible();
  snapshot = {
    ...snapshot,
    status: 'failed',
    actions: { retry: true, skip: false },
  };
  await expect(
    runView.getByRole('button', { name: 'Retry', exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await runView.getByRole('button', { name: 'Retry', exact: true }).click();
  await runView.getByText('Software details', { exact: true }).click();
  await expect(runView.getByText('Retried by amirasyraf')).toBeVisible();
  await runView.getByText('Software details', { exact: true }).click();
  snapshot = {
    ...snapshot,
    status: 'succeeded',
    error: null,
    finishedAt: new Date().toISOString(),
    stages: snapshot.stages.map(s => ({
      ...s,
      status: s.id === 'ad-join' ? 'skipped' : 'success',
      attempt: s.id === 'ad-join' ? 0 : Math.max(s.attempt, 1),
      startedAt:
        s.id === 'ad-join'
          ? null
          : s.startedAt ?? new Date(Date.now() - 30000).toISOString(),
      finishedAt: s.id === 'ad-join' ? null : new Date().toISOString(),
      error: null,
    })),
  };
  await expect(runView.getByRole('status', { name: 'Run status' })).toHaveText(
    'Completed',
    { timeout: 15000 },
  );
  await expect(
    runView.getByRole('button', { name: 'Retry', exact: true }),
  ).toHaveCount(0);
  await capture('run-succeeded');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(runView).toBeVisible();
  if (
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )
  )
    throw new Error('Run page overflows mobile viewport');
  assertNoErrors(errors);
  console.log(
    'RUN UI PASS: catalog-independent route, live polling, retry countdown, earlier attempts, terminal stop, action errors, skip confirmation/cancel, retry/skip resumption, success, mobile; stock task controls and no SSE (fixture APIs)',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const succeeded = snapshot;
  const cancelledAt = new Date(Date.now() - 60000).toISOString();
  snapshot = {
    ...succeeded,
    status: 'cancelled',
    finishedAt: cancelledAt,
    updatedAt: cancelledAt,
    stages: [
      stage('register', 'success'),
      {
        ...stage('provision', 'cancelled'),
        startedAt: new Date(Date.parse(cancelledAt) - 60000).toISOString(),
        finishedAt: null,
      },
    ],
  };
  await page.reload();
  await expect(
    page.getByLabel('Run stages').getByText('1m 0s', { exact: true }),
  ).toHaveCount(2);
  await capture('run-cancelled');
  snapshot = {
    ...succeeded,
    kind: 'refry',
    stages: [
      stage('configure', 'skipped'),
      stage('baseline', 'success'),
      stage('finalize', 'success'),
    ],
  };
  await page.reload();
  await expect(page.getByLabel('Pipeline stages').locator('li')).toHaveCount(3);
  snapshot = {
    ...succeeded,
    kind: 'destroy',
    stages: [stage('destroy', 'success'), stage('finalize', 'skipped')],
  };
  await page.reload();
  await expect(page.getByLabel('Pipeline stages').locator('li')).toHaveCount(2);
  snapshot = {
    ...succeeded,
    status: 'failed',
    stages: succeeded.stages.map(s =>
      s.id === 'software' ? { ...s, status: 'failed' } : s,
    ),
  };
  await page.goto(`${base}/catalog`);
  const kind = page
    .getByText('Kind', { exact: true })
    .locator('..')
    .getByRole('button');
  await expect(kind).toHaveText('Resource');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Resources', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Pipeline' }),
  ).toBeVisible();
  await expect(page.getByLabel('Pipeline stages')).toBeVisible();
  await assertLineFits();
  await capture('resources');
  if (!summaryReads) throw new Error('Catalog did not load run summary');
  if (latestReads) throw new Error('List performed per-VM latest-run requests');
  await expect(
    page.getByText('Failed at Software', { exact: true }),
  ).toBeVisible();
  snapshot = succeeded;
  await expect(page.getByText('Catalog', { exact: true })).toHaveCount(0);
  await kind.click();
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(
    page.getByRole('option', { name: 'Resource', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto(`${base}/catalog?filters%5Bkind%5D=group`);
  await expect(kind).toHaveText('Resource');
  await expect(page).toHaveURL(/filters%5Bkind%5D=resource/);
  admin = true;
  await page.goto(`${base}/catalog`);
  await expect(kind).toHaveText('Resource');
  await kind.click();
  await expect(
    page.getByRole('option', { name: 'Group', exact: true }),
  ).toBeVisible();
  await page.getByRole('option', { name: 'Group', exact: true }).click();
  await expect(kind).toHaveText('Group');
  await page.goto(`${base}/catalog?filters%5Bkind%5D=user`);
  await expect(kind).toHaveText('User');
  noSummary = true;
  await page.goto(`${base}/catalog`);
  await expect(page.getByText('No run known', { exact: true })).toBeVisible();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  noSummary = false;
  assertNoErrors(errors);
  console.log(
    'CATALOG UI PASS: own header, VM state/pipeline columns, Resource default, normal-user Resource-only picker and deep links, admin kind selection and explicit links (fixture APIs)',
  );
  snapshot = {
    ...succeeded,
    status: 'running',
    finishedAt: null,
    stages: succeeded.stages.map(s =>
      s.id === 'software' ? { ...s, status: 'running', finishedAt: null } : s,
    ),
  };
  const beforeEntity = runReads;
  await page.goto(`${base}/catalog/default/resource/spec-vm`);
  await expect(
    page.getByRole('heading', { name: 'Desired configuration' }),
  ).toBeVisible();
  await expect(page.getByLabel('Pipeline stages')).toBeVisible();
  await expect(page.getByLabel('Run stages')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /View run details/ }),
  ).toBeVisible();
  await capture('entity-running');
  snapshot = {
    ...snapshot,
    status: 'failed',
    actions: { retry: true, skip: true },
    error: 'Software could not be installed',
    stages: snapshot.stages.map(s =>
      s.id === 'software'
        ? { ...s, status: 'failed', error: 'Package mirror unavailable' }
        : s,
    ),
  };
  await expect(
    page.getByRole('button', { name: 'Retry', exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await capture('entity-failed');
  await expect(page.getByText('aws / ubuntu', { exact: true })).toBeVisible();
  await expect(page.getByText('git, nginx', { exact: true })).toBeVisible();
  await expect(
    page.getByText('M · t3.medium · 2 vCPU · 4 GiB · x86_64', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('cost_center: CC-1234, environment: test', { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(5500);
  if (runReads !== beforeEntity)
    throw new Error(
      'Entity card duplicated latest-run polling with per-ID polling',
    );
  entityGone = true;
  snapshot = {
    ...succeeded,
    kind: 'destroy',
    stages: [stage('destroy', 'success'), stage('finalize', 'skipped')],
  };
  await expect(page.getByText('Destroyed', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  const afterRemoval = latestReads;
  await page.waitForTimeout(5500);
  if (latestReads !== afterRemoval)
    throw new Error('Removed VM kept polling runs');
  entityGone = false;
  snapshot = succeeded;
  assertNoErrors(errors);
  console.log(
    'VM SPEC UI PASS: desired configuration renders from spec without desired-input annotations (fixture APIs)',
  );
  await page.goto(`${base}/`);
  const demoPanel = page.getByRole('region', {
    name: 'Demo mode',
    exact: true,
  });
  await expect(demoPanel.getByText('Demo mode · Off')).toBeVisible();
  await demoPanel.getByLabel('Enable demo mode').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page
    .getByRole('button', { name: 'Enable and apply limits', exact: true })
    .click();
  await expect(demoPanel.getByText('Demo mode · On')).toBeVisible();
  if (!demoSettings)
    throw new Error('Demo toggle did not use /vms/demo/settings');
  demoOn = false;
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
  const row = page.getByRole('row', { name: /spec-vm/ });
  await expect(row.getByLabel('Pipeline stages')).toBeVisible();
  await assertLineFits();
  await capture('home');
  await expect(
    row.locator('[title="M · t3.medium · 2 vCPU · 4 GiB · x86_64"]'),
  ).toHaveCount(1);
  await expect(
    row.getByRole('link', { name: 'Get SSH certificate' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: /Failed/ }).click();
  await expect(page.getByText('No machines match this filter.')).toBeVisible();
  assertNoErrors(errors);
  console.log(
    'HOME UI PASS: top bar, team VM table with pipeline line, next action and empty filter state (fixture APIs)',
  );
  await page.goto(`${base}/create/templates/default/vm-request`);
  const card = name => page.getByRole('radio', { name });
  for (const name of ['XS t3.micro', 'S t3.small', 'M t3.medium', 'L t3.large'])
    await expect(card(name)).toBeVisible();
  await expect(card('S t3.small')).toHaveAttribute('aria-checked', 'true');
  await card('L t3.large').click();
  await expect(card('L t3.large')).toHaveAttribute('aria-checked', 'true');
  await expect(card('S t3.small')).toHaveAttribute('aria-checked', 'false');
  // Advanced picker stays hidden until asked for.
  const types = page.getByRole('table', { name: 'EC2 instance types' });
  await expect(types).toHaveCount(0);
  await page
    .getByRole('button', { name: /Advanced: choose a specific EC2/ })
    .click();
  await expect(types).toBeVisible();
  // Previous generation hidden by default; family grouping and category tabs.
  await expect(types.getByText('m4.large')).toHaveCount(0);
  await expect(
    types.getByText(/^m7i · General purpose · 2 types$/),
  ).toBeVisible();
  await page.getByRole('tab', { name: /Accelerated computing/ }).click();
  await expect(types.getByText('g5.xlarge')).toBeVisible();
  await expect(types.getByText('m7i.large')).toHaveCount(0);
  await page.getByRole('tab', { name: /^All/ }).click();
  await page.getByLabel('Search instance types').fill('c7i');
  await expect(types.getByRole('radio')).toHaveCount(1);
  await page.getByLabel('Search instance types').fill('');
  await types.getByRole('radio', { name: 'm7i.large' }).check();
  await expect(page.getByText('Using instance type m7i.large')).toBeVisible();
  await expect(card('L t3.large')).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'Use a size instead' }).click();
  await expect(card('S t3.small')).toHaveAttribute('aria-checked', 'true');
  // Tags: fixed, greyed-out cost_center/project_code keys with required values; optional rows.
  await expect(page.getByLabel('cost_center key')).toBeDisabled();
  await expect(page.getByLabel('project_code key')).toBeDisabled();
  await page.getByLabel('cost_center value').fill('CC-1');
  await page.getByLabel('project_code value').fill('');
  await page.getByLabel('project_code value').blur();
  await expect(page.getByText('Required', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add tag' }).click();
  await page.getByLabel('Tag 1 key').fill('Cost_Center');
  await expect(page.getByText('Reserved key')).toBeVisible();
  await page.getByLabel('Tag 1 key').fill('environment');
  await expect(page.getByText('Reserved key')).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove tag 1' }).click();
  await expect(page.getByLabel('Tag 1 key')).toHaveCount(0);
  // Demo mode: only t3.micro..t3.large selectable.
  demoOn = true;
  await page.reload();
  await page
    .getByRole('button', { name: /Advanced: choose a specific EC2/ })
    .click();
  await expect(types.getByRole('radio', { name: 'm7i.large' })).toBeDisabled();
  await expect(types.getByRole('radio', { name: 't3.micro' })).toBeEnabled();
  await expect(page.getByText(/Demo mode is on: only t3\.micro/)).toBeVisible();
  demoOn = false;
  assertNoErrors(errors);
  console.log(
    'VM SIZE + TAGS UI PASS: tags table with fixed required cost_center/project_code and optional rows; size cards XS-L with specs, hidden Advanced picker (categories, family groups, search, generation filter, selection, back to size), demo-mode restriction; VM card and home row show the launched type (fixture APIs)',
  );
  const wording = [
    [
      'building-vm',
      'provision',
      'running',
      'provision',
      'running',
      'Building · Provision',
    ],
    [
      'updating-vm',
      'refry',
      'running',
      'software',
      'running',
      'Updating · Software',
    ],
    ['destroying-vm', 'destroy', 'running', 'destroy', 'running', 'Destroying'],
    [
      'destroy-retry-vm',
      'destroy',
      'running',
      'destroy',
      'retrying',
      'Destroying · retrying',
    ],
    // finalize is still recording the failure, so the run itself is still running.
    [
      'finalizing-vm',
      'provision',
      'running',
      'software',
      'failed',
      'Failed at Software',
    ],
    [
      'retrying-vm',
      'refry',
      'running',
      'software',
      'retrying',
      'Updating · Software · retrying',
    ],
    [
      'failed-vm',
      'provision',
      'failed',
      'software',
      'failed',
      'Failed at Software',
    ],
    [
      'attention-vm',
      'refry',
      'failed',
      'software',
      'pending',
      'Needs attention',
    ],
  ];
  listVms = wording.map(([name]) => ({
    ...vm,
    metadata: {
      ...vm.metadata,
      name,
      uid: name,
      annotations: Object.fromEntries(
        Object.entries(vm.metadata.annotations).filter(
          ([key]) => key !== 'cf/ready-at' || name === 'updating-vm',
        ),
      ),
    },
  }));
  summaryMatrix = wording.map(
    ([name, kind, status, active, stageStatus], index) => {
      const ids =
        kind === 'provision'
          ? [
              'servicenow',
              'register',
              'provision',
              'baseline',
              'software',
              'ad-join',
              'access',
              'finalize',
            ]
          : kind === 'refry'
          ? ['configure', 'software', 'finalize']
          : ['destroy', 'finalize'];
      return {
        name,
        latest: {
          ...succeeded,
          id: 100 + index,
          name,
          kind,
          status,
          finishedAt: status === 'failed' ? new Date().toISOString() : null,
          stages: ids.map((id, i) => ({
            ...stage(id, i < ids.indexOf(active) ? 'success' : 'pending'),
            ...(id === active
              ? {
                  status: stageStatus,
                  attempt: stageStatus === 'retrying' ? 2 : 1,
                  nextAttemptAt:
                    stageStatus === 'retrying'
                      ? new Date(Date.now() + 120000).toISOString()
                      : null,
                }
              : {}),
          })),
        },
      };
    },
  );
  for (const [route, screenshot] of [
    ['/', 'home-wording'],
    ['/catalog', 'resources-wording'],
  ]) {
    await page.goto(`${base}${route}`);
    // Scope to each VM's row: Home's filter tabs reuse some labels (e.g. Destroying).
    for (const [name, , , , , label] of wording)
      await expect(
        page
          .getByRole('row')
          .filter({ hasText: name })
          .getByText(label, { exact: true }),
      ).toBeVisible();
    await expect(page.getByText(/^Ready since /).first()).toBeVisible();
    await expect(page.getByText(/^Requested /).first()).toBeVisible();
    await capture(screenshot);
  }
  listVms = [vm];
  summaryMatrix = undefined;
  console.log(
    'ROW WORDING PASS: provision, refry, destroy, retrying, failed and needs-attention labels; absolute ready/request times on Home and Resources',
  );
  await page.goto(`${base}/`);
  const banner = page.getByText(
    'A new version of Compute Factory is available.',
  );
  const running = await page.evaluate(
    () =>
      /\/static\/main\.([0-9a-f]{8,})\.js/.exec(
        document.querySelector('script[src*="/static/main."]')?.src ?? '',
      )?.[1],
  );
  if (!running) {
    console.log('VERSION BANNER SKIPPED: unhashed dev-server bundle');
  } else {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(1000);
    await expect(banner).toHaveCount(0);
    // Simulate a deploy: index.html now references a different bundle.
    await page.route(new URL('/', base).href, route =>
      route.fulfill({
        contentType: 'text/html',
        body: '<script defer src="/static/main.0123456789ab.js"></script>',
      }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(banner).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
    assertNoErrors(errors);
    console.log(
      'VERSION BANNER PASS: hidden while current, shown after the deployed bundle changes',
    );
  }
} finally {
  await browser.close();
}

function assertNoErrors(errors) {
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
}
