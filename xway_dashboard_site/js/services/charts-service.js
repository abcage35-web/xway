import { DEFAULT_CHART_WINDOW_DAYS } from "../constants.js";
import { escapeHtml, formatDateLabel, formatMoney, formatNumber, formatPercent, localIsoDate, parseIsoDate, safeNumber } from "../formatters.js";
import { buildHighchartsTooltipHtml, renderHighchartsHost } from "./highcharts-service.js";
import { buildSection, emptyBlock } from "./ui-render.js";

export function createChartsService(deps) {
  const {
    combinedFunnelTile,
    comparisonPreviousValue,
    getCampaignChartContext,
    getChartWindowDays,
    getChartRenderContext,
    getOverviewSectionCollapsed,
    metricMetaItem,
    metricPrimaryDelta,
    metricState,
    metricTile,
    normalizeChartWindowDays,
    productChartKey,
    renderMetricLevel,
    shortText,
    totalsForProduct,
  } = deps;

function seriesFromRows(rows, field) {
  return (rows || []).map((row) => safeNumber(row?.[field], 0));
}

function linePath(points) {
  if (!points.length) {
    return "";
  }
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
}

function areaPath(points, baseY) {
  if (!points.length) {
    return "";
  }
  return `${linePath(points)} L ${points[points.length - 1].x.toFixed(2)} ${baseY.toFixed(2)} L ${points[0].x.toFixed(2)} ${baseY.toFixed(2)} Z`;
}

function buildChartPoints(values, options = {}) {
  const width = options.width || 620;
  const height = options.height || 220;
  const paddingX = options.paddingX || 18;
  const paddingTop = options.paddingTop || 18;
  const paddingBottom = options.paddingBottom || 28;
  const min = options.min ?? Math.min(...values, 0);
  const max = options.max ?? Math.max(...values, 1);
  const chartWidth = width - paddingX * 2;
  const chartHeight = height - paddingTop - paddingBottom;
  const span = max - min || 1;
  const xPositions = buildChartXPositions(values.length, width, paddingX);
  return values.map((value, index) => {
    const x = xPositions[index];
    const y = paddingTop + chartHeight - ((value - min) / span) * chartHeight;
    return { x, y, value };
  });
}

function buildChartXPositions(count, width = 620, paddingX = 22) {
  if (count <= 0) {
    return [];
  }
  if (count === 1) {
    return [width / 2];
  }
  const step = (width - paddingX * 2) / Math.max(count - 1, 1);
  return Array.from({ length: count }, (_, index) => paddingX + step * index);
}

function buildChartSlices(count, width = 620, paddingX = 22) {
  const positions = buildChartXPositions(count, width, paddingX);
  if (!positions.length) {
    return [];
  }
  return positions.map((x, index) => {
    const prev = positions[index - 1] ?? (x - (positions[index + 1] - x) / 2);
    const next = positions[index + 1] ?? (x + (x - positions[index - 1]) / 2);
    const start = index === 0 ? paddingX - (next - x) / 2 : (prev + x) / 2;
    const end = index === positions.length - 1 ? width - paddingX + (x - prev) / 2 : (x + next) / 2;
    return { x: start, width: end - start };
  });
}

function chartDateLabel(row) {
  return formatDateLabel(row.day || row.day_label?.split(".").reverse().join("-") || "");
}

function chartAxisLabel(row) {
  const full = chartDateLabel(row);
  const [day, month] = full.split(".");
  return day && month ? `${day}.${month}` : full;
}

const DAY_STATUS_MARKER_ORDER = ["active", "freeze", "paused"];
const DAY_STATUS_MARKER_META = {
  active: { glyph: "✓", label: "Активна" },
  freeze: { glyph: "❄", label: "Заморожена" },
  paused: { glyph: "⏸", label: "Приостановлена" },
};

const DAY_STATUS_REASON_LABELS = {
  schedule: "расписание",
  user: "пользователь",
  budget: "бюджет",
  limit: "лимит",
};

function hasBudgetLimitReason(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .split(",")
    .some((token) => /budget|бюджет|day_budget|limit|лимит|расход/.test(token.trim()));
}

function parseStatusDateTimeForChart(value, options = {}) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/);
  const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
  const fallbackDate = options.fallbackDate instanceof Date && !Number.isNaN(options.fallbackDate.getTime())
    ? options.fallbackDate
    : null;
  const fallbackYear = Number.isFinite(Number(options.fallbackYear))
    ? Number(options.fallbackYear)
    : (fallbackDate ? fallbackDate.getFullYear() : new Date().getFullYear());

  let day = fallbackDate ? fallbackDate.getDate() : null;
  let month = fallbackDate ? fallbackDate.getMonth() + 1 : null;
  let year = fallbackYear;
  let hasExplicitDate = false;

  if (dateMatch) {
    day = Number(dateMatch[1]);
    month = Number(dateMatch[2]);
    year = dateMatch[3] ? Number(dateMatch[3]) : fallbackYear;
    hasExplicitDate = true;
  }

  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
    return null;
  }

  const hours = timeMatch ? Number(timeMatch[1]) : 0;
  const minutes = timeMatch ? Number(timeMatch[2]) : 0;
  const parsed = new Date(year, month - 1, day, hours, minutes, 0, 0);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return { date: parsed, hasExplicitDate };
}

function resolveIntervalStatusKey(interval) {
  if (interval?.is_freeze) {
    return "freeze";
  }
  const statusText = String(interval?.status || "").toLowerCase();
  const reasonText = [
    ...(Array.isArray(interval?.pause_reasons) ? interval.pause_reasons : []),
    interval?.paused_limiter,
  ]
    .map((item) => String(item || "").toLowerCase())
    .join(" ");

  if (/актив|active/.test(statusText)) {
    return "active";
  }
  if (
    /приост|pause|paused|stop|неактив|inactive/.test(statusText)
    || /schedule|распис|budget|бюджет|limit|лимит/.test(reasonText)
    || Boolean(interval?.paused_limiter)
    || Boolean(interval?.paused_user)
  ) {
    return "paused";
  }
  return null;
}

function collectIntervalReasonLabels(interval) {
  const labels = [];
  const reasonTokens = [
    ...(Array.isArray(interval?.pause_reasons) ? interval.pause_reasons : []),
    interval?.paused_limiter,
  ]
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);

  reasonTokens.forEach((token) => {
    if (DAY_STATUS_REASON_LABELS[token]) {
      labels.push(DAY_STATUS_REASON_LABELS[token]);
      return;
    }
    if (/schedule|распис/.test(token)) {
      labels.push("расписание");
      return;
    }
    if (/budget|бюджет/.test(token)) {
      labels.push("бюджет");
      return;
    }
    if (/limit|лимит/.test(token)) {
      labels.push("лимит");
      return;
    }
    if (/user|пользоват/.test(token)) {
      labels.push("пользователь");
    }
  });

  if (interval?.paused_user) {
    labels.push(`пользователь: ${String(interval.paused_user).trim()}`);
  }

  const uniqueLabels = Array.from(new Set(labels));
  if (interval?.paused_user) {
    return uniqueLabels.filter((label) => label !== "пользователь");
  }
  return uniqueLabels;
}

