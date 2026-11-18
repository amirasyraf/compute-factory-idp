import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { AddressInfo, Socket, connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  GetSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { LoggerService } from '@backstage/backend-plugin-api';
import { sessionKey } from './terminal';

/** Browser RDP limits (CONTRACTS.md §8.5). */
export const RDP = {
  perUser: 1,
  idleMs: 30 * 60_000,
  // A session whose page stopped polling (tab closed, network gone) is closed.
  orphanMs: 90_000,
  pollMs: 25_000,
  // guacd output not yet acknowledged by the browser; above this, reading from guacd pauses
  // (guacd then drops frames instead of the IDP buffering without bound).
  bufferBytes: 8 * 1024 * 1024,
  // One poll response carries at most this much.
  readBytes: 2 * 1024 * 1024,
  // Browser input guacd has not consumed yet; above this the session is closed.
  inputBytes: 4 * 1024 * 1024,
  connectMs: 20_000,
};

export class RdpLimit extends Error {}

/**
 * The shared login of a Windows VM: Secrets Manager `compute-factory/vm/<name>`. Only the
 * incarnation `requestId` the caller was authorized for: a reused VM name's secret is not returned.
 */
export async function readVmLogin(
  name: string,
  requestId: string,
): Promise<{ username: string; password: string } | undefined> {
  if (!/^[a-z][a-z0-9-]{2,20}$/.test(name)) return undefined;
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: `compute-factory/vm/${name}` }),
    );
    const value = JSON.parse(result.SecretString ?? '{}');
    if (
      typeof value.username !== 'string' ||
      typeof value.password !== 'string' ||
      !value.password
    )
      throw new Error(`compute-factory/vm/${name} is malformed`);
    if (!requestId || value.requestId !== requestId) return undefined;
    return { username: value.username, password: value.password };
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  } finally {
    client.destroy();
  }
}

// Guacamole protocol: `<length>.<value>` elements (length in Unicode code points), comma
// separated, `;` terminated. guacd speaks it on TCP 4822.
const element = (value: string) => `${[...value].length}.${value}`;
export const instruction = (opcode: string, ...args: string[]) =>
  `${[opcode, ...args].map(element).join(',')};`;

const housekeeping = /^(?:4\.sync(?:,[0-9]+\.[^,;]*)*;|3\.nop;)*$/;

/** Complete instructions at the start of `buffer`, and the unparsed rest. */
function parse(buffer: string) {
  const instructions: string[][] = [];
  const chars = [...buffer];
  let position = 0;
  let start = 0;
  let current: string[] = [];
  while (position < chars.length) {
    const dot = chars.indexOf('.', position);
    if (dot < 0) break;
    const length = Number(chars.slice(position, dot).join(''));
    if (!Number.isInteger(length) || length < 0)
      throw new Error('Malformed Guacamole instruction');
    const end = dot + 1 + length;
    if (end >= chars.length) break;
    current.push(chars.slice(dot + 1, end).join(''));
    position = end + 1;
    if (chars[end] === ';') {
      instructions.push(current);
      current = [];
      start = position;
    } else if (chars[end] !== ',') {
      throw new Error('Malformed Guacamole instruction');
    }
  }
  return { instructions, rest: chars.slice(start).join('') };
}

