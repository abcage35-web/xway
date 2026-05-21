import { mapWithConcurrency } from "../utils.js";
import { XwayApiClient } from "../xway-client.js";
import { normalizeSchedule } from "../products.js";

const DEFAULT_HISTORY_LIMIT = 120;
const MAX_HISTORY_LIMIT = 1000;
const CAMPAIGN_DETAIL_CONCURRENCY = 4;

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function parseIsoDate(value) {
  const text = asString(value);
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

function normalizeIdList(...values) {
  const ids = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      value.forEach((item) => ids.push(asString(item)));
      continue;
    }
    asString(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => ids.push(item));
  }
  return [...new Set(ids.filter(Boolean))];
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

function parseFlexibleDateTime(value) {
  const text = asString(value);
  if (!text) {
    return null;
  }
  const explicitRu = text.match(/^(\d{1,2})[.-](\d{1,2})[.-](\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (explicitRu) {
    const [, dd, mm, yyyy, hh = "0", min = "0", sec = "0"] = explicitRu;
    const parsed = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(sec)));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
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
  return null;
}

async function safeCall(fn, defaultValue) {
  try {
    return [await fn(), null];
  } catch (error) {
    return [defaultValue, error instanceof Error ? error.message : String(error)];
  }
}

function resolvePaymentType(campaign) {
  const text = [
    campaign?.payment_type,
    campaign?.name,
    campaign?.auction_mode,
    campaign?.auto_type,
    campaign?.query_main?.text,
  ]
    .map((value) => asString(value).toLowerCase())
    .join(" ");
  if (/cpc|click|клик|оплата\s+за\s+клики/.test(text)) {
    return "cpc";
  }
  return "cpm";
}

function compactCampaign(campaign) {
  return {
    id: campaign?.id ?? null,
    wb_id: campaign?.external_id ?? campaign?.wb_id ?? null,
    name: campaign?.name ?? null,
    query_main: campaign?.query_main?.text ?? campaign?.query_main ?? null,
    status: campaign?.status ?? null,
    status_xway: campaign?.status_xway ?? null,
    auction_mode: campaign?.auction_mode ?? null,
    auto_type: campaign?.auto_type ?? null,
    payment_type: resolvePaymentType(campaign),
    unified: Boolean(campaign?.unified),
    schedule_active: Boolean(campaign?.schedule_active),
    budget: campaign?.budget ?? null,
    bid: campaign?.bid ?? null,
    min_cpm: campaign?.min_cpm ?? null,
    spend: campaign?.spend || {},
    limits_by_period: campaign?.limits_by_period || {},
    budget_rule: campaign?.budget_rule || {},
    budget_deposit_status: campaign?.budget_deposit_status ?? null,
    budget_deposit_error: campaign?.budget_deposit_error ?? null,
    pause_reasons: campaign?.pause_reasons || {},
  };
}

function normalizeSpendLimits(campaign) {
  const rawLimits = campaign?.limits_by_period || {};
  const rawSpend = campaign?.spend || {};
  return {
    items: Object.entries(rawLimits).map(([period, config]) => {
      const limit = config?.limit ?? null;
      const spent = rawSpend?.[period] ?? null;
      const remaining = limit !== null && limit !== undefined && spent !== null && spent !== undefined ? Number(limit) - Number(spent) : null;
      return {
        period,
        active: Boolean(config?.active),
        limit,
        spent,
        remaining,
      };
    }),
  };
}

function normalizeBudgetHistory(rows) {
  return [...(rows || [])]
    .map((row) => {
      const parsed = parseFlexibleDateTime(row?.datetime);
      return {
        ...row,
        datetime_sort: parsed ? parsed.toISOString() : null,
      };
    })
    .sort((left, right) => asString(right.datetime_sort).localeCompare(asString(left.datetime_sort)));
}

function normalizeBidHistory(campaign, rows) {
  return [...(rows || [])]
    .map((row) => {
      const parsed = parseFlexibleDateTime(row?.datetime);
      return {
        ...row,
        campaign_id: campaign?.id ?? null,
        campaign_name: campaign?.name ?? null,
        zone: row?.recom ? "Рекомендации" : "Поиск",
        datetime_sort: parsed ? parsed.toISOString() : null,
      };
    })
    .sort((left, right) => asString(right.datetime_sort).localeCompare(asString(left.datetime_sort)));
}

function normalizeBudgetRule(campaign, budgetHistory) {
  const rule = campaign?.budget_rule || {};
  return {
    active: Boolean(rule.active),
    threshold: rule.threshold ?? null,
    deposit: rule.deposit ?? null,
    limit: rule.limit ?? null,
    limit_period: rule.limit_period ?? null,
    restart: Boolean(rule.restart),
    status: campaign?.budget_deposit_status ?? null,
    error: campaign?.budget_deposit_error ?? null,
    last_topup: budgetHistory?.[0] ?? null,
    history_count: budgetHistory?.length || 0,
  };
}

function formatHour(hour) {
  if (hour === 24) {
    return "24:00";
  }
  return `${String(((hour % 24) + 24) % 24).padStart(2, "0")}:00`;
}

function hourRanges(hours) {
  const sorted = [...new Set((hours || []).map((hour) => Number(hour)).filter(Number.isFinite))].sort((left, right) => left - right);
  if (!sorted.length) {
    return [];
  }
  const ranges = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (let index = 1; index <= sorted.length; index += 1) {
    const current = sorted[index];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    ranges.push({
      start_hour: start,
      end_hour_exclusive: previous === 23 ? 24 : previous + 1,
      label: `${formatHour(start)}-${formatHour(previous === 23 ? 24 : previous + 1)}`,
    });
    start = current;
    previous = current;
  }
  return ranges;
}

function scheduleDisplay(scheduleConfig) {
  const groupsByHours = new Map();
  for (const day of scheduleConfig?.days || []) {
    const key = JSON.stringify(day.active_hours || []);
    const group = groupsByHours.get(key) || {
      days: [],
      active_hours: day.active_hours || [],
      ranges: hourRanges(day.active_hours || []),
    };
    group.days.push(day.label || day.key);
    groupsByHours.set(key, group);
  }
  const groups = [...groupsByHours.values()].map((group) => ({
    ...group,
    label: `${group.days.join(", ")}: ${group.ranges.length ? group.ranges.map((range) => range.label).join(", ") : "нет активных часов"}`,
  }));
  return {
    groups,
    summary: groups.map((group) => group.label).join("; "),
  };
}

function productRef(shopId, productId) {
  return `${shopId}:${productId}`;
}

function campaignKeys(campaign) {
  return [campaign?.id, campaign?.external_id, campaign?.wb_id].map((value) => asString(value)).filter(Boolean);
}

async function resolveCampaignContext(context, body) {
  const range = resolveRequestRange(body.start, body.end);
  const forceRefresh = Boolean(body.refresh || body.force_refresh);
  const client = new XwayApiClient(context.env, { start: range.start, end: range.end, forceRefresh });
  const requestedCampaignIds = new Set(normalizeIdList(body.campaign_id, body.campaign_ids, body.campaigns));
  const article = asString(body.article);
  let shopId = Number.parseInt(asString(body.shop_id), 10);
  let productId = Number.parseInt(asString(body.product_id), 10);
  let match = null;

  if ((!Number.isFinite(shopId) || !Number.isFinite(productId)) && article) {
    const found = await client.findArticles([article]);
    match = found[article] || null;
    shopId = Number.parseInt(asString(match?.shop?.id), 10);
    productId = Number.parseInt(asString(match?.product?.id), 10);
  }

  if (!Number.isFinite(shopId) || !Number.isFinite(productId)) {
    throw new Error("article or shop_id + product_id is required");
  }

  const stata = await client.productStata(shopId, productId);
  const rawCampaigns = Array.isArray(stata?.campaign_wb) ? stata.campaign_wb : [];
  const campaigns = requestedCampaignIds.size
    ? rawCampaigns.filter((campaign) => campaignKeys(campaign).some((key) => requestedCampaignIds.has(key)))
    : rawCampaigns;
  const matchedCampaignIds = new Set(campaigns.flatMap(campaignKeys));
  const notFoundCampaignIds = [...requestedCampaignIds].filter((id) => !matchedCampaignIds.has(id));

  return {
    client,
    range,
    article: article || asString(match?.product?.external_id) || null,
    shop: match?.shop || null,
    product: match?.product || null,
    product_ref: productRef(shopId, productId),
    shop_id: shopId,
    product_id: productId,
    campaigns,
    not_found_campaign_ids: notFoundCampaignIds,
    stata,
  };
}

function basePayload(kind, resolved, extra = {}) {
  return {
    ok: true,
    kind,
    generated_at: new Date().toISOString(),
    range: resolved.range,
    article: resolved.article,
    product_ref: resolved.product_ref,
    shop: resolved.shop
      ? {
          id: resolved.shop.id ?? resolved.shop_id,
          name: resolved.shop.name ?? null,
        }
      : { id: resolved.shop_id, name: null },
    product: resolved.product
      ? {
          id: resolved.product.id ?? resolved.product_id,
          article: resolved.product.external_id ?? resolved.article,
          name: resolved.product.name ?? resolved.product.name_custom ?? null,
        }
      : { id: resolved.product_id, article: resolved.article, name: null },
    campaign_count: resolved.campaigns.length,
    not_found_campaign_ids: resolved.not_found_campaign_ids,
    ...extra,
  };
}

export async function collectAiCampaignSchedules(context) {
  const body = await readJsonRequest(context.request);
  const resolved = await resolveCampaignContext(context, body);
  const campaigns = await mapWithConcurrency(resolved.campaigns, CAMPAIGN_DETAIL_CONCURRENCY, async (campaign) => {
    const [schedulePayload, scheduleError] = await safeCall(
      () => resolved.client.campaignSchedule(resolved.shop_id, resolved.product_id, campaign.id),
      {},
    );
    const scheduleConfig = normalizeSchedule(schedulePayload || {});
    return {
      ...compactCampaign(campaign),
      schedule_config: scheduleConfig,
      schedule_display: scheduleDisplay(scheduleConfig),
      schedule_error: scheduleError,
    };
  });
  return basePayload("campaign_schedules", resolved, { campaigns });
}

export async function collectAiCampaignLimits(context) {
  const body = await readJsonRequest(context.request);
  const resolved = await resolveCampaignContext(context, body);
  const campaigns = resolved.campaigns.map((campaign) => {
    const budgetHistory = [];
    return {
      ...compactCampaign(campaign),
      spend_limits: normalizeSpendLimits(campaign),
      budget_rule_config: normalizeBudgetRule(campaign, budgetHistory),
    };
  });
  return basePayload("campaign_limits", resolved, {
    product_spend_limits: resolved.stata?.spend_limits || resolved.product?.spend_limits || null,
    campaigns,
  });
}

export async function collectAiCampaignBudgetHistory(context) {
  const body = await readJsonRequest(context.request);
  const resolved = await resolveCampaignContext(context, body);
  const campaigns = await mapWithConcurrency(resolved.campaigns, CAMPAIGN_DETAIL_CONCURRENCY, async (campaign) => {
    const [rows, error] = await safeCall(
      () => resolved.client.campaignBudgetHistory(resolved.shop_id, resolved.product_id, campaign.id),
      [],
    );
    const budgetHistory = normalizeBudgetHistory(rows || []);
    return {
      ...compactCampaign(campaign),
      budget_history: budgetHistory,
      budget_history_error: error,
      budget_rule_config: normalizeBudgetRule(campaign, budgetHistory),
    };
  });
  return basePayload("campaign_budget_history", resolved, { campaigns });
}

export async function collectAiCampaignBidHistory(context) {
  const body = await readJsonRequest(context.request);
  const resolved = await resolveCampaignContext(context, body);
  const campaigns = await mapWithConcurrency(resolved.campaigns, CAMPAIGN_DETAIL_CONCURRENCY, async (campaign) => {
    const [rows, error] = await safeCall(
      () => resolved.client.campaignBidHistory(resolved.shop_id, resolved.product_id, campaign.id),
      [],
    );
    return {
      ...compactCampaign(campaign),
      bid_history: normalizeBidHistory(campaign, rows || []),
      bid_history_error: error,
    };
  });
  return basePayload("campaign_bid_history", resolved, { campaigns });
}

export async function collectAiCampaignStatusHistory(context) {
  const body = await readJsonRequest(context.request);
  const resolved = await resolveCampaignContext(context, body);
  const limit = clampInteger(body.limit, DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT);
  const campaigns = await mapWithConcurrency(resolved.campaigns, CAMPAIGN_DETAIL_CONCURRENCY, async (campaign) => {
    const [mpHistory, mpError] = await safeCall(
      () => resolved.client.campaignStatusMpHistory(resolved.shop_id, resolved.product_id, campaign.id, 0, limit),
      {},
    );
    const [pauseHistory, pauseError] = await safeCall(
      () => resolved.client.campaignStatusPauseHistory(resolved.shop_id, resolved.product_id, campaign.id, limit),
      {},
    );
    return {
      ...compactCampaign(campaign),
      status_history: {
        mp: mpHistory || {},
        mp_error: mpError,
        pause: pauseHistory || {},
        pause_error: pauseError,
      },
    };
  });
  return basePayload("campaign_status_history", resolved, { limit, campaigns });
}
