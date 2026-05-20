import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { fetchCatalog, fetchWbCards } from "../lib/api";
import { cn, formatDateRange, formatMoney, formatNumber, formatPercent, getTodayIso, shiftIsoDate, toNumber } from "../lib/format";
import type { CatalogArticle, CatalogResponse, CatalogShop, WbCardInfo } from "../lib/types";
import { EmptyState, MetricCard, MetricTable, PageHero, SectionCard, Tabs } from "../components/ui";

type AnalyticsSection = "drr" | "stocks";
type SortDirection = "asc" | "desc";
type DrrSortField =
  | "rank"
  | "article"
  | "drr"
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
  | "turnover"
  | "spend"
  | "ordersTotal"
  | "campaigns"
  | "activeCampaigns"
  | "enabled"
  | "shop"
  | "name";

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
  productUrl: string;
  imageUrl: string;
  stock: number | null;
  spend: number | null;
  revenue: number | null;
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
}

interface DrrAnalyticsRow extends AnalyticsRowBase {
  wb?: WbCardInfo | null;
}

type RankedDrrRow = DrrAnalyticsRow & { rank: number };
type RankedStockRow = AnalyticsRowBase & { rank: number };
type SortValue = string | number | boolean | null | undefined;

const DEFAULT_DAYS = 3;
const DEFAULT_LIMIT = 30;
const MAX_DAYS = 30;
const MAX_LIMIT = 200;
const STOCK_MIN_VALUE = 5;
const DEFAULT_AD_OFF_ERROR_STOCK_THRESHOLD = 100;
const AD_OFF_ERROR_STOCK_THRESHOLD_STORAGE_KEY = "xway-drr-analytics-ad-off-error-stock-threshold";

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
        productUrl: article.product_url,
        imageUrl: article.image_url,
        stock,
        spend: toNumber(article.expense_sum),
        revenue: toNumber(article.sum_price),
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
      };
    }),
  );
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
        </span>
      </div>
    </div>
  );
}

