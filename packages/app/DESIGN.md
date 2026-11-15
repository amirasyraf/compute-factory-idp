---
name: Compute Factory
description: A light-only Backstage developer platform whose VM build pipeline is a transit line.
colors:
  ink: "#111316"
  mute: "#5D636B"
  faint: "#8A9098"
  rule: "#E3E5E8"
  surface: "#F3F4F5"
  white: "#FFFFFF"
  blue: "#0B5FD3"
  blueDark: "#0A4FB0"
  green: "#00935A"
  red: "#E8402E"
  redText: "#C2321F"
  grey: "#9AA0A7"
  track: "#D5D8DC"
  station-border: "#C9CDD2"
  bui-border-2: "#d2d5d9"
  retired-label: "#B0B5BB"
  failed-row: "#FEF6F5"
  warning: "#B26B00"
typography:
  regular:
    fontFamily: '"Schibsted Grotesk Variable", "Schibsted Grotesk", system-ui, sans-serif'
  page-title:
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  backstage-title:
    fontSize: "30px"
    fontWeight: 700
    letterSpacing: "-0.025em"
  card-title:
    fontSize: "18px"
    fontWeight: 700
  table-heading:
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.07em"
  ssh-command:
    fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace'
  station-small:
    fontSize: "10.5px"
    lineHeight: 1.3
  station-large:
    fontSize: "12.5px"
    lineHeight: 1.3
rounded:
  chip: "4px"
  control: "6px"
  paper: "8px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
  button-primary-hover:
    backgroundColor: "{colors.blueDark}"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
  software-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.chip}"
  search-trigger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.mute}"
    rounded: "{rounded.control}"
    height: "34px"
---

# Design System: Compute Factory

## Overview

**Creative North Star: "Line Diagram"**

The VM build pipeline is a transit line and each VM is a train on it. The owned
operating surfaces make position, failure and the next action readable together,
rather than substituting a status badge and generic progress bar for the pipeline.
White ground, pale utility surfaces, ink rules and blue travelled track keep the
interface direct and operational. There are no gradient page banners or dark
sidebar in the implemented shell.

This is an implementation reference, not a redesign proposal. It captures the
source-defined system in `src/theme/`, the home/navigation/catalog overrides and
`../../plugins/vm-status/src/`. Product intent lives in `PRODUCT.md`; the selected
direction lives in `.impeccable/surfaces/src-app-tsx.md`. Existing Backstage plugin
surfaces remain visible and do not all use the transit-line grammar.

**Key Characteristics:**
- A shared eight-station line on home, Resources and VM pages.
- Dense, legible operational information with explicit state text and next actions.
- Flat white surfaces, light dividers, restrained rounding and state-bearing colour.
- Light-only, applied through supported Backstage extensions and unified theming.

This document is based on source inspection. It does not claim fresh browser,
accessibility, deployment or real-workflow verification. Only this file is part of
the documentation deliverable; no design sidecar is generated.

## Colors

The palette is neutral first, with one interaction/track accent and distinct
semantic state colours. Frontmatter records actual values, not a newly invented
palette; `cf` and `vmColors` currently duplicate several values in code.

### Primary

- **Line blue (`blue`)**: primary actions, links, selected navigation underlines,
  completed/travelled track, current station, focus outline and input caret. BUI
  solid backgrounds and rings use the same blue.
- **Deep line blue (`blueDark`)**: theme link/button hover and most owned primary
  action hovers. The Resources Request VM button is an exception: its local hover
  is `#0A52B8`, not the shared deep-blue value.

### Semantic

- **Ready green (`green`)**: ready VM bullets/state markers and the home refresh
  indicator. Completed pipeline stations stay blue, not green. Workflow task job
  success text separately uses the theme success green.
- **Failure red (`red`)**: failed VM bullets, crossed failure station and home's
  filled failed-row View run action.
- **Failure text (`redText`)**: failed station labels, error/status copy and the
  outlined Destroy VM action; also the hover of home's filled red action.
