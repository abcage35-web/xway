# Shared ChatGPT access for XWAY analytics

This document describes the first integration step: a shared ChatGPT Custom GPT can use XWAY data through Cloudflare Pages Functions.

## What was added

Cloudflare Pages Functions now expose an AI data layer:

- `GET /api/ai/openapi.json` - OpenAPI schema for GPT Actions.
- `GET /api/ai/health` - public configuration health check.
- `GET /api/ai/context` - recommendation methodology.
- `POST /api/ai/recommendation-data` - structured XWAY, MPVibe and WB data for one article.
- `POST /api/ai/ad-metrics` - aggregated XWAY advertising metrics by day, category, article, cabinet/shop and campaign type.
- `POST /api/ai/refresh-article` - same payload, but requests source refresh where supported.
- `POST /api/ai/chat` - in-site assistant endpoint that collects compact analytics context and calls an LLM server-side.

The Action endpoints do not call OpenAI themselves. ChatGPT calls them as Actions, receives structured data and writes the recommendation using the embedded context. The separate `/api/ai/chat` endpoint is for the dashboard UI: it keeps the large source payload server-side, sends a compact context to the configured model, and returns the final answer.

## Cloudflare secrets

Set these in Cloudflare Pages `Settings -> Variables and Secrets`.

Required:

```text
XWAY_AI_API_KEY=<long random secret>
```

Required only for the in-site `/ai` chat:

```text
OPENAI_API_KEY=<OpenAI API key>
```

Optional:

```text
OPENAI_MODEL=<model for /api/ai/chat>
```

Already required by native XWAY handlers:

```text
XWAY_STORAGE_STATE_JSON=<storage state json>
```

or one of the existing alternatives:

```text
XWAY_STORAGE_STATE_BASE64=<base64 storage state>
XWAY_COOKIE_HEADER=<cookie header>
XWAY_SESSIONID=<session id>
```

Optional MPVibe source:

```text
MPVIBE_REFRESH_COOKIE_HEADER=<refresh cookie header from auth.mpvibe.ru>
```

or a full cookie header that can be used both for refresh and direct MPVibe API calls:

```text
MPVIBE_COOKIE_HEADER=<service session cookie header>
```

or:

```text
MPVIBE_AUTHORIZATION=Bearer <token>
```

`MPVIBE_AUTHORIZATION` is short-lived. Prefer `MPVIBE_REFRESH_COOKIE_HEADER`: the Worker refreshes the access token through `https://auth.mpvibe.ru/api/refresh-token`, caches the new Bearer token in `XWAY_AI_CACHE` when that KV binding exists, retries once after MPVibe `401`, and only asks for a new cookie when the refresh session itself expires.

Optional WB feedback root mapping:

```json
WB_FEEDBACK_ROOTS_JSON={"282727300":"606943940"}
```

Optional shared cache:

```text
XWAY_AI_CACHE=<Cloudflare KV namespace binding>
```

If the KV binding exists, `/api/ai/recommendation-data` returns cached article analytics for the same article and date range. The same KV namespace also stores reusable XWAY source responses such as shop listings, product stats, `stata` payloads and campaign daily slices. `/api/ai/refresh-article`, `/api/catalog?refresh=1`, `/api/catalog-chart?refresh=1` and `/api/products?force_refresh=1` bypass source-cache reads and overwrite fresh data.

Optional D1 shared cache:

```text
XWAY_SHARED_CACHE_DB=<Cloudflare D1 binding>
```

D1 is the preferred shared cache for dashboard/API data that should be visible to all users after one user has loaded it. It stores reusable source responses and cacheable catalog API responses. Setup details are in `docs/d1-shared-cache.md`.

## Custom GPT setup

Create a GPT in the shared ChatGPT workspace.

Use this Action schema URL:

```text
https://xway-bt4.pages.dev/api/ai/openapi.json
```

Configure authentication as Bearer token and use the same value as `XWAY_AI_API_KEY`.

Recommended GPT instruction:

```text
You are XWAY AI Analyst. When the user asks for one article analytics or recommendations, call getArticleRecommendationData first with detail_level="full" unless the user explicitly asks for a fast aggregate check. When the user asks for metrics by category, article list, cabinet/shop, daily rows, or advertising slices, call getAggregatedAdMetrics with the needed group_by dimensions. Use the returned recommendation_context and analysis_contract for recommendations. If the user asks to refresh one article, call refreshArticleRecommendationData with detail_level="full". Answer in Russian and cite which source blocks were available or missing.
```

