import { useEffect, useState } from 'react';
import * as GuacamoleModule from 'guacamole-common-js';
import {
  Button,
  Dialog,
  DialogActions,
  DialogTitle,
  makeStyles,
} from '@material-ui/core';
import { useVmsApi } from './runs';
import { vmColors } from './pipeline';

// The package's ESM build exports one default object; its types describe the named members.
const Guacamole = ((GuacamoleModule as any).default ??
  GuacamoleModule) as typeof GuacamoleModule;

const useStyles = makeStyles({
  title: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
    flexWrap: 'wrap',
    paddingBottom: 8,
  },
  status: { fontSize: 13, fontWeight: 500 },
  frame: {
    height: '72vh',
    minHeight: 300,
    margin: '0 24px',
    background: vmColors.ink,
    borderRadius: 6,
    overflow: 'hidden',
    position: 'relative',
    outline: 'none',
    '&:focus-visible': { boxShadow: `0 0 0 2px ${vmColors.blue}` },
  },
  screen: { position: 'absolute', top: 0, left: 0 },
  hint: { color: vmColors.mute, fontSize: 12.5, marginRight: 'auto' },
});

// One request carries at most this much input (the backend accepts 512 KiB).
const MAX_INPUT = 256 * 1024;

type Api = ReturnType<typeof useVmsApi>;
type Tunnel = GuacamoleModule.Tunnel & { setState(state: number): void };

/** Guacamole's length-prefixed element: the length counts Unicode code points. */
const element = (value: unknown) => {
  const text = String(value);
  return `${[...text].length}.${text}`;
};

/**
 * A Guacamole tunnel over the IDP's short HTTP requests (no WebSocket or streamed responses,
 * which TLS-inspecting proxies can hold back): output is long-polled and acknowledged by
 * sequence number; input is sent in order, batched while a request is in flight.
 */
