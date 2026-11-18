import { useEffect } from 'react';
import {
  Box,
  Checkbox,
  FormControlLabel,
  FormHelperText,
  Typography,
} from '@material-ui/core';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';
import { createFormField } from '@backstage/plugin-scaffolder-react/alpha';
import {
  osFamily,
  osLabel,
  usePlatforms,
  useSoftwareCatalog,
} from '@internal/plugin-vm-status';

/**
 * `ui:field: VmSoftwarePicker` on the vm-request/vm-modify `configuration.software` array: one
 * checkbox per platform repo catalog entry offered for the OS family of the form's
 * `compute.platform`/`compute.os`. Selections the OS does not offer are dropped.
 */
function VmSoftwarePickerField({
  onChange,
  formData,
  formContext,
  schema,
  rawErrors,
  disabled,
}: FieldExtensionComponentProps<string[]>) {
  const compute = (formContext?.formData?.compute ?? {}) as {
    platform?: string;
    os?: string;
  };
  const platforms = usePlatforms();
  const catalog = useSoftwareCatalog();
  const family = osFamily(compute.platform, compute.os, platforms);
  const offered = (catalog?.software ?? []).filter(
    item => family && item.families.includes(family),
  );
  const selected = formData ?? [];

  useEffect(() => {
    if (!family || !catalog?.software.length) return;
    const kept = selected.filter(id => offered.some(item => item.id === id));
    if (kept.length !== selected.length) onChange(kept);
    // Re-check only when the OS family or catalog changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family, catalog]);

  const toggle = (id: string, checked: boolean) =>
    onChange(
      checked
        ? [...selected.filter(item => item !== id), id]
        : selected.filter(item => item !== id),
    );

  return (
    <Box my={1}>
      <Typography variant="subtitle1">
        <b>{schema.title ?? 'Software'}</b>
      </Typography>
      {!catalog || !platforms ? (
        <Typography variant="body2">Loading software…</Typography>
      ) : (
        <>
          {catalog.error && (
            <FormHelperText error>{catalog.error}</FormHelperText>
          )}
          {!family && (
            <FormHelperText>
              Choose a platform and image to see the software it offers.
            </FormHelperText>
          )}
          {family && !offered.length && !catalog.error && (
            <FormHelperText>
              No software is offered for{' '}
              {osLabel(compute.platform, compute.os, platforms)}.
            </FormHelperText>
          )}
          <Box display="flex" flexWrap="wrap" gridColumnGap={16}>
            {offered.map(item => (
              <FormControlLabel
                key={item.id}
                control={
                  <Checkbox
                    color="primary"
                    checked={selected.includes(item.id)}
                    disabled={disabled}
                    onChange={event => toggle(item.id, event.target.checked)}
                  />
                }
                label={item.label}
              />
            ))}
          </Box>
        </>
      )}
      {!!rawErrors?.length && (
        <FormHelperText error>{rawErrors.join(', ')}</FormHelperText>
      )}
    </Box>
  );
}

export const VmSoftwarePicker = createFormField({
  name: 'VmSoftwarePicker',
  component: VmSoftwarePickerField,
});
