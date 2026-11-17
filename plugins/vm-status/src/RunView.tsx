import { useEffect, useState } from 'react';
import { Content, InfoCard, Link, Page } from '@backstage/core-components';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  makeStyles,
} from '@material-ui/core';
import { Route, Routes, useParams } from 'react-router-dom';
import { RunView as Run, StageView, useVmsApi } from './runs';
import {
  PipelineLine,
  runProcesses,
  runStations,
  stageLabel,
  statusLabel,
  vmColors,
} from './pipeline';

const useStyles = makeStyles({
  root: {
    minWidth: 0,
    width: '100%',
    maxWidth: '100%',
    boxSizing: 'border-box',
    color: vmColors.ink,
  },
  page: {
    minWidth: 0,
    padding: '32px 20px 48px',
    maxWidth: 1120,
    width: '100%',
    margin: '0 auto',
    boxSizing: 'border-box',
    '@media (max-width: 600px)': { padding: '24px 16px 40px' },
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '16px 24px',
    flexWrap: 'wrap',
    marginBottom: 20,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
  },
  title: {
    fontSize: 30,
    fontWeight: 700,
    letterSpacing: '-0.025em',
    lineHeight: 1.15,
    margin: 0,
    overflowWrap: 'anywhere',
    '@media (max-width: 600px)': { fontSize: 24 },
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 4,
    background: '#F3F4F5',
  },
  metadata: {
    color: vmColors.mute,
    fontSize: 12.5,
    lineHeight: 1.6,
    marginTop: 8,
    overflowWrap: 'anywhere',
  },
  links: {
    display: 'flex',
    gap: 16,
    fontSize: 13,
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingTop: 8,
  },
  line: {
    minWidth: 0,
    width: '100%',
    padding: '8px 0 20px',
    boxSizing: 'border-box',
  },
  error: {
    color: vmColors.redText,
    fontSize: 12.5,
    lineHeight: 1.5,
    overflowWrap: 'anywhere',
    margin: '8px 0',
  },
  stages: { listStyle: 'none', padding: 0, margin: 0 },
  stage: { padding: '14px 0', borderTop: '1px solid #E3E5E8', minWidth: 0 },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(100px, auto) 64px',
    alignItems: 'center',
    gap: 16,
    '@media (max-width: 600px)': {
      gridTemplateColumns: 'minmax(0, 1fr) auto',
      gap: '4px 12px',
    },
  },
  label: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    fontSize: 14,
    fontWeight: 600,
    minWidth: 0,
  },
  dot: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    flex: 'none',
    background: 'currentColor',
  },
  description: {
    fontSize: 12.5,
    color: vmColors.mute,
    lineHeight: 1.5,
    paddingLeft: 17,
    marginTop: 3,
  },
  status: {
    fontSize: 12.5,
    fontWeight: 500,
    '@media (max-width: 600px)': { gridRow: 2, paddingLeft: 17 },
  },
  duration: {
    fontSize: 12.5,
    color: vmColors.mute,
    textAlign: 'right',
    whiteSpace: 'nowrap',
    '@media (max-width: 600px)': { gridColumn: 2, gridRow: 1 },
  },
  attempt: {
    fontSize: 11.5,
    fontWeight: 400,
    color: vmColors.mute,
    display: 'block',
    marginTop: 2,
  },
  details: {
    margin: '8px 0 0 17px',
    fontSize: 12.5,
    '& summary': {
      cursor: 'pointer',
      color: vmColors.blue,
      width: 'fit-content',
      padding: '2px 0',
    },
  },
  detailBody: {
    '& a': { color: vmColors.blue },
    padding: '10px 12px',
    marginTop: 8,
    background: '#F3F4F5',
    borderRadius: 6,
    overflowWrap: 'anywhere',
  },
  detailHeading: { fontSize: 12, fontWeight: 600, margin: '12px 0 6px' },
  steps: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    '& li': {
      display: 'flex',
      gap: 8,
      alignItems: 'baseline',
      padding: '4px 0',
    },
  },
  earlier: { paddingLeft: 20, margin: 0, '& li': { padding: '4px 0' } },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    margin: '0 0 20px',
  },
  compactTitle: {
    fontSize: 18,
    fontWeight: 700,
    margin: 0,
    letterSpacing: '-0.01em',
  },
  compactSummary: {
    borderTop: '1px solid #E3E5E8',
    padding: '12px 0',
    marginBottom: 4,
  },
  compactFooter: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    fontSize: 13,
    marginTop: 10,
    '& > div': { margin: 0 },
  },
});

