import { EC2Client, paginateDescribeImages } from '@aws-sdk/client-ec2';
import { armGet, armList, azureReader } from './azure';
import { Platform } from './platforms';

const ec2 = new EC2Client({ region: process.env.AWS_REGION });
const galleryApi = 'api-version=2024-03-03';
const regionId = (name?: string) => name?.toLowerCase().replace(/\s/g, '');

type GalleryVersion = {
  name: string;
  tags?: Record<string, string>;
  properties?: {
    provisioningState?: string;
    publishingProfile?: {
      excludeFromLatest?: boolean;
      targetRegions?: { name?: string; regionalExcludeFromLatest?: boolean }[];
    };
    replicationStatus?: { summary?: { region?: string; state?: string }[] };
  };
};

/** Check the image Terraform would select, not an older fallback image. */
export async function imageAvailable(
  platform: Platform,
  os: string,
  version: string,
): Promise<boolean> {
  const signal = AbortSignal.timeout(8000);
  if (platform.id === 'aws') {
    const images = [];
    for await (const page of paginateDescribeImages(
      { client: ec2, stopOnSameToken: true },
      {
        Owners: ['self'],
        Filters: [
          { Name: 'tag:cf:managed', Values: ['true'] },
          { Name: 'tag:cf:os', Values: [os] },
          { Name: 'tag:cf:os-version', Values: [version] },
        ],
      },
      { abortSignal: signal },
    )) {
      images.push(...(page.Images ?? []));
    }
    const newest = images.sort((a, b) =>
      (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''),
    )[0];
    return (
      newest?.State === 'available' &&
      newest.Tags?.some(tag => tag.Key === 'cf:poc' && tag.Value === 'true') ===
        true
    );
  }

  if (platform.id !== 'azure') return false;
  const definition = platform.os[os]?.galleryImages?.[version];
  if (!definition || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(definition))
    return false;
  const { location } = await azureReader();
  const path = `/resourceGroups/cf-images/providers/Microsoft.Compute/galleries/cfimages/images/${definition}/versions`;
  const versions = await armList<GalleryVersion>(
    `${path}?${galleryApi}`,
    signal,
  );
  const newest = versions
    .filter(item => {
      const profile = item.properties?.publishingProfile;
      const region = profile?.targetRegions?.find(
        target => regionId(target.name) === location,
      );
      return (
        /^\d+\.\d+\.\d+$/.test(item.name) &&
        region &&
        !(region.regionalExcludeFromLatest ?? profile?.excludeFromLatest)
      );
    })
    .map(item => ({ item, parts: item.name.split('.').map(Number) }))
    .sort(
      (a, b) =>
        b.parts[0] - a.parts[0] ||
        b.parts[1] - a.parts[1] ||
        b.parts[2] - a.parts[2],
    )[0]?.item;
  if (
    newest?.properties?.provisioningState !== 'Succeeded' ||
    newest.tags?.['cf:poc'] !== 'true' ||
    newest.tags?.['cf:managed'] !== 'true' ||
    newest.tags?.['cf:os'] !== os ||
    newest.tags?.['cf:os-version'] !== version
  )
    return false;
  const detail = await armGet<GalleryVersion>(
    `${path}/${newest.name}?${galleryApi}&%24expand=ReplicationStatus`,
    signal,
  );
  return (
    detail.properties?.provisioningState === 'Succeeded' &&
    detail.properties.replicationStatus?.summary?.some(
      replica =>
        regionId(replica.region) === location && replica.state === 'Completed',
    ) === true
  );
}
