import { ReactNode, useEffect, useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { Link } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import {
  ButtonBase,
  MenuItem,
  Radio,
  TextField,
  makeStyles,
} from '@material-ui/core';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';
import {
  PlatformInfo,
  usePlatforms,
  vmColors,
} from '@internal/plugin-vm-status';
import { errorMessage } from '../clientLog';

// Templates tagged `product` are what can be launched. With `cf/launch-flow: platform-image`
// the platform and image are chosen here as cards and passed to the template as
// `?formData={"compute":{platform, os}}`; other products open their template directly.
const PRODUCT_TAG = 'product';
const FLOW = 'cf/launch-flow';
const templateUrl = (entity: Entity, formData?: object) =>
  `/create/templates/${entity.metadata.namespace ?? 'default'}/${
    entity.metadata.name
  }${
    formData ? `?formData=${encodeURIComponent(JSON.stringify(formData))}` : ''
  }`;

const useStyles = makeStyles(theme => ({
  root: {
    padding: '32px 20px 48px',
    maxWidth: 1200,
    '@media (max-width: 760px)': { padding: '24px 16px 40px' },
  },
  steps: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    margin: 0,
    padding: 0,
    listStyle: 'none',
    fontSize: 13,
    color: vmColors.mute,
    '& li + li::before': { content: '"›"', marginRight: 8 },
  },
  current: { color: vmColors.ink, fontWeight: 700 },
  h1: {
    fontSize: 32,
    fontWeight: 700,
    letterSpacing: '-0.025em',
    lineHeight: 1.1,
    margin: '16px 0 8px',
  },
  sub: { color: vmColors.mute, fontSize: 14, marginBottom: 28 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: 16,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    textAlign: 'left',
    padding: '20px 22px',
    minHeight: 120,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 10,
    background: theme.palette.background.paper,
    transition: 'border-color 120ms, box-shadow 120ms',
    '&:hover': { borderColor: vmColors.blue },
    '&.Mui-disabled': { opacity: 0.5 },
  },
  selected: {
    borderColor: vmColors.blue,
    boxShadow: `0 0 0 1px ${vmColors.blue}`,
    background: '#F5FAFF',
  },
  name: { fontSize: 20, fontWeight: 700, color: vmColors.ink },
  detail: { fontSize: 13, color: vmColors.mute, marginTop: 8 },
  soon: {
    alignSelf: 'flex-start',
    marginTop: 12,
    fontSize: 12,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#F3F4F5',
    color: vmColors.mute,
  },
  image: {
    padding: '18px 22px 22px',
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 10,
    background: theme.palette.background.paper,
    '&:hover': { borderColor: vmColors.blue },
  },
  imageHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
    cursor: 'pointer',
  },
  actions: { display: 'flex', gap: 16, alignItems: 'center', marginTop: 28 },
  next: {
    height: 40,
    padding: '0 20px',
    borderRadius: 6,
    background: vmColors.blue,
    color: '#fff',
    fontWeight: 600,
    fontSize: 14,
    '&:hover': { background: '#0A52B8' },
    '&.Mui-disabled': { opacity: 0.5, color: '#fff' },
  },
}));

const STEPS = ['Product', 'Platform', 'Image', 'Configure'];

function Shell({
  step,
  back,
  title,
  sub,
  children,
}: {
  step: number;
  back: string[];
  title: string;
  sub: string;
  children: ReactNode;
}) {
  const classes = useStyles();
  return (
    <div className={classes.root}>
      <ol className={classes.steps} aria-label="Launch steps">
        {STEPS.map((name, index) => (
          <li
            key={name}
            className={index === step ? classes.current : undefined}
            aria-current={index === step ? 'step' : undefined}
          >
            {index < step && back[index] ? (
              <Link to={back[index]}>{name}</Link>
            ) : (
              name
            )}
          </li>
        ))}
      </ol>
      <h1 className={classes.h1}>{title}</h1>
      <div className={classes.sub}>{sub}</div>
      {children}
    </div>
  );
}

const productName = (entity: Entity) =>
  entity.metadata.annotations?.['cf/product'] ??
  entity.metadata.title ??
  entity.metadata.name;

/** Templates tagged `product`; undefined while loading. */
function useProducts() {
  const catalog = useApi(catalogApiRef);
  const [state, setState] = useState<{ items?: Entity[]; error?: string }>({});
  useEffect(() => {
    let live = true;
    catalog
      .getEntities({
        filter: { kind: 'template', 'metadata.tags': PRODUCT_TAG },
      })
      .then(
        result =>
          live &&
          setState({
            items: [...result.items].sort((a, b) =>
              productName(a).localeCompare(productName(b)),
            ),
          }),
      )
      .catch(error => live && setState({ error: errorMessage(error) }));
    return () => {
      live = false;
    };
  }, [catalog]);
  return state;
}

