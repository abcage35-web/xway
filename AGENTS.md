# XWAY Agent Instructions

These instructions apply to the whole repository.

## Product Context

XWAY is an operational dashboard for catalog, product, stock, campaign, bid, budget, and performance monitoring. Treat it as a work tool for repeated daily decisions, not as a marketing site.

Primary users need to scan dense commercial data, spot risk, compare periods, and drill into products or campaigns quickly.

## UI/UX Authority

Before making UI changes, read:

- `DESIGN_SYSTEM.md`
- `UX_DECISION_RULES.md`
- `UI_QA_CHECKLIST.md`

When implementation details are open, make UI/UX decisions from those documents instead of asking for every small choice. Ask only when the decision changes product meaning, business logic, or irreversible user actions.

## Interface Principles

- Favor dense but readable operational layouts.
- Preserve existing React, Tailwind, lucide, chart, and component patterns.
- Prefer existing shared components from `xway_dashboard_site/src/components/`.
- Use icons for tool actions when a common lucide icon exists.
- Keep controls predictable: tabs for views, segmented buttons for modes, filters for narrowing data, dialogs for focused drill-down.
- Make all tables, charts, and toolbars robust on narrow screens.
- Always include loading, empty, error, and long-content states when a feature can encounter them.

## Visual QA

For meaningful frontend changes:

1. Run the relevant build or typecheck command.
2. Inspect the page in a browser at desktop and mobile widths.
3. Check against `UI_QA_CHECKLIST.md`.
4. Fix overflow, unreadable labels, clipped controls, weak contrast, and broken loading states before finishing.

## Non-Goals

- Do not introduce landing-page patterns into the dashboard.
- Do not add decorative gradients, blobs, oversized hero sections, or generic AI-style card grids.
- Do not replace working local patterns with a new design framework unless explicitly requested.
