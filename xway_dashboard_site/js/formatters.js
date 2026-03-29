const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(Number(value));
}

export function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  return `${money.format(Number(value))} ₽`;
}

export function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  return `${formatNumber(value, 1)}%`;
}

export function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function formatDateLabel(value) {
  if (!value) {
    return "—";
  }
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

export function formatDateTimeLabel(value) {
  if (!value) {
    return "—";
  }
  const [datePart, timePart = ""] = String(value).split("T");
  const dateLabel = formatDateLabel(datePart);
  const timeLabel = timePart.slice(0, 5);
  return timeLabel ? `${dateLabel} ${timeLabel}` : dateLabel;
}

export function formatCellValue(value, column) {
  if (column.type === "money") {
    return formatMoney(value);
  }
  if (column.type === "percent") {
    return formatPercent(value);
  }
  if (column.type === "number") {
    return formatNumber(value, column.digits ?? 1);
  }
  return value === null || value === undefined || value === "" ? "—" : escapeHtml(value);
}

export function formatMetricDelta(value, kind = "number") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  const numeric = Number(value);
  const sign = numeric > 0 ? "+" : "";
  if (kind === "money") {
    return `${sign}${formatMoney(numeric)}`;
  }
  if (kind === "percent") {
    return `${sign}${formatPercent(numeric)}`;
  }
  return `${sign}${formatNumber(numeric, 1)}`;
}

export function deltaClass(value, invert = false) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "";
  }
  const numeric = Number(value);
  if (numeric === 0) {
    return "";
  }
  const isGood = invert ? numeric < 0 : numeric > 0;
  return isGood ? "good" : "bad";
}

export function formatByKind(value, kind = "number") {
  if (kind === "money") {
    return formatMoney(value);
  }
  if (kind === "percent") {
    return formatPercent(value);
  }
  return formatNumber(value, 0);
}

export function localIsoDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseIsoDate(value) {
  if (!value) {
    return null;
  }
  const parts = String(value).split("-");
  if (parts.length !== 3) {
    return null;
  }
  const [year, month, day] = parts.map((item) => Number(item));
  if (!year || !month || !day) {
    return null;
  }
  return new Date(year, month - 1, day);
}

export function shiftIsoDate(value, deltaDays = 0) {
  const date = parseIsoDate(value);
  if (!date) {
    return null;
  }
  date.setDate(date.getDate() + Number(deltaDays || 0));
  return localIsoDate(date);
}
