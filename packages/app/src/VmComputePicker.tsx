import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Chip,
  Collapse,
  FormControlLabel,
  FormHelperText,
  InputAdornment,
  MenuItem,
  Radio,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Tabs,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';
import CheckCircle from '@material-ui/icons/CheckCircle';
import ExpandLess from '@material-ui/icons/ExpandLess';
import ExpandMore from '@material-ui/icons/ExpandMore';
import SearchIcon from '@material-ui/icons/Search';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';
import { createFormField } from '@backstage/plugin-scaffolder-react/alpha';
import {
  CatalogInstanceType,
  DemoRestriction,
  VmSize,
  memoryText,
  useDemoRestriction,
  useInstanceTypeCatalog,
  useVmSizes,
} from '@internal/plugin-vm-status';

type Compute = {
  platform?: string;
  os?: string;
  size?: string;
  instanceType?: string;
};
type SortKey = 'type' | 'vcpus' | 'memory';

const sizeNames: Record<string, string> = {
  XS: 'Extra small',
  S: 'Small',
  M: 'Medium',
  L: 'Large',
  XL: 'Extra large',
};
const categoryOrder = [
  'General purpose',
  'Compute optimized',
  'Memory optimized',
  'Storage optimized',
  'Accelerated computing',
  'High performance computing',
  'Other',
];
const vcpuSteps = [2, 4, 8, 16, 32, 64, 96];
const memorySteps = [1, 2, 4, 8, 16, 32, 64, 128, 256];

const useStyles = makeStyles(theme => ({
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
    gap: theme.spacing(1.5),
    marginTop: theme.spacing(1),
  },
  card: {
    display: 'block',
    textAlign: 'left',
    width: '100%',
    padding: theme.spacing(2),
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 10,
    background: theme.palette.background.paper,
    position: 'relative',
    transition: 'border-color 120ms, box-shadow 120ms',
    '&:hover': { borderColor: theme.palette.primary.light },
    '&.Mui-disabled': { opacity: 0.45 },
  },
  selected: {
    borderColor: theme.palette.primary.main,
    boxShadow: `0 0 0 1px ${theme.palette.primary.main}`,
  },
  check: {
    position: 'absolute',
    top: theme.spacing(1.5),
    right: theme.spacing(1.5),
    color: theme.palette.primary.main,
  },
  letter: { fontSize: 28, fontWeight: 800, lineHeight: 1 },
  mono: { fontFamily: '"JetBrains Mono", monospace', fontSize: 13 },
  specs: {
    margin: theme.spacing(1.5, 0, 0),
    padding: 0,
    listStyle: 'none',
    '& li': {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 13,
      padding: '3px 0',
      borderTop: `1px solid ${theme.palette.divider}`,
    },
    '& li span:first-child': { color: theme.palette.text.secondary },
  },
  advancedToggle: { marginTop: theme.spacing(1.5), textTransform: 'none' },
  filters: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1.5),
    alignItems: 'center',
    margin: theme.spacing(1.5, 0),
  },
  table: { maxHeight: 440, border: `1px solid ${theme.palette.divider}` },
  familyRow: {
    background: theme.palette.action.hover,
    fontWeight: 700,
    fontSize: 12,
    letterSpacing: 0.3,
  },
  row: { cursor: 'pointer' },
  disabledRow: { opacity: 0.45, cursor: 'not-allowed' },
}));

function allowedType(type: string, restriction?: DemoRestriction) {
  return !restriction?.enabled || restriction.allowed.includes(type);
}

