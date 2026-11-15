import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { ComputeFactoryPolicy } from './policy';
import { createSshSignAction } from './sign';
import { authProvidersExtensionPoint } from '@backstage/plugin-auth-node';
import { passwordProviderFactory } from './auth';
import { createWorkflowWatchAction } from './watch';
import { createServiceNowRequestAction } from './servicenow';
import { createDemoDispatchAction } from './demo';

export { mockRestPlugin } from './servicenow';
export { demoModePlugin } from './demo';
export { clientLogPlugin } from './clientLog';
export { vmSizesPlugin } from './vmSizes';

export const passwordAuthModule = createBackendModule({
  pluginId: 'auth',
  moduleId: 'compute-factory-password',
  register(reg) {
    reg.registerInit({
      deps: { providers: authProvidersExtensionPoint },
      async init({ providers }) {
        providers.registerProvider({
          providerId: 'password',
          factory: passwordProviderFactory,
        });
      },
    });
  },
});

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
        config: coreServices.rootConfig,
        discovery: coreServices.discovery,
      },
      async init({ actions, catalog, auth, config, discovery }) {
        actions.addActions(
          createSshSignAction(catalog, auth),
          createWorkflowWatchAction(),
          createServiceNowRequestAction(auth, config),
          createDemoDispatchAction(auth, discovery),
        );
      },
    });
  },
});
