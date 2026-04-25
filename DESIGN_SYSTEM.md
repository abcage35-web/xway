# XWAY Design System

This document defines the default UI decisions for XWAY. It is a source of truth for AI agents and developers working on the dashboard.

## Product Character

XWAY should feel like a precise commercial operations console:

- calm, practical, and data-first;
- fast to scan during repeated daily use;
- clear about risk, spend, stock, conversion, and campaign status;
- visually polished without looking promotional.

Avoid landing-page composition. The first screen should be the tool itself: filters, metrics, tables, charts, and drill-down entry points.

## Users And Tasks

Primary users monitor marketplace performance and advertising operations. They need to:

- find products or catalog rows quickly;
- compare current and previous periods;
- notice budget, bid, stock, turnover, and campaign issues;
- drill from summary to product, campaign, cluster, bid, or budget detail;
- make decisions without losing context.

## Layout

- Use full-width dashboard surfaces with constrained inner spacing.
- Prefer two-level hierarchy: page toolbar, then content sections.
- Keep primary filters and date range controls near the top.
- Keep summary metrics close to the data they summarize.
- Avoid nesting cards inside cards. Use section surfaces, repeated row/card items, and dialogs only where the content needs a frame.
- Preserve stable dimensions for tables, charts, control bars, status chips, and product image areas so data updates do not shift the layout.
- Use responsive grids with explicit min/max widths for dense blocks.

## Navigation And Flow

- Catalog view is for scanning many products and finding attention areas.
- Product view is for deep investigation and period comparison.
- Dialogs should support focused drill-down without losing the current page state.
- Links to external marketplace/product pages should be visually secondary but easy to find.

## Components

Use existing shared components before creating new ones:

- `MetricCard` for high-level KPIs.
- `MetricTable` for dense sortable data.
- `SearchField` for local filtering.
- `SectionCard` for major grouped sections.
- `EmptyState` for missing or filtered-out data.
- Existing history and cluster dialogs for drill-down patterns.

When adding controls:

- use segmented controls for mutually exclusive modes;
- use checkboxes or toggles for binary settings;
- use sliders, steppers, or numeric inputs for thresholds;
- use dropdowns or multi-selects for option sets;
- use lucide icons for compact tool actions.

## Visual Style

Current direction:

- light dashboard UI;
- white and soft grey surfaces;
- restrained orange brand accents;
- blue for informational accents;
- green/amber/rose for status and risk;
- IBM Plex Sans for body text;
- Space Grotesk for display headings.

Keep the palette functional. Color should communicate grouping, state, or priority, not decorate the page.

Avoid:

- purple-blue AI gradients as a dominant motif;
- decorative blobs, glows, and bokeh backgrounds;
- oversized rounded cards for every element;
- glass effects that reduce readability;
- negative letter spacing in compact dashboard text;
- viewport-scaled font sizes.

## Typography

- Body text should prioritize legibility over personality.
- Use compact headings inside dashboard sections.
- Reserve large display text for page-level titles only.
- Keep table labels short and scannable.
- Use uppercase micro-labels sparingly for stable metadata, not paragraph text.
- Long product names, article IDs, and campaign names must wrap or truncate intentionally.

## Data Presentation

- Put the decision metric first: spend, orders, conversion, stock, turnover, campaign state, or budget risk depending on the view.
- Always show units: currency, percent, days, hours, clicks, views.
- Deltas must indicate direction and comparison period.
- When data is stale, cached, partial, or failed, show that state directly near the affected data.
- Charts should answer a specific operational question; do not add charts only for visual variety.
- Tables should support scanning through alignment, sticky headers where useful, compact row rhythm, and clear status marks.

## Status Semantics

Use consistent status meanings:

- green: active, healthy, positive progress;
- amber: warning, limited, delayed, needs attention soon;
- rose/red: failure, spend risk, broken flow, urgent issue;
- blue: informational or selected state;
- muted grey: inactive, paused, missing, secondary.

Do not rely on color alone. Pair color with text, icon, position, or status label.

## Accessibility

- Maintain readable contrast for text and controls.
- All clickable elements need visible hover and focus states.
- Do not use icon-only controls without accessible names or titles.
- Keep tap targets practical on mobile.
- Respect reduced-motion preferences for animations.
- Avoid interactions that require precise horizontal scrolling unless there is no better dense-data alternative.

## Responsive Behavior

At desktop widths, prioritize comparison and side-by-side scanning.

At tablet widths, collapse secondary controls and keep the primary data visible.

At mobile widths:

- stack panels vertically;
- keep search, date, and primary filters reachable;
- allow tables to scroll horizontally only with clear stable headers;
- avoid clipped buttons and overflowing labels;
- keep dialogs within the viewport.