- **Retirement grey (`grey`)**: destroying and other/unknown VM markers.
- **Warning amber (`warning`)**: theme warning role, not a sixth VM state.

### Neutral

- **Ink (`ink`)**: titles, primary text, avatar ground and the count strip's top rule.
- **Muted (`mute`)**: secondary text, metadata, inactive navigation and large-line
  default labels. **Faint (`faint`)**: small waiting/skipped labels.
- **White (`white`)**: application/paper backgrounds and station centres.
- **Utility surface (`surface`)**: table headings, software chips, search trigger
  and SSH command background.
- **Rule (`rule`)**: ordinary dividers, card outlines and control borders.
  **BUI secondary border (`bui-border-2`)** is the stronger BUI border token.
- **Untravelled track (`track`)**, **station border (`station-border`)** and
  **retired label (`retired-label`)** distinguish waiting geometry and retired
  lines. Station-border grey is also used for several control hover borders.
- **Failure wash (`failed-row`)**: home failed rows only.

**The Track Is Not Readiness Rule.** Blue records pipeline traversal; green
identifies a ready VM. Skipped stages can carry blue track without being completed
work.

## Typography

**Display and body:** Schibsted Grotesk Variable, then Schibsted Grotesk,
`system-ui`, `sans-serif`. The app entry imports the variable font locally via
Fontsource. **Command face:** JetBrains Mono (imported at weights 400 and 500),
with system monospace fallbacks.

- **Page titles:** the frontmatter page-title role is shared by the home greeting,
  Resources heading and VM name. The home greeting is 32px/700, not an oversized
  marketing headline, and uses balanced text wrapping.
- **Stock page titles:** the theme's Backstage header uses the backstage-title
  role; InfoCard headings use card-title. The MUI h5 override is 15px/700 with
  slight negative tracking; sign-in locally overrides its h1 to 24px with
  `-0.015em` tracking.
- **Operational copy:** owned descriptions commonly use 14px, metadata 13–13.5px,
  detail/status notes 12–12.5px. Inherited plugin body typography is not replaced
  by a separately defined complete size scale.
- **Labels:** table headings are uppercase using table-heading. Navigation,
  buttons, station labels and most section labels remain sentence case. Home
  counts are 26px/700, reducing to 20px on narrow screens.
- **Stations:** small and large roles differ in label size and top spacing, not
  station geometry. Current and failed labels are bold (700).

**The Command Face Rule.** In the owned VM/home content, use JetBrains Mono for
the full `ssh user@ip` command, not standalone IPs, names or general metadata.
The VM access facts render the IP in the regular face. Global CSS also assigns
mono to `code`, `pre`, `kbd` and BUI's monospace token, so inherited code/log
surfaces are not guaranteed to be SSH-only.

**The Aligned Numerals Rule.** Tabular numerals are scoped by global CSS to
`table` and `time`, not the entire application. Do not apply them globally to
Schibsted Grotesk; they also change punctuation widths. Existing timestamp text
outside those elements does not automatically receive tabular numerals.

## Layout

The signed-in shell is a full-height (`100vh`) white flex column. A non-shrinking
top bar (56px) sits above a separately vertically scrollable content area. It is
not a sidebar and is not implemented as an overlay on the page.

Home and Resources use `32px 20px 48px` page padding; home alone declares a
1480px maximum width, without an auto-centering margin. Their headers wrap,
aligning titles and actions at the bottom with a 24px gap. Home's count strip
starts 28px below the header. These are observed measurements, not a new universal
spacing-token scale. Owned surfaces commonly use 8/12/16/20/24px intervals, but
also intentional 10/14/28px gaps; do not claim a strict grid for every measurement.

The VM header uses `20px 20px 0` padding. Content and information cards stack with
24px gaps; where info cards exist, a wide-screen two-column layout gives content
twice the info-column width. Access/configuration facts use auto-filling columns
with a 180px minimum and `12px 24px` gaps.

