# Compute Factory IDP

Backstage 1.56, scaffolded at the repository root with **the new frontend system**,
Node 24 (`mise.toml`) and the scaffold's vendored Yarn 4.13.0.

## Custom code

- `plugins/vm-status`: the VM entity card, the run page and the shared run helpers, only for
  `Resource` / `spec.type: vm`. All run data comes from the `vms` backend API (`runs.ts`), never from a
  browser GitHub token.
  - **Run page** `/vms/runs/<id>` (`RunView.tsx`, a `PageBlueprint`): run header (kind, VM, status,
    requester, short start time, elapsed duration, error) and compact ordered stage rows with a status
    dot, human status and duration. Retry attempts show their budget and countdown; failed/retrying
    errors stay visible. Stages that ran have one details expander with the GitHub attempt, job steps,
    earlier attempts, and `skippedBy`/`retriedBy`. **Retry** and **Skip** appear only when the API's
    `actions` allow them; Skip asks for confirmation and says the stage's work will not be applied.
    It polls every 5 seconds while the run is running and works before the VM's catalog entity exists,
    which is why VM templates link here.
  - **VM page** (`VmPage.tsx` header, `VmStatusCard.tsx` body, `VmActions.tsx`, shared poller
    `vmLive.ts`): the header shows the live state and the day-2 actions (Start/Stop, Reboot, Modify;
    ⋯ Apply OS updates, Re-apply configuration, Destroy) with confirm dialogs (Destroy asks for the VM
    name). Actions post to `POST /api/vms/runs` with a per-dialog UUID request key; Modify opens the
    `vm-modify` template prefilled with the current configuration. The body has Connect (SSH command,
    **Open terminal**, certificate), Activity (active/failed run with retry/skip, then the last 10 runs), Configuration
    and Details (health check, instance, provenance). With no known run it falls back to `cf/status`.
    When a refresh finds the entity removed from the catalog it shows "Destroyed" and stops polling.
  - Desired compute/configuration/billing/tags come from the entity's structured `spec`. Modify
    replaces the software list, so unchecked catalog software is uninstalled.
    Tags (`cost_center`, `project_code` and custom tags, shown as one cloud tags line) are self-reported,
    not organizational billing authorization. The request form's `VmTagsEditor` field
    (`packages/app/src/VmTagsEditor.tsx`) is one key/value table with fixed, required `cost_center` and
    `project_code` rows and optional extra tags; `/api/vms/requests` rejects requests without them.
    Custom spec validation is performed by the platform `register` stage; malformed custom fields are
    rendered defensively by the card.
   - It also exports `PipelineLine` (the run's stages drawn as a transit line; skipped stages are
     non-stops; every run kind draws its own stages) and the summary hook used by Home,
     Virtual Machines and Resources. For VM entities only it supplies an `EntityHeaderLayoutBlueprint` header (name, state
    pill, favourite star, actions, team, OS/platform, size) and an `EntityContentLayoutBlueprint`
    layout that puts the VM card first.
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
  sidebar, and supplies that bar through `NavContentBlueprint` (Home, Resources, Launch, Search,
  search modal, settings and the signed-in user). The stock template list (`page:scaffolder`,
  `/create`) is no longer in the bar; its routes still work.
- `packages/app/src/products/catalog.ts`: product categories, IDs, resource types, and template names
   shared by Home, Resources and Launch. The only product is **Compute → Virtual Machines**.
- `packages/app/src/launch/`: **Launch** (`/launch`) starts with product categories, then products
   whose registered Scaffolder templates are tagged `product`. At `/launch/compute/virtual-machines`,
   platform cards show provider names (vSphere is marked **Coming Soon**). The next step shows
   selectable OS/release cards from `GET /api/vm-sizes/platforms`; the only choice is preselected.
   **Continue** prefills `compute.{platform,os,imageVersion}`. Admission and the platform workflow
   validate the selected release; the workflow provisions the newest bake of that release.
   Earlier steps are linked, the form's **Change** link restores the image selection, and old
   `/launch/vm-request[/<platform>]` links redirect.
