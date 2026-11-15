import type { DiscoveryApi, FetchApi } from '@backstage/frontend-plugin-api';

type ClientEvent = { kind: string; message: string; detail?: string };

let apis: { discoveryApi: DiscoveryApi; fetchApi: FetchApi } | undefined;
let sent = 0;
// Per page load; a broken page must not flood the backend log.
const maxEventsPerPage = 30;

/** The hashed bundle this tab is running, e.g. `ecad1580796d`; undefined on the dev server. */
export function runningBundle(): string | undefined {
  const script = document.querySelector<HTMLScriptElement>(
    'script[src*="/static/main."]',
  );
  return bundleFrom(script?.getAttribute('src') ?? '');
}

export function bundleFrom(html: string): string | undefined {
  return /\/static\/main\.([0-9a-f]{8,})\.js/.exec(html)?.[1];
}

export function setClientLogApis(value: typeof apis) {
  apis = value;
}

/**
 * Sends a browser-side problem to the backend log (`client-log` plugin), where it
 * appears with the user, client IP and bundle. Never throws; silently drops events
 * before sign-in or once the per-page cap is reached.
 */
export async function reportClientEvent(event: ClientEvent): Promise<void> {
  if (!apis || sent >= maxEventsPerPage) return;
  sent++;
  try {
    const base = await apis.discoveryApi.getBaseUrl('client-log');
    await apis.fetchApi.fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...event,
        page: window.location.pathname,
        bundle: runningBundle(),
      }),
      keepalive: true,
    });
  } catch {
    // Reporting must never break the page.
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
