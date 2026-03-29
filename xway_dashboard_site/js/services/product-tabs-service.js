import {
  BIDLOG_COLUMNS,
  BUDGET_HISTORY_COLUMNS,
  CLUSTER_BID_COLUMNS,
  CLUSTER_DAILY_COLUMNS,
  CLUSTER_HISTORY_COLUMNS,
  DAILY_COLUMNS,
  SCHEDULE_COVERAGE_BASELINE,
} from "../constants.js";
import { escapeHtml, formatDateLabel, formatMoney, formatNumber, formatPercent, localIsoDate, parseIsoDate, safeNumber } from "../formatters.js";
import {
  buildSection,
  emptyBlock,
  renderCampaignInlineMetricColumn,
  renderCampaignMetricCard,
  renderDataTable,
  renderScheduleMatrix,
  tagMarkup,
} from "./ui-render.js";

export function createProductTabsService(deps) {
  const {
    buildCampaignDailyRows,
    buildChartsSection,
    campaignCompareStore,
    clusterDetailCache,
    computeCpm,
    computeRate,
    metricState,
    modalBody,
    modalNote,
    modalShell,
    modalTitle,
    normalizeProductTab,
    productStore,
    renderCampaignCharts,
    shortText,
    startDateInput,
    endDateInput,
    getOverviewSectionCollapsed,
    syncModalLock,
  } = deps;

  function findCampaignById(product, campaignId) {
    return ((product?.campaigns) || []).find((campaign) => String(campaign.id) === String(campaignId)) || null;
  }

function campaignRiskState(campaign) {
  const dayLimit = (campaign.spend_limits?.items || []).find((item) => item.period === "DAY") || (campaign.spend_limits?.items || [])[0];
  if (!dayLimit || dayLimit.remaining === null || dayLimit.limit === null || !Number(dayLimit.limit)) {
    return "neutral";
  }
  const ratio = Number(dayLimit.remaining) / Number(dayLimit.limit);
  if (ratio <= 0.15) {
    return "risk";
  }
  if (ratio <= 0.35) {
    return "warn";
  }
  return "good";
}

function campaignProgressMetrics(currentValue, totalValue) {
  const current = safeNumber(currentValue, null);
  const total = safeNumber(totalValue, null);
  if (current === null || total === null || total <= 0) {
    return {
      current,
      total,
      ratio: 0,
      ratioRaw: null,
      percentText: "",
      isOverflow: false,
    };
  }
  const ratioRaw = current / total;
  return {
    current,
    total,
    ratio: Math.max(0, Math.min(ratioRaw, 1)),
    ratioRaw,
    percentText: `${formatNumber(ratioRaw * 100, 0)}%`,
    isOverflow: ratioRaw > 1,
  };
}

function progressTooltipAttrs(title, lines = []) {
  return `data-chart-tip="1" data-chart-title="${escapeHtml(title || "—")}" data-chart-lines="${escapeHtml(JSON.stringify(lines || []))}"`;
}

function renderCampaignBudgetProgressCard({
  title,
  currentValue,
  totalValue,
  tone = "good",
  actionMarkup = "",
  metaRows = [],
  totalFallbackText = "без лимита",
} = {}) {
  const progress = campaignProgressMetrics(currentValue, totalValue);
  const currentText = progress.current === null ? "—" : formatMoney(progress.current);
  const totalText = progress.total === null ? totalFallbackText : formatMoney(progress.total);
  const safeMetaRows = (metaRows || []).filter((row) => row && (row.label || row.value));
  const tooltipLines = [
    `Текущее значение: ${currentText}`,
    `Лимит: ${totalText}`,
    ...(progress.percentText ? [`Заполнение: ${progress.percentText}`] : []),
    ...safeMetaRows.map((row) => `${row.label}: ${row.value}`),
  ];

  return `
    <div class="mini-stat campaign-budget-progress-card tone-${escapeHtml(tone)}${progress.isOverflow ? " is-overflow" : ""}">
      <div class="campaign-budget-progress-head">
        <div class="campaign-budget-progress-copy">
          <span class="campaign-budget-progress-label">${escapeHtml(title || "—")}</span>
        </div>
        <div class="campaign-budget-progress-side">
          <div class="campaign-budget-progress-values">
            <strong class="campaign-budget-progress-current">${escapeHtml(currentText)}</strong>
            <span class="campaign-budget-progress-total">/ ${escapeHtml(totalText)}</span>
            ${progress.percentText ? `<b class="campaign-budget-progress-percent">${escapeHtml(progress.percentText)}</b>` : ""}
          </div>
          ${actionMarkup ? `<div class="campaign-budget-progress-action">${actionMarkup}</div>` : ""}
        </div>
      </div>
      <div class="chart-shell campaign-budget-progress-shell">
        <div
          class="campaign-budget-progress-track"
          ${progressTooltipAttrs(title, tooltipLines)}
        >
          <span class="campaign-budget-progress-fill" style="width:${(progress.ratio * 100).toFixed(2)}%"></span>
        </div>
        <div class="chart-tooltip" hidden></div>
      </div>
      ${safeMetaRows.length ? `
        <div class="campaign-budget-progress-meta">
          ${safeMetaRows
            .map((row) => `
              <div class="campaign-budget-progress-meta-row">
                <span>${escapeHtml(row.label || "—")}</span>
                <strong>${escapeHtml(row.value || "—")}</strong>
              </div>
            `)
            .join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function compactIntervalLabel(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "—";
  }
  const parts = text.split(",");
  if (parts.length >= 2) {
    const datePart = parts[0].trim();
    const timePart = parts.slice(1).join(",").trim();
    const normalizedDate = /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(datePart)
      ? datePart.slice(0, 5)
      : datePart;
    return timePart ? `${normalizedDate} ${timePart}` : normalizedDate;
  }
  return text;
}

const SCHEDULE_WEEKDAY_KEYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const SCHEDULE_DAY_LABELS = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"];
const CAMPAIGN_ACTIVITY_STATUS_ORDER = ["active", "freeze", "paused"];
const CAMPAIGN_ACTIVITY_STATUS_META = {
  active: { label: "Активна", glyph: "✓" },
  freeze: { label: "Заморожена", glyph: "❄" },
  paused: { label: "Приостановлена", glyph: "⏸" },
};

function hasBudgetLimitReason(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .split(",")
    .some((token) => /budget|бюджет|day_budget|limit|лимит|расход/.test(token.trim()));
}

function campaignActivityDayEntry(value) {
  if (value && typeof value === "object" && value.statuses instanceof Set) {
    return {
      statuses: value.statuses,
      intervals: Array.isArray(value.intervals) ? value.intervals : [],
      hasSpendLimit: Boolean(value.hasSpendLimit),
    };
  }
  if (value instanceof Set) {
    return {
      statuses: value,
      intervals: [],
      hasSpendLimit: false,
    };
  }
  return {
    statuses: new Set(),
    intervals: [],
    hasSpendLimit: false,
  };
}

function collectCampaignActivityReasonLabels(item) {
  const labels = pauseReasonLabels(item);
  const pausedUser = String(item?.paused_user || "").trim();
  if (!pausedUser) {
    return labels;
  }
  return Array.from(new Set([
    ...labels.filter((label) => label !== "Пользователь"),
    `Пользователь: ${pausedUser}`,
  ]));
}

function campaignActivityHasSpendLimit(item) {
  const reasonValues = [
    ...(Array.isArray(item?.pause_reasons) ? item.pause_reasons : []),
    item?.paused_limiter,
  ];
  return reasonValues.some((value) => hasBudgetLimitReason(value));
}

function formatCampaignActivityClockLabel(date, options = {}) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "—";
  }
  if (options.endOfDay && date.getHours() === 0 && date.getMinutes() === 0) {
    return "24:00";
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function mergeCampaignDayIntervals(intervals = []) {
  return (intervals || [])
    .filter((interval) => interval?.statusKey && interval?.startAt instanceof Date && interval?.endAt instanceof Date)
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime())
    .reduce((merged, interval) => {
      const previous = merged[merged.length - 1];
      if (
        previous
        && previous.statusKey === interval.statusKey
        && interval.startAt.getTime() <= previous.endAt.getTime()
      ) {
        previous.endAt = new Date(Math.max(previous.endAt.getTime(), interval.endAt.getTime()));
        previous.reasons = Array.from(new Set([...(previous.reasons || []), ...(interval.reasons || [])]));
        return merged;
      }
      merged.push({
        ...interval,
        startAt: new Date(interval.startAt),
        endAt: new Date(interval.endAt),
        reasons: Array.from(new Set(interval.reasons || [])),
      });
      return merged;
    }, []);
}

function renderCampaignActivityStatusSlots(statuses = []) {
  return CAMPAIGN_ACTIVITY_STATUS_ORDER
    .map((statusKey) => {
      const meta = CAMPAIGN_ACTIVITY_STATUS_META[statusKey];
      const isActive = statuses.includes(statusKey);
      return `<span class="campaign-activity-icon status-${escapeHtml(statusKey)}${isActive ? " is-active" : " is-empty"}" aria-hidden="true">${isActive ? escapeHtml(meta.glyph) : ""}</span>`;
    })
    .join("");
}

function mergeStatusNameField(...values) {
  const parts = [];
  values.forEach((value) => {
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => {
        if (!parts.includes(item)) {
          parts.push(item);
        }
      });
  });
  return parts.join(", ");
}

function formatStatusDateTimeValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "";
  }
  return `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.${date.getFullYear()}, ${formatCampaignActivityClockLabel(date)}`;
}

function formatStatusIntervalEndValue(endAt, startAt) {
  if (!(endAt instanceof Date) || Number.isNaN(endAt.getTime())) {
    return "";
  }
  if (startAt instanceof Date && !Number.isNaN(startAt.getTime()) && startAt.toDateString() === endAt.toDateString()) {
    return formatCampaignActivityClockLabel(endAt);
  }
  return formatStatusDateTimeValue(endAt);
}

