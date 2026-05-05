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
const CATALOG_CHART_CAMPAIGN_TYPE_META = {
  "cpm-manual": { label: "CPM · Ручная", color: "#2ea36f", order: 1 },
  "cpm-unified": { label: "CPM · Единая", color: "#4b7bff", order: 2 },
  cpc: { label: "CPC", color: "#8b64f6", order: 3 },
};

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

function firstNumber(...values) {
  for (const value of values) {
    const numeric = numberOrNull(value);
    if (numeric !== null) {
      return numeric;
    }
  }
  return null;
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

function catalogChartCampaignTypeForRow(row) {
  const slot = catalogCampaignSlotForRow(row || {});
  if (slot === "cpc") {
    return "cpc";
  }
  if (slot === "unified") {
    return "cpm-unified";
  }
  return "cpm-manual";
}

function cloneCatalogChartCampaignTypeOrders(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([key, rawValue]) => [key, asFloat(rawValue)])
      .filter(([, numeric]) => numeric > 0),
  );
}

function createCatalogChartCampaignTypeMetrics() {
  return {
    views: 0,
    clicks: 0,
    atbs: 0,
    orders: 0,
    spend: 0,
    revenue: 0,
  };
}

function cloneCatalogChartCampaignTypeMetrics(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([typeKey, rawMetrics]) => {
        const metrics = rawMetrics && typeof rawMetrics === "object" && !Array.isArray(rawMetrics) ? rawMetrics : {};
        const normalized = {
          views: asFloat(metrics.views),
          clicks: asFloat(metrics.clicks),
          atbs: asFloat(metrics.atbs),
          orders: asFloat(metrics.orders),
          spend: asFloat(metrics.spend),
          revenue: asFloat(metrics.revenue),
        };
        return [typeKey, normalized];
      })
      .filter(([, metrics]) => Object.values(metrics).some((numeric) => numeric > 0)),
  );
}

function addCatalogChartCampaignTypeOrder(target, typeKey, value) {
  const numeric = asFloat(value);
  if (!typeKey || numeric <= 0) {
    return;
  }
  target.orders_by_campaign_type = target.orders_by_campaign_type || {};
  target.orders_by_campaign_type[typeKey] = asFloat(target.orders_by_campaign_type[typeKey]) + numeric;
}

function addCatalogChartCampaignTypeOrders(target, source) {
  for (const [typeKey, value] of Object.entries(source || {})) {
    addCatalogChartCampaignTypeOrder(target, typeKey, value);
  }
}

function addCatalogChartCampaignTypeMetrics(target, typeKey, metrics) {
  if (!typeKey) {
    return;
  }
  const normalized = {
    views: asFloat(metrics?.views),
    clicks: asFloat(metrics?.clicks),
    atbs: asFloat(metrics?.atbs),
    orders: asFloat(metrics?.orders),
    spend: asFloat(metrics?.spend),
    revenue: asFloat(metrics?.revenue),
  };
  if (!Object.values(normalized).some((numeric) => numeric > 0)) {
    return;
  }
  target.metrics_by_campaign_type = target.metrics_by_campaign_type || {};
  const bucket = target.metrics_by_campaign_type[typeKey] || createCatalogChartCampaignTypeMetrics();
  Object.entries(normalized).forEach(([key, value]) => {
    bucket[key] = asFloat(bucket[key]) + value;
  });
  target.metrics_by_campaign_type[typeKey] = bucket;
}

function addCatalogChartCampaignTypeMetricsMap(target, source) {
  for (const [typeKey, metrics] of Object.entries(source || {})) {
    addCatalogChartCampaignTypeMetrics(target, typeKey, metrics);
  }
}

function buildCatalogCampaignTypeTotalsFromCampaigns(campaigns) {
  const target = { metrics_by_campaign_type: {} };
  for (const campaign of campaigns || []) {
    const stat = campaign?.stat || {};
    addCatalogChartCampaignTypeMetrics(target, catalogChartCampaignTypeForRow(campaign || {}), {
      views: stat.views,
      clicks: stat.clicks,
      atbs: stat.atbs,
      orders: stat.orders,
      spend: stat.sum ?? stat.expense_sum,
      revenue: stat.sum_price ?? stat.revenue,
    });
  }
  return cloneCatalogChartCampaignTypeMetrics(target.metrics_by_campaign_type);
}

