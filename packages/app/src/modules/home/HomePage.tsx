import { useEffect, useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { Link } from '@backstage/core-components';
import { identityApiRef, useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { makeStyles } from '@material-ui/core';
import {
  getVmConfiguration,
  platformLabel,
  runVmStatus,
  usePlatforms,
  useRunSummary,
  vmColors,
  vmRunLabel,
  vmState,
  vmStateColor,
} from '@internal/plugin-vm-status';
import { errorMessage, reportClientEvent } from '../../clientLog';
import {
  categories,
  productOf,
  productPath,
  products,
} from '../../products/catalog';

const useStyles = makeStyles({
  root: {
    padding: '32px 20px 48px',
    '@media (max-width: 760px)': { padding: '24px 16px 40px' },
  },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 16,
    justifyContent: 'space-between',
  },
  h1: { fontSize: 32, fontWeight: 700, lineHeight: 1.1, margin: 0 },
  sub: { color: vmColors.mute, fontSize: 14, margin: '8px 0 0' },
  launch: {
    background: vmColors.blue,
    color: '#fff',
    borderRadius: 6,
    padding: '10px 16px',
    fontWeight: 600,
    alignSelf: 'center',
    '&:hover': { background: '#0A4FB0', textDecoration: 'none' },
  },
  resources: { marginTop: 32 },
  category: { marginTop: 24 },
  categoryTitle: { fontSize: 15, color: vmColors.mute, margin: '0 0 10px' },
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 400px), 1fr))',
    gap: 16,
  },
  card: { border: '1px solid #E3E5E8', borderRadius: 8, padding: '16px 18px' },
  cardHead: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  cardTitle: { margin: 0, fontSize: 18, color: vmColors.ink },
  count: { color: vmColors.mute, fontSize: 13 },
  list: { padding: 0, margin: '10px 0', listStyle: 'none' },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'baseline',
    gap: '3px 16px',
    padding: '10px 0',
    borderTop: '1px solid #E3E5E8',
    fontSize: 14,
    overflowWrap: 'anywhere',
    '@media (max-width: 550px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  rowFacts: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 14px',
    color: vmColors.mute,
    fontSize: 13,
  },
  dot: {
    display: 'inline-block',
    borderRadius: '50%',
    width: 7,
    height: 7,
    marginRight: 5,
  },
  footer: { fontSize: 14, fontWeight: 600 },
});

const displayName = (entity: Entity) =>
  entity.metadata.title ?? entity.metadata.name;
function currentGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 18) return 'Good Afternoon';
  return 'Good Evening';
}

const entityPath = ({ metadata }: Entity) =>
  `/catalog/${encodeURIComponent(
    metadata.namespace ?? 'default',
  )}/resource/${encodeURIComponent(metadata.name)}`;