function SizeCards({
  options,
  sizes,
  value,
  restriction,
  disabled,
  onSelect,
}: {
  options: string[];
  sizes: VmSize[] | undefined;
  value: string | undefined;
  restriction: DemoRestriction | undefined;
  disabled?: boolean;
  onSelect(size: string): void;
}) {
  const classes = useStyles();
  return (
    <div className={classes.cards} role="radiogroup" aria-label="Size">
      {options.map(size => {
        const info = sizes?.find(item => item.size === size);
        const blocked = !!info && !allowedType(info.instanceType, restriction);
        const selected = value === size;
        return (
          <ButtonBase
            key={size}
            role="radio"
            aria-checked={selected}
            aria-label={`${size} ${info?.instanceType ?? ''}`.trim()}
            disabled={disabled || blocked}
            className={`${classes.card} ${selected ? classes.selected : ''}`}
            onClick={() => onSelect(size)}
            focusRipple
          >
            {selected && <CheckCircle className={classes.check} />}
            <div className={classes.letter}>{size}</div>
            <Typography variant="caption" color="textSecondary">
              {sizeNames[size] ?? 'Size'}
            </Typography>
            <div className={classes.mono}>{info?.instanceType ?? '…'}</div>
            {info?.specs ? (
              <ul className={classes.specs}>
                <li>
                  <span>vCPU</span>
                  <b>{info.specs.vcpus ?? '—'}</b>
                </li>
                <li>
                  <span>Memory</span>
                  <b>{memoryText(info.specs.memoryMiB)}</b>
                </li>
                <li>
                  <span>Network</span>
                  <span>{info.specs.network ?? '—'}</span>
                </li>
                <li>
                  <span>CPU</span>
                  <span>
                    {info.specs.architectures.join('/')}
                    {info.specs.burstable ? ' · burstable' : ''}
                  </span>
                </li>
              </ul>
            ) : (
              <Typography variant="caption" display="block">
                {sizes ? 'Specs unavailable' : 'Loading specs…'}
              </Typography>
            )}
          </ButtonBase>
        );
      })}
    </div>
  );
}

function notes(item: CatalogInstanceType): string {
  return [
    item.burstable && 'Burstable',
    item.gpus && `GPU ${item.gpus}`,
    item.bareMetal && 'Bare metal',
    !item.currentGeneration && 'Previous generation',
  ]
    .filter(Boolean)
    .join(' · ');
}

function compareNatural(a: CatalogInstanceType, b: CatalogInstanceType) {
  return (
    a.family.localeCompare(b.family) ||
    (a.vcpus ?? 0) - (b.vcpus ?? 0) ||
    (a.memoryMiB ?? 0) - (b.memoryMiB ?? 0) ||
    a.type.localeCompare(b.type)
  );
}

