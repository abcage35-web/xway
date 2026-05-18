import { cloneValue, hasCookieHeaderAuth, hasCsrfToken, hasNativeStorageState, hasSessionCookieAuth, mapWithConcurrency, resolveRange, sanitizeOrigin } from "./utils.js";
import { readSharedCache, writeSharedCache } from "./shared-cache.js";

const SOURCE_CACHE_VERSION = "v1";
const SOURCE_CACHE_PREFIX = "xway-source";
const SHOP_LIST_CACHE_TTL_MS = 120000;
const SHOP_LISTING_CACHE_TTL_MS = 120000;
const SHOP_DETAILS_CACHE_TTL_MS = 120000;
const PRODUCT_DAILY_STATS_CACHE_TTL_MS = 180000;
const PRODUCT_STATA_CACHE_TTL_MS = 180000;
const PRODUCT_INFO_CACHE_TTL_MS = 180000;
const PRODUCT_DYNAMICS_CACHE_TTL_MS = 180000;
const PRODUCT_STOCKS_RULE_CACHE_TTL_MS = 180000;
const PRODUCT_ORDERS_HEATMAP_CACHE_TTL_MS = 180000;
const CAMPAIGN_DAILY_EXACT_CACHE_TTL_MS = 180000;
const CAMPAIGN_SCHEDULE_CACHE_TTL_MS = 180000;
const PRODUCT_DAILY_STATS_CHUNK_DAYS = 30;
const PRODUCT_ORDERS_HEATMAP_CHUNK_DAYS = 7;
const CAMPAIGN_DAILY_EXACT_CONCURRENCY = 1;
const XWAY_RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const XWAY_REQUEST_MAX_ATTEMPTS = 3;
const XWAY_REQUEST_RETRY_DELAY_MS = 900;

const cacheStore = {
  shopList: new Map(),
  shopListing: new Map(),
  shopDetails: new Map(),
  productDailyStats: new Map(),
  productStata: new Map(),
  productInfo: new Map(),
  productDynamics: new Map(),
  productStocksRule: new Map(),
  productOrdersHeatMap: new Map(),
  campaignDailyExact: new Map(),
  campaignSchedule: new Map(),
};

function getCached(map, key, ttlMs) {
  const entry = map.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.createdAt > ttlMs) {
    map.delete(key);
    return null;
  }
  return cloneValue(entry.value);
}

function setCached(map, key, value) {
  map.set(key, { createdAt: Date.now(), value: cloneValue(value) });
}

function sourceCacheBinding(env) {
  const cache = env?.XWAY_AI_CACHE;
  return cache && typeof cache.get === "function" && typeof cache.put === "function" ? cache : null;
}

function sourceCacheKey(namespace, key) {
  return `${SOURCE_CACHE_PREFIX}:${SOURCE_CACHE_VERSION}:${namespace}:${key}`;
}

function sourceD1Namespace(namespace) {
  return `${SOURCE_CACHE_PREFIX}:${SOURCE_CACHE_VERSION}:${namespace}`;
}

function unwrapSourceCachePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "value")) {
    return payload.value;
  }
  return payload;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeXwayErrorText(status, text, statusText) {
  const rawText = String(text || statusText || "").replace(/\s+/g, " ").trim();
  if (status === 503 || /503 Service Temporarily Unavailable|temporarily unavailable/i.test(rawText)) {
    return "XWAY временно недоступен (503).";
  }
  return rawText || `HTTP ${status}`;
}

function decodeBase64(value) {
  if (!value) {
    return "";
  }
  if (typeof atob === "function") {
    return atob(value);
  }
  return Buffer.from(value, "base64").toString("utf8");
}

function parseStorageState(env) {
  const rawJson = String(env.XWAY_STORAGE_STATE_JSON || "").trim();
  const rawBase64 = String(env.XWAY_STORAGE_STATE_BASE64 || "").trim();
  const raw = rawJson || (rawBase64 ? decodeBase64(rawBase64) : "");
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.cookies)) {
      throw new Error("Storage state must contain a cookies array.");
    }
    return parsed;
  }

  if (hasCookieHeaderAuth(env)) {
    return {
      cookies: String(env.XWAY_COOKIE_HEADER || "")
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const separatorIndex = part.indexOf("=");
          if (separatorIndex <= 0) {
            return null;
          }
          return {
            name: part.slice(0, separatorIndex).trim(),
            value: part.slice(separatorIndex + 1).trim(),
          };
        })
        .filter((cookie) => cookie?.name && cookie?.value),
    };
  }

  if (hasSessionCookieAuth(env)) {
    const cookies = [
      {
        name: "sessionid",
        value: String(env.XWAY_SESSIONID || "").trim(),
      },
    ];
    const csrfToken = String(env.XWAY_CSRF_TOKEN || env.XWAY_CSRFTOKEN || "").trim();
    if (csrfToken) {
      cookies.push({
        name: "csrftoken_v2",
        value: csrfToken,
      });
    }
    return { cookies };
  }

  return null;
}

