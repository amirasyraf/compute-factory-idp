import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { HomePageLayoutBlueprint } from '@backstage/plugin-home-react/alpha';

// Replaces the default widget grid with the workspace welcome and expandable
// resource explorer. Home widgets are intentionally unused.
const computeFactoryHome = HomePageLayoutBlueprint.make({
  params: {
    loader: async () => {
      const { HomePage } = await import('./HomePage');
      return () => <HomePage />;
    },
  },
});

export const homeModule = createFrontendModule({
  pluginId: 'home',
  extensions: [computeFactoryHome],
});
