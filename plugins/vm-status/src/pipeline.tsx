import { makeStyles } from '@material-ui/core';

export type PipelineStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped';

export const PROCESS_ORDER = [
  'validate',
  'register',
  'provision',
  'fry-baseline',
  'fry-software',
  'fry-ad-join',
  'fry-access',
  'finalize',
  'on-failure',
] as const;

export type ProcessName = (typeof PROCESS_ORDER)[number];

/** The eight stations of the line; failure handling is a branch, not a station. */
export const STATIONS: { process: ProcessName; label: string }[] = [
  { process: 'validate', label: 'Validate' },
  { process: 'register', label: 'Register' },
  { process: 'provision', label: 'Provision' },
  { process: 'fry-baseline', label: 'Baseline' },
  { process: 'fry-software', label: 'Software' },
  { process: 'fry-ad-join', label: 'AD join' },
  { process: 'fry-access', label: 'Access' },
  { process: 'finalize', label: 'Finalize' },
];

const validStatuses = new Set<PipelineStatus>([
  'pending',
  'running',
  'success',
  'failed',
  'skipped',
]);

function parseStatuses(
  value: string | undefined,
): Record<string, PipelineStatus> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, status]) =>
        validStatuses.has(status as PipelineStatus),
      ),
    ) as Record<string, PipelineStatus>;
  } catch {
    return {};
  }
}

function getFailureProcessStatus(status: string | undefined): PipelineStatus {
  if (status === 'failed') return 'success';
  if (status === 'ready') return 'skipped';
  return 'pending';
}

/**
 * Converts the five legacy stage annotations into the complete workflow view.
 * This keeps already-registered VMs readable while new inventory entries expose
 * the explicit cf/processes annotation.
 */
export function getPipelineProcesses(
  annotations: Record<string, string>,
): Record<ProcessName, PipelineStatus> {
  const stages = parseStatuses(annotations['cf/stages']);
  const recorded = parseStatuses(annotations['cf/processes']);
  const processStageMap: Record<string, string> = {
    provision: 'provision',
    'fry-baseline': 'baseline',
    'fry-software': 'software',
    'fry-ad-join': 'ad-join',
    'fry-access': 'access',
  };
  const fallback = Object.fromEntries(
    PROCESS_ORDER.map(process => {
      if (process === 'validate' || process === 'register') {
        return [process, 'success'];
      }
      if (process === 'finalize') {
        return [
          process,
          annotations['cf/status'] === 'ready' ? 'success' : 'pending',
        ];
      }
      if (process === 'on-failure') {
        return [process, getFailureProcessStatus(annotations['cf/status'])];
      }
      return [process, stages[processStageMap[process]] ?? 'pending'];
    }),
  ) as Record<ProcessName, PipelineStatus>;

  return Object.fromEntries(
    PROCESS_ORDER.map(process => [
      process,
      recorded[process] ?? fallback[process],
    ]),
  ) as Record<ProcessName, PipelineStatus>;
}

export function statusLabel(status: PipelineStatus): string {
  switch (status) {
    case 'success':
      return 'Completed';
    case 'running':
      return 'In progress';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'Skipped';
    default:
      return 'Waiting';
  }
}

export type VmState = 'ready' | 'building' | 'failed' | 'destroying' | 'other';

export const vmColors = {
  ink: '#111316',
  mute: '#5D636B',
  blue: '#0B5FD3',
  green: '#00935A',
  red: '#E8402E',
  redText: '#C2321F',
  grey: '#9AA0A7',
  track: '#D5D8DC',
};

export function vmState(status: string | undefined): VmState {
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  if (status === 'destroying') return 'destroying';
  if (status === 'provisioning' || status === 'frying') return 'building';
  return 'other';
}

export function vmStateColor(state: VmState): string {
  if (state === 'ready') return vmColors.green;
  if (state === 'failed') return vmColors.red;
  if (state === 'building') return vmColors.blue;
  return vmColors.grey;
}

/** The stop that needs attention: the failed one, else the running one. */
export function activeStation(
  processes: Record<ProcessName, PipelineStatus>,
): { label: string; status: PipelineStatus; index: number } | undefined {
  const index =
    STATIONS.findIndex(s => processes[s.process] === 'failed') >= 0
      ? STATIONS.findIndex(s => processes[s.process] === 'failed')
      : STATIONS.findIndex(s => processes[s.process] === 'running');
  if (index < 0) return undefined;
  const { process, label } = STATIONS[index];
  return { label, status: processes[process], index };
}

/** Short human summary of where a VM is on the line. */
export function vmStateLabel(
  status: string | undefined,
  processes: Record<ProcessName, PipelineStatus>,
): string {
  const state = vmState(status);
  const failed = STATIONS.find(s => processes[s.process] === 'failed');
  const running = STATIONS.find(s => processes[s.process] === 'running');
  if (state === 'ready') return 'Ready';
  if (state === 'failed')
    return failed ? `Failed at ${failed.label}` : 'Failed';
  if (state === 'destroying') return 'Destroying';
  if (state === 'building') {
    if (status === 'provisioning' && !running) return 'Provisioning';
    return running ? `Building · ${running.label}` : 'Building';
  }
  return status ? status[0].toUpperCase() + status.slice(1) : 'Unknown';
}

