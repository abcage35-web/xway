import { collectCatalogChart } from "../catalog.js";
import { collectCatalogIssues } from "../catalog-issues.js";
import { collectProducts } from "../products.js";
import { asFloat, iterIsoDays } from "../utils.js";
import { buildAiContextPayload } from "./context.js";
import { collectMpvibeArticle } from "./mpvibe-client.js";
import { collectWbPublicFeedbacks } from "./wb-public.js";

const AI_RECOMMENDATION_CACHE_VERSION = "v1";

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

function firstProduct(productsPayload) {
  return Array.isArray(productsPayload?.products) && productsPayload.products.length ? productsPayload.products[0] : null;
}

function productRefForProduct(product) {
  const shopId = product?.shop?.id;
  const productId = product?.product_id;
  return shopId !== null && shopId !== undefined && productId !== null && productId !== undefined ? `${shopId}:${productId}` : null;
}

function pickProductFields(product) {
  if (!product) {
    return null;
  }
  return {
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
    campaigns: (product.campaigns || []).map((campaign) => ({
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
    })),
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
    required_reasoning_layers: [
      "plan_vs_fact",
      "monthly_plan_vs_forecast",
      "price_spp_dynamics",
      "campaign_type_efficiency",
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
    ],
  };
}

function aiCacheBinding(env) {
  const binding = env.XWAY_AI_CACHE;
  return binding && typeof binding.get === "function" && typeof binding.put === "function" ? binding : null;
}

function aiCacheKey(article, range) {
  return `${AI_RECOMMENDATION_CACHE_VERSION}:recommendation-data:${article}:${range.start}:${range.end}`;
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
  const includeXwayCharts = requestBody.include_xway_charts === true;
  const includeXwayIssues = requestBody.include_xway_issues === true;
  const cache = aiCacheBinding(context.env);
  const cacheKey = aiCacheKey(article, range);

  if (cache && !forceRefresh) {
    const cached = await cache.get(cacheKey, "json");
    if (cached) {
      return {
        ...cached,
        cache: {
          hit: true,
          key: cacheKey,
          refreshed: false,
        },
      };
    }
  }

  const xwayProductResult = await safeSource("xway_products", () =>
    collectProducts(context.env, {
      articles: [article],
      start: range.start,
      end: range.end,
      campaignMode: "summary",
      forceRefresh,
    }),
  );
  const product = firstProduct(xwayProductResult[0]);
  const productRef = productRefForProduct(product);

  const chartCalls = productRef && includeXwayCharts
    ? {
        xway_chart_30d: safeSource("xway_chart_30d", () =>
          collectCatalogChart(context.env, {
            productRefs: [productRef],
            start: range.start,
            end: range.end,
            includeCampaignTypes: true,
            forceRefresh,
          }),
        ),
        xway_chart_7d: safeSource("xway_chart_7d", () =>
          collectCatalogChart(context.env, {
            productRefs: [productRef],
            start: last7Range.start,
            end: last7Range.end,
            includeCampaignTypes: true,
            forceRefresh,
          }),
        ),
        xway_chart_previous_7d: safeSource("xway_chart_previous_7d", () =>
          collectCatalogChart(context.env, {
            productRefs: [productRef],
            start: previous7Range.start,
            end: previous7Range.end,
            includeCampaignTypes: true,
            forceRefresh,
          }),
        ),
      }
    : {};
  const issueCalls = productRef && includeXwayIssues
    ? {
        xway_issues: safeSource("xway_issues", () =>
          collectCatalogIssues(context.env, {
            productRefs: [productRef],
            start: last7Range.start,
            end: last7Range.end,
            forceRefresh,
          }),
        ),
      }
    : {};

  const settled = await Promise.all([
    ...Object.entries(chartCalls).map(async ([key, promise]) => [key, await promise]),
    ...Object.entries(issueCalls).map(async ([key, promise]) => [key, await promise]),
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
    refresh: forceRefresh,
    sources: buildSourceMap(results),
    xway: {
      product: pickProductFields(product),
      not_found: xwayProductResult[0]?.not_found || [],
      campaign_type_totals_from_product: summarizeProductCampaignTypes(product),
      chart_30d: summarizeChart(xwayChart30),
      chart_7d: summarizeChart(xwayChart7),
      chart_previous_7d: summarizeChart(xwayChartPrevious7),
      issues: summarizeIssues(results.xway_issues?.[0] || null),
    },
    mpvibe,
    mpvibe_signals: collectMpvibeSignals(mpvibe),
    wb_public: results.wb_public?.[0] || null,
    recommendation_context: buildAiContextPayload(),
    analysis_contract: buildAnalysisContract(),
    cache: {
      hit: false,
      key: cache ? cacheKey : null,
      refreshed: forceRefresh,
    },
  };

  if (cache) {
    await cache.put(cacheKey, JSON.stringify(payload));
  }

  return payload;
}
