import { toNumber } from "../../lib/format";
import type { CatalogChartResponse } from "../../lib/types";

export interface CatalogChartProgressState {
  cacheKey: string;
  selectionCount: number;
  loadedProductsCount: number;
  chunkCount: number;
  loadedChunkCount: number;
  errorCount: number;
}

export interface CatalogChartCacheEntry {
  productRefsKey: string;
  rangeStart: string;
  rangeEnd: string;
  response: CatalogChartResponse;
}

function catalogChartRate(numerator: number, denominator: number) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function catalogChartTypeOrders(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value).reduce<Record<string, number>>((result, [key, rawValue]) => {
    const numeric = toNumber(rawValue) ?? 0;
    if (numeric > 0) {
      result[key] = numeric;
    }
    return result;
  }, {});
}

function catalogChartTypeMetrics(value: unknown): NonNullable<CatalogChartResponse["rows"][number]["metrics_by_campaign_type"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value).reduce<NonNullable<CatalogChartResponse["rows"][number]["metrics_by_campaign_type"]>>((result, [key, rawMetrics]) => {
    const metrics = rawMetrics && typeof rawMetrics === "object" && !Array.isArray(rawMetrics) ? (rawMetrics as Record<string, unknown>) : {};
    const normalized = {
      views: toNumber(metrics.views as string | number | null | undefined) ?? 0,
      clicks: toNumber(metrics.clicks as string | number | null | undefined) ?? 0,
      atbs: toNumber(metrics.atbs as string | number | null | undefined) ?? 0,
      orders: toNumber(metrics.orders as string | number | null | undefined) ?? 0,
      spend: toNumber(metrics.spend as string | number | null | undefined) ?? 0,
      revenue: toNumber(metrics.revenue as string | number | null | undefined) ?? 0,
    };
    if (Object.values(normalized).some((numeric) => numeric > 0)) {
      result[key] = normalized;
    }
    return result;
  }, {});
}

function addCatalogChartTypeOrders(
  target: CatalogChartResponse["rows"][number],
  source: unknown,
) {
  const sourceValues = catalogChartTypeOrders(source);
  target.orders_by_campaign_type = target.orders_by_campaign_type || {};
  Object.entries(sourceValues).forEach(([key, value]) => {
    target.orders_by_campaign_type![key] = (target.orders_by_campaign_type![key] ?? 0) + value;
  });
}

function addCatalogChartTypeMetrics(
  target: { metrics_by_campaign_type?: CatalogChartResponse["rows"][number]["metrics_by_campaign_type"] },
  source: unknown,
) {
  const sourceValues = catalogChartTypeMetrics(source);
  target.metrics_by_campaign_type = target.metrics_by_campaign_type || {};
  Object.entries(sourceValues).forEach(([key, metrics]) => {
    const bucket = target.metrics_by_campaign_type![key] || {};
    target.metrics_by_campaign_type![key] = {
      views: (toNumber(bucket.views) ?? 0) + (toNumber(metrics.views) ?? 0),
      clicks: (toNumber(bucket.clicks) ?? 0) + (toNumber(metrics.clicks) ?? 0),
      atbs: (toNumber(bucket.atbs) ?? 0) + (toNumber(metrics.atbs) ?? 0),
      orders: (toNumber(bucket.orders) ?? 0) + (toNumber(metrics.orders) ?? 0),
      spend: (toNumber(bucket.spend) ?? 0) + (toNumber(metrics.spend) ?? 0),
      revenue: (toNumber(bucket.revenue) ?? 0) + (toNumber(metrics.revenue) ?? 0),
    };
  });
}

function finalizeCatalogChartRow(row: CatalogChartResponse["rows"][number]) {
  const views = toNumber(row.views) ?? 0;
  const clicks = toNumber(row.clicks) ?? 0;
  const atbs = toNumber(row.atbs) ?? 0;
  const orders = toNumber(row.orders) ?? 0;
  const orderedTotal = toNumber(row.ordered_total) ?? 0;
  const avgStock = toNumber(row.avg_stock) ?? 0;
  const expenseSum = toNumber(row.expense_sum) ?? 0;
  const sumPrice = toNumber(row.sum_price) ?? 0;
  const relSumPrice = toNumber(row.rel_sum_price) ?? 0;
  const relShks = toNumber(row.rel_shks) ?? 0;
  const relAtbs = toNumber(row.rel_atbs) ?? 0;
  const orderedSumTotal = toNumber(row.ordered_sum_total) ?? 0;
  const spentSkuCount = toNumber(row.spent_sku_count) ?? 0;

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
    orders_by_campaign_type: catalogChartTypeOrders(row.orders_by_campaign_type),
    metrics_by_campaign_type: catalogChartTypeMetrics(row.metrics_by_campaign_type),
    ctr: catalogChartRate(clicks, views),
    cr1: catalogChartRate(atbs, clicks),
    cr2: catalogChartRate(orders, atbs),
    crf: catalogChartRate(orders, clicks),
    cr_total: catalogChartRate(orderedTotal, views),
    drr_total: catalogChartRate(expenseSum, orderedSumTotal),
    drr_ads: catalogChartRate(expenseSum, sumPrice),
  };
}