### Implemented responsive boundaries

| Boundary | Actual effect |
| --- | --- |
| At or below 600px | Pipeline labels are visually hidden except running/failed stations; the line remains eight columns. |
| At or below 760px | Home/Resources padding becomes `24px 16px 40px`; home counts shrink. Top bar tightens padding/gaps, hides the brand wordmark, Search navigation tab and duplicate settings icon; avatar settings access and search trigger remain. |
| At or below 1000px | Home table header disappears; each VM becomes a stacked block, pipeline width becomes fluid, and the action aligns left. |
| At or below 1100px | Top-bar search trigger becomes a 34px icon square and profile name/team text disappears. |
| At or above 1100px | VM content with info cards uses a `2fr / 1fr` split. Exactly 1100px also meets the top-bar compact rule above. |

Above its stacking breakpoint, the home table has a 1080px minimum width and an
overflow wrapper; its pipeline is 520px wide. The Resources pipeline cell stays
300px wide and uses the stock catalog table rather than home's stacked-row
implementation. Settings uses MUI `xs={12}` / `md={6}` columns, retaining the
framework breakpoint rather than one of these owned media queries.

## Elevation & Depth

Owned surfaces are flat and divided by rules, not floating panels. Theme Paper
elevation levels 1 and 2 remove shadows and add a one-pixel rule; Cards also remove
shadows and carry that outline. Buttons disable elevation. This is not a global
assertion that every upstream modal, tooltip or higher Paper elevation is
shadowless: those are not all overridden.

Attention effects are meaningful, not ambient depth: the current station pulses
with a white-separated blue halo over 2.4 seconds using
`cubic-bezier(0.16, 1, 0.3, 1)`. Reduced-motion preference disables that animation.
Home's green refresh dot has a static translucent halo. Owned home buttons and
navigation use short 160ms ease-out colour/border/background transitions.

## Shapes

Controls and command blocks use the control radius; theme rounded Paper uses the
paper radius, and chips use the smaller chip radius. The selected direction's
6px shorthand is therefore not a universal radius in implementation. Ordinary
dividers are one pixel; home's count strip starts with a two-pixel ink rule;
selected navigation/filter underlines are three pixels.

The signature geometry is circular size bullets and station stops joined by a
horizontal line. Home size bullets are 34px; VM-header bullets are 40px. They carry
the first character of the requested size, or `?` when unavailable, in white
heavy type (800). Finalize is a squared terminus cap with a small 3px corner
radius, deliberately distinct from the circular preceding stations. Skipped
stops are ticks, not smaller dots or completed stops.

## Components

### PipelineLine: shared transit grammar

An ordered list, labelled "Pipeline stages", distributes **eight equal stations**:
Validate → Register → Provision → Baseline → Software → AD join → Access → Finalize.
Failure handling (`on-failure`) is a separate process, not a ninth station. Bake is
not an extra station either; home's heading mentions the baked image before fry.

Each station owns its arriving segment; the first has none. Geometry communicates
the process status:

| Process status | Station and arriving track |
| --- | --- |
| `pending` / Waiting | White-centred 12px stop with a 2px neutral border; 2px neutral track. |
| `success` / Completed | White-centred 12px stop with a 3px blue border; 5px blue track; ink label. |
| `running` / In progress | 16px white-centred stop with a 4px blue border, animated halo, bold blue label and 5px blue arriving track. |
| `failed` / Failed | 16px filled red stop with a white cross, bold failure-text label; arriving track stays 5px blue. |
| `skipped` / Skipped | A 2px-wide, 13px-high blue non-stop tick with an italic faint label and 5px blue track. Tooltip says "Skipped (not requested)". |
| `retired` presentation | Overrides all process variants: grey 5px track, neutral outlined stops and retired labels. Used for destroying VMs, not evidence of completed destruction. |

