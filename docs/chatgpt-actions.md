# Shared ChatGPT access for XWAY analytics

This document describes the first integration step: a shared ChatGPT Custom GPT can use XWAY data through Cloudflare Pages Functions.

## What was added

Cloudflare Pages Functions now expose an AI data layer:

- `GET /api/ai/openapi.json` - OpenAPI schema for GPT Actions.
- `GET /api/ai/health` - public configuration health check.
- `GET /api/ai/context` - recommendation methodology.
- `POST /api/ai/recommendation-data` - structured XWAY, MPVibe and WB data for one article.
- `POST /api/ai/refresh-article` - same payload, but requests source refresh where supported.

The endpoint does not call OpenAI itself. ChatGPT calls this API as an Action, receives structured data and writes the recommendation using the embedded context.

## Cloudflare secrets

Set these in Cloudflare Pages `Settings -> Variables and Secrets`.

Required:

```text
XWAY_AI_API_KEY=<long random secret>
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
MPVIBE_COOKIE_HEADER=<service session cookie header>
```

or:

```text
MPVIBE_AUTHORIZATION=Bearer <token>
```

Optional WB feedback root mapping:

```json
WB_FEEDBACK_ROOTS_JSON={"282727300":"606943940"}
```

Optional shared cache:

```text
XWAY_AI_CACHE=<Cloudflare KV namespace binding>
```

If the KV binding exists, `/api/ai/recommendation-data` returns cached article analytics for the same article and date range. `/api/ai/refresh-article` bypasses and overwrites that cache.

## Custom GPT setup

Create a GPT in the shared ChatGPT workspace.

Use this Action schema URL:

```text
https://xway-bt4.pages.dev/api/ai/openapi.json
```

Configure authentication as Bearer token and use the same value as `XWAY_AI_API_KEY`.

Recommended GPT instruction:

```text
You are XWAY AI Analyst. When the user asks for article analytics or recommendations, call getArticleRecommendationData first with detail_level="full" unless the user explicitly asks for a fast aggregate check. Use the returned recommendation_context and analysis_contract. If the user asks to refresh data, call refreshArticleRecommendationData with detail_level="full". Answer in Russian and cite which source blocks were available or missing.
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
