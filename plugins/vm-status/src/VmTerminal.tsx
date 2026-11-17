import { useEffect, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  Button,
  Dialog,
  DialogActions,
  DialogTitle,
  makeStyles,
} from '@material-ui/core';
import { useVmsApi } from './runs';
import { vmColors } from './pipeline';

const useStyles = makeStyles({
  title: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
    flexWrap: 'wrap',
    paddingBottom: 8,
  },
  status: { fontSize: 13, fontWeight: 500 },
  // Padding lives on the frame; the fit addon measures the unpadded screen inside it.
  frame: {
    height: '62vh',
    minHeight: 260,
    margin: '0 24px',
    padding: 8,
    boxSizing: 'border-box',
    background: vmColors.ink,
    borderRadius: 6,
    overflow: 'hidden',
  },
  screen: { width: '100%', height: '100%', overflow: 'hidden' },
  hint: { color: vmColors.mute, fontSize: 12.5, marginRight: 'auto' },
});

// The backend accepts at most 16 KiB of input per request.
const MAX_INPUT = 16000;

/**
 * An SSH session to the VM in the browser. The IDP backend runs `ssh` with a short-lived CA-signed
 * key; this side sends keystrokes and long-polls output over plain HTTP requests (no WebSocket,
 * which TLS-inspecting proxies can hold back).
 */
export function VmTerminal({
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
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>(
    'connecting',
  );
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open || !screen) return undefined;
    const container = screen;
    let disposed = false;
    let cleanup = () => {};
    // Rows and columns come from the font's cell size: measure only once the web font is loaded,
    // or the last rows end up below the visible area.
    Promise.race([
      document.fonts.load('13px "JetBrains Mono"').catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]).then(() => {
      if (!disposed) cleanup = start();
    });
    return () => {
      disposed = true;
      cleanup();
    };

    function start() {
      const term = new Terminal({
        fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
        fontSize: 13,
        cursorBlink: true,
        theme: { background: vmColors.ink },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      fit.fit();
      term.focus();
      let id: string | undefined;
      let seq = 0;
      let queue = '';
      let sending = false;
      let size = '';
      setState('connecting');
      setMessage('Connecting…');

      const end = (reason: string) => {
        if (disposed) return;
        setState('closed');
        setMessage(`Disconnected: ${reason}`);
        term.write(`\r\n\x1b[90m[${reason}]\x1b[0m\r\n`);
      };
      // Keystrokes are sent in order, batched while a request is in flight.
      const flush = async () => {
        if (sending || !queue || !id || disposed) return;
        sending = true;
        const data = queue.slice(0, MAX_INPUT);
        queue = queue.slice(data.length);
        try {
          await api.terminal.input(id, data);
        } catch (e) {
          end((e as Error).message);
          queue = '';
        } finally {
          sending = false;
        }
        flush();
      };
      const typing = term.onData(data => {
        queue += data;
        flush();
      });
      const resize = () => {
        fit.fit();
        const next = `${term.cols}x${term.rows}`;
        if (!id || next === size) return;
        size = next;
        api.terminal.resize(id, term.cols, term.rows).catch(() => {});
      };
      const observer = new ResizeObserver(resize);
      observer.observe(container);

      async function poll() {
        let failures = 0;
        while (!disposed && id) {
          try {
            const output = await api.terminal.output(id, seq);
            if (disposed) return;
            failures = 0;
            if (output.data) term.write(output.data);
            seq = output.seq;
            if (output.closed) {
              end(output.closed);
              return;
            }
          } catch (e) {
            if (disposed) return;
            if (++failures >= 4) {
              end((e as Error).message);
              return;
            }
            const wait = 1000 * failures;
            await new Promise(resolve => setTimeout(resolve, wait));
          }
        }
      }

      (async () => {
        try {
          const session = await api.terminal.open(vmRef, term.cols, term.rows);
          if (disposed) {
            api.terminal.close(session.id).catch(() => {});
            return;
          }
          id = session.id;
          size = `${term.cols}x${term.rows}`;
          setState('open');
          setMessage(`${session.user}@${session.host}`);
          poll();
          flush();
        } catch (e) {
          end((e as Error).message);
        }
      })();

      return () => {
        observer.disconnect();
        typing.dispose();
        if (id) api.terminal.close(id).catch(() => {});
        term.dispose();
      };
    }
  }, [api, open, screen, vmRef, attempt]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="lg"
      aria-labelledby="vm-terminal-title"
      disableEnforceFocus
    >
      <DialogTitle id="vm-terminal-title" disableTypography>
        <div className={classes.title}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Terminal · {name}</h2>
          <span
            role="status"
            aria-label="Terminal status"
            className={classes.status}
            style={{
              color: state === 'closed' ? vmColors.redText : vmColors.mute,
            }}
          >
            {message}
          </span>
        </div>
      </DialogTitle>
      <div className={classes.frame}>
        <div ref={setScreen} className={classes.screen} aria-label="Terminal" />
      </div>
      <DialogActions>
        <span className={classes.hint}>
          Signed in as your team. Closes after 15 minutes without input.
        </span>
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