function VmRows({ entities }: { entities: Entity[] }) {
  const classes = useStyles();
  const platforms = usePlatforms();
  const { runs, observed, error } = useRunSummary();
  return (
    <>
      {error && (
        <p className={classes.sub}>
          Live VM status unavailable. Showing catalog status.
        </p>
      )}
      <ul className={classes.list}>
        {entities.map(entity => {
          const { name } = entity.metadata;
          const status = entity.metadata.annotations?.['cf/status'];
          const state = vmState(
            runVmStatus(runs[name], status, observed[name]),
          );
          return (
            <li key={entityPath(entity)} className={classes.row}>
              <Link to={entityPath(entity)}>{displayName(entity)}</Link>
              <span className={classes.rowFacts}>
                <span>
                  {platformLabel(
                    getVmConfiguration(entity.spec).platform,
                    platforms,
                  )}
                </span>
                <span>
                  <i
                    aria-hidden="true"
                    className={classes.dot}
                    style={{ backgroundColor: vmStateColor(state) }}
                  />
                  {vmRunLabel(runs[name], status, observed[name])}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function ResourceRows({ entities }: { entities: Entity[] }) {
  const classes = useStyles();
  return (
    <ul className={classes.list}>
      {entities.map(entity => (
        <li key={entityPath(entity)} className={classes.row}>
          <Link to={entityPath(entity)}>{displayName(entity)}</Link>
          {typeof entity.spec?.type === 'string' && (
            <span className={classes.rowFacts}>{entity.spec.type}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function HomePage() {
  const classes = useStyles();
  const catalog = useApi(catalogApiRef);
  const identity = useApi(identityApiRef);
  const [resources, setResources] = useState<Entity[]>();
  const [error, setError] = useState<string>();
  const [name, setName] = useState<string>();
  const [teams, setTeams] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    Promise.all([identity.getProfileInfo(), identity.getBackstageIdentity()])
      .then(([profile, user]) => {
        if (!active) return;
        setName(profile.displayName ?? user.userEntityRef.split('/').pop());
        setTeams(
          user.ownershipEntityRefs
            .filter(
              ref =>
                ref.startsWith('group:default/') &&
                ref !== 'group:default/platform-admins',
            )
            .map(ref => ref.slice('group:default/'.length))
            .map(team => team.charAt(0).toUpperCase() + team.slice(1)),
        );
      })
      .catch(e =>
        reportClientEvent({
          kind: 'identity-load-failed',
          message: errorMessage(e),
          detail: 'home page',
        }),
      );
    return () => {
      active = false;
    };
  }, [identity]);

  useEffect(() => {
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await catalog.getEntities({
          filter: { kind: 'Resource' },
        });
        if (active) {
          setResources(
            [...result.items].sort((a, b) =>
              displayName(a).localeCompare(displayName(b)),
            ),
          );
          setError(undefined);
        }
      } catch (e) {
        if (active) setError(errorMessage(e));
      } finally {
        loading = false;
      }
    };
    load();
    const timer = window.setInterval(load, 10000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [catalog]);

  const other = resources?.filter(entity => !productOf(entity)) ?? [];
  const resourceCount = (count: number) =>
    `${count} ${count === 1 ? 'resource' : 'resources'}`;
  return (
    <main className={classes.root}>
      <header className={classes.head}>
        <div>
          <h1 className={classes.h1}>
            {currentGreeting()}
            {name && `, ${name}`}
          </h1>
          {!!teams.length && (
            <p className={classes.sub}>Team {teams.join(', ')}</p>
          )}
        </div>
        <Link to="/launch" className={classes.launch}>
          Launch a Product
        </Link>
      </header>
      <section className={classes.resources} aria-labelledby="your-resources">
        <div className={classes.cardHead}>
          <div>
            <h2 id="your-resources" className={classes.cardTitle}>
              Your Resources
            </h2>
            <p className={classes.sub}>
              See the resources you can access across products and platforms.
            </p>
          </div>
          <Link to="/catalog">Browse All Resources</Link>
        </div>
        {error && <p role="alert">Could not load resources: {error}</p>}
        {!resources && !error && <p role="status">Loading resources…</p>}
        {resources &&
          categories.map(category => (
            <section key={category.id} className={classes.category}>
              <h3 className={classes.categoryTitle}>{category.title}</h3>
              <div className={classes.cards}>
                {products
                  .filter(product => product.category === category.id)
                  .map(product => {
                    const entities = resources.filter(
                      entity => productOf(entity) === product,
                    );
                    const Rows =
                      product.resourceType === 'vm' ? VmRows : ResourceRows;
                    return (
                      <article key={product.id} className={classes.card}>
                        <div className={classes.cardHead}>
                          <h4 className={classes.cardTitle}>
                            <Link to={productPath(product)}>
                              {product.title}
                            </Link>
                          </h4>
                          <span className={classes.count}>
                            {resourceCount(entities.length)}
                          </span>
                        </div>
                        {entities.length > 0 ? (
                          <Rows entities={entities} />
                        ) : (
                          <p className={classes.sub}>
                            No resources in this product yet.
                          </p>
                        )}
                        <p className={classes.footer}>
                          <Link to={productPath(product)}>
                            View All {product.title}
                          </Link>
                        </p>
                      </article>
                    );
                  })}
              </div>
            </section>
          ))}
        {other.length > 0 && (
          <section className={`${classes.category} ${classes.card}`}>
            <h3 className={classes.cardTitle}>Other Resources</h3>
            <ResourceRows entities={other} />
            <Link to="/catalog">View All Resources</Link>
          </section>
        )}
      </section>
    </main>
  );
}
