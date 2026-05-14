const MPVIBE_API_ORIGIN = "https://m-api.mpvibe.ru";

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

function hasMpvibeAuth(env) {
  return Boolean(String(env.MPVIBE_COOKIE_HEADER || env.MPVIBE_AUTHORIZATION || "").trim());
}

function mpvibeHeaders(env) {
  const headers = new Headers({
    accept: "application/json, text/plain, */*",
    origin: "https://m.mpvibe.ru",
    referer: "https://m.mpvibe.ru/",
  });
  const cookieHeader = String(env.MPVIBE_COOKIE_HEADER || "").trim();
  const authorization = String(env.MPVIBE_AUTHORIZATION || "").trim();
  if (cookieHeader) {
    headers.set("cookie", cookieHeader);
  }
  if (authorization) {
    headers.set("authorization", authorization);
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
  const response = await fetch(url.toString(), { headers: mpvibeHeaders(env) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MPVibe request failed (${response.status}): ${text.slice(0, 240) || response.statusText}`);
  }
  return text ? JSON.parse(text) : null;
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function asNumberOrNull(value) {
  const numeric = Number(value);
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
