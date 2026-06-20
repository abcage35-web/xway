import { collectCatalog, collectCatalogChart, collectCatalogProductDetails } from "../_lib/catalog.js";
import { applyCatalogArticleSnapshots, writeCatalogArticleSnapshots } from "../_lib/catalog-article-snapshots.js";
import { collectCatalogAutoExclusions } from "../_lib/catalog-auto-exclusions.js";
import { collectCatalogIssues } from "../_lib/catalog-issues.js";
import { collectClusterDetail } from "../_lib/cluster-detail.js";
import { handleAiRequest } from "../_lib/ai/handler.js";
import { isAiRoute } from "../_lib/ai/auth.js";
import { collectMpvibeStocks } from "../_lib/ai/mpvibe-client.js";
import { ACCESS_PERMISSIONS, accessRoleSummary, hasAccessTokenHeader, requireAccessPermission } from "../_lib/access-control.js";
import { buildPachkaReport, sendPachkaReport } from "../_lib/pachka-report.js";
import { collectProducts } from "../_lib/products.js";
import { hasSharedD1Cache, readSharedCache, writeSharedCache } from "../_lib/shared-cache.js";
import { errorResponse, hasCookieHeaderAuth, hasCsrfToken, hasNativeStorageState, hasSessionCookieAuth, jsonResponse, sanitizeOrigin, searchParamsValue } from "../_lib/utils.js";
import { collectWbCards } from "../_lib/wb-cards.js";

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

const SHARED_API_CACHE_VERSION = "v2";
const SHARED_API_CACHEABLE_ROUTES = new Set([
  "/api/catalog",
  "/api/catalog-chart",
  "/api/catalog-product-details",
  "/api/catalog-auto-exclusions",
  "/api/catalog-issues",
  "/api/products",
]);
const ANALYST_NATIVE_ROUTES = new Set([
  "/api/catalog",
  "/api/catalog-chart",
  "/api/catalog-product-details",
  "/api/catalog-auto-exclusions",
  "/api/catalog-issues",
  "/api/products",
  "/api/cluster-detail",
  "/api/wb-cards",
  "/api/mpvibe-stocks",
]);

async function readJsonRequest(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

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

function withHeader(response, key, value) {
  const headers = new Headers(response.headers);
  headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isForceRefreshRequest(url) {
  return url.searchParams.get("refresh") === "1" || url.searchParams.get("force_refresh") === "1";
}

function isSharedApiCacheableRequest(pathname, requestUrl) {
  if (!SHARED_API_CACHEABLE_ROUTES.has(pathname)) {
    return false;
  }
  if (pathname !== "/api/catalog") {
    return true;
  }

  const mode = String(requestUrl.searchParams.get("mode") || "compact").toLowerCase();
  const auxDisabled = requestUrl.searchParams.get("aux") === "0" || requestUrl.searchParams.get("include_aux") === "0";
  return mode === "compact" && auxDisabled;
}

function normalizeCsvParam(url, name) {
  const value = url.searchParams.get(name);
  if (!value) {
    return;
  }
  url.searchParams.set(name, value.split(",").map((item) => item.trim()).filter(Boolean).sort().join(","));
}

function normalizeApiCacheKey(url) {
  const normalized = new URL(url.toString());
  normalized.searchParams.delete("refresh");
  normalized.searchParams.delete("force_refresh");
  if (normalized.pathname === "/api/catalog" && String(normalized.searchParams.get("mode") || "compact").toLowerCase() === "compact") {
    normalized.searchParams.delete("mode");
  }
  if (normalized.pathname === "/api/catalog" && normalized.searchParams.get("include_aux") === "0") {
    normalized.searchParams.delete("include_aux");
    normalized.searchParams.set("aux", "0");
  }
  if (normalized.pathname === "/api/products" && String(normalized.searchParams.get("campaign_mode") || "").toLowerCase() === "summary") {
    normalized.searchParams.delete("campaign_mode");
  }
  normalizeCsvParam(normalized, "articles");
  normalizeCsvParam(normalized, "heavy_campaign_ids");
  normalizeCsvParam(normalized, "products");
  normalizeCsvParam(normalized, "shops");

  const params = [...normalized.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyResult = leftKey.localeCompare(rightKey);
    return keyResult || leftValue.localeCompare(rightValue);
  });
  normalized.search = "";
  params.forEach(([key, value]) => normalized.searchParams.append(key, value));
  return `${SHARED_API_CACHE_VERSION}:${normalized.pathname}${normalized.search}`;
}

function sharedApiCacheNamespace(env, pathname) {
  const originNamespace = sanitizeOrigin(env.XWAY_CACHE_NAMESPACE || env.CF_PAGES_URL || env.API_ORIGIN || "xway");
  return `api-response:${originNamespace}:${pathname}`;
}

async function readSharedApiResponse(context, pathname, requestUrl, { allowForceRefresh = false } = {}) {
  if (!["GET", "HEAD"].includes(context.request.method) || !isSharedApiCacheableRequest(pathname, requestUrl) || (!allowForceRefresh && isForceRefreshRequest(requestUrl))) {
    return null;
  }
  return readSharedCache(context.env, sharedApiCacheNamespace(context.env, pathname), normalizeApiCacheKey(requestUrl));
}

async function sharedApiJsonResponse(context, pathname, payload, cacheStatus, extraHeaders = {}) {
  const hydratedPayload = pathname === "/api/catalog" ? await applyCatalogArticleSnapshots(context.env, payload) : payload;
  let response = withHeader(jsonResponse(hydratedPayload), "x-xway-shared-cache", cacheStatus);
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value !== null && value !== undefined && value !== "") {
      response = withHeader(response, key, String(value));
    }
  }
  return withSourceHeader(response, "native");
}