- `packages/app/src/modules/home/`: a `HomePageLayoutBlueprint` for the greeting and **Your Resources**.
   It groups catalog-visible Resources by category/product, with counts and linked resource rows.
   VM rows show platform and state. Unclassified catalog resources are listed under **Other Resources**.
- `packages/app/src/products/VmProductPage.tsx`: **Virtual Machines** (`/products/compute/virtual-machines`)
   has status filters, each VM's pipeline and next action (SSH certificate or run), Demo Mode and a
   shortcut to VM platform selection. Home, the product page and Resources join `GET /api/vms/summary`
   by VM name on refresh (about every 5 seconds), falling back to `cf/status`. VM visibility remains
   team-scoped (admins see every VM). Status labels name the kind
  of run (`vmRunLabel` in `plugins/vm-status/src/pipeline.tsx`, shared with the VM page): "Building ·
  <stage>", "Modifying · <stage>", "Re-applying configuration · <stage>", "Starting"/"Stopping"/
  "Rebooting", "Updating OS", "Destroying", a "· retrying" suffix while a stage waits to retry, and
  "Failed at <stage>" / "<Action> failed" / "Needs attention" on failure. Otherwise the summary's
   health check decides: "Running", "Stopped", "Instance not found" (Virtual Machines has a Stopped filter). The time shown is
  absolute and labelled: "Ready since …" from `cf/ready-at`, otherwise "Requested …".
   Home and Virtual Machines use the same full-width gutters as Resources.
- `plugins/cf-backend`: one backend package, registered against `auth`, `permission` and
  `scaffolder`, plus the `mock-rest` and `vms` plugins (Backstage extension points belong to separate plugin IDs).
  Implements password sign-in, the team policy, `cf:ssh:sign`, `cf:vm:dispatch` and `cf:vm:run`. The two VM
  actions only create an orchestrator run (see **VM orchestrator** below) and finish; they retry
  timeouts and server errors with the same task ID, and both endpoints are idempotent per task, so a
  retry returns the existing run rather than requesting a second VM. GitHub reads use ETag conditional
  requests so unchanged polls do not consume the token's 5,000/hour rate limit. Without demo mode, a
  failed inventory scan does not block requests; with demo mode it fails closed (quota cannot be checked).
  Scaffolder task recovery is on (`scaffolder.taskRecovery.enabled`): a task interrupted by a backend
  restart resumes after its last completed step.
