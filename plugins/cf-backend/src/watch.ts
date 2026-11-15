import { Entity } from '@backstage/catalog-model';
import { AuthService } from '@backstage/backend-plugin-api';
import { CatalogService } from '@backstage/plugin-catalog-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

export const PIPELINE_PROCESSES = [
  'validate',
  'register',
  'provision',
  'fry-baseline',
  'fry-software',
  'fry-ad-join',
  'fry-access',
  'finalize',
  'on-failure',
] as const;

type ProcessStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

const processLabels: Record<(typeof PIPELINE_PROCESSES)[number], string> = {
  validate: 'Validate request',
  register: 'Register VM inventory',
  provision: 'Provision compute instance',
  'fry-baseline': 'Fry: baseline',
  'fry-software': 'Fry: software',
  'fry-ad-join': 'Fry: AD join',
  'fry-access': 'Fry: team access',
  finalize: 'Finalize VM',
  'on-failure': 'Failure handling',
};

const processStatuses = new Set<ProcessStatus>([
  'pending',
  'running',
  'success',
  'failed',
  'skipped',
]);

export type PipelineSnapshot = {
  status: string;
  processes: Record<(typeof PIPELINE_PROCESSES)[number], ProcessStatus>;
};

function parseAnnotation(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, item]) =>
        processStatuses.has(item as ProcessStatus),
      ),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

export function getPipelineSnapshot(entity: Entity): PipelineSnapshot {
  const annotations = entity.metadata.annotations ?? {};
  const overallStatus = annotations['cf/status'];
  const recorded = parseAnnotation(annotations['cf/processes']);
  const stages = parseAnnotation(annotations['cf/stages']);
  const stageForProcess: Record<string, string> = {
    provision: 'provision',
    'fry-baseline': 'baseline',
    'fry-software': 'software',
    'fry-ad-join': 'ad-join',
    'fry-access': 'access',
  };
  const fallback: Record<string, ProcessStatus> = {
    validate: 'success',
    register: 'success',
    finalize: overallStatus === 'ready' ? 'success' : 'pending',
    'on-failure': getFailureProcessStatus(overallStatus),
  };
  for (const [process, stage] of Object.entries(stageForProcess)) {
    fallback[process] =
      (stages[stage] as ProcessStatus | undefined) ?? 'pending';
  }
  const processes = Object.fromEntries(
    PIPELINE_PROCESSES.map(process => [
      process,
      (recorded[process] as ProcessStatus | undefined) ?? fallback[process],
    ]),
  ) as PipelineSnapshot['processes'];
  return { status: annotations['cf/status'] ?? 'unknown', processes };
}

function getFailureProcessStatus(status: string | undefined): ProcessStatus {
  if (status === 'failed') return 'success';
  if (status === 'ready') return 'skipped';
  return 'pending';
}

function formatStatus(status: ProcessStatus): string {
  switch (status) {
    case 'success':
      return 'completed';
    case 'running':
      return 'in progress';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'waiting';
  }
}

export function formatPipelineSnapshot(snapshot: PipelineSnapshot): string[] {
  return PIPELINE_PROCESSES.map(
    process =>
      `${processLabels[process]}: ${formatStatus(snapshot.processes[process])}`,
  );
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('VM pipeline watch was cancelled'));
      },
      { once: true },
    );
  });
}

export function createVmWatchAction(
  catalog: CatalogService,
  auth: AuthService,
  options: { intervalMs?: number; maxWaitMs?: number } = {},
) {
  const intervalMs = options.intervalMs ?? 10000;
  const maxWaitMs = options.maxWaitMs ?? 30 * 60 * 1000;

  return createTemplateAction({
    id: 'cf:watch-vm',
    description:
      'Stream every VM pipeline process from the catalog until the VM is ready or failed',
    schema: {
      input: {
        name: z => z.string(),
      },
      output: {
        status: z => z.string(),
      },
    },
    async handler(ctx) {
      const credentials = await ctx.getInitiatorCredentials();
      if (!auth.isPrincipal(credentials, 'user')) {
        throw new Error('A signed-in user is required');
      }

      const started = Date.now();
      let lastSignature = '';
      let inventoryFound = false;
      while (Date.now() - started <= maxWaitMs) {
        if (ctx.signal?.aborted)
          throw new Error('VM pipeline watch was cancelled');
        const entity = await catalog.getEntityByRef(
          `resource:default/${ctx.input.name}`,
          { credentials },
        );
        if (entity) {
          inventoryFound = true;
          const snapshot = getPipelineSnapshot(entity);
          const signature = PIPELINE_PROCESSES.map(
            process => `${process}:${snapshot.processes[process]}`,
          ).join('|');
          if (signature !== lastSignature) {
            lastSignature = signature;
            ctx.logger.info(
              `VM pipeline status (${
                snapshot.status
              }):\n${formatPipelineSnapshot(snapshot)
                .map(line => `  ${line}`)
                .join('\n')}`,
            );
          }
          if (snapshot.status === 'ready') {
            ctx.output('status', snapshot.status);
            ctx.logger.info('VM pipeline completed: the VM is ready.');
            return;
          }
          if (snapshot.status === 'failed') {
            ctx.output('status', snapshot.status);
            throw new Error(
              'VM pipeline failed; open the VM catalog page or GitHub Actions run for details.',
            );
          }
        } else if (!inventoryFound) {
          ctx.logger.info(
            'Waiting for the VM inventory entry to appear in the catalog...',
          );
          inventoryFound = true;
        }
        await delay(intervalMs, ctx.signal);
      }
      throw new Error(
        `VM pipeline did not finish within ${Math.round(
          maxWaitMs / 60000,
        )} minutes; open the GitHub Actions run for details.`,
      );
    },
  });
}
