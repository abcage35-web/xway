import { asFloat, iterIsoDays } from "../utils.js";
import { readSharedCache, writeSharedCache } from "../shared-cache.js";
import { buildAiContextPayload } from "./context.js";
import { collectMpvibeArticle } from "./mpvibe-client.js";
import { collectWbPublicFeedbacks } from "./wb-public.js";
import {
  collectAiCampaignBidHistory,
  collectAiCampaignBudgetHistory,
  collectAiCampaignLimits,
  collectAiCampaignSchedules,
  collectAiCampaignStatusHistory,
} from "./campaign-details.js";

const AI_RECOMMENDATION_CACHE_VERSION = "v2";
const AI_RECOMMENDATION_D1_NAMESPACE = "ai-recommendation-data";

function parseIsoDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, amount) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function resolveRequestRange(start, end) {
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const endDate = parseIsoDate(end) || todayUtc;
  const startDate = parseIsoDate(start) || addDays(endDate, -29);
  if (startDate.getTime() > endDate.getTime()) {
    throw new Error("start date must not be after end date");
  }
  return {
    start: isoDate(startDate),
    end: isoDate(endDate),
  };
}

function resolveLastDaysRange(end, days) {
  const endDate = parseIsoDate(end);
  return {
    start: isoDate(addDays(endDate, -(days - 1))),
    end,
  };
}

