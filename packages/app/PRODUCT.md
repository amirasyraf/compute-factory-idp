# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Team engineers (primary).** Members of product teams (currently `alpha`, `bravo`) who sign in with a
  username and password, request a VM through a form, watch it being built, fetch a 12-hour SSH user
  certificate and connect from their terminal, then refry (add software / AD join) or destroy the VM.
  They see only their own team's VMs.
- **Platform admins.** Members of `group:default/platform-admins` with global access, including the full
  catalog kind picker (users, groups, templates, locations).
- **Stakeholders / leadership.** The IDP is a POC and must also demonstrate convincingly what a modern
  internal developer platform looks and feels like.

## Product Purpose

Compute Factory is an internal developer platform for self-service compute. A user requests a VM and the
platform builds it the same way every time: golden image (bake) → Terraform provision → Ansible fry stages
(baseline, software, AD join, access) → ready, with SSH access via CA-signed certificates. Success means a
user goes from request to a working SSH session without filing a ticket, and can always see where their
VM is in that pipeline.

## Positioning

Every VM is built through one visible, staged pipeline owned by the IDP orchestrator: in-IDP stages such as the mock ServiceNow request and GitHub Actions VM stages share the same run page. Each VM's
`catalog-info.yaml` in Git is its single desired-configuration source and inventory record. The IDP shows
live stage/attempt progress on a standalone run page and the VM's page. VM tasks create a run and automatically hand off to its page on success, without waiting for provisioning; task failures stay visible on the stock task page.

## Operating Context

- Built on Backstage 1.56 (new frontend system). The web app is the only surface; the terminal is where
  users actually use the VM (`ssh ubuntu@<ip>` with key + issued cert).
- Core flows: sign in → home → request VM (Scaffolder template form) → Create → live VM run page →
  VM entity page with status card → get SSH certificate / refry / destroy templates.
- Catalog defaults to the `Resource` kind; normal users see only Resource. Search covers the catalog.
- Active run progress and list summaries update about every 5 seconds; catalog facts refresh about every 10 seconds.

## Capabilities and Constraints

- Must keep password sign-in, team-scoped catalog, VM status card, standalone live run view,
  templates (request, SSH cert, refry, destroy), search and user settings. Failed runs expose backend-authorized retry/skip; skipped work is not applied. The Create page
  lists only "Request a VM"; the other templates act on an existing VM and open from the VM page or Home.
- Customization only through official Backstage theming, extension overrides, blueprints and frontend
  modules. No forking or patching upstream plugins. Key pages (home, catalog list, VM page, request flow)
  may be rebuilt as custom pages composed from plugin building blocks.
- Light mode only for now; dark mode is not required.
- The frontend mixes MUI v4 (`@material-ui/*`, most Backstage plugins) and `@backstage/ui` (BUI); a
  consistent look must cover both.
- POC scope today: Ubuntu on AWS only. Long-term target includes Windows, Azure, vSphere and possibly more
  resource types, so the design should not assume VMs are the only thing forever.
- Billing fields are self-reported tags, not billing authorization. Refry software installs are additive.

## Brand Commitments

- Name: **Compute Factory**. No existing logo, colour, typeface or voice; identity is free to create.
  The stock Backstage logo and sidebar have been replaced by a top bar with the Compute Factory
  transit mark.

## Evidence on Hand

- Real templates and org data in `catalog/` (users/teams, locations, `ssh-cert` template) and the platform
  repo's VM templates and `vms/*/catalog-info.yaml` inventory.
- No customers, metrics, testimonials or usage numbers exist; none may be invented.

## Product Principles

1. The pipeline is the product: always show where a request is and what happens next.
2. Self-service without tickets: every action a user needs is reachable from the VM itself.
3. Honest status: show observed state and its age; never imply something succeeded or stopped when it
   was only last observed that way.
4. Team-scoped by default: people see their team's resources first and only.
5. Stay upgradeable: express the design through Backstage's supported extension surfaces.
