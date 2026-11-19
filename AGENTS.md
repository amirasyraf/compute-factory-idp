# Agent instructions: Vendy IDP

- Read the shared rules in `../vendy/AGENTS.md` and the relevant sections of `../vendy/CONTRACTS.md`
  before changing a cross-repo interface. `README.md` is the human entry point; keep implementation
  detail in `REFERENCE.md` and UI design decisions in `packages/app/DESIGN.md`.
- `packages/app` owns the shell and product flows, `plugins/vm-status` owns VM and run views, and
  `plugins/cf-backend` owns login, permissions, VM orchestration, and cloud/API access.
- Derive user identity and team membership on the server. Don't widen the static workflow token or
  move a PAT, password, CA key, or other server credential into browser config. The public Git
  inventory is outside the portal's team authorization.
- Keep local automation off unless an authorized live workflow test explicitly needs it. Preserve
  short HTTP requests for live progress and browser access; SSE and WebSockets had proxy issues.
- No new unit tests or test scaffolding. Use lint, type-check/build, `scripts/smoke.mjs`, and the
  existing browser fixtures as appropriate. Fixtures don't prove real cloud behavior.
- For an authorized app release, run `./poc deploy-idp <image-id>` from the `vendy` checkout with
  the tested image, then run the signed-in live check against the existing host. Don't
  start or tear down the POC for docs or offline checks.
