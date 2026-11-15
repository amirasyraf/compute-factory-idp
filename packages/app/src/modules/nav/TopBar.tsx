import { useEffect, useState } from 'react';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { identityApiRef, useApi } from '@backstage/core-plugin-api';
import {
  NavContentBlueprint,
  type NavContentComponentProps,
} from '@backstage/plugin-app-react';
import { SearchModal, useSearchModal } from '@backstage/plugin-search';
import { makeStyles } from '@material-ui/core';
import SearchIcon from '@material-ui/icons/Search';
import SettingsOutlined from '@material-ui/icons/SettingsOutlined';
import { Mark } from './Mark';
import { errorMessage, reportClientEvent } from '../../clientLog';

const ink = '#111316';
const mute = '#5D636B';
const rule = '#E3E5E8';
const blue = '#0B5FD3';

const useStyles = makeStyles({
  bar: {
    height: 'var(--cf-topbar)',
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 32,
    padding: '0 20px',
    background: '#fff',
    borderBottom: `1px solid ${rule}`,
    '@media (max-width: 760px)': { padding: '0 12px', gap: 12 },
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontWeight: 800,
    fontSize: 16,
    letterSpacing: '-0.01em',
    color: ink,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    '@media (max-width: 760px)': { '& span': { display: 'none' } },
  },
  nav: {
    display: 'flex',
    gap: 4,
    height: '100%',
    overflowX: 'auto',
    scrollbarWidth: 'none',
  } as any,
  link: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 14px',
    color: mute,
    textDecoration: 'none',
    fontWeight: 500,
    fontSize: 14,
    whiteSpace: 'nowrap',
    borderBottom: '3px solid transparent',
    marginBottom: -1,
    transition: 'color 160ms ease-out',
    '&:hover': { color: ink, textDecoration: 'none' },
    '@media (max-width: 760px)': { padding: '0 8px', fontSize: 13.5 },
  },
  narrowHidden: { '@media (max-width: 760px)': { display: 'none' } },
  on: { color: ink, fontWeight: 600, borderBottomColor: blue },
  edge: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  search: {
    width: 240,
    height: 34,
    border: `1px solid ${rule}`,
    background: '#F3F4F5',
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 10px',
    color: mute,
    font: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
    '& svg': { fontSize: 16 },
    '&:hover': { borderColor: '#C9CDD2' },
    '@media (max-width: 1100px)': {
      width: 34,
      padding: 0,
      justifyContent: 'center',
      '& span': { display: 'none' },
    },
  },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 6,
    display: 'grid',
    placeItems: 'center',
    color: mute,
    '&:hover': { background: '#F3F4F5', color: ink },
    '& svg': { fontSize: 20 },
    // The avatar also opens settings; drop the duplicate on narrow screens.
    '@media (max-width: 760px)': { display: 'none' },
  },
  me: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 13,
    color: ink,
    textDecoration: 'none',
    '&:hover': { textDecoration: 'none' },
    '& small': { display: 'block', color: mute, fontSize: 12 },
    '@media (max-width: 1100px)': { '& > div': { display: 'none' } },
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    background: ink,
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    fontWeight: 700,
    fontSize: 12,
    textTransform: 'uppercase',
  },
});

const LABELS: Record<string, string> = {
  'page:catalog': 'Resources',
  'page:scaffolder': 'Create',
  'page:search': 'Search',
};

function useWho() {
  const identity = useApi(identityApiRef);
  const [who, setWho] = useState<{ name: string; team?: string }>();
  useEffect(() => {
    let mounted = true;
    Promise.all([identity.getProfileInfo(), identity.getBackstageIdentity()])
      .then(([profile, user]) => {
        if (!mounted) return;
        const team = user.ownershipEntityRefs
          .filter(ref => ref.startsWith('group:'))
          .map(ref => ref.split('/').pop()!)
          .filter(t => t !== 'platform-admins')
          .join(', ');
        setWho({
          name: profile.displayName ?? user.userEntityRef.split('/').pop()!,
          team: team ? `Team ${team}` : undefined,
        });
      })
      .catch(e =>
        reportClientEvent({
          kind: 'identity-load-failed',
          message: errorMessage(e),
          detail: 'top bar',
        }),
      );
    return () => {
      mounted = false;
    };
  }, [identity]);
  return who;
}

function TopBar({ navItems }: NavContentComponentProps) {
  const classes = useStyles();
  const { pathname } = useLocation();
  const who = useWho();
  const { state, toggleModal } = useSearchModal();

  const isOn = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  // Home is the brand link's destination as well as the first tab.
  navItems.take('page:home');
  navItems.take('page:user-settings');
  const primary = ['page:catalog', 'page:scaffolder', 'page:search']
    .map(id => ({ id, item: navItems.take(id) }))
    .filter(({ item }) => item);
  const rest = navItems.rest();

  const links = [
    { key: 'home', href: '/', title: 'Home' },
    ...primary.map(({ id, item }) => ({
      key: id,
      href: item!.href,
      title: LABELS[id] ?? item!.title,
    })),
    ...rest.map(item => ({
      key: item.node.spec.id,
      href: item.href,
      title: item.title,
    })),
  ];

  return (
    <header className={classes.bar}>
      <RouterLink
        to="/"
        className={classes.brand}
        aria-label="Compute Factory home"
      >
        <Mark />
        <span>Compute Factory</span>
      </RouterLink>
      <nav className={classes.nav} aria-label="Main">
        {links.map(link => (
          <RouterLink
            key={link.key}
            to={link.href}
            className={`${classes.link} ${isOn(link.href) ? classes.on : ''} ${
              link.key === 'page:search' ? classes.narrowHidden : ''
            }`}
            aria-current={isOn(link.href) ? 'page' : undefined}
          >
            {link.title}
          </RouterLink>
        ))}
      </nav>
      <div className={classes.edge}>
        <button
          type="button"
          className={classes.search}
          onClick={toggleModal}
          aria-label="Search the catalog"
        >
          <SearchIcon />
          <span>Search VMs, teams, templates</span>
        </button>
        <RouterLink
          to="/settings"
          className={classes.icon}
          aria-label="Settings"
          title="Settings"
        >
          <SettingsOutlined />
        </RouterLink>
        <RouterLink to="/settings" className={classes.me}>
          <span className={classes.avatar} aria-hidden>
            {who?.name.slice(0, 2) ?? ''}
          </span>
          {who && (
            <div>
              {who.name}
              {who.team && <small>{who.team}</small>}
            </div>
          )}
        </RouterLink>
      </div>
      <SearchModal {...state} toggleModal={toggleModal} />
    </header>
  );
}

export const TopBarContent = NavContentBlueprint.make({
  params: { component: TopBar },
});
