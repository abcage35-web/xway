import { collectAiAdMetrics } from "./ad-metrics.js";
import { buildAiContextPayload } from "./context.js";
import { collectAiRecommendationData } from "./recommendation-data.js";

const ARTICLE_RE = /\b\d{6,12}\b/;
const DATE_RE = /\b20\d{2}-\d{2}-\d{2}\b/g;

async function readJsonRequest(request) {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

function pickText(value, maxLength = 280) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function extractArticle(message, requestBody) {
  const explicit = String(requestBody.article || requestBody.context?.article || "").trim();
  if (explicit) {
    return explicit;
  }
  return String(message || "").match(ARTICLE_RE)?.[0] || null;
}

function extractRange(message, requestBody) {
  const dates = String(message || "").match(DATE_RE) || [];
  return {
    start: requestBody.start || requestBody.context?.start || dates[0] || null,
    end: requestBody.end || requestBody.context?.end || dates[1] || null,
  };
}

function wantsFullArticleData(message, requestBody) {
  if (requestBody.detail_level === "full") {
    return true;
  }
  const text = String(message || "").toLowerCase();
  return /кластер|фраз|ставк|бид|bid|cpm|cpc|статус|пауз|бюджет|распис|подроб|глубок/.test(text);
}

function buildChildContext(context, body) {
  return {
    ...context,
    request: new Request(context.request.url, {
      method: "POST",
      headers: context.request.headers,
      body: JSON.stringify(body),
    }),
  };
}

function compactNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : null;
}

function metricBucket() {
  return {
    views: 0,
    clicks: 0,
    atbs: 0,
    orders: 0,
    ordered_total: 0,
    expense_sum: 0,
    sum_price: 0,
    ordered_sum_total: 0,
    spent_sku_count: 0,
  };
}

function addMetricBucket(target, source = {}) {
  target.views += Number(source.views || 0);
  target.clicks += Number(source.clicks || 0);
  target.atbs += Number(source.atbs || 0);
  target.orders += Number(source.orders || 0);
  target.ordered_total += Number(source.ordered_total || 0);
  target.expense_sum += Number(source.expense_sum || 0);
  target.sum_price += Number(source.sum_price || 0);
  target.ordered_sum_total += Number(source.ordered_sum_total || 0);
  target.spent_sku_count += Number(source.spent_sku_count || 0);
}

function finalizeMetricBucket(metrics) {
  return {
    ...metrics,
    ctr: metrics.views ? (metrics.clicks / metrics.views) * 100 : null,
    cr_click_to_order: metrics.clicks ? (metrics.orders / metrics.clicks) * 100 : null,
    cr_view_to_order: metrics.views ? (metrics.orders / metrics.views) * 100 : null,
    cpc: metrics.clicks ? metrics.expense_sum / metrics.clicks : null,
    cpo: metrics.orders ? metrics.expense_sum / metrics.orders : null,
    drr_ads: metrics.sum_price ? (metrics.expense_sum / metrics.sum_price) * 100 : null,
    drr_total: metrics.ordered_sum_total ? (metrics.expense_sum / metrics.ordered_sum_total) * 100 : null,
  };
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(numeric, max));
}

function compactCluster(cluster) {
  return {
    normquery_id: cluster?.normquery_id,
    name: pickText(cluster?.name, 120),
    views: cluster?.views,
    clicks: cluster?.clicks,
    orders: cluster?.orders,
    expense: cluster?.expense,
    ctr: cluster?.ctr,
    cpc: cluster?.cpc,
    cpo: cluster?.cpo,
    cr: cluster?.cr,
    bid: cluster?.bid,
    bid_default: cluster?.bid_default,
    bid_rule_active: cluster?.bid_rule_active,
    bid_rule_target_place: cluster?.bid_rule_target_place,
    bid_rule_max_cpm: cluster?.bid_rule_max_cpm,
    fixed: cluster?.fixed,
    excluded: cluster?.excluded,
    is_main: cluster?.is_main,
    position: cluster?.position,
    position_is_promo: cluster?.position_is_promo,
    latest_date: cluster?.latest_date,
    latest_org_pos: cluster?.latest_org_pos,
    latest_promo_pos: cluster?.latest_promo_pos,
  };
}

