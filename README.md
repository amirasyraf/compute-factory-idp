# Compute Factory IDP

Backstage 1.56, scaffolded at the repository root with **the new frontend system**,
Node 24 (`mise.toml`) and the scaffold's vendored Yarn 4.13.0.

## Custom code

- `plugins/vm-status`: one frontend entity card, only for `Resource` / `spec.type: vm`.
  It reads catalog annotations, polls every 10 seconds until ready/failed, and
  links to certificate, destroy and refry templates. No GitHub run API bypass.
- `plugins/cf-backend`: one backend package, registered against `permission` and
  `scaffolder` (Backstage extension points belong to separate plugin IDs).
  Implements the team policy and `cf:ssh:sign` only.
- `catalog/`: users/teams, platform locations and the `ssh-cert` template.
- `deploy/`: Caddy, Postgres and the backend/frontend bundle in Docker Compose.

The default scaffolder fields, including `MyGroupsPicker`, remain intact. Search
uses the catalog collator and PG engine (in-memory fallback for local SQLite).

## Users and teams

Edit `catalog/org.yaml`. User names must match GitHub usernames exactly. Add groups
with `kind: Group`, `spec.type: team`, `children: []`; put their names in each
user's `spec.memberOf`. `amirasyraf` initially belongs **only** to `alpha`.
`platform-admins` is deliberately empty: adding membership explicitly grants
global access. GitHub sign-in uses `usernameMatchingUserEntityName` and requires
a matching catalog user; there is no permissive resolver fallback.

## Authorization and verified upstream contracts

The custom policy enables:

1. Admin claims `group:default/platform-admins`: allow everything.
2. Delete/unregister entities and create/delete locations: deny non-admins.
3. Catalog entity permissions: `(NOT (kind Resource AND spec.type vm)) OR
IS_ENTITY_OWNER(ownershipEntityRefs)`. Catalog lists, entity retrieval and
   pickers evaluate this through the catalog's permission machinery.
4. Scaffolder task read/cancel: `IS_TASK_OWNER(createdBy = userEntityRef)`.
5. Other permissions: allow. Workflow team guards remain defense in depth; repo
   writers and holders of the shared integration PAT are trusted administrators.

Source inspection against Backstage tag `v1.56.0`:

- `plugins/scaffolder-backend/src/scaffolder/actions/builtin/catalog/fetch.ts`
  passes `credentials: await ctx.getInitiatorCredentials()` to catalog lookups.
  Thus Agent B's destroy/refry `catalog:fetch` is not a privileged service lookup.
- `plugins/search-backend/src/service/AuthorizedSearchEngine.ts` authorizes each
  result's resource reference when a document type's visibility permission is
  conditional. The catalog collator supplies `catalogEntityReadPermission` and
  `document.authorization.resourceRef`. Unauthorized results are removed and
  ranks rewritten; total count is omitted. This is filtering after the engine
  query, not separate per-team indexes. Other custom collators would need their
  own visibility permission/resource references.
- `plugins/scaffolder-react/src/next/hooks/useFormDataFromQuery.ts` reads JSON
  `formData` from the URL. Card links prefill `{ "vm": "resource:default/name" }`.
- Catalog `UrlReaderProcessor` calls URL reader `search`; `GithubUrlReader`
  supports globs. `catalog/locations.yaml` registers **cf-vms** exactly, plus
  the platform templates glob. Empty `vms/` may report “no matching files found”
  until the first VM exists; the Location entity still exists and is refreshable.

These are upstream-source guarantees, not a claim that cross-team browser flows
have been exercised on the real deployed POC. The first-deploy E2E must verify
two-team visibility, task logs, workflow guards, SSH and teardown.

The signer obtains the initiating identity from scaffolder credentials, re-reads
that User entity from the catalog, normalizes `spec.memberOf`, and never accepts
principals or username from input. AWS SDK v3 uses its default credential chain
(EC2 instance role in deployment). It fetches the CA per request. Temp CA/key
files are mode 0600 in a private directory and always removed in `finally`.
Only public keys and issued certificates enter scaffolder task storage. Validity
is exactly 12 hours; key ID is the catalog username.

