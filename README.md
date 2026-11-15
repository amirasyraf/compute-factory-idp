# Compute Factory IDP

Backstage 1.56, scaffolded at the repository root with **the new frontend system**,
Node 24 (`mise.toml`) and the scaffold's vendored Yarn 4.13.0.

## Custom code

- `plugins/vm-status`: one frontend entity card, only for `Resource` / `spec.type: vm`.
  It renders every workflow process from catalog annotations, desired compute/configuration/billing/tags
  from the entity's structured `spec` (not duplicated annotations), polls every 10 seconds until ready/failed,
  and links to the full Actions run, certificate, destroy and refry templates. It never calls the GitHub
  run API with a shared token. While `cf/status` is `destroying` it offers only the destroy run link
  (the destroy workflow records no per-step progress); when a refresh finds the entity removed from the
  catalog it shows "Destroyed" with the run link and a link back to Resources, and stops polling.
  Desired software is not a software inventory: refry installs are additive, not uninstall/reconciliation.
  Billing metadata is self-reported, not organizational billing authorization. Custom spec validation is
  performed by the platform workflow; malformed custom fields are rendered defensively by the card.
  It also exports the shared pipeline helpers and `PipelineLine` (the eight stations drawn as a transit
  line; skipped stages are drawn as non-stops) used by the home page. For VM entities only it supplies
  an `EntityHeaderLayoutBlueprint` header (size bullet, name, team, OS/platform, lifecycle, inventory
  source link, favourite star) and an `EntityContentLayoutBlueprint` layout that puts the VM card first.
  The stock About card is hidden for VMs through `entity-card:catalog/about` config (`$not` filter);
  other entities keep it. The custom header does not render the stock entity context menu (unregister,
  inspect) on VM pages; destroy remains the supported way to remove a VM.
- `packages/app/src/SettingsGeneral.tsx`: overrides `sub-page:user-settings/general` with only the
  profile and identity cards (the app is light-only and has no sidebar to pin).
- `packages/app/src/theme/`: the Compute Factory look (see `packages/app/DESIGN.md`). `cfTheme.tsx`
  replaces `theme:app/light` with a unified MUI v4/v5 theme (plain white page headers, no gradient
  banners); `global.css` sets BUI tokens, self-hosted fonts and browser surfaces. Dark mode is disabled
  with `theme:app/dark: false`.
- `packages/app/src/modules/nav/`: overrides `app/layout` to put the nav in a top bar instead of a
  sidebar, and supplies that bar through `NavContentBlueprint` (Home, Resources, Create, Search,
  search modal, settings and the signed-in user).
- `packages/app/src/modules/home/`: a `HomePageLayoutBlueprint` layout that replaces the widget grid
  with the team's VMs: status counts as filters, and each VM's pipeline line and next action
  (Get SSH certificate when ready, View run while building or failed). It reads the same catalog
  annotations as the VM card, polls every 10 seconds and is team-scoped by the existing catalog
  permission policy (admins see every VM).
  Home fills the available content width, matching Resources, with 20px horizontal gutters
  (16px at or below 760px); its action header and count strip are not capped on wide screens.
- `plugins/cf-backend`: one backend package, registered against `auth`, `permission` and
  `scaffolder`, plus the `mock-rest` plugin (Backstage extension points belong to separate plugin IDs).
  Implements password sign-in, the team policy, `cf:ssh:sign`, and `cf:watch-workflow`, which streams
  every GitHub Actions job and step into request, refry and destroy tasks until the operation finishes.
  `cf:servicenow:create` makes a real HTTP POST to the mock REST receiver before VM workflow dispatch.
- `packages/app/src/WorkflowTasks.tsx`: augments the stock Scaffolder task detail page with a
  horizontally scrollable stage view, individual job status/duration and expandable step details.
  It reads versioned snapshots from the existing task-owned event stream, not a browser GitHub token
  or a new privileged run endpoint. Updates arrive about every 10 seconds; reload replays stored
  snapshots. Existing task controls, logs, output links, task lists and default form fields are retained.
  Tasks started before this feature keep their original text logs. A stopped monitor displays the last
  observed state with a warning; cancellation does not imply that the GitHub workflow was cancelled.
- `packages/app/src/PasswordSignInPage.tsx`: username/password form and an in-memory
  Backstage identity API; the restored home and signals plugins remain enabled.
- `catalog/`: users/teams, platform locations and the `ssh-cert` template.
- `deploy/`: Caddy, Postgres and the backend/frontend bundle in Docker Compose.

