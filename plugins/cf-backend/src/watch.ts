import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

type Operation = 'provision' | 'refry' | 'destroy';
type WorkflowStep = {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
};
type WorkflowJob = {
  name: string;
  status: string;
  conclusion: string | null;
  steps?: WorkflowStep[];
  started_at?: string | null;
  completed_at?: string | null;
};
type WorkflowRun = {
  status: string;
  conclusion: string | null;
  html_url: string;
  path?: string;
};

const repository = 'amirasyraf/compute-factory-platform';
const apiBase = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const expectedJobs: Record<Operation, string[]> = {
  provision: [
    'validate',
    'register',
    'provision',
    'fry-baseline / fry',
    'fry-software / fry',
    'fry-ad-join / fry',
    'fry-access / fry',
    'finalize',
    'on-failure',
  ],
  refry: ['guard', 'fry / fry', 'finalize'],
  destroy: ['guard', 'destroy'],
};
const workflowPaths: Record<Operation, string> = {
  provision: '.github/workflows/provision.yml',
  refry: '.github/workflows/fry.yml',
  destroy: '.github/workflows/destroy.yml',
};

// Versioned, task-owned projection. Never include credentials or arbitrary API URLs.
export function workflowProgress(
  operation: Operation,
  run: WorkflowRun,
  jobs: WorkflowJob[],
) {
  const names = [
    ...expectedJobs[operation],
    ...jobs
      .map(job => job.name)
      .filter(name => !expectedJobs[operation].includes(name)),
  ];
  return {
    version: 1,
    operation,
    status: run.status,
    conclusion: run.conclusion,
    jobs: names.map(name => {
      const job = jobs.find(item => item.name === name);
      const missingStatus = run.status === 'completed' ? 'unknown' : 'waiting';
      return {
        name,
        status: job ? jobState(job) : missingStatus,
        startedAt: job?.started_at ?? null,
        completedAt: job?.completed_at ?? null,
        steps: (job?.steps ?? []).map(step => ({
          name: step.name,
          status: stepState(step),
          startedAt: step.started_at ?? null,
          completedAt: step.completed_at ?? null,
        })),
      };
    }),
  };
}

function runUrl(runId: number): string {
  return `${apiBase}/repos/${repository}/actions/runs/${runId}`;
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    // GitHub's message and request ID make rate limits and token problems obvious.
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    const error = new Error(
      `GitHub API returned ${response.status} for workflow status: ${
        body.message ?? 'no message'
      } (request ${response.headers.get('x-github-request-id') ?? 'unknown'})`,
    ) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

function jobState(job: WorkflowJob): string {
  return job.status === 'completed'
    ? job.conclusion ?? 'completed'
    : job.status;
}

function stepState(step: WorkflowStep): string {
  return step.status === 'completed'
    ? step.conclusion ?? 'completed'
    : step.status;
}

function findJob(
  jobs: WorkflowJob[],
  expected: string,
): WorkflowJob | undefined {
  return jobs.find(job => job.name === expected);
}

function icon(state: string): string {
  if (state === 'success') return '✓';
  if (state === 'failure' || state === 'timed_out' || state === 'cancelled') {
    return '✗';
  }
  if (state === 'in_progress') return '●';
  if (state === 'skipped') return '–';
  return '○';
}

function formatWorkflow(
  operation: Operation,
  run: WorkflowRun,
  jobs: WorkflowJob[],
): string {
  const expected = expectedJobs[operation];
  const completed = jobs.filter(job => job.status === 'completed').length;
  const total = Math.max(expected.length, jobs.length);
  const lines = [
    `${operation} workflow: ${run.status}${
      run.conclusion ? ` (${run.conclusion})` : ''
    }`,
    `Progress: ${completed}/${total} jobs complete`,
  ];

  for (const name of expected) {
    const job = findJob(jobs, name);
    if (!job) {
      lines.push(`  ○ ${name}: waiting`);
      continue;
    }
    lines.push(`  ${icon(jobState(job))} ${job.name}: ${jobState(job)}`);
    for (const step of job.steps ?? []) {
      lines.push(
        `      ${icon(stepState(step))} ${step.name}: ${stepState(step)}`,
      );
    }
  }

  const known = new Set(expected);
  for (const job of jobs.filter(item => !known.has(item.name))) {
    lines.push(`  ${icon(jobState(job))} ${job.name}: ${jobState(job)}`);
  }

  const current = jobs.find(job => job.status === 'in_progress');
  if (current) {
    const step = current.steps?.find(item => item.status === 'in_progress');
    lines.push(`Current: ${current.name}${step ? ` / ${step.name}` : ''}`);
  }
  return lines.join('\n');
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Workflow watch was cancelled'));
      },
      { once: true },
    );
  });
}

export function createWorkflowWatchAction(
  options: { intervalMs?: number; maxWaitMs?: number } = {},
) {
  const intervalMs = options.intervalMs ?? 10000;
  const maxWaitMs = options.maxWaitMs ?? 30 * 60 * 1000;

  return createTemplateAction({
    id: 'cf:watch-workflow',
    description:
      'Stream GitHub Actions jobs and steps until a Compute Factory operation finishes',
    schema: {
      input: {
        operation: z => z.enum(['provision', 'refry', 'destroy']),
        workflowRunId: z => z.number(),
      },
      output: {
        status: z => z.string(),
      },
    },
    async handler(ctx) {
      const token = process.env.GITHUB_TOKEN;
      if (!token)
        throw new Error('GITHUB_TOKEN is required to watch workflows');

      const operation = ctx.input.operation as Operation;
      const runId = ctx.input.workflowRunId;
      const started = Date.now();
      let lastSignature = '';
      let checkedRunPath = false;

      while (Date.now() - started <= maxWaitMs) {
        if (ctx.signal?.aborted)
          throw new Error('Workflow watch was cancelled');

        // A just-dispatched run (and its jobs) can briefly 404 on GitHub's API.
        let run: WorkflowRun;
        let jobs: WorkflowJob[];
        try {
          run = await getJson<WorkflowRun>(runUrl(runId), token);
          jobs =
            (
              await getJson<{ jobs: WorkflowJob[] }>(
                `${runUrl(runId)}/jobs?per_page=100`,
                token,
              )
            ).jobs ?? [];
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
          ctx.logger.info(
            `Waiting for GitHub workflow run ${runId} to become available...`,
          );
          await delay(intervalMs, ctx.signal);
          continue;
        }

        if (
          !checkedRunPath &&
          run.path &&
          run.path !== workflowPaths[operation]
        ) {
          throw new Error(
            'Workflow run does not match the requested Compute Factory operation',
          );
        }
        checkedRunPath = true;

        const progress = workflowProgress(operation, run, jobs);
        const signature = JSON.stringify(progress);

        if (signature !== lastSignature) {
          lastSignature = signature;
          ctx.logger.info(`CF_WORKFLOW_PROGRESS_V1 ${signature}`);
          ctx.logger.info(formatWorkflow(operation, run, jobs));
        }

        if (run.status === 'completed') {
          const status =
            run.conclusion === 'success'
              ? 'success'
              : run.conclusion ?? 'failed';
          ctx.output('status', status);
          if (status === 'success') {
            ctx.logger.info(`${operation} workflow completed successfully.`);
            return;
          }
          throw new Error(`${operation} workflow finished with ${status}.`);
        }

        await delay(intervalMs, ctx.signal);
      }

      throw new Error(
        `${operation} workflow did not finish within ${Math.round(
          maxWaitMs / 60000,
        )} minutes.`,
      );
    },
  });
}