const useStyles = makeStyles({
  line: {
    display: 'grid',
    gridTemplateColumns: `repeat(${STATIONS.length}, minmax(0, 1fr))`,
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  station: {
    position: 'relative',
    textAlign: 'center',
    fontSize: 10.5,
    lineHeight: 1.3,
    color: '#8A9098',
    paddingTop: 22,
    // Track segment arriving at this station.
    '&::before': {
      content: '""',
      position: 'absolute',
      top: 8,
      left: '-50%',
      right: '50%',
      height: 2,
      background: vmColors.track,
      zIndex: 0,
    },
    '&:first-child::before': { display: 'none' },
    // Terminus: the last station is a squared cap, not a dot.
    '&:last-child::after': { borderRadius: 3 },
    // Station dot.
    '&::after': {
      content: '""',
      position: 'absolute',
      top: 3,
      left: '50%',
      width: 12,
      height: 12,
      marginLeft: -6,
      borderRadius: '50%',
      background: '#fff',
      border: '2px solid #C9CDD2',
      boxSizing: 'border-box',
      zIndex: 1,
    },
  },
  done: {
    color: vmColors.ink,
    '&::before': { background: vmColors.blue, height: 5, top: 7 },
    '&::after': { border: `3px solid ${vmColors.blue}` },
  },
  // Non-stop: the line runs straight through with only a tick, no stop.
  skipped: {
    color: '#8A9098',
    fontStyle: 'italic',
    '&::before': { background: vmColors.blue, height: 5, top: 7 },
    '&::after': {
      width: 2,
      height: 13,
      marginLeft: -1,
      top: 3,
      border: 0,
      borderRadius: 0,
      background: vmColors.blue,
    },
  },
  current: {
    color: vmColors.blue,
    fontWeight: 700,
    '&::before': { background: vmColors.blue, height: 5, top: 7 },
    '&::after': {
      width: 16,
      height: 16,
      marginLeft: -8,
      top: 1,
      border: `4px solid ${vmColors.blue}`,
      boxShadow: `0 0 0 3px #fff, 0 0 0 5px rgba(11,95,211,.35)`,
      animation: '$halo 2.4s cubic-bezier(0.16, 1, 0.3, 1) infinite',
    },
  },
  failed: {
    color: vmColors.redText,
    fontWeight: 700,
    '&::before': { background: vmColors.blue, height: 5, top: 7 },
    '&::after': {
      width: 16,
      height: 16,
      marginLeft: -8,
      top: 1,
      border: 0,
      background: `${vmColors.red} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M5 5l6 6M11 5l-6 6' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") center/16px no-repeat`,
    },
  },
  retired: {
    color: '#B0B5BB',
    '&::before': { background: vmColors.track, height: 5, top: 7 },
    '&::after': { border: '3px solid #C9CDD2' },
  },
  '@keyframes halo': {
    '0%': { boxShadow: '0 0 0 3px #fff, 0 0 0 4px rgba(11,95,211,.45)' },
    '70%': { boxShadow: '0 0 0 3px #fff, 0 0 0 9px rgba(11,95,211,0)' },
    '100%': { boxShadow: '0 0 0 3px #fff, 0 0 0 9px rgba(11,95,211,0)' },
  },
  '@media (prefers-reduced-motion: reduce)': {
    current: { '&::after': { animation: 'none' } },
  },
  label: {
    display: 'block',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  large: {
    fontSize: 12.5,
    paddingTop: 26,
    color: vmColors.mute,
  },
  // Narrow screens keep only the label that matters: the running or failed stop.
  '@media (max-width: 600px)': {
    label: { visibility: 'hidden' },
    current: { '& $label': { visibility: 'visible', overflow: 'visible' } },
    failed: { '& $label': { visibility: 'visible', overflow: 'visible' } },
  },
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  },
});

/**
 * The build pipeline drawn as a transit line: travelled track in line blue,
 * the running station haloed, a failed station marked red.
 */
export function PipelineLine({
  processes,
  retired = false,
  showLabels = true,
  size = 'small',
}: {
  processes: Record<ProcessName, PipelineStatus>;
  retired?: boolean;
  showLabels?: boolean;
  size?: 'small' | 'large';
}) {
  const classes = useStyles();
  return (
    <ol className={classes.line} aria-label="Pipeline stages">
      {STATIONS.map(({ process, label }) => {
        const status = processes[process];
        let variant = '';
        if (retired) variant = classes.retired;
        else if (status === 'success') variant = classes.done;
        else if (status === 'skipped') variant = classes.skipped;
        else if (status === 'running') variant = classes.current;
        else if (status === 'failed') variant = classes.failed;
        return (
          <li
            key={process}
            className={`${classes.station} ${
              size === 'large' ? classes.large : ''
            } ${variant}`}
            title={`${label}: ${
              status === 'skipped'
                ? 'Skipped (not requested)'
                : statusLabel(status)
            }`}
          >
            <span className={showLabels ? classes.label : classes.srOnly}>
              {label}
            </span>
            <span className={classes.srOnly}>, {statusLabel(status)}</span>
          </li>
        );
      })}
    </ol>
  );
}