The last station keeps its small-radius cap rule, including if its status changes;
the skipped variant still supplies tick dimensions. Small lines reserve 22px above the label;
large lines reserve 26px. Dot and track dimensions are identical at both sizes.
Large is used by the VM card, small by home and Resources. Labels ellipsize rather
than wrapping. Resources always requests screen-reader-only labels; home/card
labels follow the 600px rule. Each item retains a text status and title tooltip.

The model reads `cf/processes` with legacy `cf/stages` fallback. In that fallback,
Validate and Register are assumed successful, Finalize succeeds only for overall
ready, and failure handling is inferred from overall state. The line is therefore
not always a direct per-process observation. Missing/invalid statuses fall back;
do not present an inferred stop as a new live event.

### VM state vocabulary

Overall VM state and process state are separate concepts:

| VM state | Source `cf/status` | Display / marker |
| --- | --- | --- |
| `ready` | `ready` | Ready; green. |
| `building` | `provisioning` or `frying` | Building · running station, or Building; Provisioning when provisioning has no running station; blue. Home filter calls this In progress. |
| `failed` | `failed` | Failed at the first failed station, otherwise Failed; red marker and darker red text. |
| `destroying` | `destroying` | Destroying; grey marker and retired line. |
| `other` | Anything else or absent | Capitalized raw status, otherwise Unknown; grey. No dedicated home filter. |

Attention helpers choose the first failed station before the first running one.
Overall ready still labels the VM Ready even if process annotations disagree;
the implementation does not resolve contradictory upstream status data.

### Buttons, fields and browser surfaces

Primary owned actions are blue with white text; secondary actions are white,
outlined and ink-labelled. Home/Resources header actions are 40px high with 16px
horizontal padding; home row actions are 34px high with 12px padding; VM-card
actions are 36px high with 14px padding. Button labels use weight 600 without
automatic uppercase. Hover darkens primary backgrounds or strengthens outlines.

MUI TextFields default to outlined. Other form control/error/disabled behaviours
remain framework-owned unless locally set. Global keyboard focus is a 2px blue
outline with 2px offset; text selection uses translucent blue, search highlights
use a lighter blue wash, and links have a 3px underline offset. Thin neutral
scrollbars and blue input carets complete the browser surface treatment. These
rules do not establish a verified contrast/accessibility conformance claim.

### Home

Greeting and team/resource summary lead into Get SSH certificate and Request VM.
The ink-ruled count strip is itself the tablist/filter: All, In progress, Ready,
Failed, Destroying. There is no separate filter-tab row or eyebrow above the
greeting. Selected counts have a blue underline. A refresh note sits above the
table; errors, loading, no-VM and empty-filter states have explicit copy/actions.

Rows show size bullet/name/state, pipeline, details/software chips, **Requested**
time and one next action. Failed rows sort first, then building, ready, other,
destroying, with name sorting within each group. Ready links to the certificate
template; building/failed link to View run only when a run URL exists. No action
is fabricated when unavailable. Home polls the catalog about every 10 seconds.
Team scoping is enforced by the existing catalog permission policy, not a local
team-only filter; administrators can see all VMs.

### Navigation, Resources and VM pages

The top bar combines a three-station blue SVG mark and wordmark, Home / Resources /
Create / Search links, a button opening the stock search modal, settings and an
initials avatar. The apparent search field is a trigger, not an inline text input.
Active navigation has an ink label and blue underline. Avatar access goes to
settings, including when the separate settings icon is hidden.

Resources owns its title/action shell but composes stock catalog filters, table,
search, sorting and pagination. Only a nonempty all-VM result set gets Name,
State, Pipeline, Owner and Lifecycle columns (Title is hidden). Mixed, other and
empty lists use stock column selection. Normal users' kind UI is restricted to
Resource; admins retain the full picker. This is not a new API security boundary.

