import { Entity } from '@backstage/catalog-model';
import { createFrontendPlugin } from '@backstage/frontend-plugin-api';
import {
  EntityCardBlueprint,
  EntityContentLayoutBlueprint,
  EntityHeaderLayoutBlueprint,
} from '@backstage/plugin-catalog-react/alpha';

export {
  PipelineLine,
  STATIONS,
  activeStation,
  getPipelineProcesses,
  vmColors,
  vmState,
  vmStateColor,
  vmStateLabel,
  type VmState,
} from './pipeline';
export { getVmConfiguration } from './vmSpec';

const isVm = (entity: Entity) =>
  entity.kind.toLowerCase() === 'resource' && entity.spec?.type === 'vm';

export default createFrontendPlugin({
  pluginId: 'vm-status',
  extensions: [
    EntityCardBlueprint.make({
      name: 'status',
      params: {
        filter: isVm,
        loader: async () =>
          import('./VmStatusCard').then(m => <m.VmStatusCard />),
      },
    }),
    EntityHeaderLayoutBlueprint.make({
      name: 'vm',
      params: {
        filter: isVm,
        loader: async () => (await import('./VmPage')).VmHeaderLayout,
      },
    }),
    EntityContentLayoutBlueprint.make({
      name: 'vm',
      params: {
        filter: isVm,
        loader: async () => (await import('./VmPage')).VmContentLayout,
      },
    }),
  ],
});
