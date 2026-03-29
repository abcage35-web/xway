import { deltaClass, escapeHtml, formatCellValue, formatMoney, formatNumber, formatPercent } from "../formatters.js";
import { SCHEDULE_COVERAGE_BASELINE } from "../constants.js";

function renderMetricLevel({ label, value, deltaText = "", deltaTone = "", actionMarkup = "" } = {}) {
  return `
    <div class="metric-level${actionMarkup ? " has-action" : ""}">
      ${actionMarkup ? `<div class="metric-level-action">${actionMarkup}</div>` : ""}
      ${label ? `
        <div class="metric-level-head">
          <span class="metric-level-label">${escapeHtml(label)}</span>
        </div>
      ` : ""}
      <div class="metric-level-value-row">
        <strong class="metric-level-value">${escapeHtml(value)}</strong>
        ${deltaText ? `<span class="metric-level-delta ${escapeHtml(deltaTone || "")}">(${escapeHtml(deltaText)})</span>` : ""}
      </div>
    </div>
  `;
}

export function emptyBlock(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

export function buildSection(title, note, body, expandKey = null, options = {}) {
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

export function tagMarkup(text, cls = "") {
  return `<span class="tag ${cls}">${escapeHtml(text)}</span>`;
}

export function signalMarkup(label, value, tone = "neutral", note = "") {
  return `
    <div class="signal-item tone-${escapeHtml(tone)}">
      <div class="signal-copy">
        <span>${escapeHtml(label)}</span>
        ${note ? `<small>${escapeHtml(note)}</small>` : ""}
      </div>
      <b>${value}</b>
    </div>
  `;
}

export function renderCampaignMetricCard(label, value, tone = "neutral", metaRows = [], options = {}) {
  const rows = [
    { label, value, actionMarkup: options.actionMarkup || "" },
    ...metaRows.map((row) => ({
      label: row.label,
      value: row.value,
    })),
  ];
  return `
    <div class="mini-stat tone-${escapeHtml(tone)} campaign-metric-card">
      <div class="metric-level-list">
        ${rows
          .map((row) => renderMetricLevel({
            label: row.label,
            value: row.value,
            actionMarkup: row.actionMarkup || "",
          }))
          .join("")}
      </div>
    </div>
  `;
}

export function renderCampaignInlineMetricColumn(label, value, tone = "neutral", metaRows = []) {
  const rows = [
    { label, value },
    ...metaRows.map((row) => ({
      label: row.label,
      value: row.value,
    })),
  ];
  return `
    <div class="campaign-inline-metric tone-${escapeHtml(tone)}">
      <div class="metric-level-list">
        ${rows
          .map((row) => renderMetricLevel({
            label: row.label,
            value: row.value,
          }))
          .join("")}
      </div>
    </div>
  `;
}

export function comparisonItem(label, current, delta, kind = "number", invert = false) {
  let formattedCurrent = current;
  let formattedDelta = delta;
  if (kind === "money") {
    formattedCurrent = formatMoney(current);
    formattedDelta = formatMoney(delta);
  } else if (kind === "percent") {
    formattedCurrent = formatPercent(current);
    formattedDelta = formatPercent(delta);
  } else {
    formattedCurrent = formatNumber(current, 1);
    formattedDelta = formatNumber(delta, 1);
  }
  const cls = deltaClass(delta, invert);
  const sign = Number(delta) > 0 ? "+" : "";
  return `
    <div class="comparison-item">
      <div class="comparison-main">
        <span class="comparison-label">${escapeHtml(label)}</span>
        <strong class="comparison-value">${formattedCurrent}</strong>
      </div>
      <span class="delta ${cls}">${formattedDelta === "—" ? "—" : `${sign}${formattedDelta}`}</span>
    </div>
  `;
}

export function renderDataTable(columns, rows, options = {}) {
  if (!rows.length) {
    return emptyBlock(options.emptyText || "Данных нет.");
  }

  const head = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = columns.map((column) => `<td>${formatCellValue(row[column.field], column)}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `
    <div class="table-shell ${options.shellClass || ""}">
      <table class="data-table ${options.tableClass || ""}">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function scheduleHourLabel(hourIndex) {
  const start = String(hourIndex).padStart(2, "0");
  const end = String((hourIndex + 1) % 24).padStart(2, "0");
  return `${start}:00–${end}:00`;
}

function scheduleTooltipAttrs({ dayLabel, hourIndex, value, mode, maxCount }) {
  const hourLabel = scheduleHourLabel(hourIndex);
  const title = `${dayLabel} • ${hourLabel}`;
  const normalizedMax = Math.max(Number(maxCount || 1), 1);
  const normalizedValue = Math.max(Number(value || 0), 0);
  const coverageBaseline = Math.max(Number(SCHEDULE_COVERAGE_BASELINE || 2), 1);
  const coveragePercent = mode === "count"
    ? (normalizedValue / coverageBaseline) * 100
    : normalizedValue > 0 ? 100 : 0;
  const lines = mode === "count"
    ? [
        `Активных РК: ${formatNumber(normalizedValue, 0)} из ${formatNumber(normalizedMax, 0)}`,
        `Покрытие слота: ${formatPercent(coveragePercent)}`,
        normalizedValue > 0 ? "Статус: в слоте есть активные РК" : "Статус: активных РК нет",
      ]
    : [
        normalizedValue > 0 ? "Статус: активна" : "Статус: выключена",
      ];
  return `data-chart-tip="1" data-chart-title="${escapeHtml(title)}" data-chart-lines="${escapeHtml(JSON.stringify(lines))}"`;
}

export function renderScheduleMatrix(matrix, mode = "count", options = {}) {
  const maxCount = Math.max(options.maxCount || matrix.max_count || 1, 1);
  const showValues = Boolean(options.showValues);
  const header = Array.from({ length: 24 }, (_, hour) => `<span>${hour}</span>`).join("");
  const rows = (matrix.days || [])
    .map((day) => {
      const cells = (day.hours || [])
        .map((cell, hourIndex) => {
          const value = mode === "count" ? Number(cell.count || 0) : cell.active ? 1 : 0;
          const alpha = mode === "count" ? value / maxCount : value;
          const valueMarkup = showValues && mode === "count" && value > 0
            ? `<span class="schedule-cell-count">${escapeHtml(formatNumber(value, 0))}</span>`
            : "";
          return `
            <div
              class="schedule-cell ${value ? "active" : ""} ${valueMarkup ? "has-count" : ""}"
              style="--alpha:${alpha}"
              ${scheduleTooltipAttrs({
                dayLabel: day.label || "—",
                hourIndex,
                value,
                mode,
                maxCount,
              })}
            >${valueMarkup}</div>
          `;
        })
        .join("");
      return `
        <div class="schedule-row">
          <span class="schedule-day">${escapeHtml(day.label)}</span>
          <div class="schedule-cells">${cells}</div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="schedule-chart-shell chart-shell">
      <div class="schedule-grid-card">
        <div class="schedule-header">
          <span class="schedule-day title">День</span>
          <div class="schedule-hours">${header}</div>
        </div>
        ${rows}
      </div>
      <div class="chart-tooltip" hidden></div>
    </div>
  `;
}
