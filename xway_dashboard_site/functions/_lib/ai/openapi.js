export function buildAiOpenApiSpec(requestUrl) {
  const origin = new URL(requestUrl).origin;
  return {
    openapi: "3.1.0",
    info: {
      title: "XWAY AI Analytics API",
      version: "0.1.0",
      description: "Structured XWAY, MPVibe and WB data for a shared ChatGPT analyst. Role tokens: viewer can read reports, analyst can read reports and run analytics, operator can send Pachka reports. Use XWAY_ANALYST_TOKEN or the legacy XWAY_AI_API_KEY for secured analytics methods.",
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
      "/api/ai/refresh-article": {
        post: {
          operationId: "refreshArticleRecommendationData",
          summary: "Refresh source data and collect structured analytics for one WB article.",
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
          description: "Use a role token as Bearer. For analytics, configure XWAY_ANALYST_TOKEN or use the legacy XWAY_AI_API_KEY.",
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
              default: "full",
              description: "Use full for recommendation reports. Full includes campaign daily details, bid and budget history, cluster/normquery rows, fixed/excluded flags, cluster bids and positions where XWAY provides them. Summary is only for fast aggregate checks.",
            },
            include_campaign_details: {
              type: "boolean",
              description: "When true, load campaign-level details even if detail_level is summary. If campaign_ids is omitted, details are loaded for all article campaigns.",
            },
            campaign_ids: {
              type: "array",
              description: "Optional campaign ids to load with detailed clusters/phrases. Accepts either internal XWAY campaign ids or WB campaign ids. Omit for full details on every campaign.",
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
              default: true,
              description: "Include advertising slices by campaign type: manual CPM, unified CPM and CPC where XWAY can split them.",
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
            chunk_size: {
              type: "integer",
              default: 12,
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
