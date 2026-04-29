import { XwayApiClient } from "./xway-client.js";
import { normalizeCatalogCampaignStates as normalizeCatalogCampaignStatesForCatalog } from "./catalog.js";
import { asFloat, cloneValue, formatDay, mapWithConcurrency } from "./utils.js";

const WEEKDAYS = [
  ["Monday", "Пн"],
  ["Tuesday", "Вт"],
  ["Wednesday", "Ср"],
  ["Thursday", "Чт"],
  ["Friday", "Пт"],
  ["Saturday", "Сб"],
  ["Sunday", "Вс"],
];

const DAILY_SUM_FIELDS = [
  "ordered_total",
  "ordered_sum_total",
  "rel_sum_price",
  "rel_shks",
  "rel_atbs",
  "views",
  "clicks",
  "expense_sum",
  "atbs",
  "orders",
  "sum_price",
];

const PRODUCTS_CACHE_TTL_MS = 180000;
const productsCache = new Map();

const CATALOG_CAMPAIGN_FIELD_ORDER = ["unified", "manual_search", "manual_recom", "cpc"];
const CATALOG_CAMPAIGN_FIELD_META = {
  unified: { label: "Единая ставка", short_label: "Ед. CPM" },
  manual_search: { label: "Поиск", short_label: "CPM Поиск" },
  manual_recom: { label: "Рекомендации", short_label: "CPM Реком" },
  cpc: { label: "Оплата за клики", short_label: "CPC" },
};

function getCached(key) {
  const entry = productsCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.createdAt > PRODUCTS_CACHE_TTL_MS) {
    productsCache.delete(key);
    return null;
  }
  return cloneValue(entry.value);
}

function setCached(key, value) {
  productsCache.set(key, { createdAt: Date.now(), value: cloneValue(value) });
}

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

function filterDatedMapping(rows, start = null, end = null) {
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  const filtered = {};
  for (const [day, payload] of Object.entries(rows || {})) {
    const parsedDay = parseIsoDate(day);
    if (startDate && parsedDay && parsedDay.getTime() < startDate.getTime()) {
      continue;
    }
    if (endDate && parsedDay && parsedDay.getTime() > endDate.getTime()) {
      continue;
    }
    filtered[day] = payload;
  }
  return filtered;
}

function normalizeDailyStats(rows, start = null, end = null) {
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  return [...(rows || [])]
    .filter((row) => {
      const parsedDay = parseIsoDate(row?.day);
      if (startDate && parsedDay && parsedDay.getTime() < startDate.getTime()) {
        return false;
      }
      if (endDate && parsedDay && parsedDay.getTime() > endDate.getTime()) {
        return false;
      }
      return true;
    })
    .sort((left, right) => String(left?.day || "").localeCompare(String(right?.day || "")))
    .map((row) => ({
      ...row,
      day_label: formatDay(row.day),
    }));
}

function dailyTotals(rows) {
  const totals = Object.fromEntries(DAILY_SUM_FIELDS.map((field) => [field, 0]));
  for (const row of rows || []) {
    for (const field of DAILY_SUM_FIELDS) {
      const value = row?.[field];
      if (value === null || value === undefined) {
        continue;
      }
      totals[field] += Number(value);
    }
  }

  const views = totals.views;
  const clicks = totals.clicks;
  const expenseSum = totals.expense_sum;
  const orders = totals.orders;
  const orderedTotal = totals.ordered_total;
  const relShks = totals.rel_shks;
  const sumPrice = totals.sum_price;

  return {
    ...totals,
    CTR: views ? (clicks / views) * 100 : null,
    CPC: clicks ? expenseSum / clicks : null,
    CR: clicks ? (orders / clicks) * 100 : null,
    DRR: sumPrice ? (expenseSum / sumPrice) * 100 : null,
    CPO: orders ? expenseSum / orders : null,
    CPO_overall: orderedTotal ? expenseSum / orderedTotal : null,
    CPO_with_rel: orders + relShks ? expenseSum / (orders + relShks) : null,
  };
}

function normalizeSchedule(schedulePayload) {
  const payload = schedulePayload || {};
  const rawSchedule = payload.schedule || {};
  let activeSlots = 0;
  const days = WEEKDAYS.map(([dayKey, dayLabel]) => {
    const activeHours = [...new Set((rawSchedule[dayKey] || []).filter((hour) => hour !== null && hour !== undefined).map((hour) => Number(hour)).filter(Number.isFinite))].sort((left, right) => left - right);
    const activeSet = new Set(activeHours);
    return {
      key: dayKey,
      label: dayLabel,
      active_hours: activeHours,
      hours: Array.from({ length: 24 }, (_, hour) => {
        const active = activeSet.has(hour);
        if (active) {
          activeSlots += 1;
        }
        return { hour, active };
      }),
    };
  });

  return {
    schedule_active: Boolean(payload.schedule_active),
    active_slots: activeSlots,
    days,
    hours_by_day: Object.fromEntries(days.map((day) => [day.key, day.active_hours])),
  };
}

function aggregateSchedule(campaigns) {
  let activeSlots = 0;
  let maxCount = 0;
  const days = WEEKDAYS.map(([dayKey, dayLabel]) => ({
    key: dayKey,
    label: dayLabel,
    hours: Array.from({ length: 24 }, (_, hour) => {
      let count = 0;
      for (const campaign of campaigns || []) {
        const hoursByDay = campaign?.schedule_config?.hours_by_day || {};
        if ((hoursByDay[dayKey] || []).includes(hour)) {
          count += 1;
        }
      }
      if (count) {
        activeSlots += 1;
        maxCount = Math.max(maxCount, count);
      }
      return { hour, count, active: count > 0 };
    }),
  }));

  return {
    days,
    max_count: maxCount,
    active_slots: activeSlots,
  };
}

