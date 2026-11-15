export const progressMarker = 'CF_WORKFLOW_PROGRESS_V1 ';

export type WorkflowStage = {
  name: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  steps: Omit<WorkflowStage, 'steps'>[];
};

export type WorkflowProgress = {
  version: 1;
  operation: 'provision' | 'refry' | 'destroy';
  status: string;
  conclusion: string | null;
  jobs: WorkflowStage[];
};

function isStage(value: unknown): value is Omit<WorkflowStage, 'steps'> {
  if (!value || typeof value !== 'object') return false;
  const stage = value as Record<string, unknown>;
  return (
    typeof stage.name === 'string' &&
    typeof stage.status === 'string' &&
    (stage.startedAt === null || typeof stage.startedAt === 'string') &&
    (stage.completedAt === null || typeof stage.completedAt === 'string')
  );
}

// The upstream hook prefixes each persisted message with its event timestamp.
// Scan backwards and ignore malformed/unsupported entries, retaining the last good state.
export function readWorkflowProgress(
  lines: string[],
): WorkflowProgress | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const start = lines[index].indexOf(progressMarker);
    if (start < 0) continue;
    try {
      const value = JSON.parse(
        lines[index].slice(start + progressMarker.length),
      );
      if (
        value?.version === 1 &&
        ['provision', 'refry', 'destroy'].includes(value.operation) &&
        typeof value.status === 'string' &&
        (value.conclusion === null || typeof value.conclusion === 'string') &&
        Array.isArray(value.jobs) &&
        value.jobs.every(
          (job: unknown) =>
            isStage(job) &&
            'steps' in job &&
            Array.isArray(job.steps) &&
            job.steps.every(isStage),
        )
      )
        return value as WorkflowProgress;
    } catch {
      // Older tasks and human-readable log lines are intentionally supported.
    }
  }
  return undefined;
}

export function stageDuration(
  stage: Omit<WorkflowStage, 'steps'>,
  now: number,
): string {
  if (!stage.startedAt) return '';
  const start = Date.parse(stage.startedAt);
  const end = stage.completedAt ? Date.parse(stage.completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return '';
  const seconds = Math.floor((end - start) / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
