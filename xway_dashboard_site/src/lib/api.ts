import type { CatalogChartResponse, CatalogIssuesResponse, CatalogResponse, ClusterDetailResponse, ProductsResponse } from "./types";

export const DEFAULT_ARTICLES = ["44392513", "60149847"];

function buildBaseUrl(request?: Request) {
  if (request) {
    return new URL(request.url).origin;
  }
  return window.location.origin;
}

async function requestJson<T>(input: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(input, { signal });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as T & { ok?: boolean; error?: string }) : ({} as T & { ok?: boolean; error?: string });
  if (!response.ok) {
    throw new Response(text || response.statusText, {
      status: response.status,
      statusText: response.statusText,
    });
  }
  if ("ok" in data && data.ok === false) {
    throw new Error(data.error || "API request failed");
  }
  return data;
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
  return requestJson<ProductsResponse>(url.toString(), options.signal ?? options.request?.signal);
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