function normalizeHeatmap(raw) {
  const payload = raw || {};
  return {
    period_from: payload.period_from ?? null,
    period_to: payload.period_to ?? null,
    views: payload.views ?? null,
    clicks: payload.clicks ?? null,
    CTR: payload.CTR ?? null,
    CPC: payload.CPC ?? null,
    by_hour: Array.from({ length: 24 }, (_, hour) => {
      const entry = payload.by_hour?.[String(hour)] || {};
      return {
        hour,
        views: entry.views?.value ?? null,
        clicks: entry.clicks?.value ?? null,
        spent: entry.spent ?? null,
        CTR: entry.CTR?.value ?? null,
        CPC: entry.CPC?.value ?? null,
      };
    }),
  };
}

function normalizeOrdersHeatmap(raw) {
  const payload = raw || {};
  return {
    period_from: payload.period_from ?? null,
    period_to: payload.period_to ?? null,
    statistics_from: payload.statistics_from ?? null,
    overall_orders: payload.overall_orders ?? null,
    by_hour: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      orders: payload.by_hour?.[String(hour)]?.value ?? null,
    })),
  };
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
    .sort((left, right) => String(right.datetime_sort || "").localeCompare(String(left.datetime_sort || "")));
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
    .sort((left, right) => String(right.datetime_sort || "").localeCompare(String(left.datetime_sort || "")));
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

function normalizeSpendLimits(campaign) {
  const rawLimits = campaign?.limits_by_period || {};
  const rawSpend = campaign?.spend || {};
  const items = Object.entries(rawLimits).map(([period, config]) => {
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
  });
  return { items };
}

function normalizeProductSpendLimits(statItem, product) {
  return cloneValue(statItem?.spend_limits || product?.spend_limits || []).filter(
    (item) => item && typeof item === "object" && (item.limit !== null && item.limit !== undefined || item.active),
  );
}

function normalizeStatusMpHistory(rows) {
  return [...(rows || [])]
    .map((row) => {
      const parsed = parseFlexibleDateTime(row?.timestamp);
      return {
        ...row,
        day: parsed ? isoDate(parsed) : null,
        time: parsed ? parsed.toISOString().slice(11, 16) : null,
        timestamp_sort: parsed ? parsed.toISOString() : null,
      };
    })
    .sort((left, right) => String(right.timestamp_sort || "").localeCompare(String(left.timestamp_sort || "")));
}

function statusIntervalStateKey(item) {
  if (item?.is_freeze) {
    return "freeze";
  }
  const statusText = String(item?.status || "").toLowerCase();
  const reasonText = [...(item?.pause_reasons || []), item?.paused_limiter].map((value) => String(value || "").toLowerCase()).join(" ");
  if (/актив|active/.test(statusText)) {
    return "active";
  }
  if (/приост|pause|paused|stop|неактив|inactive/.test(statusText) || /schedule|распис|budget|бюджет|limit|лимит/.test(reasonText) || item?.paused_limiter || item?.paused_user) {
    return "paused";
  }
  return null;
}

function parseStatusDatetimeText(value, fallbackDate = null, fallbackYear = null) {
  const text = String(value || "").trim();
  if (!text) {
    return { value: null, hasExplicitDate: false };
  }

  const dateMatch = text.match(/(\d{1,2})[.-](\d{1,2})(?:[.-](\d{4}))?/);
  const timeMatch = text.match(/(\d{1,2}):(\d{2})/);

  let day = fallbackDate ? fallbackDate.getUTCDate() : null;
  let month = fallbackDate ? fallbackDate.getUTCMonth() + 1 : null;
  let year = fallbackDate ? fallbackDate.getUTCFullYear() : fallbackYear || new Date().getUTCFullYear();
  let hasExplicitDate = false;

  if (dateMatch) {
    day = Number.parseInt(dateMatch[1], 10);
    month = Number.parseInt(dateMatch[2], 10);
    year = dateMatch[3] ? Number.parseInt(dateMatch[3], 10) : year;
    hasExplicitDate = true;
  }

  if (!day || !month || !year) {
    return { value: null, hasExplicitDate };
  }

  const hours = timeMatch ? Number.parseInt(timeMatch[1], 10) : 0;
  const minutes = timeMatch ? Number.parseInt(timeMatch[2], 10) : 0;
  const parsed = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  return {
    value: Number.isNaN(parsed.getTime()) ? null : parsed,
    hasExplicitDate,
  };
}

function resolvePauseIntervalBounds(item) {
  const startResult = parseStatusDatetimeText(item?.start);
  if (!startResult.value) {
    return { startAt: null, endAt: null };
  }
  const rawEnd = String(item?.end || "").trim();
  if (!rawEnd) {
    return { startAt: startResult.value, endAt: new Date() };
  }
  const endResult = parseStatusDatetimeText(rawEnd, startResult.value, startResult.value.getUTCFullYear());
  if (!endResult.value) {
    return { startAt: startResult.value, endAt: startResult.value };
  }
  let endAt = endResult.value;
  if (!endResult.hasExplicitDate && endAt.getTime() <= startResult.value.getTime()) {
    endAt = new Date(endAt.getTime() + 86400000);
  }
  return { startAt: startResult.value, endAt };
}