async function readJsonRequest(request) {
  if (request.method === "GET" || request.method === "HEAD") {
    return {};
  }
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

async function safeSource(name, fn) {
  try {
    const payload = await fn();
    return [payload, { available: Boolean(payload?.available ?? true), error: payload?.error || null }];
  } catch (error) {
    return [
      null,
      {
        available: false,
        error: error instanceof Error ? error.message : String(error),
        source: name,
      },
    ];
  }
}

async function fetchSelfJson(context, pathname, params = {}) {
  const url = new URL(pathname, context.request.url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url.toString(), {
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || text || `Self API request failed (${response.status})`);
  }
  return payload;
}

function buildPostContext(context, body) {
  return {
    ...context,
    request: new Request(context.request.url, {
      method: "POST",
      headers: context.request.headers,
      body: JSON.stringify(body),
    }),
  };
}

function firstProduct(productsPayload) {
  return Array.isArray(productsPayload?.products) && productsPayload.products.length ? productsPayload.products[0] : null;
}

function productRefForProduct(product) {
  const shopId = product?.shop?.id;
  const productId = product?.product_id;
  return shopId !== null && shopId !== undefined && productId !== null && productId !== undefined ? `${shopId}:${productId}` : null;
}

function pickCampaignSummaryFields(campaign) {
  return {
    id: campaign.id,
    wb_id: campaign.wb_id,
    name: campaign.name,
    query_main: campaign.query_main,
    status: campaign.status,
    status_xway: campaign.status_xway,
    auction_mode: campaign.auction_mode,
    auto_type: campaign.auto_type,
    payment_type: campaign.payment_type,
    unified: campaign.unified,
    schedule_active: campaign.schedule_active,
    budget: campaign.budget,
    bid: campaign.bid,
    min_cpm: campaign.min_cpm,
    spend: campaign.spend,
    limits_by_period: campaign.limits_by_period,
    metrics: campaign.metrics,
  };
}

function pickCampaignFullFields(campaign) {
  return {
    ...pickCampaignSummaryFields(campaign),
    created: campaign.created,
    wb_created: campaign.wb_created,
    mp_bid: campaign.mp_bid,
    mp_recom_bid: campaign.mp_recom_bid,
    min_cpm_recom: campaign.min_cpm_recom,
    budget_rule: campaign.budget_rule,
    budget_deposit_status: campaign.budget_deposit_status,
    budget_deposit_error: campaign.budget_deposit_error,
    pause_reasons: campaign.pause_reasons,
    _heavy_loaded: Boolean(campaign._heavy_loaded),
    daily_exact: campaign.daily_exact || [],
    spend_limits: campaign.spend_limits || {},
    schedule_config: campaign.schedule_config || {},
    schedule_error: campaign.schedule_error || null,
    bid_history: campaign.bid_history || [],
    bid_history_error: campaign.bid_history_error || null,
    budget_history: campaign.budget_history || [],
    budget_history_error: campaign.budget_history_error || null,
    budget_rule_config: campaign.budget_rule_config || {},
    status_logs: campaign.status_logs || null,
    clusters: campaign.clusters || null,
    cluster_action_history: campaign.cluster_action_history || [],
    cluster_errors: campaign.cluster_errors || {},
  };
}

function pickProductFields(product, { detailLevel = "full" } = {}) {
  if (!product) {
    return null;
  }
  const full = detailLevel === "full";
  const picked = {
    detail_level: detailLevel,
    full_campaign_details: full,
    article: product.article,
    product_ref: productRefForProduct(product),
    product_id: product.product_id,
    product_url: product.product_url,
    shop: product.shop,
    identity: product.identity,
    flags: product.flags,
    stock: product.stock,
    range_metrics: product.range_metrics,
    daily_totals: product.daily_totals,
    catalog_campaign_states: product.catalog_campaign_states,
    schedule_aggregate: product.schedule_aggregate,
    campaigns: (product.campaigns || []).map((campaign) => (full ? pickCampaignFullFields(campaign) : pickCampaignSummaryFields(campaign))),
    daily_stats: (product.daily_stats || []).map((row) => ({
      day: row.day,
      views: row.views,
      clicks: row.clicks,
      atbs: row.atbs,
      orders: row.orders,
      ordered_total: row.ordered_total,
      expense_sum: row.expense_sum,
      sum_price: row.sum_price,
      ordered_sum_total: row.ordered_sum_total,
      CTR: row.CTR,
      CPC: row.CPC,
      CR: row.CR,
      DRR: row.DRR,
      CPO: row.CPO,
    })),
  };

  if (full) {
    picked.operations = product.operations;
    picked.comparison = product.comparison;
    picked.stata_totals = product.stata_totals;
    picked.heatmap = product.heatmap;
    picked.orders_heatmap = product.orders_heatmap;
    picked.article_sheet = product.article_sheet;
    picked.bid_log = product.bid_log || [];
    picked.cluster_action_log = product.cluster_action_log || [];
    picked.errors = product.errors || {};
  }

  return picked;
}

function campaignTypeForCampaign(campaign) {
  const text = [
    campaign?.payment_type,
    campaign?.name,
    campaign?.auction_mode,
    campaign?.auto_type,
    campaign?.query_main,
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  if (/cpc|click|клик/.test(text)) {
    return "cpc";
  }
  if (campaign?.unified || /unified|auto|единая/.test(text)) {
    return "cpm-unified";
  }
  return "cpm-manual";
}

function rate(numerator, denominator) {
  return denominator ? (numerator / denominator) * 100 : null;
}

function enrichCampaignTypeMetrics(metrics) {
  const views = asFloat(metrics?.views);
  const clicks = asFloat(metrics?.clicks);
  const atbs = asFloat(metrics?.atbs);
  const orders = asFloat(metrics?.orders);
  const spend = asFloat(metrics?.spend);
  const revenue = asFloat(metrics?.revenue);
  return {
    views,
    clicks,
    atbs,
    orders,
    spend,
    revenue,
    ctr: rate(clicks, views),
    cr: rate(orders, clicks),
    cpc: clicks ? spend / clicks : null,
    cpo: orders ? spend / orders : null,
    drr: rate(spend, revenue),
  };
}

function summarizeChart(chart) {
  if (!chart) {
    return null;
  }
  const campaignTypes = {};
  for (const [key, metrics] of Object.entries(chart.totals?.metrics_by_campaign_type || {})) {
    const enriched = enrichCampaignTypeMetrics(metrics);
    if (enriched.views || enriched.clicks || enriched.orders || enriched.spend || enriched.revenue) {
      campaignTypes[key] = enriched;
    }
  }
  return {
    generated_at: chart.generated_at,
    range: chart.range,
    selection_count: chart.selection_count,
    loaded_products_count: chart.loaded_products_count,
    totals: chart.totals,
    campaign_type_meta: chart.campaign_type_meta,
    campaign_type_totals: campaignTypes,
    rows: chart.rows,
    errors: chart.errors,
  };
}

function summarizeProductCampaignTypes(product) {
  const totals = {};
  for (const campaign of product?.campaigns || []) {
    const key = campaignTypeForCampaign(campaign);
    const metrics = campaign.metrics || {};
    const target = totals[key] || {
      views: 0,
      clicks: 0,
      atbs: 0,
      orders: 0,
      spend: 0,
      revenue: 0,
    };
    target.views += asFloat(metrics.views);
    target.clicks += asFloat(metrics.clicks);
    target.atbs += asFloat(metrics.atbs);
    target.orders += asFloat(metrics.orders);
    target.spend += asFloat(metrics.sum);
    target.revenue += asFloat(metrics.sum_price);
    totals[key] = target;
  }
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, enrichCampaignTypeMetrics(value)]));
}

