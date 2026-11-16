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
  Tags (`cost_center`, `project_code` and custom tags, shown as one AWS tags line) are self-reported,
  not organizational billing authorization. The request form's `VmTagsEditor` field
  (`packages/app/src/VmTagsEditor.tsx`) is one key/value table with fixed, required `cost_center` and
  `project_code` rows and optional extra tags; `/api/demo-mode/requests` rejects requests without them. Custom spec validation is
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
  `scaffolder`, plus the `mock-rest` and `demo-mode` plugins (Backstage extension points belong to separate plugin IDs).
  Implements password sign-in, the team policy, `cf:ssh:sign`, and `cf:watch-workflow`, which streams
  every GitHub Actions job and step into request, refry and destroy tasks until the operation finishes.
  It retries rate limits, GitHub 5xx and network errors (a 404 for 2 minutes) instead of failing the
  task while the workflow keeps running; GitHub reads (watcher and demo reconcile) use ETag conditional
  requests so unchanged polls do not consume the token's 5,000/hour rate limit. `cf:vm:dispatch`
  retries timeouts and server errors with the same task ID; the endpoint is idempotent per task, so a
  retry returns the existing run rather than requesting a second VM. Without demo mode, a failed
  inventory scan no longer blocks requests; with demo mode it fails closed (quota cannot be checked).
  `cf:servicenow:create` makes a real HTTP POST to the mock REST receiver before VM workflow dispatch.
- `packages/app/src/DemoModePanel.tsx`: Home's demo-mode status, per-account usage, expiry countdowns
  and admin-only global toggle with destructive confirmation. Membership in `platform-admins` controls
  access; the roster lives only in `catalog/org.yaml`.
- `packages/app/src/WorkflowTasks.tsx`: augments the stock Scaffolder task detail page with a
  horizontally scrollable stage view, individual job status/duration and expandable step details.
  It reads versioned snapshots from the existing task-owned event stream, not a browser GitHub token
  or a new privileged run endpoint. Updates arrive about every 10 seconds; reload replays stored
  snapshots. Existing task controls, logs, output links, task lists and default form fields are retained.
  Tasks started before this feature keep their original text logs. A stopped monitor displays the last
  observed state with a warning; cancellation does not imply that the GitHub workflow was cancelled.
- `packages/app/src/PasswordSignInPage.tsx`: username/password form and an in-memory
  Backstage identity API; the restored home and signals plugins remain enabled.
- `packages/app/src/taskEventPolling.ts`: the task page receives task events by **long polling**
  `GET /api/scaffolder/v2/tasks/<id>/events` (Backstage's documented alternative), not the default SSE
  `/eventstream`. TLS-inspecting corporate proxies (Netskope observed) buffer the never-ending SSE
  response, leaving the task page blank while home-page polling still works. A poll returns as soon as
  new events exist (the backend checks about every second) or with `[]` after 30 seconds. Failed polls
  retry with 1/2/5/10 s backoff and then surface "Task updates failed…" on the page; the page hook
  reconnects from the last seen event. **Revert to SSE** by deleting the `api:scaffolder` override in
  `App.tsx` and this file.
- **VM sizes and instance types** (`plugins/cf-backend/src/vmSizes.ts`,
  `packages/app/src/VmComputePicker.tsx`, `plugins/vm-status/src/vmSizes.ts`), signed-in users only:
  - `GET /api/vm-sizes/sizes`: the platform's `terraform/platforms/aws/sizes.json` (XS-L, read from GitHub
    `main`, cached 5 minutes, last good copy kept during outages) with vCPU, memory, architecture and
    network from `ec2:DescribeInstanceTypes` (cached 1 hour). Without AWS access it returns an `error`
    and types without specs.
  - `GET /api/vm-sizes/instance-types`: every x86_64, EBS-backed instance type offered in the region
    (`DescribeInstanceTypeOfferings` + `DescribeInstanceTypes`, `mac*` excluded), with family, category,
    generation, GPUs and bare-metal flag. Cached 1 hour; the last good list is kept on AWS errors.
  - The platform template's `ui:field: VmComputePicker` on `compute` renders platform/OS, size **cards**
    (size, instance type, vCPU, memory, network, CPU) and a collapsed **Advanced** picker: category tabs
    with counts, rows grouped by family, search, family/min vCPU/min memory filters, a
    current-generation toggle and sortable type/vCPU/memory columns. It submits exactly one of `size` or
    `instanceType` and preselects `S` (the schema has no `size` default, which the form would otherwise
    re-add beside an instance type). `VmSizePicker` (cards only, on a `size` string) stays registered for
    the earlier template revision.
  - **Demo mode:** `demo-mode` `/state` returns `instanceTypes` (`t3.micro`–`t3.large`); while it is on,
    other types are greyed out and unselectable, and `/api/demo-mode/requests` rejects them (403).
  - The home row, VM header and VM card show the launched type from `cf/instance-type`, else the
    requested `instanceType` ("Custom · …") or the type the size maps to now. The size badge shows the
    size (`XS`…`L`) or `◆` for a custom type.