function formatStatusDatetimeText(value, startAt = null) {
  if (!value) {
    return null;
  }
  if (startAt && isoDate(value) === isoDate(startAt)) {
    return value.toISOString().slice(11, 16);
  }
  const dd = String(value.getUTCDate()).padStart(2, "0");
  const mm = String(value.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = value.getUTCFullYear();
  const hh = String(value.getUTCHours()).padStart(2, "0");
  const min = String(value.getUTCMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy}, ${hh}:${min}`;
}

function joinStatusNames(...values) {
  const seen = new Set();
  const ordered = [];
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw) {
      continue;
    }
    for (const part of raw.split(",").map((chunk) => chunk.trim()).filter(Boolean)) {
      if (!seen.has(part)) {
        seen.add(part);
        ordered.push(part);
      }
    }
  }
  return ordered.length ? ordered.join(", ") : null;
}

function mergePauseIntervals(rows) {
  const merged = [];
  for (const row of rows || []) {
    const item = { ...row, pause_reasons: [...(row?.pause_reasons || [])] };
    const stateKey = statusIntervalStateKey(item);
    const { startAt, endAt } = resolvePauseIntervalBounds(item);

    if (merged.length) {
      const previous = merged[merged.length - 1];
      if (
        stateKey &&
        previous._stateKey === stateKey &&
        startAt instanceof Date &&
        endAt instanceof Date &&
        previous._startAt instanceof Date &&
        previous._endAt instanceof Date &&
        endAt.getTime() >= previous._startAt.getTime()
      ) {
        previous._startAt = new Date(Math.min(previous._startAt.getTime(), startAt.getTime()));
        previous._endAt = new Date(Math.max(previous._endAt.getTime(), endAt.getTime()));
        previous.start = formatStatusDatetimeText(previous._startAt);
        previous.end = formatStatusDatetimeText(previous._endAt, previous._startAt);
        previous.pause_reasons = [...new Set([...(previous.pause_reasons || []), ...(item.pause_reasons || [])])];
        previous.paused_user = joinStatusNames(previous.paused_user, item.paused_user);
        previous.unpaused_user = joinStatusNames(previous.unpaused_user, item.unpaused_user);
        previous.stopped_user = joinStatusNames(previous.stopped_user, item.stopped_user);
        previous.paused_limiter = joinStatusNames(previous.paused_limiter, item.paused_limiter);
        previous.is_freeze = Boolean(previous.is_freeze) || Boolean(item.is_freeze);
        previous.is_unfreeze = Boolean(previous.is_unfreeze) || Boolean(item.is_unfreeze);
        continue;
      }
    }

    item._stateKey = stateKey;
    item._startAt = startAt;
    item._endAt = endAt;
    if (startAt) {
      item.start = formatStatusDatetimeText(startAt);
    }
    if (endAt) {
      item.end = formatStatusDatetimeText(endAt, startAt);
    }
    merged.push(item);
  }

  return merged.map((item) => {
    const next = { ...item };
    delete next._stateKey;
    delete next._startAt;
    delete next._endAt;
    return next;
  });
}

function flattenPauseTooltips(payload) {
  return (payload?.tooltips || [])
    .map((item) => ({
      start: item?.startDate,
      end: item?.endDate,
      status: item?.status,
      is_freeze: Boolean(item?.isFreeze),
      is_unfreeze: Boolean(item?.isUnfreeze),
      pause_reasons: item?.pauseReasons || [],
      paused_user: item?.pausedUser,
      unpaused_user: item?.unpausedUser,
      stopped_user: item?.stopedUser,
      paused_limiter: item?.pausedLimiter,
    }))
    .filter((item) => {
      const hasFields = ["start", "end", "status", "paused_user", "unpaused_user", "stopped_user", "paused_limiter"].some((field) => item[field]);
      return hasFields || item.pause_reasons.length > 0;
    });
}

export function normalizeStatusPauseHistory(payload) {
  const intervals = flattenPauseTooltips(payload);
  return {
    labels: payload?.labels || [],
    header: payload?.header || [],
    series: payload?.series || [],
    next_page: payload?.next_page || {},
    tooltips: payload?.tooltips || [],
    intervals,
    merged_intervals: mergePauseIntervals(intervals),
  };
}

function normalizeClusterRows(statsPayload, positionsPayload, additionalPayload, start = null, end = null) {
  const rows = (statsPayload?.normqueries || []).map((normquery) => {
    const normqueryId = normquery?.normquery_id;
    const positionRaw = positionsPayload?.[String(normqueryId)];
    const daily = filterDatedMapping(additionalPayload?.[String(normqueryId)] || {}, start, end);
    const latestDate = Object.keys(daily).sort().at(-1) || null;
    const latestDaily = latestDate ? daily[latestDate] : null;
    return {
      normquery_id: normqueryId,
      name: normquery?.name ?? null,
      popularity: normquery?.popularity ?? null,
      views: normquery?.views ?? null,
      clicks: normquery?.clicks ?? null,
      atbs: normquery?.atbs ?? null,
      orders: normquery?.orders ?? null,
      shks: normquery?.shks ?? null,
      expense: normquery?.expense ?? null,
      ctr: normquery?.ctr ?? null,
      cpc: normquery?.cpc ?? null,
      cr: normquery?.cr ?? null,
      ocr: normquery?.ocr ?? null,
      cpo: normquery?.cpo ?? null,
      bid: normquery?.bid ?? null,
      bid_default: normquery?.bid_default ?? false,
      bid_rule_active: normquery?.bid_rule_active ?? false,
      bid_rule_target_place: normquery?.bid_rule_target_place ?? null,
      bid_rule_max_cpm: normquery?.bid_rule_max_cpm ?? null,
      excluded: Boolean(normquery?.excluded),
      fixed: Boolean(normquery?.fixed),
      is_main: Boolean(normquery?.is_main),
      tags: normquery?.tags || [],
      position_raw: positionRaw ?? null,
      position: positionRaw ? Math.abs(positionRaw) : positionRaw ?? null,
      position_is_promo: Boolean(positionRaw && positionRaw > 0),
      latest_date: latestDate,
      latest_org_pos: latestDaily?.org_pos ?? null,
      latest_promo_pos: latestDaily?.rates_promo_pos ?? null,
      daily,
    };
  });

  rows.sort((left, right) => {
    const expenseDiff = asFloat(right.expense) - asFloat(left.expense);
    if (expenseDiff) {
      return expenseDiff;
    }
    const viewsDiff = asFloat(right.views) - asFloat(left.views);
    if (viewsDiff) {
      return viewsDiff;
    }
    return String(left.name || "").localeCompare(String(right.name || ""));
  });

  return {
    available: rows.length > 0,
    statistics_from: statsPayload?.statistics_from ?? null,
    created: statsPayload?.created ?? null,
    status: statsPayload?.status ?? null,
    status_xway: statsPayload?.status_xway ?? null,
    type: statsPayload?.type ?? null,
    unified: statsPayload?.unified ?? false,
    total_clusters: statsPayload?.total_clusters ?? 0,
    excluded: statsPayload?.excluded ?? 0,
    fixed: statsPayload?.fixed ?? 0,
    current_rules_used: statsPayload?.current_rules_used ?? null,
    max_rules_available: statsPayload?.max_rules_available ?? null,
    items: rows,
  };
}

function normalizeClusterActionHistory(campaign, cluster, rows) {
  return [...(rows || [])]
    .map((row) => {
      const ts = row?.ts || row?.datetime || row?.created || row?.created_at || row?.date || "";
      return {
        ts,
        ts_sort: row?.ts_sort || row?.datetime_sort || row?.created_at || row?.created || ts || null,
        action: row?.action || row?.message || row?.status || row?.type || "Действие",
        author: row?.author || row?.user || row?.username || row?.initiator || "—",
        campaign_id: campaign?.id ?? null,
        campaign_name: campaign?.name ?? null,
        normquery_id: cluster?.normquery_id ?? null,
        cluster_name: cluster?.name ?? null,
      };
    })
    .filter((row) => row.ts || row.action)
    .sort((left, right) => String(right.ts_sort || right.ts || "").localeCompare(String(left.ts_sort || left.ts || "")));
}

function additionalStatsStart(period) {
  const start = parseIsoDate(period?.current_start);
  const end = parseIsoDate(period?.current_end);
  if (!start || !end) {
    return period?.current_start || null;
  }
  const spanDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  if (spanDays <= 30) {
    return isoDate(start);
  }
  return isoDate(new Date(end.getTime() - 30 * 86400000));
}

function catalogCampaignStatusLabel(statusCode) {
  const normalized = String(statusCode || "").trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  return {
    ACTIVE: "Активна",
    PAUSED: "Пауза",
    FROZEN: "Заморожена",
  }[normalized] || normalized;
}

function extractCatalogCampaignStatusCode(rawValue) {
  let value = rawValue;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    value = value.status;
  }
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = String(value).trim().toUpperCase();
  return normalized || null;
}

function normalizeCatalogCampaignStates(raw) {
  return CATALOG_CAMPAIGN_FIELD_ORDER.map((key) => {
    const normalizedCode = extractCatalogCampaignStatusCode(raw?.[key]);
    if (!normalizedCode) {
      return null;
    }
    const meta = CATALOG_CAMPAIGN_FIELD_META[key] || {};
    return {
      key,
      label: meta.label || key,
      short_label: meta.short_label || meta.label || key,
      status_code: normalizedCode,
      status_label: catalogCampaignStatusLabel(normalizedCode),
      active: normalizedCode === "ACTIVE",
    };
  }).filter(Boolean);
}

function resolvePaymentType(campaign) {
  const paymentTypeRaw = String(campaign?.payment_type || "").trim().toLowerCase();
  const campaignName = String(campaign?.name || "").trim().toLowerCase();
  const auctionMode = String(campaign?.auction_mode || "").trim().toLowerCase();
  const autoType = String(campaign?.auto_type || "").trim().toLowerCase();
  if (["cpc", "click", "clicks"].includes(paymentTypeRaw)) {
    return "cpc";
  }
  if (["cpm", "view", "views"].includes(paymentTypeRaw)) {
    return "cpm";
  }
  if (/оплата\s+за\s+клики|cpc|click|клик/i.test([campaignName, auctionMode, autoType].join(" "))) {
    return "cpc";
  }
  return "cpm";
}

function campaignSummary(campaign) {
  const stat = campaign?.stat || {};
  return {
    id: campaign?.id ?? null,
    wb_id: campaign?.external_id ?? null,
    name: campaign?.name ?? null,
    query_main: campaign?.query_main?.text ?? null,
    status: campaign?.status ?? null,
    status_xway: campaign?.status_xway ?? null,
    auction_mode: campaign?.auction_mode ?? null,
    auto_type: campaign?.auto_type ?? null,
    payment_type: resolvePaymentType(campaign),
    unified: Boolean(campaign?.unified),
    schedule_active: Boolean(campaign?.schedule_active),
    created: campaign?.created ?? null,
    wb_created: campaign?.wb_created ?? null,
    budget: campaign?.budget ?? null,
    bid: campaign?.bid ?? null,
    mp_bid: campaign?.mp_bid ?? null,
    mp_recom_bid: campaign?.mp_recom_bid ?? null,
    min_cpm: campaign?.min_cpm ?? null,
    min_cpm_recom: campaign?.min_cpm_recom ?? null,
    spend: campaign?.spend || {},
    limits_by_period: campaign?.limits_by_period || {},
    budget_rule: campaign?.budget_rule || {},
    budget_deposit_status: campaign?.budget_deposit_status ?? null,
    budget_deposit_error: campaign?.budget_deposit_error ?? null,
    pause_reasons: campaign?.pause_reasons || {},
    metrics: {
      views: stat.views ?? null,
      clicks: stat.clicks ?? null,
      atbs: stat.atbs ?? null,
      orders: stat.orders ?? null,
      shks: stat.shks ?? null,
      rel_shks: stat.rel_shks ?? null,
      sum: stat.sum ?? null,
      sum_price: stat.sum_price ?? null,
      rel_sum_price: stat.rel_sum_price ?? null,
      ctr: stat.CTR ?? null,
      cpc: stat.CPC ?? null,
      cr: stat.CR ?? null,
      cpo: stat.CPO ?? null,
      cpo_with_rel: stat.CPO_with_rel ?? null,
    },
    raw: cloneValue(campaign),
  };
}

function defaultArticleSheetPayload() {
  return {
    available: false,
    source_url: null,
    sheet_name: null,
    rows: [],
    latest: null,
    totals: {
      orders_plan: null,
      orders_fact: null,
      ad_spend: null,
      revenue: null,
      margin: null,
    },
    error: null,
  };
}

function productSummary(article, match, shopInfo, info, stocksRulePayload, statItem, dynamics, stata, dailyStats, heatmap, ordersHeatmap, campaigns, errors, period) {
  const product = match.product || {};
  const stat = statItem?.stat || {};
  const spend = statItem?.spend || {};
  const totals = stata?.totals || {};
  const normalizedProductSpendLimits = normalizeProductSpendLimits(statItem, product);
  const normalizedStocksRule = {
    ...(cloneValue(product.stocks_rule || {}) || {}),
    ...(cloneValue(stocksRulePayload || {}) || {}),
  };

  return {
    article,
    product_id: info?.id ?? null,
    product_url: info?.id ? `https://am.xway.ru/wb/shop/${shopInfo.id}/product/${info.id}` : null,
    period,
    shop: {
      id: shopInfo?.id ?? null,
      name: shopInfo?.name ?? null,
      marketplace: shopInfo?.marketplace ?? null,
      tariff_code: shopInfo?.tariff_code ?? null,
      products_count: shopInfo?.products_count ?? null,
      only_api: shopInfo?.only_api ?? null,
      expired: shopInfo?.expired ?? false,
      expired_days: shopInfo?.expired_days ?? null,
      expire_date: shopInfo?.expire_date ?? null,
      expire_in: shopInfo?.expire_in ?? null,
      new_flow: shopInfo?.new_flow ?? null,
      recurrent_shop: shopInfo?.recurrent_shop ?? null,
      jam_status: shopInfo?.jam_status ?? null,
    },
    identity: {
      name: info?.name ?? null,
      name_custom: info?.name_custom ?? null,
      brand: product?.brand ?? null,
      category_keyword: info?.category_keyword ?? null,
      vendor_code: product?.vendor_code ?? null,
      subject_id: info?.subject_id ?? null,
      image_url: info?.main_image_url ?? null,
      created: info?.created ?? null,
      group: product?.group ?? null,
      disp_version: product?.disp_version ?? null,
      progress_bar: product?.progress_bar ?? null,
      tags: cloneValue(product?.tags || []),
      tags_count: (product?.tags || []).length,
      seo_sets: cloneValue(product?.seo_sets || []),
      seo_sets_count: (product?.seo_sets || []).length,
      ab_tests_count: (product?.ab_tests || []).length,
    },
    flags: {
      enabled: info?.enabled ?? null,
      is_active: product?.is_active ?? null,
      ab_test_active: info?.ab_test_active ?? null,
      dispatcher_enabled: product?.dispatcher_enabled ?? null,
      dispatcher_errors: cloneValue(product?.dispatcher_errors || []),
      auto_dispatcher_is_active: info?.auto_dispatcher_is_active ?? null,
    },
    stock: {
      current: info?.stock ?? null,
      list_stock: statItem?.stock ?? null,
    },
    range_metrics: {
      budget: statItem?.budget ?? null,
      day_budget: statItem?.day_budget ?? null,
      campaigns_count: statItem?.campaigns_count ?? null,
      manual_campaigns_count: (product?.campaigns_data || {}).manual_count ?? null,
      ordered_report: statItem?.ordered_report ?? null,
      ordered_sum_report: statItem?.ordered_sum_report ?? null,
      ordered_dynamics_report: cloneValue(statItem?.ordered_dynamics_report ?? null),
      dynamics: cloneValue(statItem?.dynamics ?? null),
      spend_day: spend?.DAY ?? null,
      spend_week: spend?.WEEK ?? null,
      spend_month: spend?.MONTH ?? null,
      spend_limits: normalizedProductSpendLimits,
      views: stat?.views ?? null,
      clicks: stat?.clicks ?? null,
      atbs: stat?.atbs ?? null,
      orders: stat?.orders ?? null,
      shks: stat?.shks ?? null,
      rel_shks: stat?.rel_shks ?? null,
      sum: stat?.sum ?? null,
      sum_price: stat?.sum_price ?? null,
      rel_sum_price: stat?.rel_sum_price ?? null,
      rel_atbs: stat?.rel_atbs ?? null,
      ctr: stat?.CTR ?? null,
      cpc: stat?.CPC ?? null,
      cr: stat?.CR ?? null,
      cpo: stat?.CPO ?? null,
      cpo_overall: stat?.CPO_overall ?? null,
      cpo_with_rel: stat?.CPO_with_rel ?? null,
      drr: stat?.DRR ?? null,
    },
    operations: {
      spend_limits: cloneValue(product?.spend_limits ?? null),
      stocks_rule: Object.keys(normalizedStocksRule).length ? normalizedStocksRule : null,
      campaigns_data: cloneValue(product?.campaigns_data || {}),
      campaigns_by_type: cloneValue(product?.campaigns_data?.campaigns_by_type || {}),
    },
    comparison: cloneValue(dynamics || {}),
    stata_totals: cloneValue(totals || {}),
    daily_stats: dailyStats,
    daily_totals: dailyTotals(dailyStats),
    heatmap,
    orders_heatmap: ordersHeatmap,
    article_sheet: defaultArticleSheetPayload(),
    catalog_campaign_states: normalizeCatalogCampaignStatesForCatalog(product?.campaigns_data, [product, statItem, ...campaigns]),
    schedule_aggregate: aggregateSchedule(campaigns),
    campaigns,
    bid_log: campaigns
      .flatMap((campaign) => campaign?.bid_history || [])
      .sort((left, right) => String(right.datetime_sort || "").localeCompare(String(left.datetime_sort || ""))),
    cluster_action_log: campaigns
      .flatMap((campaign) => campaign?.cluster_action_history || [])
      .sort((left, right) => String(right.ts_sort || right.ts || "").localeCompare(String(left.ts_sort || left.ts || ""))),
    errors,
    raw: {
      product_list_item: cloneValue(product),
      stat_item: cloneValue(statItem),
      info: cloneValue(info),
      dynamics: cloneValue(dynamics),
      stata: cloneValue(stata),
    },
  };
}

