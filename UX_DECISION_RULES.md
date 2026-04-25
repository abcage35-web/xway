# XWAY UX Decision Rules

Use these rules when an AI agent or developer needs to choose a UI/UX direction without asking for every detail.

## Decision Priority

When goals compete, use this order:

1. Accuracy of business meaning.
2. Speed of finding the next action.
3. Readability of dense data.
4. Preservation of user context.
5. Visual polish.
6. Novelty.

Do not optimize for novelty if it slows scanning or makes data meaning less clear.

## Default Agent Workflow

For any UI task:

1. Identify the user's decision: what are they trying to decide or fix?
2. Identify the core entities: product, article, campaign, cluster, bid, budget, stock, date range, or issue.
3. Choose the smallest layout that makes the decision obvious.
4. Reuse existing components and styles.
5. Add states for loading, empty, partial, error, and long content.
6. Verify desktop and mobile behavior.
7. Explain the tradeoff only if the choice affects workflow or product meaning.

## Page-Level Choices

- If the user is comparing many products, use catalog patterns: filters, quick views, compact tables, and issue summaries.
- If the user is investigating one product, use product patterns: sticky context, tabs, charts, detail tables, and dialogs.
- If the user needs to choose from many options, use searchable multi-select or filtered lists.
- If the user needs to inspect a narrow detail, use a dialog instead of sending them to a new page.
- If the user needs to act repeatedly, keep controls close to the affected data.

## Information Architecture

Group by user question:

- "What changed?" -> period comparison, deltas, trend chart.
- "What needs attention?" -> issue summary, status, thresholds, sorted risk rows.
- "Why did it happen?" -> drill-down table, history dialog, cluster/campaign detail.
- "What can I change?" -> controls, filters, threshold inputs, direct links.

Avoid grouping only by backend response shape when it makes the page harder to scan.

## Tables

Use tables when users compare rows across common metrics.

Rules:

- align numbers right;
- align labels and names left;
- keep row height compact but readable;
- provide useful default sorting;
- show empty filtered results separately from missing backend data;
- avoid hidden meaning in abbreviations unless the product already uses them;
- keep sticky headers for long dense tables when implementation is stable.

## Charts

Use charts when shape over time or distribution matters.

Rules:

- start with the metric and period the user already selected;
- label units clearly;
- keep colors semantically consistent;
- avoid more than a few competing series unless comparison is the point;
- provide fallback copy when there is not enough data.

## Filters And Controls

- Put high-impact filters first: date range, product/article, status, issue kind.
- Use quick filters for common operational questions.
- Persist preferences only when repeat use is expected.
- Make reset/clear actions obvious.
- Do not hide active filters in collapsed UI without a visible summary.

## Error And Loading States

- Use loading skeletons or overlays when data is expected soon.
- Preserve existing data while refreshing when that avoids a blank page.
- Show partial failures near the affected section.
- Tell the user what failed in operational language, not stack traces.
- Avoid blocking the full page when only one section failed.

## Empty States

Empty states should answer:

- is there no data, or did filters remove it?
- what scope/date range produced the result?
- what is the next useful action?

Do not use playful empty states in operational views.

## Microcopy

Use short Russian labels that match existing product language.

Good labels are specific:

- "Расход без заказов"
- "Медленная оборач."
- "Бюджет"
- "Ставки"
- "Пауза"

Avoid vague labels:

- "Insights"
- "Magic"
- "Smart"
- "AI"
- "Overview" when a Russian operational label exists.

## When To Ask The User

Ask before deciding when:

- the UI choice changes a business rule or threshold;
- data can be interpreted in multiple conflicting ways;
- a workflow may delete, pause, publish, spend money, or alter campaigns;
- a new dependency or external service is needed;
- the requested design contradicts the product's operational dashboard direction.

Otherwise, make the decision and document the assumption in the final note.
