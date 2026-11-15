import { createApp } from '@backstage/frontend-defaults';
import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { githubAuthApiRef } from '@backstage/core-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import { SignInPage } from '@backstage/core-components';
import vmStatus from '@internal/plugin-vm-status';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { navModule } from './modules/nav';
import { homeModule } from './modules/home';

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props =>
      (
        <SignInPage
          {...props}
          provider={{
            id: 'github-auth-provider',
            title: 'GitHub',
            message: 'Sign in using your catalog-listed GitHub account',
            apiRef: githubAuthApiRef,
          }}
        />
      ),
  },
});

// Scaffolder's auto-discovered plugin retains all default field extensions,
// including MyGroupsPicker. Do not replace its field extension input list.
export default createApp({
  features: [
    catalogPlugin,
    vmStatus,
    navModule,
    homeModule,
    createFrontendModule({ pluginId: 'app', extensions: [signInPage] }),
  ],
});