/** A free loopback port for the SSH forward (bound briefly, then released). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Resolves once something accepts connections on the port, or rejects when `failed` is set. */
async function waitForPort(port: number, failed: () => string | null) {
  const deadline = Date.now() + RDP.connectMs;
  for (;;) {
    const reason = failed();
    if (reason) throw new Error(reason);
    const open = await new Promise<boolean>(resolve => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    if (Date.now() > deadline)
      throw new Error('The SSH tunnel to the VM did not open in time');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

type Chunk = { seq: number; data: string };
type Session = {
  id: string;
  user: string;
  vm: string;
  host: string;
  ssh: ChildProcess;
  guacd: Socket;
  dir: string;
  chunks: Chunk[];
  bytes: number;
  seq: number;
  paused: boolean;
  closed: string | null;
  waiters: Set<() => void>;
  openedAt: number;
  lastInput: number;
  lastPoll: number;
};

/**
 * Remote Desktop sessions from the IDP to Windows VMs, drawn in the browser by guacamole-common-js.
 * For each session the IDP opens an SSH port forward to the VM's own RDP port (3389 is never
 * exposed), with a fresh key signed by the SSH CA for a few minutes (like the terminal), and
 * connects guacd (a sidecar sharing the backend's network namespace) through it with the VM's
 * shared login. The browser exchanges Guacamole instructions over short HTTP requests.
 */
export function createRdp(logger: LoggerService) {
  const sessions = new Map<string, Session>();
  // Per user: sessions being set up (SSH tunnel, guacd handshake).
  const opening = new Map<string, number>();
  const guacdHost = process.env.GUACD_HOST || '127.0.0.1';
  const guacdPort = Number(process.env.GUACD_PORT || 4822);

  const wake = (session: Session) => {
    session.waiters.forEach(waiter => waiter());
    session.waiters.clear();
  };

  function close(session: Session, reason: string) {
    if (session.closed) return;
    session.closed = reason;
    session.guacd.destroy();
    session.ssh.kill();
    wake(session);
    rm(session.dir, { recursive: true, force: true }).catch(() => {});
    logger.info(
      `RDP ${session.id} closed: ${session.user} → ${session.vm} (${
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
      if (now - session.lastInput > RDP.idleMs)
        close(session, 'idle for 30 minutes');
      else if (now - session.lastPoll > RDP.orphanMs)
        close(session, 'browser stopped polling');
    }
  }, 15_000);
  sweep.unref();

  const owned = (id: string, user: string) => {
    const session = sessions.get(id);
    return session && session.user === user ? session : undefined;
  };

  /** guacd handshake for one RDP connection; resolves with output that followed `ready`. */
  function handshake(
    socket: Socket,
    decoder: StringDecoder,
    settings: Record<string, string>,
    display: { width: number; height: number; dpi: number; timezone: string },
  ) {
    return new Promise<string>((resolve, reject) => {
      let buffer = '';
      let sentConnect = false;
      let timer: NodeJS.Timeout | undefined = undefined;
      // Only the handshake listens to `data` until it settles; the session attaches its own after.
      const finish = () => {
        clearTimeout(timer);
        socket.removeAllListeners('data');
      };
      const fail = (error: Error) => {
        finish();
        reject(error);
      };
      timer = setTimeout(
        () => fail(new Error('guacd did not answer in time')),
        RDP.connectMs,
      );
      const onData = (data: Buffer) => {
        buffer += decoder.write(data);
        let parsed;
        try {
          parsed = parse(buffer);
        } catch (error) {
          fail(error as Error);
          return;
        }
        buffer = parsed.rest;
        for (const [opcode, ...args] of parsed.instructions) {
          if (opcode === 'args' && !sentConnect) {
            sentConnect = true;
            // The first element is guacd's protocol version; answer with the same one.
            const [version, ...names] = args;
            socket.write(
              instruction(
                'size',
                String(display.width),
                String(display.height),
                String(display.dpi),
              ) +
                instruction('audio') +
                instruction('video') +
                instruction('image', 'image/png', 'image/jpeg', 'image/webp') +
                instruction('timezone', display.timezone) +
                instruction(
                  'connect',
                  version,
                  ...names.map(name => settings[name] ?? ''),
                ),
            );
          } else if (opcode === 'ready') {
            finish();
            // Anything after `ready` belongs to the browser, as raw instructions.
            resolve(
              parsed.instructions
                .slice(
                  parsed.instructions.findIndex(item => item[0] === 'ready') +
                    1,
                )
                .map(item => instruction(item[0], ...item.slice(1)))
                .join('') + buffer,
            );
            return;
          } else if (opcode === 'error') {
            fail(new Error(`guacd: ${args[0] ?? 'connection refused'}`));
            return;
          }
        }
      };
      socket.on('data', onData);
      socket.once('error', fail);
      socket.write(instruction('select', 'rdp'));
    });
  }

  return {
    async open(input: {
      user: string;
      vm: string;
      host: string;
      /** The VM's OS login user (`cf/ssh-user`), already validated by the caller. */
      sshUser: string;
      principal: string;
      login: { username: string; password: string };
      width: number;
      height: number;
      dpi: number;
      timezone: string;
    }) {
      // Sessions still connecting count too (reserved before the first await), so parallel
      // requests cannot exceed the limit.
      const active = [...sessions.values()].filter(
        session => session.user === input.user && !session.closed,
      );
      if (active.length + (opening.get(input.user) ?? 0) >= RDP.perUser)
        throw new RdpLimit(
          'You already have a remote desktop open; close it first',
        );
      opening.set(input.user, (opening.get(input.user) ?? 0) + 1);
      const id = randomUUID();
      let dir: string | undefined;
      let ssh: ChildProcess | undefined;
      let guacd: Socket | undefined;
      try {
        dir = await mkdtemp(join(tmpdir(), 'cf-rdp-'));
        const key = await sessionKey(
          dir,
          `idp-rdp:${input.user}`,
          input.principal,
        );
        const port = await freePort();
        let exited: string | null = null;
        let stderr = '';
        ssh = spawn(
          'ssh',
          [
            '-N',
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
            '-o',
            'ExitOnForwardFailure=yes',
            // POC: VM host keys are not pinned anywhere (same as the terminal and fry stages).
            '-o',
            'StrictHostKeyChecking=no',
            '-o',
            'UserKnownHostsFile=/dev/null',
            '-o',
            'LogLevel=ERROR',
            '-L',
            `127.0.0.1:${port}:localhost:3389`,
            `${input.sshUser}@${input.host}`,
          ],
          {
            cwd: dir,
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        );
        ssh.stderr?.on('data', data => {
          stderr = `${stderr}${data}`.slice(-2000);
        });
        ssh.once('exit', code => {
          exited = `SSH tunnel to the VM exited (${code})${
            stderr.trim() ? `: ${stderr.trim()}` : ''
          }`;
        });
        await waitForPort(port, () => exited);
        guacd = connect({ host: guacdHost, port: guacdPort });
        await new Promise<void>((resolve, reject) => {
          guacd!.once('connect', resolve);
          guacd!.once('error', error =>
            reject(new Error(`guacd unavailable: ${error.message}`)),
          );
        });
        // One decoder for the whole connection: a UTF-8 character can span the end of the handshake.
        const decoder = new StringDecoder('utf8');
        const initial = await handshake(
          guacd,
          decoder,
          {
            hostname: '127.0.0.1',
            port: String(port),
            username: input.login.username,
            password: input.login.password,
            security: 'nla',
            'ignore-cert': 'true',
            'resize-method': 'display-update',
            'server-layout': 'en-us-qwerty',
            'disable-audio': 'true',
            'enable-wallpaper': 'false',
            'enable-font-smoothing': 'true',
          },
          input,
        );
        const now = Date.now();
        const session: Session = {
          id,
          user: input.user,
          vm: input.vm,
          host: input.host,
          ssh,
          guacd,
          dir,
          chunks: [],
          bytes: 0,
          seq: 0,
          paused: false,
          closed: null,
          waiters: new Set(),
          openedAt: now,
          lastInput: now,
          lastPoll: now,
        };
        const push = (data: string) => {
          if (!data) return;
          session.seq += 1;
          session.chunks.push({ seq: session.seq, data });
          session.bytes += data.length;
          if (session.bytes > RDP.bufferBytes && !session.paused) {
            session.paused = true;
            guacd!.pause();
          }
          wake(session);
        };
        push(initial);
        guacd.on('data', data => push(decoder.write(data)));
        guacd.on('close', () => close(session, 'the remote desktop closed'));
        guacd.on('error', error => close(session, `guacd: ${error.message}`));
        ssh.on('exit', code => close(session, `SSH tunnel exited (${code})`));
        sessions.set(id, session);
        logger.info(
          `RDP ${id} opened: ${input.user} → ${input.vm} (${input.host}) as ${input.principal}`,
        );
        return { id };
      } catch (error) {
        guacd?.destroy();
        ssh?.kill();
        if (dir) await rm(dir, { recursive: true, force: true });
        throw error;
      } finally {
        const count = (opening.get(input.user) ?? 1) - 1;
        if (count > 0) opening.set(input.user, count);
        else opening.delete(input.user);
      }
    },

    /**
     * Instructions after `after` (which also acknowledges everything up to it); waits up to 25 s
     * for new output. undefined = unknown session.
     */
    async read(id: string, user: string, after: number) {
      const session = owned(id, user);
      if (!session) return undefined;
      session.lastPoll = Date.now();
      while (session.chunks.length && session.chunks[0].seq <= after)
        session.bytes -= session.chunks.shift()!.data.length;
      if (session.paused && session.bytes < RDP.bufferBytes / 2) {
        session.paused = false;
        session.guacd.resume();
      }
      if (!session.chunks.length && !session.closed) {
        const waiters = session.waiters;
        await new Promise<void>(resolve => {
          let timer: NodeJS.Timeout | undefined = undefined;
          const done = () => {
            clearTimeout(timer);
            waiters.delete(done);
            resolve();
          };
          timer = setTimeout(done, RDP.pollMs);
          waiters.add(done);
        });
      }
      session.lastPoll = Date.now();
      const chunks: Chunk[] = [];
      let size = 0;
      for (const chunk of session.chunks) {
        if (chunks.length && size + chunk.data.length > RDP.readBytes) break;
        chunks.push(chunk);
        size += chunk.data.length;
      }
      return {
        seq: chunks.length ? chunks[chunks.length - 1].seq : after,
        data: chunks.map(chunk => chunk.data).join(''),
        closed: chunks.length ? null : session.closed,
      };
    },

    /** Raw Guacamole instructions from the browser (keys, mouse, size, clipboard, sync). */
    input(id: string, user: string, data: string) {
      const session = owned(id, user);
      if (!session || session.closed) return false;
      // The browser acknowledges every frame (`sync`); only real input counts as activity.
      if (!housekeeping.test(data)) session.lastInput = Date.now();
      session.guacd.write(data);
      // guacd stopped reading: end the session rather than queue input without bound.
      if (session.guacd.writableLength > RDP.inputBytes) {
        close(session, 'the remote desktop stopped accepting input');
        return false;
      }
      return true;
    },

    close(id: string, user: string) {
      const session = owned(id, user);
      if (session) close(session, 'closed by the user');
      return Boolean(session);
    },
  };
}

export type RdpSessions = ReturnType<typeof createRdp>;
