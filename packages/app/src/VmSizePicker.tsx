import {
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  Radio,
  RadioGroup,
} from '@material-ui/core';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';
import { createFormField } from '@backstage/plugin-scaffolder-react/alpha';
import { describeSpecs, useVmSizes } from '@internal/plugin-vm-status';

/**
 * `ui:field: VmSizePicker` (platform vm-request template). The value stays S/M/L; each
 * option shows the instance type from the platform's sizes.json and live AWS specs.
 */
function VmSizePickerField({
  onChange,
  formData,
  schema,
  rawErrors,
  required,
  disabled,
}: FieldExtensionComponentProps<string>) {
  const state = useVmSizes();
  const options = Array.isArray(schema.enum)
    ? schema.enum.filter((item): item is string => typeof item === 'string')
    : state?.sizes.map(item => item.size) ?? [];
  return (
    <FormControl
      component="fieldset"
      margin="normal"
      required={required}
      error={!!rawErrors?.length}
      disabled={disabled}
    >
      <FormLabel component="legend">{schema.title ?? 'Size'}</FormLabel>
      <RadioGroup
        value={formData ?? ''}
        onChange={event => onChange(event.target.value)}
      >
        {options.map(size => {
          const info = state?.sizes.find(item => item.size === size);
          const detail = info
            ? [info.instanceType, info.specs && describeSpecs(info.specs)]
                .filter(Boolean)
                .join(' · ')
            : '';
          return (
            <FormControlLabel
              key={size}
              value={size}
              control={<Radio color="primary" />}
              label={
                <span>
                  <b>{size}</b>
                  {detail && ` — ${detail}`}
                </span>
              }
            />
          );
        })}
      </RadioGroup>
      {!state && <FormHelperText>Loading instance types…</FormHelperText>}
      {state?.error && <FormHelperText>{state.error}</FormHelperText>}
    </FormControl>
  );
}

export const VmSizePicker = createFormField({
  name: 'VmSizePicker',
  component: VmSizePickerField,
});