The default scaffolder fields, including `MyGroupsPicker`, remain intact. Search
uses the catalog collator and PG engine (in-memory fallback for local SQLite).
`app.extensions.page:home` mounts Home at `/`, rendered by the Compute Factory home layout. Catalog keeps its default `/catalog` route and defaults to **Resource**.
`packages/app/src/CatalogPage.tsx` overrides `page:catalog` (in `App.tsx`) with a Compute Factory
page shell: a "Resources" heading and Request VM button, with the stock `CatalogFilterLayout`,
the `catalog-filter` extension inputs (including `CatalogKindFilter`) and the stock `CatalogTable`
for search, sorting and paging. When every listed entity is a VM, the table shows State and
Pipeline (the `PipelineLine`, without labels) columns instead of System, Description and Tags;
other lists keep the stock columns. The stock page's permission-gated Create button, support
button and export button are not rendered (export was never enabled). Both `page:catalog` and
`page:catalog/entity` are overridden with `noHeader: true`, so the plugin "Catalog" header bar is
not drawn above the list or any entity page; entity pages keep their own headers.
`CatalogKindFilter.tsx` gives normal users only the Resource kind, including normalization of
non-Resource catalog filter URLs. Members of `group:default/platform-admins` retain the full kind
picker and explicit kind links. This is a catalog-list UI restriction, not an API permission change:
User/Group entities remain readable for sign-in, ownership and template team pickers. Direct entity
pages continue to use existing catalog permissions.

## Users and teams

`catalog/org.yaml` is the sole roster of users, teams and memberships; do not repeat the roster
in documentation. User names must match the password file exactly. Add groups with `kind: Group`,
`spec.type: team`, `children: []`; put their names in each user's `spec.memberOf`. Internal team IDs
are lowercase for consistent owner refs and SSH principals; display names may retain other casing.
Membership in the reserved `platform-admins` group explicitly grants global access. The password provider calls
`signInWithCatalogUser` with the username; unknown catalog users cannot sign in.
The default ownership resolver supplies the user plus their direct groups, so
the existing policy and SSH action are unchanged. GitHub is an integration only,
not a login provider. No OAuth App or OAuth environment variables are required.

### Password file and sessions

`IDP_USERS_B64` is canonical, single-line base64 of UTF-8 text, one
`username:hash` per line. It is secret backend environment, never frontend config.
Hash format: `scrypt$16384$8$1$<16-byte-salt-base64>$<32-byte-key-base64>`.
Verification uses async Node scrypt and `timingSafeEqual`; unknown users and
malformed hashes pay a dummy scrypt cost and fail with the same generic message.

`deploy/hash-password.mjs` reads a password from stdin, strips one terminal
newline (not spaces), and prints one hash. It uses only Node built-ins and the
shared password helper in this repo. For example, on a private terminal:

```sh
read -rs PASSWORD
HASH=$(printf '%s' "$PASSWORD" | node deploy/hash-password.mjs)
unset PASSWORD
# Append "username:$HASH" to your private password file, then:
IDP_USERS_B64=$(base64 < /path/to/private/users.txt | tr -d '\n')
unset HASH
```

The orchestrator's `./poc set-password` manages this file/environment for deploy.
Never commit passwords, password files, or hashes. Base64 avoids Compose `$`
interpolation; it is encoding, not encryption.

Sessions last 12 hours from login, without sliding renewal. A signed HttpOnly,
SameSite=Lax cookie restores sign-in across reloads. Cookies are Secure on HTTPS;
plain HTTP is allowed only for local development, never in production. POST login
and sign-out require a permitted Origin and an AJAX header. Access tokens live
only in memory and refresh through the cookie; passwords are never written to
browser storage. Sign out clears the cookie and returns to the form.
The cookie signing key derives from the secret user configuration: changing any
hash invalidates all existing sessions, and unchanged configuration survives a
backend restart. This is a single-instance POC, not a full account-management,
password-reset, MFA or brute-force protection service.

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
  the platform templates glob. **cf-vms** sets `presence: optional`: with a
  required location, an empty `vms/` fails with “no matching files found”, and a
  failed location keeps its previous children, so destroying the last VM left it
  in the catalog as `destroying`. Optional presence makes the empty glob succeed,
  so the removed VM is orphaned and deleted (`orphanStrategy: delete`).

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

Set `IDP_USERS_B64` in your shell using a throwaway password file for interactive local development.
There is no guest or GitHub sign-in provider. `scripts/smoke.mjs` starts temporary local backend and Caddy containers, checks
readiness/org/locations/templates and the authenticated mock REST action, and stops both; run it with the token
in the environment after the image build. It uses SQLite and a dummy catalog-only
static token and freshly generated throwaway login; the GitHub integration token is inherited by
Docker through environment only. It exercises the real Caddy rewrite, backend-to-backend POST,
HTTP 201 and matching caller/receiver logs, rejected anonymous/catalog-token/user calls, and failed-step
short-circuiting on HTTP 503, without dispatching GHA. It also runs the existing fixture-API browser
checks against this local frontend. No production configuration or AWS credentials are needed.
These checks do not verify live VM provisioning or a real ServiceNow service.