function InstanceTypePicker({
  value,
  restriction,
  onSelect,
}: {
  value: string | undefined;
  restriction: DemoRestriction | undefined;
  onSelect(type: string): void;
}) {
  const classes = useStyles();
  const catalog = useInstanceTypeCatalog(true);
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [family, setFamily] = useState('all');
  const [minVcpu, setMinVcpu] = useState(0);
  const [minMemory, setMinMemory] = useState(0);
  const [currentOnly, setCurrentOnly] = useState(true);
  const [allowedOnly, setAllowedOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'type',
    desc: false,
  });

  const types = useMemo(() => catalog?.types ?? [], [catalog]);
  const base = useMemo(
    () =>
      types.filter(
        item =>
          (!currentOnly || item.currentGeneration) &&
          (!allowedOnly || allowedType(item.type, restriction)),
      ),
    [types, currentOnly, allowedOnly, restriction],
  );
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of base)
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    return categoryOrder
      .filter(name => counts.has(name))
      .map(name => ({ name, count: counts.get(name)! }));
  }, [base]);
  const inCategory = useMemo(
    () =>
      category === 'All'
        ? base
        : base.filter(item => item.category === category),
    [base, category],
  );
  const families = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of inCategory)
      counts.set(item.family, (counts.get(item.family) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  }, [inCategory]);
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = inCategory.filter(
      item =>
        (family === 'all' || item.family === family) &&
        (item.vcpus ?? 0) >= minVcpu &&
        (item.memoryMiB ?? 0) >= minMemory * 1024 &&
        (!query ||
          item.type.includes(query) ||
          item.category.toLowerCase().includes(query) ||
          (item.gpus ?? '').toLowerCase().includes(query)),
    );
    const direction = sort.desc ? -1 : 1;
    return filtered.sort((a, b) => {
      if (sort.key === 'vcpus')
        return (
          direction * ((a.vcpus ?? 0) - (b.vcpus ?? 0)) || compareNatural(a, b)
        );
      if (sort.key === 'memory')
        return (
          direction * ((a.memoryMiB ?? 0) - (b.memoryMiB ?? 0)) ||
          compareNatural(a, b)
        );
      return direction * compareNatural(a, b);
    });
  }, [inCategory, family, minVcpu, minMemory, search, sort]);

  // A family chosen in one category may not exist in the next.
  useEffect(() => {
    if (family !== 'all' && !families.some(([name]) => name === family))
      setFamily('all');
  }, [families, family]);

  const direction = sort.desc ? 'desc' : 'asc';
  const header = (key: SortKey, label: string, numeric = false) => (
    <TableCell
      align={numeric ? 'right' : 'left'}
      sortDirection={sort.key === key ? direction : false}
    >
      <TableSortLabel
        active={sort.key === key}
        direction={sort.key === key && sort.desc ? 'desc' : 'asc'}
        onClick={() =>
          setSort(current => ({
            key,
            desc: current.key === key ? !current.desc : false,
          }))
        }
      >
        {label}
      </TableSortLabel>
    </TableCell>
  );

  if (!catalog)
    return (
      <Typography variant="body2">Loading instance types from AWS…</Typography>
    );
  if (catalog.error)
    return <FormHelperText error>{catalog.error}</FormHelperText>;

  const body: JSX.Element[] = [];
  let lastFamily = '';
  for (const item of rows) {
    if (sort.key === 'type' && item.family !== lastFamily) {
      lastFamily = item.family;
      const count = rows.filter(row => row.family === item.family).length;
      body.push(
        <TableRow key={`family-${item.family}`}>
          <TableCell colSpan={6} className={classes.familyRow}>
            {item.family} · {item.category} · {count} type
            {count === 1 ? '' : 's'}
          </TableCell>
        </TableRow>,
      );
    }
    const blocked = !allowedType(item.type, restriction);
    const selected = value === item.type;
    body.push(
      <TableRow
        key={item.type}
        hover={!blocked}
        selected={selected}
        aria-disabled={blocked}
        title={blocked ? 'Not available while demo mode is on' : undefined}
        className={blocked ? classes.disabledRow : classes.row}
        onClick={() => !blocked && onSelect(item.type)}
      >
        <TableCell padding="checkbox">
          <Radio
            color="primary"
            size="small"
            checked={selected}
            disabled={blocked}
            inputProps={{ 'aria-label': item.type }}
            onChange={() => onSelect(item.type)}
          />
        </TableCell>
        <TableCell className={classes.mono}>{item.type}</TableCell>
        <TableCell align="right">{item.vcpus ?? '—'}</TableCell>
        <TableCell align="right">{memoryText(item.memoryMiB)}</TableCell>
        <TableCell>{item.network ?? '—'}</TableCell>
        <TableCell>
          {blocked ? 'Unavailable in demo mode' : notes(item)}
        </TableCell>
      </TableRow>,
    );
  }

  return (
    <Box mt={1}>
      <Tabs
        value={category}
        onChange={(_, next) => setCategory(next)}
        variant="scrollable"
        scrollButtons="auto"
        indicatorColor="primary"
        aria-label="Instance family types"
      >
        <Tab value="All" label={`All (${base.length})`} />
        {categories.map(item => (
          <Tab
            key={item.name}
            value={item.name}
            label={`${item.name} (${item.count})`}
          />
        ))}
      </Tabs>
      <div className={classes.filters}>
        <TextField
          size="small"
          variant="outlined"
          placeholder="Search e.g. m7i, large, NVIDIA"
          value={search}
          onChange={event => setSearch(event.target.value)}
          inputProps={{ 'aria-label': 'Search instance types' }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <TextField
          select
          size="small"
          variant="outlined"
          label="Family"
          value={family}
          onChange={event => setFamily(event.target.value)}
          style={{ minWidth: 140 }}
        >
          <MenuItem value="all">All families</MenuItem>
          {families.map(([name, count]) => (
            <MenuItem key={name} value={name}>
              {name} ({count})
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          variant="outlined"
          label="Min vCPU"
          value={minVcpu}
          onChange={event => setMinVcpu(Number(event.target.value))}
          style={{ minWidth: 110 }}
        >
          <MenuItem value={0}>Any</MenuItem>
          {vcpuSteps.map(step => (
            <MenuItem key={step} value={step}>
              {step}+
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          variant="outlined"
          label="Min memory"
          value={minMemory}
          onChange={event => setMinMemory(Number(event.target.value))}
          style={{ minWidth: 120 }}
        >
          <MenuItem value={0}>Any</MenuItem>
          {memorySteps.map(step => (
            <MenuItem key={step} value={step}>
              {step}+ GiB
            </MenuItem>
          ))}
        </TextField>
        <FormControlLabel
          control={
            <Checkbox
              color="primary"
              checked={currentOnly}
              onChange={event => setCurrentOnly(event.target.checked)}
            />
          }
          label="Current generation only"
        />
        {restriction?.enabled && (
          <FormControlLabel
            control={
              <Checkbox
                color="primary"
                checked={allowedOnly}
                onChange={event => setAllowedOnly(event.target.checked)}
              />
            }
            label="Hide types unavailable in demo mode"
          />
        )}
      </div>
      {restriction?.enabled && (
        <FormHelperText>
          Demo mode is on: only {restriction.allowed.join(', ')} can be
          requested.
        </FormHelperText>
      )}
      <TableContainer className={classes.table}>
        <Table size="small" stickyHeader aria-label="EC2 instance types">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox" />
              {header('type', 'Instance type')}
              {header('vcpus', 'vCPU', true)}
              {header('memory', 'Memory', true)}
              <TableCell>Network</TableCell>
              <TableCell>Notes</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {body.length ? (
              body
            ) : (
              <TableRow>
                <TableCell colSpan={6}>
                  No instance types match these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      <FormHelperText>
        {rows.length} of {types.length} x86_64 instance types offered in this
        region, live from AWS.
      </FormHelperText>
    </Box>
  );
}

function enumOf(schema: unknown): string[] {
  const values = (schema as { enum?: unknown } | undefined)?.enum;
  return Array.isArray(values)
    ? values.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * `ui:field: VmComputePicker` on the platform vm-request template's `compute` object.
 * Size cards (XS-L) for regular users; a collapsed "Advanced" picker for any instance type
 * offered in the region. Submits exactly one of `size` or `instanceType`.
 */
function VmComputePickerField({
  onChange,
  formData,
  schema,
  rawErrors,
  disabled,
}: FieldExtensionComponentProps<Compute>) {
  const classes = useStyles();
  const sizes = useVmSizes();
  const restriction = useDemoRestriction();
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const sizeOptions = enumOf(properties.size);
  const platforms = enumOf(properties.platform);
  const systems = enumOf(properties.os);
  const value: Compute = formData ?? {};
  const [advanced, setAdvanced] = useState(Boolean(value.instanceType));
  const base = {
    platform: value.platform ?? platforms[0],
    os: value.os ?? systems[0],
  };

  useEffect(() => {
    if (!formData?.size && !formData?.instanceType) {
      const initial = sizeOptions.includes('S') ? 'S' : sizeOptions[0];
      if (initial) onChange({ ...base, size: initial });
    }
    // Only fills an empty selection; base/onChange identity changes are irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData?.size, formData?.instanceType]);

  const custom = value.instanceType;
  const customBlocked = custom && !allowedType(custom, restriction);
  const label = (name: string, fallback: string) =>
    (properties[name] as { title?: string } | undefined)?.title ?? fallback;

  return (
    <Box my={2}>
      <Box display="flex" gridGap={16} mb={2}>
        <TextField
          select
          size="small"
          variant="outlined"
          label={label('platform', 'Platform')}
          value={base.platform ?? ''}
          disabled={disabled || platforms.length < 2}
          onChange={event =>
            onChange({ ...value, platform: event.target.value })
          }
          style={{ minWidth: 140 }}
        >
          {platforms.map(item => (
            <MenuItem key={item} value={item}>
              {item.toUpperCase()}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          variant="outlined"
          label={label('os', 'Operating system')}
          value={base.os ?? ''}
          disabled={disabled || systems.length < 2}
          onChange={event => onChange({ ...value, os: event.target.value })}
          style={{ minWidth: 160 }}
        >
          {systems.map(item => (
            <MenuItem key={item} value={item}>
              {item === 'ubuntu' ? 'Ubuntu' : item}
            </MenuItem>
          ))}
        </TextField>
      </Box>
      <Typography variant="subtitle1">
        <b>{label('size', 'Size')}</b>
      </Typography>
      <SizeCards
        options={sizeOptions}
        sizes={sizes?.sizes}
        value={custom ? undefined : value.size}
        restriction={restriction}
        disabled={disabled}
        onSelect={size => onChange({ ...base, size })}
      />
      {sizes?.error && <FormHelperText>{sizes.error}</FormHelperText>}
      {custom && (
        <Box
          mt={1.5}
          display="flex"
          alignItems="center"
          gridGap={8}
          flexWrap="wrap"
        >
          <Chip color="primary" label={`Using instance type ${custom}`} />
          <Button
            size="small"
            onClick={() =>
              onChange({
                ...base,
                size: sizeOptions.includes('S') ? 'S' : sizeOptions[0],
              })
            }
          >
            Use a size instead
          </Button>
          {customBlocked && (
            <FormHelperText error>
              Demo mode is on; {custom} cannot be requested. Pick a size or an
              allowed type.
            </FormHelperText>
          )}
        </Box>
      )}
      <Button
        className={classes.advancedToggle}
        size="small"
        onClick={() => setAdvanced(open => !open)}
        endIcon={advanced ? <ExpandLess /> : <ExpandMore />}
        aria-expanded={advanced}
      >
        Advanced: choose a specific EC2 instance type
      </Button>
      <Collapse in={advanced} unmountOnExit>
        <InstanceTypePicker
          value={custom}
          restriction={restriction}
          onSelect={instanceType => onChange({ ...base, instanceType })}
        />
      </Collapse>
      {!!rawErrors?.length && (
        <FormHelperText error>{rawErrors.join(', ')}</FormHelperText>
      )}
    </Box>
  );
}

export const VmComputePicker = createFormField({
  name: 'VmComputePicker',
  component: VmComputePickerField,
});

/** Earlier template revision put `ui:field: VmSizePicker` on `size` itself; kept compatible. */
function VmSizePickerField({
  onChange,
  formData,
  schema,
  disabled,
}: FieldExtensionComponentProps<string>) {
  const sizes = useVmSizes();
  const restriction = useDemoRestriction();
  return (
    <Box my={2}>
      <Typography variant="subtitle1">
        <b>{schema.title ?? 'Size'}</b>
      </Typography>
      <SizeCards
        options={enumOf(schema)}
        sizes={sizes?.sizes}
        value={formData}
        restriction={restriction}
        disabled={disabled}
        onSelect={onChange}
      />
    </Box>
  );
}

export const VmSizePicker = createFormField({
  name: 'VmSizePicker',
  component: VmSizePickerField,
});
