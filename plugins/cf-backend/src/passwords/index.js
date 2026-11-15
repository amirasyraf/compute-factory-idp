// Shared by the backend and the dependency-free password hashing CLI.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const prefix = 'scrypt$16384$8$1';
const dummy = `${prefix}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(
  32,
).toString('base64')}`;

export async function hashPassword(password) {
  if (!password || Buffer.byteLength(password) > 1024)
    throw new Error('Password must contain 1–1024 bytes');
  const salt = randomBytes(16);
  const key = await derive(password, salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `${prefix}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parseHash(hash) {
  const parts = hash.split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== prefix)
    return undefined;
  const salt = Buffer.from(parts[4], 'base64');
  const key = Buffer.from(parts[5], 'base64');
  if (
    salt.length !== 16 ||
    key.length !== 32 ||
    salt.toString('base64') !== parts[4] ||
    key.toString('base64') !== parts[5]
  )
    return undefined;
  return { salt, key };
}

export async function verifyPassword(password, hash) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024)
    return false;
  const parsed = typeof hash === 'string' ? parseHash(hash) : undefined;
  // Unknown users and malformed records still pay the same scrypt cost.
  const { salt, key } = parsed || parseHash(dummy);
  const actual = await derive(password, salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, key) && Boolean(parsed);
}

export function readUsers(encoded) {
  if (!encoded || encoded.length > 1024 * 1024)
    throw new Error('IDP_USERS_B64 is required (maximum 1 MiB)');
  const raw = Buffer.from(encoded, 'base64');
  if (raw.toString('base64') !== encoded)
    throw new Error(
      'IDP_USERS_B64 must be canonical base64 without line breaks',
    );
  const users = new Map();
  for (const line of raw.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf(':');
    const username = line.slice(0, separator);
    const hash = line.slice(separator + 1);
    if (
      separator < 1 ||
      !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(username) ||
      users.has(username)
    )
      throw new Error('Invalid or duplicate username in IDP_USERS_B64');
    users.set(username, hash);
  }
  if (!users.size) throw new Error('IDP_USERS_B64 contains no users');
  return users;
}

export async function verifyUserPassword(users, username, password) {
  return verifyPassword(password, users.get(username));
}
