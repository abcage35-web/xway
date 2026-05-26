import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { fetchCatalog, fetchCatalogAutoExclusions, fetchCatalogIssues, fetchCatalogProductDetails, fetchMpvibeStocks, fetchWbCards } from "../lib/api";
import { cn, formatDateRange, formatMoney, formatNumber, formatPercent, getTodayIso, shiftIsoDate, toNumber } from "../lib/format";
import type { CatalogArticle, CatalogAutoExclusionCampaign, CatalogAutoExclusionRow, CatalogCampaignState, CatalogIssuesIssue, CatalogIssuesRow, CatalogResponse, CatalogShop, MpvibeStockInfo, MpvibeStocksResponse, WbCardInfo } from "../lib/types";
import { EmptyState, MetricCard, MetricTable, PageHero, SectionCard, Tabs } from "../components/ui";
import type { TableColumn } from "../components/ui";

type AnalyticsSection = "drr" | "stocks" | "limits" | "limitActivity" | "autoExclusions" | "categories";
type SortDirection = "asc" | "desc";
type DataSource = "XWAY" | "WB" | "MPVibe" | "XWAY/WB" | "Расчет";
type AnalyticsRowSource = "xway" | "mpvibe";
type DrrSortField =
  | "rank"
  | "article"
  | "drr"
  | "stock"
  | "stockMpvibe"
  | "spend"
  | "revenue"
  | "ordersAds"
  | "ordersTotal"
  | "reviews"
  | "bzo"
  | "price"
  | "shop"
  | "name";
type StockSortField =
  | "rank"
  | "article"
  | "stock"
  | "stockMpvibe"
  | "turnover"
  | "spend"
  | "ordersTotal"
  | "campaigns"
  | "activeCampaigns"
  | "enabled"
  | "shop"
  | "name";
type LimitSortField =
  | "rank"
  | "article"
  | "issueCount"
  | "missingSpendLimit"
  | "missingBudgetRule"
  | "spendLimit"
  | "budgetLimit"
  | "stock"
  | "stockMpvibe"
  | "spend"
  | "ordersTotal"
  | "activeCampaigns"
  | "shop"
  | "name";
type LimitActivitySortField =
  | "rank"
  | "article"
  | "issueCount"
  | "maxIncidentHours"
  | "totalHours"
  | "incidents"
  | "spend"
  | "ordersTotal"
  | "stock"
  | "stockMpvibe"
  | "activeCampaigns"
  | "shop"
  | "name";
type AutoExclusionSortField =
  | "rank"
  | "article"
  | "campaignId"
  | "configured"
  | "ruleActive"
  | "ruleDays"
  | "spend"
  | "ordersTotal"
  | "stock"
  | "stockMpvibe"
  | "shop"
  | "name";
type CategorySortField =
  | "rank"
  | "category"
  | "skuCount"
  | "stock"
  | "stockMpvibe"
  | "drrAds"
  | "drrTotal"
  | "spend"
  | "spendShare"
  | "revenueAds"
  | "revenueAdsShare"
  | "revenueTotal"
  | "revenueTotalShare"
  | "ordersAds"
  | "ordersTotal"
  | "campaigns"
  | "activeCampaigns";

interface SortState<TField extends string> {
  field: TField | null;
  direction: SortDirection;
}

interface AnalyticsRowBase {
  ref: string;
  article: string;
  productId: number;
  name: string;
  shopName: string;
  shopId: number;
  productUrl: string;
  imageUrl: string;
  categoryKeyword: string;
  stock: number | null;
  stockMpvibe: number | null;
  spend: number | null;
  revenue: number | null;
  revenueTotal: number | null;
  ordersAds: number | null;
  ordersTotal: number | null;
  views: number | null;
  clicks: number | null;
  atbs: number | null;
  drr: number | null;
  enabled: boolean;
  campaigns: number;
  activeCampaigns: number;
  turnoverDays: number | null;
  source: AnalyticsRowSource;
  campaignStates: CatalogCampaignState[];
}

interface DrrAnalyticsRow extends AnalyticsRowBase {
  wb?: WbCardInfo | null;
}

type RankedDrrRow = DrrAnalyticsRow & { rank: number };
type RankedStockRow = AnalyticsRowBase & { rank: number };
type TableSummaryRow = Partial<Record<string, ReactNode>>;
interface LimitSetupRow extends AnalyticsRowBase {
  activeCampaignStateCount: number;
  spendLimitConfiguredCount: number;
  budgetRuleConfiguredCount: number;
  missingSpendLimit: boolean;
  missingBudgetRule: boolean;
  issueCount: number;
  spendLimit: number | null;
  spendSpentToday: number | null;
  budgetLimit: number | null;
  budgetSpentToday: number | null;
}
type RankedLimitSetupRow = LimitSetupRow & { rank: number };
interface LimitActivityIssueSummary {
  kind: "budget" | "limit";
  title: string;
  hours: number;
  maxIncidentHours: number;
  incidents: number;
  campaignLabels: string[];
  dayLabels: string[];
}
interface LimitActivityRow extends AnalyticsRowBase {
  issues: LimitActivityIssueSummary[];
  issueCount: number;
  totalHours: number;
  maxIncidentHours: number;
  incidents: number;
  campaignLabels: string[];
}
type RankedLimitActivityRow = LimitActivityRow & { rank: number };
interface AutoExclusionCampaignRow extends AnalyticsRowBase {
  productRef: string;
  campaignId: number;
  campaignName: string | null;
  campaignLabel: string;
  paymentType: "cpm" | "cpc" | null;
  statusCode: string | null;
  statusLabel: string | null;
  displayStatus: "active" | "paused" | "freeze" | "muted";
  ruleExists: boolean;
  ruleActive: boolean | null;
  configured: boolean;
  exclusionMode: "all" | "conditions" | "unknown";
  ruleDays: number | null;
  boost: number | null;
  efficiency: number | null;
  popularity: number | null;
  popularityAbove: number | null;
  ctr: number | null;
  ctrView: number | null;
  cpc: number | null;
  cpcView: number | null;
  queriesToExclude: string[];
  queriesNotToExclude: string[];
  ruleError: string | null;
}
type RankedAutoExclusionCampaignRow = AutoExclusionCampaignRow & { rank: number };
interface CategoryDriverRow {
  ref: string;
  shopId: number;
  shopName: string;
  category: string;
  skuCount: number;
  stock: number;
  stockMpvibe: number | null;
  spend: number;
  spendShare: number | null;
  revenueAds: number;
  revenueAdsShare: number | null;
  revenueTotal: number;
  revenueTotalShare: number | null;
  ordersAds: number;
  ordersTotal: number;
  views: number;
  clicks: number;
  atbs: number;
  drrAds: number | null;
  drrTotal: number | null;
  campaigns: number;
  activeCampaigns: number;
}

type RankedCategoryDriverRow = CategoryDriverRow & { rank: number };
type CategoryDriverPieMetric = "spend" | "revenueTotal";
type CategoryDriverPieSlice = {
  key: string;
  name: string;
  value: number;
  color: string;
  row: RankedCategoryDriverRow;
  collapsedCount?: number;
};
type CategoryDriverShopGroup = {
  shopId: number;
  shopName: string;
  rows: RankedCategoryDriverRow[];
};
type SortValue = string | number | boolean | null | undefined;

const DEFAULT_DAYS = 3;
const DEFAULT_LIMIT = 30;
const MAX_DAYS = 30;
const MAX_LIMIT = 200;
const STOCK_MIN_VALUE = 5;
const DEFAULT_AD_OFF_ERROR_STOCK_THRESHOLD = 100;
const AD_OFF_ERROR_STOCK_THRESHOLD_STORAGE_KEY = "xway-drr-analytics-ad-off-error-stock-threshold";
const DEFAULT_CATEGORY_MIN_STOCK = 100;
const CATEGORY_MIN_STOCK_STORAGE_KEY = "xway-drr-analytics-category-min-stock";
const DRR_ANALYTICS_COLUMN_WIDTH_STORAGE_KEY = "xway-drr-analytics-column-widths-v1";
const CATEGORY_DRIVER_PIE_TOOLTIP_WIDTH = 280;
const CATEGORY_DRIVER_PIE_TOOLTIP_GAP = 12;
const CATEGORY_DRIVER_PIE_TOOLTIP_EDGE = 8;
const CATEGORY_DRIVER_PIE_LEGEND_LIMIT = 8;
const CATEGORY_DRIVER_OTHER_COLOR = "#94a3b8";
const LIMIT_DETAILS_BATCH_SIZE = 10;
const LIMIT_ACTIVITY_THRESHOLD_HOURS = 4;
const LIMIT_ACTIVITY_BATCH_SIZE = 6;
const LIMIT_ACTIVITY_DEADLINE_MS = 12000;
const AUTO_EXCLUSIONS_BATCH_SIZE = 8;
const AUTO_EXCLUSIONS_DEADLINE_MS = 12000;
const CATEGORY_DRIVER_CHART_COLORS = [
  "#ff8a2d",
  "#8b64f6",
  "#2dd4bf",
  "#5d88ff",
  "#f05286",
  "#57cf8e",
  "#facc15",
  "#38bdf8",
  "#fb7185",
  "#a78bfa",
  "#34d399",
  "#f59e0b",
];
const RESIZABLE_COLUMN_CONFIG = {
  rank: { default: 52, min: 44, max: 90 },
  product: { default: 380, min: 240, max: 680 },
  links: { default: 106, min: 82, max: 170 },
  article: { default: 116, min: 94, max: 170 },
  category: { default: 320, min: 180, max: 620 },
  skuCount: { default: 104, min: 84, max: 160 },
  categoryDrr: { default: 96, min: 82, max: 150 },
  categoryMoney: { default: 154, min: 128, max: 230 },
  categoryShare: { default: 72, min: 62, max: 110 },
  categoryNumber: { default: 124, min: 96, max: 180 },
  categoryStatus: { default: 132, min: 110, max: 190 },
  share: { default: 72, min: 58, max: 110 },
  drr: { default: 86, min: 72, max: 130 },
  spend: { default: 128, min: 104, max: 200 },
  revenue: { default: 128, min: 104, max: 200 },
  ordersAds: { default: 112, min: 88, max: 170 },
  ordersTotal: { default: 112, min: 92, max: 180 },
  reviews: { default: 126, min: 104, max: 190 },
  bzo: { default: 124, min: 94, max: 190 },
  price: { default: 128, min: 104, max: 180 },
  shop: { default: 190, min: 130, max: 340 },
  stock: { default: 112, min: 88, max: 170 },
  stockMpvibe: { default: 124, min: 98, max: 180 },
  turnover: { default: 142, min: 112, max: 220 },
  limitIssue: { default: 240, min: 180, max: 360 },
  limitActivityIssue: { default: 300, min: 220, max: 460 },
  limitActivityHours: { default: 142, min: 112, max: 190 },
  autoExclusionCampaign: { default: 270, min: 210, max: 440 },
  autoExclusionRule: { default: 230, min: 180, max: 360 },
  limitAmount: { default: 186, min: 146, max: 260 },
  activeCampaigns: { default: 126, min: 104, max: 190 },
  campaigns: { default: 112, min: 86, max: 160 },
  enabled: { default: 126, min: 104, max: 190 },
} as const;

type ResizableColumnKey = keyof typeof RESIZABLE_COLUMN_CONFIG;
type ColumnWidthState = Record<ResizableColumnKey, number>;

function getDefaultColumnWidths(): ColumnWidthState {
  return Object.fromEntries(
    Object.entries(RESIZABLE_COLUMN_CONFIG).map(([key, config]) => [key, config.default]),
  ) as ColumnWidthState;
}

function clampColumnWidth(columnKey: ResizableColumnKey, value: number) {
  const config = RESIZABLE_COLUMN_CONFIG[columnKey];
  if (!Number.isFinite(value)) {
    return config.default;
  }
  return Math.round(Math.max(config.min, Math.min(config.max, value)));
}

function readStoredColumnWidths(): ColumnWidthState {
  const defaults = getDefaultColumnWidths();
  if (typeof window === "undefined") {
    return defaults;
  }
  try {
    const stored = window.localStorage.getItem(DRR_ANALYTICS_COLUMN_WIDTH_STORAGE_KEY);
    if (!stored) {
      return defaults;
    }
    const parsed = JSON.parse(stored) as Partial<Record<ResizableColumnKey, number>>;
    return Object.fromEntries(
      Object.keys(RESIZABLE_COLUMN_CONFIG).map((key) => {
        const columnKey = key as ResizableColumnKey;
        return [columnKey, clampColumnWidth(columnKey, Number(parsed[columnKey] ?? defaults[columnKey]))];
      }),
    ) as ColumnWidthState;
  } catch {
    return defaults;
  }
}