function buildCatalogChartTotals(rows: CatalogChartResponse["rows"]): CatalogChartResponse["totals"] {
  const totals = rows.reduce(
    (accumulator, row) => {
      accumulator.views += toNumber(row.views) ?? 0;
      accumulator.clicks += toNumber(row.clicks) ?? 0;
      accumulator.atbs += toNumber(row.atbs) ?? 0;
      accumulator.orders += toNumber(row.orders) ?? 0;
      accumulator.ordered_total += toNumber(row.ordered_total) ?? 0;
      accumulator.avg_stock += toNumber(row.avg_stock) ?? 0;
      accumulator.expense_sum += toNumber(row.expense_sum) ?? 0;
      accumulator.sum_price += toNumber(row.sum_price) ?? 0;
      accumulator.rel_sum_price += toNumber(row.rel_sum_price) ?? 0;
      accumulator.rel_shks += toNumber(row.rel_shks) ?? 0;
      accumulator.rel_atbs += toNumber(row.rel_atbs) ?? 0;
      accumulator.ordered_sum_total += toNumber(row.ordered_sum_total) ?? 0;
      addCatalogChartTypeMetrics(accumulator, row.metrics_by_campaign_type);
      return accumulator;
    },
    {
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
      metrics_by_campaign_type: {},
    },
  );

  return {
    ...totals,
    metrics_by_campaign_type: catalogChartTypeMetrics(totals.metrics_by_campaign_type),
    ctr: catalogChartRate(totals.clicks, totals.views),
    cr1: catalogChartRate(totals.atbs, totals.clicks),
    cr2: catalogChartRate(totals.orders, totals.atbs),
    crf: catalogChartRate(totals.orders, totals.clicks),
    cr_total: catalogChartRate(totals.ordered_total, totals.views),
    drr_total: catalogChartRate(totals.expense_sum, totals.ordered_sum_total),
    drr_ads: catalogChartRate(totals.expense_sum, totals.sum_price),
  };
}

export function mergeCatalogChartResponses(
  current: CatalogChartResponse | null,
  incoming: CatalogChartResponse,
  selectionCount: number,
): CatalogChartResponse {
  const rowsByDay = new Map<string, CatalogChartResponse["rows"][number]>();
  const seedRows = current?.rows.length ? current.rows : incoming.rows;

  seedRows.forEach((row) => {
    rowsByDay.set(row.day, {
      ...row,
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
      ctr: null,
      cr1: null,
      cr2: null,
      crf: null,
      cr_total: null,
      drr_total: null,
      drr_ads: null,
    });
  });

  [current?.rows ?? [], incoming.rows].forEach((sourceRows) => {
    sourceRows.forEach((row) => {
      const target = rowsByDay.get(row.day);
      if (!target) {
        rowsByDay.set(row.day, finalizeCatalogChartRow(row));
        return;
      }
      target.views += toNumber(row.views) ?? 0;
      target.clicks += toNumber(row.clicks) ?? 0;
      target.atbs += toNumber(row.atbs) ?? 0;
      target.orders += toNumber(row.orders) ?? 0;
      target.ordered_total += toNumber(row.ordered_total) ?? 0;
      target.avg_stock += toNumber(row.avg_stock) ?? 0;
      target.expense_sum += toNumber(row.expense_sum) ?? 0;
      target.sum_price += toNumber(row.sum_price) ?? 0;
      target.rel_sum_price += toNumber(row.rel_sum_price) ?? 0;
      target.rel_shks += toNumber(row.rel_shks) ?? 0;
      target.rel_atbs += toNumber(row.rel_atbs) ?? 0;
      target.ordered_sum_total += toNumber(row.ordered_sum_total) ?? 0;
      target.spent_sku_count += toNumber(row.spent_sku_count) ?? 0;
      addCatalogChartTypeOrders(target, row.orders_by_campaign_type);
      addCatalogChartTypeMetrics(target, row.metrics_by_campaign_type);
    });
  });

  const rows = [...rowsByDay.values()]
    .map((row) => finalizeCatalogChartRow(row))
    .sort((left, right) => left.day.localeCompare(right.day));

  return {
    ok: true,
    generated_at: incoming.generated_at,
    range: incoming.range,
    selection_count: selectionCount,
    loaded_products_count: (current?.loaded_products_count ?? 0) + (incoming.loaded_products_count ?? 0),
    rows,
    product_rows: [...(current?.product_rows ?? []), ...(incoming.product_rows ?? [])],
    campaign_type_meta: incoming.campaign_type_meta ?? current?.campaign_type_meta,
    totals: buildCatalogChartTotals(rows),
    errors: [...(current?.errors ?? []), ...(incoming.errors ?? [])],
  };
}

