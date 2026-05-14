export function buildAiOpenApiSpec(requestUrl) {
  const origin = new URL(requestUrl).origin;
  return {
    openapi: "3.1.0",
    info: {
      title: "XWAY AI Analytics API",
      version: "0.1.0",
      description: "Structured XWAY, MPVibe and WB data for a shared ChatGPT analyst.",
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
          description: "Use the Cloudflare secret XWAY_AI_API_KEY as Bearer token.",
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
              description: "Optional XWAY campaign ids to load with detailed clusters/phrases. Omit for full details on every campaign.",
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
      },
    },
  };
}
