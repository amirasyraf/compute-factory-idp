import { ReactNode, useState } from 'react';
import { InfoCard, Link } from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import { Button, makeStyles } from '@material-ui/core';
import { getVmConfiguration } from './vmSpec';
import { useVmSizeText } from './vmSizes';
import { RunView } from './runs';
import { VmRunView } from './RunView';
import { observedLabel, runNoun, vmColors } from './pipeline';
import { deriveVm, useVmLive } from './vmLive';
import { modifyUrl } from './VmActions';

const SSH_CERT = '/create/templates/default/ssh-cert';

const useStyles = makeStyles(theme => ({
  grid: {
    display: 'grid',
    gap: 24,
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 1100px)': {
      gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
      alignItems: 'start',
    },
  },
  column: { display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 },
  muted: { color: vmColors.mute, fontSize: 13.5, margin: 0 },
  error: { color: vmColors.redText, fontSize: 13, margin: '8px 0 0' },
  list: {
    margin: 0,
    '& > div': {
      display: 'grid',
      gridTemplateColumns: '110px minmax(0, 1fr)',
      gap: 12,
      padding: '7px 0',
      borderTop: `1px solid ${theme.palette.divider}`,
    },
    '& > div:first-child': { borderTop: 0, paddingTop: 0 },
    '& dt': { fontSize: 12.5, color: vmColors.mute },
    '& dd': { margin: 0, fontSize: 13.5, overflowWrap: 'anywhere' },
  },
  command: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 14,
  },
  code: {
    fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
    fontSize: 14,
    background: '#F3F4F5',
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 6,
    padding: '7px 12px',
    overflowWrap: 'anywhere',
  },
  mono: {
    fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
    fontSize: 12.5,
  },
  button: { textTransform: 'none', fontWeight: 600, borderRadius: 6 },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 36,
    padding: '0 16px',
    borderRadius: 6,
    border: `1px solid ${vmColors.blue}`,
    color: vmColors.blue,
    fontWeight: 600,
    fontSize: 14,
    textDecoration: 'none',
    '&:hover': { textDecoration: 'none', background: 'rgba(11,95,211,.06)' },
  },
  primary: {
    background: vmColors.blue,
    color: '#fff',
    '&:hover': { background: '#0A4FB0' },
  },
  action: {
    fontSize: 14,
    fontWeight: 600,
    marginTop: 8,
    display: 'inline-block',
  },
  chip: {
    display: 'inline-block',
    padding: '1px 8px',
    marginRight: 6,
    borderRadius: 4,
    background: '#F3F4F5',
    fontSize: 13,
  },
  history: { listStyle: 'none', margin: 0, padding: 0 },
  historyRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: 12,
    alignItems: 'baseline',
    padding: '9px 0',
    borderTop: `1px solid ${theme.palette.divider}`,
    fontSize: 13.5,
    '&:first-child': { borderTop: 0 },
  },
  historyMeta: { color: vmColors.mute, fontSize: 12.5 },
  current: { marginBottom: 16 },
  heading: { fontSize: 13, fontWeight: 700, margin: '0 0 6px' },
}));

const when = (iso?: string | null) => {
  if (!iso || !Number.isFinite(Date.parse(iso))) return undefined;
  const date = new Date(iso);
  return (
    <time dateTime={iso} title={date.toLocaleString()}>
      {date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}
    </time>
  );
};