function mergePauseHistoryDisplayIntervals(intervals = []) {
  return (intervals || [])
    .filter((item) => item?.start || item?.end || item?.status)
    .reduce((merged, item) => {
      const startAt = parseStatusDateTimeValue(item?.start);
      const endAt = startAt ? parseCampaignIntervalEnd(item, startAt) : null;
      const statusKey = campaignActivityStatusKey(item);
      const normalizedItem = {
        ...item,
        pause_reasons: Array.isArray(item?.pause_reasons) ? [...item.pause_reasons] : [],
        _startAt: startAt,
        _endAt: endAt,
        _statusKey: statusKey,
      };
      const previous = merged[merged.length - 1];
      if (
        previous
        && previous._statusKey
        && previous._statusKey === statusKey
        && startAt instanceof Date
        && endAt instanceof Date
        && previous._startAt instanceof Date
        && endAt.getTime() >= previous._startAt.getTime()
      ) {
        previous._startAt = startAt < previous._startAt ? startAt : previous._startAt;
        previous.start = formatStatusDateTimeValue(previous._startAt);
        previous.end = formatStatusIntervalEndValue(previous._endAt, previous._startAt);
        previous.pause_reasons = Array.from(new Set([...(previous.pause_reasons || []), ...(normalizedItem.pause_reasons || [])]));
        previous.paused_user = mergeStatusNameField(previous.paused_user, normalizedItem.paused_user);
        previous.unpaused_user = mergeStatusNameField(previous.unpaused_user, normalizedItem.unpaused_user);
        previous.stopped_user = mergeStatusNameField(previous.stopped_user, normalizedItem.stopped_user);
        previous.paused_limiter = mergeStatusNameField(previous.paused_limiter, normalizedItem.paused_limiter);
        previous.is_freeze = Boolean(previous.is_freeze) || Boolean(normalizedItem.is_freeze);
        previous.is_unfreeze = Boolean(previous.is_unfreeze) || Boolean(normalizedItem.is_unfreeze);
        return merged;
      }
      normalizedItem.start = formatStatusDateTimeValue(startAt);
      normalizedItem.end = formatStatusIntervalEndValue(endAt, startAt);
      merged.push(normalizedItem);
      return merged;
    }, [])
    .map((item) => {
      const normalized = { ...item };
      delete normalized._startAt;
      delete normalized._endAt;
      delete normalized._statusKey;
      return normalized;
    });
}

function campaignMergedPauseHistoryIntervals(campaign) {
  const pauseHistory = campaign?.status_logs?.pause_history || {};
  return Array.isArray(pauseHistory.merged_intervals) ? pauseHistory.merged_intervals : (pauseHistory.intervals || []);
}

function normalizeScheduleLabel(value) {
  return String(value || "").trim().toUpperCase();
}

function buildCampaignScheduleMatrix(scheduleConfig = {}) {
  const sourceDays = Array.isArray(scheduleConfig?.days) ? scheduleConfig.days : [];
  if (!scheduleConfig?.schedule_active) {
    return {
      days: SCHEDULE_DAY_LABELS.map((label) => ({
        label,
        hours: Array.from({ length: 24 }, () => ({ active: false })),
      })),
      max_count: 1,
    };
  }

  const dayByLabel = new Map(
    sourceDays.map((day) => [normalizeScheduleLabel(day?.label), day]),
  );

  const normalizedDays = SCHEDULE_DAY_LABELS.map((fallbackLabel, index) => {
    const sourceDay = dayByLabel.get(fallbackLabel) || sourceDays[index] || {};
    const sourceHours = Array.isArray(sourceDay?.hours) ? sourceDay.hours : [];
    const normalizedHours = Array.from({ length: 24 }, (_, hourIndex) => {
      const sourceCell = sourceHours[hourIndex];
      const active = sourceCell && typeof sourceCell === "object"
        ? Boolean(sourceCell.active)
        : Boolean(sourceCell);
      return { active };
    });
    return {
      label: sourceDay?.label || fallbackLabel,
      hours: normalizedHours,
    };
  });

  return { days: normalizedDays, max_count: 1 };
}

function buildCampaignActivityDays(product) {
  const start = parseIsoDate(product?.period?.current_start);
  const end = parseIsoDate(product?.period?.current_end);
  if (start && end && end >= start) {
    const days = [];
    for (let cursor = new Date(start); cursor <= end; cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)) {
      days.push(localIsoDate(cursor));
    }
    return days;
  }
  const uniqueDays = Array.from(new Set((product?.daily_stats || []).map((row) => String(row?.day || "")).filter(Boolean))).sort();
  return uniqueDays;
}

function campaignActivityStatusKey(item) {
  if (item?.is_freeze) {
    return "freeze";
  }
  const status = String(item?.status || "").toLowerCase();
  const reasons = [
    ...(Array.isArray(item?.pause_reasons) ? item.pause_reasons : []),
    item?.paused_limiter,
  ]
    .map((token) => String(token || "").toLowerCase())
    .join(" ");
  if (/актив|active/.test(status)) {
    return "active";
  }
  if (
    /приост|pause|paused|stop|неактив|inactive/.test(status)
    || /schedule|распис|budget|бюджет|limit|лимит/.test(reasons)
    || Boolean(item?.paused_limiter)
    || Boolean(item?.paused_user)
  ) {
    return "paused";
  }
  return null;
}

function campaignBaseStatusKey(campaign) {
  const status = String(campaign?.status || "").toLowerCase();
  if (/актив|active/.test(status)) {
    return "active";
  }
  if (/заморож|freeze/.test(status)) {
    return "freeze";
  }
  if (/приост|pause|paused|stop|неактив|inactive/.test(status)) {
    return "paused";
  }
  return null;
}

