import { normalizeSchedule, normalizeStatusPauseHistory } from "./products.js";
import { XwayApiClient } from "./xway-client.js";
import { iterIsoDays, mapWithConcurrency, parseCatalogChartProductRefs } from "./utils.js";

const CATALOG_ISSUE_KIND_ORDER = ["budget", "limit", "schedule_setup"];
const CATALOG_ISSUES_FETCH_CONCURRENCY = 2;
const CATALOG_ISSUES_DEFAULT_DEADLINE_MS = 22000;
const CATALOG_ISSUES_MIN_PROCESSED_BEFORE_DEADLINE = 1;

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function computeDrr(spend, revenue) {
  const spendValue = toNumber(spend);
  const revenueValue = toNumber(revenue);
  if (spendValue === null || revenueValue === null || revenueValue <= 0) {
    return null;
  }
  return (spendValue / revenueValue) * 100;
}

async function safeCall(fn, defaultValue) {
  try {
    return [await fn(), null];
  } catch (error) {
    return [defaultValue, error instanceof Error ? error.message : String(error)];
  }
}

function splitStatusDateTime(value) {
  const text = String(value || "").trim();
  if (!text) {
    return { date: "—", time: "" };
  }
  const parts = text.split(",");
  if (parts.length >= 2) {
    const [datePart = "—", ...timeParts] = parts;
    return {
      date: datePart.trim() || "—",
      time: timeParts.join(",").trim(),
    };
  }
  const match = text.match(/^(.*?)(\d{1,2}:\d{2})$/);
  if (match) {
    return {
      date: (match[1] ?? "").trim() || "—",
      time: (match[2] ?? "").trim(),
    };
  }
  return { date: text, time: "" };
}

function parseRuDateLabel(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})[.-](\d{1,2})[.-](\d{4})$/);
  if (!match) {
    return null;
  }
  const [, day, month, year] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function parseStatusDateTimeValue(value, options = {}) {
  const parts = splitStatusDateTime(value);
  const fallbackDate = options.fallbackDate instanceof Date && !Number.isNaN(options.fallbackDate.getTime()) ? new Date(options.fallbackDate) : null;
  const explicitDate = parseRuDateLabel(parts.date);
  const baseDate =
    explicitDate ||
    fallbackDate ||
    (Number.isFinite(options.fallbackYear) ? new Date(Number(options.fallbackYear), 0, 1) : null);
  if (!baseDate) {
    return null;
  }
  const parsed = new Date(baseDate);
  if (parts.time) {
    const [hours = 0, minutes = 0] = parts.time.split(":").map((item) => Number(item));
    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
      parsed.setHours(hours, minutes, 0, 0);
    }
  } else {
    parsed.setHours(0, 0, 0, 0);
  }
  return parsed;
}

function parseCampaignIntervalEnd(item, startAt) {
  const rawEnd = String(item?.end || "").trim();
  if (!rawEnd) {
    return new Date();
  }
  const parsed = parseStatusDateTimeValue(rawEnd, {
    fallbackDate: startAt,
    fallbackYear: startAt.getFullYear(),
  });
  if (!parsed) {
    return new Date(startAt);
  }
  const endAt = new Date(parsed);
  const endDateLabel = splitStatusDateTime(rawEnd).date;
  const hasDatePart = Boolean(parseRuDateLabel(endDateLabel));
  if (!hasDatePart && endAt <= startAt) {
    endAt.setDate(endAt.getDate() + 1);
  }
  return endAt;
}

