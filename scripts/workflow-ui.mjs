// Exercise the actual served frontend with fixture APIs only. No login credentials,
// workflow dispatches, VM creation or backend writes. Run against local or deployed UI.
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
    annotations: { 'cf/status': 'ready' },
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
    } else if (path.endsWith('/eventstream') || path.endsWith('/events')) {
      const events = [
        {
          id: 1,
          type: 'log',
          body: {
            stepId: 'monitor',
            status: 'processing',
            message: `CF_WORKFLOW_PROGRESS_V1 ${JSON.stringify(snapshot)}`,
          },
        },
      ].map(event => ({
        ...event,
        taskId: task.id,
        createdAt: '2026-11-15T00:00:01Z',
      }));
      await route.fulfill({
        contentType: 'text/event-stream',
        body: events
          .map(
            event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(''),
      });
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
  await page.reload();
  await expect(graph.getByText('failure', { exact: true })).toBeVisible();
  await expect(graph.getByText('skipped', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(graph).toBeVisible();
  const overflows = await graph.evaluate(el => el.scrollWidth > el.clientWidth);
  if (!overflows)
    throw new Error('Stage graph should scroll on narrow screens');
  assertNoErrors(errors);
  console.log(
    'WORKFLOW UI PASS: stages, expandable steps, controls, replay, failure/skipped states, narrow layout (fixture APIs)',
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
    page.getByText('costCenter: CC-1234', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('environment: test', { exact: true }),
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
    row.getByRole('link', { name: 'Get SSH certificate' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: /Failed/ }).click();
  await expect(page.getByText('No machines match this filter.')).toBeVisible();
  assertNoErrors(errors);
  console.log(
    'HOME UI PASS: top bar, team VM table with pipeline line, next action and empty filter state (fixture APIs)',
  );
} finally {
  await browser.close();
}

function assertNoErrors(errors) {
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
}
