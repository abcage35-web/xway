export function buildAiOpenApiSpec(requestUrl) {
  const origin = new URL(requestUrl).origin;
  return {
    openapi: "3.1.0",
    info: {
      title: "XWAY AI Analytics API",
      version: "0.1.0",
      description: "Structured XWAY, MPVibe and WB data for a shared ChatGPT analyst. Use the single XWAY_TOKEN value as Bearer for secured analytics methods. Legacy role tokens are accepted only when XWAY_TOKEN is not configured.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/ai/context": {
        get: {
          operationId: "getRecommendationContext",
          summary: "Get the current XWAY recommendation methodology.",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Recommendation context.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ContextResponse" } } },
            },
          },
        },
      },
      "/api/ai/recommendation-data": {
        post: {
          operationId: "getArticleRecommendationData",
          summary: "Collect structured analytics for one WB article.",
          description: "Collect recommendation context through light methods by default. detail_level=full adds focused campaign schedules, limits, budget top-ups, bid history and status logs, but does not load full product cluster payload unless include_product_heavy_details is explicitly true.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RecommendationRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Structured article analytics for recommendation generation.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/RecommendationDataResponse" } } },
            },
          },
        },
      },
      "/api/ai/ad-metrics": {
        post: {
          operationId: "getAggregatedAdMetrics",
          summary: "Aggregate XWAY advertising metrics by day, category, article, cabinet/shop and campaign type.",
          description: "Use this for catalog/category/cabinet requests such as daily ad metrics for a category, slices by campaign type, or grouped metrics by articles and shops.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AdMetricsRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Aggregated advertising metrics.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AdMetricsResponse" } } },
            },
          },
        },
      },
      "/api/ai/chat": {
        post: {
          operationId: "sendDashboardChatMessage",
          summary: "Ask the in-site XWAY AI assistant a question.",
          description: "This endpoint is intended for the dashboard chat UI. It collects compact XWAY/MPVibe context server-side and returns a final model answer. It is callable without a Bearer token from the dashboard.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Assistant answer.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ChatResponse" } } },
            },
          },
        },
      },
      "/api/ai/campaign-schedules": {
        post: {
          operationId: "getCampaignSchedules",
          summary: "Get configured campaign display schedules without loading full product analytics.",
          description: "Focused method for show-time diagnostics. Loads only article/product resolution, campaign rows and schedule-get for selected campaigns.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CampaignFocusedRequest" } } },
          },
          responses: {
            "200": {
              description: "Campaign schedule settings.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/CampaignFocusedResponse" } } },
            },
          },
        },
      },
      "/api/ai/campaign-limits": {
        post: {
          operationId: "getCampaignLimits",
          summary: "Get campaign spend limits and budget rules without loading full product analytics.",
          description: "Focused method for active limits, spent amounts, remaining limits, budget rules and budget-deposit status.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CampaignFocusedRequest" } } },
          },
          responses: {
            "200": {
              description: "Campaign limits and budget rules.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/CampaignFocusedResponse" } } },
            },
          },
        },
      },
      "/api/ai/campaign-budget-history": {
        post: {
          operationId: "getCampaignBudgetHistory",
          summary: "Get campaign budget top-up history without loading full product analytics.",
          description: "Focused method for budget replenishment history and budget auto-deposit rule diagnostics.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CampaignFocusedRequest" } } },
          },
          responses: {
            "200": {
              description: "Campaign budget history.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/CampaignFocusedResponse" } } },
            },
          },
        },
      },
      "/api/ai/campaign-bid-history": {
        post: {
          operationId: "getCampaignBidHistory",
          summary: "Get campaign bid history without loading full product analytics.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CampaignFocusedRequest" } } },
          },
          responses: {
            "200": {
              description: "Campaign bid history.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/CampaignFocusedResponse" } } },
            },
          },
        },
      },
      "/api/ai/campaign-status-history": {
        post: {
          operationId: "getCampaignStatusHistory",
          summary: "Get campaign status/pause history without loading full product analytics.",
          description: "Focused method for schedule pauses, manual pauses, limits and status diagnostics. Use limit to keep payload small.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CampaignStatusHistoryRequest" } } },
          },
          responses: {
            "200": {
              description: "Campaign status history.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/CampaignFocusedResponse" } } },
            },
          },
        },
      },
      "/api/ai/refresh-article": {
        post: {
          operationId: "refreshArticleRecommendationData",
          summary: "Refresh source data and collect structured analytics for one WB article.",
          description: "Refreshes light/focused article context. It bypasses short-lived caches, but still avoids full product cluster payload unless include_product_heavy_details is explicitly true.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RecommendationRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Refreshed structured article analytics.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/RecommendationDataResponse" } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Use XWAY_TOKEN as Bearer. Legacy XWAY_ANALYST_TOKEN and XWAY_AI_API_KEY values are accepted only when XWAY_TOKEN is not configured.",
        },
      },
      schemas: {
        RecommendationRequest: {
          type: "object",
          additionalProperties: false,
          properties: {
            article: { type: "string", description: "WB nmId/article, for example 282727300." },
            start: { type: "string", format: "date", description: "Analysis start date. Defaults to 30 days before end." },
            end: { type: "string", format: "date", description: "Analysis end date. Defaults to today." },
            refresh: { type: "boolean", description: "Bypass short-lived source caches when supported." },
            detail_level: {
              type: "string",
              enum: ["full", "summary"],
              default: "summary",
              description: "summary loads fast aggregate product data. full adds focused campaign schedules, limits, budget top-ups, bid history and bounded status logs without loading full cluster payload.",
            },
            include_campaign_details: {
              type: "boolean",
              description: "When true, load focused campaign-level methods even if detail_level is summary. If campaign_ids is omitted, focused details are loaded for all article campaigns.",
            },
            include_product_heavy_details: {
              type: "boolean",
              default: false,
              description: "Explicit escape hatch for the old heavy product details path with cluster/normquery payloads. Keep false for routine analysis, schedules, limits, budgets, bids and statuses.",
            },
            campaign_ids: {
              type: "array",
              description: "Optional campaign ids for focused campaign methods. When include_product_heavy_details=true, also limits heavy product details to these campaigns.",
              items: { type: "string" },
            },
            include_xway_charts: {
              type: "boolean",
              description: "Include catalog chart totals for the requested range, last 7 days and previous 7 days. Defaults to true in full mode.",
            },
            include_xway_issues: {
              type: "boolean",
              description: "Include catalog issue diagnostics for the last 7 days. Defaults to true in full mode.",
            },
          },
          required: ["article"],
        },
        AdMetricsRequest: {
          type: "object",
          additionalProperties: false,
          properties: {
            start: { type: "string", format: "date", description: "Analysis start date. Defaults to 30 days before end." },
            end: { type: "string", format: "date", description: "Analysis end date. Defaults to today." },
            refresh: { type: "boolean", description: "Bypass source caches where supported." },
            group_by: {
              type: "array",
              description: "Dimensions for aggregation. Use day for daily rows, campaign_type for ad slices, category for category rows, article for article rows, and shop for cabinet/shop rows. Examples: ['day'], ['day','campaign_type'], ['category','day'], ['shop','category'], ['article','day'].",
              items: {
                type: "string",
                enum: ["day", "category", "article", "shop", "campaign_type"],
              },
            },
            categories: {
              type: "array",
              description: "Category keywords to include, for example ['Одеяла']. Matching is case-insensitive and allows partial matches.",
              items: { type: "string" },
            },
            articles: {
              type: "array",
              description: "WB nmId/articles to include.",
              items: { type: "string" },
            },
            shop_ids: {
              type: "array",
              description: "XWAY cabinet/shop ids to include.",
              items: { type: "string" },
            },
            shop_names: {
              type: "array",
              description: "Cabinet/shop names to include. Matching is case-insensitive and allows partial matches.",
              items: { type: "string" },
            },
            product_refs: {
              type: "array",
              description: "Exact XWAY product refs in shop_id:product_id format.",
              items: { type: "string" },
            },
            include_campaign_types: {
              type: "boolean",
              default: false,
              description: "Include advertising slices by campaign type: manual CPM, unified CPM and CPC where XWAY can split them. This is enabled automatically when group_by includes campaign_type.",
            },
            retry_failed: {
              type: "boolean",
              default: true,
              description: "Automatically retry product refs that were not loaded by catalog-chart because of source limits or transient errors.",
            },
            max_retry_rounds: {
              type: "integer",
              default: 3,
              description: "How many retry rounds to run for missing product refs. Retries use smaller chunks and eventually single-product requests.",
            },
            retry_delay_ms: {
              type: "integer",
              default: 350,
              description: "Delay between retry chunks. Increase on repeated source limit errors, but keep in mind the ChatGPT Action timeout.",
            },
            deadline_ms: {
              type: "integer",
              default: 55000,
              description: "Overall endpoint time budget. If the deadline is reached, the response returns partial metrics plus remaining_product_refs instead of timing out.",
            },
            chunk_size: {
              type: "integer",
              default: 25,
              description: "Initial number of product refs per catalog-chart subrequest. Smaller values reduce source-limit errors but increase request time.",
            },
            row_limit: {
              type: "integer",
              default: 5000,
              description: "Maximum number of grouped rows returned. If exceeded, response.truncated is true.",
            },
          },
        },
        ChatRequest: {
          type: "object",
          additionalProperties: false,
          properties: {
            message: { type: "string" },
            history: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  content: { type: "string" },
                },
              },
            },
            article: { type: "string" },
            start: { type: "string", format: "date" },
            end: { type: "string", format: "date" },
            refresh: { type: "boolean" },
            categories: { type: "array", items: { type: "string" } },
            articles: { type: "array", items: { type: "string" } },
            shop_ids: { type: "array", items: { type: "string" } },
            shop_names: { type: "array", items: { type: "string" } },
            group_by: {
              type: "array",
              items: { type: "string", enum: ["day", "category", "article", "shop", "campaign_type"] },
            },
            campaign_ids: { type: "array", items: { type: "string" } },
            row_limit: { type: "integer", default: 120 },
            auto_continue_rounds: {
              type: "integer",
              default: 4,
              description: "For dashboard chat, automatically continue loading remaining product refs before calling the LLM.",
            },
            max_retry_rounds: { type: "integer", default: 5 },
            retry_delay_ms: { type: "integer", default: 500 },
            chunk_size: { type: "integer", default: 8 },
          },
          required: ["message"],
        },
        CampaignFocusedRequest: {
          type: "object",
          additionalProperties: false,
          properties: {
            article: { type: "string", description: "WB nmId/article. Preferred way to resolve shop/product/campaigns." },
            shop_id: { type: "string", description: "Direct XWAY shop id. Use with product_id when article resolution is not needed." },
            product_id: { type: "string", description: "Direct XWAY product id. Use with shop_id when article resolution is not needed." },
            campaign_id: { type: "string", description: "Optional single XWAY campaign id or WB campaign id." },
            campaign_ids: {
              type: "array",
              description: "Optional selected campaign ids. Accepts internal XWAY campaign ids or WB campaign ids. Omit to return all campaigns for the product.",
              items: { type: "string" },
            },
            start: { type: "string", format: "date", description: "Range start for product/campaign state lookup. Defaults to 30 days before end." },
            end: { type: "string", format: "date", description: "Range end for product/campaign state lookup. Defaults to today." },
            refresh: { type: "boolean", description: "Bypass short-lived XWAY source caches for this focused method." },
          },
        },
        CampaignStatusHistoryRequest: {
          allOf: [
            { $ref: "#/components/schemas/CampaignFocusedRequest" },
            {
              type: "object",
              properties: {
                limit: { type: "integer", default: 120, description: "Maximum status rows per history source and campaign." },
              },
            },
          ],
        },
        CampaignFocusedResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            kind: { type: "string" },
            generated_at: { type: "string" },
            range: { type: "object" },
            article: { type: ["string", "null"] },
            product_ref: { type: "string" },
            campaign_count: { type: "integer" },
            not_found_campaign_ids: { type: "array", items: { type: "string" } },
            campaigns: { type: "array", items: { type: "object" } },
          },
        },
        ContextResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            version: { type: "string" },
            context: { type: "string" },
          },
        },
        RecommendationDataResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            article: { type: "string" },
            range: { type: "object" },
            detail: { type: "object" },
            sources: { type: "object" },
            xway: { type: "object" },
            mpvibe: { type: "object" },
            wb_public: { type: "object" },
            recommendation_context: { type: "object" },
            analysis_contract: { type: "object" },
          },
        },
        AdMetricsResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            range: { type: "object" },
            request: { type: "object" },
            selection: { type: "object" },
            rows: { type: "array", items: { type: "object" } },
            row_count: { type: "integer" },
            source_rows_count: { type: "integer" },
            truncated: { type: "boolean" },
            totals: { type: "object" },
            campaign_type_totals: { type: "object" },
            campaign_type_meta: { type: "object" },
            retry: { type: "object" },
            deadline: { type: "object" },
            errors: { type: "array", items: { type: "object" } },
          },
        },
        ChatResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            generated_at: { type: "string" },
            answer: { type: "string" },
            model: { type: "string" },
            mode: { type: "string" },
            article: { type: ["string", "null"] },
            range: { type: "object" },
            sources: { type: "object" },
            context_summary: { type: "object" },
          },
        },
      },
    },
  };
}
