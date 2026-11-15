import { useEffect, useMemo, useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { Link } from '@backstage/core-components';
import { identityApiRef, useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { errorMessage, reportClientEvent } from '../../clientLog';
import {
  PipelineLine,
  STATIONS,
  activeStation,
  VmState,
  getPipelineProcesses,
  getVmConfiguration,
  useVmSizes,
  vmSizeText,
  vmColors,
  vmState,
  vmStateColor,
  vmStateLabel,
} from '@internal/plugin-vm-status';
import { makeStyles } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import VpnKeyOutlined from '@material-ui/icons/VpnKeyOutlined';
import { DemoModePanel } from '../../DemoModePanel';

const REQUEST_VM = '/create/templates/default/vm-request';
const SSH_CERT = '/create/templates/default/ssh-cert';

type Filter = 'all' | 'building' | 'ready' | 'failed' | 'destroying';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'building', label: 'In progress' },
  { id: 'ready', label: 'Ready' },
  { id: 'failed', label: 'Failed' },
  { id: 'destroying', label: 'Destroying' },
];

const useStyles = makeStyles({
  root: {
    padding: '32px 20px 48px',
    '@media (max-width: 760px)': { padding: '24px 16px 40px' },
  },
  head: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 24,
    flexWrap: 'wrap',
  },
  h1: {
    fontSize: 32,
    fontWeight: 700,
    letterSpacing: '-0.025em',
    lineHeight: 1.1,
    margin: 0,
    textWrap: 'balance',
  } as any,
  sub: { color: vmColors.mute, fontSize: 14, marginTop: 8 },
  buttons: { display: 'flex', gap: 10, flexWrap: 'wrap' },
  btn: {
    height: 40,
    padding: '0 16px',
    borderRadius: 6,
    border: '1px solid #E3E5E8',
    background: '#fff',
    color: vmColors.ink,
    fontWeight: 600,
    fontSize: 14,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    textDecoration: 'none',
    transition: 'border-color 160ms ease-out, background 160ms ease-out',
    '& svg': { fontSize: 18 },
    '&:hover': { borderColor: '#C9CDD2', textDecoration: 'none' },
  },
  primary: {
    background: vmColors.blue,
    borderColor: vmColors.blue,
    color: '#fff',
    '&:hover': { background: '#0A4FB0', borderColor: '#0A4FB0' },
  },
  strip: {
    display: 'flex',
    marginTop: 28,
    borderTop: `2px solid ${vmColors.ink}`,
    borderBottom: '1px solid #E3E5E8',
    flexWrap: 'wrap',
  },
  count: {
    appearance: 'none',
    border: 0,
    borderRight: '1px solid #E3E5E8',
    background: 'transparent',
    font: 'inherit',
    color: vmColors.mute,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    padding: '14px 28px 12px',
    borderBottomWidth: 3,
    borderBottomStyle: 'solid',
    borderBottomColor: 'transparent',
    marginBottom: -1,
    whiteSpace: 'nowrap',
    '&:first-child': { paddingLeft: 0 },
    '&:last-child': { borderRight: 0 },
    '& b': {
      fontSize: 26,
      fontWeight: 700,
      letterSpacing: '-0.02em',
      color: vmColors.ink,
    },
    '&:hover': { color: vmColors.ink },
    '@media (max-width: 760px)': {
      padding: '10px 14px 8px',
      gap: 6,
      '& b': { fontSize: 20 },
      '&:first-child': { paddingLeft: 0 },
    },
  },
  countOn: {
    color: vmColors.ink,
    fontWeight: 600,
    borderBottomColor: vmColors.blue,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    display: 'inline-block',
    marginRight: 6,
    verticalAlign: 1,
  },
  live: {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    color: vmColors.mute,
    fontSize: 13,
    margin: '14px 0 10px',
    '& b': { color: vmColors.ink, fontWeight: 600 },
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: vmColors.green,
    boxShadow: '0 0 0 3px rgba(0,147,90,.15)',
  },
  tableWrap: { overflowX: 'auto' },
  table: {
    width: '100%',
    minWidth: 1080,
    borderCollapse: 'collapse',
    '& th': {
      textAlign: 'left',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.07em',
      textTransform: 'uppercase',
      color: vmColors.mute,
      padding: '9px 12px',
      borderBottom: '1px solid #E3E5E8',
      background: '#F3F4F5',
    },
    '& td': {
      padding: '18px 12px',
      borderBottom: '1px solid #E3E5E8',
      verticalAlign: 'middle',
    },
    // Narrow screens: each VM becomes a stacked block, the line spans the width.
    '@media (max-width: 1000px)': {
      minWidth: 0,
      '& thead': { display: 'none' },
      '& tbody, & tr, & td': { display: 'block', width: '100%' },
      '& tr': { padding: '16px 0', borderBottom: '1px solid #E3E5E8' },
      '& td': { padding: '6px 12px', borderBottom: 0 },
      '& td:empty': { display: 'none' },
    },
  },
  failRow: {
    background: '#FEF6F5',
    '& td': { background: '#FEF6F5' },
  },
  vm: { display: 'flex', alignItems: 'center', gap: 14 },
  bullet: {
    width: 34,
    height: 34,
    borderRadius: '50%',
    color: '#fff',
    fontWeight: 800,
    fontSize: 15,
    display: 'grid',
    placeItems: 'center',
    flex: 'none',
  },
  name: {
    whiteSpace: 'nowrap',
    fontSize: 15,
    fontWeight: 600,
    color: vmColors.ink,
    textDecoration: 'none',
    '&:hover': { color: vmColors.blue, textDecoration: 'underline' },
  },
  state: {
    fontSize: 12.5,
    fontWeight: 600,
    marginTop: 2,
    whiteSpace: 'nowrap',
  },
  line: {
    width: 520,
    '@media (max-width: 1000px)': { width: '100%' },
  },
  meta: { fontSize: 13, color: vmColors.mute, '& div + div': { marginTop: 3 } },
  mono: {
    fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
    fontSize: 12.5,
    color: vmColors.ink,
  },
  chip: {
    display: 'inline-block',
    fontSize: 11.5,
    fontWeight: 500,
    background: '#F3F4F5',
    borderRadius: 4,
    padding: '1px 7px',
    color: vmColors.ink,
    marginRight: 4,
  },
  when: { fontSize: 13, color: vmColors.mute, whiteSpace: 'nowrap' },
  act: {
    textAlign: 'right',
    whiteSpace: 'nowrap',
    '@media (max-width: 1000px)': { textAlign: 'left', paddingTop: 10 },
  },
  small: {
    height: 34,
    padding: '0 12px',
    fontSize: 13,
  },
  danger: {
    background: vmColors.red,
    borderColor: vmColors.red,
    color: '#fff',
    '&:hover': { background: vmColors.redText, borderColor: vmColors.redText },
  },
  empty: {
    padding: '56px 0',
    textAlign: 'center',
    color: vmColors.mute,
    '& h2': {
      color: vmColors.ink,
      fontSize: 18,
      fontWeight: 700,
      margin: '0 0 6px',
    },
    '& p': { margin: '0 0 20px' },
  },
  error: { color: vmColors.redText, fontSize: 14, padding: '24px 0' },
});

