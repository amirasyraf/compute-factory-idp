// Exercise the actual served frontend with fixture APIs only. No login credentials,
// workflow dispatches, VM creation or backend writes. Run against local or deployed UI.
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

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
    annotations: { 'cf/status': 'ready', 'cf/instance-type': 't3.medium' },
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
        id: 'servicenow',
        name: 'Create ServiceNow request (mock)',
        action: 'cf:servicenow:create',
      },
      {
        id: 'dispatch',
        name: 'Start VM pipeline',
        action: 'github:actions:dispatch',
      },
      {
        id: 'monitor',
        name: 'Monitor VM workflow',
        action: 'cf:watch-workflow',
      },
    ],
  },
};
const stage = (name, status, steps = []) => ({
  name,
  status,
  startedAt: null,
  completedAt: null,
  steps,
});
let revision = 1;
let demoOn = false;
let streamRequests = 0;
let snapshot = {
  version: 1,
  operation: 'provision',
  status: 'in_progress',
  conclusion: null,
  jobs: [
    stage('validate', 'success'),
    stage('register', 'success'),
    stage('provision', 'in_progress', [
      {
        name: 'Terraform apply',
        status: 'in_progress',
        startedAt: null,
        completedAt: null,
      },
    ]),
    stage('fry-baseline / fry', 'waiting'),
    stage('fry-software / fry', 'waiting'),
    stage('fry-ad-join / fry', 'waiting'),
    stage('fry-access / fry', 'waiting'),
    stage('finalize', 'waiting'),
    stage('on-failure', 'waiting'),
  ],
};
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
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
            stepId: 'servicenow',
            status: 'completed',
            message:
              'HTTP 201 Created — mock ServiceNow request RITM0000001234 accepted',
          },
        },
        {
          id: 1 + revision,
          type: 'log',
          body: {
            stepId: 'monitor',
            status: 'processing',
            message: `CF_WORKFLOW_PROGRESS_V1 ${JSON.stringify(snapshot)}`,
          },
        },
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
      json = task;
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
        ? { items: [vm], totalItems: 1, pageInfo: {} }
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
    } else if (demoOn && path.endsWith('/demo-mode/state')) {
      json = {
        enabled: true,
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
      json = path.includes('/resource/') ? vm : template;
    } else if (path.endsWith('/entities')) {
      json = [vm];
    }
    await route.fulfill({ json });
  });
  await page.goto(`${base}/create/tasks/${task.id}`);
  const graph = page.getByRole('region', { name: 'GitHub Actions stages' });
  await expect(graph).toBeVisible();
  await expect(
    page.getByText('Create ServiceNow request (mock)', { exact: true }),
  ).toBeVisible();
  await expect(graph.getByText('Provision', { exact: true })).toBeVisible();
  await expect(graph.getByText('Baseline', { exact: true })).toBeVisible();
  await graph.locator('details').nth(2).locator('summary').click();
  await expect(graph.getByText('Terraform apply')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(graph).toBeVisible();
  snapshot = {
    ...snapshot,
    status: 'completed',
    conclusion: 'failure',
    jobs: snapshot.jobs.map(job => ({
      ...job,
      status:
        job.name === 'provision'
          ? 'failure'
          : job.name === 'fry-software / fry'
          ? 'skipped'
          : job.status,
    })),
  };
  revision++;
  // No reload: the long-poll loop must pick up the new snapshot on its own.
  await expect(graph.getByText('failure', { exact: true })).toBeVisible();
  await expect(graph.getByText('skipped', { exact: true })).toBeVisible();
  if (streamRequests)
    throw new Error(`Task page opened ${streamRequests} SSE stream(s)`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(graph).toBeVisible();
  const overflows = await graph.evaluate(el => el.scrollWidth > el.clientWidth);
  if (!overflows)
    throw new Error('Stage graph should scroll on narrow screens');
  assertNoErrors(errors);
  console.log(
    'WORKFLOW UI PASS: pre-GHA mock REST step, stages, live long-poll update (no SSE), expandable steps, controls, replay, failure/skipped states, narrow layout (fixture APIs)',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
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
  assertNoErrors(errors);
  console.log(
    'CATALOG UI PASS: own header, VM state/pipeline columns, Resource default, normal-user Resource-only picker and deep links, admin kind selection and explicit links (fixture APIs)',
  );
  await page.goto(`${base}/catalog/default/resource/spec-vm`);
  await expect(
    page.getByRole('heading', { name: 'Desired configuration' }),
  ).toBeVisible();
  await expect(page.getByLabel('Pipeline stages')).toBeVisible();
  await expect(page.getByText('aws / ubuntu', { exact: true })).toBeVisible();
  await expect(page.getByText('git, nginx', { exact: true })).toBeVisible();
  await expect(
    page.getByText('M · t3.medium · 2 vCPU · 4 GiB · x86_64', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('cost_center: CC-1234, environment: test', { exact: true }),
  ).toBeVisible();
  assertNoErrors(errors);
  console.log(
    'VM SPEC UI PASS: desired configuration renders from spec without desired-input annotations (fixture APIs)',
  );
  await page.goto(`${base}/`);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
  const row = page.getByRole('row', { name: /spec-vm/ });
  await expect(row.getByLabel('Pipeline stages')).toBeVisible();
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