VM pages replace the entity header with Resources breadcrumb, size bullet, VM
name, favourite star, team, OS/platform, lifecycle and inventory-source link.
Section tabs appear only when there is more than one; otherwise a spacer is used.
The stock About card is hidden only for VMs, whose content cards precede info
cards. The VM pipeline card contains summary/activity, the large line, last-check
note, Access, all nine process rows (including failure handling), and Desired
configuration. SSH certificate, optional GitHub run, prefilled refry and destroy
links remain reachable. Ready promotes certificate access; failed promotes the
run link. Destroy is a red-text outlined action here, not home's filled red style.

### Stock and owned boundaries; known limitations

- **Owned:** theme/BUI browser surfaces, top-bar layout/navigation/mark, home,
  Resources shell and VM columns, kind picker override, VM header/content/card,
  password sign-in composition and the workflow-task augmentation.
- **Retained plugin building blocks:** catalog filtering/table mechanics, entity
  favourites, InfoCards, search modal/results, template picker/form fields and
  stepper, task controls/logs/output and settings profile/identity cards. Other
  entity pages retain their stock entity content/About card. Plain page themes
  apply to these surfaces but do not make them entirely bespoke.
- **Task progress is not PipelineLine:** `WorkflowTasks.tsx` adds horizontally
  scrolling 210px job cards, statuses, durations and expandable steps to the stock
  task page, retaining a determinate progress bar and status chip. Do not claim
  the transit-line rejection of generic bars has already been implemented here.
- **Template/form residue:** template card headers are reordered/styled by the
  theme, but their glyphs remain stock. The request-form stepper and its spacing
  gap are still stock; no owned correction is implemented. Their rendered extent
  has not been rechecked for this document.
- **VM context-menu omission:** custom VM headers do not expose stock unregister
  or inspect menus, including for admins. Destroy remains the supported VM-removal
  route. Do not promise these menus as part of the VM-page action inventory.
- **Age is not status age:** home's "Requested N ago" derives from
  `cf/requested-at`, not a state-transition/observation timestamp. The VM card's
  last-checked time is local catalog-fetch time; ready/failed stop polling, while
  the header remains based on the enclosing entity. None proves when a workflow
  state changed. Home's refresh dot remains green even when an error is shown;
  it is not independently verified workflow health.
- **Light only:** `theme:app/dark` is disabled in `app-config.yaml`. General
  settings intentionally shows only stock profile and identity cards, not theme
  selection or Pin Sidebar controls. No dark palette is defined here.
- **No invented capabilities:** quota, billing totals, Copy SSH, retries and
  real AD verification are not established UI capabilities. Billing is explicitly
  self-reported; desired software is not a reconciled installed inventory.

Password sign-in is an owned composition of themed MUI controls: a narrow
`maxWidth="xs"` container, top margin, outlined username/password fields, inline
error and full-width primary submit with busy text. It is not a separate visual
world. Session restoration initially shows a spinner.

## Do's and Don'ts

### Do

- **Do** reuse PipelineLine and its state helpers across VM operating surfaces;
  keep failure handling outside the eight-station track.
- **Do** preserve the distinct non-stop tick, current halo, red cross and squared
  terminus; colour alone is not the whole line grammar.
- **Do** show real next actions and honest timestamps, keeping request age,
  catalog-fetch time and workflow observation age distinct.
- **Do** theme both legacy MUI and BUI, and keep extension changes upgradeable.
- **Do** retain readable metadata and existing responsive behaviour rather than
  inventing a single app-wide breakpoint or spacing scale.

### Don't

- **Don't** add a dark sidebar, gradient page banner or dark-mode promise.
- **Don't** turn skipped into success or destroying into destroyed.
- **Don't** use mono for ordinary VM facts or force tabular numerals globally.
- **Don't** replace the owned VM pipeline with generic badge-plus-bar progress;
  equally, don't claim stock task/form surfaces have already been redesigned.
- **Don't** invent quotas, costs, retries, menu actions or verified freshness.
- **Don't** treat this source-derived document as evidence of a new browser or
  end-to-end verification run.
