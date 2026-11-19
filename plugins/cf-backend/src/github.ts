export const repository = 'amirasyraf/vendy-platform';
const api = `https://api.github.com/repos/${repository}`;

export class GitHubError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`GitHub API HTTP ${status}: ${detail}`);
  }
}

// A deliberate refusal (bad input, missing workflow, auth), as opposed to a rate limit,
// GitHub 5xx or network failure, whose outcome is unknown or transient.
export const rejected = (error: unknown) =>
  error instanceof GitHubError &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 429 &&
  !/rate limit/i.test(error.message);

export const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Unknown error';

export const runHtmlUrl = (id: string | number) =>
  `https://github.com/${repository}/actions/runs/${id}`;

// Conditional GETs: frequent polls mostly get 304s, which do not count against
// GitHub's hourly rate limit. Bounded; cleared when it grows too large.
const etags = new Map<string, { etag: string; body: unknown }>();

export async function github<T>(
  path: string,
  body?: unknown,
): Promise<T | undefined> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required for VM automation');
  const cached = body === undefined ? etags.get(path) : undefined;
  const response = await fetch(`${api}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(cached ? { 'If-None-Match': cached.etag } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (response.status === 304 && cached) return cached.body as T;
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new GitHubError(
      response.status,
      `${failure.message ?? 'no message'} (${path.split('?')[0]}, request ${
        response.headers.get('x-github-request-id') ?? 'unknown'
      })`,
    );
  }
  if (response.status === 204) return undefined;
  const result = (await response.json().catch(() => undefined)) as T;
  const etag = response.headers.get('etag');
  if (body === undefined && etag) {
    if (etags.size > 2000) etags.clear();
    etags.set(path, { etag, body: result });
  }
  return result;
}

// Bounded concurrency instead of one request per row in series.
export async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        results[current] = await fn(items[current]);
      }
    }),
  );
  return results;
}
