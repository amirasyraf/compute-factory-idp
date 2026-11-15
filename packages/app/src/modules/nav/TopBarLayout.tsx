import { coreExtensionData } from '@backstage/frontend-plugin-api';
import appPlugin from '@backstage/plugin-app';

const shell = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  background: '#fff',
} as const;

const content = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
} as const;

// Same inputs as the stock layout; renders the nav as a top bar above the
// content instead of a sidebar beside it.
export const TopBarLayout = appPlugin.getExtension('app/layout').override({
  factory: (_originalFactory, { inputs }) => [
    coreExtensionData.reactElement(
      <div style={shell}>
        {inputs.nav.get(coreExtensionData.reactElement)}
        <div style={content}>
          {inputs.content.get(coreExtensionData.reactElement)}
        </div>
      </div>,
    ),
  ],
});
