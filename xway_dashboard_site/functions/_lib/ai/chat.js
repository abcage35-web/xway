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

function compactCampaign(campaign) {
  const metrics = campaign?.metrics || {};
  return {
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
    errors: payload?.errors,
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
    sourcePayload = await collectAiAdMetrics(
      buildChildContext(context, {
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
      }),
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
