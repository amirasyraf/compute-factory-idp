import { useEffect, useState } from 'react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { InfoCard, Link } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef, useEntity } from '@backstage/plugin-catalog-react';
import { makeStyles } from '@material-ui/core';
import { getVmConfiguration } from './vmSpec';
import { useVmSizes, vmSizeText } from './vmSizes';
import {
  PROCESS_ORDER,
  PipelineLine,
  PipelineStatus,
  ProcessName,
  getPipelineProcesses,
  statusLabel,
  vmColors,
  vmState,
  vmStateLabel,
} from './pipeline';

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
        'Commit the desired VM spec and catalog entity to the platform inventory.',
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

function statusDot(status: PipelineStatus): string {
  if (status === 'success' || status === 'running') return vmColors.blue;
  if (status === 'failed') return vmColors.red;
  return '#C9CDD2';
}

const useStyles = makeStyles(theme => ({
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    flexWrap: 'wrap',
  },
  state: { fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' },
  activity: { color: vmColors.mute, fontSize: 13, marginTop: 2 },
  line: { margin: theme.spacing(3, 0, 1) },
  note: { color: vmColors.mute, fontSize: 12.5 },
  error: { color: vmColors.redText, fontSize: 13, marginTop: 8 },
  section: {
    marginTop: theme.spacing(3),
    paddingTop: theme.spacing(2),
    borderTop: `1px solid ${theme.palette.divider}`,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    margin: '0 0 10px',
  },
  steps: { margin: 0, padding: 0, listStyle: 'none' },
  step: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    columnGap: 16,
    padding: '9px 0',
    borderBottom: `1px solid ${theme.palette.divider}`,
    '&:last-child': { borderBottom: 0 },
  },
  stepLabel: { fontSize: 14, fontWeight: 600 },
  stepDesc: { fontSize: 12.5, color: vmColors.mute, marginTop: 2 },
  stepStatus: {
    fontSize: 12.5,
    fontWeight: 600,
    alignSelf: 'center',
    color: vmColors.ink,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    whiteSpace: 'nowrap',
  },
  stepDot: { width: 8, height: 8, borderRadius: '50%', flex: 'none' },
  facts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: '12px 24px',
    margin: 0,
    '& dt': { fontSize: 12, color: vmColors.mute },
    '& dd': { margin: '2px 0 0', fontSize: 14, overflowWrap: 'anywhere' },
  },
  command: {
    display: 'inline-block',
    fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
    fontSize: 13,
    background: '#F3F4F5',
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 6,
    padding: '6px 10px',
    marginTop: 4,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: theme.spacing(2),
  },
  action: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 36,
    padding: '0 14px',
    borderRadius: 6,
    border: `1px solid ${theme.palette.divider}`,
    background: '#fff',
    color: vmColors.ink,
    fontWeight: 600,
    fontSize: 13.5,
    textDecoration: 'none',
    '&:hover': { borderColor: '#C9CDD2', textDecoration: 'none' },
  },
  primary: {
    background: vmColors.blue,
    borderColor: vmColors.blue,
    color: '#fff',
    '&:hover': { background: '#0A4FB0', borderColor: '#0A4FB0' },
  },
  danger: {
    color: vmColors.redText,
    '&:hover': { borderColor: vmColors.red },
  },
}));