- `packages/app/src/ClientMonitor.tsx` (app-root element) and `clientLog.ts`:
  - **New-version banner.** The app is a single page, so a tab opened before a deploy keeps the old
    bundle. Every 60 seconds and on tab focus, the tab fetches `index.html` (served `no-store`) and
    compares its `main.<hash>.js` with the bundle it is running. On a mismatch it shows "A new version
    of Compute Factory is available. [Reload]". It never reloads by itself, so half-filled forms are
    safe. Disabled on the dev server, whose bundle has no hash.
  - **Browser error reporting.** Uncaught errors, unhandled rejections, exhausted task-update polling,
    identity load failures and stale bundles are POSTed to the `client-log` backend plugin, at most 30
    per page load and only once signed in.

## Logging and troubleshooting

- **Backstage** logs JSON to stdout. The access log line is written when a request *finishes*. With
  `backend.trustProxy: 1` (production), audit and client-log entries carry the real client IP.
- **Browser reports** appear as `warn` lines `Browser <kind>: <message>` with
  `type: clientEvent`, the user, client IP, user agent, page and bundle hash
  (`plugins/cf-backend/src/clientLog.ts`; signed-in users only, 8 KB body, 60 per user per minute).
- **Caddy** writes a JSON access log for every request: client IP, status, size and duration.
  `Authorization` and `Cookie` headers are redacted by Caddy.
- GitHub API failures in the workflow monitor and demo mode include GitHub's message and
  `x-github-request-id`. Demo provision and cleanup dispatch failures are logged as warnings.
- Container logs rotate at 20 MB × 5 files per service.
- From the orchestrator repo: `./poc logs [backstage|caddy|postgres|all] [since]` and
  `./poc task <task-id>` (task status plus stored events). If the task page is blank but
  `./poc task` shows events, the problem is delivery to the browser; check Caddy for that client's
  `/events` requests and `whois` its IP (corporate TLS proxies such as Netskope).
- `LOG_LEVEL=debug` in the env file raises Backstage verbosity for a deploy.
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

### Demo mode

Demo mode defaults **off**. On Home, platform admins can enable/disable it without redeploying.
Enabling destroys oldest excess VMs, keeping the newest three per requesting account, and gives
existing ready/failed VMs five minutes from enable time. New VMs get five minutes from first readiness
(or terminal failure if never ready). Refry does not extend the deadline. A fourth request is refused;
queued, provisioning, failed and destroying VMs all occupy quota until their inventory is gone.
Quotas are per original requester, not per team, and include admins.

The backend stores settings, deadlines and dispatch reservations in its existing database and checks
Git inventory every 15 seconds. It reuses `destroy.yml`/Terraform rather than directly terminating EC2.
Disabling invalidates queued cleanup; already-started destruction cannot be undone. Re-enabling starts
fresh timers. IDP/GitHub downtime delays cleanup, and Actions queues/Terraform add time after expiry.
This is a POC cost-control convenience, not an independent hard termination guarantee.