function compactCampaignClusters(campaign, limit = 30) {
  const items = Array.isArray(campaign?.clusters?.items) ? campaign.clusters.items : [];
  const activeItems = items.filter((cluster) => !cluster?.excluded);
  return {
    available: Boolean(campaign?.clusters?.available),
    total_clusters: campaign?.clusters?.total_clusters ?? items.length,
    loaded_clusters: items.length,
    excluded: campaign?.clusters?.excluded ?? items.filter((cluster) => cluster?.excluded).length,
    fixed: campaign?.clusters?.fixed ?? items.filter((cluster) => cluster?.fixed).length,
    active_loaded: activeItems.length,
    top_active_by_views: [...activeItems]
      .sort((left, right) => Number(right?.views || 0) - Number(left?.views || 0))
      .slice(0, limit)
      .map(compactCluster),
    top_active_by_spend: [...activeItems]
      .sort((left, right) => Number(right?.expense || 0) - Number(left?.expense || 0))
      .slice(0, Math.min(limit, 15))
      .map(compactCluster),
  };
}

function compactCampaign(campaign) {
  const metrics = campaign?.metrics || {};
  const compact = {
    id: campaign?.id,
    wb_id: campaign?.wb_id,
    name: pickText(campaign?.name, 120),
    type: campaign?.payment_type,
    status: campaign?.status_xway || campaign?.status,
    bid: campaign?.bid,
    budget: campaign?.budget,
    spend_day: campaign?.spend?.DAY,
    spend_period: metrics.sum,
    views: metrics.views,
    clicks: metrics.clicks,
    orders: metrics.orders,
    revenue: metrics.sum_price,
    drr: compactNumber(metrics.sum && metrics.sum_price ? (Number(metrics.sum) / Number(metrics.sum_price)) * 100 : null),
    cpo: metrics.cpo,
    cpc: metrics.cpc,
  };
  if (campaign?.clusters?.available || campaign?._heavy_loaded) {
    compact.clusters = compactCampaignClusters(campaign);
  }
  return compact;
}

function topDailyRows(rows, metric, limit = 5, direction = "desc") {
  return [...(rows || [])]
    .filter((row) => Number.isFinite(Number(row?.[metric])))
    .sort((left, right) => {
      const delta = Number(left[metric]) - Number(right[metric]);
      return direction === "asc" ? delta : -delta;
    })
    .slice(0, limit)
    .map((row) => ({
      day: row.day,
      views: row.views,
      clicks: row.clicks,
      orders: row.orders,
      spend: row.expense_sum,
      revenue: row.sum_price,
      drr: row.DRR,
      cpo: row.CPO,
    }));
}

function compactArticlePayload(payload) {
  const product = payload?.xway?.product || {};
  const rangeMetrics = product.range_metrics || {};
  const dailyRows = product.daily_stats || [];
  const campaigns = product.campaigns || [];
  return {
    kind: "article",
    generated_at: payload?.generated_at,
    sources: payload?.sources,
    article: product.article || payload?.article,
    range: payload?.range,
    product: {
      name: product.identity?.name,
      brand: product.identity?.brand,
      category: product.identity?.category_keyword,
      stock: product.stock?.current,
      shop: product.shop?.name,
      enabled: product.flags?.enabled,
    },
    totals: {
      views: rangeMetrics.views,
      clicks: rangeMetrics.clicks,
      atbs: rangeMetrics.atbs,
      orders: rangeMetrics.orders,
      total_orders: rangeMetrics.ordered_report,
      spend: rangeMetrics.sum,
      revenue_ads: rangeMetrics.sum_price,
      revenue_total: rangeMetrics.ordered_sum_report,
      ctr: rangeMetrics.ctr,
      cr: rangeMetrics.cr,
      cpc: rangeMetrics.cpc,
      cpo: rangeMetrics.cpo,
      drr: rangeMetrics.drr,
      spend_day: rangeMetrics.spend_day,
    },
    daily: {
      rows_count: dailyRows.length,
      latest: dailyRows.slice(-7),
      top_spend_days: topDailyRows(dailyRows, "expense_sum"),
      top_orders_days: topDailyRows(dailyRows, "orders"),
      weak_orders_days: topDailyRows(dailyRows, "orders", 5, "asc"),
    },
    campaigns: campaigns.map(compactCampaign),
    campaign_type_totals: payload?.xway?.campaign_type_totals_from_product,
    charts: {
      current_7d: payload?.xway?.chart_7d,
      previous_7d: payload?.xway?.chart_previous_7d,
    },
    issues: payload?.xway?.issues,
    mpvibe_signals: payload?.mpvibe_signals,
    mpvibe: {
      available: payload?.sources?.mpvibe?.available,
      card: payload?.mpvibe?.card,
      plan: payload?.mpvibe?.plan,
      stocks: payload?.mpvibe?.stocks,
      price: payload?.mpvibe?.price,
      daily_latest: (payload?.mpvibe?.daily || []).slice(-7),
    },
    wb_public: payload?.wb_public,
  };
}

