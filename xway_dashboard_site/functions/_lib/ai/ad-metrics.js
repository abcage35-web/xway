import { asFloat, resolveRange } from "../utils.js";

const DEFAULT_CHART_CHUNK_SIZE = 12;
const MAX_GROUP_ROWS_DEFAULT = 5000;
const GROUP_DIMENSIONS = new Set(["day", "category", "article", "shop", "campaign_type"]);

async function readJsonRequest(request) {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

async function fetchSelfJson(context, pathname, params = {}) {
  const url = new URL(pathname, context.request.url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url.toString(), {
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || text || `Self API request failed (${response.status})`);
  }
  return payload;
}

function toList(...values) {
  const result = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      result.push(...value);
      continue;
    }
    if (value !== null && value !== undefined && value !== "") {
      result.push(...String(value).split(","));
    }
  }
  return [...new Set(result.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\u0451/g, "\u0435")
    .replace(/\s+/g, " ");
}

function textMatchesAny(value, filters) {
  if (!filters.length) {
    return true;
  }
  const normalized = normalizeText(value);
  return filters.some((filter) => {
    const candidate = normalizeText(filter);
    return normalized === candidate || normalized.includes(candidate) || candidate.includes(normalized);
  });
}

function normalizeGroupBy(value) {
  const requested = toList(value).map((item) => item.toLowerCase());
  const groups = requested.filter((item) => GROUP_DIMENSIONS.has(item));
  return groups.length ? groups : ["day"];
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function catalogArticles(catalog) {
  const rows = [];
  for (const shop of catalog?.shops || []) {
    for (const article of shop.articles || []) {
      const productRef = `${shop.id}:${article.product_id}`;
      rows.push({
        product_ref: productRef,
        shop_id: shop.id,
        shop_name: shop.name,
        marketplace: shop.marketplace,
        article: String(article.article || ""),
        product_id: article.product_id,
        name: article.name || "",
        brand: article.brand || "",
        vendor_code: article.vendor_code || "",
        category: article.category_keyword || "",
        stock: article.stock ?? null,
        enabled: article.enabled ?? null,
        is_active: article.is_active ?? null,
      });
    }
  }
  return rows;
}

function filterCatalogArticles(rows, filters) {
  const productRefs = new Set(filters.productRefs);
  const articles = new Set(filters.articles.map((value) => String(value)));
  const shopIds = new Set(filters.shopIds.map((value) => String(value)));

  return rows.filter((row) => {
    if (productRefs.size && !productRefs.has(row.product_ref)) {
      return false;
    }
    if (articles.size && !articles.has(String(row.article))) {
      return false;
    }
    if (shopIds.size && !shopIds.has(String(row.shop_id))) {
      return false;
    }
    if (!textMatchesAny(row.shop_name, filters.shopNames)) {
      return false;
    }
    if (!textMatchesAny(row.category, filters.categories)) {
      return false;
    }
    return true;
  });
}

function rate(numerator, denominator) {
  return denominator ? (numerator / denominator) * 100 : null;
}

function createMetricBucket() {
  return {
    views: 0,
    clicks: 0,
    atbs: 0,
    orders: 0,
    ordered_total: 0,
    expense_sum: 0,
    sum_price: 0,
    ordered_sum_total: 0,
    spent_sku_count: 0,
  };
}

function addMetrics(target, source, { campaignTypeMetrics = false } = {}) {
  target.views += asFloat(source?.views);
  target.clicks += asFloat(source?.clicks);
  target.atbs += asFloat(source?.atbs);
  target.orders += asFloat(source?.orders);
  target.expense_sum += asFloat(campaignTypeMetrics ? source?.spend : source?.expense_sum);
  target.sum_price += asFloat(campaignTypeMetrics ? source?.revenue : source?.sum_price);
  if (!campaignTypeMetrics) {
    target.ordered_total += asFloat(source?.ordered_total);
    target.ordered_sum_total += asFloat(source?.ordered_sum_total);
    target.spent_sku_count += asFloat(source?.spent_sku_count);
  } else if (asFloat(source?.spend) > 0) {
    target.spent_sku_count += 1;
  }
}

function finalizeMetrics(metrics) {
  return {
    ...metrics,
    ctr: rate(metrics.clicks, metrics.views),
    cr_click_to_order: rate(metrics.orders, metrics.clicks),
    cr_view_to_order: rate(metrics.orders, metrics.views),
    cpc: metrics.clicks ? metrics.expense_sum / metrics.clicks : null,
    cpo: metrics.orders ? metrics.expense_sum / metrics.orders : null,
    drr_ads: rate(metrics.expense_sum, metrics.sum_price),
    drr_total: rate(metrics.expense_sum, metrics.ordered_sum_total),
  };
}

function campaignTypeLabel(typeKey, meta) {
  if (!typeKey) {
    return null;
  }
  return meta?.[typeKey]?.label || typeKey;
}

function groupIdentity(groupBy, meta, row, campaignType, campaignTypeMeta) {
  const identity = {};
  for (const dimension of groupBy) {
    if (dimension === "day") {
      identity.day = row.day;
    } else if (dimension === "category") {
      identity.category = meta.category || "uncategorized";
    } else if (dimension === "article") {
      identity.article = meta.article || null;
      identity.product_ref = meta.product_ref || null;
      identity.product_name = meta.name || null;
    } else if (dimension === "shop") {
      identity.shop_id = meta.shop_id ?? null;
      identity.shop_name = meta.shop_name || null;
    } else if (dimension === "campaign_type") {
      identity.campaign_type = campaignType || "unsplit";
      identity.campaign_type_label = campaignTypeLabel(identity.campaign_type, campaignTypeMeta);
    }
  }
  return identity;
}

function groupKey(identity) {
  return Object.keys(identity)
    .sort()
    .map((key) => `${key}=${identity[key] ?? ""}`)
    .join("|");
}

function emptyMeta(productRef) {
  const [shopId, productId] = String(productRef || "").split(":", 2);
  return {
    product_ref: productRef,
    shop_id: shopId || null,
    shop_name: null,
    article: null,
    product_id: productId || null,
    name: null,
    category: null,
  };
}

async function collectChartChunks(context, productRefs, range, includeCampaignTypes, forceRefresh) {
  const chunks = chunk(productRefs, DEFAULT_CHART_CHUNK_SIZE);
  const payloads = [];
  const errors = [];

  for (const refs of chunks) {
    try {
      payloads.push(
        await fetchSelfJson(context, "/api/catalog-chart", {
          products: refs.join(","),
          start: range.current_start,
          end: range.current_end,
          include_campaign_types: includeCampaignTypes ? "1" : "",
          force_refresh: forceRefresh ? "1" : "",
        }),
      );
    } catch (error) {
      errors.push({
        products: refs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { payloads, errors, chunk_count: chunks.length };
}

function aggregateRows({ chartPayloads, metaByRef, groupBy, rowLimit, includeCampaignTypes }) {
  const grouped = new Map();
  const totals = createMetricBucket();
  const campaignTypeTotals = new Map();
  let sourceRowsCount = 0;

  function touchGroup(identity) {
    const key = groupKey(identity);
    const existing = grouped.get(key);
    if (existing) {
      return existing;
    }
    const created = {
      ...identity,
      metrics: createMetricBucket(),
      _product_refs: new Set(),
    };
    grouped.set(key, created);
    return created;
  }

  for (const chart of chartPayloads) {
    for (const product of chart.product_rows || []) {
      const meta = metaByRef.get(product.product_ref) || emptyMeta(product.product_ref);
      for (const row of product.rows || []) {
        sourceRowsCount += 1;
        addMetrics(totals, row);

        if (includeCampaignTypes) {
          for (const [typeKey, metrics] of Object.entries(row.metrics_by_campaign_type || {})) {
            const bucket = campaignTypeTotals.get(typeKey) || createMetricBucket();
            addMetrics(bucket, metrics, { campaignTypeMetrics: true });
            campaignTypeTotals.set(typeKey, bucket);
          }
        }

        const typeEntries = groupBy.includes("campaign_type") && includeCampaignTypes
          ? Object.entries(row.metrics_by_campaign_type || {})
          : [[null, row]];
        const effectiveEntries = typeEntries.length ? typeEntries : [["unsplit", row]];

        for (const [typeKey, metrics] of effectiveEntries) {
          const identity = groupIdentity(groupBy, meta, row, typeKey, chart.campaign_type_meta || {});
          const target = touchGroup(identity);
          addMetrics(target.metrics, metrics, { campaignTypeMetrics: Boolean(typeKey) && typeKey !== "unsplit" });
          target._product_refs.add(product.product_ref);
        }
      }
    }
  }

  const rows = [...grouped.values()]
    .map((row) => {
      const productCount = row._product_refs.size;
      delete row._product_refs;
      return {
        ...row,
        product_count: productCount,
        metrics: finalizeMetrics(row.metrics),
      };
    })
    .sort((left, right) => {
      const leftKey = [left.day, left.shop_name, left.category, left.article, left.campaign_type].filter(Boolean).join("|");
      const rightKey = [right.day, right.shop_name, right.category, right.article, right.campaign_type].filter(Boolean).join("|");
      return leftKey.localeCompare(rightKey);
    });

  return {
    source_rows_count: sourceRowsCount,
    row_count: rows.length,
    rows: rows.slice(0, rowLimit),
    truncated: rows.length > rowLimit,
    totals: finalizeMetrics(totals),
    campaign_type_totals: Object.fromEntries(
      [...campaignTypeTotals.entries()].map(([typeKey, metrics]) => [typeKey, finalizeMetrics(metrics)]),
    ),
  };
}

export async function collectAiAdMetrics(context) {
  const requestBody = await readJsonRequest(context.request);
  const range = resolveRange(requestBody.start, requestBody.end, new Date(), 30);
  const forceRefresh = Boolean(requestBody.refresh);
  const groupBy = normalizeGroupBy(requestBody.group_by || requestBody.slices);
  const includeCampaignTypes = requestBody.include_campaign_types !== false || groupBy.includes("campaign_type");
  const rowLimit = Math.max(1, Math.min(Number.parseInt(String(requestBody.row_limit || MAX_GROUP_ROWS_DEFAULT), 10) || MAX_GROUP_ROWS_DEFAULT, 20000));
  const filters = {
    categories: toList(requestBody.categories, requestBody.category),
    articles: toList(requestBody.articles, requestBody.article),
    shopIds: toList(requestBody.shop_ids, requestBody.shop_id),
    shopNames: toList(requestBody.shop_names, requestBody.shop_name),
    productRefs: toList(requestBody.product_refs, requestBody.products),
  };

  const catalog = await fetchSelfJson(context, "/api/catalog", {
    start: range.current_start,
    end: range.current_end,
    mode: "compact",
    force_refresh: forceRefresh ? "1" : "",
  });
  const allArticles = catalogArticles(catalog);
  const matchedArticles = filterCatalogArticles(allArticles, filters);
  const productRefs = matchedArticles.map((row) => row.product_ref);

  if (!productRefs.length) {
    return {
      ok: true,
      generated_at: new Date().toISOString(),
      range,
      request: {
        filters,
        group_by: groupBy,
        include_campaign_types: includeCampaignTypes,
      },
      selection: {
        total_catalog_articles: allArticles.length,
        matched_articles: 0,
        matched_shops: 0,
        categories: [],
      },
      rows: [],
      row_count: 0,
      truncated: false,
      totals: finalizeMetrics(createMetricBucket()),
      campaign_type_totals: {},
      errors: [],
    };
  }

  const metaByRef = new Map(matchedArticles.map((row) => [row.product_ref, row]));
  const chart = await collectChartChunks(context, productRefs, range, includeCampaignTypes, forceRefresh);
  const aggregated = aggregateRows({
    chartPayloads: chart.payloads,
    metaByRef,
    groupBy,
    rowLimit,
    includeCampaignTypes,
  });
  const chartErrors = chart.payloads.flatMap((payload) => payload.errors || []);
  const loadedRefs = new Set(chart.payloads.flatMap((payload) => (payload.product_rows || []).map((row) => row.product_ref)));
  const matchedShopIds = new Set(matchedArticles.map((row) => String(row.shop_id)));
  const matchedCategories = [...new Set(matchedArticles.map((row) => row.category || "uncategorized"))].sort((left, right) => left.localeCompare(right));

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    range,
    request: {
      filters,
      group_by: groupBy,
      include_campaign_types: includeCampaignTypes,
      row_limit: rowLimit,
    },
    selection: {
      total_catalog_articles: allArticles.length,
      matched_articles: matchedArticles.length,
      matched_shops: matchedShopIds.size,
      loaded_products_count: loadedRefs.size,
      chart_chunk_count: chart.chunk_count,
      categories: matchedCategories,
      product_refs: productRefs,
    },
    rows: aggregated.rows,
    row_count: aggregated.row_count,
    source_rows_count: aggregated.source_rows_count,
    truncated: aggregated.truncated,
    totals: aggregated.totals,
    campaign_type_totals: aggregated.campaign_type_totals,
    campaign_type_meta: chart.payloads.find((payload) => payload.campaign_type_meta)?.campaign_type_meta || {},
    errors: [...chart.errors, ...chartErrors],
  };
}
