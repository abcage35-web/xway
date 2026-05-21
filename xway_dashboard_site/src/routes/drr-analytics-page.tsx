import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { fetchCatalog, fetchMpvibeStocks, fetchWbCards } from "../lib/api";
import { cn, formatDateRange, formatMoney, formatNumber, formatPercent, getTodayIso, shiftIsoDate, toNumber } from "../lib/format";
import type { CatalogArticle, CatalogResponse, CatalogShop, MpvibeStockInfo, MpvibeStocksResponse, WbCardInfo } from "../lib/types";
import { EmptyState, MetricCard, MetricTable, PageHero, SectionCard, Tabs } from "../components/ui";
import type { TableColumn } from "../components/ui";

type AnalyticsSection = "drr" | "stocks" | "categories";
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
}

interface DrrAnalyticsRow extends AnalyticsRowBase {
  wb?: WbCardInfo | null;
}

type RankedDrrRow = DrrAnalyticsRow & { rank: number };
type RankedStockRow = AnalyticsRowBase & { rank: number };
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

function buildCategoryDriverPieSlices(rows: RankedCategoryDriverRow[], metric: CategoryDriverPieMetric): CategoryDriverPieSlice[] {
  return rows
    .filter((row) => row[metric] > 0)
    .sort((left, right) => right[metric] - left[metric])
    .map((row, index) => ({
      key: `${row.ref}:${metric}`,
      name: row.category,
      value: row[metric],
      color: CATEGORY_DRIVER_CHART_COLORS[index % CATEGORY_DRIVER_CHART_COLORS.length] ?? "#ff8a2d",
      row,
    }));
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

function CategoryDriverPieTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: CategoryDriverPieSlice }>;
}) {
  const slice = payload?.[0]?.payload;
  if (!active || !slice) {
    return null;
  }
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
  return (
    <div className="drr-category-pie">
      <div className="drr-category-pie-head">
        <span>{title}</span>
        <strong>{formatMoney(total)}</strong>
      </div>
      {slices.length ? (
        <div className="drr-category-pie-body">
          <ResponsiveContainer width="100%" height={230}>
            <PieChart margin={{ top: 10, right: 8, bottom: 10, left: 8 }}>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                innerRadius="54%"
                outerRadius="82%"
                paddingAngle={slices.length > 1 ? 1 : 0}
                stroke="rgba(9, 13, 24, 0.92)"
                strokeWidth={2}
              >
                {slices.map((slice) => (
                  <Cell key={slice.key} fill={slice.color} />
                ))}
              </Pie>
              <Tooltip content={<CategoryDriverPieTooltip />} wrapperClassName="drr-category-pie-tooltip-wrap" />
            </PieChart>
          </ResponsiveContainer>
          <div className="drr-category-pie-total" aria-hidden="true">
            <span>{totalLabel}</span>
            <strong>{formatMoney(total)}</strong>
          </div>
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
  const [loading, setLoading] = useState(false);
  const [wbLoading, setWbLoading] = useState(false);
  const [mpvibeLoading, setMpvibeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mpvibeWarning, setMpvibeWarning] = useState<string | null>(null);
  const [loadedRange, setLoadedRange] = useState<{ start: string; end: string; days: number } | null>(null);
  const [drrSort, setDrrSort] = useState<SortState<DrrSortField>>({ field: "spend", direction: "desc" });
  const [stockSort, setStockSort] = useState<SortState<StockSortField>>({ field: "stock", direction: "desc" });
  const [categorySort, setCategorySort] = useState<SortState<CategorySortField>>({ field: "spend", direction: "desc" });
  const [columnWidths, setColumnWidths] = useState<ColumnWidthState>(readStoredColumnWidths);
  const abortRef = useRef<AbortController | null>(null);
  const wbAbortRef = useRef<AbortController | null>(null);
  const mpvibeAbortRef = useRef<AbortController | null>(null);
  const mpvibeForceRefreshRef = useRef(false);
  const mpvibeLoadedRequestRef = useRef<string | null>(null);
  const resizeDragRef = useRef<{ columnKey: ResizableColumnKey; startX: number; startWidth: number } | null>(null);

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
  const categoryShopGroups = useMemo(() => buildCategoryDriverGroups(rows, categorySort, categoryMinStock), [categoryMinStock, categorySort, rows]);
  const categoryRowsCount = categoryShopGroups.reduce((sum, group) => sum + group.rows.length, 0);

  const drrHeader = useSortableHeader<DrrSortField>(drrSort, setDrrSort);
  const stockHeader = useSortableHeader<StockSortField>(stockSort, setStockSort);
  const categoryHeader = useSortableHeader<CategorySortField>(categorySort, setCategorySort);
  const columnWidthProps = (columnKey: ResizableColumnKey) => ({
    width: columnWidths[columnKey],
    minWidth: RESIZABLE_COLUMN_CONFIG[columnKey].min,
    maxWidth: RESIZABLE_COLUMN_CONFIG[columnKey].max,
  });

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

  const loadData = async (forceRefresh = false) => {
    const nextDays = clampInteger(daysInput, DEFAULT_DAYS, 1, MAX_DAYS);
    const nextRange = buildStatsRange(nextDays);
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    mpvibeForceRefreshRef.current = forceRefresh;
    setLoading(true);
    setError(null);
    setMpvibeWarning(null);
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

  useEffect(() => {
    void loadData(false);
    return () => {
      abortRef.current?.abort();
      wbAbortRef.current?.abort();
      mpvibeAbortRef.current?.abort();
    };
    // Initial load should use default form values only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const missingArticles = topDrrRows.map((row) => row.article).filter((article) => !wbByArticle[article]);
    if (!missingArticles.length) {
      return;
    }
    wbAbortRef.current?.abort();
    const abortController = new AbortController();
    wbAbortRef.current = abortController;
    setWbLoading(true);
    fetchWbCards({ articles: missingArticles, signal: abortController.signal })
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
    fetchMpvibeStocks({
      articles: requestedArticles,
      start: loadedRange.start,
      end: loadedRange.end,
      includeAllWithStock: true,
      forceRefresh: mpvibeForceRefreshRef.current,
      signal: abortController.signal,
    })
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
  }, [baseRows, loadedRange]);

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
          <Link to="/catalog" className="metric-chip inline-flex items-center justify-center rounded-2xl px-3.5 py-2 text-sm font-medium text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]">
            Каталог
          </Link>
        }
      />

      <Tabs<AnalyticsSection>
        value={section}
        onChange={setSection}
        items={[
          { value: "drr", label: "Аналитика ДРР", count: drrRows.length },
          { value: "stocks", label: "Остатки", count: stockRows.length },
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
          <button
            type="button"
            onClick={() => void loadData(true)}
            disabled={loading}
            className="metric-chip inline-flex h-11 items-center gap-2 rounded-2xl px-4 text-sm font-semibold text-brand-200 transition hover:bg-[var(--color-surface-strong)] disabled:cursor-progress disabled:opacity-70"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            Обновить
          </button>
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
          {section !== "categories" ? (
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
      ) : (
        <div className="space-y-4">
          {categoryShopGroups.length ? (
            categoryShopGroups.map((group) => (
              <SectionCard
                key={group.shopId}
                title={group.shopName}
                caption={`Категории кабинета с суммарным остатком от ${formatNumber(categoryMinStock)}: ${formatNumber(group.rows.length)} категорий, ${formatNumber(group.rows.reduce((sum, row) => sum + row.skuCount, 0))} SKU.`}
              >
                <CategoryDriverCharts rows={group.rows} />
                <MetricTable
                  rows={group.rows}
                  columns={categoryColumns}
                  className="drr-category-driver-table"
                  stickyHeader
                  headerSummaryPlacement="inline"
                  stickyHeaderClassName="drr-analytics-sticky-header drr-category-driver-table"
                  getRowKey={(row) => row.ref}
                  emptyText="По кабинету нет категорий за выбранный период."
                />
              </SectionCard>
            ))
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
