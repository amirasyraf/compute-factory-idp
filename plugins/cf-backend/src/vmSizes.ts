import {
  DescribeInstanceTypesCommand,
  EC2Client,
  _InstanceType,
} from '@aws-sdk/client-ec2';
import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import express from 'express';

// The platform repo owns size -> instance type; Terraform reads the same file.
const sizesUrl =
  'https://api.github.com/repos/amirasyraf/compute-factory-platform/contents/terraform/platforms/aws/sizes.json?ref=main';
const sizesTtlMs = 5 * 60 * 1000;
// Instance-type specs do not change; refresh hourly only to pick up new mappings.
const specsTtlMs = 60 * 60 * 1000;
const typePattern = /^[a-z0-9-]+\.[a-z0-9-]+$/;

type Specs = {
  vcpus: number | null;
  memoryMiB: number | null;
  architectures: string[];
  network: string | null;
  burstable: boolean;
};
type Size = { size: string; instanceType: string; specs: Specs | null };

async function fetchSizes(): Promise<Record<string, string>> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required to read sizes.json');
  const response = await fetch(sizesUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      `GitHub API HTTP ${response.status} reading sizes.json (request ${
        response.headers.get('x-github-request-id') ?? 'unknown'
      })`,
    );
  const parsed: unknown = await response.json();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('sizes.json must be an object of size -> instance type');
  const sizes = Object.entries(parsed).filter(
    (entry): entry is [string, string] =>
      /^[A-Z]{1,4}$/.test(entry[0]) &&
      typeof entry[1] === 'string' &&
      typePattern.test(entry[1]),
  );
  if (!sizes.length) throw new Error('sizes.json has no valid entries');
  return Object.fromEntries(sizes);
}

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
        let sizes: { at: number; value: Record<string, string> } | undefined;
        let specs: { at: number; value: Record<string, Specs> } | undefined;
        let specsError: string | null = null;

        async function load() {
          if (!sizes || Date.now() - sizes.at > sizesTtlMs) {
            try {
              sizes = { at: Date.now(), value: await fetchSizes() };
            } catch (error) {
              // Serve the last good mapping during a GitHub outage.
              if (!sizes) throw error;
              logger.warn(
                `VM sizes: keeping cached mapping; ${(error as Error).message}`,
              );
              sizes.at = Date.now();
            }
          }
          const types = [...new Set(Object.values(sizes.value))].sort();
          const missing = types.some(type => !specs?.value[type]);
          if (!specs || missing || Date.now() - specs.at > specsTtlMs) {
            try {
              const result = await ec2.send(
                new DescribeInstanceTypesCommand({
                  InstanceTypes: types as _InstanceType[],
                }),
              );
              const value: Record<string, Specs> = {};
              for (const item of result.InstanceTypes ?? []) {
                if (!item.InstanceType) continue;
                value[item.InstanceType] = {
                  vcpus: item.VCpuInfo?.DefaultVCpus ?? null,
                  memoryMiB: item.MemoryInfo?.SizeInMiB ?? null,
                  architectures: item.ProcessorInfo?.SupportedArchitectures ?? [],
                  network: item.NetworkInfo?.NetworkPerformance ?? null,
                  burstable: item.BurstablePerformanceSupported ?? false,
                };
              }
              specs = { at: Date.now(), value };
              specsError = null;
            } catch (error) {
              // Without AWS (local dev) or on an IAM/API failure, sizes still show their types.
              specsError = `AWS specs unavailable: ${(error as Error).message}`;
              logger.warn(`VM sizes: ${specsError}`);
              if (specs) specs.at = Date.now();
              else specs = { at: Date.now() - specsTtlMs + 60_000, value: {} };
            }
          }
          const result: Size[] = Object.entries(sizes.value).map(
            ([size, instanceType]) => ({
              size,
              instanceType,
              specs: specs?.value[instanceType] ?? null,
            }),
          );
          return { sizes: result, error: specsError };
        }

        const router = express.Router();
        router.get('/sizes', async (req, res, next) => {
          try {
            await httpAuth.credentials(req, { allow: ['user'] });
            res.json(await load());
          } catch (error) {
            next(error);
          }
        });
        httpRouter.use(router);
      },
    });
  },
});