function formatChartClockLabel(date, options = {}) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "—";
  }
  if (options.endOfDay && date.getHours() === 0 && date.getMinutes() === 0) {
    return "24:00";
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dayStatusEntry(value) {
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

function intervalHasSpendLimit(interval) {
  const reasonValues = [
    ...(Array.isArray(interval?.pause_reasons) ? interval.pause_reasons : []),
    interval?.paused_limiter,
  ];
  return reasonValues.some((value) => hasBudgetLimitReason(value));
}

function campaignMergedPauseHistoryIntervals(campaign) {
  const pauseHistory = campaign?.status_logs?.pause_history || {};
  return Array.isArray(pauseHistory.merged_intervals) ? pauseHistory.merged_intervals : (pauseHistory.intervals || []);
}

function mergeDayStatusIntervals(intervals = []) {
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

function buildCampaignDayStatusMap(campaign, rows = []) {
  const normalizedRows = Array.isArray(rows)
    ? rows.filter((row) => row?.day)
    : [];
  if (!normalizedRows.length) {
    return new Map();
  }

  const markersByDay = new Map();
  normalizedRows.forEach((row) => {
    const dayKey = String(row.day);
    markersByDay.set(dayKey, {
      statuses: new Set(),
      intervals: [],
      hasSpendLimit: false,
    });
  });

  const intervals = campaignMergedPauseHistoryIntervals(campaign);
  if (!intervals.length) {
    return markersByDay;
  }

  const anchorDay = normalizedRows[normalizedRows.length - 1]?.day || normalizedRows[0]?.day;
  const anchorYear = parseIsoDate(anchorDay)?.getFullYear() || new Date().getFullYear();
  const dayRanges = normalizedRows
    .map((row) => {
      const dayStart = parseIsoDate(row.day);
      if (!dayStart) {
        return null;
      }
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      return { day: String(row.day), dayStart, dayEnd };
    })
    .filter(Boolean);
  const freezeMinutesByDay = new Map();

  intervals.forEach((interval) => {
    const statusKey = resolveIntervalStatusKey(interval);
    if (!statusKey) {
      return;
    }
    const startParsed = parseStatusDateTimeForChart(interval?.start, { fallbackYear: anchorYear });
    if (!startParsed) {
      return;
    }
    const endParsedRaw = parseStatusDateTimeForChart(interval?.end, {
      fallbackDate: startParsed.date,
      fallbackYear: startParsed.date.getFullYear(),
    });
    const endDate = endParsedRaw?.date ? new Date(endParsedRaw.date) : new Date();
    if (endParsedRaw && !endParsedRaw.hasExplicitDate && endDate <= startParsed.date) {
      endDate.setDate(endDate.getDate() + 1);
    }

    dayRanges.forEach((range) => {
      const overlapStart = Math.max(startParsed.date.getTime(), range.dayStart.getTime());
      const overlapEnd = Math.min(endDate.getTime(), range.dayEnd.getTime());
      if (overlapEnd > overlapStart) {
        const entry = markersByDay.get(range.day);
        entry?.statuses.add(statusKey);
        if (entry && intervalHasSpendLimit(interval)) {
          entry.hasSpendLimit = true;
        }
        entry?.intervals.push({
          statusKey,
          startAt: new Date(overlapStart),
          endAt: new Date(overlapEnd),
          reasons: collectIntervalReasonLabels(interval),
        });
        if (statusKey === "freeze") {
          const durationMinutes = (overlapEnd - overlapStart) / 60000;
          freezeMinutesByDay.set(
            range.day,
            safeNumber(freezeMinutesByDay.get(range.day), 0) + durationMinutes,
          );
        }
      }
    });
  });

  dayRanges.forEach((range) => {
    const fullDayFreeze = safeNumber(freezeMinutesByDay.get(range.day), 0) >= (24 * 60 - 1);
    if (fullDayFreeze) {
      const entry = markersByDay.get(range.day);
      entry?.statuses.delete("active");
      if (entry?.intervals?.length) {
        entry.intervals = entry.intervals.filter((interval) => interval.statusKey !== "active");
      }
    }
  });

  markersByDay.forEach((entry) => {
    if (entry?.intervals?.length) {
      entry.intervals = mergeDayStatusIntervals(entry.intervals);
    }
  });

  return markersByDay;
}

function renderDayStatusMarkers(rows, options = {}) {
  const map = options.dayStatusMap instanceof Map ? options.dayStatusMap : new Map();
  if (!map.size) {
    return "";
  }
  const width = options.width || 620;
  const height = options.height || 220;
  const paddingX = options.paddingX || 30;
  const y = options.y ?? (height - 10);
  const markerSpacing = options.spacing || 18;
  const markerRadius = options.radius || 9;
  const positions = buildChartXPositions(rows.length, width, paddingX);

  return rows
    .map((row, index) => {
      const dayKey = String(row?.day || "");
      const entry = dayStatusEntry(map.get(dayKey));
      const dayStatuses = DAY_STATUS_MARKER_ORDER.filter((key) => entry.statuses.has(key));
      if (!dayStatuses.length) {
        return "";
      }
      const orderedStatuses = dayStatuses.slice(0, 3);
      if (!orderedStatuses.length) {
        return "";
      }
      const sharedLines = [`За день: ${orderedStatuses.map((key) => DAY_STATUS_MARKER_META[key].label).join(", ")}`];
      if (entry.hasSpendLimit) {
        sharedLines.unshift("Финстоп: лимит расходов / бюджета");
      }
      return orderedStatuses
        .map((statusKey, markerIndex) => {
          const markerX = positions[index];
          const markerY = y + markerIndex * markerSpacing;
          const markerMeta = DAY_STATUS_MARKER_META[statusKey];
          return `
            <g class="chart-day-status-marker status-${escapeHtml(statusKey)}">
              <circle
                cx="${markerX.toFixed(2)}"
                cy="${markerY.toFixed(2)}"
                r="${markerRadius.toFixed(2)}"
                class="chart-day-status-dot status-${escapeHtml(statusKey)}"
                ${chartTooltipAttrs(chartDateLabel(row), [`Статус: ${markerMeta.label}`, ...sharedLines])}
              ></circle>
              <text
                x="${markerX.toFixed(2)}"
                y="${markerY.toFixed(2)}"
                class="chart-day-status-glyph"
              >${escapeHtml(markerMeta.glyph)}</text>
            </g>
          `;
        })
        .join("");
    })
    .join("");
}

function renderDayStatusTable(rows, options = {}) {
  const map = options.dayStatusMap instanceof Map ? options.dayStatusMap : new Map();
  if (!rows.length || !map.size) {
    return "";
  }
  const columnsStyle = `grid-template-columns: repeat(${rows.length}, minmax(0, 1fr));`;

  const statusCells = rows
    .map((row) => {
      const dayKey = String(row?.day || "");
      const entry = dayStatusEntry(map.get(dayKey));
      const orderedStatuses = DAY_STATUS_MARKER_ORDER.filter((key) => entry.statuses.has(key)).slice(0, 3);
      const titleParts = [chartDateLabel(row)];
      if (options.campaignId) {
        titleParts.push(`ID ${options.campaignId}`);
      }
      const title = titleParts.join(" • ");
      const tooltipLines = entry.intervals.length
        ? [
          ...(entry.hasSpendLimit ? ["Финстоп: лимит расходов / бюджета"] : []),
          ...entry.intervals
            .slice()
            .sort((left, right) => left.startAt.getTime() - right.startAt.getTime())
            .map((interval) => {
              const meta = DAY_STATUS_MARKER_META[interval.statusKey] || { glyph: "•", label: interval.statusKey };
              const reasonSuffix = interval.reasons.length ? ` (${interval.reasons.join(", ")})` : "";
              return `${meta.glyph} ${meta.label}: ${formatChartClockLabel(interval.startAt)} → ${formatChartClockLabel(interval.endAt, { endOfDay: true })}${reasonSuffix}`;
            }),
        ]
        : [
          ...(entry.hasSpendLimit ? ["Финстоп: лимит расходов / бюджета"] : []),
          ...orderedStatuses.map((statusKey) => {
            const meta = DAY_STATUS_MARKER_META[statusKey];
            return `${meta.glyph} ${meta.label}`;
          }),
        ];
      const safeTooltipLines = tooltipLines.length ? tooltipLines : ["Статусы: нет"];
      const chips = DAY_STATUS_MARKER_ORDER
        .map((statusKey) => {
          const meta = DAY_STATUS_MARKER_META[statusKey];
          const isActive = orderedStatuses.includes(statusKey);
          return `
            <span
              class="chart-status-chip status-${escapeHtml(statusKey)}${isActive ? " is-active" : " is-empty"}"
            >${isActive ? escapeHtml(meta.glyph) : ""}</span>
          `;
        })
        .join("");
      return `
        <div class="chart-status-column${entry.hasSpendLimit ? " has-budget-alert" : ""}" ${chartTooltipAttrs(title, safeTooltipLines)}>
          <div class="chart-status-stack">
            ${chips}
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="chart-status-strip" style="${columnsStyle}" aria-label="Статусы активности РК по дням">
      ${statusCells}
    </div>
  `;
}

function estimateChartLabelWidth(text, fontSize = 15) {
  const safeText = String(text || "");
  return Math.max(34, safeText.length * fontSize * 0.62);
}

function chartLabelBounds(label, gap = 8) {
  const width = label.width || estimateChartLabelWidth(label.text);
  if (label.anchor === "start") {
    return { left: label.x - gap, right: label.x + width + gap };
  }
  if (label.anchor === "end") {
    return { left: label.x - width - gap, right: label.x + gap };
  }
  return {
    left: label.x - width / 2 - gap,
    right: label.x + width / 2 + gap,
  };
}

function chartLabels(rows, options = {}) {
  if (!(rows || []).length) {
    return [];
  }
  const width = options.width || 620;
  const height = options.height || 220;
  const paddingX = options.paddingX || 30;
  const y = options.y || (height - 10);
  const positions = buildChartXPositions(rows.length, width, paddingX);
  const chartWidth = Math.max(width - paddingX * 2, 1);
  const minLabelGap = options.minLabelGap || 54;
  const maxLabels = Math.max(2, Math.floor(chartWidth / minLabelGap));
  const step = rows.length <= maxLabels ? 1 : Math.ceil((rows.length - 1) / Math.max(maxLabels - 1, 1));
  const gap = options.labelGap || 8;
  const candidateLabels = rows
    .map((row, index) => {
      const isFirst = index === 0;
      const isLast = index === rows.length - 1;
      const isVisible = isFirst || isLast || index % step === 0;
      if (!isVisible) {
        return null;
      }
      return {
        x: positions[index],
        y,
        text: chartAxisLabel(row),
        anchor: isFirst ? "start" : isLast ? "end" : "middle",
        width: estimateChartLabelWidth(chartAxisLabel(row)),
        isFirst,
        isLast,
      };
    })
    .filter(Boolean);

  const resolvedLabels = [];
  candidateLabels.forEach((label) => {
    const prev = resolvedLabels[resolvedLabels.length - 1];
    if (!prev) {
      resolvedLabels.push(label);
      return;
    }

    const prevBounds = chartLabelBounds(prev, gap);
    const currentBounds = chartLabelBounds(label, gap);
    const overlaps = currentBounds.left < prevBounds.right;
    if (!overlaps) {
      resolvedLabels.push(label);
      return;
    }

    if (label.isLast && !prev.isFirst) {
      resolvedLabels[resolvedLabels.length - 1] = label;
    }
  });

  return resolvedLabels;
}

function renderChartLabels(rows, options = {}) {
  return chartLabels(rows, options)
    .map(
      (label) => `
        <text x="${label.x}" y="${label.y}" text-anchor="${label.anchor}">
          ${escapeHtml(label.text)}
        </text>
      `,
    )
    .join("");
}

function chartTooltipAttrs(title, lines) {
  return `data-chart-tip="1" data-chart-title="${escapeHtml(title)}" data-chart-lines="${escapeHtml(JSON.stringify(lines || []))}"`;
}

function trimChartRows(rows, windowDays = DEFAULT_CHART_WINDOW_DAYS) {
  const normalizedWindow = Math.max(DEFAULT_CHART_WINDOW_DAYS, normalizeChartWindowDays(windowDays));
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (!normalizedRows.length || normalizedRows.length <= normalizedWindow) {
    return normalizedRows;
  }
  return normalizedRows.slice(-normalizedWindow);
}

function renderHoverSlices(rows, options, linesForRow) {
  if (!(rows || []).length) {
    return "";
  }
  const width = options.width || 620;
  const height = options.height || 220;
  const paddingX = options.paddingX || 30;
  const paddingTop = options.paddingTop || 18;
  const paddingBottom = options.paddingBottom || 56;
  const slices = buildChartSlices(rows.length, width, paddingX);

  return rows
    .map((row, index) => {
      const attrs = chartTooltipAttrs(chartDateLabel(row), linesForRow(row, index));
      return `<rect class="chart-hover-slice" x="${slices[index].x.toFixed(2)}" y="${paddingTop}" width="${slices[index].width.toFixed(2)}" height="${(height - paddingTop - paddingBottom).toFixed(2)}" fill="transparent" ${attrs}></rect>`;
    })
    .join("");
}

function chartSeriesKey(value, index = 0) {
  const normalized = String(value || `series-${index}`)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `series-${index}`;
}

function renderChartLegend(items = []) {
  return items
    .filter((item) => item?.label)
    .map((item, index) => {
      const key = item.key || chartSeriesKey(item.label, index);
      const isToggle = item.toggle !== false;
      return `
        <button
          type="button"
          class="chart-legend-item ${isToggle ? "" : "is-static"}"
          ${isToggle ? `data-chart-toggle="${escapeHtml(key)}"` : ""}
        >
          <i style="--swatch:${item.color}"></i>
          ${escapeHtml(item.label)}
        </button>
      `;
    })
    .join("");
}

function parseChartTooltipLines(rawValue) {
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return String(rawValue)
      .split("||")
      .filter(Boolean);
  }
}

function normalizeTooltipToneToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function chartTooltipTone(label) {
  const normalized = normalizeTooltipToneToken(label);
  if (!normalized) {
    return "neutral";
  }
  if (/лимит расходов|лимит бюджета|budget|бюджет|day_budget|limit|лимит|финстоп/.test(normalized)) {
    return "alert-danger";
  }
  if (/актив|active|✓/.test(normalized)) {
    return "status-active";
  }
  if (/заморож|freeze|❄/.test(normalized)) {
    return "status-freeze";
  }
  if (/приост|pause|paused|⏸/.test(normalized)) {
    return "status-paused";
  }
  if (/ставк|показ|клик|ctr|cpc|cpm|охват|позици/.test(normalized)) {
    return "metric-traffic";
  }
  if (/drr|дрр|расход|cpo|cpl|спенд/.test(normalized)) {
    return "metric-cost";
  }
  if (/корзин|заказ|выручк|доход|cr1|cr2|crf|остаток|stock/.test(normalized)) {
    return "metric-orders";
  }
  if (/рк|статус|за день|период|пользоват/.test(normalized)) {
    return "meta";
  }
  return "neutral";
}

function parseChartTooltipTextLine(line) {
  const text = String(line || "").trim();
  if (!text) {
    return null;
  }
  const shouldStackPairValue = (value, { force = false } = {}) => {
    const safeValue = String(value || "").trim();
    return force || safeValue.length > 32 || /[()]/.test(safeValue) || /→/.test(safeValue);
  };
  const statusMatch = text.match(/^([✓❄⏸])\s*([^:]+):\s*(.+)$/);
  if (statusMatch) {
    const [, glyph, label, value] = statusMatch;
    return {
      kind: "pair",
      badge: `${glyph} ${String(label || "").trim()}`,
      value: String(value || "").trim(),
      tone: chartTooltipTone(label),
      layout: shouldStackPairValue(value, { force: true }) ? "stacked" : "inline",
    };
  }
  const pairMatch = text.match(/^([^:]{1,48}):\s*(.+)$/);
  if (pairMatch) {
    const [, badge, value] = pairMatch;
    return {
      kind: "pair",
      badge: String(badge || "").trim(),
      value: String(value || "").trim(),
      tone: chartTooltipTone(badge),
      layout: shouldStackPairValue(value) ? "stacked" : "inline",
    };
  }
  return {
    kind: "plain",
    text,
    tone: chartTooltipTone(text),
  };
}

function renderChartTooltipLine(line) {
  if (typeof line === "string") {
    const parsed = parseChartTooltipTextLine(line);
    if (!parsed) {
      return "";
    }
    if (parsed.kind === "pair") {
      return `
        <div class="chart-tooltip-metric-row tone-${escapeHtml(parsed.tone)}${parsed.layout === "stacked" ? " is-stacked" : ""}">
          <span class="chart-tooltip-metric-label">${escapeHtml(parsed.badge || "—")}</span>
          <span class="chart-tooltip-metric-value">${escapeHtml(parsed.value || "—")}</span>
        </div>
      `;
    }
    return `<span class="chart-tooltip-line tone-${escapeHtml(parsed.tone)}">${escapeHtml(parsed.text || "—")}</span>`;
  }
  if (!line || typeof line !== "object") {
    return "";
  }
  if (line.type === "divider") {
    return `<div class="chart-tooltip-divider" aria-hidden="true"></div>`;
  }
  if (line.type === "metric") {
    const tone = chartTooltipTone(line.label || "");
    return `
      <div class="chart-tooltip-metric-row tone-${escapeHtml(tone)}">
        <span class="chart-tooltip-metric-label">${escapeHtml(line.label || "—")}</span>
        <span class="chart-tooltip-metric-value">${escapeHtml(line.value || "—")}</span>
      </div>
    `;
  }
  if (line.type === "metric-grid") {
    const items = Array.isArray(line.items) ? line.items : [];
    return `
      <div class="chart-tooltip-metric-grid">
        ${items
          .map((item) => `
            <div class="chart-tooltip-metric-card tone-${escapeHtml(chartTooltipTone(item.label || ""))}">
              <span class="chart-tooltip-metric-card-label">${escapeHtml(item.label || "—")}</span>
              <strong class="chart-tooltip-metric-card-value">${escapeHtml(item.value || "—")}</strong>
            </div>
          `)
          .join("")}
      </div>
    `;
  }
  if (line.type === "cluster-table") {
    const rows = Array.isArray(line.rows) ? line.rows : [];
    const columns = Array.isArray(line.columns) ? line.columns : ["Кластер", "Позиция", "Охват", "Заказы"];
    return `
      <div class="chart-tooltip-table">
        <div class="chart-tooltip-table-head">
          ${columns.map((column) => `<span class="chart-tooltip-head-cell">${escapeHtml(column)}</span>`).join("")}
        </div>
        ${rows
          .map((row) => `
            <div class="chart-tooltip-table-row">
              <span class="chart-tooltip-cell name">${escapeHtml(row.name || "—")}</span>
              <span class="chart-tooltip-cell pos"><span class="chart-tooltip-pill">${escapeHtml(row.position || "—")}</span></span>
              <span class="chart-tooltip-cell reach">${escapeHtml(row.reach || "—")}</span>
              <span class="chart-tooltip-cell orders">${escapeHtml(row.orders || "—")}</span>
            </div>
          `)
          .join("")}
      </div>
    `;
  }
  return "";
}

function tooltipHasTable(lines = []) {
  return (Array.isArray(lines) ? lines : []).some(
    (line) => line && typeof line === "object" && (line.type === "cluster-table" || line.type === "metric"),
  );
}

function renderChartTooltipContentMarkup(title, lines = []) {
  const safeLines = Array.isArray(lines) ? lines : [];
  return `
    ${title ? `<strong>${escapeHtml(title)}</strong>` : ""}
    ${safeLines.map((line) => renderChartTooltipLine(line)).join("")}
  `;
}

function renderHighchartsTooltipMarkup(title, lines = []) {
  return buildHighchartsTooltipHtml(title, lines, renderChartTooltipLine);
}

function buildChartPointCustom(title, lines = []) {
  return {
    title,
    lines,
    tooltipHasTable: tooltipHasTable(lines),
  };
}

function resolveHighchartsTooltipPoint(context) {
  if (context?.point) {
    return context.point;
  }
  if (Array.isArray(context?.points)) {
    const withCustom = context.points.find((entry) => entry?.point?.custom);
    if (withCustom?.point) {
      return withCustom.point;
    }
    if (context.points[0]?.point) {
      return context.points[0].point;
    }
  }
  return null;
}

function renderHighchartsTooltipFromContext(context, fallbackLines = []) {
  const point = resolveHighchartsTooltipPoint(context);
  const title = point?.custom?.title || context?.key || point?.category || "—";
  const fallback = typeof fallbackLines === "function"
    ? fallbackLines(context, point)
    : fallbackLines;
  const lines = point?.custom?.lines || fallback || [];
  return renderHighchartsTooltipMarkup(title, lines);
}

function chartLabelStep(count) {
  const total = Number(count || 0);
  if (total <= 7) {
    return 1;
  }
  if (total <= 14) {
    return 2;
  }
  if (total <= 21) {
    return 3;
  }
  return 4;
}

function buildHighchartsXAxis(categories = [], options = {}) {
  const step = options.step || chartLabelStep(categories.length);
  return {
    categories,
    minPadding: options.minPadding ?? 0.04,
    maxPadding: options.maxPadding ?? 0.04,
    tickLength: 0,
    lineWidth: 0,
    gridLineWidth: options.gridLineWidth ?? 1,
    gridLineDashStyle: options.gridLineDashStyle || "Dash",
    gridLineColor: options.gridLineColor || "rgba(101, 93, 127, 0.28)",
    labels: {
      reserveSpace: true,
      y: options.labelOffsetY ?? 16,
      style: {
        color: "rgba(38, 33, 58, 0.82)",
        fontSize: options.labelFontSize || "15px",
        fontWeight: "700",
      },
      formatter: function formatter() {
        const index = Number(this.pos);
        const isFirst = index === 0;
        const isLast = index === categories.length - 1;
        if (isFirst || isLast || index % step === 0) {
          return categories[index] || "";
        }
        return "";
      },
    },
  };
}

function buildHiddenHighchartsYAxis(min = 0, max = 1) {
  const safeMin = Number.isFinite(Number(min)) ? Number(min) : 0;
  const safeMax = Number.isFinite(Number(max)) ? Number(max) : 1;
  const span = Math.max(safeMax - safeMin, 1);
  const paddedMin = safeMin <= 0 ? safeMin : Math.max(0, safeMin - span * 0.08);
  const paddedMax = safeMax + span * 0.12;
  return {
    min: paddedMin,
    max: paddedMax,
    title: {
      text: undefined,
    },
    endOnTick: false,
    startOnTick: false,
    gridLineWidth: 0,
    labels: {
      enabled: false,
    },
  };
}

function renderChartWindowControls(chartKey) {
  if (!chartKey) {
    return "";
  }
  const normalizedWindow = getChartWindowDays(chartKey);
  return `
    <div class="chart-window-switch" role="group" aria-label="Окно графика">
      ${[7, 14, 30]
        .map((days) => `
          <button
            type="button"
            class="chart-window-chip ${normalizedWindow === days ? "is-active" : ""}"
            data-chart-window="${days}"
            data-chart-key="${escapeHtml(chartKey)}"
          >
            ${days}
          </button>
        `)
        .join("")}
    </div>
  `;
}

function buildNativeTooltipConfig(fallbackLines = []) {
  return {
    enabled: true,
    shared: true,
    useHTML: true,
    outside: true,
    hideDelay: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    shadow: false,
    padding: 0,
    formatter: function formatter() {
      return renderHighchartsTooltipFromContext(this, fallbackLines);
    },
  };
}

function renderChartLoadingOverlay() {
  return `
    <div class="chart-loading-overlay" aria-hidden="true">
      <span class="loading-spinner"></span>
      <span>Прогрузка графика…</span>
    </div>
  `;
}

function renderPageLoadingOverlay() {
  return `
    <div class="product-loading-overlay" aria-hidden="true">
      <div class="product-loading-badge">
        <span class="loading-spinner"></span>
        <span>Прогрузка товара…</span>
      </div>
    </div>
  `;
}

function chartCard(title, note, legend, svg, tone = "neutral", options = {}) {
  return `
    <section class="chart-card tone-${escapeHtml(tone)} ${options.loading ? "is-loading" : ""}" ${options.chartKey ? `data-chart-key="${escapeHtml(options.chartKey)}"` : ""}>
      <div class="chart-card-head">
        <div>
          <h4>${escapeHtml(title)}</h4>
          ${note ? `<p>${escapeHtml(note)}</p>` : ""}
        </div>
        ${renderChartWindowControls(options.chartKey)}
      </div>
      <div class="chart-shell">
        ${svg}
        ${options.afterChartHtml || ""}
        <div class="chart-tooltip" hidden></div>
      </div>
      ${legend ? `<div class="chart-legend">${legend}</div>` : ""}
      ${options.loading ? renderChartLoadingOverlay() : ""}
    </section>
  `;
}

function computeCpm(spend, views) {
  if (!views || !Number(views)) {
    return null;
  }
  return (Number(spend || 0) / Number(views)) * 1000;
}

function computeRate(numerator, denominator) {
  if (!denominator || !Number(denominator)) {
    return null;
  }
  return (Number(numerator || 0) / Number(denominator)) * 100;
}

function computeDrr(spend, revenue) {
  if (!revenue || !Number(revenue)) {
    return null;
  }
  return (Number(spend || 0) / Number(revenue)) * 100;
}

function computeCrf(ctr, cr1, cr2) {
  if (
    ctr === null || ctr === undefined || Number.isNaN(Number(ctr))
    || cr1 === null || cr1 === undefined || Number.isNaN(Number(cr1))
    || cr2 === null || cr2 === undefined || Number.isNaN(Number(cr2))
  ) {
    return null;
  }
  return (Number(ctr) * Number(cr1) * Number(cr2)) / 10000;
}

function buildFunnelLayout(product) {
  const totals = totalsForProduct(product);
  const comparison = product.comparison || {};
  const aov = totals.orders ? Number(totals.sum_price || 0) / Number(totals.orders) : null;
  const prevExpense = comparisonPreviousValue(comparison.sum);
  const tiles = [
    { customMarkup: combinedFunnelTile(totals, comparison, product) },
    {
      label: "Выручка с рекламы",
      key: "revenue",
      value: formatMoney(totals.sum_price),
      metaItems: [
        { label: "Ср. чек", value: formatMoney(aov) },
        { label: "ДРР", value: formatPercent(totals.DRR) },
      ],
    },
    {
      label: "Заказано всего",
      key: "revenue_total",
      value: formatMoney(totals.ordered_sum_total),
      metaItems: [
        metricMetaItem("Расход", totals.expense_sum, "money", { previous: prevExpense, invert: true }),
      ],
    },
    {
      label: "Доп. выручка",
      key: "rel_sum_price",
      value: formatMoney(totals.rel_sum_price),
      metaItems: [
        metricMetaItem("Доп. заказы", totals.rel_shks, "number", { previous: comparisonPreviousValue(comparison.rel_shks) }),
      ],
      tone: "inventory",
    },
  ];

  return `
    <div class="metric-grid">
      ${tiles
        .map((tile) => {
          if (tile.customMarkup) {
            return tile.customMarkup;
          }
          const state = { ...metricState(tile.key, totals[tile.key]) };
          if (tile.tone) {
            state.tone = tile.tone;
          }
          return metricTile(tile.label, tile.value, {
            state,
            metaItems: tile.metaItems,
            primaryDelta: tile.primaryDelta,
          });
        })
        .join("")}
    </div>
  `;
}

function renderAreaChart(rows, config) {
  const visibleRows = trimChartRows(rows, config.windowDays);
  if (!visibleRows.length) {
    return emptyBlock("Недостаточно данных для графика.");
  }
  const values = seriesFromRows(visibleRows, config.field);
  const chartHeight = config.height || 220;
  const peak = Math.max(...values, 0);
  const seriesKey = chartSeriesKey(config.field || config.title);
  const legend = renderChartLegend([
    { key: seriesKey, label: `Пик ${config.formatter(peak)}`, color: config.color },
  ]);
  const categories = visibleRows.map((row) => chartAxisLabel(row));
  const chartMarkup = renderHighchartsHost(
    () => ({
      chart: {
        type: "area",
        height: chartHeight,
        spacing: [14, 18, 30, 18],
      },
      xAxis: buildHighchartsXAxis(categories, {
        labelFontSize: chartHeight <= 170 ? "12px" : "15px",
      }),
      yAxis: buildHiddenHighchartsYAxis(0, Math.max(...values, 1)),
      tooltip: buildNativeTooltipConfig((context) => [`${config.title}: ${config.formatter(context?.y)}`]),
      plotOptions: {
        area: {
          lineWidth: 3,
          marker: {
            enabled: true,
            radius: 3.5,
            fillColor: config.color,
          },
          fillColor: {
            linearGradient: [0, 0, 0, chartHeight],
            stops: [
              [0, `${config.color}66`],
              [1, `${config.color}0a`],
            ],
          },
          threshold: 0,
        },
      },
      series: [
        {
          type: "area",
          color: config.color,
          data: values.map((value, index) => ({
            y: value,
            custom: buildChartPointCustom(
              chartDateLabel(visibleRows[index]),
              [`${config.title}: ${config.formatter(value)}`],
            ),
          })),
          custom: {
            seriesKey,
          },
        },
      ],
    }),
    {
      className: "trend-chart",
      height: chartHeight,
      prefix: "area",
    },
  );
  return chartCard(config.title, config.note, legend, chartMarkup, config.tone, {
    chartKey: config.chartKey,
    loading: config.loading,
  });
}

function renderBarChart(rows, config) {
  const visibleRows = trimChartRows(rows, config.windowDays);
  if (!visibleRows.length) {
    return emptyBlock("Недостаточно данных для графика.");
  }
  const values = seriesFromRows(visibleRows, config.field);
  const chartHeight = config.height || 220;
  const seriesKey = chartSeriesKey(config.field || config.title);
  const legend = renderChartLegend([
    { key: seriesKey, label: `Всего ${config.formatter(values.reduce((acc, value) => acc + value, 0))}`, color: config.color },
  ]);
  const categories = visibleRows.map((row) => chartAxisLabel(row));
  const chartMarkup = renderHighchartsHost(
    () => ({
      chart: {
        type: "column",
        height: chartHeight,
        spacing: [14, 18, 30, 18],
      },
      xAxis: buildHighchartsXAxis(categories, {
        labelFontSize: chartHeight <= 170 ? "12px" : "15px",
      }),
      yAxis: buildHiddenHighchartsYAxis(0, Math.max(...values, 1)),
      tooltip: buildNativeTooltipConfig((context) => [`${config.title}: ${config.formatter(context?.y)}`]),
      plotOptions: {
        column: {
          borderWidth: 0,
          borderRadius: 10,
          pointPadding: 0.16,
          groupPadding: 0.14,
        },
      },
      series: [
        {
          type: "column",
          color: config.color,
          data: values.map((value, index) => ({
            y: value,
            custom: buildChartPointCustom(
              chartDateLabel(visibleRows[index]),
              [`${config.title}: ${config.formatter(value)}`],
            ),
          })),
          custom: {
            seriesKey,
          },
        },
      ],
    }),
    {
      className: "trend-chart",
      height: chartHeight,
      prefix: "bar",
    },
  );
  return chartCard(config.title, config.note, legend, chartMarkup, config.tone, {
    chartKey: config.chartKey,
    loading: config.loading,
  });
}

function renderComboChart(rows, config) {
  const visibleRows = trimChartRows(rows, config.windowDays);
  if (!visibleRows.length) {
    return emptyBlock("Недостаточно данных для графика.");
  }

  const chartHeight = config.height || 220;

  const lineValues = seriesFromRows(visibleRows, config.lineField);
  const barSeries = (config.barSeries && config.barSeries.length
    ? config.barSeries
    : [{
        field: config.barField,
        label: config.barLabel,
        color: config.barColor,
        formatter: config.barFormatter,
      }])
    .map((series) => ({
      ...series,
      values: typeof series.getValue === "function"
      ? visibleRows.map((row) => safeNumber(series.getValue(row), 0))
      : seriesFromRows(visibleRows, series.field),
    }));
  const lineMax = Math.max(...lineValues, 1);
  const plotLineValues = lineValues.map((value) => (value / lineMax) * 100);
  const flatBarValues = barSeries.flatMap((series) => series.values);
  const barMax = Math.max(...flatBarValues, 1);
  const plotBarSeries = barSeries.map((series) => ({
    ...series,
    plotValues: series.values.map((value) => (value / barMax) * 100),
  }));
  const lineSeriesKey = chartSeriesKey(config.lineField || config.lineLabel, 0);
  const computedLineLegendValue = typeof config.lineLegendValue === "function"
    ? config.lineLegendValue(lineValues, visibleRows)
    : (config.lineLegendValue ?? lineValues.reduce((acc, value) => acc + value, 0));
  const lineLegendText = typeof config.lineLegendFormatter === "function"
    ? config.lineLegendFormatter(computedLineLegendValue, visibleRows)
    : config.lineFormatter(computedLineLegendValue);
  const legend = renderChartLegend([
    { key: lineSeriesKey, label: `${config.lineLabel} ${lineLegendText}`, color: config.lineColor },
    ...barSeries.map((series, index) => ({
      key: series.key || chartSeriesKey(series.field || series.label, index + 1),
      label: `${series.label} ${series.formatter(series.values.reduce((acc, value) => acc + value, 0))}`,
      color: series.color,
    })),
    ...((config.extraLegend || []).map((item, index) => ({
      key: item.key || chartSeriesKey(item.label, index + 100),
      label: item.label,
      color: item.color,
      toggle: false,
    }))),
  ]);
  const categories = visibleRows.map((row) => chartAxisLabel(row));
  const chartMarkup = renderHighchartsHost(
    () => ({
      chart: {
        height: chartHeight,
        spacing: [14, 18, 30, 18],
      },
      xAxis: buildHighchartsXAxis(categories, {
        labelFontSize: chartHeight <= 170 ? "12px" : "15px",
      }),
      yAxis: buildHiddenHighchartsYAxis(0, 100),
      tooltip: buildNativeTooltipConfig(),
      plotOptions: {
        column: {
          borderWidth: 0,
          borderRadius: 10,
          pointPadding: 0.12,
          groupPadding: 0.16,
        },
        area: {
          lineWidth: 3,
          marker: {
            enabled: true,
            radius: 3.2,
            fillColor: config.lineColor,
          },
          fillColor: {
            linearGradient: [0, 0, 0, chartHeight],
            stops: [
              [0, `${config.lineColor}4d`],
              [1, `${config.lineColor}08`],
            ],
          },
        },
      },
      series: [
        ...plotBarSeries.map((series, index) => ({
          type: "column",
          name: series.label,
          color: series.color,
          data: series.values.map((value, pointIndex) => ({
            y: series.plotValues[pointIndex],
            custom: buildChartPointCustom(
              chartDateLabel(visibleRows[pointIndex]),
              [
                `${config.lineLabel}: ${config.lineFormatter(lineValues[pointIndex])}`,
                ...barSeries.map((item) => `${item.label}: ${item.formatter(item.values[pointIndex])}`),
                ...((config.tooltipExtras || []).map((item) => `${item.label}: ${item.value}`)),
              ],
            ),
          })),
          custom: {
            seriesKey: series.key || chartSeriesKey(series.field || series.label, index + 1),
          },
        })),
        {
          type: "area",
          name: config.lineLabel,
          color: config.lineColor,
          data: plotLineValues.map((value, index) => ({
            y: value,
            custom: buildChartPointCustom(
              chartDateLabel(visibleRows[index]),
              [
                `${config.lineLabel}: ${config.lineFormatter(lineValues[index])}`,
                ...barSeries.map((series) => `${series.label}: ${series.formatter(series.values[index])}`),
                ...((config.tooltipExtras || []).map((item) => `${item.label}: ${item.value}`)),
              ],
            ),
          })),
          custom: {
            seriesKey: lineSeriesKey,
          },
        },
      ],
    }),
    {
      className: "trend-chart",
      height: chartHeight,
      prefix: "combo",
    },
  );

  return chartCard(config.title, config.note, legend, chartMarkup, config.tone, {
    chartKey: config.chartKey,
    loading: config.loading,
  });
}

function renderDayGuides(rows, { width, height, paddingX, paddingTop, paddingBottom }) {
  return buildChartXPositions(rows.length, width, paddingX)
    .map(
      (x) => `
        <line
          x1="${x.toFixed(2)}"
          y1="${paddingTop}"
          x2="${x.toFixed(2)}"
          y2="${(height - paddingBottom).toFixed(2)}"
          class="chart-day-guide"
        ></line>
      `,
    )
    .join("");
}

function renderMultiLineChart(rows, config) {
  const visibleRows = trimChartRows(rows, config.windowDays);
  if (!visibleRows.length) {
    return emptyBlock("Недостаточно данных для графика.");
  }
  const hasDayStatusTable = config.dayStatusMap instanceof Map && config.dayStatusMap.size > 0;
  const chartHeight = config.height || 220;
  const seriesValues = config.series.map((series) =>
    typeof series.getValue === "function"
      ? visibleRows.map((row) => safeNumber(series.getValue(row), 0))
      : seriesFromRows(visibleRows, series.field),
  );
  const barSeries = (config.barSeries || []).map((series) => ({
    ...series,
    values: typeof series.getValue === "function"
      ? visibleRows.map((row) => {
          const rawValue = series.getValue(row);
          if (series.preserveNull && (rawValue === null || rawValue === undefined || Number.isNaN(Number(rawValue)))) {
            return null;
          }
          return safeNumber(rawValue, 0);
        })
      : visibleRows.map((row) => {
          const rawValue = row?.[series.field];
          if (series.preserveNull && (rawValue === null || rawValue === undefined || Number.isNaN(Number(rawValue)))) {
            return null;
          }
          return safeNumber(rawValue, 0);
        }),
  }));
  const normalizedSets = config.normalizeEach
    ? seriesValues.map((values) => {
        const max = Math.max(...values, 1);
        return values.map((value) => (value / max) * 100);
      })
    : seriesValues;
  const normalizedBarSets = config.normalizeEach
    ? (() => {
        if (config.normalizeBarsEach) {
          return barSeries.map((series) => {
            const definedValues = series.values.filter((value) => value !== null && value !== undefined);
            const seriesMax = Math.max(...definedValues, 1);
            return series.values.map((value) => {
              if (value === null || value === undefined) {
                return null;
              }
              if (series.invertScale) {
                return ((Math.max(seriesMax - value, 0) + 1) / seriesMax) * 100;
              }
              return (value / seriesMax) * 100;
            });
          });
        }
        const definedValues = barSeries.flatMap((series) => series.values.filter((value) => value !== null && value !== undefined));
        const sharedBarMax = Math.max(...definedValues, 1);
        return barSeries.map((series) => series.values.map((value) => {
          if (value === null || value === undefined) {
            return null;
          }
          if (series.invertScale) {
            return ((Math.max(sharedBarMax - value, 0) + 1) / sharedBarMax) * 100;
          }
          return (value / sharedBarMax) * 100;
        }));
      })()
    : barSeries.map((series) => series.values);
  const flatValues = [...normalizedSets.flat(), ...normalizedBarSets.flat().filter((value) => value !== null && value !== undefined)];
  const max = Math.max(...flatValues, 1);
  const min = 0;
  const tooltipLinesForRow = (row, index) => {
    if (typeof config.tooltipLinesBuilder === "function") {
      return config.tooltipLinesBuilder(row, index, { seriesValues, barSeries });
    }
    const baseLines = [
      ...config.series.map((series, seriesIndex) => `${series.label}: ${series.formatter(seriesValues[seriesIndex][index])}`),
      ...barSeries.map((series, seriesIndex) => `${series.label}: ${series.formatter(series.values[index], rows[index])}`),
    ];
    const extraLines = typeof config.tooltipLinesForRow === "function" ? (config.tooltipLinesForRow(row, index) || []) : [];
    return [...baseLines, ...extraLines];
  };
  const categories = visibleRows.map((row) => chartAxisLabel(row));
  const statusTable = hasDayStatusTable
    ? renderDayStatusTable(visibleRows, {
        dayStatusMap: config.dayStatusMap,
        campaignId: config.campaignId,
      })
    : "";
  const legend = renderChartLegend(
    [
      ...config.series.map((series, index) => ({
        key: series.key || chartSeriesKey(series.field || series.label, index),
        label: series.label,
        color: series.color,
      })),
      ...barSeries.map((series, index) => ({
        key: series.key || chartSeriesKey(series.field || series.label, index + config.series.length),
        label: series.label,
        color: series.color,
      })),
    ],
  );
  const chartMarkup = renderHighchartsHost(
    () => ({
      chart: {
        height: chartHeight,
        spacing: [14, 18, 32, 18],
      },
      xAxis: buildHighchartsXAxis(categories, {
        labelFontSize: chartHeight <= 170 ? "12px" : "15px",
      }),
      yAxis: buildHiddenHighchartsYAxis(min, max),
      tooltip: buildNativeTooltipConfig(),
      plotOptions: {
        column: {
          borderWidth: 0,
          borderRadius: 8,
          pointPadding: 0.08,
          groupPadding: 0.14,
          grouping: true,
        },
        line: {
          lineWidth: 3,
          marker: {
            enabled: true,
            radius: 2.8,
          },
          states: {
            hover: {
              lineWidthPlus: 0,
            },
          },
        },
      },
      series: [
        ...barSeries.map((series, seriesIndex) => ({
          type: "column",
          name: series.label,
          color: series.color,
          opacity: series.opacity ?? 0.42,
          data: normalizedBarSets[seriesIndex].map((value, index) => {
            if (value === null || value === undefined) {
              return null;
            }
            return {
              y: value,
              custom: buildChartPointCustom(
                chartDateLabel(visibleRows[index]),
                tooltipLinesForRow(visibleRows[index], index),
              ),
            };
          }),
          custom: {
            seriesKey: series.key || chartSeriesKey(series.field || series.label, seriesIndex + config.series.length),
          },
        })),
        ...config.series.map((series, index) => ({
          type: "line",
          name: series.label,
          color: series.color,
          data: normalizedSets[index].map((value, pointIndex) => ({
            y: value,
            custom: buildChartPointCustom(
              chartDateLabel(visibleRows[pointIndex]),
              tooltipLinesForRow(visibleRows[pointIndex], pointIndex),
            ),
          })),
          custom: {
            seriesKey: series.key || chartSeriesKey(series.field || series.label, index),
          },
        })),
      ],
    }),
    {
      className: "trend-chart",
      height: chartHeight,
      prefix: "multi",
    },
  );
  return chartCard(config.title, config.note, legend, chartMarkup, config.tone, {
    chartKey: config.chartKey,
    loading: config.loading,
    afterChartHtml: statusTable,
  });
}

function renderEfficiencyMiniChart(rows, config) {
  const visibleRows = trimChartRows(rows, config.windowDays);
  if (!visibleRows.length) {
    return "";
  }
  const chartHeight = config.height || 94;
  const values = visibleRows.map((row) =>
    typeof config.getValue === "function"
      ? safeNumber(config.getValue(row), 0)
      : safeNumber(row?.[config.field], 0),
  );
  const current = values[values.length - 1] ?? null;
  const categories = visibleRows.map((row) => chartAxisLabel(row));
  const chartMarkup = renderHighchartsHost(
    () => ({
      chart: {
        type: "line",
        height: chartHeight,
        spacing: config.showAxisLabels ? [8, 18, 24, 18] : [8, 18, 12, 18],
      },
      xAxis: {
        ...buildHighchartsXAxis(categories, {
          labelFontSize: "12px",
          step: config.showAxisLabels ? chartLabelStep(categories.length) : categories.length + 1,
          labelOffsetY: 14,
        }),
        labels: config.showAxisLabels
          ? buildHighchartsXAxis(categories, {
              labelFontSize: "12px",
              step: chartLabelStep(categories.length),
              labelOffsetY: 14,
            }).labels
          : { enabled: false },
      },
      yAxis: buildHiddenHighchartsYAxis(0, Math.max(...values, 1)),
      tooltip: buildNativeTooltipConfig((context) => [`${config.label}: ${config.formatter(context?.y)}`]),
      plotOptions: {
        line: {
          lineWidth: 3,
          marker: {
            enabled: true,
            radius: 2.8,
            fillColor: config.color,
          },
          states: {
            hover: {
              lineWidthPlus: 0,
            },
          },
        },
      },
      series: [
        {
          type: "line",
          color: config.color,
          data: values.map((value, index) => ({
            y: value,
            custom: buildChartPointCustom(
              chartDateLabel(visibleRows[index]),
              [`${config.label}: ${config.formatter(value)}`],
            ),
          })),
          custom: {
            seriesKey: chartSeriesKey(config.label, 0),
          },
        },
      ],
    }),
    {
      className: "efficiency-mini-chart",
      height: chartHeight,
      prefix: "efficiency",
    },
  );
  return `
    <div class="efficiency-mini${config.showAxisLabels ? " has-axis-labels" : ""}">
      <div class="efficiency-mini-head">
        <span class="efficiency-mini-label">
          <i style="--swatch:${config.color}"></i>
          ${escapeHtml(config.label)}
        </span>
        <strong>${escapeHtml(config.formatter(current))}</strong>
      </div>
      <div class="chart-shell">${chartMarkup}</div>
    </div>
  `;
}

function renderEfficiencySplitCard(rows, options = {}) {
  if (!(trimChartRows(rows, options.windowDays) || []).length) {
    return emptyBlock("Недостаточно данных для графика.");
  }
  return `
    <section class="chart-card tone-warn ${options.loading ? "is-loading" : ""}" ${options.chartKey ? `data-chart-key="${escapeHtml(options.chartKey)}"` : ""}>
      <div class="chart-card-head">
        <div>
          <h4>Эффективность: CTR, CR1, CR2, CRF</h4>
        </div>
        ${renderChartWindowControls(options.chartKey)}
      </div>
      <div class="efficiency-mini-stack">
        ${renderEfficiencyMiniChart(rows, {
          field: "CTR",
          label: "CTR",
          color: "#2e9f73",
          formatter: (value) => formatPercent(value),
          showAxisLabels: false,
          windowDays: options.windowDays,
        })}
        ${renderEfficiencyMiniChart(rows, {
          label: "CR1",
          color: "#1c9ed8",
          getValue: (row) => computeRate(row.atbs, row.clicks),
          formatter: (value) => formatPercent(value),
          showAxisLabels: false,
          windowDays: options.windowDays,
        })}
        ${renderEfficiencyMiniChart(rows, {
          label: "CR2",
          color: "#8b64f6",
          getValue: (row) => computeRate(row.orders, row.atbs),
          formatter: (value) => formatPercent(value),
          showAxisLabels: false,
          windowDays: options.windowDays,
        })}
        ${renderEfficiencyMiniChart(rows, {
          label: "CRF",
          color: "#f17828",
          getValue: (row) => computeCrf(
            row.CTR,
            computeRate(row.atbs, row.clicks),
            computeRate(row.orders, row.atbs),
          ),
          formatter: (value) => formatPercent(value),
          showAxisLabels: true,
          windowDays: options.windowDays,
        })}
      </div>
      ${options.loading ? renderChartLoadingOverlay() : ""}
    </section>
  `;
}

function renderCampaignEfficiencyCard(rows, options = {}) {
  if (!(trimChartRows(rows, options.windowDays) || []).length) {
    return "";
  }
  return `
    <section class="chart-card tone-warn ${options.loading ? "is-loading" : ""}" ${options.chartKey ? `data-chart-key="${escapeHtml(options.chartKey)}"` : ""}>
      <div class="chart-card-head">
        <div>
          <h4>Эффективность РК: CTR, CPC, CPM</h4>
        </div>
        ${renderChartWindowControls(options.chartKey)}
      </div>
      <div class="efficiency-mini-stack">
        ${renderEfficiencyMiniChart(rows, {
          field: "CTR",
          label: "CTR",
          color: "#2e9f73",
          formatter: (value) => formatPercent(value),
          showAxisLabels: false,
          height: options.height || 72,
          windowDays: options.windowDays,
        })}
        ${renderEfficiencyMiniChart(rows, {
          field: "CPC",
          label: "CPC",
          color: "#1c9ed8",
          formatter: (value) => formatMoney(value),
          showAxisLabels: false,
          height: options.height || 72,
          windowDays: options.windowDays,
        })}
        ${renderEfficiencyMiniChart(rows, {
          field: "CPM",
          label: "CPM",
          color: "#8b64f6",
          formatter: (value) => formatMoney(value),
          showAxisLabels: true,
          height: options.height || 72,
          windowDays: options.windowDays,
        })}
      </div>
      ${options.loading ? renderChartLoadingOverlay() : ""}
    </section>
  `;
}

function buildCampaignDailyRowsFromClusters(campaign, baseRows = [], options = {}) {
  const includeEmpty = Boolean(options.includeEmpty);
  const baseDays = (baseRows || [])
    .map((row) => row?.day)
    .filter(Boolean);
  const aggregate = new Map();

  baseDays.forEach((day) => {
    aggregate.set(day, {
      day,
      views: 0,
      clicks: 0,
      expense_sum: 0,
    });
  });

  (((campaign || {}).clusters || {}).items || []).forEach((cluster) => {
    Object.entries(cluster.daily || {}).forEach(([day, payload]) => {
      if (!aggregate.has(day)) {
        aggregate.set(day, {
          day,
          views: 0,
          clicks: 0,
          expense_sum: 0,
        });
      }
      const bucket = aggregate.get(day);
      bucket.views += safeNumber(payload?.views, 0);
      bucket.clicks += safeNumber(payload?.clicks, 0);
      bucket.atbs += safeNumber(payload?.atbs, 0);
      bucket.orders += safeNumber(payload?.orders, 0);
      bucket.expense_sum += safeNumber(payload?.expense, 0);
    });
  });

  const campaignTotals = {
    views: safeNumber(campaign?.metrics?.views, null),
    clicks: safeNumber(campaign?.metrics?.clicks, null),
    atbs: safeNumber(campaign?.metrics?.atbs, null),
    orders: safeNumber(campaign?.metrics?.orders, null),
    expense_sum: safeNumber(campaign?.metrics?.sum, null),
  };

  const rawTotals = Array.from(aggregate.values()).reduce(
    (acc, row) => {
      acc.views += safeNumber(row.views, 0);
      acc.clicks += safeNumber(row.clicks, 0);
      acc.atbs += safeNumber(row.atbs, 0);
      acc.orders += safeNumber(row.orders, 0);
      acc.expense_sum += safeNumber(row.expense_sum, 0);
      return acc;
    },
    { views: 0, clicks: 0, atbs: 0, orders: 0, expense_sum: 0 },
  );

  const scaleFactor = (metric) => {
    const target = campaignTotals[metric];
    const source = rawTotals[metric];
    if (target === null || target === undefined || !Number.isFinite(Number(target))) {
      return 1;
    }
    if (!source) {
      return 1;
    }
    return Number(target) / Number(source);
  };

  const expenseScale = scaleFactor("expense_sum");
  const viewsScale = scaleFactor("views");
  const clicksScale = scaleFactor("clicks");
  const atbsScale = scaleFactor("atbs");
  const ordersScale = scaleFactor("orders");

  const rows = Array.from(aggregate.values())
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .map((row) => ({
      ...row,
      views: safeNumber(row.views, 0) * viewsScale,
      clicks: safeNumber(row.clicks, 0) * clicksScale,
      atbs: safeNumber(row.atbs, 0) * atbsScale,
      orders: safeNumber(row.orders, 0) * ordersScale,
      expense_sum: safeNumber(row.expense_sum, 0) * expenseScale,
    }));

  rows.forEach((row) => {
    row.CTR = computeRate(row.clicks, row.views);
    row.CPC = row.clicks ? row.expense_sum / row.clicks : null;
    row.CPM = computeCpm(row.expense_sum, row.views);
  });

  return includeEmpty ? rows : rows.filter((row) => row.views || row.clicks || row.expense_sum);
}

function buildCampaignDailyRows(campaign, baseRows = [], options = {}) {
  const includeEmpty = Boolean(options.includeEmpty);
  const exactRows = ((campaign || {}).daily_exact || [])
    .filter((row) => row?.day)
    .map((row) => ({
      day: row.day,
      views: safeNumber(row.views, 0),
      clicks: safeNumber(row.clicks, 0),
      atbs: safeNumber(row.atbs, 0),
      orders: safeNumber(row.orders, 0),
      expense_sum: safeNumber(row.expense_sum, 0),
      sum_price: safeNumber(row.sum_price, 0),
      CTR: safeNumber(row.CTR, null),
      CPC: safeNumber(row.CPC, null),
      CR: safeNumber(row.CR, null),
      CPO: safeNumber(row.CPO, null),
      CPO_with_rel: safeNumber(row.CPO_with_rel, null),
    }))
    .sort((left, right) => String(left.day).localeCompare(String(right.day)));

  if (exactRows.length) {
    exactRows.forEach((row) => {
      row.CTR = row.CTR ?? computeRate(row.clicks, row.views);
      row.CPC = row.CPC ?? (row.clicks ? row.expense_sum / row.clicks : null);
      row.CPM = computeCpm(row.expense_sum, row.views);
    });
    return includeEmpty ? exactRows : exactRows.filter((row) => row.views || row.clicks || row.expense_sum);
  }

  const normalizedBaseRows = (baseRows || [])
    .filter((row) => row?.day)
    .map((row) => ({
      day: row.day,
      views: safeNumber(row.views, 0),
      clicks: safeNumber(row.clicks, 0),
      atbs: safeNumber(row.atbs, 0),
      orders: safeNumber(row.orders, 0),
      expense_sum: safeNumber(row.expense_sum, 0),
    }))
    .sort((left, right) => String(left.day).localeCompare(String(right.day)));

  if (!normalizedBaseRows.length) {
    return buildCampaignDailyRowsFromClusters(campaign, baseRows, options);
  }

  const productTotals = normalizedBaseRows.reduce(
    (acc, row) => {
      acc.views += row.views;
      acc.clicks += row.clicks;
      acc.atbs += row.atbs;
      acc.orders += row.orders;
      acc.expense_sum += row.expense_sum;
      return acc;
    },
    { views: 0, clicks: 0, atbs: 0, orders: 0, expense_sum: 0 },
  );

  const campaignTotals = {
    views: safeNumber(campaign?.metrics?.views, null),
    clicks: safeNumber(campaign?.metrics?.clicks, null),
    atbs: safeNumber(campaign?.metrics?.atbs, null),
    orders: safeNumber(campaign?.metrics?.orders, null),
    expense_sum: safeNumber(campaign?.metrics?.sum, null),
  };

  const shares = {
    views: productTotals.views > 0 && Number.isFinite(Number(campaignTotals.views))
      ? Number(campaignTotals.views) / productTotals.views
      : null,
    clicks: productTotals.clicks > 0 && Number.isFinite(Number(campaignTotals.clicks))
      ? Number(campaignTotals.clicks) / productTotals.clicks
      : null,
    atbs: productTotals.atbs > 0 && Number.isFinite(Number(campaignTotals.atbs))
      ? Number(campaignTotals.atbs) / productTotals.atbs
      : null,
    orders: productTotals.orders > 0 && Number.isFinite(Number(campaignTotals.orders))
      ? Number(campaignTotals.orders) / productTotals.orders
      : null,
    expense_sum: productTotals.expense_sum > 0 && Number.isFinite(Number(campaignTotals.expense_sum))
      ? Number(campaignTotals.expense_sum) / productTotals.expense_sum
      : null,
  };

  const hasProductShareModel = Object.values(shares).some((value) => value !== null);
  if (!hasProductShareModel) {
    return buildCampaignDailyRowsFromClusters(campaign, baseRows, options);
  }

  const rows = normalizedBaseRows.map((row) => ({
    day: row.day,
    views: shares.views === null ? 0 : row.views * shares.views,
    clicks: shares.clicks === null ? 0 : row.clicks * shares.clicks,
    atbs: shares.atbs === null ? 0 : row.atbs * shares.atbs,
    orders: shares.orders === null ? 0 : row.orders * shares.orders,
    expense_sum: shares.expense_sum === null ? 0 : row.expense_sum * shares.expense_sum,
  }));

  rows.forEach((row) => {
    row.CTR = computeRate(row.clicks, row.views);
    row.CPC = row.clicks ? row.expense_sum / row.clicks : null;
    row.CPM = computeCpm(row.expense_sum, row.views);
  });

  return includeEmpty ? rows : rows.filter((row) => row.views || row.clicks || row.expense_sum);
}

function normalizeBidHistoryRows(campaign) {
  return ((campaign || {}).bid_history || [])
    .map((row) => {
      const rawDate = row?.datetime_sort || row?.datetime || "";
      const dateValue = row?.datetime_sort ? new Date(row.datetime_sort) : null;
      const fallbackValue = String(rawDate || "")
        .replace(/^(\d{2})-(\d{2})-(\d{4})/, "$3-$2-$1")
        .replace(" ", "T");
      const parsed = dateValue && !Number.isNaN(dateValue.getTime())
        ? dateValue
        : new Date(fallbackValue);
      const bidValue = safeNumber(row?.cpm ?? row?.bid ?? row?.new_bid, null);
      if (!parsed || Number.isNaN(parsed.getTime()) || bidValue === null) {
        return null;
      }
      return {
        at: parsed,
        bid: bidValue,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.at - right.at);
}

function isAuctionCampaign(campaign) {
  const name = String(campaign?.name || "").toLowerCase();
  const autoType = String(campaign?.auto_type || "").toLowerCase();
  return name.includes("аукцион") || (autoType === "search" && campaign?.unified === false);
}

function buildAuctionAverageCampaignCpmRows(campaign, baseRows = [], options = {}) {
  const includeEmpty = Boolean(options.includeEmpty);
  const baseDailyRows = buildCampaignDailyRows(campaign, baseRows, { includeEmpty: true });
  if (!baseDailyRows.length) {
    return [];
  }

  const currentBid = safeNumber(campaign?.bid ?? campaign?.cpm, null);
  const rows = baseDailyRows.map((row) => ({
    ...row,
    bid: safeNumber(row.CPM, null) ?? computeCpm(row.expense_sum, row.views) ?? currentBid,
  }));

  return includeEmpty ? rows : rows.filter((row) => row.views || row.clicks || row.expense_sum || row.bid);
}

function buildCampaignBidViewRows(campaign, baseRows = [], options = {}) {
  if (isAuctionCampaign(campaign)) {
    const auctionRows = buildAuctionAverageCampaignCpmRows(campaign, baseRows, options);
    if (auctionRows.length) {
      return auctionRows;
    }
  }

  const rows = buildCampaignDailyRows(campaign, baseRows, options);
  if (!rows.length) {
    return [];
  }

  const history = normalizeBidHistoryRows(campaign);
  const currentBid = safeNumber(campaign?.bid ?? campaign?.cpm, null);
  const campaignRevenue = safeNumber(campaign?.metrics?.sum_price, null);
  const campaignOrders = safeNumber(campaign?.metrics?.orders, null);
  const campaignAverageOrderPrice = campaignOrders ? Number(campaignRevenue || 0) / Number(campaignOrders) : null;
  const firstHistoryBid = history.length ? history[0].bid : currentBid;
  let activeBid = firstHistoryBid;
  let cursor = 0;

  return rows.map((row) => {
    const dayEnd = parseIsoDate(row.day);
    if (dayEnd) {
      dayEnd.setHours(23, 59, 59, 999);
      while (cursor < history.length && history[cursor].at <= dayEnd) {
        activeBid = history[cursor].bid;
        cursor += 1;
      }
    }

    const rowRevenue = safeNumber(row.sum_price, null);
    const estimatedRevenue = rowRevenue !== null
      ? rowRevenue
      : (campaignAverageOrderPrice && row.orders
        ? Number(campaignAverageOrderPrice) * Number(row.orders)
        : null);

    return {
      ...row,
      bid: activeBid ?? currentBid,
      drr: computeDrr(row.expense_sum, estimatedRevenue),
    };
  });
}

function renderCampaignCharts(product, campaign) {
  const expenseContext = getCampaignChartContext(product, campaign, "expense");
  const trafficContext = getCampaignChartContext(product, campaign, "traffic");
  const efficiencyContext = getCampaignChartContext(product, campaign, "efficiency");
  const bidViewsContext = getCampaignChartContext(product, campaign, "bidviews");
  const expenseRows = buildCampaignDailyRows(expenseContext.campaign, expenseContext.baseRows);
  const trafficRows = buildCampaignDailyRows(trafficContext.campaign, trafficContext.baseRows);
  const efficiencyRows = buildCampaignDailyRows(efficiencyContext.campaign, efficiencyContext.baseRows);
  const bidViewRows = buildCampaignBidViewRows(bidViewsContext.campaign, bidViewsContext.baseRows);
  const dayStatusMap = buildCampaignDayStatusMap(bidViewsContext.campaign, bidViewRows);
  if (!expenseRows.length && !trafficRows.length && !efficiencyRows.length && !bidViewRows.length) {
    return "";
  }
  return `
    <details class="campaign-charts-panel" open>
      <summary class="campaign-charts-summary">
        <span>Графики РК</span>
      </summary>
      <div class="campaign-charts-grid">
        ${renderMultiLineChart(bidViewRows, {
          title: "Ставка и показы",
          note: "",
          normalizeEach: true,
          normalizeBarsEach: true,
          tone: "traffic",
          series: [
            { field: "bid", label: "Ставка", color: "#4b7bff", formatter: (value) => formatMoney(value) },
            { field: "drr", label: "ДРР", color: "#f17828", formatter: (value) => formatPercent(value) },
          ],
          barSeries: [
            {
              field: "views",
              label: "Показы",
              color: "#8b64f6",
              formatter: (value) => formatNumber(value, 0),
              opacity: 0.24,
            },
            {
              field: "atbs",
              label: "Корзины",
              color: "#2e9f73",
              formatter: (value) => formatNumber(value, 0),
              opacity: 0.32,
            },
            {
              field: "orders",
              label: "Заказы",
              color: "#5f6b82",
              formatter: (value) => formatNumber(value, 0),
              opacity: 0.4,
            },
          ],
          chartKey: bidViewsContext.chartKey,
          windowDays: bidViewsContext.windowDays,
          loading: bidViewsContext.loading,
          height: 152,
          dayStatusMap,
          campaignId: bidViewsContext.campaign?.id,
        })}
        ${renderComboChart(expenseRows, {
          title: "Расход, показы и клики",
          note: "",
          lineField: "expense_sum",
          lineLabel: "Расход",
          lineColor: "#f17828",
          lineFormatter: (value) => formatMoney(value),
          barSeries: [
            {
              field: "views",
              label: "Показы",
              color: "#4b7bff",
              formatter: (value) => formatNumber(value, 0),
            },
            {
              field: "clicks",
              label: "Клики",
              color: "#8b64f6",
              formatter: (value) => formatNumber(value, 0),
            },
          ],
          tone: "cost",
          chartKey: expenseContext.chartKey,
          windowDays: expenseContext.windowDays,
          loading: expenseContext.loading,
          height: 152,
        })}
        ${renderMultiLineChart(trafficRows, {
          title: "Трафик: показы и клики",
          note: "",
          normalizeEach: true,
          tone: "traffic",
          series: [
            { field: "views", label: "Показы", color: "#4b7bff", formatter: (value) => formatNumber(value, 0) },
            { field: "clicks", label: "Клики", color: "#8b64f6", formatter: (value) => formatNumber(value, 0) },
          ],
          chartKey: trafficContext.chartKey,
          windowDays: trafficContext.windowDays,
          loading: trafficContext.loading,
          height: 152,
        })}
        ${renderCampaignEfficiencyCard(efficiencyRows, {
          chartKey: efficiencyContext.chartKey,
          height: 72,
          windowDays: efficiencyContext.windowDays,
          loading: efficiencyContext.loading,
        })}
      </div>
    </details>
  `;
}

function buildClusterInfluenceRows(product) {
  const eligibleClusters = [];
  const aggregate = new Map();
  const baseDays = (product.daily_stats || [])
    .map((row) => row?.day)
    .filter(Boolean);

  baseDays.forEach((day) => {
    aggregate.set(day, {
      day,
      position_sum: 0,
      position_count: 0,
      ctr_clicks: 0,
      ctr_views: 0,
      top_clusters: [],
    });
  });

  (product.campaigns || []).forEach((campaign) => {
    ((campaign.clusters || {}).items || []).forEach((cluster) => {
      const includeInTop = Boolean(cluster.fixed) || !Boolean(cluster.excluded);
      if (includeInTop) {
        eligibleClusters.push(cluster);
      }
      Object.entries(cluster.daily || {}).forEach(([day, payload]) => {
        if (!aggregate.has(day)) {
          aggregate.set(day, {
            day,
            position_sum: 0,
            position_count: 0,
            ctr_clicks: 0,
            ctr_views: 0,
          });
        }
        const bucket = aggregate.get(day);
        const positionRaw = payload?.rates_promo_pos ?? payload?.org_pos;
        const position = positionRaw === null || positionRaw === undefined || Number.isNaN(Number(positionRaw))
          ? null
          : Number(positionRaw);
        if (position !== null && position > 0) {
          bucket.position_sum += position;
          bucket.position_count += 1;
        }

        const views = payload?.views === null || payload?.views === undefined || Number.isNaN(Number(payload?.views))
          ? 0
          : Number(payload.views);
        const clicks = payload?.clicks === null || payload?.clicks === undefined || Number.isNaN(Number(payload?.clicks))
          ? 0
          : Number(payload.clicks);
        bucket.ctr_views += views;
        bucket.ctr_clicks += clicks;
      });
    });
  });

  const topClustersByPeriod = eligibleClusters
    .map((cluster) => ({
      cluster,
      views: cluster?.views === null || cluster?.views === undefined || Number.isNaN(Number(cluster?.views))
        ? 0
        : Number(cluster.views),
      orders: cluster?.orders === null || cluster?.orders === undefined || Number.isNaN(Number(cluster?.orders))
        ? 0
        : Number(cluster.orders),
    }))
    .sort((left, right) => {
      if (right.views !== left.views) {
        return right.views - left.views;
      }
      if (right.orders !== left.orders) {
        return right.orders - left.orders;
      }
      return String(left.cluster?.name || "").localeCompare(String(right.cluster?.name || ""));
    })
    .slice(0, 3);

  return Array.from(aggregate.values())
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .map((row) => ({
      day: row.day,
      avg_position: row.position_count ? row.position_sum / row.position_count : null,
      cluster_ctr: row.ctr_views ? (row.ctr_clicks / row.ctr_views) * 100 : null,
      top_clusters: topClustersByPeriod.map((item, index) => {
        const cluster = item.cluster || {};
        const dailyPayload = (cluster.daily || {})[row.day] || {};
        const positionRaw = dailyPayload?.rates_promo_pos ?? dailyPayload?.org_pos ?? cluster.latest_promo_pos ?? cluster.latest_org_pos;
        const positionValue = positionRaw === null || positionRaw === undefined || Number.isNaN(Number(positionRaw))
          ? null
          : Number(positionRaw);
        const dailyViews = dailyPayload?.views === null || dailyPayload?.views === undefined || Number.isNaN(Number(dailyPayload?.views))
          ? 0
          : Number(dailyPayload.views);
        const dailyOrders = dailyPayload?.orders === null || dailyPayload?.orders === undefined || Number.isNaN(Number(dailyPayload?.orders))
          ? 0
          : Number(dailyPayload.orders);
        return {
          rank: index + 1,
          name: `${index + 1}. ${shortText(cluster.name || "—", 22)}`,
          reach: formatNumber(dailyViews, 0),
          orders: formatNumber(dailyOrders, 0),
          position: positionValue === null ? "—" : formatNumber(positionValue, 0),
          position_value: positionValue,
        };
      }),
    }))
    .map((row) => ({
      ...row,
      top1_position: row.top_clusters?.[0]?.position_value ?? null,
      top2_position: row.top_clusters?.[1]?.position_value ?? null,
      top3_position: row.top_clusters?.[2]?.position_value ?? null,
    }))
    .filter((row) => row.avg_position !== null || row.cluster_ctr !== null);
}

function buildChartsSection(product) {
  const expenseContext = getChartRenderContext(product, productChartKey(product?.article, "expense-orders"));
  const trafficContext = getChartRenderContext(product, productChartKey(product?.article, "traffic"));
  const efficiencyContext = getChartRenderContext(product, productChartKey(product?.article, "efficiency"));
  const clusterContext = getChartRenderContext(product, productChartKey(product?.article, "cluster-ctr"));
  const expenseRows = expenseContext.product?.daily_stats || product.daily_stats || [];
  const trafficRows = trafficContext.product?.daily_stats || product.daily_stats || [];
  const efficiencyRows = efficiencyContext.product?.daily_stats || product.daily_stats || [];
  const clusterInfluenceRows = buildClusterInfluenceRows(clusterContext.product || product);
  const currentStock = safeNumber(product.stock?.current, null) ?? safeNumber(product.stock?.list_stock, null);
  const chartsBody = `
    <div class="charts-grid">
      ${renderComboChart(expenseRows, {
        title: "Расход и заказы",
        note: "",
        lineField: "expense_sum",
        lineLabel: "Расход",
        lineColor: "#f17828",
        lineFormatter: (value) => formatMoney(value),
        barSeries: [
          {
            field: "orders",
            label: "Заказы с РК",
            color: "#2e9f73",
            formatter: (value) => formatNumber(value, 0),
          },
          {
            field: "ordered_total",
            label: "Заказы всего",
            color: "#7b879c",
            formatter: (value) => formatNumber(value, 0),
          },
        ],
        extraLegend: currentStock === null ? [] : [{ label: `Остаток ${formatNumber(currentStock, 0)}`, color: "#8b64f6" }],
        tooltipExtras: currentStock === null ? [] : [{ label: "Остаток сейчас", value: formatNumber(currentStock, 0) }],
        tone: "cost",
        chartKey: expenseContext.chartKey,
        windowDays: expenseContext.windowDays,
        loading: expenseContext.loading,
      })}
      ${renderMultiLineChart(trafficRows, {
        title: "Трафик: показы, клики и корзины",
        note: "",
        normalizeEach: true,
        tone: "traffic",
        series: [
          { field: "views", label: "Показы", color: "#4b7bff", formatter: (value) => formatNumber(value, 0) },
          { field: "clicks", label: "Клики", color: "#8b64f6", formatter: (value) => formatNumber(value, 0) },
          { field: "atbs", label: "Корзины", color: "#2e9f73", formatter: (value) => formatNumber(value, 0) },
        ],
        chartKey: trafficContext.chartKey,
        windowDays: trafficContext.windowDays,
        loading: trafficContext.loading,
      })}
      ${renderEfficiencySplitCard(efficiencyRows, {
        chartKey: efficiencyContext.chartKey,
        windowDays: efficiencyContext.windowDays,
        loading: efficiencyContext.loading,
      })}
      ${renderMultiLineChart(clusterInfluenceRows, {
        title: "Позиция кластеров и CTR",
        note: "",
        normalizeEach: true,
        tone: "neutral",
        tooltipLinesBuilder: (row) => {
          const lines = [
            {
              type: "metric-grid",
              items: [
                {
                  label: "Ср. позиция",
                  value: formatNumber(row.avg_position, 1),
                },
                {
                  label: "CTR кластеров",
                  value: formatPercent(row.cluster_ctr),
                },
              ],
            },
          ];
          if ((row.top_clusters || []).length) {
            lines.push({ type: "divider" });
            lines.push({
              type: "cluster-table",
              columns: ["Кластер", "Позиция", "Охват", "Заказы"],
              rows: row.top_clusters.map((cluster) => ({
                name: cluster.name,
                position: cluster.position,
                reach: cluster.reach,
                orders: cluster.orders,
              })),
            });
          }
          return lines;
        },
        series: [
          {
            field: "avg_position",
            label: "Ср. позиция",
            color: "#7b879c",
            formatter: (value) => formatNumber(value, 1),
          },
          {
            field: "cluster_ctr",
            label: "CTR кластеров",
            color: "#2e9f73",
            formatter: (value) => formatPercent(value),
          },
        ],
        barSeries: [
          {
            field: "top1_position",
            label: "Топ-1 поз.",
            color: "#6f45f4",
            formatter: (value) => value === null || value === undefined ? "—" : formatNumber(value, 0),
            opacity: 0.74,
            strokeOpacity: 0.96,
            strokeWidth: 1.35,
            preserveNull: true,
            invertScale: true,
            radius: 10,
          },
          {
            field: "top2_position",
            label: "Топ-2 поз.",
            color: "#8f6bff",
            formatter: (value) => value === null || value === undefined ? "—" : formatNumber(value, 0),
            opacity: 0.62,
            strokeOpacity: 0.88,
            strokeWidth: 1.25,
            preserveNull: true,
            invertScale: true,
            radius: 10,
          },
          {
            field: "top3_position",
            label: "Топ-3 поз.",
            color: "#b091ff",
            formatter: (value) => value === null || value === undefined ? "—" : formatNumber(value, 0),
            opacity: 0.52,
            strokeOpacity: 0.82,
            strokeWidth: 1.15,
            preserveNull: true,
            invertScale: true,
            radius: 10,
          },
        ],
        barGroupRatio: 0.78,
        barMaxGroupWidth: 52,
        barMinWidth: 7,
        barMaxWidth: 15,
        barGap: 4,
        chartKey: clusterContext.chartKey,
        windowDays: clusterContext.windowDays,
        loading: clusterContext.loading,
      })}
    </div>
  `;
  return buildSection(
    "Графики",
    `${formatDateLabel(product.period.current_start)} → ${formatDateLabel(product.period.current_end)}`,
    chartsBody,
    null,
    {
      article: product?.article,
      collapseKey: "charts",
      collapsed: getOverviewSectionCollapsed?.(product?.article, "charts"),
    },
  );
}



  return {
    buildCampaignBidViewRows,
    buildCampaignDailyRows,
    buildChartsSection,
    buildFunnelLayout,
    computeCpm,
    computeRate,
    parseChartTooltipLines,
    renderCampaignCharts,
    renderChartTooltipLine,
  };
}
