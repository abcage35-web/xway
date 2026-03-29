const numberFormatter = new Intl.NumberFormat("ru-RU");
const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});
const moneyFloatFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 1,
});

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function toNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function resolveFractionDigits(numeric: number, maximumFractionDigits: number) {
  if (maximumFractionDigits <= 0) {
    return 0;
  }
  return Math.abs(numeric) >= 100 ? 0 : maximumFractionDigits;
}

export function formatNumber(value: number | string | null | undefined, maximumFractionDigits = 0) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return "—";
  }
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: resolveFractionDigits(numeric, maximumFractionDigits),
  }).format(numeric);
}

export function formatCompactNumber(value: number | string | null | undefined) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return "—";
  }
  const abs = Math.abs(numeric);
  if (abs >= 1_000_000_000) {
    return `${formatNumber(numeric / 1_000_000_000, 1)} млрд`;
  }
  if (abs >= 1_000_000) {
    return `${formatNumber(numeric / 1_000_000, 1)} млн`;
  }
  if (abs >= 1_000) {
    return `${formatNumber(numeric / 1_000, 1)} тыс`;
  }
  return numberFormatter.format(numeric);
}

export function formatMoney(value: number | string | null | undefined, precise = false) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return "—";
  }
  const digits = precise ? resolveFractionDigits(numeric, 1) : 0;
  return (digits > 0 ? moneyFloatFormatter : moneyFormatter).format(numeric);
}

export function formatPercent(value: number | string | null | undefined, digits = 1) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return "—";
  }
  return `${numeric.toFixed(resolveFractionDigits(numeric, digits))}%`;
}

export function formatDate(value: string | null | undefined) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
  }).format(date);
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "—";
  }
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDateRange(start?: string | null, end?: string | null) {
  if (!start && !end) {
    return "За выбранный период";
  }
  return `${formatDate(start)} - ${formatDate(end)}`;
}

export function formatDelta(value: number | null | undefined, suffix = "%") {
  const numeric = toNumber(value);
  if (numeric === null) {
    return "—";
  }
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${numeric.toFixed(resolveFractionDigits(numeric, 1))}${suffix}`;
}

export function statusTone(active: boolean, status?: string | null) {
  const normalized = String(status || "").toUpperCase();
  if (active) {
    return "emerald";
  }
  if (normalized.includes("PAUSE")) {
    return "amber";
  }
  if (normalized.includes("FROZEN")) {
    return "slate";
  }
  return "rose";
}

export function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function relativeDeltaClass(value: number | null | undefined) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return "text-slate-500";
  }
  if (numeric > 0) {
    return "text-emerald-600";
  }
  if (numeric < 0) {
    return "text-rose-600";
  }
  return "text-slate-500";
}

function toLocalIsoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getTodayIso() {
  return toLocalIsoDate(new Date());
}

export function shiftIsoDate(baseIso: string, deltaDays: number) {
  const date = new Date(`${baseIso}T00:00:00`);
  date.setDate(date.getDate() + deltaDays);
  return toLocalIsoDate(date);
}

export function buildPresetRange(preset: string) {
  const today = getTodayIso();
  if (preset === "today") {
    return { start: today, end: today };
  }
  if (preset === "yesterday") {
    const yesterday = shiftIsoDate(today, -1);
    return { start: yesterday, end: yesterday };
  }
  const days = Number(preset);
  if (!Number.isFinite(days) || days <= 0) {
    return { start: shiftIsoDate(today, -6), end: today };
  }
  return { start: shiftIsoDate(today, -(days - 1)), end: today };
}

export function getRangePreset(start?: string | null, end?: string | null) {
  if (!start || !end) {
    return "custom";
  }
  const today = getTodayIso();
  if (start === today && end === today) {
    return "today";
  }
  const yesterday = shiftIsoDate(today, -1);
  if (start === yesterday && end === yesterday) {
    return "yesterday";
  }
  const diff = Math.round((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86_400_000);
  const days = diff + 1;
  if ([3, 7, 14, 30].includes(days) && end === today) {
    return String(days);
  }
  return "custom";
}

export function flattenCatalogArticles<T extends { articles: unknown[] }>(shops: T[]) {
  return shops.flatMap((shop) => shop.articles);
}

export { numberFormatter };
