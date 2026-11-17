import { useEffect, useState } from 'react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { InfoCard, Link } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef, useEntity } from '@backstage/plugin-catalog-react';
import { makeStyles } from '@material-ui/core';
import { getVmConfiguration } from './vmSpec';
import { useVmSizeText } from './vmSizes';
import { RunView, runVmStatus, useVmsApi } from './runs';
import { VmRunView } from './RunView';
import { vmColors, vmState, vmRunLabel, VmActivityTime } from './pipeline';

const useStyles = makeStyles(theme => ({
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    flexWrap: 'wrap',
  },
  state: { fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' },
  activity: { color: vmColors.mute, fontSize: 13, marginTop: 2 },
  note: { color: vmColors.mute, fontSize: 12.5, marginTop: 6 },
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
  facts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(180px, 100%), 1fr))',
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
    maxWidth: '100%',
    boxSizing: 'border-box',
    overflowWrap: 'anywhere',
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
  const runsApi = useVmsApi();
  const [run, setRun] = useState<RunView>();
  const [runError, setRunError] = useState<string>();
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
  const sizeText = useVmSizeText(entity);
  const overallStatus = runVmStatus(run, annotations['cf/status']) ?? 'unknown';
  const state = vmState(overallStatus);
  const ip = annotations['cf/public-ip'];
  const user = annotations['cf/ssh-user'] || 'ubuntu';
  const prefill = encodeURIComponent(
    JSON.stringify({ vm: stringifyEntityRef(entity) }),
  );
  const runUrl = run ? `/vms/runs/${run.id}` : undefined;
  const destroying = state === 'destroying';

  useEffect(() => {
    if (removed) return undefined;
    let disposed = false;
    let timer: number;
    setRun(undefined);
    async function load() {
      try {
        const result = await runsApi.latest(initial.metadata.name);
        if (disposed) return;
        setRun(result.runs[0]);
        setRunError(undefined);
      } catch (e) {
        if (!disposed) setRunError((e as Error).message);
      }
      if (!disposed) timer = window.setTimeout(load, 5000);
    }
    load();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [runsApi, initial.metadata.name, removed]);

  useEffect(() => {
    if (removed) return undefined;
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

  const refreshNote =
    'Catalog facts refresh about every 10 seconds; latest run about every 5 seconds.';

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
              View destroy run
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
      {!run && (
        <div className={classes.head}>
          <div>
            <div
              className={classes.state}
              style={{
                color: state === 'failed' ? vmColors.redText : undefined,
              }}
            >
              {vmRunLabel(undefined, overallStatus)}
            </div>
            <div className={classes.activity}>
              {destroying
                ? 'Removing this VM; checking until it leaves the catalog.'
                : 'Latest orchestrator run'}
            </div>
          </div>
        </div>
      )}

      {run ? (
        <VmRunView initialRun={run} poll={false} compact onRunChange={setRun} />
      ) : (
        <p>
          No run known. Catalog status: {annotations['cf/status'] ?? 'unknown'}.
        </p>
      )}
      {runError && (
        <p role="alert" className={classes.error}>
          Run updates unavailable: {runError}
        </p>
      )}
      <div className={classes.activity}>
        <VmActivityTime annotations={annotations} />
      </div>
      <div className={classes.note} title={refreshNote}>
        Catalog checked{' '}
        <time
          dateTime={lastRefreshed.toISOString()}
          title={lastRefreshed.toLocaleString()}
        >
          {lastRefreshed.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>{' '}
        · Live updates
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
              {destroying ? 'View destroy run' : 'View run'}
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
            <dd>{sizeText}</dd>
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
            <dt>Tags</dt>
            <dd>{desired.tags}</dd>
          </div>
        </dl>
      </div>
    </InfoCard>
  );
}
