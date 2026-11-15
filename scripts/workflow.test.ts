import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  workflowProgress,
  createWorkflowWatchAction,
} from '../plugins/cf-backend/src/watch.ts';
import {
  progressMarker,
  readWorkflowProgress,
  stageDuration,
} from '../packages/app/src/workflowProgress.ts';

const run = {
  status: 'in_progress',
  conclusion: null,
  html_url: 'https://github.com/example/run',
};
const job = {
  name: 'provision',
  status: 'in_progress',
  conclusion: null,
  started_at: '2026-11-15T00:00:00Z',
  completed_at: null,
  steps: [
    {
      name: 'Terraform apply',
      status: 'in_progress',
      conclusion: null,
      started_at: '2026-11-15T00:00:01Z',
    },
  ],
};

test('projects every expected job in pipeline order, with step status and timing', () => {
  const snapshot = workflowProgress('provision', run, [job]);
  assert.equal(snapshot.jobs.length, 9);
  assert.equal(snapshot.jobs[0].name, 'validate');
  assert.equal(snapshot.jobs[0].status, 'waiting');
  assert.equal(snapshot.jobs[2].status, 'in_progress');
  assert.equal(snapshot.jobs[2].startedAt, job.started_at);
  assert.equal(snapshot.jobs[2].steps[0].name, 'Terraform apply');
  assert.equal(snapshot.jobs[2].steps[0].status, 'in_progress');
});

test('preserves skipped, failed, cancelled and additional jobs without inventing success', () => {
  const snapshot = workflowProgress(
    'destroy',
    { ...run, status: 'completed', conclusion: 'failure' },
    [
      { ...job, name: 'destroy', status: 'completed', conclusion: 'failure' },
      { ...job, name: 'cleanup', status: 'completed', conclusion: 'skipped' },
      { ...job, name: 'other', status: 'completed', conclusion: 'cancelled' },
    ],
  );
  assert.deepEqual(
    snapshot.jobs.map(item => item.status),
    ['unknown', 'failure', 'skipped', 'cancelled'],
  );
  assert.deepEqual(
    workflowProgress('refry', run, []).jobs.map(item => item.name),
    ['guard', 'fry / fry', 'finalize'],
  );
});

test('reads latest valid persisted snapshot and ignores old, malformed and unsupported logs', () => {
  const snapshot = workflowProgress('provision', run, [job]);
  const line = `2026-11-15T00:00:01Z ${progressMarker}${JSON.stringify(
    snapshot,
  )}`;
  assert.deepEqual(
    readWorkflowProgress([
      'human readable log',
      line,
      `${progressMarker}{broken`,
    ]),
    snapshot,
  );
  assert.deepEqual(
    readWorkflowProgress([line, `${progressMarker}{"version":2}`]),
    snapshot,
  );
  assert.equal(readWorkflowProgress(['old task log']), undefined);
  assert.equal(
    readWorkflowProgress([
      `${progressMarker}${JSON.stringify({ ...snapshot, jobs: [null] })}`,
    ]),
    undefined,
  );
  const final = { ...snapshot, status: 'completed', conclusion: 'success' };
  assert.deepEqual(
    readWorkflowProgress([line, `${progressMarker}${JSON.stringify(final)}`]),
    final,
  );
});

test('duration handles running, finished, skipped and malformed times', () => {
  const stage = workflowProgress('provision', run, [job]).jobs[2];
  const now = Date.parse('2026-11-15T00:01:02Z');
  assert.equal(stageDuration(stage, now), '1m 2s');
  assert.equal(
    stageDuration({ ...stage, completedAt: '2026-11-15T00:00:08Z' }, now),
    '8s',
  );
  assert.equal(stageDuration({ ...stage, startedAt: null }, now), '');
  assert.equal(stageDuration({ ...stage, startedAt: 'bad' }, now), '');
});

test('watcher emits frontend-readable snapshots through the existing task logger', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const messages: string[] = [];
  const outputs: unknown[][] = [];
  process.env.GITHUB_TOKEN = 'test-only';
  globalThis.fetch = async input =>
    new Response(
      JSON.stringify(
        String(input).includes('/jobs?')
          ? { jobs: [{ ...job, status: 'completed', conclusion: 'success' }] }
          : {
              ...run,
              status: 'completed',
              conclusion: 'success',
              path: '.github/workflows/provision.yml',
            },
      ),
    );
  try {
    await createWorkflowWatchAction().handler({
      input: { operation: 'provision', workflowRunId: 123 },
      logger: { info: (message: string) => messages.push(message) },
      output: (...args: unknown[]) => outputs.push(args),
    } as never);
    assert.equal(readWorkflowProgress(messages)?.jobs[2].status, 'success');
    assert.deepEqual(outputs, [['status', 'success']]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  }
});
