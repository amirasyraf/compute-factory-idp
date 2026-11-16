// Signed-in, read-only check of the deployed IDP with real backend data. Never submits a form,
// dispatches a workflow or changes state. Credentials come from the orchestrator's gitignored
// .poc-passwords (POC only), e.g.:
//   CF_USER=user1 CF_PASSWORD="$(grep '^user1:' ../compute-factory/.poc-passwords | cut -d: -f2-)" \
//     mise exec -- node scripts/live-check.mjs
import { chromium, expect } from '@playwright/test';

const base = process.env.LIVE_URL ?? 'https://idp.amirasyraf.dev';
const user = process.env.CF_USER;
const password = process.env.CF_PASSWORD;
if (!user || !password) throw new Error('Set CF_USER and CF_PASSWORD');

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto(base);
  await page.locator('input[name=username]').fill(user);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
  console.log(`SIGN-IN PASS: ${user}`);

  // Real vm-sizes endpoint: sizes.json from GitHub plus live EC2 specs.
  const sizesResponse = page.waitForResponse(response =>
    response.url().endsWith('/api/vm-sizes/sizes'),
  );
  await page.goto(`${base}/create/templates/default/vm-request`);
  const sizes = await (await sizesResponse).json();
  if (sizes.error) throw new Error(`vm-sizes error: ${sizes.error}`);
  for (const item of sizes.sizes) {
    if (!item.specs?.vcpus || !item.specs?.memoryMiB)
      throw new Error(`No AWS specs for ${item.size} (${item.instanceType})`);
  }
  for (const item of sizes.sizes) {
    await expect(
      page.getByRole('radio', { name: `${item.size} ${item.instanceType}` }),
    ).toBeVisible();
  }
  console.log(
    `VM SIZE LIVE PASS: ${sizes.sizes
      .map(
        item =>
          `${item.size}=${item.instanceType} (${item.specs.vcpus} vCPU, ${
            item.specs.memoryMiB / 1024
          } GiB)`,
      )
      .join(', ')}`,
  );

  // Advanced picker: the real region catalog from AWS (x86_64 types offered here).
  const catalogResponse = page.waitForResponse(response =>
    response.url().endsWith('/api/vm-sizes/instance-types'),
  );
  await page
    .getByRole('button', { name: /Advanced: choose a specific EC2/ })
    .click();
  const catalog = await (await catalogResponse).json();
  if (!Array.isArray(catalog.types) || catalog.types.length < 50)
    throw new Error(
      `Instance-type catalog too small: ${JSON.stringify(catalog).slice(
        0,
        300,
      )}`,
    );
  const types = page.getByRole('table', { name: 'EC2 instance types' });
  await expect(types.getByRole('radio', { name: 't3.micro' })).toBeVisible();
  const demoOn = (await page.getByText(/Demo mode is on: only/).count()) > 0;
  const blocked = catalog.types.find(
    item => item.currentGeneration && !item.type.startsWith('t3.'),
  );
  if (demoOn && blocked)
    await expect(
      types.getByRole('radio', { name: blocked.type }),
    ).toBeDisabled();
  console.log(
    `ADVANCED PICKER LIVE PASS: ${catalog.types.length} types in ${
      catalog.region
    }, ${
      new Set(catalog.types.map(item => item.family)).size
    } families; demo mode ${
      demoOn ? `on, ${blocked?.type} greyed out` : 'off'
    }`,
  );

  // Task page delivery: the newest own task must load events by long polling, not SSE.
  const polls = [];
  page.on('request', request => {
    if (/\/v2\/tasks\/[^/]+\/(events|eventstream)/.test(request.url()))
      polls.push(new URL(request.url()).pathname.split('/').pop());
  });
  await page.goto(`${base}/create/tasks`);
  const taskLink = page.locator('a[href*="/create/tasks/"]').first();
  await taskLink.waitFor({ timeout: 15000 }).catch(() => {});
  if (await taskLink.count()) {
    await taskLink.click();
    await expect(page.getByText('Workflow stages')).toBeVisible();
    await expect
      .poll(() => polls.length, { timeout: 15000 })
      .toBeGreaterThan(0);
    if (polls.includes('eventstream')) throw new Error('Task page used SSE');
    console.log('TASK PAGE LIVE PASS: events delivered by long polling');
  } else {
    console.log('TASK PAGE LIVE SKIPPED: no tasks for this user');
  }

  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
} finally {
  await browser.close();
}
