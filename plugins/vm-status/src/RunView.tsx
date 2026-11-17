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
import { RunView as Run, useVmsApi } from './runs';
import { PipelineLine, stageLabel, vmColors } from './pipeline';

const useStyles = makeStyles({
  metadata: {
    color: vmColors.mute,
    fontSize: 13,
    margin: '8px 0',
    overflowWrap: 'anywhere',
  },
  error: { color: vmColors.redText, overflowWrap: 'anywhere' },
  stages: { listStyle: 'none', padding: 0, margin: '24px 0 0' },
  stage: {
    padding: '16px 0',
    borderTop: '1px solid #E3E5E8',
    overflowWrap: 'anywhere',
  },
  title: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' },
  actions: { display: 'flex', gap: 12, marginTop: 16 },
  details: { marginTop: 8, '& summary': { cursor: 'pointer' } },
});

const timestamp = (value: string | null) =>
  value ? new Date(value).toLocaleString() : '—';

export function VmRunView({
  initialRun,
  poll = true,
}: {
  initialRun: Run;
  poll?: boolean;
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
    setError(undefined);
  }, [initialRun]);
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
    if (!run.stages.some(stage => stage.status === 'retrying'))
      return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run]);

  async function act(action: 'retry' | 'skip') {
    setConfirmSkip(false);
    setPending(action);
    setError(undefined);
    try {
      setRun(await api.action(run.id, action));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(undefined);
    }
  }

  return (
    <section aria-label={`VM run ${run.id}`}>
      <div className={classes.title}>
        <h2>
          {run.kind} · {run.name}
        </h2>
        <strong>{run.status}</strong>
        <Link to={`/vms/runs/${run.id}`}>Run #{run.id}</Link>
        <Link to={`/catalog/default/resource/${encodeURIComponent(run.name)}`}>
          Open VM in catalog
        </Link>
      </div>
      <div className={classes.metadata}>
        Requested by {run.requestedBy} · Team {run.team}
      </div>
      <div className={classes.metadata}>
        Created {timestamp(run.createdAt)} · Updated {timestamp(run.updatedAt)}{' '}
        · Finished {timestamp(run.finishedAt)}
      </div>
      {run.error && <p className={classes.error}>{run.error}</p>}
      <PipelineLine
        processes={Object.fromEntries(
          run.stages.map(stage => [stage.id, stage.status]),
        )}
        stations={run.stages.map(stage => ({
          process: stage.id,
          label: stageLabel(stage.id),
        }))}
        size="large"
      />
      <ol className={classes.stages} aria-label="Run stages">
        {run.stages.map(stage => (
          <li key={stage.id} className={classes.stage}>
            <div className={classes.title}>
              <strong>{stageLabel(stage.id)}</strong>
              <span>{stage.status}</span>
              <span>
                Attempt {stage.attempt}/{stage.maxAttempts}
              </span>
            </div>
            {stage.status === 'retrying' && stage.nextAttemptAt && (
              <p>
                Retry in{' '}
                {Math.max(
                  0,
                  Math.ceil((Date.parse(stage.nextAttemptAt) - now) / 1000),
                )}
                s · {timestamp(stage.nextAttemptAt)}
              </p>
            )}
            <div className={classes.metadata}>
              Started {timestamp(stage.startedAt)} · Finished{' '}
              {timestamp(stage.finishedAt)}
              {stage.outcome && ` · Outcome ${stage.outcome}`}
            </div>
            {stage.error && <p className={classes.error}>{stage.error}</p>}
            {stage.skippedBy && (
              <p>
                Skipped by {stage.skippedBy}. This stage’s work was not applied.
              </p>
            )}
            {stage.retriedBy && <p>Retried by {stage.retriedBy}</p>}
            {stage.status === 'skipped' && !stage.skippedBy && (
              <p>Not applicable to this run.</p>
            )}
            {stage.runUrl && (
              <a href={stage.runUrl} target="_blank" rel="noreferrer">
                GitHub attempt
              </a>
            )}
            <details className={classes.details}>
              <summary>Job steps ({stage.steps.length})</summary>
              {stage.steps.length ? (
                <ol>
                  {stage.steps.map((step, index) => (
                    <li key={`${index}-${step.name}`}>
                      {step.name} · {step.status}
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No job steps reported yet.</p>
              )}
            </details>
            {!!stage.attempts.length && (
              <details className={classes.details}>
                <summary>Earlier attempts ({stage.attempts.length})</summary>
                <ol>
                  {stage.attempts.map((attempt, index) => (
                    <li key={`${index}-${attempt.attempt}`}>
                      Attempt {attempt.attempt} · {attempt.conclusion} ·{' '}
                      {timestamp(attempt.finishedAt)}
                      {attempt.error && (
                        <p className={classes.error}>{attempt.error}</p>
                      )}
                      {attempt.runUrl && (
                        <a
                          href={attempt.runUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          GitHub attempt {attempt.attempt}
                        </a>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className={classes.error}>
          {error}
        </p>
      )}
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
      <Content>
        <InfoCard title={`VM run ${id}`}>
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
        </InfoCard>
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