function isCatalogCampaignRow(source) {
  const hasIdentity = ["id", "campaign_id", "external_id", "wb_id"].some((field) => source?.[field] !== null && source?.[field] !== undefined);
  const hasCampaignFields = [
    "status",
    "status_xway",
    "payment_type",
    "paymentType",
    "auction_mode",
    "auto_type",
    "unified",
    "budget_rule",
    "budget_rule_config",
    "limits_by_period",
  ].some((field) => Object.prototype.hasOwnProperty.call(source || {}, field));
  return hasIdentity && hasCampaignFields;
}

function collectCampaignRowsFromSource(source) {
  if (!source || typeof source !== "object") {
    return [];
  }
  const rows = [];
  if (isCatalogCampaignRow(source)) {
    rows.push(source);
  }
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

function mergePlainObjects(left, right) {
  return {
    ...(left && typeof left === "object" && !Array.isArray(left) ? left : {}),
    ...(right && typeof right === "object" && !Array.isArray(right) ? right : {}),
  };
}

function mergeSpendLimitArrays(left, right) {
  const seen = new Set();
  return [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])].filter((item, index) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const key = JSON.stringify([
      item.period ?? item.limit_period ?? index,
      item.limit ?? item.limit_sum ?? item.value ?? null,
      item.spent ?? item.spent_today ?? item.current ?? item.used ?? null,
      item.active ?? null,
    ]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function mergeCampaignRow(left, right) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right || {})) {
    if (value !== null && value !== undefined && value !== "") {
      merged[key] = value;
    }
  }
  for (const key of ["limits_by_period", "spend", "budget_rule", "budget_rule_config"]) {
    merged[key] = mergePlainObjects(left?.[key], right?.[key]);
  }
  if (Array.isArray(left?.spend_limits) || Array.isArray(right?.spend_limits)) {
    merged.spend_limits = mergeSpendLimitArrays(left?.spend_limits, right?.spend_limits);
  }
  return merged;
}