function parseCampaignIntervalEnd(item, startAt) {
  const rawEnd = String(item?.end || "").trim();
  if (!rawEnd) {
    return new Date();
  }
  const parsed = parseStatusDateTimeValue(rawEnd, {
    fallbackDate: startAt,
    fallbackYear: startAt?.getFullYear?.(),
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

function buildCampaignActivityStatusByDay(campaign, isoDays = []) {
  const map = new Map(
    isoDays.map((day) => [day, {
      statuses: new Set(),
      intervals: [],
      hasSpendLimit: false,
    }]),
  );
  if (!isoDays.length) {
    return map;
  }
  const dayRanges = isoDays
    .map((isoDay) => {
      const dayStart = parseIsoDate(isoDay);
      if (!dayStart) {
        return null;
      }
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      return { isoDay, dayStart, dayEnd };
    })
    .filter(Boolean);
  const freezeMinutesByDay = new Map();
  const anchorDay = isoDays[isoDays.length - 1] || isoDays[0];
  const anchorYear = parseIsoDate(anchorDay)?.getFullYear() || new Date().getFullYear();

  campaignMergedPauseHistoryIntervals(campaign).forEach((item) => {
    const statusKey = campaignActivityStatusKey(item);
    if (!statusKey) {
      return;
    }
    const startAt = parseStatusDateTimeValue(item?.start, { fallbackYear: anchorYear });
    if (!startAt) {
      return;
    }
    const endAt = parseCampaignIntervalEnd(item, startAt);
    dayRanges.forEach((range) => {
      const overlapStart = Math.max(startAt.getTime(), range.dayStart.getTime());
      const overlapEnd = Math.min(endAt.getTime(), range.dayEnd.getTime());
      if (overlapEnd > overlapStart) {
        const entry = map.get(range.isoDay);
        entry?.statuses.add(statusKey);
        if (campaignActivityHasSpendLimit(item)) {
          entry.hasSpendLimit = true;
        }
        entry?.intervals.push({
          statusKey,
          startAt: new Date(overlapStart),
          endAt: new Date(overlapEnd),
          reasons: collectCampaignActivityReasonLabels(item),
        });
        if (statusKey === "freeze") {
          const durationMinutes = (overlapEnd - overlapStart) / 60000;
          freezeMinutesByDay.set(
            range.isoDay,
            safeNumber(freezeMinutesByDay.get(range.isoDay), 0) + durationMinutes,
          );
        }
      }
    });
  });

  dayRanges.forEach((range) => {
    const fullDayFreeze = safeNumber(freezeMinutesByDay.get(range.isoDay), 0) >= (24 * 60 - 1);
    if (!fullDayFreeze) {
      return;
    }
    const entry = map.get(range.isoDay);
    entry?.statuses.delete("active");
    if (entry?.intervals?.length) {
      entry.intervals = entry.intervals.filter((interval) => interval.statusKey !== "active");
    }
  });

  const baseKey = campaignBaseStatusKey(campaign);
  if (baseKey) {
    dayRanges.forEach((range) => {
      const entry = map.get(range.isoDay);
      if (!(entry?.statuses?.size > 0)) {
        entry?.statuses.add(baseKey);
      }
    });
  }

  map.forEach((entry) => {
    if (entry?.intervals?.length) {
      entry.intervals = mergeCampaignDayIntervals(entry.intervals);
    }
  });

  return map;
}

function campaignActivityTooltipAttrs(dayIso, campaign, entryValue) {
  const entry = campaignActivityDayEntry(entryValue);
  const statuses = CAMPAIGN_ACTIVITY_STATUS_ORDER.filter((key) => entry.statuses.has(key));
  const title = `${compactStatusDayLabel(formatDateLabel(dayIso))} • ID ${campaign.id}`;
  const intervalLines = (entry.intervals || []).map((interval) => {
    const meta = CAMPAIGN_ACTIVITY_STATUS_META[interval.statusKey] || { glyph: "•", label: interval.statusKey };
    const reasonSuffix = interval.reasons?.length ? ` • ${interval.reasons.join(", ")}` : "";
    return `${meta.glyph} ${meta.label}: ${formatCampaignActivityClockLabel(interval.startAt)} → ${formatCampaignActivityClockLabel(interval.endAt, { endOfDay: true })}${reasonSuffix}`;
  });
  const lines = intervalLines.length
    ? [
      `РК: ${campaign.id}`,
      ...(entry.hasSpendLimit ? ["Финстоп: лимит расходов / бюджета"] : []),
      ...intervalLines,
    ]
    : [
      `РК: ${campaign.id}`,
      ...(entry.hasSpendLimit ? ["Финстоп: лимит расходов / бюджета"] : []),
      `Статусы: ${statuses.length ? statuses.map((key) => CAMPAIGN_ACTIVITY_STATUS_META[key]?.label || key).join(", ") : "Нет данных"}`,
    ];
  return `data-chart-tip="1" data-chart-title="${escapeHtml(title)}" data-chart-lines="${escapeHtml(JSON.stringify(lines))}"`;
}

function renderCampaignActivityTimeline(product, campaigns = []) {
  const days = buildCampaignActivityDays(product);
  if (!days.length || !campaigns.length) {
    return "";
  }
  const columnsStyle = `grid-template-columns: repeat(${days.length}, minmax(24px, 1fr));`;
  const dayAlertSet = new Set();
  const rows = campaigns
    .map((campaign) => {
      const dayStatusMap = buildCampaignActivityStatusByDay(campaign, days);
      const cells = days
        .map((day) => {
          const entry = campaignActivityDayEntry(dayStatusMap.get(day));
          if (entry.hasSpendLimit) {
            dayAlertSet.add(day);
          }
          const statuses = CAMPAIGN_ACTIVITY_STATUS_ORDER.filter((key) => entry.statuses.has(key));
          const dominant = statuses.includes("freeze")
            ? "freeze"
            : statuses.includes("paused")
              ? "paused"
              : statuses.includes("active")
                ? "active"
                : "none";
          const iconsMarkup = renderCampaignActivityStatusSlots(statuses);
          return `
            <div
              class="campaign-activity-cell is-${dominant}${statuses.length > 1 ? " is-mixed" : ""}${entry.hasSpendLimit ? " has-budget-alert" : ""}"
              ${campaignActivityTooltipAttrs(day, campaign, entry)}
            >
              <span class="campaign-activity-icons">${iconsMarkup}</span>
            </div>
          `;
        })
        .join("");
      return `
        <div class="campaign-activity-row">
          <span class="campaign-activity-label">ID ${escapeHtml(campaign.id)}</span>
          <div class="campaign-activity-cells" style="${columnsStyle}">
            ${cells}
          </div>
        </div>
      `;
    })
    .join("");

  const dateLabels = days
    .map((day) => `<span class="campaign-activity-date${dayAlertSet.has(day) ? " has-budget-alert" : ""}">${escapeHtml(formatDateLabel(day).slice(0, 5))}</span>`)
    .join("");

  return `
    <div class="campaign-activity-overview chart-shell">
      <div class="campaign-activity-head">
        <h4>Активность РК</h4>
      </div>
      <div class="campaign-activity-scroll">
        <div class="campaign-activity-grid">
          ${rows}
          <div class="campaign-activity-dates-row">
            <span class="campaign-activity-label dates">Даты</span>
            <div class="campaign-activity-dates" style="${columnsStyle}">
              ${dateLabels}
            </div>
          </div>
        </div>
      </div>
      <div class="chart-tooltip" hidden></div>
    </div>
  `;
}

function parseStatusDateTimeValue(value, options = {}) {
  const parts = splitStatusDateTime(value);
  const fallbackDate = options.fallbackDate instanceof Date && !Number.isNaN(options.fallbackDate.getTime())
    ? new Date(options.fallbackDate)
    : null;
  const date = parseRuDateLabel(parts.date) || fallbackDate;
  if (!date) {
    return null;
  }
  const parsed = new Date(date);
  if (parts.time) {
    const [hours, minutes] = parts.time.split(":").map((item) => Number(item));
    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
      parsed.setHours(hours, minutes, 0, 0);
    }
  } else {
    parsed.setHours(0, 0, 0, 0);
  }
  return parsed;
}

function currentPauseInterval(campaign) {
  const intervals = campaign?.status_logs?.pause_history?.intervals || [];
  if (!intervals.length) {
    return null;
  }
  return intervals.find((item) => !String(item?.end || "").trim()) || intervals[0];
}

function campaignDisplayStatus(campaign) {
  const baseStatus = String(campaign?.status || "").trim() || "—";
  const currentInterval = currentPauseInterval(campaign);
  if (currentInterval?.is_freeze) {
    return {
      label: "Заморожена",
      tone: "freeze",
    };
  }
  if (/актив/i.test(baseStatus)) {
    return {
      label: "Активна",
      tone: "good",
    };
  }
  if (/приост/i.test(baseStatus)) {
    return {
      label: "Приостановлена",
      tone: "bad",
    };
  }
  return {
    label: baseStatus,
    tone: "",
  };
}

function campaignStatusOutlineClass(displayStatus) {
  if (displayStatus?.tone === "freeze") {
    return "status-outline-freeze";
  }
  if (displayStatus?.tone === "bad") {
    return "status-outline-paused";
  }
  if (displayStatus?.tone === "good") {
    return "status-outline-active";
  }
  return "";
}

function isScheduledActiveAt(campaign, date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return false;
  }
  const schedule = campaign?.schedule_config || {};
  if (!schedule.schedule_active) {
    return false;
  }
  const weekdayKey = SCHEDULE_WEEKDAY_KEYS[date.getDay()];
  const activeHours = (schedule.hours_by_day || {})[weekdayKey] || [];
  return activeHours.includes(date.getHours());
}

function splitPauseReasonTokens(values) {
  const source = Array.isArray(values) ? values : [values];
  return source
    .flatMap((value) => String(value || "").split(/[;,/]/))
    .map((value) => value.trim())
    .filter(Boolean);
}

function isScheduleReasonToken(value) {
  return /schedule|распис/i.test(String(value || ""));
}

function isBudgetReasonToken(value) {
  return /budget|бюджет|limit|лимит|day|день/i.test(String(value || ""));
}

function translatePauseReasonToken(value) {
  const token = String(value || "").trim();
  if (!token) {
    return "";
  }
  if (isScheduleReasonToken(token)) {
    return "Расписание показов";
  }
  if (isBudgetReasonToken(token)) {
    return "Нет бюджета";
  }
  if (/freeze|замороз/i.test(token)) {
    return "Заморозка";
  }
  if (/user|пользоват/i.test(token)) {
    return "Пользователь";
  }
  return token;
}

function pauseReasonLabels(item) {
  const tokens = [
    ...splitPauseReasonTokens(item?.pause_reasons || []),
    ...splitPauseReasonTokens(item?.paused_limiter),
  ];
  if (!tokens.length && item?.paused_user) {
    tokens.push("user");
  }
  const seen = new Set();
  return tokens
    .map((token) => translatePauseReasonToken(token))
    .filter((label) => {
      if (!label || seen.has(label)) {
        return false;
      }
      seen.add(label);
      return true;
    });
}

function formatDurationMinutes(totalMinutes) {
  const minutes = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (!hours) {
    return `${minutes} мин`;
  }
  if (!restMinutes) {
    return `${hours} ч`;
  }
  return `${hours} ч ${restMinutes} мин`;
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function activeHoursForDate(campaign, date) {
  const schedule = campaign?.schedule_config || {};
  if (!schedule.schedule_active) {
    return Array.from({ length: 24 }, (_, hour) => hour);
  }
  const weekdayKey = SCHEDULE_WEEKDAY_KEYS[date.getDay()];
  return ((schedule.hours_by_day || {})[weekdayKey] || [])
    .map((hour) => Number(hour))
    .filter((hour) => Number.isFinite(hour) && hour >= 0 && hour <= 23);
}

function scheduledActiveMinutesBetween(campaign, startAt, endAt) {
  if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime())) {
    return 0;
  }
  const safeEnd = endAt instanceof Date && !Number.isNaN(endAt.getTime()) ? endAt : new Date();
  if (safeEnd <= startAt) {
    return 0;
  }
  const schedule = campaign?.schedule_config || {};
  if (!schedule.schedule_active) {
    return Math.round((safeEnd.getTime() - startAt.getTime()) / 60000);
  }
  let minutes = 0;
  for (let cursor = startOfDay(startAt); cursor <= safeEnd; cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)) {
    activeHoursForDate(campaign, cursor).forEach((hour) => {
      const hourStart = new Date(cursor);
      hourStart.setHours(hour, 0, 0, 0);
      const hourEnd = new Date(hourStart);
      hourEnd.setHours(hour + 1, 0, 0, 0);
      const overlapStart = Math.max(hourStart.getTime(), startAt.getTime());
      const overlapEnd = Math.min(hourEnd.getTime(), safeEnd.getTime());
      if (overlapEnd > overlapStart) {
        minutes += (overlapEnd - overlapStart) / 60000;
      }
    });
  }
  return Math.round(minutes);
}

function activeHoursCountForDay(campaign, isoDay) {
  const date = parseIsoDate(isoDay);
  if (!date) {
    return campaign?.schedule_config?.schedule_active ? 0 : 24;
  }
  const schedule = campaign?.schedule_config || {};
  return schedule.schedule_active ? activeHoursForDate(campaign, date).length : 24;
}

function estimateBudgetGap(campaign, campaignDailyRows, totalActiveMinutes, referenceDate = null) {
  if (!(totalActiveMinutes > 0)) {
    return null;
  }
  const cutoff = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
    ? localIsoDate(referenceDate)
    : null;
  const sourceRows = (campaignDailyRows || [])
    .filter((row) => safeNumber(row?.expense_sum, 0) > 0)
    .filter((row) => !cutoff || String(row?.day || "") <= cutoff);
  const sampleRows = sourceRows.slice(-3);
  if (!sampleRows.length) {
    return null;
  }
  const totals = sampleRows.reduce((acc, row) => {
    const activeHours = activeHoursCountForDay(campaign, row.day);
    if (activeHours > 0) {
      acc.expense += safeNumber(row.expense_sum, 0);
      acc.hours += activeHours;
    }
    return acc;
  }, { expense: 0, hours: 0 });
  if (!(totals.expense > 0) || !(totals.hours > 0)) {
    return null;
  }
  const hourlySpend = totals.expense / totals.hours;
  return hourlySpend * (totalActiveMinutes / 60);
}

