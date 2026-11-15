import { FormEvent, useEffect, useState } from 'react';
import {
  BackstageUserIdentity,
  DiscoveryApi,
  IdentityApi,
  ProfileInfo,
  SignInPageProps,
  discoveryApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Container,
  TextField,
  Typography,
} from '@material-ui/core';

type Session = {
  profile: ProfileInfo;
  backstageIdentity: {
    token: string;
    identity: BackstageUserIdentity;
    expiresInSeconds?: number;
  };
};

// The only durable credential is the server's HttpOnly cookie. No browser
// storage contains a password or a Backstage access token.
class PasswordIdentity implements IdentityApi {
  private session?: Session;
  private refreshAt = 0;
  private refreshing?: Promise<Session | undefined>;
  constructor(private readonly discovery: DiscoveryApi) {}

  private async request(
    method: 'GET' | 'POST',
    body?: { username: string; password: string },
  ): Promise<Session | undefined> {
    const base = await this.discovery.getBaseUrl('auth');
    const response = await fetch(`${base}/password/refresh`, {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return undefined;
    if (!response.ok) throw new Error('Invalid username or password');
    const session: Session = await response.json();
    this.session = session;
    this.refreshAt =
      Date.now() +
      Math.max(0, (session.backstageIdentity.expiresInSeconds ?? 300) - 60) *
        1000;
    return session;
  }
  restore() {
    return this.request('GET');
  }
  async login(username: string, password: string) {
    await this.request('POST', { username, password });
  }
  private async current(): Promise<Session> {
    if (this.session && Date.now() < this.refreshAt) return this.session;
    if (!this.refreshing)
      this.refreshing = this.restore().finally(() => {
        this.refreshing = undefined;
      });
    const session = await this.refreshing;
    if (!session) {
      window.location.replace('/');
      throw new Error('Session expired');
    }
    return session;
  }
  async getProfileInfo() {
    return (await this.current()).profile;
  }
  async getBackstageIdentity() {
    return (await this.current()).backstageIdentity.identity;
  }
  async getCredentials() {
    return { token: (await this.current()).backstageIdentity.token };
  }
  async signOut() {
    const base = await this.discovery.getBaseUrl('auth');
    const response = await fetch(`${base}/password/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!response.ok) throw new Error('Unable to sign out');
    this.session = undefined;
    window.location.replace('/');
  }
}

export function PasswordSignInPage({ onSignInSuccess }: SignInPageProps) {
  const discovery = useApi(discoveryApiRef);
  const [identity] = useState(() => new PasswordIdentity(discovery));
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    identity
      .restore()
      .then(session => {
        if (active && session) onSignInSuccess(identity);
      })
      .catch(() => {
        if (active) setError('Unable to restore session. Please sign in.');
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [identity, onSignInSuccess]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await identity.login(username.trim(), password);
      onSignInSuccess(identity);
    } catch {
      setError('Invalid username or password');
    } finally {
      setPassword('');
      setBusy(false);
    }
  }
  if (checking)
    return (
      <Box p={6}>
        <CircularProgress aria-label="Checking session" />
      </Box>
    );
  return (
    <Container maxWidth="xs">
      <Box mt={10}>
        <Card>
          <CardContent>
            <Typography
              variant="h5"
              component="h1"
              style={{ fontSize: 24, letterSpacing: '-0.015em' }}
            >
              Compute Factory
            </Typography>
            <Typography>Sign in with your username and password.</Typography>
            <form onSubmit={submit} autoComplete="off">
              <TextField
                label="Username"
                name="username"
                value={username}
                onChange={event => setUsername(event.target.value)}
                fullWidth
                required
                margin="normal"
                autoComplete="off"
              />
              <TextField
                label="Password"
                name="password"
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                fullWidth
                required
                margin="normal"
                autoComplete="off"
              />
              {error && (
                <Typography role="alert" color="error">
                  {error}
                </Typography>
              )}
              <Box mt={2}>
                <Button
                  type="submit"
                  variant="contained"
                  color="primary"
                  disabled={busy}
                  fullWidth
                >
                  {busy ? 'Signing in…' : 'Sign in'}
                </Button>
              </Box>
            </form>
          </CardContent>
        </Card>
      </Box>
    </Container>
  );
}
