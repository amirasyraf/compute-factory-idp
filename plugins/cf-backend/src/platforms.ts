import { LoggerService } from '@backstage/backend-plugin-api';
import { message, repository } from './github';

/** Platforms the IDP knows how to observe and price; each has `terraform/platforms/<id>/`. */
export const PLATFORMS = ['aws', 'azure'];
/** Shown on the Launch page as "Coming soon"; nothing else knows about them. */
export const COMING_SOON = [{ id: 'vsphere', label: 'vSphere' }];
const fallbackLabels: Record<string, string> = { aws: 'AWS', azure: 'Azure' };
const ttlMs = 5 * 60 * 1000;

export type Platform = {
  id: string;
  label: string;
  os: Record<
    string,
    {
      label?: string;
      versions?: string[];
      galleryImages?: Record<string, string>;
      sshUser?: string;
      family?: string;
    }
  >;
  instanceTypePattern: RegExp;
  excludedInstanceTypePattern: RegExp | null;
  reservedTagPrefixes: string[];
  forbiddenTagKeyCharacters: string;
  /** The public IP survives stop/start and resize (Azure static IP); AWS gets a new one. */
  staticPublicIp: boolean;
};

export const validPlatform = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-z][a-z0-9-]{1,20}$/.test(id);

export const validImageVersion = (version: unknown): version is string =>
  typeof version === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(version);

export function imageVersions(platform: Platform, os: string): string[] {
  const image = Object.prototype.hasOwnProperty.call(platform.os, os)
    ? platform.os[os]
    : undefined;
  const versions = Array.isArray(image?.versions)
    ? [...new Set(image.versions.filter(validImageVersion))]
    : [];
  if (platform.id !== 'azure') return versions;
  const galleryImages = image?.galleryImages ?? {};
  return versions.filter(version => {
    const name = galleryImages[version];
    return (
      typeof name === 'string' &&
      !!name &&
      Object.values(galleryImages).filter(
        item =>
          typeof item === 'string' && item.toLowerCase() === name.toLowerCase(),
      ).length === 1
    );
  });
}

/** Only when platform.json cannot be read. */
export const fallbackLabel = (id: string) =>
  fallbackLabels[id] ?? id.toUpperCase();

const files = new Map<string, { at: number; value: unknown }>();
const loads = new Map<string, Promise<unknown>>();

async function fetchFile(path: string): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error(`GITHUB_TOKEN is required to read ${path}`);
  const response = await fetch(
    `https://api.github.com/repos/${repository}/contents/${path}?ref=main`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    },
  );
  if (!response.ok)
    throw new Error(
      `GitHub API HTTP ${response.status} reading ${path} (request ${
        response.headers.get('x-github-request-id') ?? 'unknown'
      })`,
    );
  try {
    return await response.json();
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

/** A platform repo file from `main`, cached 5 minutes; the last good copy is kept during outages. */
async function platformFile(
  id: string,
  file: 'sizes.json' | 'platform.json',
  logger: LoggerService,
): Promise<unknown> {
  if (!validPlatform(id)) throw new Error('Invalid platform');
  const path = `terraform/platforms/${id}/${file}`;
  const cached = files.get(path);
  if (cached && Date.now() - cached.at < ttlMs) return cached.value;
  let load = loads.get(path);
  if (!load) {
    load = fetchFile(path).finally(() => loads.delete(path));
    loads.set(path, load);
  }
  try {
    const value = await load;
    files.set(path, { at: Date.now(), value });
    return value;
  } catch (error) {
    if (!cached) throw error;
    logger.warn(`Platform files: keeping cached ${path}; ${message(error)}`);
    cached.at = Date.now();
    return cached.value;
  }
}

const object = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
};
// An empty pattern means "none".
const pattern = (value: unknown) =>
  typeof value === 'string' && value ? new RegExp(value) : null;

export async function loadPlatform(
  id: string,
  logger: LoggerService,
): Promise<Platform> {
  const raw = object(
    await platformFile(id, 'platform.json', logger),
    'platform.json',
  );
  const instanceTypePattern = pattern(raw.instanceTypePattern);
  if (!instanceTypePattern)
    throw new Error(`${id} platform.json has no instanceTypePattern`);
  return {
    id,
    label:
      typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim()
        : fallbackLabel(id),
    os: object(raw.os ?? {}, 'platform.json os') as Platform['os'],
    instanceTypePattern,
    excludedInstanceTypePattern: pattern(raw.excludedInstanceTypePattern),
    reservedTagPrefixes: Array.isArray(raw.reservedTagPrefixes)
      ? raw.reservedTagPrefixes
          .filter((item): item is string => typeof item === 'string')
          .map(item => item.toLowerCase())
      : [],
    forbiddenTagKeyCharacters:
      typeof raw.forbiddenTagKeyCharacters === 'string'
        ? raw.forbiddenTagKeyCharacters
        : '',
    staticPublicIp: raw.staticPublicIp === true,
  };
}

export const allowsInstanceType = (platform: Platform, type: string) =>
  platform.instanceTypePattern.test(type) &&
  !platform.excludedInstanceTypePattern?.test(type);

/** The platform's `sizes.json`: size letter -> instance type. */
export async function loadSizes(
  id: string,
  logger: LoggerService,
): Promise<Record<string, string>> {
  const [platform, raw] = await Promise.all([
    loadPlatform(id, logger),
    platformFile(id, 'sizes.json', logger),
  ]);
  const sizes = Object.entries(object(raw, 'sizes.json')).filter(
    (entry): entry is [string, string] =>
      /^[A-Z]{1,4}$/.test(entry[0]) &&
      typeof entry[1] === 'string' &&
      allowsInstanceType(platform, entry[1]),
  );
  if (!sizes.length) throw new Error(`${id} sizes.json has no valid entries`);
  return Object.fromEntries(sizes);
}

export async function platformLabel(id: string, logger: LoggerService) {
  try {
    return (await loadPlatform(id, logger)).label;
  } catch {
    return fallbackLabel(id);
  }
}
