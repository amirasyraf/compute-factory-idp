import { Fragment } from 'react';
import { Link } from '@backstage/core-components';
import {
  FavoriteEntity,
  useAsyncEntity,
} from '@backstage/plugin-catalog-react';
import type {
  EntityContentLayoutProps,
  EntityHeaderLayoutProps,
} from '@backstage/plugin-catalog-react/alpha';
import { makeStyles } from '@material-ui/core';
import { useLocation } from 'react-router-dom';
import { getVmConfiguration } from './vmSpec';
import { vmColors, vmState, vmStateColor } from './pipeline';

const rule = '#E3E5E8';

const useStyles = makeStyles({
  header: {
    padding: '20px 20px 0',
    borderBottom: `1px solid ${rule}`,
  },
  crumb: {
    fontSize: 13,
    color: vmColors.mute,
    '& a': { color: vmColors.mute },
    '& a:hover': { color: vmColors.ink },
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    marginTop: 12,
    flexWrap: 'wrap',
  },
  bullet: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    color: '#fff',
    fontWeight: 800,
    fontSize: 17,
    display: 'grid',
    placeItems: 'center',
    flex: 'none',
  },
  h1: {
    fontSize: 32,
    fontWeight: 700,
    letterSpacing: '-0.025em',
    lineHeight: 1.1,
    margin: 0,
    overflowWrap: 'anywhere',
  },
  star: { marginLeft: 'auto' },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 20px',
    margin: '10px 0 0',
    padding: 0,
    listStyle: 'none',
    fontSize: 13.5,
    color: vmColors.mute,
    '& b': { color: vmColors.ink, fontWeight: 600 },
  },
  tabs: { display: 'flex', gap: 4, marginTop: 16, overflowX: 'auto' },
  tab: {
    padding: '10px 12px',
    fontSize: 14,
    fontWeight: 500,
    color: vmColors.mute,
    borderBottom: '3px solid transparent',
    marginBottom: -1,
    whiteSpace: 'nowrap',
    '&:hover': { color: vmColors.ink, textDecoration: 'none' },
  },
  tabOn: {
    color: vmColors.ink,
    fontWeight: 600,
    borderBottomColor: vmColors.blue,
  },
  spacer: { height: 16 },
  // Content cards lead; info cards follow (side column on wide screens).
  layout: {
    display: 'grid',
    gap: 24,
    gridTemplateColumns: 'minmax(0, 1fr)',
    marginTop: 24,
  },
  withInfo: {
    '@media (min-width: 1100px)': {
      gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
      alignItems: 'start',
    },
  },
  column: { display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 },
});

/** Compute Factory header for VM entity pages, in the home page's voice. */
export function VmHeaderLayout({ tabs, activeTabId }: EntityHeaderLayoutProps) {
  const classes = useStyles();
  const { entity } = useAsyncEntity();
  const { pathname } = useLocation();
  if (!entity) return <header className={classes.header} />;
  const desired = getVmConfiguration(entity.spec);
  const annotations = entity.metadata.annotations ?? {};
  // view-url when the integration set it, else the GitHub file the entity came from.
  const location = annotations['backstage.io/managed-by-origin-location'] ?? '';
  const source =
    annotations['backstage.io/view-url'] ??
    (location.startsWith('url:') ? location.slice(4) : undefined);
  const state = vmState(annotations['cf/status']);
  const flat = tabs.flatMap(tab => ('items' in tab ? tab.items : [tab]));

  return (
    <header className={classes.header}>
      <nav className={classes.crumb} aria-label="Breadcrumb">
        <Link to="/catalog">Resources</Link> / Virtual machine
      </nav>
      <div className={classes.titleRow}>
        <span
          className={classes.bullet}
          style={{ background: vmStateColor(state) }}
          title={`Size ${desired.size}`}
        >
          {desired.size === '—' ? '?' : desired.size.slice(0, 1)}
        </span>
        <h1 className={classes.h1}>
          {entity.metadata.title ?? entity.metadata.name}
        </h1>
        <span className={classes.star}>
          <FavoriteEntity entity={entity} />
        </span>
      </div>
      <ul className={classes.meta}>
        <li>
          Team <b>{desired.team}</b>
        </li>
        <li>
          {desired.os === 'ubuntu' ? 'Ubuntu' : desired.os} on{' '}
          {desired.platform.toUpperCase()} · size {desired.size}
        </li>
        {entity.spec?.lifecycle && (
          <li>
            Lifecycle <b>{String(entity.spec.lifecycle)}</b>
          </li>
        )}
        {source && (
          <li>
            <Link to={source}>View inventory source</Link>
          </li>
        )}
      </ul>
      {flat.length > 1 ? (
        <nav className={classes.tabs} aria-label="VM sections">
          {flat.map(tab => {
            const on = tab.id === activeTabId || pathname.endsWith(tab.href);
            return (
              <Link
                key={tab.id}
                to={tab.href}
                className={`${classes.tab} ${on ? classes.tabOn : ''}`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      ) : (
        <div className={classes.spacer} />
      )}
    </header>
  );
}

export function VmContentLayout({ cards }: EntityContentLayoutProps) {
  const classes = useStyles();
  const content = cards.filter(card => card.type !== 'info');
  const info = cards.filter(card => card.type === 'info');
  return (
    <div className={`${classes.layout} ${info.length ? classes.withInfo : ''}`}>
      <div className={classes.column}>
        {content.map((c, i) => (
          <Fragment key={c.element.key ?? i}>{c.element}</Fragment>
        ))}
      </div>
      {info.length > 0 && (
        <div className={classes.column}>
          {info.map((c, i) => (
            <Fragment key={c.element.key ?? i}>{c.element}</Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
