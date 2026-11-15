import { useEffect, useState } from 'react';
import { identityApiRef, useApi } from '@backstage/core-plugin-api';
import { Select } from '@backstage/core-components';
import {
  EntityKindFilter,
  EntityKindPicker,
  useEntityList,
} from '@backstage/plugin-catalog-react';
import { Box } from '@material-ui/core';

// This is catalog navigation, not authorization. User/Group reads are still
// needed by sign-in, ownership and Scaffolder team pickers.
export function CatalogKindFilter() {
  const identity = useApi(identityApiRef);
  const [admin, setAdmin] = useState<boolean>();
  const { filters, updateFilters } = useEntityList();

  useEffect(() => {
    let mounted = true;
    identity.getBackstageIdentity().then(
      user => {
        if (mounted)
          setAdmin(
            user.ownershipEntityRefs.includes('group:default/platform-admins'),
          );
      },
      () => {
        if (mounted) setAdmin(false);
      },
    );
    return () => {
      mounted = false;
    };
  }, [identity]);

  useEffect(() => {
    // Also normalize non-Resource deep links for normal users. Do not rewrite
    // an admin's explicit URL while their identity is still being resolved.
    if (admin === false && filters.kind?.value !== 'resource') {
      updateFilters({ kind: new EntityKindFilter('resource', 'Resource') });
    }
  }, [admin, filters.kind?.value, updateFilters]);

  if (admin) return <EntityKindPicker initialFilter="resource" />;
  if (admin === undefined) return null;
  return (
    <Box pb={1} pt={1}>
      <Select
        label="Kind"
        selected="resource"
        items={[{ label: 'Resource', value: 'resource' }]}
        onChange={() => {}}
      />
    </Box>
  );
}
