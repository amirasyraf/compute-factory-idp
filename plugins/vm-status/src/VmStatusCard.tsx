import { useEffect, useState, type CSSProperties } from 'react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { InfoCard, Link } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef, useEntity } from '@backstage/plugin-catalog-react';
import {
  Box,
  Chip,
  Divider,
  Grid,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Typography,
} from '@material-ui/core';
import CheckCircle from '@material-ui/icons/CheckCircle';
import ErrorIcon from '@material-ui/icons/Error';
import HourglassEmpty from '@material-ui/icons/HourglassEmpty';
import PlayCircleOutline from '@material-ui/icons/PlayCircleOutline';
import SkipNext from '@material-ui/icons/SkipNext';

export type PipelineStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped';

export const PROCESS_ORDER = [
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

type ProcessName = (typeof PROCESS_ORDER)[number];

const processInfo: Record<ProcessName, { label: string; description: string }> =
  {
    validate: {
      label: 'Validate request',
      description:
        'Check the VM name, team, platform, OS and software choices.',
    },
    register: {
      label: 'Register VM inventory',
      description:
        'Write the request and catalog entity to the platform inventory.',
    },
    provision: {
      label: 'Provision compute instance',
      description: 'Create the VM with Terraform and record its IP address.',
    },
    'fry-baseline': {
      label: 'Fry: baseline',
      description: 'Apply hostname, timezone, hosts, banner and VM metadata.',
    },
    'fry-software': {
      label: 'Fry: software',
      description:
        'Install the software selected in the request, or skip if none was selected.',
    },
    'fry-ad-join': {
      label: 'Fry: AD join',
      description:
        'Apply the requested mock AD membership, or skip when it was not selected.',
    },
    'fry-access': {
      label: 'Fry: team access',
      description:
        'Grant the owning team access through the SSH certificate principal.',
    },
    finalize: {
      label: 'Finalize VM',
      description: 'Mark the VM ready after every required stage succeeds.',
    },
    'on-failure': {
      label: 'Failure handling',
      description:
        'Record a failed running process while keeping the VM for diagnosis.',
    },
  };

const statusIcons: Record<PipelineStatus, JSX.Element> = {
  success: <CheckCircle style={{ color: '#4caf50' }} />,
  failed: <ErrorIcon color="error" />,
  pending: <HourglassEmpty color="disabled" />,
  running: <PlayCircleOutline color="primary" />,
  skipped: <SkipNext color="disabled" />,
};

const validStatuses = new Set<PipelineStatus>([
  'pending',
  'running',
  'success',
  'failed',
  'skipped',
]);

function parseStatuses(
  value: string | undefined,
): Record<string, PipelineStatus> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, status]) =>
        validStatuses.has(status as PipelineStatus),
      ),
    ) as Record<string, PipelineStatus>;
  } catch {
    return {};
  }
}

/**
 * Converts the five legacy stage annotations into the complete workflow view.
 * This keeps already-registered VMs readable while new inventory entries expose
 * the explicit cf/processes annotation.
 */
export function getPipelineProcesses(
  annotations: Record<string, string>,
): Record<ProcessName, PipelineStatus> {
  const stages = parseStatuses(annotations['cf/stages']);
  const recorded = parseStatuses(annotations['cf/processes']);
  const processStageMap: Record<string, string> = {
    provision: 'provision',
    'fry-baseline': 'baseline',
    'fry-software': 'software',
    'fry-ad-join': 'ad-join',
    'fry-access': 'access',
  };
  const fallback = Object.fromEntries(
    PROCESS_ORDER.map(process => {
      if (process === 'validate' || process === 'register') {
        return [process, 'success'];
      }
      if (process === 'finalize') {
        return [
          process,
          annotations['cf/status'] === 'ready' ? 'success' : 'pending',
        ];
      }
      if (process === 'on-failure') {
        return [process, getFailureProcessStatus(annotations['cf/status'])];
      }
      return [process, stages[processStageMap[process]] ?? 'pending'];
    }),
  ) as Record<ProcessName, PipelineStatus>;

  return Object.fromEntries(
    PROCESS_ORDER.map(process => [
      process,
      recorded[process] ?? fallback[process],
    ]),
  ) as Record<ProcessName, PipelineStatus>;
}

export function statusLabel(status: PipelineStatus): string {
  switch (status) {
    case 'success':
      return 'Completed';
    case 'running':
      return 'In progress';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'Skipped';
    default:
      return 'Waiting';
  }
}

function getFailureProcessStatus(status: string | undefined): PipelineStatus {
  if (status === 'failed') return 'success';
  if (status === 'ready') return 'skipped';
  return 'pending';
}

function getOverallPipelineStatus(status: string): PipelineStatus {
  if (status === 'ready') return 'success';
  if (status === 'failed') return 'failed';
  if (
    status === 'provisioning' ||
    status === 'frying' ||
    status === 'destroying'
  ) {
    return 'running';
  }
  return 'pending';
}

function statusChipStyle(status: PipelineStatus): CSSProperties {
  if (status === 'success')
    return { backgroundColor: '#e8f5e9', color: '#1b5e20' };
  if (status === 'failed')
    return { backgroundColor: '#ffebee', color: '#b71c1c' };
  if (status === 'running')
    return { backgroundColor: '#e3f2fd', color: '#0d47a1' };
  return { backgroundColor: '#f5f5f5', color: '#616161' };
}

