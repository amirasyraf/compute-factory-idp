import { Content } from '@backstage/core-components';
import {
  UserSettingsIdentityCard,
  UserSettingsProfileCard,
} from '@backstage/plugin-user-settings';
import { Grid } from '@material-ui/core';

// The stock General page adds Theme and Pin Sidebar toggles. Compute Factory is
// light-only with a top bar, so only profile and identity remain.
export function SettingsGeneral() {
  return (
    <Content>
      <Grid container spacing={3}>
        <Grid item xs={12} md={6}>
          <UserSettingsProfileCard />
        </Grid>
        <Grid item xs={12} md={6}>
          <UserSettingsIdentityCard />
        </Grid>
      </Grid>
    </Content>
  );
}
