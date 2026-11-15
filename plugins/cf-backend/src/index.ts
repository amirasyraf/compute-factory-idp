import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { ComputeFactoryPolicy } from './policy';
import { createSshSignAction } from './sign';

// One package; Backstage requires a registration for each owning plugin.
export const permissionModule = createBackendModule({
  pluginId: 'permission',
  moduleId: 'compute-factory',
  register(reg) {
    reg.registerInit({
      deps: { policy: policyExtensionPoint, userInfo: coreServices.userInfo },
      async init({ policy, userInfo }) {
        policy.setPolicy(new ComputeFactoryPolicy(userInfo));
      },
    });
  },
});
export const sshModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'compute-factory',
  register(reg) {
    reg.registerInit({
      deps: {
        actions: scaffolderActionsExtensionPoint,
        catalog: catalogServiceRef,
        auth: coreServices.auth,
      },
      async init({ actions, catalog, auth }) {
        actions.addActions(createSshSignAction(catalog, auth));
      },
    });
  },
});