function XwayLink({ href }: { href: string }) {
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

export function DrrAnalyticsPage() {
  const [section, setSection] = useState<AnalyticsSection>("drr");
  const [daysInput, setDaysInput] = useState(String(DEFAULT_DAYS));
  const [limitInput, setLimitInput] = useState(String(DEFAULT_LIMIT));
  const [adOffErrorStockThresholdInput, setAdOffErrorStockThresholdInput] = useState(readStoredAdOffThreshold);
  const [payload, setPayload] = useState<CatalogResponse | null>(null);
  const [wbByArticle, setWbByArticle] = useState<Record<string, WbCardInfo>>({});
  const [loading, setLoading] = useState(false);
  const [wbLoading, setWbLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedRange, setLoadedRange] = useState<{ start: string; end: string; days: number } | null>(null);
  const [drrSort, setDrrSort] = useState<SortState<DrrSortField>>({ field: "spend", direction: "desc" });
  const [stockSort, setStockSort] = useState<SortState<StockSortField>>({ field: "stock", direction: "desc" });
  const abortRef = useRef<AbortController | null>(null);
  const wbAbortRef = useRef<AbortController | null>(null);

  const days = clampInteger(daysInput, DEFAULT_DAYS, 1, MAX_DAYS);
  const limit = clampInteger(limitInput, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const adOffErrorStockThreshold = clampInteger(adOffErrorStockThresholdInput, DEFAULT_AD_OFF_ERROR_STOCK_THRESHOLD, 0, 1000000);
  const rows = useMemo(() => flattenCatalogRows(payload, loadedRange?.days ?? days), [days, loadedRange?.days, payload]);

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
      .filter((row) => (row.stock ?? 0) > STOCK_MIN_VALUE && (row.spend ?? 0) === 0);
    const sorted = sortRows<AnalyticsRowBase>(candidates, stockSort, (row, field) => {
      switch (field as StockSortField) {
        case "rank":
          return candidates.indexOf(row) + 1;
        case "article":
          return articleNumber(row.article);
        case "stock":
          return row.stock;
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

  const drrHeader = useSortableHeader<DrrSortField>(drrSort, setDrrSort);
  const stockHeader = useSortableHeader<StockSortField>(stockSort, setStockSort);

  const rangeLabel = loadedRange ? formatDateRange(loadedRange.start, loadedRange.end) : "Период еще не загружен";
  const totalSpend = rows.reduce((sum, row) => sum + (row.spend ?? 0), 0);
  const zeroSpendStockCount = rows.filter((row) => (row.stock ?? 0) > STOCK_MIN_VALUE && (row.spend ?? 0) === 0).length;

  const loadData = async (forceRefresh = false) => {
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
    try {
      window.localStorage.setItem(AD_OFF_ERROR_STOCK_THRESHOLD_STORAGE_KEY, String(adOffErrorStockThreshold));
    } catch {
      // localStorage is an optional UI convenience.
    }
  }, [adOffErrorStockThreshold]);

  const drrColumns = [
    {
      key: "rank",
      header: drrHeader("rank", "#", { ariaLabel: "Номер строки" }),
      headerClassName: "drr-col-rank",
      cellClassName: "drr-col-rank",
      render: (row: RankedDrrRow) => formatNumber(row.rank),
    },
    {
      key: "name",
      header: drrHeader("name", "Товар", { ariaLabel: "Товар" }),
      headerClassName: "drr-col-product",
      cellClassName: "drr-col-product",
      render: (row: RankedDrrRow) => <ProductCell row={row} />,
    },
    {
      key: "links",
      header: "Ссылки",
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
      header: drrHeader("article", "Артикул", { ariaLabel: "Артикул" }),
      headerClassName: "drr-col-article",
      cellClassName: "drr-col-article",
      render: (row: RankedDrrRow) => row.article,
    },
    {
      key: "drr",
      header: drrHeader("drr", "ДРР", { ariaLabel: "ДРР" }),
      headerClassName: "drr-col-small",
      cellClassName: "drr-col-small",
      render: (row: RankedDrrRow) => formatPercent(row.drr),
    },
    {
      key: "spend",
      header: drrHeader("spend", "Расход за период", { ariaLabel: "Расход" }),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedDrrRow) => formatMoney(row.spend),
    },
    {
      key: "revenue",
      header: drrHeader("revenue", "Выручка РК", { ariaLabel: "Выручка РК" }),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedDrrRow) => formatMoney(row.revenue),
    },
    {
      key: "ordersAds",
      header: drrHeader("ordersAds", "Заказы РК", { ariaLabel: "Заказы РК" }),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedDrrRow) => formatNumber(row.ordersAds),
    },
    {
      key: "ordersTotal",
      header: drrHeader("ordersTotal", "Заказы всего", { ariaLabel: "Заказы всего" }),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedDrrRow) => formatNumber(row.ordersTotal),
    },
    {
      key: "reviews",
      header: drrHeader("reviews", "Отзывы WB", { ariaLabel: "Отзывы WB" }),
      headerClassName: "drr-col-reviews",
      cellClassName: "drr-col-reviews",
      render: (row: RankedDrrRow) => formatReviewCell(row.wb),
    },
    {
      key: "bzo",
      header: drrHeader("bzo", "БЗО", { ariaLabel: "БЗО" }),
      headerClassName: "drr-col-bzo",
      cellClassName: "drr-col-bzo",
      render: (row: RankedDrrRow) => formatBzoCell(row.wb),
    },
    {
      key: "price",
      header: drrHeader("price", "Цена с СПП", { ariaLabel: "Цена с СПП" }),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedDrrRow) => formatMoney(row.wb?.price_spp),
    },
    {
      key: "shop",
      header: drrHeader("shop", "Кабинет", { ariaLabel: "Кабинет" }),
      headerClassName: "drr-col-shop",
      cellClassName: "drr-col-shop",
      render: (row: RankedDrrRow) => row.shopName,
    },
  ];

  const stockColumns = [
    {
      key: "rank",
      header: stockHeader("rank", "#", { ariaLabel: "Номер строки" }),
      headerClassName: "drr-col-rank",
      cellClassName: "drr-col-rank",
      render: (row: RankedStockRow) => formatNumber(row.rank),
    },
    {
      key: "name",
      header: stockHeader("name", "Товар", { ariaLabel: "Товар" }),
      headerClassName: "drr-col-product",
      cellClassName: "drr-col-product",
      render: (row: RankedStockRow) => <ProductCell row={row} />,
    },
    {
      key: "links",
      header: "Ссылки",
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
      header: stockHeader("article", "Артикул", { ariaLabel: "Артикул" }),
      headerClassName: "drr-col-article",
      cellClassName: "drr-col-article",
      render: (row: RankedStockRow) => row.article,
    },
    {
      key: "stock",
      header: stockHeader("stock", "Остаток FBO", { ariaLabel: "Остаток FBO" }),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedStockRow) => formatNumber(row.stock),
    },
    {
      key: "turnover",
      header: stockHeader("turnover", "Оборач. по периоду", { ariaLabel: "Оборачиваемость" }),
      headerClassName: "drr-col-turnover",
      cellClassName: "drr-col-turnover",
      render: (row: RankedStockRow) => formatTurnover(row.turnoverDays),
    },
    {
      key: "spend",
      header: stockHeader("spend", "Расход", { ariaLabel: "Расход" }),
      headerClassName: "drr-col-money",
      cellClassName: "drr-col-money",
      render: (row: RankedStockRow) => formatMoney(row.spend),
    },
    {
      key: "ordersTotal",
      header: stockHeader("ordersTotal", "Заказы всего", { ariaLabel: "Заказы всего" }),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedStockRow) => formatNumber(row.ordersTotal),
    },
    {
      key: "activeCampaigns",
      header: stockHeader("activeCampaigns", "Реклама", { ariaLabel: "Активные РК" }),
      headerClassName: "drr-col-status",
      cellClassName: "drr-col-status",
      render: (row: RankedStockRow) => (
        <span
          className={cn(
            "drr-status-chip",
            row.activeCampaigns > 0 ? "is-on" : (row.stock ?? 0) > adOffErrorStockThreshold ? "is-error" : "is-off",
          )}
          title={
            row.activeCampaigns > 0
              ? "Есть активная реклама"
              : (row.stock ?? 0) > adOffErrorStockThreshold
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
      header: stockHeader("campaigns", "РК всего", { ariaLabel: "РК всего" }),
      headerClassName: "drr-col-number",
      cellClassName: "drr-col-number",
      render: (row: RankedStockRow) => formatNumber(row.campaigns),
    },
    {
      key: "enabled",
      header: stockHeader("enabled", "XWAY статус", { ariaLabel: "XWAY статус" }),
      headerClassName: "drr-col-status",
      cellClassName: "drr-col-status",
      render: (row: RankedStockRow) => (
        <span className={cn("drr-status-chip", row.enabled ? "is-on" : "is-off")}>{row.enabled ? "включен" : "отключен"}</span>
      ),
    },
    {
      key: "shop",
      header: stockHeader("shop", "Кабинет", { ariaLabel: "Кабинет" }),
      headerClassName: "drr-col-shop",
      cellClassName: "drr-col-shop",
      render: (row: RankedStockRow) => row.shopName,
    },
  ];

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
          </>
        }
        actions={
          <Link to="/catalog" className="metric-chip inline-flex items-center justify-center rounded-2xl px-3.5 py-2 text-sm font-medium text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]">
            Каталог
          </Link>
        }
      />

      <SectionCard
        title="Параметры"
        caption="Диапазон считается от вчерашнего дня назад: при 3 днях это последние 3 полных дня."
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
          <div className="drr-analytics-hint metric-chip">
            Будет загружено: {formatDateRange(buildStatsRange(days).start, buildStatsRange(days).end)}
          </div>
        </div>
        {error ? <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50/70 px-4 py-3 text-sm text-rose-700">{error}</div> : null}
      </SectionCard>

      <div className="grid gap-2.5 md:grid-cols-3">
        <MetricCard label="Расход за период" value={formatMoney(totalSpend)} density="compact" />
        <MetricCard label="Топ ДРР" value={formatNumber(topDrrRows.length)} hint={`из лимита ${formatNumber(limit)}`} density="compact" />
        <MetricCard label="Остатки без расхода" value={formatNumber(zeroSpendStockCount)} hint={`остаток > ${formatNumber(STOCK_MIN_VALUE)}`} density="compact" />
      </div>

      <Tabs<AnalyticsSection>
        value={section}
        onChange={setSection}
        items={[
          { value: "drr", label: "Аналитика ДРР", count: drrRows.length },
          { value: "stocks", label: "Остатки", count: stockRows.length },
        ]}
      />

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
              getRowKey={(row) => row.ref}
              emptyText="Нет товаров с расходом и ДРР за выбранный период."
            />
          ) : (
            <EmptyState title="Нет данных" text="Нажмите обновить или измените период." />
          )}
        </SectionCard>
      ) : (
        <SectionCard
          title="Остатки"
          caption={`Товары с остатком FBO больше ${formatNumber(STOCK_MIN_VALUE)} и нулевым рекламным расходом за выбранный период. Красная реклама: выключена при остатке больше ${formatNumber(adOffErrorStockThreshold)}.`}
        >
          {stockRows.length ? (
            <MetricTable
              rows={stockRows}
              columns={stockColumns}
              stickyHeader
              getRowKey={(row) => row.ref}
              emptyText="Нет товаров с остатком и нулевым расходом за выбранный период."
            />
          ) : (
            <EmptyState title="Нет данных" text="Нажмите обновить или измените период." />
          )}
        </SectionCard>
      )}
    </div>
  );
}
