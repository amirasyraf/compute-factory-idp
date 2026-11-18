import { ReactNode, useState } from 'react';
import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import { Link } from '@backstage/core-components';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  makeStyles,
} from '@material-ui/core';
import MoreHorizIcon from '@material-ui/icons/MoreHoriz';
import { useNavigate } from 'react-router-dom';
import { VmOperation, useVmsApi } from './runs';
import { vmColors } from './pipeline';
import { deriveVm } from './vmLive';
import { platformLabel, usePlatforms } from './vmSizes';

const useStyles = makeStyles({
  bar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  button: {
    textTransform: 'none',
    fontWeight: 600,
    height: 36,
    borderRadius: 6,
  },
  // A navigation link that looks like the outlined buttons beside it.
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 36,
    padding: '0 15px',
    borderRadius: 6,
    border: '1px solid rgba(0, 0, 0, 0.23)',
    color: vmColors.ink,
    fontWeight: 600,
    fontSize: 14,
    textDecoration: 'none',
    '&:hover': { background: 'rgba(0, 0, 0, 0.04)', textDecoration: 'none' },
  },
  danger: { color: vmColors.redText },
  error: { color: vmColors.redText, fontSize: 13, marginTop: 12 },
  body: { fontSize: 14, lineHeight: 1.55, '& p': { margin: '0 0 10px' } },
});

type Confirm = {
  operation: VmOperation;
  title: string;
  body: ReactNode;
  confirm: string;
  danger?: boolean;
  /** Ask the user to type the VM name (destroy). */
  typed?: boolean;
};

/** Modify opens the form prefilled with the VM's current desired configuration. */
export function modifyUrl(entity: Entity) {
  const spec = (entity.spec ?? {}) as Record<string, any>;
  const configuration = spec.configuration ?? {};
  const formData = {
    vm: stringifyEntityRef(entity),
    compute: spec.compute,
    configuration: {
      software: Array.isArray(configuration.software)
        ? configuration.software
        : [],
      adJoin: configuration.adJoin === true,
    },
  };
  return `/create/templates/default/vm-modify?formData=${encodeURIComponent(
    JSON.stringify(formData),
  )}`;
}