function buildCookieHeader(storageState) {
  return (storageState.cookies || [])
    .filter((cookie) => cookie && cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function csrfTokenFromState(storageState) {
  const cookies = storageState.cookies || [];
  return (
    cookies.find((cookie) => cookie?.name === "csrftoken_v2")?.value ||
    cookies.find((cookie) => cookie?.name === "csrftoken")?.value ||
    null
  );
}

function parseIsoDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseXwayDateTime(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  const match = text.match(/^(\d{1,2})[.-](\d{1,2})[.-](\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) {
    return null;
  }
  const [, dd, mm, yyyy, hh = "0", min = "0", sec = "0"] = match;
  const parsed = new Date(Date.UTC(
    Number.parseInt(yyyy, 10),
    Number.parseInt(mm, 10) - 1,
    Number.parseInt(dd, 10),
    Number.parseInt(hh, 10),
    Number.parseInt(min, 10),
    Number.parseInt(sec, 10),
  ));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseFlexibleDateTime(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const explicitRu = parseXwayDateTime(text);
  if (explicitRu) {
    return explicitRu;
  }

  const normalized = text.replace("Z", "+00:00");
  const candidates = [normalized];
  if (normalized.includes(" ") && !normalized.includes("T")) {
    candidates.push(normalized.replace(" ", "T"));
  }

  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const localDateTimeMatch = text.match(/^(\d{2})[.-](\d{2})[.-](\d{4}),\s*(\d{2}):(\d{2})$/);
  if (localDateTimeMatch) {
    const [, dd, mm, yyyy, hh, min] = localDateTimeMatch;
    const parsed = new Date(Date.UTC(Number.parseInt(yyyy, 10), Number.parseInt(mm, 10) - 1, Number.parseInt(dd, 10), Number.parseInt(hh, 10), Number.parseInt(min, 10)));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const localDateMatch = text.match(/^(\d{2})[.-](\d{2})[.-](\d{4})$/);
  if (localDateMatch) {
    const [, dd, mm, yyyy] = localDateMatch;
    const parsed = new Date(Date.UTC(Number.parseInt(yyyy, 10), Number.parseInt(mm, 10) - 1, Number.parseInt(dd, 10)));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function isoDateFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftIsoDate(day, deltaDays) {
  const parsed = parseIsoDate(day);
  if (!parsed) {
    return String(day || "");
  }
  parsed.setUTCDate(parsed.getUTCDate() + deltaDays);
  return isoDateFromDate(parsed);
}

function splitIsoDateRange(start, end, chunkDays = PRODUCT_DAILY_STATS_CHUNK_DAYS) {
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  if (!startDate || !endDate || startDate > endDate) {
    return [];
  }
  const ranges = [];
  for (let cursor = new Date(startDate); cursor <= endDate; cursor.setUTCDate(cursor.getUTCDate() + chunkDays)) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + chunkDays - 1);
    if (chunkEnd > endDate) {
      chunkEnd.setTime(endDate.getTime());
    }
    ranges.push({
      start: isoDateFromDate(chunkStart),
      end: isoDateFromDate(chunkEnd),
    });
  }
  return ranges;
}

function isoDateRangeDays(start, end) {
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  if (!startDate || !endDate || startDate > endDate) {
    return 0;
  }
  return Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
}

function isRetryableXwayError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /\b(429|502|503|504|1102)\b|Worker exceeded resource limits|temporarily unavailable|gateway timeout|timed?\s*out/i.test(message);
}

function aggregateOrdersHeatMapPayloads(payloads, start, end) {
  const byHour = {};
  let overallOrders = 0;
  let hasOverallOrders = false;
  let statisticsFrom = null;

  for (const payload of payloads || []) {
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const payloadOverallOrders = Number(payload.overall_orders);
    if (Number.isFinite(payloadOverallOrders)) {
      overallOrders += payloadOverallOrders;
      hasOverallOrders = true;
    }
    if (!statisticsFrom && payload.statistics_from) {
      statisticsFrom = payload.statistics_from;
    }
    for (let hour = 0; hour < 24; hour += 1) {
      const key = String(hour);
      const value = Number(payload.by_hour?.[key]?.value);
      byHour[key] = {
        ...(byHour[key] || {}),
        value: (Number(byHour[key]?.value) || 0) + (Number.isFinite(value) ? value : 0),
      };
    }
  }

  return {
    period_from: start,
    period_to: end,
    statistics_from: statisticsFrom,
    overall_orders: hasOverallOrders ? overallOrders : null,
    by_hour: byHour,
    partial: payloads.some((payload) => payload?.partial),
    aggregated_from_chunks: true,
  };
}

function buildStatDynReferer(baseReferer, start, end) {
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  if (!startDate || !endDate || startDate > endDate) {
    return baseReferer;
  }
  const spanDays = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
  const dynEnd = shiftIsoDate(start, -1);
  const dynStart = shiftIsoDate(dynEnd, -(spanDays - 1));
  return `${baseReferer}?stat=${start}..${end}&dyn=${dynStart}..${dynEnd}`;
}

function statusMpHistoryReachedStart(rows, start) {
  const targetDate = parseIsoDate(start);
  if (!targetDate) {
    return false;
  }
  let minDay = null;
  for (const row of rows || []) {
    const parsed = parseFlexibleDateTime(row?.timestamp);
    if (!parsed) {
      continue;
    }
    if (!minDay || parsed.getTime() < minDay.getTime()) {
      minDay = parsed;
    }
  }
  return Boolean(minDay && isoDateFromDate(minDay) <= isoDateFromDate(targetDate));
}

function statusPauseHistoryReachedStart(payload, start) {
  const targetDate = parseIsoDate(start);
  if (!targetDate) {
    return false;
  }
  let minDay = null;
  for (const row of payload?.tooltips || []) {
    const parsed = parseFlexibleDateTime(row?.startDate || row?.endDate);
    if (!parsed) {
      continue;
    }
    if (!minDay || parsed.getTime() < minDay.getTime()) {
      minDay = parsed;
    }
  }
  return Boolean(minDay && isoDateFromDate(minDay) <= isoDateFromDate(targetDate));
}

export class XwayApiClient {
  constructor(env, { start = null, end = null, forceRefresh = false } = {}) {
    const storageState = parseStorageState(env);
    if (!storageState) {
      throw new Error("Native handlers require XWAY_STORAGE_STATE_JSON, XWAY_STORAGE_STATE_BASE64, XWAY_COOKIE_HEADER, or XWAY_SESSIONID.");
    }
    this.env = env;
    this.storageState = storageState;
    this.range = resolveRange(start, end);
    this.cookieHeader = buildCookieHeader(storageState);
    this.csrfToken = String(env.XWAY_CSRF_TOKEN || env.XWAY_CSRFTOKEN || "").trim() || csrfTokenFromState(storageState);
    this.baseOrigin = "https://am.xway.ru";
    this.cacheNamespace = sanitizeOrigin(env.XWAY_CACHE_NAMESPACE || env.CF_PAGES_URL || env.API_ORIGIN || "xway");
    this.forceRefresh = Boolean(forceRefresh);
  }

  static canUseNative(env) {
    return hasNativeStorageState(env);
  }

  buildHeaders({ referer = null, csrf = false, extraHeaders = {} } = {}) {
    const headers = new Headers({
      accept: "application/json, text/plain, */*",
      cookie: this.cookieHeader,
      ...extraHeaders,
    });
    if (referer) {
      headers.set("referer", referer);
    }
    if (csrf && this.csrfToken) {
      headers.set("x-csrftoken", this.csrfToken);
      headers.set("x-requested-with", "XMLHttpRequest");
    }
    return headers;
  }

  buildProductReferer(shopId, productId) {
    return `${this.baseOrigin}/wb/shop/${shopId}/product/${productId}`;
  }

  buildCampaignReferer(shopId, productId, campaignId, start = this.range.current_start, end = this.range.current_end) {
    return `${this.buildProductReferer(shopId, productId)}/campaign/${campaignId}/new-flow?stat=${start}..${end}`;
  }

  async readSourceCache(map, key, ttlMs) {
    if (this.forceRefresh) {
      return null;
    }

    const memoryCached = getCached(map, key, ttlMs);
    if (memoryCached) {
      return memoryCached;
    }

    const d1Cached = await readSharedCache(this.env, sourceD1Namespace(this.cacheNamespace), key, { maxAgeMs: ttlMs });
    if (d1Cached !== null && d1Cached !== undefined) {
      setCached(map, key, d1Cached);
      return cloneValue(d1Cached);
    }

    const cache = sourceCacheBinding(this.env);
    if (!cache) {
      return null;
    }

    try {
      const cached = await cache.get(sourceCacheKey(this.cacheNamespace, key), "json");
      const value = unwrapSourceCachePayload(cached);
      if (value === null || value === undefined) {
        return null;
      }
      setCached(map, key, value);
      await writeSharedCache(this.env, sourceD1Namespace(this.cacheNamespace), key, value, { ttlMs });
      return cloneValue(value);
    } catch {
      return null;
    }
  }

  async writeSourceCache(map, key, value) {
    setCached(map, key, value);
    await writeSharedCache(this.env, sourceD1Namespace(this.cacheNamespace), key, value);

    const cache = sourceCacheBinding(this.env);
    if (!cache) {
      return;
    }

    try {
      await cache.put(
        sourceCacheKey(this.cacheNamespace, key),
        JSON.stringify({
          created_at: new Date().toISOString(),
          value,
        }),
      );
    } catch {
      // Source cache is an optimization only. A KV write failure must not fail the data load.
    }
  }

  async requestJson(pathname, { method = "GET", referer = null, params = null, csrf = false, body = null, json = null, extraHeaders = {} } = {}) {
    const url = new URL(pathname, this.baseOrigin);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== null && value !== undefined && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const headers = this.buildHeaders({ referer, csrf, extraHeaders });
    let requestBody = body;
    if (json !== null && json !== undefined) {
      headers.set("content-type", "application/json; charset=utf-8");
      requestBody = JSON.stringify(json);
    }
    for (let attempt = 0; attempt < XWAY_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: ["GET", "HEAD"].includes(method.toUpperCase()) ? undefined : requestBody,
        redirect: "follow",
      });
      if (!response.ok) {
        const text = await response.text();
        const message = normalizeXwayErrorText(response.status, text, response.statusText);
        if (XWAY_RETRYABLE_STATUSES.has(response.status) && attempt < XWAY_REQUEST_MAX_ATTEMPTS - 1) {
          await wait(XWAY_REQUEST_RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw new Error(`XWAY request failed (${response.status}): ${message}`);
      }
      if (response.status === 204) {
        return null;
      }
      return response.json();
    }
    throw new Error("XWAY request failed: retry attempts exhausted");
  }

  async listShops() {
    const cacheKey = `${this.cacheNamespace}:shops`;
    const cached = await this.readSourceCache(cacheStore.shopList, cacheKey, SHOP_LIST_CACHE_TTL_MS);
    if (cached) {
      return cached;
    }
    const payload = await this.requestJson("/api/adv/shop/list", { params: { query: "" } });
    await this.writeSourceCache(cacheStore.shopList, cacheKey, payload);
    return payload;
  }

  async shopDetails(shopId) {
    const cacheKey = `${this.cacheNamespace}:shop-details:${shopId}`;
    const cached = await this.readSourceCache(cacheStore.shopDetails, cacheKey, SHOP_DETAILS_CACHE_TTL_MS);
    if (cached) {
      return cached;
    }
    const payload = await this.requestJson(`/api/adv/shop/${shopId}`, {
      referer: `${this.baseOrigin}/wb/shop/${shopId}`,
    });
    await this.writeSourceCache(cacheStore.shopDetails, cacheKey, payload);
    return payload;
  }

  async shopListing(shopId, start = this.range.current_start, end = this.range.current_end) {
    const cacheKey = `${this.cacheNamespace}:shop-listing:${shopId}:${start}:${end}`;
    const cached = await this.readSourceCache(cacheStore.shopListing, cacheKey, SHOP_LISTING_CACHE_TTL_MS);
    if (cached) {
      return cached;
    }
    const query = {
      start,
      end,
      is_active: 1,
      enabled: 1,
    };
    const referer = `${this.baseOrigin}/wb/shop/${shopId}`;
    const [listWoResult, listStatResult] = await Promise.allSettled([
      this.requestJson(`/api/adv/shop/${shopId}/product/list-wo-stat`, { referer, params: query }),
      this.requestJson(`/api/adv/shop/${shopId}/product/list-stat`, { referer, params: query }),
    ]);

    if (listWoResult.status === "rejected" && listStatResult.status === "rejected") {
      throw new Error(`Failed to load shop listing for shop ${shopId}`);
    }

    const payload = {
      list_wo: listWoResult.status === "fulfilled" ? listWoResult.value : { products_wb: [] },
      list_stat: listStatResult.status === "fulfilled" ? listStatResult.value : { products_wb: {} },
    };
    await this.writeSourceCache(cacheStore.shopListing, cacheKey, payload);
    return payload;
  }

  async findArticles(articleIds) {
    const targets = new Set((articleIds || []).map((articleId) => String(articleId || "").trim()).filter(Boolean));
    const found = {};
    if (!targets.size) {
      return found;
    }
    const shops = await this.listShops();
    for (const shop of shops || []) {
      const shopId = Number(shop?.id);
      if (!Number.isFinite(shopId)) {
        continue;
      }
      const listing = await this.shopListing(shopId, this.range.current_start, this.range.current_end);
      const products = listing?.list_wo?.products_wb || [];
      const statMap = listing?.list_stat?.products_wb || {};
      for (const product of products) {
        const article = String(product?.external_id || "").trim();
        if (!article || !targets.has(article) || found[article]) {
          continue;
        }
        const productId = Number(product?.id);
        found[article] = {
          shop,
          product,
          stat_item: Number.isFinite(productId) ? statMap[String(productId)] || {} : {},
        };
      }
      if (Object.keys(found).length >= targets.size) {
        break;
      }
    }
    return found;
  }

  async productInfo(shopId, productId) {
    const cacheKey = `${this.cacheNamespace}:product-info:${shopId}:${productId}`;
    const cached = await this.readSourceCache(cacheStore.productInfo, cacheKey, PRODUCT_INFO_CACHE_TTL_MS);
    if (cached) {
      return cached;
    }
    const payload = await this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/info`, {
      referer: this.buildProductReferer(shopId, productId),
    });
    await this.writeSourceCache(cacheStore.productInfo, cacheKey, payload);
    return payload;
  }

  async productDynamics(shopId, productId) {
    const cacheKey = `${this.cacheNamespace}:product-dynamics:${shopId}:${productId}:${this.range.current_start}:${this.range.current_end}`;
    const cached = await this.readSourceCache(cacheStore.productDynamics, cacheKey, PRODUCT_DYNAMICS_CACHE_TTL_MS);
    if (cached) {
      return cached;
    }
    const payload = await this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/dynamics-totals`, {
      referer: this.buildProductReferer(shopId, productId),
      params: {
        filter_start: this.range.current_start,
        filter_end: this.range.current_end,
        dynamics_start: this.range.compare_start,
        dynamics_end: this.range.compare_end,
        is_active: 0,
      },
    });
    await this.writeSourceCache(cacheStore.productDynamics, cacheKey, payload);
    return payload;
  }

  async productStocksRule(shopId, productId) {
    const cacheKey = `${this.cacheNamespace}:product-stocks-rule:${shopId}:${productId}`;
    const cached = await this.readSourceCache(cacheStore.productStocksRule, cacheKey, PRODUCT_STOCKS_RULE_CACHE_TTL_MS);
    if (cached) {
      return cached;
    }
    const payload = await this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/stocks-rule`, {
      referer: this.buildProductReferer(shopId, productId),
    });
    await this.writeSourceCache(cacheStore.productStocksRule, cacheKey, payload);
    return payload;
  }

  async productStataRange(shopId, productId, start = this.range.current_start, end = this.range.current_end) {
    const cacheKey = `${this.cacheNamespace}:product-stata:${shopId}:${productId}:${start}:${end}`;
    const cached = await this.readSourceCache(cacheStore.productStata, cacheKey, PRODUCT_STATA_CACHE_TTL_MS);
    if (cached) {
      return cached;
    }
    const payload = await this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/stata`, {
      referer: this.buildProductReferer(shopId, productId),
      params: {
        is_active: 0,
        start,
        end,
        tags: "",
        active_camps: 1,
      },
    });
    await this.writeSourceCache(cacheStore.productStata, cacheKey, payload);
    return payload;
  }

  async productStata(shopId, productId) {
    return this.productStataRange(shopId, productId, this.range.current_start, this.range.current_end);
  }

  async productStatsByDay(shopId, productId, start = this.range.current_start, end = this.range.current_end) {
    const cacheKey = `${this.cacheNamespace}:product-stats:${shopId}:${productId}:${start}:${end}`;
    const cached = await this.readSourceCache(cacheStore.productDailyStats, cacheKey, PRODUCT_DAILY_STATS_CACHE_TTL_MS);
    if (cached) {
      return cached;
    }
    const ranges = splitIsoDateRange(start, end);
    if (ranges.length > 1) {
      const rowsByDay = new Map();
      for (const range of ranges) {
        const rows = await this.productStatsByDay(shopId, productId, range.start, range.end);
        for (const row of rows || []) {
          const day = String(row?.day || "").trim();
          if (day) {
            rowsByDay.set(day, row);
          }
        }
      }
      const payload = [...rowsByDay.values()].sort((left, right) => String(left.day || "").localeCompare(String(right.day || "")));
      await this.writeSourceCache(cacheStore.productDailyStats, cacheKey, payload);
      return payload;
    }
    const range = ranges[0] || { start, end };
    const payload = await this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/stats-by-day`, {
      referer: buildStatDynReferer(this.buildProductReferer(shopId, productId), range.start, range.end),
      params: { start: range.start, end: range.end },
    });
    await this.writeSourceCache(cacheStore.productDailyStats, cacheKey, payload);
    return payload;
  }

  async campaignDailyExact(shopId, productId, campaignIds, start = this.range.current_start, end = this.range.current_end) {
    const normalizedIds = [...new Set((campaignIds || []).map((campaignId) => String(campaignId || "").trim()).filter(Boolean))].sort();
    const result = Object.fromEntries(normalizedIds.map((campaignId) => [campaignId, []]));
    if (!normalizedIds.length) {
      return result;
    }
    const cacheKey = `${this.cacheNamespace}:campaign-daily-exact:${shopId}:${productId}:${normalizedIds.join(",")}:${start}:${end}`;
    const cached = await this.readSourceCache(cacheStore.campaignDailyExact, cacheKey, CAMPAIGN_DAILY_EXACT_CACHE_TTL_MS);
    if (cached) {
      return cached;
    }
    const days = [];
    for (let dayCursor = new Date(`${start}T00:00:00Z`); dayCursor <= new Date(`${end}T00:00:00Z`); dayCursor = new Date(dayCursor.getTime() + 86400000)) {
      days.push(dayCursor.toISOString().slice(0, 10));
    }
    const dayPayloads = await mapWithConcurrency(days, CAMPAIGN_DAILY_EXACT_CONCURRENCY, async (day) => {
      try {
        return {
          day,
          stata: await this.productStataRange(shopId, productId, day, day),
          error: null,
        };
      } catch (error) {
        return {
          day,
          stata: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    const errors = [];
    for (const { day, stata } of dayPayloads) {
      if (!stata) {
        errors.push(day);
        continue;
      }
      const campaignMap = new Map(
        (stata?.campaign_wb || [])
          .filter((campaign) => campaign?.id !== null && campaign?.id !== undefined)
          .map((campaign) => [String(campaign.id), campaign]),
      );
      for (const campaignId of normalizedIds) {
        const stat = campaignMap.get(campaignId)?.stat || {};
        result[campaignId].push({
          day,
          views: stat.views ?? null,
          clicks: stat.clicks ?? null,
          atbs: stat.atbs ?? null,
          orders: stat.orders ?? null,
          shks: stat.shks ?? null,
          rel_shks: stat.rel_shks ?? null,
          expense_sum: stat.sum ?? null,
          sum_price: stat.sum_price ?? null,
          rel_sum_price: stat.rel_sum_price ?? null,
          CTR: stat.CTR ?? null,
          CPC: stat.CPC ?? null,
          CR: stat.CR ?? null,
          CPO: stat.CPO ?? null,
          CPO_with_rel: stat.CPO_with_rel ?? null,
        });
      }
    }
    if (errors.length) {
      Object.defineProperty(result, "__missing_days", {
        value: errors,
        enumerable: false,
      });
    }
    if (!errors.length) {
      await this.writeSourceCache(cacheStore.campaignDailyExact, cacheKey, result);
    }
    return result;
  }

  async productHeatMap(shopId, productId, campaignIds) {
    const campaigns = (campaignIds || []).map((campaignId) => Number.parseInt(String(campaignId), 10)).filter(Number.isFinite);
    if (!campaigns.length) {
      return null;
    }
    return this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/heat-map`, {
      referer: this.buildProductReferer(shopId, productId),
      params: {
        campaigns: campaigns.join(","),
        from: this.range.current_start,
        to: this.range.current_end,
      },
    });
  }

  async productOrdersHeatMapRange(shopId, productId, start = this.range.current_start, end = this.range.current_end, { allowSplit = true } = {}) {
    const cacheKey = `${this.cacheNamespace}:product-orders-heat-map:${shopId}:${productId}:${start}:${end}`;
    const cached = await this.readSourceCache(cacheStore.productOrdersHeatMap, cacheKey, PRODUCT_ORDERS_HEATMAP_CACHE_TTL_MS);
    if (cached) {
      return cached;
    }

    try {
      const payload = await this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/orders-heat-map`, {
        referer: this.buildProductReferer(shopId, productId),
        params: {
          from: start,
          to: end,
        },
      });
      await this.writeSourceCache(cacheStore.productOrdersHeatMap, cacheKey, payload);
      return payload;
    } catch (error) {
      const days = isoDateRangeDays(start, end);
      if (!allowSplit || days <= 1 || !isRetryableXwayError(error)) {
        throw error;
      }

      const chunkDays = days <= PRODUCT_ORDERS_HEATMAP_CHUNK_DAYS ? Math.max(1, Math.ceil(days / 2)) : PRODUCT_ORDERS_HEATMAP_CHUNK_DAYS;
      const ranges = splitIsoDateRange(start, end, chunkDays);
      const payloads = [];
      for (const range of ranges) {
        try {
          payloads.push(await this.productOrdersHeatMapRange(shopId, productId, range.start, range.end, { allowSplit: true }));
        } catch (chunkError) {
          if (isRetryableXwayError(chunkError)) {
            payloads.push({
              period_from: range.start,
              period_to: range.end,
              partial: true,
              by_hour: {},
            });
            continue;
          }
          throw chunkError;
        }
      }
      const payload = aggregateOrdersHeatMapPayloads(payloads, start, end);
      await this.writeSourceCache(cacheStore.productOrdersHeatMap, cacheKey, payload);
      return payload;
    }
  }

  async productOrdersHeatMap(shopId, productId) {
    return this.productOrdersHeatMapRange(shopId, productId, this.range.current_start, this.range.current_end);
  }

  async campaignSchedule(shopId, productId, campaignId) {
    const cacheKey = `${this.cacheNamespace}:campaign-schedule:${shopId}:${productId}:${campaignId}`;
    const cached = await this.readSourceCache(cacheStore.campaignSchedule, cacheKey, CAMPAIGN_SCHEDULE_CACHE_TTL_MS);
    if (cached) {
      return cached;
    }
    const payload = await this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/campaign/${campaignId}/schedule-get`, {
      referer: this.buildCampaignReferer(shopId, productId, campaignId),
    });
    await this.writeSourceCache(cacheStore.campaignSchedule, cacheKey, payload);
    return payload;
  }

  async campaignBidHistory(shopId, productId, campaignId) {
    return this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/campaign/${campaignId}/bid-history`, {
      referer: this.buildCampaignReferer(shopId, productId, campaignId),
    });
  }

  async campaignBudgetHistory(shopId, productId, campaignId) {
    return this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/campaign/${campaignId}/budget-history`, {
      referer: this.buildCampaignReferer(shopId, productId, campaignId),
    });
  }

  async campaignStatusMpHistory(shopId, productId, campaignId, offset = 0, limit = 40) {
    return this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/campaign/${campaignId}/status-mp-history`, {
      referer: this.buildProductReferer(shopId, productId),
      params: { offset, limit },
    });
  }

  async campaignStatusMpHistoryFull(shopId, productId, campaignId, { pageLimit = 120, maxPages = 50, targetStart = null } = {}) {
    let safeLimit = Math.max(1, Number.parseInt(String(pageLimit || 120), 10) || 120);
    let safeMaxPages = Math.max(1, Number.parseInt(String(maxPages || 50), 10) || 50);
    if (targetStart) {
      safeMaxPages = Math.max(safeMaxPages, 200);
    }
    let offset = 0;
    const result = [];
    let nextPage = false;

    for (let index = 0; index < safeMaxPages; index += 1) {
      const payload = (await this.campaignStatusMpHistory(shopId, productId, campaignId, offset, safeLimit)) || {};
      const pageRows = payload.result || [];
      result.push(...pageRows);
      nextPage = Boolean(payload.next_page);
      if (statusMpHistoryReachedStart(result, targetStart) || !nextPage || !pageRows.length || pageRows.length < safeLimit) {
        nextPage = Boolean(nextPage && !statusMpHistoryReachedStart(result, targetStart) && pageRows.length >= safeLimit);
        break;
      }
      offset += safeLimit;
    }

    return {
      result,
      next_page: nextPage,
    };
  }

  async campaignStatusPauseHistory(shopId, productId, campaignId, limit = 24) {
    return this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/campaign/${campaignId}/status-pause-history`, {
      method: "POST",
      referer: this.buildProductReferer(shopId, productId),
      csrf: true,
      json: { limit },
    });
  }

  async campaignStatusPauseHistoryFull(shopId, productId, campaignId, { initialLimit = 120, maxLimit = 5000, targetStart = null } = {}) {
    let safeLimit = Math.max(1, Number.parseInt(String(initialLimit || 120), 10) || 120);
    let safeMaxLimit = Math.max(safeLimit, Number.parseInt(String(maxLimit || 5000), 10) || 5000);
    if (targetStart) {
      safeMaxLimit = Math.max(safeMaxLimit, 20000);
    }

    while (true) {
      const payload = (await this.campaignStatusPauseHistory(shopId, productId, campaignId, safeLimit)) || {};
      if (statusPauseHistoryReachedStart(payload, targetStart)) {
        return payload;
      }
      const nextPage = payload.next_page || {};
      if (!nextPage.has_next || safeLimit >= safeMaxLimit) {
        return payload;
      }
      const requestedLimit = Math.max(safeLimit, Number.parseInt(String(nextPage.limit || safeLimit), 10) || safeLimit);
      safeLimit = Math.min(safeMaxLimit, Math.max(requestedLimit + 120, safeLimit * 2));
    }
  }

  async campaignNormqueryStats(shopId, productId, campaignId) {
    const currentEndDate = new Date(`${this.range.current_end}T00:00:00Z`);
    currentEndDate.setUTCDate(currentEndDate.getUTCDate() - 30);
    return this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/campaign/${campaignId}/normquery-stats`, {
      referer: this.buildCampaignReferer(shopId, productId, campaignId),
      params: {
        search_mode: "cluster",
        search_part: "cluster",
        excludes: "",
        includes: "",
        exact_match: 0,
        start: this.range.current_start,
        end: this.range.current_end,
        dynamics_start: this.range.compare_start,
        dynamics_end: this.range.compare_end,
        for_jam_start: currentEndDate.toISOString().slice(0, 10),
        for_jam_end: this.range.current_end,
        with_stats_only: 1,
        init: 1,
      },
    });
  }

  async productNormqueriesPositions(shopId, productId, normqueryIds) {
    const ids = (normqueryIds || []).map((normqueryId) => Number.parseInt(String(normqueryId), 10)).filter(Number.isFinite);
    if (!ids.length) {
      return {};
    }
    return this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/normqueries-positions`, {
      method: "POST",
      referer: this.buildProductReferer(shopId, productId),
      csrf: true,
      json: { normquery_ids: ids },
    });
  }

  async campaignAdditionalStatsForNormqueries(shopId, productId, campaignId, normqueryIds, start = this.range.current_start, end = this.range.current_end) {
    const ids = (normqueryIds || []).map((normqueryId) => Number.parseInt(String(normqueryId), 10)).filter(Number.isFinite);
    if (!ids.length) {
      return {};
    }
    return this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/campaign/${campaignId}/additional-stats-for-normqueries`, {
      method: "POST",
      referer: this.buildCampaignReferer(shopId, productId, campaignId),
      csrf: true,
      json: {
        normquery_ids: ids,
        start,
        end,
      },
    });
  }

  async campaignNormqueryHistory(shopId, productId, campaignId, normqueryId) {
    return this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/campaign/${campaignId}/normquery-history`, {
      referer: this.buildCampaignReferer(shopId, productId, campaignId),
      params: { normquery_id: normqueryId },
    });
  }

  async campaignNormqueryBidHistory(shopId, productId, campaignId, normqueryId) {
    return this.requestJson(`/api/adv/shop/${shopId}/product/${productId}/campaign/${campaignId}/normquery-bid-history`, {
      referer: this.buildCampaignReferer(shopId, productId, campaignId),
      params: { normquery_id: normqueryId },
    });
  }
}