export function mergeCatalogChartRetryResponse(
  current: CatalogChartResponse,
  incoming: CatalogChartResponse,
  selectionCount: number,
  retriedRefs: string[],
): CatalogChartResponse {
  const retried = new Set(retriedRefs);
  const merged = mergeCatalogChartResponses(current, incoming, selectionCount);
  return {
    ...merged,
    errors: [
      ...current.errors.filter((error) => !retried.has(error.product)),
      ...incoming.errors,
    ],
  };
}

export function aggregateCatalogChartResponse(
  response: CatalogChartResponse,
  productRefs: string[],
  requestedStart: string,
  requestedEnd: string,
): CatalogChartResponse {
  const requestedRefs = new Set(productRefs);
  const sourceRows = response.rows.filter((row) => row.day >= requestedStart && row.day <= requestedEnd);

  if (!response.product_rows?.length) {
    const sliced = sliceCatalogChartResponse(response, requestedStart, requestedEnd);
    return {
      ...sliced,
      selection_count: productRefs.length,
      loaded_products_count: productRefs.length,
    };
  }

  const rowsByDay = new Map(
    sourceRows.map((row) => [
      row.day,
      {
        ...row,
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
        ctr: null,
        cr1: null,
        cr2: null,
        crf: null,
        cr_total: null,
        drr_total: null,
        drr_ads: null,
      },
    ]),
  );
  let loadedProductsCount = 0;

  response.product_rows.forEach((product) => {
    if (!requestedRefs.has(product.product_ref)) {
      return;
    }
    loadedProductsCount += 1;
    product.rows.forEach((row) => {
      if (row.day < requestedStart || row.day > requestedEnd) {
        return;
      }
      const target = rowsByDay.get(row.day);
      if (!target) {
        return;
      }
      const expenseSum = toNumber(row.expense_sum) ?? 0;
      target.views += toNumber(row.views) ?? 0;
      target.clicks += toNumber(row.clicks) ?? 0;
      target.atbs += toNumber(row.atbs) ?? 0;
      target.orders += toNumber(row.orders) ?? 0;
      target.ordered_total += toNumber(row.ordered_total) ?? 0;
      target.avg_stock += toNumber(row.avg_stock) ?? 0;
      target.expense_sum += expenseSum;
      target.sum_price += toNumber(row.sum_price) ?? 0;
      target.rel_sum_price += toNumber(row.rel_sum_price) ?? 0;
      target.rel_shks += toNumber(row.rel_shks) ?? 0;
      target.rel_atbs += toNumber(row.rel_atbs) ?? 0;
      target.ordered_sum_total += toNumber(row.ordered_sum_total) ?? 0;
      addCatalogChartTypeOrders(target, row.orders_by_campaign_type);
      addCatalogChartTypeMetrics(target, row.metrics_by_campaign_type);
      if (expenseSum > 0) {
        target.spent_sku_count += 1;
      }
    });
  });

  const rows = [...rowsByDay.values()]
    .map((row) => finalizeCatalogChartRow(row))
    .sort((left, right) => left.day.localeCompare(right.day));
  const errors = response.errors.filter((error) => requestedRefs.has(error.product));

  return {
    ...response,
    range: {
      ...response.range,
      current_start: requestedStart,
      current_end: requestedEnd,
      span_days: rows.length,
    },
    selection_count: productRefs.length,
    loaded_products_count: loadedProductsCount,
    rows,
    totals: buildCatalogChartTotals(rows),
    errors,
  };
}

function sliceCatalogChartResponse(
  response: CatalogChartResponse,
  requestedStart: string,
  requestedEnd: string,
): CatalogChartResponse {
  const rows = response.rows
    .filter((row) => row.day >= requestedStart && row.day <= requestedEnd)
    .map((row) => finalizeCatalogChartRow(row));

  return {
    ...response,
    range: {
      ...response.range,
      current_start: requestedStart,
      current_end: requestedEnd,
      span_days: rows.length,
    },
    rows,
    totals: buildCatalogChartTotals(rows),
  };
}

export function resolveCachedCatalogChartResponse(
  cache: Map<string, CatalogChartCacheEntry>,
  options: {
    cacheKey: string;
    productRefsKey: string;
    rangeStart: string;
    rangeEnd: string;
  },
) {
  const exact = cache.get(options.cacheKey);
  if (exact) {
    return exact.response;
  }

  let coveringEntry: CatalogChartCacheEntry | null = null;
  for (const entry of cache.values()) {
    if (entry.productRefsKey !== options.productRefsKey || entry.rangeEnd !== options.rangeEnd) {
      continue;
    }
    if (entry.rangeStart > options.rangeStart) {
      continue;
    }
    if (!coveringEntry || entry.rangeStart > coveringEntry.rangeStart) {
      coveringEntry = entry;
    }
  }

  if (!coveringEntry) {
    return null;
  }
  return sliceCatalogChartResponse(coveringEntry.response, options.rangeStart, options.rangeEnd);
}
