import { XwayApiClient } from "./xway-client.js";
import { asFloat, cloneValue, formatDay, iterIsoDays, mapWithConcurrency, parseCatalogChartProductRefs } from "./utils.js";

const CATALOG_CAMPAIGN_FIELD_ORDER = ["unified", "manual_search", "manual_recom", "cpc"];
const CATALOG_CAMPAIGN_FIELD_META = {
  unified: { label: "Единая ставка", short_label: "Ед. CPM" },
  manual_search: { label: "Поиск", short_label: "CPM Поиск" },
  manual_recom: { label: "Рекомендации", short_label: "CPM Реком" },
  cpc: { label: "Оплата за клики", short_label: "CPC" },
};
const SHOP_DETAIL_SAFE_FIELDS = [
  "id",
  "name",
  "marketplace",
  "tariff_code",
  "products_count",
  "created",
  "expired",
  "expired_days",
  "expire_date",
  "expire_in",
  "only_api",
  "recurrent_shop",
  "new_flow",
  "jam_status",
  "has_limit",
  "limit_q",
  "fact_q",
  "requests_num",
  "balance",
  "bonus",
  "cashback",
  "use_cashback",
  "account",
  "selected_contract",
  "selected_contract_secondary",
  "contracts",
  "tariffs",
  "top_up_balance_type",
  "top_up_balance_type_code",
  "top_up_balance_type_secondary",
  "top_up_balance_type_secondary_code",
];
const SHOP_PRODUCT_SAFE_FIELDS = [
  "id",
  "external_id",
  "name",
  "name_custom",
  "brand",
  "vendor_code",
  "category_keyword",
  "subject_id",
  "group",
  "disp_version",
  "progress_bar",
  "dispatcher_enabled",
  "dispatcher_errors",
  "enabled",
  "is_active",
  "ab_test_active",
  "ab_tests",
  "seo_sets",
  "tags",
  "main_image_url",
  "spend_limits",
  "stocks_rule",
  "campaigns_data",
];
const SHOP_STAT_SAFE_FIELDS = [
  "id",
  "budget",
  "day_budget",
  "campaigns_count",
  "stock",
  "ordered_report",
  "ordered_sum_report",
  "ordered_dynamics_report",
  "dynamics",
  "spend",
  "stat",
  "spend_limits",
  "dispatcher_enabled",
];

function snapshotFields(payload, fields) {
  const source = payload || {};
  const snapshot = {};
  for (const field of fields) {
    if (field in source) {
      snapshot[field] = cloneValue(source[field]);
    }
  }
  return snapshot;
}

function catalogCampaignStatusLabel(statusCode) {
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

function extractCatalogCampaignStatusCode(rawValue) {
  let value = rawValue;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    value = value.status;
  }
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = String(value).trim().toUpperCase();
  return normalized || null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeSpendLimitPeriod(period) {
  const value = String(period || "").toLowerCase();
  if (value.includes("day") || value.includes("дн")) {
    return "day";
  }
  if (value.includes("week") || value.includes("нед")) {
    return "week";
  }
  if (value.includes("month") || value.includes("мес")) {
    return "month";
  }
  return value;
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    return Object.values(value);
  }
  return [];
}