function formatStatusClock(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function splitPauseReasonTokens(values) {
  const source = Array.isArray(values) ? values : [values];
  return source
    .flatMap((value) => {
      if (value && typeof value === "object") {
        return [
          ...splitPauseReasonTokens(value.pause_reasons || []),
          ...splitPauseReasonTokens(value.paused_limiter),
          ...splitPauseReasonTokens(value.reason),
          ...splitPauseReasonTokens(value.status),
        ];
      }
      return String(value || "").split(/[;,\s/]+/);
    })
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveCampaignActivityStatusKey(item) {
  if (item?.is_freeze) {
    return "freeze";
  }
  const status = String(item?.status || "").toLowerCase();
  const reasons = [...(item?.pause_reasons || []), item?.paused_limiter]
    .map((token) => String(token || "").toLowerCase())
    .join(" ");
  if (/актив|active/.test(status)) {
    return "active";
  }
  if (
    /приост|pause|paused|stop|неактив|inactive/.test(status) ||
    /schedule|распис|budget|бюджет|limit|лимит/.test(reasons) ||
    Boolean(item?.paused_limiter) ||
    Boolean(item?.paused_user)
  ) {
    return "paused";
  }
  return "unknown";
}

function resolvePauseReasonKinds(item) {
  const tokens = [...splitPauseReasonTokens(item?.pause_reasons || []), ...splitPauseReasonTokens(item?.paused_limiter)];
  const joined = tokens.map((token) => token.toLowerCase()).join(" ");
  const hasSchedule = /schedule|распис/.test(joined);
  const hasLimit = /campaign_limiter|spend_limit|day_limit|daily_limit|limit|лимит|день|day/.test(joined);
  const hasBudget = /budget|бюджет|money|баланс|остаток|fund/.test(joined);
  const reasonKinds = [];

  if (hasSchedule) {
    reasonKinds.push("schedule");
  }
  if (hasBudget) {
    reasonKinds.push("budget");
  }
  if (hasLimit) {
    reasonKinds.push("limit");
  }
  return reasonKinds;
}

function resolvePauseIssueKinds(item) {
  if (item?.is_freeze) {
    return [];
  }
  const reasonKinds = resolvePauseReasonKinds(item);
  const issueKinds = [];
  if (reasonKinds.includes("limit")) {
    issueKinds.push("limit");
  }
  if (reasonKinds.includes("budget")) {
    issueKinds.push("budget");
  }
  return issueKinds;
}

function campaignRawPauseHistoryIntervals(campaign) {
  const pauseHistory = campaign?.status_logs?.pause_history;
  return Array.isArray(pauseHistory?.intervals) ? pauseHistory.intervals : Array.isArray(pauseHistory?.merged_intervals) ? pauseHistory.merged_intervals : [];
}

function formatYesterdayLabel(day) {
  const parsed = new Date(`${day}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return day;
  }
  const weekday = parsed.toLocaleDateString("ru-RU", { weekday: "short" });
  const date = parsed.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  return `${weekday} ${date}`;
}

function buildCampaignYesterdayStatusDay(campaign, yesterday) {
  const dayStart = new Date(`${yesterday}T00:00:00`);
  const dayEnd = new Date(`${yesterday}T23:59:59.999`);

  const entries = campaignRawPauseHistoryIntervals(campaign)
    .flatMap((item) => {
      const startAt = parseStatusDateTimeValue(item?.start);
      const endAt = startAt ? parseCampaignIntervalEnd(item, startAt) : null;
      if (!startAt || !endAt) {
        return [];
      }
      if (startAt > dayEnd || endAt < dayStart) {
        return [];
      }
      const effectiveStart = startAt > dayStart ? startAt : dayStart;
      const effectiveEnd = endAt < dayEnd ? endAt : dayEnd;
      return [{
        key: resolveCampaignActivityStatusKey(item),
        startTime: formatStatusClock(effectiveStart),
        endTime: effectiveEnd.getTime() >= dayEnd.getTime() ? null : formatStatusClock(effectiveEnd),
        issueKinds: resolvePauseIssueKinds(item),
      }];
    })
    .sort((left, right) => left.startTime.localeCompare(right.startTime));

  return {
    day: yesterday,
    label: formatYesterdayLabel(yesterday),
    entries,
  };
}

function parseClockToMinutes(value, endOfDay = false) {
  if (!value) {
    return endOfDay ? 24 * 60 : 0;
  }
  const [hours = "0", minutes = "0"] = String(value).split(":");
  const total = Number(hours) * 60 + Number(minutes);
  return Number.isFinite(total) ? total : endOfDay ? 24 * 60 : 0;
}

function buildCampaignIssueSummaries(campaign, statusDays) {
  const summaries = new Map();
  const totalStoppedHoursByDay = new Map();
  const dailyExpenseByDay = new Map(
    [...(campaign?.daily_exact || [])]
      .sort((left, right) => String(left?.day || "").localeCompare(String(right?.day || "")))
      .map((row) => [row?.day, toNumber(row?.expense_sum)]),
  );
  const averageHourlySpendFallback = (() => {
    const positiveExpenses = [...dailyExpenseByDay.values()].filter((value) => value !== null && value > 0);
    if (!positiveExpenses.length) {
      return 0;
    }
    return positiveExpenses.reduce((sum, value) => sum + value, 0) / (positiveExpenses.length * 24);
  })();

  statusDays.forEach((day) => {
    day.entries.forEach((entry) => {
      if (entry.key === "active") {
        return;
      }
      const startMinutes = parseClockToMinutes(entry.startTime);
      const endMinutes = parseClockToMinutes(entry.endTime, true);
      const durationHours = Math.max(endMinutes - startMinutes, 0) / 60;
      if (durationHours <= 0) {
        return;
      }
      totalStoppedHoursByDay.set(day.day, (totalStoppedHoursByDay.get(day.day) || 0) + durationHours);
    });
  });

  statusDays.forEach((day) => {
    day.entries.forEach((entry) => {
      if (!entry.issueKinds?.length || entry.key === "active") {
        return;
      }
      const startMinutes = parseClockToMinutes(entry.startTime);
      const endMinutes = parseClockToMinutes(entry.endTime, true);
      const durationHours = Math.max(endMinutes - startMinutes, 0) / 60;
      if (durationHours <= 0) {
        return;
      }
      entry.issueKinds.forEach((kind) => {
        const current = summaries.get(kind) || {
          kind,
          label: kind === "limit" ? "Израсходован лимит" : "Нет бюджета",
          hours: 0,
          maxIncidentHours: 0,
          incidents: 0,
          days: [],
        };
        current.hours += durationHours;
        current.maxIncidentHours = Math.max(current.maxIncidentHours || 0, durationHours);
        current.incidents += 1;
        let dayEntry = current.days.find((item) => item.day === day.day);
        if (!dayEntry) {
          dayEntry = { day: day.day, label: day.label, hours: 0, maxIncidentHours: 0, incidents: 0, estimatedGap: null };
          current.days.push(dayEntry);
        }
        dayEntry.hours += durationHours;
        dayEntry.maxIncidentHours = Math.max(dayEntry.maxIncidentHours || 0, durationHours);
        dayEntry.incidents += 1;
        summaries.set(kind, current);
      });
    });
  });

  if (isCampaignScheduleSetupIssue(campaign)) {
    statusDays.forEach((day) => {
      if (!day?.day) {
        return;
      }
      const current = summaries.get("schedule_setup") || {
        kind: "schedule_setup",
        label: "Не настроено время показа",
        hours: 0,
        maxIncidentHours: 0,
        incidents: 0,
        days: [],
      };
      current.hours += 24;
      current.maxIncidentHours = Math.max(current.maxIncidentHours || 0, 24);
      current.incidents += 1;
      let dayEntry = current.days.find((item) => item.day === day.day);
      if (!dayEntry) {
        dayEntry = { day: day.day, label: day.label, hours: 0, maxIncidentHours: 0, incidents: 0, estimatedGap: null };
        current.days.push(dayEntry);
      }
      dayEntry.hours += 24;
      dayEntry.maxIncidentHours = Math.max(dayEntry.maxIncidentHours || 0, 24);
      dayEntry.incidents += 1;
      summaries.set("schedule_setup", current);
    });
  }

  return CATALOG_ISSUE_KIND_ORDER
    .map((kind) => summaries.get(kind))
    .filter(Boolean)
    .map((summary) => {
      const days = summary.days
        .map((dayEntry) => {
          const totalStoppedHours = totalStoppedHoursByDay.get(dayEntry.day) || 0;
          const activeHours = Math.max(24 - totalStoppedHours, 0);
          const dailyExpense = dailyExpenseByDay.get(dayEntry.day) ?? null;
          const estimatedGap =
            summary.kind === "schedule_setup"
              ? null
              : dailyExpense !== null && dailyExpense > 0 && activeHours > 0
                ? (dailyExpense / activeHours) * dayEntry.hours
                : averageHourlySpendFallback > 0
                  ? averageHourlySpendFallback * dayEntry.hours
                  : null;
          return { ...dayEntry, estimatedGap };
        })
        .sort((left, right) => left.day.localeCompare(right.day));
      const estimatedGapValues = days
        .map((day) => day.estimatedGap)
        .filter((value) => value !== null && Number.isFinite(value));
      return {
        ...summary,
        maxIncidentHours: Number.isFinite(summary.maxIncidentHours) ? summary.maxIncidentHours : 0,
        estimatedGapTotal: estimatedGapValues.length ? estimatedGapValues.reduce((sum, value) => sum + value, 0) : null,
        days,
      };
    });
}

function formatIssueCampaignName(campaign) {
  const name = String(campaign?.name || "").trim();
  return name ? `РК ${campaign.id} · ${name}` : `РК ${campaign.id}`;
}

function resolveCampaignPaymentType(campaign) {
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

function resolveCampaignZoneKind(campaign) {
  const auctionMode = String(campaign?.auction_mode || "").trim().toLowerCase();
  const autoType = String(campaign?.auto_type || "").trim().toLowerCase();
  const name = String(campaign?.name || "").trim().toLowerCase();
  const paymentType = String(campaign?.payment_type || "").trim().toLowerCase();
  const searchSignal = toNumber(campaign?.min_cpm) !== null || toNumber(campaign?.mp_bid) !== null;
  const recomSignal = toNumber(campaign?.min_cpm_recom) !== null || toNumber(campaign?.mp_recom_bid) !== null;
  const source = [auctionMode, autoType, name].filter(Boolean).join(" ");

  let hasSearch = false;
  let hasRecom = false;

  if (campaign?.unified) {
    hasSearch = true;
    hasRecom = true;
  } else if (/search[_\s-]*recom|recom[_\s-]*search|searchrecom|поиск.*реком|реком.*поиск/.test(auctionMode)) {
    hasSearch = true;
    hasRecom = true;
  } else if (/recom|recommend|реком/.test(auctionMode)) {
    hasRecom = true;
  } else if (/search|поиск/.test(auctionMode)) {
    hasSearch = true;
  } else if (paymentType.includes("cpc") || paymentType.includes("click") || paymentType.includes("клик")) {
    hasSearch = true;
  } else {
    hasSearch = searchSignal || /search|поиск/.test(source);
    hasRecom = recomSignal || /recom|recommend|реком/.test(source);
  }

  if (hasSearch && hasRecom) {
    return "both";
  }
  if (hasRecom) {
    return "recom";
  }
  return "search";
}

function normalizeCampaignStatusCode(campaign) {
  const raw = campaign?.status_xway ?? campaign?.status ?? null;
  const normalized = String(raw || "").trim().toUpperCase();
  let statusCode = normalized || null;
  if (["PAUSED", "PAUSE", "ПАУЗА", "ПРИОСТАНОВЛЕНА", "ПРИОСТАНОВЛЕН", "ОСТАНОВЛЕНА", "ОСТАНОВЛЕН"].includes(normalized)) {
    statusCode = "PAUSED";
  } else if (["ACTIVE", "АКТИВНА", "АКТИВЕН", "АКТИВНАЯ", "АКТИВНЫЙ"].includes(normalized)) {
    statusCode = "ACTIVE";
  } else if (["FROZEN", "FREEZE", "ЗАМОРОЖЕНА", "ЗАМОРОЖЕН", "ЗАМОРОЗКА"].includes(normalized)) {
    statusCode = "FROZEN";
  }
  const rawStatusText = [campaign?.status_xway, campaign?.status, campaign?.freeze_status].map((value) => String(value || "").toLowerCase()).join(" ");
  const pausePayload = campaign?.pause_reasons || {};
  const pauseTokens = splitPauseReasonTokens(pausePayload).map((token) => token.toLowerCase());
  const pausedUser = pausePayload?.paused_user ?? campaign?.paused_user ?? null;
  if (
    campaign?.is_freeze ||
    campaign?.is_frozen ||
    campaign?.frozen ||
    campaign?.freeze ||
    /заморож|freeze|frozen/.test(rawStatusText) ||
    (statusCode === "PAUSED" && (pausedUser || pauseTokens.some((token) => ["user", "manual", "freeze", "frozen"].includes(token) || /замороз/.test(token))))
  ) {
    return "FROZEN";
  }
  return statusCode;
}

function formatCampaignStatusLabel(statusCode) {
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

function resolveCampaignDisplayStatus(statusCode) {
  const normalized = String(statusCode || "").trim().toUpperCase();
  const normalizedLower = normalized.toLowerCase();
  if (normalized === "ACTIVE" || /актив/.test(normalizedLower)) {
    return "active";
  }
  if (normalized === "FROZEN" || /заморож|freeze|frozen/.test(normalizedLower)) {
    return "freeze";
  }
  if (normalized === "PAUSED" || /приост|pause|paused|stop|неактив/.test(normalizedLower)) {
    return "paused";
  }
  return "muted";
}

function normalizeCursor(value, total) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.min(parsed, Math.max(total, 0));
}

function normalizeLimit(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(parsed, max));
}

function normalizeDeadlineMs(value, fallback = CATALOG_ISSUES_DEFAULT_DEADLINE_MS) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(3000, Math.min(parsed, 25000));
}

function isCampaignScheduleSetupIssue(campaign) {
  const statusCode = normalizeCampaignStatusCode(campaign);
  const displayStatus = resolveCampaignDisplayStatus(statusCode);
  if (displayStatus !== "active" && displayStatus !== "paused") {
    return false;
  }
  if (!campaign?.schedule_config) {
    return false;
  }
  const schedule = campaign?.schedule_config || {};
  const activeSlots = toNumber(schedule.active_slots);
  return !schedule.schedule_active || (activeSlots !== null && activeSlots >= 168);
}

function collectCampaignDayMetrics(campaign, day) {
  return [...(campaign?.daily_exact || [])].reduce(
    (totals, row) => {
      if (String(row?.day || "") !== day) {
        return totals;
      }
      totals.orders_ads += toNumber(row?.orders) ?? 0;
      totals.spend += toNumber(row?.expense_sum) ?? 0;
      totals.revenue_ads += toNumber(row?.sum_price) ?? 0;
      return totals;
    },
    { orders_ads: 0, spend: 0, revenue_ads: 0 },
  );
}

function collectProductDayMetrics(rows, day) {
  return [...(rows || [])].reduce(
    (totals, row) => {
      if (String(row?.day || "") !== day) {
        return totals;
      }
      totals.total_orders += toNumber(row?.ordered_total) ?? 0;
      totals.total_revenue += toNumber(row?.ordered_sum_total) ?? 0;
      return totals;
    },
    { total_orders: 0, total_revenue: 0 },
  );
}

function collectCampaignRangeMetrics(campaign, days) {
  return days.reduce(
    (totals, day) => {
      const metrics = collectCampaignDayMetrics(campaign, day);
      totals.orders_ads += metrics.orders_ads;
      totals.spend += metrics.spend;
      totals.revenue_ads += metrics.revenue_ads;
      return totals;
    },
    { orders_ads: 0, spend: 0, revenue_ads: 0 },
  );
}

function collectProductRangeMetrics(rows, days) {
  return days.reduce(
    (totals, day) => {
      const metrics = collectProductDayMetrics(rows, day);
      totals.total_orders += metrics.total_orders;
      totals.total_revenue += metrics.total_revenue;
      return totals;
    },
    { total_orders: 0, total_revenue: 0 },
  );
}

function buildIssueCampaignMeta(campaign, metrics = {}) {
  const statusCode = normalizeCampaignStatusCode(campaign);
  return {
    id: Number(campaign?.id),
    label: formatIssueCampaignName(campaign),
    payment_type: resolveCampaignPaymentType(campaign),
    zone_kind: resolveCampaignZoneKind(campaign),
    status_code: statusCode,
    status_label: formatCampaignStatusLabel(statusCode),
    display_status: resolveCampaignDisplayStatus(statusCode),
    hours: Number.isFinite(metrics.hours) ? metrics.hours : 0,
    max_incident_hours: Number.isFinite(metrics.max_incident_hours) ? metrics.max_incident_hours : 0,
    incidents: Number.isFinite(metrics.incidents) ? metrics.incidents : 0,
    orders_ads: Number.isFinite(metrics.orders_ads) ? metrics.orders_ads : 0,
    drr: Number.isFinite(metrics.drr) ? metrics.drr : null,
    estimated_gap: Number.isFinite(metrics.estimated_gap) && metrics.estimated_gap > 0 ? metrics.estimated_gap : null,
  };
}

function aggregateCatalogIssueSummaries(campaigns, productDailyStats, targetDays) {
  const days = (Array.isArray(targetDays) ? targetDays : [targetDays]).filter(Boolean);
  const productRangeMetrics = collectProductRangeMetrics(productDailyStats, days);
  const aggregated = new Map();
  for (const campaign of campaigns || []) {
    const statusDays = days.map((day) => buildCampaignYesterdayStatusDay(campaign, day));
    const campaignIssues = buildCampaignIssueSummaries(campaign, statusDays);
    for (const summary of campaignIssues) {
      const summaryDays = summary.days.filter((entry) => days.includes(entry.day));
      if (!summaryDays.length) {
        continue;
      }
      const summaryDayKeys = summaryDays.map((entry) => entry.day);
      const campaignMetrics = collectCampaignRangeMetrics(campaign, summaryDayKeys);
      const campaignDrr = computeDrr(campaignMetrics.spend, campaignMetrics.revenue_ads);
      const summaryHours = summaryDays.reduce((sum, entry) => sum + entry.hours, 0);
      const summaryMaxIncidentHours = Math.max(...summaryDays.map((entry) => entry.maxIncidentHours || 0), summary.maxIncidentHours || 0);
      const summaryIncidents = summaryDays.reduce((sum, entry) => sum + entry.incidents, 0);
      const summaryEstimatedGap = summaryDays
        .map((entry) => entry.estimatedGap)
        .filter((value) => value !== null && Number.isFinite(value))
        .reduce((sum, value) => sum + value, 0);
      const current = aggregated.get(summary.kind) || {
        kind: summary.kind,
        title: summary.label,
        hours: 0,
        max_incident_hours: 0,
        incidents: 0,
        days: [],
        orders_ads: 0,
        total_orders: productRangeMetrics.total_orders,
        drr_overall: null,
        spend: 0,
        estimated_gap: 0,
        campaign_ids: [],
        campaign_labels: [],
        campaigns: [],
        campaignIdSet: new Set(),
        campaignLabelSet: new Set(),
      };
      current.hours += summaryHours;
      current.max_incident_hours = Math.max(current.max_incident_hours || 0, summaryMaxIncidentHours);
      current.incidents += summaryIncidents;
      current.orders_ads += campaignMetrics.orders_ads;
      current.spend += campaignMetrics.spend;
      if (summaryEstimatedGap > 0) {
        current.estimated_gap = (current.estimated_gap || 0) + summaryEstimatedGap;
      }
      summaryDays.forEach((entry) => {
        let currentDay = current.days.find((dayEntry) => dayEntry.day === entry.day);
        if (!currentDay) {
          currentDay = {
            day: entry.day,
            label: entry.label,
            hours: 0,
            max_incident_hours: 0,
            incidents: 0,
            estimated_gap: 0,
          };
          current.days.push(currentDay);
        }
        currentDay.hours += entry.hours;
        currentDay.max_incident_hours = Math.max(currentDay.max_incident_hours || 0, entry.maxIncidentHours || 0);
        currentDay.incidents += entry.incidents;
        if (entry.estimatedGap !== null) {
          currentDay.estimated_gap = (currentDay.estimated_gap || 0) + entry.estimatedGap;
        }
      });
      if (!current.campaignIdSet.has(campaign.id)) {
        current.campaignIdSet.add(campaign.id);
        current.campaign_ids.push(campaign.id);
        current.campaigns.push(buildIssueCampaignMeta(campaign, {
          hours: summaryHours,
          max_incident_hours: summaryMaxIncidentHours,
          incidents: summaryIncidents,
          orders_ads: campaignMetrics.orders_ads,
          drr: campaignDrr,
          estimated_gap: summaryEstimatedGap,
        }));
      } else {
        const currentCampaign = current.campaigns.find((item) => item.id === Number(campaign.id));
        if (currentCampaign) {
          currentCampaign.hours += summaryHours;
          currentCampaign.max_incident_hours = Math.max(currentCampaign.max_incident_hours || 0, summaryMaxIncidentHours);
          currentCampaign.incidents += summaryIncidents;
          currentCampaign.orders_ads += campaignMetrics.orders_ads;
          currentCampaign.drr = Number.isFinite(campaignDrr) ? campaignDrr : currentCampaign.drr;
          currentCampaign.estimated_gap =
            summaryEstimatedGap > 0
              ? (currentCampaign.estimated_gap || 0) + summaryEstimatedGap
              : currentCampaign.estimated_gap;
        }
      }
      const campaignLabel = formatIssueCampaignName(campaign);
      if (!current.campaignLabelSet.has(campaignLabel)) {
        current.campaignLabelSet.add(campaignLabel);
        current.campaign_labels.push(campaignLabel);
      }
      aggregated.set(summary.kind, current);
    }
  }

  return CATALOG_ISSUE_KIND_ORDER
    .map((kind) => aggregated.get(kind))
    .filter(Boolean)
    .map(({ campaignIdSet: _campaignIdSet, campaignLabelSet: _campaignLabelSet, spend, ...item }) => {
      const drrOverall = computeDrr(spend, productRangeMetrics.total_revenue);
      return {
        ...item,
        total_orders: Number.isFinite(item.total_orders) ? item.total_orders : null,
        drr_overall: Number.isFinite(drrOverall) ? drrOverall : null,
        estimated_gap: typeof item.estimated_gap === "number" && Number.isFinite(item.estimated_gap) && item.estimated_gap > 0 ? item.estimated_gap : null,
        days: item.days
          .map((day) => ({
            ...day,
            estimated_gap:
              typeof day.estimated_gap === "number" && Number.isFinite(day.estimated_gap) && day.estimated_gap > 0
                ? day.estimated_gap
                : null,
          }))
          .sort((left, right) => left.day.localeCompare(right.day)),
        campaigns: item.campaigns
          .map((campaign) => ({
            ...campaign,
            drr: typeof campaign.drr === "number" && Number.isFinite(campaign.drr) ? campaign.drr : null,
            estimated_gap:
              typeof campaign.estimated_gap === "number" && Number.isFinite(campaign.estimated_gap) && campaign.estimated_gap > 0
                ? campaign.estimated_gap
                : null,
          }))
          .sort((left, right) => {
            const hoursDiff = right.hours - left.hours;
            if (hoursDiff !== 0) {
              return hoursDiff;
            }
            const maxIncidentDiff = (right.max_incident_hours || 0) - (left.max_incident_hours || 0);
            if (maxIncidentDiff !== 0) {
              return maxIncidentDiff;
            }
            const incidentsDiff = right.incidents - left.incidents;
            if (incidentsDiff !== 0) {
              return incidentsDiff;
            }
            return String(left.label || "").localeCompare(String(right.label || ""), "ru");
          }),
      };
    });
}

async function collectSingleCatalogIssue(client, [shopId, productId], options = {}) {
  const limitActivityOnly = options.scope === "limit_activity";
  const productRef = `${shopId}:${productId}`;
  const stata = await client.productStata(shopId, productId);
  const allCampaignRows = stata?.campaign_wb || [];
  const campaignRows = limitActivityOnly
    ? allCampaignRows.filter((campaign) => {
      const displayStatus = resolveCampaignDisplayStatus(normalizeCampaignStatusCode(campaign));
      return displayStatus === "active" || displayStatus === "paused";
    })
    : allCampaignRows;
  const campaignIds = campaignRows.map((campaign) => campaign?.id).filter((value) => value !== null && value !== undefined);
  if (!campaignIds.length) {
    return { product_ref: productRef, issues: [], campaigns: [] };
  }

  const [dailyExactPayload] = limitActivityOnly
    ? [{}, null]
    : await safeCall(
      () => client.campaignDailyExact(shopId, productId, campaignIds, client.range.current_start, client.range.current_end),
      {},
    );
  const [productDailyStats] = limitActivityOnly
    ? [[], null]
    : await safeCall(
      () => client.productStatsByDay(shopId, productId, client.range.current_start, client.range.current_end),
      [],
    );

  const campaigns = await mapWithConcurrency(
    campaignRows,
    Math.min(2, Math.max(campaignRows.length, 1)),
    async (campaign) => {
      const campaignId = campaign?.id;
      const [pausePayload] = await safeCall(
        () => client.campaignStatusPauseHistory(shopId, productId, Number(campaignId), 120),
        {},
      );
      const [schedulePayload, scheduleError] = limitActivityOnly
        ? [{}, null]
        : await safeCall(() => client.campaignSchedule(shopId, productId, Number(campaignId)), {});
      return {
        id: campaignId,
        name: campaign?.name ?? null,
        status: campaign?.status ?? null,
        status_xway: campaign?.status_xway ?? null,
        payment_type: campaign?.payment_type ?? null,
        auction_mode: campaign?.auction_mode ?? null,
        auto_type: campaign?.auto_type ?? null,
        unified: Boolean(campaign?.unified),
        min_cpm: campaign?.min_cpm ?? null,
        mp_bid: campaign?.mp_bid ?? null,
        min_cpm_recom: campaign?.min_cpm_recom ?? null,
        mp_recom_bid: campaign?.mp_recom_bid ?? null,
        daily_exact: dailyExactPayload?.[String(campaignId)] || [],
        schedule_config: limitActivityOnly || scheduleError ? null : normalizeSchedule(schedulePayload || {}),
        status_logs: {
          pause_history: normalizeStatusPauseHistory(pausePayload || {}),
        },
      };
    },
  );

  return {
    product_ref: productRef,
    issues: aggregateCatalogIssueSummaries(campaigns, productDailyStats, iterIsoDays(client.range.current_start, client.range.current_end)),
    campaigns: campaigns.map((campaign) => buildIssueCampaignMeta(campaign)),
  };
}

export async function collectCatalogIssues(env, { productRefs = [], start = null, end = null, forceRefresh = false, cursor = null, limitProducts = null, deadlineMs = null, scope = null } = {}) {
  const client = new XwayApiClient(env, { start, end, forceRefresh });
  const parsedRefs = parseCatalogChartProductRefs(productRefs);
  const cursorIndex = normalizeCursor(cursor, parsedRefs.length);
  const remainingRefs = parsedRefs.slice(cursorIndex);
  const maxProducts = normalizeLimit(limitProducts, remainingRefs.length, remainingRefs.length || 1);
  const targetRefs = remainingRefs.slice(0, maxProducts);
  const normalizedDeadlineMs = normalizeDeadlineMs(deadlineMs);
  const startedAt = Date.now();
  const rows = [];
  let processedProductsCount = 0;

  const fetchConcurrency = scope === "limit_activity" ? 1 : CATALOG_ISSUES_FETCH_CONCURRENCY;
  for (let index = 0; index < targetRefs.length; index += fetchConcurrency) {
    const batch = targetRefs.slice(index, index + fetchConcurrency);
    const batchRows = await mapWithConcurrency(batch, fetchConcurrency, async (ref) => {
      try {
        return await collectSingleCatalogIssue(client, ref, { scope });
      } catch (error) {
        const [shopId, productId] = ref;
        return {
          product_ref: `${shopId}:${productId}`,
          issues: [],
          campaigns: [],
          error: error instanceof Error ? error.message : String(error || "Unknown error"),
        };
      }
    });
    rows.push(...batchRows);
    processedProductsCount += batch.length;
    if (
      processedProductsCount >= CATALOG_ISSUES_MIN_PROCESSED_BEFORE_DEADLINE &&
      Date.now() - startedAt >= normalizedDeadlineMs &&
      cursorIndex + processedProductsCount < parsedRefs.length
    ) {
      break;
    }
  }

  const nextIndex = cursorIndex + processedProductsCount;
  const complete = nextIndex >= parsedRefs.length;

  return {
    ok: true,
    generated_at: new Date().toISOString().slice(0, 10),
    range: client.range,
    rows,
    requested_products: parsedRefs.map(([shopId, productId]) => `${shopId}:${productId}`),
    loaded_products_count: rows.length,
    processed_products_count: processedProductsCount,
    remaining_products_count: Math.max(parsedRefs.length - nextIndex, 0),
    complete,
    next_cursor: complete ? null : String(nextIndex),
  };
}