### Mock ServiceNow REST demo

The VM request starts with **Create ServiceNow request (mock)**, before **Start VM pipeline** and
**Monitor VM workflow**. `cf:servicenow:create` sends VM name/team/platform/OS/size, the authenticated
requester's entity ref and the task ID to `POST https://idp.amirasyraf.dev/mock-rest/servicenow`.
Caddy rewrites that exact path to the `mock-rest` plugin's `/api/mock-rest/servicenow` route.
The receiver returns HTTP 201 with `{number: "RITM…", status: "created", mock: true, requestId}`.
Task logs show the URL, status and fake number; successful task output repeats the number.
The number is deterministic for a task ID, but the receiver is stateless: no real ticket, approval,
record lookup, persistence or provisioning-status update is implemented. Refry/destroy and direct GHA
dispatch do not call this demo endpoint.

The endpoint accepts only Backstage service credentials from `plugin:scaffolder`; it is not an
anonymous public webhook. The existing catalog-only external token stays catalog-only. No new shared
secret is needed. The action uses a backend-configured URL constrained to this IDP origin and exact
mock path, disallows redirects, and aborts after ten seconds or task cancellation. A non-201 or malformed
response fails the task before GHA starts. It supports Template Editor dry-runs because it creates no
persistent resources (the dry-run still makes the real POST). No tokens or full request bodies are logged.
Local development uses `computeFactory.mockServiceNowUrl` at `http://localhost:7007/api/mock-rest/servicenow`;
production overrides it with the public HTTPS demo path. The smoke check uses a disposable local Caddy.

For interactive development:

```sh
GITHUB_TOKEN="$(gh auth token)" NODE_OPTIONS=--no-node-snapshot \
  mise exec -- node .yarn/releases/yarn-4.13.0.cjs start
```

SQLite is in-memory; local catalog state is disposable. File locations in the
base config are relative to `packages/backend`. Stop with Ctrl-C. Do not store
the GitHub token in a file. Signing locally additionally requires `AWS_REGION`,
`SSH_CA_SECRET_ID` and AWS default-chain access to the secret.

## Checks

Run one heavy job at a time on the shared laptop, with a 3 GiB Node heap cap:

```sh
export NODE_OPTIONS='--no-node-snapshot --max-old-space-size=3072'
mise exec -- node .yarn/releases/yarn-4.13.0.cjs tsc
mise exec -- node .yarn/releases/yarn-4.13.0.cjs lint
WORKFLOW_UI_URL=https://idp.amirasyraf.dev mise exec -- node scripts/workflow-ui.mjs
GITHUB_TOKEN=build-only mise exec -- node .yarn/releases/yarn-4.13.0.cjs build:backend
docker buildx build --platform linux/arm64 --load -t compute-factory-idp:latest .
GITHUB_TOKEN="$(gh auth token)" mise exec -- node scripts/smoke.mjs
```

Backend build bundles the frontend. The Dockerfile uses Backstage's host-build
skeleton/bundle approach and installs Linux-native production dependencies in
the arm64 image; it never copies macOS node_modules. `openssh-client` is present.
This POC does not use unit-test scaffolding. Verification uses static checks, the platform's existing
offline workflow integration check, and focused browser smoke checks. Browser checks exercise
expandable steps and unchanged task controls; fixture data alone does not verify a real VM run.
`scripts/workflow-ui.mjs` uses installed Google Chrome and fixture API responses to check the served
frontend without signing in, dispatching a workflow or changing backend state. It also checks the
Resource catalog default, normal-user kind restrictions, admin kind selection/deep links, the VM
card, and the home page's VM table, pipeline line, next action and empty filter state.

## Deploy

Copy `deploy/.env.example` to a gitignored file and fill the seven keys only:

`IDP_DOMAIN`, `IDP_USERS_B64`, `GITHUB_TOKEN`,
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

- Populate `IDP_USERS_B64` using `./poc set-password`, with usernames matching
  `catalog/org.yaml`; include only users who should be able to log in.
- Integration PAT: private platform repo Contents read and Actions read/write.
  The IDP org/cert template is read from packaged files, not via GitHub.
- DNS points directly to the host; inbound TCP 80/443 for Caddy TLS.
- EC2 role can read only `compute-factory/ssh-ca`; IMDSv2 hop limit 2 for Docker.
- Infra-generated Postgres password/static token; platform workflow secret
  `BACKSTAGE_TOKEN` matches the runtime value. External access is restricted to
  the `catalog` plugin using the current `backend.auth.externalAccess` shape.
- Health: `https://idp.amirasyraf.dev/.backstage/health/v1/readiness` returns 200
  through Caddy (paths are proxied unchanged except the exact mock ServiceNow path described above).

Postgres and Caddy state use named volumes. Re-running deploy preserves them.
No real host deployment is performed by this repo's build verification.
