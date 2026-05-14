import { errorResponse } from "../utils.js";

export function isAiRoute(pathname) {
  return String(pathname || "").startsWith("/api/ai/");
}

function bearerTokenFromHeader(value) {
  const match = String(value || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function requireAiAuth(context) {
  const expected = String(context.env.XWAY_AI_API_KEY || "").trim();
  if (!expected) {
    return {
      ok: false,
      response: errorResponse(500, "XWAY_AI_API_KEY is not configured."),
    };
  }

  const headers = context.request.headers;
  const provided = bearerTokenFromHeader(headers.get("authorization")) || String(headers.get("x-xway-ai-key") || "").trim();
  if (!provided || provided !== expected) {
    return {
      ok: false,
      response: errorResponse(401, "Unauthorized AI API request."),
    };
  }

  return { ok: true, response: null };
}
