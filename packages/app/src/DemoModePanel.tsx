import { useCallback, useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Switch,
  makeStyles,
} from '@material-ui/core';

type DemoState = {
  enabled: boolean;
  generation: string;
  isAdmin: boolean;
  automationAvailable: boolean;
  ownedCount: number;
  lastScan: number | null;
  error: string | null;
  vms: {
    name: string;
    requestedBy: string;
    status: string;
    expiresAt: number | null;
    cleanupReason: string | null;
    error: string | null;
    runUrl: string | null;
  }[];
};
const useStyles = makeStyles({
  root: {
    marginTop: 24,
    padding: '14px 16px',
    border: '1px solid #E3E5E8',
    borderRadius: 8,
    fontSize: 13,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
  },
  title: { fontSize: 14, fontWeight: 700 },
  muted: { color: '#5D636B', marginTop: 4 },
  error: { color: '#C2321F', marginTop: 8 },
  list: {
    paddingLeft: 20,
    marginBottom: 0,
    '& li': { marginTop: 6, overflowWrap: 'anywhere' },
  },
});

function modeLabel(state?: DemoState) {
  if (!state) return 'Loading';
  return state.enabled ? 'On' : 'Off';
}

function deadlineLabel(vm: DemoState['vms'][number], now: number) {
  if (vm.cleanupReason) return `Cleanup queued: ${vm.cleanupReason}`;
  if (vm.expiresAt === null) return 'Timer starts after readiness';
  const seconds = Math.max(0, Math.ceil((vm.expiresAt - now) / 1000));
  if (!seconds) return 'Cleanup due';
  return `Expires in ${Math.floor(seconds / 60)}:${String(
    seconds % 60,
  ).padStart(2, '0')}`;
}

export function DemoModePanel() {
  const classes = useStyles();
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [state, setState] = useState<DemoState>();
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const base = await discovery.getBaseUrl('vms');
      const response = await fetchApi.fetch(`${base}/demo/state`, { signal });
      if (!response.ok)
        throw new Error(`Demo settings HTTP ${response.status}`);
      const data = await response.json();
      if (typeof data.enabled !== 'boolean' || !Array.isArray(data.vms))
        throw new Error('Demo settings unavailable');
      if (!signal?.aborted) {
        setState(data);
        setError(undefined);
      }
    },
    [discovery, fetchApi],
  );
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      load(controller.signal).catch(e => {
        if (!controller.signal.aborted) setError(e.message);
      });
    refresh();
    const poll = window.setInterval(refresh, 15000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      controller.abort();
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [load]);

  async function toggle() {
    if (!state || confirm === undefined) return;
    setBusy(true);
    try {
      const base = await discovery.getBaseUrl('vms');
      const response = await fetchApi.fetch(`${base}/demo/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: confirm,
          generation: state.generation,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? `Demo settings HTTP ${response.status}`);
      setConfirm(undefined);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={classes.root} aria-label="Demo Mode">
      <div className={classes.header}>
        <div>
          <div className={classes.title}>Demo Mode · {modeLabel(state)}</div>
          <div className={classes.muted}>
            {state?.enabled
              ? `Your VMs: ${state.ownedCount}/3 · Automatic cleanup 5 minutes after readiness (or terminal failure).`
              : 'When enabled: 3 VMs per account, with a 5-minute lifetime after readiness.'}
          </div>
        </div>
        {state?.isAdmin && (
          <FormControlLabel
            label="Enable Demo Mode"
            control={
              <Switch
                checked={state.enabled}
                disabled={busy}
                color="primary"
                onChange={(_, enabled) => setConfirm(enabled)}
              />
            }
          />
        )}
      </div>
      {state?.enabled && (
        <div className={classes.muted}>
          Cleanup is triggered at expiry; Actions queues and Terraform add time
          before termination.
        </div>
      )}
      {state && !state.automationAvailable && (
        <div className={classes.muted}>
          VM automation is disabled in this environment. No VMs will be launched
          or automatically destroyed.
        </div>
      )}
      {(error || state?.error) && (
        <div className={classes.error} role="alert">
          {error ?? state?.error}
        </div>
      )}
      {state?.enabled && !state.lastScan && (
        <div className={classes.muted}>
          Waiting for the inventory scan. Deadlines are preserved across
          restarts.
        </div>
      )}
      {state &&
        (state.enabled || state.vms.some(vm => vm.error)) &&
        state.vms.length > 0 && (
          <ul className={classes.list}>
            {state.vms.map(vm => {
              return (
                <li key={vm.name}>
                  <b>{vm.name}</b>
                  {state.isAdmin ? ` · ${vm.requestedBy}` : ''} · {vm.status} ·{' '}
                  {deadlineLabel(vm, now)}
                  {vm.runUrl && (
                    <>
                      {' '}
                      ·{' '}
                      <a href={vm.runUrl} target="_blank" rel="noreferrer">
                        Cleanup Run
                      </a>
                    </>
                  )}
                  {vm.error && (
                    <span className={classes.error}> · {vm.error}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      <Dialog
        open={confirm !== undefined}
        onClose={() => {
          if (!busy) setConfirm(undefined);
        }}
        aria-labelledby="demo-confirm-title"
      >
        <DialogTitle id="demo-confirm-title">
          {confirm ? 'Enable Demo Mode?' : 'Disable Demo Mode?'}
        </DialogTitle>
        <DialogContent>
          {confirm
            ? 'This applies to every account, including admins. Oldest excess VMs will be destroyed, leaving the newest three per account. Existing ready or failed VMs get five minutes from now; other VMs get five minutes after readiness or terminal failure. VM data will be permanently deleted.'
            : 'Stop quota enforcement and future automatic cleanup. Destruction that has already started cannot be undone. Re-enabling starts fresh five-minute timers for existing ready or failed VMs.'}
          {error && (
            <p className={classes.error} role="alert">
              {error}
            </p>
          )}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setConfirm(undefined)}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            color="primary"
            variant="contained"
            onClick={toggle}
          >
            {busy && 'Saving…'}
            {!busy && (confirm ? 'Enable and Apply Limits' : 'Disable')}
          </Button>
        </DialogActions>
      </Dialog>
    </section>
  );
}