export function VmStatusCard() {
  const { entity: initial } = useEntity();
  const api = useApi(catalogApiRef);
  const [entity, setEntity] = useState(initial);
  const [error, setError] = useState<string>();
  const [lastRefreshed, setLastRefreshed] = useState(() => new Date());

  useEffect(() => {
    setEntity(initial);
    setLastRefreshed(new Date());
  }, [initial]);

  const annotations = entity.metadata.annotations ?? {};
  const overallStatus = annotations['cf/status'] ?? 'unknown';
  const status = getOverallPipelineStatus(overallStatus);
  const processes = getPipelineProcesses(annotations);
  const rows = PROCESS_ORDER.map(process => ({
    process,
    ...processInfo[process],
    status: processes[process],
  }));
  const active = rows.find(row => row.status === 'running');
  const failed = rows.find(row => row.status === 'failed');
  const completed = rows.filter(
    row => row.status === 'success' || row.status === 'skipped',
  ).length;
  const ip = annotations['cf/public-ip'];
  const user = annotations['cf/ssh-user'] || 'ubuntu';
  const prefill = encodeURIComponent(
    JSON.stringify({ vm: stringifyEntityRef(entity) }),
  );
  const runUrl = annotations['cf/run-url'];
  const overallLabel = statusLabel(status);
  let currentActivity = 'Waiting for pipeline updates';
  if (failed) currentActivity = `${failed.label} failed`;
  else if (active) currentActivity = active.label;
  else if (overallStatus === 'ready')
    currentActivity = 'All pipeline processes completed';

  useEffect(() => {
    if (overallStatus === 'ready' || overallStatus === 'failed')
      return undefined;
    let disposed = false;
    let fetching = false;
    const timer = window.setInterval(async () => {
      if (fetching) return;
      fetching = true;
      try {
        const updated = await api.getEntityByRef(stringifyEntityRef(entity));
        if (!disposed && updated) {
          setEntity(updated);
          setLastRefreshed(new Date());
          setError(undefined);
        }
      } catch {
        if (!disposed) setError('Live refresh failed; retrying.');
      } finally {
        fetching = false;
      }
    }, 10000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [api, entity, overallStatus]);

  return (
    <InfoCard title="VM pipeline">
      <Box display="flex" justifyContent="space-between" alignItems="center">
        <Typography variant="h6">{overallLabel}</Typography>
        <Chip label={overallStatus} style={statusChipStyle(status)} />
      </Box>
      <Typography variant="body2" color="textSecondary">
        Current activity: {currentActivity}
      </Typography>
      {error && <Typography color="error">{error}</Typography>}

      <Box mt={2} mb={1}>
        <Box
          style={{
            height: 6,
            borderRadius: 3,
            background: '#eeeeee',
            overflow: 'hidden',
          }}
        >
          <Box
            style={{
              height: '100%',
              width: `${(completed / PROCESS_ORDER.length) * 100}%`,
              background: '#4caf50',
              transition: 'width 300ms ease',
            }}
          />
        </Box>
        <Typography variant="caption" color="textSecondary">
          {completed} of {PROCESS_ORDER.length} pipeline processes complete or
          skipped
        </Typography>
      </Box>

      <Typography variant="subtitle2">Pipeline processes</Typography>
      <List dense>
        {rows.map(row => (
          <ListItem key={row.process} divider alignItems="flex-start">
            <ListItemIcon>{statusIcons[row.status]}</ListItemIcon>
            <ListItemText
              primary={
                <Box display="flex" alignItems="center" gridGap={8}>
                  <Typography variant="body2">{row.label}</Typography>
                  <Chip
                    size="small"
                    label={statusLabel(row.status)}
                    style={statusChipStyle(row.status)}
                  />
                </Box>
              }
              secondary={row.description}
            />
          </ListItem>
        ))}
      </List>

      <Typography variant="caption" color="textSecondary">
        Live catalog status; refreshes every 10 seconds while the pipeline is
        active. Last checked {lastRefreshed.toLocaleTimeString()}.
      </Typography>

      <Divider style={{ margin: '16px 0' }} />
      <Typography variant="subtitle2">Request and access</Typography>
      <Grid container spacing={1} style={{ marginTop: 4 }}>
        <Grid item xs={6}>
          <Typography variant="caption" color="textSecondary">
            Team
          </Typography>
          <Typography variant="body2">
            {annotations['cf/team'] || '—'}
          </Typography>
        </Grid>
        <Grid item xs={6}>
          <Typography variant="caption" color="textSecondary">
            Platform / OS
          </Typography>
          <Typography variant="body2">
            {annotations['cf/platform'] || '—'} / {annotations['cf/os'] || '—'}
          </Typography>
        </Grid>
        <Grid item xs={6}>
          <Typography variant="caption" color="textSecondary">
            Size
          </Typography>
          <Typography variant="body2">
            {annotations['cf/size'] || '—'}
          </Typography>
        </Grid>
        <Grid item xs={6}>
          <Typography variant="caption" color="textSecondary">
            Software
          </Typography>
          <Typography variant="body2">
            {annotations['cf/software'] || 'none'}
          </Typography>
        </Grid>
      </Grid>

      <Box mt={2}>
        <Typography variant="body2">
          IP: {ip || 'Pending'} · SSH user: {user}
        </Typography>
        {ip && (
          <Box my={1}>
            <code>
              ssh {user}@{ip}
            </code>
          </Box>
        )}
        {runUrl && (
          <Box my={1}>
            <a href={runUrl} target="_blank" rel="noreferrer">
              Open full GitHub Actions run
            </a>
          </Box>
        )}
      </Box>

      <Box my={1}>
        <Link to="/create/templates/default/ssh-cert">Get SSH certificate</Link>
      </Box>
      <Box my={1}>
        <Link to={`/create/templates/default/vm-refry?formData=${prefill}`}>
          Re-run fry stage
        </Link>
      </Box>
      <Box my={1}>
        <Link to={`/create/templates/default/vm-destroy?formData=${prefill}`}>
          Destroy VM
        </Link>
      </Box>
    </InfoCard>
  );
}