function catalogCampaignSlotForRow(row) {
  const text = [
    row?.payment_type,
    row?.paymentType,
    row?.name,
    row?.auction_mode,
    row?.auto_type,
    row?.type,
    row?.kind,
    row?.zone,
    row?.placement,
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  const isCpc = /cpc|click|клик/.test(text);
  const isUnified = Boolean(row?.unified) || /unified|auto|единая/.test(text);
  const isRecom = Boolean(row?.recom || row?.is_recom || row?.recommendation) || /recom|recommend|реком/.test(text);

  if (isCpc) {
    return "cpc";
  }
  if (isUnified) {
    return "unified";
  }
  return isRecom ? "manual_recom" : "manual_search";
}

function collectCampaignRowsFromSource(source) {
  if (!source || typeof source !== "object") {
    return [];
  }
  const rows = [];
  const directKeys = ["campaigns", "campaign_wb", "campaigns_wb", "campaign_items", "items"];
  for (const key of directKeys) {
    rows.push(...asArray(source[key]).filter((item) => item && typeof item === "object"));
  }
  const byType = source.campaigns_by_type || source.campaignsData?.campaigns_by_type || source.campaigns_data?.campaigns_by_type;
  if (byType && typeof byType === "object") {
    for (const value of Object.values(byType)) {
      rows.push(...asArray(value).filter((item) => item && typeof item === "object"));
    }
  }
  return rows;
}

function uniqueCampaignRows(rows) {
  const seen = new Set();
  return rows.filter((row, index) => {
    const key = row?.id ?? row?.campaign_id ?? row?.external_id ?? row?.wb_id ?? `idx-${index}`;
    const normalized = String(key);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function catalogCampaignRowsForKey(payload, key, extraSources = []) {
  const byType = payload?.campaigns_by_type || {};
  const candidatesByKey = {
    unified: ["unified", "auto", "automatic"],
    manual_search: ["manual_search", "search", "manual"],
    manual_recom: ["manual_recom", "recom", "recommendation", "recommendations"],
    cpc: ["cpc", "clicks"],
  };
  const typedRows = (candidatesByKey[key] || [key]).flatMap((candidateKey) => asArray(byType[candidateKey]));
  const inferredRows = [payload, ...extraSources]
    .flatMap((source) => collectCampaignRowsFromSource(source))
    .filter((row) => catalogCampaignSlotForRow(row) === key);
  return uniqueCampaignRows([...typedRows, ...inferredRows]);
}

function resolveSpendLimitConfig(source) {
  const limitsByPeriod = source?.limits_by_period || {};
  const periodItems = Object.entries(limitsByPeriod).map(([period, config]) => ({
    period,
    active: Boolean(config?.active),
    limit: numberOrNull(config?.limit),
  }));
  const rawSpendLimits = Array.isArray(source?.spend_limits)
    ? source.spend_limits
    : Array.isArray(source?.spend_limits?.items)
      ? source.spend_limits.items
      : [];
  const spendLimitItems = rawSpendLimits.map((item) => ({
    period: item?.period ?? item?.limit_period,
    active: Boolean(item?.active),
    limit: numberOrNull(item?.limit),
  }));
  const directLimit = numberOrNull(source?.spend_limit ?? source?.day_limit ?? source?.daily_limit ?? source?.limit);
  const directLimitItem =
    directLimit !== null || source?.spend_limit_active
      ? {
          period: source?.spend_limit_period ?? source?.limit_period ?? "day",
          active: Boolean(source?.spend_limit_active ?? source?.active),
          limit: directLimit,
        }
      : null;
  const items = [...periodItems, ...spendLimitItems, directLimitItem].filter((item) => item && (item.limit !== null || item.active));
  return (
    items.find((item) => item.active && normalizeSpendLimitPeriod(item.period) === "day") ||
    items.find((item) => item.active) ||
    items.find((item) => normalizeSpendLimitPeriod(item.period) === "day") ||
    items[0] ||
    null
  );
}

function readCampaignSpendToday(source) {
  return (
    numberOrNull(source?.spend?.DAY) ??
    numberOrNull(source?.spend?.day) ??
    numberOrNull(source?.spend_today) ??
    numberOrNull(source?.spent_day) ??
    numberOrNull(source?.spend_day) ??
    numberOrNull(source?.day_spend) ??
    numberOrNull(source?.today_spend) ??
    numberOrNull(source?.today_expense) ??
    numberOrNull(source?.expense_day) ??
    numberOrNull(source?.expense_today) ??
    numberOrNull(source?.spent_today)
  );
}

function readBudgetSpentToday(source, budgetRule) {
  return (
    numberOrNull(budgetRule?.spent) ??
    numberOrNull(budgetRule?.spent_today) ??
    numberOrNull(budgetRule?.current) ??
    numberOrNull(budgetRule?.used) ??
    numberOrNull(source?.budget_spent_today) ??
    numberOrNull(source?.budget_spent) ??
    null
  );
}

function normalizeCatalogCampaignLimitSummary(rawValue, campaigns) {
  const sources = [
    rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? rawValue : null,
    ...campaigns,
  ].filter(Boolean);
  const budgetLimits = [];
  const budgetSpentValues = [];
  const spendLimits = [];
  const spendSpentValues = [];
  let budgetRuleActive = false;
  let spendLimitActive = false;

  for (const source of sources) {
    const budgetRule = source.budget_rule_config || source.budget_rule || {};
    const budgetLimit = numberOrNull(budgetRule.limit ?? source.budget_limit ?? source.budget_rule_limit);
    const spendLimit = resolveSpendLimitConfig(source);
    const spendToday = readCampaignSpendToday(source);
    const budgetSpentToday = readBudgetSpentToday(source, budgetRule);

    if (budgetLimit !== null && budgetLimit > 0) {
      budgetLimits.push(budgetLimit);
    }
    if (budgetSpentToday !== null && budgetSpentToday >= 0) {
      budgetSpentValues.push(budgetSpentToday);
    }
    if (spendToday !== null && spendToday >= 0) {
      spendSpentValues.push(spendToday);
    }
    if (spendLimit?.limit !== null && spendLimit?.limit !== undefined && spendLimit.limit > 0) {
      spendLimits.push(spendLimit.limit);
    }
    budgetRuleActive = budgetRuleActive || Boolean(budgetRule.active ?? source.budget_rule_active);
    spendLimitActive = spendLimitActive || Boolean(spendLimit?.active ?? source.spend_limit_active);
  }

  return {
    budget_limit: budgetLimits.length ? budgetLimits.reduce((sum, value) => sum + value, 0) : null,
    budget_spent_today: budgetSpentValues.length ? budgetSpentValues.reduce((sum, value) => sum + value, 0) : null,
    budget_rule_active: budgetRuleActive,
    spend_limit: spendLimits.length ? spendLimits.reduce((sum, value) => sum + value, 0) : null,
    spend_spent_today: spendSpentValues.length ? spendSpentValues.reduce((sum, value) => sum + value, 0) : null,
    spend_limit_active: spendLimitActive,
  };
}

function normalizeCatalogCampaignStates(raw, extraSources = []) {
  const payload = raw || {};
  const rows = [];
  for (const key of CATALOG_CAMPAIGN_FIELD_ORDER) {
    const normalizedCode = extractCatalogCampaignStatusCode(payload[key]);
    if (!normalizedCode) {
      continue;
    }
    const meta = CATALOG_CAMPAIGN_FIELD_META[key] || {};
    const campaigns = catalogCampaignRowsForKey(payload, key, extraSources);
    rows.push({
      key,
      label: meta.label || key,
      short_label: meta.short_label || meta.label || key,
      status_code: normalizedCode,
      status_label: catalogCampaignStatusLabel(normalizedCode),
      active: normalizedCode === "ACTIVE",
      ...normalizeCatalogCampaignLimitSummary(payload[key], campaigns),
    });
  }
  return rows;
}

async function collectShopCatalog(shop, client, includeExtended) {
  const shopId = Number(shop.id);
  const [listingResult, shopDetailResult] = await Promise.allSettled([
    client.shopListing(shopId, client.range.current_start, client.range.current_end),
    client.shopDetails(shopId),
  ]);

  const listingError = listingResult.status === "rejected" ? String(listingResult.reason?.message || listingResult.reason || "Unknown error") : null;
  const shopDetailError = shopDetailResult.status === "rejected" ? String(shopDetailResult.reason?.message || shopDetailResult.reason || "Unknown error") : null;
  const listing = listingResult.status === "fulfilled" ? listingResult.value : { list_wo: {}, list_stat: {} };
  const shopDetail = shopDetailResult.status === "fulfilled" ? shopDetailResult.value : {};
  const listWo = listing.list_wo || {};
  const listStat = listing.list_stat || {};
  const shopListingMeta = {
    products_limit: listWo.products_limit,
    total_products: listWo.total_products,
    filtered_products: listWo.filtered_products,
    disabled_products: listWo.disabled_products,
    total_launched_ab_test: listWo.total_launched_ab_test,
    spend_limits_by_period: cloneValue(listWo.spend_limits_by_period || {}),
    shop_spend: cloneValue(listStat.spend || {}),
    shop_totals: cloneValue(listStat.totals || {}),
  };
  const products = listWo.products_wb || [];
  const statMap = listStat.products_wb || {};

  const shopArticles = [];
  for (const product of products) {
    const article = String(product.external_id || "").trim();
    if (!article) {
      continue;
    }
    const productId = product.id;
    const campaignData = product.campaigns_data || {};
    const statItem = productId !== null && productId !== undefined ? statMap[String(productId)] || {} : {};
    const stat = statItem.stat || {};
    const spend = statItem.spend || {};
    const articlePayload = {
      article,
      product_id: productId,
      name: product.name_custom || product.name || "",
      brand: product.brand || "",
      vendor_code: product.vendor_code || "",
      category_keyword: product.category_keyword || "",
      image_url: product.main_image_url || "",
      enabled: product.enabled,
      is_active: product.is_active,
      stock: statItem.stock,
      campaigns_count: statItem.campaigns_count,
      campaign_states: normalizeCatalogCampaignStates(campaignData, [product, statItem]),
      manual_campaigns_count: campaignData.manual_count,
      expense_sum: stat.sum,
      views: stat.views,
      clicks: stat.clicks,
      atbs: stat.atbs,
      orders: stat.orders,
      sum_price: stat.sum_price,
      ctr: stat.CTR,
      cpc: stat.CPC,
      cr: stat.CR,
      cpo: stat.CPO,
      cpo_overall: stat.CPO_overall,
      cpo_with_rel: stat.CPO_with_rel,
      drr: stat.DRR,
      budget: statItem.budget,
      day_budget: statItem.day_budget,
      ordered_report: statItem.ordered_report,
      ordered_sum_report: statItem.ordered_sum_report,
      spend_day: spend.DAY,
      spend_week: spend.WEEK,
      spend_month: spend.MONTH,
      dispatcher_enabled: statItem.dispatcher_enabled ?? product.dispatcher_enabled,
      group: product.group,
      subject_id: product.subject_id,
      disp_version: product.disp_version,
      ab_test_active: product.ab_test_active,
      ab_tests_count: (product.ab_tests || []).length,
      tags_count: (product.tags || []).length,
      seo_sets_count: (product.seo_sets || []).length,
      shop_url: `https://am.xway.ru/wb/shop/${shopId}`,
      product_url: productId !== null && productId !== undefined ? `https://am.xway.ru/wb/shop/${shopId}/product/${productId}` : null,
    };
    if (includeExtended) {
      Object.assign(articlePayload, {
        progress_bar: cloneValue(product.progress_bar),
        dispatcher_errors: cloneValue(product.dispatcher_errors || []),
        spend_limits: cloneValue(product.spend_limits),
        stocks_rule: cloneValue(product.stocks_rule),
        ordered_dynamics_report: cloneValue(statItem.ordered_dynamics_report),
        dynamics: cloneValue(statItem.dynamics),
        campaigns_data: cloneValue(campaignData),
        campaigns_by_type: cloneValue(campaignData.campaigns_by_type || {}),
        listing_product_snapshot: snapshotFields(product, SHOP_PRODUCT_SAFE_FIELDS),
        listing_stat_snapshot: snapshotFields(statItem, SHOP_STAT_SAFE_FIELDS),
      });
    }
    shopArticles.push(articlePayload);
  }

  shopArticles.sort((left, right) => {
    const leftKey = `${String(left.name || "").toLowerCase()}::${left.article}`;
    const rightKey = `${String(right.name || "").toLowerCase()}::${right.article}`;
    return leftKey.localeCompare(rightKey);
  });

  const shopPayload = {
    id: shopId,
    name: shop.name || `Кабинет ${shopId}`,
    marketplace: shop.marketplace,
    tariff_code: shop.tariff_code,
    only_api: shop.only_api,
    expired_days: shop.expired_days,
    shop_url: `https://am.xway.ru/wb/shop/${shopId}`,
    balance: shopDetail.balance,
    bonus: shopDetail.bonus,
    cashback: shopDetail.cashback,
    expired: shopDetail.expired,
    expire_in: shopDetail.expire_in,
    expire_date: shopDetail.expire_date,
    recurrent_shop: shopDetail.recurrent_shop,
    new_flow: shopDetail.new_flow,
    jam_status: shopDetail.jam_status,
    use_cashback: shopDetail.use_cashback,
    has_limit: shopDetail.has_limit,
    limit_q: shopDetail.limit_q,
    fact_q: shopDetail.fact_q,
    requests_num: shopDetail.requests_num,
    top_up_balance_type_code: shopDetail.top_up_balance_type_code,
    listing_meta: shopListingMeta,
    shop_detail_error: shopDetailError,
    products_count: shopArticles.length,
    listing_error: listingError,
    articles: shopArticles,
  };

  if (includeExtended) {
    Object.assign(shopPayload, {
      selected_contract: cloneValue(shopDetail.selected_contract),
      selected_contract_secondary: cloneValue(shopDetail.selected_contract_secondary),
      contracts: cloneValue(shopDetail.contracts || []),
      tariffs: cloneValue(shopDetail.tariffs || []),
      top_up_balance_type: cloneValue(shopDetail.top_up_balance_type),
      top_up_balance_type_secondary: cloneValue(shopDetail.top_up_balance_type_secondary),
      top_up_balance_type_secondary_code: shopDetail.top_up_balance_type_secondary_code,
      detail_snapshot: snapshotFields(shopDetail, SHOP_DETAIL_SAFE_FIELDS),
    });
  }

  return shopPayload;
}

export async function collectCatalog(env, { start = null, end = null, mode = "compact" } = {}) {
  const normalizedMode = String(mode || "").toLowerCase() === "full" ? "full" : "compact";
  const includeExtended = normalizedMode === "full";
  const client = new XwayApiClient(env, { start, end });
  const shops = await client.listShops();
  const catalogShops = await mapWithConcurrency(shops, 4, (shop) => collectShopCatalog(shop, client, includeExtended));

  const totals = {
    expense_sum: 0,
    orders: 0,
    atbs: 0,
    clicks: 0,
    views: 0,
  };
  for (const shopPayload of catalogShops) {
    const shopTotals = shopPayload.listing_meta?.shop_totals || {};
    totals.expense_sum += asFloat(shopTotals.sum);
    totals.orders += asFloat(shopTotals.orders);
    totals.atbs += asFloat(shopTotals.atbs);
    totals.clicks += asFloat(shopTotals.clicks);
    totals.views += asFloat(shopTotals.views);
  }

  catalogShops.sort((left, right) => {
    const leftKey = `${String(left.name || "").toLowerCase()}::${left.id}`;
    const rightKey = `${String(right.name || "").toLowerCase()}::${right.id}`;
    return leftKey.localeCompare(rightKey);
  });

  return {
    generated_at: new Date().toISOString().slice(0, 10),
    mode: normalizedMode,
    range: client.range,
    total_shops: catalogShops.length,
    total_articles: catalogShops.reduce((sum, shopPayload) => sum + Number(shopPayload.products_count || 0), 0),
    totals,
    shops: catalogShops,
  };
}

function catalogChartRate(numerator, denominator) {
  return denominator ? (numerator / denominator) * 100 : null;
}

function createEmptyCatalogChartRow(day) {
  return {
    day,
    day_label: formatDay(day),
    views: 0,
    clicks: 0,
    atbs: 0,
    orders: 0,
    expense_sum: 0,
    sum_price: 0,
    ordered_sum_total: 0,
    spent_sku_count: 0,
  };
}

function finalizeCatalogChartRow(row) {
  const views = asFloat(row.views);
  const clicks = asFloat(row.clicks);
  const atbs = asFloat(row.atbs);
  const orders = asFloat(row.orders);
  const expenseSum = asFloat(row.expense_sum);
  const sumPrice = asFloat(row.sum_price);
  const orderedSumTotal = asFloat(row.ordered_sum_total);
  const spentSkuCount = Number.parseInt(String(row.spent_sku_count || 0), 10) || 0;
  return {
    ...row,
    views,
    clicks,
    atbs,
    orders,
    expense_sum: expenseSum,
    sum_price: sumPrice,
    ordered_sum_total: orderedSumTotal,
    spent_sku_count: spentSkuCount,
    ctr: catalogChartRate(clicks, views),
    cr1: catalogChartRate(atbs, clicks),
    cr2: catalogChartRate(orders, atbs),
    crf: catalogChartRate(orders, clicks),
    drr_total: catalogChartRate(expenseSum, orderedSumTotal),
    drr_ads: catalogChartRate(expenseSum, sumPrice),
  };
}

function buildCatalogChartTotals(rows) {
  const totals = {
    views: 0,
    clicks: 0,
    atbs: 0,
    orders: 0,
    expense_sum: 0,
    sum_price: 0,
    ordered_sum_total: 0,
  };
  for (const row of rows) {
    totals.views += asFloat(row.views);
    totals.clicks += asFloat(row.clicks);
    totals.atbs += asFloat(row.atbs);
    totals.orders += asFloat(row.orders);
    totals.expense_sum += asFloat(row.expense_sum);
    totals.sum_price += asFloat(row.sum_price);
    totals.ordered_sum_total += asFloat(row.ordered_sum_total);
  }
  return {
    ...totals,
    ctr: catalogChartRate(totals.clicks, totals.views),
    cr1: catalogChartRate(totals.atbs, totals.clicks),
    cr2: catalogChartRate(totals.orders, totals.atbs),
    crf: catalogChartRate(totals.orders, totals.clicks),
    drr_total: catalogChartRate(totals.expense_sum, totals.ordered_sum_total),
    drr_ads: catalogChartRate(totals.expense_sum, totals.sum_price),
  };
}

export async function collectCatalogChart(env, { productRefs = [], start = null, end = null } = {}) {
  const client = new XwayApiClient(env, { start, end });
  const parsedRefs = parseCatalogChartProductRefs(productRefs);
  const days = iterIsoDays(client.range.current_start, client.range.current_end);
  const rowsByDay = new Map(days.map((day) => [day, createEmptyCatalogChartRow(day)]));
  const productRows = [];
  const errors = [];

  await mapWithConcurrency(parsedRefs, 6, async ([shopId, productId]) => {
    const productRef = `${shopId}:${productId}`;
    try {
      const rows = await client.productStatsByDay(shopId, productId, client.range.current_start, client.range.current_end);
      const productRowsByDay = new Map(days.map((day) => [day, createEmptyCatalogChartRow(day)]));
      for (const row of rows || []) {
        const day = row.day;
        const target = rowsByDay.get(day);
        const productTarget = productRowsByDay.get(day);
        if (!target || !productTarget) {
          continue;
        }
        const expenseSum = asFloat(row.expense_sum);
        const sumPrice = asFloat(row.sum_price);
        const orderedSumTotal = asFloat(row.ordered_sum_total);
        target.views += asFloat(row.views);
        target.clicks += asFloat(row.clicks);
        target.atbs += asFloat(row.atbs);
        target.orders += asFloat(row.orders);
        target.expense_sum += expenseSum;
        target.sum_price += sumPrice;
        target.ordered_sum_total += orderedSumTotal;
        productTarget.views += asFloat(row.views);
        productTarget.clicks += asFloat(row.clicks);
        productTarget.atbs += asFloat(row.atbs);
        productTarget.orders += asFloat(row.orders);
        productTarget.expense_sum += expenseSum;
        productTarget.sum_price += sumPrice;
        productTarget.ordered_sum_total += orderedSumTotal;
        if (expenseSum > 0) {
          target.spent_sku_count += 1;
          productTarget.spent_sku_count = 1;
        }
      }
      productRows.push({
        product_ref: productRef,
        rows: days.map((day) => finalizeCatalogChartRow(productRowsByDay.get(day))),
      });
    } catch (error) {
      errors.push({
        product: productRef,
        error: String(error?.message || error || "Unknown error"),
      });
    }
  });

  const rows = days.map((day) => finalizeCatalogChartRow(rowsByDay.get(day)));
  productRows.sort((left, right) => left.product_ref.localeCompare(right.product_ref));
  return {
    generated_at: new Date().toISOString().slice(0, 10),
    range: client.range,
    selection_count: parsedRefs.length,
    loaded_products_count: Math.max(parsedRefs.length - errors.length, 0),
    rows,
    product_rows: productRows,
    totals: buildCatalogChartTotals(rows),
    errors,
  };
}
