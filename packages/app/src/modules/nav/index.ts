import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { TopBarContent } from './TopBar';
import { TopBarLayout } from './TopBarLayout';

export const navModule = createFrontendModule({
  pluginId: 'app',
  extensions: [TopBarContent, TopBarLayout],
});
