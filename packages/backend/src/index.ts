import { createBackend } from '@backstage/backend-defaults';
import {
  permissionModule,
  sshModule,
  passwordAuthModule,
  mockRestPlugin,
  demoModePlugin,
  clientLogPlugin,
} from '@internal/plugin-cf-backend';

const backend = createBackend();
backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(passwordAuthModule);
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(import('@backstage/plugin-permission-backend'));
backend.add(permissionModule);
backend.add(sshModule);
backend.add(mockRestPlugin);
backend.add(demoModePlugin);
backend.add(clientLogPlugin);
backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage/plugin-search-backend-module-pg'));
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-user-settings-backend'));
// Required by the frontend user-settings storage (plugin.signal.service).
backend.add(import('@backstage/plugin-signals-backend'));
backend.start();
