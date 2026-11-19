# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Team engineers (primary).** Members of product teams (currently `alpha`, `bravo`) who sign in with a
  username and password, launch a VM (Launch → Compute → Virtual Machines → platform → image → form), watch it being built, fetch a 12-hour SSH user
  certificate and connect from their terminal, then manage it from its page: start, stop, reboot,
  modify (size, software install/uninstall, AD join), apply OS updates, re-apply configuration or destroy.
  They see only their own team's VMs.
- **Platform admins.** Members of `group:default/platform-admins` with global access, including the full
  catalog kind picker (users, groups, templates, locations).
- **Stakeholders / leadership.** The IDP is a POC and must also demonstrate convincingly what a modern
  internal developer platform looks and feels like.

## Product Purpose

Vendy is an internal developer platform for self-service products across infrastructure platforms.
Virtual Machines is its first Compute product. A user requests a VM and the
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
  users actually use the VM (`ssh <user>@<ip>`, `ubuntu` for Ubuntu, `Administrator`/`cfadmin` for Windows
  Server, with key + issued cert). Windows VMs also open a remote desktop in the browser or a native RDP
  client through an SSH forward, with the team's shared password.
- Core flows: sign in → Home (expandable resource overview) → Launch (category → product → platform → image release) → VM form → Launch → live VM run page →
  VM entity page (live state, Connect, Activity, Configuration, Details) → open a browser terminal or
  get an SSH certificate, power actions, Modify form, OS updates, re-apply, destroy.
- The Virtual Machines product page shows live VM state and pipelines across clouds. Resources defaults
  to the `Resource` kind; normal users see only Resource. Search covers the catalog.
- Active run progress and list summaries update about every 5 seconds; catalog facts refresh about every 10 seconds.

## Capabilities and Constraints

- Must keep password sign-in, team-scoped catalog, VM status card, standalone live run view,
  templates (request, SSH cert, modify), VM day-2 actions, search and user settings. Failed runs expose backend-authorized retry/skip; skipped work is not applied. Launch (top bar,
  Home and Resources buttons) lists categories, then products backed by registered templates tagged `product`.
  VMs continue through platform and image release cards; provision uses the selected release. The stock
  `/create` list shows only the VM template; other VM templates open from dedicated VM surfaces.
  Running/stopped state comes from the IDP's periodic health check of each cloud, never from desired configuration.
- Customization only through official Backstage theming, extension overrides, blueprints and frontend
  modules. No forking or patching upstream plugins. Key pages (home, catalog list, VM page, request flow)
  may be rebuilt as custom pages composed from plugin building blocks.
- Light mode only for now; dark mode is not required.
- The frontend mixes MUI v4 (`@material-ui/*`, most Backstage plugins) and `@backstage/ui` (BUI); a
  consistent look must cover both.
- POC scope today: Ubuntu 26.04 and Windows Server 2025 on AWS and Azure (vSphere shown as "Coming
  soon"). Long-term target includes vSphere and more products than VMs, so the design does not assume VMs are the only thing:
  Launch lists products and platforms from data.
- Billing fields are self-reported tags, not billing authorization. Modify uninstalls unchecked catalog
  software (package data and configuration files are kept).

## Brand Commitments

- Name: **Vendy**. Keep the existing mark, palette, and type for the rename.
  The stock Backstage logo and sidebar have been replaced by a top bar with the Vendy
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