function clampInteger(value: string, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function readStoredAdOffThreshold() {
  if (typeof window === "undefined") {
    return String(DEFAULT_AD_OFF_ERROR_STOCK_THRESHOLD);
  }
  try {
    return window.localStorage.getItem(AD_OFF_ERROR_STOCK_THRESHOLD_STORAGE_KEY) || String(DEFAULT_AD_OFF_ERROR_STOCK_THRESHOLD);
  } catch {
    return String(DEFAULT_AD_OFF_ERROR_STOCK_THRESHOLD);
  }
}

function readStoredCategoryMinStock() {
  if (typeof window === "undefined") {
    return String(DEFAULT_CATEGORY_MIN_STOCK);
  }
  try {
    return window.localStorage.getItem(CATEGORY_MIN_STOCK_STORAGE_KEY) || String(DEFAULT_CATEGORY_MIN_STOCK);
  } catch {
    return String(DEFAULT_CATEGORY_MIN_STOCK);
  }
}

function buildStatsRange(days: number) {
  const end = shiftIsoDate(getTodayIso(), -1);
  return {
    start: shiftIsoDate(end, -(days - 1)),
    end,
  };
}

function articleNumber(article: string) {
  const numeric = Number(article);
  return Number.isFinite(numeric) ? numeric : article;
}

function resolveDrr(article: CatalogArticle) {
  const explicit = toNumber(article.drr);
  if (explicit !== null) {
    return explicit;
  }
  const spend = toNumber(article.expense_sum);
  const revenue = toNumber(article.sum_price);
  return spend !== null && revenue !== null && revenue > 0 ? (spend / revenue) * 100 : null;
}

function computeTurnoverDays(stock: number | null, ordersTotal: number | null, days: number) {
  if (stock === null || ordersTotal === null || ordersTotal <= 0) {
    return null;
  }
  return stock / (ordersTotal / Math.max(days, 1));
}

function flattenCatalogRows(payload: CatalogResponse | null, days: number): AnalyticsRowBase[] {
  if (!payload) {
    return [];
  }
  return payload.shops.flatMap((shop: CatalogShop) =>
    shop.articles.map((article) => {
      const stock = toNumber(article.stock);
      const ordersTotal = toNumber(article.ordered_report);
      return {
        ref: `${shop.id}:${article.product_id}`,
        article: article.article,
        productId: article.product_id,
        name: article.name,
        shopName: shop.name,
        shopId: shop.id,
        productUrl: article.product_url,
        imageUrl: article.image_url,
        categoryKeyword: article.category_keyword,
        stock,
        stockMpvibe: null,
        spend: toNumber(article.expense_sum),
        revenue: toNumber(article.sum_price),
        revenueTotal: toNumber(article.ordered_sum_report),
        ordersAds: toNumber(article.orders),
        ordersTotal,
        views: toNumber(article.views),
        clicks: toNumber(article.clicks),
        atbs: toNumber(article.atbs),
        drr: resolveDrr(article),
        enabled: Boolean(article.enabled && article.is_active),
        campaigns: article.campaign_states.length,
        activeCampaigns: article.campaign_states.filter((campaign) => campaign.active).length,
        turnoverDays: computeTurnoverDays(stock, ordersTotal, days),
        source: "xway",
        campaignStates: article.campaign_states,
      };
    }),
  );
}

function buildMpvibeOnlyRows(stockByArticle: Record<string, MpvibeStockInfo>, baseRows: AnalyticsRowBase[]): AnalyticsRowBase[] {
  const xwayArticles = new Set(baseRows.map((row) => row.article));
  return Object.values(stockByArticle)
    .filter((stock) => !xwayArticles.has(stock.article) && (toNumber(stock.stock_fbo) ?? 0) > 0)
    .map((stock) => {
      const stockFbo = toNumber(stock.stock_fbo);
      return {
        ref: `mpvibe:${stock.card_id ?? stock.article}`,
        article: stock.article,
        productId: 0,
        name: stock.name || `Артикул ${stock.article}`,
        shopName: stock.account_id ? `MPVibe account ${stock.account_id}` : "MPVibe",
        shopId: 0,
        productUrl: "",
        imageUrl: "",
        categoryKeyword: "Только MPVibe",
        stock: null,
        stockMpvibe: stockFbo,
        spend: null,
        revenue: null,
        revenueTotal: null,
        ordersAds: null,
        ordersTotal: null,
        views: null,
        clicks: null,
        atbs: null,
        drr: null,
        enabled: false,
        campaigns: 0,
        activeCampaigns: 0,
        turnoverDays: null,
        source: "mpvibe",
        campaignStates: [],
      };
    });
}

function stockSignal(row: AnalyticsRowBase) {
  return row.stock ?? row.stockMpvibe ?? 0;
}

function compareSortValues(left: SortValue, right: SortValue) {
  const leftMissing = left === null || left === undefined || left === "";
  const rightMissing = right === null || right === undefined || right === "";
  if (leftMissing && rightMissing) {
    return 0;
  }
  if (leftMissing) {
    return 1;
  }
  if (rightMissing) {
    return -1;
  }
  if (typeof left === "string" || typeof right === "string") {
    return String(left).localeCompare(String(right), "ru");
  }
  if (typeof left === "boolean" || typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  return Number(left) - Number(right);
}

function sortRows<T extends { article: string }>(rows: T[], sort: SortState<string>, resolveValue: (row: T, field: string) => SortValue) {
  if (!sort.field) {
    return rows;
  }
  return [...rows].sort((left, right) => {
    const result = compareSortValues(resolveValue(left, sort.field!), resolveValue(right, sort.field!)) || String(left.article).localeCompare(String(right.article), "ru");
    return sort.direction === "asc" ? result : -result;
  });
}

function sortNamedRows<T extends { ref: string }>(rows: T[], sort: SortState<string>, resolveValue: (row: T, field: string) => SortValue) {
  if (!sort.field) {
    return rows;
  }
  return [...rows].sort((left, right) => {
    const result = compareSortValues(resolveValue(left, sort.field!), resolveValue(right, sort.field!)) || String(left.ref).localeCompare(String(right.ref), "ru");
    return sort.direction === "asc" ? result : -result;
  });
}

function buildCategoryDriverGroups(rows: AnalyticsRowBase[], sort: SortState<CategorySortField>, minStock: number): CategoryDriverShopGroup[] {
  if (!rows.length) {
    return [];
  }
  const rowsByShop = new Map<number, { shopId: number; shopName: string; rows: AnalyticsRowBase[] }>();
  rows.forEach((row) => {
    const current = rowsByShop.get(row.shopId) || { shopId: row.shopId, shopName: row.shopName, rows: [] };
    current.rows.push(row);
    rowsByShop.set(row.shopId, current);
  });
  return [...rowsByShop.values()]
    .map((shop) => {
      const categoriesByName = new Map<string, CategoryDriverRow>();
      const shopTotals = shop.rows.reduce(
        (totals, row) => ({
          spend: totals.spend + (row.spend ?? 0),
          revenueAds: totals.revenueAds + (row.revenue ?? 0),
          revenueTotal: totals.revenueTotal + (row.revenueTotal ?? 0),
        }),
        { spend: 0, revenueAds: 0, revenueTotal: 0 },
      );
      shop.rows.forEach((row) => {
        const category = String(row.categoryKeyword || "").trim() || "Без категории";
        const key = category.toLocaleLowerCase("ru");
        const current =
          categoriesByName.get(key) ||
          ({
            ref: `${shop.shopId}:${key}`,
            shopId: shop.shopId,
            shopName: shop.shopName,
            category,
            skuCount: 0,
            stock: 0,
            stockMpvibe: null,
            spend: 0,
            spendShare: null,
            revenueAds: 0,
            revenueAdsShare: null,
            revenueTotal: 0,
            revenueTotalShare: null,
            ordersAds: 0,
            ordersTotal: 0,
            views: 0,
            clicks: 0,
            atbs: 0,
            drrAds: null,
            drrTotal: null,
            campaigns: 0,
            activeCampaigns: 0,
          } satisfies CategoryDriverRow);
        current.skuCount += 1;
        current.stock += row.stock ?? 0;
        current.stockMpvibe = row.stockMpvibe === null ? current.stockMpvibe : (current.stockMpvibe ?? 0) + row.stockMpvibe;
        current.spend += row.spend ?? 0;
        current.revenueAds += row.revenue ?? 0;
        current.revenueTotal += row.revenueTotal ?? 0;
        current.ordersAds += row.ordersAds ?? 0;
        current.ordersTotal += row.ordersTotal ?? 0;
        current.views += row.views ?? 0;
        current.clicks += row.clicks ?? 0;
        current.atbs += row.atbs ?? 0;
        current.campaigns += row.campaigns;
        current.activeCampaigns += row.activeCampaigns;
        categoriesByName.set(key, current);
      });
      const rows = [...categoriesByName.values()].map((row) => ({
        ...row,
        spendShare: shopTotals.spend > 0 ? (row.spend / shopTotals.spend) * 100 : null,
        revenueAdsShare: shopTotals.revenueAds > 0 ? (row.revenueAds / shopTotals.revenueAds) * 100 : null,
        revenueTotalShare: shopTotals.revenueTotal > 0 ? (row.revenueTotal / shopTotals.revenueTotal) * 100 : null,
        drrAds: row.revenueAds > 0 ? (row.spend / row.revenueAds) * 100 : null,
        drrTotal: row.revenueTotal > 0 ? (row.spend / row.revenueTotal) * 100 : null,
      }));
      const visibleRows = rows.filter((row) => row.stock >= minStock);
      const sortedRows = sortNamedRows<CategoryDriverRow>(visibleRows, sort, (row, field) => {
        switch (field as CategorySortField) {
          case "rank":
            return visibleRows.indexOf(row) + 1;
          case "category":
            return row.category;
          case "skuCount":
            return row.skuCount;
          case "stock":
            return row.stock;
          case "stockMpvibe":
            return row.stockMpvibe;
          case "drrAds":
            return row.drrAds;
          case "drrTotal":
            return row.drrTotal;
          case "spend":
            return row.spend;
          case "spendShare":
            return row.spendShare;
          case "revenueAds":
            return row.revenueAds;
          case "revenueAdsShare":
            return row.revenueAdsShare;
          case "revenueTotal":
            return row.revenueTotal;
          case "revenueTotalShare":
            return row.revenueTotalShare;
          case "ordersAds":
            return row.ordersAds;
          case "ordersTotal":
            return row.ordersTotal;
          case "campaigns":
            return row.campaigns;
          case "activeCampaigns":
          default:
            return row.activeCampaigns;
        }
      });
      return {
        shopId: shop.shopId,
        shopName: shop.shopName,
        rows: sortedRows.map((row, index) => ({ ...row, rank: index + 1 })),
      };
    })
    .filter((group) => group.rows.length > 0);
}

function buildAllCategoryDriverGroup(rows: AnalyticsRowBase[], sort: SortState<CategorySortField>, minStock: number): CategoryDriverShopGroup | null {
  if (!rows.length) {
    return null;
  }
  const categoriesByName = new Map<string, CategoryDriverRow>();
  const shopNamesByCategory = new Map<string, Set<string>>();
  const totals = rows.reduce(
    (summary, row) => ({
      spend: summary.spend + (row.spend ?? 0),
      revenueAds: summary.revenueAds + (row.revenue ?? 0),
      revenueTotal: summary.revenueTotal + (row.revenueTotal ?? 0),
    }),
    { spend: 0, revenueAds: 0, revenueTotal: 0 },
  );

  rows.forEach((row) => {
    const category = String(row.categoryKeyword || "").trim() || "Без категории";
    const key = category.toLocaleLowerCase("ru");
    const current =
      categoriesByName.get(key) ||
      ({
        ref: `all:${key}`,
        shopId: 0,
        shopName: "Все кабинеты",
        category,
        skuCount: 0,
        stock: 0,
        stockMpvibe: null,
        spend: 0,
        spendShare: null,
        revenueAds: 0,
        revenueAdsShare: null,
        revenueTotal: 0,
        revenueTotalShare: null,
        ordersAds: 0,
        ordersTotal: 0,
        views: 0,
        clicks: 0,
        atbs: 0,
        drrAds: null,
        drrTotal: null,
        campaigns: 0,
        activeCampaigns: 0,
      } satisfies CategoryDriverRow);
    current.skuCount += 1;
    current.stock += row.stock ?? 0;
    current.stockMpvibe = row.stockMpvibe === null ? current.stockMpvibe : (current.stockMpvibe ?? 0) + row.stockMpvibe;
    current.spend += row.spend ?? 0;
    current.revenueAds += row.revenue ?? 0;
    current.revenueTotal += row.revenueTotal ?? 0;
    current.ordersAds += row.ordersAds ?? 0;
    current.ordersTotal += row.ordersTotal ?? 0;
    current.views += row.views ?? 0;
    current.clicks += row.clicks ?? 0;
    current.atbs += row.atbs ?? 0;
    current.campaigns += row.campaigns;
    current.activeCampaigns += row.activeCampaigns;
    categoriesByName.set(key, current);

    const shopNames = shopNamesByCategory.get(key) || new Set<string>();
    if (row.shopName) {
      shopNames.add(row.shopName);
    }
    shopNamesByCategory.set(key, shopNames);
  });

  const categoryRows = [...categoriesByName.entries()].map(([key, row]) => {
    const sourceShopNames = [...(shopNamesByCategory.get(key) || new Set<string>())];
    const sourceShopLabel =
      sourceShopNames.length > 1
        ? `${formatNumber(sourceShopNames.length)} каб.`
        : sourceShopNames[0] || "Все кабинеты";
    return {
      ...row,
      shopName: sourceShopLabel,
      spendShare: totals.spend > 0 ? (row.spend / totals.spend) * 100 : null,
      revenueAdsShare: totals.revenueAds > 0 ? (row.revenueAds / totals.revenueAds) * 100 : null,
      revenueTotalShare: totals.revenueTotal > 0 ? (row.revenueTotal / totals.revenueTotal) * 100 : null,
      drrAds: row.revenueAds > 0 ? (row.spend / row.revenueAds) * 100 : null,
      drrTotal: row.revenueTotal > 0 ? (row.spend / row.revenueTotal) * 100 : null,
    };
  });
  const visibleRows = categoryRows.filter((row) => row.stock >= minStock);
  const sortedRows = sortNamedRows<CategoryDriverRow>(visibleRows, sort, (row, field) => {
    switch (field as CategorySortField) {
      case "rank":
        return visibleRows.indexOf(row) + 1;
      case "category":
        return row.category;
      case "skuCount":
        return row.skuCount;
      case "stock":
        return row.stock;
      case "stockMpvibe":
        return row.stockMpvibe;
      case "drrAds":
        return row.drrAds;
      case "drrTotal":
        return row.drrTotal;
      case "spend":
        return row.spend;
      case "spendShare":
        return row.spendShare;
      case "revenueAds":
        return row.revenueAds;
      case "revenueAdsShare":
        return row.revenueAdsShare;
      case "revenueTotal":
        return row.revenueTotal;
      case "revenueTotalShare":
        return row.revenueTotalShare;
      case "ordersAds":
        return row.ordersAds;
      case "ordersTotal":
        return row.ordersTotal;
      case "campaigns":
        return row.campaigns;
      case "activeCampaigns":
      default:
        return row.activeCampaigns;
    }
  });
  const rankedRows = sortedRows.map((row, index) => ({ ...row, rank: index + 1 }));
  return rankedRows.length ? { shopId: 0, shopName: "Все кабинеты", rows: rankedRows } : null;
}

function formatReviewCell(wb?: WbCardInfo | null) {
  if (!wb) {
    return "—";
  }
  const feedbacks = wb.feedbacks ?? wb.nm_feedbacks;
  const rating = wb.rating;
  if (feedbacks === null || feedbacks === undefined) {
    return "—";
  }
  return rating !== null && rating !== undefined ? `${formatNumber(feedbacks)} (${formatNumber(rating, 1)}★)` : formatNumber(feedbacks);
}

function formatBzoCell(wb?: WbCardInfo | null) {
  const points = toNumber(wb?.feedback_points);
  return points !== null && points > 0 ? `да (${formatMoney(points)})` : "нет";
}

function formatTurnover(value: number | null) {
  return value === null ? "—" : `${formatNumber(value, 1)} дн`;
}

function sumMetric<T>(rows: T[], resolveValue: (row: T) => number | null | undefined) {
  return rows.reduce((sum, row) => sum + (resolveValue(row) ?? 0), 0);
}

function nullableSumMetric<T>(rows: T[], resolveValue: (row: T) => number | null | undefined) {
  return rows.reduce(
    (result, row) => {
      const value = resolveValue(row);
      if (value === null || value === undefined) {
        return result;
      }
      return {
        sum: result.sum + value,
        count: result.count + 1,
      };
    },
    { sum: 0, count: 0 },
  );
}

function averageMetric<T>(rows: T[], resolveValue: (row: T) => number | null | undefined) {
  const total = nullableSumMetric(rows, resolveValue);
  return total.count ? total.sum / total.count : null;
}

function ratioPercent(numerator: number, denominator: number) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function summaryLabel(title: string, subtitle?: string) {
  return (
    <div className="drr-table-summary-label">
      <strong>{title}</strong>
      {subtitle ? <span>{subtitle}</span> : null}
    </div>
  );
}

function buildDrrSummaryRow(rows: RankedDrrRow[]): TableSummaryRow {
  const spend = sumMetric(rows, (row) => row.spend);
  const revenue = sumMetric(rows, (row) => row.revenue);
  const ordersAds = sumMetric(rows, (row) => row.ordersAds);
  const ordersTotal = sumMetric(rows, (row) => row.ordersTotal);
  const stock = sumMetric(rows, (row) => row.stock);
  const stockMpvibe = nullableSumMetric(rows, (row) => row.stockMpvibe);
  const reviews = nullableSumMetric(rows, (row) => row.wb?.feedbacks ?? row.wb?.nm_feedbacks);
  const averagePrice = averageMetric(rows, (row) => row.wb?.price_spp);
  const bzoActive = rows.filter((row) => (toNumber(row.wb?.feedback_points) ?? 0) > 0).length;
  const uniqueShops = new Set(rows.map((row) => row.shopName).filter(Boolean)).size;

  return {
    rank: "Итого",
    name: summaryLabel("Итого", `${formatNumber(rows.length)} товаров`),
    article: `${formatNumber(rows.length)} SKU`,
    stock: formatNumber(stock),
    stockMpvibe: stockMpvibe.count ? formatNumber(stockMpvibe.sum) : formatNumber(null),
    drr: formatPercent(ratioPercent(spend, revenue)),
    spend: formatMoney(spend),
    revenue: formatMoney(revenue),
    ordersAds: formatNumber(ordersAds),
    ordersTotal: formatNumber(ordersTotal),
    reviews: reviews.count ? formatNumber(reviews.sum) : formatNumber(null),
    bzo: `${formatNumber(bzoActive)} / ${formatNumber(rows.length)}`,
    price: averagePrice === null ? formatNumber(null) : `ср. ${formatMoney(averagePrice)}`,
    shop: `${formatNumber(uniqueShops)} каб.`,
  };
}

function buildStockSummaryRow(rows: RankedStockRow[], days: number): TableSummaryRow {
  const stock = sumMetric(rows, (row) => row.stock);
  const stockMpvibe = nullableSumMetric(rows, (row) => row.stockMpvibe);
  const spend = sumMetric(rows, (row) => row.spend);
  const ordersTotal = sumMetric(rows, (row) => row.ordersTotal);
  const activeCampaigns = sumMetric(rows, (row) => row.activeCampaigns);
  const campaigns = sumMetric(rows, (row) => row.campaigns);
  const enabledCount = rows.filter((row) => row.enabled).length;
  const uniqueShops = new Set(rows.map((row) => row.shopName).filter(Boolean)).size;

  return {
    rank: "Итого",
    name: summaryLabel("Итого", `${formatNumber(rows.length)} товаров`),
    article: `${formatNumber(rows.length)} SKU`,
    stock: formatNumber(stock),
    stockMpvibe: stockMpvibe.count ? formatNumber(stockMpvibe.sum) : formatNumber(null),
    turnover: formatTurnover(computeTurnoverDays(stock, ordersTotal, days)),
    spend: formatMoney(spend),
    ordersTotal: formatNumber(ordersTotal),
    activeCampaigns: formatNumber(activeCampaigns),
    campaigns: formatNumber(campaigns),
    enabled: `${formatNumber(enabledCount)} вкл.`,
    shop: `${formatNumber(uniqueShops)} каб.`,
  };
}

function buildCategorySummaryRow(rows: RankedCategoryDriverRow[]): TableSummaryRow {
  const skuCount = sumMetric(rows, (row) => row.skuCount);
  const stock = sumMetric(rows, (row) => row.stock);
  const stockMpvibe = nullableSumMetric(rows, (row) => row.stockMpvibe);
  const spend = sumMetric(rows, (row) => row.spend);
  const spendShare = sumMetric(rows, (row) => row.spendShare);
  const revenueAds = sumMetric(rows, (row) => row.revenueAds);
  const revenueAdsShare = sumMetric(rows, (row) => row.revenueAdsShare);
  const revenueTotal = sumMetric(rows, (row) => row.revenueTotal);
  const revenueTotalShare = sumMetric(rows, (row) => row.revenueTotalShare);
  const ordersAds = sumMetric(rows, (row) => row.ordersAds);
  const ordersTotal = sumMetric(rows, (row) => row.ordersTotal);
  const activeCampaigns = sumMetric(rows, (row) => row.activeCampaigns);
  const campaigns = sumMetric(rows, (row) => row.campaigns);

  return {
    rank: "Итого",
    category: summaryLabel("Итого", `${formatNumber(rows.length)} категорий`),
    skuCount: formatNumber(skuCount),
    drrTotal: formatPercent(ratioPercent(spend, revenueTotal)),
    drrAds: formatPercent(ratioPercent(spend, revenueAds)),
    spend: formatMoney(spend),
    spendShare: formatPercent(spendShare),
    revenueTotal: formatMoney(revenueTotal),
    revenueTotalShare: formatPercent(revenueTotalShare),
    revenueAds: formatMoney(revenueAds),
    revenueAdsShare: formatPercent(revenueAdsShare),
    ordersAds: formatNumber(ordersAds),
    ordersTotal: formatNumber(ordersTotal),
    stock: formatNumber(stock),
    stockMpvibe: stockMpvibe.count ? formatNumber(stockMpvibe.sum) : formatNumber(null),
    activeCampaigns: formatNumber(activeCampaigns),
    campaigns: formatNumber(campaigns),
  };
}

function formatHours(value: number | null | undefined) {
  const numeric = toNumber(value as number | string | null | undefined);
  return numeric === null ? "—" : `${formatNumber(numeric, 1)} ч`;
}

function positiveLimit(value: unknown) {
  const numeric = toNumber(value as string | number | null | undefined);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function nonNegativeMetric(value: unknown) {
  const numeric = toNumber(value as string | number | null | undefined);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

function sumCampaignValues(states: CatalogCampaignState[], field: keyof CatalogCampaignState, positiveOnly = false) {
  const values = states
    .map((state) => (positiveOnly ? positiveLimit(state[field]) : nonNegativeMetric(state[field])))
    .filter((value): value is number => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function isSpendLimitConfigured(state: CatalogCampaignState) {
  return Boolean(state.spend_limit_active) && positiveLimit(state.spend_limit) !== null;
}

function isBudgetRuleConfigured(state: CatalogCampaignState) {
  return Boolean(state.budget_rule_active) && positiveLimit(state.budget_limit) !== null;
}

function isLimitCheckCampaignState(state: CatalogCampaignState) {
  const status = String(state.status_code || "").toUpperCase();
  return status === "ACTIVE" || status === "PAUSED";
}

function isAutoExclusionCheckCampaignState(state: CatalogCampaignState) {
  if (!isLimitCheckCampaignState(state)) {
    return false;
  }
  return String(state.key || "").toLowerCase() !== "cpc";
}

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function normalizeDrrApiErrorMessage(text: string) {
  const source = String(text || "").trim();
  if (!source) {
    return "Не удалось загрузить данные API.";
  }
  const hasHtml = /<!doctype html>|<html[\s>]|<head[\s>]|<body[\s>]/i.test(source);
  const decodeHtmlText = (value: string) =>
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/&bull;/gi, "·")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  const cloudflareCode = source.match(/cf-error-code[^>]*>\s*(\d{3,4})\s*</i)?.[1] || source.match(/\bError\s+(\d{3,4})\b/i)?.[1] || null;
  const title = source.match(/<title[^>]*>(.*?)<\/title>/i)?.[1];
  const decodedTitle = title ? decodeHtmlText(title).replace(/\s*\|.*$/, "").trim() : "";
  if (hasHtml && /Worker exceeded resource limits/i.test(source)) {
    return `Cloudflare: Worker exceeded resource limits${cloudflareCode ? ` (${cloudflareCode})` : ""}.`;
  }
  if (hasHtml && decodedTitle) {
    return `Cloudflare: ${decodedTitle}${cloudflareCode ? ` (${cloudflareCode})` : ""}.`;
  }
  const statusMatch = source.match(/\b(5\d{2}|4\d{2})\b/);
  if ((hasHtml || /temporarily unavailable|XWAY request failed \(503\)/i.test(source)) && statusMatch?.[1] === "503") {
    return "XWAY временно недоступен (503).";
  }
  if (hasHtml && statusMatch?.[1]) {
    return `Ошибка API (${statusMatch[1]}).`;
  }
  return source;
}

async function readDrrApiErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Response) {
    if (error.bodyUsed) {
      return error.statusText ? `Ошибка API (${error.status}): ${error.statusText}` : `Ошибка API (${error.status})`;
    }
    const text = await error.clone().text();
    if (!text) {
      return error.statusText ? `Ошибка API (${error.status}): ${error.statusText}` : `Ошибка API (${error.status})`;
    }
    try {
      const parsed = JSON.parse(text) as { error?: string };
      return normalizeDrrApiErrorMessage(parsed.error || text);
    } catch {
      return normalizeDrrApiErrorMessage(text);
    }
  }
  if (error instanceof Error) {
    return normalizeDrrApiErrorMessage(error.message);
  }
  return fallback;
}

function isRetryableLimitActivityError(message: string) {
  return /resource limits|1102|временно недоступен|timeout|timed out|\b(429|502|503|504)\b/i.test(message);
}

function mergeCampaignStatesForLimitDetails(baseStates: CatalogCampaignState[], detailStates: CatalogCampaignState[]) {
  const detailByKey = new Map(detailStates.map((state) => [state.key, state]));
  const merged = baseStates.map((state) => {
    const detailState = detailByKey.get(state.key);
    return detailState ? { ...state, ...detailState } : state;
  });
  detailStates.forEach((state) => {
    if (!baseStates.some((baseState) => baseState.key === state.key)) {
      merged.push(state);
    }
  });
  return merged;
}

function buildLimitSetupRow(row: AnalyticsRowBase, detailStates: CatalogCampaignState[] | undefined): LimitSetupRow | null {
  if (row.source !== "xway") {
    return null;
  }
  if (!detailStates) {
    return null;
  }
  const campaignStates = mergeCampaignStatesForLimitDetails(row.campaignStates, detailStates);
  const activeStates = campaignStates.filter(isLimitCheckCampaignState);
  if (!activeStates.length) {
    return null;
  }

  const spendLimitConfiguredCount = activeStates.filter(isSpendLimitConfigured).length;
  const budgetRuleConfiguredCount = activeStates.filter(isBudgetRuleConfigured).length;
  const missingSpendLimit = spendLimitConfiguredCount < activeStates.length;
  const missingBudgetRule = budgetRuleConfiguredCount < activeStates.length;
  const spendLimitConfiguredStates = activeStates.filter(isSpendLimitConfigured);
  const budgetRuleConfiguredStates = activeStates.filter(isBudgetRuleConfigured);

  return {
    ...row,
    campaignStates,
    activeCampaignStateCount: activeStates.length,
    spendLimitConfiguredCount,
    budgetRuleConfiguredCount,
    missingSpendLimit,
    missingBudgetRule,
    issueCount: Number(missingSpendLimit) + Number(missingBudgetRule),
    spendLimit: sumCampaignValues(spendLimitConfiguredStates, "spend_limit", true),
    spendSpentToday: sumCampaignValues(spendLimitConfiguredStates, "spend_spent_today"),
    budgetLimit: sumCampaignValues(budgetRuleConfiguredStates, "budget_limit", true),
    budgetSpentToday: sumCampaignValues(budgetRuleConfiguredStates, "budget_spent_today"),
  };
}

function normalizeLimitActivityIssueTitle(issue: CatalogIssuesIssue) {
  return issue.kind === "limit" ? "лимит расходов" : "нехватка бюджета";
}

function isLimitActivityCampaign(campaign: CatalogIssuesIssue["campaigns"][number]) {
  return campaign.display_status === "active" || campaign.display_status === "paused";
}

function buildLimitActivityIssueSummary(issue: CatalogIssuesIssue): LimitActivityIssueSummary | null {
  if (issue.kind !== "budget" && issue.kind !== "limit") {
    return null;
  }
  const activeCampaigns = issue.campaigns.filter(isLimitActivityCampaign);
  if (!activeCampaigns.length) {
    return null;
  }
  const maxIncidentHours = Math.max(...activeCampaigns.map((campaign) => toNumber(campaign.max_incident_hours ?? null) ?? campaign.hours ?? 0));
  if (maxIncidentHours < LIMIT_ACTIVITY_THRESHOLD_HOURS) {
    return null;
  }
  const campaignLabels = activeCampaigns.map((campaign) => campaign.label).filter(Boolean);
  const totalHours = activeCampaigns.reduce((sum, campaign) => sum + (toNumber(campaign.hours ?? null) ?? 0), 0);
  const incidents = activeCampaigns.reduce((sum, campaign) => sum + (toNumber(campaign.incidents ?? null) ?? 0), 0);
  const dayLabels = (issue.days || [])
    .filter((day) => (day.max_incident_hours ?? day.hours) > 0)
    .map((day) => `${day.label}: ${formatHours(day.max_incident_hours ?? day.hours)}`);
  return {
    kind: issue.kind,
    title: normalizeLimitActivityIssueTitle(issue),
    hours: totalHours || issue.hours,
    maxIncidentHours,
    incidents: incidents || issue.incidents,
    campaignLabels,
    dayLabels,
  };
}

function buildLimitActivityRow(row: AnalyticsRowBase, issueRow: CatalogIssuesRow | undefined): LimitActivityRow | null {
  if (!issueRow?.issues?.length) {
    return null;
  }
  const issues = issueRow.issues
    .map(buildLimitActivityIssueSummary)
    .filter((issue): issue is LimitActivityIssueSummary => issue !== null);
  if (!issues.length) {
    return null;
  }
  const campaignLabels = [...new Set(issues.flatMap((issue) => issue.campaignLabels))];
  return {
    ...row,
    issues,
    issueCount: issues.length,
    totalHours: issues.reduce((sum, issue) => sum + issue.hours, 0),
    maxIncidentHours: Math.max(...issues.map((issue) => issue.maxIncidentHours)),
    incidents: issues.reduce((sum, issue) => sum + issue.incidents, 0),
    campaignLabels,
  };
}

function buildAutoExclusionCampaignRows(row: AnalyticsRowBase, autoRow: CatalogAutoExclusionRow | undefined): AutoExclusionCampaignRow[] {
  if (row.source !== "xway" || !autoRow?.campaigns?.length) {
    return [];
  }
  return autoRow.campaigns.map((campaign: CatalogAutoExclusionCampaign) => ({
    ...row,
    ref: `${row.ref}:${campaign.id}`,
    productRef: row.ref,
    campaignId: campaign.id,
    campaignName: campaign.name,
    campaignLabel: campaign.label || `РК ${campaign.id}`,
    paymentType: campaign.payment_type,
    statusCode: campaign.status_code,
    statusLabel: campaign.status_label,
    displayStatus: campaign.display_status,
    ruleExists: campaign.rule_exists,
    ruleActive: campaign.auto_rule?.active ?? null,
    configured: campaign.configured,
    exclusionMode: campaign.auto_rule?.fixed === false ? "all" : campaign.auto_rule?.fixed === true ? "conditions" : "unknown",
    ruleDays: campaign.auto_rule?.days ?? null,
    boost: campaign.auto_rule?.boost ?? null,
    efficiency: campaign.auto_rule?.efficiency ?? null,
    popularity: campaign.auto_rule?.popularity ?? null,
    popularityAbove: campaign.auto_rule?.popularity_above ?? null,
    ctr: campaign.auto_rule?.ctr ?? null,
    ctrView: campaign.auto_rule?.ctr_view ?? null,
    cpc: campaign.auto_rule?.cpc ?? null,
    cpcView: campaign.auto_rule?.cpc_view ?? null,
    queriesToExclude: campaign.auto_rule?.queries_to_exclude ?? [],
    queriesNotToExclude: campaign.auto_rule?.queries_not_to_exclude ?? [],
    ruleError: campaign.rule_error ?? null,
  }));
}

function formatAutoExclusionDays(value: number | null) {
  if (value === null) {
    return "период не задан";
  }
  if (value >= 1000) {
    return "все время";
  }
  return `${formatNumber(value)} дн.`;
}

function hasAutoExclusionConditions(row: AutoExclusionCampaignRow) {
  return (
    row.boost !== null ||
    row.efficiency !== null ||
    row.popularity !== null ||
    row.popularityAbove !== null ||
    row.ctr !== null ||
    row.cpc !== null ||
    row.queriesToExclude.length > 0
  );
}

function buildAutoExclusionConditionLabels(row: AutoExclusionCampaignRow) {
  const labels: string[] = [];
  if (row.ctr !== null) {
    labels.push(`CTR < ${formatPercent(row.ctr)}${row.ctrView !== null ? `, показы от ${formatNumber(row.ctrView)}` : ""}`);
  }
  if (row.cpc !== null) {
    labels.push(`CPC > ${formatMoney(row.cpc)}${row.cpcView !== null ? `, показы от ${formatNumber(row.cpcView)}` : ""}`);
  }
  if (row.boost !== null) {
    labels.push(`буст от ${formatNumber(row.boost)}`);
  }
  if (row.efficiency !== null) {
    labels.push(`эффективность от ${formatNumber(row.efficiency)}`);
  }
  if (row.popularity !== null) {
    labels.push(`популярность < ${formatNumber(row.popularity)}`);
  }
  if (row.popularityAbove !== null) {
    labels.push(`популярность > ${formatNumber(row.popularityAbove)}`);
  }
  if (row.queriesToExclude.length) {
    labels.push(`если входят слова: ${formatNumber(row.queriesToExclude.length)}`);
  }
  if (row.queriesNotToExclude.length) {
    labels.push(`не исключать слова: ${formatNumber(row.queriesNotToExclude.length)}`);
  }
  return labels;
}

function autoExclusionProblemLabel(row: AutoExclusionCampaignRow) {
  if (row.configured) {
    return "настроено";
  }
  if (row.ruleError || !row.ruleExists || row.ruleActive === false) {
    return "выключено";
  }
  if (row.exclusionMode === "conditions" && !hasAutoExclusionConditions(row)) {
    return "нет условий";
  }
  return "не настроено";
}

function buildCategoryDriverPieSlices(rows: RankedCategoryDriverRow[], metric: CategoryDriverPieMetric): CategoryDriverPieSlice[] {
  const sortedRows = rows
    .filter((row) => row[metric] > 0)
    .sort((left, right) => right[metric] - left[metric]);
  const visibleRows = sortedRows.length > CATEGORY_DRIVER_PIE_LEGEND_LIMIT ? sortedRows.slice(0, CATEGORY_DRIVER_PIE_LEGEND_LIMIT - 1) : sortedRows;
  const tailRows = sortedRows.slice(visibleRows.length);
  const slices: CategoryDriverPieSlice[] = visibleRows.map((row, index) => ({
    key: `${row.ref}:${metric}`,
    name: row.category,
    value: row[metric],
    color: CATEGORY_DRIVER_CHART_COLORS[index % CATEGORY_DRIVER_CHART_COLORS.length] ?? "#ff8a2d",
    row,
  }));
  if (tailRows.length) {
    const otherRow = aggregateCategoryDriverRows(tailRows, metric, visibleRows.length + 1);
    slices.push({
      key: `${otherRow.ref}:${metric}`,
      name: otherRow.category,
      value: otherRow[metric],
      color: CATEGORY_DRIVER_OTHER_COLOR,
      row: otherRow,
      collapsedCount: tailRows.length,
    });
  }
  return slices;
}

function aggregateCategoryDriverRows(rows: RankedCategoryDriverRow[], metric: CategoryDriverPieMetric, rank: number): RankedCategoryDriverRow {
  const totals = rows.reduce(
    (sum, row) => ({
      skuCount: sum.skuCount + row.skuCount,
      stock: sum.stock + row.stock,
      stockMpvibe: row.stockMpvibe === null ? sum.stockMpvibe : (sum.stockMpvibe ?? 0) + row.stockMpvibe,
      spend: sum.spend + row.spend,
      spendShare: sum.spendShare + (row.spendShare ?? 0),
      revenueAds: sum.revenueAds + row.revenueAds,
      revenueAdsShare: sum.revenueAdsShare + (row.revenueAdsShare ?? 0),
      revenueTotal: sum.revenueTotal + row.revenueTotal,
      revenueTotalShare: sum.revenueTotalShare + (row.revenueTotalShare ?? 0),
      ordersAds: sum.ordersAds + row.ordersAds,
      ordersTotal: sum.ordersTotal + row.ordersTotal,
      views: sum.views + row.views,
      clicks: sum.clicks + row.clicks,
      atbs: sum.atbs + row.atbs,
      campaigns: sum.campaigns + row.campaigns,
      activeCampaigns: sum.activeCampaigns + row.activeCampaigns,
    }),
    {
      skuCount: 0,
      stock: 0,
      stockMpvibe: null as number | null,
      spend: 0,
      spendShare: 0,
      revenueAds: 0,
      revenueAdsShare: 0,
      revenueTotal: 0,
      revenueTotalShare: 0,
      ordersAds: 0,
      ordersTotal: 0,
      views: 0,
      clicks: 0,
      atbs: 0,
      campaigns: 0,
      activeCampaigns: 0,
    },
  );
  const firstRow = rows[0];
  return {
    ref: `other:${firstRow?.shopId ?? "all"}:${metric}`,
    shopId: firstRow?.shopId ?? 0,
    shopName: firstRow?.shopName ?? "",
    category: `Остальные ${rows.length} категорий`,
    rank,
    skuCount: totals.skuCount,
    stock: totals.stock,
    stockMpvibe: totals.stockMpvibe,
    spend: totals.spend,
    spendShare: totals.spendShare,
    revenueAds: totals.revenueAds,
    revenueAdsShare: totals.revenueAdsShare,
    revenueTotal: totals.revenueTotal,
    revenueTotalShare: totals.revenueTotalShare,
    ordersAds: totals.ordersAds,
    ordersTotal: totals.ordersTotal,
    views: totals.views,
    clicks: totals.clicks,
    atbs: totals.atbs,
    drrAds: totals.revenueAds > 0 ? (totals.spend / totals.revenueAds) * 100 : null,
    drrTotal: totals.revenueTotal > 0 ? (totals.spend / totals.revenueTotal) * 100 : null,
    campaigns: totals.campaigns,
    activeCampaigns: totals.activeCampaigns,
  };
}

function sourceSummary(source: DataSource) {
  return (
    <span className={cn("drr-source-label", source === "WB" && "is-wb", source === "MPVibe" && "is-mpvibe", source === "XWAY/WB" && "is-mixed", source === "Расчет" && "is-derived")}>
      {source}
    </span>
  );
}

function withSourceSummaries<T>(columns: Array<TableColumn<T>>, sources: Record<string, DataSource>) {
  return columns.map((column) => ({
    ...column,
    headerSummary: sourceSummary(sources[column.key] ?? "XWAY"),
  }));
}

function resolveMpvibeStockWarning(response: MpvibeStocksResponse) {
  if (response.rows.some((row) => row.stock_fbo !== null)) {
    return null;
  }
  const firstError = response.errors.map((item) => String(item.error || "").replace(/\s+/g, " ").trim()).find(Boolean);
  if (/RefreshToken|refresh cookie|token refresh|MPVIBE_REFRESH_COOKIE_HEADER|MPVIBE_AUTHORIZATION/i.test(firstError || "")) {
    return "MPVibe не авторизован: обновите MPVIBE_REFRESH_COOKIE_HEADER из auth.mpvibe.ru или задайте свежий MPVIBE_AUTHORIZATION в Cloudflare Pages.";
  }
  return firstError
    ? `MPVibe не вернул остатки FBO: ${firstError}`
    : "MPVibe не вернул остатки FBO: остаток XWAY останется доступен, MPVibe-колонки можно догрузить повторным обновлением.";
}

function useSortableHeader<TField extends string>(
  sort: SortState<TField>,
  setSort: (sort: SortState<TField>) => void,
) {
  const toggleSort = (field: TField) => {
    if (sort.field !== field) {
      setSort({ field, direction: "desc" });
      return;
    }
    if (sort.direction === "desc") {
      setSort({ field, direction: "asc" });
      return;
    }
    setSort({ field: null, direction: "desc" });
  };

  return (field: TField, label: ReactNode, options: { align?: "left" | "right"; ariaLabel?: string } = {}) => {
    const active = sort.field === field;
    const Icon = active ? (sort.direction === "desc" ? ArrowDown : ArrowUp) : ArrowUpDown;
    const directionLabel = active ? (sort.direction === "desc" ? "по убыванию" : "по возрастанию") : "без сортировки";
    return (
      <button
        type="button"
        onClick={() => toggleSort(field)}
        className={cn("catalog-sort-header", options.align === "right" && "is-right", active && "is-active")}
        aria-label={`${options.ariaLabel || "Сортировка"}: ${directionLabel}`}
        title={`${options.ariaLabel || "Сортировка"}: ${directionLabel}`}
      >
        <span className="catalog-sort-header-label">{label}</span>
        <Icon className="catalog-sort-header-icon" aria-hidden="true" />
      </button>
    );
  };
}

function ProductCell({ row }: { row: AnalyticsRowBase }) {
  return (
    <div className="drr-analytics-product-cell">
      <div className="drr-analytics-product-thumb">
        {row.imageUrl ? <img src={row.imageUrl} alt={row.name} loading="lazy" /> : <span>{row.article.slice(0, 2)}</span>}
      </div>
      <div className="drr-analytics-product-copy">
        <strong title={row.name}>{row.name}</strong>
        <span>
          {row.article} · {row.shopName}
          {row.source === "mpvibe" ? " · только MPVibe" : ""}
        </span>
      </div>
    </div>
  );
}

function XwayLink({ href }: { href: string }) {
  if (!href) {
    return null;
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="drr-analytics-link" title="Открыть в XWAY">
      XWAY
      <ExternalLink className="size-3.5" />
    </a>
  );
}

function WbLink({ article }: { article: string }) {
  return (
    <a
      href={`https://www.wildberries.ru/catalog/${encodeURIComponent(article)}/detail.aspx`}
      target="_blank"
      rel="noreferrer"
      className="drr-analytics-link is-wb"
      title="Открыть на Wildberries"
    >
      WB
      <ExternalLink className="size-3.5" />
    </a>
  );
}

function LimitIssueCell({ row }: { row: LimitSetupRow }) {
  return (
    <div className="drr-limit-issue-stack">
      {row.missingSpendLimit ? <span className="drr-status-chip is-error">нет лимита расхода</span> : null}
      {row.missingBudgetRule ? <span className="drr-status-chip is-warning">нет бюджета/пополнения</span> : null}
      {!row.missingSpendLimit && !row.missingBudgetRule ? <span className="drr-status-chip is-on">настроено</span> : null}
    </div>
  );
}

function LimitActivityIssueCell({ row }: { row: LimitActivityRow }) {
  return (
    <div className="drr-limit-activity-cell">
      <div className="drr-limit-issue-stack">
        {row.issues.map((issue) => (
          <span key={issue.kind} className={cn("drr-status-chip", issue.kind === "limit" ? "is-error" : "is-warning")}>
            {issue.title}
          </span>
        ))}
      </div>
      <span>
        макс. {formatHours(row.maxIncidentHours)} · всего {formatHours(row.totalHours)}
      </span>
      {row.campaignLabels.length ? <small title={row.campaignLabels.join(", ")}>{row.campaignLabels.slice(0, 2).join(", ")}</small> : null}
    </div>
  );
}

function AutoExclusionCampaignCell({ row }: { row: AutoExclusionCampaignRow }) {
  return (
    <div className="drr-limit-activity-cell">
      <span title={row.campaignLabel}>{row.campaignLabel}</span>
      <small>
        {row.statusLabel || row.statusCode || "статус неизвестен"} · {row.paymentType === "cpm" ? "CPM" : row.paymentType?.toUpperCase() || "тип неизвестен"}
      </small>
    </div>
  );
}

function AutoExclusionStatusCell({ row }: { row: AutoExclusionCampaignRow }) {
  const label = autoExclusionProblemLabel(row);
  return (
    <div className="drr-limit-issue-stack">
      <span className={cn("drr-status-chip", row.configured ? "is-on" : row.ruleExists ? "is-warning" : "is-error")}>{label}</span>
    </div>
  );
}

function AutoExclusionRuleCell({ row }: { row: AutoExclusionCampaignRow }) {
  const conditionLabels = buildAutoExclusionConditionLabels(row);
  const ruleUnavailable = Boolean(row.ruleError || !row.ruleExists || row.ruleActive === false);
  const title = row.ruleError ? `XWAY не вернул правило: ${row.ruleError}` : conditionLabels.join(", ") || undefined;
  const primaryLabel =
    ruleUnavailable
      ? "правило выключено"
      : row.exclusionMode === "all"
        ? "все незафиксированные"
        : row.exclusionMode === "conditions"
          ? "при выполнении условий"
          : "режим не задан";
  return (
    <div className="drr-limit-summary" title={title}>
      <strong className={row.configured ? undefined : "is-error"}>{primaryLabel}</strong>
      <span>статистика: {formatAutoExclusionDays(row.ruleDays)}</span>
      <span>
        {ruleUnavailable
          ? "настройка выключена"
          : row.exclusionMode === "all"
            ? "каждый незафиксированный кластер"
            : conditionLabels.length
              ? conditionLabels.slice(0, 2).join(" · ")
              : "условия не заданы"}
      </span>
    </div>
  );
}

function LimitSetupCell({
  configured,
  total,
  limit,
  spent,
}: {
  configured: number;
  total: number;
  limit: number | null;
  spent: number | null;
}) {
  const missing = configured < total;
  return (
    <div className="drr-limit-summary">
      <strong className={missing ? "is-error" : undefined}>
        {configured > 0 ? `${formatNumber(configured)}/${formatNumber(total)} настроено` : "не настроено"}
      </strong>
      <span>{limit !== null ? `лимит ${formatMoney(limit)}` : "лимит не задан"}</span>
      {spent !== null ? <span>расход DAY {formatMoney(spent)}</span> : null}
    </div>
  );
}

function CategoryDriverPieTooltip({
  slice,
}: {
  slice: CategoryDriverPieSlice;
}) {
  const row = slice.row;
  return (
    <div className="drr-category-pie-tooltip">
      <strong>{row.category}</strong>
      <div>
        <span>ДРР общ.</span>
        <b>{formatPercent(row.drrTotal)}</b>
      </div>
      <div>
        <span>Заказы всего</span>
        <b>{formatNumber(row.ordersTotal)}</b>
      </div>
      <div>
        <span>Выручка общая</span>
        <b>{formatMoney(row.revenueTotal)}</b>
      </div>
      <div>
        <span>Траты</span>
        <b>{formatMoney(row.spend)}</b>
      </div>
      <div>
        <span>SKU</span>
        <b>{formatNumber(row.skuCount)}</b>
      </div>
      <div>
        <span>Остаток XWAY</span>
        <b>{formatNumber(row.stock)}</b>
      </div>
      {row.stockMpvibe !== null ? (
        <div>
          <span>Остаток MPVibe</span>
          <b>{formatNumber(row.stockMpvibe)}</b>
        </div>
      ) : null}
    </div>
  );
}

function CategoryDriverPieLegend({
  slices,
  total,
}: {
  slices: CategoryDriverPieSlice[];
  total: number;
}) {
  return (
    <div className="drr-category-pie-legend" aria-label="Легенда категорий">
      {slices.map((slice) => {
        const share = total > 0 ? (slice.value / total) * 100 : null;
        return (
          <div key={`${slice.key}-legend`} className="drr-category-pie-legend-item" title={slice.name}>
            <span className="drr-category-pie-legend-dot" style={{ ["--slice-color" as string]: slice.color }} />
            <span className="drr-category-pie-legend-name">{slice.name}</span>
            <span className="drr-category-pie-legend-value">
              {formatMoney(slice.value)}
              {share !== null ? <small>{formatPercent(share)}</small> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CategoryDriverPie({
  rows,
  metric,
  title,
  totalLabel,
}: {
  rows: RankedCategoryDriverRow[];
  metric: CategoryDriverPieMetric;
  title: string;
  totalLabel: string;
}) {
  const slices = buildCategoryDriverPieSlices(rows, metric);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [activeSlice, setActiveSlice] = useState<CategoryDriverPieSlice | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);

  const updateActiveSlice = (index: number, event?: { clientX?: number; clientY?: number }) => {
    setActiveSlice(slices[index] ?? null);
    if (event && typeof event.clientX === "number" && typeof event.clientY === "number") {
      updateTooltipPosition({ clientX: event.clientX, clientY: event.clientY });
    }
  };

  const updateTooltipPosition = (event: { clientX: number; clientY: number }) => {
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    let x = pointerX + CATEGORY_DRIVER_PIE_TOOLTIP_GAP;
    if (x + CATEGORY_DRIVER_PIE_TOOLTIP_WIDTH > rect.width - CATEGORY_DRIVER_PIE_TOOLTIP_EDGE) {
      x = pointerX - CATEGORY_DRIVER_PIE_TOOLTIP_WIDTH - CATEGORY_DRIVER_PIE_TOOLTIP_GAP;
    }
    setTooltipPosition({
      x: Math.round(Math.max(CATEGORY_DRIVER_PIE_TOOLTIP_EDGE, Math.min(x, rect.width - CATEGORY_DRIVER_PIE_TOOLTIP_WIDTH - CATEGORY_DRIVER_PIE_TOOLTIP_EDGE))),
      y: Math.round(Math.max(CATEGORY_DRIVER_PIE_TOOLTIP_EDGE, pointerY)),
    });
  };

  return (
    <div className="drr-category-pie">
      <div className="drr-category-pie-head">
        <span>{title}</span>
        <strong>{formatMoney(total)}</strong>
      </div>
      {slices.length ? (
        <div
          ref={bodyRef}
          className="drr-category-pie-body"
          onPointerMove={(event) => {
            if (activeSlice) {
              updateTooltipPosition(event);
            }
          }}
          onPointerLeave={() => {
            setActiveSlice(null);
            setTooltipPosition(null);
          }}
        >
          <div className="drr-category-pie-plot">
            <ResponsiveContainer width="100%" height={230}>
              <PieChart margin={{ top: 10, right: 8, bottom: 10, left: 8 }}>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="54%"
                  outerRadius="82%"
                  paddingAngle={0}
                  stroke="none"
                  strokeWidth={0}
                  onMouseEnter={(_slice, index, event) => {
                    updateActiveSlice(index, event);
                  }}
                  onMouseMove={(_slice, index, event) => {
                    updateActiveSlice(index, event);
                  }}
                >
                  {slices.map((slice) => (
                    <Cell key={slice.key} fill={slice.color} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="drr-category-pie-total" aria-hidden="true">
              <span>{totalLabel}</span>
              <strong>{formatMoney(total)}</strong>
            </div>
          </div>
          <CategoryDriverPieLegend slices={slices} total={total} />
          {activeSlice && tooltipPosition ? (
            <div
              className="drr-category-pie-hover-tooltip"
              style={{
                ["--tooltip-x" as string]: `${tooltipPosition.x}px`,
                ["--tooltip-y" as string]: `${tooltipPosition.y}px`,
              }}
            >
              <CategoryDriverPieTooltip slice={activeSlice} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="drr-category-pie-empty">Нет данных</div>
      )}
    </div>
  );
}

function CategoryDriverCharts({ rows }: { rows: RankedCategoryDriverRow[] }) {
  return (
    <div className="drr-category-chart-block">
      <CategoryDriverPie rows={rows} metric="spend" title="Расход за период" totalLabel="Расход" />
      <CategoryDriverPie rows={rows} metric="revenueTotal" title="Выручка общая за период" totalLabel="Выручка" />
    </div>
  );
}

export function DrrAnalyticsPage() {
  const [section, setSection] = useState<AnalyticsSection>("drr");
  const [daysInput, setDaysInput] = useState(String(DEFAULT_DAYS));
  const [limitInput, setLimitInput] = useState(String(DEFAULT_LIMIT));
  const [adOffErrorStockThresholdInput, setAdOffErrorStockThresholdInput] = useState(readStoredAdOffThreshold);
  const [categoryMinStockInput, setCategoryMinStockInput] = useState(readStoredCategoryMinStock);
  const [payload, setPayload] = useState<CatalogResponse | null>(null);
  const [wbByArticle, setWbByArticle] = useState<Record<string, WbCardInfo>>({});
  const [mpvibeStockByArticle, setMpvibeStockByArticle] = useState<Record<string, MpvibeStockInfo>>({});
  const [limitCampaignStatesByRef, setLimitCampaignStatesByRef] = useState<Record<string, CatalogCampaignState[]>>({});
  const [limitActivityIssuesByRef, setLimitActivityIssuesByRef] = useState<Record<string, CatalogIssuesRow>>({});
  const [autoExclusionsByRef, setAutoExclusionsByRef] = useState<Record<string, CatalogAutoExclusionRow>>({});
  const [limitDetailsLoading, setLimitDetailsLoading] = useState(false);
  const [limitActivityLoading, setLimitActivityLoading] = useState(false);
  const [autoExclusionsLoading, setAutoExclusionsLoading] = useState(false);
  const [limitDetailsProgress, setLimitDetailsProgress] = useState<{ loaded: number; total: number }>({ loaded: 0, total: 0 });
  const [limitActivityProgress, setLimitActivityProgress] = useState<{ loaded: number; total: number }>({ loaded: 0, total: 0 });
  const [autoExclusionsProgress, setAutoExclusionsProgress] = useState<{ loaded: number; total: number }>({ loaded: 0, total: 0 });
  const [limitDetailsError, setLimitDetailsError] = useState<string | null>(null);
  const [limitActivityError, setLimitActivityError] = useState<string | null>(null);
  const [autoExclusionsError, setAutoExclusionsError] = useState<string | null>(null);
  const [mpvibeRefreshNonce, setMpvibeRefreshNonce] = useState(0);
  const [limitDetailsRefreshNonce, setLimitDetailsRefreshNonce] = useState(0);
  const [limitActivityRefreshNonce, setLimitActivityRefreshNonce] = useState(0);
  const [autoExclusionsRefreshNonce, setAutoExclusionsRefreshNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [wbLoading, setWbLoading] = useState(false);
  const [mpvibeLoading, setMpvibeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mpvibeWarning, setMpvibeWarning] = useState<string | null>(null);
  const [loadedRange, setLoadedRange] = useState<{ start: string; end: string; days: number } | null>(null);
  const [drrSort, setDrrSort] = useState<SortState<DrrSortField>>({ field: "spend", direction: "desc" });
  const [stockSort, setStockSort] = useState<SortState<StockSortField>>({ field: "stock", direction: "desc" });
  const [limitsSort, setLimitsSort] = useState<SortState<LimitSortField>>({ field: "issueCount", direction: "desc" });
  const [limitActivitySort, setLimitActivitySort] = useState<SortState<LimitActivitySortField>>({ field: "maxIncidentHours", direction: "desc" });
  const [autoExclusionsSort, setAutoExclusionsSort] = useState<SortState<AutoExclusionSortField>>({ field: "configured", direction: "asc" });
  const [categorySort, setCategorySort] = useState<SortState<CategorySortField>>({ field: "spend", direction: "desc" });
  const [columnWidths, setColumnWidths] = useState<ColumnWidthState>(readStoredColumnWidths);
  const abortRef = useRef<AbortController | null>(null);
  const wbAbortRef = useRef<AbortController | null>(null);
  const mpvibeAbortRef = useRef<AbortController | null>(null);
  const limitDetailsAbortRef = useRef<AbortController | null>(null);
  const limitActivityAbortRef = useRef<AbortController | null>(null);
  const autoExclusionsAbortRef = useRef<AbortController | null>(null);
  const mpvibeForceRefreshRef = useRef(false);
  const mpvibeLoadedRequestRef = useRef<string | null>(null);
  const limitDetailsRequestRef = useRef<string | null>(null);
  const limitActivityRequestRef = useRef<string | null>(null);
  const autoExclusionsRequestRef = useRef<string | null>(null);
  const limitDetailsForceRefreshRef = useRef(false);
  const limitActivityForceRefreshRef = useRef(false);
  const autoExclusionsForceRefreshRef = useRef(false);
  const resizeDragRef = useRef<{ columnKey: ResizableColumnKey; startX: number; startWidth: number } | null>(null);
  const drrBackgroundQueueRef = useRef<Promise<void>>(Promise.resolve());

  const days = clampInteger(daysInput, DEFAULT_DAYS, 1, MAX_DAYS);
  const limit = clampInteger(limitInput, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const adOffErrorStockThreshold = clampInteger(adOffErrorStockThresholdInput, DEFAULT_AD_OFF_ERROR_STOCK_THRESHOLD, 0, 1000000);
  const categoryMinStock = clampInteger(categoryMinStockInput, DEFAULT_CATEGORY_MIN_STOCK, 0, 1000000);
  const baseRows = useMemo(() => flattenCatalogRows(payload, loadedRange?.days ?? days), [days, loadedRange?.days, payload]);
  const rows = useMemo(
    () => {
      const xwayRows = baseRows.map((row) => ({
        ...row,
        stockMpvibe: toNumber(mpvibeStockByArticle[row.article]?.stock_fbo),
      }));
      return [...xwayRows, ...buildMpvibeOnlyRows(mpvibeStockByArticle, baseRows)];
    },
    [baseRows, mpvibeStockByArticle],
  );
  const limitDetailRefs = useMemo(
    () =>
      baseRows
        .filter((row) => row.source === "xway" && row.campaignStates.some(isLimitCheckCampaignState))
        .map((row) => row.ref),
    [baseRows],
  );
  const autoExclusionRefs = useMemo(
    () =>
      baseRows
        .filter((row) => row.source === "xway" && row.campaignStates.some(isAutoExclusionCheckCampaignState))
        .map((row) => row.ref),
    [baseRows],
  );

  const topDrrRows = useMemo<DrrAnalyticsRow[]>(() => {
    return [...rows]
      .filter((row) => (row.spend ?? 0) > 0 && row.drr !== null)
      .sort((left, right) => (right.drr ?? Number.NEGATIVE_INFINITY) - (left.drr ?? Number.NEGATIVE_INFINITY))
      .slice(0, limit)
      .map((row) => ({ ...row, wb: wbByArticle[row.article] ?? null }));
  }, [limit, rows, wbByArticle]);

  const drrRows = useMemo(() => {
    const sorted = sortRows<DrrAnalyticsRow>(topDrrRows, drrSort, (row, field) => {
      switch (field as DrrSortField) {
        case "rank":
          return topDrrRows.indexOf(row) + 1;
        case "article":
          return articleNumber(row.article);
        case "drr":
          return row.drr;
        case "stock":
          return row.stock;
        case "stockMpvibe":
          return row.stockMpvibe;
        case "spend":
          return row.spend;
        case "revenue":
          return row.revenue;
        case "ordersAds":
          return row.ordersAds;
        case "ordersTotal":
          return row.ordersTotal;
        case "reviews":
          return row.wb?.feedbacks ?? row.wb?.nm_feedbacks ?? null;
        case "bzo":
          return (row.wb?.feedback_points ?? 0) > 0;
        case "price":
          return row.wb?.price_spp ?? null;
        case "shop":
          return row.shopName;
        case "name":
        default:
          return row.name;
      }
    });
    return sorted.map((row, index) => ({ ...row, rank: index + 1 }));
  }, [drrSort, topDrrRows]);

  const stockRows = useMemo(() => {
    const candidates = rows
      .filter((row) => stockSignal(row) > STOCK_MIN_VALUE && (row.spend ?? 0) === 0);
    const sorted = sortRows<AnalyticsRowBase>(candidates, stockSort, (row, field) => {
      switch (field as StockSortField) {
        case "rank":
          return candidates.indexOf(row) + 1;
        case "article":
          return articleNumber(row.article);
        case "stock":
          return row.stock;
        case "stockMpvibe":
          return row.stockMpvibe;
        case "turnover":
          return row.turnoverDays;
        case "spend":
          return row.spend;
        case "ordersTotal":
          return row.ordersTotal;
        case "campaigns":
          return row.campaigns;
        case "activeCampaigns":
          return row.activeCampaigns;
        case "enabled":
          return row.enabled;
        case "shop":
          return row.shopName;
        case "name":
        default:
          return row.name;
      }
    });
    return sorted.slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
  }, [limit, rows, stockSort]);
  const limitRows = useMemo(() => {
    const candidates = rows
      .map((row) => buildLimitSetupRow(row, limitCampaignStatesByRef[row.ref]))
      .filter((row): row is LimitSetupRow => row !== null);
    const sorted = sortRows<LimitSetupRow>(candidates, limitsSort, (row, field) => {
      switch (field as LimitSortField) {
        case "rank":
          return candidates.indexOf(row) + 1;
        case "article":
          return articleNumber(row.article);
        case "issueCount":
          return row.issueCount;
        case "missingSpendLimit":
          return row.missingSpendLimit;
        case "missingBudgetRule":
          return row.missingBudgetRule;
        case "spendLimit":
          return row.spendLimit;
        case "budgetLimit":
          return row.budgetLimit;
        case "stock":
          return row.stock;
        case "stockMpvibe":
          return row.stockMpvibe;
        case "spend":
          return row.spend;
        case "ordersTotal":
          return row.ordersTotal;
        case "activeCampaigns":
          return row.activeCampaignStateCount;
        case "shop":
          return row.shopName;
        case "name":
        default:
          return row.name;
      }
    });
    return sorted.map((row, index) => ({ ...row, rank: index + 1 }));
  }, [limitCampaignStatesByRef, limitsSort, rows]);
  const limitIssueRows = useMemo(() => limitRows.filter((row) => row.missingSpendLimit || row.missingBudgetRule), [limitRows]);
  const limitConfiguredRows = useMemo(() => limitRows.filter((row) => !row.missingSpendLimit && !row.missingBudgetRule), [limitRows]);
  const limitActivityRows = useMemo(() => {
    const candidates = rows
      .map((row) => buildLimitActivityRow(row, limitActivityIssuesByRef[row.ref]))
      .filter((row): row is LimitActivityRow => row !== null);
    const sorted = sortRows<LimitActivityRow>(candidates, limitActivitySort, (row, field) => {
      switch (field as LimitActivitySortField) {
        case "rank":
          return candidates.indexOf(row) + 1;
        case "article":
          return articleNumber(row.article);
        case "issueCount":
          return row.issueCount;
        case "maxIncidentHours":
          return row.maxIncidentHours;
        case "totalHours":
          return row.totalHours;
        case "incidents":
          return row.incidents;
        case "spend":
          return row.spend;
        case "ordersTotal":
          return row.ordersTotal;
        case "stock":
          return row.stock;
        case "stockMpvibe":
          return row.stockMpvibe;
        case "activeCampaigns":
          return row.activeCampaigns;
        case "shop":
          return row.shopName;
        case "name":
        default:
          return row.name;
      }
    });
    return sorted.map((row, index) => ({ ...row, rank: index + 1 }));
  }, [limitActivityIssuesByRef, limitActivitySort, rows]);
  const autoExclusionRows = useMemo(() => {
    const candidates = rows.flatMap((row) => buildAutoExclusionCampaignRows(row, autoExclusionsByRef[row.ref]));
    const sorted = sortRows<AutoExclusionCampaignRow>(candidates, autoExclusionsSort, (row, field) => {
      switch (field as AutoExclusionSortField) {
        case "rank":
          return candidates.indexOf(row) + 1;
        case "article":
          return articleNumber(row.article);
        case "campaignId":
          return row.campaignId;
        case "configured":
          return row.configured;
        case "ruleActive":
          return row.ruleActive;
        case "ruleDays":
          return row.ruleDays;
        case "spend":
          return row.spend;
        case "ordersTotal":
          return row.ordersTotal;
        case "stock":
          return row.stock;
        case "stockMpvibe":
          return row.stockMpvibe;
        case "shop":
          return row.shopName;
        case "name":
        default:
          return row.name;
      }
    });
    return sorted.map((row, index) => ({ ...row, rank: index + 1 }));
  }, [autoExclusionsByRef, autoExclusionsSort, rows]);
  const autoExclusionIssueRows = useMemo(() => autoExclusionRows.filter((row) => !row.configured), [autoExclusionRows]);
  const autoExclusionConfiguredRows = useMemo(() => autoExclusionRows.filter((row) => row.configured), [autoExclusionRows]);
  const categoryShopGroups = useMemo(() => buildCategoryDriverGroups(rows, categorySort, categoryMinStock), [categoryMinStock, categorySort, rows]);
  const allCategoryGroup = useMemo(() => buildAllCategoryDriverGroup(rows, categorySort, categoryMinStock), [categoryMinStock, categorySort, rows]);
  const categoryRowsCount = categoryShopGroups.reduce((sum, group) => sum + group.rows.length, 0);
  const drrSummaryRow = useMemo(() => buildDrrSummaryRow(drrRows), [drrRows]);
  const stockSummaryRow = useMemo(() => buildStockSummaryRow(stockRows, loadedRange?.days ?? days), [days, loadedRange?.days, stockRows]);

  const drrHeader = useSortableHeader<DrrSortField>(drrSort, setDrrSort);
  const stockHeader = useSortableHeader<StockSortField>(stockSort, setStockSort);
  const limitsHeader = useSortableHeader<LimitSortField>(limitsSort, setLimitsSort);
  const limitActivityHeader = useSortableHeader<LimitActivitySortField>(limitActivitySort, setLimitActivitySort);
  const autoExclusionsHeader = useSortableHeader<AutoExclusionSortField>(autoExclusionsSort, setAutoExclusionsSort);
  const categoryHeader = useSortableHeader<CategorySortField>(categorySort, setCategorySort);
  const columnWidthProps = (columnKey: ResizableColumnKey) => ({
    width: columnWidths[columnKey],
    minWidth: RESIZABLE_COLUMN_CONFIG[columnKey].min,
    maxWidth: RESIZABLE_COLUMN_CONFIG[columnKey].max,
  });

  const runQueuedDrrBackgroundTask = async <T,>(task: () => Promise<T>): Promise<T> => {
    const queuedTask = drrBackgroundQueueRef.current.catch(() => undefined).then(task);
    drrBackgroundQueueRef.current = queuedTask.then(
      () => undefined,
      () => undefined,
    );
    return queuedTask;
  };

  const startColumnResize = (columnKey: ResizableColumnKey, event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeDragRef.current = {
      columnKey,
      startX: event.clientX,
      startWidth: columnWidths[columnKey],
    };
    if (typeof document !== "undefined") {
      document.body.classList.add("is-resizing-drr-column");
    }
  };

  const resetColumnWidth = (columnKey: ResizableColumnKey, event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
    setColumnWidths((current) => {
      const nextWidth = RESIZABLE_COLUMN_CONFIG[columnKey].default;
      return current[columnKey] === nextWidth ? current : { ...current, [columnKey]: nextWidth };
    });
  };

  const resizableHeader = (content: ReactNode, columnKey: ResizableColumnKey) => (
    <div className="drr-resizable-header">
      <div className="drr-resizable-header-content">{content}</div>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label="Изменить ширину колонки"
        title="Потяните, чтобы изменить ширину. Двойной клик сбрасывает ширину."
        className="drr-column-resize-handle"
        onPointerDown={(event) => startColumnResize(columnKey, event)}
        onDoubleClick={(event) => resetColumnWidth(columnKey, event)}
      />
    </div>
  );

  const rangeLabel = loadedRange ? formatDateRange(loadedRange.start, loadedRange.end) : "Период еще не загружен";
  const totalSpend = rows.reduce((sum, row) => sum + (row.spend ?? 0), 0);
  const zeroSpendStockCount = rows.filter((row) => stockSignal(row) > STOCK_MIN_VALUE && (row.spend ?? 0) === 0).length;
  const missingSpendLimitCount = limitIssueRows.filter((row) => row.missingSpendLimit).length;
  const missingBudgetRuleCount = limitIssueRows.filter((row) => row.missingBudgetRule).length;
  const configuredLimitCount = limitConfiguredRows.length;
  const limitActivityLimitCount = limitActivityRows.filter((row) => row.issues.some((issue) => issue.kind === "limit")).length;
  const limitActivityBudgetCount = limitActivityRows.filter((row) => row.issues.some((issue) => issue.kind === "budget")).length;
  const limitActivityMaxHours = limitActivityRows.length ? Math.max(...limitActivityRows.map((row) => row.maxIncidentHours)) : null;
  const autoExclusionSkippedCpcCount = Object.values(autoExclusionsByRef).reduce((sum, row) => sum + (row.cpc_skipped_count || 0), 0);
  const currentSectionRefreshing =
    (section === "drr" && (loading || wbLoading)) ||
    (section === "stocks" && mpvibeLoading) ||
    (section === "limits" && limitDetailsLoading) ||
    (section === "limitActivity" && limitActivityLoading) ||
    (section === "autoExclusions" && autoExclusionsLoading) ||
    (section === "categories" && loading);
  const anyRefreshLoading = loading || wbLoading || mpvibeLoading || limitDetailsLoading || limitActivityLoading || autoExclusionsLoading;
  const canRefreshCurrentSection = Boolean(loadedRange) || section === "drr" || section === "categories";

  const refreshCatalogOnly = async (forceRefresh = true) => {
    const nextDays = clampInteger(daysInput, DEFAULT_DAYS, 1, MAX_DAYS);
    const nextRange = buildStatsRange(nextDays);
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    setLoading(true);
    setError(null);
    try {
      const catalogPayload = await fetchCatalog({
        start: nextRange.start,
        end: nextRange.end,
        includeAux: false,
        forceRefresh,
        signal: abortController.signal,
      });
      setPayload(catalogPayload);
      setLoadedRange({ ...nextRange, days: nextDays });
    } catch (loadError) {
      if (!isAbortError(loadError)) {
        setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить аналитику.");
      }
    } finally {
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
      setLoading(false);
    }
  };

  const loadData = async (forceRefresh = false) => {
    const nextDays = clampInteger(daysInput, DEFAULT_DAYS, 1, MAX_DAYS);
    const nextRange = buildStatsRange(nextDays);
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    mpvibeForceRefreshRef.current = forceRefresh;
    limitDetailsForceRefreshRef.current = forceRefresh;
    limitActivityForceRefreshRef.current = forceRefresh;
    autoExclusionsForceRefreshRef.current = forceRefresh;
    wbAbortRef.current?.abort();
    mpvibeAbortRef.current?.abort();
    limitDetailsAbortRef.current?.abort();
    limitActivityAbortRef.current?.abort();
    autoExclusionsAbortRef.current?.abort();
    limitDetailsRequestRef.current = null;
    limitActivityRequestRef.current = null;
    autoExclusionsRequestRef.current = null;
    setLoading(true);
    setError(null);
    setMpvibeWarning(null);
    setLimitDetailsError(null);
    setLimitActivityError(null);
    setAutoExclusionsError(null);
    setWbByArticle({});
    setLimitCampaignStatesByRef({});
    setLimitActivityIssuesByRef({});
    setAutoExclusionsByRef({});
    setLimitDetailsProgress({ loaded: 0, total: 0 });
    setLimitActivityProgress({ loaded: 0, total: 0 });
    setAutoExclusionsProgress({ loaded: 0, total: 0 });
    mpvibeLoadedRequestRef.current = null;
    try {
      const catalogPayload = await fetchCatalog({
        start: nextRange.start,
        end: nextRange.end,
        includeAux: false,
        forceRefresh,
        signal: abortController.signal,
      });
      setPayload(catalogPayload);
      setMpvibeStockByArticle({});
      setLoadedRange({ ...nextRange, days: nextDays });
    } catch (loadError) {
      if ((loadError as Error).name !== "AbortError") {
        setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить аналитику.");
      }
    } finally {
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
      setLoading(false);
    }
  };

  const refreshCurrentSection = async () => {
    if (section === "limits") {
      limitDetailsForceRefreshRef.current = true;
      limitDetailsRequestRef.current = null;
      limitDetailsAbortRef.current?.abort();
      setLimitDetailsError(null);
      setLimitDetailsProgress({ loaded: 0, total: 0 });
      setLimitDetailsRefreshNonce((value) => value + 1);
      return;
    }
    if (section === "limitActivity") {
      limitActivityForceRefreshRef.current = true;
      limitActivityRequestRef.current = null;
      limitActivityAbortRef.current?.abort();
      setLimitActivityError(null);
      setLimitActivityProgress({ loaded: 0, total: 0 });
      setLimitActivityRefreshNonce((value) => value + 1);
      return;
    }
    if (section === "autoExclusions") {
      autoExclusionsForceRefreshRef.current = true;
      autoExclusionsRequestRef.current = null;
      autoExclusionsAbortRef.current?.abort();
      setAutoExclusionsError(null);
      setAutoExclusionsProgress({ loaded: 0, total: 0 });
      setAutoExclusionsRefreshNonce((value) => value + 1);
      return;
    }
    if (section === "stocks") {
      mpvibeForceRefreshRef.current = true;
      mpvibeLoadedRequestRef.current = null;
      mpvibeAbortRef.current?.abort();
      setMpvibeWarning(null);
      setMpvibeStockByArticle({});
      setMpvibeRefreshNonce((value) => value + 1);
      return;
    }
    await refreshCatalogOnly(true);
    if (section === "drr") {
      wbAbortRef.current?.abort();
      setWbByArticle({});
    }
  };

  useEffect(() => {
    void loadData(false);
    return () => {
      abortRef.current?.abort();
      wbAbortRef.current?.abort();
      mpvibeAbortRef.current?.abort();
      limitDetailsAbortRef.current?.abort();
      limitActivityAbortRef.current?.abort();
      autoExclusionsAbortRef.current?.abort();
    };
    // Initial load should use default form values only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (section !== "limits" || !loadedRange) {
      return;
    }
    const refs = [...new Set(limitDetailRefs)];
    const requestKey = `${loadedRange.start}:${loadedRange.end}:${refs.join(",")}`;
    if (limitDetailsRequestRef.current === requestKey) {
      return;
    }

    limitDetailsAbortRef.current?.abort();
    const abortController = new AbortController();
    limitDetailsAbortRef.current = abortController;
    limitDetailsRequestRef.current = requestKey;
    const forceRefresh = limitDetailsForceRefreshRef.current;

    setLimitDetailsError(null);
    setLimitDetailsProgress({ loaded: 0, total: refs.length });
    setLimitDetailsLoading(Boolean(refs.length));

    if (!refs.length) {
      return () => {
        if (limitDetailsAbortRef.current === abortController) {
          limitDetailsAbortRef.current = null;
        }
      };
    }

    void runQueuedDrrBackgroundTask(async () => {
      let checked = 0;
      let failed = 0;
      const chunks = chunkItems(refs, LIMIT_DETAILS_BATCH_SIZE);
      for (const chunk of chunks) {
        if (abortController.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const nextStatesByRef: Record<string, CatalogCampaignState[]> = {};
        try {
          const response = await fetchCatalogProductDetails({
            productRefs: chunk,
            start: loadedRange.start,
            end: loadedRange.end,
            forceRefresh,
            includeCampaignDetails: true,
            includeBestTime: false,
            signal: abortController.signal,
          });
          const loadedRefs = new Set<string>();
          response.rows.forEach((row) => {
            if (row.errors?.campaign_details || !row.campaign_states?.length) {
              return;
            }
            nextStatesByRef[row.product_ref] = row.campaign_states;
            loadedRefs.add(row.product_ref);
          });
          failed += chunk.filter((ref) => !loadedRefs.has(ref)).length;
        } catch (chunkError) {
          if (isAbortError(chunkError)) {
            throw chunkError;
          }
          failed += chunk.length;
        }

        if (Object.keys(nextStatesByRef).length) {
          setLimitCampaignStatesByRef((current) => ({ ...current, ...nextStatesByRef }));
        }
        checked += chunk.length;
        setLimitDetailsProgress({ loaded: checked, total: refs.length });
      }

      if (failed > 0) {
        setLimitDetailsError(`Не удалось проверить лимиты для ${formatNumber(failed)} товаров. Остальные строки показаны по детальным данным XWAY.`);
      }
    })
      .catch((detailsError) => {
        if (!isAbortError(detailsError)) {
          setLimitDetailsError(detailsError instanceof Error ? detailsError.message : "Не удалось догрузить лимиты и пополнения.");
        }
      })
      .finally(() => {
        if (limitDetailsAbortRef.current === abortController) {
          limitDetailsAbortRef.current = null;
          setLimitDetailsLoading(false);
          limitDetailsForceRefreshRef.current = false;
        }
      });

    return () => {
      abortController.abort();
      if (limitDetailsAbortRef.current === abortController) {
        limitDetailsAbortRef.current = null;
        limitDetailsRequestRef.current = null;
        setLimitDetailsLoading(false);
      }
    };
  }, [limitDetailRefs, limitDetailsRefreshNonce, loadedRange, section]);

  useEffect(() => {
    if (section !== "limitActivity" || !loadedRange) {
      return;
    }
    const refs = [...new Set(limitDetailRefs)];
    const requestKey = `${loadedRange.start}:${loadedRange.end}:${refs.join(",")}`;
    if (limitActivityRequestRef.current === requestKey) {
      return;
    }

    limitActivityAbortRef.current?.abort();
    const abortController = new AbortController();
    limitActivityAbortRef.current = abortController;
    limitActivityRequestRef.current = requestKey;
    const forceRefresh = limitActivityForceRefreshRef.current;

    setLimitActivityError(null);
    setLimitActivityProgress({ loaded: 0, total: refs.length });
    setLimitActivityLoading(Boolean(refs.length));

    if (!refs.length) {
      return () => {
        if (limitActivityAbortRef.current === abortController) {
          limitActivityAbortRef.current = null;
        }
      };
    }

    void runQueuedDrrBackgroundTask(async () => {
      let failed = 0;
      let loaded = 0;
      const fetchLimitActivityChunk = async (chunk: string[]): Promise<number> => {
        try {
          const response = await fetchCatalogIssues({
            productRefs: chunk,
            start: loadedRange.start,
            end: loadedRange.end,
            forceRefresh,
            limitProducts: chunk.length,
            deadlineMs: LIMIT_ACTIVITY_DEADLINE_MS,
            scope: "limit_activity",
            signal: abortController.signal,
          });
          const nextRowsByRef: Record<string, CatalogIssuesRow> = {};
          const loadedRefs = new Set<string>();
          let failedRows = 0;
          response.rows.forEach((row) => {
            nextRowsByRef[row.product_ref] = row;
            loadedRefs.add(row.product_ref);
            if (row.error) {
              failedRows += 1;
            }
          });
          failedRows += chunk.filter((ref) => !loadedRefs.has(ref)).length;
          if (Object.keys(nextRowsByRef).length) {
            setLimitActivityIssuesByRef((current) => ({ ...current, ...nextRowsByRef }));
          }
          return failedRows;
        } catch (chunkError) {
          if (isAbortError(chunkError)) {
            throw chunkError;
          }
          const message = await readDrrApiErrorMessage(chunkError, "Не удалось загрузить логи активности РК.");
          if (chunk.length > 1 && isRetryableLimitActivityError(message)) {
            const middle = Math.max(1, Math.ceil(chunk.length / 2));
            const leftFailed = await fetchLimitActivityChunk(chunk.slice(0, middle));
            const rightFailed = await fetchLimitActivityChunk(chunk.slice(middle));
            return leftFailed + rightFailed;
          }
          if (chunk.length > 1) {
            const middle = Math.max(1, Math.ceil(chunk.length / 2));
            const leftFailed = await fetchLimitActivityChunk(chunk.slice(0, middle));
            const rightFailed = await fetchLimitActivityChunk(chunk.slice(middle));
            return leftFailed + rightFailed;
          }
          return chunk.length;
        }
      };

      const chunks = chunkItems(refs, LIMIT_ACTIVITY_BATCH_SIZE);
      for (const chunk of chunks) {
        if (abortController.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        failed += await fetchLimitActivityChunk(chunk);
        loaded += chunk.length;
        setLimitActivityProgress({ loaded: Math.min(loaded, refs.length), total: refs.length });
      }

      if (failed > 0) {
        setLimitActivityError(`Не удалось проверить логи активности для ${formatNumber(failed)} товаров. Остальные строки показаны по доступным данным XWAY.`);
      }
    })
      .catch(async (activityError) => {
        if (!isAbortError(activityError)) {
          setLimitActivityError(await readDrrApiErrorMessage(activityError, "Не удалось загрузить логи активности РК."));
        }
      })
      .finally(() => {
        if (limitActivityAbortRef.current === abortController) {
          limitActivityAbortRef.current = null;
          setLimitActivityLoading(false);
          limitActivityForceRefreshRef.current = false;
        }
      });

    return () => {
      abortController.abort();
      if (limitActivityAbortRef.current === abortController) {
        limitActivityAbortRef.current = null;
        limitActivityRequestRef.current = null;
        setLimitActivityLoading(false);
      }
    };
  }, [limitActivityRefreshNonce, limitDetailRefs, loadedRange, section]);

  useEffect(() => {
    if (section !== "autoExclusions" || !loadedRange) {
      return;
    }
    const refs = [...new Set(autoExclusionRefs)];
    const requestKey = `${loadedRange.start}:${loadedRange.end}:${refs.join(",")}`;
    if (autoExclusionsRequestRef.current === requestKey) {
      return;
    }

    autoExclusionsAbortRef.current?.abort();
    const abortController = new AbortController();
    autoExclusionsAbortRef.current = abortController;
    autoExclusionsRequestRef.current = requestKey;
    const forceRefresh = autoExclusionsForceRefreshRef.current;

    setAutoExclusionsError(null);
    setAutoExclusionsProgress({ loaded: 0, total: refs.length });
    setAutoExclusionsLoading(Boolean(refs.length));

    if (!refs.length) {
      return () => {
        if (autoExclusionsAbortRef.current === abortController) {
          autoExclusionsAbortRef.current = null;
        }
      };
    }

    void runQueuedDrrBackgroundTask(async () => {
      let failed = 0;
      let loaded = 0;
      const fetchAutoExclusionChunk = async (chunk: string[]): Promise<number> => {
        try {
          const response = await fetchCatalogAutoExclusions({
            productRefs: chunk,
            start: loadedRange.start,
            end: loadedRange.end,
            forceRefresh,
            limitProducts: chunk.length,
            deadlineMs: AUTO_EXCLUSIONS_DEADLINE_MS,
            signal: abortController.signal,
          });
          const nextRowsByRef: Record<string, CatalogAutoExclusionRow> = {};
          const loadedRefs = new Set<string>();
          let failedRows = 0;
          response.rows.forEach((row) => {
            nextRowsByRef[row.product_ref] = row;
            loadedRefs.add(row.product_ref);
            if (row.error) {
              failedRows += 1;
            }
          });
          failedRows += chunk.filter((ref) => !loadedRefs.has(ref)).length;
          if (Object.keys(nextRowsByRef).length) {
            setAutoExclusionsByRef((current) => ({ ...current, ...nextRowsByRef }));
          }
          return failedRows;
        } catch (chunkError) {
          if (isAbortError(chunkError)) {
            throw chunkError;
          }
          const message = await readDrrApiErrorMessage(chunkError, "Не удалось загрузить настройки автоисключения.");
          if (chunk.length > 1 && isRetryableLimitActivityError(message)) {
            const middle = Math.max(1, Math.ceil(chunk.length / 2));
            const leftFailed = await fetchAutoExclusionChunk(chunk.slice(0, middle));
            const rightFailed = await fetchAutoExclusionChunk(chunk.slice(middle));
            return leftFailed + rightFailed;
          }
          if (chunk.length > 1) {
            const middle = Math.max(1, Math.ceil(chunk.length / 2));
            const leftFailed = await fetchAutoExclusionChunk(chunk.slice(0, middle));
            const rightFailed = await fetchAutoExclusionChunk(chunk.slice(middle));
            return leftFailed + rightFailed;
          }
          return chunk.length;
        }
      };

      const chunks = chunkItems(refs, AUTO_EXCLUSIONS_BATCH_SIZE);
      for (const chunk of chunks) {
        if (abortController.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        failed += await fetchAutoExclusionChunk(chunk);
        loaded += chunk.length;
        setAutoExclusionsProgress({ loaded: Math.min(loaded, refs.length), total: refs.length });
      }

      if (failed > 0) {
        setAutoExclusionsError(`Не удалось проверить автоисключение для ${formatNumber(failed)} товаров. Остальные строки показаны по доступным данным XWAY.`);
      }
    })
      .catch(async (autoExclusionError) => {
        if (!isAbortError(autoExclusionError)) {
          setAutoExclusionsError(await readDrrApiErrorMessage(autoExclusionError, "Не удалось загрузить настройки автоисключения."));
        }
      })
      .finally(() => {
        if (autoExclusionsAbortRef.current === abortController) {
          autoExclusionsAbortRef.current = null;
          setAutoExclusionsLoading(false);
          autoExclusionsForceRefreshRef.current = false;
        }
      });

    return () => {
      abortController.abort();
      if (autoExclusionsAbortRef.current === abortController) {
        autoExclusionsAbortRef.current = null;
        autoExclusionsRequestRef.current = null;
        setAutoExclusionsLoading(false);
      }
    };
  }, [autoExclusionRefs, autoExclusionsRefreshNonce, loadedRange, section]);

  useEffect(() => {
    const missingArticles = topDrrRows.map((row) => row.article).filter((article) => !wbByArticle[article]);
    if (!missingArticles.length) {
      return;
    }
    wbAbortRef.current?.abort();
    const abortController = new AbortController();
    wbAbortRef.current = abortController;
    setWbLoading(true);
    runQueuedDrrBackgroundTask(() => fetchWbCards({ articles: missingArticles, signal: abortController.signal }))
      .then((response) => {
        if (response.errors.length && !response.rows.length) {
          setError("WB не вернул карточные данные: отзывы, БЗО и цену можно будет догрузить повторным обновлением.");
        }
        setWbByArticle((current) => {
          const next = { ...current };
          response.rows.forEach((row) => {
            next[row.article] = row;
          });
          return next;
        });
      })
      .catch((wbError) => {
        if ((wbError as Error).name !== "AbortError") {
          setError(wbError instanceof Error ? wbError.message : "Не удалось загрузить данные WB.");
        }
      })
      .finally(() => {
        if (wbAbortRef.current === abortController) {
          wbAbortRef.current = null;
        }
        setWbLoading(false);
      });
  }, [topDrrRows, wbByArticle]);

  useEffect(() => {
    if (!loadedRange) {
      return;
    }
    const requestedArticles = [...new Set(baseRows.map((row) => row.article).filter(Boolean))];
    const requestKey = `${loadedRange.start}:${loadedRange.end}:${requestedArticles.join(",")}`;
    if (mpvibeLoadedRequestRef.current === requestKey) {
      return;
    }
    mpvibeLoadedRequestRef.current = requestKey;
    mpvibeAbortRef.current?.abort();
    const abortController = new AbortController();
    mpvibeAbortRef.current = abortController;
    setMpvibeLoading(true);
    runQueuedDrrBackgroundTask(() =>
      fetchMpvibeStocks({
        articles: requestedArticles,
        start: loadedRange.start,
        end: loadedRange.end,
        includeAllWithStock: true,
        forceRefresh: mpvibeForceRefreshRef.current,
        signal: abortController.signal,
      }),
    )
      .then((response) => {
        setMpvibeWarning(response.errors.length ? resolveMpvibeStockWarning(response) : null);
        setMpvibeStockByArticle((current) => {
          const next = { ...current };
          response.rows.forEach((row) => {
            next[row.article] = row;
          });
          return next;
        });
      })
      .catch((mpvibeError) => {
        if ((mpvibeError as Error).name !== "AbortError") {
          setMpvibeWarning(mpvibeError instanceof Error ? mpvibeError.message : "Не удалось загрузить остатки MPVibe.");
        }
      })
      .finally(() => {
        if (mpvibeAbortRef.current === abortController) {
          mpvibeAbortRef.current = null;
        }
        mpvibeForceRefreshRef.current = false;
        setMpvibeLoading(false);
      });
  }, [baseRows, loadedRange, mpvibeRefreshNonce]);

  useEffect(() => {
    try {
      window.localStorage.setItem(AD_OFF_ERROR_STOCK_THRESHOLD_STORAGE_KEY, String(adOffErrorStockThreshold));
    } catch {
      // localStorage is an optional UI convenience.
    }
  }, [adOffErrorStockThreshold]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CATEGORY_MIN_STOCK_STORAGE_KEY, String(categoryMinStock));
    } catch {
      // localStorage is an optional UI convenience.
    }
  }, [categoryMinStock]);

  useEffect(() => {
    try {
      window.localStorage.setItem(DRR_ANALYTICS_COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(columnWidths));
    } catch {
      // localStorage is an optional UI convenience.
    }
  }, [columnWidths]);

  useEffect(() => {
    const stopResize = () => {
      resizeDragRef.current = null;
      if (typeof document !== "undefined") {
        document.body.classList.remove("is-resizing-drr-column");
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = resizeDragRef.current;
      if (!dragState) {
        return;
      }
      const nextWidth = clampColumnWidth(dragState.columnKey, dragState.startWidth + event.clientX - dragState.startX);
      setColumnWidths((current) => (current[dragState.columnKey] === nextWidth ? current : { ...current, [dragState.columnKey]: nextWidth }));
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      stopResize();
    };
  }, []);

  const drrColumns = withSourceSummaries<RankedDrrRow>([
    {
      key: "rank",
      ...columnWidthProps("rank"),
      header: resizableHeader("#", "rank"),
      headerClassName: "drr-col-rank",
      cellClassName: "drr-col-rank",
      render: (row: RankedDrrRow) => formatNumber(row.rank),
    },
    {
      key: "name",
      ...columnWidthProps("product"),
      header: resizableHeader(drrHeader("name", "Товар", { ariaLabel: "Товар" }), "product"),
      headerClassName: "drr-col-product",
      cellClassName: "drr-col-product",
      render: (row: RankedDrrRow) => <ProductCell row={row} />,
    },
    {
      key: "links",
      ...columnWidthProps("links"),
      header: resizableHeader("Ссылки", "links"),
      headerClassName: "drr-col-links",
      cellClassName: "drr-col-links",
      render: (row: RankedDrrRow) => (
        <div className="drr-analytics-link-stack">
          <XwayLink href={row.productUrl} />
          <WbLink article={row.article} />
        </div>
      ),
    },
    {
      key: "article",
      ...columnWidthProps("article"),
      header: resizableHeader(drrHeader("article", "Артикул", { ariaLabel: "Артикул" }), "article"),
      headerClassName: "drr-col-article",
      cellClassName: "drr-col-article",
      render: (row: RankedDrrRow) => row.article,
    },
    {
      key: "stock",
      ...columnWidthProps("stock"),
      header: resizableHeader(drrHeader("stock", "Остаток XWAY", { ariaLabel: "Остаток XWAY" }), "stock"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedDrrRow) => formatNumber(row.stock),
    },
    {
      key: "stockMpvibe",
      ...columnWidthProps("stockMpvibe"),
      header: resizableHeader(drrHeader("stockMpvibe", "Остаток MPVibe", { ariaLabel: "Остаток MPVibe" }), "stockMpvibe"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedDrrRow) => formatNumber(row.stockMpvibe),
    },
    {
      key: "drr",
      ...columnWidthProps("drr"),
      header: resizableHeader(drrHeader("drr", "ДРР", { ariaLabel: "ДРР" }), "drr"),
      headerClassName: "drr-col-small",
      cellClassName: "drr-col-small",
      render: (row: RankedDrrRow) => formatPercent(row.drr),
    },
    {
      key: "spend",
      ...columnWidthProps("spend"),
      header: resizableHeader(drrHeader("spend", "Расход за период", { ariaLabel: "Расход" }), "spend"),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedDrrRow) => formatMoney(row.spend),
    },
    {
      key: "revenue",
      ...columnWidthProps("revenue"),
      header: resizableHeader(drrHeader("revenue", "Выручка РК", { ariaLabel: "Выручка РК" }), "revenue"),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedDrrRow) => formatMoney(row.revenue),
    },
    {
      key: "ordersAds",
      ...columnWidthProps("ordersAds"),
      header: resizableHeader(drrHeader("ordersAds", "Заказы РК", { ariaLabel: "Заказы РК" }), "ordersAds"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedDrrRow) => formatNumber(row.ordersAds),
    },
    {
      key: "ordersTotal",
      ...columnWidthProps("ordersTotal"),
      header: resizableHeader(drrHeader("ordersTotal", "Заказы всего", { ariaLabel: "Заказы всего" }), "ordersTotal"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedDrrRow) => formatNumber(row.ordersTotal),
    },
    {
      key: "reviews",
      ...columnWidthProps("reviews"),
      header: resizableHeader(drrHeader("reviews", "Отзывы WB", { ariaLabel: "Отзывы WB" }), "reviews"),
      headerClassName: "drr-col-reviews",
      cellClassName: "drr-col-reviews",
      render: (row: RankedDrrRow) => formatReviewCell(row.wb),
    },
    {
      key: "bzo",
      ...columnWidthProps("bzo"),
      header: resizableHeader(drrHeader("bzo", "БЗО", { ariaLabel: "БЗО" }), "bzo"),
      headerClassName: "drr-col-bzo",
      cellClassName: "drr-col-bzo",
      render: (row: RankedDrrRow) => formatBzoCell(row.wb),
    },
    {
      key: "price",
      ...columnWidthProps("price"),
      header: resizableHeader(drrHeader("price", "Цена с СПП", { ariaLabel: "Цена с СПП" }), "price"),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedDrrRow) => formatMoney(row.wb?.price_spp),
    },
    {
      key: "shop",
      ...columnWidthProps("shop"),
      header: resizableHeader(drrHeader("shop", "Кабинет", { ariaLabel: "Кабинет" }), "shop"),
      headerClassName: "drr-col-shop",
      cellClassName: "drr-col-shop",
      render: (row: RankedDrrRow) => row.shopName,
    },
  ], {
    rank: "Расчет",
    name: "XWAY",
    links: "XWAY/WB",
    article: "XWAY",
    stock: "XWAY",
    stockMpvibe: "MPVibe",
    drr: "Расчет",
    spend: "XWAY",
    revenue: "XWAY",
    ordersAds: "XWAY",
    ordersTotal: "XWAY",
    reviews: "WB",
    bzo: "WB",
    price: "WB",
    shop: "XWAY",
  });

  const stockColumns = withSourceSummaries<RankedStockRow>([
    {
      key: "rank",
      ...columnWidthProps("rank"),
      header: resizableHeader("#", "rank"),
      headerClassName: "drr-col-rank",
      cellClassName: "drr-col-rank",
      render: (row: RankedStockRow) => formatNumber(row.rank),
    },
    {
      key: "name",
      ...columnWidthProps("product"),
      header: resizableHeader(stockHeader("name", "Товар", { ariaLabel: "Товар" }), "product"),
      headerClassName: "drr-col-product",
      cellClassName: "drr-col-product",
      render: (row: RankedStockRow) => <ProductCell row={row} />,
    },
    {
      key: "links",
      ...columnWidthProps("links"),
      header: resizableHeader("Ссылки", "links"),
      headerClassName: "drr-col-links",
      cellClassName: "drr-col-links",
      render: (row: RankedStockRow) => (
        <div className="drr-analytics-link-stack">
          <XwayLink href={row.productUrl} />
          <WbLink article={row.article} />
        </div>
      ),
    },
    {
      key: "article",
      ...columnWidthProps("article"),
      header: resizableHeader(stockHeader("article", "Артикул", { ariaLabel: "Артикул" }), "article"),
      headerClassName: "drr-col-article",
      cellClassName: "drr-col-article",
      render: (row: RankedStockRow) => row.article,
    },
    {
      key: "stock",
      ...columnWidthProps("stock"),
      header: resizableHeader(stockHeader("stock", "Остаток XWAY", { ariaLabel: "Остаток XWAY" }), "stock"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedStockRow) => formatNumber(row.stock),
    },
    {
      key: "stockMpvibe",
      ...columnWidthProps("stockMpvibe"),
      header: resizableHeader(stockHeader("stockMpvibe", "Остаток MPVibe", { ariaLabel: "Остаток MPVibe" }), "stockMpvibe"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedStockRow) => formatNumber(row.stockMpvibe),
    },
    {
      key: "turnover",
      ...columnWidthProps("turnover"),
      header: resizableHeader(stockHeader("turnover", "Оборач. по периоду", { ariaLabel: "Оборачиваемость" }), "turnover"),
      headerClassName: "drr-col-turnover",
      cellClassName: "drr-col-turnover",
      render: (row: RankedStockRow) => formatTurnover(row.turnoverDays),
    },
    {
      key: "spend",
      ...columnWidthProps("spend"),
      header: resizableHeader(stockHeader("spend", "Расход", { ariaLabel: "Расход" }), "spend"),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedStockRow) => formatMoney(row.spend),
    },
    {
      key: "ordersTotal",
      ...columnWidthProps("ordersTotal"),
      header: resizableHeader(stockHeader("ordersTotal", "Заказы всего", { ariaLabel: "Заказы всего" }), "ordersTotal"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedStockRow) => formatNumber(row.ordersTotal),
    },
    {
      key: "activeCampaigns",
      ...columnWidthProps("activeCampaigns"),
      header: resizableHeader(stockHeader("activeCampaigns", "Реклама", { ariaLabel: "Активные РК" }), "activeCampaigns"),
      headerClassName: "drr-col-status",
      cellClassName: "drr-col-status",
      render: (row: RankedStockRow) => (
        <span
          className={cn(
            "drr-status-chip",
            row.activeCampaigns > 0 ? "is-on" : stockSignal(row) > adOffErrorStockThreshold ? "is-error" : "is-off",
          )}
          title={
            row.activeCampaigns > 0
              ? "Есть активная реклама"
              : stockSignal(row) > adOffErrorStockThreshold
                ? `Реклама выключена при остатке больше ${formatNumber(adOffErrorStockThreshold)}`
                : "Реклама выключена"
          }
        >
          {row.activeCampaigns > 0 ? `активна ${row.activeCampaigns}` : "выкл"}
        </span>
      ),
    },
    {
      key: "campaigns",
      ...columnWidthProps("campaigns"),
      header: resizableHeader(stockHeader("campaigns", "РК всего", { ariaLabel: "РК всего" }), "campaigns"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedStockRow) => formatNumber(row.campaigns),
    },
    {
      key: "enabled",
      ...columnWidthProps("enabled"),
      header: resizableHeader(stockHeader("enabled", "XWAY статус", { ariaLabel: "XWAY статус" }), "enabled"),
      headerClassName: "drr-col-status",
      cellClassName: "drr-col-status",
      render: (row: RankedStockRow) => (
        <span className={cn("drr-status-chip", row.enabled ? "is-on" : "is-off")}>{row.enabled ? "включен" : "отключен"}</span>
      ),
    },
    {
      key: "shop",
      ...columnWidthProps("shop"),
      header: resizableHeader(stockHeader("shop", "Кабинет", { ariaLabel: "Кабинет" }), "shop"),
      headerClassName: "drr-col-shop",
      cellClassName: "drr-col-shop",
      render: (row: RankedStockRow) => row.shopName,
    },
  ], {
    rank: "Расчет",
    name: "XWAY",
    links: "XWAY/WB",
    article: "XWAY",
    stock: "XWAY",
    stockMpvibe: "MPVibe",
    turnover: "Расчет",
    spend: "XWAY",
    ordersTotal: "XWAY",
    activeCampaigns: "XWAY",
    campaigns: "XWAY",
    enabled: "XWAY",
    shop: "XWAY",
  });

  const limitColumns = withSourceSummaries<RankedLimitSetupRow>([
    {
      key: "rank",
      ...columnWidthProps("rank"),
      header: resizableHeader("#", "rank"),
      headerClassName: "drr-col-rank",
      cellClassName: "drr-col-rank",
      render: (row: RankedLimitSetupRow) => formatNumber(row.rank),
    },
    {
      key: "name",
      ...columnWidthProps("product"),
      header: resizableHeader(limitsHeader("name", "Товар", { ariaLabel: "Товар" }), "product"),
      headerClassName: "drr-col-product",
      cellClassName: "drr-col-product",
      render: (row: RankedLimitSetupRow) => <ProductCell row={row} />,
    },
    {
      key: "links",
      ...columnWidthProps("links"),
      header: resizableHeader("Ссылки", "links"),
      headerClassName: "drr-col-links",
      cellClassName: "drr-col-links",
      render: (row: RankedLimitSetupRow) => (
        <div className="drr-analytics-link-stack">
          <XwayLink href={row.productUrl} />
          <WbLink article={row.article} />
        </div>
      ),
    },
    {
      key: "article",
      ...columnWidthProps("article"),
      header: resizableHeader(limitsHeader("article", "Артикул", { ariaLabel: "Артикул" }), "article"),
      headerClassName: "drr-col-article",
      cellClassName: "drr-col-article",
      render: (row: RankedLimitSetupRow) => row.article,
    },
    {
      key: "issueCount",
      ...columnWidthProps("limitIssue"),
      header: resizableHeader(limitsHeader("issueCount", "Проблема", { ariaLabel: "Проблема" }), "limitIssue"),
      headerClassName: "drr-col-limit-issue",
      cellClassName: "drr-col-limit-issue",
      render: (row: RankedLimitSetupRow) => <LimitIssueCell row={row} />,
    },
    {
      key: "spendLimit",
      ...columnWidthProps("limitAmount"),
      header: resizableHeader(limitsHeader("spendLimit", "Лимит расхода", { ariaLabel: "Лимит расхода" }), "limitAmount"),
      headerClassName: "drr-col-limit-amount",
      cellClassName: "drr-col-limit-amount",
      render: (row: RankedLimitSetupRow) => (
        <LimitSetupCell
          configured={row.spendLimitConfiguredCount}
          total={row.activeCampaignStateCount}
          limit={row.spendLimit}
          spent={row.spendSpentToday}
        />
      ),
    },
    {
      key: "budgetLimit",
      ...columnWidthProps("limitAmount"),
      header: resizableHeader(limitsHeader("budgetLimit", "Бюджет / пополн.", { ariaLabel: "Бюджет и пополнения" }), "limitAmount"),
      headerClassName: "drr-col-limit-amount",
      cellClassName: "drr-col-limit-amount",
      render: (row: RankedLimitSetupRow) => (
        <LimitSetupCell
          configured={row.budgetRuleConfiguredCount}
          total={row.activeCampaignStateCount}
          limit={row.budgetLimit}
          spent={row.budgetSpentToday}
        />
      ),
    },
    {
      key: "activeCampaigns",
      ...columnWidthProps("activeCampaigns"),
      header: resizableHeader(limitsHeader("activeCampaigns", "РК к проверке", { ariaLabel: "РК к проверке" }), "activeCampaigns"),
      headerClassName: "drr-col-status",
      cellClassName: "drr-col-status",
      render: (row: RankedLimitSetupRow) => formatNumber(row.activeCampaignStateCount),
    },
    {
      key: "spend",
      ...columnWidthProps("spend"),
      header: resizableHeader(limitsHeader("spend", "Расход за период", { ariaLabel: "Расход" }), "spend"),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedLimitSetupRow) => formatMoney(row.spend),
    },
    {
      key: "ordersTotal",
      ...columnWidthProps("ordersTotal"),
      header: resizableHeader(limitsHeader("ordersTotal", "Заказы всего", { ariaLabel: "Заказы всего" }), "ordersTotal"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedLimitSetupRow) => formatNumber(row.ordersTotal),
    },
    {
      key: "stock",
      ...columnWidthProps("stock"),
      header: resizableHeader(limitsHeader("stock", "Остаток XWAY", { ariaLabel: "Остаток XWAY" }), "stock"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedLimitSetupRow) => formatNumber(row.stock),
    },
    {
      key: "stockMpvibe",
      ...columnWidthProps("stockMpvibe"),
      header: resizableHeader(limitsHeader("stockMpvibe", "Остаток MPVibe", { ariaLabel: "Остаток MPVibe" }), "stockMpvibe"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedLimitSetupRow) => formatNumber(row.stockMpvibe),
    },
    {
      key: "shop",
      ...columnWidthProps("shop"),
      header: resizableHeader(limitsHeader("shop", "Кабинет", { ariaLabel: "Кабинет" }), "shop"),
      headerClassName: "drr-col-shop",
      cellClassName: "drr-col-shop",
      render: (row: RankedLimitSetupRow) => row.shopName,
    },
  ], {
    rank: "Расчет",
    name: "XWAY",
    links: "XWAY/WB",
    article: "XWAY",
    issueCount: "Расчет",
    spendLimit: "XWAY",
    budgetLimit: "XWAY",
    activeCampaigns: "XWAY",
    spend: "XWAY",
    ordersTotal: "XWAY",
    stock: "XWAY",
    stockMpvibe: "MPVibe",
    shop: "XWAY",
  });

  const limitActivityColumns = withSourceSummaries<RankedLimitActivityRow>([
    {
      key: "rank",
      ...columnWidthProps("rank"),
      header: resizableHeader("#", "rank"),
      headerClassName: "drr-col-rank",
      cellClassName: "drr-col-rank",
      render: (row: RankedLimitActivityRow) => formatNumber(row.rank),
    },
    {
      key: "name",
      ...columnWidthProps("product"),
      header: resizableHeader(limitActivityHeader("name", "Товар", { ariaLabel: "Товар" }), "product"),
      headerClassName: "drr-col-product",
      cellClassName: "drr-col-product",
      render: (row: RankedLimitActivityRow) => <ProductCell row={row} />,
    },
    {
      key: "links",
      ...columnWidthProps("links"),
      header: resizableHeader("Ссылки", "links"),
      headerClassName: "drr-col-links",
      cellClassName: "drr-col-links",
      render: (row: RankedLimitActivityRow) => (
        <div className="drr-analytics-link-stack">
          <XwayLink href={row.productUrl} />
          <WbLink article={row.article} />
        </div>
      ),
    },
    {
      key: "article",
      ...columnWidthProps("article"),
      header: resizableHeader(limitActivityHeader("article", "Артикул", { ariaLabel: "Артикул" }), "article"),
      headerClassName: "drr-col-article",
      cellClassName: "drr-col-article",
      render: (row: RankedLimitActivityRow) => row.article,
    },
    {
      key: "issueCount",
      ...columnWidthProps("limitActivityIssue"),
      header: resizableHeader(limitActivityHeader("issueCount", "Проблема", { ariaLabel: "Проблема" }), "limitActivityIssue"),
      headerClassName: "drr-col-limit-activity-issue",
      cellClassName: "drr-col-limit-activity-issue",
      render: (row: RankedLimitActivityRow) => <LimitActivityIssueCell row={row} />,
    },
    {
      key: "maxIncidentHours",
      ...columnWidthProps("limitActivityHours"),
      header: resizableHeader(limitActivityHeader("maxIncidentHours", "Макс. подряд", { ariaLabel: "Максимум подряд" }), "limitActivityHours"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedLimitActivityRow) => formatHours(row.maxIncidentHours),
    },
    {
      key: "totalHours",
      ...columnWidthProps("limitActivityHours"),
      header: resizableHeader(limitActivityHeader("totalHours", "Всего часов", { ariaLabel: "Всего часов" }), "limitActivityHours"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedLimitActivityRow) => formatHours(row.totalHours),
    },
    {
      key: "incidents",
      ...columnWidthProps("ordersAds"),
      header: resizableHeader(limitActivityHeader("incidents", "Инциденты", { ariaLabel: "Инциденты" }), "ordersAds"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedLimitActivityRow) => formatNumber(row.incidents),
    },
    {
      key: "activeCampaigns",
      ...columnWidthProps("activeCampaigns"),
      header: resizableHeader(limitActivityHeader("activeCampaigns", "РК", { ariaLabel: "РК" }), "activeCampaigns"),
      headerClassName: "drr-col-status",
      cellClassName: "drr-col-status",
      render: (row: RankedLimitActivityRow) => formatNumber(row.campaignLabels.length),
    },
    {
      key: "spend",
      ...columnWidthProps("spend"),
      header: resizableHeader(limitActivityHeader("spend", "Расход за период", { ariaLabel: "Расход" }), "spend"),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedLimitActivityRow) => formatMoney(row.spend),
    },
    {
      key: "ordersTotal",
      ...columnWidthProps("ordersTotal"),
      header: resizableHeader(limitActivityHeader("ordersTotal", "Заказы всего", { ariaLabel: "Заказы всего" }), "ordersTotal"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedLimitActivityRow) => formatNumber(row.ordersTotal),
    },
    {
      key: "stock",
      ...columnWidthProps("stock"),
      header: resizableHeader(limitActivityHeader("stock", "Остаток XWAY", { ariaLabel: "Остаток XWAY" }), "stock"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedLimitActivityRow) => formatNumber(row.stock),
    },
    {
      key: "stockMpvibe",
      ...columnWidthProps("stockMpvibe"),
      header: resizableHeader(limitActivityHeader("stockMpvibe", "Остаток MPVibe", { ariaLabel: "Остаток MPVibe" }), "stockMpvibe"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedLimitActivityRow) => formatNumber(row.stockMpvibe),
    },
    {
      key: "shop",
      ...columnWidthProps("shop"),
      header: resizableHeader(limitActivityHeader("shop", "Кабинет", { ariaLabel: "Кабинет" }), "shop"),
      headerClassName: "drr-col-shop",
      cellClassName: "drr-col-shop",
      render: (row: RankedLimitActivityRow) => row.shopName,
    },
  ], {
    rank: "Расчет",
    name: "XWAY",
    links: "XWAY/WB",
    article: "XWAY",
    issueCount: "Расчет",
    maxIncidentHours: "XWAY",
    totalHours: "XWAY",
    incidents: "XWAY",
    activeCampaigns: "XWAY",
    spend: "XWAY",
    ordersTotal: "XWAY",
    stock: "XWAY",
    stockMpvibe: "MPVibe",
    shop: "XWAY",
  });

  const autoExclusionColumns = withSourceSummaries<RankedAutoExclusionCampaignRow>([
    {
      key: "rank",
      ...columnWidthProps("rank"),
      header: resizableHeader("#", "rank"),
      headerClassName: "drr-col-rank",
      cellClassName: "drr-col-rank",
      render: (row: RankedAutoExclusionCampaignRow) => formatNumber(row.rank),
    },
    {
      key: "name",
      ...columnWidthProps("product"),
      header: resizableHeader(autoExclusionsHeader("name", "Товар", { ariaLabel: "Товар" }), "product"),
      headerClassName: "drr-col-product",
      cellClassName: "drr-col-product",
      render: (row: RankedAutoExclusionCampaignRow) => <ProductCell row={row} />,
    },
    {
      key: "links",
      ...columnWidthProps("links"),
      header: resizableHeader("Ссылки", "links"),
      headerClassName: "drr-col-links",
      cellClassName: "drr-col-links",
      render: (row: RankedAutoExclusionCampaignRow) => (
        <div className="drr-analytics-link-stack">
          <XwayLink href={row.productUrl} />
          <WbLink article={row.article} />
        </div>
      ),
    },
    {
      key: "article",
      ...columnWidthProps("article"),
      header: resizableHeader(autoExclusionsHeader("article", "Артикул", { ariaLabel: "Артикул" }), "article"),
      headerClassName: "drr-col-article",
      cellClassName: "drr-col-article",
      render: (row: RankedAutoExclusionCampaignRow) => row.article,
    },
    {
      key: "campaignId",
      ...columnWidthProps("autoExclusionCampaign"),
      header: resizableHeader(autoExclusionsHeader("campaignId", "РК", { ariaLabel: "Рекламная кампания" }), "autoExclusionCampaign"),
      headerClassName: "drr-col-auto-exclusion-campaign",
      cellClassName: "drr-col-auto-exclusion-campaign",
      render: (row: RankedAutoExclusionCampaignRow) => <AutoExclusionCampaignCell row={row} />,
    },
    {
      key: "configured",
      ...columnWidthProps("limitIssue"),
      header: resizableHeader(autoExclusionsHeader("configured", "Автоисключение", { ariaLabel: "Автоисключение" }), "limitIssue"),
      headerClassName: "drr-col-limit-issue",
      cellClassName: "drr-col-limit-issue",
      render: (row: RankedAutoExclusionCampaignRow) => <AutoExclusionStatusCell row={row} />,
    },
    {
      key: "ruleDays",
      ...columnWidthProps("autoExclusionRule"),
      header: resizableHeader(autoExclusionsHeader("ruleDays", "Правило", { ariaLabel: "Правило автоисключения" }), "autoExclusionRule"),
      headerClassName: "drr-col-auto-exclusion-rule",
      cellClassName: "drr-col-auto-exclusion-rule",
      render: (row: RankedAutoExclusionCampaignRow) => <AutoExclusionRuleCell row={row} />,
    },
    {
      key: "spend",
      ...columnWidthProps("spend"),
      header: resizableHeader(autoExclusionsHeader("spend", "Расход за период", { ariaLabel: "Расход" }), "spend"),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedAutoExclusionCampaignRow) => formatMoney(row.spend),
    },
    {
      key: "ordersTotal",
      ...columnWidthProps("ordersTotal"),
      header: resizableHeader(autoExclusionsHeader("ordersTotal", "Заказы всего", { ariaLabel: "Заказы всего" }), "ordersTotal"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedAutoExclusionCampaignRow) => formatNumber(row.ordersTotal),
    },
    {
      key: "stock",
      ...columnWidthProps("stock"),
      header: resizableHeader(autoExclusionsHeader("stock", "Остаток XWAY", { ariaLabel: "Остаток XWAY" }), "stock"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedAutoExclusionCampaignRow) => formatNumber(row.stock),
    },
    {
      key: "stockMpvibe",
      ...columnWidthProps("stockMpvibe"),
      header: resizableHeader(autoExclusionsHeader("stockMpvibe", "Остаток MPVibe", { ariaLabel: "Остаток MPVibe" }), "stockMpvibe"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedAutoExclusionCampaignRow) => formatNumber(row.stockMpvibe),
    },
    {
      key: "shop",
      ...columnWidthProps("shop"),
      header: resizableHeader(autoExclusionsHeader("shop", "Кабинет", { ariaLabel: "Кабинет" }), "shop"),
      headerClassName: "drr-col-shop",
      cellClassName: "drr-col-shop",
      render: (row: RankedAutoExclusionCampaignRow) => row.shopName,
    },
  ], {
    rank: "Расчет",
    name: "XWAY",
    links: "XWAY/WB",
    article: "XWAY",
    campaignId: "XWAY",
    configured: "Расчет",
    ruleDays: "XWAY",
    spend: "XWAY",
    ordersTotal: "XWAY",
    stock: "XWAY",
    stockMpvibe: "MPVibe",
    shop: "XWAY",
  });

  const categoryColumns = withSourceSummaries<RankedCategoryDriverRow>([
    {
      key: "rank",
      ...columnWidthProps("rank"),
      header: resizableHeader("#", "rank"),
      headerClassName: "drr-col-rank",
      cellClassName: "drr-col-rank",
      render: (row: RankedCategoryDriverRow) => formatNumber(row.rank),
    },
    {
      key: "category",
      ...columnWidthProps("category"),
      header: resizableHeader(categoryHeader("category", "Категория", { ariaLabel: "Категория" }), "category"),
      headerClassName: "drr-col-category",
      cellClassName: "drr-col-category",
      render: (row: RankedCategoryDriverRow) => (
        <div className="drr-category-cell">
          <strong title={row.category}>{row.category}</strong>
          <span>{row.shopName}</span>
        </div>
      ),
    },
    {
      key: "skuCount",
      ...columnWidthProps("skuCount"),
      header: resizableHeader(categoryHeader("skuCount", "SKU", { ariaLabel: "SKU" }), "skuCount"),
      headerClassName: "drr-col-sku",
      cellClassName: "drr-col-sku",
      render: (row: RankedCategoryDriverRow) => formatNumber(row.skuCount),
    },
    {
      key: "drrTotal",
      ...columnWidthProps("categoryDrr"),
      header: resizableHeader(categoryHeader("drrTotal", "ДРР общ.", { ariaLabel: "ДРР общий" }), "categoryDrr"),
      headerClassName: "drr-col-small",
      cellClassName: "drr-col-small",
      render: (row: RankedCategoryDriverRow) => formatPercent(row.drrTotal),
    },
    {
      key: "drrAds",
      ...columnWidthProps("categoryDrr"),
      header: resizableHeader(categoryHeader("drrAds", "ДРР РК", { ariaLabel: "ДРР РК" }), "categoryDrr"),
      headerClassName: "drr-col-small",
      cellClassName: "drr-col-small",
      render: (row: RankedCategoryDriverRow) => formatPercent(row.drrAds),
    },
    {
      key: "spend",
      ...columnWidthProps("categoryMoney"),
      header: resizableHeader(categoryHeader("spend", "Расход за период", { ariaLabel: "Расход" }), "categoryMoney"),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedCategoryDriverRow) => formatMoney(row.spend),
    },
    {
      key: "spendShare",
      ...columnWidthProps("categoryShare"),
      header: resizableHeader("%", "categoryShare"),
      headerClassName: "drr-col-share",
      cellClassName: "drr-col-share",
      render: (row: RankedCategoryDriverRow) => formatPercent(row.spendShare),
    },
    {
      key: "revenueTotal",
      ...columnWidthProps("categoryMoney"),
      header: resizableHeader(categoryHeader("revenueTotal", "Выручка всего", { ariaLabel: "Выручка всего" }), "categoryMoney"),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedCategoryDriverRow) => formatMoney(row.revenueTotal),
    },
    {
      key: "revenueTotalShare",
      ...columnWidthProps("categoryShare"),
      header: resizableHeader("%", "categoryShare"),
      headerClassName: "drr-col-share",
      cellClassName: "drr-col-share",
      render: (row: RankedCategoryDriverRow) => formatPercent(row.revenueTotalShare),
    },
    {
      key: "revenueAds",
      ...columnWidthProps("categoryMoney"),
      header: resizableHeader(categoryHeader("revenueAds", "Выручка РК", { ariaLabel: "Выручка РК" }), "categoryMoney"),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedCategoryDriverRow) => formatMoney(row.revenueAds),
    },
    {
      key: "revenueAdsShare",
      ...columnWidthProps("categoryShare"),
      header: resizableHeader("%", "categoryShare"),
      headerClassName: "drr-col-share",
      cellClassName: "drr-col-share",
      render: (row: RankedCategoryDriverRow) => formatPercent(row.revenueAdsShare),
    },
    {
      key: "ordersAds",
      ...columnWidthProps("categoryNumber"),
      header: resizableHeader(categoryHeader("ordersAds", "Заказы РК", { ariaLabel: "Заказы РК" }), "categoryNumber"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedCategoryDriverRow) => formatNumber(row.ordersAds),
    },
    {
      key: "ordersTotal",
      ...columnWidthProps("categoryNumber"),
      header: resizableHeader(categoryHeader("ordersTotal", "Заказы всего", { ariaLabel: "Заказы всего" }), "categoryNumber"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedCategoryDriverRow) => formatNumber(row.ordersTotal),
    },
    {
      key: "stock",
      ...columnWidthProps("stock"),
      header: resizableHeader(categoryHeader("stock", "Остаток XWAY", { ariaLabel: "Остаток XWAY" }), "stock"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedCategoryDriverRow) => formatNumber(row.stock),
    },
    {
      key: "stockMpvibe",
      ...columnWidthProps("stockMpvibe"),
      header: resizableHeader(categoryHeader("stockMpvibe", "Остаток MPVibe", { ariaLabel: "Остаток MPVibe" }), "stockMpvibe"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedCategoryDriverRow) => formatNumber(row.stockMpvibe),
    },
    {
      key: "activeCampaigns",
      ...columnWidthProps("categoryStatus"),
      header: resizableHeader(categoryHeader("activeCampaigns", "Активные РК", { ariaLabel: "Активные РК" }), "categoryStatus"),
      headerClassName: "drr-col-status",
      cellClassName: "drr-col-status",
      render: (row: RankedCategoryDriverRow) => formatNumber(row.activeCampaigns),
    },
    {
      key: "campaigns",
      ...columnWidthProps("categoryNumber"),
      header: resizableHeader(categoryHeader("campaigns", "РК всего", { ariaLabel: "РК всего" }), "categoryNumber"),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedCategoryDriverRow) => formatNumber(row.campaigns),
    },
  ], {
    rank: "Расчет",
    category: "XWAY",
    skuCount: "Расчет",
    drrTotal: "Расчет",
    drrAds: "Расчет",
    spend: "XWAY",
    spendShare: "Расчет",
    revenueTotal: "XWAY",
    revenueTotalShare: "Расчет",
    revenueAds: "XWAY",
    revenueAdsShare: "Расчет",
    ordersAds: "XWAY",
    ordersTotal: "XWAY",
    stock: "XWAY",
    stockMpvibe: "MPVibe",
    activeCampaigns: "XWAY",
    campaigns: "XWAY",
  });

  return (
    <div className="drr-analytics-page space-y-6">
      <PageHero
        compact
        title="Аналитика ДРР"
        metrics={
          <>
            <span className="metric-chip rounded-2xl px-3.5 py-2 text-sm font-medium text-[var(--color-ink)]">{rangeLabel}</span>
            <span className="metric-chip rounded-2xl px-3.5 py-2 text-sm font-medium text-[var(--color-ink)]">{formatNumber(rows.length)} товаров</span>
            {wbLoading ? <span className="metric-chip rounded-2xl px-3.5 py-2 text-sm font-medium text-[var(--color-muted)]">WB загружается</span> : null}
            {mpvibeLoading ? <span className="metric-chip rounded-2xl px-3.5 py-2 text-sm font-medium text-[var(--color-muted)]">MPVibe загружается</span> : null}
            {mpvibeWarning && !mpvibeLoading ? <span className="metric-chip rounded-2xl px-3.5 py-2 text-sm font-medium text-amber-200">MPVibe: частично</span> : null}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to="/pachka-report" className="metric-chip inline-flex items-center justify-center rounded-2xl px-3.5 py-2 text-sm font-medium text-brand-200 transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]">
              Pachka
            </Link>
            <Link to="/catalog" className="metric-chip inline-flex items-center justify-center rounded-2xl px-3.5 py-2 text-sm font-medium text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]">
              Каталог
            </Link>
          </div>
        }
      />

      <Tabs<AnalyticsSection>
        value={section}
        onChange={setSection}
        items={[
          { value: "drr", label: "Аналитика ДРР", count: drrRows.length },
          { value: "stocks", label: "Остатки", count: stockRows.length },
          { value: "limits", label: "Лимиты", count: limitDetailRefs.length },
          { value: "limitActivity", label: "Вылеты лимитов", count: limitActivityRows.length },
          { value: "autoExclusions", label: "Автоисключение", count: autoExclusionRefs.length },
          { value: "categories", label: "Категорийные драйверы", count: categoryRowsCount },
        ]}
      />

      <SectionCard
        title="Параметры"
        caption={
          <>
            Диапазон считается от вчерашнего дня назад: при 3 днях это последние 3 полных дня.
            <br />
            Будет загружено: {formatDateRange(buildStatsRange(days).start, buildStatsRange(days).end)}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void refreshCurrentSection()}
              disabled={!canRefreshCurrentSection || currentSectionRefreshing || anyRefreshLoading}
              className="metric-chip inline-flex h-11 items-center gap-2 rounded-2xl px-4 text-sm font-semibold text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)] disabled:cursor-progress disabled:opacity-70"
            >
              <RefreshCw className={cn("size-4", currentSectionRefreshing && "animate-spin")} />
              Обновить вкладку
            </button>
            <button
              type="button"
              onClick={() => void loadData(true)}
              disabled={anyRefreshLoading}
              className="metric-chip inline-flex h-11 items-center gap-2 rounded-2xl px-4 text-sm font-semibold text-brand-200 transition hover:bg-[var(--color-surface-strong)] disabled:cursor-progress disabled:opacity-70"
            >
              <RefreshCw className={cn("size-4", anyRefreshLoading && "animate-spin")} />
              Обновить все
            </button>
          </div>
        }
      >
        <div className="drr-analytics-controls">
          <label className="drr-analytics-input metric-chip">
            <span>Статистика, дней</span>
            <input
              type="number"
              min={1}
              max={MAX_DAYS}
              value={daysInput}
              onChange={(event) => setDaysInput(event.target.value)}
            />
          </label>
          {section === "drr" || section === "stocks" ? (
            <label className="drr-analytics-input metric-chip">
              <span>Артикулов к выводу</span>
              <input
                type="number"
                min={1}
                max={MAX_LIMIT}
                value={limitInput}
                onChange={(event) => setLimitInput(event.target.value)}
              />
            </label>
          ) : null}
          {section === "stocks" ? (
            <label className="drr-analytics-input metric-chip">
              <span>Ошибка: реклама выкл. при остатке больше</span>
              <input
                type="number"
                min={0}
                max={1000000}
                value={adOffErrorStockThresholdInput}
                onChange={(event) => setAdOffErrorStockThresholdInput(event.target.value)}
              />
            </label>
          ) : null}
          {section === "categories" ? (
            <label className="drr-analytics-input metric-chip">
              <span>Показывать категории с остатком от</span>
              <input
                type="number"
                min={0}
                max={1000000}
                value={categoryMinStockInput}
                onChange={(event) => setCategoryMinStockInput(event.target.value)}
              />
            </label>
          ) : null}
        </div>
        {error ? <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50/70 px-4 py-3 text-sm text-rose-700">{error}</div> : null}
        {mpvibeWarning ? <div className="mt-4 rounded-2xl border border-amber-300/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{mpvibeWarning}</div> : null}
      </SectionCard>

      <div className="grid gap-2.5 md:grid-cols-3">
        <MetricCard label="Расход за период" value={formatMoney(totalSpend)} density="compact" />
        {section === "categories" ? (
          <>
            <MetricCard label="Категорий" value={formatNumber(categoryRowsCount)} hint={`остаток от ${formatNumber(categoryMinStock)}`} density="compact" />
            <MetricCard label="Товаров в срезе" value={formatNumber(rows.length)} density="compact" />
          </>
        ) : section === "limits" ? (
          <>
            <MetricCard label="Без лимита расхода" value={formatNumber(missingSpendLimitCount)} hint="ACTIVE или PAUSED" density="compact" />
            <MetricCard label="Без бюджета / пополн." value={formatNumber(missingBudgetRuleCount)} hint="ACTIVE или PAUSED" density="compact" />
            <MetricCard label="Лимиты заданы" value={formatNumber(configuredLimitCount)} hint={`проверено ${formatNumber(limitRows.length)}`} density="compact" />
          </>
        ) : section === "limitActivity" ? (
          <>
            <MetricCard label="Вылеты 4+ ч" value={formatNumber(limitActivityRows.length)} hint={`проверено ${formatNumber(limitActivityProgress.loaded)} из ${formatNumber(limitActivityProgress.total)}`} density="compact" />
            <MetricCard label="Лимит расходов" value={formatNumber(limitActivityLimitCount)} hint="по логам активности РК" density="compact" />
            <MetricCard label="Нехватка бюджета" value={formatNumber(limitActivityBudgetCount)} hint={limitActivityMaxHours !== null ? `макс. ${formatHours(limitActivityMaxHours)}` : "по логам активности РК"} density="compact" />
          </>
        ) : section === "autoExclusions" ? (
          <>
            <MetricCard label="Без автоисключения" value={formatNumber(autoExclusionIssueRows.length)} hint="CPM, ACTIVE или PAUSED" density="compact" />
            <MetricCard label="Настроено" value={formatNumber(autoExclusionConfiguredRows.length)} hint={`проверено ${formatNumber(autoExclusionRows.length)} РК`} density="compact" />
            <MetricCard label="CPC пропущено" value={formatNumber(autoExclusionSkippedCpcCount)} hint="оплата за клик не проверяется" density="compact" />
          </>
        ) : (
          <>
            <MetricCard label="Топ ДРР" value={formatNumber(topDrrRows.length)} hint={`из лимита ${formatNumber(limit)}`} density="compact" />
            <MetricCard label="Остатки без расхода" value={formatNumber(zeroSpendStockCount)} hint={`остаток > ${formatNumber(STOCK_MIN_VALUE)}`} density="compact" />
          </>
        )}
      </div>

      {section === "drr" ? (
        <SectionCard
          title="Аналитика ДРР"
          caption={`Сначала берется топ-${formatNumber(limit)} по наивысшему ДРР, затем таблица сортируется выбранной колонкой.`}
        >
          {drrRows.length ? (
            <MetricTable
              rows={drrRows}
              columns={drrColumns}
              summaryRow={drrSummaryRow}
              stickyHeader
              headerSummaryPlacement="inline"
              stickyHeaderClassName="drr-analytics-sticky-header"
              getRowKey={(row) => row.ref}
              emptyText="Нет товаров с расходом и ДРР за выбранный период."
            />
          ) : (
            <EmptyState title="Нет данных" text="Нажмите обновить или измените период." />
          )}
        </SectionCard>
      ) : section === "stocks" ? (
        <SectionCard
          title="Остатки"
          caption={`Товары с остатком FBO XWAY или MPVibe больше ${formatNumber(STOCK_MIN_VALUE)} и нулевым рекламным расходом за выбранный период. Красная реклама: выключена при остатке больше ${formatNumber(adOffErrorStockThreshold)}.`}
        >
          {stockRows.length ? (
            <MetricTable
              rows={stockRows}
              columns={stockColumns}
              summaryRow={stockSummaryRow}
              stickyHeader
              headerSummaryPlacement="inline"
              stickyHeaderClassName="drr-analytics-sticky-header"
              getRowKey={(row) => row.ref}
              emptyText="Нет товаров с остатком и нулевым расходом за выбранный период."
            />
          ) : (
            <EmptyState title="Нет данных" text="Нажмите обновить или измените период." />
          )}
        </SectionCard>
      ) : section === "limits" ? (
        <div className="space-y-4">
          <SectionCard
            title="Артикулы без части лимитов"
            caption="РК в статусе ACTIVE или PAUSED, где не найден хотя бы один активный лимит расхода или бюджетное правило с лимитом пополнения. FROZEN не проверяется."
          >
            {limitDetailsLoading ? (
              <div className="mb-4 rounded-2xl border border-sky-300/40 bg-sky-500/10 px-4 py-3 text-sm font-semibold text-sky-100">
                <div>
                  Проверяю лимиты: {formatNumber(limitDetailsProgress.loaded)} / {formatNumber(limitDetailsProgress.total)} товаров с РК ACTIVE или PAUSED
                </div>
                <div className="mt-1 text-xs font-semibold text-sky-100/80">
                  Уже выведено: проблем {formatNumber(limitIssueRows.length)} · настроено {formatNumber(limitConfiguredRows.length)}
                </div>
              </div>
            ) : null}
            {limitDetailsError ? <div className="mb-4 rounded-2xl border border-amber-300/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{limitDetailsError}</div> : null}
            {limitIssueRows.length ? (
              <MetricTable
                rows={limitIssueRows}
                columns={limitColumns}
                stickyHeader
                headerSummaryPlacement="inline"
                stickyHeaderClassName="drr-analytics-sticky-header"
                getRowKey={(row) => row.ref}
                emptyText="Нет РК ACTIVE или PAUSED без настроенных лимитов или пополнений."
              />
            ) : limitDetailsLoading ? (
              <EmptyState
                title="Пока проблем нет"
                text={
                  limitConfiguredRows.length
                    ? "Среди уже проверенных товаров проблемные строки не найдены. Настроенные строки выводятся в таблице ниже."
                    : "Проблемные строки появятся по мере проверки детальных данных XWAY."
                }
              />
            ) : (
              <EmptyState title="Нет проблем" text="Для проверенных РК ACTIVE или PAUSED лимиты расхода и бюджетные правила заданы." />
            )}
          </SectionCard>

          <SectionCard
            title="Артикулы с заданными лимитами"
            caption="РК в статусе ACTIVE или PAUSED, где для каждой проверяемой кампании найден и лимит расхода, и бюджетное правило с лимитом пополнения."
          >
            {limitConfiguredRows.length ? (
              <MetricTable
                rows={limitConfiguredRows}
                columns={limitColumns}
                stickyHeader
                headerSummaryPlacement="inline"
                stickyHeaderClassName="drr-analytics-sticky-header"
                getRowKey={(row) => row.ref}
                emptyText="Нет РК ACTIVE или PAUSED с полностью заданными лимитами."
              />
            ) : limitDetailsLoading ? (
              <EmptyState title="Догружаю лимиты" text="Настроенные строки появятся по мере проверки детальных данных XWAY." />
            ) : (
              <EmptyState title="Нет данных" text="Не найдено РК ACTIVE или PAUSED, где заданы оба типа лимитов." />
            )}
          </SectionCard>
        </div>
      ) : section === "limitActivity" ? (
        <SectionCard
          title="Вылеты лимитов по логам активности"
          caption={`РК в статусе ACTIVE или PAUSED, где за выбранный период статус «лимит расходов» или «нехватка бюджета» держался подряд не меньше ${formatHours(LIMIT_ACTIVITY_THRESHOLD_HOURS)}. FROZEN не проверяется.`}
        >
          {limitActivityLoading ? (
            <div className="mb-4 rounded-2xl border border-sky-300/40 bg-sky-500/10 px-4 py-3 text-sm font-semibold text-sky-100">
              Проверяю логи активности: {formatNumber(limitActivityProgress.loaded)} / {formatNumber(limitActivityProgress.total)} товаров с РК ACTIVE или PAUSED
            </div>
          ) : null}
          {limitActivityError ? <div className="mb-4 rounded-2xl border border-amber-300/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{limitActivityError}</div> : null}
          {limitActivityRows.length ? (
            <MetricTable
              rows={limitActivityRows}
              columns={limitActivityColumns}
              stickyHeader
              headerSummaryPlacement="inline"
              stickyHeaderClassName="drr-analytics-sticky-header"
              getRowKey={(row) => row.ref}
              emptyText="Нет товаров с вылетом лимита расходов или бюджета на 4+ часа."
            />
          ) : limitActivityLoading ? (
            <EmptyState title="Проверяю логи" text="Строки появятся, если в логах найдется непрерывный вылет лимита или бюджета на 4+ часа." />
          ) : (
            <EmptyState title="Нет вылетов" text="По проверенным РК ACTIVE или PAUSED не найдено вылетов лимита расходов или бюджета на 4+ часа." />
          )}
        </SectionCard>
      ) : section === "autoExclusions" ? (
        <div className="space-y-4">
          <SectionCard
            title="РК без автоисключения"
            caption="Проверяются РК в статусе ACTIVE или PAUSED, кроме кампаний с оплатой за клик. FROZEN и CPC не проверяются."
          >
            {autoExclusionsLoading ? (
              <div className="mb-4 rounded-2xl border border-sky-300/40 bg-sky-500/10 px-4 py-3 text-sm font-semibold text-sky-100">
                <div>
                  Проверяю автоисключение: {formatNumber(autoExclusionsProgress.loaded)} / {formatNumber(autoExclusionsProgress.total)} товаров с CPM РК ACTIVE или PAUSED
                </div>
                <div className="mt-1 text-xs font-semibold text-sky-100/80">
                  Уже выведено: без настройки {formatNumber(autoExclusionIssueRows.length)} · настроено {formatNumber(autoExclusionConfiguredRows.length)} · CPC пропущено {formatNumber(autoExclusionSkippedCpcCount)}
                </div>
              </div>
            ) : null}
            {autoExclusionsError ? <div className="mb-4 rounded-2xl border border-amber-300/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{autoExclusionsError}</div> : null}
            {autoExclusionIssueRows.length ? (
              <MetricTable
                rows={autoExclusionIssueRows}
                columns={autoExclusionColumns}
                stickyHeader
                headerSummaryPlacement="inline"
                stickyHeaderClassName="drr-analytics-sticky-header"
                getRowKey={(row) => row.ref}
                emptyText="Нет CPM РК ACTIVE или PAUSED без автоисключения."
              />
            ) : autoExclusionsLoading ? (
              <EmptyState
                title="Пока проблем нет"
                text={
                  autoExclusionConfiguredRows.length
                    ? "Среди уже проверенных РК проблемные строки не найдены. Настроенные строки выводятся в таблице ниже."
                    : "Проблемные строки появятся по мере проверки данных XWAY."
                }
              />
            ) : (
              <EmptyState title="Нет проблем" text="Для проверенных CPM РК ACTIVE или PAUSED автоисключение настроено." />
            )}
          </SectionCard>

          <SectionCard
            title="РК с автоисключением"
            caption="CPM РК в статусе ACTIVE или PAUSED, где включено правило исключения незафиксированных кластеров."
          >
            {autoExclusionConfiguredRows.length ? (
              <MetricTable
                rows={autoExclusionConfiguredRows}
                columns={autoExclusionColumns}
                stickyHeader
                headerSummaryPlacement="inline"
                stickyHeaderClassName="drr-analytics-sticky-header"
                getRowKey={(row) => row.ref}
                emptyText="Нет CPM РК ACTIVE или PAUSED с настроенным автоисключением."
              />
            ) : autoExclusionsLoading ? (
              <EmptyState title="Догружаю автоисключение" text="Настроенные строки появятся по мере проверки данных XWAY." />
            ) : (
              <EmptyState title="Нет данных" text="Не найдено CPM РК ACTIVE или PAUSED с настроенным автоисключением." />
            )}
          </SectionCard>
        </div>
      ) : (
        <div className="space-y-4">
          {allCategoryGroup || categoryShopGroups.length ? (
            <>
              {allCategoryGroup ? (
                <SectionCard
                  title="Все кабинеты"
                  caption={`Суммы и расчетные показатели по всем кабинетам с суммарным остатком от ${formatNumber(categoryMinStock)}: ${formatNumber(allCategoryGroup.rows.length)} категорий, ${formatNumber(allCategoryGroup.rows.reduce((sum, row) => sum + row.skuCount, 0))} SKU.`}
                >
                  <CategoryDriverCharts rows={allCategoryGroup.rows} />
                  <MetricTable
                    rows={allCategoryGroup.rows}
                    columns={categoryColumns}
                    summaryRow={buildCategorySummaryRow(allCategoryGroup.rows)}
                    className="drr-category-driver-table"
                    stickyHeader
                    headerSummaryPlacement="inline"
                    stickyHeaderClassName="drr-analytics-sticky-header drr-category-driver-table"
                    getRowKey={(row) => row.ref}
                    emptyText="Нет категорий по всем кабинетам за выбранный период."
                  />
                </SectionCard>
              ) : null}
              {categoryShopGroups.map((group) => (
              <SectionCard
                key={group.shopId}
                title={group.shopName}
                caption={`Категории кабинета с суммарным остатком от ${formatNumber(categoryMinStock)}: ${formatNumber(group.rows.length)} категорий, ${formatNumber(group.rows.reduce((sum, row) => sum + row.skuCount, 0))} SKU.`}
              >
                <CategoryDriverCharts rows={group.rows} />
                <MetricTable
                  rows={group.rows}
                  columns={categoryColumns}
                  summaryRow={buildCategorySummaryRow(group.rows)}
                  className="drr-category-driver-table"
                  stickyHeader
                  headerSummaryPlacement="inline"
                  stickyHeaderClassName="drr-analytics-sticky-header drr-category-driver-table"
                  getRowKey={(row) => row.ref}
                  emptyText="По кабинету нет категорий за выбранный период."
                />
              </SectionCard>
              ))}
            </>
          ) : (
            <SectionCard title="Категорийные драйверы" caption="Категории появятся после загрузки каталога.">
              <EmptyState title="Нет данных" text="Нажмите обновить или измените период." />
            </SectionCard>
          )}
        </div>
      )}
    </div>
  );
}