- **VM orchestrator** (`plugins/cf-backend/src/orchestrator.ts`, served by the `vms` plugin in
  `vms.ts`; contract in the orchestrator repo's `CONTRACTS.md` §8.2). It owns stage order, retries
  and run state in the plugin database; GitHub Actions only executes one platform `stage.yml` stage
  per dispatch, except stages that run inside the IDP itself (today the mock ServiceNow request, the
  provision run's first stage; see `inProcess` in `vms.ts`). A 10-second worker dispatches due stages, polls their GitHub run and job steps, and
  advances the run: up to 4 attempts per stage with 30 s / 2 min / 8 min backoff, a 45-minute attempt
  deadline, and no automatic retry for permanent failures (the stage's `Validate inputs` step failed,
  `startup_failure`, a rejected dispatch, or an in-IDP stage's non-transient error). Each attempt is stored with its run key before dispatch,
  so a lost dispatch response is recovered from the run title instead of dispatching again. When a
  stage fails for good, `finalize` records `cf/status: failed` and the run waits for a person:
  **Retry** (fresh attempt budget, then continue) or, for `software` and `ad-join` only, **Skip**.
  Admins and members of the run's team can do either. Destroy supersedes any other active run of
  that VM; any new run supersedes a failed day-2 run. Run kinds: provision, modify, reapply, power
  (start/stop/reboot), update (OS updates), destroy. Stage lists are code, not configuration.
  Routes under `/api/vms`: `GET /runs/:id`, `GET /runs?name=`, `GET /summary`, `GET /observed/:name`,
  `POST /runs/:id/retry|skip`, `POST /runs` (day-2 runs, from the VM page and `cf:vm:run`) and
  `POST /requests` (provision admission, from `cf:vm:dispatch`). Run visibility is team-scoped like
  the catalog. `POST /runs` diffs a Modify against the entity spec and refuses (409) operations the
  health check shows cannot work (for example Reboot on a stopped VM).
- **Browser terminal** (`plugins/cf-backend/src/terminal.ts`, `plugins/vm-status/src/VmTerminal.tsx`,
  CONTRACTS.md §8.4): `POST /api/vms/terminal` signs a fresh key with the SSH CA for 5 minutes (principal
  of the VM's team, key ID `idp-terminal:<user>`) and runs the system `ssh` as the VM's `cf/ssh-user` in a PTY (`node-pty`, built
  in the image; on macOS the prebuilt `spawn-helper` may need `chmod +x` for local runs). The xterm.js
  dialog posts keystrokes and long-polls output over plain HTTP. Two sessions per user, 15-minute idle
  and 90-second orphan timeouts, open/close logged; production only (`demoAutomation`).
- **VM health check** (`plugins/cf-backend/src/observed.ts`, CONTRACTS.md §8.3): only where
  `computeFactory.demoAutomation` is on, a 30-second scheduled task (and a scan after each finished
  day-2 run) scans every platform and keeps each platform's result in memory separately (a failing
  cloud keeps its last result): state, status checks, type, public IP, request ID and team per `cf:vm`
  tag, plus `platform`. AWS: `ec2:DescribeInstances`/`DescribeInstanceStatus` for `cf:poc=true`
  instances with the host role (infra policy `observe-vms`). Azure: ARM VM list (with power state),
  public IPs and Resource Health with the Reader principal (`plugins/cf-backend/src/azure.ts`;
  credential from Secrets Manager `AZURE_READER_SECRET_ID`, `@azure/identity` certificate auth, plain
  `fetch` to ARM). Freshness and refusals use the VM's own platform (from its spec). `GET
/observed/:name` and `/summary` expose it team-scoped. Locally it is off (`enabled: false`).
- `packages/app/src/DemoModePanel.tsx`: the Virtual Machines page's Demo Mode status, per-account usage, expiry countdowns
  and admin-only global toggle with destructive confirmation. Membership in `platform-admins` controls
  access; the roster lives only in `catalog/org.yaml`.
- The Scaffolder task page is the stock one, wrapped by `packages/app/src/VmTaskRedirect.tsx`: when a
  `vm-request` or `vm-modify` task completes successfully, the browser goes straight to its
  run page (`/vms/runs/<id>`, history replaced, so Back returns to the form). It takes the run from a
  same-origin `/vms/runs/<n>` output link (or a numeric `runId` in the task's completion output; step
  outputs are not visible to the stock task API). Failed or cancelled tasks (quota, conflicts) stay on
  the task page so the error is visible; other templates are unaffected. The earlier GitHub-job stage
  view on the task page was removed with `cf:watch-workflow`.
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
- **Platforms, VM sizes and instance types** (`plugins/cf-backend/src/{platforms,vmSizes,azure}.ts`,
  `packages/app/src/VmComputePicker.tsx`, `plugins/vm-status/src/vmSizes.ts`), signed-in users only;
  CONTRACTS.md §10a:
  - Each platform's `terraform/platforms/<p>/{platform.json,sizes.json}` is read from the platform repo's
    `main` through the GitHub API (cached 5 minutes, last good copy kept during outages). `PLATFORMS`
    (`aws`, `azure`) is the list the IDP can read specs and health for; `COMING_SOON` adds vSphere.
  - `GET /api/vm-sizes/platforms`: label, availability, images (`os`: id, label, versions), tag
    rules and `staticPublicIp` per platform, for Launch, the tags editor and the stop/start wording
    (Azure keeps its address; AWS gets a new one).
  - `GET /api/vm-sizes/sizes?platform=<p>` (default `aws`): XS-L with vCPU, memory, architecture and
    network. AWS from `ec2:DescribeInstanceTypes` (cached 1 hour); Azure from the Resource SKUs API,
    with `quotaOk`. Without cloud access it returns an `error` and types without specs.
  - `GET /api/vm-sizes/instance-types?platform=<p>`: AWS every x86_64, EBS-backed type offered in the
    region (`DescribeInstanceTypeOfferings` + `DescribeInstanceTypes`, `mac*` excluded). Azure every VM
    size without a location restriction that boots the x64 Gen2 image, categorized by series letter;
    Azure has no generation flag, so every size counts as current and the toggle is hidden. `quotaOk`
    compares free family and regional vCPU quota (Compute usages, cached 5 minutes) with the size's
    vCPUs; sizes over quota are shown greyed out as "Over vCPU quota" (B-series has no quota in this
    subscription and the region allows 10 vCPUs). Cached 1 hour; the last good list is kept on errors.
   - The platform template's `ui:field: VmComputePicker` on `compute` shows the platform and versioned image chosen
    on Launch with a **Change** link (not on Modify: `ui:options.locked`), size **cards** (size,
    instance type, vCPU, memory, network, CPU) and a collapsed **Advanced** picker: category tabs with
    counts, rows grouped by family, search, family/min vCPU/min memory filters, a current-generation
    toggle (AWS) and sortable type/vCPU/memory columns. It submits exactly one of `size` or
    `instanceType` and preselects `S` (the schema has no `size` default, which the form would otherwise
    re-add beside an instance type). `VmSizePicker` (cards only, on a `size` string) stays registered for
    the earlier template revision.
  - `VmTagsEditor` ("Cloud tags") marks keys reserved by the chosen platform (`reservedTagPrefixes`) or
    containing its forbidden characters (Azure `<>%&\?/`); submit-time validation applies every
    platform's rules. The platform's `spec.py` is authoritative.
  - **Demo mode:** `/api/vms/demo/state` returns `instanceTypes`: every platform's `sizes.json` values;
    while it is on, other types are greyed out and unselectable, and `/api/vms/requests` and Modify
    reject them (403; 503 while the size files cannot be read).
   - The product-page row, VM header and VM card show the launched type from `cf/instance-type`, else the
     requested `instanceType` ("Custom · …") or the type the size maps to now. The product-page size badge shows the
    size (`XS`…`L`) or `◆` for a custom type. The Modify form reuses `VmComputePicker`.
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

- **Backstage** logs JSON to stdout. The access log line is written when a request _finishes_. With
  `backend.trustProxy: 1` (production), audit and client-log entries carry the real client IP.
- **Browser reports** appear as `warn` lines `Browser <kind>: <message>` with
  `type: clientEvent`, the user, client IP, user agent, page and bundle hash
  (`plugins/cf-backend/src/clientLog.ts`; signed-in users only, 8 KB body, 60 per user per minute).
- **Caddy** writes a JSON access log for every request: client IP, status, size and duration.
  `Authorization` and `Cookie` headers are redacted by Caddy.
- Orchestrator lines start with `VM run <id> <name>`: creation, every stage dispatch (with its GitHub
  run ID), failed attempts with the next retry delay, permanent failures, manual retry/skip with the
  user, and the run outcome. GitHub API failures include GitHub's message and `x-github-request-id`.
- Run and stage state is in Postgres DB `backstage_plugin_vms` (`vm_runs`, `vm_run_stages`; demo
  mode uses `demo_settings`, `demo_vms` in the same database).
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
 page shell: a "Resources" heading and Launch button, with the stock `CatalogFilterLayout`,
the `catalog-filter` extension inputs (including `CatalogKindFilter`) and the stock `CatalogTable`
 for search, sorting and paging. Resource results include a Product column and can be filtered by Type.
 When every listed entity is a VM, the table shows State and
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
  Thus day-2 runs (`POST /api/vms/runs`) read the VM with the user's credentials, not a privileged service lookup.
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

Demo mode defaults **off**. On Virtual Machines, platform admins can enable/disable it without redeploying.
Enabling destroys oldest excess VMs, keeping the newest three per requesting account, and gives
existing ready/failed VMs five minutes from enable time. New VMs get five minutes from first readiness
(or terminal failure if never ready). Day-2 runs, including stop, do not extend the deadline. A fourth request is refused;
queued, provisioning, failed and destroying VMs all occupy quota until their inventory is gone.
Quotas are per original requester, not per team, and include admins.

The `vms` plugin stores settings, deadlines and reservations in its database and checks Git
inventory every 15 seconds. Cleanup creates an orchestrator destroy run (the platform `destroy` stage
and Terraform) rather than terminating EC2 directly. Failure timers start only when `finalize` records
a failure after retries, not on a transient failure that is being retried.
Disabling invalidates queued cleanup; already-started destruction cannot be undone. Re-enabling starts
fresh timers. IDP/GitHub downtime delays cleanup, and Actions queues/Terraform add time after expiry.
This is a POC cost-control convenience, not an independent hard termination guarantee.

The deployment enables `computeFactory.demoAutomation: true`. It defaults false elsewhere so local
development and the existing smoke environment can exercise real controls without launching or deleting
production VMs. Local requests are refused while automation is disabled. Production is single-instance:
do not scale the backend horizontally without replacing its admission mutex with distributed locking.

Each VM gets one cleanup destroy run per demo-mode generation; the orchestrator retries its stages.
If that run still fails, the VM shows "Cleanup stopped" and an operator retries the run from its run
page (or toggles demo mode off and on, which starts a new generation and a new run). A reservation
whose provision run ended without ever registering inventory is released; that run can no longer be
retried. Repository writers/dispatch-token holders are trusted and can dispatch `stage.yml` directly;
do not give that access to demo users. The worker still reconciles their inventory against the policy.

### Setup

```sh
mise trust
mise install
mise exec -- node .yarn/releases/yarn-4.13.0.cjs install --immutable
```

Set `IDP_USERS_B64` in your shell using a throwaway password file for interactive local development.
There is no guest or GitHub sign-in provider. `scripts/smoke.mjs` starts temporary local backend and Caddy containers, checks
readiness/org/locations/templates and the mock REST endpoint's authentication, and stops both; run it with the token
in the environment after the image build. It uses SQLite and a dummy catalog-only
static token and freshly generated throwaway login; the GitHub integration token is inherited by
Docker through environment only. It exercises the real Caddy rewrite to the mock endpoint and its
rejection of anonymous, catalog-token and user calls, without dispatching GHA. The orchestrator's
own ServiceNow POST only happens inside a run, which local automation never creates, so that call is
verified live after deploy. It also runs the existing fixture-API browser
checks against this local frontend. No production configuration or AWS credentials are needed.
These checks verify admin/non-admin demo controls and the orchestrator's authenticated read APIs
against the real local backend/database with automation disabled (no run can be created or
dispatched locally). They do not verify live orchestration, VM expiry/provisioning or a real
ServiceNow service; those are checked live after deploy.

### Mock ServiceNow REST demo

Every provision run starts with the **ServiceNow request** stage, which runs inside the IDP (not in
GitHub Actions). It sends VM name/team/platform/OS/size, the requester's entity ref and the run's
request ID to `POST https://idp.amirasyraf.dev/mock-rest/servicenow`. Caddy rewrites that exact path
to the `mock-rest` plugin's `/api/mock-rest/servicenow` route. The receiver returns HTTP 201 with
`{number: "RITM…", status: "created", mock: true, requestId}`, and the stage shows
"RITM… created (mock ServiceNow)" on the run page. The number is deterministic for a request ID, but
the receiver is stateless: no real ticket, approval, record lookup, persistence or
provisioning-status update is implemented. Day-2 runs do not call this demo endpoint.

The endpoint accepts only Backstage service credentials from `plugin:vms`; it is not an anonymous
public webhook. The workflow token is restricted to `catalog` and `vms`, where it can only call the
read-only demo cleanup check; it still cannot call the mock receiver. No new shared secret is needed.
The client uses a backend-configured URL constrained to this IDP origin and exact mock path,
disallows redirects, and aborts after ten seconds. HTTP 5xx/429, timeouts and network errors are
retried like any stage; any other non-201 or malformed response fails the stage without retries, so
no VM is registered. No tokens or full request bodies are logged.
Local development uses `computeFactory.mockServiceNowUrl` at `http://localhost:7007/api/mock-rest/servicenow`;
production overrides it with the public HTTPS demo path.

For interactive development:

```sh
GITHUB_TOKEN="$(gh auth token)" NODE_OPTIONS=--no-node-snapshot \
  mise exec -- node .yarn/releases/yarn-4.13.0.cjs start
```

SQLite is in-memory; local catalog state is disposable. File locations in the
base config are relative to `packages/backend`. Stop with Ctrl-C. Do not store
the GitHub token in a file. Signing locally additionally requires `AWS_REGION`,
`SSH_CA_SECRET_ID` and AWS default-chain access to the secret. Azure specs and the Azure picker
additionally need `AZURE_READER_SECRET_ID=compute-factory/azure-reader` and access to that secret;
without it they return "Azure is not configured" errors.

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
offline workflow integration check, and focused browser smoke checks. Browser checks cover the run
page (running, retrying with countdown, failed with Retry/Skip, Skip confirmation, succeeded, earlier
attempts, API errors, polling stop/resume), the VM page's latest run, live Running/Stopped state,
day-2 action dialogs and the requests they post, Modify prefill and destroyed state, the list
summary join and fallback, the demo panel's `vms` routes, and unchanged stock task controls; fixture
data alone does not verify a real VM run. The task fixture serves `/events` as a long-poll endpoint and
fails if the page opens `/eventstream`. Against a built (hashed) frontend it also simulates a deploy
and checks that the new-version banner appears; on the dev server that check is skipped.
`scripts/workflow-ui.mjs` uses installed Google Chrome and fixture API responses to check the served
 frontend without signing in, dispatching a workflow or changing backend state. It also walks
 Home → Compute / Virtual Machines and Launch → Compute → Virtual Machines → platform → image. A
 multi-release AWS fixture checks selection and submitted form payload; Azure checks a single
 automatically selected release, live-size presentation with a quota-blocked size, and Azure tag rules.
Set `WORKFLOW_UI_SCREENSHOTS` to a temporary directory to capture run states, entity cards and lists
at 1440px and 390px widths during the same fixture smoke. Inspect the images, then delete the directory.
`scripts/live-check.mjs` signs in to the deployed IDP with a real POC login (from the orchestrator's
 gitignored `.poc-passwords`) and checks, read-only, the grouped Home, VM product page, both image
 pickers, form prefill, the request form's live AWS instance types and
specs, that the newest own task page receives events by long polling, and that the newest visible VM
run's page renders all its stages (read-only; it never presses Retry or Skip). Run it after every deploy.

## Deploy

Copy `deploy/.env.example` to a gitignored file and fill the eight keys only:

`IDP_DOMAIN`, `IDP_USERS_B64`, `GITHUB_TOKEN`,
`POSTGRES_PASSWORD`, `BACKSTAGE_TOKEN`, `AWS_REGION`, `SSH_CA_SECRET_ID`, `AZURE_READER_SECRET_ID`.

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
- EC2 role can read only the secrets `compute-factory/ssh-ca` and `compute-factory/azure-reader`
  (plus read-only EC2 describe calls); IMDSv2 hop limit 2 for Docker.
- Infra-generated Postgres password/static token; platform workflow secret
  `BACKSTAGE_TOKEN` matches the runtime value. External access is restricted to
  the `catalog` and `vms` plugins using the current `backend.auth.externalAccess` shape.
- Health: `https://idp.amirasyraf.dev/.backstage/health/v1/readiness` returns 200
  through Caddy (paths are proxied unchanged except the exact mock ServiceNow path described above).

Postgres, Caddy and registry state use named volumes. Re-running deploy preserves them.
No real host deployment is performed by this repo's build verification.
