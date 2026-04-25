# XWAY UI QA Checklist

Use this checklist before finishing meaningful frontend changes.

## Required Checks

- Build or typecheck passes.
- The changed view renders without console errors.
- Desktop width around 1440px is readable.
- Tablet width around 768px is usable.
- Mobile width around 375px has no clipped controls or unreadable text.
- Search, filters, tabs, dialogs, and table scrolling still work.
- Loading, empty, error, and long-content states are covered where relevant.

## Visual Checks

- Text does not overlap icons, buttons, cards, tables, or chart labels.
- Buttons and pills do not resize the surrounding layout on hover.
- Product names, article IDs, and campaign names wrap or truncate intentionally.
- Numeric columns remain aligned.
- Sticky headers, sticky columns, and horizontal scroll areas do not fight each other.
- Dialogs fit within the viewport and can be closed.
- Color is used consistently with status semantics.
- Contrast is readable on soft surfaces.
- No decorative UI has been added without a functional reason.

## Interaction Checks

- Every clickable element has a hover state.
- Keyboard focus is visible for controls.
- Icon-only buttons have accessible labels or titles.
- Disabled controls look disabled and cannot be activated.
- Persisted settings still restore correctly after refresh.
- External links are visually distinct from internal navigation.

## Data Checks

- Units are visible for money, percent, days, hours, clicks, views, and orders.
- Deltas clearly state their comparison period.
- Partial, cached, failed, or stale data is labeled near the affected section.
- Empty filtered results are not confused with backend failure.
- Sorting and filtering do not silently drop important rows.

## Suggested Commands

From `xway_dashboard_site/`:

```bash
npm run build
npm run dev
```

Use the local Vite URL for browser inspection. Check at least:

- `1440 x 900`
- `768 x 1024`
- `375 x 812`

For purely documentation-only changes, browser QA is not required.
