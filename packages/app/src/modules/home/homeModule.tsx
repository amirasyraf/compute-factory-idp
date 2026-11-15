import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { HomePageWidgetBlueprint } from '@backstage/plugin-home-react/alpha';
import { MarkdownContent } from '@backstage/core-components';

const content = `
## Compute Factory

Self-service VMs for your teams.

1. **[Get SSH certificate](/create/templates/default/ssh-cert)**: paste your public key, save the
   result as \`~/.ssh/id_ed25519-cert.pub\`. Valid 12h, works on every VM of your teams.
2. **[Request a VM](/create/templates/default/vm-request)**: pick team, size and software.
3. **[Your teams' VMs](/catalog?filters%5Bkind%5D=resource&filters%5Btype%5D=vm)**: live build
   status, IP and the SSH command. Destroy or re-run a fry stage from the VM's page.
`;

const welcomeWidget = HomePageWidgetBlueprint.make({
  name: 'compute-factory',
  params: {
    name: 'ComputeFactory',
    title: 'Compute Factory',
    description: 'How to get and use a VM',
    components: async () => ({
      Content: () => <MarkdownContent content={content} />,
    }),
  },
});

export const homeModule = createFrontendModule({
  pluginId: 'home',
  extensions: [welcomeWidget],
});