function uniqueCampaignRows(rows) {
  const order = [];
  const byKey = new Map();
  rows.forEach((row, index) => {
    const key = row?.id ?? row?.campaign_id ?? row?.external_id ?? row?.wb_id ?? `idx-${index}`;
    const normalized = String(key);
    if (!byKey.has(normalized)) {
      order.push(normalized);
      byKey.set(normalized, row);
      return;
    }
    byKey.set(normalized, mergeCampaignRow(byKey.get(normalized), row));
  });
  return order.map((key) => byKey.get(key));
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
  const spendByPeriod = source?.spend || {};
  const readSpendValue = (value) =>
    firstNumber(value, value?.spent, value?.spent_today, value?.current, value?.used, value?.value, value?.sum, value?.amount);
  const readPeriodSpend = (period) =>
    readSpendValue(spendByPeriod?.[period]) ??
    readSpendValue(spendByPeriod?.[String(period || "").toUpperCase()]) ??
    readSpendValue(spendByPeriod?.[String(period || "").toLowerCase()]) ??
    null;
  const periodItems = Object.entries(limitsByPeriod).map(([period, config]) => ({
    period,
    active: Boolean(config?.active),
    limit: firstNumber(config?.limit, config?.limit_sum, config?.limitSum, config?.value, config?.sum, config?.amount, config?.max, config?.max_sum),
    spent: readPeriodSpend(period),
  }));
  const rawSpendLimits = Array.isArray(source?.spend_limits)
    ? source.spend_limits
    : Array.isArray(source?.spend_limits?.items)
      ? source.spend_limits.items
      : [];
  const spendLimitItems = rawSpendLimits.map((item) => ({
    period: item?.period ?? item?.limit_period,
    active: Boolean(item?.active),
    limit: firstNumber(item?.limit, item?.limit_sum, item?.limitSum, item?.value, item?.sum, item?.amount, item?.max, item?.max_sum),
    spent:
      firstNumber(item?.spent, item?.spent_today, item?.current, item?.used, item?.value_spent, item?.spent_sum, item?.amount_spent) ??
      readPeriodSpend(item?.period ?? item?.limit_period),
  }));
  const directLimit = firstNumber(source?.spend_limit, source?.day_limit, source?.daily_limit, source?.limit, source?.limit_sum, source?.spend_limit_sum, source?.daily_limit_sum);
  const directLimitItem =
    directLimit !== null || source?.spend_limit_active
      ? {
          period: source?.spend_limit_period ?? source?.limit_period ?? "day",
          active: Boolean(source?.spend_limit_active ?? source?.active),
          limit: directLimit,
          spent:
            firstNumber(source?.spend_limit_spent, source?.spend_limit_spent_today, source?.day_limit_spent, source?.daily_limit_spent, source?.spent_today, source?.spent_day) ??
            readPeriodSpend(source?.spend_limit_period ?? source?.limit_period ?? "day"),
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
  const readSpendValue = (value) => firstNumber(value, value?.spent, value?.spent_today, value?.current, value?.used, value?.value, value?.sum, value?.amount);
  const stat = source?.stat || source?.metrics || {};
  return (
    readSpendValue(source?.spend?.DAY) ??
    readSpendValue(source?.spend?.day) ??
    numberOrNull(source?.spend_today) ??
    numberOrNull(source?.spent_day) ??
    numberOrNull(source?.spend_day) ??
    numberOrNull(source?.day_spend) ??
    numberOrNull(source?.today_spend) ??
    numberOrNull(source?.today_expense) ??
    numberOrNull(source?.expense_day) ??
    numberOrNull(source?.expense_today) ??
    numberOrNull(source?.spent_today) ??
    firstNumber(stat?.sum, stat?.expense_sum)
  );
}

function readBudgetSpentToday(source, budgetRule) {
  return (
    firstNumber(budgetRule?.spent, budgetRule?.spent_today, budgetRule?.current, budgetRule?.used, budgetRule?.value, budgetRule?.sum, budgetRule?.amount) ??
    firstNumber(source?.budget_spent_today, source?.budget_spent, source?.budget_used, source?.budget_current) ??
    readCampaignSpendToday(source) ??
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
    const budgetLimit = firstNumber(
      budgetRule.limit,
      budgetRule.limit_sum,
      budgetRule.limitSum,
      budgetRule.max,
      budgetRule.max_sum,
      budgetRule.value,
      source.budget_limit,
      source.budget_rule_limit,
      source.budget_limit_sum,
    );
    const spendLimit = resolveSpendLimitConfig(source);
    const spendToday = numberOrNull(spendLimit?.spent) ?? readCampaignSpendToday(source);
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
    if ((spendLimit?.limit === null || spendLimit?.limit === undefined) && budgetLimit !== null && budgetLimit > 0) {
      spendLimits.push(budgetLimit);
      spendLimitActive = spendLimitActive || Boolean(budgetRule.active ?? source.budget_rule_active);
    }
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

export function normalizeCatalogCampaignStates(raw, extraSources = []) {
  const payload = raw || {};
  const rows = [];
  for (const key of CATALOG_CAMPAIGN_FIELD_ORDER) {
    const campaigns = catalogCampaignRowsForKey(payload, key, extraSources);
    const statusSource = campaigns.find((campaign) => extractCatalogCampaignStatusCode(campaign?.status_xway ?? campaign?.status));
    const normalizedCode =
      extractCatalogCampaignStatusCode(payload[key]) ||
      extractCatalogCampaignStatusCode(statusSource?.status_xway ?? statusSource?.status);
    if (!normalizedCode) {
      continue;
    }
    const meta = CATALOG_CAMPAIGN_FIELD_META[key] || {};
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

function productHasCampaignSlots(product, statItem) {
  const campaignData = product?.campaigns_data || {};
  return (
    Boolean(campaignData.unified || campaignData.manual_search || campaignData.manual_recom || campaignData.cpc) ||
    Number(statItem?.campaigns_count || 0) > 0 ||
    Number(campaignData.manual_count || 0) > 0
  );
}

async function collectCatalogCampaignDetailSources(shopId, products, statMap, client) {
  const targets = products
    .map((product) => {
      const productId = product?.id;
      const statItem = productId !== null && productId !== undefined ? statMap[String(productId)] || {} : {};
      return productId !== null && productId !== undefined && productHasCampaignSlots(product, statItem) ? product : null;
    })
    .filter(Boolean);
  const detailByProductId = new Map();
  let errorCount = 0;

  await mapWithConcurrency(targets, 4, async (product) => {
    try {
      const productId = product.id;
      const stata = await client.productStata(shopId, productId);
      detailByProductId.set(String(productId), {
        campaign_wb: cloneValue(stata?.campaign_wb || []),
      });
    } catch {
      errorCount += 1;
    }
  });

  return { detailByProductId, loadedCount: detailByProductId.size, errorCount };
}

async function collectShopCatalog(shop, client, includeExtended, productIds = null) {
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
  const products = productIds
    ? (listWo.products_wb || []).filter((product) => product?.id !== null && product?.id !== undefined && productIds.has(Number(product.id)))
    : listWo.products_wb || [];
  const statMap = listStat.products_wb || {};
  const campaignDetailSources = await collectCatalogCampaignDetailSources(shopId, products, statMap, client);

  const shopArticles = [];
  for (const product of products) {
    const article = String(product.external_id || "").trim();
    if (!article) {
      continue;
    }
    const productId = product.id;
    const campaignData = product.campaigns_data || {};
    const statItem = productId !== null && productId !== undefined ? statMap[String(productId)] || {} : {};
    const campaignDetailSource = productId !== null && productId !== undefined ? campaignDetailSources.detailByProductId.get(String(productId)) : null;
    const hasCampaignSlots = productHasCampaignSlots(product, statItem);
    const stat = statItem.stat || {};
    const spend = statItem.spend || {};
    const hasPeriodAdStats = [stat.sum, stat.views, stat.clicks, stat.atbs, stat.orders].some((value) => asFloat(value) > 0);
    const rawCampaignTypeTotals = campaignDetailSource ? buildCatalogCampaignTypeTotalsFromCampaigns(campaignDetailSource.campaign_wb || []) : null;
    const campaignTypeTotals = campaignDetailSource
      ? (Object.keys(rawCampaignTypeTotals).length || !hasCampaignSlots || !hasPeriodAdStats ? rawCampaignTypeTotals : null)
      : (hasCampaignSlots ? null : {});
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
      campaign_states: normalizeCatalogCampaignStates(campaignData, [product, statItem, campaignDetailSource]),
      campaign_type_totals: campaignTypeTotals,
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
    campaign_limit_details_loaded: campaignDetailSources.loadedCount,
    campaign_limit_details_errors: campaignDetailSources.errorCount,
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

function catalogProductRefsByShop(productRefs = []) {
  const refsByShop = new Map();
  for (const rawRef of productRefs || []) {
    const [shopPart, productPart] = String(rawRef || "").split(":", 2);
    const shopId = Number(shopPart);
    const productId = Number(productPart);
    if (!Number.isFinite(shopId) || !Number.isFinite(productId)) {
      continue;
    }
    if (!refsByShop.has(shopId)) {
      refsByShop.set(shopId, new Set());
    }
    refsByShop.get(shopId).add(productId);
  }
  return refsByShop;
}

export async function collectCatalog(env, { start = null, end = null, mode = "compact", forceRefresh = false, productRefs = [] } = {}) {
  const normalizedMode = String(mode || "").toLowerCase() === "full" ? "full" : "compact";
  const includeExtended = normalizedMode === "full";
  const client = new XwayApiClient(env, { start, end, forceRefresh });
  const refsByShop = catalogProductRefsByShop(productRefs);
  const shops = (await client.listShops()).filter((shop) => !refsByShop.size || refsByShop.has(Number(shop?.id)));
  const catalogShops = await mapWithConcurrency(shops, 4, (shop) =>
    collectShopCatalog(shop, client, includeExtended, refsByShop.get(Number(shop?.id)) || null),
  );

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
    ordered_total: 0,
    avg_stock: 0,
    expense_sum: 0,
    sum_price: 0,
    rel_sum_price: 0,
    rel_shks: 0,
    rel_atbs: 0,
    ordered_sum_total: 0,
    spent_sku_count: 0,
    orders_by_campaign_type: {},
    metrics_by_campaign_type: {},
  };
}

function finalizeCatalogChartRow(row) {
  const views = asFloat(row.views);
  const clicks = asFloat(row.clicks);
  const atbs = asFloat(row.atbs);
  const orders = asFloat(row.orders);
  const orderedTotal = asFloat(row.ordered_total);
  const avgStock = asFloat(row.avg_stock);
  const expenseSum = asFloat(row.expense_sum);
  const sumPrice = asFloat(row.sum_price);
  const relSumPrice = asFloat(row.rel_sum_price);
  const relShks = asFloat(row.rel_shks);
  const relAtbs = asFloat(row.rel_atbs);
  const orderedSumTotal = asFloat(row.ordered_sum_total);
  const spentSkuCount = Number.parseInt(String(row.spent_sku_count || 0), 10) || 0;
  const ordersByCampaignType = cloneCatalogChartCampaignTypeOrders(row.orders_by_campaign_type);
  const metricsByCampaignType = cloneCatalogChartCampaignTypeMetrics(row.metrics_by_campaign_type);
  return {
    ...row,
    views,
    clicks,
    atbs,
    orders,
    ordered_total: orderedTotal,
    avg_stock: avgStock,
    expense_sum: expenseSum,
    sum_price: sumPrice,
    rel_sum_price: relSumPrice,
    rel_shks: relShks,
    rel_atbs: relAtbs,
    ordered_sum_total: orderedSumTotal,
    spent_sku_count: spentSkuCount,
    orders_by_campaign_type: ordersByCampaignType,
    metrics_by_campaign_type: metricsByCampaignType,
    ctr: catalogChartRate(clicks, views),
    cr1: catalogChartRate(atbs, clicks),
    cr2: catalogChartRate(orders, atbs),
    crf: catalogChartRate(orders, clicks),
    cr_total: catalogChartRate(orderedTotal, views),
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
    ordered_total: 0,
    avg_stock: 0,
    expense_sum: 0,
    sum_price: 0,
    rel_sum_price: 0,
    rel_shks: 0,
    rel_atbs: 0,
    ordered_sum_total: 0,
    orders_by_campaign_type: {},
    metrics_by_campaign_type: {},
  };
  for (const row of rows) {
    totals.views += asFloat(row.views);
    totals.clicks += asFloat(row.clicks);
    totals.atbs += asFloat(row.atbs);
    totals.orders += asFloat(row.orders);
    totals.ordered_total += asFloat(row.ordered_total);
    totals.avg_stock += asFloat(row.avg_stock);
    totals.expense_sum += asFloat(row.expense_sum);
    totals.sum_price += asFloat(row.sum_price);
    totals.rel_sum_price += asFloat(row.rel_sum_price);
    totals.rel_shks += asFloat(row.rel_shks);
    totals.rel_atbs += asFloat(row.rel_atbs);
    totals.ordered_sum_total += asFloat(row.ordered_sum_total);
    addCatalogChartCampaignTypeOrders(totals, row.orders_by_campaign_type);
    addCatalogChartCampaignTypeMetricsMap(totals, row.metrics_by_campaign_type);
  }
  return {
    ...totals,
    orders_by_campaign_type: cloneCatalogChartCampaignTypeOrders(totals.orders_by_campaign_type),
    metrics_by_campaign_type: cloneCatalogChartCampaignTypeMetrics(totals.metrics_by_campaign_type),
    ctr: catalogChartRate(totals.clicks, totals.views),
    cr1: catalogChartRate(totals.atbs, totals.clicks),
    cr2: catalogChartRate(totals.orders, totals.atbs),
    crf: catalogChartRate(totals.orders, totals.clicks),
    cr_total: catalogChartRate(totals.ordered_total, totals.views),
    drr_total: catalogChartRate(totals.expense_sum, totals.ordered_sum_total),
    drr_ads: catalogChartRate(totals.expense_sum, totals.sum_price),
  };
}

export async function collectCatalogChart(env, { productRefs = [], start = null, end = null, includeCampaignTypes = false } = {}) {
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
      let campaignDailyExact = {};
      let campaignTypeById = new Map();
      if (includeCampaignTypes) {
        try {
          const stata = await client.productStata(shopId, productId);
          const campaigns = stata?.campaign_wb || [];
          const campaignIds = campaigns.map((campaign) => campaign?.id).filter((campaignId) => campaignId !== null && campaignId !== undefined);
          campaignTypeById = new Map(campaigns.map((campaign) => [String(campaign.id), catalogChartCampaignTypeForRow(campaign)]));
          campaignDailyExact = campaignIds.length
            ? await client.campaignDailyExact(shopId, productId, campaignIds, client.range.current_start, client.range.current_end)
            : {};
        } catch {
          campaignDailyExact = {};
          campaignTypeById = new Map();
        }
      }
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
        const relSumPrice = asFloat(row.rel_sum_price);
        const relShks = asFloat(row.rel_shks);
        const relAtbs = asFloat(row.rel_atbs);
        const orderedSumTotal = asFloat(row.ordered_sum_total);
        const orderedTotal = asFloat(row.ordered_total);
        const avgStock = asFloat(row.avg_stock);
        target.views += asFloat(row.views);
        target.clicks += asFloat(row.clicks);
        target.atbs += asFloat(row.atbs);
        target.orders += asFloat(row.orders);
        target.ordered_total += orderedTotal;
        target.avg_stock += avgStock;
        target.expense_sum += expenseSum;
        target.sum_price += sumPrice;
        target.rel_sum_price += relSumPrice;
        target.rel_shks += relShks;
        target.rel_atbs += relAtbs;
        target.ordered_sum_total += orderedSumTotal;
        productTarget.views += asFloat(row.views);
        productTarget.clicks += asFloat(row.clicks);
        productTarget.atbs += asFloat(row.atbs);
        productTarget.orders += asFloat(row.orders);
        productTarget.ordered_total += orderedTotal;
        productTarget.avg_stock += avgStock;
        productTarget.expense_sum += expenseSum;
        productTarget.sum_price += sumPrice;
        productTarget.rel_sum_price += relSumPrice;
        productTarget.rel_shks += relShks;
        productTarget.rel_atbs += relAtbs;
        productTarget.ordered_sum_total += orderedSumTotal;
        if (expenseSum > 0) {
          target.spent_sku_count += 1;
          productTarget.spent_sku_count = 1;
        }
      }
      for (const [campaignId, campaignRows] of Object.entries(campaignDailyExact || {})) {
        const typeKey = campaignTypeById.get(String(campaignId));
        if (!typeKey) {
          continue;
        }
        for (const campaignRow of campaignRows || []) {
          const day = campaignRow?.day;
          const target = rowsByDay.get(day);
          const productTarget = productRowsByDay.get(day);
          if (!target || !productTarget) {
            continue;
          }
          const orders = asFloat(campaignRow.orders);
          addCatalogChartCampaignTypeOrder(target, typeKey, orders);
          addCatalogChartCampaignTypeOrder(productTarget, typeKey, orders);
          const typeMetrics = {
            views: campaignRow.views,
            clicks: campaignRow.clicks,
            atbs: campaignRow.atbs,
            orders: campaignRow.orders,
            spend: campaignRow.expense_sum,
            revenue: campaignRow.sum_price,
          };
          addCatalogChartCampaignTypeMetrics(target, typeKey, typeMetrics);
          addCatalogChartCampaignTypeMetrics(productTarget, typeKey, typeMetrics);
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
    campaign_type_meta: CATALOG_CHART_CAMPAIGN_TYPE_META,
    totals: buildCatalogChartTotals(rows),
    errors,
  };
}
