import type { AiChatMessage, AiChatResponse, CatalogArticle, CatalogCampaignState, CatalogChartResponse, CatalogIssuesResponse, CatalogProductDetailRow, CatalogProductDetailsResponse, CatalogResponse, ClusterDetailResponse, ProductsResponse } from "./types";
import { readPersistentApiCache, writePersistentApiCache } from "./persistent-api-cache";

export const DEFAULT_ARTICLES = ["44392513", "60149847"];
const API_RESPONSE_CACHE_VERSION = "v3";

function buildBaseUrl(request?: Request) {
  if (request) {
    return new URL(request.url).origin;
  }
  return window.location.origin;
}

function isRetryableXwayUnavailable(status: number, text: string) {
  return status === 503 || /\b503\b|temporarily unavailable|XWAY request failed \(503\)/i.test(text);
}

function waitForRequestRetry(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error("Aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  }

  return new Promise<void>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    const handleAbort = () => {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", handleAbort);
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function createAbortError() {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function normalizeCacheUrl(input: URL) {
  const url = new URL(input.toString());
  url.searchParams.delete("refresh");

  const articles = url.searchParams.get("articles");
  if (articles) {
    url.searchParams.set("articles", articles.split(",").filter(Boolean).sort().join(","));
  }

  const products = url.searchParams.get("products");
  if (products) {
    url.searchParams.set("products", products.split(",").filter(Boolean).sort().join(","));
  }

  const shops = url.searchParams.get("shops");
  if (shops) {
    url.searchParams.set("shops", shops.split(",").filter(Boolean).sort().join(","));
  }

  const params = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyResult = leftKey.localeCompare(rightKey);
    return keyResult || leftValue.localeCompare(rightValue);
  });
  url.search = "";
  params.forEach(([key, value]) => url.searchParams.append(key, value));
  return url.toString();
}

function apiResponseCacheKey(namespace: string, url: URL) {
  return `${API_RESPONSE_CACHE_VERSION}:${namespace}:${normalizeCacheUrl(url)}`;
}

function sumCatalogArticles(shops: CatalogResponse["shops"]) {
  return shops.reduce(
    (totals, shop) => {
      shop.articles.forEach((article) => {
        totals.expense_sum += Number(article.expense_sum || 0);
        totals.orders += Number(article.orders || 0);
        totals.atbs += Number(article.atbs || 0);
        totals.clicks += Number(article.clicks || 0);
        totals.views += Number(article.views || 0);
      });
      return totals;
    },
    {
      expense_sum: 0,
      orders: 0,
      atbs: 0,
      clicks: 0,
      views: 0,
    },
  );
}

const CATALOG_CAMPAIGN_DETAIL_FIELDS: Array<keyof Pick<
  CatalogCampaignState,
  "budget_limit" | "budget_spent_today" | "budget_rule_active" | "spend_limit" | "spend_spent_today" | "spend_limit_active"
>> = [
  "budget_limit",
  "budget_spent_today",
  "budget_rule_active",
  "spend_limit",
  "spend_spent_today",
  "spend_limit_active",
];

function hasKnownCatalogCampaignDetailValue(value: unknown) {
  return value !== null && value !== undefined;
}

function mergeCatalogCampaignStatesPreservingDetails(baseStates: CatalogCampaignState[] = [], incomingStates: CatalogCampaignState[] = []) {
  if (!incomingStates.length) {
    return baseStates;
  }
  const baseByKey = new Map(baseStates.map((state) => [state.key, state]));
  return incomingStates.map((incomingState) => {
    const baseState = baseByKey.get(incomingState.key);
    if (!baseState) {
      return incomingState;
    }
    const mergedState = { ...baseState, ...incomingState };
    CATALOG_CAMPAIGN_DETAIL_FIELDS.forEach((field) => {
      if (!hasKnownCatalogCampaignDetailValue(incomingState[field]) && hasKnownCatalogCampaignDetailValue(baseState[field])) {
        mergedState[field] = baseState[field] as never;
      }
    });
    return mergedState;
  });
}

function mergeCatalogArticlePreservingDetails(baseArticle: CatalogArticle | null | undefined, incomingArticle: CatalogArticle) {
  if (!baseArticle) {
    return incomingArticle;
  }
  return {
    ...incomingArticle,
    campaign_states: mergeCatalogCampaignStatesPreservingDetails(baseArticle.campaign_states, incomingArticle.campaign_states),
    campaign_type_totals: incomingArticle.campaign_type_totals ?? baseArticle.campaign_type_totals,
    best_order_time: incomingArticle.best_order_time ?? baseArticle.best_order_time ?? null,
  };
}

function mergeCatalogCampaignStatesFromDetails(baseStates: CatalogCampaignState[] = [], detailStates: CatalogCampaignState[] = []) {
  if (!detailStates.length) {
    return baseStates;
  }
  const statesByKey = new Map(baseStates.map((state) => [state.key, state]));
  detailStates.forEach((detailState) => {
    const current = statesByKey.get(detailState.key);
    statesByKey.set(detailState.key, current ? { ...current, ...detailState } : detailState);
  });
  return [...statesByKey.values()];
}

function mergeCatalogArticleDetailRow(article: CatalogArticle, detailRow: CatalogProductDetailRow) {
  const hasCampaignError = Boolean(detailRow.errors?.campaign_details);
  const hasBestTimeError = Boolean(detailRow.errors?.best_order_time);
  return {
    ...article,
    campaign_states: hasCampaignError ? article.campaign_states : mergeCatalogCampaignStatesFromDetails(article.campaign_states, detailRow.campaign_states ?? []),
    campaign_type_totals: hasCampaignError ? article.campaign_type_totals : detailRow.campaign_type_totals ?? article.campaign_type_totals,
    best_order_time: hasBestTimeError ? article.best_order_time ?? null : detailRow.best_order_time ?? article.best_order_time ?? null,
  };
}

async function mergeCatalogProductResponseIntoFullCache(url: URL, productResponse: CatalogResponse) {
  const fullUrl = new URL(url.toString());
  fullUrl.searchParams.delete("products");
  fullUrl.searchParams.delete("shops");
  fullUrl.searchParams.delete("refresh");
  fullUrl.searchParams.delete("force_refresh");
  const fullCacheKey = apiResponseCacheKey("catalog", fullUrl);
  const cachedFullResponse = await readPersistentApiCache<CatalogResponse>(fullCacheKey);
  if (!cachedFullResponse) {
    return;
  }

  const replacementShopById = new Map(productResponse.shops.map((shop) => [String(shop.id), shop]));
  const replacementArticleByRef = new Map(
    productResponse.shops.flatMap((shop) => shop.articles.map((article) => [`${shop.id}:${article.product_id}`, article] as const)),
  );
  let changed = false;

  const shops = cachedFullResponse.shops.map((shop) => {
    const replacementShop = replacementShopById.get(String(shop.id));
    let shopChanged = false;
    const articles = shop.articles.map((article) => {
      const replacement = replacementArticleByRef.get(`${shop.id}:${article.product_id}`);
      if (!replacement) {
        return article;
      }
      changed = true;
      shopChanged = true;
      return mergeCatalogArticlePreservingDetails(article, replacement);
    });
    if (!replacementShop) {
      return shopChanged ? { ...shop, articles } : shop;
    }
    const { articles: _replacementArticles, listing_meta: _replacementListingMeta, ...shopPatch } = replacementShop;
    return {
      ...shop,
      ...shopPatch,
      listing_meta: shop.listing_meta,
      articles,
    };
  });

  if (!changed) {
    return;
  }

  await writePersistentApiCache<CatalogResponse>(fullCacheKey, {
    ...cachedFullResponse,
    generated_at: productResponse.generated_at,
    total_shops: shops.length,
    total_articles: shops.reduce((total, shop) => total + shop.articles.length, 0),
    totals: sumCatalogArticles(shops),
    shops,
  });
}

function mergeCatalogShopResponse(baseResponse: CatalogResponse, shopResponse: CatalogResponse) {
  const replacementShopById = new Map(shopResponse.shops.map((shop) => [String(shop.id), shop]));
  const baseShopById = new Map(baseResponse.shops.map((shop) => [String(shop.id), shop]));
  const seenShopIds = new Set<string>();
  let changed = false;

  const shops = baseResponse.shops.map((shop) => {
    const shopId = String(shop.id);
    seenShopIds.add(shopId);
    const replacement = replacementShopById.get(shopId);
    if (!replacement) {
      return shop;
    }
    changed = true;
    const baseArticlesByRef = new Map(shop.articles.map((article) => [`${shop.id}:${article.product_id}`, article]));
    return {
      ...replacement,
      articles: replacement.articles.map((article) =>
        mergeCatalogArticlePreservingDetails(baseArticlesByRef.get(`${replacement.id}:${article.product_id}`), article),
      ),
    };
  });

  shopResponse.shops.forEach((shop) => {
    const shopId = String(shop.id);
    if (!seenShopIds.has(shopId)) {
      const baseShop = baseShopById.get(shopId);
      const baseArticlesByRef = new Map((baseShop?.articles ?? []).map((article) => [`${shop.id}:${article.product_id}`, article]));
      shops.push({
        ...shop,
        articles: shop.articles.map((article) =>
          mergeCatalogArticlePreservingDetails(baseArticlesByRef.get(`${shop.id}:${article.product_id}`), article),
        ),
      });
      seenShopIds.add(shopId);
      changed = true;
    }
  });

  if (!changed) {
    return null;
  }

  return {
    ...baseResponse,
    generated_at: shopResponse.generated_at,
    total_shops: shops.length,
    total_articles: shops.reduce((total, shop) => total + shop.articles.length, 0),
    totals: sumCatalogArticles(shops),
    shops,
  };
}

async function mergeCatalogShopResponseIntoFullCache(url: URL, shopResponse: CatalogResponse) {
  if (!shopResponse.shops.length) {
    return;
  }

  const fullUrl = new URL(url.toString());
  fullUrl.searchParams.delete("products");
  fullUrl.searchParams.delete("shops");
  fullUrl.searchParams.delete("refresh");
  fullUrl.searchParams.delete("force_refresh");
  const fullCacheKey = apiResponseCacheKey("catalog", fullUrl);
  const cachedFullResponse = await readPersistentApiCache<CatalogResponse>(fullCacheKey);
  if (!cachedFullResponse) {
    await writePersistentApiCache<CatalogResponse>(fullCacheKey, {
      ...shopResponse,
      total_shops: shopResponse.shops.length,
      total_articles: shopResponse.shops.reduce((total, shop) => total + shop.articles.length, 0),
      totals: sumCatalogArticles(shopResponse.shops),
    });
    return;
  }

  const mergedResponse = mergeCatalogShopResponse(cachedFullResponse, shopResponse);
  if (!mergedResponse) {
    return;
  }

  await writePersistentApiCache<CatalogResponse>(fullCacheKey, mergedResponse);
}

async function mergeCatalogProductDetailsIntoFullCache(url: URL, detailsResponse: CatalogProductDetailsResponse) {
  if (!detailsResponse.rows.length) {
    return;
  }

  const fullUrl = new URL(url.toString());
  fullUrl.pathname = "/api/catalog";
  fullUrl.searchParams.set("mode", "compact");
  fullUrl.searchParams.set("aux", "0");
  fullUrl.searchParams.delete("products");
  fullUrl.searchParams.delete("refresh");
  fullUrl.searchParams.delete("force_refresh");
  fullUrl.searchParams.delete("best_time");
  fullUrl.searchParams.delete("campaign_details");
  fullUrl.searchParams.delete("include_campaign_details");
  const fullCacheKey = apiResponseCacheKey("catalog", fullUrl);
  const cachedFullResponse = await readPersistentApiCache<CatalogResponse>(fullCacheKey);
  if (!cachedFullResponse) {
    return;
  }

  const detailsByRef = new Map(detailsResponse.rows.map((row) => [row.product_ref, row]));
  let changed = false;
  const shops = cachedFullResponse.shops.map((shop) => ({
    ...shop,
    articles: shop.articles.map((article) => {
      const detailRow = detailsByRef.get(`${shop.id}:${article.product_id}`);
      if (!detailRow) {
        return article;
      }
      changed = true;
      return mergeCatalogArticleDetailRow(article, detailRow);
    }),
  }));

  if (!changed) {
    return;
  }

  await writePersistentApiCache<CatalogResponse>(fullCacheKey, {
    ...cachedFullResponse,
    generated_at: detailsResponse.generated_at,
    shops,
  });
}

async function requestCachedJson<T>(
  url: URL,
  signal: AbortSignal | undefined,
  requestOptions: { retry503?: boolean; maxAttempts?: number; retryDelayMs?: number },
  cacheOptions: {
    namespace: string;
    bypassRead?: boolean;
    shouldWrite?: (response: T) => boolean;
    afterWrite?: (response: T) => Promise<void> | void;
  },
): Promise<T> {
  const cacheKey = apiResponseCacheKey(cacheOptions.namespace, url);
  if (signal?.aborted) {
    throw createAbortError();
  }

  if (!cacheOptions.bypassRead) {
    const cached = await readPersistentApiCache<T>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const response = await requestJson<T>(url.toString(), signal, requestOptions);
  if (cacheOptions.shouldWrite?.(response) ?? true) {
    await writePersistentApiCache(cacheKey, response);
    await cacheOptions.afterWrite?.(response);
  }
  return response;
}

async function requestJson<T>(
  input: string,
  signal?: AbortSignal,
  options: { retry503?: boolean; maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<T> {
  const maxAttempts = options.retry503 ? Math.max(1, options.maxAttempts ?? 3) : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(input, { signal });
    const text = await response.text();
    let data = {} as T & { ok?: boolean; error?: string };
    try {
      data = text ? (JSON.parse(text) as T & { ok?: boolean; error?: string }) : data;
    } catch (error) {
      if (!response.ok) {
        if (options.retry503 && attempt < maxAttempts - 1 && isRetryableXwayUnavailable(response.status, text)) {
          await waitForRequestRetry(options.retryDelayMs ?? 800, signal);
          continue;
        }
        throw new Response(text || response.statusText, {
          status: response.status,
          statusText: response.statusText,
        });
      }
      throw error;
    }

    if (!response.ok) {
      if (options.retry503 && attempt < maxAttempts - 1 && isRetryableXwayUnavailable(response.status, data.error || text)) {
        await waitForRequestRetry(options.retryDelayMs ?? 800, signal);
        continue;
      }
      throw new Response(text || response.statusText, {
        status: response.status,
        statusText: response.statusText,
      });
    }
    if ("ok" in data && data.ok === false) {
      const message = data.error || "API request failed";
      if (options.retry503 && attempt < maxAttempts - 1 && isRetryableXwayUnavailable(response.status, message)) {
        await waitForRequestRetry(options.retryDelayMs ?? 800, signal);
        continue;
      }
      throw new Error(message);
    }
    return data;
  }

  throw new Error("API request failed");
}

function appendRange(params: URLSearchParams, start?: string | null, end?: string | null) {
  if (start) {
    params.set("start", start);
  }
  if (end) {
    params.set("end", end);
  }
}

export function parseArticlesParam(rawValue: string | null) {
  const values = (rawValue || "")
    .split(",")
    .map((article) => article.trim())
    .filter(Boolean);
  return values.length ? [...new Set(values)] : DEFAULT_ARTICLES;
}

export async function fetchProducts(options: {
  request?: Request;
  articles: string[];
  start?: string | null;
  end?: string | null;
  campaignMode?: "full" | "summary";
  heavyCampaignIds?: Array<number | string>;
  signal?: AbortSignal;
}) {
  const url = new URL("/api/products", buildBaseUrl(options.request));
  url.searchParams.set("articles", options.articles.join(","));
  appendRange(url.searchParams, options.start, options.end);
  if (options.campaignMode) {
    url.searchParams.set("campaign_mode", options.campaignMode);
  }
  if (options.heavyCampaignIds?.length) {
    url.searchParams.set("heavy_campaign_ids", options.heavyCampaignIds.map((id) => String(id)).join(","));
  }
  return requestJson<ProductsResponse>(url.toString(), options.signal ?? options.request?.signal, { retry503: true, maxAttempts: 3, retryDelayMs: 900 });
}

export async function fetchCatalog(options: {
  request?: Request;
  start?: string | null;
  end?: string | null;
  signal?: AbortSignal;
  forceRefresh?: boolean;
  productRefs?: string[];
  shopIds?: Array<number | string>;
  includeAux?: boolean;
}) {
  const url = new URL("/api/catalog", buildBaseUrl(options.request));
  url.searchParams.set("mode", "compact");
  if (options.productRefs?.length) {
    url.searchParams.set("products", options.productRefs.join(","));
  }
  if (options.shopIds?.length) {
    url.searchParams.set("shops", options.shopIds.map((id) => String(id)).join(","));
  }
  if (options.includeAux === false) {
    url.searchParams.set("aux", "0");
  }
  appendRange(url.searchParams, options.start, options.end);
  if (options.forceRefresh) {
    url.searchParams.set("refresh", "1");
  }
  return requestCachedJson<CatalogResponse>(
    url,
    options.signal ?? options.request?.signal,
    { retry503: true, maxAttempts: 3, retryDelayMs: 900 },
    {
      namespace: "catalog",
      bypassRead: options.forceRefresh,
      afterWrite: options.shopIds?.length
        ? (response) => mergeCatalogShopResponseIntoFullCache(url, response)
        : options.productRefs?.length && options.includeAux !== false
          ? (response) => mergeCatalogProductResponseIntoFullCache(url, response)
          : undefined,
    },
  );
}

export async function fetchCatalogChart(options: {
  productRefs: string[];
  start?: string | null;
  end?: string | null;
  includeCampaignTypes?: boolean;
  forceRefresh?: boolean;
  cursor?: string | null;
  limitProducts?: number | null;
  deadlineMs?: number | null;
  signal?: AbortSignal;
}) {
  const url = new URL("/api/catalog-chart", window.location.origin);
  if (options.productRefs.length) {
    url.searchParams.set("products", options.productRefs.join(","));
  }
  appendRange(url.searchParams, options.start, options.end);
  if (options.includeCampaignTypes) {
    url.searchParams.set("include_campaign_types", "1");
  }
  if (options.cursor) {
    url.searchParams.set("cursor", options.cursor);
  }
  if (options.limitProducts) {
    url.searchParams.set("limit_products", String(options.limitProducts));
  }
  if (options.deadlineMs) {
    url.searchParams.set("deadline_ms", String(options.deadlineMs));
  }
  return requestCachedJson<CatalogChartResponse>(
    url,
    options.signal,
    { retry503: true, maxAttempts: 3, retryDelayMs: 900 },
    {
      namespace: "catalog-chart",
      bypassRead: options.forceRefresh,
    },
  );
}

export async function fetchCatalogProductDetails(options: {
  productRefs: string[];
  start?: string | null;
  end?: string | null;
  forceRefresh?: boolean;
  includeCampaignDetails?: boolean;
  includeBestTime?: boolean;
  signal?: AbortSignal;
}) {
  const url = new URL("/api/catalog-product-details", window.location.origin);
  if (options.productRefs.length) {
    url.searchParams.set("products", options.productRefs.join(","));
  }
  appendRange(url.searchParams, options.start, options.end);
  if (options.includeCampaignDetails === false) {
    url.searchParams.set("campaign_details", "0");
  }
  if (options.includeBestTime === false) {
    url.searchParams.set("best_time", "0");
  }
  if (options.forceRefresh) {
    url.searchParams.set("refresh", "1");
  }
  const response = await requestCachedJson<CatalogProductDetailsResponse>(
    url,
    options.signal,
    { retry503: true, maxAttempts: 3, retryDelayMs: 900 },
    {
      namespace: "catalog-product-details",
      bypassRead: options.forceRefresh,
    },
  );
  await mergeCatalogProductDetailsIntoFullCache(url, response);
  return response;
}

export async function fetchCatalogIssues(options: {
  productRefs: string[];
  start?: string | null;
  end?: string | null;
  forceRefresh?: boolean;
  cursor?: string | null;
  limitProducts?: number | null;
  deadlineMs?: number | null;
  signal?: AbortSignal;
}) {
  const url = new URL("/api/catalog-issues", window.location.origin);
  if (options.productRefs.length) {
    url.searchParams.set("products", options.productRefs.join(","));
  }
  appendRange(url.searchParams, options.start, options.end);
  if (options.cursor) {
    url.searchParams.set("cursor", options.cursor);
  }
  if (options.limitProducts) {
    url.searchParams.set("limit_products", String(options.limitProducts));
  }
  if (options.deadlineMs) {
    url.searchParams.set("deadline_ms", String(options.deadlineMs));
  }
  return requestCachedJson<CatalogIssuesResponse>(
    url,
    options.signal,
    { retry503: true, maxAttempts: 3, retryDelayMs: 900 },
    {
      namespace: "catalog-issues",
      bypassRead: options.forceRefresh,
    },
  );
}

export async function fetchClusterDetail(options: {
  shopId: number;
  productId: number;
  campaignId: number;
  normqueryId: number;
  start?: string | null;
  end?: string | null;
  signal?: AbortSignal;
}) {
  const url = new URL("/api/cluster-detail", window.location.origin);
  url.searchParams.set("shop_id", String(options.shopId));
  url.searchParams.set("product_id", String(options.productId));
  url.searchParams.set("campaign_id", String(options.campaignId));
  url.searchParams.set("normquery_id", String(options.normqueryId));
  appendRange(url.searchParams, options.start, options.end);
  return requestJson<ClusterDetailResponse>(url.toString(), options.signal);
}

export async function sendAiChatMessage(options: {
  message: string;
  history?: AiChatMessage[];
  article?: string | null;
  start?: string | null;
  end?: string | null;
  refresh?: boolean;
  signal?: AbortSignal;
}) {
  const response = await fetch(new URL("/api/ai/chat", window.location.origin).toString(), {
    method: "POST",
    signal: options.signal,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: options.message,
      history: options.history || [],
      article: options.article || undefined,
      start: options.start || undefined,
      end: options.end || undefined,
      refresh: options.refresh || undefined,
    }),
  });
  const text = await response.text();
  let payload: AiChatResponse & { error?: string };
  try {
    payload = text ? JSON.parse(text) : ({ ok: false, error: "Empty response" } as AiChatResponse & { error?: string });
  } catch {
    payload = { ok: false, error: text || response.statusText } as AiChatResponse & { error?: string };
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || text || response.statusText);
  }
  return payload;
}