function compactAdMetricsPayload(payload) {
  return {
    kind: "ad_metrics",
    generated_at: payload?.generated_at,
    range: payload?.range,
    selection: payload?.selection,
    request: payload?.request,
    totals: payload?.totals,
    campaign_type_totals: payload?.campaign_type_totals,
    rows: (payload?.rows || []).slice(0, 120),
    row_count: payload?.row_count,
    truncated: payload?.truncated,
    retry: payload?.retry,
    load_segments: payload?.load_segments,
    errors: payload?.errors,
  };
}

function rowIdentity(row) {
  return {
    day: row?.day,
    category: row?.category,
    article: row?.article,
    product_ref: row?.product_ref,
    product_name: row?.product_name,
    shop_id: row?.shop_id,
    shop_name: row?.shop_name,
    campaign_type: row?.campaign_type,
    campaign_type_label: row?.campaign_type_label,
  };
}

function rowIdentityKey(identity) {
  return Object.entries(identity)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
}

function mergeMetricMaps(payloads, key) {
  const merged = new Map();
  for (const payload of payloads) {
    for (const [typeKey, metrics] of Object.entries(payload?.[key] || {})) {
      const target = merged.get(typeKey) || metricBucket();
      addMetricBucket(target, metrics);
      merged.set(typeKey, target);
    }
  }
  return Object.fromEntries([...merged.entries()].map(([typeKey, metrics]) => [typeKey, finalizeMetricBucket(metrics)]));
}

function mergeAdMetricsPayloads(payloads) {
  const base = payloads[0] || {};
  const groupedRows = new Map();
  const totals = metricBucket();
  let loadedProducts = 0;

  for (const payload of payloads) {
    addMetricBucket(totals, payload?.totals || {});
    loadedProducts += Number(payload?.selection?.loaded_products_count || 0);
    for (const row of payload?.rows || []) {
      const identity = rowIdentity(row);
      const key = rowIdentityKey(identity);
      const existing = groupedRows.get(key) || {
        ...identity,
        product_count: 0,
        metrics: metricBucket(),
      };
      existing.product_count += Number(row.product_count || 0);
      addMetricBucket(existing.metrics, row.metrics || {});
      groupedRows.set(key, existing);
    }
  }

  const rows = [...groupedRows.values()]
    .map((row) => ({
      ...row,
      metrics: finalizeMetricBucket(row.metrics),
    }))
    .sort((left, right) => rowIdentityKey(left).localeCompare(rowIdentityKey(right)));
  const last = payloads[payloads.length - 1] || base;
  const remaining = last?.selection?.remaining_product_refs || last?.retry?.remaining_product_refs || [];
  const matchedArticles = Number(base?.selection?.matched_articles || 0);

  return {
    ...base,
    selection: {
      ...(base.selection || {}),
      loaded_products_count: loadedProducts,
      coverage_percent: matchedArticles ? (loadedProducts / matchedArticles) * 100 : base?.selection?.coverage_percent ?? null,
      remaining_product_refs: remaining,
    },
    rows,
    row_count: rows.length,
    truncated: payloads.some((payload) => payload?.truncated),
    totals: finalizeMetricBucket(totals),
    campaign_type_totals: mergeMetricMaps(payloads, "campaign_type_totals"),
    retry: {
      complete: remaining.length === 0,
      continuation_count: Math.max(payloads.length - 1, 0),
      attempts: payloads.flatMap((payload, segment) =>
        (payload?.retry?.attempts || []).map((attempt) => ({
          ...attempt,
          segment,
        })),
      ),
      remaining_product_refs: remaining,
      recommended_next_request: last?.retry?.recommended_next_request || null,
    },
    load_segments: payloads.map((payload, index) => ({
      index,
      matched_articles: payload?.selection?.matched_articles,
      loaded_products_count: payload?.selection?.loaded_products_count,
      remaining_count: (payload?.selection?.remaining_product_refs || []).length,
      retry_complete: payload?.retry?.complete,
    })),
    errors: payloads.flatMap((payload) => payload?.errors || []),
  };
}