The deployment enables `computeFactory.demoAutomation: true`. It defaults false elsewhere so local
development and the existing smoke environment can exercise real controls without launching or deleting
production VMs. Local requests are refused while automation is disabled. Production is single-instance:
do not scale the backend horizontally without replacing its admission mutex with distributed locking.

Ambiguous GitHub dispatches retain their reservation/cleanup intent and show an error. The worker
recovers IDs from the newest 100 matching workflow runs; it does not blindly resend ambiguous requests.
Known rejected cleanup dispatches and failed cleanup runs are retried after two minutes, at most three
attempts per VM per demo-mode generation; then the VM shows "Cleanup stopped" and needs an operator
(fix the cause, then toggle demo mode off and on to start a new generation). If recovery
cannot find a run, inspect Actions and the control panel before operator repair; do not simply resubmit.
Repository writers/dispatch-token holders are trusted and can bypass portal admission; do not give
that access to demo users. The worker still reconciles their inventory against the enabled policy.

### Setup

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
These checks verify admin/non-admin demo controls against the real local backend/database with
automation disabled. They do not verify live VM expiry/provisioning or a real ServiceNow service.

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
anonymous public webhook. The workflow token is restricted to catalog and the read-only demo cleanup
check, and still cannot call the mock receiver. No new shared
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
CF_USER=user1 CF_PASSWORD="$(grep '^user1:' ../compute-factory/.poc-passwords | cut -d: -f2-)" \
  mise exec -- node scripts/live-check.mjs
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
The task fixture serves `/events` as a long-poll endpoint, fails if the page opens `/eventstream`, and
checks that a changed workflow snapshot appears without a page reload. Against a built (hashed)
frontend it also simulates a deploy and checks that the new-version banner appears; on the dev
server that check is skipped.
`scripts/workflow-ui.mjs` uses installed Google Chrome and fixture API responses to check the served
frontend without signing in, dispatching a workflow or changing backend state.
`scripts/live-check.mjs` signs in to the deployed IDP with a real POC login (from the orchestrator's
gitignored `.poc-passwords`) and checks, read-only, the request form's live instance types and AWS
specs and that the newest own task page receives events by long polling. Run it after every deploy. It also checks the
Resource catalog default, normal-user kind restrictions, admin kind selection/deep links, the VM
card, and the home page's VM table, pipeline line, next action and empty filter state.

## Deploy

Copy `deploy/.env.example` to a gitignored file and fill the seven keys only:

`IDP_DOMAIN`, `IDP_USERS_B64`, `GITHUB_TOKEN`,
`POSTGRES_PASSWORD`, `BACKSTAGE_TOKEN`, `AWS_REGION`, `SSH_CA_SECRET_ID`.

```sh
./deploy/deploy.sh <host> <env-file>
```

This rebuilds locally for `linux/arm64` (type check in parallel with the bundle build) and starts
the services in `/opt/idp`. The image is shipped through a `registry:2` service on the host,
bound to `127.0.0.1:15000` there and reached through an SSH tunnel on local port 15000:
`docker push` uploads only compressed layers the host lacks (usually just the app bundle), and the
host pulls `localhost:15000/compute-factory-idp:latest`. Afterwards it garbage-collects untagged
registry blobs and prunes unused host images. The first deploy to a new host sends every layer. Requires mise, Docker/buildx and the local
`~/.ssh/id_ed25519`. It is non-interactive, uses disposable-host SSH options
without reading/writing known_hosts, and uploads `.env` with mode 0600.
After `docker compose up` it runs `caddy reload`, because a running Caddy does not re-read its
bind-mounted Caddyfile.
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

Postgres, Caddy and registry state use named volumes. Re-running deploy preserves them.
No real host deployment is performed by this repo's build verification.
