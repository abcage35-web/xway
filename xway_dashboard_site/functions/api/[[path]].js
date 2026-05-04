import { collectCatalog, collectCatalogChart } from "../_lib/catalog.js";
import { collectCatalogIssues } from "../_lib/catalog-issues.js";
import { collectClusterDetail } from "../_lib/cluster-detail.js";
import { collectProducts } from "../_lib/products.js";
import { errorResponse, hasCookieHeaderAuth, hasCsrfToken, hasNativeStorageState, hasSessionCookieAuth, jsonResponse, sanitizeOrigin, searchParamsValue } from "../_lib/utils.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function copyResponseHeaders(headers) {
  const nextHeaders = new Headers();
  for (const [key, value] of headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      nextHeaders.set(key, value);
    }
  }
  nextHeaders.set("cache-control", "no-store");
  return nextHeaders;
}

function withSourceHeader(response, source) {
  const headers = new Headers(response.headers);
  headers.set("x-xway-api-source", source);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxyRequest(context, apiOrigin) {
  if (!apiOrigin) {
    return errorResponse(500, "API_ORIGIN is not configured.");
  }

  const requestUrl = new URL(context.request.url);
  const upstreamUrl = `${apiOrigin}${requestUrl.pathname}${requestUrl.search}`;
  const headers = new Headers(context.request.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", requestUrl.host);
  headers.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""));

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: context.request.method,
      headers,
      body: ["GET", "HEAD"].includes(context.request.method) ? undefined : context.request.body,
      redirect: "manual",
    });

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: copyResponseHeaders(upstreamResponse.headers),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reach upstream API.";
    return errorResponse(502, message);
  }
}

async function handleNativeRequest(context, pathname) {
  const requestUrl = new URL(context.request.url);
  if (pathname === "/api/health") {
    return jsonResponse({
      ok: true,
      backend: hasNativeStorageState(context.env) ? "cloudflare-native" : "proxy-only",
      native_routes: ["/api/health", "/api/catalog", "/api/catalog-chart", "/api/catalog-issues", "/api/products", "/api/cluster-detail"],
      fallback_routes: [],
      fallback_configured: Boolean(sanitizeOrigin(context.env.API_ORIGIN)),
      has_storage_state: hasNativeStorageState(context.env),
      auth_sources: {
        storage_state_json: Boolean(String(context.env.XWAY_STORAGE_STATE_JSON || "").trim()),
        storage_state_base64: Boolean(String(context.env.XWAY_STORAGE_STATE_BASE64 || "").trim()),
        cookie_header: hasCookieHeaderAuth(context.env),
        sessionid: hasSessionCookieAuth(context.env),
        csrf_token: hasCsrfToken(context.env),
      },
    });
  }

  if (pathname === "/api/catalog") {
    return jsonResponse(
      await collectCatalog(context.env, {
        start: searchParamsValue(requestUrl, "start"),
        end: searchParamsValue(requestUrl, "end"),
        mode: searchParamsValue(requestUrl, "mode") || "compact",
        forceRefresh: requestUrl.searchParams.get("refresh") === "1" || requestUrl.searchParams.get("force_refresh") === "1",
      }),
    );
  }

  if (pathname === "/api/catalog-chart") {
    const productRefs = String(requestUrl.searchParams.get("products") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return jsonResponse(
      await collectCatalogChart(context.env, {
        productRefs,
        start: searchParamsValue(requestUrl, "start"),
        end: searchParamsValue(requestUrl, "end"),
        includeCampaignTypes: requestUrl.searchParams.get("include_campaign_types") === "1",
      }),
    );
  }

  if (pathname === "/api/catalog-issues") {
    const productRefs = String(requestUrl.searchParams.get("products") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return jsonResponse(
      await collectCatalogIssues(context.env, {
        productRefs,
        start: searchParamsValue(requestUrl, "start"),
        end: searchParamsValue(requestUrl, "end"),
      }),
    );
  }

  if (pathname === "/api/products") {
    const articles = String(requestUrl.searchParams.get("articles") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const heavyCampaignIds = String(requestUrl.searchParams.get("heavy_campaign_ids") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return jsonResponse(
      await collectProducts(context.env, {
        articles,
        start: searchParamsValue(requestUrl, "start"),
        end: searchParamsValue(requestUrl, "end"),
        campaignMode: searchParamsValue(requestUrl, "campaign_mode") || "full",
        heavyCampaignIds,
      }),
    );
  }

  if (pathname === "/api/cluster-detail") {
    return jsonResponse(
      await collectClusterDetail(context.env, {
        shopId: searchParamsValue(requestUrl, "shop_id"),
        productId: searchParamsValue(requestUrl, "product_id"),
        campaignId: searchParamsValue(requestUrl, "campaign_id"),
        normqueryId: searchParamsValue(requestUrl, "normquery_id"),
        start: searchParamsValue(requestUrl, "start"),
        end: searchParamsValue(requestUrl, "end"),
      }),
    );
  }

  return errorResponse(404, `Native handler for ${pathname} is not implemented.`);
}

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const pathname = requestUrl.pathname;
  const apiOrigin = sanitizeOrigin(context.env.API_ORIGIN);
  const nativeRoutes = new Set(["/api/health", "/api/catalog", "/api/catalog-chart", "/api/catalog-issues", "/api/products", "/api/cluster-detail"]);

  if (nativeRoutes.has(pathname)) {
    if (pathname === "/api/health" || hasNativeStorageState(context.env)) {
      try {
        return withSourceHeader(await handleNativeRequest(context, pathname), "native");
      } catch (error) {
        if (!apiOrigin || pathname === "/api/health") {
          return errorResponse(500, error instanceof Error ? error.message : "Native handler failed.");
        }
      }
    }
    if (!apiOrigin) {
      return errorResponse(500, "Native handler is not configured and API_ORIGIN fallback is missing.");
    }
    return withSourceHeader(await proxyRequest(context, apiOrigin), "proxy");
  }

  if (!apiOrigin) {
    return errorResponse(501, `Route ${pathname} is not ported yet and API_ORIGIN fallback is missing.`);
  }

  return withSourceHeader(await proxyRequest(context, apiOrigin), "proxy");
}
