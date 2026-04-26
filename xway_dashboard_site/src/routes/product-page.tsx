import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, ChevronDown, ExternalLink, Info, Maximize2, Minus, Pause, Pin, Play, Plus, Search, Snowflake, Star, ThumbsUp, X } from "lucide-react";
import MarqueeImport from "react-fast-marquee";
import type { CSSProperties, ElementType, MouseEvent, ReactNode } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useNavigate, useNavigation, useRevalidator } from "react-router";
import {
  buildCampaignStatusHourSlots,
  buildCampaignIssueSummaries,
  CampaignIssueDayBreakdownList,
  CampaignInlineOverviewChart,
  CampaignInlineIssuesPanel,
  type CampaignIssueBreakdownDay,
  type CampaignIssueSummary,
  type CampaignOverviewStatusEntry,
  type CampaignOverviewStatusDay,
  ChartWindowSwitch,
  DailyPerformanceChart,
  HourlyPerformanceChart,
  ProductOverviewCharts,
  resolveOverviewWindow,
  type OverviewWindow,
} from "../components/charts";
import { CampaignBidHistoryDialog, type CampaignBidHistoryDialogTarget } from "../components/campaign-bid-history-dialog";
import { CampaignBudgetHistoryDialog, type CampaignBudgetHistoryDialogTarget } from "../components/campaign-budget-history-dialog";
import { ClusterDetailDialog, type ClusterDialogTarget } from "../components/cluster-detail-dialog";
import { ProductTopToolbar } from "../components/product-top-toolbar";
import { EmptyState, MetricTable, ScheduleMatrix, SearchField } from "../components/ui";
import { fetchProducts, parseArticlesParam } from "../lib/api";
import {
  buildBidChangeFromPreviousDay,
  buildDailyBidRows,
  formatBidMoney,
  formatSignedBidMoney,
  resolveBidKind,
  resolveBidLabel,
} from "../lib/bid-history";
import {
  buildPresetRange,
  cn,
  formatCompactNumber,
  formatDateRange,
  formatMoney,
  formatNumber,
  formatPercent,
  getTodayIso,
  getRangePreset,
  toNumber,
} from "../lib/format";
import type {
  BudgetRuleConfig,
  CampaignPauseHistoryEntry,
  CampaignPauseHistoryPayload,
  CampaignDailyExactRow,
  CampaignScheduleConfig,
  CampaignSpendLimitItem,
  CampaignSummary,
  ClusterDailyRow,
  ClusterItem,
  DailyStat,
  ProductStocksRule,
  ProductSummary,
  ProductsResponse,
  ScheduleAggregate,
} from "../lib/types";

type ProductTab = "overview" | "daily" | "campaign-status" | "clusters" | "campaign-heatmap" | "bids";

interface ProductLoaderData {
  payload: ProductsResponse;
  comparePayload: ProductsResponse | null;
  trackedArticles: string[];
  start?: string | null;
  end?: string | null;
  payloadIsCached?: boolean;
}

const PANEL_CLASS = "rounded-[30px] border border-[var(--color-line)] bg-white shadow-[0_24px_60px_rgba(44,35,66,0.08)]";
const SOFT_PANEL_CLASS = "rounded-[24px] border border-[var(--color-line)] bg-white shadow-[0_18px_46px_rgba(44,35,66,0.06)]";
const EXTERNAL_PILL_LINK_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border border-[rgba(61,130,216,0.18)] bg-[rgba(237,243,255,0.72)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#3d82d8] transition hover:border-[rgba(61,130,216,0.34)] hover:bg-[rgba(237,243,255,0.96)]";
const CHART_PRELOAD_DAYS = 60;
const CLUSTER_POSITION_TIMELINE_DAYS = 7;
const COMPARE_ENABLED_STORAGE_KEY = "xway-product-compare-enabled";
const CAMPAIGN_STATUS_SECTION_VIEW_STORAGE_KEY = "xway-campaign-status-section-view";
const PRODUCT_PAGE_CACHE_STORAGE_KEY = "xway-product-page-cache-v1";
const HOURS_SECTION_WINDOWS = [
  { value: "today", label: "сегодня" },
  { value: "yesterday", label: "вчера" },
  { value: "3", label: "3" },
  { value: "7", label: "7" },
  { value: "14", label: "14" },
  { value: "30", label: "30" },
  { value: "60", label: "60" },
] as const;

const Marquee = ((MarqueeImport as unknown as { default?: ElementType }).default ?? MarqueeImport) as ElementType;

type HoursSectionWindowPreset = (typeof HOURS_SECTION_WINDOWS)[number]["value"];

declare global {
  interface Window {
    __xwayProductAppReady?: boolean;
  }
}

function readCachedProductLoaderData() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(PRODUCT_PAGE_CACHE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as ProductLoaderData | null;
    if (!parsed?.payload?.products?.length) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function buildProductSearch(options: {
  article: string;
  start?: string | null;
  end?: string | null;
}) {
  const params = new URLSearchParams();
  params.set("articles", options.article);
  if (options.start) {
    params.set("start", options.start);
  }
  if (options.end) {
    params.set("end", options.end);
  }
  return `?${params.toString()}`;
}

function toIsoDateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveLoaderRange(start?: string | null, end?: string | null) {
  const parsedEnd = end ? new Date(`${end}T00:00:00`) : null;
  const safeEnd = parsedEnd && !Number.isNaN(parsedEnd.getTime()) ? parsedEnd : new Date();
  const endDate = new Date(safeEnd.getFullYear(), safeEnd.getMonth(), safeEnd.getDate());

  const parsedStart = start ? new Date(`${start}T00:00:00`) : null;
  const safeStart =
    parsedStart && !Number.isNaN(parsedStart.getTime())
      ? parsedStart
      : new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - 6);
  const startDate = new Date(safeStart.getFullYear(), safeStart.getMonth(), safeStart.getDate());

  const spanDays = Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  const compareEnd = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() - 1);
  const compareStart = new Date(compareEnd.getFullYear(), compareEnd.getMonth(), compareEnd.getDate() - (spanDays - 1));

  return {
    currentStart: toIsoDateValue(startDate),
    currentEnd: toIsoDateValue(endDate),
    compareStart: toIsoDateValue(compareStart),
    compareEnd: toIsoDateValue(compareEnd),
  };
}

function resolveChartPreloadRange(end?: string | null, days = CHART_PRELOAD_DAYS) {
  const parsedEnd = end ? new Date(`${end}T00:00:00`) : null;
  const safeEnd = parsedEnd && !Number.isNaN(parsedEnd.getTime()) ? parsedEnd : new Date();
  const endDate = new Date(safeEnd.getFullYear(), safeEnd.getMonth(), safeEnd.getDate());
  const startDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - Math.max(days - 1, 0));

  return {
    start: toIsoDateValue(startDate),
    end: toIsoDateValue(endDate),
  };
}

function resolveHoursSectionRange(end?: string | null, preset: HoursSectionWindowPreset = "today") {
  const parsedEnd = end ? new Date(`${end}T00:00:00`) : null;
  const safeEnd = parsedEnd && !Number.isNaN(parsedEnd.getTime()) ? parsedEnd : new Date();
  const endDate = new Date(safeEnd.getFullYear(), safeEnd.getMonth(), safeEnd.getDate());

  if (preset === "yesterday") {
    const yesterday = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - 1);
    const iso = toIsoDateValue(yesterday);
    return { start: iso, end: iso };
  }

  if (preset === "today") {
    const iso = toIsoDateValue(endDate);
    return { start: iso, end: iso };
  }

  const days = Number(preset);
  const startDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - Math.max(days - 1, 0));
  return {
    start: toIsoDateValue(startDate),
    end: toIsoDateValue(endDate),
  };
}

function resolveHoursSectionPreset(spanDays: number | null | undefined): HoursSectionWindowPreset {
  const span = Math.max(1, spanDays ?? 1);
  if (span <= 1) {
    return "today";
  }
  if (span <= 3) {
    return "3";
  }
  if (span <= 7) {
    return "7";
  }
  if (span <= 14) {
    return "14";
  }
  if (span <= 30) {
    return "30";
  }
  return "60";
}

export async function productLoader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const selectedArticleParam = url.searchParams.get("selected");
  const requestedArticles = parseArticlesParam(url.searchParams.get("articles") || selectedArticleParam);
  const trackedArticles = requestedArticles.length ? [requestedArticles[0]!] : [];
  const requestedStart = url.searchParams.get("start");
  const requestedEnd = url.searchParams.get("end");

  if (url.searchParams.has("selected")) {
    const cleanParams = new URLSearchParams(url.searchParams);
    cleanParams.delete("selected");
    if (!cleanParams.get("articles") && trackedArticles[0]) {
      cleanParams.set("articles", trackedArticles[0]);
    }
    const nextSearch = cleanParams.toString();
    return redirect(`${url.pathname}${nextSearch ? `?${nextSearch}` : ""}`);
  }

  const range = resolveLoaderRange(requestedStart, requestedEnd);
  const shouldUseCachedPayload =
    typeof window !== "undefined" &&
    !window.__xwayProductAppReady &&
    window.location.pathname.startsWith("/product");

  if (shouldUseCachedPayload) {
    const cached = readCachedProductLoaderData();
    if (cached) {
      return {
        payload: cached.payload,
        comparePayload: null,
        trackedArticles,
        start: range.currentStart,
        end: range.currentEnd,
        payloadIsCached: true,
      };
    }
  }

  const payload = await fetchProducts({
    request,
    articles: trackedArticles,
    start: range.currentStart,
    end: range.currentEnd,
    campaignMode: "full",
  });

  return {
    payload,
    comparePayload: null,
    trackedArticles,
    start: range.currentStart,
    end: range.currentEnd,
    payloadIsCached: false,
  };
}

function dailyRowsNewestFirst(rows: DailyStat[]) {
  return [...rows].sort((left, right) => right.day.localeCompare(left.day));
}

function formatAnalyticsDayParts(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return {
      weekday: value,
      date: "",
    };
  }

  return {
    weekday: new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(date).replace(".", "").toUpperCase(),
    date: new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(date),
  };
}

function isCampaignActive(status?: string | null) {
  return String(status || "").toLowerCase().includes("актив");
}

function buildCatalogSearch(start?: string | null, end?: string | null) {
  const params = new URLSearchParams();
  if (start) {
    params.set("start", start);
  }
  if (end) {
    params.set("end", end);
  }
  return params.toString() ? `?${params.toString()}` : "";
}

function buildWildberriesProductUrl(article?: string | null) {
  const normalized = String(article || "").trim();
  if (!normalized) {
    return null;
  }
  return `https://www.wildberries.ru/catalog/${normalized}/detail.aspx`;
}

function buildWildberriesSearchUrl(query?: string | null) {
  const normalized = String(query || "").trim();
  if (!normalized) {
    return null;
  }
  return `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(normalized)}`;
}

function mapCampaignSchedule(schedule?: CampaignScheduleConfig): ScheduleAggregate {
  return {
    days: (schedule?.days || []).map((day) => ({
      key: day.key,
      label: day.label,
      hours: (day.hours || []).map((hour) => ({
        hour: hour.hour,
        count: hour.active ? 1 : 0,
        active: hour.active,
      })),
    })),
    max_count: 1,
    active_slots: schedule?.active_slots,
  };
}

function computeRate(numerator: number | string | null | undefined, denominator: number | string | null | undefined) {
  const top = toNumber(numerator);
  const bottom = toNumber(denominator);
  if (top === null || bottom === null || bottom <= 0) {
    return null;
  }
  return (top / bottom) * 100;
}

function computeMoneyPer(numerator: number | string | null | undefined, denominator: number | string | null | undefined) {
  const top = toNumber(numerator);
  const bottom = toNumber(denominator);
  if (top === null || bottom === null || bottom <= 0) {
    return null;
  }
  return top / bottom;
}

function computeCpm(spend: number | string | null | undefined, views: number | string | null | undefined) {
  const cost = toNumber(spend);
  const impressions = toNumber(views);
  if (cost === null || impressions === null || impressions <= 0) {
    return null;
  }
  return (cost / impressions) * 1000;
}

function computeDrr(spend: number | string | null | undefined, revenue: number | string | null | undefined) {
  return computeRate(spend, revenue);
}

function computeDrrAtbs(
  spend: number | string | null | undefined,
  revenueAds: number | string | null | undefined,
  ordersAds: number | string | null | undefined,
  atbs: number | string | null | undefined,
) {
  const averageOrderValue = computeMoneyPer(revenueAds, ordersAds);
  const baskets = toNumber(atbs);
  const cost = toNumber(spend);
  if (averageOrderValue === null || baskets === null || baskets <= 0 || cost === null) {
    return null;
  }
  return (cost / (averageOrderValue * baskets)) * 100;
}

function accumulateClusterOrdersDrrTotals(daily: Record<string, ClusterDailyRow> | null | undefined) {
  let spend = 0;
  let orders = 0;
  let hasOrders = false;

  Object.values(daily || {}).forEach((row) => {
    const rowSpend = toNumber(row.expense);
    const rowOrders = toNumber(row.orders);
    if (rowSpend !== null) {
      spend += rowSpend;
    }
    if (rowOrders !== null && rowOrders > 0) {
      orders += rowOrders;
      hasOrders = true;
    }
  });

  return hasOrders ? { spend, orders } : null;
}

function computeClusterOrdersDrrValue(
  spend: number | string | null | undefined,
  orders: number | string | null | undefined,
  averageCheck: number | string | null | undefined,
) {
  const cost = toNumber(spend);
  const clusterOrders = toNumber(orders);
  const productAverageCheck = toNumber(averageCheck);
  if (cost === null || clusterOrders === null || clusterOrders <= 0 || productAverageCheck === null || productAverageCheck <= 0) {
    return null;
  }
  return computeDrr(cost, productAverageCheck * clusterOrders);
}

function computeClusterOrdersDrr(
  daily: Record<string, ClusterDailyRow> | null | undefined,
  averageCheck: number | string | null | undefined,
) {
  const totals = accumulateClusterOrdersDrrTotals(daily);
  return totals ? computeClusterOrdersDrrValue(totals.spend, totals.orders, averageCheck) : null;
}

function countClusterTrafficPeriodDays(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) {
    return 0;
  }
  const effectiveEnd = end === getTodayIso() ? shiftIsoDateString(end, -1) ?? end : end;
  if (effectiveEnd < start) {
    return 0;
  }
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${effectiveEnd}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return 0;
  }
  return Math.floor((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
}

function formatBoardCount(value: number | string | null | undefined, compact = false) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return "—";
  }
  if ((compact && Math.abs(numeric) >= 1000) || Math.abs(numeric) >= 100_000) {
    return `${formatNumber(numeric / 1000, 1)} тыс`;
  }
  return formatNumber(numeric);
}

function formatBoardPercent(value: number | string | null | undefined) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return "—";
  }
  const digits = Math.abs(numeric) >= 100 || Math.abs(numeric % 1) < 0.05 ? 0 : 1;
  return `${numeric.toFixed(digits)}%`;
}

function formatCompactRubles(value: number | string | null | undefined) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return "—";
  }
  if (Math.abs(numeric) >= 1_000_000) {
    return `${formatNumber(numeric / 1_000_000, 1)} млн ₽`;
  }
  if (Math.abs(numeric) >= 10_000) {
    return `${formatNumber(numeric / 1_000, 1)} тыс ₽`;
  }
  return formatMoney(numeric, Math.abs(numeric % 1) > 0.001);
}

function formatSignedNumber(value: number | string | null | undefined) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }
  if (Math.abs(numeric) >= 100_000) {
    return `${numeric > 0 ? "+" : ""}${formatNumber(numeric / 1000, 1)} тыс`;
  }
  return `${numeric > 0 ? "+" : ""}${formatNumber(numeric, 1)}`;
}

function formatSignedMoney(value: number | string | null | undefined) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }
  return `${numeric > 0 ? "+" : ""}${formatMoney(numeric, true)}`;
}

function formatSignedPercent(value: number | string | null | undefined) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }
  return `${numeric > 0 ? "+" : ""}${formatBoardPercent(numeric)}`;
}

function deltaTone(value: number | string | null | undefined, positiveIsGood = true) {
  const numeric = toNumber(value);
  if (numeric === null || numeric === 0) {
    return "text-[var(--color-muted)]";
  }
  const isGood = positiveIsGood ? numeric > 0 : numeric < 0;
  return isGood ? "text-emerald-600" : "text-rose-500";
}

function diffValue(current: number | string | null | undefined, previous: number | string | null | undefined) {
  const currentValue = toNumber(current);
  const previousValue = toNumber(previous);
  if (currentValue === null) {
    return null;
  }
  return currentValue - (previousValue ?? 0);
}

const STOCKS_RULE_MODE_KEYS = ["type", "condition", "metric", "kind", "rule_type", "mode", "field"] as const;
const STOCKS_RULE_DAYS_KEYS = ["days", "days_gap", "days_left", "days_threshold", "turnover_days", "coverage_days", "days_to_stockout"] as const;
const STOCKS_RULE_STOCK_KEYS = ["stock", "stocks_limit", "stock_threshold", "min_stock", "remain_stock", "quantity", "qty"] as const;
const STOCKS_RULE_GENERIC_VALUE_KEYS = ["threshold", "value"] as const;

function pickStocksRuleNumeric(rule: ProductStocksRule | null | undefined, keys: readonly string[]) {
  if (!rule) {
    return null;
  }
  for (const key of keys) {
    const numeric = toNumber(rule[key] as string | number | null | undefined);
    if (numeric !== null) {
      return numeric;
    }
  }
  return null;
}