/** Day-2 actions for one VM: power, Modify, OS updates, re-apply and destroy. */
export function VmActions({
  entity,
  vm,
  onStarted,
}: {
  entity: Entity;
  vm: ReturnType<typeof deriveVm>;
  onStarted: () => void;
}) {
  const classes = useStyles();
  const api = useVmsApi();
  const navigate = useNavigate();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [confirm, setConfirm] = useState<Confirm>();
  const [requestKey, setRequestKey] = useState('');
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const name = entity.metadata.name;
  const platforms = usePlatforms();
  const platform = (entity.spec as any)?.compute?.platform;
  // Unknown platform info: describe the stricter case (a new address).
  const staticIp = Boolean(
    platforms?.find(item => item.id === platform)?.staticPublicIp,
  );

  if (vm.state === 'destroying') return null;
  const locked = vm.busy || vm.incomplete || vm.status === 'missing';
  const stopped = vm.power === 'stopped';
  // Unknown power state: offer what a ready VM normally allows; the backend re-checks.
  const running = vm.power === undefined || vm.power === 'running';
  const needsRunning = stopped ? 'Start the VM first' : undefined;
  let reason: string | undefined;
  if (vm.busy) reason = 'A run is in progress';
  else if (vm.incomplete) reason = 'Finish or destroy the build first';
  else if (vm.status === 'missing')
    reason = `No instance found in ${platformLabel(platform, platforms)}`;

  const open = (next: Confirm) => {
    setMenu(null);
    setError(undefined);
    setTyped('');
    // One key per dialog: a double submit returns the same run.
    setRequestKey(window.crypto.randomUUID());
    setConfirm(next);
  };
  async function submit() {
    if (!confirm) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await api.operate({
        operation: confirm.operation,
        vm: stringifyEntityRef(entity),
        requestKey,
      });
      setConfirm(undefined);
      onStarted();
      if (confirm.operation === 'destroy')
        navigate(`/vms/runs/${result.runId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  const action = (
    label: string,
    onClick: () => void,
    disabledReason?: string,
    primary = false,
  ) => (
    <Tooltip title={disabledReason ?? ''}>
      <span>
        <Button
          variant={primary ? 'contained' : 'outlined'}
          color={primary ? 'primary' : 'default'}
          className={classes.button}
          disabled={Boolean(disabledReason)}
          onClick={onClick}
        >
          {label}
        </Button>
      </span>
    </Tooltip>
  );

  return (
    <div className={classes.bar} role="group" aria-label="VM actions">
      {stopped
        ? action(
            'Start',
            () =>
              open({
                operation: 'start',
                title: `Start ${name}?`,
                body: (
                  <p>
                    {staticIp
                      ? 'The VM starts with its usual public IP address.'
                      : 'The VM starts with a new public IP address. Connect with the new address shown on this page.'}
                  </p>
                ),
                confirm: 'Start VM',
              }),
            reason,
            true,
          )
        : action(
            'Stop',
            () =>
              open({
                operation: 'stop',
                title: `Stop ${name}?`,
                body: (
                  <>
                    <p>
                      {staticIp
                        ? 'The VM shuts down and is deallocated, so its compute is no longer billed. Its disk and public IP address are kept.'
                        : 'The VM shuts down. Its disk is kept, but its public IP address is released: starting it again gives it a new one.'}
                    </p>
                    <p>Open SSH sessions are disconnected.</p>
                  </>
                ),
                confirm: 'Stop VM',
              }),
            reason ?? (running ? undefined : `The VM is ${vm.power}`),
          )}
      {action(
        'Reboot',
        () =>
          open({
            operation: 'reboot',
            title: `Reboot ${name}?`,
            body: (
              <p>
                The VM restarts and keeps its public IP address. Open SSH
                sessions are disconnected.
              </p>
            ),
            confirm: 'Reboot VM',
          }),
        reason ?? needsRunning,
      )}
      {locked || stopped ? (
        action('Modify', () => {}, reason ?? needsRunning)
      ) : (
        <Link to={modifyUrl(entity)} className={classes.link}>
          Modify
        </Link>
      )}
      <IconButton
        aria-label="More actions"
        aria-haspopup="menu"
        onClick={event => setMenu(event.currentTarget)}
        size="small"
      >
        <MoreHorizIcon />
      </IconButton>
      <Menu
        anchorEl={menu}
        open={Boolean(menu)}
        onClose={() => setMenu(null)}
        getContentAnchorEl={null}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          disabled={Boolean(reason ?? needsRunning)}
          onClick={() =>
            open({
              operation: 'update',
              title: `Apply OS updates to ${name}?`,
              body: (
                <p>
                  Installs all available Ubuntu package updates. If an update
                  needs it, the VM reboots and open SSH sessions are
                  disconnected.
                </p>
              ),
              confirm: 'Apply updates',
            })
          }
        >
          <ListItemText
            primary="Apply OS updates"
            secondary={reason ?? needsRunning}
          />
        </MenuItem>
        <MenuItem
          disabled={Boolean(reason ?? needsRunning)}
          onClick={() =>
            open({
              operation: 'reapply',
              title: `Re-apply configuration to ${name}?`,
              body: (
                <p>
                  Runs baseline, software, AD join and access again against the
                  VM's current configuration. Use it to repair manual changes on
                  the VM. Nothing in the configuration changes.
                </p>
              ),
              confirm: 'Re-apply',
            })
          }
        >
          <ListItemText
            primary="Re-apply configuration"
            secondary={reason ?? needsRunning}
          />
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() =>
            open({
              operation: 'destroy',
              title: `Destroy ${name}?`,
              body: (
                <p>
                  The instance, its disk and its inventory record are deleted.
                  This cannot be undone.
                </p>
              ),
              confirm: 'Destroy VM',
              danger: true,
              typed: true,
            })
          }
        >
          <ListItemText
            primary={<span className={classes.danger}>Destroy VM</span>}
          />
        </MenuItem>
      </Menu>
      <Dialog
        open={Boolean(confirm)}
        onClose={() => !pending && setConfirm(undefined)}
        aria-labelledby="vm-action-title"
        maxWidth="xs"
        fullWidth
      >
        {confirm && (
          <>
            <DialogTitle id="vm-action-title">{confirm.title}</DialogTitle>
            <DialogContent className={classes.body}>
              {confirm.body}
              {confirm.typed && (
                <TextField
                  id="vm-action-confirm-name"
                  fullWidth
                  size="small"
                  variant="outlined"
                  label={`Type ${name} to confirm`}
                  value={typed}
                  onChange={event => setTyped(event.target.value)}
                />
              )}
              {error && (
                <div role="alert" className={classes.error}>
                  {error}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirm(undefined)} disabled={pending}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={pending || (confirm.typed && typed !== name)}
                className={confirm.danger ? classes.danger : undefined}
                color={confirm.danger ? 'default' : 'primary'}
              >
                {pending ? 'Starting…' : confirm.confirm}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </div>
  );
}