function resolveCampaignHistoryFetchStart(campaign) {
  const candidates = [campaign?.wb_created, campaign?.created]
    .map((value) => parseFlexibleDateTime(value))
    .filter(Boolean)
    .map((value) => isoDate(value));
  return candidates.length ? candidates.sort()[0] : null;
}

async function safeCall(fn, defaultValue) {
  try {
    return [await fn(), null];
  } catch (error) {
    return [defaultValue, error instanceof Error ? error.message : String(error)];
  }
}

async function runParallelSafeCalls(tasks, concurrency = 4) {
  const entries = Object.entries(tasks || {});
  const values = {};
  const errors = {};
  await mapWithConcurrency(entries, Math.min(concurrency, Math.max(entries.length, 1)), async ([key, [call, defaultValue]]) => {
    const [value, error] = await safeCall(call, defaultValue);
    values[key] = value;
    errors[key] = error;
  });
  return [values, errors];
}

async function collectCampaignHeavyPayload(client, shopId, productId, campaignId, campaignHistoryStart = null) {
  const [primaryValues, primaryErrors] = await runParallelSafeCalls(
    {
      schedule: [() => client.campaignSchedule(shopId, productId, campaignId), {}],
      bid_history: [() => client.campaignBidHistory(shopId, productId, campaignId), []],
      budget_history: [() => client.campaignBudgetHistory(shopId, productId, campaignId), []],
      status_mp: [() => client.campaignStatusMpHistoryFull(shopId, productId, campaignId, { pageLimit: 120, targetStart: campaignHistoryStart }), {}],
      status_pause: [() => client.campaignStatusPauseHistoryFull(shopId, productId, campaignId, { initialLimit: 120, targetStart: campaignHistoryStart }), {}],
      cluster_stats: [() => client.campaignNormqueryStats(shopId, productId, campaignId), {}],
    },
    6,
  );

  const clusterStatsPayload = primaryValues.cluster_stats || {};
  const clusterIds = (clusterStatsPayload.normqueries || []).map((item) => item?.normquery_id).filter((value) => value !== null && value !== undefined);
  let secondaryValues = {
    cluster_positions: {},
    cluster_additional: {},
    cluster_history: {},
  };
  let secondaryErrors = {
    cluster_positions: null,
    cluster_additional: null,
    cluster_history: null,
  };

  if (clusterIds.length) {
    [secondaryValues, secondaryErrors] = await runParallelSafeCalls(
      {
        cluster_positions: [() => client.productNormqueriesPositions(shopId, productId, clusterIds), {}],
        cluster_additional: [() => client.campaignAdditionalStatsForNormqueries(shopId, productId, campaignId, clusterIds, additionalStatsStart(client.range), client.range.current_end), {}],
        cluster_history: [
          async () => {
            const entries = await mapWithConcurrency(clusterIds, 4, async (normqueryId) => {
              const [history] = await safeCall(() => client.campaignNormqueryHistory(shopId, productId, campaignId, normqueryId), []);
              return [String(normqueryId), history || []];
            });
            return Object.fromEntries(entries);
          },
          {},
        ],
      },
      3,
    );
  }

  return {
    schedule_payload: primaryValues.schedule || {},
    bid_history_payload: primaryValues.bid_history || [],
    budget_history_payload: primaryValues.budget_history || [],
    status_mp_payload: primaryValues.status_mp || {},
    status_pause_payload: primaryValues.status_pause || {},
    cluster_stats_payload: clusterStatsPayload,
    cluster_positions_payload: secondaryValues.cluster_positions || {},
    cluster_additional_payload: secondaryValues.cluster_additional || {},
    cluster_history_payload: secondaryValues.cluster_history || {},
    errors: {
      schedule: primaryErrors.schedule,
      bid_history: primaryErrors.bid_history,
      budget_history: primaryErrors.budget_history,
      status_mp: primaryErrors.status_mp,
      status_pause: primaryErrors.status_pause,
      cluster_stats: primaryErrors.cluster_stats,
      cluster_positions: secondaryErrors.cluster_positions,
      cluster_additional: secondaryErrors.cluster_additional,
      cluster_history: secondaryErrors.cluster_history,
    },
  };
}

