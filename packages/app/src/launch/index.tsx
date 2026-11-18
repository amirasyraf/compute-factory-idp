import {
  PageBlueprint,
  createFrontendPlugin,
  createRouteRef,
} from '@backstage/frontend-plugin-api';
import AddCircleOutline from '@material-ui/icons/AddCircleOutline';

// Launch: product -> platform -> image cards, then the product's Scaffolder template.
// The nav item needs a title and an icon (AppNav drops pages without either).
export const launchPlugin = createFrontendPlugin({
  pluginId: 'launch',
  title: 'Launch',
  icon: <AddCircleOutline fontSize="inherit" />,
  extensions: [
    PageBlueprint.make({
      params: {
        path: '/launch',
        title: 'Launch',
        noHeader: true,
        routeRef: createRouteRef(),
        loader: async () => import('./LaunchPage').then(m => <m.LaunchPage />),
      },
    }),
  ],
});
