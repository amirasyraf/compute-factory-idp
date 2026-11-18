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
      /** Smallest memory an instance type needs for this OS (Windows: 4096). */
      minMemoryMiB?: number;
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

/** The OS family (`linux`, `windows`) of a platform's OS; it selects sizes and software. */
export function osFamily(platform: Platform, os: unknown): string | undefined {
  if (
    typeof os !== 'string' ||
    !Object.prototype.hasOwnProperty.call(platform.os, os)
  )
    return undefined;
  const family = platform.os[os]?.family;
  return typeof family === 'string' && /^[a-z]+$/.test(family)
    ? family
    : undefined;
}

export function minMemoryMiB(platform: Platform, os: unknown): number {
  const value =
    typeof os === 'string' &&
    Object.prototype.hasOwnProperty.call(platform.os, os)
      ? platform.os[os]?.minMemoryMiB
      : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
  return repoFile(`terraform/platforms/${id}/${file}`, logger);
}

async function repoFile(path: string, logger: LoggerService): Promise<unknown> {
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

/** The platform's `sizes.json` for one OS family: size letter -> instance type. */
export async function loadSizes(
  id: string,
  logger: LoggerService,
  family: string,
): Promise<Record<string, string>> {
  const [platform, raw] = await Promise.all([
    loadPlatform(id, logger),
    platformFile(id, 'sizes.json', logger),
  ]);
  const map = object(raw, 'sizes.json');
  const sizes = Object.entries(
    object(
      Object.prototype.hasOwnProperty.call(map, family) ? map[family] : {},
      `sizes.json ${family}`,
    ),
  ).filter(
    (entry): entry is [string, string] =>
      /^[A-Z]{1,4}$/.test(entry[0]) &&
      typeof entry[1] === 'string' &&
      allowsInstanceType(platform, entry[1]),
  );
  if (!sizes.length)
    throw new Error(`${id} sizes.json has no valid ${family} entries`);
  return Object.fromEntries(sizes);
}

/** Every instance type any OS family's size maps to on this platform. */
export async function allSizeTypes(
  id: string,
  logger: LoggerService,
): Promise<string[]> {
  const raw = object(
    await platformFile(id, 'sizes.json', logger),
    'sizes.json',
  );
  const lists = await Promise.all(
    Object.keys(raw).map(family => loadSizes(id, logger, family)),
  );
  return lists.flatMap(sizes => Object.values(sizes));
}

/** One `ansible/software-catalog.json` entry: label and the per-family package ID (null = not offered). */
export type SoftwareItem = { id: string; label: string; families: string[] };

/** The platform repo's software catalog, as the request and Modify forms show it. */
export async function loadSoftware(
  logger: LoggerService,
): Promise<SoftwareItem[]> {
  const raw = object(
    await repoFile('ansible/software-catalog.json', logger),
    'software-catalog.json',
  );
  return Object.entries(raw)
    .filter(([id]) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(id))
    .map(([id, value]) => {
      const entry = object(value, `software-catalog.json ${id}`);
      return {
        id,
        label:
          typeof entry.label === 'string' && entry.label ? entry.label : id,
        families: Object.entries(entry)
          .filter(
            ([key, item]) =>
              key !== 'label' && typeof item === 'string' && item.length > 0,
          )
          .map(([key]) => key),
      };
    });
}

/**
 * Why `software` cannot be installed on this OS (the stage validation would fail permanently),
 * or null. Throws when the platform or catalog cannot be read.
 */
export async function refuseSoftware(
  platformId: string,
  os: unknown,
  software: string[],
  logger: LoggerService,
): Promise<string | null> {
  const [platform, catalog] = await Promise.all([
    loadPlatform(platformId, logger),
    loadSoftware(logger),
  ]);
  const family = osFamily(platform, os);
  if (!family) return 'Choose a supported VM platform and image';
  const missing = software.filter(
    item =>
      !catalog.find(entry => entry.id === item)?.families.includes(family),
  );
  return missing.length
    ? `Not offered for ${
        platform.os[os as string]?.label ?? os
      }: ${missing.join(', ')}`
    : null;
}

export async function platformLabel(id: string, logger: LoggerService) {
  try {
    return (await loadPlatform(id, logger)).label;
  } catch {
    return fallbackLabel(id);
  }
}
