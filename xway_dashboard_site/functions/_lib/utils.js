export function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function jsonResponse(payload, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

export function errorResponse(status, message, extra = {}) {
  return jsonResponse({ ok: false, error: message, ...extra }, { status });
}

export function sanitizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function hasCookieHeaderAuth(env) {
  const cookieHeader = String(env.XWAY_COOKIE_HEADER || "").trim();
  return Boolean(cookieHeader);
}

export function hasSessionCookieAuth(env) {
  const sessionId = String(env.XWAY_SESSIONID || "").trim();
  return Boolean(sessionId);
}

export function hasCsrfToken(env) {
  const csrfToken = String(env.XWAY_CSRF_TOKEN || env.XWAY_CSRFTOKEN || "").trim();
  return Boolean(csrfToken);
}

export function hasNativeStorageState(env) {
  const storageState = String(env.XWAY_STORAGE_STATE_JSON || env.XWAY_STORAGE_STATE_BASE64 || "").trim();
  return Boolean(storageState || hasCookieHeaderAuth(env) || hasSessionCookieAuth(env));
}

function parseIsoDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }
  const [year, month, day] = text.split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, amount) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function resolveRange(start, end, referenceDate = new Date(), defaultDays = 7) {
  const today = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate()));
  const endDate = parseIsoDate(end) ?? today;
  const startDate = parseIsoDate(start) ?? addDays(endDate, -(defaultDays - 1));
  if (startDate.getTime() > endDate.getTime()) {
    throw new Error("start date must not be after end date");
  }

  const spanDays = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
  const compareEnd = addDays(startDate, -1);
  const compareStart = addDays(compareEnd, -(spanDays - 1));

  return {
    current_start: isoDate(startDate),
    current_end: isoDate(endDate),
    compare_start: isoDate(compareStart),
    compare_end: isoDate(compareEnd),
    span_days: spanDays,
  };
}

export function iterIsoDays(start, end) {
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  if (!startDate || !endDate || startDate.getTime() > endDate.getTime()) {
    return [];
  }
  const days = [];
  for (let current = startDate; current.getTime() <= endDate.getTime(); current = addDays(current, 1)) {
    days.push(isoDate(current));
  }
  return days;
}

export function formatDay(day) {
  const parsed = parseIsoDate(day);
  if (!parsed) {
    return String(day || "");
  }
  const dd = String(parsed.getUTCDate()).padStart(2, "0");
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = parsed.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export function asFloat(value) {
  const numeric = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

export function parseCatalogChartProductRefs(rawRefs) {
  const seen = new Set();
  const refs = [];
  for (const rawRef of rawRefs || []) {
    const parts = String(rawRef || "").split(":", 2).map((part) => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      continue;
    }
    const shopId = Number.parseInt(parts[0], 10);
    const productId = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(shopId) || !Number.isFinite(productId)) {
      continue;
    }
    const key = `${shopId}:${productId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push([shopId, productId]);
  }
  return refs;
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

export function searchParamsValue(url, key) {
  const value = url.searchParams.get(key);
  return value && value.trim() ? value.trim() : null;
}