const RUN_STATUS: Record<RunView['status'], string> = {
  running: 'In progress',
  failed: 'Failed',
  succeeded: 'Completed',
  cancelled: 'Cancelled',
};
const RUN_COLOR: Record<RunView['status'], string> = {
  running: vmColors.blue,
  failed: vmColors.redText,
  succeeded: vmColors.green,
  cancelled: vmColors.mute,
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const classes = useStyles();
  const [copied, setCopied] = useState(false);
  return (
    <div className={classes.command}>
      <code className={classes.code}>{command}</code>
      <Button
        size="small"
        className={classes.button}
        onClick={() =>
          navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/** The VM page body: connect, configuration and activity, with instance details aside. */
export function VmStatusCard() {
  const classes = useStyles();
  const { entity: initial } = useEntity();
  const live = useVmLive(initial.metadata.name);
  const entity = live.entity ?? initial;
  const sizeText = useVmSizeText(entity);
  const desired = getVmConfiguration(entity.spec);
  const annotations = entity.metadata.annotations ?? {};
  const vm = deriveVm(entity, live);
  const runs = live.runs ?? [];
  const current =
    vm.latest &&
    (vm.latest.status === 'running' || vm.latest.status === 'failed')
      ? vm.latest
      : undefined;
  const location = annotations['backstage.io/managed-by-origin-location'] ?? '';
  const source =
    annotations['backstage.io/view-url'] ??
    (location.startsWith('url:') ? location.slice(4) : undefined);

  if (live.removed) {
    return (
      <InfoCard title="Removed from the catalog">
        <p className={classes.muted}>
          This VM was destroyed and its inventory record deleted.
        </p>
        <p>
          {vm.latest && (
            <Link to={`/vms/runs/${vm.latest.id}`}>View the destroy run</Link>
          )}{' '}
          · <Link to="/catalog">Back to Resources</Link>
        </p>
      </InfoCard>
    );
  }

  let connect: ReactNode;
  if (vm.state === 'destroying')
    connect = <p className={classes.muted}>The VM is being destroyed.</p>;
  else if (vm.power === 'stopped')
    connect = (
      <p className={classes.muted}>
        The VM is stopped. Start it to connect; it gets a new public IP address.
      </p>
    );
  else if (vm.status === 'missing')
    connect = (
      <p className={classes.error}>
        No instance for this VM was found in AWS. Destroy the VM to remove its
        record.
      </p>
    );
  else if (vm.ip && vm.state !== 'building')
    connect = <CopyCommand command={`ssh ${vm.user}@${vm.ip}`} />;
  else
    connect = (
      <p className={classes.muted}>
        The address appears here when the VM is ready.
      </p>
    );

  const health = live.observed;
  let healthText: ReactNode = 'Not available in this environment';
  if (live.observedError) healthText = `Unavailable: ${live.observedError}`;
  else if (health?.enabled && !health.checkedAt) healthText = 'Checking…';
  else if (health?.checkedAt)
    healthText = (
      <>
        {observedLabel(vm.observed ?? null)}
        {vm.observed?.health === 'initializing' && ' · status checks starting'}
        <div className={classes.historyMeta}>
          Checked {when(health.checkedAt)}
          {health.error && ` · last check failed: ${health.error}`}
        </div>
      </>
    );

  return (
    <div className={classes.grid}>
      <div className={classes.column}>
        <InfoCard title="Connect">
          {connect}
          <Link
            to={SSH_CERT}
            className={`${classes.link} ${
              vm.state === 'ready' ? classes.primary : ''
            }`}
          >
            Get SSH certificate
          </Link>
          <p className={classes.muted} style={{ marginTop: 10 }}>
            Sign your public key for 12 hours of access as{' '}
            <span className={classes.mono}>{vm.user}</span> to your team's VMs.
          </p>
        </InfoCard>

        <InfoCard
          title="Activity"
          subheader={
            live.runsError ? (
              <span className={classes.error}>
                Run updates unavailable: {live.runsError}
              </span>
            ) : undefined
          }
        >
          {current && (
            <div className={classes.current}>
              <VmRunView
                initialRun={current}
                poll={false}
                compact
                onRunChange={live.refresh}
              />
            </div>
          )}
          {runs.length > 0 ? (
            <>
              {current && <h3 className={classes.heading}>History</h3>}
              <ol className={classes.history} aria-label="Recent runs">
                {runs.map(run => (
                  <li key={run.id} className={classes.historyRow}>
                    <div>
                      <Link to={`/vms/runs/${run.id}`}>
                        <b>{runNoun(run)}</b>
                      </Link>{' '}
                      <span style={{ color: RUN_COLOR[run.status] }}>
                        · {RUN_STATUS[run.status]}
                      </span>
                      <div className={classes.historyMeta}>
                        Run #{run.id} · {run.requestedBy.split('/').pop()}
                        {run.error && run.status !== 'succeeded'
                          ? ` · ${run.error}`
                          : ''}
                      </div>
                    </div>
                    <span className={classes.historyMeta}>
                      {when(run.createdAt)}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className={classes.muted}>
              {live.runs ? 'No runs recorded for this VM.' : 'Loading runs…'}
            </p>
          )}
        </InfoCard>
      </div>

      <div className={classes.column}>
        <InfoCard
          title="Configuration"
          action={
            !vm.busy &&
            !vm.incomplete &&
            vm.state === 'ready' &&
            vm.power !== 'stopped' ? (
              <Link to={modifyUrl(entity)} className={classes.action}>
                Modify
              </Link>
            ) : undefined
          }
        >
          <dl className={classes.list}>
            <Fact label="Size">{sizeText}</Fact>
            <Fact label="Software">
              {desired.software === 'none'
                ? 'None'
                : desired.software.split(', ').map(item => (
                    <span key={item} className={classes.chip}>
                      {item}
                    </span>
                  ))}
            </Fact>
            <Fact label="AD join">
              {desired.adJoin === 'Requested (mock)'
                ? 'Joined (mock)'
                : 'Not joined'}
            </Fact>
            <Fact label="Tags">{desired.tags}</Fact>
          </dl>
        </InfoCard>

        <InfoCard title="Details">
          <dl className={classes.list}>
            <Fact label="State">{healthText}</Fact>
            <Fact label="Instance">
              <span className={classes.mono}>
                {vm.observed?.instanceId ||
                  annotations['cf/instance-id'] ||
                  'Not launched yet'}
              </span>
            </Fact>
            <Fact label="Public IP">{vm.ip || 'None'}</Fact>
            <Fact label="Requested">
              {annotations['cf/requested-by'] ?? 'unknown'}
              {annotations['cf/requested-at'] && (
                <> · {when(annotations['cf/requested-at'])}</>
              )}
            </Fact>
            {annotations['cf/ready-at'] && (
              <Fact label="First ready">
                {when(annotations['cf/ready-at'])}
              </Fact>
            )}
            <Fact label="Lifecycle">
              {String(entity.spec?.lifecycle ?? 'unknown')}
            </Fact>
            {source && (
              <Fact label="Inventory">
                <Link to={source}>View source</Link>
              </Fact>
            )}
          </dl>
          {live.entityError && (
            <p className={classes.error}>
              Catalog refresh failed ({live.entityError}); retrying.
            </p>
          )}
        </InfoCard>
      </div>
    </div>
  );
}