function summarizeIssues(issues) {
  if (!issues) {
    return null;
  }
  return {
    generated_at: issues.generated_at,
    range: issues.range,
    requested_products: issues.requested_products,
    loaded_products_count: issues.loaded_products_count,
    rows: issues.rows,
  };
}

function summarizeFocusedCampaignPayload(payload) {
  if (!payload) {
    return null;
  }
  return {
    generated_at: payload.generated_at,
    kind: payload.kind,
    range: payload.range,
    article: payload.article,
    product_ref: payload.product_ref,
    campaign_count: payload.campaign_count,
    not_found_campaign_ids: payload.not_found_campaign_ids || [],
    campaigns: payload.campaigns || [],
  };
}

function buildSourceMap(results) {
  return Object.fromEntries(
    Object.entries(results).map(([name, [, meta]]) => [
      name,
      {
        available: Boolean(meta.available),
        error: meta.error || null,
      },
    ]),
  );
}

function buildAnalysisContract() {
  return {
    output_language: "ru",
    recommended_request: {
      detail_level: "full",
      use_focused_campaign_methods_first: true,
      product_heavy_details_only_when_explicit: true,
      use_summary_only_for: "fast aggregate checks; focused campaign methods provide schedules, limits, budget top-ups, bids and status logs without loading full product cluster payload",
    },
    required_reasoning_layers: [
      "plan_vs_fact",
      "monthly_plan_vs_forecast",
      "price_spp_dynamics",
      "campaign_type_efficiency",
      "manual_campaign_cluster_detail",
      "margin_wb_ds_percent",
      "inventory_unlocking",
      "wb_reviews_quality_risks",
    ],
    rules: [
      "Do not use ordinary margin_percent as the main stop signal; use margin_wb_ds_percent from MPVibe.",
      "Do not recommend CPC actions if CPC campaign data is absent.",
      "If plan is already fulfilled, prefer reducing inefficient advertising pressure over buying extra volume.",
      "If sales rose after price_with_wallet decreased or spp changed, treat it as price elasticity, not pure ad efficiency.",
      "For expensive manual CPM, estimate order-risk from its order share, not from its spend share.",
      "When manual CPM cluster data is present, analyze fixed/excluded clusters, cluster bids, positions, daily cluster metrics and cluster action history before recommending bid changes.",
      "If manual CPM clusters are missing in the payload, first use focused campaign schedules, limits, budget history, bid history and status history; do not invent phrase-level recommendations.",
    ],
  };
}

function aiCacheBinding(env) {
  const binding = env.XWAY_AI_CACHE;
  return binding && typeof binding.get === "function" && typeof binding.put === "function" ? binding : null;
}

