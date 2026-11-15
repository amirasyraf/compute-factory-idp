import { ScaffolderClient } from '@backstage/plugin-scaffolder';
import type {
  LogEvent,
  ScaffolderStreamLogsOptions,
} from '@backstage/plugin-scaffolder-react';

type Options = ConstructorParameters<typeof ScaffolderClient>[0];
type LogObservable = ReturnType<ScaffolderClient['streamLogs']>;
type Observer = {
  next?(event: LogEvent): void;
  error?(error: Error): void;
  complete?(): void;
};

// Waits between consecutive failed polls; one more failure surfaces the error.
const backoffMs = [1000, 2000, 5000, 10000];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Task logs by long polling `GET /v2/tasks/:id/events` instead of the upstream SSE
 * `/eventstream`. TLS-inspecting corporate proxies (Netskope was observed) buffer the
 * never-ending SSE response, so the task page stays blank while the task runs.
 * Each poll returns as soon as new events exist (backend checks about every second)
 * or with [] after 30 seconds.
 *
 * Unlike upstream polling, network failures are retried with backoff and then
 * reported, so the task page shows an error instead of silently freezing; the
 * task page hook then reconnects from the last seen event.
 *
 * To revert to SSE: remove the `api:scaffolder` override in App.tsx and this file.
 */
export class PollingScaffolderClient extends ScaffolderClient {
  readonly #options: Options;

  constructor(options: Options) {
    super(options);
    this.#options = options;
  }

  streamLogs({ taskId, after }: ScaffolderStreamLogsOptions): LogObservable {
    const { discoveryApi } = this.#options;
    const fetchApi = this.#options.fetchApi ?? {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, init),
    };

    const poll = async (observer: Observer, signal: AbortSignal) => {
      let lastId = after;
      let failures = 0;
      while (!signal.aborted) {
        try {
          const base = await discoveryApi.getBaseUrl('scaffolder');
          const query = lastId === undefined ? '' : `?after=${lastId}`;
          const response = await fetchApi.fetch(
            `${base}/v2/tasks/${encodeURIComponent(taskId)}/events${query}`,
            { signal },
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const events = (await response.json()) as LogEvent[];
          failures = 0;
          for (const event of events) {
            if (signal.aborted) return;
            lastId = Number(event.id);
            observer.next?.(event);
            if (event.type === 'completion') {
              observer.complete?.();
              return;
            }
          }
        } catch (error) {
          if (signal.aborted) return;
          if (failures >= backoffMs.length) {
            observer.error?.(
              new Error(
                `Task updates failed after ${failures + 1} attempts (${
                  error instanceof Error ? error.message : String(error)
                }); retrying`,
              ),
            );
            return;
          }
          await sleep(backoffMs[failures++], signal);
        }
      }
    };

    const observable: LogObservable = {
      [Symbol.observable]: () => observable,
      subscribe(
        first?: Observer | ((event: LogEvent) => void),
        error?: (error: Error) => void,
        complete?: () => void,
      ) {
        const observer: Observer =
          typeof first === 'function'
            ? { next: first, error, complete }
            : first ?? {};
        const controller = new AbortController();
        void poll(observer, controller.signal).finally(() =>
          controller.abort(),
        );
        return {
          unsubscribe: () => controller.abort(),
          get closed() {
            return controller.signal.aborted;
          },
        };
      },
    };
    return observable;
  }
}
