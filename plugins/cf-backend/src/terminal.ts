import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LoggerService } from '@backstage/backend-plugin-api';
import { IPty, spawn } from 'node-pty';
import { fetchCa } from './sign';

const run = promisify(execFile);

/** Browser terminal limits (CONTRACTS.md §8.4). */
export const TERMINAL = {
  perUser: 2,
  idleMs: 15 * 60_000,
  // A session whose page stopped polling (tab closed, network gone) is closed.
  orphanMs: 90_000,
  pollMs: 25_000,
  bufferBytes: 256 * 1024,
  certMinutes: 5,
};

type Chunk = { seq: number; data: string };
type Session = {
  id: string;
  user: string;
  vm: string;
  host: string;
  pty: IPty;
  dir: string;
  chunks: Chunk[];
  bytes: number;
  seq: number;
  closed: string | null;
  waiters: Set<() => void>;
  openedAt: number;
  lastInput: number;
  lastPoll: number;
};

export class TerminalLimit extends Error {}

/**
 * Interactive SSH sessions from the IDP to VMs. Each session gets a fresh key, signed by the SSH CA
 * for a few minutes with the principal that grants access (the VM's team, or platform-admins), and
 * runs the system `ssh` in a PTY. The browser exchanges input and output over short HTTP requests.
 */
export function createTerminals(logger: LoggerService) {
  const sessions = new Map<string, Session>();

  const wake = (session: Session) => {
    session.waiters.forEach(waiter => waiter());
    session.waiters.clear();
  };

  function close(session: Session, reason: string) {
    if (session.closed) return;
    session.closed = reason;
    try {
      session.pty.kill();
    } catch {
      // Already exited.
    }
    wake(session);
    rm(session.dir, { recursive: true, force: true }).catch(() => {});
    logger.info(
      `Terminal ${session.id} closed: ${session.user} → ${session.vm} (${
        session.host
      }) after ${Math.round(
        (Date.now() - session.openedAt) / 1000,
      )}s: ${reason}`,
    );
    // Keep the final output readable briefly, then forget the session.
    setTimeout(() => sessions.delete(session.id), 60_000).unref();
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.closed) continue;
      if (now - session.lastInput > TERMINAL.idleMs)
        close(session, 'idle for 15 minutes');
      else if (now - session.lastPoll > TERMINAL.orphanMs)
        close(session, 'browser stopped polling');
    }
  }, 15_000);
  sweep.unref();

  function owned(id: string, user: string) {
    const session = sessions.get(id);
    return session && session.user === user ? session : undefined;
  }

  return {
    async open(input: {
      user: string;
      vm: string;
      host: string;
      principal: string;
      cols: number;
      rows: number;
    }) {
      const active = [...sessions.values()].filter(
        session => session.user === input.user && !session.closed,
      );
      if (active.length >= TERMINAL.perUser)
        throw new TerminalLimit(
          `You already have ${TERMINAL.perUser} open terminals; close one first`,
        );
      const id = randomUUID();
      const dir = await mkdtemp(join(tmpdir(), 'cf-term-'));
      try {
        const key = join(dir, 'key');
        const ca = join(dir, 'ca');
        await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], {
          timeout: 10000,
        });
        await writeFile(ca, `${(await fetchCa()).trim()}\n`, { mode: 0o600 });
        try {
          await run(
            'ssh-keygen',
            [
              '-q',
              '-s',
              ca,
              '-I',
              `idp-terminal:${input.user}`,
              '-n',
              input.principal,
              '-V',
              `-1m:+${TERMINAL.certMinutes}m`,
              `${key}.pub`,
            ],
            { timeout: 10000 },
          );
        } finally {
          await rm(ca, { force: true });
        }
        const pty = spawn(
          'ssh',
          [
            '-tt',
            '-i',
            key,
            '-o',
            `CertificateFile=${key}-cert.pub`,
            '-o',
            'IdentitiesOnly=yes',
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=10',
            '-o',
            'ServerAliveInterval=30',
            // POC: VM host keys are not pinned anywhere (same as the fry stages).
            '-o',
            'StrictHostKeyChecking=no',
            '-o',
            'UserKnownHostsFile=/dev/null',
            '-o',
            'LogLevel=ERROR',
            `ubuntu@${input.host}`,
          ],
          {
            name: 'xterm-256color',
            cols: input.cols,
            rows: input.rows,
            cwd: dir,
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
          },
        );
        const now = Date.now();
        const session: Session = {
          id,
          user: input.user,
          vm: input.vm,
          host: input.host,
          pty,
          dir,
          chunks: [],
          bytes: 0,
          seq: 0,
          closed: null,
          waiters: new Set(),
          openedAt: now,
          lastInput: now,
          lastPoll: now,
        };
        pty.onData(data => {
          session.seq += 1;
          session.chunks.push({ seq: session.seq, data });
          session.bytes += data.length;
          // A reader that falls far behind loses the oldest output, never the newest.
          while (
            session.bytes > TERMINAL.bufferBytes &&
            session.chunks.length
          ) {
            session.bytes -= session.chunks.shift()!.data.length;
          }
          wake(session);
        });
        pty.onExit(({ exitCode }) =>
          close(session, `ssh exited with code ${exitCode}`),
        );
        sessions.set(id, session);
        logger.info(
          `Terminal ${id} opened: ${input.user} → ${input.vm} (${input.host}) as ${input.principal}`,
        );
        return { id };
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
    },

    /** Output after `after`; waits up to 25 s for new output. undefined = unknown session. */
    async read(id: string, user: string, after: number) {
      const session = owned(id, user);
      if (!session) return undefined;
      session.lastPoll = Date.now();
      const pending = () => session.chunks.filter(chunk => chunk.seq > after);
      if (!pending().length && !session.closed) {
        const waiters = session.waiters;
        await new Promise<void>(resolve => {
          let timer: NodeJS.Timeout | undefined = undefined;
          const done = () => {
            clearTimeout(timer);
            waiters.delete(done);
            resolve();
          };
          timer = setTimeout(done, TERMINAL.pollMs);
          waiters.add(done);
        });
      }
      session.lastPoll = Date.now();
      const chunks = pending();
      return {
        seq: chunks.length ? chunks[chunks.length - 1].seq : session.seq,
        data: chunks.map(chunk => chunk.data).join(''),
        closed: chunks.length ? null : session.closed,
      };
    },

    input(id: string, user: string, data: string) {
      const session = owned(id, user);
      if (!session || session.closed) return false;
      session.lastInput = Date.now();
      session.pty.write(data);
      return true;
    },

    resize(id: string, user: string, cols: number, rows: number) {
      const session = owned(id, user);
      if (!session || session.closed) return false;
      session.pty.resize(cols, rows);
      return true;
    },

    close(id: string, user: string) {
      const session = owned(id, user);
      if (session) close(session, 'closed by the user');
      return Boolean(session);
    },
  };
}

export type Terminals = ReturnType<typeof createTerminals>;