function normalizeCampaignIds(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  return [
    ...new Set(
      source
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ),
  ];
}

function resolveDetailLevel(requestBody) {
  const requested = String(requestBody.detail_level || "").trim().toLowerCase();
  if (requested === "full") {
    return "full";
  }
  return "summary";
}

function resolveOptionalFullDefault(value, detailLevel) {
  if (value === false) {
    return false;
  }
  if (value === true) {
    return true;
  }
  return detailLevel === "full";
}

function aiCacheKey(article, range, options = {}) {
  const parts = [
    AI_RECOMMENDATION_CACHE_VERSION,
    "recommendation-data",
    article,
    range.start,
    range.end,
    `detail=${options.detailLevel || "full"}`,
    `campaigns=${(options.campaignIds || []).slice().sort().join(",")}`,
    `charts=${options.includeXwayCharts ? "1" : "0"}`,
    `issues=${options.includeXwayIssues ? "1" : "0"}`,
    `focused=${options.includeFocusedCampaigns ? "1" : "0"}`,
    `product_heavy=${options.includeProductHeavyDetails ? "1" : "0"}`,
  ];
  return parts.join(":");
}

function collectMpvibeSignals(mpvibe) {
  const daily = Array.isArray(mpvibe?.daily) ? mpvibe.daily : [];
  return {
    plan: mpvibe?.plan || null,
    best_margin_wb_ds_days: daily
      .filter((row) => typeof row.margin_wb_ds_percent === "number")
      .sort((left, right) => Number(right.margin_wb_ds_percent) - Number(left.margin_wb_ds_percent))
      .slice(0, 5)
      .map((row) => ({
        date: row.date,
        margin_wb_ds_percent: row.margin_wb_ds_percent,
        revenue: row.revenue,
        adv_spent: row.adv_spent,
        drr: row.drr,
        price_mp: row.price_mp,
        price_with_wallet: row.price_with_wallet,
        spp: row.spp,
        adv_order_count: row.adv_order_count,
      })),
    worst_drr_days: daily
      .filter((row) => typeof row.drr === "number")
      .sort((left, right) => Number(right.drr) - Number(left.drr))
      .slice(0, 5)
      .map((row) => ({
        date: row.date,
        drr: row.drr,
        margin_wb_ds_percent: row.margin_wb_ds_percent,
        revenue: row.revenue,
        adv_spent: row.adv_spent,
        price_with_wallet: row.price_with_wallet,
        spp: row.spp,
      })),
  };
}

