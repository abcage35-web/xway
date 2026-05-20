const MPVIBE_API_ORIGIN = "https://m-api.mpvibe.ru";
const MPVIBE_AUTH_ORIGIN = "https://auth.mpvibe.ru";
const MPVIBE_TOKEN_CACHE_KEY = "mpvibe:access-token:v1";
const MPVIBE_TOKEN_SKEW_SECONDS = 60;

let mpvibeTokenMemory = null;
let mpvibeRefreshPromise = null;

const DAILY_FIELDS = [
  "date",
  "revenue",
  "adv_spent",
  "drr",
  "adv_impressions",
  "adv_clicks",
  "adv_cart_count",
  "adv_order_count",
  "ctr_test",
  "conversion_cart",
  "conversion_order",
  "return_count",
  "returns_revenue",
  "margin",
  "margin_percent",
  "margin_wb_ds",
  "margin_wb_ds_percent",
  "stocks_fbo",
  "stocks_fbo_days",
  "price",
  "price_mp",
  "price_with_wallet",
  "spp",
  "promo_percent",
  "prices",
];

const PRICE_FIELDS = [
  "card_id",
  "name",
  "offer_id",
  "sku",
  "entity_id",
  "account_id",
  "niche_id",
  "size_id",
  "size",
  "sebes",
  "price",
  "discount_percent",
  "spp_percent",
  "new_price",
  "new_discount",
  "status",
  "last_change_status",
  "planned_minimal_price",
];

const STOCK_VALUE_FIELDS = [
  "stocks_fbo",
  "stock_fbo",
  "fbo_stock",
  "fbo",
  "total_stock",
  "total_quantity",
  "quantity",
  "qty",
  "stock",
  "stocks",
  "amount",
  "balance",
  "count",
  "remain_stock",
];

function hasMpvibeAuth(env) {
  return Boolean(String(env.MPVIBE_COOKIE_HEADER || env.MPVIBE_REFRESH_COOKIE_HEADER || env.MPVIBE_AUTHORIZATION || "").trim());
}

function normalizeBearer(value) {
  const token = String(value || "").trim();
  if (!token) {
    return "";
  }
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function mpvibeCacheBinding(env) {
  const binding = env.XWAY_AI_CACHE;
  return binding && typeof binding.get === "function" && typeof binding.put === "function" ? binding : null;
}

function decodeJwtPayload(authorization) {
  const token = String(authorization || "").replace(/^Bearer\s+/i, "").trim();
  const payloadPart = token.split(".")[1];
  if (!payloadPart) {
    return null;
  }
  try {
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payloadPart.length / 4) * 4, "=");
    return JSON.parse(atob(normalized));
  } catch {
    return null;
  }
}

function authorizationExpiresAt(authorization) {
  const exp = Number(decodeJwtPayload(authorization)?.exp);
  return Number.isFinite(exp) ? exp : null;
}

function isUsableAuthorization(authorization) {
  if (!authorization) {
    return false;
  }
  const expiresAt = authorizationExpiresAt(authorization);
  return expiresAt === null || expiresAt > Math.floor(Date.now() / 1000) + MPVIBE_TOKEN_SKEW_SECONDS;
}

function tokenCacheTtlSeconds(authorization) {
  const expiresAt = authorizationExpiresAt(authorization);
  if (!expiresAt) {
    return 3600;
  }
  return Math.max(60, expiresAt - Math.floor(Date.now() / 1000) - MPVIBE_TOKEN_SKEW_SECONDS);
}

async function readCachedMpvibeAuthorization(env) {
  if (isUsableAuthorization(mpvibeTokenMemory?.authorization)) {
    return mpvibeTokenMemory.authorization;
  }

  const cache = mpvibeCacheBinding(env);
  if (!cache) {
    return "";
  }
  const cached = await cache.get(MPVIBE_TOKEN_CACHE_KEY, "json");
  const authorization = normalizeBearer(cached?.authorization || cached?.token);
  if (!isUsableAuthorization(authorization)) {
    return "";
  }
  mpvibeTokenMemory = {
    authorization,
    expires_at: authorizationExpiresAt(authorization),
  };
  return authorization;
}

