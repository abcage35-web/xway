import { normalizeStatusPauseHistory } from "./products.js";
import { XwayApiClient } from "./xway-client.js";
import { mapWithConcurrency, parseCatalogChartProductRefs } from "./utils.js";

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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
    .flatMap((value) => String(value || "").split(/[;,/]/))
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
          incidents: 0,
          days: [],
        };
        current.hours += durationHours;
        current.incidents += 1;
        let dayEntry = current.days.find((item) => item.day === day.day);
        if (!dayEntry) {
          dayEntry = { day: day.day, label: day.label, hours: 0, incidents: 0, estimatedGap: null };
          current.days.push(dayEntry);
        }
        dayEntry.hours += durationHours;
        dayEntry.incidents += 1;
        summaries.set(kind, current);
      });
    });
  });

  return ["budget", "limit"]
    .map((kind) => summaries.get(kind))
    .filter(Boolean)
    .map((summary) => {
      const days = summary.days
        .map((dayEntry) => {
          const totalStoppedHours = totalStoppedHoursByDay.get(dayEntry.day) || 0;
          const activeHours = Math.max(24 - totalStoppedHours, 0);
          const dailyExpense = dailyExpenseByDay.get(dayEntry.day) ?? null;
          const estimatedGap =
            dailyExpense !== null && dailyExpense > 0 && activeHours > 0
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
  return normalized || null;
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
  if (normalized === "ACTIVE") {
    return "active";
  }
  if (normalized === "FROZEN") {
    return "freeze";
  }
  if (normalized === "PAUSED") {
    return "paused";
  }
  return "muted";
}

function buildIssueCampaignMeta(campaign) {
  const statusCode = normalizeCampaignStatusCode(campaign);
  return {
    id: Number(campaign?.id),
    label: formatIssueCampaignName(campaign),
    payment_type: resolveCampaignPaymentType(campaign),
    zone_kind: resolveCampaignZoneKind(campaign),
    status_code: statusCode,
    status_label: formatCampaignStatusLabel(statusCode),
    display_status: resolveCampaignDisplayStatus(statusCode),
  };
}

function aggregateCatalogIssueSummaries(campaigns, yesterday) {
  const aggregated = new Map();
  for (const campaign of campaigns || []) {
    const yesterdayStatusDay = buildCampaignYesterdayStatusDay(campaign, yesterday);
    const campaignIssues = buildCampaignIssueSummaries(campaign, [yesterdayStatusDay]);
    for (const summary of campaignIssues) {
      const dayEntry = summary.days.find((entry) => entry.day === yesterday);
      if (!dayEntry) {
        continue;
      }
      const current = aggregated.get(summary.kind) || {
        kind: summary.kind,
        title: summary.label,
        hours: 0,
        incidents: 0,
        estimated_gap: 0,
        campaign_ids: [],
        campaign_labels: [],
        campaigns: [],
        campaignIdSet: new Set(),
        campaignLabelSet: new Set(),
      };
      current.hours += dayEntry.hours;
      current.incidents += dayEntry.incidents;
      if (dayEntry.estimatedGap !== null) {
        current.estimated_gap = (current.estimated_gap || 0) + dayEntry.estimatedGap;
      }
      if (!current.campaignIdSet.has(campaign.id)) {
        current.campaignIdSet.add(campaign.id);
        current.campaign_ids.push(campaign.id);
        current.campaigns.push(buildIssueCampaignMeta(campaign));
      }
      const campaignLabel = formatIssueCampaignName(campaign);
      if (!current.campaignLabelSet.has(campaignLabel)) {
        current.campaignLabelSet.add(campaignLabel);
        current.campaign_labels.push(campaignLabel);
      }
      aggregated.set(summary.kind, current);
    }
  }

  return ["budget", "limit"]
    .map((kind) => aggregated.get(kind))
    .filter(Boolean)
    .map(({ campaignIdSet: _campaignIdSet, campaignLabelSet: _campaignLabelSet, ...item }) => ({
      ...item,
      estimated_gap: typeof item.estimated_gap === "number" && Number.isFinite(item.estimated_gap) && item.estimated_gap > 0 ? item.estimated_gap : null,
    }));
}

async function collectSingleCatalogIssue(client, [shopId, productId]) {
  const productRef = `${shopId}:${productId}`;
  const stata = await client.productStata(shopId, productId);
  const campaignRows = stata?.campaign_wb || [];
  const campaignIds = campaignRows.map((campaign) => campaign?.id).filter((value) => value !== null && value !== undefined);
  if (!campaignIds.length) {
    return { product_ref: productRef, issues: [] };
  }

  const [dailyExactPayload] = await safeCall(
    () => client.campaignDailyExact(shopId, productId, campaignIds, client.range.current_start, client.range.current_end),
    {},
  );

  const campaigns = await mapWithConcurrency(
    campaignRows,
    Math.min(2, Math.max(campaignRows.length, 1)),
    async (campaign) => {
      const campaignId = campaign?.id;
      const [pausePayload] = await safeCall(
        () => client.campaignStatusPauseHistoryFull(shopId, productId, Number(campaignId), { initialLimit: 120, targetStart: client.range.current_start }),
        {},
      );
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
        status_logs: {
          pause_history: normalizeStatusPauseHistory(pausePayload || {}),
        },
      };
    },
  );

  return {
    product_ref: productRef,
    issues: aggregateCatalogIssueSummaries(campaigns, client.range.current_start),
  };
}

export async function collectCatalogIssues(env, { productRefs = [], start = null, end = null } = {}) {
  const client = new XwayApiClient(env, { start, end });
  const parsedRefs = parseCatalogChartProductRefs(productRefs);
  const rows = await mapWithConcurrency(parsedRefs, 2, async (ref) => collectSingleCatalogIssue(client, ref));

  return {
    ok: true,
    generated_at: new Date().toISOString().slice(0, 10),
    range: client.range,
    rows: rows.filter((row) => (row.issues || []).length > 0),
    requested_products: parsedRefs.map(([shopId, productId]) => `${shopId}:${productId}`),
    loaded_products_count: rows.length,
  };
}