function pickStocksRuleText(rule: ProductStocksRule | null | undefined, keys: readonly string[]) {
  if (!rule) {
    return null;
  }
  for (const key of keys) {
    const value = rule[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function formatStocksRuleThreshold(value: number | null) {
  if (value === null) {
    return null;
  }
  return formatNumber(value, Number.isInteger(value) ? 0 : 1);
}

function inferStocksRuleMode(rule: ProductStocksRule | null | undefined) {
  const modeText = pickStocksRuleText(rule, STOCKS_RULE_MODE_KEYS);
  if (!modeText) {
    return null;
  }
  if (/(day|days|turnover|coverage|stockout|predict|дн|дни|дней|оборач|законч)/i.test(modeText)) {
    return "days" as const;
  }
  if (/(stock|limit|qty|quantity|remain|остат|шт)/i.test(modeText)) {
    return "stock" as const;
  }
  return null;
}

function resolveStocksRuleHint(rule: ProductStocksRule | null | undefined) {
  const daysValue = pickStocksRuleNumeric(rule, STOCKS_RULE_DAYS_KEYS);
  if (daysValue !== null) {
    return `Остаток закончится через ${formatStocksRuleThreshold(daysValue)} дн`;
  }

  const stockValue = pickStocksRuleNumeric(rule, STOCKS_RULE_STOCK_KEYS);
  if (stockValue !== null) {
    return `Остаток ≤ ${formatStocksRuleThreshold(stockValue)} шт`;
  }

  const genericThreshold = pickStocksRuleNumeric(rule, STOCKS_RULE_GENERIC_VALUE_KEYS);
  const inferredMode = inferStocksRuleMode(rule);
  if (genericThreshold !== null && inferredMode === "days") {
    return `Остаток закончится через ${formatStocksRuleThreshold(genericThreshold)} дн`;
  }
  if (genericThreshold !== null && inferredMode === "stock") {
    return `Остаток ≤ ${formatStocksRuleThreshold(genericThreshold)} шт`;
  }
  return null;
}

function resolveStocksRuleSummary(product: ProductSummary) {
  const rule = product.operations?.stocks_rule ?? null;
  const isActive = Boolean(rule?.active);
  const hasError = Boolean(rule?.has_error);
  const hint = resolveStocksRuleHint(rule);

  if (hasError) {
    return {
      value: "Ошибка",
      valueClassName: "text-rose-500",
      hint: hint ? `${hint} · ошибка правила` : "Ошибка правила",
      hintClassName: "text-rose-500",
    };
  }

  return {
    value: isActive ? "Включена" : "Выключена",
    valueClassName: isActive ? "text-emerald-600" : "text-[var(--color-muted)]",
    hint: hint ?? (isActive ? "Порог не указан" : null),
    hintClassName: undefined,
  };
}

interface MetricSeriesPoint {
  label: string;
  value: number | null;
  day?: string | null;
}

interface BoardMetricCell {
  label: string;
  value: string;
  delta?: string | null;
  deltaGood?: boolean;
  hint?: ReactNode;
  action?: ReactNode;
  inlineMetrics?: Array<{
    label: string;
    value: string;
    delta?: string | null;
    deltaGood?: boolean;
  }>;
}

interface BoardDrrCell {
  label: string;
  value: number | null;
  delta?: number | null;
  points: MetricSeriesPoint[];
  tone: "basket" | "ads-orders" | "total-orders";
}

const EMPTY_BOARD_CELL: BoardMetricCell = {
  label: "",
  value: "",
};

function buildMetricSeries(product: ProductSummary, metric: (row: DailyStat) => number | null) {
  return product.daily_stats.map((row, index) => ({
    label: row.day_label || `День ${index + 1}`,
    value: metric(row),
  }));
}

function buildBoardMetrics(product: ProductSummary) {
  const totals = product.daily_totals || {};
  const spend = toNumber(totals.expense_sum ?? product.range_metrics.sum);
  const views = toNumber(totals.views ?? product.range_metrics.views);
  const clicks = toNumber(totals.clicks ?? product.range_metrics.clicks);
  const atbs = toNumber(totals.atbs ?? product.range_metrics.atbs);
  const ordersAds = toNumber(totals.orders ?? product.range_metrics.orders);
  const totalOrders = toNumber(totals.ordered_total ?? product.range_metrics.ordered_report);
  const revenueAds = toNumber(totals.sum_price ?? product.range_metrics.sum_price);
  const revenueTotal = toNumber(totals.ordered_sum_total ?? product.range_metrics.ordered_sum_report);
  const extraRevenue = toNumber(totals.rel_sum_price ?? product.range_metrics.rel_sum_price);

  return {
    views,
    clicks,
    atbs,
    ordersAds,
    totalOrders,
    spend,
    revenueAds,
    revenueTotal,
    extraRevenue,
    ctr: toNumber(totals.CTR ?? product.range_metrics.ctr) ?? computeRate(clicks, views),
    cr1: computeRate(atbs, clicks),
    cr2: computeRate(ordersAds, atbs),
    cpm: computeCpm(spend, views),
    cpc: toNumber(totals.CPC ?? product.range_metrics.cpc) ?? computeMoneyPer(spend, clicks),
    cpl: computeMoneyPer(spend, atbs),
    cpo: toNumber(totals.CPO ?? product.range_metrics.cpo) ?? computeMoneyPer(spend, ordersAds),
    cpoOverall: toNumber(totals.CPO_overall ?? product.range_metrics.cpo_overall) ?? computeMoneyPer(spend, totalOrders),
    adsShare: computeRate(ordersAds, totalOrders),
    averageCheck: computeMoneyPer(revenueTotal, totalOrders),
    adsAverageCheck: computeMoneyPer(revenueAds, ordersAds),
    extraOrders: toNumber(totals.rel_shks ?? product.range_metrics.rel_shks),
    extraAtbs: toNumber(totals.rel_atbs ?? product.range_metrics.rel_atbs),
    drrAtbs: computeDrrAtbs(spend, revenueAds, ordersAds, atbs),
    drrOrdersAds: toNumber(totals.DRR) ?? computeDrr(spend, revenueAds),
    drrOrdersTotal: computeDrr(spend, revenueTotal),
    drrAtbsSeries: buildMetricSeries(product, (row) => computeDrrAtbs(row.expense_sum, row.sum_price, row.orders, row.atbs)),
    drrOrdersAdsSeries: buildMetricSeries(product, (row) => computeDrr(row.expense_sum, row.sum_price)),
    drrOrdersTotalSeries: buildMetricSeries(product, (row) => computeDrr(row.expense_sum, row.ordered_sum_total)),
  };
}

function formatDailySeriesLabel(day: string, fallbackIndex: number) {
  const parsed = new Date(`${day}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return `День ${fallbackIndex + 1}`;
  }
  return parsed.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function formatClusterTileDayLabel(day: string | null | undefined, fallbackLabel: string) {
  if (!day) {
    return fallbackLabel.slice(0, 2);
  }
  const parsed = new Date(`${day}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return fallbackLabel.slice(0, 2);
  }
  return parsed.toLocaleDateString("ru-RU", { day: "2-digit" });
}

function formatClusterPositionColumnWeekday(day: string) {
  const parsed = new Date(`${day}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return "ДАТА";
  }
  return parsed
    .toLocaleDateString("ru-RU", { weekday: "short" })
    .replace(".", "")
    .toUpperCase();
}

function ClusterPositionDayColumnHeader({ day }: { day: string }) {
  return (
    <div className="flex min-w-[48px] flex-col items-center text-center leading-none">
      <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">{formatClusterPositionColumnWeekday(day)}</span>
      <strong className="mt-0.5 text-[12px] font-semibold text-[var(--color-ink)]">{formatDailySeriesLabel(day, 0)}</strong>
    </div>
  );
}

function ClusterPositionDayValueCell({
  point,
  comparePoint,
}: {
  point: MetricSeriesPoint | null;
  comparePoint?: MetricSeriesPoint | null;
}) {
  const hasValue = point?.value !== null && point?.value !== undefined;
  if (!hasValue) {
    return <div className="h-[28px] w-[48px] min-w-[48px]" aria-hidden="true" />;
  }
  const currentValue = toNumber(point?.value);
  const compareValue = toNumber(comparePoint?.value);
  const toneClassName =
    currentValue !== null && compareValue !== null
      ? currentValue < compareValue
        ? "border-[rgba(62,157,105,0.24)] bg-[rgba(62,157,105,0.09)]"
        : currentValue > compareValue
          ? "border-[rgba(215,95,95,0.22)] bg-[rgba(215,95,95,0.08)]"
          : "border-[rgba(139,100,246,0.14)] bg-[rgba(139,100,246,0.05)]"
      : "border-[rgba(139,100,246,0.14)] bg-[rgba(139,100,246,0.05)]";
  const title = point?.day
    ? `${formatDailySeriesLabel(point.day, 0)}: ${point.value !== null ? `${formatNumber(Math.round(point.value))} поз.` : "—"}`
    : "Нет данных";

  return (
    <div className="flex justify-center">
      <div
        className={cn(
          "flex h-[28px] w-[48px] min-w-[48px] flex-col items-center justify-center rounded-[9px] border px-0 py-0 text-center transition",
          toneClassName,
        )}
        title={title}
      >
        <strong className="text-[12px] font-semibold leading-none text-[var(--color-ink)]">
          {point?.value !== null ? formatNumber(Math.round(point.value)) : "—"}
        </strong>
      </div>
    </div>
  );
}

function buildCampaignMetricSeries(campaign: CampaignSummary, metric: (row: CampaignDailyExactRow) => number | null) {
  return [...(campaign.daily_exact || [])]
    .sort((left, right) => left.day.localeCompare(right.day))
    .map((row, index) => ({
      label: formatDailySeriesLabel(row.day, index),
      value: metric(row),
    }));
}

function buildCampaignBidSeries(campaign: CampaignSummary) {
  return buildDailyBidRows(campaign).map((row) => ({
    label: row.label,
    value: row.bid,
  }));
}

function buildCampaignSpendSeries(campaign: CampaignSummary) {
  return buildCampaignMetricSeries(campaign, (row) => toNumber(row.expense_sum));
}

function buildCampaignBidChange(campaign: CampaignSummary) {
  return buildBidChangeFromPreviousDay(campaign);
}

function buildMetricSeriesChange(points: MetricSeriesPoint[]) {
  const normalizedValues = points
    .map((point) => toNumber(point.value))
    .filter((value): value is number => value !== null);

  if (normalizedValues.length < 2) {
    return null;
  }

  const previous = normalizedValues.at(-2);
  const current = normalizedValues.at(-1);
  if (previous === undefined || current === undefined) {
    return null;
  }
  const delta = current - previous;
  return {
    delta,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
  } as const;
}

function buildCampaignMetrics(campaign: CampaignSummary) {
  const spend = toNumber(campaign.metrics.sum);
  const views = toNumber(campaign.metrics.views);
  const clicks = toNumber(campaign.metrics.clicks);
  const atbs = toNumber(campaign.metrics.atbs);
  const orders = toNumber(campaign.metrics.orders);
  const revenue = toNumber(campaign.metrics.sum_price);

  return {
    views,
    clicks,
    atbs,
    orders,
    spend,
    revenue,
    ctr: toNumber(campaign.metrics.ctr) ?? computeRate(clicks, views),
    cpm: computeCpm(spend, views),
    cpc: toNumber(campaign.metrics.cpc) ?? computeMoneyPer(spend, clicks),
    cpl: computeMoneyPer(spend, atbs),
    cpo: toNumber(campaign.metrics.cpo) ?? computeMoneyPer(spend, orders),
    cr1: computeRate(atbs, clicks),
    cr2: computeRate(orders, atbs),
    drrAtbs: computeDrrAtbs(spend, revenue, orders, atbs),
    drrOrders: computeDrr(spend, revenue),
    drrAtbsSeries: buildCampaignMetricSeries(campaign, (row) => computeDrrAtbs(row.expense_sum, row.sum_price, row.orders, row.atbs)),
    drrOrdersSeries: buildCampaignMetricSeries(campaign, (row) => computeDrr(row.expense_sum, row.sum_price)),
  };
}

type CampaignZoneMetricKey = "views" | "clicks";
type CampaignZoneKey = "search" | "recom";

const CAMPAIGN_ZONE_RAW_FIELD_CANDIDATES: Record<CampaignZoneKey, Record<CampaignZoneMetricKey, string[]>> = {
  search: {
    views: ["search_views", "views_search", "viewsSearch", "searchViews"],
    clicks: ["search_clicks", "clicks_search", "clicksSearch", "searchClicks"],
  },
  recom: {
    views: [
      "recom_views",
      "views_recom",
      "viewsRecom",
      "recomViews",
      "recommend_views",
      "views_recommendation",
      "recommendation_views",
      "recommendationViews",
      "recommendations_views",
    ],
    clicks: [
      "recom_clicks",
      "clicks_recom",
      "clicksRecom",
      "recomClicks",
      "recommend_clicks",
      "clicks_recommendation",
      "recommendation_clicks",
      "recommendationClicks",
      "recommendations_clicks",
    ],
  },
};

const CAMPAIGN_ZONE_RAW_NESTED_KEYS: Record<CampaignZoneKey, string[]> = {
  search: ["search"],
  recom: ["recom", "recommendation", "recommendations", "recs"],
};

const CAMPAIGN_ZONE_RAW_CONTAINER_KEYS = [
  "stat",
  "stats",
  "metrics",
  "summary",
  "result",
  "report",
  "zones",
] as const;

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCampaignZoneMetricFromContainer(
  container: Record<string, unknown>,
  zone: CampaignZoneKey,
  metric: CampaignZoneMetricKey,
) {
  for (const field of CAMPAIGN_ZONE_RAW_FIELD_CANDIDATES[zone][metric]) {
    const value = toNumber(container[field] as number | string | null | undefined);
    if (value !== null) {
      return value;
    }
  }

  const metricAliases = metric === "views" ? ["views", "shows", "impressions"] : ["clicks"];
  for (const nestedKey of CAMPAIGN_ZONE_RAW_NESTED_KEYS[zone]) {
    const nested = container[nestedKey];
    if (!isRecordLike(nested)) {
      continue;
    }
    for (const alias of metricAliases) {
      const value = toNumber(nested[alias] as number | string | null | undefined);
      if (value !== null) {
        return value;
      }
      const countValue = toNumber(nested[`${alias}_count`] as number | string | null | undefined);
      if (countValue !== null) {
        return countValue;
      }
    }
  }

  return null;
}

function pickCampaignZoneMetricFromApi(
  campaign: CampaignSummary,
  zone: CampaignZoneKey,
  metric: CampaignZoneMetricKey,
) {
  const raw = campaign.raw;
  if (!isRecordLike(raw)) {
    return null;
  }

  const containers: Record<string, unknown>[] = [raw];
  CAMPAIGN_ZONE_RAW_CONTAINER_KEYS.forEach((key) => {
    const candidate = raw[key];
    if (isRecordLike(candidate)) {
      containers.push(candidate);
    }
  });

  for (const container of containers) {
    const value = readCampaignZoneMetricFromContainer(container, zone, metric);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function sumCampaignClusterMetric(campaign: CampaignSummary, metric: CampaignZoneMetricKey) {
  let hasValue = false;
  let total = 0;
  for (const cluster of campaign.clusters.items) {
    const value = toNumber(metric === "views" ? cluster.views : cluster.clicks);
    if (value === null) {
      continue;
    }
    hasValue = true;
    total += value;
  }
  return hasValue ? total : null;
}

function clampMetricShare(value: number, total: number) {
  return Math.min(Math.max(value, 0), total);
}

function buildCampaignZoneShareData(campaign: CampaignSummary, metric: CampaignZoneMetricKey, total: number | null) {
  const totalValue = toNumber(total);
  if (totalValue === null || totalValue <= 0) {
    return null;
  }

  const zones = resolveCampaignZoneBadges(campaign);
  if (!zones.length) {
    return null;
  }

  const hasSearch = zones.some((zone) => zone.key === "search");
  const hasRecom = zones.some((zone) => zone.key === "recom");
  const searchFromApi = hasSearch ? pickCampaignZoneMetricFromApi(campaign, "search", metric) : null;
  const recomFromApi = hasRecom ? pickCampaignZoneMetricFromApi(campaign, "recom", metric) : null;
  const searchFromClusters = hasSearch ? sumCampaignClusterMetric(campaign, metric) : null;

  let searchCount = searchFromApi;
  let recomCount = recomFromApi;

  if (hasSearch && hasRecom) {
    if (searchCount === null && searchFromClusters !== null) {
      searchCount = searchFromClusters;
    }
    if (searchCount !== null) {
      searchCount = clampMetricShare(searchCount, totalValue);
    }
    if (recomCount !== null) {
      recomCount = clampMetricShare(recomCount, totalValue);
    }

    if (searchCount === null && recomCount !== null) {
      searchCount = Math.max(totalValue - recomCount, 0);
    }
    if (recomCount === null && searchCount !== null) {
      recomCount = Math.max(totalValue - searchCount, 0);
    }
    if (searchCount === null && recomCount === null) {
      searchCount = totalValue;
      recomCount = 0;
    }

    const combined = (searchCount ?? 0) + (recomCount ?? 0);
    if (combined > totalValue) {
      if (searchFromApi !== null && recomFromApi === null) {
        recomCount = Math.max(totalValue - (searchCount ?? 0), 0);
      } else if (recomFromApi !== null && searchFromApi === null) {
        searchCount = Math.max(totalValue - (recomCount ?? 0), 0);
      } else {
        const scaledSearch = Math.round(((searchCount ?? 0) / combined) * totalValue);
        searchCount = scaledSearch;
        recomCount = Math.max(totalValue - scaledSearch, 0);
      }
    } else if (combined < totalValue) {
      if (recomCount !== null) {
        recomCount += totalValue - combined;
      } else if (searchCount !== null) {
        searchCount += totalValue - combined;
      }
    }
  } else if (hasSearch) {
    searchCount = clampMetricShare(searchFromApi ?? searchFromClusters ?? totalValue, totalValue);
  } else if (hasRecom) {
    recomCount = clampMetricShare(recomFromApi ?? totalValue, totalValue);
  }

  const items = zones
    .map((zone) => {
      const count = zone.key === "search" ? searchCount : recomCount;
      if (count === null) {
        return null;
      }
      const percent = (count / totalValue) * 100;
      return {
        key: zone.key,
        label: zone.label,
        percent,
      };
    })
    .filter((value): value is { key: CampaignZoneKey; label: string; percent: number } => Boolean(value));

  if (!items.length) {
    return null;
  }

  const normalized = items.map((item) => ({
    ...item,
    percent: item.percent,
    color: item.key === "search" ? "#4f8dff" : "#7b78ff",
  }));

  return {
    total: totalValue,
    items: normalized,
  };
}

function resolveCompareCampaign(campaign: CampaignSummary, compareProduct?: ProductSummary | null) {
  if (!compareProduct) {
    return null;
  }

  const byId = compareProduct.campaigns.find((candidate) => candidate.id === campaign.id);
  if (byId) {
    return byId;
  }

  const byWbId = compareProduct.campaigns.find((candidate) => candidate.wb_id === campaign.wb_id);
  if (byWbId) {
    return byWbId;
  }

  const campaignQuery = String(campaign.query_main || "").trim().toLowerCase();
  const byNameAndQuery = compareProduct.campaigns.find((candidate) => {
    const candidateQuery = String(candidate.query_main || "").trim().toLowerCase();
    return candidate.name === campaign.name && candidateQuery === campaignQuery;
  });
  if (byNameAndQuery) {
    return byNameAndQuery;
  }

  return compareProduct.campaigns.find((candidate) => candidate.name === campaign.name) ?? null;
}

function normalizeSpendLimitPeriod(period?: string | null) {
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

function formatSpendLimitPeriodLabel(period?: string | null) {
  const normalized = normalizeSpendLimitPeriod(period);
  if (normalized === "day") {
    return "день";
  }
  if (normalized === "week") {
    return "неделя";
  }
  if (normalized === "month") {
    return "месяц";
  }
  return "период";
}

function resolveCampaignSpendLimit(campaign: CampaignSummary) {
  const items = campaign.spend_limits?.items || [];
  return (
    items.find((item) => item.active) ||
    items.find((item) => normalizeSpendLimitPeriod(item.period) === "day") ||
    items.find((item) => normalizeSpendLimitPeriod(item.period) === "week") ||
    items.find((item) => normalizeSpendLimitPeriod(item.period) === "month") ||
    items[0] ||
    null
  );
}

function sumSpendLimitValues<T extends { limit?: number | null }>(items: T[]) {
  if (!items.length) {
    return null;
  }
  const numericItems = items
    .map((item) => toNumber(item.limit))
    .filter((value): value is number => value !== null);
  if (!numericItems.length) {
    return null;
  }
  return numericItems.reduce((sum, value) => sum + value, 0);
}

interface ProductSpendInsightChip {
  id: string;
  label: string;
  tone: "limit" | "budget" | "conflict";
  active: boolean;
  campaignId?: number | null;
}

interface ProductSpendCampaignTrack {
  id: string;
  campaignId: number;
  campaign: CampaignSummary;
  label: string;
  meta: string | null;
  current: number;
  limit: number | null;
  forecastHours: number | null;
  forecastLabel: string | null;
  badges: ProductSpendInsightChip[];
}

function formatCampaignLimiterName(campaign: CampaignSummary) {
  return `РК ${campaign.id}`;
}

function formatCampaignSpendTrackLabel(campaign: CampaignSummary) {
  return resolveCampaignBidModeLabel(campaign);
}

function formatCampaignZoneSummary(campaign: CampaignSummary) {
  const zones = resolveCampaignZoneBadges(campaign).map((zone) => zone.label);
  return zones.length ? zones.join(" · ") : null;
}

function buildCampaignAccentPalette(campaignId: number) {
  const hue = (Math.abs(campaignId) * 47) % 360;
  return {
    solid: `hsl(${hue} 68% 48%)`,
    soft: `hsl(${hue} 88% 94% / 0.96)`,
    border: `hsl(${hue} 64% 48% / 0.26)`,
    text: `hsl(${hue} 38% 28%)`,
    track: `hsl(${hue} 74% 84% / 0.56)`,
  };
}

function buildCampaignAccentStyle(campaignId?: number | null): CSSProperties | undefined {
  if (!campaignId) {
    return undefined;
  }
  const palette = buildCampaignAccentPalette(campaignId);
  return {
    ["--campaign-accent" as string]: palette.solid,
    ["--campaign-accent-soft" as string]: palette.soft,
    ["--campaign-accent-border" as string]: palette.border,
    ["--campaign-accent-text" as string]: palette.text,
    ["--campaign-accent-track" as string]: palette.track,
  };
}

function buildCampaignStatusAccentStyle(campaign?: CampaignSummary | null): CSSProperties | undefined {
  if (!campaign) {
    return undefined;
  }

  const statusKey = resolveCampaignDisplayStatus(campaign).key;
  const palette =
    statusKey === "freeze"
      ? {
          solid: "rgba(47, 111, 255, 0.96)",
          soft: "rgba(239, 244, 255, 0.96)",
          border: "rgba(47, 111, 255, 0.26)",
          text: "#3559c7",
          track: "rgba(194, 212, 255, 0.58)",
        }
      : statusKey === "paused"
        ? {
            solid: "rgba(139, 100, 246, 0.96)",
            soft: "rgba(245, 239, 255, 0.96)",
            border: "rgba(139, 100, 246, 0.26)",
            text: "#6d52b4",
            track: "rgba(219, 206, 255, 0.58)",
          }
        : {
            solid: "rgba(52, 168, 102, 0.96)",
            soft: "rgba(236, 250, 242, 0.96)",
            border: "rgba(52, 168, 102, 0.26)",
            text: "#2f7f53",
            track: "rgba(190, 235, 206, 0.58)",
          };

  return {
    ["--campaign-accent" as string]: palette.solid,
    ["--campaign-accent-soft" as string]: palette.soft,
    ["--campaign-accent-border" as string]: palette.border,
    ["--campaign-accent-text" as string]: palette.text,
    ["--campaign-accent-track" as string]: palette.track,
  };
}

function resolveCampaignTrackEffectiveLimit(campaign: CampaignSummary, spendLimits?: CampaignSpendLimitItem[] | null) {
  const candidates = [
    ...(spendLimits || []).map((item) => toNumber(item.limit)),
    campaign.budget_rule_config?.active ? toNumber(campaign.budget_rule_config?.limit) : null,
  ].filter((value): value is number => value !== null && value > 0);

  if (!candidates.length) {
    return null;
  }

  return Math.min(...candidates);
}

function buildCampaignRemainingActivityForecastHours(campaign: CampaignSummary, currentSpend: number, limit: number | null) {
  if (!Number.isFinite(currentSpend) || currentSpend <= 0 || limit === null || limit <= 0) {
    return null;
  }

  const remainingBudget = limit - currentSpend;
  if (remainingBudget <= 0) {
    return 0;
  }

  const rowsByDay = new Map(
    [...(campaign.daily_exact || [])]
      .filter((row) => String(row.day || "").trim())
      .map((row) => [row.day, toNumber(row.expense_sum) ?? 0] as const),
  );
  const today = new Date();
  const yesterdayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const dayBeforeYesterdayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2);
  const yesterdaySpend = rowsByDay.get(toIsoDateValue(yesterdayDate)) ?? 0;
  const dayBeforeYesterdaySpend = rowsByDay.get(toIsoDateValue(dayBeforeYesterdayDate)) ?? 0;

  const averageDailySpend =
    yesterdaySpend > 0 && dayBeforeYesterdaySpend > 0
      ? (yesterdaySpend + dayBeforeYesterdaySpend) / 2
      : yesterdaySpend > 0
        ? yesterdaySpend
        : null;

  if (!Number.isFinite(averageDailySpend) || averageDailySpend === null || averageDailySpend <= 0) {
    return null;
  }

  const remainingHoursRaw = (remainingBudget / averageDailySpend) * 24;
  if (!Number.isFinite(remainingHoursRaw) || remainingHoursRaw <= 0) {
    return 0;
  }

  return Math.max(1, Math.round(remainingHoursRaw));
}

function resolveOverviewHeatmapMinHeight(dayCount: number | null | undefined) {
  const safeDayCount = Number(dayCount);
  if (!Number.isFinite(safeDayCount) || safeDayCount <= 0) {
    return 0;
  }

  const headerHeight = 18;
  const rowHeight = 12;
  const rowGap = 4;
  const boxChromeHeight = 26;
  return headerHeight + safeDayCount * rowHeight + Math.max(safeDayCount - 1, 0) * rowGap + boxChromeHeight;
}

function formatCampaignRemainingActivityForecast(hours: number | null) {
  if (hours === null) {
    return null;
  }
  if (hours <= 0) {
    return "лимит исчерпан";
  }
  return `≈ ${formatNumber(hours)} ч`;
}

function formatIssueCampaignCount(value: number) {
  const abs = Math.abs(value);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${value} кампания`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${value} кампании`;
  }
  return `${value} кампаний`;
}

function formatIssueStopCountLabel(value: number) {
  const abs = Math.abs(value);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${value} остановка`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${value} остановки`;
  }
  return `${value} остановок`;
}

function formatBudgetRuleChipValue(rule?: BudgetRuleConfig | null) {
  const limit = toNumber(rule?.limit);
  const threshold = toNumber(rule?.threshold);
  const deposit = toNumber(rule?.deposit);
  if (limit !== null) {
    return formatMoney(limit, true);
  }
  if (deposit !== null && threshold !== null) {
    return `${formatMoney(deposit, true)} / ${formatMoney(threshold, true)}`;
  }
  if (deposit !== null) {
    return `автопоп. ${formatMoney(deposit, true)}`;
  }
  if (threshold !== null) {
    return `порог ${formatMoney(threshold, true)}`;
  }
  return "включён";
}

function buildProductDailySpendSummary(product: ProductSummary) {
  const campaignDaySpend = product.campaigns.reduce((sum, campaign) => sum + (toNumber(campaign.spend?.DAY) ?? 0), 0);
  const current = campaignDaySpend > 0 ? campaignDaySpend : toNumber(product.range_metrics.spend_day);
  const allDayLimits = (product.range_metrics.spend_limits || []).filter((item) => normalizeSpendLimitPeriod(item.limit_period) === "day");
  const activeDayLimits = allDayLimits.filter((item) => item.active);
  const activeCampaignSpendLimits = product.campaigns.flatMap((campaign) =>
    (campaign.spend_limits?.items || [])
      .filter((item) => item.active)
      .map((item, index) => ({ campaign, item, index })),
  );
  const total = sumSpendLimitValues(activeDayLimits) ?? sumSpendLimitValues(allDayLimits);
  const activeBudgetRules = product.campaigns
    .map((campaign) => ({ campaign, rule: campaign.budget_rule_config ?? null }))
    .filter(({ rule }) => Boolean(rule?.active));
  const activeRules: ProductSpendInsightChip[] = [
    ...activeDayLimits.map((item, index) => ({
      id: `product-day-limit-${index}`,
      label: `лимит дня ${formatMoney(item.limit, true)}`,
      tone: "limit" as const,
      active: true,
      campaignId: null,
    })),
  ];
  const conflicts: ProductSpendInsightChip[] = [];

  if (activeDayLimits.length > 0) {
    product.campaigns.forEach((campaign) => {
      const activeSpendItems = (campaign.spend_limits?.items || []).filter((item) => item.active);
      if (!activeSpendItems.length) {
        return;
      }
      const periods = activeSpendItems
        .map((item) => formatSpendLimitPeriodLabel(item.period))
        .filter((period, index, items) => items.indexOf(period) === index);
      conflicts.push({
        id: `campaign-limit-overlap-${campaign.id}`,
        label: `${formatCampaignLimiterName(campaign)} · общий лимит дня пересекается с лимитом РК${periods.length ? ` (${periods.join(" / ")})` : ""}`,
        tone: "conflict",
        active: true,
        campaignId: campaign.id,
      });
    });
  }

  const hasAnyActiveRule = activeRules.length > 0;
  const hasActiveDayLimiter = activeDayLimits.length > 0;
  const hasConfiguredDayLimiter = allDayLimits.length > 0;
  const campaignTracks: ProductSpendCampaignTrack[] = product.campaigns
    .reduce<ProductSpendCampaignTrack[]>((items, campaign) => {
      const currentSpend = toNumber(campaign.spend?.DAY) ?? 0;
      const displayStatus = resolveCampaignDisplayStatus(campaign);
      const configuredSpendLimit = resolveCampaignSpendLimit(campaign);
      const activeSpendItems = (campaign.spend_limits?.items || []).filter((item) => item.active);
      const activeBudgetRule = Boolean(campaign.budget_rule_config?.active);
      const hasActiveSpendLimit = activeSpendItems.length > 0;
      const hasLimiterConfig = Boolean(configuredSpendLimit || campaign.budget_rule_config);
      const effectiveLimit = resolveCampaignTrackEffectiveLimit(campaign, activeSpendItems);
      const forecastHours = buildCampaignRemainingActivityForecastHours(campaign, currentSpend, effectiveLimit);
      const badges: ProductSpendInsightChip[] = [
        {
          id: `campaign-track-limit-${campaign.id}`,
          label: `лимит${configuredSpendLimit?.limit != null ? ` ${formatMoney(configuredSpendLimit.limit, true)}` : ""}`,
          tone: "limit" as const,
          active: hasActiveSpendLimit,
          campaignId: campaign.id,
        },
        {
          id: `campaign-track-budget-${campaign.id}`,
          label: `бюджет${campaign.budget_rule_config ? ` ${formatBudgetRuleChipValue(campaign.budget_rule_config)}` : ""}`,
          tone: "budget" as const,
          active: activeBudgetRule,
          campaignId: campaign.id,
        },
      ];
      if (currentSpend <= 0 && !hasLimiterConfig) {
        return items;
      }
      items.push({
        id: `campaign-track-${campaign.id}`,
        campaignId: campaign.id,
        campaign,
        label: formatCampaignSpendTrackLabel(campaign),
        meta: formatCampaignZoneSummary(campaign),
        current: currentSpend,
        limit: effectiveLimit,
        forecastHours,
        forecastLabel: displayStatus.key === "freeze" ? null : formatCampaignRemainingActivityForecast(forecastHours),
        badges,
      });
      return items;
    }, [])
    .sort((left, right) => right.current - left.current);

  return {
    current,
    total,
    enabled: hasActiveDayLimiter,
    statusText: hasActiveDayLimiter
      ? "лимит дня включён"
      : hasConfiguredDayLimiter
        ? "лимит дня выключен"
        : "лимит дня не задан",
    activeRules,
    campaignTracks,
    conflicts,
  };
}

type ProductDailySpendSummary = ReturnType<typeof buildProductDailySpendSummary>;

interface ProductOverviewErrorSummary {
  id: string;
  kind: "budget" | "limit" | "conflict" | "schedule" | "paused";
  title: string;
  value: string;
  meta: string;
  note: string | null;
  recommendation: string;
  days: CampaignIssueBreakdownDay[];
}

interface ProductOverviewYesterdayIssue {
  id: string;
  kind: ProductOverviewErrorSummary["kind"];
  title: string;
  value: string;
  meta: string;
  note: string | null;
  recommendation: string;
  day: CampaignIssueBreakdownDay;
}

type ProductOverviewDowntimeKind = "schedule" | "paused";

function parseStatusClockToMinutes(value: string | null | undefined, endOfDay = false) {
  if (!value) {
    return endOfDay ? 24 * 60 : 0;
  }
  const [hours = "0", minutes = "0"] = String(value).split(":");
  const total = Number(hours) * 60 + Number(minutes);
  return Number.isFinite(total) ? total : endOfDay ? 24 * 60 : 0;
}

function resolveStatusEntryDurationHours(entry: Pick<CampaignOverviewStatusEntry, "startTime" | "endTime">) {
  const startMinutes = parseStatusClockToMinutes(entry.startTime);
  const endMinutes = parseStatusClockToMinutes(entry.endTime, true);
  return Math.max(endMinutes - startMinutes, 0) / 60;
}

function resolveProductOverviewDowntimeTitle(kind: ProductOverviewDowntimeKind) {
  if (kind === "schedule") {
    return "Пауза по расписанию";
  }
  return "Приостановлена";
}

function shiftIsoDateString(value: string | null | undefined, deltaDays: number) {
  if (!value) {
    return null;
  }
  const parts = value.split("-");
  if (parts.length !== 3) {
    return null;
  }
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function resolveOverviewIssueRecommendation(kind: ProductOverviewErrorSummary["kind"]) {
  if (kind === "budget") {
    return "Проверьте бюджет РК: увеличьте его или перераспределите трафик на более эффективные часы и кампании.";
  }
  if (kind === "limit") {
    return "Проверьте тепловую карту и уменьшите ставку РК или ставку кластера, если лимита не хватает до конца дня.";
  }
  if (kind === "schedule") {
    return "Проверьте расписание показов и расширьте активные часы, если спрос смещён в недоступные интервалы.";
  }
  if (kind === "paused") {
    return "Проверьте ручные остановки и правило автостопа по остатку или оборачиваемости.";
  }
  return "Согласуйте общий лимит дня и лимиты отдельных РК, чтобы они не конфликтовали между собой.";
}

const OVERVIEW_ISSUE_STATUS_VARIANT_PRIORITY = [
  "paused-mixed",
  "paused-limit",
  "paused-budget",
  "paused-schedule",
  "paused",
  "freeze",
  "active",
  "unknown",
] as const;

type OverviewIssueDayAccumulator = {
  day: string;
  label: string;
  hours: number;
  incidents: number;
  estimatedGapTotal: number;
  hasEstimatedGap: boolean;
  campaignNames: Set<string>;
  slotCounts: Array<Map<string, number>>;
};

function createOverviewIssueSlotCounts() {
  return Array.from({ length: 24 }, () => new Map<string, number>());
}

function accumulateOverviewIssueSlotCounts(
  slotCounts: Array<Map<string, number>>,
  statusDay?: CampaignOverviewStatusDay | null,
) {
  buildCampaignStatusHourSlots(statusDay).forEach((slot) => {
    const bucket = slotCounts[slot.hour];
    if (!bucket) {
      return;
    }
    bucket.set(slot.variant, (bucket.get(slot.variant) || 0) + 1);
  });
}

function resolveOverviewIssueStatusTitle(variant: string) {
  if (variant === "active") {
    return "Активна";
  }
  if (variant === "freeze") {
    return "Заморожена";
  }
  if (variant === "paused-schedule") {
    return "Пауза: расписание показов";
  }
  if (variant === "paused-limit") {
    return "Пауза: лимит расходов";
  }
  if (variant === "paused-budget") {
    return "Пауза: исчерпан бюджет";
  }
  if (variant === "paused-mixed") {
    return "Пауза: смешанная причина";
  }
  if (variant === "paused") {
    return "Приостановлена";
  }
  return "Нет данных";
}

function collapseOverviewIssueSlotCounts(slotCounts: Array<Map<string, number>>) {
  return slotCounts.map((bucket, hour) => {
    const variant =
      OVERVIEW_ISSUE_STATUS_VARIANT_PRIORITY.reduce<(typeof OVERVIEW_ISSUE_STATUS_VARIANT_PRIORITY)[number]>(
        (best, current) => {
          const bestCount = bucket.get(best) || 0;
          const currentCount = bucket.get(current) || 0;
          if (currentCount > bestCount) {
            return current;
          }
          return best;
        },
        "unknown",
      );
    return {
      hour,
      variant,
      title: `${String(hour).padStart(2, "0")}:00 · ${resolveOverviewIssueStatusTitle(variant)}`,
    };
  });
}

function formatOverviewIssueCampaignPreview(campaignNames: Iterable<string>) {
  const items = [...campaignNames];
  if (!items.length) {
    return null;
  }
  if (items.length > 2) {
    return `${items.slice(0, 2).join(" · ")} · +${items.length - 2}`;
  }
  return items.join(" · ");
}

function buildOverviewIssueBreakdownDay(day: OverviewIssueDayAccumulator): CampaignIssueBreakdownDay {
  const campaignPreview = formatOverviewIssueCampaignPreview(day.campaignNames);
  return {
    day: day.day,
    label: day.label,
    hours: day.hours,
    incidents: day.incidents,
    estimatedGap: day.hasEstimatedGap ? day.estimatedGapTotal : null,
    note: campaignPreview ? `${formatIssueCampaignCount(day.campaignNames.size)} · ${campaignPreview}` : null,
    statusSlots: collapseOverviewIssueSlotCounts(day.slotCounts),
  };
}

function buildProductOverviewErrorSummaries(
  product: ProductSummary,
  dailySpendSummary: ProductDailySpendSummary,
  window: OverviewWindow,
): ProductOverviewErrorSummary[] {
  const activeRange = resolveChartPreloadRange(product.period.current_end, window);
  const aggregated = new Map<
    CampaignIssueSummary["kind"],
    {
      kind: CampaignIssueSummary["kind"];
      title: string;
      hours: number;
      incidents: number;
      estimatedGapTotal: number | null;
      campaignNames: Set<string>;
      days: Map<string, OverviewIssueDayAccumulator>;
    }
  >();
  const downtimeAggregated = new Map<
    ProductOverviewDowntimeKind,
    {
      kind: ProductOverviewDowntimeKind;
      title: string;
      hours: number;
      incidents: number;
      campaignNames: Set<string>;
      days: Map<string, OverviewIssueDayAccumulator>;
    }
  >();

  product.campaigns.forEach((campaign) => {
    const statusDays = buildCampaignStatusDays(campaign, activeRange.start, activeRange.end).filter(
      (day) => day.day >= activeRange.start && day.day <= activeRange.end,
    );
    const statusDayByDay = new Map(statusDays.map((day) => [day.day, day]));
    buildCampaignIssueSummaries(campaign, statusDays).forEach((summary) => {
      const current = aggregated.get(summary.kind) || {
        kind: summary.kind,
        title: summary.label,
        hours: 0,
        incidents: 0,
        estimatedGapTotal: null,
        campaignNames: new Set<string>(),
        days: new Map<string, OverviewIssueDayAccumulator>(),
      };
      current.hours += summary.hours;
      current.incidents += summary.incidents;
      if (summary.estimatedGapTotal !== null) {
        current.estimatedGapTotal = (current.estimatedGapTotal ?? 0) + summary.estimatedGapTotal;
      }
      const campaignLabel = formatCampaignLimiterName(campaign);
      current.campaignNames.add(campaignLabel);
      summary.days.forEach((dayEntry) => {
        const aggregatedDay =
          current.days.get(dayEntry.day) ||
          (() => {
            const nextDay: OverviewIssueDayAccumulator = {
              day: dayEntry.day,
              label: dayEntry.label,
              hours: 0,
              incidents: 0,
              estimatedGapTotal: 0,
              hasEstimatedGap: false,
              campaignNames: new Set<string>(),
              slotCounts: createOverviewIssueSlotCounts(),
            };
            current.days.set(dayEntry.day, nextDay);
            return nextDay;
          })();
        const hadCampaignAlready = aggregatedDay.campaignNames.has(campaignLabel);
        aggregatedDay.hours += dayEntry.hours;
        aggregatedDay.incidents += dayEntry.incidents;
        if (dayEntry.estimatedGap !== null) {
          aggregatedDay.estimatedGapTotal += dayEntry.estimatedGap;
          aggregatedDay.hasEstimatedGap = true;
        }
        aggregatedDay.campaignNames.add(campaignLabel);
        if (!hadCampaignAlready) {
          accumulateOverviewIssueSlotCounts(aggregatedDay.slotCounts, statusDayByDay.get(dayEntry.day));
        }
      });
      aggregated.set(summary.kind, current);
    });
    statusDays.forEach((day) => {
      const dayKindsCounted = new Set<ProductOverviewDowntimeKind>();
      day.entries.forEach((entry) => {
        const durationHours = resolveStatusEntryDurationHours(entry);
        if (durationHours <= 0) {
          return;
        }

        let downtimeKind: ProductOverviewDowntimeKind | null = null;
        if (entry.key === "paused") {
          const hasScheduleReason = Boolean(entry.reasonKinds?.includes("schedule"));
          if (entry.issueKinds?.length && !hasScheduleReason) {
            return;
          }
          downtimeKind = hasScheduleReason ? "schedule" : "paused";
        }

        if (!downtimeKind) {
          return;
        }

        const current = downtimeAggregated.get(downtimeKind) || {
          kind: downtimeKind,
          title: resolveProductOverviewDowntimeTitle(downtimeKind),
          hours: 0,
          incidents: 0,
          campaignNames: new Set<string>(),
          days: new Map<string, OverviewIssueDayAccumulator>(),
        };
        current.hours += durationHours;
        current.incidents += 1;
        const campaignLabel = formatCampaignLimiterName(campaign);
        current.campaignNames.add(campaignLabel);
        const aggregatedDay =
          current.days.get(day.day) ||
          (() => {
            const nextDay: OverviewIssueDayAccumulator = {
              day: day.day,
              label: day.label,
              hours: 0,
              incidents: 0,
              estimatedGapTotal: 0,
              hasEstimatedGap: false,
              campaignNames: new Set<string>(),
              slotCounts: createOverviewIssueSlotCounts(),
            };
            current.days.set(day.day, nextDay);
            return nextDay;
          })();
        aggregatedDay.hours += durationHours;
        aggregatedDay.incidents += 1;
        aggregatedDay.campaignNames.add(campaignLabel);
        if (!dayKindsCounted.has(downtimeKind)) {
          accumulateOverviewIssueSlotCounts(aggregatedDay.slotCounts, day);
          dayKindsCounted.add(downtimeKind);
        }
        downtimeAggregated.set(downtimeKind, current);
      });
    });
  });

  const issueItems: ProductOverviewErrorSummary[] = (["budget", "limit"] as const)
    .map((kind) => aggregated.get(kind))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => {
      const campaignNames = [...item.campaignNames];
      const campaignPreview =
        campaignNames.length > 2
          ? `${campaignNames.slice(0, 2).join(" · ")} · +${campaignNames.length - 2}`
          : campaignNames.join(" · ");
      return {
        id: `overview-error-${item.kind}`,
        kind: item.kind,
        title: item.title,
        value: `${formatNumber(item.hours, 1)} ч`,
        meta: `${formatIssueCampaignCount(item.campaignNames.size)} · ${formatIssueStopCountLabel(item.incidents)}`,
        note:
          item.estimatedGapTotal !== null
            ? `≈ не хватило ${formatMoney(Math.round(item.estimatedGapTotal), true)}${campaignPreview ? ` · ${campaignPreview}` : ""}`
            : campaignPreview || null,
        recommendation: resolveOverviewIssueRecommendation(item.kind),
        days: [...item.days.values()]
          .sort((left, right) => right.day.localeCompare(left.day))
          .map(buildOverviewIssueBreakdownDay),
      };
    });
  const downtimeItems: ProductOverviewErrorSummary[] = (["schedule", "paused"] as const)
    .map((kind) => downtimeAggregated.get(kind))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => {
      const campaignNames = [...item.campaignNames];
      const campaignPreview =
        campaignNames.length > 2
          ? `${campaignNames.slice(0, 2).join(" · ")} · +${campaignNames.length - 2}`
          : campaignNames.join(" · ");
      return {
        id: `overview-error-${item.kind}`,
        kind: item.kind,
        title: item.title,
        value: `${formatNumber(item.hours, 1)} ч`,
        meta: `${formatIssueCampaignCount(item.campaignNames.size)} · ${formatIssueStopCountLabel(item.incidents)}`,
        note: campaignPreview || null,
        recommendation: resolveOverviewIssueRecommendation(item.kind),
        days: [...item.days.values()]
          .sort((left, right) => right.day.localeCompare(left.day))
          .map(buildOverviewIssueBreakdownDay),
      };
    });

  if (dailySpendSummary.conflicts.length) {
    const conflictPreview =
      dailySpendSummary.conflicts.length > 2
        ? `${dailySpendSummary.conflicts.slice(0, 2).map((item) => item.label).join(" · ")} · +${dailySpendSummary.conflicts.length - 2}`
        : dailySpendSummary.conflicts.map((item) => item.label).join(" · ");
    issueItems.unshift({
      id: "overview-error-conflicts",
      kind: "conflict",
      title: "Конфликт лимитов",
      value: formatNumber(dailySpendSummary.conflicts.length),
      meta: "общий лимит дня конфликтует с лимитами РК",
      note: conflictPreview || null,
      recommendation: resolveOverviewIssueRecommendation("conflict"),
      days: [],
    });
  }

  return [...issueItems, ...downtimeItems];
}

function resolveUsageTone(percent: number | null | undefined) {
  const numeric = toNumber(percent);
  if (numeric === null) {
    return "tone-neutral";
  }
  if (numeric >= 90) {
    return "tone-risk";
  }
  if (numeric >= 70) {
    return "tone-warn";
  }
  return "tone-good";
}

function resolveCampaignStatusOutline(status?: string | null) {
  const normalized = String(status || "").toLowerCase();
  if (normalized.includes("зам") || normalized.includes("freeze")) {
    return "status-outline-freeze";
  }
  if (normalized.includes("пауз") || normalized.includes("pause")) {
    return "status-outline-paused";
  }
  if (normalized.includes("актив") || normalized.includes("active")) {
    return "status-outline-active";
  }
  return "";
}

function resolveCampaignModeLabel(campaign: CampaignSummary) {
  if (campaign.auction_mode) {
    return campaign.auction_mode;
  }
  return null;
}

function resolveCampaignBidModeLabel(campaign: Pick<CampaignSummary, "unified">) {
  return campaign.unified ? "Единая ставка" : "Ручная ставка";
}

function resolveCampaignVisibilityPillLabel(campaign: CampaignSummary) {
  const bidKind = resolveBidKind({
    payment_type: campaign.payment_type ?? null,
    auction_mode: campaign.auction_mode ?? null,
    auto_type: campaign.auto_type ?? null,
    name: campaign.name ?? "",
  });
  const bidLabel = bidKind === "cpc" ? "CPC" : "CPM";
  const zones = resolveCampaignZoneBadges(campaign);
  const zoneLabel =
    zones.length >= 2 ? "П+Р" : zones[0]?.label === "Рекомендации" ? "Реком." : zones[0]?.label === "Поиск" ? "Поиск" : null;

  const parts = [bidLabel];
  if (bidKind !== "cpc") {
    parts.push(campaign.unified ? "Единая" : "Ручная");
  }
  if (zoneLabel) {
    parts.push(zoneLabel);
  }
  return parts.join(" · ");
}

function resolveCampaignVisibilityPillMainLabel(campaign: CampaignSummary) {
  const bidKind = resolveBidKind({
    payment_type: campaign.payment_type ?? null,
    auction_mode: campaign.auction_mode ?? null,
    auto_type: campaign.auto_type ?? null,
    name: campaign.name ?? "",
  });
  const bidLabel = bidKind === "cpc" ? "CPC" : "CPM";
  const parts = [bidLabel];
  if (bidKind !== "cpc") {
    parts.push(campaign.unified ? "Единая" : "Ручная");
  }
  return parts.join(" · ");
}

function resolveCampaignBidLabel(campaign?: Pick<CampaignSummary, "payment_type" | "auction_mode" | "auto_type" | "name"> | null) {
  return resolveBidLabel({
    payment_type: campaign?.payment_type ?? null,
    auction_mode: campaign?.auction_mode ?? null,
    auto_type: campaign?.auto_type ?? null,
    name: campaign?.name ?? "",
  });
}

function resolveCampaignBidPlacement(campaign?: Pick<CampaignSummary, "payment_type" | "auction_mode" | "auto_type" | "name"> | null) {
  return resolveBidKind({
    payment_type: campaign?.payment_type ?? null,
    auction_mode: campaign?.auction_mode ?? null,
    auto_type: campaign?.auto_type ?? null,
    name: campaign?.name ?? "",
  }) === "cpc"
    ? "clicks"
    : "views";
}

function resolveCampaignZoneBadges(
  campaign?: Pick<
    CampaignSummary,
    "name" | "auction_mode" | "auto_type" | "payment_type" | "unified" | "min_cpm" | "mp_bid" | "min_cpm_recom" | "mp_recom_bid"
  > | null,
) {
  const auctionMode = String(campaign?.auction_mode || "").trim().toLowerCase();
  const autoType = String(campaign?.auto_type || "").trim().toLowerCase();
  const name = String(campaign?.name || "").trim().toLowerCase();
  const paymentType = String(campaign?.payment_type || "").trim().toLowerCase();
  const searchSignal = toNumber(campaign?.min_cpm) !== null || toNumber(campaign?.mp_bid) !== null;
  const recomSignal = toNumber(campaign?.min_cpm_recom) !== null || toNumber(campaign?.mp_recom_bid) !== null;
  const source = [auctionMode, autoType, name].filter(Boolean).join(" ");

  let hasSearch = false;
  let hasRecom = false;

  if (campaign?.unified) {
    hasSearch = true;
    hasRecom = true;
  } else if (/search[_\s-]*recom|recom[_\s-]*search|searchrecom|поиск.*реком|реком.*поиск/.test(auctionMode)) {
    hasSearch = true;
    hasRecom = true;
  } else if (/recom|recommend|реком/.test(auctionMode)) {
    hasRecom = true;
  } else if (/search|поиск/.test(auctionMode)) {
    hasSearch = true;
  } else if (paymentType.includes("cpc") || paymentType.includes("click") || paymentType.includes("клик")) {
    hasSearch = true;
  } else {
    hasSearch = searchSignal || /search|поиск/.test(source);
    hasRecom = recomSignal || /recom|recommend|реком/.test(source);
  }

  const zones: Array<{ key: "search" | "recom"; label: string; icon: typeof Search }> = [];

  if (hasSearch || (!hasSearch && !hasRecom)) {
    zones.push({ key: "search", label: "Поиск", icon: Search });
  }
  if (hasRecom) {
    zones.push({ key: "recom", label: "Рекомендации", icon: ThumbsUp });
  }

  return zones;
}

type CampaignStatusStateKey = "active" | "paused" | "freeze" | "unknown";
type CampaignIssueKind = "budget" | "limit";
type CampaignPauseReasonKind = "schedule" | "budget" | "limit";

interface StatusDateTimeParts {
  date: string;
  time: string;
}

interface StatusTimelineItem extends CampaignPauseHistoryEntry {
  sourceKey: string;
  statusKey: CampaignStatusStateKey;
  statusLabel: string;
  reasons: string[];
  displayStart?: string;
  displayEnd?: string | null;
  dayKey: string;
  tierIndex: number;
  tierCount: number;
}

interface CampaignDayStatusEntry {
  key: CampaignStatusStateKey;
  label: string;
  startTime: string;
  endTime: string | null;
  originalStart?: string | null;
  originalEnd?: string | null;
  actorLabel?: string | null;
  reasons: string[];
  reasonKinds: CampaignPauseReasonKind[];
  issueKinds: CampaignIssueKind[];
}

interface StatusTimelineDay {
  dayKey: string;
  dayLabel: string;
  items: StatusTimelineItem[];
}

function compactIsoDayLabel(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) {
    return "—";
  }
  const parsed = new Date(`${text}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return compactStatusDayLabel(text);
  }
  return `${String(parsed.getDate()).padStart(2, "0")}.${String(parsed.getMonth() + 1).padStart(2, "0")}`;
}

function formatStatusTimelineDayRangeLabel(startKey?: string | null, endKey?: string | null) {
  const startLabel = compactIsoDayLabel(startKey);
  const endLabel = compactIsoDayLabel(endKey ?? startKey);
  if (!startLabel || startLabel === "—" || startLabel === endLabel) {
    return startLabel;
  }
  return `${startLabel} - ${endLabel}`;
}

function formatStatusTransitionCountLabel(count: number) {
  if (count === 1) {
    return "1 переход";
  }
  if (count > 1 && count < 5) {
    return `${formatNumber(count)} перехода`;
  }
  return `${formatNumber(count)} переходов`;
}

function splitStatusDateTime(value?: string | null): StatusDateTimeParts {
  const text = String(value || "").trim();
  if (!text) {
    return { date: "—", time: "" };
  }
  const parts = text.split(",");
  if (parts.length >= 2) {
    const [datePart = "—", ...timeParts] = parts;
    return {
      date: datePart.trim() || "—",
      time: timeParts.join(",").trim(),
    };
  }
  const match = text.match(/^(.*?)(\d{1,2}:\d{2})$/);
  if (match) {
    return {
      date: (match[1] ?? "").trim() || "—",
      time: (match[2] ?? "").trim(),
    };
  }
  return { date: text, time: "" };
}

function parseRuDateLabel(value?: string | null) {
  const match = String(value || "").trim().match(/^(\d{1,2})[.-](\d{1,2})[.-](\d{4})$/);
  if (!match) {
    return null;
  }
  const [, day, month, year] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function parseFlexibleStatusDay(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  const explicitRuDate = parseRuDateLabel(text.split(",")[0]?.trim());
  if (explicitRuDate) {
    return explicitRuDate;
  }
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function parseStatusDateTimeValue(
  value?: string | null,
  options: {
    fallbackDate?: Date | null;
    fallbackYear?: number | null;
  } = {},
) {
  const parts = splitStatusDateTime(value);
  const fallbackDate = options.fallbackDate instanceof Date && !Number.isNaN(options.fallbackDate.getTime()) ? new Date(options.fallbackDate) : null;
  const explicitDate = parseRuDateLabel(parts.date);
  const baseDate =
    explicitDate ||
    fallbackDate ||
    (Number.isFinite(options.fallbackYear) ? new Date(Number(options.fallbackYear), 0, 1) : null);
  if (!baseDate) {
    return null;
  }
  const parsed = new Date(baseDate);
  if (parts.time) {
    const [hours = 0, minutes = 0] = parts.time.split(":").map((item) => Number(item));
    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
      parsed.setHours(hours, minutes, 0, 0);
    }
  } else {
    parsed.setHours(0, 0, 0, 0);
  }
  return parsed;
}

function parseCampaignIntervalEnd(item: Pick<CampaignPauseHistoryEntry, "end">, startAt: Date) {
  const rawEnd = String(item.end || "").trim();
  if (!rawEnd) {
    return new Date();
  }
  const parsed = parseStatusDateTimeValue(rawEnd, {
    fallbackDate: startAt,
    fallbackYear: startAt.getFullYear(),
  });
  if (!parsed) {
    return new Date(startAt);
  }
  const endAt = new Date(parsed);
  const endDateLabel = splitStatusDateTime(rawEnd).date;
  const hasDatePart = Boolean(parseRuDateLabel(endDateLabel));
  if (!hasDatePart && endAt <= startAt) {
    endAt.setDate(endAt.getDate() + 1);
  }
  return endAt;
}

function formatStatusDateTimeForUi(value: Date, startAt?: Date | null) {
  if (startAt && value.toDateString() === startAt.toDateString()) {
    return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  }
  return `${String(value.getDate()).padStart(2, "0")}.${String(value.getMonth() + 1).padStart(2, "0")}.${value.getFullYear()}, ${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function mergeStatusNameField(...values: Array<string | null | undefined>) {
  const parts: string[] = [];
  values.forEach((value) => {
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => {
        if (!parts.includes(item)) {
          parts.push(item);
        }
      });
  });
  return parts.join(", ");
}

function resolveCampaignStatusHistoryStart(campaign: CampaignSummary) {
  const candidates: Date[] = [];

  [campaign.wb_created, campaign.created].forEach((value) => {
    const parsed = parseFlexibleStatusDay(value);
    if (parsed) {
      candidates.push(parsed);
    }
  });

  (campaign.daily_exact || []).forEach((row) => {
    const parsed = parseFlexibleStatusDay(row.day);
    if (parsed) {
      candidates.push(parsed);
    }
  });

  campaignMergedPauseHistoryIntervals(campaign).forEach((item) => {
    const parsed = parseStatusDateTimeValue(item.start);
    if (parsed) {
      candidates.push(new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
    }
  });

  (campaign.status_logs?.mp_history || []).forEach((item) => {
    const parsed =
      parseFlexibleStatusDay(item.timestamp_sort) ||
      parseFlexibleStatusDay(item.timestamp) ||
      parseFlexibleStatusDay(item.day);
    if (parsed) {
      candidates.push(parsed);
    }
  });

  if (!candidates.length) {
    return null;
  }

  const earliest = candidates.reduce((currentEarliest, item) => (item.getTime() < currentEarliest.getTime() ? item : currentEarliest));
  return toIsoDateValue(earliest);
}

function countPauseHistoryEntries(payload?: CampaignPauseHistoryPayload) {
  if (!payload) {
    return 0;
  }
  return Math.max(
    Array.isArray(payload.merged_intervals) ? payload.merged_intervals.length : 0,
    Array.isArray(payload.intervals) ? payload.intervals.length : 0,
    Array.isArray(payload.tooltips) ? payload.tooltips.length : 0,
  );
}

function mergeUniquePauseHistoryEntries(left: CampaignPauseHistoryEntry[] = [], right: CampaignPauseHistoryEntry[] = []) {
  const seen = new Set<string>();
  const merged: CampaignPauseHistoryEntry[] = [];

  [...left, ...right].forEach((item) => {
    const key = JSON.stringify([
      item.start || "",
      item.end || "",
      item.status || "",
      Boolean(item.is_freeze),
      Boolean(item.is_unfreeze),
      item.paused_user || "",
      item.unpaused_user || "",
      item.stopped_user || "",
      item.paused_limiter || "",
      [...(item.pause_reasons || [])].sort(),
    ]);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(item);
  });

  merged.sort((left, right) => {
    const leftAt = parseStatusDateTimeValue(left.start)?.getTime() ?? 0;
    const rightAt = parseStatusDateTimeValue(right.start)?.getTime() ?? 0;
    return leftAt - rightAt;
  });

  return merged;
}

function mergeCampaignStatusLogs(base?: CampaignSummary["status_logs"], extended?: CampaignSummary["status_logs"]) {
  if (!base) {
    return extended;
  }
  if (!extended) {
    return base;
  }

  const primaryPauseHistory =
    countPauseHistoryEntries(extended.pause_history) >= countPauseHistoryEntries(base.pause_history)
      ? extended.pause_history
      : base.pause_history;
  const secondaryPauseHistory = primaryPauseHistory === extended.pause_history ? base.pause_history : extended.pause_history;
  const mergedIntervals = mergeUniquePauseHistoryEntries(primaryPauseHistory?.intervals || [], secondaryPauseHistory?.intervals || []);
  const mergedMergedIntervals = mergeUniquePauseHistoryEntries(
    primaryPauseHistory?.merged_intervals || [],
    secondaryPauseHistory?.merged_intervals || [],
  );

  return {
    mp_history: (extended.mp_history?.length ? extended.mp_history : base.mp_history) || [],
    mp_next_page: extended.mp_next_page ?? base.mp_next_page ?? null,
    mp_error: extended.mp_error ?? base.mp_error ?? null,
    pause_error: extended.pause_error ?? base.pause_error ?? null,
    pause_history: {
      labels: (primaryPauseHistory?.labels?.length ? primaryPauseHistory.labels : secondaryPauseHistory?.labels) || [],
      header: (primaryPauseHistory?.header?.length ? primaryPauseHistory.header : secondaryPauseHistory?.header) || [],
      series: (primaryPauseHistory?.series?.length ? primaryPauseHistory.series : secondaryPauseHistory?.series) || [],
      next_page: primaryPauseHistory?.next_page ?? secondaryPauseHistory?.next_page ?? null,
      tooltips: (primaryPauseHistory?.tooltips?.length ? primaryPauseHistory.tooltips : secondaryPauseHistory?.tooltips) || [],
      intervals: mergedIntervals,
      merged_intervals: mergedMergedIntervals.length ? mergedMergedIntervals : mergedIntervals,
    },
  };
}

function mergeCampaignChartSource(base: CampaignSummary, extended?: CampaignSummary | null): CampaignSummary {
  if (!extended) {
    return base;
  }

  return {
    ...base,
    ...extended,
    daily_exact: extended.daily_exact?.length ? extended.daily_exact : base.daily_exact,
    status_logs: mergeCampaignStatusLogs(base.status_logs, extended.status_logs),
  };
}

function resolveEarlierIsoDate(left?: string | null, right?: string | null) {
  const leftDate = parseFlexibleStatusDay(left);
  const rightDate = parseFlexibleStatusDay(right);
  if (leftDate && rightDate) {
    return leftDate.getTime() <= rightDate.getTime() ? toIsoDateValue(leftDate) : toIsoDateValue(rightDate);
  }
  if (leftDate) {
    return toIsoDateValue(leftDate);
  }
  if (rightDate) {
    return toIsoDateValue(rightDate);
  }
  return null;
}

function resolveCampaignActivityStatusKey(item?: CampaignPauseHistoryEntry | null): CampaignStatusStateKey {
  if (item?.is_freeze) {
    return "freeze";
  }
  const status = String(item?.status || "").toLowerCase();
  const reasons = [...(item?.pause_reasons || []), item?.paused_limiter]
    .map((token) => String(token || "").toLowerCase())
    .join(" ");
  if (/актив|active/.test(status)) {
    return "active";
  }
  if (
    /приост|pause|paused|stop|неактив|inactive/.test(status) ||
    /schedule|распис|budget|бюджет|limit|лимит/.test(reasons) ||
    Boolean(item?.paused_limiter) ||
    Boolean(item?.paused_user)
  ) {
    return "paused";
  }
  return "unknown";
}

function splitPauseReasonTokens(values: string[] | string | null | undefined) {
  const source = Array.isArray(values) ? values : [values];
  return source
    .flatMap((value) => String(value || "").split(/[;,/]/))
    .map((value) => value.trim())
    .filter(Boolean);
}

function translatePauseReasonToken(value: string) {
  const token = String(value || "").trim();
  if (!token) {
    return "";
  }
  if (/campaign_limiter/i.test(token)) {
    return "Лимит расходов";
  }
  if (/schedule|распис/i.test(token)) {
    return "Расписание показов";
  }
  if (/budget|бюджет|money|баланс|остаток|fund/i.test(token)) {
    return "Нет бюджета";
  }
  if (/freeze|замороз/i.test(token)) {
    return "Заморозка";
  }
  if (/user|пользоват/i.test(token)) {
    return "Пользователь";
  }
  if (/spend_limit|day_limit|daily_limit|limit|лимит|day|день/i.test(token)) {
    return "Лимит расходов";
  }
  return token;
}

function resolvePauseActorLabel(item?: CampaignPauseHistoryEntry | null) {
  if (!item) {
    return null;
  }
  const frozenBy = mergeStatusNameField(item.paused_user, item.stopped_user);
  const resumedBy = mergeStatusNameField(item.unpaused_user ?? undefined);

  if (item.is_freeze && frozenBy) {
    return `Заморозил: ${frozenBy}`;
  }
  if (item.is_unfreeze && resumedBy) {
    return `Разморозил: ${resumedBy}`;
  }
  return null;
}

function resolvePauseIssueKinds(item?: CampaignPauseHistoryEntry | null): CampaignIssueKind[] {
  if (item?.is_freeze) {
    return [];
  }
  const reasonKinds = resolvePauseReasonKinds(item);
  const issueKinds: CampaignIssueKind[] = [];
  if (reasonKinds.includes("limit")) {
    issueKinds.push("limit");
  }
  if (reasonKinds.includes("budget")) {
    issueKinds.push("budget");
  }
  return issueKinds;
}

function resolvePauseReasonKinds(item?: CampaignPauseHistoryEntry | null): CampaignPauseReasonKind[] {
  const tokens = [...splitPauseReasonTokens(item?.pause_reasons || []), ...splitPauseReasonTokens(item?.paused_limiter)];
  const joined = tokens.map((token) => token.toLowerCase()).join(" ");
  const hasSchedule = /schedule|распис/.test(joined);
  const hasLimit = /campaign_limiter|spend_limit|day_limit|daily_limit|limit|лимит|день|day/.test(joined);
  const hasBudget = /budget|бюджет|money|баланс|остаток|fund/.test(joined);
  const reasonKinds: CampaignPauseReasonKind[] = [];

  if (hasSchedule) {
    reasonKinds.push("schedule");
  }
  if (hasBudget) {
    reasonKinds.push("budget");
  }
  if (hasLimit) {
    reasonKinds.push("limit");
  }
  return reasonKinds;
}

function resolvePauseContext(item?: CampaignPauseHistoryEntry | null) {
  const tokens = [...splitPauseReasonTokens(item?.pause_reasons || []), ...splitPauseReasonTokens(item?.paused_limiter)];
  const actorLabel = resolvePauseActorLabel(item);
  const reasonKinds = resolvePauseReasonKinds(item);
  const issueKinds = resolvePauseIssueKinds(item);
  if (!tokens.length && item?.paused_user) {
    tokens.push("user");
  }
  const seen = new Set<string>();
  const reasonLabels = tokens
    .map((token) => translatePauseReasonToken(token))
    .filter((label) => !(actorLabel && label === "Пользователь"))
    .filter((label) => {
      if (!label || seen.has(label)) {
        return false;
      }
      seen.add(label);
      return true;
    });

  return {
    actorLabel,
    reasonLabels,
    reasonKinds,
    issueKinds,
  };
}

function pauseReasonLabels(item?: CampaignPauseHistoryEntry | null) {
  const { actorLabel, reasonLabels } = resolvePauseContext(item);
  const labels = [...reasonLabels];
  const seen = new Set(labels);
  if (actorLabel && !seen.has(actorLabel)) {
    labels.push(actorLabel);
  }
  return labels;
}

function compactStatusDayLabel(value?: string | null) {
  const parsed = parseRuDateLabel(value);
  if (!parsed) {
    return value || "—";
  }
  return `${String(parsed.getDate()).padStart(2, "0")}.${String(parsed.getMonth() + 1).padStart(2, "0")}`;
}

function compactStatusEndLabel(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) {
    return "актуально";
  }
  const parsed = splitStatusDateTime(text);
  if (parsed.time) {
    if (!parsed.date || parsed.date === "—") {
      return `до ${parsed.time}`;
    }
    return `до ${compactStatusDayLabel(parsed.date)} ${parsed.time}`;
  }
  return `до ${compactStatusDayLabel(text)}`;
}

function compactStatusStartTimeLabel(value?: string | null) {
  const parts = splitStatusDateTime(value);
  if (parts.time) {
    return parts.time;
  }
  return compactStatusDayLabel(parts.date);
}

function formatStatusClock(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatStatusDurationHours(item: Pick<CampaignPauseHistoryEntry, "start" | "end">) {
  const startAt = parseStatusDateTimeValue(item.start);
  if (!startAt) {
    return null;
  }
  const endAt = parseCampaignIntervalEnd(item, startAt);
  const diffHours = Math.max(0, (endAt.getTime() - startAt.getTime()) / 36e5);
  const rounded = Math.round(diffHours * 2) / 2;
  if (!Number.isFinite(rounded)) {
    return null;
  }
  if (rounded < 24) {
    const formatted = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
    return `${formatted}ч`;
  }

  const days = Math.floor(rounded / 24);
  const hoursRemainder = Math.round((rounded - days * 24) * 2) / 2;
  const formattedHours =
    hoursRemainder <= 0
      ? null
      : Number.isInteger(hoursRemainder)
        ? String(hoursRemainder)
        : hoursRemainder.toFixed(1).replace(".", ",");

  return formattedHours ? `${days}д ${formattedHours}ч` : `${days}д`;
}

function formatStatusTimelineDurationHours(
  item: Pick<StatusTimelineItem, "dayKey" | "displayStart" | "displayEnd" | "start" | "end">,
) {
  const fallbackDate = parseFlexibleStatusDay(item.dayKey);
  const startAt =
    parseStatusDateTimeValue(item.displayStart, {
      fallbackDate,
      fallbackYear: fallbackDate?.getFullYear(),
    }) || parseStatusDateTimeValue(item.start);
  if (!startAt) {
    return null;
  }

  const endAt =
    parseStatusDateTimeValue(item.displayEnd, {
      fallbackDate,
      fallbackYear: fallbackDate?.getFullYear(),
    }) || parseStatusDateTimeValue(item.end, {
      fallbackDate,
      fallbackYear: fallbackDate?.getFullYear(),
    });

  if (!endAt) {
    return null;
  }

  const diffHours = Math.max(0, (endAt.getTime() - startAt.getTime()) / 36e5);
  const rounded = Math.round(diffHours * 2) / 2;
  if (!Number.isFinite(rounded)) {
    return null;
  }
  if (rounded < 24) {
    const formatted = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
    return `${formatted}ч`;
  }

  const days = Math.floor(rounded / 24);
  const hoursRemainder = Math.round((rounded - days * 24) * 2) / 2;
  const formattedHours =
    hoursRemainder <= 0
      ? null
      : Number.isInteger(hoursRemainder)
        ? String(hoursRemainder)
        : hoursRemainder.toFixed(1).replace(".", ",");

  return formattedHours ? `${days}д ${formattedHours}ч` : `${days}д`;
}

function buildIsoDayRange(start?: string | null, end?: string | null) {
  if (!start || !end) {
    return [];
  }
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) {
    return [];
  }
  const days: string[] = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    days.push(toIsoDateValue(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function mergePauseHistoryDisplayIntervals(intervals: CampaignPauseHistoryEntry[] = []) {
  return intervals
    .filter((item) => item?.start || item?.end || item?.status)
    .reduce<Array<CampaignPauseHistoryEntry & { _startAt: Date | null; _endAt: Date | null; _statusKey: CampaignStatusStateKey }>>((merged, item) => {
      const startAt = parseStatusDateTimeValue(item.start);
      const endAt = startAt ? parseCampaignIntervalEnd(item, startAt) : null;
      const statusKey = resolveCampaignActivityStatusKey(item);
      const normalizedItem = {
        ...item,
        pause_reasons: Array.isArray(item.pause_reasons) ? [...item.pause_reasons] : [],
        _startAt: startAt,
        _endAt: endAt,
        _statusKey: statusKey,
      };
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous._statusKey !== "unknown" &&
        previous._statusKey === statusKey &&
        startAt instanceof Date &&
        endAt instanceof Date &&
        previous._startAt instanceof Date &&
        endAt.getTime() >= previous._startAt.getTime()
      ) {
        previous._startAt = startAt < previous._startAt ? startAt : previous._startAt;
        previous._endAt = previous._endAt instanceof Date ? new Date(Math.max(previous._endAt.getTime(), endAt.getTime())) : endAt;
        previous.start = `${String(previous._startAt.getDate()).padStart(2, "0")}.${String(previous._startAt.getMonth() + 1).padStart(2, "0")}.${previous._startAt.getFullYear()}, ${String(previous._startAt.getHours()).padStart(2, "0")}:${String(previous._startAt.getMinutes()).padStart(2, "0")}`;
        previous.end = previous._endAt
          ? previous._startAt.toDateString() === previous._endAt.toDateString()
            ? `${String(previous._endAt.getHours()).padStart(2, "0")}:${String(previous._endAt.getMinutes()).padStart(2, "0")}`
            : `${String(previous._endAt.getDate()).padStart(2, "0")}.${String(previous._endAt.getMonth() + 1).padStart(2, "0")}.${previous._endAt.getFullYear()}, ${String(previous._endAt.getHours()).padStart(2, "0")}:${String(previous._endAt.getMinutes()).padStart(2, "0")}`
          : previous.end;
        previous.pause_reasons = Array.from(new Set([...(previous.pause_reasons || []), ...(normalizedItem.pause_reasons || [])]));
        previous.paused_user = mergeStatusNameField(previous.paused_user, normalizedItem.paused_user);
        previous.unpaused_user = mergeStatusNameField(previous.unpaused_user ?? undefined, normalizedItem.unpaused_user ?? undefined) || undefined;
        previous.stopped_user = mergeStatusNameField(previous.stopped_user ?? undefined, normalizedItem.stopped_user ?? undefined) || undefined;
        previous.paused_limiter = mergeStatusNameField(previous.paused_limiter, normalizedItem.paused_limiter);
        previous.is_freeze = Boolean(previous.is_freeze) || Boolean(normalizedItem.is_freeze);
        previous.is_unfreeze = Boolean(previous.is_unfreeze) || Boolean(normalizedItem.is_unfreeze);
        return merged;
      }
      merged.push(normalizedItem);
      return merged;
    }, [])
    .map(({ _startAt, _endAt, _statusKey, ...normalized }) => normalized);
}

function campaignMergedPauseHistoryIntervals(campaign: CampaignSummary) {
  const pauseHistory = campaign.status_logs?.pause_history;
  return Array.isArray(pauseHistory?.merged_intervals) ? pauseHistory.merged_intervals : Array.isArray(pauseHistory?.intervals) ? pauseHistory.intervals : [];
}

function campaignRawPauseHistoryIntervals(campaign: CampaignSummary) {
  const pauseHistory = campaign.status_logs?.pause_history;
  return Array.isArray(pauseHistory?.intervals) ? pauseHistory.intervals : Array.isArray(pauseHistory?.merged_intervals) ? pauseHistory.merged_intervals : [];
}

function currentPauseInterval(campaign: CampaignSummary) {
  const intervals = campaign.status_logs?.pause_history?.intervals || [];
  if (!intervals.length) {
    return null;
  }
  return intervals.find((item) => !String(item.end || "").trim()) || intervals[0] || null;
}

function resolveCampaignDisplayStatus(campaign: CampaignSummary) {
  const baseStatus = String(campaign.status || "").trim() || "—";
  const currentInterval = currentPauseInterval(campaign);
  if (currentInterval?.is_freeze) {
    return { key: "freeze" as const, label: "Заморожена", tone: "accent" as const };
  }
  if (/актив/i.test(baseStatus)) {
    return { key: "active" as const, label: "Активна", tone: "good" as const };
  }
  if (/приост/i.test(baseStatus)) {
    return { key: "paused" as const, label: "Приостановлена", tone: "bad" as const };
  }
  return { key: "unknown" as const, label: baseStatus, tone: "default" as const };
}

function buildCampaignStatusTimelineItems(campaign: CampaignSummary, limit?: number | null): StatusTimelineItem[] {
  const rawIntervals = campaignRawPauseHistoryIntervals(campaign);
  const scopedIntervals =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? rawIntervals.slice(0, limit)
      : rawIntervals;

  const baseItems = scopedIntervals
    .flatMap((item, index) => {
      const statusKey = resolveCampaignActivityStatusKey(item);
      const startAt = parseStatusDateTimeValue(item.start);
      const endAt = startAt ? parseCampaignIntervalEnd(item, startAt) : null;
      const reasons = pauseReasonLabels(item);
      const statusLabel =
        statusKey === "paused"
          ? "Пауза"
          : item.is_freeze
            ? "Заморожена"
            : item.status || "Статус";
      const sourceKey = `${index}:${item.start || ""}:${item.end || ""}:${statusKey}:${item.is_freeze ? "freeze" : "plain"}:${reasons.join("|")}`;

      if (!startAt || !endAt) {
        return [{
          ...item,
          sourceKey,
          statusKey,
          statusLabel,
          reasons,
          displayStart: item.start,
          displayEnd: item.end ?? null,
          dayKey: startAt ? toIsoDateValue(startAt) : splitStatusDateTime(item.start).date || `unknown-${index}`,
          tierIndex: 0,
          tierCount: 1,
        }];
      }

      const slices: StatusTimelineItem[] = [];
      const cursor = new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate());
      const lastDay = new Date(endAt.getFullYear(), endAt.getMonth(), endAt.getDate());

      while (cursor.getTime() <= lastDay.getTime()) {
        const dayStart = new Date(cursor);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(cursor);
        dayEnd.setHours(23, 59, 59, 999);
        const effectiveStart = startAt > dayStart ? startAt : dayStart;
        const effectiveEnd = endAt < dayEnd ? endAt : dayEnd;

        if (effectiveEnd.getTime() >= effectiveStart.getTime()) {
          slices.push({
            ...item,
            sourceKey,
            statusKey,
            statusLabel,
            reasons,
            displayStart: formatStatusDateTimeForUi(effectiveStart),
            displayEnd: effectiveEnd.getTime() >= dayEnd.getTime() ? null : formatStatusDateTimeForUi(effectiveEnd, effectiveStart),
            dayKey: toIsoDateValue(dayStart),
            tierIndex: 0,
            tierCount: 1,
          });
        }

        cursor.setDate(cursor.getDate() + 1);
      }

      return slices;
    });

  const totalsByDay = new Map<string, number>();
  baseItems.forEach((item) => {
    totalsByDay.set(item.dayKey, (totalsByDay.get(item.dayKey) || 0) + 1);
  });

  const seenByDay = new Map<string, number>();
  return baseItems.map((item) => {
    const tierIndex = seenByDay.get(item.dayKey) || 0;
    seenByDay.set(item.dayKey, tierIndex + 1);
    return {
      ...item,
      tierIndex,
      tierCount: totalsByDay.get(item.dayKey) || 1,
    };
  });
}

function buildCampaignStatusTimelineDays(campaign: CampaignSummary, limit?: number | null): StatusTimelineDay[] {
  const grouped = new Map<string, StatusTimelineDay>();

  buildCampaignStatusTimelineItems(campaign, limit).forEach((item) => {
    const existing = grouped.get(item.dayKey);
    if (!existing) {
      grouped.set(item.dayKey, {
        dayKey: item.dayKey,
        dayLabel: formatStatusTimelineDayRangeLabel(item.dayKey),
        items: [item],
      });
      return;
    }
    existing.items.push(item);
  });

  const orderedDays = [...grouped.values()]
    .map((day) => ({
      ...day,
      items: [...day.items].sort((left, right) => {
        const leftAt = parseStatusDateTimeValue(left.start)?.getTime() ?? 0;
        const rightAt = parseStatusDateTimeValue(right.start)?.getTime() ?? 0;
        return rightAt - leftAt;
      }),
    }))
    .sort((left, right) => left.dayKey.localeCompare(right.dayKey));

  const mergedDays: StatusTimelineDay[] = [];

  orderedDays.forEach((day) => {
    const previousDay = mergedDays[mergedDays.length - 1];
    const previousItem = previousDay?.items.length === 1 ? previousDay.items[0] : null;
    const currentItem = day.items.length === 1 ? day.items[0] : null;

    if (previousDay && previousItem && currentItem && previousItem.sourceKey === currentItem.sourceKey) {
      previousDay.dayLabel = formatStatusTimelineDayRangeLabel(previousDay.dayKey, day.dayKey);
      previousDay.items = [{
        ...previousItem,
        displayEnd: currentItem.displayEnd ?? previousItem.displayEnd,
      }];
      return;
    }

    mergedDays.push(day);
  });

  return mergedDays;
}

function buildCampaignStatusDays(campaign: CampaignSummary, rangeStart?: string | null, rangeEnd?: string | null): CampaignOverviewStatusDay[] {
  const historyStart = resolveCampaignStatusHistoryStart(campaign);
  const effectiveStart = resolveEarlierIsoDate(rangeStart, historyStart) ?? rangeStart ?? historyStart;
  const rangeDays = buildIsoDayRange(effectiveStart, rangeEnd);
  const fallbackDays = [...(campaign.daily_exact || [])].map((row) => row.day).sort((left, right) => left.localeCompare(right));
  const dayKeys = rangeDays.length ? rangeDays : fallbackDays;

  if (!dayKeys.length) {
    return [];
  }

  const intervals = campaignRawPauseHistoryIntervals(campaign).flatMap((item) => {
    const startAt = parseStatusDateTimeValue(item.start);
    const endAt = startAt ? parseCampaignIntervalEnd(item, startAt) : null;
    if (!startAt) {
      return [];
    }
    const context = resolvePauseContext(item);
    return [{
      startAt,
      endAt: endAt || new Date(startAt),
      key: resolveCampaignActivityStatusKey(item),
      label: item.is_freeze ? "Заморожена" : item.status || "Статус",
      reasons: context.reasonLabels,
      reasonKinds: context.reasonKinds,
      actorLabel: context.actorLabel ?? null,
      issueKinds: context.issueKinds,
    }];
  });

  return dayKeys.map((day) => {
    const dayStart = new Date(`${day}T00:00:00`);
    const dayEnd = new Date(`${day}T23:59:59.999`);
    const entries: CampaignDayStatusEntry[] = intervals
      .filter((interval) => interval.startAt <= dayEnd && interval.endAt >= dayStart)
      .sort((left, right) => left.startAt.getTime() - right.startAt.getTime())
      .map((interval) => {
        const effectiveStart = interval.startAt > dayStart ? interval.startAt : dayStart;
        const effectiveEnd = interval.endAt < dayEnd ? interval.endAt : dayEnd;
        return {
          key: interval.key,
          label: interval.label,
          startTime: formatStatusClock(effectiveStart),
          endTime: effectiveEnd.getTime() >= dayEnd.getTime() ? null : formatStatusClock(effectiveEnd),
          originalStart: interval.startAt ? formatStatusDateTimeForUi(interval.startAt) : null,
          originalEnd: interval.endAt ? formatStatusDateTimeForUi(interval.endAt, interval.startAt) : null,
          reasons: interval.reasons,
          reasonKinds: interval.reasonKinds,
          actorLabel: interval.actorLabel,
          issueKinds: interval.issueKinds,
        };
      });

    return {
      day,
      label: formatDailySeriesLabel(day, 0),
      entries,
    };
  });
}

function CampaignStatusGlyph({ state }: { state: CampaignStatusStateKey }) {
  if (state === "active") {
    return <Play size={13} strokeWidth={2.2} />;
  }
  if (state === "freeze") {
    return <Snowflake size={13} strokeWidth={2.1} />;
  }
  if (state === "paused") {
    return <Pause size={13} strokeWidth={2.2} />;
  }
  return <span className="block h-2 w-2 rounded-full bg-current" />;
}

function CampaignStatusIconBadge({
  campaign,
  className,
}: {
  campaign: CampaignSummary;
  className?: string;
}) {
  const displayStatus = resolveCampaignDisplayStatus(campaign);
  const tooltip = `Статус РК: ${displayStatus.label}`;

  return (
    <span
      className={cn("campaign-status-icon-badge", `is-${displayStatus.key}`, className)}
      title={tooltip}
      aria-label={tooltip}
    >
      <CampaignStatusGlyph state={displayStatus.key} />
    </span>
  );
}

function CampaignScheduleStatusBadge({
  active,
  className,
}: {
  active: boolean;
  className?: string;
}) {
  const tooltip = active ? "Расписание активно" : "Расписание выключено";
  const Icon = active ? Check : Pause;

  return (
    <span
      className={cn("campaign-budget-progress-state-badge", active ? "is-on" : "is-off", className)}
      title={tooltip}
      aria-label={tooltip}
    >
      <Icon size={14} strokeWidth={2.2} />
    </span>
  );
}

function buildVisibleCampaignIds(campaigns: CampaignSummary[], selectedIds: number[]) {
  const campaignIds = campaigns.map((campaign) => campaign.id);
  const filtered = selectedIds.filter((id, index) => campaignIds.includes(id) && selectedIds.indexOf(id) === index);
  return filtered.length ? filtered : campaignIds;
}

function formatSparklineTooltipLabel(label?: string | null) {
  const normalized = String(label || "").trim();
  const match = normalized.match(/^(\d{2}\.\d{2}\.)(\d{4})$/);
  if (!match) {
    return normalized;
  }
  const [, prefix = "", year = ""] = match;
  return `${prefix}${year.slice(-2)}`;
}

function Sparkline({
  points,
  stroke,
  fill,
  width = 80,
  height = 30,
  className,
  responsive = false,
  formatValue = formatBoardPercent,
  invertY = false,
  clipToBounds = false,
  activeLabel,
  onActiveLabelChange,
  compactTooltip = false,
  variant = "line",
}: {
  points: MetricSeriesPoint[];
  stroke: string;
  fill: string;
  width?: number;
  height?: number;
  className?: string;
  responsive?: boolean;
  formatValue?: (value: number) => string;
  invertY?: boolean;
  clipToBounds?: boolean;
  activeLabel?: string | null;
  onActiveLabelChange?: (label: string | null) => void;
  compactTooltip?: boolean;
  variant?: "line" | "bars";
}) {
  const gradientId = useId().replace(/:/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [responsiveWidth, setResponsiveWidth] = useState(width);
  const [tooltipMeasuredWidth, setTooltipMeasuredWidth] = useState(0);
  const series = points.map((point) => ({
    label: point.label,
    day: point.day ?? null,
    value: toNumber(point.value),
  }));
  const numericSeries = series.filter((point): point is { label: string; day: string | null; value: number } => point.value !== null);
  const hasRenderableSeries = series.length > 0 && numericSeries.length > 0;

  useEffect(() => {
    if (!responsive || !containerRef.current || typeof ResizeObserver === "undefined") {
      return;
    }

    const node = containerRef.current;
    const updateWidth = () => {
      const nextWidth = Math.round(node.getBoundingClientRect().width);
      if (nextWidth > 0) {
        setResponsiveWidth((current) => (current !== nextWidth ? nextWidth : current));
      }
    };

    updateWidth();
    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(node);
    return () => observer.disconnect();
  }, [responsive, width]);

  const chartWidth = responsive ? responsiveWidth : width;
  const max = hasRenderableSeries ? Math.max(...numericSeries.map((point) => point.value)) : 0;
  const min = hasRenderableSeries ? Math.min(...numericSeries.map((point) => point.value)) : 0;
  const domainMin = variant === "bars" ? Math.min(min, 0) : min;
  const range = max - domainMin || 1;
  const padX = variant === "bars" ? 6 : 8;
  const padY = 3;
  const innerHeight = height - padY * 2;
  const chartBottom = height - padY;
  const slotWidth = series.length > 0 ? (chartWidth - padX * 2) / Math.max(series.length, 1) : 0;
  const barWidth = Math.max(4, Math.min(12, slotWidth * 0.68));
  const getX = (index: number) =>
    variant === "bars"
      ? padX + slotWidth * index + slotWidth / 2
      : series.length <= 1
        ? chartWidth / 2
        : padX + (index / (series.length - 1)) * (chartWidth - padX * 2);
  const getY = (value: number) => {
    const scale = (value - domainMin) / range;
    return padY + (invertY ? scale : 1 - scale) * innerHeight;
  };
  const zeroY = getY(0);
  const contiguousSegments = series.reduce<
    Array<Array<{ x: number; y: number; index: number; label: string; day: string | null; value: number }>>
  >((segments, point, index) => {
    if (point.value === null) {
      return segments;
    }

    const previous = series[index - 1];
    const shouldStartNewSegment = index === 0 || previous?.value === null;
    const nextPoint = {
      x: getX(index),
      y: getY(point.value),
      index,
      label: point.label,
      day: point.day,
      value: point.value,
    };

    if (shouldStartNewSegment) {
      segments.push([nextPoint]);
      return segments;
    }

    segments[segments.length - 1]?.push(nextPoint);
    return segments;
  }, []);
  const controlledHoveredIndex =
    activeLabel == null
      ? null
      : series.findIndex((point) => point.label === activeLabel);
  const resolvedHoveredIndex =
    controlledHoveredIndex !== null && controlledHoveredIndex >= 0 ? controlledHoveredIndex : hoveredIndex;
  const activePoint = resolvedHoveredIndex === null ? null : series[resolvedHoveredIndex] ?? null;
  const tooltipLabel = formatSparklineTooltipLabel(activePoint?.label);
  const tooltipValue = activePoint?.value !== null && activePoint ? formatValue(activePoint.value) : "—";
  const estimatedTooltipWidth = Math.max(
    compactTooltip ? 40 : 56,
    Math.round(
      Math.max(
        (tooltipLabel.length || 0) * (compactTooltip ? 4.2 : 5.4) + (compactTooltip ? 10 : 16),
        tooltipValue.length * (compactTooltip ? 5.1 : 6.8) + (compactTooltip ? 12 : 18),
      ),
    ),
  );
  const tooltipMaxWidth =
    typeof window !== "undefined"
      ? Math.max(compactTooltip ? 82 : 120, Math.min(compactTooltip ? 160 : 240, window.innerWidth - 24))
      : compactTooltip
        ? 160
        : 240;
  const tooltipWidth = Math.min(tooltipMeasuredWidth || estimatedTooltipWidth, tooltipMaxWidth);
  const tooltipHeight = tooltipLabel ? (compactTooltip ? 24 : 34) : compactTooltip ? 16 : 22;
  const tooltipCenterX =
    resolvedHoveredIndex === null
      ? 0
      : Math.max(tooltipWidth / 2, Math.min(chartWidth - tooltipWidth / 2, getX(resolvedHoveredIndex)));
  const clipPathId = `spark-clip-${gradientId}`;

  useEffect(() => {
    if (!activePoint || !tooltipRef.current) {
      setTooltipMeasuredWidth(0);
      return;
    }

    const nextWidth = Math.ceil(tooltipRef.current.getBoundingClientRect().width);
    if (nextWidth > 0) {
      setTooltipMeasuredWidth((current) => (current !== nextWidth ? nextWidth : current));
    }
  }, [activePoint, tooltipLabel, tooltipValue]);

  const handleMouseMove = useCallback(
    (event: MouseEvent<SVGSVGElement>) => {
      if (!hasRenderableSeries) {
        return;
      }
      if (!svgRef.current) {
        return;
      }
      const rect = svgRef.current.getBoundingClientRect();
      const mouseX = rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * chartWidth : event.clientX - rect.left;
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;
      series.forEach((_, index) => {
        const distance = Math.abs(getX(index) - mouseX);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });
      setHoveredIndex(closestIndex);
      onActiveLabelChange?.(series[closestIndex]?.label ?? null);
    },
    [chartWidth, onActiveLabelChange, series],
  );

  const svg = (
    <svg
      ref={svgRef}
      width={responsive ? "100%" : chartWidth}
      height={responsive ? "100%" : height}
      viewBox={`0 0 ${chartWidth} ${height}`}
      preserveAspectRatio="none"
      className={cn("block cursor-crosshair overflow-visible", responsive && "h-full w-full", className)}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => {
        setHoveredIndex(null);
        onActiveLabelChange?.(null);
      }}
      style={{ userSelect: "none" }}
    >
      <defs>
        <linearGradient id={`spark-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fill} stopOpacity="0.18" />
          <stop offset="100%" stopColor={fill} stopOpacity="0.02" />
        </linearGradient>
        <clipPath id={clipPathId}>
          <rect x={1} y={1} width={Math.max(chartWidth - 2, 0)} height={Math.max(height - 2, 0)} rx={6} ry={6} />
        </clipPath>
      </defs>

      <g clipPath={`url(#${clipPathId})`}>
        {variant === "bars" ? (
          <>
            {series.map((point, index) => {
              if (point.value === null) {
                return null;
              }
              const valueY = getY(point.value);
              const invertedBarScale = max === min ? 0.72 : Math.max(0, Math.min((max - point.value) / Math.max(max - min, 1), 1));
              const rectHeight = invertY ? Math.max(invertedBarScale * innerHeight, 2) : Math.max(Math.abs(zeroY - valueY), 2);
              const rectY = invertY ? chartBottom - rectHeight : Math.min(valueY, zeroY);
              const isActiveBar = resolvedHoveredIndex === index;
              return (
                <rect
                  key={`${stroke}-bar-${index}`}
                  x={getX(index) - barWidth / 2}
                  y={rectY}
                  width={barWidth}
                  height={rectHeight}
                  rx={2.5}
                  ry={2.5}
                  fill={fill}
                  fillOpacity={isActiveBar ? 0.92 : 0.7}
                  stroke={isActiveBar ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.4)"}
                  strokeWidth={isActiveBar ? 1.2 : 0.8}
                />
              );
            })}
          </>
        ) : (
          <>
            {contiguousSegments.map((segment, index) => (
              <Fragment key={`${gradientId}-segment-area-${index}`}>
                <polygon
                  points={`${segment[0]?.x},${chartBottom} ${segment.map((point) => `${point.x},${point.y}`).join(" ")} ${segment[segment.length - 1]?.x},${chartBottom}`}
                  fill={`url(#spark-${gradientId})`}
                />
                {segment.length > 1 ? (
                  <polyline
                    points={segment.map((point) => `${point.x},${point.y}`).join(" ")}
                    fill="none"
                    stroke={stroke}
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : (
                  <circle cx={segment[0]!.x} cy={segment[0]!.y} r="1.8" fill={stroke} />
                )}
              </Fragment>
            ))}

            {resolvedHoveredIndex === null &&
              series.map((point, index) => (
                point.value !== null ? (
                  <circle key={`${stroke}-${index}`} cx={getX(index)} cy={getY(point.value)} r="1.8" fill={stroke} stroke="rgba(255,255,255,0.85)" strokeWidth="1" />
                ) : null
              ))}

            {resolvedHoveredIndex !== null && activePoint ? (
              <>
                <line x1={getX(resolvedHoveredIndex)} y1="0" x2={getX(resolvedHoveredIndex)} y2={height} stroke={stroke} strokeWidth="1" strokeDasharray="3 2" strokeOpacity="0.5" />
                {series.map((point, index) => (
                  point.value !== null ? (
                    <circle
                      key={`${stroke}-hover-${index}`}
                      cx={getX(index)}
                      cy={getY(point.value)}
                      r={index === resolvedHoveredIndex ? "4" : "2"}
                      fill={index === resolvedHoveredIndex ? stroke : "rgba(200,200,200,0.5)"}
                      stroke={index === resolvedHoveredIndex ? "rgba(255,255,255,0.9)" : "none"}
                      strokeWidth="1.5"
                    />
                  ) : null
                ))}
              </>
            ) : null}
          </>
        )}
      </g>
    </svg>
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative overflow-visible", responsive && "h-full w-full")}
      style={responsive ? undefined : { width: `${chartWidth}px`, height: `${height}px` }}
    >
      {!hasRenderableSeries ? <div className="h-[22px] w-[56px] rounded-[12px] bg-white/45" /> : null}
      {resolvedHoveredIndex !== null && activePoint ? (
        <div
          ref={tooltipRef}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute z-20 grid w-max bg-[rgba(38,33,58,0.93)] text-center text-white shadow-[0_12px_28px_rgba(26,20,41,0.28)]",
            compactTooltip ? "rounded-[9px] px-2 py-1" : "rounded-[12px] px-3 py-2",
          )}
          style={{
            minHeight: `${tooltipHeight}px`,
            maxWidth: `${tooltipMaxWidth}px`,
            left: `${tooltipCenterX}px`,
            bottom: `calc(100% + 6px)`,
            transform: "translateX(-50%)",
          }}
        >
          {tooltipLabel ? <div className={cn("font-semibold leading-none text-white/55", compactTooltip ? "text-[7px]" : "text-[11px]")}>{tooltipLabel}</div> : null}
          <div className={cn("font-display font-semibold leading-none text-white", compactTooltip ? "text-[10px]" : "text-[15px]", tooltipLabel ? (compactTooltip ? "mt-0.5" : "mt-1") : "")}>{tooltipValue}</div>
        </div>
      ) : null}
      {hasRenderableSeries ? (clipToBounds ? <div className="h-full w-full overflow-hidden rounded-[8px]">{svg}</div> : svg) : null}
    </div>
  );
}

function buildClusterPositionTimelineDayKeys(clusters: ClusterItem[], days = CLUSTER_POSITION_TIMELINE_DAYS) {
  const availableDays = clusters.flatMap((cluster) => Object.keys(cluster.daily || {}));
  const fallbackDays = clusters
    .map((cluster) => cluster.latest_date)
    .filter((value): value is string => Boolean(value));
  const latestDay = [...availableDays, ...fallbackDays].sort((left, right) => left.localeCompare(right)).at(-1);

  if (!latestDay) {
    return [];
  }

  const parsedEnd = new Date(`${latestDay}T00:00:00`);
  if (Number.isNaN(parsedEnd.getTime())) {
    return [];
  }

  const startDate = new Date(parsedEnd);
  startDate.setDate(startDate.getDate() - Math.max(days - 1, 0));
  return buildIsoDayRange(toIsoDateValue(startDate), latestDay);
}

function buildClusterPositionSeries(cluster: ClusterItem, days = CLUSTER_POSITION_TIMELINE_DAYS, dayKeys?: string[]): MetricSeriesPoint[] {
  const lookup = new Map(
    Object.entries(cluster.daily || {}).map(([day, row]) => [
      day,
      (() => {
        const value = toNumber(row.rates_promo_pos) ?? toNumber(row.org_pos);
        return value !== null && value > 0 ? value : null;
      })(),
    ]),
  );

  if (dayKeys?.length) {
    return dayKeys.map((day, index) => ({
      day,
      label: formatDailySeriesLabel(day, index),
      value: lookup.get(day) ?? null,
    }));
  }

  const rows = Object.entries(cluster.daily || {})
    .sort(([leftDay], [rightDay]) => leftDay.localeCompare(rightDay))
    .map(([day, row], index) => ({
      day,
      label: formatDailySeriesLabel(day, index),
      value: toNumber(row.rates_promo_pos) ?? toNumber(row.org_pos),
    }))
    .filter((point) => point.value !== null && point.value > 0);

  if (rows.length) {
    return rows.slice(-days);
  }

  const fallbackPosition = toNumber(cluster.position);
  if (fallbackPosition !== null && fallbackPosition > 0) {
    return [
      {
        day: cluster.latest_date,
        label: cluster.latest_date ? formatDailySeriesLabel(cluster.latest_date, 0) : "Сейчас",
        value: fallbackPosition,
      },
    ];
  }

  return [];
}

function ClusterPositionSparkline({
  points,
}: {
  points: MetricSeriesPoint[];
}) {
  if (!points.length) {
    return <span className="text-xs text-[var(--color-muted)]">—</span>;
  }

  return (
    <div className="flex min-w-[80px] items-center">
      <div className="h-[18px] min-w-[64px] flex-1">
        <Sparkline
          points={points}
          stroke="#8b64f6"
          fill="#8b64f6"
          height={18}
          responsive
          invertY
          className="h-full w-full"
          formatValue={(value) => `${formatNumber(Math.round(value))} поз.`}
          compactTooltip
          variant="bars"
        />
      </div>
    </div>
  );
}

type ClusterFilterMode = "enabled" | "fixed" | "excluded";
type ClusterSortKey = "expense" | "views" | "clicks" | "position" | "bid" | "ctr" | "cr" | "popularity" | "name";
type ClusterSortDirection = "asc" | "desc";

function resolveClusterState(cluster: ClusterItem) {
  if (cluster.excluded) {
    return {
      key: "excluded" as const,
      label: "Исключён",
      Icon: X,
      className: "border-rose-200 bg-rose-50 text-rose-600",
    };
  }
  if (cluster.fixed) {
    return {
      key: "fixed" as const,
      label: "Зафиксирован",
      Icon: Pin,
      className: "border-violet-200 bg-violet-50 text-violet-600",
    };
  }
  return {
    key: "enabled" as const,
    label: "Включён",
    Icon: Check,
    className: "border-emerald-200 bg-emerald-50 text-emerald-600",
  };
}

function matchesClusterFilter(cluster: ClusterItem, filterModes: ClusterFilterMode[]) {
  if (!filterModes.length) {
    return false;
  }
  return filterModes.includes(resolveClusterState(cluster).key);
}

function getClusterSortDefaultDirection(sortKey: ClusterSortKey): ClusterSortDirection {
  return sortKey === "name" || sortKey === "position" ? "asc" : "desc";
}

function compareNullableNumbers(left: number | null, right: number | null) {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left - right;
}

function compareClusters(left: ClusterItem, right: ClusterItem, sortKey: ClusterSortKey) {
  switch (sortKey) {
    case "name":
      return left.name.localeCompare(right.name, "ru");
    case "position":
      return compareNullableNumbers(toNumber(left.position), toNumber(right.position));
    case "views":
      return compareNullableNumbers(toNumber(left.views), toNumber(right.views));
    case "clicks":
      return compareNullableNumbers(toNumber(left.clicks), toNumber(right.clicks));
    case "bid":
      return compareNullableNumbers(toNumber(left.bid), toNumber(right.bid));
    case "ctr":
      return compareNullableNumbers(toNumber(left.ctr), toNumber(right.ctr));
    case "cr":
      return compareNullableNumbers(toNumber(left.cr), toNumber(right.cr));
    case "popularity":
      return compareNullableNumbers(toNumber(left.popularity), toNumber(right.popularity));
    case "expense":
    default:
      return compareNullableNumbers(toNumber(left.expense), toNumber(right.expense));
  }
}

function ClusterStateIcon({ cluster }: { cluster: ClusterItem }) {
  const state = resolveClusterState(cluster);
  const Icon = state.Icon;

  return (
    <span
      className={cn("inline-flex size-6 items-center justify-center rounded-full border shadow-[0_6px_16px_rgba(44,35,66,0.05)]", state.className)}
      title={state.label}
      aria-label={state.label}
    >
      <Icon className="size-3" />
    </span>
  );
}

function resolveClusterStrategyTone(isActive: boolean) {
  return isActive
    ? {
        icon: "border-emerald-200 bg-emerald-100 text-emerald-700",
      }
    : {
        icon: "border-slate-200 bg-white text-slate-500",
      };
}

function ClusterStrategyValueBox({
  current,
  target,
  title,
  muted = false,
}: {
  current: string;
  target: string;
  title: string;
  muted?: boolean;
}) {
  return (
    <div className={cn("cluster-strategy-value-stack", muted && "is-muted")} title={title}>
      <span className="cluster-strategy-value-box-value">{current}</span>
      <span className="cluster-strategy-value-arrow" aria-hidden="true">
        →
      </span>
      <span className="cluster-strategy-value-box-value">{target}</span>
    </div>
  );
}

function ClusterStrategyStatusCell({ cluster }: { cluster: ClusterItem }) {
  const isActive = Boolean(cluster.bid_rule_active);
  const tone = resolveClusterStrategyTone(isActive);

  return (
    <div className="flex justify-center" title={isActive ? "Стратегия включена" : "Стратегия выключена"}>
      <span
        className={cn("inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border", tone.icon)}
        aria-label={isActive ? "Стратегия включена" : "Стратегия выключена"}
      >
        {isActive ? <Check className="size-2.25" /> : <Pause className="size-2.25" />}
      </span>
    </div>
  );
}

function ClusterStrategyBidCell({ cluster }: { cluster: ClusterItem }) {
  const isActive = Boolean(cluster.bid_rule_active);
  const currentBid = toNumber(cluster.bid);
  const maxCpm = toNumber(cluster.bid_rule_max_cpm);
  const currentText = currentBid !== null ? formatMoney(currentBid, true) : "—";
  const targetText = maxCpm !== null ? formatMoney(maxCpm, true) : "—";

  return (
    <ClusterStrategyValueBox
      current={currentText}
      target={targetText}
      muted={!isActive}
      title={`Текущая ставка ${currentBid !== null ? formatMoney(currentBid, true) : "—"} · Ставка стратегии ${maxCpm !== null ? formatMoney(maxCpm, true) : "—"}`}
    />
  );
}

function ClusterStrategyPositionCell({ cluster }: { cluster: ClusterItem }) {
  const isActive = Boolean(cluster.bid_rule_active);
  const currentPosition = toNumber(cluster.position);
  const targetPlace = toNumber(cluster.bid_rule_target_place);
  const currentText = currentPosition !== null ? formatNumber(currentPosition) : "—";
  const targetText = targetPlace !== null ? formatNumber(targetPlace) : "—";

  return (
    <ClusterStrategyValueBox
      current={currentText}
      target={targetText}
      muted={!isActive}
      title={`Текущая позиция ${currentPosition !== null ? formatNumber(currentPosition) : "—"} · Позиция таргет ${targetPlace !== null ? formatNumber(targetPlace) : "—"}`}
    />
  );
}

function PerformanceCell({
  cell,
  compareOnNewLine = false,
}: {
  cell: BoardMetricCell;
  compareOnNewLine?: boolean;
}) {
  if (!cell.label && !cell.value && !cell.inlineMetrics?.length) {
    return <div className="min-h-[52px] p-3" />;
  }

  if (cell.inlineMetrics?.length) {
    return (
      <div className="min-h-[52px] p-3">
        <div className="grid grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)] items-stretch">
          {cell.inlineMetrics.map((metric, index) => (
            <Fragment key={`${metric.label}-${index}`}>
              {index > 0 ? <div className="h-full bg-[var(--color-line)]" aria-hidden="true" /> : null}
              <div className={cn("min-w-0", index > 0 && "pl-2")}>
                <span className="block text-[10px] font-bold uppercase tracking-wider leading-none text-[var(--color-muted)]">{metric.label}</span>
                <div className={cn("mt-1.5 flex flex-wrap items-baseline gap-1.5", compareOnNewLine && "campaign-period-compare-stack")}>
                  <strong className="font-display text-[1.15rem] leading-none text-[var(--color-ink)]">{metric.value}</strong>
                  {metric.delta ? (
                    <span
                      data-period-delta
                      className={cn(
                        "text-[11px] font-semibold leading-none",
                        metric.deltaGood === undefined ? "text-[var(--color-muted)]" : metric.deltaGood ? "text-emerald-600" : "text-rose-500",
                      )}
                    >
                      ({metric.delta})
                    </span>
                  ) : null}
                </div>
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[52px] p-3">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <span className="block text-[10px] font-bold uppercase tracking-wider leading-none text-[var(--color-muted)]">{cell.label}</span>
        {cell.action ? <div className="shrink-0">{cell.action}</div> : null}
      </div>
      <div className={cn("flex flex-wrap items-baseline gap-1.5", compareOnNewLine && "campaign-period-compare-stack")}>
        <strong className="font-display text-[1.15rem] leading-none text-[var(--color-ink)]">{cell.value}</strong>
        {cell.delta ? <span data-period-delta className={cn("text-[11px] font-semibold leading-none", cell.deltaGood === undefined ? "text-[var(--color-muted)]" : cell.deltaGood ? "text-emerald-600" : "text-rose-500")}>({cell.delta})</span> : null}
      </div>
      {cell.hint ? <div className="mt-1 text-[10px] leading-tight text-[var(--color-muted)]">{cell.hint}</div> : null}
    </div>
  );
}

function DrrCard({
  drr,
  compareOnNewLine = false,
}: {
  drr: BoardDrrCell;
  compareOnNewLine?: boolean;
}) {
  const graphRef = useRef<HTMLDivElement>(null);
  const [graphWidth, setGraphWidth] = useState(0);
  const palette = {
    basket: {
      background: "bg-gradient-to-br from-[rgba(237,243,255,0.9)] to-[rgba(226,237,255,0.7)]",
      border: "border-[rgba(75,123,255,0.18)]",
      chart: "#3d82d8",
    },
    "ads-orders": {
      background: "bg-gradient-to-br from-[rgba(255,248,240,0.9)] to-[rgba(255,242,226,0.7)]",
      border: "border-[rgba(241,120,40,0.22)]",
      chart: "#f17828",
    },
    "total-orders": {
      background: "bg-gradient-to-br from-[rgba(236,250,242,0.9)] to-[rgba(224,248,236,0.7)]",
      border: "border-[rgba(62,157,105,0.24)]",
      chart: "#3e9d69",
    },
  } as const;
  const tone = palette[drr.tone];
  const compactPoints = graphWidth > 0 && drr.points.length > 7 && graphWidth / drr.points.length < 16;
  const visiblePoints = compactPoints ? drr.points.slice(-7) : drr.points;
  const shouldRenderGraph = visiblePoints.length > 1;

  useEffect(() => {
    if (!graphRef.current || typeof ResizeObserver === "undefined") {
      return;
    }

    const node = graphRef.current;
    const updateWidth = () => {
      const nextWidth = Math.round(node.getBoundingClientRect().width);
      if (nextWidth > 0) {
        setGraphWidth((current) => (current !== nextWidth ? nextWidth : current));
      }
    };

    updateWidth();
    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={cn("relative z-0 flex h-full min-h-[78px] flex-col justify-between gap-2 rounded-[14px] border px-3 py-2.5 transition-[z-index] hover:z-40 focus-within:z-40", tone.background, tone.border)}>
      <span className="block min-h-[1.35rem] text-[9px] font-bold uppercase tracking-[0.1em] leading-[0.95] text-[var(--color-muted)]">
        {drr.label}
      </span>
      <div className="flex min-w-0 items-end gap-3">
        <div className={cn("flex min-w-0 flex-wrap items-baseline gap-1.5", compareOnNewLine && "campaign-period-compare-stack")}>
          <strong className="font-display text-[1.15rem] leading-none text-[var(--color-ink)]">{formatBoardPercent(drr.value)}</strong>
          {drr.delta !== null && drr.delta !== undefined ? <span data-period-delta className={cn("text-[11px] font-bold leading-none", deltaTone(drr.delta, false))}>{formatSignedPercent(drr.delta)}</span> : null}
        </div>
        {shouldRenderGraph ? (
          <div ref={graphRef} className="ml-auto flex h-[30px] min-w-0 flex-1 items-end justify-end">
            <Sparkline
              points={visiblePoints}
              stroke={tone.chart}
              fill={tone.chart}
              width={120}
              height={30}
              responsive
              className="h-full w-full"
              formatValue={formatBoardPercent}
              clipToBounds
              variant="bars"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BidAccentCard({
  label,
  value,
  points,
  change,
  bidKind,
  tone,
  onOpenHistory,
}: {
  label: string;
  value: string;
  points: MetricSeriesPoint[];
  change: { delta: number; direction: "up" | "down" | "flat" } | null;
  bidKind: "cpm" | "cpc";
  tone: "views" | "clicks";
  onOpenHistory: () => void;
}) {
  const graphRef = useRef<HTMLDivElement>(null);
  const [graphWidth, setGraphWidth] = useState(0);
  const palette = {
    views: {
      background: "bg-gradient-to-br from-[rgba(237,243,255,0.92)] to-[rgba(226,237,255,0.72)]",
      border: "border-[rgba(75,123,255,0.18)]",
      chart: "#3d82d8",
      affordance: "bg-white/78 text-[#3d82d8] shadow-[0_10px_24px_rgba(61,130,216,0.12)]",
    },
    clicks: {
      background: "bg-gradient-to-br from-[rgba(245,240,255,0.92)] to-[rgba(237,230,255,0.74)]",
      border: "border-[rgba(132,99,255,0.2)]",
      chart: "#7b61ff",
      affordance: "bg-white/78 text-[#7b61ff] shadow-[0_10px_24px_rgba(123,97,255,0.12)]",
    },
  } as const;
  const style = palette[tone];
  const changeText = change ? formatSignedBidMoney(change.delta, bidKind) : null;
  const compactPoints = graphWidth > 0 && points.length > 7 && graphWidth / points.length < 16;
  const visiblePoints = compactPoints ? points.slice(-7) : points;

  useEffect(() => {
    if (!graphRef.current || typeof ResizeObserver === "undefined") {
      return;
    }

    const node = graphRef.current;
    const updateWidth = () => {
      const nextWidth = Math.round(node.getBoundingClientRect().width);
      if (nextWidth > 0) {
        setGraphWidth((current) => (current !== nextWidth ? nextWidth : current));
      }
    };

    updateWidth();
    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={cn(
        "relative z-0 flex min-h-[60px] w-full flex-col gap-2 rounded-[14px] border p-3 text-left transition-[z-index] hover:z-40 focus-within:z-40",
        style.background,
        style.border,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="campaign-card-section-label truncate">{label}</span>
        <button
          type="button"
          onClick={onOpenHistory}
          aria-label={`${label}: открыть историю изменения ставки`}
          className={cn("overlay-open-button", style.affordance)}
        >
          <ArrowUpRight className="size-3.5" />
        </button>
      </div>
      <div className="flex min-w-0 items-end gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-1.5">
          <strong className="font-display text-[1.15rem] leading-none text-[var(--color-ink)]">{value}</strong>
          {change && change.direction !== "flat" && changeText ? (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-[0.8rem] font-bold leading-none",
                change.direction === "up" ? "text-rose-500" : "text-emerald-600",
              )}
            >
              {change.direction === "up" ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
              <span>{changeText}</span>
            </span>
          ) : null}
        </div>
        <div ref={graphRef} className="ml-auto flex h-[30px] min-w-0 flex-1 items-end justify-end">
          <Sparkline
            points={visiblePoints}
            stroke={style.chart}
            fill={style.chart}
            width={120}
            height={30}
            responsive
            formatValue={(pointValue) => formatBidMoney(pointValue, bidKind)}
          />
        </div>
      </div>
    </div>
  );
}

function CampaignBudgetProgressCard({
  label,
  current,
  total,
  tone,
  statusText,
  disabled = false,
  showDashTotalWhenDisabled = false,
  showDashPercentWhenDisabled = false,
  titleCase = false,
  className,
  action,
  details,
  tooltipDetails,
}: {
  label: string;
  current: number | string | null | undefined;
  total: number | string | null | undefined;
  tone: string;
  statusText?: string | null;
  disabled?: boolean;
  showDashTotalWhenDisabled?: boolean;
  showDashPercentWhenDisabled?: boolean;
  titleCase?: boolean;
  className?: string;
  action?: ReactNode;
  details?: ReactNode;
  tooltipDetails?: string[];
}) {
  const currentValue = toNumber(current);
  const totalValue = toNumber(total);
  const percent = currentValue !== null && totalValue !== null && totalValue > 0 ? (currentValue / totalValue) * 100 : null;
  const fillWidth = percent === null ? 0 : Math.max(currentValue && currentValue > 0 ? 6 : 0, Math.min(percent, 100));
  const shouldShowDashPercent = disabled && showDashPercentWhenDisabled;
  const percentText = shouldShowDashPercent ? "—" : percent !== null ? `${Math.round(percent)}%` : null;
  const currentText = formatMoney(currentValue, true);
  const shouldShowDashTotal = disabled && showDashTotalWhenDisabled;
  const totalText = !shouldShowDashTotal && totalValue !== null ? formatMoney(totalValue, true) : "—";
  const tooltipLabel = `${label}: ${currentText} из ${totalText}${percentText ? `, ${percentText}` : ""}`;
  const normalizedStatus = String(statusText || "").toLowerCase();
  const stateBadge = (() => {
    if (normalizedStatus.includes("не задан")) {
      return { label: "не задан", tone: "is-neutral", Icon: X };
    }
    if (normalizedStatus.includes("другие ограничители") || normalizedStatus.includes("част")) {
      return { label: "частично", tone: "is-partial", Icon: Minus };
    }
    if (normalizedStatus.includes("выключ")) {
      return { label: "выключен", tone: "is-off", Icon: Pause };
    }
    if (normalizedStatus.includes("включ") || normalizedStatus.includes("актив")) {
      return { label: "включён", tone: "is-on", Icon: Check };
    }
    return {
      label: disabled ? "выключен" : "включён",
      tone: disabled ? "is-off" : "is-on",
      Icon: disabled ? Pause : Check,
    };
  })();

  return (
    <div className={cn("campaign-budget-progress-card", tone, percent !== null && percent > 100 && "is-overflow", disabled && "is-disabled", titleCase && "is-title-case", className)}>
      <div className="campaign-budget-progress-head">
        <div className="campaign-budget-progress-top">
          <div className="campaign-budget-progress-copy">
            <span className="campaign-budget-progress-label campaign-card-section-label">{label}</span>
            {statusText ? <small className="campaign-budget-progress-status">{statusText}</small> : null}
          </div>
          <div className="campaign-budget-progress-top-side">
            <span
              className={cn("campaign-budget-progress-state-badge", stateBadge.tone)}
              title={stateBadge.label}
              aria-label={stateBadge.label}
            >
              <stateBadge.Icon className="size-3.5" aria-hidden="true" />
            </span>
            {action ? <div className="campaign-budget-progress-action">{action}</div> : null}
          </div>
        </div>
        <div className="campaign-budget-progress-side">
          <div className="campaign-budget-progress-values">
            {percentText ? <span className="campaign-budget-progress-percent">{percentText}</span> : null}
            <div className="campaign-budget-progress-primary">
              <strong className="campaign-budget-progress-current">{currentText}</strong>
              <span className="campaign-budget-progress-total">{!shouldShowDashTotal && totalValue !== null ? `/ ${totalText}` : "/ —"}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="campaign-budget-progress-shell">
        <div className="campaign-budget-progress-tooltip-shell" tabIndex={0} aria-label={tooltipLabel}>
          <div className="campaign-budget-progress-track">
            <span className="campaign-budget-progress-fill" style={{ width: `${fillWidth}%` }} />
          </div>
          <div className="campaign-budget-progress-tooltip" role="note" aria-hidden="true">
            <strong>{label}</strong>
            <span>{`${currentText} из ${totalText}`}</span>
            {statusText ? <span>{statusText}</span> : null}
            {percentText ? <span>{`Заполнение: ${percentText}`}</span> : null}
            {tooltipDetails?.map((detail, index) => (
              <span key={`${label}-tooltip-detail-${index}`}>{detail}</span>
            ))}
          </div>
        </div>
      </div>
      {details ? <div className="campaign-budget-progress-details">{details}</div> : null}
    </div>
  );
}

function SpendAccentCard({
  label,
  value,
  points,
  change,
}: {
  label: string;
  value: string;
  points: MetricSeriesPoint[];
  change: { delta: number; direction: "up" | "down" | "flat" } | null;
}) {
  const graphRef = useRef<HTMLDivElement>(null);
  const [graphWidth, setGraphWidth] = useState(0);
  const changeText = change ? formatSignedMoney(change.delta) : null;
  const compactPoints = graphWidth > 0 && points.length > 7 && graphWidth / points.length < 16;
  const visiblePoints = compactPoints ? points.slice(-7) : points;

  useEffect(() => {
    if (!graphRef.current || typeof ResizeObserver === "undefined") {
      return;
    }

    const node = graphRef.current;
    const updateWidth = () => {
      const nextWidth = Math.round(node.getBoundingClientRect().width);
      if (nextWidth > 0) {
        setGraphWidth((current) => (current !== nextWidth ? nextWidth : current));
      }
    };

    updateWidth();
    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={cn(
        "relative z-0 flex min-h-[60px] w-full flex-col gap-2 rounded-[14px] border p-3 text-left transition-[z-index] hover:z-40 focus-within:z-40",
        "border-[rgba(241,120,40,0.22)] bg-gradient-to-br from-[rgba(255,248,240,0.92)] to-[rgba(255,242,226,0.74)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="campaign-card-section-label truncate">{label}</span>
        <span aria-hidden="true" className="block h-7 w-7 shrink-0 opacity-0" />
      </div>
      <div className="flex min-w-0 items-end gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-1.5">
          <strong className="font-display text-[1.15rem] leading-none text-[var(--color-ink)]">{value}</strong>
          {change && change.direction !== "flat" && changeText ? (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-[0.8rem] font-bold leading-none",
                change.direction === "up" ? "text-rose-500" : "text-emerald-600",
              )}
            >
              {change.direction === "up" ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
              <span>{changeText}</span>
            </span>
          ) : null}
        </div>
        {visiblePoints.length ? (
          <div ref={graphRef} className="ml-auto flex h-[30px] min-w-0 flex-1 items-end justify-end">
            <Sparkline
              points={visiblePoints}
              stroke="#f17828"
              fill="#f17828"
              width={120}
              height={30}
              responsive
              formatValue={(pointValue) => formatMoney(pointValue, true)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BoardHintCard({
  share,
}: {
  share: ReturnType<typeof buildCampaignZoneShareData> | null;
}) {
  if (!share) {
    return <div className="min-h-[60px]" />;
  }

  return (
    <div className="campaign-zone-share">
      <div className="campaign-zone-share-bar">
        {share.items.map((item) => (
          <span
            key={`zone-share-${item.key}`}
            style={{ width: `${item.percent}%`, background: item.color }}
            className="campaign-zone-share-bar-segment"
          />
        ))}
      </div>
      <div className="campaign-zone-share-labels">
        {share.items.map((item) => (
          <span key={`zone-share-label-${item.key}`}>
            {item.label} {formatPercent(item.percent, 1)}
          </span>
        ))}
      </div>
    </div>
  );
}

function CampaignKeyTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone: string;
}) {
  return (
    <div className={cn("rounded-[20px] border px-4 py-4", tone)} style={{ borderColor: "var(--tone-border)", background: "var(--tone-bg)" }}>
      <div className="metric-level-list">
        <div className="metric-level">
          <p className="metric-level-label text-[0.78rem] font-medium leading-none text-[var(--color-muted)]">{label}</p>
          <div className="metric-level-value-row mt-2 flex flex-wrap items-baseline gap-1.5">
            <strong className="metric-level-value font-display text-[1.05rem] font-semibold leading-none text-[var(--color-ink)]">{value}</strong>
          </div>
        </div>
      </div>
    </div>
  );
}

function CampaignPerformanceBoard({
  campaign,
  compareCampaign,
}: {
  campaign: CampaignSummary;
  compareCampaign?: CampaignSummary | null;
}) {
  const current = buildCampaignMetrics(campaign);
  const previous = compareCampaign ? buildCampaignMetrics(compareCampaign) : null;
  const viewsZoneHint = buildCampaignZoneShareData(campaign, "views", current.views);
  const clicksZoneHint = buildCampaignZoneShareData(campaign, "clicks", current.clicks);
  const compareDiff = (currentValue: number | string | null | undefined, previousValue: number | string | null | undefined) => {
    if (!compareCampaign) {
      return null;
    }
    return diffValue(currentValue, previousValue);
  };
  const columns: Array<{
    stage: string;
    volume: BoardMetricCell;
    cost: BoardMetricCell;
    rate: BoardMetricCell;
    highlight: ReactNode | null;
  }> = [
    {
      stage: "Показы",
      volume: {
        label: "",
        value: formatBoardCount(current.views, true),
        delta: formatSignedNumber(compareDiff(current.views, previous?.views)),
        deltaGood: (compareDiff(current.views, previous?.views) ?? 0) >= 0,
        hint: null,
      },
      cost: {
        label: "CPM",
        value: formatMoney(current.cpm, true),
        delta: formatSignedMoney(compareDiff(current.cpm, previous?.cpm)),
        deltaGood: (compareDiff(current.cpm, previous?.cpm) ?? 0) <= 0,
      },
      rate: EMPTY_BOARD_CELL,
      highlight: <BoardHintCard share={viewsZoneHint} />,
    },
    {
      stage: "Клики",
      volume: {
        label: "",
        value: formatBoardCount(current.clicks),
        delta: formatSignedNumber(compareDiff(current.clicks, previous?.clicks)),
        deltaGood: (compareDiff(current.clicks, previous?.clicks) ?? 0) >= 0,
        hint: null,
      },
      cost: {
        label: "CPC",
        value: formatMoney(current.cpc, true),
        delta: formatSignedMoney(compareDiff(current.cpc, previous?.cpc)),
        deltaGood: (compareDiff(current.cpc, previous?.cpc) ?? 0) <= 0,
      },
      rate: {
        label: "CTR",
        value: formatBoardPercent(current.ctr),
        delta: formatSignedPercent(compareDiff(current.ctr, previous?.ctr)),
        deltaGood: (compareDiff(current.ctr, previous?.ctr) ?? 0) >= 0,
      },
      highlight: <BoardHintCard share={clicksZoneHint} />,
    },
    {
      stage: "Корзины",
      volume: {
        label: "",
        value: formatBoardCount(current.atbs),
        delta: formatSignedNumber(compareDiff(current.atbs, previous?.atbs)),
        deltaGood: (compareDiff(current.atbs, previous?.atbs) ?? 0) >= 0,
      },
      cost: {
        label: "CPL",
        value: formatMoney(current.cpl, true),
        delta: formatSignedMoney(compareDiff(current.cpl, previous?.cpl)),
        deltaGood: (compareDiff(current.cpl, previous?.cpl) ?? 0) <= 0,
      },
      rate: {
        label: "CR1",
        value: formatBoardPercent(current.cr1),
        delta: formatSignedPercent(compareDiff(current.cr1, previous?.cr1)),
        deltaGood: (compareDiff(current.cr1, previous?.cr1) ?? 0) >= 0,
      },
      highlight: (
        <DrrCard
          compareOnNewLine
          drr={{
            label: "ДРР корзин",
            value: current.drrAtbs,
            delta: compareDiff(current.drrAtbs, previous?.drrAtbs),
            points: current.drrAtbsSeries,
            tone: "basket",
          }}
        />
      ),
    },
    {
      stage: "Заказы",
      volume: {
        label: "",
        value: formatBoardCount(current.orders),
        delta: formatSignedNumber(compareDiff(current.orders, previous?.orders)),
        deltaGood: (compareDiff(current.orders, previous?.orders) ?? 0) >= 0,
      },
      cost: {
        label: "CPO",
        value: formatMoney(current.cpo, true),
        delta: formatSignedMoney(compareDiff(current.cpo, previous?.cpo)),
        deltaGood: (compareDiff(current.cpo, previous?.cpo) ?? 0) <= 0,
      },
      rate: {
        label: "CR2",
        value: formatBoardPercent(current.cr2),
        delta: formatSignedPercent(compareDiff(current.cr2, previous?.cr2)),
        deltaGood: (compareDiff(current.cr2, previous?.cr2) ?? 0) >= 0,
      },
      highlight: (
        <DrrCard
          compareOnNewLine
          drr={{
            label: "ДРР заказов (РК)",
            value: current.drrOrders,
            delta: compareDiff(current.drrOrders, previous?.drrOrders),
            points: current.drrOrdersSeries,
            tone: "ads-orders",
          }}
        />
      ),
    },
  ];
  const rowKeys = ["volume", "cost", "rate"] as const;

  return (
    <div className="relative overflow-visible rounded-[20px] border border-[var(--color-line)] bg-white">
      <div className="grid overflow-hidden rounded-t-[20px] border-b border-[var(--color-line)] bg-[var(--color-surface-soft)]" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))" }}>
        {columns.map((column, index) => (
          <div key={column.stage} className={cn("px-3 py-2", index > 0 && "border-l border-[var(--color-line)]")}>
            <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-muted)]">{column.stage}</span>
          </div>
        ))}
      </div>

      <div className="grid border-b border-[var(--color-line)]" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))" }}>
        {columns.map((column, index) => (
          <div key={`${column.stage}-highlight`} className={cn("p-2", index > 0 && "border-l border-[var(--color-line)]")}>
            {column.highlight ?? <div className="min-h-[60px]" />}
          </div>
        ))}
      </div>

      {rowKeys.map((rowKey, rowIndex) => (
        <div key={rowKey} className={cn("grid", rowIndex > 0 && "border-t border-[var(--color-line)]")} style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))" }}>
          {columns.map((column, index) => (
            <div key={`${column.stage}-${rowKey}`} className={cn(index > 0 && "border-l border-[var(--color-line)]")}>
              <PerformanceCell cell={column[rowKey]} compareOnNewLine />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ProductSignalCard({
  label,
  value,
  delta,
  valueClassName,
  hint,
  hintClassName,
  deltaClassName,
  className,
}: {
  label: string;
  value: ReactNode;
  delta?: string | null;
  valueClassName?: string;
  hint?: ReactNode;
  hintClassName?: string;
  deltaClassName?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("signal-item rounded-[18px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-1.5", className)}
      style={{ width: "100%", minHeight: "60px", display: "grid", alignContent: "center" }}
    >
      <div className="signal-copy gap-1.5">
        <span className="block text-xs leading-tight text-[var(--color-muted)]">{label}</span>
        <div className="flex flex-wrap items-baseline gap-1.5">
          <b className={cn("font-display text-[1.2rem] font-semibold leading-none text-[var(--color-ink)]", valueClassName)}>{value}</b>
          {delta ? <span className={cn("text-[0.88rem] font-semibold leading-none", deltaClassName)}>{`(${delta})`}</span> : null}
        </div>
        {hint ? <span className={cn("block text-[11px] leading-tight text-[var(--color-muted)]", hintClassName)}>{hint}</span> : null}
      </div>
    </div>
  );
}

function ProductOverviewIssuesCard({
  items,
  referenceEndDay,
}: {
  items: ProductOverviewErrorSummary[];
  referenceEndDay?: string | null;
}) {
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const itemsResetKey = useMemo(
    () => items.map((item) => `${item.id}:${item.days.map((day) => `${day.day}:${day.incidents}`).join("|")}`).join("||"),
    [items],
  );
  const yesterdayIssues = useMemo<ProductOverviewYesterdayIssue[]>(() => {
    const yesterday = shiftIsoDateString(referenceEndDay, -1);
    if (!yesterday) {
      return [];
    }
    return items
      .map((item) => {
        const day = item.days.find((entry) => entry.day === yesterday);
        if (!day) {
          return null;
        }
        return {
          id: `${item.id}-yesterday`,
          kind: item.kind,
          title: item.title,
          value: `${formatNumber(day.hours, 1)} ч`,
          meta: formatIssueStopCountLabel(day.incidents),
          note: day.estimatedGap !== null ? `≈ не хватило ${formatMoney(Math.round(day.estimatedGap), true)}` : day.note ?? null,
          recommendation: item.recommendation,
          day,
        };
      })
      .filter((item): item is ProductOverviewYesterdayIssue => Boolean(item));
  }, [items, referenceEndDay]);

  useEffect(() => {
    setExpandedItems({});
  }, [itemsResetKey]);

  return (
    <div className="product-overview-issues">
      {items.length ? (
        <div className="product-overview-issues-grid">
          {items.map((item) => (
            <div key={item.id} className={cn("product-overview-issue-card", `is-${item.kind}`)}>
              <div className="product-overview-issue-top">
                <span className="product-overview-issue-label">{item.title}</span>
                <strong className="product-overview-issue-value">{item.value}</strong>
              </div>
              <div className="product-overview-issue-meta">{item.meta}</div>
              {item.note ? <div className="product-overview-issue-note">{item.note}</div> : null}
              <div className="product-overview-issue-recommendation">{item.recommendation}</div>
              {item.days.length ? (
                <button
                  type="button"
                  className={cn("campaign-inline-issue-toggle", expandedItems[item.id] && "is-open")}
                  onClick={() =>
                    setExpandedItems((current) => ({
                      ...current,
                      [item.id]: !current[item.id],
                    }))
                  }
                >
                  <span>{expandedItems[item.id] ? "Скрыть по дням" : "Показать по дням"}</span>
                  <ChevronDown size={14} strokeWidth={2.2} />
                </button>
              ) : null}
              {item.days.length && expandedItems[item.id] ? <CampaignIssueDayBreakdownList days={item.days} /> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="product-overview-issue-empty">В выбранном окне нет простоев, бюджетных ошибок, лимитных остановок и конфликтов лимитов.</div>
      )}
      <div className="product-overview-yesterday">
        <div className="product-overview-yesterday-head">
          <span>Ошибки за вчера</span>
          <small>{shiftIsoDateString(referenceEndDay, -1) ?? "дата не определена"}</small>
        </div>
        {yesterdayIssues.length ? (
          <div className="product-overview-issues-grid">
            {yesterdayIssues.map((item) => (
              <div key={item.id} className={cn("product-overview-issue-card", `is-${item.kind}`)}>
                <div className="product-overview-issue-top">
                  <span className="product-overview-issue-label">{item.title}</span>
                  <strong className="product-overview-issue-value">{item.value}</strong>
                </div>
                <div className="product-overview-issue-meta">{item.meta}</div>
                {item.note ? <div className="product-overview-issue-note">{item.note}</div> : null}
                <div className="product-overview-issue-recommendation">{item.recommendation}</div>
                {item.day.statusSlots?.length ? <CampaignIssueDayBreakdownList days={[item.day]} className="product-overview-yesterday-breakdown" /> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="product-overview-issue-empty">За вчера ошибок не найдено.</div>
        )}
      </div>
    </div>
  );
}

function ProductDetailSummaryCard({
  sections,
}: {
  sections: Array<{
    label: string;
    value: ReactNode;
    delta?: string | null;
    deltaClassName?: string;
  }>;
}) {
  return (
    <div className="metric-tile rounded-[18px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-4 sm:px-5 sm:py-4">
      <div className="metric-level-list space-y-3.5">
        {sections.map((section, index) => (
          <div key={section.label} className="metric-level">
            <p className="metric-level-label text-[0.78rem] font-medium leading-none text-[var(--color-muted)] sm:text-[0.82rem]">{section.label}</p>
            <div className="metric-level-value-row mt-2 flex flex-wrap items-baseline gap-1.5">
              <strong className="metric-level-value font-display text-[0.95rem] font-semibold leading-none text-[var(--color-ink)] sm:text-[1.05rem]">{section.value}</strong>
              {section.delta ? <span className={cn("metric-level-delta text-[0.9rem] font-semibold leading-none", section.deltaClassName)}>{`(${section.delta})`}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PerformanceOverviewBoard({
  product,
  compareProduct,
}: {
  product: ProductSummary;
  compareProduct: ProductSummary | null;
}) {
  const current = buildBoardMetrics(product);
  const previous = compareProduct ? buildBoardMetrics(compareProduct) : null;

  const columns: Array<{
    stage: string;
    headerMetric?: BoardMetricCell | null;
    volume: BoardMetricCell;
    cost: BoardMetricCell;
    rate: BoardMetricCell;
    extra: BoardMetricCell;
    drr: BoardDrrCell | null;
  }> = [
    {
      stage: "Просмотры",
      headerMetric: null,
      volume: {
        label: "Просмотры",
        value: formatBoardCount(current.views, true),
        delta: formatSignedNumber(diffValue(current.views, previous?.views)),
        deltaGood: (diffValue(current.views, previous?.views) ?? 0) >= 0,
      },
      cost: {
        label: "CPM",
        value: formatMoney(current.cpm, true),
        delta: formatSignedMoney(diffValue(current.cpm, previous?.cpm)),
        deltaGood: (diffValue(current.cpm, previous?.cpm) ?? 0) <= 0,
      },
      rate: EMPTY_BOARD_CELL,
      extra: EMPTY_BOARD_CELL,
      drr: null,
    },
    {
      stage: "Клики",
      headerMetric: null,
      volume: {
        label: "Клики",
        value: formatBoardCount(current.clicks),
        delta: formatSignedNumber(diffValue(current.clicks, previous?.clicks)),
        deltaGood: (diffValue(current.clicks, previous?.clicks) ?? 0) >= 0,
      },
      cost: {
        label: "CPC",
        value: formatMoney(current.cpc, true),
        delta: formatSignedMoney(diffValue(current.cpc, previous?.cpc)),
        deltaGood: (diffValue(current.cpc, previous?.cpc) ?? 0) <= 0,
      },
      rate: {
        label: "CTR",
        value: formatBoardPercent(current.ctr),
        delta: formatSignedPercent(diffValue(current.ctr, previous?.ctr)),
        deltaGood: (diffValue(current.ctr, previous?.ctr) ?? 0) >= 0,
      },
      extra: EMPTY_BOARD_CELL,
      drr: null,
    },
    {
      stage: "Корзины",
      headerMetric: null,
      volume: {
        label: "Корзины",
        value: formatBoardCount(current.atbs),
        delta: formatSignedNumber(diffValue(current.atbs, previous?.atbs)),
        deltaGood: (diffValue(current.atbs, previous?.atbs) ?? 0) >= 0,
      },
      cost: {
        label: "CPL",
        value: formatMoney(current.cpl, true),
        delta: formatSignedMoney(diffValue(current.cpl, previous?.cpl)),
        deltaGood: (diffValue(current.cpl, previous?.cpl) ?? 0) <= 0,
      },
      rate: {
        label: "CR1",
        value: formatBoardPercent(current.cr1),
        delta: formatSignedPercent(diffValue(current.cr1, previous?.cr1)),
        deltaGood: (diffValue(current.cr1, previous?.cr1) ?? 0) >= 0,
      },
      extra: EMPTY_BOARD_CELL,
      drr: {
        label: "ДРР корзин",
        value: current.drrAtbs,
        delta: diffValue(current.drrAtbs, previous?.drrAtbs),
        points: current.drrAtbsSeries,
        tone: "basket",
      },
    },
    {
      stage: "Заказы (РК)",
      headerMetric: {
        label: "% с РК",
        value: formatBoardPercent(current.adsShare),
        delta: formatSignedPercent(diffValue(current.adsShare, previous?.adsShare)),
        deltaGood: (diffValue(current.adsShare, previous?.adsShare) ?? 0) >= 0,
      },
      volume: {
        label: "Заказы (РК)",
        value: formatBoardCount(current.ordersAds),
        delta: formatSignedNumber(diffValue(current.ordersAds, previous?.ordersAds)),
        deltaGood: (diffValue(current.ordersAds, previous?.ordersAds) ?? 0) >= 0,
      },
      cost: {
        label: "CPO (РК)",
        value: formatMoney(current.cpo, true),
        delta: formatSignedMoney(diffValue(current.cpo, previous?.cpo)),
        deltaGood: (diffValue(current.cpo, previous?.cpo) ?? 0) <= 0,
      },
      rate: {
        label: "CR2",
        value: formatBoardPercent(current.cr2),
        delta: formatSignedPercent(diffValue(current.cr2, previous?.cr2)),
        deltaGood: (diffValue(current.cr2, previous?.cr2) ?? 0) >= 0,
      },
      extra: {
        label: "Выручка (РК)",
        value: formatMoney(current.revenueAds, true),
        delta: formatSignedMoney(diffValue(current.revenueAds, previous?.revenueAds)),
        deltaGood: (diffValue(current.revenueAds, previous?.revenueAds) ?? 0) >= 0,
      },
      drr: {
        label: "ДРР заказов (РК)",
        value: current.drrOrdersAds,
        delta: diffValue(current.drrOrdersAds, previous?.drrOrdersAds),
        points: current.drrOrdersAdsSeries,
        tone: "ads-orders",
      },
    },
    {
      stage: "Заказы (всего)",
      headerMetric: null,
      volume: {
        label: "Заказы (всего)",
        value: formatBoardCount(current.totalOrders),
        delta: formatSignedNumber(diffValue(current.totalOrders, previous?.totalOrders)),
        deltaGood: (diffValue(current.totalOrders, previous?.totalOrders) ?? 0) >= 0,
      },
      cost: {
        label: "CPO (всего)",
        value: formatMoney(current.cpoOverall, true),
        delta: formatSignedMoney(diffValue(current.cpoOverall, previous?.cpoOverall)),
        deltaGood: (diffValue(current.cpoOverall, previous?.cpoOverall) ?? 0) <= 0,
      },
      rate: EMPTY_BOARD_CELL,
      extra: {
        label: "Выручка (всего)",
        value: formatMoney(current.revenueTotal, true),
        delta: formatSignedMoney(diffValue(current.revenueTotal, previous?.revenueTotal)),
        deltaGood: (diffValue(current.revenueTotal, previous?.revenueTotal) ?? 0) >= 0,
      },
      drr: {
        label: "ДРР заказов (всего)",
        value: current.drrOrdersTotal,
        delta: diffValue(current.drrOrdersTotal, previous?.drrOrdersTotal),
        points: current.drrOrdersTotalSeries,
        tone: "total-orders",
      },
    },
    {
      stage: "Ассоциированные заказы",
      headerMetric: null,
      volume: {
        label: "",
        value: "",
        inlineMetrics: [
          {
            label: "Доп. корзины",
            value: formatBoardCount(current.extraAtbs),
            delta: formatSignedNumber(diffValue(current.extraAtbs, previous?.extraAtbs)),
            deltaGood: (diffValue(current.extraAtbs, previous?.extraAtbs) ?? 0) >= 0,
          },
          {
            label: "Доп. заказы",
            value: formatBoardCount(current.extraOrders),
            delta: formatSignedNumber(diffValue(current.extraOrders, previous?.extraOrders)),
            deltaGood: (diffValue(current.extraOrders, previous?.extraOrders) ?? 0) >= 0,
          },
        ],
      },
      cost: EMPTY_BOARD_CELL,
      rate: EMPTY_BOARD_CELL,
      extra: {
        label: "Доп. выручка",
        value: formatMoney(current.extraRevenue, true),
        delta: formatSignedMoney(diffValue(current.extraRevenue, previous?.extraRevenue)),
        deltaGood: (diffValue(current.extraRevenue, previous?.extraRevenue) ?? 0) >= 0,
      },
      drr: null,
    },
  ];
  const rowKeys = ["volume", "cost", "rate", "extra"] as const;
  const boardGridTemplate = `repeat(${columns.length}, minmax(0,1fr))`;

  return (
    <div className="overflow-x-auto">
      <div className="relative min-w-[1320px] overflow-visible rounded-[20px] border border-[var(--color-line)] bg-white">
      <div className="hidden sm:block">
          <div className="grid overflow-hidden rounded-t-[20px] border-b border-[var(--color-line)] bg-[var(--color-surface-soft)]" style={{ gridTemplateColumns: boardGridTemplate }}>
            {columns.map((column, index) => (
              <div key={column.stage} className={cn("h-full px-3 py-2", index > 0 && "border-l border-[var(--color-line)]")}>
                <div className="flex h-full items-center justify-between gap-3">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-muted)]">{column.stage}</span>
                  {column.headerMetric ? (
                    <div className="rounded-[12px] bg-white/80 px-3 py-1.5 text-right shadow-[0_8px_18px_rgba(44,35,66,0.05)]">
                      <div className="flex flex-nowrap items-baseline justify-end gap-1 whitespace-nowrap">
                        <strong className="font-display text-[1rem] leading-none text-[var(--color-ink)]">{column.headerMetric.value}</strong>
                        {column.headerMetric.delta ? (
                          <span
                            className={cn(
                              "text-[11px] font-semibold leading-none",
                              column.headerMetric.deltaGood === undefined
                                ? "text-[var(--color-muted)]"
                                : column.headerMetric.deltaGood
                                  ? "text-emerald-600"
                                  : "text-rose-500",
                            )}
                          >
                            {`(${column.headerMetric.delta})`}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <div className="grid border-b border-[var(--color-line)]" style={{ gridTemplateColumns: boardGridTemplate }}>
            {columns.map((column, index) => (
              <div key={`${column.stage}-drr`} className={cn("p-2", index > 0 && "border-l border-[var(--color-line)]")}>
                {column.drr ? <DrrCard drr={column.drr} /> : <div className="min-h-[60px]" />}
              </div>
            ))}
          </div>

          {rowKeys.map((rowKey, rowIndex) => {
            const hasMeaningfulCells = columns.some((column) => column[rowKey].label || column[rowKey].value || column[rowKey].inlineMetrics?.length);
            if (!hasMeaningfulCells) {
              return null;
            }
            return (
              <div key={rowKey} className={cn("grid", rowIndex > 0 && "border-t border-[var(--color-line)]")} style={{ gridTemplateColumns: boardGridTemplate }}>
                {columns.map((column, index) => (
                  <div key={`${column.stage}-${rowKey}`} className={cn(index > 0 && "border-l border-[var(--color-line)]")}>
                    <PerformanceCell cell={column[rowKey]} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        <div className="divide-y divide-[var(--color-line)] sm:hidden">
          {columns.map((column) => (
            <div key={column.stage} className="p-3">
              <div className="mb-2 flex items-start justify-between gap-3">
                <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-brand-200)]">{column.stage}</span>
                {column.headerMetric ? (
                  <div className="text-right">
                    <div className="flex flex-nowrap items-baseline justify-end gap-1 whitespace-nowrap">
                      <strong className="font-display text-[1rem] leading-none text-[var(--color-ink)]">{column.headerMetric.value}</strong>
                      {column.headerMetric.delta ? (
                        <span
                          className={cn(
                            "text-[10px] font-semibold",
                            column.headerMetric.deltaGood === undefined
                              ? "text-[var(--color-muted)]"
                              : column.headerMetric.deltaGood
                                ? "text-emerald-600"
                                : "text-rose-500",
                          )}
                        >
                          {`(${column.headerMetric.delta})`}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="mb-2 grid grid-cols-2 gap-x-4 gap-y-2">
                {rowKeys
                  .filter((rowKey) => column[rowKey].label || column[rowKey].value || column[rowKey].hint || column[rowKey].inlineMetrics?.length)
                  .map((rowKey) => (
                    column[rowKey].inlineMetrics?.length ? (
                      <div key={rowKey} className="col-span-2">
                        <PerformanceCell cell={column[rowKey]} />
                      </div>
                    ) : (
                      <div key={rowKey}>
                        <span className="block text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{column[rowKey].label}</span>
                        <div className="flex flex-wrap items-baseline gap-1">
                          <strong className="font-display text-[1rem] text-[var(--color-ink)]">{column[rowKey].value}</strong>
                          {column[rowKey].delta ? <span className={cn("text-[10px] font-semibold", column[rowKey].deltaGood === undefined ? "text-[var(--color-muted)]" : column[rowKey].deltaGood ? "text-emerald-600" : "text-rose-500")}>({column[rowKey].delta})</span> : null}
                        </div>
                        {column[rowKey].hint ? <div className="mt-1 text-[10px] leading-tight text-[var(--color-muted)]">{column[rowKey].hint}</div> : null}
                      </div>
                    )
                  ))}
              </div>
              {column.drr ? <DrrCard drr={column.drr} /> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MetaPill({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "good" | "warn" | "bad" | "accent";
}) {
  const toneClass = {
    default: "border-[var(--color-line)] bg-[var(--color-surface-soft)] text-[var(--color-muted)]",
    good: "border-emerald-200 bg-emerald-50 text-emerald-700",
    warn: "border-amber-200 bg-amber-50 text-amber-700",
    bad: "border-rose-200 bg-rose-50 text-rose-700",
    accent: "border-[rgba(241,120,40,0.18)] bg-[var(--color-brand-100)] text-[var(--color-brand-200)]",
  } as const;

  return <span className={cn("inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", toneClass[tone])}>{children}</span>;
}

interface CampaignPillTickerItem {
  key: string;
  node: ReactNode;
}

function CampaignPillsTicker({
  items,
  className,
}: {
  items: CampaignPillTickerItem[];
  className?: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const itemsSignature = items.map((item) => item.key).join("|");

  useEffect(() => {
    const viewport = viewportRef.current;
    const measure = measureRef.current;
    if (!viewport || !measure) {
      return;
    }

    const syncOverflow = () => {
      setOverflowing(measure.scrollWidth - viewport.clientWidth > 6);
    };

    syncOverflow();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(syncOverflow);
    observer.observe(viewport);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [itemsSignature]);

  const content = items.map((item) => <Fragment key={item.key}>{item.node}</Fragment>);

  return (
    <div ref={viewportRef} className={cn("campaign-pills-marquee-shell", className)}>
      <div ref={measureRef} className="campaign-pills-marquee-measure campaign-card-head-pills is-nowrap">
        {content}
      </div>
      {overflowing ? (
        <Marquee
          className="campaign-pills-marquee-viewport"
          gradient={false}
          speed={28}
          pauseOnHover
          pauseOnClick
        >
          <div className="campaign-card-head-pills is-nowrap campaign-pills-marquee-track">{content}</div>
        </Marquee>
      ) : (
        <div className="campaign-card-head-pills is-nowrap">{content}</div>
      )}
    </div>
  );
}

function LegacySection({
  title,
  note,
  children,
  actions,
  titleActions,
  className,
}: {
  title: ReactNode;
  note?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  titleActions?: ReactNode;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const sectionBodyId = useId();
  const sectionLabel = typeof title === "string" ? title : "секцию";

  return (
    <section className={cn(SOFT_PANEL_CLASS, "relative p-4 sm:p-5", className)}>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={sectionBodyId}
        aria-label={collapsed ? `Развернуть ${sectionLabel}` : `Свернуть ${sectionLabel}`}
        onClick={() => setCollapsed((current) => !current)}
        className="absolute right-4 top-4 inline-flex size-10 items-center justify-center rounded-full bg-[var(--color-surface-soft)] text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)] sm:right-5 sm:top-5"
      >
        {collapsed ? <Plus className="size-4" /> : <Minus className="size-4" />}
      </button>
      <div className={cn("flex flex-wrap items-start justify-between gap-3 pr-12", collapsed ? "mb-0" : "mb-4")}>
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-display text-lg font-semibold text-[var(--color-ink)] sm:text-xl">{title}</h3>
            {titleActions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{titleActions}</div> : null}
          </div>
          {note ? <div className="text-sm text-[var(--color-muted)]">{note}</div> : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </div>
      {!collapsed ? <div id={sectionBodyId}>{children}</div> : null}
    </section>
  );
}

function SignalTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded-[18px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">{label}</p>
      <p className="mt-2 font-display text-xl font-semibold text-[var(--color-ink)]">{value}</p>
      {hint ? <p className="mt-1 text-xs text-[var(--color-muted)]">{hint}</p> : null}
    </div>
  );
}

function MiniMetric({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded-[18px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">{label}</p>
      <p className="mt-2 text-lg font-semibold text-[var(--color-ink)]">{value}</p>
      {hint ? <p className="mt-1 text-xs text-[var(--color-muted)]">{hint}</p> : null}
    </div>
  );
}

function FunnelTile({ product }: { product: ProductSummary }) {
  const totals = product.daily_totals || {};
  const views = toNumber(totals.views);
  const clicks = toNumber(totals.clicks);
  const atbs = toNumber(totals.atbs);
  const orders = toNumber(totals.orders);
  const steps = [
    { label: "Показы", value: views, hint: formatPercent(totals.CTR) },
    { label: "Клики", value: clicks, hint: formatMoney(totals.CPC, true) },
    { label: "Корзины", value: atbs, hint: formatPercent(totals.CR) },
    { label: "Заказы", value: orders, hint: formatMoney(totals.CPO, true) },
  ];

  return (
    <div className="rounded-[24px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <MetaPill tone="accent">Воронка</MetaPill>
        <MetaPill>{product.article}</MetaPill>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        {steps.map((step, index) => (
          <div key={step.label} className="relative rounded-[18px] border border-[var(--color-line)] bg-white px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">{step.label}</p>
            <p className="mt-2 text-xl font-semibold text-[var(--color-ink)]">{formatCompactNumber(step.value)}</p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">{step.hint}</p>
            {index < steps.length - 1 ? <span className="absolute -right-2 top-1/2 hidden -translate-y-1/2 text-[var(--color-line-strong)] sm:block">→</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductMetricsGrid({ product }: { product: ProductSummary }) {
  const totals = product.daily_totals || {};
  const revenueAds = toNumber(totals.sum_price);
  const revenueTotal = toNumber(totals.ordered_sum_total);
  const extraRevenue = toNumber(totals.rel_sum_price);
  const averageOrderValue = toNumber(totals.orders) ? Number(revenueAds || 0) / Number(totals.orders || 1) : null;

  return (
    <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.7fr)_repeat(3,minmax(0,1fr))]">
      <FunnelTile product={product} />
      <MiniMetric label="Выручка (РК)" value={formatMoney(revenueAds)} hint={`Ср. чек ${formatMoney(averageOrderValue)}`} />
      <MiniMetric label="Выручка (всего)" value={formatMoney(revenueTotal)} hint={`ДРР ${formatPercent(totals.DRR)}`} />
      <MiniMetric label="Доп. выручка" value={formatMoney(extraRevenue)} hint={`Доп. заказов ${formatNumber(totals.rel_shks)}`} />
    </div>
  );
}

function CampaignOverviewCard({
  campaign,
  compareCampaign,
  rangeStart,
  rangeEnd,
  chartCampaign,
  chartRangeStart,
  chartRangeEnd,
  campaignOverviewWindow,
  heatmapResponsiveResetKey,
  onCampaignOverviewWindowChange,
  onOpenBidHistory,
  onOpenBudgetHistory,
  onOpenChartsOverlay,
}: {
  campaign: CampaignSummary;
  compareCampaign?: CampaignSummary | null;
  rangeStart?: string | null;
  rangeEnd?: string | null;
  chartCampaign?: CampaignSummary | null;
  chartRangeStart?: string | null;
  chartRangeEnd?: string | null;
  campaignOverviewWindow: OverviewWindow;
  heatmapResponsiveResetKey?: string;
  onCampaignOverviewWindowChange: (value: OverviewWindow) => void;
  onOpenBidHistory: (campaign: CampaignSummary) => void;
  onOpenBudgetHistory: (campaign: CampaignSummary) => void;
  onOpenChartsOverlay: () => void;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const headShellRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const [headPinState, setHeadPinState] = useState<{
    mode: "static" | "fixed" | "bottom";
    height: number;
    width: number;
    left: number;
    top: number;
    absoluteTop: number;
    absoluteLeft: number;
  }>({
    mode: "static",
    height: 0,
    width: 0,
    left: 0,
    top: 0,
    absoluteTop: 0,
    absoluteLeft: 0,
  });
  const chartSourceCampaign = mergeCampaignChartSource(campaign, chartCampaign);
  const campaignSchedule = mapCampaignSchedule(campaign.schedule_config);
  const hasInlineHeatmap = campaignSchedule.days.some((day) => day.hours.length > 0);
  const spendLimit = resolveCampaignSpendLimit(campaign);
  const spendValue = toNumber(campaign.metrics.sum);
  const bidPlacement = resolveCampaignBidPlacement(campaign);
  const budgetRule = campaign.budget_rule_config ?? null;
  const budgetValue = toNumber(campaign.budget);
  const budgetLimit = toNumber(budgetRule?.limit);
  const budgetThreshold = toNumber(budgetRule?.threshold);
  const budgetDeposit = toNumber(budgetRule?.deposit);
  const latestCampaignDay = [...(campaign.daily_exact || [])].sort((left, right) => right.day.localeCompare(left.day))[0];
  const budgetSpentToday = toNumber(latestCampaignDay?.expense_sum);
  const campaignSpendToday = toNumber(campaign.spend?.DAY) ?? budgetSpentToday;
  const limitSpent = toNumber(spendLimit?.spent);
  const limitTotal = toNumber(spendLimit?.limit);
  const displayStatus = resolveCampaignDisplayStatus(campaign);
  const isBudgetRuleConfigured = Boolean(
    budgetRule &&
      (budgetRule.limit !== null ||
        budgetRule.threshold !== null ||
        budgetRule.deposit !== null ||
        budgetRule.history_count > 0 ||
        budgetRule.status ||
        budgetRule.error),
  );
  const isBudgetRuleEnabled = Boolean(budgetRule?.active);
  const isSpendLimitEnabled = Boolean(spendLimit?.active);
  const limitCardCurrent = isSpendLimitEnabled ? limitSpent ?? campaignSpendToday : campaignSpendToday;
  const limitCardTotal = isSpendLimitEnabled ? limitTotal : isBudgetRuleEnabled ? budgetLimit : limitTotal;
  const limitCardPercent =
    limitCardCurrent !== null && limitCardTotal !== null && limitCardTotal > 0 ? (limitCardCurrent / limitCardTotal) * 100 : null;
  const budgetPercent = budgetSpentToday !== null && budgetLimit !== null && budgetLimit > 0 ? (budgetSpentToday / budgetLimit) * 100 : null;
  const budgetTooltipDetails = [
    budgetValue !== null ? `Текущий бюджет: ${formatMoney(budgetValue, true)}` : null,
    budgetDeposit !== null ? `Пополнение: ${formatMoney(budgetDeposit, true)}` : null,
    budgetThreshold !== null ? `При остатке: ${formatMoney(budgetThreshold, true)}` : null,
  ].filter((detail): detail is string => Boolean(detail));
  const budgetRuleStatus = isBudgetRuleConfigured
    ? isBudgetRuleEnabled
      ? "правило активно"
      : "правило выключено"
    : "не задано";
  const spendLimitStatus = spendLimit
    ? isSpendLimitEnabled
      ? `включён · ${formatSpendLimitPeriodLabel(spendLimit.period)}`
      : `выключен · ${formatSpendLimitPeriodLabel(spendLimit.period)}`
    : isBudgetRuleEnabled
      ? "по бюджету"
      : "не задан";
  const limitForecastHours =
    displayStatus.key !== "freeze" ? buildCampaignRemainingActivityForecastHours(campaign, limitCardCurrent ?? 0, limitCardTotal) : null;
  const limitForecastLabel = formatCampaignRemainingActivityForecast(limitForecastHours);
  const statusClass = resolveCampaignStatusOutline(displayStatus.key);
  const bidKind = resolveBidKind(campaign);
  const bidTypeLabel = bidKind === "cpc" ? "CPC" : "CPM";
  const bidModeLabel = resolveCampaignBidModeLabel(campaign);
  const zoneBadges = resolveCampaignZoneBadges(campaign);
  const headPillItems: CampaignPillTickerItem[] = [];
  headPillItems.push({ key: `bid-type-${campaign.id}`, node: <MetaPill>{bidTypeLabel}</MetaPill> });
  headPillItems.push({ key: `bid-mode-${campaign.id}`, node: <MetaPill>{bidModeLabel}</MetaPill> });
  if (campaign.schedule_config?.schedule_active) {
    headPillItems.push({ key: `schedule-${campaign.id}`, node: <MetaPill tone="accent">Расписание</MetaPill> });
  }
  const statusDays = buildCampaignStatusDays(
    chartSourceCampaign,
    chartRangeStart ?? rangeStart,
    chartRangeEnd ?? rangeEnd,
  );
  const visibleIssueStatusDays =
    statusDays.length > campaignOverviewWindow
      ? statusDays.slice(statusDays.length - campaignOverviewWindow)
      : statusDays;
  const hasBudgetHistory = campaign.budget_history.length > 0;
  const spendSeries = buildCampaignSpendSeries(chartSourceCampaign);
  const spendChange = buildMetricSeriesChange(spendSeries);
  const isHeadFloating = headPinState.mode !== "static";
  const campaignHeadStyle: CSSProperties | undefined =
    headPinState.mode === "fixed"
      ? {
          position: "fixed",
          top: `${headPinState.top}px`,
          left: `${headPinState.left}px`,
          width: `${headPinState.width}px`,
          zIndex: 420,
        }
      : headPinState.mode === "bottom"
        ? {
            position: "absolute",
            top: `${headPinState.absoluteTop}px`,
            left: `${headPinState.absoluteLeft}px`,
            width: `${headPinState.width}px`,
            zIndex: 120,
          }
        : undefined;

  useEffect(() => {
    if (typeof window === "undefined" || !cardRef.current || !headShellRef.current || !headRef.current) {
      return undefined;
    }

    const card = cardRef.current;
    const shell = headShellRef.current;
    const head = headRef.current;
    let frame = 0;

    const resolveStickyTop = () => {
      const varsSource = (card.closest(".page-viewport") as HTMLElement | null) ?? document.documentElement;
      const styles = window.getComputedStyle(varsSource);
      const topNav = Number.parseFloat(styles.getPropertyValue("--top-nav-height")) || 76;
      const tabBar = Number.parseFloat(styles.getPropertyValue("--product-tabbar-height")) || 58;
      return topNav + tabBar;
    };

    const update = () => {
      frame = 0;
      const cardRect = card.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const headRect = head.getBoundingClientRect();
      const cardStyles = window.getComputedStyle(card);
      const bodyZoom = Number.parseFloat(window.getComputedStyle(document.body).zoom);
      const zoom =
        Number.isFinite(bodyZoom) && bodyZoom > 0
          ? bodyZoom
          : shell.offsetWidth > 0 && shellRect.width > 0
            ? shellRect.width / shell.offsetWidth
            : 1;
      const roundMetric = (value: number) => Math.round(value * 100) / 100;
      const stickyTopVisual = resolveStickyTop();
      const paddingTop = Number.parseFloat(cardStyles.paddingTop) || 0;
      const paddingLeft = Number.parseFloat(cardStyles.paddingLeft) || 0;
      const paddingBottom = Number.parseFloat(cardStyles.paddingBottom) || 0;
      const paddingBottomVisual = paddingBottom * zoom;
      const headHeightVisual = Math.ceil(headRect.height);
      const headHeight = head.offsetHeight || Math.ceil(headHeightVisual / zoom);
      const width = roundMetric(shellRect.width / zoom);
      const left = roundMetric(shellRect.left / zoom);
      const stickyTop = roundMetric(stickyTopVisual / zoom);
      const absoluteTop = roundMetric(Math.max(paddingTop, card.clientHeight - paddingBottom - headHeight));
      const absoluteLeft = roundMetric(paddingLeft);

      let mode: "static" | "fixed" | "bottom" = "static";
      if (cardRect.top <= stickyTopVisual) {
        mode = cardRect.bottom - paddingBottomVisual - headHeightVisual <= stickyTopVisual ? "bottom" : "fixed";
      }

      setHeadPinState((current) => {
        if (
          current.mode === mode &&
          current.height === headHeight &&
          current.width === width &&
          current.left === left &&
          current.top === stickyTop &&
          current.absoluteTop === absoluteTop &&
          current.absoluteLeft === absoluteLeft
        ) {
          return current;
        }

        return {
          mode,
          height: headHeight,
          width,
          left,
          top: stickyTop,
          absoluteTop,
          absoluteLeft,
        };
      });
    };

    const scheduleUpdate = () => {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    window.visualViewport?.addEventListener("resize", scheduleUpdate);
    window.visualViewport?.addEventListener("scroll", scheduleUpdate);

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleUpdate) : null;
    observer?.observe(card);
    observer?.observe(shell);
    observer?.observe(head);

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.visualViewport?.removeEventListener("resize", scheduleUpdate);
      window.visualViewport?.removeEventListener("scroll", scheduleUpdate);
      observer?.disconnect();
    };
  }, [campaign.id, campaign.name]);

  return (
    <article ref={cardRef} className={cn("campaign-card tone-good rounded-[28px] border", statusClass)}>
      <div ref={headShellRef} className="campaign-card-head-shell" style={headPinState.height ? { minHeight: `${headPinState.height}px` } : undefined}>
        <div ref={headRef} className={cn("campaign-card-head", isHeadFloating && "is-floating")} style={campaignHeadStyle}>
          <div className="campaign-card-head-copy">
            <div className="campaign-card-head-top">
              <CampaignPillsTicker items={headPillItems} />
              <div className="campaign-card-head-top-side">
                <div className="campaign-card-meta-side is-inline">
                  <span className="campaign-card-meta-side-line">WB ID {campaign.wb_id}</span>
                  <span className="campaign-card-meta-side-line">{campaign.query_main || "ключевая фраза не задана"}</span>
                </div>
                <CampaignStatusIconBadge campaign={campaign} />
              </div>
            </div>
            <div className="campaign-card-group">
              <div className="campaign-card-title-row">
                <div className="campaign-card-title-wrap">
                  <h4 className="font-display font-semibold text-[var(--color-ink)]">{campaign.name}</h4>
                </div>
                <div className="campaign-card-side-stack">
                  {zoneBadges.length ? (
                    <div className="campaign-zone-row is-inline-title is-side-stack">
                      <div className="campaign-zone-list">
                        {zoneBadges.map((zone) => {
                          const Icon = zone.icon;
                          return (
                            <span key={`${campaign.id}-${zone.key}`} className="campaign-zone-pill">
                              <Icon className="size-3.5" />
                              {zone.label}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {hasInlineHeatmap ? (
        <div className="campaign-inline-heatmap is-compact is-inline-row">
          <div className="campaign-inline-heatmap-head">
            <div className="campaign-inline-heatmap-copy">
              <span className="campaign-inline-heatmap-title campaign-card-section-label">Heatmap РК</span>
              <small className="campaign-inline-heatmap-note">Показы по дням и часам</small>
            </div>
            <CampaignScheduleStatusBadge
              active={Boolean(campaign.schedule_config?.schedule_active)}
              className="campaign-inline-heatmap-status-badge"
            />
          </div>
          <ScheduleMatrix schedule={campaignSchedule} compact showCounts={false} responsiveResetKey={heatmapResponsiveResetKey} />
        </div>
      ) : null}

      <div className="campaign-budget-grid">
        <div className="grid gap-2 sm:grid-cols-2">
          <CampaignBudgetProgressCard
            label="Бюджет"
            current={budgetSpentToday}
            total={budgetLimit}
            tone={resolveUsageTone(budgetPercent)}
            statusText={budgetRuleStatus}
            disabled={!isBudgetRuleEnabled}
            action={
              hasBudgetHistory ? (
                <button
                  type="button"
                  onClick={() => onOpenBudgetHistory(campaign)}
                  aria-label="Открыть логи пополнений бюджета"
                  className="overlay-open-button"
                >
                  <ArrowUpRight className="size-3.5" />
                </button>
              ) : undefined
            }
            tooltipDetails={budgetTooltipDetails}
            details={
              budgetValue !== null ? (
                <div className="campaign-budget-progress-meta-row">
                  <span>Текущий бюджет</span>
                  <strong>{formatMoney(budgetValue, true)}</strong>
                </div>
              ) : null
            }
          />
          <CampaignBudgetProgressCard
            label="Лимит трат"
            current={limitCardCurrent}
            total={limitCardTotal}
            tone={resolveUsageTone(limitCardPercent)}
            statusText={spendLimitStatus}
            disabled={!isSpendLimitEnabled && !isBudgetRuleEnabled}
            details={
              limitForecastLabel ? (
                <div className="campaign-budget-progress-meta-row">
                  <span>Примерно до лимита</span>
                  <strong>{limitForecastLabel}</strong>
                </div>
              ) : null
            }
          />
        </div>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <SpendAccentCard
          label="Расход"
          value={formatMoney(spendValue, true)}
          points={spendSeries}
          change={spendChange}
        />
        <BidAccentCard
          label={resolveCampaignBidLabel(campaign)}
          value={formatBidMoney(campaign.bid, bidKind)}
          points={buildCampaignBidSeries(campaign)}
          change={buildCampaignBidChange(campaign)}
          bidKind={bidKind}
          tone={bidPlacement === "clicks" ? "clicks" : "views"}
          onOpenHistory={() => onOpenBidHistory(campaign)}
        />
      </div>

      <div className="mt-3">
        <CampaignPerformanceBoard campaign={campaign} compareCampaign={compareCampaign} />
      </div>

      <div className="mt-3">
        <CampaignInlineOverviewChart
          campaign={chartSourceCampaign}
          statusDays={statusDays}
          activeWindow={campaignOverviewWindow}
          onActiveWindowChange={onCampaignOverviewWindowChange}
          headerAction={
            <button
              type="button"
              onClick={onOpenChartsOverlay}
              aria-label="Открыть все графики РК в расширенном окне"
              title="Открыть все графики РК"
              className="overlay-open-button is-chart-window-control"
            >
              <Maximize2 className="size-3.5" />
            </button>
          }
        />
      </div>

      <CampaignInlineIssuesPanel campaign={chartSourceCampaign} campaignId={campaign.id} statusDays={visibleIssueStatusDays} className="mt-3" />
    </article>
  );
}

function CampaignDisplayControls({
  campaigns,
  selectedIds,
  onToggle,
  inline = false,
}: {
  campaigns: CampaignSummary[];
  selectedIds: number[];
  onToggle: (campaignId: number) => void;
  inline?: boolean;
}) {
  if (campaigns.length <= 1) {
    return null;
  }

  return (
    <div className={cn("campaign-display-controls", inline && "is-inline-title")}>
      {campaigns.map((campaign) => {
        const visible = selectedIds.includes(campaign.id);
        const label = resolveCampaignVisibilityPillLabel(campaign);
        const mainLabel = resolveCampaignVisibilityPillMainLabel(campaign);
        const zones = resolveCampaignZoneBadges(campaign);

        return (
          <button
            key={`campaign-visibility-${campaign.id}`}
            type="button"
            aria-pressed={visible}
            onClick={() => onToggle(campaign.id)}
            className={cn("campaign-visibility-pill", !visible && "is-hidden")}
            title={`${campaign.name} · ${label}`}
          >
            <CampaignStatusIconBadge campaign={campaign} className="campaign-visibility-pill-status" />
            <span className="campaign-visibility-pill-label">{mainLabel}</span>
            {zones.length ? (
              <span className="campaign-visibility-pill-zones" aria-hidden="true">
                {zones.map((zone) => {
                  const ZoneIcon = zone.icon;
                  return (
                    <span key={`campaign-visibility-${campaign.id}-${zone.key}`} className="campaign-visibility-pill-zone-icon">
                      <ZoneIcon className="size-3" />
                    </span>
                  );
                })}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function renderOverview(
  product: ProductSummary,
  overviewErrorSummaries: ProductOverviewErrorSummary[],
  overviewErrorsWindow: OverviewWindow,
  onOverviewErrorsWindowChange: (value: OverviewWindow) => void,
  selectedCampaignIds: number[],
  onToggleVisibleCampaign: (campaignId: number) => void,
  onOpenBidHistory: (campaign: CampaignSummary) => void,
  onOpenBudgetHistory: (campaign: CampaignSummary) => void,
  compareProduct?: ProductSummary | null,
  chartProduct?: ProductSummary | null,
  overviewChartsWindow?: OverviewWindow,
  onOverviewChartsWindowChange?: (value: OverviewWindow) => void,
  onOpenOverviewChartsOverlay?: () => void,
  campaignOverviewWindow?: OverviewWindow,
  onCampaignOverviewWindowChange?: (value: OverviewWindow) => void,
  onOpenCampaignChartsOverlay?: () => void,
) {
  const chartSourceProduct = chartProduct?.article === product.article ? chartProduct : product;
  const activeCampaigns = product.campaigns.filter((campaign) => isCampaignActive(campaign.status)).length;
  const scheduledCampaigns = product.campaigns.filter((campaign) => campaign.schedule_config?.schedule_active).length;
  const visibleCampaignIds = buildVisibleCampaignIds(product.campaigns, selectedCampaignIds);
  const campaignHeatmapResponsiveResetKey = visibleCampaignIds.join(",") || "none";
  const chartCampaignById = new Map(chartSourceProduct.campaigns.map((campaign) => [campaign.id, campaign]));
  const visibleCampaigns = visibleCampaignIds
    .map((campaignId) => product.campaigns.find((campaign) => campaign.id === campaignId) || null)
    .filter((campaign): campaign is CampaignSummary => Boolean(campaign));

  return (
    <div className="space-y-4">
      <LegacySection
        title="Ошибки"
        note={overviewErrorSummaries.length ? "простои, остановки и конфликтующие ограничения" : "в текущем окне ошибок не найдено"}
        actions={<ChartWindowSwitch activeWindow={overviewErrorsWindow} onChange={onOverviewErrorsWindowChange} />}
      >
        <ProductOverviewIssuesCard items={overviewErrorSummaries} referenceEndDay={product.period.current_end} />
      </LegacySection>

      <LegacySection
        title="Графики"
        note={formatDateRange(product.period.current_start, product.period.current_end)}
        actions={
          onOpenOverviewChartsOverlay ? (
            <button
              type="button"
              onClick={onOpenOverviewChartsOverlay}
              aria-label="Открыть все графики товара в расширенном окне"
              title="Открыть все графики товара"
              className="overlay-open-button is-chart-window-control"
            >
              <Maximize2 className="size-3.5" />
            </button>
          ) : undefined
        }
      >
        <ProductOverviewCharts
          product={chartSourceProduct}
          activeWindow={overviewChartsWindow ?? resolveOverviewWindow(product.period.span_days)}
          onActiveWindowChange={onOverviewChartsWindowChange}
        />
      </LegacySection>

      <LegacySection
        title="Рекламные кампании"
        note={`${formatNumber(product.campaigns.length)} кампаний в товаре`}
        titleActions={<CampaignDisplayControls campaigns={product.campaigns} selectedIds={visibleCampaignIds} onToggle={onToggleVisibleCampaign} inline />}
        actions={
          <>
            <MetaPill tone="good">Активных {formatNumber(activeCampaigns)}</MetaPill>
            <MetaPill tone="accent">С расписанием {formatNumber(scheduledCampaigns)}</MetaPill>
          </>
        }
      >
        {product.campaigns.length ? (
          <div className="campaign-list-shell">
            {!visibleCampaigns.length ? (
              <div className="rounded-[18px] border border-dashed border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-5 text-sm text-[var(--color-muted)]">
                Все рекламные кампании скрыты. Нажмите на плашку типа РК сверху, чтобы вернуть её в отображение.
              </div>
            ) : null}
            <div className={cn("campaign-list grid gap-4", visibleCampaigns.length === 2 ? "is-compare-pair" : "is-fluid")}>
              {visibleCampaigns.map((campaign) => (
                <CampaignOverviewCard
                  key={campaign.id}
                  campaign={campaign}
                  compareCampaign={resolveCompareCampaign(campaign, compareProduct)}
                  rangeStart={product.period.current_start}
                  rangeEnd={product.period.current_end}
                  chartCampaign={chartCampaignById.get(campaign.id) || null}
                  chartRangeStart={chartSourceProduct.period.current_start}
                  chartRangeEnd={chartSourceProduct.period.current_end}
                  campaignOverviewWindow={campaignOverviewWindow ?? resolveOverviewWindow(product.period.span_days)}
                  heatmapResponsiveResetKey={campaignHeatmapResponsiveResetKey}
                  onCampaignOverviewWindowChange={onCampaignOverviewWindowChange ?? (() => undefined)}
                  onOpenBidHistory={onOpenBidHistory}
                  onOpenBudgetHistory={onOpenBudgetHistory}
                  onOpenChartsOverlay={onOpenCampaignChartsOverlay ?? (() => undefined)}
                />
              ))}
            </div>
          </div>
        ) : (
          <EmptyState title="Кампании не найдены" text="У выбранного товара сейчас нет кампаний в текущем периоде." />
        )}
      </LegacySection>
    </div>
  );
}

type DailyTableView = "daily" | "analytics";
type AnalyticsSectionView = "daily" | "hours";

function ProductDailyPanel({ product }: { product: ProductSummary }) {
  const [sectionView, setSectionView] = useState<AnalyticsSectionView>("daily");
  const [tableView, setTableView] = useState<DailyTableView>("daily");
  const days = dailyRowsNewestFirst(product.daily_stats);
  const productAverageCheck = useMemo(() => buildBoardMetrics(product).averageCheck, [product]);
  const initialPreset = resolveHoursSectionPreset(product.period.span_days);
  const [windowPreset, setWindowPreset] = useState<HoursSectionWindowPreset>(initialPreset);
  const [hoursProduct, setHoursProduct] = useState<ProductSummary>(product);
  const [isHoursLoading, setIsHoursLoading] = useState(false);
  const hoursContextKey = `${product.article}:${product.period.current_start || ""}:${product.period.current_end || ""}`;
  const requestedRange = useMemo(
    () => resolveHoursSectionRange(product.period.current_end, windowPreset),
    [product.period.current_end, windowPreset],
  );
  const baseRangeKey = `${product.article}:${product.period.current_start || ""}:${product.period.current_end || ""}`;
  const requestedRangeKey = `${product.article}:${requestedRange.start}:${requestedRange.end}`;
  const hoursCacheRef = useRef<Map<string, ProductSummary>>(new Map());
  const hoursFetchAbortRef = useRef<AbortController | null>(null);
  const hoursFetchKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setSectionView("daily");
    setTableView("daily");
  }, [product.article, product.period.current_start, product.period.current_end]);

  useEffect(() => {
    hoursCacheRef.current.set(baseRangeKey, product);
  }, [baseRangeKey, product]);

  useEffect(() => {
    hoursFetchAbortRef.current?.abort();
    hoursFetchAbortRef.current = null;
    hoursFetchKeyRef.current = null;
    setWindowPreset(resolveHoursSectionPreset(product.period.span_days));
    setHoursProduct(product);
    setIsHoursLoading(false);
  }, [hoursContextKey, product]);

  useEffect(
    () => () => {
      hoursFetchAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (requestedRange.start === product.period.current_start && requestedRange.end === product.period.current_end) {
      hoursFetchAbortRef.current?.abort();
      hoursFetchAbortRef.current = null;
      hoursFetchKeyRef.current = null;
      setHoursProduct(product);
      setIsHoursLoading(false);
      return;
    }

    const cachedProduct = hoursCacheRef.current.get(requestedRangeKey);
    if (cachedProduct) {
      hoursFetchAbortRef.current?.abort();
      hoursFetchAbortRef.current = null;
      hoursFetchKeyRef.current = null;
      setHoursProduct(cachedProduct);
      setIsHoursLoading(false);
      return;
    }

    const controller = new AbortController();
    hoursFetchAbortRef.current?.abort();
    hoursFetchAbortRef.current = controller;
    hoursFetchKeyRef.current = requestedRangeKey;
    setIsHoursLoading(true);

    fetchProducts({
      articles: [product.article],
      start: requestedRange.start,
      end: requestedRange.end,
      campaignMode: "full",
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) {
          return;
        }
        const nextProduct = response.products.find((item) => item.article === product.article) ?? null;
        if (!nextProduct) {
          return;
        }
        hoursCacheRef.current.set(requestedRangeKey, nextProduct);
        setHoursProduct(nextProduct);
      })
      .catch(() => {
        // Keep the currently visible content on screen if the local fetch fails.
      })
      .finally(() => {
        if (hoursFetchAbortRef.current === controller) {
          hoursFetchAbortRef.current = null;
        }
        if (hoursFetchKeyRef.current === requestedRangeKey) {
          hoursFetchKeyRef.current = null;
        }
        if (!controller.signal.aborted) {
          setIsHoursLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [
    product,
    product.article,
    product.period.current_end,
    product.period.current_start,
    requestedRange.end,
    requestedRange.start,
    requestedRangeKey,
  ]);

  const hoursSourceProduct = hoursProduct.article === product.article ? hoursProduct : product;
  const ordersByHour = new Map(hoursSourceProduct.orders_heatmap.by_hour.map((row) => [row.hour, row.orders]));
  const hourlyRows = hoursSourceProduct.heatmap.by_hour.map((row) => ({
    hour: `${row.hour}:00`,
    avgStock: null,
    views: row.views,
    clicks: row.clicks,
    spent: row.spent,
    atbs: null,
    ctr: row.CTR,
    cr: computeRate(ordersByHour.get(row.hour) ?? 0, row.views),
    cpc: row.CPC,
    orders: ordersByHour.get(row.hour) ?? 0,
    orderedTotal: ordersByHour.get(row.hour) ?? 0,
    sumPrice:
      productAverageCheck !== null && productAverageCheck > 0 && (ordersByHour.get(row.hour) ?? 0) > 0
        ? (ordersByHour.get(row.hour) ?? 0) * productAverageCheck
        : null,
  }));

  const analyticsRows: Array<{
    key: string;
    label: string;
    renderValue: (day: DailyStat) => ReactNode;
  }> = [
    { key: "ordered_sum_total", label: "Общая сумма заказов", renderValue: (day) => formatMoney(day.ordered_sum_total) },
    { key: "ordered_total", label: "Общее кол-во заказов", renderValue: (day) => formatNumber(day.ordered_total) },
    { key: "avg_stock", label: "Средний остаток", renderValue: (day) => formatNumber(day.avg_stock) },
    { key: "views", label: "Показов", renderValue: (day) => formatNumber(day.views) },
    { key: "clicks", label: "Кликов", renderValue: (day) => formatNumber(day.clicks) },
    { key: "expense_sum", label: "Расход", renderValue: (day) => formatMoney(day.expense_sum, true) },
    { key: "atbs", label: "Корзин с рекламы", renderValue: (day) => formatNumber(day.atbs) },
    { key: "sum_price", label: "Заказано с рекламы, руб.", renderValue: (day) => formatMoney(day.sum_price) },
    { key: "orders", label: "Заказано с рекламы, шт.", renderValue: (day) => formatNumber(day.orders) },
    { key: "drr", label: "ДРР", renderValue: (day) => formatPercent(day.DRR) },
    {
      key: "cpo_overall",
      label: "Общий CPO",
      renderValue: (day) => formatMoney(day.CPO_overall ?? computeMoneyPer(day.expense_sum, day.ordered_total), true),
    },
    { key: "ctr", label: "CTR", renderValue: (day) => formatPercent(day.CTR) },
    { key: "cpc", label: "CPC", renderValue: (day) => formatMoney(day.CPC, true) },
    { key: "cr", label: "CR", renderValue: (day) => formatPercent(computeRate(day.ordered_total, day.views)) },
    { key: "crf", label: "CRF", renderValue: (day) => formatPercent(day.CR) },
    { key: "cpo", label: "CPO", renderValue: (day) => formatMoney(day.CPO, true) },
  ];

  return (
    <LegacySection
      title="Аналитика"
      note={
        sectionView === "hours"
          ? `${formatDateRange(requestedRange.start, requestedRange.end)} · heatmap и расписание`
          : `${formatDateRange(product.period.current_start, product.period.current_end)} · ${formatNumber(days.length)} строк`
      }
      titleActions={
        <div className="chart-window-switch" aria-label="Вид раздела аналитики">
          <button
            type="button"
            onClick={() => setSectionView("daily")}
            className={sectionView === "daily" ? "chart-window-chip is-active" : "chart-window-chip"}
          >
            По дням
          </button>
          <button
            type="button"
            onClick={() => setSectionView("hours")}
            className={sectionView === "hours" ? "chart-window-chip is-active" : "chart-window-chip"}
          >
            По часам
          </button>
        </div>
      }
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {sectionView === "hours" ? (
            <>
              {isHoursLoading ? <MetaPill tone="accent">Догружаю</MetaPill> : null}
              <div className="chart-window-switch" aria-label="Окно раздела По часам">
                {HOURS_SECTION_WINDOWS.map((window) => (
                  <button
                    key={window.value}
                    type="button"
                    onClick={() => setWindowPreset(window.value)}
                    className={windowPreset === window.value ? "chart-window-chip is-active" : "chart-window-chip"}
                  >
                    {window.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      }
    >
      {sectionView === "daily" ? (
        days.length ? (
          <div className="space-y-4">
            <div className="rounded-[24px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] p-3">
              <DailyPerformanceChart rows={product.daily_stats} />
            </div>
            <div className="flex justify-end">
              <div className="chart-window-switch" aria-label="Вид таблицы аналитики по дням">
                <button
                  type="button"
                  onClick={() => setTableView("daily")}
                  className={tableView === "daily" ? "chart-window-chip is-active" : "chart-window-chip"}
                >
                  По дням
                </button>
                <button
                  type="button"
                  onClick={() => setTableView("analytics")}
                  className={tableView === "analytics" ? "chart-window-chip is-active" : "chart-window-chip"}
                >
                  Аналитика
                </button>
              </div>
            </div>
            {tableView === "daily" ? (
              <MetricTable
                rows={days}
                emptyText="За выбранный период дневных строк не пришло."
                columns={[
                  { key: "day", header: "Дата", render: (row) => row.day_label },
                  { key: "stock", header: "Остаток", align: "right", render: (row) => formatNumber(row.avg_stock) },
                  {
                    key: "drrAtbs",
                    header: (
                      <span className="inline-flex flex-col leading-[1.05]">
                        <span>ДРР по</span>
                        <span>корзинам</span>
                      </span>
                    ),
                    align: "right",
                    dividerBefore: true,
                    render: (row) => formatPercent(computeDrrAtbs(row.expense_sum, row.sum_price, row.orders, row.atbs)),
                  },
                  {
                    key: "drrOrders",
                    header: (
                      <span className="inline-flex flex-col leading-[1.05]">
                        <span>ДРР по</span>
                        <span>заказам</span>
                      </span>
                    ),
                    align: "right",
                    render: (row) => formatPercent(row.DRR),
                  },
                  { key: "spend", header: "Расход", align: "right", render: (row) => formatMoney(row.expense_sum) },
                  { key: "sum", header: "Выручка", align: "right", render: (row) => formatMoney(row.sum_price) },
                  { key: "views", header: "Показы", align: "right", dividerBefore: true, render: (row) => formatNumber(row.views) },
                  { key: "clicks", header: "Клики", align: "right", render: (row) => formatNumber(row.clicks) },
                  { key: "atbs", header: "Корзины", align: "right", render: (row) => formatNumber(row.atbs) },
                  {
                    key: "ordersAds",
                    header: (
                      <span className="inline-flex flex-col leading-[1.05]">
                        <span>Заказы</span>
                        <span>(РК)</span>
                      </span>
                    ),
                    align: "right",
                    render: (row) => formatNumber(row.orders),
                  },
                  {
                    key: "ordersTotal",
                    header: (
                      <span className="inline-flex flex-col leading-[1.05]">
                        <span>Заказы</span>
                        <span>(общие)</span>
                      </span>
                    ),
                    align: "right",
                    render: (row) => formatNumber(row.ordered_total),
                  },
                  { key: "ctr", header: "CTR", align: "right", dividerBefore: true, render: (row) => formatPercent(row.CTR) },
                  { key: "cr1", header: "CR1", align: "right", render: (row) => formatPercent(computeRate(row.atbs, row.clicks)) },
                  { key: "cr2", header: "CR2", align: "right", render: (row) => formatPercent(computeRate(row.orders, row.atbs)) },
                  { key: "cr", header: "CR", align: "right", render: (row) => formatPercent(computeRate(row.ordered_total, row.views)) },
                  { key: "cpm", header: "CPM", align: "right", dividerBefore: true, render: (row) => formatMoney(computeCpm(row.expense_sum, row.views), true) },
                  { key: "cpc", header: "CPC", align: "right", render: (row) => formatMoney(row.CPC, true) },
                  { key: "cpl", header: "CPL", align: "right", render: (row) => formatMoney(computeMoneyPer(row.expense_sum, row.atbs), true) },
                  {
                    key: "cpoAds",
                    header: (
                      <span className="inline-flex flex-col leading-[1.05]">
                        <span>CPO</span>
                        <span>(РК)</span>
                      </span>
                    ),
                    align: "right",
                    render: (row) => formatMoney(row.CPO, true),
                  },
                  {
                    key: "cpoOverall",
                    header: (
                      <span className="inline-flex flex-col leading-[1.05]">
                        <span>CPO</span>
                        <span>(всего)</span>
                      </span>
                    ),
                    align: "right",
                    render: (row) => formatMoney(row.CPO_overall ?? computeMoneyPer(row.expense_sum, row.ordered_total), true),
                  },
                ]}
              />
            ) : (
              <MetricTable
                rows={analyticsRows}
                emptyText="Дневная аналитика отсутствует."
                variant="flat"
                className="overflow-visible rounded-[24px] border border-[var(--color-line)] bg-white"
                columns={[
                  {
                    key: "metric",
                    header: "Показатель",
                    stickyLeft: 0,
                    headerClassName: "min-w-[240px]",
                    cellClassName: "min-w-[240px] font-medium",
                    render: (row) => row.label,
                  },
                  ...days.map((day) => {
                    const parts = formatAnalyticsDayParts(day.day);
                    return {
                      key: day.day,
                      header: (
                        <span className="inline-flex min-w-[112px] flex-col leading-[1.05]">
                          <span>{parts.weekday}</span>
                          <span>{parts.date}</span>
                        </span>
                      ),
                      align: "right" as const,
                      dividerBefore: true,
                      headerClassName: "min-w-[112px]",
                      cellClassName: "min-w-[112px] whitespace-nowrap",
                      render: (row: (typeof analyticsRows)[number]) => row.renderValue(day),
                    };
                  }),
                ]}
              />
            )}
          </div>
        ) : (
          <EmptyState title="Аналитика не найдена" text="За выбранный период API не вернуло дневные аналитические строки." />
        )
      ) : (
        <div className="grid gap-4 xl:grid-cols-[0.92fr,1.08fr]">
          <div className="space-y-4">
            <div className="rounded-[24px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] p-4">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">Покрытие по расписанию</p>
              <ScheduleMatrix schedule={hoursSourceProduct.schedule_aggregate} />
            </div>
          </div>
          <div className="space-y-4">
            <div className="rounded-[24px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] p-3">
              <HourlyPerformanceChart heatmap={hoursSourceProduct.heatmap} ordersHeatmap={hoursSourceProduct.orders_heatmap} />
            </div>
            <MetricTable
              rows={hourlyRows}
              emptyText="Почасовые данные отсутствуют."
              columns={[
                { key: "hour", header: "Час", render: (row) => row.hour },
                { key: "stock", header: "Остаток", align: "right", render: (row) => formatNumber(row.avgStock) },
                {
                  key: "drrAtbs",
                  header: (
                    <span className="inline-flex flex-col leading-[1.05]">
                      <span>ДРР по</span>
                      <span>корзинам</span>
                    </span>
                  ),
                  align: "right",
                  dividerBefore: true,
                  render: (row) => formatPercent(computeDrrAtbs(row.spent, row.sumPrice, row.orders, row.atbs)),
                },
                {
                  key: "drrOrders",
                  header: (
                    <span className="inline-flex flex-col leading-[1.05]">
                      <span>ДРР по</span>
                      <span>заказам</span>
                    </span>
                  ),
                  align: "right",
                  render: (row) => formatPercent(computeDrr(row.spent, row.sumPrice)),
                },
                { key: "spent", header: "Расход", align: "right", render: (row) => formatMoney(row.spent) },
                { key: "sum", header: "Выручка", align: "right", render: (row) => formatMoney(row.sumPrice) },
                { key: "views", header: "Показы", align: "right", dividerBefore: true, render: (row) => formatNumber(row.views) },
                { key: "clicks", header: "Клики", align: "right", render: (row) => formatNumber(row.clicks) },
                { key: "atbs", header: "Корзины", align: "right", render: (row) => formatNumber(row.atbs) },
                {
                  key: "ordersAds",
                  header: (
                    <span className="inline-flex flex-col leading-[1.05]">
                      <span>Заказы</span>
                      <span>(РК)</span>
                    </span>
                  ),
                  align: "right",
                  render: (row) => formatNumber(row.orders),
                },
                {
                  key: "ordersTotal",
                  header: (
                    <span className="inline-flex flex-col leading-[1.05]">
                      <span>Заказы</span>
                      <span>(общие)</span>
                    </span>
                  ),
                  align: "right",
                  render: (row) => formatNumber(row.orderedTotal),
                },
                { key: "ctr", header: "CTR", align: "right", dividerBefore: true, render: (row) => formatPercent(row.ctr) },
                { key: "cr", header: "CR", align: "right", render: (row) => formatPercent(row.cr) },
                { key: "cr1", header: "CR1", align: "right", render: (row) => formatPercent(computeRate(row.atbs, row.clicks)) },
                { key: "cr2", header: "CR2", align: "right", render: (row) => formatPercent(computeRate(row.orders, row.atbs)) },
                { key: "cpm", header: "CPM", align: "right", dividerBefore: true, render: (row) => formatMoney(computeCpm(row.spent, row.views), true) },
                { key: "cpc", header: "CPC", align: "right", render: (row) => formatMoney(row.cpc, true) },
                { key: "cpl", header: "CPL", align: "right", render: (row) => formatMoney(computeMoneyPer(row.spent, row.atbs), true) },
                {
                  key: "cpoAds",
                  header: (
                    <span className="inline-flex flex-col leading-[1.05]">
                      <span>CPO</span>
                      <span>(РК)</span>
                    </span>
                  ),
                  align: "right",
                  render: (row) => formatMoney(computeMoneyPer(row.spent, row.orders), true),
                },
                {
                  key: "cpoOverall",
                  header: (
                    <span className="inline-flex flex-col leading-[1.05]">
                      <span>CPO</span>
                      <span>(всего)</span>
                    </span>
                  ),
                  align: "right",
                  render: (row) => formatMoney(computeMoneyPer(row.spent, row.orderedTotal), true),
                },
              ]}
            />
          </div>
        </div>
      )}
    </LegacySection>
  );
}

function CampaignStatusCard({
  campaign,
  view,
}: {
  campaign: CampaignSummary;
  view: "timeline" | "hours";
}) {
  const [hoveredHourLegendKey, setHoveredHourLegendKey] = useState<string | null>(null);
  const mpHistory = campaign.status_logs?.mp_history || [];
  const timelineDays = useMemo(() => [...buildCampaignStatusTimelineDays(campaign)].reverse(), [campaign]);
  const hourlyDays = useMemo(
    () => buildCampaignStatusDays(campaign).filter((day) => day.entries.length > 0),
    [campaign],
  );
  const hourLegendItems = useMemo(() => {
    const legendOrder = ["active", "paused-schedule", "paused-limit", "paused-budget", "paused-mixed", "paused", "freeze", "unknown"];
    const items = new Map<string, { key: string; label: string; variant: string }>();

    hourlyDays.forEach((day) => {
      buildCampaignStatusHourSlots(day).forEach((slot) => {
        if (!items.has(slot.legendKey)) {
          items.set(slot.legendKey, {
            key: slot.legendKey,
            label: slot.legendLabel,
            variant: slot.variant,
          });
        }
      });
    });

    return [...items.values()].sort((left, right) => {
      const leftIndex = legendOrder.indexOf(left.variant);
      const rightIndex = legendOrder.indexOf(right.variant);
      return (leftIndex === -1 ? legendOrder.length : leftIndex) - (rightIndex === -1 ? legendOrder.length : rightIndex);
    });
  }, [hourlyDays]);
  const displayStatus = resolveCampaignDisplayStatus(campaign);
  const totalIntervals = campaignMergedPauseHistoryIntervals(campaign).length;
  const bidModeLabel = resolveCampaignBidModeLabel(campaign);

  return (
    <article className={cn("rounded-[24px] border border-[var(--color-line)] bg-white p-4 shadow-[0_14px_32px_rgba(44,35,66,0.06)]", resolveCampaignStatusOutline(displayStatus.label))}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-2 flex flex-wrap gap-2">
            <MetaPill>ID {campaign.id}</MetaPill>
            <MetaPill tone={displayStatus.tone}>{displayStatus.label}</MetaPill>
            <MetaPill>{bidModeLabel}</MetaPill>
            {campaign.status_xway ? <MetaPill tone={resolveCampaignDisplayStatus({ ...campaign, status: campaign.status_xway }).tone}>XWAY {campaign.status_xway}</MetaPill> : null}
          </div>
          <h4 className="text-base font-semibold text-[var(--color-ink)]">{campaign.name}</h4>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <MetaPill>{`MP ${formatNumber(mpHistory.length)}`}</MetaPill>
          <MetaPill>{`Интервалы ${formatNumber(totalIntervals)}`}</MetaPill>
          <MetaPill tone={campaign.schedule_config?.schedule_active ? "accent" : "default"}>{campaign.schedule_config?.schedule_active ? "Расписание активно" : "Без расписания"}</MetaPill>
          <MetaPill>{`${resolveCampaignBidLabel(campaign)} ${formatBidMoney(campaign.bid, campaign)}`}</MetaPill>
          <MetaPill>{`Расход ${formatMoney(campaign.metrics.sum)}`}</MetaPill>
        </div>
      </div>

      <div className="status-log-grid">
        {view === "hours" ? (
          hourlyDays.length ? (
            <div className="campaign-status-hours-shell">
              <div className="campaign-status-hours-slider">
                {[...hourlyDays].reverse().map((day) => {
                  const hourSlots = [...buildCampaignStatusHourSlots(day)].reverse();
                  return (
                    <article key={`${campaign.id}-status-hour-day-${day.day}`} className="campaign-status-ribbon-card">
                      <div className="campaign-status-ribbon-head is-hours">
                        <div className="campaign-status-ribbon-copy is-hours">
                          <strong>{day.label}</strong>
                          <small>{formatStatusTransitionCountLabel(day.entries.length)}</small>
                        </div>
                      </div>
                      <div className="campaign-status-ribbon-scale" aria-hidden="true">
                        {hourSlots.map((slot, index) => (
                          <span
                            key={`${campaign.id}-status-ribbon-tick-${day.day}-${slot.hour}`}
                            className="campaign-status-ribbon-tick"
                          >
                            {String(slot.hour)}
                          </span>
                        ))}
                      </div>
                      <div className="campaign-status-ribbon-track" role="img" aria-label={`Почасовой статус за ${day.label}`}>
                        {hourSlots.map((slot) => (
                          <span
                            key={`${campaign.id}-status-ribbon-slot-${day.day}-${slot.hour}`}
                            className={cn(
                              "campaign-status-ribbon-hour",
                              `is-${slot.variant}`,
                              hoveredHourLegendKey
                                ? slot.legendKey === hoveredHourLegendKey
                                  ? "is-hover-match"
                                  : "is-hover-dim"
                                : null,
                            )}
                            title={`${day.label} · ${slot.title}`}
                          />
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>
              {hourLegendItems.length ? (
                <div className="campaign-status-hours-legend">
                  {hourLegendItems.map((item) => (
                    <button
                      key={`${campaign.id}-status-legend-${item.key}`}
                      type="button"
                      className={cn(
                        "campaign-status-hours-legend-bubble",
                        `is-${item.variant}`,
                        hoveredHourLegendKey
                          ? item.key === hoveredHourLegendKey
                            ? "is-filter-active"
                            : "is-filter-dim"
                          : null,
                      )}
                      onMouseEnter={() => setHoveredHourLegendKey(item.key)}
                      onMouseLeave={() => setHoveredHourLegendKey(null)}
                      onFocus={() => setHoveredHourLegendKey(item.key)}
                      onBlur={() => setHoveredHourLegendKey(null)}
                    >
                      <span className={cn("campaign-status-hours-legend-dot", `is-${item.variant}`)} aria-hidden="true" />
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState title="Логи состояния не найдены" text="Для этой РК пока нет интервалов статусов, которые можно показать по часам." />
          )
        ) : (
          timelineDays.length ? (
            <div className="campaign-status-timeline-shell">
              <div className="campaign-status-timeline-board">
                {timelineDays.map((day) => (
                  <section key={`${campaign.id}-status-timeline-day-${day.dayKey}`} className="campaign-status-timeline-day-group">
                    <div className="campaign-status-timeline-head">
                      <div className="campaign-status-timeline-copy">
                        <strong>{day.dayLabel}</strong>
                        <small>{formatStatusTransitionCountLabel(day.items.length)}</small>
                      </div>
                    </div>
                    <div className="campaign-status-timeline-track">
                      {day.items.map((item) => {
                        const duration = formatStatusTimelineDurationHours(item);
                        const reasons = pauseReasonLabels(item);
                        const detailLabel = reasons.join(" · ") || item.statusLabel;
                        return (
                          <article
                            key={`${campaign.id}-status-timeline-item-${day.dayKey}-${item.sourceKey}-${item.displayStart || item.start || "start"}`}
                            className={cn("campaign-status-timeline-entry", `is-${item.statusKey}`)}
                            title={`${item.displayStart || item.start || "—"} · ${detailLabel}`}
                          >
                            <div className="campaign-status-timeline-entry-head">
                              <div className="campaign-status-timeline-entry-top">
                                <strong>{compactStatusStartTimeLabel(item.displayStart || item.start)}</strong>
                                {duration ? <span className="campaign-status-timeline-duration">{duration}</span> : null}
                              </div>
                              <span className="campaign-status-timeline-entry-until">{compactStatusEndLabel(item.displayEnd)}</span>
                            </div>
                            <div className="campaign-status-timeline-entry-divider" aria-hidden="true" />
                            <span className={cn("campaign-status-timeline-icon", `is-${item.statusKey}`)} aria-hidden="true">
                              <CampaignStatusGlyph state={item.statusKey} />
                            </span>
                            <div className={cn("campaign-status-timeline-entry-card", `is-${item.statusKey}`)}>
                              <strong>{item.statusLabel}</strong>
                              <small>{detailLabel}</small>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          ) : (
            <EmptyState title="Логи состояния не найдены" text="Для этой РК пока нет интервалов статусов, которые можно показать лентой." />
          )
        )}
      </div>
    </article>
  );
}

function CampaignStatusSection({ product }: { product: ProductSummary }) {
  const [view, setView] = useState<"timeline" | "hours">(() => {
    if (typeof window === "undefined") {
      return "timeline";
    }
    return window.localStorage.getItem(CAMPAIGN_STATUS_SECTION_VIEW_STORAGE_KEY) === "hours" ? "hours" : "timeline";
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(CAMPAIGN_STATUS_SECTION_VIEW_STORAGE_KEY, view);
  }, [view]);

  return (
    <LegacySection
      title="Логи состояния РК"
      note={`${formatNumber(product.campaigns.length)} кампаний · ${formatNumber(product.campaigns.reduce((sum, campaign) => sum + (campaign.status_logs?.mp_history.length || 0), 0))} логов`}
      actions={(
        <div className="chart-window-switch" aria-label="Вид логов состояния">
          <button
            type="button"
            className={cn("chart-window-chip", view === "timeline" && "is-active")}
            onClick={() => setView("timeline")}
          >
            Лента
          </button>
          <button
            type="button"
            className={cn("chart-window-chip", view === "hours" && "is-active")}
            onClick={() => setView("hours")}
          >
            Часы
          </button>
        </div>
      )}
    >
      {product.campaigns.length ? (
        <div className="space-y-4">
          {product.campaigns.map((campaign) => (
            <CampaignStatusCard key={campaign.id} campaign={campaign} view={view} />
          ))}
        </div>
      ) : (
        <EmptyState title="Кампании не найдены" text="Для товара нет кампаний, по которым можно показать логи состояния." />
      )}
    </LegacySection>
  );
}

function CampaignClustersContent({
  campaign,
  isWildberries,
  productAverageCheck,
  periodStart,
  periodEnd,
  openClusterDialog,
}: {
  campaign: CampaignSummary;
  isWildberries: boolean;
  productAverageCheck: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  openClusterDialog: (campaignId: number, campaignName: string, cluster: ClusterItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeFilters, setActiveFilters] = useState<ClusterFilterMode[]>(["enabled", "fixed"]);
  const [sortKey, setSortKey] = useState<ClusterSortKey>("expense");
  const [sortDirection, setSortDirection] = useState<ClusterSortDirection>("desc");

  const filterCounts = useMemo(
    () => ({
      enabled: campaign.clusters.items.filter((item) => matchesClusterFilter(item, ["enabled"])).length,
      fixed: campaign.clusters.items.filter((item) => matchesClusterFilter(item, ["fixed"])).length,
      excluded: campaign.clusters.items.filter((item) => matchesClusterFilter(item, ["excluded"])).length,
    }),
    [campaign.clusters.items],
  );

  const visibleRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...campaign.clusters.items]
      .filter((item) => matchesClusterFilter(item, activeFilters))
      .filter((item) => (!normalizedQuery ? true : item.name.toLowerCase().includes(normalizedQuery)))
      .sort((left, right) => {
        const result = compareClusters(left, right, sortKey);
        return sortDirection === "asc" ? result : result * -1;
      });
  }, [activeFilters, campaign.clusters.items, query, sortDirection, sortKey]);

  const clusterPositionDayKeys = useMemo(
    () => buildClusterPositionTimelineDayKeys(visibleRows, CLUSTER_POSITION_TIMELINE_DAYS),
    [visibleRows],
  );
  const clusterPositionDayKeysDesc = useMemo(
    () => [...clusterPositionDayKeys].reverse(),
    [clusterPositionDayKeys],
  );
  const clusterPositionSeriesByClusterId = useMemo(
    () =>
      new Map(
        visibleRows.map((row) => {
          const series = buildClusterPositionSeries(row, CLUSTER_POSITION_TIMELINE_DAYS, clusterPositionDayKeys);
          const byDay = new Map(
            series
              .filter((point): point is MetricSeriesPoint & { day: string } => Boolean(point.day))
              .map((point) => [point.day, point]),
          );
          return [row.normquery_id, { series, byDay }] as const;
        }),
      ),
    [visibleRows, clusterPositionDayKeys],
  );

  const clusterTrafficPeriodDays = useMemo(
    () => countClusterTrafficPeriodDays(periodStart, periodEnd),
    [periodEnd, periodStart],
  );

  const analyticsCards = useMemo(
    () =>
      activeFilters.map((filterKey) => {
        const rows = campaign.clusters.items.filter((item) => matchesClusterFilter(item, [filterKey]));
        const expense = rows.reduce((sum, item) => sum + (toNumber(item.expense) ?? 0), 0);
        const clicks = rows.reduce((sum, item) => sum + (toNumber(item.clicks) ?? 0), 0);
        const views = rows.reduce((sum, item) => sum + (toNumber(item.views) ?? 0), 0);
        const atbs = rows.reduce((sum, item) => sum + (toNumber(item.atbs) ?? 0), 0);
        const orders = rows.reduce((sum, item) => sum + (toNumber(item.orders) ?? 0), 0);
        const queryDemandPerDay = rows.reduce((sum, item) => sum + (toNumber(item.popularity) ?? 0) / 7, 0);
        const trafficCapacity = queryDemandPerDay * clusterTrafficPeriodDays;
        const trafficShare = trafficCapacity > 0 ? (views / trafficCapacity) * 100 : null;
        const config = {
          enabled: {
            label: "Включены",
            tone: "border-emerald-200 bg-emerald-50/80 text-emerald-700",
          },
          fixed: {
            label: "Зафиксированы",
            tone: "border-violet-200 bg-violet-50/80 text-violet-700",
          },
          excluded: {
            label: "Исключены",
            tone: "border-rose-200 bg-rose-50/80 text-rose-700",
          },
        } as const;
        return {
          key: filterKey,
          label: config[filterKey].label,
          tone: config[filterKey].tone,
          count: rows.length,
          expense,
          clicks,
          views,
          atbs,
          orders,
          trafficCapacity,
          trafficShare,
        };
      }),
    [activeFilters, campaign.clusters.items, clusterTrafficPeriodDays],
  );

  const excludedClustersCount = useMemo(
    () => toNumber(campaign.clusters.excluded) ?? filterCounts.excluded,
    [campaign.clusters.excluded, filterCounts.excluded],
  );

  const excludedRulesLimit = useMemo(
    () => {
      if (isWildberries) {
        return 1000;
      }
      return toNumber(campaign.clusters.max_rules_available);
    },
    [campaign.clusters.max_rules_available, isWildberries],
  );

  const excludedClusterTraffic = useMemo(() => {
    const rows = campaign.clusters.items.filter((item) => matchesClusterFilter(item, ["excluded"]));
    const expense = rows.reduce((sum, item) => sum + (toNumber(item.expense) ?? 0), 0);
    const views = rows.reduce((sum, item) => sum + (toNumber(item.views) ?? 0), 0);
    const clicks = rows.reduce((sum, item) => sum + (toNumber(item.clicks) ?? 0), 0);
    const atbs = rows.reduce((sum, item) => sum + (toNumber(item.atbs) ?? 0), 0);
    const orders = rows.reduce((sum, item) => sum + (toNumber(item.orders) ?? 0), 0);
    const queryDemandPerDay = rows.reduce((sum, item) => sum + (toNumber(item.popularity) ?? 0) / 7, 0);
    const trafficCapacity = queryDemandPerDay * clusterTrafficPeriodDays;
    return {
      expense,
      views,
      clicks,
      atbs,
      orders,
      trafficCapacity,
      trafficShare: trafficCapacity > 0 ? (views / trafficCapacity) * 100 : null,
    };
  }, [campaign.clusters.items, clusterTrafficPeriodDays]);

  const filterButtons: Array<{
    key: ClusterFilterMode;
    label: string;
    count: number;
    icon: typeof Check;
    tone: string;
  }> = [
    { key: "enabled", label: "Включены", count: filterCounts.enabled, icon: Check, tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
    { key: "fixed", label: "Зафиксированы", count: filterCounts.fixed, icon: Pin, tone: "border-violet-200 bg-violet-50 text-violet-700" },
    { key: "excluded", label: "Исключены", count: filterCounts.excluded, icon: X, tone: "border-rose-200 bg-rose-50 text-rose-700" },
  ];

  const sortOptions: Array<{ value: ClusterSortKey; label: string }> = [
    { value: "expense", label: "По расходу" },
    { value: "views", label: "По показам" },
    { value: "clicks", label: "По кликам" },
    { value: "position", label: "По позиции" },
    { value: "bid", label: "По ставке" },
    { value: "ctr", label: "По CTR" },
    { value: "cr", label: "По CR" },
    { value: "popularity", label: "По запросам в неделю" },
    { value: "name", label: "По названию" },
  ];

  const visibleRowTotals = useMemo(() => {
    const popularity = visibleRows.reduce((sum, row) => sum + (toNumber(row.popularity) ?? 0), 0);
    const popularityPerDay = visibleRows.reduce((sum, row) => sum + (toNumber(row.popularity) ?? 0) / 7, 0);
    const expense = visibleRows.reduce((sum, row) => sum + (toNumber(row.expense) ?? 0), 0);
    const views = visibleRows.reduce((sum, row) => sum + (toNumber(row.views) ?? 0), 0);
    const clicks = visibleRows.reduce((sum, row) => sum + (toNumber(row.clicks) ?? 0), 0);
    const atbs = visibleRows.reduce((sum, row) => sum + (toNumber(row.atbs) ?? 0), 0);
    const orders = visibleRows.reduce((sum, row) => sum + (toNumber(row.orders) ?? 0), 0);
    const overallOrders = visibleRows.reduce((sum, row) => sum + (toNumber(row.shks) ?? 0), 0);
    const drrOrdersTotals = visibleRows.reduce(
      (sum, row) => {
        const totals = accumulateClusterOrdersDrrTotals(row.daily);
        if (!totals) {
          return sum;
        }
        sum.spend += totals.spend;
        sum.orders += totals.orders;
        return sum;
      },
      { spend: 0, orders: 0 },
    );
    return {
      popularity,
      popularityPerDay,
      expense,
      views,
      clicks,
      atbs,
      orders,
      overallOrders,
      ctr: computeRate(clicks, views),
      cr1: computeRate(atbs, clicks),
      cr2: computeRate(orders, atbs),
      crf: computeRate(orders, clicks),
      drrOrders: computeClusterOrdersDrrValue(drrOrdersTotals.spend, drrOrdersTotals.orders, productAverageCheck),
      cpm: computeCpm(expense, views),
      cpc: computeMoneyPer(expense, clicks),
      cpl: computeMoneyPer(expense, atbs),
      cpo: computeMoneyPer(expense, orders),
    };
  }, [productAverageCheck, visibleRows]);

  return (
    <>
      <div className="mb-3 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {filterButtons.map((button) => {
            const Icon = button.icon;
            const isActive = activeFilters.includes(button.key);
            return (
              <button
                key={button.key}
                type="button"
                onClick={() =>
                  setActiveFilters((current) =>
                    current.includes(button.key)
                      ? current.filter((key) => key !== button.key)
                      : [...current, button.key],
                  )
                }
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                  isActive ? button.tone : "border-[var(--color-line)] bg-white text-[var(--color-muted)] hover:bg-[var(--color-surface-soft)]",
                )}
              >
                <Icon className="size-3.5" />
                <span>{button.label}</span>
                <span className="text-[0.72rem] opacity-80">{formatNumber(button.count)}</span>
              </button>
            );
          })}
        </div>

        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-[18px] border border-slate-200 bg-slate-50/70 px-4 py-3 text-[var(--color-ink)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted)]">Исключённые</div>
                <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]">кластеры</div>
                <strong className="mt-2 block font-display text-[1.5rem] leading-none text-[var(--color-ink)]">
                  {formatNumber(excludedClustersCount)}
                </strong>
                <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]">расход</div>
                <strong className="mt-2 block font-display text-[1.5rem] leading-none text-[var(--color-ink)]">
                  {formatMoney(excludedClusterTraffic.expense)}
                </strong>
              </div>
              <div
                className="inline-flex items-center gap-1.5 rounded-full border border-[#ffb997] bg-[#ffd0b4] px-2.5 py-1 text-[0.95rem] font-semibold leading-none text-[#342f49]"
                title="Текущее число исключённых кластеров и общий лимит правил исключения"
              >
                <span>
                  {excludedRulesLimit !== null
                    ? `${formatNumber(excludedClustersCount)}/${formatNumber(excludedRulesLimit)}`
                    : formatNumber(excludedClustersCount)}
                </span>
                <Info className="size-3.5 shrink-0" />
              </div>
            </div>
            <div className="mt-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]">трафик периода</div>
              <div className="mt-1 flex items-end justify-between gap-3">
                <strong className="font-display text-[1.1rem] leading-none text-[var(--color-ink)]">
                  {excludedClusterTraffic.trafficShare !== null ? formatPercent(excludedClusterTraffic.trafficShare) : "—"}
                </strong>
              </div>
              <div className="mt-1 text-[11px] leading-none text-[var(--color-muted)]">
                ({formatCompactNumber(excludedClusterTraffic.views)} / {formatCompactNumber(Math.round(excludedClusterTraffic.trafficCapacity || 0))})
              </div>
            </div>
            <div className="mt-3 text-[11px] font-medium text-[var(--color-muted)]">
              {formatNumber(excludedClusterTraffic.views)} просмотров &gt; {formatNumber(excludedClusterTraffic.clicks)} кликов &gt; {formatNumber(excludedClusterTraffic.atbs)} корзин &gt; {formatNumber(excludedClusterTraffic.orders)} заказов
            </div>
          </div>

          {analyticsCards.length ? (
            analyticsCards.map((card) => (
              <div key={card.key} className={cn("rounded-[18px] border px-4 py-3", card.tone)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.16em]">{card.label}</span>
                    <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] opacity-60">кластеры</div>
                    <strong className="mt-2 block font-display text-[1.5rem] leading-none">
                      {formatNumber(card.count)}
                    </strong>
                    <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.14em] opacity-60">расход</div>
                    <strong className="mt-2 block font-display text-[1.5rem] leading-none">
                      {formatMoney(card.expense)}
                    </strong>
                    <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.14em] opacity-60">трафик периода</div>
                    <strong className="mt-2 block font-display text-[1.2rem] leading-none">
                      {card.trafficShare !== null ? formatPercent(card.trafficShare) : "—"}
                    </strong>
                    <div className="mt-1 text-[11px] leading-none opacity-70">
                      ({formatCompactNumber(card.views)} / {formatCompactNumber(Math.round(card.trafficCapacity || 0))})
                    </div>
                  </div>
                </div>
                <div className="mt-3">
                  <span className="text-[11px] font-medium opacity-80">
                    {formatNumber(card.views)} просмотров &gt; {formatNumber(card.clicks)} кликов &gt; {formatNumber(card.atbs)} корзин &gt; {formatNumber(card.orders)} заказов
                  </span>
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-[18px] border border-dashed border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-3 text-sm text-[var(--color-muted)]">
              Выберите хотя бы один тег фильтра, чтобы увидеть кластеры и аналитику трат.
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="w-full lg:max-w-[320px]">
            <SearchField value={query} onChange={setQuery} placeholder="Поиск по названию кластера" />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="metric-chip inline-flex min-h-[48px] items-center gap-3 rounded-2xl px-4 py-3 text-sm text-[var(--color-muted)]">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">Сортировка</span>
              <select
                value={sortKey}
                onChange={(event) => {
                  const nextSortKey = event.target.value as ClusterSortKey;
                  setSortKey(nextSortKey);
                  setSortDirection(getClusterSortDefaultDirection(nextSortKey));
                }}
                className="bg-transparent text-sm text-[var(--color-ink)] outline-none"
              >
                {sortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={() => setSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
              title={sortDirection === "asc" ? "Сейчас по возрастанию" : "Сейчас по убыванию"}
              className="metric-chip inline-flex min-h-[48px] items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold text-[var(--color-ink)]"
            >
              {sortDirection === "asc" ? "↑" : "↓"}
            </button>
          </div>
        </div>
      </div>

      <MetricTable
        className="cluster-metric-table"
        rows={visibleRows}
        emptyText={query || activeFilters.length ? "По выбранным фильтрам кластеры не найдены." : "Выберите хотя бы один тег фильтра."}
        columns={[
          {
            key: "query",
            header: "Кластер",
            headerSummary: <span className="font-semibold text-[var(--color-muted)]">Итого</span>,
            stickyLeft: 0,
            headerClassName: "!w-[248px] !min-w-[248px] !px-5",
            cellClassName: "!w-[248px] !min-w-[248px] !px-5",
            render: (row) => {
              const clusterSearchUrl = isWildberries ? buildWildberriesSearchUrl(row.name) : null;
              return (
                <div className="flex min-w-[180px] max-w-[216px] items-center gap-2.5">
                  <div className="shrink-0">
                    <ClusterStateIcon cluster={row} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-[var(--color-ink)]" title={row.name}>
                      {clusterSearchUrl ? (
                        <a
                          href={clusterSearchUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="group inline-flex max-w-full items-center gap-1.5 text-[var(--color-ink)] transition hover:text-[#3d82d8]"
                          title={`Открыть поиск WB по фразе «${row.name}»`}
                        >
                          <span className="inline-flex min-w-0 items-center gap-1.5">
                            {row.is_main ? (
                              <Star
                                className="size-3.5 shrink-0 fill-[rgba(245,158,11,0.18)] text-[rgba(245,158,11,0.92)]"
                                aria-label="Главный кластер"
                              />
                            ) : null}
                            <span className="block truncate">{row.name}</span>
                          </span>
                          <ExternalLink className="size-3.5 shrink-0 text-[var(--color-muted)] transition group-hover:text-[#3d82d8]" />
                        </a>
                      ) : (
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          {row.is_main ? (
                            <Star
                              className="size-3.5 shrink-0 fill-[rgba(245,158,11,0.18)] text-[rgba(245,158,11,0.92)]"
                              aria-label="Главный кластер"
                            />
                          ) : null}
                          <span className="block truncate">{row.name}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            },
          },
          {
            key: "popularity",
            header: (
              <span className="inline-flex flex-col leading-[1.05]">
                <span>Запросы</span>
                <span>в неделю</span>
              </span>
            ),
            headerSummary: formatNumber(visibleRowTotals.popularity),
            stickyLeft: 248,
            headerClassName: "!w-[98px] !min-w-[98px] !px-2",
            cellClassName: "!w-[98px] !min-w-[98px] !px-2",
            render: (row) => formatNumber(row.popularity),
          },
          {
            key: "popularity_daily",
            header: (
              <span className="inline-flex flex-col leading-[1.05]">
                <span>Запросы</span>
                <span>в день</span>
              </span>
            ),
            headerSummary: formatNumber(Math.round(visibleRowTotals.popularityPerDay)),
            stickyLeft: 346,
            headerClassName: "!w-[92px] !min-w-[92px] !px-2",
            cellClassName: "!w-[92px] !min-w-[92px] !px-2",
            render: (row) => formatNumber(Math.round((toNumber(row.popularity) ?? 0) / 7)),
          },
          {
            key: "strategy_status",
            header: <span className="sr-only">Статус стратегии</span>,
            headerSummary: null,
            dividerBefore: true,
            headerClassName: "!w-[38px] !min-w-[38px] !px-1.5 text-center",
            cellClassName: "!w-[38px] !min-w-[38px] !px-1.5",
            render: (row) => <ClusterStrategyStatusCell cluster={row} />,
          },
          {
            key: "strategy_bid",
            header: (
              <span className="inline-flex w-full flex-col items-center gap-1 leading-[1.05]">
                <span>Ставки</span>
                <span className="inline-flex items-center gap-1 text-[0.58rem] font-medium uppercase tracking-[0.18em] text-[var(--color-muted)]">
                  <span>Текущая</span>
                  <span aria-hidden="true">→</span>
                  <span>Таргет</span>
                </span>
              </span>
            ),
            headerSummary: null,
            headerClassName: "!w-[176px] !min-w-[176px] !px-2",
            cellClassName: "!w-[176px] !min-w-[176px] !px-2",
            render: (row) => <ClusterStrategyBidCell cluster={row} />,
          },
          {
            key: "strategy_position",
            header: (
              <span className="inline-flex w-full flex-col items-center gap-1 leading-[1.05]">
                <span>Позиции</span>
                <span className="inline-flex items-center gap-1 text-[0.58rem] font-medium uppercase tracking-[0.18em] text-[var(--color-muted)]">
                  <span>Текущая</span>
                  <span aria-hidden="true">→</span>
                  <span>Таргет</span>
                </span>
              </span>
            ),
            headerSummary: null,
            headerClassName: "!w-[112px] !min-w-[112px] !px-2",
            cellClassName: "!w-[112px] !min-w-[112px] !px-2",
            render: (row) => <ClusterStrategyPositionCell cluster={row} />,
          },
          {
            key: "position_trend",
            header: "Тренд 7д",
            headerSummary: null,
            dividerBefore: true,
            headerClassName: "!w-[74px] !min-w-[74px] !px-1.5",
            cellClassName: "!w-[74px] !min-w-[74px] !px-1.5",
            render: (row) => (
              <ClusterPositionSparkline
                points={clusterPositionSeriesByClusterId.get(row.normquery_id)?.series || []}
              />
            ),
          },
          ...clusterPositionDayKeysDesc.map((day, columnIndex) => ({
            key: `position_day_${day}`,
            header: <ClusterPositionDayColumnHeader day={day} />,
            headerSummary: null,
            dividerBefore: columnIndex === 0,
            headerClassName: "!w-[56px] !min-w-[56px] !px-[3px] !py-1.5",
            cellClassName: "!w-[56px] !min-w-[56px] !px-[3px] !py-1.5",
            render: (row: ClusterItem) => {
              const compareDay = clusterPositionDayKeysDesc[columnIndex + 1];
              return (
                <ClusterPositionDayValueCell
                  point={clusterPositionSeriesByClusterId.get(row.normquery_id)?.byDay.get(day) ?? null}
                  comparePoint={compareDay ? clusterPositionSeriesByClusterId.get(row.normquery_id)?.byDay.get(compareDay) ?? null : null}
                />
              );
            },
          })),
          { key: "expense", header: "Расход", headerSummary: formatMoney(visibleRowTotals.expense), align: "right", dividerBefore: true, render: (row) => formatMoney(row.expense) },
          { key: "views", header: "Показы", headerSummary: formatNumber(visibleRowTotals.views), align: "right", dividerBefore: true, render: (row) => formatNumber(row.views) },
          { key: "clicks", header: "Клики", headerSummary: formatNumber(visibleRowTotals.clicks), align: "right", render: (row) => formatNumber(row.clicks) },
          { key: "atbs", header: "Корзины", headerSummary: formatNumber(visibleRowTotals.atbs), align: "right", render: (row) => formatNumber(row.atbs) },
          { key: "orders", header: "Заказы", headerSummary: formatNumber(visibleRowTotals.orders), align: "right", render: (row) => formatNumber(row.orders) },
          {
            key: "overall_orders",
            header: (
              <span className="inline-flex flex-col leading-[1.05]">
                <span>Общие</span>
                <span>заказы</span>
              </span>
            ),
            headerSummary: formatNumber(visibleRowTotals.overallOrders),
            align: "right",
            render: (row) => formatNumber(row.shks),
          },
          { key: "ctr", header: "CTR", headerSummary: formatPercent(visibleRowTotals.ctr), align: "right", dividerBefore: true, render: (row) => formatPercent(row.ctr) },
          { key: "cr1", header: "CR1", headerSummary: formatPercent(visibleRowTotals.cr1), align: "right", render: (row) => formatPercent(computeRate(row.atbs, row.clicks)) },
          { key: "cr2", header: "CR2", headerSummary: formatPercent(visibleRowTotals.cr2), align: "right", render: (row) => formatPercent(computeRate(row.orders, row.atbs)) },
          { key: "cr", header: "CRF", headerSummary: formatPercent(visibleRowTotals.crf), align: "right", render: (row) => formatPercent(row.cr) },
          {
            key: "drr_orders",
            header: (
              <span className="inline-flex flex-col leading-[1.05]">
                <span>ДРР</span>
                <span>(РК Заказы)</span>
              </span>
            ),
            headerSummary: formatPercent(visibleRowTotals.drrOrders),
            align: "right",
            render: (row) => formatPercent(computeClusterOrdersDrr(row.daily, productAverageCheck)),
          },
          { key: "cpm", header: "CPM", headerSummary: formatMoney(visibleRowTotals.cpm, true), align: "right", dividerBefore: true, render: (row) => formatMoney(computeCpm(row.expense, row.views), true) },
          { key: "cpc", header: "CPC", headerSummary: formatMoney(visibleRowTotals.cpc, true), align: "right", render: (row) => formatMoney(row.cpc, true) },
          { key: "cpl", header: "CPL", headerSummary: formatMoney(visibleRowTotals.cpl, true), align: "right", render: (row) => formatMoney(computeMoneyPer(row.expense, row.atbs), true) },
          { key: "cpo", header: "CPO", headerSummary: formatMoney(visibleRowTotals.cpo, true), align: "right", render: (row) => formatMoney(row.cpo, true) },
          {
            key: "detail",
            header: "Детали",
            headerSummary: null,
            align: "right",
            dividerBefore: true,
            render: (row) => (
              <button
                type="button"
                onClick={() => openClusterDialog(campaign.id, campaign.name, row)}
                className="rounded-2xl bg-[var(--color-ink)] px-2.5 py-1.5 text-[11px] font-medium leading-none text-white transition hover:bg-[#342f49]"
              >
                Детали
              </button>
            ),
          },
        ]}
      />
    </>
  );
}

function ProductClustersPanel({
  product,
  openClusterDialog,
}: {
  product: ProductSummary;
  openClusterDialog: (campaignId: number, campaignName: string, cluster: ClusterItem) => void;
}) {
  const isWildberries = /wb|wildberries/i.test(String(product.shop.marketplace || ""));
  const productAverageCheck = useMemo(() => buildBoardMetrics(product).averageCheck, [product]);
  const campaignsWithClusters = useMemo(
    () => product.campaigns.filter((campaign) => campaign.clusters.items.length),
    [product.campaigns],
  );
  const firstCampaignWithClusters = campaignsWithClusters[0] ?? null;
  const [activeCampaignId, setActiveCampaignId] = useState<number | null>(firstCampaignWithClusters?.id ?? null);

  useEffect(() => {
    setActiveCampaignId((current) => {
      if (!firstCampaignWithClusters) {
        return null;
      }
      return campaignsWithClusters.some((campaign) => campaign.id === current) ? current : firstCampaignWithClusters.id;
    });
  }, [campaignsWithClusters, firstCampaignWithClusters]);

  const activeCampaign = campaignsWithClusters.find((campaign) => campaign.id === activeCampaignId) ?? firstCampaignWithClusters;

  if (!activeCampaign) {
    return <EmptyState title="Нет кластеров" text="Кластерные данные по этому товару не пришли в текущем периоде." />;
  }

  const displayStatus = resolveCampaignDisplayStatus(activeCampaign);
  const modeLabel = resolveCampaignModeLabel(activeCampaign);
  const bidModeLabel = resolveCampaignBidModeLabel(activeCampaign);

  return (
    <LegacySection
      title="Кластеры РК"
      note={`${formatNumber(campaignsWithClusters.length)} кампаний с кластерами`}
    >
      {campaignsWithClusters.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {campaignsWithClusters.map((campaign) => {
            const isActive = campaign.id === activeCampaign.id;
            const bidKind = resolveBidKind(campaign);
            const bidTypeLabel = bidKind === "cpc" ? "CPC" : "CPM";
            const bidModeLabel = bidKind === "cpc" ? "Оплата за клики" : resolveCampaignBidModeLabel(campaign);
            return (
              <button
                key={campaign.id}
                type="button"
                onClick={() => setActiveCampaignId(campaign.id)}
                className={cn(
                  "min-w-[156px] rounded-[16px] border px-4 py-3 text-left transition",
                  isActive
                    ? "border-[rgba(126,94,246,0.24)] bg-[rgba(126,94,246,0.08)] shadow-[0_12px_24px_rgba(44,35,66,0.08)]"
                    : "border-[var(--color-line)] bg-white hover:bg-[var(--color-surface-soft)]",
                )}
              >
                <div className="text-sm font-semibold text-[var(--color-ink)]">{`${bidTypeLabel} · ${bidModeLabel}`}</div>
                <div className="mt-1 text-xs text-[var(--color-muted)]">{`${formatNumber(campaign.clusters.total_clusters)} кластеров`}</div>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-[20px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-[var(--color-ink)]">{activeCampaign.name}</div>
          <div className="mt-1 text-xs text-[var(--color-muted)]">
            {`${formatNumber(activeCampaign.clusters.total_clusters)} кластеров · исключено ${formatNumber(activeCampaign.clusters.excluded)} · зафиксировано ${formatNumber(activeCampaign.clusters.fixed)}`}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <MetaPill tone={displayStatus.tone}>{displayStatus.label}</MetaPill>
          {modeLabel ? <MetaPill>{modeLabel}</MetaPill> : null}
          <MetaPill>{bidModeLabel}</MetaPill>
        </div>
      </div>

      <CampaignClustersContent
        campaign={activeCampaign}
        isWildberries={isWildberries}
        productAverageCheck={productAverageCheck}
        periodStart={product.period.current_start}
        periodEnd={product.period.current_end}
        openClusterDialog={openClusterDialog}
      />
    </LegacySection>
  );
}

function CampaignHeatmapCard({ campaign }: { campaign: CampaignSummary }) {
  const campaignSchedule = mapCampaignSchedule(campaign.schedule_config);
  const displayStatus = resolveCampaignDisplayStatus(campaign);

  return (
    <article className={cn("campaign-heatmap-card", resolveCampaignStatusOutline(displayStatus.key))}>
      <div className="campaign-heatmap-card-head">
        <div className="campaign-heatmap-card-copy">
          <h4 className="campaign-heatmap-card-title">{campaign.name}</h4>
          <p className="campaign-heatmap-card-note">ID {campaign.id} · {campaign.query_main || "ключевая фраза не задана"}</p>
        </div>
        <div className="campaign-heatmap-card-actions">
          <MetaPill tone="accent">Слотов {formatNumber(campaign.schedule_config?.active_slots)}</MetaPill>
          <CampaignStatusIconBadge campaign={campaign} />
        </div>
      </div>

      <div className="campaign-heatmap-card-metrics">
        <MiniMetric label="Показы" value={formatCompactNumber(campaign.metrics.views)} />
        <MiniMetric label="Заказы" value={formatNumber(campaign.metrics.orders)} />
        <MiniMetric label="Расход" value={formatMoney(campaign.metrics.sum)} />
        <MiniMetric label="CTR" value={formatPercent(campaign.metrics.ctr)} />
      </div>

      <div className="campaign-inline-heatmap campaign-heatmap-card-matrix is-compact">
        <div className="campaign-inline-heatmap-head">
          <div className="campaign-inline-heatmap-copy">
            <span className="campaign-inline-heatmap-title campaign-card-section-label">Heatmap РК</span>
            <small className="campaign-inline-heatmap-note">Показы по дням и часам</small>
          </div>
          <CampaignScheduleStatusBadge
            active={Boolean(campaign.schedule_config?.schedule_active)}
            className="campaign-inline-heatmap-status-badge"
          />
        </div>
        <ScheduleMatrix
          schedule={campaignSchedule}
          compact
          showCounts={false}
          dayLabelWidth={34}
        />
      </div>
    </article>
  );
}

function renderCampaignHeatmap(product: ProductSummary) {
  return (
    <LegacySection title="Heatmap по кампаниям" note={`${formatNumber(product.campaigns.length)} кампаний · отдельный heatmap по каждой РК`}>
      {product.campaigns.length ? (
        <div className="campaign-heatmap-grid">
          {product.campaigns.map((campaign) => (
            <CampaignHeatmapCard key={campaign.id} campaign={campaign} />
          ))}
        </div>
      ) : (
        <EmptyState title="Кампании не найдены" text="Для товара нет кампаний, по которым можно показать отдельные heatmap." />
      )}
    </LegacySection>
  );
}

function renderBids(product: ProductSummary) {
  return (
    <LegacySection title="Логи изменения ставки" note={`${formatNumber(product.bid_log.length)} записей по изменениям ставок`}>
      <MetricTable
        rows={product.bid_log}
        emptyText="Лог изменений ставок по товару пока пуст."
        columns={[
          { key: "datetime", header: "Время", render: (row) => row.datetime },
          { key: "campaign_name", header: "Кампания", render: (row) => row.campaign_name },
          { key: "zone", header: "Зона", render: (row) => row.zone },
          { key: "cpm", header: "Ставка CPM", align: "right", render: (row) => formatMoney(row.cpm) },
          { key: "new_position", header: "Новая позиция", align: "right", render: (row) => row.new_position || "—" },
          { key: "origin", header: "Источник", render: (row) => row.origin || "—" },
        ]}
      />
    </LegacySection>
  );
}

function CampaignChartsOverlayDialog({
  product,
  chartProduct,
  activeWindow,
  onActiveWindowChange,
  onClose,
}: {
  product: ProductSummary | null;
  chartProduct?: ProductSummary | null;
  activeWindow: OverviewWindow;
  onActiveWindowChange: (value: OverviewWindow) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!product) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeydown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [onClose, product]);

  if (!product) {
    return null;
  }

  const chartSourceProduct = chartProduct?.article === product.article ? chartProduct : product;
  const chartCampaignById = new Map(chartSourceProduct.campaigns.map((campaign) => [campaign.id, campaign]));

  return (
    <div className="fixed inset-0 z-[5000] flex items-center justify-center p-1 sm:p-2">
      <button type="button" aria-label="Закрыть" className="absolute inset-0 bg-[rgba(38,33,58,0.28)] backdrop-blur-sm" onClick={onClose} />
      <div className="glass-panel relative z-[5001] flex h-[calc(100vh-8px)] max-h-[calc(100vh-8px)] w-full max-w-[calc(100vw-8px)] flex-col overflow-hidden rounded-[34px]">
        <div className="shrink-0 flex items-start justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3 sm:px-5 sm:py-3.5">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.22em] text-brand-200">{product.article}</p>
            <h2 className="mt-1 font-display text-[1.6rem] font-semibold leading-[1.05] text-[var(--color-ink)]">Графики по всем РК</h2>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">
              {`${formatNumber(product.campaigns.length)} кампаний · ${formatDateRange(chartSourceProduct.period.current_start, chartSourceProduct.period.current_end)}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="metric-chip rounded-2xl p-2.5 text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4 sm:px-6 sm:py-5">
          {product.campaigns.length ? (
            <div className="grid min-w-0 auto-rows-min items-start gap-4 2xl:grid-cols-2">
              {product.campaigns.map((campaign) => {
                const chartSourceCampaign = mergeCampaignChartSource(campaign, chartCampaignById.get(campaign.id) || null);
                const statusDays = buildCampaignStatusDays(
                  chartSourceCampaign,
                  chartSourceProduct.period.current_start,
                  chartSourceProduct.period.current_end,
                );
                const visibleIssueStatusDays =
                  statusDays.length > activeWindow
                    ? statusDays.slice(statusDays.length - activeWindow)
                    : statusDays;
                const bidKind = resolveBidKind(campaign);
                const bidTypeLabel = bidKind === "cpc" ? "CPC" : "CPM";
                const zoneBadges = resolveCampaignZoneBadges(campaign);
                const displayStatus = resolveCampaignDisplayStatus(campaign);
                const headPillItems: CampaignPillTickerItem[] = [];
                headPillItems.push({ key: `overlay-bid-type-${campaign.id}`, node: <MetaPill>{bidTypeLabel}</MetaPill> });
                headPillItems.push({
                  key: `overlay-bid-mode-${campaign.id}`,
                  node: <MetaPill>{resolveCampaignBidModeLabel(campaign)}</MetaPill>,
                });

                return (
                  <article
                    key={`overlay-campaign-chart-${campaign.id}`}
                    className={cn(
                      "campaign-overlay-card min-w-0 self-start rounded-[28px] border border-[var(--color-line)] bg-white p-4 shadow-[0_14px_32px_rgba(44,35,66,0.06)]",
                      resolveCampaignStatusOutline(displayStatus.key),
                    )}
                    >
                      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="campaign-card-head-top mb-2">
                            <CampaignPillsTicker items={headPillItems} />
                            <div className="campaign-card-head-top-side">
                              <div className="campaign-card-meta-side is-inline">
                                <span className="campaign-card-meta-side-line">WB ID {campaign.wb_id}</span>
                                <span className="campaign-card-meta-side-line">{campaign.query_main || "ключевая фраза не задана"}</span>
                              </div>
                              <CampaignStatusIconBadge campaign={campaign} />
                            </div>
                          </div>
                          <div className="campaign-card-title-row">
                            <div className="campaign-card-title-wrap">
                              <h3 className="font-display text-lg font-semibold text-[var(--color-ink)]">{campaign.name}</h3>
                            </div>
                            <div className="campaign-card-side-stack">
                              {zoneBadges.length ? (
                                <div className="campaign-zone-row is-inline-title is-side-stack">
                                  <div className="campaign-zone-list">
                                    {zoneBadges.map((zone) => {
                                      const Icon = zone.icon;
                                      return (
                                        <span key={`overlay-zone-${campaign.id}-${zone.key}`} className="campaign-zone-pill">
                                          <Icon className="size-3.5" />
                                          {zone.label}
                                        </span>
                                      );
                                    })}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>

                    <CampaignInlineOverviewChart
                      campaign={chartSourceCampaign}
                      statusDays={statusDays}
                      activeWindow={activeWindow}
                      onActiveWindowChange={onActiveWindowChange}
                      density="overlay"
                    />

                    <CampaignInlineIssuesPanel campaign={chartSourceCampaign} campaignId={campaign.id} statusDays={visibleIssueStatusDays} className="mt-3" />
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState title="Кампании не найдены" text="Для товара нет кампаний, которые можно показать в расширенном окне." />
          )}
        </div>
      </div>
    </div>
  );
}

function ProductOverviewChartsOverlayDialog({
  product,
  chartProduct,
  activeWindow,
  onActiveWindowChange,
  onClose,
}: {
  product: ProductSummary | null;
  chartProduct?: ProductSummary | null;
  activeWindow: OverviewWindow;
  onActiveWindowChange: (value: OverviewWindow) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!product) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeydown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [onClose, product]);

  if (!product) {
    return null;
  }

  const chartSourceProduct = chartProduct?.article === product.article ? chartProduct : product;

  return (
    <div className="fixed inset-0 z-[5000] flex items-center justify-center p-1 sm:p-2">
      <button type="button" aria-label="Закрыть" className="absolute inset-0 bg-[rgba(38,33,58,0.28)] backdrop-blur-sm" onClick={onClose} />
      <div className="glass-panel relative z-[5001] flex h-[calc(100vh-8px)] max-h-[calc(100vh-8px)] w-full max-w-[calc(100vw-8px)] flex-col overflow-hidden rounded-[34px]">
        <div className="shrink-0 flex items-start justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3 sm:px-5 sm:py-3.5">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.22em] text-brand-200">{product.article}</p>
            <h2 className="mt-1 font-display text-[1.6rem] font-semibold leading-[1.05] text-[var(--color-ink)]">Графики товара</h2>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{formatDateRange(chartSourceProduct.period.current_start, chartSourceProduct.period.current_end)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="metric-chip rounded-2xl p-2.5 text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4 sm:px-6 sm:py-5">
          <ProductOverviewCharts
            product={chartSourceProduct}
            activeWindow={activeWindow}
            onActiveWindowChange={onActiveWindowChange}
            layout="overlay"
          />
        </div>
      </div>
    </div>
  );
}

function LegacyTabBar({
  activeTab,
  onChange,
  product,
  onHeightChange,
  stickyTopOffset = 84,
  className,
}: {
  activeTab: ProductTab;
  onChange: (tab: ProductTab) => void;
  product: ProductSummary;
  onHeightChange?: (height: number) => void;
  stickyTopOffset?: number;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const [layout, setLayout] = useState({ height: 0, width: 0, left: 0 });
  const tabs: Array<{ value: ProductTab; label: string }> = [
    { value: "overview", label: "Обзор" },
    { value: "daily", label: "Аналитика" },
    { value: "campaign-status", label: "Статусы РК" },
    { value: "clusters", label: "Кластеры" },
    { value: "campaign-heatmap", label: "Heatmap РК" },
    { value: "bids", label: "Ставки" },
  ];

  useEffect(() => {
    if (!rootRef.current || !innerRef.current) {
      return;
    }
    const wrapper = rootRef.current;
    const inner = innerRef.current;
    const updateLayout = () => {
      const wrapperRect = wrapper.getBoundingClientRect();
      const innerHeight = Math.ceil(inner.getBoundingClientRect().height);
      setLayout((current) => {
        const next = {
          height: innerHeight,
          width: Math.ceil(wrapperRect.width),
          left: Math.round(wrapperRect.left),
        };
        return current.height === next.height && current.width === next.width && current.left === next.left ? current : next;
      });
      onHeightChange?.(innerHeight);
      setIsPinned(wrapperRect.top <= stickyTopOffset);
    };

    updateLayout();
    window.addEventListener("scroll", updateLayout, { passive: true });
    window.addEventListener("resize", updateLayout);

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => updateLayout());
      observer.observe(wrapper);
      observer.observe(inner);
      return () => {
        window.removeEventListener("scroll", updateLayout);
        window.removeEventListener("resize", updateLayout);
        observer.disconnect();
      };
    }

    return () => {
      window.removeEventListener("scroll", updateLayout);
      window.removeEventListener("resize", updateLayout);
    };
  }, [onHeightChange, stickyTopOffset]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "product-tabbar-sticky relative z-[38] w-full",
        className,
      )}
      style={layout.height ? { minHeight: `${layout.height}px` } : undefined}
    >
      <div
        ref={innerRef}
        className="flex w-full flex-wrap gap-1.5 rounded-[16px] border border-[var(--color-line)] bg-[rgba(248,247,252,0.88)] p-1.5 backdrop-blur-md shadow-[0_12px_30px_rgba(44,35,66,0.06)]"
        style={
          isPinned
            ? {
                position: "fixed",
                top: `${stickyTopOffset}px`,
                left: "18px",
                right: "18px",
                width: "auto",
                zIndex: 38,
              }
            : undefined
        }
      >
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.value}
            onClick={() => onChange(tab.value)}
            className={cn(
              "rounded-[11px] px-3.5 py-2 text-[13px] font-medium leading-none transition",
              activeTab === tab.value
                ? "bg-white text-[var(--color-ink)] shadow-[0_8px_20px_rgba(44,35,66,0.07)]"
                : "text-[var(--color-muted)] hover:bg-white/70 hover:text-[var(--color-ink)]",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ProductPage() {
  const { payload, comparePayload, trackedArticles, start, end, payloadIsCached = false } = useLoaderData() as ProductLoaderData;
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [activeTab, setActiveTab] = useState<ProductTab>("overview");
  const [clusterTarget, setClusterTarget] = useState<ClusterDialogTarget | null>(null);
  const [bidHistoryTarget, setBidHistoryTarget] = useState<CampaignBidHistoryDialogTarget | null>(null);
  const [budgetHistoryTarget, setBudgetHistoryTarget] = useState<CampaignBudgetHistoryDialogTarget | null>(null);
  const [isOverviewChartsOverlayOpen, setOverviewChartsOverlayOpen] = useState(false);
  const [isCampaignChartsOverlayOpen, setCampaignChartsOverlayOpen] = useState(false);
  const [visibleCampaignIds, setVisibleCampaignIds] = useState<number[]>([]);
  const [payloadState, setPayloadState] = useState(payload);
  const [comparePayloadState, setComparePayloadState] = useState<ProductsResponse | null>(comparePayload);
  const [isCompareLoading, setIsCompareLoading] = useState(false);
  const [isPayloadRefreshing, setIsPayloadRefreshing] = useState(false);
  const [isCompareEnabled, setIsCompareEnabled] = useState(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.localStorage.getItem(COMPARE_ENABLED_STORAGE_KEY) !== "0";
  });
  const [topNavHeight, setTopNavHeight] = useState(76);
  const [tabBarHeight, setTabBarHeight] = useState(58);
  const [chartProduct, setChartProduct] = useState<ProductSummary | null>(null);
  const [isChartProductLoading, setIsChartProductLoading] = useState(false);
  const [overviewChartsWindow, setOverviewChartsWindow] = useState<OverviewWindow>(14);
  const overviewChartsWindowKeyRef = useRef<string | null>(null);
  const [campaignOverviewWindow, setCampaignOverviewWindow] = useState<OverviewWindow>(14);
  const campaignOverviewWindowKeyRef = useRef<string | null>(null);
  const [overviewErrorsWindow, setOverviewErrorsWindow] = useState<OverviewWindow>(14);
  const overviewErrorsWindowKeyRef = useRef<string | null>(null);
  const overviewSummaryRef = useRef<HTMLDivElement | null>(null);
  const overviewLeftSideRef = useRef<HTMLDivElement | null>(null);
  const overviewSignalsRef = useRef<HTMLDivElement | null>(null);
  const overviewBudgetRef = useRef<HTMLDivElement | null>(null);
  const [overviewHeatmapHeight, setOverviewHeatmapHeight] = useState<number | null>(null);
  const compareFetchAbortRef = useRef<AbortController | null>(null);
  const compareAutoLoadKeyRef = useRef<string | null>(null);
  const compareCacheRef = useRef<Map<string, ProductsResponse>>(new Map());
  const chartFetchAbortRef = useRef<AbortController | null>(null);
  const chartFetchKeyRef = useRef<string | null>(null);
  const chartFetchPromiseRef = useRef<Promise<ProductSummary | null> | null>(null);

  const currentProduct = payloadState.products[0] ?? null;
  const overviewHeatmapMinHeight = resolveOverviewHeatmapMinHeight(currentProduct?.schedule_aggregate.days.length);
  const compareProduct = comparePayloadState?.products[0] ?? null;
  const effectiveCompareProduct = isCompareEnabled ? compareProduct : null;
  const appliedStart = start || currentProduct?.period.current_start || "";
  const appliedEnd = end || currentProduct?.period.current_end || "";
  const appliedPreset = getRangePreset(appliedStart, appliedEnd);
  const compareRange = useMemo(() => resolveLoaderRange(appliedStart, appliedEnd), [appliedStart, appliedEnd]);
  const compareRequestKey = `${trackedArticles.join(",")}:${compareRange.compareStart}:${compareRange.compareEnd}`;
  const [draftStart, setDraftStart] = useState(appliedStart);
  const [draftEnd, setDraftEnd] = useState(appliedEnd);
  const [draftPreset, setDraftPreset] = useState(appliedPreset);

  useEffect(() => {
    setActiveTab("overview");
    setBidHistoryTarget(null);
    setBudgetHistoryTarget(null);
    setOverviewChartsOverlayOpen(false);
    setCampaignChartsOverlayOpen(false);
  }, [currentProduct?.article]);

  useEffect(() => {
    setPayloadState(payload);
  }, [payload]);

  useEffect(() => {
    setDraftStart(appliedStart);
    setDraftEnd(appliedEnd);
    setDraftPreset(appliedPreset);
  }, [appliedStart, appliedEnd, appliedPreset]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.__xwayProductAppReady = true;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !payloadState.products.length) {
      return;
    }
    try {
      window.sessionStorage.setItem(
        PRODUCT_PAGE_CACHE_STORAGE_KEY,
        JSON.stringify({
          payload: payloadState,
          comparePayload: null,
          trackedArticles,
          start: appliedStart,
          end: appliedEnd,
          payloadIsCached: false,
        } satisfies ProductLoaderData),
      );
    } catch {
      // Ignore cache write failures; the page should continue rendering.
    }
  }, [appliedEnd, appliedStart, payloadState, trackedArticles]);

  useEffect(() => {
    if (!payloadIsCached) {
      setIsPayloadRefreshing(false);
      return;
    }

    const controller = new AbortController();
    setIsPayloadRefreshing(true);

    fetchProducts({
      articles: trackedArticles,
      start: start,
      end: end,
      campaignMode: "full",
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) {
          return;
        }
        setPayloadState(response);
      })
      .catch(() => {
        // Keep cached content on screen if the refresh fails.
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsPayloadRefreshing(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [end, payloadIsCached, start, trackedArticles]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(COMPARE_ENABLED_STORAGE_KEY, isCompareEnabled ? "1" : "0");
  }, [isCompareEnabled]);

  useEffect(() => {
    compareFetchAbortRef.current?.abort();
    compareFetchAbortRef.current = null;
    compareAutoLoadKeyRef.current = null;
    if (comparePayload) {
      compareCacheRef.current.set(compareRequestKey, comparePayload);
    }
    setComparePayloadState(comparePayload ?? compareCacheRef.current.get(compareRequestKey) ?? null);
    setIsCompareLoading(false);
  }, [comparePayload, compareRequestKey, appliedStart, appliedEnd, trackedArticles.join(",")]);

  useEffect(() => {
    if (isCompareEnabled) {
      return;
    }
    compareFetchAbortRef.current?.abort();
    compareFetchAbortRef.current = null;
    compareAutoLoadKeyRef.current = null;
    setIsCompareLoading(false);
  }, [isCompareEnabled]);

  useEffect(() => {
    if (!currentProduct) {
      setVisibleCampaignIds([]);
      return;
    }
    setVisibleCampaignIds((current) => buildVisibleCampaignIds(currentProduct.campaigns, current));
  }, [currentProduct]);

  useEffect(() => {
    const summaryNode = overviewSummaryRef.current;
    const leftSideNode = overviewLeftSideRef.current;
    const signalsNode = overviewSignalsRef.current;
    const budgetNode = overviewBudgetRef.current;
    if (!summaryNode || !leftSideNode || !signalsNode || !budgetNode || typeof window === "undefined") {
      setOverviewHeatmapHeight(null);
      return;
    }

    const mediaQuery = window.matchMedia("(min-width: 1280px)");

    const updateOverviewHeatmapHeight = () => {
      if (!mediaQuery.matches) {
        setOverviewHeatmapHeight((current) => (current === null ? current : null));
        return;
      }

      const signalsHeight = signalsNode.getBoundingClientRect().height;
      const budgetHeight = budgetNode.getBoundingClientRect().height;
      const styles = window.getComputedStyle(leftSideNode);
      const gap = Number.parseFloat(styles.rowGap || styles.gap || "0") || 0;
      const nextHeight = Math.max(budgetHeight - signalsHeight - gap, overviewHeatmapMinHeight);

      setOverviewHeatmapHeight((current) => (current !== null && Math.abs(current - nextHeight) < 0.5 ? current : nextHeight));
    };

    updateOverviewHeatmapHeight();
    window.addEventListener("resize", updateOverviewHeatmapHeight);

    const handleMediaChange = () => updateOverviewHeatmapHeight();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleMediaChange);
    } else {
      mediaQuery.addListener(handleMediaChange);
    }

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => updateOverviewHeatmapHeight()) : null;
    observer?.observe(summaryNode);
    observer?.observe(leftSideNode);
    observer?.observe(signalsNode);
    observer?.observe(budgetNode);

    return () => {
      window.removeEventListener("resize", updateOverviewHeatmapHeight);
      if (typeof mediaQuery.removeEventListener === "function") {
        mediaQuery.removeEventListener("change", handleMediaChange);
      } else {
        mediaQuery.removeListener(handleMediaChange);
      }
      observer?.disconnect();
    };
  }, [currentProduct?.article, currentProduct?.period.current_start, currentProduct?.period.current_end, overviewHeatmapMinHeight, visibleCampaignIds.join(",")]);

  useEffect(() => {
    if (!currentProduct) {
      overviewChartsWindowKeyRef.current = null;
      return;
    }
    const nextWindow = resolveOverviewWindow(currentProduct.period.span_days);
    const nextKey = `${currentProduct.article}:${currentProduct.period.current_start || ""}:${currentProduct.period.current_end || ""}`;
    setOverviewChartsWindow((current) => {
      if (overviewChartsWindowKeyRef.current !== nextKey) {
        overviewChartsWindowKeyRef.current = nextKey;
        return nextWindow;
      }
      return current;
    });
  }, [currentProduct?.article, currentProduct?.period.current_start, currentProduct?.period.current_end, currentProduct?.period.span_days]);

  useEffect(() => {
    if (!currentProduct) {
      campaignOverviewWindowKeyRef.current = null;
      return;
    }
    const nextWindow = resolveOverviewWindow(currentProduct.period.span_days);
    const nextKey = `${currentProduct.article}:${currentProduct.period.current_start || ""}:${currentProduct.period.current_end || ""}`;
    setCampaignOverviewWindow((current) => {
      if (campaignOverviewWindowKeyRef.current !== nextKey) {
        campaignOverviewWindowKeyRef.current = nextKey;
        return nextWindow;
      }
      return current;
    });
  }, [currentProduct?.article, currentProduct?.period.current_start, currentProduct?.period.current_end, currentProduct?.period.span_days]);

  useEffect(() => {
    if (!currentProduct) {
      overviewErrorsWindowKeyRef.current = null;
      return;
    }
    const nextKey = `${currentProduct.article}:${currentProduct.period.current_start || ""}:${currentProduct.period.current_end || ""}`;
    setOverviewErrorsWindow((current) => {
      if (overviewErrorsWindowKeyRef.current !== nextKey) {
        overviewErrorsWindowKeyRef.current = nextKey;
        return 14;
      }
      return current;
    });
  }, [currentProduct?.article, currentProduct?.period.current_start, currentProduct?.period.current_end]);

  useEffect(() => {
    chartFetchAbortRef.current?.abort();
    chartFetchAbortRef.current = null;
    chartFetchKeyRef.current = null;
    chartFetchPromiseRef.current = null;
    setChartProduct(null);
    setIsChartProductLoading(false);
  }, [currentProduct?.article, currentProduct?.period.current_end, currentProduct?.period.span_days]);

  useEffect(
    () => () => {
      compareFetchAbortRef.current?.abort();
      chartFetchAbortRef.current?.abort();
    },
    [],
  );

  const openClusterDialog = (campaignId: number, campaignName: string, cluster: ClusterItem) => {
    if (!currentProduct) {
      return;
    }
    setClusterTarget({
      shopId: currentProduct.shop.id,
      productId: currentProduct.product_id,
      campaignId,
      normqueryId: cluster.normquery_id,
      clusterName: cluster.name,
      campaignName,
      productAverageCheck: buildBoardMetrics(currentProduct).averageCheck,
      start: appliedStart,
      end: appliedEnd,
    });
  };

  const openBidHistoryDialog = (campaign: CampaignSummary) => {
    if (!currentProduct) {
      return;
    }
    setBidHistoryTarget({
      productArticle: currentProduct.article,
      campaign,
      rangeLabel: formatDateRange(appliedStart, appliedEnd),
    });
  };

  const openBudgetHistoryDialog = (campaign: CampaignSummary) => {
    if (!currentProduct) {
      return;
    }
    setBudgetHistoryTarget({
      productArticle: currentProduct.article,
      campaign,
    });
  };

  const navigateToProduct = (next: {
    article?: string;
    start?: string | null;
    end?: string | null;
  }) => {
    const nextArticle = next.article ?? currentProduct?.article ?? trackedArticles[0] ?? "";
    const nextStart = next.start ?? appliedStart;
    const nextEnd = next.end ?? appliedEnd;
    navigate(`/product${buildProductSearch({ article: nextArticle, start: nextStart, end: nextEnd })}`);
  };

  const handlePresetChange = (nextPreset: string) => {
    if (nextPreset === "custom") {
      return;
    }
    const nextRange = buildPresetRange(nextPreset);
    setDraftStart(nextRange.start);
    setDraftEnd(nextRange.end);
    setDraftPreset(nextPreset);
  };

  const handleRangeChange = (nextRange: { start: string; end: string }) => {
    setDraftStart(nextRange.start);
    setDraftEnd(nextRange.end);
    setDraftPreset(getRangePreset(nextRange.start, nextRange.end));
  };

  const handleToolbarRefresh = () => {
    if (draftStart === appliedStart && draftEnd === appliedEnd) {
      revalidator.revalidate();
      return;
    }
    navigateToProduct({ start: draftStart, end: draftEnd });
  };

  const handleToggleVisibleCampaign = (campaignId: number) => {
    if (!currentProduct) {
      return;
    }
    setVisibleCampaignIds((current) => {
      const next = buildVisibleCampaignIds(currentProduct.campaigns, current);
      if (next.includes(campaignId)) {
        if (next.length === 1) {
          return next;
        }
        return next.filter((id) => id !== campaignId);
      }
      return buildVisibleCampaignIds(currentProduct.campaigns, [...next, campaignId]);
    });
  };

  const ensureChartProduct = useCallback(() => {
    if (!currentProduct || (currentProduct.period.span_days || 0) >= CHART_PRELOAD_DAYS) {
      return Promise.resolve(currentProduct ?? null);
    }

    const preloadRange = resolveChartPreloadRange(currentProduct.period.current_end, CHART_PRELOAD_DAYS);
    const requestKey = `${currentProduct.article}:${preloadRange.start}:${preloadRange.end}`;
    const existingChartProduct =
      chartProduct?.article === currentProduct.article && chartProduct.period.current_start === preloadRange.start && chartProduct.period.current_end === preloadRange.end
        ? chartProduct
        : null;

    if (existingChartProduct) {
      return Promise.resolve(existingChartProduct);
    }

    if (chartFetchPromiseRef.current && chartFetchKeyRef.current === requestKey) {
      return chartFetchPromiseRef.current;
    }

    chartFetchAbortRef.current?.abort();
    const controller = new AbortController();
    chartFetchAbortRef.current = controller;
    chartFetchKeyRef.current = requestKey;
    setIsChartProductLoading(true);

    const requestPromise = fetchProducts({
      articles: [currentProduct.article],
      start: preloadRange.start,
      end: preloadRange.end,
      campaignMode: "full",
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) {
          return null;
        }
        const nextProduct = response.products.find((product) => product.article === currentProduct.article) ?? null;
        setChartProduct(nextProduct);
        return nextProduct;
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setChartProduct(null);
        }
        return null;
      })
      .finally(() => {
        if (chartFetchAbortRef.current === controller) {
          chartFetchAbortRef.current = null;
        }
        if (chartFetchKeyRef.current === requestKey) {
          chartFetchKeyRef.current = null;
          chartFetchPromiseRef.current = null;
        }
        if (!controller.signal.aborted) {
          setIsChartProductLoading(false);
        }
      });

    chartFetchPromiseRef.current = requestPromise;
    return requestPromise;
  }, [chartProduct, currentProduct]);

  const maybeLoadExtendedCharts = useCallback(
    (nextWindow: OverviewWindow) => {
      if (!currentProduct) {
        return;
      }
      if (nextWindow > (currentProduct.period.span_days || 0)) {
        void ensureChartProduct();
      }
    },
    [currentProduct, ensureChartProduct],
  );

  const handleOverviewChartsWindowChange = useCallback(
    (nextWindow: OverviewWindow) => {
      setOverviewChartsWindow(nextWindow);
      maybeLoadExtendedCharts(nextWindow);
    },
    [maybeLoadExtendedCharts],
  );

  const handleCampaignOverviewWindowChange = useCallback(
    (nextWindow: OverviewWindow) => {
      setCampaignOverviewWindow(nextWindow);
      maybeLoadExtendedCharts(nextWindow);
    },
    [maybeLoadExtendedCharts],
  );

  const handleOverviewErrorsWindowChange = useCallback(
    (nextWindow: OverviewWindow) => {
      setOverviewErrorsWindow(nextWindow);
      maybeLoadExtendedCharts(nextWindow);
    },
    [maybeLoadExtendedCharts],
  );

  const handleOpenOverviewChartsOverlay = useCallback(() => {
    setOverviewChartsOverlayOpen(true);
    void ensureChartProduct();
  }, [ensureChartProduct]);

  const handleOpenCampaignChartsOverlay = useCallback(() => {
    setCampaignChartsOverlayOpen(true);
    void ensureChartProduct();
  }, [ensureChartProduct]);

  useEffect(() => {
    if (!currentProduct) {
      return;
    }
    if ((currentProduct.period.span_days || 0) >= 3) {
      return;
    }
    void ensureChartProduct();
  }, [currentProduct, ensureChartProduct]);

  const handleLoadCompare = useCallback(() => {
    if (!isCompareEnabled || isCompareLoading || comparePayloadState) {
      return;
    }

    const controller = new AbortController();
    compareFetchAbortRef.current?.abort();
    compareFetchAbortRef.current = controller;
    setIsCompareLoading(true);

    fetchProducts({
      articles: trackedArticles,
      start: compareRange.compareStart,
      end: compareRange.compareEnd,
      campaignMode: "summary",
      heavyCampaignIds: visibleCampaignIds,
      signal: controller.signal,
    })
      .then((response) => {
        if (!controller.signal.aborted) {
          compareCacheRef.current.set(compareRequestKey, response);
          setComparePayloadState(response);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setComparePayloadState(null);
        }
      })
      .finally(() => {
        if (compareFetchAbortRef.current === controller) {
          compareFetchAbortRef.current = null;
        }
        if (!controller.signal.aborted) {
          setIsCompareLoading(false);
        }
      });
  }, [comparePayloadState, compareRange.compareEnd, compareRange.compareStart, isCompareEnabled, isCompareLoading, trackedArticles, visibleCampaignIds]);

  useEffect(() => {
    if (!isCompareEnabled || comparePayloadState || isCompareLoading || compareAutoLoadKeyRef.current === compareRequestKey) {
      return;
    }
    compareAutoLoadKeyRef.current = compareRequestKey;
    handleLoadCompare();
  }, [comparePayloadState, compareRequestKey, handleLoadCompare, isCompareEnabled, isCompareLoading]);

  useEffect(() => {
    if (!isCompareEnabled || !comparePayloadState) {
      return;
    }
    void ensureChartProduct();
  }, [comparePayloadState, ensureChartProduct, isCompareEnabled]);

  if (!currentProduct) {
    return <EmptyState title="Товар не найден" text="API не вернул ни одного товара по текущему набору артикулов." />;
  }

  const topLevelErrors = Object.entries(currentProduct.errors || {}).filter(([, value]) => Boolean(value));
  const productPath = `/product${buildProductSearch({ article: currentProduct.article, start: draftStart, end: draftEnd })}`;
  const catalogPath = `/catalog${buildCatalogSearch(draftStart, draftEnd)}`;
  const routeNavigationRefreshing = navigation.state !== "idle";
  const dataRefreshing = revalidator.state !== "idle" || isPayloadRefreshing;
  const toolbarRefreshing = dataRefreshing || routeNavigationRefreshing;
  const heroMetrics = buildBoardMetrics(currentProduct);
  const previousHeroMetrics = effectiveCompareProduct ? buildBoardMetrics(effectiveCompareProduct) : null;
  const stocksRuleSummary = resolveStocksRuleSummary(currentProduct);
  const dailySpendSourceProduct =
    chartProduct?.article === currentProduct.article && (chartProduct.period.span_days || 0) >= Math.max(currentProduct.period.span_days || 0, 3)
      ? chartProduct
      : currentProduct;
  const dailySpendSummary = useMemo(() => buildProductDailySpendSummary(dailySpendSourceProduct), [dailySpendSourceProduct]);
  const overviewErrorsSourceProduct =
    overviewErrorsWindow > (currentProduct.period.span_days || 0) && chartProduct?.article === currentProduct.article ? chartProduct : currentProduct;
  const overviewErrorSummaries = useMemo(
    () => buildProductOverviewErrorSummaries(overviewErrorsSourceProduct, dailySpendSummary, overviewErrorsWindow),
    [dailySpendSummary, overviewErrorsSourceProduct, overviewErrorsWindow],
  );
  const hasExtendedChartData =
    (currentProduct.period.span_days || 0) >= CHART_PRELOAD_DAYS ||
    (chartProduct?.article === currentProduct.article &&
      (chartProduct.period.span_days || 0) >= CHART_PRELOAD_DAYS &&
      chartProduct.period.current_end === resolveChartPreloadRange(currentProduct.period.current_end, CHART_PRELOAD_DAYS).end);
  const isOverviewErrorsAwaitingData = overviewErrorsWindow > (currentProduct.period.span_days || 0) && !hasExtendedChartData;
  const isOverviewChartsAwaitingData = overviewChartsWindow > (currentProduct.period.span_days || 0) && !hasExtendedChartData;
  const isCampaignChartsAwaitingData = campaignOverviewWindow > (currentProduct.period.span_days || 0) && !hasExtendedChartData;
  const chartLoadingLabel =
    isOverviewChartsAwaitingData || isCampaignChartsAwaitingData || isOverviewErrorsAwaitingData
      ? `Догружаю данные на ${CHART_PRELOAD_DAYS} дней`
      : "Догружаю графики";
  const wildberriesUrl = /wb|wildberries/i.test(String(currentProduct.shop.marketplace || ""))
    ? buildWildberriesProductUrl(currentProduct.article)
    : null;
  const loadingBadges = [
    dataRefreshing
      ? {
          key: "page",
          label: isPayloadRefreshing ? "Обновляю данные на странице" : "Обновляю данные",
          tone: "page" as const,
        }
      : null,
    isChartProductLoading
      ? {
          key: "charts",
          label: chartLoadingLabel,
          tone: "charts" as const,
        }
      : null,
    isCompareLoading
      ? {
          key: "compare",
          label: "Считаю сравнение",
          tone: "page" as const,
        }
      : null,
  ].filter(Boolean) as Array<{ key: string; label: string; tone: "page" | "charts" }>;

  const handleTopNavHeightChange = useCallback((nextHeight: number) => {
    setTopNavHeight((current) => (current === nextHeight || nextHeight <= 0 ? current : nextHeight));
  }, []);

  return (
    <>
      <div className="space-y-4" style={{ ["--page-loading-offset" as string]: "90px" }}>
        {loadingBadges.length ? (
          <div className="page-corner-status" aria-live="polite">
            {loadingBadges.map((badge) => (
              <div
                key={badge.key}
                role="status"
                className={cn("page-corner-status-badge", badge.tone === "charts" && "is-charts")}
              >
                <span className="page-corner-status-dot" aria-hidden="true" />
                <span>{badge.label}</span>
              </div>
            ))}
          </div>
        ) : null}
        <ProductTopToolbar
          start={draftStart}
          end={draftEnd}
          preset={draftPreset}
          productPath={productPath}
          catalogPath={catalogPath}
          activeView="product"
          compareEnabled={isCompareEnabled}
          onCompareEnabledChange={setIsCompareEnabled}
          onRangeChange={handleRangeChange}
          onPresetChange={handlePresetChange}
          onRefresh={handleToolbarRefresh}
          onScrollTop={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          refreshing={toolbarRefreshing}
          onHeightChange={handleTopNavHeightChange}
        />

        <div
          className="page-viewport"
          style={{
            ["--top-nav-height" as string]: `${topNavHeight}px`,
            ["--top-nav-gap" as string]: "8px",
            ["--product-tabbar-height" as string]: `${tabBarHeight}px`,
          }}
        >
          <div className="page-shell space-y-4">
            <LegacyTabBar
              activeTab={activeTab}
              onChange={setActiveTab}
              onHeightChange={setTabBarHeight}
              stickyTopOffset={topNavHeight + 8}
              product={currentProduct}
            />

            {activeTab === "overview" ? (
              <article className={cn(PANEL_CLASS, "product-panel relative z-0 overflow-visible p-4 sm:p-5")}>
                <div className="absolute right-[-5rem] top-[-5rem] h-56 w-56 rounded-full bg-[radial-gradient(circle,_rgba(255,157,92,0.08)_0%,_rgba(255,157,92,0)_72%)]" />
                <div className="product-toolbar">
                  <div className="product-header">
                  <div className="product-cover w-[88px] overflow-hidden rounded-[24px] border border-[var(--color-line)] bg-[var(--color-surface-strong)] shadow-[0_10px_24px_rgba(44,35,66,0.08)] aspect-[51/68] sm:w-[102px]">
                    {currentProduct.identity.image_url ? <img src={currentProduct.identity.image_url} alt={currentProduct.identity.name} className="h-full w-full object-cover object-center" /> : null}
                  </div>
                  <div className="product-heading min-w-0">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <MetaPill tone={currentProduct.shop.expired ? "warn" : "good"}>{currentProduct.shop.expired ? "Неактивен" : "Активен"}</MetaPill>
                      <span className="text-xs font-bold uppercase tracking-wider text-[var(--color-muted)]">{currentProduct.identity.brand || "Без бренда"}</span>
                      <span className="size-1 rounded-full bg-[var(--color-line)]" />
                      <span className="text-xs text-[var(--color-muted)]">{currentProduct.identity.category_keyword || "—"}</span>
                    </div>
                    <h2 className="mb-1.5 font-display leading-tight text-[var(--color-ink)]" style={{ fontSize: "clamp(1.1rem, 1.6vw, 1.5rem)" }}>
                      {currentProduct.identity.name || `Артикул ${currentProduct.article}`}
                    </h2>
                    <div className="product-meta flex flex-wrap items-center gap-3">
                      <span className="text-xs text-[var(--color-muted)]">
                        Артикул: <strong className="font-semibold text-[var(--color-ink)]">{currentProduct.article}</strong>
                      </span>
                      {currentProduct.shop.name ? <span className="text-xs text-[var(--color-muted)]">ИП: {currentProduct.shop.name}</span> : null}
                      {wildberriesUrl ? (
                        <a
                          href={wildberriesUrl}
                          target="_blank"
                          rel="noreferrer"
                          className={EXTERNAL_PILL_LINK_CLASS}
                        >
                          <ExternalLink className="size-3.5" />
                          WB
                        </a>
                      ) : currentProduct.shop.marketplace ? <span className="text-xs text-[var(--color-teal)]">{currentProduct.shop.marketplace}</span> : null}
                      {currentProduct.product_url ? (
                        <a
                          href={currentProduct.product_url}
                          target="_blank"
                          rel="noreferrer"
                          className={EXTERNAL_PILL_LINK_CLASS}
                        >
                          <ExternalLink className="size-3.5" />
                          XWAY
                        </a>
                      ) : null}
                      <span className="text-xs text-[var(--color-muted)]">{formatDateRange(currentProduct.period.current_start, currentProduct.period.current_end)}</span>
                    </div>
                  </div>
                  </div>
                </div>

                <div
                  ref={overviewSummaryRef}
                  className="product-overview-summary mt-4 grid grid-cols-1 gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                  style={{ width: "100%", justifySelf: "stretch" }}
                >
                  <div ref={overviewLeftSideRef} className="product-overview-side">
                    <div ref={overviewSignalsRef} className="product-overview-signals grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      <ProductSignalCard label="Остаток" value={`${formatNumber(currentProduct.stock.current)} шт`} />
                      <ProductSignalCard
                        label="Средний чек"
                        value={formatMoney(heroMetrics.averageCheck)}
                        delta={formatSignedMoney(diffValue(heroMetrics.averageCheck, previousHeroMetrics?.averageCheck))}
                        deltaClassName={deltaTone(diffValue(heroMetrics.averageCheck, previousHeroMetrics?.averageCheck), true)}
                      />
                      <ProductSignalCard
                        label="Расход за период"
                        value={formatMoney(heroMetrics.spend, true)}
                        delta={formatSignedMoney(diffValue(heroMetrics.spend, previousHeroMetrics?.spend))}
                        deltaClassName={deltaTone(diffValue(heroMetrics.spend, previousHeroMetrics?.spend), false)}
                      />
                      <ProductSignalCard
                        label="Стоп всех РК"
                        value={stocksRuleSummary.value}
                        valueClassName={stocksRuleSummary.valueClassName}
                        hint={stocksRuleSummary.hint}
                        hintClassName={stocksRuleSummary.hintClassName}
                      />
                    </div>
                    <div
                      className="campaign-inline-heatmap product-hero-heatmap product-overview-heatmap is-compact is-inline-row"
                      style={
                        overviewHeatmapHeight !== null
                          ? { height: `${overviewHeatmapHeight}px` }
                          : undefined
                      }
                    >
                      <ScheduleMatrix
                        schedule={currentProduct.schedule_aggregate}
                        compact
                        showCounts={false}
                        showDayHeaderLabel={false}
                        dayLabelWidth={22}
                        stretchToFitHeight
                      />
                    </div>
                  </div>
                  <div className="product-overview-side">
                    <div ref={overviewBudgetRef} className="product-overview-budget-shell">
                      <CampaignBudgetProgressCard
                        label="Расходы за сегодня"
                        current={dailySpendSummary.current}
                        total={dailySpendSummary.total}
                        tone={resolveUsageTone(
                          dailySpendSummary.current !== null && dailySpendSummary.total !== null && dailySpendSummary.total > 0
                            ? (dailySpendSummary.current / dailySpendSummary.total) * 100
                            : null,
                        )}
                        statusText={dailySpendSummary.statusText}
                        disabled={!dailySpendSummary.enabled}
                        showDashTotalWhenDisabled
                        showDashPercentWhenDisabled
                        titleCase
                        className="product-daily-spend-card product-overview-budget"
                        details={
                          dailySpendSummary.activeRules.length || dailySpendSummary.campaignTracks.length ? (
                            <div className="campaign-budget-progress-meta">
                              {dailySpendSummary.activeRules.length ? (
                                <div className="campaign-budget-progress-detail-group">
                                  <span className="campaign-budget-progress-detail-label">Лимит товара</span>
                                  <div className="campaign-budget-progress-detail-chips is-compact">
                                    {dailySpendSummary.activeRules.map((item) => (
                                      <span
                                        key={item.id}
                                        className={cn(
                                          "campaign-budget-progress-detail-chip",
                                          item.campaignId ? "is-campaign" : item.tone === "budget" ? "is-budget" : "is-limit",
                                        )}
                                        style={buildCampaignAccentStyle(item.campaignId)}
                                      >
                                        {item.label}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                              {dailySpendSummary.campaignTracks.length ? (
                                <div className="campaign-budget-progress-detail-group">
                                  <span className="campaign-budget-progress-detail-label">Траты по РК</span>
                                  <div
                                    className={cn(
                                      "campaign-budget-progress-track-list",
                                      dailySpendSummary.campaignTracks.length > 1 && "is-pair",
                                    )}
                                  >
                                    {dailySpendSummary.campaignTracks.map((item) => {
                                      const normalizedPercent =
                                        item.limit !== null && item.limit > 0
                                          ? Math.max(0, Math.min((item.current / item.limit) * 100, 100))
                                        : item.current > 0
                                          ? 100
                                          : 0;
                                    const trackZones = resolveCampaignZoneBadges(item.campaign);
                                    const orderedBadges = [...item.badges].sort((left, right) => {
                                      if (left.tone === right.tone) {
                                        return 0;
                                      }
                                      return left.tone === "budget" ? -1 : 1;
                                    });
                                    const bidKind = resolveBidKind(item.campaign);
                                    const bidTypeLabel = bidKind === "cpc" ? "CPC" : "CPM";

                                    return (
                                      <div key={item.id} className="campaign-budget-progress-track-row" style={buildCampaignStatusAccentStyle(item.campaign)}>
                                        <div className="campaign-budget-progress-track-copy">
                                          <div className="campaign-budget-progress-track-head" title={`${item.label}${item.meta ? ` · ${item.meta}` : ""}`}>
                                            <div className="campaign-budget-progress-track-title-row">
                                              <CampaignStatusIconBadge campaign={item.campaign} className="campaign-budget-progress-track-pill-status" />
                                              <span className="campaign-budget-progress-track-type-pill">{bidTypeLabel}</span>
                                              {trackZones.length ? (
                                                <span className="campaign-budget-progress-track-zone-inline" aria-hidden="true">
                                                  {trackZones.map((zone) => {
                                                    const ZoneIcon = zone.icon;
                                                    return (
                                                      <span key={`${item.id}-${zone.key}`} className="campaign-budget-progress-track-pill-zone">
                                                        <ZoneIcon className="size-3" />
                                                      </span>
                                                    );
                                                  })}
                                                </span>
                                              ) : null}
                                              <span className="campaign-budget-progress-track-pill-label">{item.label}</span>
                                            </div>
                                          </div>
                                          {orderedBadges.length ? (
                                            <div className="campaign-budget-progress-track-badges">
                                              {orderedBadges.map((badge) => (
                                                <span
                                                  key={badge.id}
                                                  className={cn(
                                                    "campaign-budget-progress-track-badge",
                                                    badge.active ? "is-active" : "is-inactive",
                                                    badge.tone === "budget" ? "is-budget" : "is-limit",
                                                  )}
                                                >
                                                  {badge.label}
                                                </span>
                                              ))}
                                            </div>
                                          ) : null}
                                        </div>
                                        <div className="campaign-budget-progress-track-metrics">
                                          <div
                                            className="campaign-budget-progress-track-bar"
                                            style={{ ["--track-progress" as string]: `${normalizedPercent}%` } as CSSProperties}
                                            aria-hidden="true"
                                          >
                                            <span className="campaign-budget-progress-track-bar-fill" />
                                          </div>
                                          <div className="campaign-budget-progress-track-side">
                                            <span className="campaign-budget-progress-track-percent">{`${Math.round(normalizedPercent)}%`}</span>
                                            <strong className="campaign-budget-progress-track-value">
                                              {formatMoney(item.current, true)} / {item.limit !== null ? formatMoney(item.limit, true) : "—"}
                                            </strong>
                                            {item.forecastLabel ? (
                                              <span className="campaign-budget-progress-track-forecast">{item.forecastLabel}</span>
                                            ) : null}
                                          </div>
                                        </div>
                                      </div>
                                    );
                                    })}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          ) : null
                        }
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-4">
                  <PerformanceOverviewBoard product={currentProduct} compareProduct={effectiveCompareProduct} />
                </div>
              </article>
            ) : null}

            {topLevelErrors.length ? (
              <div className="rounded-[18px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Не все блоки загрузились: {topLevelErrors.map(([key]) => key).join(", ")}
              </div>
            ) : null}

            <article className={cn(PANEL_CLASS, "p-4 sm:p-5")}>
              <div className="min-w-0">
                {activeTab === "overview"
                  ? renderOverview(
                      currentProduct,
                      overviewErrorSummaries,
                      overviewErrorsWindow,
                      handleOverviewErrorsWindowChange,
                      visibleCampaignIds,
                      handleToggleVisibleCampaign,
                      openBidHistoryDialog,
                      openBudgetHistoryDialog,
                      effectiveCompareProduct,
                      chartProduct,
                      overviewChartsWindow,
                      handleOverviewChartsWindowChange,
                      handleOpenOverviewChartsOverlay,
                      campaignOverviewWindow,
                      handleCampaignOverviewWindowChange,
                      handleOpenCampaignChartsOverlay,
                    )
                  : null}
                {activeTab === "daily" ? <ProductDailyPanel product={currentProduct} /> : null}
                {activeTab === "campaign-status" ? <CampaignStatusSection product={currentProduct} /> : null}
                {activeTab === "clusters" ? <ProductClustersPanel product={currentProduct} openClusterDialog={openClusterDialog} /> : null}
                {activeTab === "campaign-heatmap" ? renderCampaignHeatmap(currentProduct) : null}
                {activeTab === "bids" ? renderBids(currentProduct) : null}
              </div>
            </article>
          </div>
        </div>
      </div>

      <ClusterDetailDialog target={clusterTarget} onClose={() => setClusterTarget(null)} />
      <CampaignBidHistoryDialog target={bidHistoryTarget} onClose={() => setBidHistoryTarget(null)} />
      <CampaignBudgetHistoryDialog target={budgetHistoryTarget} onClose={() => setBudgetHistoryTarget(null)} />
      <ProductOverviewChartsOverlayDialog
        product={isOverviewChartsOverlayOpen ? currentProduct : null}
        chartProduct={chartProduct}
        activeWindow={overviewChartsWindow}
        onActiveWindowChange={handleOverviewChartsWindowChange}
        onClose={() => setOverviewChartsOverlayOpen(false)}
      />
      <CampaignChartsOverlayDialog
        product={isCampaignChartsOverlayOpen ? currentProduct : null}
        chartProduct={chartProduct}
        activeWindow={campaignOverviewWindow}
        onActiveWindowChange={handleCampaignOverviewWindowChange}
        onClose={() => setCampaignChartsOverlayOpen(false)}
      />
    </>
  );
}