## Example Action request

```json
{
  "article": "282727300",
  "start": "2026-04-14",
  "end": "2026-05-13",
  "detail_level": "full"
}
```

The response includes:

- XWAY product/card/campaign summaries;
- XWAY product daily stats and campaign summaries;
- in `detail_level: "full"` mode, XWAY campaign daily details, bid history, budget history, pause/status logs, spend-limit settings, cluster/normquery rows, fixed/excluded flags, cluster bids, cluster positions, cluster daily metrics and cluster action history where XWAY returns them;
- XWAY campaign-type totals derived from product campaigns;
- XWAY 30-day, last-7-day and previous-7-day chart totals by default in full mode, or if `include_xway_charts` is `true`;
- XWAY issues for the last 7 days by default in full mode, or if `include_xway_issues` is `true`;
- MPVibe daily plan, monthly plan, price/SPP dynamics and `margin_wb_ds_percent` if MPVibe auth is configured;
- WB feedback summary if `WB_FEEDBACK_ROOTS_JSON` contains a root id for the article;
- recommendation rules and required reasoning layers.

Use `detail_level: "summary"` only for fast aggregate checks. If the user asks about manual CPM phrases, clusters, fixed positions, excluded phrases or cluster bids, use `detail_level: "full"`. To limit a heavy diagnostic to known campaigns, pass `campaign_ids`; both internal XWAY campaign ids and WB campaign ids are accepted, for example:

```json
{
  "article": "558310506",
  "start": "2026-04-15",
  "end": "2026-05-14",
  "detail_level": "full",
  "campaign_ids": ["33211298"]
}
```

## Aggregated ad metrics examples

Daily advertising metrics for category:

```json
{
  "categories": ["Одеяла"],
  "start": "2026-05-01",
  "end": "2026-05-14",
  "group_by": ["day"]
}
```

Daily category metrics split by ad type:

```json
{
  "categories": ["Одеяла"],
  "start": "2026-05-01",
  "end": "2026-05-14",
  "group_by": ["day", "campaign_type"]
}
```

Supported grouping dimensions are `day`, `category`, `article`, `shop` and `campaign_type`. The same endpoint supports cabinet/shop cuts (`shop_ids` or `shop_names`), exact articles (`articles`) and exact product refs (`product_refs`).

`getAggregatedAdMetrics` retries incomplete catalog-chart loads by default. If `selection.remaining_product_refs` is not empty after the built-in retries, call the returned `retry.recommended_next_request` to load the missing products separately and merge the result in the answer. For repeated source-limit errors, prefer `chunk_size: 1`, `max_retry_rounds: 3` and a larger `retry_delay_ms`.

The dashboard catalog uses the same resumable pattern internally for heavy chart and issue loads. `/api/catalog-chart` and `/api/catalog-issues` accept `cursor`, `limit_products` and `deadline_ms`; when the response has `complete: false`, the caller should request `next_cursor` and merge the returned rows. This keeps each Cloudflare invocation short while preserving full data coverage.

For the in-dashboard AI chat, prefer `sendDashboardChatMessage` when the user expects the assistant to decide the data-loading path autonomously. That endpoint runs server-side collection first, retries remaining product refs, merges continuation loads, compacts campaign/cluster context and only then calls the LLM.

## MPVibe endpoints used

The integration discovers and reads MPVibe through the same JSON endpoints used by the browser UI:

- `/auth/profile`
- `/api/realtime/mp/wb`
- `/api/realtime/mp/wb/by/card`
- `/api/realtime/mp/wb/by/card-day`
- `/api/realtime/mp/wb/stocks`
- `/api/realtime/mp/wb/plan`
- `/api/price/wb`

The AI data layer does not expose MPVibe cookies or request headers. It returns only structured article analytics to ChatGPT.

## Security model

Team members do not receive XWAY, MPVibe or OpenAI secrets. ChatGPT only receives the Action token. Cloudflare validates the token, collects source data server-side and returns a sanitized JSON payload.

Do not put personal browser cookies into repo files. If MPVibe has no service-account auth, rotate the session regularly and keep it only in Cloudflare secrets.