async function collectSingleArticle(env, article, match, start, end, campaignMode, requestedHeavyIds) {
  const client = new XwayApiClient(env, { start, end });
  const shop = match.shop || {};
  const product = match.product || {};
  const statItem = match.stat_item || {};
  const shopId = Number.parseInt(String(shop.id), 10);
  const productId = Number.parseInt(String(product.id), 10);

  const [shopInfo, info, dynamics, stata, [stocksRulePayload]] = await Promise.all([
    client.shopDetails(shopId),
    client.productInfo(shopId, productId),
    client.productDynamics(shopId, productId),
    client.productStata(shopId, productId),
    safeCall(() => client.productStocksRule(shopId, productId), {}),
  ]);

  const campaignRows = stata?.campaign_wb || [];
  const campaignIds = campaignRows.map((campaign) => campaign?.id).filter((value) => value !== null && value !== undefined);
  const campaignHistoryStarts = Object.fromEntries(
    campaignRows
      .filter((campaign) => campaign?.id !== null && campaign?.id !== undefined)
      .map((campaign) => [String(campaign.id), resolveCampaignHistoryFetchStart(campaign)]),
  );

  let heavyIds;
  if (campaignMode === "summary") {
    const defaultHeavyIds = campaignIds.slice(0, 2).map((campaignId) => String(campaignId));
    heavyIds = new Set(
      campaignIds
        .map((campaignId) => String(campaignId))
        .filter((campaignId) => requestedHeavyIds.size ? requestedHeavyIds.has(campaignId) : defaultHeavyIds.includes(campaignId)),
    );
  } else {
    heavyIds = new Set(campaignIds.map((campaignId) => String(campaignId)));
  }
  const heavyCampaignIds = campaignIds.filter((campaignId) => heavyIds.has(String(campaignId)));

  const auxTasks = {
    campaign_daily_exact: [() => client.campaignDailyExact(shopId, productId, [...heavyIds], client.range.current_start, client.range.current_end), {}],
    daily_stats: [() => client.productStatsByDay(shopId, productId, client.range.current_start, client.range.current_end), []],
    heatmap: [() => client.productHeatMap(shopId, productId, campaignIds), {}],
    orders_heatmap: [() => client.productOrdersHeatMap(shopId, productId), {}],
  };

  const auxPromise = runParallelSafeCalls(auxTasks, 4);
  const heavyPayloadEntries = await mapWithConcurrency(
    heavyCampaignIds,
    Math.min(4, Math.max(heavyCampaignIds.length, 1)),
    async (campaignId) => {
      try {
        const payload = await collectCampaignHeavyPayload(client, shopId, productId, Number(campaignId), campaignHistoryStarts[String(campaignId)] || null);
        return [String(campaignId), payload];
      } catch (error) {
        return [
          String(campaignId),
          {
            errors: {
              fatal: error instanceof Error ? error.message : String(error),
            },
          },
        ];
      }
    },
  );
  const heavyPayloadByCampaign = Object.fromEntries(heavyPayloadEntries);
  const [auxValues, auxErrors] = await auxPromise;

  const campaignDailyExact = auxValues.campaign_daily_exact || {};
  const campaigns = campaignRows.map((campaign) => {
    const summary = campaignSummary(campaign);
    const campaignId = campaign?.id;
    const isHeavy = heavyIds.has(String(campaignId));
    summary._heavy_loaded = isHeavy;
    summary.daily_exact = isHeavy ? campaignDailyExact[String(campaignId)] || [] : [];
    summary.spend_limits = normalizeSpendLimits(campaign);

    if (isHeavy) {
      const heavyPayload = heavyPayloadByCampaign[String(campaignId)] || {};
      const heavyErrors = heavyPayload.errors || {};
      const budgetHistory = normalizeBudgetHistory(heavyPayload.budget_history_payload || []);
      summary.schedule_config = normalizeSchedule(heavyPayload.schedule_payload || {});
      summary.schedule_error = heavyErrors.schedule || heavyErrors.fatal || null;
      summary.bid_history = normalizeBidHistory(campaign, heavyPayload.bid_history_payload || []);
      summary.bid_history_error = heavyErrors.bid_history || heavyErrors.fatal || null;
      summary.budget_history = budgetHistory;
      summary.budget_history_error = heavyErrors.budget_history || heavyErrors.fatal || null;
      summary.budget_rule_config = normalizeBudgetRule(campaign, budgetHistory);
      summary.status_logs = {
        mp_history: normalizeStatusMpHistory(heavyPayload.status_mp_payload?.result || []),
        mp_next_page: heavyPayload.status_mp_payload?.next_page ?? null,
        mp_error: heavyErrors.status_mp || heavyErrors.fatal || null,
        pause_history: normalizeStatusPauseHistory(heavyPayload.status_pause_payload || {}),
        pause_error: heavyErrors.status_pause || heavyErrors.fatal || null,
      };
      summary.clusters = normalizeClusterRows(
        heavyPayload.cluster_stats_payload || {},
        heavyPayload.cluster_positions_payload || {},
        heavyPayload.cluster_additional_payload || {},
        client.range.current_start,
        client.range.current_end,
      );
      summary.cluster_action_history = summary.clusters.items.flatMap((cluster) =>
        normalizeClusterActionHistory(campaign, cluster, heavyPayload.cluster_history_payload?.[String(cluster.normquery_id)] || []),
      );
      summary.cluster_errors = Object.fromEntries(
        Object.entries({
          stats: heavyErrors.cluster_stats || heavyErrors.fatal || null,
          positions: heavyErrors.cluster_positions || heavyErrors.fatal || null,
          additional: heavyErrors.cluster_additional || heavyErrors.fatal || null,
          history: heavyErrors.cluster_history || heavyErrors.fatal || null,
        }).filter(([, value]) => Boolean(value)),
      );
    } else {
      summary.schedule_config = {};
      summary.schedule_error = null;
      summary.bid_history = [];
      summary.bid_history_error = null;
      summary.budget_history = [];
      summary.budget_history_error = null;
      summary.budget_rule_config = normalizeBudgetRule(campaign, []);
      summary.status_logs = {
        mp_history: [],
        mp_next_page: null,
        mp_error: null,
        pause_history: normalizeStatusPauseHistory({}),
        pause_error: null,
      };
      summary.clusters = {
        available: false,
        items: [],
        total_clusters: 0,
        excluded: 0,
        fixed: 0,
        current_rules_used: 0,
        max_rules_available: 0,
        statistics_from: null,
        created: null,
        status: campaign?.status ?? null,
        status_xway: campaign?.status_xway ?? null,
        type: campaign?.type ?? null,
        unified: campaign?.unified ?? false,
      };
      summary.cluster_errors = {};
      summary.cluster_action_history = [];
    }

    return summary;
  });

  const errors = Object.fromEntries(
    Object.entries({
      daily_stats: auxErrors.daily_stats,
      heatmap: auxErrors.heatmap,
      orders_heatmap: auxErrors.orders_heatmap,
      campaign_daily_exact: auxErrors.campaign_daily_exact,
    }).filter(([, value]) => Boolean(value)),
  );

  return productSummary(
    article,
    match,
    shopInfo,
    info,
    stocksRulePayload || {},
    statItem,
    dynamics,
    stata,
    normalizeDailyStats(auxValues.daily_stats || [], client.range.current_start, client.range.current_end),
    normalizeHeatmap(auxValues.heatmap || {}),
    normalizeOrdersHeatmap(auxValues.orders_heatmap || {}),
    campaigns,
    errors,
    client.range,
  );
}

