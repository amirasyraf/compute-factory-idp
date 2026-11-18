import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { ClientCertificateCredential } from '@azure/identity';

// ARM REST api-versions (learn.microsoft.com/rest/api; checked against the subscription).
export const ARM_VERSIONS = {
  skus: '2021-07-01',
  compute: '2026-04-01',
  network: '2026-01-01',
  health: '2026-07-01',
};
const arm = 'https://management.azure.com';
const readerTtlMs = 60 * 60 * 1000;

type Reader = {
  subscriptionId: string;
  location: string;
  credential: ClientCertificateCredential;
};
let reader: { at: number; value: Promise<Reader> } | undefined;

/** Azure features run only where the Reader credential's secret is configured. */
export const azureConfigured = () =>
  Boolean(process.env.AZURE_READER_SECRET_ID);

async function loadReader(): Promise<Reader> {
  const secretId = process.env.AZURE_READER_SECRET_ID;
  if (!secretId)
    throw new Error('Azure is not configured (AZURE_READER_SECRET_ID unset)');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
  let value: Record<string, unknown>;
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    try {
      value = JSON.parse(result.SecretString ?? '');
    } catch {
      // Never echo the parser's message: it quotes the secret.
      throw new Error('Azure reader secret is not valid JSON');
    }
  } finally {
    client.destroy();
  }
  for (const key of [
    'tenantId',
    'clientId',
    'subscriptionId',
    'location',
    'certificatePem',
  ])
    if (typeof value[key] !== 'string' || !value[key])
      throw new Error(`Azure reader secret has no ${key}`);
  const subscriptionId = String(value.subscriptionId);
  const location = String(value.location);
  if (
    !/^[0-9a-fA-F-]{36}$/.test(subscriptionId) ||
    !/^[a-z0-9]+$/.test(location)
  )
    throw new Error(
      'Azure reader secret has an invalid subscription or location',
    );
  return {
    subscriptionId,
    location,
    credential: new ClientCertificateCredential(
      String(value.tenantId),
      String(value.clientId),
      { certificate: String(value.certificatePem) },
    ),
  };
}

/** The Reader service principal (secret re-read hourly; failures are retried on the next call). */
export function azureReader(): Promise<Reader> {
  if (!reader || Date.now() - reader.at > readerTtlMs) {
    const value = loadReader();
    reader = { at: Date.now(), value };
    value.catch(() => {
      if (reader?.value === value) reader = undefined;
    });
  }
  return reader.value;
}

/** Every item of a subscription-scoped ARM list (`path` after `/subscriptions/<id>`), following `nextLink`. */
export async function armList<T>(path: string): Promise<T[]> {
  const { credential, subscriptionId } = await azureReader();
  const items: T[] = [];
  let url: string | undefined = `${arm}/subscriptions/${subscriptionId}${path}`;
  for (let page = 0; url; page++) {
    if (page >= 100 || !url.startsWith(`${arm}/`))
      throw new Error('Unexpected ARM pagination');
    const token = await credential.getToken(`${arm}/.default`);
    if (!token) throw new Error('No Azure access token');
    const response: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token.token}` },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    const body = (await response.json().catch(() => ({}))) as {
      value?: T[];
      nextLink?: string;
      error?: { code?: string; message?: string };
    };
    if (!response.ok)
      throw new Error(
        `Azure ARM HTTP ${response.status}: ${body.error?.code ?? ''} ${
          body.error?.message ?? ''
        } (${path.split('?')[0]}, request ${
          response.headers.get('x-ms-request-id') ?? 'unknown'
        })`,
      );
    items.push(...(body.value ?? []));
    url = body.nextLink;
  }
  return items;
}