function greeting(now: Date) {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function ago(iso: string | undefined, now: Date): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function teamsLabel(refs: string[]) {
  const teams = refs
    .filter(ref => ref.startsWith('group:'))
    .map(ref => ref.split('/').pop()!)
    .filter(team => team !== 'platform-admins');
  if (!teams.length) return undefined;
  const names = teams.map(t => t[0].toUpperCase() + t.slice(1));
  return `Team ${names.join(', ')}`;
}

type Row = {
  entity: Entity;
  state: VmState;
};

function VmRow({ entity, state, now }: Row & { now: Date }) {
  const classes = useStyles();
  const annotations = entity.metadata.annotations ?? {};
  const status = annotations['cf/status'];
  const processes = getPipelineProcesses(annotations);
  const desired = getVmConfiguration(entity.spec);
  const sizeText = vmSizeText(entity, desired.size, useVmSizes());
  const color = vmStateColor(state);
  const ip = annotations['cf/public-ip'];
  const user = annotations['cf/ssh-user'] || 'ubuntu';
  const runUrl = annotations['cf/run-url'];
  const namespace = entity.metadata.namespace ?? 'default';
  const name = entity.metadata.name;
  const active = activeStation(processes);
  const requested = ago(annotations['cf/requested-at'], now);
  const os = desired.os === 'ubuntu' ? 'Ubuntu' : desired.os;

  let action = null;
  if (state === 'ready') {
    action = (
      <Link to={SSH_CERT} className={`${classes.btn} ${classes.small}`}>
        Get SSH certificate
      </Link>
    );
  } else if (runUrl && (state === 'failed' || state === 'building')) {
    action = (
      <a
        href={runUrl}
        target="_blank"
        rel="noreferrer"
        className={`${classes.btn} ${classes.small} ${
          state === 'failed' ? classes.danger : ''
        }`}
      >
        View run
      </a>
    );
  }

  return (
    <tr className={state === 'failed' ? classes.failRow : undefined}>
      <td>
        <div className={classes.vm}>
          <span
            className={classes.bullet}
            style={{ background: color }}
            title={sizeText}
          >
            {desired.size === '—' ? '?' : desired.size.slice(0, 1)}
          </span>
          <div>
            <Link
              to={`/catalog/${namespace}/resource/${name}`}
              className={classes.name}
              style={state === 'destroying' ? { color: vmColors.mute } : {}}
            >
              {entity.metadata.title ?? name}
            </Link>
            <div
              className={classes.state}
              style={{
                color: state === 'failed' ? vmColors.redText : color,
              }}
            >
              <i className={classes.dot} style={{ background: color }} />
              {vmStateLabel(status, processes)}
            </div>
          </div>
        </div>
      </td>
      <td>
        <div className={classes.line}>
          <PipelineLine
            processes={processes}
            retired={state === 'destroying'}
          />
        </div>
      </td>
      <td className={classes.meta}>
        {state === 'ready' && ip ? (
          <div>
            {os} ·{' '}
            <span className={classes.mono}>
              ssh {user}@{ip}
            </span>
          </div>
        ) : (
          <div>
            {os} · {sizeText}
          </div>
        )}
        {active && (state === 'building' || state === 'failed') && (
          <div
            style={
              active.status === 'failed'
                ? { color: vmColors.redText, fontWeight: 600 }
                : { color: vmColors.ink }
            }
          >
            {active.status === 'failed'
              ? `${active.label} stage failed`
              : `${active.label} running`}{' '}
            · stage {active.index + 1} of {STATIONS.length}
          </div>
        )}
        {desired.software !== 'none' && (
          <div>
            {desired.software.split(', ').map(s => (
              <span key={s} className={classes.chip}>
                {s}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className={classes.when}>
        {requested ? `Requested ${requested}` : '—'}
      </td>
      <td className={classes.act}>{action}</td>
    </tr>
  );
}

export function HomePage() {
  const classes = useStyles();
  const catalog = useApi(catalogApiRef);
  const identity = useApi(identityApiRef);
  const [vms, setVms] = useState<Entity[]>();
  const [error, setError] = useState<string>();
  const [refreshed, setRefreshed] = useState<Date>();
  const [now, setNow] = useState(() => new Date());
  const [filter, setFilter] = useState<Filter>('all');
  const [who, setWho] = useState<{ name?: string; team?: string }>({});

  useEffect(() => {
    let mounted = true;
    Promise.all([identity.getProfileInfo(), identity.getBackstageIdentity()])
      .then(([profile, user]) => {
        if (!mounted) return;
        setWho({
          name: profile.displayName ?? user.userEntityRef.split('/').pop(),
          team: teamsLabel(user.ownershipEntityRefs),
        });
      })
      .catch(e =>
        reportClientEvent({
          kind: 'identity-load-failed',
          message: errorMessage(e),
          detail: 'home page',
        }),
      );
    return () => {
      mounted = false;
    };
  }, [identity]);

  useEffect(() => {
    let disposed = false;
    let fetching = false;
    const load = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const res = await catalog.getEntities({
          filter: { kind: 'resource', 'spec.type': 'vm' },
        });
        if (disposed) return;
        setVms(res.items);
        setError(undefined);
        setRefreshed(new Date());
      } catch (e) {
        if (!disposed)
          setError(
            `Could not load your team's machines: ${
              (e as Error).message
            }. Retrying every 10 seconds.`,
          );
      } finally {
        fetching = false;
        if (!disposed) setNow(new Date());
      }
    };
    load();
    const timer = window.setInterval(load, 10000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [catalog]);

  const rows: Row[] = useMemo(() => {
    const rank: Record<VmState, number> = {
      failed: 0,
      building: 1,
      ready: 2,
      other: 3,
      destroying: 4,
    };
    return (vms ?? [])
      .map(entity => ({
        entity,
        state: vmState(entity.metadata.annotations?.['cf/status']),
      }))
      .sort(
        (a, b) =>
          rank[a.state] - rank[b.state] ||
          a.entity.metadata.name.localeCompare(b.entity.metadata.name),
      );
  }, [vms]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      all: rows.length,
      building: 0,
      ready: 0,
      failed: 0,
      destroying: 0,
    };
    rows.forEach(r => {
      if (r.state in c) c[r.state as Filter] += 1;
    });
    return c;
  }, [rows]);

  const shown = filter === 'all' ? rows : rows.filter(r => r.state === filter);
  const dotColor: Record<Filter, string | undefined> = {
    all: undefined,
    building: vmColors.blue,
    ready: vmColors.green,
    failed: vmColors.red,
    destroying: vmColors.grey,
  };

  return (
    <div className={classes.root}>
      <div className={classes.head}>
        <div>
          <h1 className={classes.h1}>
            {greeting(now)}
            {who.name ? `, ${who.name}` : ''}
          </h1>
          <div className={classes.sub}>
            {[
              who.team,
              vms
                ? `${rows.length} virtual machine${
                    rows.length === 1 ? '' : 's'
                  }`
                : undefined,
            ]
              .filter(Boolean)
              .join(' · ') || '\u00a0'}
          </div>
        </div>
        <div className={classes.buttons}>
          <Link to={SSH_CERT} className={classes.btn}>
            <VpnKeyOutlined />
            Get SSH certificate
          </Link>
          <Link to={REQUEST_VM} className={`${classes.btn} ${classes.primary}`}>
            <AddIcon />
            Request VM
          </Link>
        </div>
      </div>

      <DemoModePanel />

      <div className={classes.strip} role="tablist" aria-label="Filter VMs">
        {FILTERS.map(f => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={`${classes.count} ${
              filter === f.id ? classes.countOn : ''
            }`}
            onClick={() => setFilter(f.id)}
          >
            <b>{vms ? counts[f.id] : '–'}</b>
            <span>
              {dotColor[f.id] && (
                <i
                  className={classes.dot}
                  style={{ background: dotColor[f.id] }}
                />
              )}
              {f.label}
            </span>
          </button>
        ))}
      </div>

      <div className={classes.live} aria-live="polite">
        <span className={classes.liveDot} />
        Updates about every 10 seconds
        {refreshed && (
          <>
            {' · last refreshed '}
            <b>{refreshed.toLocaleTimeString()}</b>
          </>
        )}
      </div>

      {error && <div className={classes.error}>{error}</div>}

      {!vms && !error && (
        <div className={classes.empty}>Loading your team's machines…</div>
      )}

      {vms && rows.length === 0 && (
        <div className={classes.empty}>
          <h2>No virtual machines yet</h2>
          <p>
            Request one and watch it travel the line from Validate to Finalize.
          </p>
          <Link to={REQUEST_VM} className={`${classes.btn} ${classes.primary}`}>
            <AddIcon />
            Request VM
          </Link>
        </div>
      )}

      {vms && rows.length > 0 && shown.length === 0 && (
        <div className={classes.empty}>
          <h2>Nothing here right now</h2>
          <p>No machines match this filter.</p>
          <button
            type="button"
            className={classes.btn}
            onClick={() => setFilter('all')}
          >
            Show all machines
          </button>
        </div>
      )}

      {shown.length > 0 && (
        <div className={classes.tableWrap}>
          <table className={classes.table}>
            <thead>
              <tr>
                <th style={{ width: 260 }}>Machine</th>
                <th style={{ width: 560 }}>Pipeline · baked image, then fry</th>
                <th>Details</th>
                <th style={{ width: 150 }}>Requested</th>
                <th style={{ width: 170 }}>
                  <span style={{ position: 'absolute', left: -9999 }}>
                    Next action
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map(row => (
                <VmRow
                  key={row.entity.metadata.uid ?? row.entity.metadata.name}
                  {...row}
                  now={now}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
