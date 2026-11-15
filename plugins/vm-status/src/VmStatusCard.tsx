import { useEffect, useState } from 'react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { InfoCard, Link } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef, useEntity } from '@backstage/plugin-catalog-react';
import {
  Box,
  Chip,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Typography,
} from '@material-ui/core';
import CheckCircle from '@material-ui/icons/CheckCircle';
import ErrorIcon from '@material-ui/icons/Error';
import HourglassEmpty from '@material-ui/icons/HourglassEmpty';
import PlayCircleOutline from '@material-ui/icons/PlayCircleOutline';
import SkipNext from '@material-ui/icons/SkipNext';

const icons: Record<string, JSX.Element> = {
  success: <CheckCircle color="primary" />,
  failed: <ErrorIcon color="error" />,
  pending: <HourglassEmpty />,
  running: <PlayCircleOutline color="primary" />,
  skipped: <SkipNext />,
};

export function VmStatusCard() {
  const { entity: initial } = useEntity();
  const api = useApi(catalogApiRef);
  const [entity, setEntity] = useState(initial);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setEntity(initial);
  }, [initial]);
  const status = entity.metadata.annotations?.['cf/status'] ?? 'unknown';
  useEffect(() => {
    if (status === 'ready' || status === 'failed') return undefined;
    let disposed = false;
    let fetching = false;
    const timer = window.setInterval(async () => {
      if (fetching) return;
      fetching = true;
      try {
        const updated = await api.getEntityByRef(stringifyEntityRef(entity));
        if (!disposed && updated) {
          setEntity(updated);
          setError(undefined);
        }
      } catch {
        if (!disposed) setError('Status refresh failed; retrying.');
      } finally {
        fetching = false;
      }
    }, 10000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [api, entity, status]);
  const annotations = entity.metadata.annotations ?? {};
  let stages: Record<string, string> = {};
  try {
    const parsed = JSON.parse(annotations['cf/stages'] ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      stages = Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
      ) as Record<string, string>;
    }
  } catch {
    /* malformed annotation */
  }
  const ip = annotations['cf/public-ip'];
  const user = annotations['cf/ssh-user'] || 'ubuntu';
  const prefill = encodeURIComponent(
    JSON.stringify({ vm: stringifyEntityRef(entity) }),
  );
  return (
    <InfoCard title="VM status">
      <Chip label={status} color={status === 'ready' ? 'primary' : 'default'} />
      {error && <Typography color="error">{error}</Typography>}
      <List dense>
        {['provision', 'baseline', 'software', 'ad-join', 'access'].map(
          stage => (
            <ListItem key={stage}>
              <ListItemIcon>
                {icons[stages[stage]] ?? icons.pending}
              </ListItemIcon>
              <ListItemText
                primary={stage}
                secondary={stages[stage] ?? 'pending'}
              />
            </ListItem>
          ),
        )}
      </List>
      <Typography>
        IP: {ip || 'Pending'} · SSH user: {user}
      </Typography>
      {ip && (
        <Box my={2}>
          <code>
            ssh {user}@{ip}
          </code>
        </Box>
      )}
      <Box my={1}>
        <Link to="/create/templates/default/ssh-cert">Get SSH certificate</Link>
      </Box>
      <Box my={1}>
        <Link to={`/create/templates/default/vm-refry?formData=${prefill}`}>
          Re-run fry stage
        </Link>
      </Box>
      <Box my={1}>
        <Link to={`/create/templates/default/vm-destroy?formData=${prefill}`}>
          Destroy VM
        </Link>
      </Box>
    </InfoCard>
  );
}