async function writeCachedMpvibeAuthorization(env, authorization) {
  const normalized = normalizeBearer(authorization);
  if (!normalized) {
    return;
  }
  mpvibeTokenMemory = {
    authorization: normalized,
    expires_at: authorizationExpiresAt(normalized),
  };

  const cache = mpvibeCacheBinding(env);
  if (cache) {
    await cache.put(
      MPVIBE_TOKEN_CACHE_KEY,
      JSON.stringify({
        authorization: normalized,
        expires_at: mpvibeTokenMemory.expires_at,
      }),
      { expirationTtl: tokenCacheTtlSeconds(normalized) },
    );
  }
}

function mpvibeRefreshCookieHeader(env) {
  return String(env.MPVIBE_REFRESH_COOKIE_HEADER || env.MPVIBE_COOKIE_HEADER || "").trim();
}

function mpvibeTimezoneOffset(env) {
  const value = Number.parseInt(String(env.MPVIBE_TIMEZONE_OFFSET || "-240"), 10);
  return Number.isFinite(value) ? value : -240;
}

async function refreshMpvibeAuthorization(env) {
  const cookieHeader = mpvibeRefreshCookieHeader(env);
  if (!cookieHeader) {
    throw new Error("MPVibe refresh cookie is not configured. Set MPVIBE_REFRESH_COOKIE_HEADER or MPVIBE_COOKIE_HEADER.");
  }

  if (!mpvibeRefreshPromise) {
    mpvibeRefreshPromise = (async () => {
      const response = await fetch(`${MPVIBE_AUTH_ORIGIN}/api/refresh-token`, {
        method: "POST",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/json",
          origin: "https://m.mpvibe.ru",
          referer: "https://m.mpvibe.ru/",
          cookie: cookieHeader,
        },
        body: JSON.stringify({ timeZoneOffset: mpvibeTimezoneOffset(env) }),
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        throw new Error(`MPVibe token refresh failed (${response.status}): ${text.slice(0, 240) || response.statusText}`);
      }
      const authorization = normalizeBearer(payload?.token);
      if (!authorization) {
        throw new Error("MPVibe token refresh did not return a token.");
      }
      await writeCachedMpvibeAuthorization(env, authorization);
      return authorization;
    })().finally(() => {
      mpvibeRefreshPromise = null;
    });
  }

  return mpvibeRefreshPromise;
}

async function resolveMpvibeAuthorization(env, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await readCachedMpvibeAuthorization(env);
    if (cached) {
      return cached;
    }

    const configured = normalizeBearer(env.MPVIBE_AUTHORIZATION);
    if (isUsableAuthorization(configured)) {
      return configured;
    }
  }

  if (mpvibeRefreshCookieHeader(env)) {
    return refreshMpvibeAuthorization(env);
  }

  return normalizeBearer(env.MPVIBE_AUTHORIZATION);
}

async function mpvibeHeaders(env, { authorization } = {}) {
  const headers = new Headers({
    accept: "application/json, text/plain, */*",
    origin: "https://m.mpvibe.ru",
    referer: "https://m.mpvibe.ru/",
  });
  const cookieHeader = String(env.MPVIBE_COOKIE_HEADER || "").trim();
  if (cookieHeader) {
    headers.set("cookie", cookieHeader);
  }
  const resolvedAuthorization = authorization || (await resolveMpvibeAuthorization(env));
  if (resolvedAuthorization) {
    headers.set("authorization", resolvedAuthorization);
  }
  return headers;
}