function campaignBudgetPauseWarning(campaign, campaignDailyRows = []) {
  const intervals = campaign?.status_logs?.pause_history?.intervals || [];
  const budgetIntervals = intervals.map((item) => {
    const reasonTokens = [
      ...splitPauseReasonTokens(item.pause_reasons || []),
      ...splitPauseReasonTokens(item.paused_limiter),
    ];
    const hasBudgetReason = reasonTokens.some((reason) => isBudgetReasonToken(reason));
    const hasOnlyScheduleReason = reasonTokens.length > 0 && reasonTokens.every((reason) => isScheduleReasonToken(reason));
    const status = String(item.status || "").toLowerCase();
    const startAt = parseStatusDateTimeValue(item.start);
    const endAt = parseStatusDateTimeValue(item.end) || new Date();
    const pausedInActiveSlot = scheduledActiveMinutesBetween(campaign, startAt, endAt) > 0;
    const isPaused = /приост|неактив|pause|stop|freeze/i.test(status) || Boolean(item.paused_limiter);
    if (!isPaused || item.is_freeze || hasOnlyScheduleReason || !hasBudgetReason || !pausedInActiveSlot) {
      return null;
    }
    const activeMinutes = scheduledActiveMinutesBetween(campaign, startAt, endAt);
    if (!(activeMinutes > 0)) {
      return null;
    }
    return {
      item,
      startAt,
      endAt,
      activeMinutes,
    };
  }).filter(Boolean);

  if (!budgetIntervals.length) {
    return null;
  }

  const latest = budgetIntervals[0];
  const totalInactiveMinutes = budgetIntervals.reduce((sum, interval) => sum + interval.activeMinutes, 0);
  const extraBudget = estimateBudgetGap(campaign, campaignDailyRows, totalInactiveMinutes, latest.startAt);
  const latestLabel = `${compactIntervalLabel(latest.item.start)} → ${compactIntervalLabel(latest.item.end || "актуально")}`;
  const scheduleTail = campaign?.schedule_config?.schedule_active ? "по расписанию" : "за 24 часа";
  const parts = [
    `Не хватило бюджета/лимита РК: суммарно не работала ${formatDurationMinutes(totalInactiveMinutes)} в активное окно.`,
    `Последний интервал: ${latestLabel}.`,
  ];
  if (extraBudget !== null && extraBudget > 0) {
    parts.push(`Ориентировочно нужно +${formatMoney(extraBudget)} доп. бюджета, чтобы закрыть это время ${scheduleTail}.`);
  }
  return parts.join(" ");
}

function campaignCpoComparisonWarning(product, campaign) {
  const currentCpo = safeNumber(campaign?.metrics?.cpo, null);
  if (!(currentCpo > 0) || !product?.campaigns?.length) {
    return null;
  }

  const comparable = (product.campaigns || [])
    .map((item) => ({
      id: item.id,
      name: item.name || `ID ${item.id}`,
      cpo: safeNumber(item.metrics?.cpo, null),
    }))
    .filter((item) => item.cpo > 0);

  if (comparable.length < 2) {
    return null;
  }

  const best = comparable.reduce((min, item) => (item.cpo < min.cpo ? item : min), comparable[0]);
  if (String(best.id) === String(campaign.id) || currentCpo <= best.cpo) {
    return null;
  }

  const ratio = currentCpo / best.cpo;
  return `CPO выгоднее в «${best.name}» в ${formatNumber(ratio, 1)}x: ${formatMoney(best.cpo)} против ${formatMoney(currentCpo)}.`;
}

