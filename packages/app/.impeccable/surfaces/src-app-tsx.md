---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/modules/home/HomePage.tsx","src/modules/nav/TopBar.tsx","src/VmTaskRedirect.tsx"]
---

# Vendy app shell and VM surfaces

Scope: signed-in shell, Home, Launch, Resources, VM pages, and task handoff, plus sign-in.
Use [DESIGN.md](../../DESIGN.md) for tokens, layouts, and limits; use
[PRODUCT.md](../../PRODUCT.md) for the user flows.

Keep the line diagram for actual stage state, not as decoration. Home is a resource overview.
Launch is where people request something, and Virtual Machines is where they follow and operate
their VMs. Read quota, retry, and skip information from the backend rather than inventing it.