async function readSharedApiFallbackResponse(context, pathname, requestUrl, extraHeaders = {}) {
  const cachedPayload = await readSharedApiResponse(context, pathname, requestUrl, { allowForceRefresh: true });
  if (cachedPayload === null || cachedPayload === undefined) {
    return null;
  }
  return sharedApiJsonResponse(context, pathname, cachedPayload, "stale", extraHeaders);
}

function writeSharedApiResponse(context, pathname, requestUrl, response) {
  if (!["GET", "HEAD"].includes(context.request.method) || !isSharedApiCacheableRequest(pathname, requestUrl) || !response.ok || !hasSharedD1Cache(context.env)) {
    return;
  }

  const cacheWrite = (async () => {
    try {
      const payload = await response.clone().json();
      await writeSharedCache(context.env, sharedApiCacheNamespace(context.env, pathname), normalizeApiCacheKey(requestUrl), payload);
    } catch {
      // Shared API cache is an optimization only.
    }
  })();

  if (typeof context.waitUntil === "function") {
    context.waitUntil(cacheWrite);
  }
}

function searchParamsInteger(url, key) {
  const value = searchParamsValue(url, key);
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function asTrimmedString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function timingSafeEqual(left, right) {
  const leftValue = asTrimmedString(left);
  const rightValue = asTrimmedString(right);
  if (!leftValue || !rightValue || leftValue.length !== rightValue.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < leftValue.length; index += 1) {
    diff |= leftValue.charCodeAt(index) ^ rightValue.charCodeAt(index);
  }
  return diff === 0;
}

async function validatePachkaReportSecret(context) {
  const expectedSecret = asTrimmedString(context.env.PACHKA_REPORT_SECRET);
  if (!expectedSecret) {
    return errorResponse(409, "PACHKA_REPORT_SECRET is not configured.");
  }
  const headerSecret = context.request.headers.get("x-pachka-report-secret") || context.request.headers.get("x-xway-report-secret");
  let bodySecret = "";
  if (!headerSecret && !["GET", "HEAD"].includes(context.request.method)) {
    const payload = await readJsonRequest(context.request);
    bodySecret = asTrimmedString(payload?.secret);
  }
  if (!timingSafeEqual(headerSecret || bodySecret, expectedSecret)) {
    return errorResponse(401, "Invalid Pachka report secret.");
  }
  return null;
}

async function validatePachkaReportSendAccess(context) {
  if (hasAccessTokenHeader(context.request)) {
    const access = requireAccessPermission(context, ACCESS_PERMISSIONS.SEND_PACHKA, { errorPrefix: "Pachka report" });
    return access.ok ? null : access.response;
  }
  return validatePachkaReportSecret(context);
}

function validateOptionalRoleAccess(context, pathname) {
  if (!hasAccessTokenHeader(context.request)) {
    return null;
  }

  if (pathname === "/api/pachka-report") {
    const access = requireAccessPermission(context, ACCESS_PERMISSIONS.READ_REPORTS, { errorPrefix: "Pachka report" });
    return access.ok ? null : access.response;
  }

  if (ANALYST_NATIVE_ROUTES.has(pathname)) {
    const access = requireAccessPermission(context, ACCESS_PERMISSIONS.RUN_ANALYSIS, { errorPrefix: "XWAY analytics" });
    return access.ok ? null : access.response;
  }

  return null;
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
      native_routes: ["/api/health", "/api/catalog", "/api/catalog-chart", "/api/catalog-product-details", "/api/catalog-auto-exclusions", "/api/catalog-issues", "/api/catalog-article-snapshots", "/api/products", "/api/cluster-detail", "/api/wb-cards", "/api/mpvibe-stocks", "/api/pachka-report", "/api/pachka-report/send", "/api/ai/*"],
      fallback_routes: [],
      fallback_configured: Boolean(sanitizeOrigin(context.env.API_ORIGIN)),
      shared_cache: {
        d1: hasSharedD1Cache(context.env),
        kv: Boolean(context.env.XWAY_AI_CACHE && typeof context.env.XWAY_AI_CACHE.get === "function" && typeof context.env.XWAY_AI_CACHE.put === "function"),
      },
      role_access: accessRoleSummary(context.env),
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
    const productRefs = String(requestUrl.searchParams.get("products") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const shopIds = String(requestUrl.searchParams.get("shops") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const payload = await collectCatalog(context.env, {
      start: searchParamsValue(requestUrl, "start"),
      end: searchParamsValue(requestUrl, "end"),
      mode: searchParamsValue(requestUrl, "mode") || "compact",
      forceRefresh: requestUrl.searchParams.get("refresh") === "1" || requestUrl.searchParams.get("force_refresh") === "1",
      productRefs,
      shopIds,
      includeAux: requestUrl.searchParams.get("aux") !== "0" && requestUrl.searchParams.get("include_aux") !== "0",
    });
    return jsonResponse(await applyCatalogArticleSnapshots(context.env, payload));
  }

  if (pathname === "/api/catalog-article-snapshots") {
    if (context.request.method !== "POST") {
      return errorResponse(405, "Use POST for catalog article snapshots.");
    }
    const payload = await readJsonRequest(context.request);
    if (!payload) {
      return errorResponse(400, "Invalid JSON payload.");
    }
    try {
      return jsonResponse(await writeCatalogArticleSnapshots(context.env, payload));
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : "Invalid catalog article snapshot payload.");
    }
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
        forceRefresh: requestUrl.searchParams.get("refresh") === "1" || requestUrl.searchParams.get("force_refresh") === "1",
        cursor: searchParamsValue(requestUrl, "cursor"),
        limitProducts: searchParamsInteger(requestUrl, "limit_products"),
        deadlineMs: searchParamsInteger(requestUrl, "deadline_ms"),
      }),
    );
  }

  if (pathname === "/api/catalog-product-details") {
    const productRefs = String(requestUrl.searchParams.get("products") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return jsonResponse(
      await collectCatalogProductDetails(context.env, {
        productRefs,
        start: searchParamsValue(requestUrl, "start"),
        end: searchParamsValue(requestUrl, "end"),
        forceRefresh: requestUrl.searchParams.get("refresh") === "1" || requestUrl.searchParams.get("force_refresh") === "1",
        includeCampaignDetails: requestUrl.searchParams.get("campaign_details") !== "0" && requestUrl.searchParams.get("include_campaign_details") !== "0",
        includeBestTime: requestUrl.searchParams.get("best_time") !== "0",
      }),
    );
  }

  if (pathname === "/api/catalog-auto-exclusions") {
    const productRefs = String(requestUrl.searchParams.get("products") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return jsonResponse(
      await collectCatalogAutoExclusions(context.env, {
        productRefs,
        start: searchParamsValue(requestUrl, "start"),
        end: searchParamsValue(requestUrl, "end"),
        forceRefresh: requestUrl.searchParams.get("refresh") === "1" || requestUrl.searchParams.get("force_refresh") === "1",
        cursor: searchParamsValue(requestUrl, "cursor"),
        limitProducts: searchParamsInteger(requestUrl, "limit_products"),
        deadlineMs: searchParamsInteger(requestUrl, "deadline_ms"),
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
        forceRefresh: requestUrl.searchParams.get("refresh") === "1" || requestUrl.searchParams.get("force_refresh") === "1",
        cursor: searchParamsValue(requestUrl, "cursor"),
        limitProducts: searchParamsInteger(requestUrl, "limit_products"),
        deadlineMs: searchParamsInteger(requestUrl, "deadline_ms"),
        scope: searchParamsValue(requestUrl, "scope"),
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
        campaignMode: searchParamsValue(requestUrl, "campaign_mode") || "summary",
        heavyCampaignIds,
        forceRefresh: requestUrl.searchParams.get("refresh") === "1" || requestUrl.searchParams.get("force_refresh") === "1",
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

  if (pathname === "/api/wb-cards") {
    const articles = String(requestUrl.searchParams.get("articles") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return jsonResponse(await collectWbCards({ articles }));
  }

  if (pathname === "/api/mpvibe-stocks") {
    const articles = String(requestUrl.searchParams.get("articles") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return jsonResponse(
      await collectMpvibeStocks(context.env, {
        articles,
        start: searchParamsValue(requestUrl, "start"),
        end: searchParamsValue(requestUrl, "end"),
        includeAllWithStock: requestUrl.searchParams.get("include_all_with_stock") === "1",
      }),
    );
  }

  if (pathname === "/api/pachka-report") {
    if (!["GET", "HEAD"].includes(context.request.method)) {
      return errorResponse(405, "Use GET for Pachka report preview.");
    }
    return jsonResponse(
      await buildPachkaReport(context.env, {
        forceRefresh: requestUrl.searchParams.get("refresh") === "1" || requestUrl.searchParams.get("force_refresh") === "1",
        days: searchParamsInteger(requestUrl, "days"),
        limit: searchParamsInteger(requestUrl, "limit"),
      }),
    );
  }

  if (pathname === "/api/pachka-report/send") {
    if (context.request.method !== "POST") {
      return errorResponse(405, "Use POST for Pachka report sending.");
    }
    const secretError = await validatePachkaReportSendAccess(context);
    if (secretError) {
      return secretError;
    }
    try {
      return jsonResponse(await sendPachkaReport(context.env));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pachka report sending failed.";
      return errorResponse(message.includes("not configured") ? 409 : 502, message);
    }
  }

  return errorResponse(404, `Native handler for ${pathname} is not implemented.`);
}

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const pathname = requestUrl.pathname;
  const apiOrigin = sanitizeOrigin(context.env.API_ORIGIN);
  const nativeRoutes = new Set(["/api/health", "/api/catalog", "/api/catalog-chart", "/api/catalog-product-details", "/api/catalog-auto-exclusions", "/api/catalog-issues", "/api/catalog-article-snapshots", "/api/products", "/api/cluster-detail", "/api/wb-cards", "/api/mpvibe-stocks", "/api/pachka-report", "/api/pachka-report/send"]);

  if (isAiRoute(pathname)) {
    try {
      return withSourceHeader(await handleAiRequest(context, pathname), "native");
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : "AI handler failed.");
    }
  }

  if (nativeRoutes.has(pathname)) {
    const roleError = validateOptionalRoleAccess(context, pathname);
    if (roleError) {
      return roleError;
    }

    const cachedPayload = await readSharedApiResponse(context, pathname, requestUrl);
    if (cachedPayload !== null && cachedPayload !== undefined) {
      return sharedApiJsonResponse(context, pathname, cachedPayload, "hit");
    }

    if (pathname === "/api/health" || pathname === "/api/catalog-article-snapshots" || pathname === "/api/wb-cards" || pathname === "/api/mpvibe-stocks" || pathname === "/api/pachka-report" || pathname === "/api/pachka-report/send" || hasNativeStorageState(context.env)) {
      try {
        const nativeResponse = await handleNativeRequest(context, pathname);
        if (!nativeResponse.ok) {
          const fallbackResponse = await readSharedApiFallbackResponse(context, pathname, requestUrl, {
            "x-xway-native-status": nativeResponse.status,
          });
          if (fallbackResponse) {
            return fallbackResponse;
          }
        }
        writeSharedApiResponse(context, pathname, requestUrl, nativeResponse);
        const cacheStatus = isSharedApiCacheableRequest(pathname, requestUrl) && hasSharedD1Cache(context.env) ? "miss" : "skip";
        return withSourceHeader(withHeader(nativeResponse, "x-xway-shared-cache", cacheStatus), "native");
      } catch (error) {
        const fallbackResponse = await readSharedApiFallbackResponse(context, pathname, requestUrl, {
          "x-xway-native-error": "1",
        });
        if (fallbackResponse) {
          return fallbackResponse;
        }
        if (!apiOrigin || pathname === "/api/health" || pathname === "/api/mpvibe-stocks" || pathname === "/api/pachka-report" || pathname === "/api/pachka-report/send") {
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