function renderCampaignWarnings(product, campaign, campaignDailyRows = []) {
  const warnings = [
    campaignBudgetPauseWarning(campaign, campaignDailyRows),
    campaignCpoComparisonWarning(product, campaign),
  ].filter(Boolean);

  return `
    <div class="warning-strip campaign-warning-strip campaign-card-group campaign-card-group-warning${warnings.length ? "" : " is-empty"}">
      ${warnings.length ? `
        <strong>Проверки</strong>
        <ul class="campaign-warning-list">
          ${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      ` : `<div class="campaign-warning-placeholder" aria-hidden="true"></div>`}
    </div>
  `;
}

function renderCampaign(campaign, baseRows = [], chartCampaign = null, product = null) {
  const chartCampaignSource = chartCampaign || campaign;
  const campaignDailyRows = buildCampaignDailyRows(chartCampaignSource, baseRows, { includeEmpty: true });
  const lastThreeCampaignDays = campaignDailyRows.slice(-3);
  const requiredDailyBudget = lastThreeCampaignDays.length
    ? lastThreeCampaignDays.reduce((sum, row) => sum + safeNumber(row.expense_sum, 0), 0) / lastThreeCampaignDays.length
    : null;
  const schedule = campaign.schedule_config || {};
  const budgetRule = campaign.budget_rule_config || {};
  const campaignSpend = safeNumber(campaign.metrics?.sum, null);
  const campaignViews = safeNumber(campaign.metrics?.views, null);
  const campaignClicks = safeNumber(campaign.metrics?.clicks, null);
  const campaignAtbs = safeNumber(campaign.metrics?.atbs, null);
  const campaignOrders = safeNumber(campaign.metrics?.orders, null);
  const campaignRevenue = safeNumber(campaign.metrics?.sum_price, null);
  const campaignCtr = campaign.metrics?.ctr;
  const campaignCpm = computeCpm(campaignSpend, campaignViews);
  const campaignCr1 = computeRate(campaign.metrics?.atbs, campaign.metrics?.clicks);
  const campaignCr2 = computeRate(campaign.metrics?.orders, campaign.metrics?.atbs);
  const campaignCpl = campaignAtbs ? Number(campaignSpend || 0) / Number(campaignAtbs) : null;
  const campaignAverageOrderPrice = campaignOrders ? Number(campaignRevenue || 0) / Number(campaignOrders) : null;
  const campaignDrrOrders = campaignAverageOrderPrice && campaignOrders
    ? (Number(campaignSpend || 0) / (campaignAverageOrderPrice * Number(campaignOrders))) * 100
    : null;
  const campaignDrrAtbs = campaignAverageOrderPrice && campaignAtbs
    ? (Number(campaignSpend || 0) / (campaignAverageOrderPrice * Number(campaignAtbs))) * 100
    : null;
  const budgetLimit = budgetRule.limit_period ? `${budgetRule.limit_period}: ${formatMoney(budgetRule.limit)}` : "—";
  const budgetTopup = budgetRule.active
    ? `${formatMoney(budgetRule.deposit)} при остатке ${formatMoney(budgetRule.threshold)}`
    : "выключено";
  const dayLimit = (campaign.spend_limits?.items || []).find((item) => item.period === "DAY") || (campaign.spend_limits?.items || [])[0];
  const remainingLimitText = dayLimit && dayLimit.remaining !== null
    ? formatMoney(dayLimit.remaining)
    : "—";
  const riskTone = campaignRiskState(campaign);
  const topupTone = budgetRule.active ? "good" : "neutral";
  const displayStatus = campaignDisplayStatus(campaign);
  const statusOutlineClass = campaignStatusOutlineClass(displayStatus);
  return `
    <article class="campaign-card tone-${riskTone}${statusOutlineClass ? ` ${statusOutlineClass}` : ""}">
      <div class="campaign-card-head campaign-card-group campaign-card-group-head">
        <div class="product-meta compact">
          ${tagMarkup(`ID ${campaign.id}`)}
          ${tagMarkup(displayStatus.label, displayStatus.tone)}
          ${tagMarkup(schedule.schedule_active ? "Расписание" : "Без расписания", schedule.schedule_active ? "good" : "")}
        </div>
        <h4>${escapeHtml(campaign.name || "Без названия")}</h4>
      </div>
      ${product ? renderCampaignWarnings(product, campaign, campaignDailyRows) : ""}
      <div class="campaign-metrics-stack campaign-card-group campaign-card-group-metrics">
        <div class="campaign-grid campaign-grid-primary campaign-card-row campaign-card-row-primary">
          ${renderCampaignMetricCard("Расход", formatMoney(campaign.metrics?.sum), "cost")}
          ${renderCampaignMetricCard("Ставка", formatMoney(campaign.bid), "traffic", [], {
            actionMarkup: `
              <button
                type="button"
                class="ghost-button mini-stat-icon-button mini-stat-icon-button-traffic"
                data-action="open-bid-history"
                data-campaign-id="${escapeHtml(campaign.id)}"
                aria-label="Открыть логи ставок"
                title="Логи ставок"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M3 12.25A.75.75 0 0 1 3.75 13H13a.75.75 0 0 1 0 1.5H3.75A.75.75 0 0 1 3 13.25Zm.3-2.22a.75.75 0 0 1 0-1.06l2.59-2.59a.75.75 0 0 1 1.06 0l1.34 1.34 3.03-3.03a.75.75 0 1 1 1.06 1.06L8.82 9.31a.75.75 0 0 1-1.06 0L6.42 7.97 4.36 10.03a.75.75 0 0 1-1.06 0Z"></path>
                </svg>
              </button>
            `,
          })}
          ${renderCampaignMetricCard("ДРР заказов (рк)", formatPercent(campaignDrrOrders), "cost")}
          ${renderCampaignMetricCard("ДРР корзин", formatPercent(campaignDrrAtbs), "cost")}
        </div>
        <div class="campaign-inline-metrics-row campaign-card-row campaign-card-row-secondary">
          ${renderCampaignInlineMetricColumn("Показы", formatNumber(campaign.metrics?.views, 0), "traffic", [
            { label: "CPM", value: formatMoney(campaignCpm) },
          ])}
          ${renderCampaignInlineMetricColumn("Клики", formatNumber(campaign.metrics?.clicks, 0), "traffic", [
            { label: "CPC", value: formatMoney(campaign.metrics?.cpc) },
            { label: "CTR", value: formatPercent(campaignCtr) },
          ])}
          ${renderCampaignInlineMetricColumn("Корзины", formatNumber(campaign.metrics?.atbs, 0), "orders", [
            { label: "CPL", value: formatMoney(campaignCpl) },
            { label: "CR1", value: formatPercent(campaignCr1) },
          ])}
          ${renderCampaignInlineMetricColumn("Заказы", formatNumber(campaign.metrics?.orders, 0), "orders", [
            { label: "CPO", value: formatMoney(campaign.metrics?.cpo) },
            { label: "CR2", value: formatPercent(campaignCr2) },
          ])}
        </div>
      </div>
      <div class="campaign-budget-grid campaign-card-group campaign-card-group-budget">
        ${renderCampaignBudgetProgressCard({
          title: "Бюджет",
          currentValue: campaign.budget,
          totalValue: budgetRule.limit,
          tone: topupTone,
          totalFallbackText: "без лимита",
          actionMarkup: `
            <button
              type="button"
              class="ghost-button mini-stat-icon-button"
              data-action="open-budget-history"
              data-campaign-id="${escapeHtml(campaign.id)}"
              aria-label="Открыть логи пополнений"
              title="Логи пополнений"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M8 2.25a.75.75 0 0 1 .75.75v4.19l2.53 1.52a.75.75 0 0 1-.78 1.28L7.62 8.29A.75.75 0 0 1 7.25 7.65V3A.75.75 0 0 1 8 2.25Z"></path>
                <path d="M8 14A6 6 0 1 0 3.1 4.54a.75.75 0 1 1-1.22-.88A7.5 7.5 0 1 1 .5 8a.75.75 0 0 1 1.5 0A6 6 0 0 0 8 14Z"></path>
              </svg>
            </button>
          `,
          metaRows: [
            { label: "Автопополнение", value: budgetTopup },
            { label: "Лимит пополнения", value: budgetLimit },
          ],
        })}
        ${renderCampaignBudgetProgressCard({
          title: "Лимит расхода",
          currentValue: dayLimit?.spent,
          totalValue: dayLimit?.limit,
          tone: riskTone,
          totalFallbackText: "не задан",
          metaRows: [
            { label: "Остаток лимита", value: remainingLimitText },
            { label: "Необходимый бюджет в день", value: formatMoney(requiredDailyBudget) },
          ],
        })}
      </div>
      <details class="campaign-inline-heatmap-panel campaign-card-group campaign-card-group-heatmap" open>
        <summary class="campaign-inline-heatmap-summary">
          <span>Heatmap РК</span>
          <small>${schedule.schedule_active ? "расписание активно" : "без расписания"}</small>
        </summary>
        <div class="campaign-inline-heatmap">
          ${renderScheduleMatrix(buildCampaignScheduleMatrix(schedule), "boolean")}
        </div>
      </details>
      ${product
        ? renderCampaignCharts(product, campaign).replace('class="campaign-charts-panel"', 'class="campaign-charts-panel campaign-card-group campaign-card-group-charts"')
        : renderCampaignCharts({ article: campaign.article, daily_stats: baseRows, campaigns: [chartCampaignSource] }, chartCampaignSource).replace('class="campaign-charts-panel"', 'class="campaign-charts-panel campaign-card-group campaign-card-group-charts"')}
      <div class="campaign-foot campaign-card-group campaign-card-group-foot">
        ${tagMarkup(`CPC ${formatMoney(campaign.metrics?.cpc)}`)}
        ${tagMarkup(`CPO ${formatMoney(campaign.metrics?.cpo)}`)}
        ${tagMarkup(`Логов ставок ${formatNumber((campaign.bid_history || []).length, 0)}`)}
        ${tagMarkup(`Пополнений ${formatNumber((campaign.budget_history || []).length, 0)}`)}
      </div>
    </article>
  `;
}

function renderCampaignSchedules(campaigns) {
  if (!campaigns.length) {
    return emptyBlock("Кампании не найдены.");
  }

  return campaigns
    .map((campaign) => {
      const schedule = campaign.schedule_config || {};
      const slots = formatNumber(schedule.active_slots, 0);
      const logs = formatNumber((campaign.bid_history || []).length, 0);
      const displayStatus = campaignDisplayStatus(campaign);
      return `
        <article class="campaign-schedule-card tone-${campaignRiskState(campaign)}">
          <div class="campaign-schedule-summary">
            <div>
              <h4>${escapeHtml(campaign.name || "Без названия")}</h4>
              <p>ID ${escapeHtml(campaign.id)} • ${schedule.schedule_active ? "расписание активно" : "расписание выключено"}</p>
            </div>
            <div class="product-meta compact">
              ${tagMarkup(`Слотов ${slots}`)}
              ${tagMarkup(`Логов ${logs}`)}
              ${tagMarkup(displayStatus.label, displayStatus.tone)}
            </div>
          </div>
          <div class="campaign-schedule-meta">
            <div class="mini-stat tone-traffic"><span>Показы</span><strong>${formatNumber(campaign.metrics?.views, 0)}</strong></div>
            <div class="mini-stat tone-orders"><span>Заказы</span><strong>${formatNumber(campaign.metrics?.orders, 0)}</strong></div>
            <div class="mini-stat tone-cost"><span>Расход</span><strong>${formatMoney(campaign.metrics?.sum)}</strong></div>
            <div class="mini-stat tone-${metricState("ctr", campaign.metrics?.ctr).tone}"><span>CTR</span><strong>${formatPercent(campaign.metrics?.ctr)}</strong></div>
          </div>
          <div class="campaign-schedule-body">
            ${renderScheduleMatrix(buildCampaignScheduleMatrix(schedule), "boolean")}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderHourlyTable(product) {
  const heatByHour = new Map((product.heatmap?.by_hour || []).map((row) => [row.hour, row]));
  const ordersByHour = new Map((product.orders_heatmap?.by_hour || []).map((row) => [row.hour, row]));
  const rows = Array.from({ length: 24 }, (_, hour) => {
    const heat = heatByHour.get(hour) || {};
    const orders = ordersByHour.get(hour) || {};
    return {
      hour: `${hour}:00`,
      views: heat.views,
      clicks: heat.clicks,
      spent: heat.spent,
      CTR: heat.CTR,
      CPC: heat.CPC,
      orders: orders.orders,
    };
  });

  const columns = [
    { label: "Час", field: "hour", type: "text" },
    { label: "Показы", field: "views", type: "number", digits: 0 },
    { label: "Клики", field: "clicks", type: "number", digits: 0 },
    { label: "Расход", field: "spent", type: "money" },
    { label: "CTR", field: "CTR", type: "percent" },
    { label: "CPC", field: "CPC", type: "money" },
    { label: "Заказы", field: "orders", type: "number", digits: 0 },
  ];

  return renderDataTable(columns, rows, { emptyText: "Heatmap по часам пока не вернулась из XWAY." });
}

function buildSection(title, note, body, expandKey = null) {
  const options = arguments[4] || {};
  const article = String(options.article || "").trim();
  const collapseKey = String(options.collapseKey || "").trim();
  const collapsed = Boolean(options.collapsed && article && collapseKey);
  return `
    <section class="section-panel${collapsed ? " is-collapsed" : ""}">
      <div class="section-head">
        <div class="section-head-copy">
          <h3>${escapeHtml(title)}</h3>
          ${note ? `<p class="section-note section-head-note">${escapeHtml(note)}</p>` : ""}
        </div>
        ${(expandKey || collapseKey) ? `
          <div class="section-head-actions">
            ${expandKey ? `<button type="button" class="ghost-button" data-expand-panel="${expandKey}">Развернуть</button>` : ""}
            ${collapseKey ? `
              <button
                type="button"
                class="ghost-button section-toggle-button${collapsed ? " is-collapsed" : ""}"
                data-overview-section-toggle="${escapeHtml(collapseKey)}"
                data-article="${escapeHtml(article)}"
                aria-label="${collapsed ? "Развернуть блок" : "Свернуть блок"}"
                aria-expanded="${collapsed ? "false" : "true"}"
              >${collapsed ? "+" : "−"}</button>
            ` : ""}
          </div>
        ` : ""}
      </div>
      <div class="section-body"${collapsed ? " hidden" : ""}>
        ${body}
      </div>
    </section>
  `;
}

function normalizeCampaignCompareSelection(product, selection = null) {
  const ids = Array.from(new Set(((product?.campaigns) || []).map((campaign) => String(campaign.id))));
  if (!ids.length) {
    return { ids, left: null, right: null };
  }
  if (ids.length === 1) {
    return { ids, left: ids[0], right: null };
  }
  let left = selection?.left && ids.includes(String(selection.left)) ? String(selection.left) : ids[0];
  let right = selection?.right && ids.includes(String(selection.right)) ? String(selection.right) : ids.find((id) => id !== left) || ids[1];
  if (left === right) {
    right = ids.find((id) => id !== left) || null;
  }
  return { ids, left, right };
}

function getCampaignCompareSelection(product) {
  const articleKey = String(product?.article || "");
  const normalized = normalizeCampaignCompareSelection(product, articleKey ? campaignCompareStore.get(articleKey) : null);
  if (articleKey && normalized.ids.length > 1) {
    campaignCompareStore.set(articleKey, { left: normalized.left, right: normalized.right });
  }
  return normalized;
}

function selectedCampaignIds(product) {
  const selection = getCampaignCompareSelection(product);
  return [selection.left, selection.right].filter(Boolean);
}

function currentProductRequestOptions(article = selectedArticle) {
  const product = productStore.get(String(article || ""));
  const activeTab = getActiveTab(article);
  if (isHeavyTab(activeTab)) {
    return { campaignMode: "full" };
  }
  if (!product) {
    return { campaignMode: "summary" };
  }
  const heavyCampaignIds = selectedCampaignIds(product);
  return {
    campaignMode: "summary",
    heavyCampaignIds,
  };
}

function mergeProductsIntoStore(products = [], mode = "merge") {
  if (mode !== "merge") {
    productStore.clear();
  }
  (products || []).forEach((product) => productStore.set(String(product.article), product));
  syncArticleSummaries(products || []);
}

function mergePayloadProducts(payload, mode = "replace") {
  if (mode !== "merge" || !currentPayload) {
    currentPayload = payload;
    return;
  }
  const merged = new Map(((currentPayload.products || [])).map((product) => [String(product.article), product]));
  (payload.products || []).forEach((product) => merged.set(String(product.article), product));
  currentPayload = {
    ...currentPayload,
    ...payload,
    products: Array.from(merged.values()),
  };
}

async function fetchAndMergeSingleProduct(article, requestOptions = {}, statusMessage = "Прогрузка товара…") {
  const articleKey = String(article || "");
  if (!articleKey) {
    return null;
  }
  let succeeded = false;
  isLoading = true;
  loadingArticle = articleKey;
  setStatus(statusMessage, "loading");
  syncControlState();
  renderSelectedProduct();
  try {
    const payload = await fetchProductsPayload(
      [articleKey],
      startDateInput.value,
      endDateInput.value,
      "Не удалось загрузить данные товара.",
      requestOptions,
    );
    cacheChartProducts(payload.products || []);
    handleLoadedPayload(payload, { mode: "merge", focusArticle: articleKey });
    succeeded = true;
    return (payload.products || [])[0] || productStore.get(articleKey) || null;
  } catch (error) {
    setStatus("Ошибка", "error");
    return productStore.get(articleKey) || null;
  } finally {
    isLoading = false;
    loadingArticle = null;
    syncControlState();
    renderSelectedProduct();
    if (succeeded) {
      const doneStatus = statusMessage === "Прогрузка кампаний…"
        ? "Кампании загружены"
        : statusMessage === "Прогрузка вкладки…"
          ? "Вкладка загружена"
          : "Товар обновлен";
      setStatus(doneStatus, "idle");
    }
  }
}

async function ensureCampaignCompareHeavyData(product) {
  if (!product) {
    return null;
  }
  const heavyCampaignIds = selectedCampaignIds(product);
  if (productHasCampaignHeavy(product, heavyCampaignIds)) {
    return product;
  }
  return fetchAndMergeSingleProduct(
    product.article,
    { campaignMode: "summary", heavyCampaignIds },
    "Прогрузка кампаний…",
  );
}

async function ensureHeavyTabData(product, tabName) {
  if (!product || !isHeavyTab(tabName) || productHasAllCampaignHeavy(product)) {
    return product;
  }
  return fetchAndMergeSingleProduct(product.article, { campaignMode: "full" }, "Прогрузка вкладки…");
}

function setCampaignCompareSelection(product, slot, campaignId) {
  const articleKey = String(product?.article || "");
  if (!articleKey) {
    return;
  }
  const normalized = getCampaignCompareSelection(product);
  const nextId = String(campaignId || "");
  if (!normalized.ids.includes(nextId)) {
    return;
  }
  let left = normalized.left;
  let right = normalized.right;
  if (slot === "left") {
    left = nextId;
    if (right === left) {
      right = normalized.ids.find((id) => id !== left && id !== normalized.right) || normalized.ids.find((id) => id !== left) || null;
    }
  } else if (slot === "right") {
    right = nextId;
    if (left === right) {
      left = normalized.ids.find((id) => id !== right && id !== normalized.left) || normalized.ids.find((id) => id !== right) || null;
    }
  }
  campaignCompareStore.set(articleKey, { left, right });
}

function campaignCompareLabel(campaign) {
  return `${campaign.id} · ${shortText(campaign.name || "Без названия", 42)}`;
}

function renderCampaignCompareControls(product, selection) {
  const campaigns = product?.campaigns || [];
  const buildOptions = (selectedId) => campaigns.map((campaign) => `
    <option value="${escapeHtml(campaign.id)}"${String(selectedId) === String(campaign.id) ? " selected" : ""}>
      ${escapeHtml(campaignCompareLabel(campaign))}
    </option>
  `).join("");
  return `
    <div class="campaign-compare-controls" role="group" aria-label="Выбор кампаний для сравнения">
      <label class="campaign-compare-field">
        <span>РК 1</span>
        <select data-campaign-compare-slot="left" data-article="${escapeHtml(product.article)}">
          ${buildOptions(selection.left)}
        </select>
      </label>
      <label class="campaign-compare-field">
        <span>РК 2</span>
        <select data-campaign-compare-slot="right" data-article="${escapeHtml(product.article)}">
          ${buildOptions(selection.right)}
        </select>
      </label>
    </div>
  `;
}

function buildOverviewCampaignsSection(product) {
  const campaigns = product?.campaigns || [];
  const campaignCount = campaigns.length;
  if (!campaignCount) {
    return buildSection("Кампании", "0 кампаний в выборке", emptyBlock("Кампании не найдены."), null, {
      article: product?.article,
      collapseKey: "campaigns",
      collapsed: getOverviewSectionCollapsed?.(product?.article, "campaigns"),
    });
  }
  const campaignsCollapsed = Boolean(getOverviewSectionCollapsed?.(product?.article, "campaigns"));
  const compareMode = campaignCount > 3;
  const selection = getCampaignCompareSelection(product);
  const visibleCampaigns = compareMode
    ? [selection.left, selection.right]
        .map((campaignId) => campaigns.find((campaign) => String(campaign.id) === String(campaignId)))
        .filter(Boolean)
    : campaigns;
  const controls = compareMode ? renderCampaignCompareControls(product, selection) : "";
  const note = compareMode
    ? `${formatNumber(campaignCount, 0)} кампаний в товаре • выбрано 2 для сравнения`
    : `${formatNumber(campaignCount, 0)} кампаний в товаре`;
  const listClass = compareMode ? "campaign-list is-compare-pair" : "campaign-list is-fluid";
  const activityTimeline = renderCampaignActivityTimeline(product, campaigns);
  return `
    <section class="section-panel${campaignsCollapsed ? " is-collapsed" : ""}">
      <div class="section-head section-head-campaigns">
        <div class="section-head-copy">
          <h3>Кампании</h3>
          <p class="section-note section-head-note">${escapeHtml(note)}</p>
        </div>
        <div class="section-head-actions">
          ${controls}
          <button
            type="button"
            class="ghost-button section-toggle-button${campaignsCollapsed ? " is-collapsed" : ""}"
            data-overview-section-toggle="campaigns"
            data-article="${escapeHtml(product?.article || "")}"
            aria-label="${campaignsCollapsed ? "Развернуть блок" : "Свернуть блок"}"
            aria-expanded="${campaignsCollapsed ? "false" : "true"}"
          >${campaignsCollapsed ? "+" : "−"}</button>
        </div>
      </div>
      <div class="section-body"${campaignsCollapsed ? " hidden" : ""}>
        ${activityTimeline}
        <div class="campaign-list-shell">
          <div class="${listClass}">
            ${visibleCampaigns.map((campaign) => renderCampaign(campaign, product.daily_stats || [], findCampaignById(product, campaign.id) || null, product)).join("")}
          </div>
        </div>
      </div>
    </section>
  `;
}

function buildOverviewScheduleSection(product) {
  const scheduleAggregate = product.schedule_aggregate || { days: [], max_count: 1 };
  const days = Array.isArray(scheduleAggregate.days) ? scheduleAggregate.days : [];
  if (!days.length) {
    return buildSection(
      "Покрытие по расписанию",
      `${formatNumber((product.campaigns || []).length, 0)} кампаний`,
      emptyBlock("Данные по расписанию не найдены."),
      null,
      {
        article: product?.article,
        collapseKey: "schedule",
        collapsed: getOverviewSectionCollapsed?.(product?.article, "schedule"),
      },
    );
  }

  const totalSlots = days.reduce(
    (sum, day) => sum + (Array.isArray(day?.hours) ? day.hours.length : 0),
    0,
  );
  const totalActiveCampaignSlots = days.reduce(
    (sum, day) => sum + (Array.isArray(day?.hours)
      ? day.hours.reduce((hourSum, cell) => {
          const countValue = Number(cell?.count);
          if (Number.isFinite(countValue) && countValue > 0) {
            return hourSum + countValue;
          }
          return hourSum + (cell?.active ? 1 : 0);
        }, 0)
      : 0),
    0,
  );
  const activeSlotsRaw = Number(scheduleAggregate.active_slots);
  const activeSlots = Number.isFinite(activeSlotsRaw) ? activeSlotsRaw : null;
  const normalizedCoverageBase = Math.max(Number(SCHEDULE_COVERAGE_BASELINE || 2), 1);
  const coverage = totalSlots > 0
    ? (totalActiveCampaignSlots / (totalSlots * normalizedCoverageBase)) * 100
    : null;
  const maxCount = Math.max(
    safeNumber(scheduleAggregate.max_count, 0),
    (product.campaigns || []).length,
    1,
  );
  const noteParts = [
    `${formatNumber((product.campaigns || []).length, 0)} кампаний`,
    coverage === null ? `активных слотов: ${formatNumber(activeSlots, 0)}` : `покрытие слотов: ${formatPercent(coverage)}`,
  ];

  return buildSection(
    "Покрытие по расписанию",
    noteParts.join(" • "),
    renderScheduleMatrix(scheduleAggregate, "count", { showValues: true, maxCount }),
    null,
    {
      article: product?.article,
      collapseKey: "schedule",
      collapsed: getOverviewSectionCollapsed?.(product?.article, "schedule"),
    },
  );
}

function buildOverviewTab(product) {
  const scheduleCoverage = buildOverviewScheduleSection(product);
  const charts = buildChartsSection(product);
  const campaigns = buildOverviewCampaignsSection(product);
  return `<div class="overview-stack">${scheduleCoverage}${charts}<div class="overview-grid">${campaigns}</div></div>`;
}

function dailyRowsNewestFirst(rows) {
  return [...(rows || [])].sort((left, right) => String(right?.day || "").localeCompare(String(left?.day || "")));
}

function buildDailyTab(product) {
  const body = renderDataTable(DAILY_COLUMNS, dailyRowsNewestFirst(product.daily_stats));
  const note = `${formatDateLabel(product.period.current_start)} → ${formatDateLabel(product.period.current_end)} • ${formatNumber((product.daily_stats || []).length, 0)} строк`;
  return buildSection("Статистика по дням", note, body, "daily");
}

function splitStatusDateTime(value) {
  const text = String(value || "").trim();
  if (!text) {
    return { date: "—", time: "" };
  }
  const parts = text.split(",");
  if (parts.length >= 2) {
    return {
      date: parts[0].trim() || "—",
      time: parts.slice(1).join(",").trim(),
    };
  }
  const match = text.match(/^(.*?)(\d{1,2}:\d{2})$/);
  if (match) {
    return {
      date: match[1].trim() || "—",
      time: match[2].trim(),
    };
  }
  return { date: text, time: "" };
}

function parseRuDateLabel(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) {
    return null;
  }
  const [, day, month, year] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function compactStatusDayLabel(value) {
  const parsed = parseRuDateLabel(value);
  if (!parsed) {
    return value || "—";
  }
  return `${String(parsed.getDate()).padStart(2, "0")}.${String(parsed.getMonth() + 1).padStart(2, "0")}`;
}

function compactStatusEndLabel(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "актуально";
  }
  const parsed = splitStatusDateTime(text);
  if (parsed.time) {
    const dayLabel = compactStatusDayLabel(parsed.date);
    if (dayLabel === "Сегодня" || dayLabel === "Вчера") {
      return `до ${parsed.time}`;
    }
    return `до ${dayLabel} ${parsed.time}`;
  }
  return `до ${compactStatusDayLabel(text)}`;
}

function renderPauseHistoryList(campaign) {
  const intervals = mergePauseHistoryDisplayIntervals(campaignMergedPauseHistoryIntervals(campaign));
  if (!intervals.length) {
    return emptyBlock("Логи состояния не найдены.");
  }
  return `
    <div class="status-interval-shell">
    <div class="status-interval-list">
      ${intervals.map((item) => {
        const reasons = pauseReasonLabels(item);
        const start = splitStatusDateTime(item.start);
        const status = item.is_freeze ? "Заморожена" : (item.status || "—");
        const statusTone = status === "Активна"
          ? "good"
          : status === "Заморожена"
            ? "freeze"
            : status === "Приостановлена"
              ? "paused"
              : "";
        return `
          <article class="status-interval-item">
            <div class="status-interval-time">
              <strong>${escapeHtml(compactStatusDayLabel(start.date))}</strong>
              ${start.time ? `<span>${escapeHtml(start.time)}</span>` : ""}
              <small>${escapeHtml(compactStatusEndLabel(item.end))}</small>
            </div>
            <div class="status-interval-track" aria-hidden="true"><i></i></div>
            <div class="status-interval-meta">
              ${tagMarkup(status, statusTone)}
              ${reasons.map((reason) => tagMarkup(shortText(reason, 20))).join("")}
            </div>
          </article>
        `;
      }).join("")}
    </div>
    </div>
  `;
}

function renderCampaignStatusCard(campaign) {
  const displayStatus = campaignDisplayStatus(campaign);
  const cardTone = displayStatus.tone === "good" ? "good" : displayStatus.tone === "bad" ? "warn" : "neutral";
  const statusOutlineClass = campaignStatusOutlineClass(displayStatus);
  const xwayTone = campaign.status_xway === "Активна"
    ? "good"
    : campaign.status_xway === "Заморожена"
      ? "freeze"
      : campaign.status_xway === "Приостановлена"
        ? "bad"
        : "";
  return `
    <section class="campaign-card tone-${escapeHtml(cardTone)}${statusOutlineClass ? ` ${statusOutlineClass}` : ""}">
      <div class="campaign-card-head">
        <div class="product-meta compact">
          ${tagMarkup(`ID ${campaign.id}`)}
          ${tagMarkup(displayStatus.label, displayStatus.tone)}
          ${campaign.status_xway ? tagMarkup(`XWAY: ${campaign.status_xway}`, xwayTone) : ""}
        </div>
        <h4>${escapeHtml(campaign.name || `Кампания ${campaign.id}`)}</h4>
      </div>
      <div class="stack-block">
        <div class="stack-head">
          <h4>Паузы и статусы</h4>
        </div>
        ${renderPauseHistoryList(campaign)}
      </div>
    </section>
  `;
}

function buildCampaignStatusTab(product) {
  const campaigns = product.campaigns || [];
  const totalIntervals = campaigns.reduce(
    (sum, campaign) => sum + mergePauseHistoryDisplayIntervals(campaignMergedPauseHistoryIntervals(campaign)).length,
    0,
  );
  const body = campaigns.length
    ? `<div class="campaign-status-stack">${campaigns.map(renderCampaignStatusCard).join("")}</div>`
    : emptyBlock("Кампании не найдены.");
  return buildSection(
    "Логи состояния РК",
    `${formatNumber(campaigns.length, 0)} кампаний • ${formatNumber(totalIntervals, 0)} логов`,
    body,
  );
}

function renderClusterSummary(campaign) {
  const clusters = campaign.clusters || {};
  return `
    <div class="cluster-summary-strip">
      ${tagMarkup(`Всего ${formatNumber(clusters.total_clusters, 0)}`)}
      ${tagMarkup(`Исключено ${formatNumber(clusters.excluded, 0)}`)}
      ${tagMarkup(`Зафиксировано ${formatNumber(clusters.fixed, 0)}`)}
      ${clusters.max_rules_available ? tagMarkup(`Правила ${formatNumber(clusters.current_rules_used, 0)} / ${formatNumber(clusters.max_rules_available, 0)}`) : ""}
    </div>
  `;
}

function renderClusterStatusIcons(row) {
  const icons = [];
  if (row.is_main) {
    icons.push('<span class="cluster-status-icon is-main" title="Основной" aria-label="Основной">★</span>');
  }
  if (row.fixed) {
    icons.push('<span class="cluster-status-icon is-fixed" title="Зафиксирован" aria-label="Зафиксирован">◎</span>');
  }
  if (row.excluded) {
    icons.push('<span class="cluster-status-icon is-excluded" title="Исключен" aria-label="Исключен">−</span>');
  }
  return `<div class="cluster-status-icons">${icons.join("")}</div>`;
}

function renderClusterTable(product, campaign) {
  const rows = campaign.clusters?.items || [];
  if (!rows.length) {
    const errorKeys = Object.keys(campaign.cluster_errors || {});
    return emptyBlock(errorKeys.length ? `Кластеры недоступны: ${errorKeys.join(", ")}` : "Кластеры не найдены.");
  }
  return `
    ${renderClusterSummary(campaign)}
    <div class="table-shell cluster-table-shell">
      <table class="data-table cluster-table">
        <thead>
          <tr>
            <th>Кластер</th>
            <th>Позиция</th>
            <th>Целевое место</th>
            <th>Макс. ставка CPM</th>
            <th>Ставка</th>
            <th>Популярность</th>
            <th>Показы</th>
            <th>Клики</th>
            <th>Расход</th>
            <th>CTR</th>
            <th>CPC</th>
            <th>Заказы</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td class="cluster-name-cell">
                <div class="cluster-name-wrap">
                  ${renderClusterStatusIcons(row)}
                  <div class="cluster-name-copy">
                    <strong>${escapeHtml(row.name || "—")}</strong>
                    <span>${escapeHtml(`ID ${row.normquery_id}`)}</span>
                  </div>
                </div>
              </td>
              <td>
                <div class="cluster-position-cell">
                  <strong>${row.position === null || row.position === undefined ? "—" : escapeHtml(formatNumber(row.position, 0))}</strong>
                  <span>${row.position_is_promo ? "AD" : "org"}</span>
                </div>
              </td>
              <td>${row.bid_rule_target_place === null || row.bid_rule_target_place === undefined ? "—" : formatNumber(row.bid_rule_target_place, 0)}</td>
              <td>${formatMoney(row.bid_rule_max_cpm)}</td>
              <td>${formatMoney(row.bid)}</td>
              <td>${formatNumber(row.popularity, 0)}</td>
              <td>${formatNumber(row.views, 0)}</td>
              <td>${formatNumber(row.clicks, 0)}</td>
              <td>${formatMoney(row.expense)}</td>
              <td>${formatPercent(row.ctr)}</td>
              <td>${formatMoney(row.cpc)}</td>
              <td>${formatNumber(row.orders, 0)}</td>
              <td>
                <button
                  type="button"
                  class="ghost-button compact-button"
                  data-cluster-detail="1"
                  data-article="${escapeHtml(product.article)}"
                  data-campaign-id="${escapeHtml(campaign.id)}"
                  data-normquery-id="${escapeHtml(row.normquery_id)}"
                >Детали</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderClusterCampaignCard(product, campaign) {
  return `
    <section class="section-panel">
      <div class="section-head">
        <div>
          <h3>${escapeHtml(campaign.name || `Кампания ${campaign.id}`)}</h3>
          <p class="section-note">${escapeHtml(`${formatNumber((campaign.clusters?.items || []).length, 0)} кластеров • ${campaign.status || "—"}`)}</p>
        </div>
      </div>
      ${renderClusterTable(product, campaign)}
    </section>
  `;
}

function buildClustersTab(product) {
  const campaigns = (product.campaigns || []).filter((campaign) => campaign.clusters?.available || Object.keys(campaign.cluster_errors || {}).length);
  const body = campaigns.length
    ? `<div class="cluster-campaign-stack">${campaigns.map((campaign) => renderClusterCampaignCard(product, campaign)).join("")}</div>`
    : emptyBlock("Для этого товара кластеры не доступны.");
  return buildSection("Кластеры и позиции", `${formatNumber(campaigns.length, 0)} кампаний с кластерными данными`, body);
}

function buildHoursTab(product) {
  const aggregate = `
    <div class="stack-block">
      <div class="stack-head">
        <h4>Покрытие по расписанию</h4>
        <p>Сколько кампаний активны в каждом слоте.</p>
      </div>
      ${renderScheduleMatrix(product.schedule_aggregate || { days: [], max_count: 1 }, "count")}
    </div>
  `;
  const hourly = `
    <div class="stack-block">
      <div class="stack-head">
        <h4>Производительность по часу</h4>
        <p>Показы, клики, расход, CTR, CPC и заказы по часам.</p>
      </div>
      ${renderHourlyTable(product)}
    </div>
  `;
  const body = `<div class="hours-grid">${aggregate}${hourly}</div>`;
  const note = `${formatDateLabel(product.period.current_start)} → ${formatDateLabel(product.period.current_end)} • heatmap и расписание`;
  return buildSection("Часы показов и heatmap", note, body, "heatmap");
}

function buildCampaignHeatmapTab(product) {
  const body = product.campaigns?.length
    ? `<div class="campaign-heatmap-grid">${renderCampaignSchedules(product.campaigns || [])}</div>`
    : emptyBlock("Кампании не найдены.");
  const note = `${formatNumber((product.campaigns || []).length, 0)} кампаний • отдельный heatmap по каждой РК`;
  return buildSection("Heatmap по кампаниям", note, body);
}

function buildBidlogTab(product, expanded = false) {
  const rows = expanded ? product.bid_log || [] : (product.bid_log || []).slice(0, 12);
  const body = renderDataTable(BIDLOG_COLUMNS, rows, {
    shellClass: "compact-shell",
    emptyText: "Изменений ставок нет.",
  });
  const note = expanded
    ? `${formatNumber((product.bid_log || []).length, 0)} записей по изменениям ставок`
    : `${formatNumber((product.bid_log || []).length, 0)} записей • на экране последние 12`;
  return buildSection("Логи изменения ставки", note, body, "bidlog");
}

function renderProductTabContent(product, tabName) {
  switch (normalizeProductTab(tabName)) {
    case "overview":
      return buildOverviewTab(product);
    case "daily":
      return buildDailyTab(product);
    case "campaign-status":
      return buildCampaignStatusTab(product);
    case "clusters":
      return buildClustersTab(product);
    case "hours":
      return buildHoursTab(product);
    case "campaign-heatmap":
      return buildCampaignHeatmapTab(product);
    case "bids":
      return buildBidlogTab(product, false);
    default:
      return buildOverviewTab(product);
  }
}

function openBudgetHistory(article, campaignId) {
  const product = productStore.get(String(article));
  if (!product) {
    return;
  }
  const campaign = (product.campaigns || []).find((item) => String(item.id) === String(campaignId));
  if (!campaign) {
    return;
  }
  const rows = campaign.budget_history || [];
  modalTitle.textContent = `${product.article} • Логи пополнений`;
  modalNote.textContent = campaign.name || "";
  modalBody.innerHTML = buildSection(
    "История пополнений",
    `${formatNumber(rows.length, 0)} записей`,
    renderDataTable(BUDGET_HISTORY_COLUMNS, rows, {
      shellClass: "compact-shell",
      emptyText: "Пополнений не было.",
    }),
  );
  modalShell.hidden = false;
  syncModalLock();
}

function openBidHistory(article, campaignId) {
  const product = productStore.get(String(article));
  if (!product) {
    return;
  }
  const campaign = (product.campaigns || []).find((item) => String(item.id) === String(campaignId));
  if (!campaign) {
    return;
  }
  const rows = campaign.bid_history || [];
  modalTitle.textContent = `${product.article} • Логи изменения ставки`;
  modalNote.textContent = campaign.name || "";
  modalBody.innerHTML = buildSection(
    "История ставок",
    `${formatNumber(rows.length, 0)} записей`,
    renderDataTable(BIDLOG_COLUMNS, rows, {
      shellClass: "compact-shell",
      emptyText: "Изменений ставок не было.",
    }),
  );
  modalShell.hidden = false;
  syncModalLock();
}

function buildModalContent(product, type) {
  if (type === "daily") {
    return {
      title: `${product.article} • Статистика по дням`,
      note: `${formatDateLabel(product.period.current_start)} → ${formatDateLabel(product.period.current_end)}`,
      body: buildDailyTab(product),
    };
  }
  if (type === "heatmap") {
    return {
      title: `${product.article} • Часы показов и heatmap`,
      note: `${formatDateLabel(product.period.current_start)} → ${formatDateLabel(product.period.current_end)}`,
      body: buildHoursTab(product),
    };
  }
  if (type === "bidlog") {
    return {
      title: `${product.article} • Логи изменения ставки`,
      note: `${formatNumber((product.bid_log || []).length, 0)} записей`,
      body: buildBidlogTab(product, true),
    };
  }
  return {
    title: `${product.article} • Сырые JSON`,
    note: "Полный объект ответа XWAY по товару",
    body: `<section class="section-panel"><pre class="modal-json">${escapeHtml(JSON.stringify(product, null, 2))}</pre></section>`,
  };
}

function buildClusterDailyRows(daily) {
  return Object.entries(daily || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, values]) => ({
      day,
      day_label: formatDateLabel(day),
      ...values,
    }));
}

async function openClusterDetail(article, campaignId, normqueryId) {
  const product = productStore.get(String(article));
  if (!product) {
    return;
  }
  const campaign = (product.campaigns || []).find((item) => String(item.id) === String(campaignId));
  const cluster = (campaign?.clusters?.items || []).find((item) => String(item.normquery_id) === String(normqueryId));
  modalTitle.textContent = `${article} • ${cluster?.name || `Кластер ${normqueryId}`}`;
  modalNote.textContent = campaign?.name || "";
  modalBody.innerHTML = `<section class="section-panel"><div class="empty-state">Загрузка деталей кластера…</div></section>`;
  modalShell.hidden = false;
  syncModalLock();

  const cacheKey = [article, campaignId, normqueryId, startDateInput.value, endDateInput.value].join(":");
  let payload = clusterDetailCache.get(cacheKey);
  if (!payload) {
    const params = new URLSearchParams({
      shop_id: String(product.shop.id),
      product_id: String(product.product_id),
      campaign_id: String(campaignId),
      normquery_id: String(normqueryId),
      start: startDateInput.value,
      end: endDateInput.value,
    });
    const response = await fetch(`/api/cluster-detail?${params.toString()}`);
    payload = await response.json();
    if (!response.ok || !payload.ok) {
      modalBody.innerHTML = `<section class="section-panel">${emptyBlock(payload.error || "Не удалось загрузить детали кластера.")}</section>`;
      return;
    }
    clusterDetailCache.set(cacheKey, payload);
  }

  const dailyRows = buildClusterDailyRows(payload.daily);
  const currentPosition = payload.position === null || payload.position === undefined
    ? "—"
    : `${Math.abs(Number(payload.position))}${Number(payload.position) > 0 ? " AD" : ""}`;
  const targetPlace = cluster?.bid_rule_target_place === null || cluster?.bid_rule_target_place === undefined
    ? "—"
    : formatNumber(cluster?.bid_rule_target_place, 0);

  modalBody.innerHTML = `
    <section class="section-panel">
      <div class="cluster-detail-grid">
        <div class="mini-stat tone-traffic"><span>Позиция</span><strong>${escapeHtml(currentPosition)}</strong></div>
        <div class="mini-stat tone-neutral"><span>Целевое место</span><strong>${escapeHtml(targetPlace)}</strong></div>
        <div class="mini-stat tone-cost"><span>Макс. ставка CPM</span><strong>${formatMoney(cluster?.bid_rule_max_cpm)}</strong></div>
        <div class="mini-stat tone-traffic"><span>Ставка</span><strong>${formatMoney(cluster?.bid)}</strong></div>
        <div class="mini-stat tone-traffic"><span>Показы</span><strong>${formatNumber(cluster?.views, 0)}</strong></div>
        <div class="mini-stat tone-traffic"><span>Клики</span><strong>${formatNumber(cluster?.clicks, 0)}</strong></div>
        <div class="mini-stat tone-cost"><span>Расход</span><strong>${formatMoney(cluster?.expense)}</strong></div>
        <div class="mini-stat tone-orders"><span>Заказы</span><strong>${formatNumber(cluster?.orders, 0)}</strong></div>
        <div class="mini-stat tone-orders"><span>CTR</span><strong>${formatPercent(cluster?.ctr)}</strong></div>
      </div>
    </section>
    ${buildSection("Аналитика по дням", `${formatDateLabel(startDateInput.value)} → ${formatDateLabel(endDateInput.value)}`, renderDataTable(CLUSTER_DAILY_COLUMNS, dailyRows, { emptyText: "Дневной аналитики нет." }))}
    ${buildSection("История кластера", `${formatNumber((payload.history || []).length, 0)} записей`, renderDataTable(CLUSTER_HISTORY_COLUMNS, payload.history || [], { emptyText: "История изменений пуста." }))}
    ${buildSection("История ставок кластера", `${formatNumber((payload.bid_history || []).length, 0)} записей`, renderDataTable(CLUSTER_BID_COLUMNS, payload.bid_history || [], { emptyText: "История ставок пуста." }))}
  `;
}



  return {
    buildModalContent,
    openBidHistory,
    openBudgetHistory,
    openClusterDetail,
    renderProductTabContent,
    selectedCampaignIds,
    setCampaignCompareSelection,
  };
}