function pollingTunnel(api: Api, id: string, end: (reason: string) => void) {
  const tunnel = new (Guacamole.Tunnel as any)() as Tunnel;
  const parser = new Guacamole.Parser();
  parser.oninstruction = (opcode, args) => tunnel.oninstruction?.(opcode, args);
  let open = false;
  let seq = 0;
  let queue = '';
  let sending = false;

  const fail = (reason: string) => {
    if (!open) return;
    open = false;
    tunnel.setState(Guacamole.Tunnel.State.CLOSED);
    end(reason);
  };
  const flush = async () => {
    if (sending || !queue || !open) return;
    sending = true;
    const data = queue.slice(0, MAX_INPUT);
    queue = queue.slice(data.length);
    try {
      await api.rdp.input(id, data);
    } catch (e) {
      fail((e as Error).message);
    } finally {
      sending = false;
    }
    flush();
  };
  const poll = async () => {
    let failures = 0;
    while (open) {
      try {
        const output = await api.rdp.output(id, seq);
        if (!open) return;
        failures = 0;
        if (output.data) parser.receive(output.data);
        seq = output.seq;
        if (output.closed) {
          fail(output.closed);
          return;
        }
      } catch (e) {
        if (!open) return;
        if (++failures >= 4) {
          fail((e as Error).message);
          return;
        }
        const wait = 1000 * failures;
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  };

  tunnel.connect = () => {
    open = true;
    tunnel.setState(Guacamole.Tunnel.State.OPEN);
    poll();
  };
  tunnel.sendMessage = (...elements: unknown[]) => {
    if (!open || !elements.length) return;
    queue += `${elements.map(element).join(',')};`;
    flush();
  };
  tunnel.disconnect = () => {
    if (!open) return;
    open = false;
    tunnel.setState(Guacamole.Tunnel.State.CLOSED);
    api.rdp.close(id).catch(() => {});
  };
  return tunnel;
}

/**
 * A Windows VM's desktop in the browser. The IDP connects guacd to the VM's RDP port through an SSH
 * tunnel (signed in with the team's shared login); this side draws it with guacamole-common-js.
 */
export function VmRemoteDesktop({
  vmRef,
  name,
  open,
  onClose,
}: {
  vmRef: string;
  name: string;
  open: boolean;
  onClose: () => void;
}) {
  const classes = useStyles();
  const api = useVmsApi();
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>(
    'connecting',
  );
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [client, setClient] = useState<GuacamoleModule.Client>();

  useEffect(() => {
    if (!open || !frame) return undefined;
    const container = frame;
    let disposed = false;
    let id: string | undefined;
    let cleanup = () => {};
    setState('connecting');
    setMessage('Connecting…');

    const end = (reason: string) => {
      if (disposed) return;
      setState('closed');
      setMessage(`Disconnected: ${reason}`);
    };

    (async () => {
      try {
        const width = Math.max(640, Math.floor(container.clientWidth));
        const height = Math.max(480, Math.floor(container.clientHeight));
        const session = await api.rdp.open({
          vm: vmRef,
          width,
          height,
          dpi: 96,
          timezone:
            new Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC',
        });
        id = session.id;
        if (disposed) {
          api.rdp.close(session.id).catch(() => {});
          return;
        }
        const guac = new Guacamole.Client(pollingTunnel(api, session.id, end));
        const display = guac.getDisplay();
        const screen = display.getElement();
        screen.className = classes.screen;
        container.appendChild(screen);
        // Fit the remote screen into the frame, never enlarging it.
        const fit = () => {
          const w = display.getWidth();
          const h = display.getHeight();
          if (!w || !h) return;
          display.scale(
            Math.min(1, container.clientWidth / w, container.clientHeight / h),
          );
        };
        display.onresize = fit;
        let resizeTimer: number | undefined;
        const observer = new ResizeObserver(() => {
          fit();
          window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(
            () =>
              guac.sendSize(
                Math.floor(container.clientWidth),
                Math.floor(container.clientHeight),
              ),
            400,
          );
        });
        observer.observe(container);

        const mouse = new Guacamole.Mouse(screen);
        mouse.onEach(['mousedown', 'mousemove', 'mouseup'], event => {
          if (event.type === 'mousedown') container.focus();
          guac.sendMouseState(
            (event as GuacamoleModule.Mouse.Event).state,
            true,
          );
        });
        // Keys go to the VM only while the frame has focus.
        const keyboard = new Guacamole.Keyboard(container);
        keyboard.onkeydown = keysym => {
          guac.sendKeyEvent(1, keysym);
          return false;
        };
        keyboard.onkeyup = keysym => guac.sendKeyEvent(0, keysym);
        // Text copied on the VM lands in the local clipboard (when the browser allows it).
        guac.onclipboard = (stream, mimetype) => {
          if (mimetype !== 'text/plain') return;
          const reader = new Guacamole.StringReader(stream);
          let text = '';
          reader.ontext = chunk => {
            text += chunk;
          };
          reader.onend = () => {
            navigator.clipboard?.writeText(text).catch(() => {});
          };
        };
        guac.onerror = status =>
          end(status.message || 'The remote desktop reported an error');
        guac.onstatechange = clientState => {
          // 5 = DISCONNECTED
          if (clientState === 5) end('the session ended');
        };
        guac.connect();
        container.focus();
        setClient(guac);
        setState('open');
        setMessage(`${session.user} on ${session.host}`);
        cleanup = () => {
          window.clearTimeout(resizeTimer);
          observer.disconnect();
          keyboard.onkeydown = null;
          keyboard.onkeyup = null;
          keyboard.reset();
          guac.disconnect();
          screen.remove();
          setClient(undefined);
        };
      } catch (e) {
        end((e as Error).message);
      }
    })();

    return () => {
      disposed = true;
      cleanup();
      if (id) api.rdp.close(id).catch(() => {});
    };
  }, [api, open, frame, vmRef, attempt, classes.screen]);

  /** Local clipboard text becomes the VM's clipboard, ready to paste there. */
  const sendClipboard = async () => {
    if (!client) return;
    try {
      const text = await navigator.clipboard.readText();
      const writer = new Guacamole.StringWriter(
        client.createClipboardStream('text/plain'),
      );
      writer.sendText(text);
      writer.sendEnd();
      frame?.focus();
    } catch {
      setMessage('The browser did not allow reading the clipboard');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="xl"
      aria-labelledby="vm-rdp-title"
      disableEnforceFocus
    >
      <DialogTitle id="vm-rdp-title" disableTypography>
        <div className={classes.title}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Remote Desktop · {name}</h2>
          <span
            role="status"
            aria-label="Remote desktop status"
            className={classes.status}
            style={{
              color: state === 'closed' ? vmColors.redText : vmColors.mute,
            }}
          >
            {message}
          </span>
        </div>
      </DialogTitle>
      <div
        ref={setFrame}
        className={classes.frame}
        // A remote desktop takes all keyboard and mouse input while focused; it must be focusable.
        role="application"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label="Remote desktop"
      />
      <DialogActions>
        <span className={classes.hint}>
          Signed in with your team's shared login. Click the desktop to type.
          Closes after 30 minutes without input.
        </span>
        {state === 'open' && (
          <Button onClick={sendClipboard}>Send Clipboard to VM</Button>
        )}
        {state === 'closed' && (
          <Button onClick={() => setAttempt(value => value + 1)}>
            Reconnect
          </Button>
        )}
        <Button color="primary" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