export function VmStatusCard() {
  const classes = useStyles();
  const { entity: initial } = useEntity();
  const api = useApi(catalogApiRef);
  const [entity, setEntity] = useState(initial);
  const [error, setError] = useState<string>();
  const [lastRefreshed, setLastRefreshed] = useState(() => new Date());
  // Set when a refresh finds the entity gone: destroy deletes it last.
  const [removed, setRemoved] = useState(false);

  useEffect(() => {
    setEntity(initial);
    setRemoved(false);
    setLastRefreshed(new Date());
  }, [initial]);

  const annotations = entity.metadata.annotations ?? {};
  const desired = getVmConfiguration(entity.spec);
  const sizes = useVmSizes();
  const overallStatus = annotations['cf/status'] ?? 'unknown';
  const state = vmState(overallStatus);
  const processes = getPipelineProcesses(annotations);
  const rows = PROCESS_ORDER.map(process => ({
    process,
    ...processInfo[process],
    status: processes[process],
  }));
  const active = rows.find(row => row.status === 'running');
  const failed = rows.find(row => row.status === 'failed');
  const ip = annotations['cf/public-ip'];
  const user = annotations['cf/ssh-user'] || 'ubuntu';
  const prefill = encodeURIComponent(
    JSON.stringify({ vm: stringifyEntityRef(entity) }),
  );
  const runUrl = annotations['cf/run-url'];
  const destroying = state === 'destroying';
  let currentActivity = 'Waiting for pipeline updates';
  if (destroying)
    currentActivity =
      'The destroy workflow is removing this VM. This page updates when it leaves the catalog.';
  else if (failed) currentActivity = `${failed.label} failed`;
  else if (active) currentActivity = active.label;
  else if (overallStatus === 'ready')
    currentActivity = 'All pipeline processes completed';

  useEffect(() => {
    if (removed || overallStatus === 'ready' || overallStatus === 'failed')
      return undefined;
    let disposed = false;
    let fetching = false;
    const timer = window.setInterval(async () => {
      if (fetching) return;
      fetching = true;
      try {
        const updated = await api.getEntityByRef(stringifyEntityRef(entity));
        if (disposed) return;
        if (updated) setEntity(updated);
        else setRemoved(true);
        setLastRefreshed(new Date());
        setError(undefined);
      } catch (e) {
        if (!disposed)
          setError(`Live refresh failed (${(e as Error).message}); retrying.`);
      } finally {
        fetching = false;
      }
    }, 10000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [api, entity, overallStatus, removed]);

  let refreshNote =
    'Refreshes about every 10 seconds while the pipeline is active.';
  if (state === 'ready' || state === 'failed') refreshNote = '';
  else if (destroying)
    refreshNote = 'Checks about every 10 seconds until the VM is removed.';

  if (removed) {
    return (
      <InfoCard title="VM pipeline">
        <div className={classes.state}>Destroyed</div>
        <div className={classes.activity}>
          This VM has been removed from the catalog. Checked{' '}
          {lastRefreshed.toLocaleTimeString()}.
        </div>
        <div className={classes.actions}>
          {runUrl && (
            <a
              href={runUrl}
              target="_blank"
              rel="noreferrer"
              className={classes.action}
            >
              View destroy run on GitHub
            </a>
          )}
          <Link
            to="/catalog"
            className={`${classes.action} ${classes.primary}`}
          >
            Back to Resources
          </Link>
        </div>
      </InfoCard>
    );
  }

  return (
    <InfoCard title="VM pipeline">
      <div className={classes.head}>
        <div>
          <div
            className={classes.state}
            style={{ color: state === 'failed' ? vmColors.redText : undefined }}
          >
            {vmStateLabel(overallStatus, processes)}
          </div>
          <div className={classes.activity}>{currentActivity}</div>
        </div>
      </div>

      <div className={classes.line}>
        <PipelineLine
          processes={processes}
          retired={state === 'destroying'}
          size="large"
        />
      </div>
      <div className={classes.note}>
        {refreshNote} Last checked {lastRefreshed.toLocaleTimeString()}.
      </div>
      {error && <div className={classes.error}>{error}</div>}

      <div className={classes.section}>
        <h3 className={classes.sectionTitle}>Access</h3>
        <dl className={classes.facts}>
          <div>
            <dt>IP address</dt>
            <dd>{ip || 'Pending'}</dd>
          </div>
          <div>
            <dt>SSH user</dt>
            <dd>{user}</dd>
          </div>
        </dl>
        {ip && !destroying && (
          <code className={classes.command}>
            ssh {user}@{ip}
          </code>
        )}
        <div className={classes.actions}>
          {!destroying && (
            <Link
              to="/create/templates/default/ssh-cert"
              className={`${classes.action} ${
                state === 'ready' ? classes.primary : ''
              }`}
            >
              Get SSH certificate
            </Link>
          )}
          {runUrl && (
            <a
              href={runUrl}
              target="_blank"
              rel="noreferrer"
              className={`${classes.action} ${
                state === 'failed' || destroying ? classes.primary : ''
              }`}
            >
              {destroying ? 'View destroy run on GitHub' : 'View run on GitHub'}
            </a>
          )}
          {!destroying && (
            <>
              <Link
                to={`/create/templates/default/vm-refry?formData=${prefill}`}
                className={classes.action}
              >
                Refry
              </Link>
              <Link
                to={`/create/templates/default/vm-destroy?formData=${prefill}`}
                className={`${classes.action} ${classes.danger}`}
              >
                Destroy VM
              </Link>
            </>
          )}
        </div>
      </div>

      <div className={classes.section}>
        <h3 className={classes.sectionTitle}>Pipeline processes</h3>
        <ol className={classes.steps}>
          {rows.map(row => (
            <li key={row.process} className={classes.step}>
              <div>
                <div className={classes.stepLabel}>{row.label}</div>
                <div className={classes.stepDesc}>{row.description}</div>
              </div>
              <span
                className={classes.stepStatus}
                style={
                  row.status === 'failed' ? { color: vmColors.redText } : {}
                }
              >
                <i
                  className={classes.stepDot}
                  style={{ background: statusDot(row.status) }}
                />
                {statusLabel(row.status)}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className={classes.section}>
        <h3 className={classes.sectionTitle}>Desired configuration</h3>
        <dl className={classes.facts}>
          <div>
            <dt>Team</dt>
            <dd>{desired.team}</dd>
          </div>
          <div>
            <dt>Platform / OS</dt>
            <dd>
              {desired.platform} / {desired.os}
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{vmSizeText(entity, desired.size, sizes)}</dd>
          </div>
          <div>
            <dt>Software</dt>
            <dd>{desired.software}</dd>
          </div>
          <div>
            <dt>AD join</dt>
            <dd>{desired.adJoin}</dd>
          </div>
          <div>
            <dt>Billing (self-reported)</dt>
            <dd>{desired.billing}</dd>
          </div>
          <div>
            <dt>Cloud tags</dt>
            <dd>{desired.cloudTags}</dd>
          </div>
        </dl>
      </div>
    </InfoCard>
  );
}
