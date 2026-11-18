import { ReactNode, Suspense, lazy, useState } from 'react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { InfoCard, Link } from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import { Button, makeStyles } from '@material-ui/core';
import { getVmConfiguration } from './vmSpec';
import {
  osFamily,
  platformLabel,
  usePlatforms,
  useVmSizeText,
} from './vmSizes';
import { RunView, useVmsApi } from './runs';
import { VmRunView } from './RunView';
import { observedLabel, runNoun, vmColors } from './pipeline';
import { deriveVm, useVmLive } from './vmLive';
import { modifyUrl } from './VmActions';

const SSH_CERT = '/create/templates/default/ssh-cert';
// xterm.js loads only when someone opens a terminal.
const VmTerminal = lazy(() =>
  import('./VmTerminal').then(m => ({ default: m.VmTerminal })),
);
// guacamole-common-js loads only when someone opens a remote desktop.
const VmRemoteDesktop = lazy(() =>
  import('./VmRemoteDesktop').then(m => ({ default: m.VmRemoteDesktop })),
);
// Local port for native RDP clients through `ssh -L` (3389 itself is often taken locally).
const RDP_LOCAL_PORT = 33389;

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
  note: { color: vmColors.mute, fontSize: 13.5, margin: '0 0 14px' },
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

/** Windows VMs: the team's shared login, fetched only when asked for (each read is logged). */
function SharedLogin({ name }: { name: string }) {
  const classes = useStyles();
  const api = useVmsApi();
  const [login, setLogin] = useState<{ username: string; password: string }>();
  const [error, setError] = useState<string>();
  if (login)
    return (
      <div>
        <CopyCommand command={login.password} />
        <p className={classes.muted} style={{ marginBottom: 14 }}>
          Password of <span className={classes.mono}>{login.username}</span>,
          shared by your team.{' '}
          <Button
            size="small"
            className={classes.button}
            onClick={() => setLogin(undefined)}
          >
            Hide
          </Button>
        </p>
      </div>
    );
  return (
    <>
      <Button
        variant="outlined"
        className={classes.button}
        style={{ marginRight: 10 }}
        onClick={() =>
          api
            .password(name)
            .then(value => {
              setLogin(value);
              setError(undefined);
            })
            .catch(e => setError((e as Error).message))
        }
      >
        Show Password
      </Button>
      {error && <p className={classes.error}>{error}</p>}
    </>
  );
}

/** A `.rdp` file for a native client connecting through the `ssh -L` forward. */
const rdpFile = (user: string) =>
  `data:application/x-rdp;charset=utf-8,${encodeURIComponent(
    `full address:s:localhost:${RDP_LOCAL_PORT}\r\nusername:s:${user}\r\nprompt for credentials:i:1\r\n`,
  )}`;

/** The VM page body: connect, configuration and activity, with instance details aside. */
export function VmStatusCard() {
  const classes = useStyles();
  const { entity: initial } = useEntity();
  const live = useVmLive(initial.metadata.name);
  const entity = live.entity ?? initial;
  const sizeText = useVmSizeText(entity);
  const desired = getVmConfiguration(entity.spec);
  const platforms = usePlatforms();
  const annotations = entity.metadata.annotations ?? {};
  const vm = deriveVm(entity, live);
  const [terminal, setTerminal] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const windows =
    osFamily(desired.platform, desired.os, platforms) === 'windows';
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
      <InfoCard title="Removed from the Catalog">
        <p className={classes.muted}>
          This VM was destroyed and its inventory record deleted.
        </p>
        <p>
          {vm.latest && (
            <Link to={`/vms/runs/${vm.latest.id}`}>View the Destroy Run</Link>
          )}{' '}
          · <Link to="/catalog">Back to Resources</Link>
        </p>
      </InfoCard>
    );
  }

  let connect: ReactNode;
  if (vm.state === 'destroying')
    connect = <p className={classes.note}>The VM is being destroyed.</p>;
  else if (vm.power === 'stopped')
    connect = (
      <p className={classes.note}>
        The VM is stopped. Start it to connect
        {platforms?.find(item => item.id === desired.platform)?.staticPublicIp
          ? '; it keeps its public IP address.'
          : '; it gets a new public IP address.'}
      </p>
    );
  else if (vm.status === 'missing')
    connect = (
      <p className={classes.note} style={{ color: vmColors.redText }}>
        No instance for this VM was found in{' '}
        {platformLabel(desired.platform, platforms)}. Destroy the VM to remove
        its record.
      </p>
    );
  else if (vm.ip && vm.state !== 'building' && windows)
    connect = (
      <>
        <CopyCommand
          command={`ssh -L ${RDP_LOCAL_PORT}:localhost:3389 ${vm.user}@${vm.ip}`}
        />
        {vm.state === 'ready' && (
          <div style={{ marginBottom: 14 }}>
            <Button
              variant="contained"
              color="primary"
              className={classes.button}
              style={{ marginRight: 10 }}
              onClick={() => setDesktop(true)}
            >
              Open Remote Desktop
            </Button>
            <Button
              variant="outlined"
              className={classes.button}
              style={{ marginRight: 10 }}
              onClick={() => setTerminal(true)}
            >
              Open Terminal
            </Button>
            <SharedLogin name={entity.metadata.name} />
          </div>
        )}
        <p className={classes.note}>
          For your own RDP client, keep the SSH command above running and open{' '}
          <a href={rdpFile(vm.user)} download={`${entity.metadata.name}.rdp`}>
            {entity.metadata.name}.rdp
          </a>{' '}
          (localhost:{RDP_LOCAL_PORT}) with the shared password.
        </p>
      </>
    );
  else if (vm.ip && vm.state !== 'building')
    connect = (
      <>
        <CopyCommand command={`ssh ${vm.user}@${vm.ip}`} />
        {vm.state === 'ready' && (
          <Button
            variant="contained"
            color="primary"
            className={classes.button}
            style={{ marginRight: 10 }}
            onClick={() => setTerminal(true)}
          >
            Open Terminal
          </Button>
        )}
      </>
    );
  else
    connect = (
      <p className={classes.note}>
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
          <Link to={SSH_CERT} className={classes.link}>
            Get SSH Certificate
          </Link>
          {terminal && (
            <Suspense fallback={null}>
              <VmTerminal
                vmRef={stringifyEntityRef(entity)}
                name={entity.metadata.name}
                open={terminal}
                onClose={() => setTerminal(false)}
              />
            </Suspense>
          )}
          {desktop && (
            <Suspense fallback={null}>
              <VmRemoteDesktop
                vmRef={stringifyEntityRef(entity)}
                name={entity.metadata.name}
                open={desktop}
                onClose={() => setDesktop(false)}
              />
            </Suspense>
          )}
          <p className={classes.muted} style={{ marginTop: 10 }}>
            {windows
              ? 'Open the desktop or a PowerShell terminal here'
              : 'Open a terminal here'}
            , or sign your own public key for 12 hours of access as{' '}
            <span className={classes.mono}>{vm.user}</span> to your team's VMs
            from your machine.
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
            <Fact label="AD Join">
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
              <Fact label="First Ready">
                {when(annotations['cf/ready-at'])}
              </Fact>
            )}
            <Fact label="Lifecycle">
              {String(entity.spec?.lifecycle ?? 'unknown')}
            </Fact>
            {source && (
              <Fact label="Inventory">
                <Link to={source}>View Source</Link>
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
