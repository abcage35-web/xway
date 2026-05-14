import { errorResponse, jsonResponse } from "../utils.js";
import { requireAiAuth } from "./auth.js";
import { buildAiContextPayload } from "./context.js";
import { buildAiOpenApiSpec } from "./openapi.js";
import { collectAiAdMetrics } from "./ad-metrics.js";
import { handleAiChat } from "./chat.js";
import { collectAiRecommendationData } from "./recommendation-data.js";

function methodAllowed(context, allowed) {
  if (allowed.includes(context.request.method)) {
    return null;
  }
  return errorResponse(405, `Method ${context.request.method} is not allowed.`);
}

function authed(context) {
  const auth = requireAiAuth(context);
  return auth.ok ? null : auth.response;
}

function aiErrorResponse(error) {
  const message = error instanceof Error ? error.message : String(error || "AI handler failed.");
  const status = /article is required|start date must not be after end date|Unexpected token|JSON/i.test(message) ? 400 : 500;
  return errorResponse(status, message);
}

export async function handleAiRequest(context, pathname) {
  if (pathname === "/api/ai/openapi.json") {
    const methodError = methodAllowed(context, ["GET", "HEAD"]);
    if (methodError) {
      return methodError;
    }
    return jsonResponse(buildAiOpenApiSpec(context.request.url));
  }

  if (pathname === "/api/ai/health") {
    const methodError = methodAllowed(context, ["GET", "HEAD"]);
    if (methodError) {
      return methodError;
    }
    return jsonResponse({
      ok: true,
      service: "xway-ai-actions",
      auth_configured: Boolean(String(context.env.XWAY_AI_API_KEY || "").trim()),
      openai_configured: Boolean(String(context.env.OPENAI_API_KEY || "").trim()),
      mpvibe_configured: Boolean(String(context.env.MPVIBE_COOKIE_HEADER || context.env.MPVIBE_REFRESH_COOKIE_HEADER || context.env.MPVIBE_AUTHORIZATION || "").trim()),
      mpvibe_refresh_configured: Boolean(String(context.env.MPVIBE_REFRESH_COOKIE_HEADER || context.env.MPVIBE_COOKIE_HEADER || "").trim()),
      wb_feedback_roots_configured: Boolean(String(context.env.WB_FEEDBACK_ROOTS_JSON || "").trim()),
    });
  }

  if (pathname === "/api/ai/chat") {
    const methodError = methodAllowed(context, ["POST"]);
    if (methodError) {
      return methodError;
    }
    try {
      return jsonResponse(await handleAiChat(context));
    } catch (error) {
      return aiErrorResponse(error);
    }
  }

  const authError = authed(context);
  if (authError) {
    return authError;
  }

  if (pathname === "/api/ai/context") {
    const methodError = methodAllowed(context, ["GET", "HEAD"]);
    if (methodError) {
      return methodError;
    }
    return jsonResponse(buildAiContextPayload());
  }

  if (pathname === "/api/ai/recommendation-data") {
    const methodError = methodAllowed(context, ["POST"]);
    if (methodError) {
      return methodError;
    }
    try {
      return jsonResponse(await collectAiRecommendationData(context));
    } catch (error) {
      return aiErrorResponse(error);
    }
  }

  if (pathname === "/api/ai/ad-metrics") {
    const methodError = methodAllowed(context, ["POST"]);
    if (methodError) {
      return methodError;
    }
    try {
      return jsonResponse(await collectAiAdMetrics(context));
    } catch (error) {
      return aiErrorResponse(error);
    }
  }

  if (pathname === "/api/ai/refresh-article") {
    const methodError = methodAllowed(context, ["POST"]);
    if (methodError) {
      return methodError;
    }
    try {
      return jsonResponse(await collectAiRecommendationData(context, { refreshOverride: true }));
    } catch (error) {
      return aiErrorResponse(error);
    }
  }

  return errorResponse(404, `AI route ${pathname} is not implemented.`);
}
