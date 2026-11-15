import { PropsWithChildren, useEffect, useMemo, useState } from 'react';
import { Route, Routes, useParams } from 'react-router-dom';
import { Content, InfoCard } from '@backstage/core-components';
import { useTaskEventStream } from '@backstage/plugin-scaffolder-react';
import {
  Box,
  Chip,
  CircularProgress,
  LinearProgress,
  Typography,
  makeStyles,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import {
  readWorkflowProgress,
  stageDuration,
  WorkflowStage,
} from './workflowProgress';

const useStyles = makeStyles(theme => ({
  graph: {
    display: 'flex',
    gap: theme.spacing(2),
    overflowX: 'auto',
    padding: theme.spacing(1, 0, 2),
  },
  stage: {
    flex: '0 0 210px',
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 6,
    padding: theme.spacing(2),
    position: 'relative',
  },
  running: {
    borderColor: theme.palette.primary.main,
    background: theme.palette.action.hover,
  },
  details: { marginTop: theme.spacing(2), cursor: 'pointer' },
  steps: {
    paddingLeft: theme.spacing(2),
    '& li': { marginTop: theme.spacing(1) },
  },
  success: { color: theme.palette.success.main },
  failure: { color: theme.palette.error.main },
}));

const labels: Record<string, string> = {
  'fry-baseline / fry': 'Baseline',
  'fry-software / fry': 'Software',
  'fry-ad-join / fry': 'AD join',
  'fry-access / fry': 'Access',
  'on-failure': 'Failure handling',
  'fry / fry': 'Fry',
};
const symbols: Record<string, string> = {
  success: '✓',
  failure: '✗',
  timed_out: '✗',
  cancelled: '⊘',
  skipped: '−',
};

function Status({ status }: { status: string }) {
  const classes = useStyles();
  let color: string | undefined;
  if (status === 'success') color = classes.success;
  if (['failure', 'timed_out', 'cancelled'].includes(status))
    color = classes.failure;
  return (
    <Box
      component="span"
      className={color}
      display="inline-flex"
      alignItems="center"
      gridGap={6}
    >
      {status === 'in_progress' ? (
        <CircularProgress size={12} aria-label="Running" />
      ) : (
        <span aria-hidden>{symbols[status] ?? '○'}</span>
      )}
      <span>{status.replace(/_/g, ' ')}</span>
    </Box>
  );
}

function StageCard({ stage, now }: { stage: WorkflowStage; now: number }) {
  const classes = useStyles();
  return (
    <Box
      className={`${classes.stage} ${
        stage.status === 'in_progress' ? classes.running : ''
      }`}
    >
      <Typography variant="subtitle1">
        {labels[stage.name] ??
          stage.name.replace(/^./, letter => letter.toUpperCase())}
      </Typography>
      <Status status={stage.status} />
      <Typography variant="caption" display="block">
        {stageDuration(stage, now)}
      </Typography>
      <details className={classes.details}>
        <summary>Steps ({stage.steps.length})</summary>
        {stage.steps.length ? (
          <ol className={classes.steps}>
            {stage.steps.map((step, index) => (
              <li key={`${index}-${step.name}`}>
                <Typography variant="body2">{step.name}</Typography>
                <Typography variant="caption">
                  <Status status={step.status} /> {stageDuration(step, now)}
                </Typography>
              </li>
            ))}
          </ol>
        ) : (
          <Typography variant="body2">
            No step details reported by GitHub.
          </Typography>
        )}
      </details>
    </Box>
  );
}

function TaskPipeline() {
  const { taskId } = useParams();
  const stream = useTaskEventStream(taskId!);
  const classes = useStyles();
  const logs = stream.stepLogs.monitor;
  const progress = useMemo(() => readWorkflowProgress(logs ?? []), [logs]);
  const [now, setNow] = useState(Date.now);
  const active =
    !!progress &&
    progress.status !== 'completed' &&
    !stream.completed &&
    !stream.cancelled;
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const monitorsWorkflow = stream.task?.spec.steps.some(
    step => step.action === 'cf:watch-workflow',
  );
  if (!monitorsWorkflow) return null;
  const done =
    progress?.jobs.filter(
      job =>
        !['waiting', 'queued', 'pending', 'in_progress', 'unknown'].includes(
          job.status,
        ),
    ).length ?? 0;
  return (
    <Content>
      <InfoCard
        title="Workflow stages"
        subheader="Live GitHub Actions jobs · updates about every 10 seconds"
      >
        {stream.error && (
          <Alert severity="warning">
            Workflow updates unavailable: {stream.error.message}
          </Alert>
        )}
        {!progress ? (
          <Typography>
            Waiting for workflow stage data. Tasks started before this update
            retain their text logs below.
          </Typography>
        ) : (
          <>
            <Box display="flex" alignItems="center" gridGap={12} mb={2}>
              <Chip
                label={
                  progress.conclusion ?? progress.status.replace(/_/g, ' ')
                }
                size="small"
              />
              <Typography variant="body2">
                {done}/{progress.jobs.length} jobs complete
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={
                progress.jobs.length ? (done / progress.jobs.length) * 100 : 0
              }
              aria-label="Workflow progress"
            />
            {(stream.cancelled ||
              (stream.completed && progress.status !== 'completed')) && (
              <Alert severity="warning">
                Task monitoring stopped. These are the last observed GitHub job
                states, not confirmation that the workflow stopped.
              </Alert>
            )}
            <Box
              className={classes.graph}
              role="region"
              aria-label="GitHub Actions stages"
              tabIndex={0}
            >
              {progress.jobs.map(stage => (
                <StageCard key={stage.name} stage={stage} now={now} />
              ))}
            </Box>
          </>
        )}
      </InfoCard>
    </Content>
  );
}

// Augment only task details; retain the upstream task list, controls, logs and outputs.
export function WorkflowTasks({ children }: PropsWithChildren<{}>) {
  return (
    <>
      <Routes>
        <Route path=":taskId" element={<TaskPipeline />} />
        <Route path="*" element={null} />
      </Routes>
      {children}
    </>
  );
}
