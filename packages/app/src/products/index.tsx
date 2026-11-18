import {
  createFrontendPlugin,
  createRouteRef,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { productPath, virtualMachines } from './catalog';

export const productsPlugin = createFrontendPlugin({
  pluginId: 'products',
  extensions: [
    PageBlueprint.make({
      name: 'virtual-machines',
      params: {
        path: productPath(virtualMachines),
        title: virtualMachines.title,
        noHeader: true,
        routeRef: createRouteRef(),
        loader: async () =>
          import('./VmProductPage').then(m => <m.VmProductPage />),
      },
    }),
  ],
});