async function mpvibeJson(env, pathname, params = {}) {
  const url = new URL(pathname, MPVIBE_API_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  let authorization = await resolveMpvibeAuthorization(env);
  let response = await fetch(url.toString(), { headers: await mpvibeHeaders(env, { authorization }) });
  let text = await response.text();
  if (response.status === 401 && mpvibeRefreshCookieHeader(env)) {
    authorization = await resolveMpvibeAuthorization(env, { forceRefresh: true });
    response = await fetch(url.toString(), { headers: await mpvibeHeaders(env, { authorization }) });
    text = await response.text();
  }
  if (!response.ok) {
    throw new Error(`MPVibe request failed (${response.status}): ${text.slice(0, 240) || response.statusText}`);
  }
  return text ? JSON.parse(text) : null;
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function asNumberOrNull(value) {
  const numeric = Number(String(value ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(numeric) ? numeric : null;
}

function objectMatchesArticle(value, article) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return ["sku", "nm_id", "nmId", "article", "wb_article", "nmid"].some((field) => asString(value[field]) === article);
}

function findFirstObject(value, predicate) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstObject(item, predicate);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  if (predicate(value)) {
    return value;
  }
  for (const item of Object.values(value)) {
    const found = findFirstObject(item, predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

function findRealtimeCard(payload, article) {
  for (const accountRow of Array.isArray(payload) ? payload : []) {
    const cards = accountRow?.cards && typeof accountRow.cards === "object" ? accountRow.cards : {};
    for (const card of Object.values(cards)) {
      if (objectMatchesArticle(card, article)) {
        return {
          card,
          account_id: accountRow.account_id ?? card?.account_id ?? null,
          entity_id: accountRow.entity_id ?? card?.entity_id ?? null,
          manager_id: accountRow.manager_id ?? null,
          manager_name: accountRow.manager_name ?? null,
        };
      }
    }
  }

  const card = findFirstObject(payload, (value) => objectMatchesArticle(value, article));
  return card ? { card, account_id: card.account_id ?? null, entity_id: card.entity_id ?? null } : null;
}

function readByCardId(value, cardId) {
  const key = asString(cardId);
  if (!key) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readByCardId(item, cardId);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    return value[key];
  }
  if (asString(value.card_id) === key) {
    return value;
  }
  for (const item of Object.values(value)) {
    const found = readByCardId(item, cardId);
    if (found) {
      return found;
    }
  }
  return null;
}

function selectFields(source, fields) {
  const target = {};
  for (const field of fields) {
    if (source && Object.prototype.hasOwnProperty.call(source, field)) {
      target[field] = source[field];
    }
  }
  return target;
}

function normalizeCardDayRows(payload, cardId) {
  const keys = Array.isArray(payload?.keys) ? payload.keys : [];
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .filter((row) => asString(row?.card_id) === asString(cardId))
    .map((row) => {
      const values = Object.fromEntries(keys.map((key, index) => [key, row?.data?.[index]]));
      values.date = row?.date || row?.dt || row?.day || values.date;
      return selectFields(values, DAILY_FIELDS);
    })
    .sort((left, right) => asString(left.date).localeCompare(asString(right.date)));
}

function findStocksForCard(payload, cardId) {
  const key = asString(cardId);
  for (const row of Array.isArray(payload) ? payload : []) {
    if (row?.stocks && Object.prototype.hasOwnProperty.call(row.stocks, key)) {
      return {
        account_total: row.total || null,
        stock: row.stocks[key],
        supply: row.supplies?.[key] || null,
      };
    }
  }
  return {
    account_total: null,
    stock: readByCardId(payload, cardId),
    supply: null,
  };
}

function extractMpvibeStockValue(value, depth = 0) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const direct = asNumberOrNull(value);
  if (direct !== null) {
    return direct;
  }
  if (depth > 4) {
    return null;
  }
  if (Array.isArray(value)) {
    const values = value.map((item) => extractMpvibeStockValue(item, depth + 1)).filter((item) => item !== null);
    return values.length ? values.reduce((sum, item) => sum + item, 0) : null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const field of STOCK_VALUE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      const nested = extractMpvibeStockValue(value[field], depth + 1);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

function indexRealtimeCardsByArticle(payload, articles) {
  const wanted = new Set((articles || []).map((article) => asString(article)).filter(Boolean));
  const byArticle = new Map();
  for (const accountRow of Array.isArray(payload) ? payload : []) {
    const cards = accountRow?.cards && typeof accountRow.cards === "object" ? accountRow.cards : {};
    for (const card of Object.values(cards)) {
      for (const field of ["sku", "nm_id", "nmId", "article", "wb_article", "nmid"]) {
        const article = asString(card?.[field]);
        if (wanted.has(article) && !byArticle.has(article)) {
          byArticle.set(article, {
            card,
            account_id: accountRow.account_id ?? card?.account_id ?? null,
            entity_id: accountRow.entity_id ?? card?.entity_id ?? null,
            manager_id: accountRow.manager_id ?? null,
            manager_name: accountRow.manager_name ?? null,
          });
        }
      }
    }
  }
  return byArticle;
}

function normalizePlan(planPayload, cardId) {
  const plan = readByCardId(planPayload, cardId);
  if (!plan || typeof plan !== "object") {
    return null;
  }
  return {
    future_plan: plan.future_plan || null,
    orders_count: asNumberOrNull(plan.orders_count),
    planned_count: asNumberOrNull(plan.planned_count),
    monthly_forecast_count: asNumberOrNull(plan.monthly_forecast_count),
    monthly_planned_count: asNumberOrNull(plan.monthly_planned_count),
  };
}

function normalizePriceCard(pricePayload, article, cardId) {
  const rows = Array.isArray(pricePayload) ? pricePayload : [];
  const row =
    rows.find((item) => asString(item?.sku) === asString(article)) ||
    rows.find((item) => asString(item?.card_id) === asString(cardId));
  return row ? selectFields(row, PRICE_FIELDS) : null;
}

function normalizeMainCard(card, article, parent = {}) {
  if (!card) {
    return null;
  }
  const filterData = card.filter_data || {};
  const advData = card.adv_data || {};
  return {
    card_id: card.card_id ?? card.id ?? null,
    sku: card.sku ?? article,
    offer_id: card.offer_id ?? null,
    account_id: card.account_id ?? parent.account_id ?? null,
    entity_id: card.entity_id ?? parent.entity_id ?? null,
    manager_id: parent.manager_id ?? null,
    manager_name: parent.manager_name ?? null,
    name: card.name ?? card.title ?? null,
    current_price: card.current_price ?? filterData.current_price ?? null,
    filter_data: selectFields(filterData, ["order_count", "revenue", "margin", "margin_percent", "margin_ds_percent", "sebes", "illiquid", "is_outdated"]),
    adv_data: selectFields(advData, ["campaign_id", "state", "spent", "drr", "ctr", "shop_id", "product_wb"]),
    plan_data: card.plan_data || null,
    stock_data: card.stock_data || null,
  };
}

function mpvibeRequestError(source, error) {
  const message = error instanceof Error ? error.message : asString(error) || "unknown error";
  return `${source}: ${message}`;
}

export async function collectMpvibeArticle(env, { article, start, end } = {}) {
  const normalizedArticle = asString(article);
  if (!hasMpvibeAuth(env)) {
    return {
      available: false,
      error: "MPVibe auth is not configured. Set MPVIBE_COOKIE_HEADER or MPVIBE_AUTHORIZATION in Cloudflare secrets.",
    };
  }

  const mainPayload = await mpvibeJson(env, "/api/realtime/mp/wb", { start_date: start, end_date: end });
  const mainMatch = findRealtimeCard(mainPayload, normalizedArticle);
  const mainCard = normalizeMainCard(mainMatch?.card, normalizedArticle, mainMatch);
  const cardId = mainCard?.card_id;
  const accountId = mainCard?.account_id;
  if (!cardId) {
    return {
      available: false,
      error: `Article ${normalizedArticle} was not found in MPVibe realtime data.`,
    };
  }

  const requests = {
    byCard: mpvibeJson(env, "/api/realtime/mp/wb/by/card", { start_date: start, end_date: end, account_id: accountId }),
    plan: mpvibeJson(env, "/api/realtime/mp/wb/plan", { start_date: start, end_date: end }),
    stocks: mpvibeJson(env, "/api/realtime/mp/wb/stocks", { start_date: start, end_date: end }),
    price: mpvibeJson(env, "/api/price/wb"),
  };
  if (accountId !== null && accountId !== undefined) {
    requests.cardDay = mpvibeJson(env, "/api/realtime/mp/wb/by/card-day", { start_date: start, end_date: end, account_id: accountId });
  }

  const settled = await Promise.allSettled(Object.entries(requests).map(async ([key, promise]) => [key, await promise]));
  const payloads = {};
  const errors = {};
  for (const result of settled) {
    if (result.status === "fulfilled") {
      const [key, payload] = result.value;
      payloads[key] = payload;
    } else {
      errors.unknown = result.reason instanceof Error ? result.reason.message : String(result.reason);
    }
  }

  return {
    available: true,
    article: normalizedArticle,
    range: { start, end },
    card: mainCard,
    summary: readByCardId(payloads.byCard, cardId),
    price: normalizePriceCard(payloads.price, normalizedArticle, cardId),
    daily: normalizeCardDayRows(payloads.cardDay, cardId),
    plan: normalizePlan(payloads.plan, cardId),
    stocks: findStocksForCard(payloads.stocks, cardId),
    errors,
  };
}

export async function collectMpvibeStocks(env, { articles, start, end } = {}) {
  const requestedArticles = [...new Set((articles || []).map((article) => asString(article)).filter(Boolean))];
  if (!requestedArticles.length) {
    return {
      ok: true,
      available: hasMpvibeAuth(env),
      generated_at: new Date().toISOString(),
      range: { start, end },
      requested_articles: [],
      rows: [],
      errors: [],
    };
  }
  if (!hasMpvibeAuth(env)) {
    return {
      ok: true,
      available: false,
      generated_at: new Date().toISOString(),
      range: { start, end },
      requested_articles: requestedArticles,
      rows: requestedArticles.map((article) => ({
        article,
        card_id: null,
        account_id: null,
        stock_fbo: null,
        available: false,
        error: "MPVibe auth is not configured.",
      })),
      errors: [{ articles: requestedArticles, error: "MPVibe auth is not configured." }],
    };
  }

  const [mainResult, stocksResult] = await Promise.allSettled([
    mpvibeJson(env, "/api/realtime/mp/wb", { start_date: start, end_date: end }),
    mpvibeJson(env, "/api/realtime/mp/wb/stocks", { start_date: start, end_date: end }),
  ]);
  const requestErrors = [];
  if (mainResult.status === "rejected") {
    requestErrors.push(mpvibeRequestError("realtime", mainResult.reason));
  }
  if (stocksResult.status === "rejected") {
    requestErrors.push(mpvibeRequestError("stocks", stocksResult.reason));
  }

  const mainPayload = mainResult.status === "fulfilled" ? mainResult.value : null;
  const stocksPayload = stocksResult.status === "fulfilled" ? stocksResult.value : null;

  if (!mainPayload) {
    const error = requestErrors.join(" | ") || "MPVibe realtime data is unavailable.";
    return {
      ok: true,
      available: false,
      generated_at: new Date().toISOString(),
      range: { start, end },
      requested_articles: requestedArticles,
      rows: requestedArticles.map((article) => ({
        article,
        card_id: null,
        account_id: null,
        stock_fbo: null,
        available: false,
        error,
      })),
      errors: [{ articles: requestedArticles, error }],
    };
  }

  const indexedCards = indexRealtimeCardsByArticle(mainPayload, requestedArticles);

  const rows = requestedArticles.map((article) => {
    const mainMatch = indexedCards.get(article) || findRealtimeCard(mainPayload, article);
    const mainCard = normalizeMainCard(mainMatch?.card, article, mainMatch);
    const cardId = mainCard?.card_id;
    if (!cardId) {
      return {
        article,
        card_id: null,
        account_id: null,
        stock_fbo: null,
        available: false,
        error: `Article ${article} was not found in MPVibe realtime data.`,
      };
    }
    const stocks = stocksPayload ? findStocksForCard(stocksPayload, cardId) : null;
    const stockFbo = extractMpvibeStockValue(stocks?.stock) ?? extractMpvibeStockValue(mainCard?.stock_data);
    return {
      article,
      card_id: cardId,
      account_id: mainCard?.account_id ?? null,
      stock_fbo: stockFbo,
      available: stockFbo !== null,
      error: stockFbo === null ? "MPVibe stock was not found for article." : null,
    };
  });

  return {
    ok: true,
    available: rows.some((row) => row.available),
    generated_at: new Date().toISOString(),
    range: { start, end },
    requested_articles: requestedArticles,
    rows,
    errors: [
      ...requestErrors.map((error) => ({ articles: requestedArticles, error })),
      ...rows
        .filter((row) => row.error)
        .map((row) => ({
          articles: [row.article],
          error: row.error,
        })),
    ],
  };
}