export async function collectProducts(env, { articles = [], start = null, end = null, campaignMode = "full", heavyCampaignIds = [] } = {}) {
  const requestedArticles = [...new Set((articles || []).map((article) => String(article || "").trim()).filter(Boolean))];
  const normalizedMode = String(campaignMode || "").toLowerCase() === "summary" ? "summary" : "full";
  const requestedHeavyIds = new Set((heavyCampaignIds || []).map((campaignId) => String(campaignId || "").trim()).filter(Boolean));
  const client = new XwayApiClient(env, { start, end });

  const cacheKey = [
    client.cacheNamespace,
    client.range.current_start,
    client.range.current_end,
    normalizedMode,
    requestedArticles.join(","),
    [...requestedHeavyIds].sort().join(","),
  ].join("::");
  const cached = getCached(cacheKey);
  if (cached) {
    return cached;
  }

  const found = await client.findArticles(requestedArticles);
  const pendingArticles = [];
  const notFound = [];
  for (const article of requestedArticles) {
    if (found[article]) {
      pendingArticles.push(article);
    } else {
      notFound.push(article);
    }
  }

  const productsByArticle = Object.fromEntries(
    await mapWithConcurrency(
      pendingArticles,
      Math.min(4, Math.max(pendingArticles.length, 1)),
      async (article) => [article, await collectSingleArticle(env, article, found[article], client.range.current_start, client.range.current_end, normalizedMode, requestedHeavyIds)],
    ),
  );

  const payload = {
    ok: true,
    generated_at: new Date().toISOString().slice(0, 10),
    range: client.range,
    products: requestedArticles.map((article) => productsByArticle[article]).filter(Boolean),
    not_found: notFound,
    requested_articles: requestedArticles,
  };
  setCached(cacheKey, payload);
  return payload;
}