function Products() {
  const classes = useStyles();
  const navigate = useNavigate();
  const { items, error } = useProducts();
  return (
    <Shell
      step={0}
      back={[]}
      title="Launch a product"
      sub="Choose what to launch. Your team owns it; you can follow its build and manage it afterwards."
    >
      {error && <p role="alert">Products unavailable: {error}</p>}
      {!items && !error && <p>Loading products…</p>}
      {items && !items.length && <p>No products are available yet.</p>}
      <div className={classes.grid}>
        {items?.map(entity => (
          <ButtonBase
            key={entity.metadata.name}
            className={classes.card}
            focusRipple
            onClick={() =>
              navigate(
                entity.metadata.annotations?.[FLOW] === 'platform-image'
                  ? `/launch/${encodeURIComponent(entity.metadata.name)}`
                  : templateUrl(entity),
              )
            }
          >
            <span className={classes.name}>{productName(entity)}</span>
            {entity.metadata.description && (
              <span className={classes.detail}>
                {entity.metadata.description}
              </span>
            )}
          </ButtonBase>
        ))}
      </div>
    </Shell>
  );
}

/** The product (template) named in the URL; undefined while loading, null if unknown. */
function useProduct(): Entity | null | undefined {
  const { product } = useParams();
  const { items, error } = useProducts();
  if (error) return null;
  return items && (items.find(item => item.metadata.name === product) ?? null);
}

function Unknown({ step, what }: { step: number; what: string }) {
  return (
    <Shell
      step={step}
      back={['/launch']}
      title={`Unknown ${what}`}
      sub="It may have been removed."
    >
      <Link to="/launch">Back to products</Link>
    </Shell>
  );
}

function Platforms() {
  const classes = useStyles();
  const navigate = useNavigate();
  const product = useProduct();
  const platforms = usePlatforms();
  if (product === null) return <Unknown step={1} what="product" />;
  return (
    <Shell
      step={1}
      back={['/launch']}
      title="Choose a platform"
      sub={`Where ${product ? productName(product).toLowerCase() : 'it'} runs.`}
    >
      {!platforms && <p>Loading platforms…</p>}
      <div className={classes.grid}>
        {platforms?.map(platform => (
          <ButtonBase
            key={platform.id}
            className={classes.card}
            focusRipple
            disabled={!platform.available || !product}
            onClick={() =>
              navigate(
                `/launch/${encodeURIComponent(
                  product!.metadata.name,
                )}/${encodeURIComponent(platform.id)}`,
              )
            }
          >
            <span className={classes.name}>{platform.label}</span>
            {platform.available ? (
              <span className={classes.detail}>
                {platform.os.length
                  ? `${platform.os.map(os => os.label).join(', ')}`
                  : platform.error ?? 'No images yet'}
              </span>
            ) : (
              <span className={classes.soon}>Coming soon</span>
            )}
          </ButtonBase>
        ))}
      </div>
    </Shell>
  );
}

function Images() {
  const classes = useStyles();
  const navigate = useNavigate();
  const { platform: id } = useParams();
  const product = useProduct();
  const platforms = usePlatforms();
  const platform: PlatformInfo | null | undefined =
    platforms &&
    (platforms.find(item => item.id === id && item.available) ?? null);
  const [chosen, setChosen] = useState<string>();
  const [versions, setVersions] = useState<Record<string, string>>({});
  // Preselect the only image, as there is nothing to choose between.
  useEffect(() => {
    if (platform?.os.length === 1 && !chosen) setChosen(platform.os[0].id);
  }, [platform, chosen]);

  if (product === null) return <Unknown step={2} what="product" />;
  if (platform === null) return <Unknown step={2} what="platform" />;
  return (
    <Shell
      step={2}
      back={['/launch', product ? `/launch/${product.metadata.name}` : '']}
      title="Choose your image"
      sub={
        platform
          ? `Operating system images for ${platform.label}, kept up to date by the platform team.`
          : 'Loading…'
      }
    >
      <div className={classes.grid} role="radiogroup" aria-label="Image">
        {platform?.os.map(os => {
          const selected = chosen === os.id;
          const version = versions[os.id] ?? os.versions[0] ?? '';
          return (
            <div
              key={os.id}
              className={`${classes.image} ${selected ? classes.selected : ''}`}
            >
              <label className={classes.imageHead}>
                <Radio
                  color="primary"
                  checked={selected}
                  onChange={() => setChosen(os.id)}
                  inputProps={{ 'aria-label': os.label }}
                />
                <span className={classes.name}>{os.label}</span>
              </label>
              <TextField
                select
                fullWidth
                size="small"
                variant="outlined"
                value={version}
                disabled={os.versions.length < 2}
                inputProps={{ 'aria-label': `${os.label} version` }}
                onChange={event => {
                  setVersions({ ...versions, [os.id]: event.target.value });
                  setChosen(os.id);
                }}
              >
                {os.versions.map(item => (
                  <MenuItem key={item} value={item}>
                    Version {item}
                  </MenuItem>
                ))}
              </TextField>
            </div>
          );
        })}
      </div>
      {platform && !platform.os.length && (
        <p>
          {platform.error ?? 'No images are available on this platform yet.'}
        </p>
      )}
      <div className={classes.actions}>
        <ButtonBase
          className={classes.next}
          disabled={!chosen || !product || !platform}
          onClick={() =>
            navigate(
              templateUrl(product!, {
                compute: { platform: platform!.id, os: chosen },
              }),
            )
          }
        >
          Continue
        </ButtonBase>
        <Link to={product ? `/launch/${product.metadata.name}` : '/launch'}>
          Back
        </Link>
      </div>
    </Shell>
  );
}

export function LaunchPage() {
  return (
    <Routes>
      <Route path="/" element={<Products />} />
      <Route path=":product" element={<Platforms />} />
      <Route path=":product/:platform" element={<Images />} />
    </Routes>
  );
}
