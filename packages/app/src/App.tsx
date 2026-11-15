import { createApp } from '@backstage/frontend-defaults';
import {
  coreExtensionData,
  createFrontendModule,
} from '@backstage/frontend-plugin-api';
import scaffolderPlugin from '@backstage/plugin-scaffolder/alpha';
import { WorkflowTasks } from './WorkflowTasks';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import { PasswordSignInPage } from './PasswordSignInPage';
import vmStatus from '@internal/plugin-vm-status';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { navModule } from './modules/nav';
import { homeModule } from './modules/home';

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props => <PasswordSignInPage {...props} />,
  },
});

// Override only the task sub-page, preserving all default fields and task UI.
const scaffolder = scaffolderPlugin.withOverrides({
  extensions: [
    scaffolderPlugin.getExtension('sub-page:scaffolder/tasks').override({
      factory(originalFactory) {
        const original = originalFactory();
        return Array.from(original, output =>
          output.id === coreExtensionData.reactElement.id
            ? coreExtensionData.reactElement(
                <WorkflowTasks>
                  {original.get(coreExtensionData.reactElement)}
                </WorkflowTasks>,
              )
            : output,
        );
      },
    }),
  ],
});
export default createApp({
  features: [
    catalogPlugin,
    scaffolder,
    vmStatus,
    navModule,
    homeModule,
    createFrontendModule({ pluginId: 'app', extensions: [signInPage] }),
  ],
});
