import { createFrontendPlugin } from '@backstage/frontend-plugin-api';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';

export default createFrontendPlugin({
  pluginId: 'vm-status',
  extensions: [
    EntityCardBlueprint.make({
      name: 'status',
      params: {
        filter: entity =>
          entity.kind.toLowerCase() === 'resource' &&
          entity.spec?.type === 'vm',
        loader: async () =>
          import('./VmStatusCard').then(m => <m.VmStatusCard />),
      },
    }),
  ],
});