export async function collectAiRecommendationData(context, { refreshOverride = false } = {}) {
  const requestBody = await readJsonRequest(context.request);
  const article = String(requestBody.article || "").trim();
  if (!article) {
    throw new Error("article is required");
  }

  const range = resolveRequestRange(requestBody.start, requestBody.end);
  const last7Range = resolveLastDaysRange(range.end, 7);
  const previous7Range = {
    start: isoDate(addDays(parseIsoDate(last7Range.start), -7)),
    end: isoDate(addDays(parseIsoDate(last7Range.start), -1)),
  };
  const forceRefresh = Boolean(refreshOverride || requestBody.refresh);
  const requestedDetailLevel = resolveDetailLevel(requestBody);
  const campaignIds = normalizeCampaignIds(requestBody.campaign_ids);
  const includeCampaignDetails = requestedDetailLevel === "full" || refreshOverride || requestBody.include_campaign_details === true || campaignIds.length > 0;
  const detailLevel = includeCampaignDetails ? "full" : "summary";
  const includeProductHeavyDetails = requestBody.include_product_heavy_details === true || String(requestBody.product_campaign_mode || "").toLowerCase() === "full";
  const productCampaignMode = includeProductHeavyDetails && includeCampaignDetails && campaignIds.length === 0 ? "full" : "summary";
  const productHeavyCampaignIds = includeProductHeavyDetails && includeCampaignDetails && campaignIds.length ? campaignIds : [];
  const includeXwayCharts = resolveOptionalFullDefault(requestBody.include_xway_charts, detailLevel);
  const includeXwayIssues = resolveOptionalFullDefault(requestBody.include_xway_issues, detailLevel);
  const cache = aiCacheBinding(context.env);
  const cacheKey = aiCacheKey(article, range, {
    detailLevel,
    campaignIds,
    includeXwayCharts,
    includeXwayIssues,
    includeFocusedCampaigns: includeCampaignDetails,
    includeProductHeavyDetails,
  });

  if (!forceRefresh) {
    const d1Cached = await readSharedCache(context.env, AI_RECOMMENDATION_D1_NAMESPACE, cacheKey);
    if (d1Cached) {
      return {
        ...d1Cached,
        cache: {
          hit: true,
          key: cacheKey,
          source: "d1",
          refreshed: false,
        },
      };
    }

    if (cache) {
      const cached = await cache.get(cacheKey, "json");
      if (cached) {
        await writeSharedCache(context.env, AI_RECOMMENDATION_D1_NAMESPACE, cacheKey, cached);
        return {
          ...cached,
          cache: {
            hit: true,
            key: cacheKey,
            source: "kv",
            refreshed: false,
          },
        };
      }
    }
  }

  const xwayProductResult = await safeSource("xway_products", () =>
    fetchSelfJson(context, "/api/products", {
      articles: article,
      start: range.start,
      end: range.end,
      campaign_mode: productCampaignMode,
      heavy_campaign_ids: productHeavyCampaignIds.length ? productHeavyCampaignIds.join(",") : "",
      force_refresh: forceRefresh ? "1" : "",
    }),
  );
  const product = firstProduct(xwayProductResult[0]);
  const productRef = productRefForProduct(product);
  const focusedCampaignBody = {
    article,
    start: range.start,
    end: range.end,
    refresh: false,
    campaign_ids: campaignIds,
  };

  const chartCalls = productRef && includeXwayCharts
    ? {
        xway_chart_30d: safeSource("xway_chart_30d", () =>
          fetchSelfJson(context, "/api/catalog-chart", {
            products: productRef,
            start: range.start,
            end: range.end,
            include_campaign_types: "1",
            force_refresh: forceRefresh ? "1" : "",
          }),
        ),
        xway_chart_7d: safeSource("xway_chart_7d", () =>
          fetchSelfJson(context, "/api/catalog-chart", {
            products: productRef,
            start: last7Range.start,
            end: last7Range.end,
            include_campaign_types: "1",
            force_refresh: forceRefresh ? "1" : "",
          }),
        ),
        xway_chart_previous_7d: safeSource("xway_chart_previous_7d", () =>
          fetchSelfJson(context, "/api/catalog-chart", {
            products: productRef,
            start: previous7Range.start,
            end: previous7Range.end,
            include_campaign_types: "1",
            force_refresh: forceRefresh ? "1" : "",
          }),
        ),
      }
    : {};
  const issueCalls = productRef && includeXwayIssues
    ? {
        xway_issues: safeSource("xway_issues", () =>
          fetchSelfJson(context, "/api/catalog-issues", {
            products: productRef,
            start: last7Range.start,
            end: last7Range.end,
            force_refresh: forceRefresh ? "1" : "",
          }),
        ),
      }
    : {};
  const focusedCampaignCalls = includeCampaignDetails
    ? {
        xway_campaign_schedules: safeSource("xway_campaign_schedules", () =>
          collectAiCampaignSchedules(buildPostContext(context, focusedCampaignBody)),
        ),
        xway_campaign_limits: safeSource("xway_campaign_limits", () =>
          collectAiCampaignLimits(buildPostContext(context, focusedCampaignBody)),
        ),
        xway_campaign_budget_history: safeSource("xway_campaign_budget_history", () =>
          collectAiCampaignBudgetHistory(buildPostContext(context, focusedCampaignBody)),
        ),
        xway_campaign_bid_history: safeSource("xway_campaign_bid_history", () =>
          collectAiCampaignBidHistory(buildPostContext(context, focusedCampaignBody)),
        ),
        xway_campaign_status_history: safeSource("xway_campaign_status_history", () =>
          collectAiCampaignStatusHistory(buildPostContext(context, { ...focusedCampaignBody, limit: 60 })),
        ),
      }
    : {};

  const settled = await Promise.all([
    ...Object.entries(chartCalls).map(async ([key, promise]) => [key, await promise]),
    ...Object.entries(issueCalls).map(async ([key, promise]) => [key, await promise]),
    ...Object.entries(focusedCampaignCalls).map(async ([key, promise]) => [key, await promise]),
    safeSource("mpvibe", () => collectMpvibeArticle(context.env, { article, start: last7Range.start, end: last7Range.end })).then((value) => ["mpvibe", value]),
    safeSource("wb_public", () => collectWbPublicFeedbacks(context.env, { article, end: range.end, days: 30 })).then((value) => ["wb_public", value]),
  ]);
  const results = {
    xway_products: xwayProductResult,
    ...Object.fromEntries(settled),
  };

  const xwayChart30 = results.xway_chart_30d?.[0] || null;
  const xwayChart7 = results.xway_chart_7d?.[0] || null;
  const xwayChartPrevious7 = results.xway_chart_previous_7d?.[0] || null;
  const mpvibe = results.mpvibe?.[0] || null;

  const payload = {
    ok: true,
    generated_at: new Date().toISOString(),
    article,
    range: {
      requested: range,
      last_7_days: last7Range,
      previous_7_days: previous7Range,
      days: iterIsoDays(range.start, range.end).length,
    },
    detail: {
      level: detailLevel,
      xway_campaign_mode: productCampaignMode,
      campaign_ids: campaignIds,
      focused_campaign_details_requested: includeCampaignDetails,
      product_heavy_details_requested: includeProductHeavyDetails,
      include_xway_charts: includeXwayCharts,
      include_xway_issues: includeXwayIssues,
    },
    refresh: forceRefresh,
    sources: buildSourceMap(results),
    xway: {
      product: pickProductFields(product, { detailLevel }),
      not_found: xwayProductResult[0]?.not_found || [],
      campaign_type_totals_from_product: summarizeProductCampaignTypes(product),
      chart_30d: summarizeChart(xwayChart30),
      chart_7d: summarizeChart(xwayChart7),
      chart_previous_7d: summarizeChart(xwayChartPrevious7),
      issues: summarizeIssues(results.xway_issues?.[0] || null),
      focused_campaigns: includeCampaignDetails
        ? {
            schedules: summarizeFocusedCampaignPayload(results.xway_campaign_schedules?.[0] || null),
            limits: summarizeFocusedCampaignPayload(results.xway_campaign_limits?.[0] || null),
            budget_history: summarizeFocusedCampaignPayload(results.xway_campaign_budget_history?.[0] || null),
            bid_history: summarizeFocusedCampaignPayload(results.xway_campaign_bid_history?.[0] || null),
            status_history: summarizeFocusedCampaignPayload(results.xway_campaign_status_history?.[0] || null),
          }
        : null,
    },
    mpvibe,
    mpvibe_signals: collectMpvibeSignals(mpvibe),
    wb_public: results.wb_public?.[0] || null,
    recommendation_context: buildAiContextPayload(),
    analysis_contract: buildAnalysisContract(),
    cache: {
      hit: false,
      key: cacheKey,
      source: null,
      refreshed: forceRefresh,
    },
  };

  await writeSharedCache(context.env, AI_RECOMMENDATION_D1_NAMESPACE, cacheKey, payload);

  if (cache) {
    await cache.put(cacheKey, JSON.stringify(payload));
  }

  return payload;
}