function buildPrompt({ message, history, dataContext }) {
  return [
    "Вопрос сотрудника:",
    message,
    "",
    "Последние сообщения диалога:",
    JSON.stringify((history || []).slice(-8), null, 2),
    "",
    "Доступный компактный аналитический контекст:",
    JSON.stringify(dataContext, null, 2),
  ].join("\n");
}

function openAiText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const chunks = [];
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

async function callOpenAi(env, { message, history, dataContext }) {
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  const model = String(env.OPENAI_MODEL || "gpt-4.1-mini").trim();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: [
        buildAiContextPayload().context,
        "",
        "Ты встроенный ассистент XWAY Dashboard. Отвечай по-русски, коротко и по делу.",
        "Не выдумывай данные. Если нужного блока нет в compact context, явно скажи, что источник не вернул данные.",
        "Для чисел указывай период и источник. Давай конкретные действия по РК, цене, остаткам или диагностике.",
      ].join("\n"),
      input: buildPrompt({ message, history, dataContext }),
    }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message || text || `OpenAI request failed (${response.status})`);
  }
  return {
    answer: openAiText(payload) || "Не удалось сформировать ответ.",
    model,
  };
}

async function collectAdMetricsForChat(context, initialBody, requestBody) {
  const maxContinuationRounds = clampInteger(requestBody.auto_continue_rounds, 4, 0, 8);
  const payloads = [];
  let body = {
    ...initialBody,
    retry_failed: true,
    max_retry_rounds: requestBody.max_retry_rounds ?? 5,
    retry_delay_ms: requestBody.retry_delay_ms ?? 500,
    chunk_size: requestBody.chunk_size ?? 8,
  };

  for (let round = 0; round <= maxContinuationRounds; round += 1) {
    const payload = await collectAiAdMetrics(buildChildContext(context, body));
    payloads.push(payload);
    const remaining = payload?.retry?.remaining_product_refs || payload?.selection?.remaining_product_refs || [];
    if (!remaining.length || !payload?.retry?.recommended_next_request) {
      break;
    }
    body = {
      ...payload.retry.recommended_next_request,
      refresh: false,
      row_limit: initialBody.row_limit,
    };
  }

  return mergeAdMetricsPayloads(payloads);
}

export async function handleAiChat(context) {
  const requestBody = await readJsonRequest(context.request);
  const message = pickText(requestBody.message, 4000);
  if (!message) {
    throw new Error("message is required.");
  }
  const history = Array.isArray(requestBody.history) ? requestBody.history : [];
  const article = extractArticle(message, requestBody);
  const range = extractRange(message, requestBody);
  const refresh = Boolean(requestBody.refresh);

  let sourcePayload;
  let dataContext;
  if (article) {
    sourcePayload = await collectAiRecommendationData(
      buildChildContext(context, {
        article,
        start: range.start,
        end: range.end,
        refresh,
        detail_level: wantsFullArticleData(message, requestBody) ? "full" : "summary",
        include_xway_charts: true,
        include_xway_issues: true,
        campaign_ids: requestBody.campaign_ids || [],
      }),
      { refreshOverride: refresh },
    );
    dataContext = compactArticlePayload(sourcePayload);
  } else {
    sourcePayload = await collectAdMetricsForChat(
      context,
      {
        start: range.start,
        end: range.end,
        refresh,
        group_by: requestBody.group_by || ["category"],
        categories: requestBody.categories || [],
        articles: requestBody.articles || [],
        shop_ids: requestBody.shop_ids || [],
        shop_names: requestBody.shop_names || [],
        include_campaign_types: true,
        row_limit: requestBody.row_limit || 120,
      },
      requestBody,
    );
    dataContext = compactAdMetricsPayload(sourcePayload);
  }

  const ai = await callOpenAi(context.env, { message, history, dataContext });
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    answer: ai.answer,
    model: ai.model,
    mode: dataContext.kind,
    article: article || null,
    range,
    sources: dataContext.kind === "article" ? sourcePayload?.sources : { xway: { available: true } },
    context_summary: {
      kind: dataContext.kind,
      rows: dataContext.rows?.length ?? dataContext.daily?.rows_count ?? null,
      campaigns: dataContext.campaigns?.length ?? null,
      truncated: dataContext.truncated ?? false,
    },
  };
}