## Local development

```sh
mise trust
mise install
mise exec -- node .yarn/releases/yarn-4.13.0.cjs install --immutable
```

Create gitignored `app-config.local.yaml`:

```yaml
auth:
  providers:
    guest:
      userEntityRef: user:default/amirasyraf
```

The normal UI is GitHub-only; for UI development add a GitHub development
provider with the localhost callback. The guest provider is useful for backend
smoke tests and is not configured in base/production config; it refuses
production use. `scripts/smoke.mjs` starts a temporary local backend container, checks
readiness/org/locations/templates and always stops it; run it with the token
in the environment after the image build. It uses SQLite and a dummy catalog-only
static token; the real GitHub token is inherited by Docker through environment
only. No production configuration or AWS credentials are used.

```sh
GITHUB_TOKEN="$(gh auth token)" NODE_OPTIONS=--no-node-snapshot \
  mise exec -- node .yarn/releases/yarn-4.13.0.cjs start
```

SQLite is in-memory; local catalog state is disposable. File locations in the
base config are relative to `packages/backend`. Stop with Ctrl-C. Do not store
the GitHub token in a file. Signing locally additionally requires `AWS_REGION`,
`SSH_CA_SECRET_ID` and AWS default-chain access to the secret; unit tests need
no AWS credentials and create a throwaway local CA.

## Checks

Run one heavy job at a time on the shared laptop, with a 3 GiB Node heap cap:

```sh
export NODE_OPTIONS='--no-node-snapshot --max-old-space-size=3072'
mise exec -- node .yarn/releases/yarn-4.13.0.cjs tsc
mise exec -- node .yarn/releases/yarn-4.13.0.cjs lint
mise exec -- node .yarn/releases/yarn-4.13.0.cjs workspace @internal/plugin-cf-backend test --watch=false --maxWorkers=2
GITHUB_TOKEN=build-only mise exec -- node .yarn/releases/yarn-4.13.0.cjs build:backend
docker buildx build --platform linux/arm64 --load -t compute-factory-idp:latest .
```

Backend build bundles the frontend. The Dockerfile uses Backstage's host-build
skeleton/bundle approach and installs Linux-native production dependencies in
the arm64 image; it never copies macOS node_modules. `openssh-client` is present.

## Deploy

Copy `deploy/.env.example` to a gitignored file and fill the eight keys only:

`IDP_DOMAIN`, `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET`, `GITHUB_TOKEN`,
`POSTGRES_PASSWORD`, `BACKSTAGE_TOKEN`, `AWS_REGION`, `SSH_CA_SECRET_ID`.

```sh
./deploy/deploy.sh <host> <env-file>
```

This rebuilds locally for `linux/arm64`, loads the image over SSH and starts the
three services in `/opt/idp`. Requires mise, Docker/buildx and the local
`~/.ssh/id_ed25519`. It is non-interactive, uses disposable-host SSH options
without reading/writing known_hosts, and uploads `.env` with mode 0600.
The script fails immediately on a concurrent build lock instead of waiting.
The orchestrator waits for cloud-init's `cf-idp-ready` marker first.

First deploy prerequisites owned by the orchestrator:

- GitHub OAuth App callback:
  `https://idp.amirasyraf.dev/api/auth/github/handler/frame`.
- Integration PAT: private platform repo Contents read and Actions read/write.
  The IDP org/cert template is read from packaged files, not via GitHub.
- DNS points directly to the host; inbound TCP 80/443 for Caddy TLS.
- EC2 role can read only `compute-factory/ssh-ca`; IMDSv2 hop limit 2 for Docker.
- Infra-generated Postgres password/static token; platform workflow secret
  `BACKSTAGE_TOKEN` matches the runtime value. External access is restricted to
  the `catalog` plugin using the current `backend.auth.externalAccess` shape.
- Health: `https://idp.amirasyraf.dev/.backstage/health/v1/readiness` returns 200
  through Caddy (all paths are proxied unchanged).

Postgres and Caddy state use named volumes. Re-running deploy preserves them.
No real host deployment is performed by this repo's build verification.