const descriptions: Record<string, string> = {
  register: 'Record the desired VM configuration in inventory.',
  provision: 'Create compute and record its network address.',
  baseline: 'Apply hostname, timezone and the base configuration.',
  software: 'Install the software selected for this VM.',
  'ad-join': 'Apply the requested mock AD membership.',
  access: 'Grant the owning team SSH certificate access.',
  configure: 'Update the desired configuration for this refry.',
  destroy: 'Remove compute and its inventory record.',
  finalize: 'Record the run outcome in inventory.',
};
const kindLabel = {
  provision: 'Provision',
  refry: 'Refry',
  destroy: 'Destroy',
};
const runLabel = {
  running: 'In progress',
  failed: 'Failed',
  succeeded: 'Completed',
  cancelled: 'Cancelled',
};
const shortUser = (user: string) => user.split('/').pop()!;
const fullTime = (value: string) => new Date(value).toLocaleString();

function duration(start: string | null, end: string | null, now: number) {
  if (!start) return '';
  const seconds = Math.max(
    0,
    Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000),
  );
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function stageStatus(stage: StageView, now: number) {
  if (stage.status === 'skipped')
    return stage.skippedBy
      ? `Skipped by ${shortUser(stage.skippedBy)}`
      : 'Not needed';
  if (stage.status === 'retrying' && stage.nextAttemptAt) {
    const seconds = Math.max(
      0,
      Math.ceil((Date.parse(stage.nextAttemptAt) - now) / 1000),
    );
    return `Retrying in ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  return statusLabel(stage.status);
}

function statusColor(status: string) {
  if (['failed', 'failure', 'timed_out'].includes(status))
    return vmColors.redText;
  if (['running', 'retrying', 'in_progress', 'success'].includes(status))
    return vmColors.blue;
  if (status === 'succeeded') return vmColors.green;
  return vmColors.mute;
}

function StageRow({ stage, now }: { stage: StageView; now: number }) {
  const classes = useStyles();
  const ran =
    stage.attempt > 0 || !!stage.startedAt || stage.attempts.length > 0;
  const activeError =
    ['failed', 'retrying'].includes(stage.status) && stage.error;
  const retryAttempt =
    stage.attempt > 1 ||
    stage.attempts.length > 0 ||
    stage.status === 'retrying';
  return (
    <li className={classes.stage}>
      <div className={classes.row}>
        <div className={classes.label}>
          <span
            aria-hidden
            className={classes.dot}
            style={{ color: statusColor(stage.status) }}
          />
          {stageLabel(stage.id)}
        </div>
        <div
          className={classes.status}
          style={{ color: statusColor(stage.status) }}
        >
          <span>{stageStatus(stage, now)}</span>
          {retryAttempt && (
            <span className={classes.attempt}>
              attempt {stage.attempt} of {stage.maxAttempts}
            </span>
          )}
        </div>
        <time
          className={classes.duration}
          title={
            stage.startedAt
              ? `Started ${fullTime(stage.startedAt)}${
                  stage.finishedAt
                    ? ` · Finished ${fullTime(stage.finishedAt)}`
                    : ''
                }`
              : undefined
          }
        >
          {duration(stage.startedAt, stage.finishedAt, now)}
        </time>
      </div>
      {stage.status !== 'pending' &&
        !(stage.status === 'skipped' && !stage.skippedBy) && (
          <div className={classes.description}>{descriptions[stage.id]}</div>
        )}
      {activeError && <p className={classes.error}>{stage.error}</p>}
      {ran && (
        <details className={classes.details}>
          <summary>{stageLabel(stage.id)} details</summary>
          <div className={classes.detailBody}>
            {stage.runUrl && (
              <a href={stage.runUrl} target="_blank" rel="noreferrer">
                View attempt {stage.attempt} on GitHub ↗
              </a>
            )}
            {stage.error && !activeError && (
              <p className={classes.error}>{stage.error}</p>
            )}
            {stage.retriedBy && <p>Retried by {shortUser(stage.retriedBy)}</p>}
            {stage.skippedBy && (
              <p>
                This stage’s work was not applied. The desired spec is
                unchanged.
              </p>
            )}
            {stage.outcome && <p>Recorded outcome: {stage.outcome}</p>}
            {!!stage.steps.length && (
              <>
                <h4 className={classes.detailHeading}>Job steps</h4>
                <ol className={classes.steps}>
                  {stage.steps.map((step, index) => (
                    <li key={`${index}-${step.name}`}>
                      <span
                        aria-hidden
                        style={{ color: statusColor(step.status) }}
                      >
                        {(
                          {
                            success: '✓',
                            failure: '✕',
                            cancelled: '⊘',
                            skipped: '−',
                            in_progress: '◉',
                          } as Record<string, string>
                        )[step.status] ?? '○'}
                      </span>
                      <span>
                        {step.name}{' '}
                        <span style={{ color: vmColors.mute }}>
                          · {step.status.replace(/_/g, ' ')}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {!!stage.attempts.length && (
              <>
                <h4 className={classes.detailHeading}>
                  Earlier attempts ({stage.attempts.length})
                </h4>
                <ol className={classes.earlier}>
                  {stage.attempts.map((attempt, index) => (
                    <li key={`${index}-${attempt.attempt}`}>
                      <span style={{ color: statusColor(attempt.conclusion) }}>
                        Attempt {attempt.attempt} ·{' '}
                        {attempt.conclusion.replace(/_/g, ' ')}
                      </span>
                      {' · '}
                      <time title={fullTime(attempt.finishedAt)}>
                        {new Date(attempt.finishedAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                      {attempt.runUrl && (
                        <>
                          {' '}
                          ·{' '}
                          <a
                            href={attempt.runUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View on GitHub ↗
                          </a>
                        </>
                      )}
                      {attempt.error && (
                        <p className={classes.error}>{attempt.error}</p>
                      )}
                    </li>
                  ))}
                </ol>
              </>
            )}
            {!stage.runUrl &&
              !stage.steps.length &&
              !stage.attempts.length &&
              !stage.error && <span>No attempt details reported yet.</span>}
          </div>
        </details>
      )}
    </li>
  );
}

export function VmRunView({
  initialRun,
  poll = true,
  compact = false,
  onRunChange,
}: {
  initialRun: Run;
  poll?: boolean;
  compact?: boolean;
  onRunChange?: (run: Run) => void;
}) {
  const classes = useStyles();
  const api = useVmsApi();
  const [run, setRun] = useState(initialRun);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<'retry' | 'skip'>();
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setRun(initialRun);
  }, [initialRun]);
  useEffect(() => {
    setError(undefined);
    setConfirmSkip(false);
  }, [initialRun.id]);
  useEffect(() => {
    if (!poll || run.status !== 'running') return undefined;
    let disposed = false;
    let timer: number;
    async function refreshRun() {
      try {
        const updated = await api.getRun(run.id);
        if (disposed) return;
        setRun(updated);
        setError(undefined);
        if (updated.status !== 'running') return;
      } catch (e) {
        if (disposed) return;
        setError(`Live update failed: ${(e as Error).message}. Retrying.`);
      }
      timer = window.setTimeout(refreshRun, 5000);
    }
    timer = window.setTimeout(refreshRun, 5000);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [api, run.id, run.status, poll]);
  useEffect(() => {
    if (run.status !== 'running') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.status]);

  async function act(action: 'retry' | 'skip') {
    setConfirmSkip(false);
    setPending(action);
    setError(undefined);
    try {
      const updated = await api.action(run.id, action);
      setRun(updated);
      onRunChange?.(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(undefined);
    }
  }

  const active =
    run.stages.find(stage => stage.status === 'failed') ??
    run.stages.find(stage => ['running', 'retrying'].includes(stage.status));
  // Cancellation can leave a dispatched stage without its own finishedAt.
  const observedAt =
    run.status === 'running'
      ? now
      : Date.parse(run.finishedAt ?? run.updatedAt);
  const line = (
    <div className={classes.line}>
      <PipelineLine
        processes={runProcesses(run)}
        stations={runStations(run)}
        size="large"
      />
    </div>
  );
  const actions = (
    <div className={classes.actions}>
      {run.actions.retry && (
        <Button
          variant="contained"
          color="primary"
          disabled={!!pending}
          onClick={() => act('retry')}
        >
          {pending === 'retry' ? 'Retrying…' : 'Retry'}
        </Button>
      )}
      {run.actions.skip && (
        <Button
          variant="outlined"
          disabled={!!pending}
          onClick={() => setConfirmSkip(true)}
        >
          {pending === 'skip' ? 'Skipping…' : 'Skip'}
        </Button>
      )}
    </div>
  );
  const chip = (
    <span
      role="status"
      aria-label="Run status"
      className={classes.chip}
      style={{ color: statusColor(run.status) }}
    >
      <span aria-hidden className={classes.dot} />
      {runLabel[run.status]}
    </span>
  );

  return (
    <section className={classes.root} aria-label={`VM run ${run.id}`}>
      {compact ? (
        <>
          <div className={classes.titleRow}>
            <h2 className={classes.compactTitle}>
              {kindLabel[run.kind]} run #{run.id}
            </h2>
            {chip}
          </div>
          <div className={classes.metadata}>
            Requested by{' '}
            <span title={run.requestedBy}>{shortUser(run.requestedBy)}</span> ·{' '}
            {run.team}
          </div>
          {line}
          {active && (
            <div className={classes.compactSummary}>
              <div className={classes.label}>
                <span
                  aria-hidden
                  className={classes.dot}
                  style={{ color: statusColor(active.status) }}
                />
                {stageLabel(active.id)}{' '}
                <span
                  className={classes.status}
                  style={{ color: statusColor(active.status) }}
                >
                  {stageStatus(active, now)}
                </span>
              </div>
              {active.error && <p className={classes.error}>{active.error}</p>}
            </div>
          )}
          {run.error && !active?.error && (
            <p className={classes.error}>{run.error}</p>
          )}
        </>
      ) : (
        <>
          <header className={classes.header}>
            <div>
              <div className={classes.titleRow}>
                <h1 className={classes.title}>
                  {kindLabel[run.kind]} · {run.name}
                </h1>
                {chip}
              </div>
              <div className={classes.metadata}>
                <span title={run.requestedBy}>
                  {shortUser(run.requestedBy)}
                </span>{' '}
                · Team {run.team} · Started{' '}
                <time title={fullTime(run.createdAt)}>
                  {new Date(run.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>{' '}
                · {duration(run.createdAt, run.finishedAt, now)} elapsed
              </div>
            </div>
            <nav className={classes.links} aria-label="Run links">
              <span style={{ color: vmColors.mute }}>Run #{run.id}</span>
              <Link
                to={`/catalog/default/resource/${encodeURIComponent(run.name)}`}
              >
                Open VM in catalog →
              </Link>
            </nav>
          </header>
          {run.error && <p className={classes.error}>{run.error}</p>}
        </>
      )}
      {error && (
        <p role="alert" className={classes.error}>
          {error}
        </p>
      )}
      {compact ? (
        <div className={classes.compactFooter}>
          {(run.actions.retry || run.actions.skip) && actions}
          <Link to={`/vms/runs/${run.id}`}>View run details →</Link>
        </div>
      ) : (
        <>
          {(run.actions.retry || run.actions.skip) && actions}
          <InfoCard title="Pipeline stages">
            {line}
            <ol className={classes.stages} aria-label="Run stages">
              {run.stages.map(stage => (
                <StageRow key={stage.id} stage={stage} now={observedAt} />
              ))}
            </ol>
          </InfoCard>
        </>
      )}
      <Dialog
        open={confirmSkip}
        onClose={() => setConfirmSkip(false)}
        aria-labelledby="skip-stage-title"
      >
        <DialogTitle id="skip-stage-title">Skip failed stage?</DialogTitle>
        <DialogContent>
          The stage’s work will not be applied. The desired VM spec will not
          change.
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmSkip(false)}>Cancel</Button>
          <Button
            color="primary"
            disabled={!!pending || !run.actions.skip}
            onClick={() => act('skip')}
          >
            Skip stage
          </Button>
        </DialogActions>
      </Dialog>
    </section>
  );
}

function RunPage() {
  const classes = useStyles();
  const { id } = useParams();
  const api = useVmsApi();
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    setRun(undefined);
    setError(undefined);
    api
      .getRun(id!)
      .then(value => {
        if (!disposed) setRun(value);
      })
      .catch(e => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [api, id, reload]);
  return (
    <Page themeId="tool">
      <Content className={classes.page}>
        {error && (
          <div role="alert">
            {error}{' '}
            <Button onClick={() => setReload(value => value + 1)}>
              Try again
            </Button>
          </div>
        )}
        {!error && run && <VmRunView initialRun={run} />}
        {!error && !run && <p>Loading run…</p>}
      </Content>
    </Page>
  );
}

export function VmRunsPage() {
  return (
    <Routes>
      <Route path="runs/:id" element={<RunPage />} />
      <Route
        path="*"
        element={
          <Content>Open a VM run from your request output or VM page.</Content>
        }
      />
    </Routes>
  );
}
