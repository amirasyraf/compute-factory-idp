import {
  UnifiedThemeProvider,
  createUnifiedTheme,
  genPageTheme,
  palettes,
} from '@backstage/theme';
import { ThemeBlueprint } from '@backstage/plugin-app-react';
import LightIcon from '@material-ui/icons/WbSunny';

export const cf = {
  ink: '#111316',
  mute: '#5D636B',
  faint: '#8A9098',
  rule: '#E3E5E8',
  surface: '#F3F4F5',
  white: '#FFFFFF',
  blue: '#0B5FD3',
  blueDark: '#0A4FB0',
  green: '#00935A',
  red: '#E8402E',
  redText: '#C2321F',
  grey: '#9AA0A7',
  font: '"Schibsted Grotesk Variable", "Schibsted Grotesk", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

// Every page header is plain white with ink type: no gradient banners.
const plainPage = genPageTheme({
  colors: [cf.white, cf.white],
  shape: 'none',
  options: { fontColor: cf.ink },
});
const pageTheme = Object.fromEntries(
  [
    'home',
    'documentation',
    'tool',
    'service',
    'website',
    'library',
    'other',
    'app',
    'apis',
    'card',
  ].map(id => [id, plainPage]),
);

const theme = createUnifiedTheme({
  palette: {
    ...palettes.light,
    primary: { main: cf.blue, dark: cf.blueDark },
    secondary: { main: cf.ink },
    error: { main: cf.red, dark: cf.redText },
    success: { main: cf.green },
    warning: { main: '#B26B00' },
    info: { main: cf.blue },
    background: { default: cf.white, paper: cf.white },
    text: { primary: cf.ink, secondary: cf.mute },
    divider: cf.rule,
    border: cf.rule,
    textSubtle: cf.mute,
    textContrast: cf.ink,
    link: cf.blue,
    linkHover: cf.blueDark,
    navigation: {
      ...palettes.light.navigation,
      background: cf.white,
      indicator: cf.blue,
      color: cf.mute,
      selectedColor: cf.ink,
    },
  },
  fontFamily: cf.font,
  defaultPageTheme: 'home',
  pageTheme,
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
          borderRadius: 6,
          letterSpacing: 0,
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        rounded: { borderRadius: 8 },
        elevation1: { boxShadow: 'none', border: `1px solid ${cf.rule}` },
        elevation2: { boxShadow: 'none', border: `1px solid ${cf.rule}` },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: { boxShadow: 'none', border: `1px solid ${cf.rule}` },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 4, fontWeight: 500 },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        head: {
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          color: cf.mute,
          backgroundColor: cf.surface,
        },
      },
    },
    MuiTab: {
      styleOverrides: { root: { textTransform: 'none', fontWeight: 500 } },
    },
    BackstageHeader: {
      styleOverrides: {
        header: {
          boxShadow: 'none',
          borderBottom: `1px solid ${cf.rule}`,
          padding: '28px 20px 20px',
        },
        title: { fontSize: 30, fontWeight: 700, letterSpacing: '-0.025em' },
        subtitle: { color: cf.mute },
        type: { color: cf.mute, letterSpacing: '0.06em' },
      },
    },
    BackstageHeaderTabs: {
      styleOverrides: {
        tabsWrapper: {
          backgroundColor: cf.white,
          borderBottom: `1px solid ${cf.rule}`,
          paddingLeft: 24,
        },
        defaultTab: { textTransform: 'none', fontSize: 14 },
        selected: { color: cf.ink },
      },
    },
    BackstageInfoCard: {
      styleOverrides: {
        header: { padding: '16px 20px 8px' },
        headerTitle: { fontWeight: 700, fontSize: 18 },
      },
    },
    MuiTextField: {
      defaultProps: { variant: 'outlined' },
    },
    // Form section headings (rjsf TitleField) sit below the card title.
    MuiTypography: {
      styleOverrides: {
        h5: { fontSize: 15, fontWeight: 700, letterSpacing: '-0.005em' },
      },
    },
    BackstageHighlightedSearchResultText: {
      styleOverrides: {
        highlight: {
          background: 'rgba(11, 95, 211, 0.14)',
          color: 'inherit',
          borderRadius: 2,
          padding: '0 1px',
        },
      },
    },
    // Template cards: title first, type and actions below it (no eyebrow).
    BackstageItemCardHeader: {
      styleOverrides: {
        root: {
          display: 'flex',
          flexDirection: 'column-reverse',
          gap: 6,
          color: cf.ink,
          backgroundImage: 'none',
          '& h3': { color: cf.mute, fontSize: 13, fontWeight: 500 },
          '& h3 svg, & h3 button': { color: cf.mute },
        },
      },
    },
    CatalogReactUserListPicker: {
      styleOverrides: {
        root: {
          backgroundColor: cf.surface,
          border: `1px solid ${cf.rule}`,
          borderRadius: 8,
        },
        title: { color: cf.mute, letterSpacing: '0.07em', fontSize: 11 },
      },
    },
  } as any,
});

export const cfLightTheme = ThemeBlueprint.make({
  name: 'light',
  params: {
    theme: {
      id: 'light',
      title: 'Compute Factory',
      variant: 'light',
      icon: <LightIcon />,
      Provider: ({ children }) => (
        <UnifiedThemeProvider theme={theme}>{children}</UnifiedThemeProvider>
      ),
    },
  },
});
