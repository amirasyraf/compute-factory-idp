import {
  DescribeInstanceTypesCommand,
  EC2Client,
  InstanceTypeInfo,
  _InstanceType,
  paginateDescribeInstanceTypeOfferings,
  paginateDescribeInstanceTypes,
} from '@aws-sdk/client-ec2';
import {
  LoggerService,
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import express from 'express';
import { ARM_VERSIONS, armList, azureReader } from './azure';
import { message } from './github';
import {
  COMING_SOON,
  PLATFORMS,
  fallbackLabel,
  loadPlatform,
  loadSizes,
  validPlatform,
} from './platforms';

// Instance-type specs do not change; refresh hourly only to pick up new mappings.
const specsTtlMs = 60 * 60 * 1000;
const usagesTtlMs = 5 * 60 * 1000;

type Specs = {
  vcpus: number | null;
  memoryMiB: number | null;
  architectures: string[];
  network: string | null;
  burstable: boolean;
  // Enough free vCPU quota to launch it; null = not known (AWS, or usages unavailable).
  quotaOk: boolean | null;
};
type Size = { size: string; instanceType: string; specs: Specs | null };
type CatalogType = Specs & {
  type: string;
  family: string;
  category: string;
  currentGeneration: boolean;
  bareMetal: boolean;
  gpus: string | null;
};

// AWS's instance families, keyed by the family's leading letters (m7i -> m, inf2 -> inf).
const categories: [RegExp, string][] = [
  [/^(t|m|a)$/, 'General purpose'],
  [/^c$/, 'Compute optimized'],
  [/^(r|x|z|u)$/, 'Memory optimized'],
  [/^(i|im|is|d|h)$/, 'Storage optimized'],
  [/^(p|g|inf|trn|dl|f|vt)$/, 'Accelerated computing'],
  [/^hpc$/, 'High performance computing'],
];
function category(family: string): string {
  const letters = /^[a-z]+/.exec(family)?.[0] ?? family;
  return categories.find(([pattern]) => pattern.test(letters))?.[1] ?? 'Other';
}
// Azure sizes by the series letter after `Standard_`.
const azureCategories: Record<string, string> = {
  A: 'General purpose',
  B: 'General purpose',
  D: 'General purpose',
  F: 'Compute optimized',
  E: 'Memory optimized',
  M: 'Memory optimized',
  L: 'Storage optimized',
  N: 'Accelerated computing',
  H: 'High performance computing',
};

function toSpecs(item: InstanceTypeInfo): Specs {
  return {
    vcpus: item.VCpuInfo?.DefaultVCpus ?? null,
    memoryMiB: item.MemoryInfo?.SizeInMiB ?? null,
    architectures: item.ProcessorInfo?.SupportedArchitectures ?? [],
    network: item.NetworkInfo?.NetworkPerformance ?? null,
    burstable: item.BurstablePerformanceSupported ?? false,
    quotaOk: null,
  };
}
const specsOf = ({
  vcpus,
  memoryMiB,
  architectures,
  network,
  burstable,
  quotaOk,
}: CatalogType): Specs => ({
  vcpus,
  memoryMiB,
  architectures,
  network,
  burstable,
  quotaOk,
});

/** A cached loader: concurrent callers share one load; the last good value survives failures. */
function cache<T>(
  ttlMs: number,
  load: () => Promise<T>,
  logger: LoggerService,
) {
  let value: { at: number; value: T } | undefined;
  let inFlight: Promise<T> | undefined;
  return async (): Promise<T> => {
    if (value && Date.now() - value.at < ttlMs) return value.value;
    inFlight ??= load().finally(() => {
      inFlight = undefined;
    });
    try {
      value = { at: Date.now(), value: await inFlight };
      return value.value;
    } catch (error) {
      if (!value) throw error;
      logger.warn(`VM sizes: keeping cached data; ${message(error)}`);
      return value.value;
    }
  };
}

type Sku = {
  resourceType?: string;
  name?: string;
  family?: string;
  restrictions?: { type?: string }[];
  capabilities?: { name: string; value: string }[];
};
type Usage = { name?: { value?: string }; currentValue: number; limit: number };

export const vmSizesPlugin = createBackendPlugin({
  pluginId: 'vm-sizes',
  register(reg) {
    reg.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        logger: coreServices.logger,
      },
      async init({ httpRouter, httpAuth, logger }) {
        const ec2 = new EC2Client({ region: process.env.AWS_REGION });
        let awsSpecs: { at: number; value: Record<string, Specs> } | undefined;
        let awsSpecsError: string | null = null;

        async function awsSizeSpecs(types: string[]) {
          const missing = types.some(type => !awsSpecs?.value[type]);
          if (!awsSpecs || missing || Date.now() - awsSpecs.at > specsTtlMs) {
            try {
              const result = await ec2.send(
                new DescribeInstanceTypesCommand({
                  InstanceTypes: types as _InstanceType[],
                }),
              );
              const value: Record<string, Specs> = {};
              for (const item of result.InstanceTypes ?? []) {
                if (!item.InstanceType) continue;
                value[item.InstanceType] = toSpecs(item);
              }
              awsSpecs = { at: Date.now(), value };
              awsSpecsError = null;
            } catch (error) {
              // Without AWS (local dev) or on an IAM/API failure, sizes still show their types.
              awsSpecsError = `AWS specs unavailable: ${message(error)}`;
              logger.warn(`VM sizes: ${awsSpecsError}`);
              if (awsSpecs) awsSpecs.at = Date.now();
              else
                awsSpecs = { at: Date.now() - specsTtlMs + 60_000, value: {} };
            }
          }
          return { specs: awsSpecs.value, error: awsSpecsError };
        }

        // Every type this account can launch in the region that boots the x86_64 golden image.
        // Mac types need dedicated hosts and are excluded. A few paginated calls, cached an hour.
        const awsCatalog = cache(
          specsTtlMs,
          async (): Promise<CatalogType[]> => {
            const offered = new Set<string>();
            for await (const page of paginateDescribeInstanceTypeOfferings(
              { client: ec2 },
              { LocationType: 'availability-zone' },
            )) {
              for (const item of page.InstanceTypeOfferings ?? [])
                if (item.InstanceType) offered.add(item.InstanceType);
            }
            const types: CatalogType[] = [];
            for await (const page of paginateDescribeInstanceTypes(
              { client: ec2 },
              {
                Filters: [
                  {
                    Name: 'processor-info.supported-architecture',
                    Values: ['x86_64'],
                  },
                  { Name: 'supported-root-device-type', Values: ['ebs'] },
                ],
              },
            )) {
              for (const item of page.InstanceTypes ?? []) {
                const type = item.InstanceType;
                if (!type || !offered.has(type) || type.startsWith('mac'))
                  continue;
                const family = type.split('.')[0];
                const gpu = item.GpuInfo?.Gpus?.[0];
                types.push({
                  ...toSpecs(item),
                  type,
                  family,
                  category: category(family),
                  currentGeneration: item.CurrentGeneration ?? false,
                  bareMetal: item.BareMetal ?? false,
                  gpus: gpu
                    ? `${gpu.Count ?? 1}× ${[gpu.Manufacturer, gpu.Name]
                        .filter(Boolean)
                        .join(' ')}`
                    : null,
                });
              }
            }
            return types.sort((a, b) => a.type.localeCompare(b.type));
          },
          logger,
        );

        // Sizes this subscription may use in the location that boot the x64 Gen2 image.
        // Azure has no "current generation" flag, so every size counts as current.
        const azureSkus = cache(
          specsTtlMs,
          async (): Promise<CatalogType[]> => {
            const { location } = await azureReader();
            const skus = await armList<Sku>(
              `/providers/Microsoft.Compute/skus?api-version=${
                ARM_VERSIONS.skus
              }&$filter=${encodeURIComponent(`location eq '${location}'`)}`,
            );
            const types = new Map<string, CatalogType>();
            for (const sku of skus) {
              if (sku.resourceType !== 'virtualMachines' || !sku.name) continue;
              if (sku.restrictions?.some(item => item.type === 'Location'))
                continue;
              const caps = Object.fromEntries(
                (sku.capabilities ?? []).map(item => [item.name, item.value]),
              );
              if (
                caps.CpuArchitectureType !== 'x64' ||
                !String(caps.HyperVGenerations ?? '')
                  .split(',')
                  .includes('V2')
              )
                continue;
              const number = (value: string | undefined) =>
                value !== undefined && Number.isFinite(Number(value))
                  ? Number(value)
                  : null;
              const memoryGB = number(caps.MemoryGB);
              const gpus = number(caps.GPUs);
              const letter = /^Standard_([A-Za-z])/.exec(sku.name)?.[1];
              types.set(sku.name, {
                vcpus: number(caps.vCPUs),
                memoryMiB:
                  memoryGB === null ? null : Math.round(memoryGB * 1024),
                architectures: ['x86_64'],
                network: null,
                burstable: letter?.toUpperCase() === 'B',
                quotaOk: null,
                type: sku.name,
                family: sku.family ?? 'Other',
                category:
                  azureCategories[letter?.toUpperCase() ?? ''] ?? 'Other',
                currentGeneration: true,
                bareMetal: false,
                gpus: gpus ? `${gpus}× GPU` : null,
              });
            }
            return [...types.values()].sort((a, b) =>
              a.type.localeCompare(b.type),
            );
          },
          logger,
        );
        const azureUsages = cache(
          usagesTtlMs,
          async () => {
            const { location } = await azureReader();
            const usages = await armList<Usage>(
              `/providers/Microsoft.Compute/locations/${location}/usages?api-version=${ARM_VERSIONS.compute}`,
            );
            return new Map(
              usages
                .filter(item => item.name?.value)
                .map(item => [item.name!.value!.toLowerCase(), item]),
            );
          },
          logger,
        );
        // Free quota now, for both the size's family and the regional vCPU total.
        async function azureCatalog(): Promise<CatalogType[]> {
          const types = await azureSkus();
          const usages = await azureUsages().catch(error => {
            logger.warn(
              `VM sizes: Azure usages unavailable: ${message(error)}`,
            );
            return undefined;
          });
          const free = (name: string) => {
            const usage = usages?.get(name.toLowerCase());
            return usage ? usage.limit - usage.currentValue : undefined;
          };
          const cores = free('cores');
          return types.map(item => {
            const family = free(item.family);
            return {
              ...item,
              quotaOk:
                item.vcpus === null ||
                cores === undefined ||
                family === undefined
                  ? null
                  : family >= item.vcpus && cores >= item.vcpus,
            };
          });
        }

        async function catalogFor(platform: string) {
          if (platform === 'aws') return awsCatalog();
          if (platform === 'azure') return azureCatalog();
          throw new Error(`No instance-type source for ${platform}`);
        }

        async function sizesFor(platform: string) {
          const [info, mapping] = await Promise.all([
            loadPlatform(platform, logger),
            loadSizes(platform, logger),
          ]);
          let specs: Record<string, Specs> = {};
          let error: string | null = null;
          if (platform === 'aws')
            ({ specs, error } = await awsSizeSpecs([
              ...new Set(Object.values(mapping)),
            ]));
          else
            try {
              for (const item of await catalogFor(platform))
                specs[item.type] = specsOf(item);
            } catch (failure) {
              error = `${info.label} specs unavailable: ${message(failure)}`;
              logger.warn(`VM sizes: ${error}`);
            }
          const sizes: Size[] = Object.entries(mapping).map(
            ([size, instanceType]) => ({
              size,
              instanceType,
              specs: specs[instanceType] ?? null,
            }),
          );
          return {
            platform,
            label: info.label,
            reservedTagPrefixes: info.reservedTagPrefixes,
            sizes,
            error,
          };
        }

        const platformOf = (req: express.Request, res: express.Response) => {
          const platform = req.query.platform ?? 'aws';
          if (validPlatform(platform) && PLATFORMS.includes(platform))
            return platform;
          res.status(400).json({ error: 'Unknown platform' });
          return undefined;
        };

        const router = express.Router();
        router.get('/platforms', async (req, res, next) => {
          try {
            await httpAuth.credentials(req, { allow: ['user'] });
            res.json({
              platforms: await Promise.all(
                PLATFORMS.map(async id => {
                  try {
                    const info = await loadPlatform(id, logger);
                    return {
                      id,
                      label: info.label,
                      available: true,
                      os: Object.entries(info.os).map(([os, item]) => ({
                        id: os,
                        label: item.label ?? os,
                        versions: Array.isArray(item.versions)
                          ? item.versions.filter(
                              (version): version is string =>
                                typeof version === 'string',
                            )
                          : [],
                      })),
                      reservedTagPrefixes: info.reservedTagPrefixes,
                      forbiddenTagKeyCharacters: info.forbiddenTagKeyCharacters,
                      error: null,
                    };
                  } catch (error) {
                    return {
                      id,
                      label: fallbackLabel(id),
                      available: true,
                      os: [],
                      reservedTagPrefixes: [],
                      forbiddenTagKeyCharacters: '',
                      error: message(error),
                    };
                  }
                }),
              ).then(platforms => [
                ...platforms,
                ...COMING_SOON.map(item => ({
                  ...item,
                  available: false,
                  os: [],
                  reservedTagPrefixes: [],
                  forbiddenTagKeyCharacters: '',
                  error: null,
                })),
              ]),
            });
          } catch (error) {
            next(error);
          }
        });
        router.get('/instance-types', async (req, res, next) => {
          try {
            await httpAuth.credentials(req, { allow: ['user'] });
            const platform = platformOf(req, res);
            if (!platform) return;
            let types: CatalogType[];
            try {
              types = await catalogFor(platform);
            } catch (error) {
              const failure = `${fallbackLabel(
                platform,
              )} instance types unavailable: ${message(error)}`;
              logger.warn(`VM sizes: ${failure}`);
              res.status(503).json({ error: failure });
              return;
            }
            res.json({
              region:
                platform === 'aws'
                  ? process.env.AWS_REGION
                  : (await azureReader()).location,
              types,
            });
          } catch (error) {
            next(error);
          }
        });
        router.get('/sizes', async (req, res, next) => {
          try {
            await httpAuth.credentials(req, { allow: ['user'] });
            const platform = platformOf(req, res);
            if (platform) res.json(await sizesFor(platform));
          } catch (error) {
            next(error);
          }
        });
        httpRouter.use(router);
      },
    });
  },
});
