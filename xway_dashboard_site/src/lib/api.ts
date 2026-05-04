import type { CatalogChartResponse, CatalogIssuesResponse, CatalogResponse, ClusterDetailResponse, ProductsResponse } from "./types";

export const DEFAULT_ARTICLES = ["44392513", "60149847"];

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
}) {
  const url = new URL("/api/catalog", buildBaseUrl(options.request));
  url.searchParams.set("mode", "compact");
  if (options.productRefs?.length) {
    url.searchParams.set("products", options.productRefs.join(","));
  }
  appendRange(url.searchParams, options.start, options.end);
  if (options.forceRefresh) {
    url.searchParams.set("refresh", "1");
  }
  return requestJson<CatalogResponse>(url.toString(), options.signal ?? options.request?.signal);
}

export async function fetchCatalogChart(options: {
  productRefs: string[];
  start?: string | null;
  end?: string | null;
  includeCampaignTypes?: boolean;
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
  return requestJson<CatalogChartResponse>(url.toString(), options.signal);
}

export async function fetchCatalogIssues(options: {
  productRefs: string[];
  start?: string | null;
  end?: string | null;
  signal?: AbortSignal;
}) {
  const url = new URL("/api/catalog-issues", window.location.origin);
  if (options.productRefs.length) {
    url.searchParams.set("products", options.productRefs.join(","));
  }
  appendRange(url.searchParams, options.start, options.end);
  return requestJson<CatalogIssuesResponse>(url.toString(), options.signal);
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
