---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/modules/home/homeModule.tsx","src/modules/nav/Sidebar.tsx","src/WorkflowTasks.tsx"]
---

# Compute Factory app shell and VM surfaces

Scope: the whole signed-in app (shell, home, resources list, VM entity page, request/task pages), plus sign-in. Mode: Operate.
Audience: team engineers requesting and operating VMs; platform admins; stakeholders seeing a modern IDP.
Task: see where every team VM is in its pipeline, act on the next step (SSH cert, view run, refry, destroy), request new VMs.
Constraints: Backstage new frontend system, official extension/theming surfaces only; MUI v4 and BUI both themed; light mode only; no invented capabilities (no quotas, costs, retries).

## Direction contract

THESIS: The build pipeline is a transit line and every VM is a train on it. Refuses the category default of status badges plus a progress bar, and Backstage's dark sidebar with gradient header banners.

OWN-WORLD: White ground, #F3F4F5 surfaces, #E3E5E8 rules, ink #111316, line blue #0B5FD3 for primary and travelled track, green #00935A ready, red #E8402E failure, muted #5D636B. Schibsted Grotesk with tabular numerals; JetBrains Mono only for IPs and commands. Station-dot timelines, round line bullets carrying the size letter, 6px radii, 2px ink rule over stats.

STORY: The visitor sees their team's machines, reads each one's position on the line at a glance, spots the failure, and takes the one next action.

FIRST VIEWPORT: Slim 56px white top bar (mark, Home/Resources/Create/Search, search field, settings, avatar). Eyebrow plus greeting left, Get SSH certificate and blue Request VM right. Ink-ruled count strip (Ready, In progress, Failed, Destroying). Filter tabs and live refresh note. VM table: bullet and name, eight-station pipeline line, details, updated, one action.

FORM: Line Diagram, position 1 of the ordered list (the roll assigned position 3; user chose this pick). seed:5e6fe49fa78b0cb0

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- Sketch's "vCPU quota" stat and "Copy SSH" action are not real capabilities; drop quota, use Get SSH certificate.
