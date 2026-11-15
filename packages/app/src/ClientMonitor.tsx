import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';
import { Box, Button, Typography } from '@material-ui/core';
import {
  bundleFrom,
  errorMessage,
  reportClientEvent,
  runningBundle,
  setClientLogApis,
} from './clientLog';

const checkEveryMs = 60_000;

/**
 * Mounted once at the app root. Reports uncaught browser errors to the backend log
 * and shows a reload banner when a newer frontend has been deployed. The app is a
 * single page, so an open tab otherwise keeps running the old bundle indefinitely.
 */
export function ClientMonitor() {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [latest, setLatest] = useState<string>();

  useEffect(() => {
    setClientLogApis({ discoveryApi, fetchApi });
    const onError = (event: ErrorEvent) => {
      // Benign browser noise, not an application error.
      if (event.message?.includes('ResizeObserver loop')) return;
      void reportClientEvent({
        kind: 'uncaught-error',
        message: event.message || 'Unknown error',
        detail: `${event.filename}:${event.lineno}:${event.colno}`,
      });
    };
    const onRejection = (event: PromiseRejectionEvent) =>
      void reportClientEvent({
        kind: 'unhandled-rejection',
        message: errorMessage(event.reason),
      });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [discoveryApi, fetchApi]);

  useEffect(() => {
    const running = runningBundle();
    // The dev server serves an unhashed bundle; there is nothing to compare.
    if (!running) return undefined;
    let reported = false;
    let checking = false;
    const check = async () => {
      if (document.hidden || checking) return;
      checking = true;
      try {
        // index.html is served no-store; a short request, unlike SSE, passes TLS proxies.
        const response = await fetch('/', { cache: 'no-store' });
        const deployed = response.ok
          ? bundleFrom(await response.text())
          : undefined;
        if (deployed && deployed !== running) {
          setLatest(deployed);
          if (!reported) {
            reported = true;
            void reportClientEvent({
              kind: 'stale-bundle',
              message: `Tab is running ${running}; ${deployed} is deployed`,
            });
          }
        }
      } catch {
        // Offline or deploying; the next check retries.
      } finally {
        checking = false;
      }
    };
    const timer = window.setInterval(check, checkEveryMs);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  if (!latest) return null;
  return (
    <Box
      role="status"
      position="fixed"
      top={0}
      left={0}
      right={0}
      zIndex={2000}
      display="flex"
      justifyContent="center"
      alignItems="center"
      gridGap={16}
      py={1}
      px={2}
      bgcolor="primary.main"
      color="primary.contrastText"
    >
      <Typography variant="body2">
        A new version of Compute Factory is available.
      </Typography>
      <Button
        size="small"
        variant="contained"
        onClick={() => window.location.reload()}
      >
        Reload
      </Button>
    </Box>
  );
}
