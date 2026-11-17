import { createContext, ReactNode, useContext } from 'react';
import { Entity } from '@backstage/catalog-model';
import { Link, TableColumn } from '@backstage/core-components';
import {
  CatalogTable,
  CatalogTableColumnsFunc,
  CatalogTableRow,
} from '@backstage/plugin-catalog';
import {
  CatalogFilterLayout,
  EntityListPagination,
  EntityListProvider,
} from '@backstage/plugin-catalog-react';
import {
  PipelineLine,
  runProcesses,
  runStations,
  runVmStatus,
  useRunSummary,
  RunView,
  vmColors,
  vmState,
  vmStateColor,
  vmStateLabel,
} from '@internal/plugin-vm-status';
import { makeStyles } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';

const REQUEST_VM = '/create/templates/default/vm-request';
const RunsContext = createContext<Record<string, RunView>>({});

const isVm = (entity: Entity) =>
  entity.kind.toLowerCase() === 'resource' && entity.spec?.type === 'vm';

const useStyles = makeStyles({
  root: {
    padding: '32px 20px 48px',
    '@media (max-width: 760px)': { padding: '24px 16px 40px' },
  },
  head: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 24,
    flexWrap: 'wrap',
    marginBottom: 28,
  },
  h1: {
    fontSize: 32,
    fontWeight: 700,
    letterSpacing: '-0.025em',
    lineHeight: 1.1,
    margin: 0,
  },
  sub: { color: vmColors.mute, fontSize: 14, marginTop: 8 },
  primary: {
    height: 40,
    padding: '0 16px',
    borderRadius: 6,
    background: vmColors.blue,
    color: '#fff',
    fontWeight: 600,
    fontSize: 14,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    '& svg': { fontSize: 18 },
    '&:hover': { background: '#0A52B8', textDecoration: 'none' },
  },
  state: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  dot: { width: 9, height: 9, borderRadius: '50%', flex: 'none' },
  line: { width: 300, marginTop: -6 },
});

function VmStateCell({ entity }: { entity: Entity }) {
  const classes = useStyles();
  const annotations = entity.metadata.annotations ?? {};
  const run = useContext(RunsContext)[entity.metadata.name];
  const status = runVmStatus(run, annotations['cf/status']);
  const state = vmState(status);
  return (
    <span
      className={classes.state}
      style={state === 'failed' ? { color: vmColors.redText } : undefined}
    >
      <i className={classes.dot} style={{ background: vmStateColor(state) }} />
      {vmStateLabel(status, runProcesses(run), runStations(run))}
    </span>
  );
}

function VmLineCell({ entity }: { entity: Entity }) {
  const classes = useStyles();
  const annotations = entity.metadata.annotations ?? {};
  const run = useContext(RunsContext)[entity.metadata.name];
  if (!run) return <span>No run known</span>;
  return (
    <div className={classes.line}>
      <PipelineLine
        processes={runProcesses(run)}
        stations={runStations(run)}
        retired={
          vmState(runVmStatus(run, annotations['cf/status'])) === 'destroying'
        }
        showLabels={false}
      />
    </div>
  );
}

const vmColumns = (
  runs: Record<string, RunView>,
): TableColumn<CatalogTableRow>[] => [
  CatalogTable.columns.createTitleColumn({ hidden: true }),
  {
    ...CatalogTable.columns.createNameColumn({ defaultKind: 'resource' }),
    cellStyle: { whiteSpace: 'nowrap' },
  },
  {
    title: 'State',
    customSort: (a, b) =>
      String(
        runVmStatus(
          runs[a.entity.metadata.name],
          a.entity.metadata.annotations?.['cf/status'],
        ) ?? '',
      ).localeCompare(
        String(
          runVmStatus(
            runs[b.entity.metadata.name],
            b.entity.metadata.annotations?.['cf/status'],
          ) ?? '',
        ),
      ),
    render: ({ entity }) => <VmStateCell entity={entity} />,
  },
  {
    title: 'Pipeline',
    sorting: false,
    render: ({ entity }) => <VmLineCell entity={entity} />,
  },
  CatalogTable.columns.createOwnerColumn(),
  CatalogTable.columns.createSpecLifecycleColumn(),
];

/**
 * Replaces the stock catalog page shell only. Filters (including the custom
 * Kind filter) still come from the page's `catalog-filter` extension inputs,
 * and the stock CatalogTable keeps search, sorting and paging.
 */
export function CatalogPage({
  filters,
  pagination,
}: {
  filters: ReactNode;
  pagination: EntityListPagination;
}) {
  const classes = useStyles();
  const { runs, error } = useRunSummary();
  // VM lists get state and pipeline columns; every other list keeps the stock set.
  const columns: CatalogTableColumnsFunc = context =>
    context.entities.length > 0 && context.entities.every(isVm)
      ? vmColumns(runs)
      : CatalogTable.defaultColumnsFunc(context);
  return (
    <RunsContext.Provider value={runs}>
      <EntityListProvider pagination={pagination}>
        <div className={classes.root}>
          <div className={classes.head}>
            <div>
              <h1 className={classes.h1}>Resources</h1>
              <div className={classes.sub}>
                Each virtual machine with its state and pipeline position.
              </div>
            </div>
            <Link to={REQUEST_VM} className={classes.primary}>
              <AddIcon />
              Request VM
            </Link>
          </div>
          {error && (
            <p role="alert">
              Run summary unavailable: {error}. Showing catalog status.
            </p>
          )}
          <CatalogFilterLayout>
            <CatalogFilterLayout.Filters>{filters}</CatalogFilterLayout.Filters>
            <CatalogFilterLayout.Content>
              <CatalogTable columns={columns} />
            </CatalogFilterLayout.Content>
          </CatalogFilterLayout>
        </div>
      </EntityListProvider>
    </RunsContext.Provider>
  );
}
