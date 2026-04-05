import { useDeferredValue, useEffect, useRef, useState, startTransition } from "react";
import { ExternalLink, FolderOpen, Layers3, MousePointerClick, PackageCheck, Pause, Play, Search as SearchIcon, ShoppingBag, ShoppingCart, Snowflake, ThumbsUp } from "lucide-react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useNavigate } from "react-router";
import { fetchCatalog, fetchCatalogChart, fetchCatalogIssues } from "../lib/api";
import type { CatalogArticleYesterdayIssues } from "../lib/catalog-article-issues";
import { buildPresetRange, cn, formatCompactNumber, formatDate, formatDateRange, formatMoney, formatNumber, formatPercent, getRangePreset, getTodayIso, shiftIsoDate, toNumber } from "../lib/format";
import type { CatalogArticle, CatalogCampaignState, CatalogChartResponse, CatalogResponse, CatalogShop } from "../lib/types";
import { CatalogSelectionChart } from "../components/catalog-selection-chart";
import { SearchableMultiSelect, type SearchableMultiSelectOption } from "../components/searchable-multi-select";
import { InlineMetricSet, MetricCard, MetricTable, PageHero, RangeToolbar, SearchField, SectionCard } from "../components/ui";

interface CatalogLoaderData {
  payload: CatalogResponse;
  comparePayload: CatalogResponse | null;
  turnoverPayload: CatalogResponse | null;
  start?: string | null;
  end?: string | null;
}

type CatalogChartWindow = 7 | 14 | 30 | 60;
type CatalogCampaignSlotKind = "unified" | "manual" | "cpc";
type CatalogCampaignDisplayStatus = "active" | "paused" | "freeze" | "muted";

interface CatalogCampaignSlot {
  key: CatalogCampaignSlotKind;
  headline: string;
  zoneLabel: string;
  zoneKind: "search" | "recom" | "both";
  statusCode: string | null;
  displayStatus: CatalogCampaignDisplayStatus;
}

const CATALOG_CAMPAIGN_SLOT_META: Record<CatalogCampaignSlotKind, { headline: string }> = {
  unified: { headline: "Единая ставка" },
  manual: { headline: "Ручная ставка" },
  cpc: { headline: "Оплата за клики" },
};

function CatalogCampaignColumnsHeader() {
  const headerItems: Array<{ key: CatalogCampaignSlotKind; title: string; subtitle: string }> = [
    { key: "unified", title: "кампания", subtitle: "Единая ставка" },
    { key: "manual", title: "кампания", subtitle: "Ручная ставка" },
    { key: "cpc", title: "кампания", subtitle: "Оплата за клики" },
  ];

  return (
    <div className="catalog-campaign-header-board">
      {headerItems.map((item) => (
        <div key={item.key} className="catalog-campaign-header-item">
          <div className="catalog-campaign-header-title-row">
            <span className={cn("catalog-campaign-kind-badge", `is-${item.key}`)}>{item.key === "cpc" ? "CPC" : "CPM"}</span>
            <strong className="catalog-campaign-header-title">{item.title}</strong>
          </div>
          <span className="catalog-campaign-header-subtitle">{item.subtitle}</span>
        </div>
      ))}
    </div>
  );
}

function resolveCatalogCampaignDisplayStatus(statusCode: string | null | undefined): CatalogCampaignDisplayStatus {
  const normalized = String(statusCode || "").trim().toUpperCase();
  if (normalized === "ACTIVE") {
    return "active";
  }
  if (normalized === "FROZEN") {
    return "freeze";
  }
  if (normalized === "PAUSED") {
    return "paused";
  }
  return "muted";
}

function resolveCatalogCampaignSlotStatus(states: CatalogCampaignState[]): string | null {
  const codes = [...new Set(states.map((state) => String(state.status_code || "").trim().toUpperCase()).filter(Boolean))];
  if (!codes.length) {
    return null;
  }
  if (codes.length === 1) {
    return codes[0]!;
  }
  if (codes.includes("FROZEN")) {
    return "FROZEN";
  }
  if (codes.includes("PAUSED")) {
    return "PAUSED";
  }
  if (codes.includes("ACTIVE")) {
    return "ACTIVE";
  }
  return codes[0] ?? null;
}

function CatalogCampaignStatusGlyph({ status }: { status: CatalogCampaignDisplayStatus }) {
  if (status === "active") {
    return <Play size={14} strokeWidth={2.2} />;
  }
  if (status === "freeze") {
    return <Snowflake size={14} strokeWidth={2.1} />;
  }
  if (status === "paused") {
    return <Pause size={14} strokeWidth={2.2} />;
  }
  return <span className="block h-2.5 w-2.5 rounded-full bg-current" />;
}

function CatalogCampaignStatusIconBadge({
  status,
  label,
}: {
  status: CatalogCampaignDisplayStatus;
  label: string;
}) {
  return (
    <span className={cn("campaign-status-icon-badge catalog-campaign-status", `is-${status}`)} title={label} aria-label={label}>
      <CatalogCampaignStatusGlyph status={status} />
    </span>
  );
}

function CatalogCampaignZonePill({
  label,
  kind,
  iconOnly = false,
}: {
  label: string;
  kind: "search" | "recom" | "both";
  iconOnly?: boolean;
}) {
  if (kind === "both") {
    return (
      <span className={cn("catalog-campaign-zone-pill is-both", iconOnly && "is-icon-only")} title={label} aria-label={label}>
        <SearchIcon className="size-4" strokeWidth={2.05} />
        {iconOnly ? null : <span>Поиск</span>}
        <span className="catalog-campaign-zone-separator">+</span>
        <ThumbsUp className="size-4" strokeWidth={2.05} />
        {iconOnly ? null : <span>Рекомендации</span>}
      </span>
    );
  }

  if (kind === "recom") {
    return (
      <span className={cn("catalog-campaign-zone-pill is-recom", iconOnly && "is-icon-only")} title={label} aria-label={label}>
        <ThumbsUp className="size-4" strokeWidth={2.05} />
        {iconOnly ? null : <span>Рекомендации</span>}
      </span>
    );
  }

  return (
    <span className={cn("catalog-campaign-zone-pill is-search", iconOnly && "is-icon-only")} title={label} aria-label={label}>
      <SearchIcon className="size-4" strokeWidth={2.05} />
      {iconOnly ? null : <span>{label}</span>}
    </span>
  );
}

function buildCatalogCampaignSlots(article: CatalogArticle): CatalogCampaignSlot[] {
  const byKey = new Map(article.campaign_states.map((state) => [state.key, state]));
  const slots: CatalogCampaignSlot[] = [];

  const unifiedState = byKey.get("unified");
  if (unifiedState) {
    const meta = CATALOG_CAMPAIGN_SLOT_META.unified;
    slots.push({
      key: "unified",
      headline: meta.headline,
      zoneLabel: "Поиск + Рекомендации",
      zoneKind: "both",
      statusCode: unifiedState.status_code,
      displayStatus: resolveCatalogCampaignDisplayStatus(unifiedState.status_code),
    });
  }

  const manualStates = [byKey.get("manual_search"), byKey.get("manual_recom")].filter(Boolean) as CatalogCampaignState[];
  if (manualStates.length) {
    const hasSearch = manualStates.some((state) => state.key === "manual_search");
    const hasRecom = manualStates.some((state) => state.key === "manual_recom");
    const meta = CATALOG_CAMPAIGN_SLOT_META.manual;
    slots.push({
      key: "manual",
      headline: meta.headline,
      zoneLabel: hasSearch && hasRecom ? "Поиск + Рекомендации" : hasSearch ? "Поиск" : "Рекомендации",
      zoneKind: hasSearch && hasRecom ? "both" : hasSearch ? "search" : "recom",
      statusCode: resolveCatalogCampaignSlotStatus(manualStates),
      displayStatus: resolveCatalogCampaignDisplayStatus(resolveCatalogCampaignSlotStatus(manualStates)),
    });
  }

  const cpcState = byKey.get("cpc");
  if (cpcState) {
    const meta = CATALOG_CAMPAIGN_SLOT_META.cpc;
    slots.push({
      key: "cpc",
      headline: meta.headline,
      zoneLabel: "Поиск",
      zoneKind: "search",
      statusCode: cpcState.status_code,
      displayStatus: resolveCatalogCampaignDisplayStatus(cpcState.status_code),
    });
  }

  return slots;
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

function buildProductSearch(article: string, start?: string | null, end?: string | null) {
  const params = new URLSearchParams();
  params.set("articles", article);
  if (start) {
    params.set("start", start);
  }
  if (end) {
    params.set("end", end);
  }
  return `?${params.toString()}`;
}

function resolveCatalogChartWindow(spanDays: number | null | undefined): CatalogChartWindow {
  const numeric = Number(spanDays || 0);
  if (numeric <= 7) {
    return 7;
  }
  if (numeric <= 14) {
    return 14;
  }
  if (numeric <= 30) {
    return 30;
  }
  return 60;
}

export async function catalogLoader({ request }: LoaderFunctionArgs): Promise<CatalogLoaderData> {
  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const payload = await fetchCatalog({ request, start, end });
  const compareStart = shiftIsoDate(payload.range.current_start, -payload.range.span_days);
  const compareEnd = shiftIsoDate(payload.range.current_end, -payload.range.span_days);
  let comparePayload: CatalogResponse | null = null;

  try {
    comparePayload = await fetchCatalog({ request, start: compareStart, end: compareEnd });
  } catch {
    comparePayload = null;
  }

  const turnoverEnd = payload.range.current_end;
  const turnoverStart = shiftIsoDate(turnoverEnd, -2);
  let turnoverPayload: CatalogResponse | null = null;

  if (payload.range.current_start === turnoverStart && payload.range.current_end === turnoverEnd) {
    turnoverPayload = payload;
  } else {
    try {
      turnoverPayload = await fetchCatalog({ request, start: turnoverStart, end: turnoverEnd });
    } catch {
      turnoverPayload = null;
    }
  }

  return { payload, comparePayload, turnoverPayload, start, end };
}

function articleMatches(article: CatalogArticle, query: string) {
  if (!query) {
    return true;
  }
  const haystack = [article.article, article.name, article.brand, article.vendor_code, article.category_keyword]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function normalizeCategoryValue(value: string | null | undefined) {
  return String(value || "").trim() || "__empty__";
}

function formatCategoryLabel(value: string | null | undefined) {
  return String(value || "").trim() || "Без категории";
}

function buildShopOptionsFromShops(shops: CatalogShop[]): SearchableMultiSelectOption[] {
  return shops
    .map((shop) => ({
      value: String(shop.id),
      label: shop.name,
      searchText: [shop.marketplace, shop.tariff_code, shop.name].filter(Boolean).join(" "),
    }))
    .sort((left, right) => left.label.localeCompare(right.label, "ru"));
}

function buildShopOptions(payload: CatalogResponse): SearchableMultiSelectOption[] {
  return buildShopOptionsFromShops(payload.shops);
}

function buildCategoryOptions(payload: CatalogResponse): SearchableMultiSelectOption[] {
  const byCategory = new Map<string, SearchableMultiSelectOption>();
  payload.shops.forEach((shop) => {
    shop.articles.forEach((article) => {
      const value = normalizeCategoryValue(article.category_keyword);
      if (!byCategory.has(value)) {
        byCategory.set(value, {
          value,
          label: formatCategoryLabel(article.category_keyword),
          searchText: [article.category_keyword, article.name, article.brand, shop.name].filter(Boolean).join(" "),
        });
      }
    });
  });
  return [...byCategory.values()].sort((left, right) => left.label.localeCompare(right.label, "ru"));
}

function buildSkuOptions(payload: CatalogResponse): SearchableMultiSelectOption[] {
  const bySku = new Map<string, SearchableMultiSelectOption>();
  payload.shops.forEach((shop) => {
    shop.articles.forEach((article) => {
      if (bySku.has(article.article)) {
        return;
      }
      bySku.set(article.article, {
        value: article.article,
        label: `${article.article} · ${article.name || "Без названия"}`,
        searchText: [article.article, article.name, article.brand, article.vendor_code, article.category_keyword, shop.name].filter(Boolean).join(" "),
      });
    });
  });
  return [...bySku.values()].sort((left, right) => left.label.localeCompare(right.label, "ru"));
}

function formatProductsWord(count: number) {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs >= 11 && abs <= 19) {
    return "товаров";
  }
  if (last === 1) {
    return "товар";
  }
  if (last >= 2 && last <= 4) {
    return "товара";
  }
  return "товаров";
}

function summarizeCatalogArticles(articles: CatalogArticle[]) {
  return articles.reduce(
    (totals, article) => {
      totals.views += toNumber(article.views) ?? 0;
      totals.clicks += toNumber(article.clicks) ?? 0;
      totals.orders += toNumber(article.orders) ?? 0;
      totals.expense_sum += toNumber(article.expense_sum) ?? 0;
      return totals;
    },
    {
      views: 0,
      clicks: 0,
      orders: 0,
      expense_sum: 0,
    },
  );
}

function computeTurnoverDays(stock: number | string | null | undefined, orderedReport3d: number | string | null | undefined, windowDays = 3) {
  const stockValue = toNumber(stock);
  if (stockValue === null || stockValue <= 0) {
    return null;
  }
  const orderedValue = toNumber(orderedReport3d);
  if (orderedValue === null) {
    return null;
  }
  if (orderedValue <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return stockValue / (orderedValue / windowDays);
}

function formatTurnoverDays(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "—";
  }
  if (!Number.isFinite(value)) {
    return "∞";
  }
  return `${formatNumber(value, value >= 10 ? 0 : 1)} дн`;
}

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function formatIssueIncidents(count: number) {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs >= 11 && abs <= 19) {
    return `${count} остановок`;
  }
  if (last === 1) {
    return `${count} остановка`;
  }
  if (last >= 2 && last <= 4) {
    return `${count} остановки`;
  }
  return `${count} остановок`;
}

function getArticleIssueHoursTotal(item: CatalogArticleYesterdayIssues) {
  return item.issues.reduce((sum, issue) => sum + issue.hours, 0);
}

function getArticleIssueIncidentsTotal(item: CatalogArticleYesterdayIssues) {
  return item.issues.reduce((sum, issue) => sum + issue.incidents, 0);
}

function mapCatalogIssueRows(
  rows: Array<{ product_ref: string; issues: CatalogArticleYesterdayIssues["issues"] }>,
  metaByRef: Map<string, { article: string; name: string; productUrl: string; stock: number | string | null | undefined }>,
) {
  return rows
    .map((row) => {
      const meta = metaByRef.get(row.product_ref);
      if (!meta || !row.issues.length) {
        return null;
      }
      return {
        article: meta.article,
        name: meta.name,
        productUrl: meta.productUrl,
        issues: row.issues,
      };
    })
    .filter((item): item is CatalogArticleYesterdayIssues => Boolean(item))
    .sort((left, right) => {
      const hoursDiff = getArticleIssueHoursTotal(right) - getArticleIssueHoursTotal(left);
      if (hoursDiff !== 0) {
        return hoursDiff;
      }
      const incidentsDiff = getArticleIssueIncidentsTotal(right) - getArticleIssueIncidentsTotal(left);
      if (incidentsDiff !== 0) {
        return incidentsDiff;
      }
      return left.article.localeCompare(right.article, "ru");
    });
}

async function readApiErrorMessage(error: unknown) {
  if (error instanceof Response) {
    const text = await error.text();
    if (!text) {
      return `Ошибка API (${error.status})`;
    }
    try {
      const parsed = JSON.parse(text) as { error?: string };
      return parsed.error || text;
    } catch {
      return text;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Не удалось собрать ошибки по артикулам.";
}

async function isWorkerSubrequestLimitError(error: unknown) {
  const message = await readApiErrorMessage(error);
  return /too many subrequests/i.test(message);
}

function filterShops(
  payload: CatalogResponse,
  filters: {
    query: string;
    selectedShopIds: string[];
    selectedCategories: string[];
    selectedSkus: string[];
  },
) {
  return payload.shops
    .map((shop) => {
      if (filters.selectedShopIds.length && !filters.selectedShopIds.includes(String(shop.id))) {
        return null;
      }

      const baseArticles = shop.articles.filter((article) => {
        if (filters.selectedCategories.length && !filters.selectedCategories.includes(normalizeCategoryValue(article.category_keyword))) {
          return false;
        }
        if (filters.selectedSkus.length && !filters.selectedSkus.includes(article.article)) {
          return false;
        }
        return true;
      });

      if (!baseArticles.length) {
        return null;
      }

      const shopMatches = shop.name.toLowerCase().includes(filters.query);
      const articles = filters.query
        ? (shopMatches ? baseArticles : baseArticles.filter((article) => articleMatches(article, filters.query)))
        : baseArticles;

      if (!articles.length) {
        return null;
      }

      return {
        ...shop,
        articles,
      };
    })
    .filter(Boolean) as CatalogShop[];
}

export function CatalogPage() {
  const { payload, comparePayload, turnoverPayload, start, end } = useLoaderData() as CatalogLoaderData;
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selectedShopIds, setSelectedShopIds] = useState<string[]>([]);
  const [selectedIssueShopIds, setSelectedIssueShopIds] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedSkus, setSelectedSkus] = useState<string[]>([]);
  const [chartCollapsed, setChartCollapsed] = useState(false);
  const [chartWindow, setChartWindow] = useState<CatalogChartWindow>(() => resolveCatalogChartWindow(payload.range.span_days));
  const [chartData, setChartData] = useState<CatalogChartResponse | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [articleIssuesLoading, setArticleIssuesLoading] = useState(false);
  const [articleIssuesError, setArticleIssuesError] = useState<string | null>(null);
  const [articleIssueRows, setArticleIssueRows] = useState<CatalogArticleYesterdayIssues[] | null>(null);
  const [articleIssuesCompletedCount, setArticleIssuesCompletedCount] = useState(0);
  const [articleIssuesTotalCount, setArticleIssuesTotalCount] = useState(0);
  const [collapsedShopIds, setCollapsedShopIds] = useState<string[]>([]);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const chartFetchAbortRef = useRef<AbortController | null>(null);
  const articleIssuesAbortRef = useRef<AbortController | null>(null);

  const shopOptions = buildShopOptions(payload);
  const categoryOptions = buildCategoryOptions(payload);
  const skuOptions = buildSkuOptions(payload);
  const visibleShops = filterShops(payload, {
    query: deferredQuery,
    selectedShopIds,
    selectedCategories,
    selectedSkus,
  });
  const issueShopOptions = buildShopOptionsFromShops(visibleShops);
  const issueShopOptionKey = issueShopOptions.map((option) => option.value).join(",");
  const issueScopedShops = visibleShops.filter(
    (shop) => !selectedIssueShopIds.length || selectedIssueShopIds.includes(String(shop.id)),
  );
  const turnoverOrdersByRef = new Map(
    (turnoverPayload?.shops || []).flatMap((shop) =>
      shop.articles.map((article) => [`${shop.id}:${article.product_id}`, article.ordered_report] as const),
    ),
  );
  const visibleIssueTargets = [...new Map(
    issueScopedShops.flatMap((shop) =>
      shop.articles.map((article) => [
        `${shop.id}:${article.product_id}`,
        {
          ref: `${shop.id}:${article.product_id}`,
          article: article.article,
          name: article.name || `Артикул ${article.article}`,
          productUrl: article.product_url,
          stock: article.stock,
        },
      ]),
    ),
  ).values()].filter((item) => (toNumber(item.stock) ?? 0) > 0);
  const visibleArticleCodes = [...new Set(visibleShops.flatMap((shop) => shop.articles.map((article) => article.article)))].sort((left, right) => left.localeCompare(right, "ru"));
  const visibleIssueTargetRefs = visibleIssueTargets.map((item) => item.ref);
  const visibleIssueTargetMetaByRef = new Map(visibleIssueTargets.map((item) => [item.ref, item]));
  const visibleArticles = visibleShops.flatMap((shop) =>
    shop.articles.map((article) => ({
      shopId: shop.id,
      productId: article.product_id,
    })),
  );
  const visibleIssueTargetRefsKey = visibleIssueTargetRefs.join(",");
  const chartSelectionCount = visibleArticles.length;
  const chartProductRefs = visibleArticles.map((item) => `${item.shopId}:${item.productId}`);
  const chartProductRefsKey = chartProductRefs.join(",");
  const chartRangeEnd = payload.range.current_end;
  const chartRangeStart = shiftIsoDate(chartRangeEnd, -(chartWindow - 1));
  const chartRangeLabel = formatDateRange(chartRangeStart, chartRangeEnd);
  const yesterdayIso = shiftIsoDate(getTodayIso(), -1);
  const yesterdayLabel = formatDate(yesterdayIso);
  const preset = getRangePreset(start, end);
  const catalogSearch = buildCatalogSearch(start, end);
  const issueScopeShopCount = issueScopedShops.length;

  const handleRangeChange = (next: { start: string; end: string }) => {
    navigate(`/catalog${buildCatalogSearch(next.start, next.end)}`);
  };

  const handlePresetChange = (nextPreset: string) => {
    if (nextPreset === "custom") {
      return;
    }
    const nextRange = buildPresetRange(nextPreset);
    navigate(`/catalog${buildCatalogSearch(nextRange.start, nextRange.end)}`);
  };

  const toggleShop = (shopId: number) => {
    setCollapsedShopIds((current) =>
      current.includes(String(shopId)) ? current.filter((item) => item !== String(shopId)) : [...current, String(shopId)],
    );
  };

  useEffect(() => {
    const node = toolbarRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }

    const syncHeight = () => {
      const nextHeight = Math.max(Math.round(node.getBoundingClientRect().height) - 1, 0);
      setToolbarHeight(nextHeight);
    };

    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      chartFetchAbortRef.current?.abort();
      articleIssuesAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const allowedValues = new Set(issueShopOptions.map((option) => option.value));
    setSelectedIssueShopIds((current) => {
      const next = current.filter((value) => allowedValues.has(value));
      return next.length === current.length ? current : next;
    });
  }, [issueShopOptionKey]);

  useEffect(() => {
    articleIssuesAbortRef.current?.abort();
    setArticleIssuesLoading(false);
    setArticleIssuesError(null);
    setArticleIssueRows(null);
    setArticleIssuesCompletedCount(0);
    setArticleIssuesTotalCount(0);
  }, [visibleIssueTargetRefsKey]);

  useEffect(() => {
    chartFetchAbortRef.current?.abort();
    if (chartCollapsed) {
      setChartLoading(false);
      setChartError(null);
      return;
    }
    if (!chartSelectionCount) {
      setChartLoading(false);
      setChartError(null);
      setChartData(null);
      return;
    }

    const controller = new AbortController();
    chartFetchAbortRef.current = controller;
    const timer = window.setTimeout(() => {
      setChartLoading(true);
      setChartError(null);
      setChartData(null);
      fetchCatalogChart({
        productRefs: chartProductRefs,
        start: chartRangeStart,
        end: chartRangeEnd,
        signal: controller.signal,
      })
        .then((response) => {
          if (controller.signal.aborted) {
            return;
          }
          setChartData(response);
        })
        .catch((error) => {
          if (controller.signal.aborted) {
            return;
          }
          setChartError(error instanceof Error ? error.message : "Не удалось загрузить агрегированный график.");
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setChartLoading(false);
          }
        });
    }, 260);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [chartCollapsed, chartProductRefsKey, chartSelectionCount, chartRangeEnd, chartRangeStart]);

  const ctr = payload.totals.views > 0 ? (payload.totals.clicks / payload.totals.views) * 100 : 0;
  const cr = payload.totals.clicks > 0 ? (payload.totals.orders / payload.totals.clicks) * 100 : 0;
  const compareCtr = comparePayload && comparePayload.totals.views > 0 ? (comparePayload.totals.clicks / comparePayload.totals.views) * 100 : null;
  const compareCr = comparePayload && comparePayload.totals.clicks > 0 ? (comparePayload.totals.orders / comparePayload.totals.clicks) * 100 : null;
  const diffValue = (current: number | string | null | undefined, previous: number | string | null | undefined) => {
    const currentValue = toNumber(current);
    const previousValue = toNumber(previous);
    if (currentValue === null || previousValue === null) {
      return null;
    }
    return currentValue - previousValue;
  };
  const deltaClassName = (value: number | null | undefined, positiveIsGood = true) => {
    const numeric = toNumber(value);
    if (numeric === null || numeric === 0) {
      return "text-slate-500";
    }
    const isGood = positiveIsGood ? numeric > 0 : numeric < 0;
    return isGood ? "text-emerald-600" : "text-rose-600";
  };
  const formatSignedNumber = (value: number | null | undefined) => {
    const numeric = toNumber(value);
    if (numeric === null) {
      return null;
    }
    return `${numeric > 0 ? "+" : ""}${formatNumber(numeric, 1)}`;
  };
  const formatSignedMoney = (value: number | null | undefined) => {
    const numeric = toNumber(value);
    if (numeric === null) {
      return null;
    }
    return `${numeric > 0 ? "+" : ""}${formatMoney(numeric, true)}`;
  };
  const formatSignedPercent = (value: number | null | undefined) => {
    const numeric = toNumber(value);
    if (numeric === null) {
      return null;
    }
    return `${numeric > 0 ? "+" : ""}${formatPercent(numeric)}`;
  };
  const renderDeltaText = (value: string | null) => (value ? `${value} к прошлому периоду` : undefined);
  const clearLocalFilters = () => {
    setQuery("");
    setSelectedShopIds([]);
    setSelectedIssueShopIds([]);
    setSelectedCategories([]);
    setSelectedSkus([]);
  };

  const collectArticleIssues = async () => {
    articleIssuesAbortRef.current?.abort();
    if (!visibleIssueTargetRefs.length) {
      setArticleIssueRows([]);
      setArticleIssuesError(null);
      setArticleIssuesLoading(false);
      setArticleIssuesCompletedCount(0);
      setArticleIssuesTotalCount(0);
      return;
    }

    const controller = new AbortController();
    articleIssuesAbortRef.current = controller;
    setArticleIssuesLoading(true);
    setArticleIssuesError(null);
    setArticleIssueRows([]);
    setArticleIssuesCompletedCount(0);
    setArticleIssuesTotalCount(visibleIssueTargetRefs.length);

    try {
      const issueRowsByRef = new Map<string, { product_ref: string; issues: CatalogArticleYesterdayIssues["issues"] }>();
      const partialErrorMessages = new Set<string>();
      let completedCount = 0;

      const fetchIssueRowsChunk = async (refs: string[]): Promise<Array<{ product_ref: string; issues: CatalogArticleYesterdayIssues["issues"] }>> => {
        const response = await fetchCatalogIssues({
          productRefs: refs,
          start: yesterdayIso,
          end: yesterdayIso,
          signal: controller.signal,
        });
        return response.rows.map((row) => ({
          product_ref: row.product_ref,
          issues: row.issues.map((issue) => ({
            kind: issue.kind,
            title: issue.title,
            hours: issue.hours,
            incidents: issue.incidents,
            estimatedGap: issue.estimated_gap,
            campaignIds: issue.campaign_ids,
            campaignLabels: issue.campaign_labels,
          })),
        }));
      };

      const fetchIssueRowsAdaptive = async (refs: string[]): Promise<Array<{ product_ref: string; issues: CatalogArticleYesterdayIssues["issues"] }>> => {
        try {
          return await fetchIssueRowsChunk(refs);
        } catch (error) {
          if (refs.length > 1 && (await isWorkerSubrequestLimitError(error))) {
            const middle = Math.ceil(refs.length / 2);
            const left = await fetchIssueRowsAdaptive(refs.slice(0, middle));
            const right = await fetchIssueRowsAdaptive(refs.slice(middle));
            return [...left, ...right];
          }
          if (!controller.signal.aborted) {
            partialErrorMessages.add(await readApiErrorMessage(error));
          }
          return [];
        }
      };

      const chunks = chunkItems(visibleIssueTargetRefs, 20);
      for (const chunk of chunks) {
        const rows = await fetchIssueRowsAdaptive(chunk);
        if (controller.signal.aborted) {
          return;
        }
        rows.forEach((row) => issueRowsByRef.set(row.product_ref, row));
        completedCount += chunk.length;
        setArticleIssuesCompletedCount(completedCount);
        setArticleIssueRows(mapCatalogIssueRows([...issueRowsByRef.values()], visibleIssueTargetMetaByRef));
      }

      const nextRows = mapCatalogIssueRows([...issueRowsByRef.values()], visibleIssueTargetMetaByRef);
      setArticleIssueRows(nextRows);
      if (partialErrorMessages.size) {
        const [firstMessage] = [...partialErrorMessages];
        setArticleIssuesError(
          nextRows.length
            ? `Часть артикулов не загрузилась. Уже показаны найденные ошибки. ${firstMessage}`
            : firstMessage || "Не удалось собрать ошибки по артикулам.",
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setArticleIssuesError(await readApiErrorMessage(error));
    } finally {
      if (!controller.signal.aborted) {
        setArticleIssuesLoading(false);
      }
    }
  };

  return (
    <div className="space-y-6">
      <PageHero
        title="Каталог артикулов"
        subtitle={
          <>
            <p>
              Сводка по всем магазинам и товарам за <span className="font-medium text-[var(--color-ink)]">{formatDateRange(start, end)}</span>.
            </p>
            <p className="mt-2">
              В каталоге сейчас {formatNumber(payload.total_articles)} артикулов из {formatNumber(payload.total_shops)} магазинов.
            </p>
          </>
        }
        metrics={
          <>
            <span className="metric-chip rounded-2xl px-4 py-2 text-sm text-[var(--color-ink)]">{formatNumber(payload.total_shops)} магазинов</span>
            <span className="metric-chip rounded-2xl px-4 py-2 text-sm text-[var(--color-ink)]">{formatNumber(payload.total_articles)} артикулов</span>
          </>
        }
      />

      <div ref={toolbarRef} className="catalog-range-toolbar-sticky">
        <RangeToolbar
          start={start}
          end={end}
          preset={preset}
          onPresetChange={handlePresetChange}
          onRangeChange={handleRangeChange}
        />
      </div>

      <SectionCard
        title="График каталога"
        caption={`Отображение за ${chartWindow} дн. · ${chartRangeLabel}. Отдельная шкала рассчитывается для каждого показателя, поэтому сильные расхождения по абсолютным значениям не сжимают остальные линии.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="chart-window-switch" aria-label="Период графика каталога">
              {[7, 14, 30, 60].map((windowValue) => (
                <button
                  key={windowValue}
                  type="button"
                  onClick={() => setChartWindow(windowValue as CatalogChartWindow)}
                  className={chartWindow === windowValue ? "chart-window-chip is-active" : "chart-window-chip"}
                >
                  {windowValue}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setChartCollapsed((current) => !current)}
              className="metric-chip rounded-2xl px-4 py-2 text-sm text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
            >
              {chartCollapsed ? "Показать график" : "Скрыть график"}
            </button>
          </div>
        }
      >
        <div className="mb-5 grid w-full gap-3 xl:grid-cols-[minmax(260px,1.35fr)_repeat(3,minmax(220px,1fr))]">
          <div className="min-w-0">
            <SearchField value={query} onChange={(value) => startTransition(() => setQuery(value))} placeholder="Фильтр по артикулу, названию, бренду, категории" />
          </div>
          <SearchableMultiSelect
            label="Кабинет"
            allLabel="Все кабинеты"
            options={shopOptions}
            selectedValues={selectedShopIds}
            onChange={setSelectedShopIds}
            emptyText="Кабинеты не найдены"
          />
          <SearchableMultiSelect
            label="Категория"
            allLabel="Все категории"
            options={categoryOptions}
            selectedValues={selectedCategories}
            onChange={setSelectedCategories}
            emptyText="Категории не найдены"
          />
          <SearchableMultiSelect
            label="SKU"
            allLabel="Все SKU"
            options={skuOptions}
            selectedValues={selectedSkus}
            onChange={setSelectedSkus}
            emptyText="SKU не найдены"
          />
        </div>

        {!chartCollapsed ? (
          <CatalogSelectionChart
            rows={chartData?.rows ?? []}
            totals={chartData?.totals ?? null}
            selectionCount={chartSelectionCount}
            loadedProductsCount={chartData?.loaded_products_count ?? null}
            isLoading={chartLoading}
            error={chartError}
            rangeLabel={chartRangeLabel}
            windowDays={chartWindow}
          />
        ) : (
          <div className="text-sm text-[var(--color-muted)]">
            График скрыт. В текущую выборку попало {formatNumber(chartSelectionCount)} {formatProductsWord(chartSelectionCount)}. При открытии он загрузится отдельно за последние {chartWindow} дн.
          </div>
        )}
      </SectionCard>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
        <MetricCard
          label="Расход"
          value={formatMoney(payload.totals.expense_sum)}
          icon={<Layers3 className="size-5" />}
          deltaText={renderDeltaText(formatSignedMoney(diffValue(payload.totals.expense_sum, comparePayload?.totals.expense_sum)))}
          deltaClassName={deltaClassName(diffValue(payload.totals.expense_sum, comparePayload?.totals.expense_sum), false)}
        />
        <MetricCard
          label="Показы"
          value={formatCompactNumber(payload.totals.views)}
          icon={<ShoppingBag className="size-5" />}
          deltaText={renderDeltaText(formatSignedNumber(diffValue(payload.totals.views, comparePayload?.totals.views)))}
          deltaClassName={deltaClassName(diffValue(payload.totals.views, comparePayload?.totals.views), true)}
        />
        <MetricCard
          label="Клики"
          value={formatCompactNumber(payload.totals.clicks)}
          icon={<MousePointerClick className="size-5" />}
          deltaText={renderDeltaText(formatSignedNumber(diffValue(payload.totals.clicks, comparePayload?.totals.clicks)))}
          deltaClassName={deltaClassName(diffValue(payload.totals.clicks, comparePayload?.totals.clicks), true)}
        />
        <MetricCard
          label="Корзины"
          value={formatCompactNumber(payload.totals.atbs)}
          icon={<ShoppingCart className="size-5" />}
          deltaText={renderDeltaText(formatSignedNumber(diffValue(payload.totals.atbs, comparePayload?.totals.atbs)))}
          deltaClassName={deltaClassName(diffValue(payload.totals.atbs, comparePayload?.totals.atbs), true)}
        />
        <MetricCard
          label="Заказы"
          value={formatNumber(payload.totals.orders)}
          icon={<PackageCheck className="size-5" />}
          deltaText={renderDeltaText(formatSignedNumber(diffValue(payload.totals.orders, comparePayload?.totals.orders)))}
          deltaClassName={deltaClassName(diffValue(payload.totals.orders, comparePayload?.totals.orders), true)}
        />
        <MetricCard
          label="CTR каталога"
          value={formatPercent(ctr)}
          icon={<FolderOpen className="size-5" />}
          deltaText={renderDeltaText(formatSignedPercent(diffValue(ctr, compareCtr)))}
          deltaClassName={deltaClassName(diffValue(ctr, compareCtr), true)}
        />
        <MetricCard
          label="CR каталога"
          value={formatPercent(cr)}
          icon={<ExternalLink className="size-5" />}
          deltaText={renderDeltaText(formatSignedPercent(diffValue(cr, compareCr)))}
          deltaClassName={deltaClassName(diffValue(cr, compareCr), true)}
        />
      </div>

      <SectionCard
        title="Ошибки по артикулам"
        caption={`Сбор бюджетных и лимитных остановок только по видимым артикулам с остатком > 0 за вчера, ${yesterdayLabel}. По кнопке запрашиваются детальные кампании так же, как в ошибках внутри товара по всем РК.`}
        actions={
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
            <SearchableMultiSelect
              label="Кабинеты для сбора"
              allLabel="Все кабинеты"
              options={issueShopOptions}
              selectedValues={selectedIssueShopIds}
              onChange={setSelectedIssueShopIds}
              emptyText="Кабинеты в текущей выборке не найдены"
              className="min-w-[280px]"
            />
            <button
              type="button"
              onClick={collectArticleIssues}
              disabled={articleIssuesLoading || !visibleIssueTargetRefs.length}
              className={cn(
                "metric-chip rounded-2xl px-4 py-2 text-sm transition",
                articleIssuesLoading || !visibleIssueTargetRefs.length
                  ? "cursor-not-allowed text-[var(--color-muted)] opacity-70"
                  : "text-[var(--color-ink)] hover:bg-[var(--color-surface-strong)]",
              )}
            >
              {articleIssuesLoading ? "Собираем ошибки..." : "Собрать ошибки за вчера"}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-muted)]">
            <span className="metric-chip rounded-2xl px-3 py-2">{formatNumber(visibleArticleCodes.length)} артикулов в текущей выборке</span>
            <span className="metric-chip rounded-2xl px-3 py-2">{formatNumber(issueScopeShopCount)} кабинетов для сбора</span>
            <span className="metric-chip rounded-2xl px-3 py-2">{formatNumber(visibleIssueTargetRefs.length)} с остатком &gt; 0</span>
            {articleIssuesTotalCount ? (
              <span className="metric-chip rounded-2xl px-3 py-2">
                Обработано {formatNumber(articleIssuesCompletedCount)} / {formatNumber(articleIssuesTotalCount)}
              </span>
            ) : null}
            {articleIssueRows ? (
              <span className="metric-chip rounded-2xl px-3 py-2">
                {formatNumber(articleIssueRows.length)} с ошибками за {yesterdayLabel}
              </span>
            ) : null}
          </div>

          {articleIssuesError ? (
            <div className="rounded-[22px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {articleIssuesError}
            </div>
          ) : null}

          {articleIssuesLoading ? (
            <div className="rounded-[22px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-4 text-sm text-[var(--color-muted)]">
              {articleIssueRows?.length
                ? `Обработано ${formatNumber(articleIssuesCompletedCount)} из ${formatNumber(articleIssuesTotalCount)} артикулов. Уже показаны найденные ошибки.`
                : `Загружаю вчерашние ошибки по ${formatNumber(visibleIssueTargetRefs.length)} артикулам с остатком > 0.`}
            </div>
          ) : null}

          {!articleIssuesLoading && !articleIssuesError && articleIssueRows && !articleIssueRows.length ? (
            <div className="rounded-[22px] border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-700">
              За {yesterdayLabel} по текущей выборке не найдено ошибок бюджета и лимитов.
            </div>
          ) : null}

          {articleIssueRows?.length ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {articleIssueRows.map((item) => (
                <article key={item.article} className="rounded-[24px] border border-[var(--color-line)] bg-white/90 p-4 shadow-[0_12px_30px_rgba(44,35,66,0.06)]">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          to={`/product${buildProductSearch(item.article, yesterdayIso, yesterdayIso)}`}
                          className="font-display text-lg font-semibold text-[var(--color-ink)] hover:text-brand-200"
                        >
                          Артикул {item.article}
                        </Link>
                        <span className="metric-chip rounded-2xl px-3 py-1.5 text-xs text-[var(--color-muted)]">
                          {formatNumber(getArticleIssueHoursTotal(item), 1)} ч простоя
                        </span>
                        <span className="metric-chip rounded-2xl px-3 py-1.5 text-xs text-[var(--color-muted)]">
                          {formatIssueIncidents(getArticleIssueIncidentsTotal(item))}
                        </span>
                      </div>
                      <p className="truncate text-sm text-[var(--color-muted)]" title={item.name}>
                        {item.name}
                      </p>
                    </div>
                    <a
                      href={item.productUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-2xl border border-[var(--color-line)] px-3 py-2 text-sm text-brand-200 transition hover:bg-[var(--color-surface-soft)]"
                    >
                      XWAY
                      <ExternalLink className="size-3.5" />
                    </a>
                  </div>

                  <div className="mt-4 space-y-3">
                    {item.issues.map((issue) => (
                      <div
                        key={`${item.article}-${issue.kind}`}
                        className={cn(
                          "rounded-[20px] border px-4 py-3",
                          issue.kind === "budget" ? "border-rose-200 bg-rose-50/70" : "border-amber-200 bg-amber-50/70",
                        )}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-medium text-[var(--color-ink)]">{issue.title}</p>
                          <span
                            className={cn(
                              "rounded-full px-2.5 py-1 text-xs font-medium",
                              issue.kind === "budget" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700",
                            )}
                          >
                            {formatIssueIncidents(issue.incidents)}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-sm text-[var(--color-muted)]">
                          <span className="metric-chip rounded-2xl px-3 py-2">{formatNumber(issue.hours, 1)} ч</span>
                          {issue.estimatedGap !== null ? <span className="metric-chip rounded-2xl px-3 py-2">≈ {formatMoney(issue.estimatedGap)}</span> : null}
                          <span className="metric-chip rounded-2xl px-3 py-2">{formatNumber(issue.campaignIds.length)} РК</span>
                        </div>
                        {issue.campaignLabels.length ? (
                          <p className="mt-3 text-xs leading-5 text-[var(--color-muted)]">
                            {issue.campaignLabels.join(", ")}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      </SectionCard>

      <div className="space-y-5">
        {visibleShops.map((shop) => {
          const collapsed = collapsedShopIds.includes(String(shop.id));
          const totals = summarizeCatalogArticles(shop.articles);

          return (
            <SectionCard
              key={shop.id}
              className="catalog-shop-section overflow-visible"
              title={shop.name}
              caption={
                <div className="flex flex-wrap items-center gap-2">
                  <span>{shop.marketplace} · {shop.tariff_code}</span>
                  {shop.expire_in ? <span className="text-[var(--color-muted)]">{shop.expire_in}</span> : null}
                </div>
              }
              actions={
                <button
                  type="button"
                  onClick={() => toggleShop(shop.id)}
                  className="metric-chip rounded-2xl px-4 py-2 text-sm text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
                >
                  {collapsed ? "Развернуть" : "Свернуть"}
                </button>
              }
            >
              <div className="space-y-5">
                <InlineMetricSet
                  values={[
                    { label: "Артикулы", value: formatNumber(shop.articles.length) },
                    { label: "Показы", value: formatCompactNumber(totals.views) },
                    { label: "Клики", value: formatCompactNumber(totals.clicks) },
                    { label: "Заказы", value: formatNumber(totals.orders) },
                    { label: "Расход", value: formatMoney(totals.expense_sum) },
                    { label: "CR", value: formatPercent(totals.clicks > 0 ? (totals.orders / totals.clicks) * 100 : null) },
                    { label: "Баланс", value: formatMoney(shop.balance) },
                    {
                      label: "Магазин",
                      value: (
                        <a
                          href={shop.shop_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 whitespace-nowrap text-brand-200 hover:text-brand-100"
                        >
                          Открыть в XWAY
                          <ExternalLink className="size-3.5" />
                        </a>
                      ),
                    },
                  ]}
                />

                {!collapsed ? (
                  <MetricTable
                    rows={shop.articles}
                    stickyHeader
                    headerStickyTop={toolbarHeight}
                    emptyText="Под текущий фильтр артикулы не попали."
                    columns={[
                      {
                        key: "product",
                        header: <span className="inline-block w-[232px]">Товар</span>,
                        render: (article) => (
                          <div className="flex w-[232px] max-w-[232px] items-start gap-3">
                            <div className="h-14 aspect-[51/68] shrink-0 overflow-hidden rounded-2xl bg-[var(--color-surface-strong)]">
                              {article.image_url ? <img src={article.image_url} alt={article.name} className="h-full w-full object-cover" /> : null}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium text-[var(--color-ink)]" title={article.name}>
                                {article.name}
                              </p>
                              <p className="mt-1 text-xs text-[var(--color-muted)]">
                                {article.article} · {article.brand || "Без бренда"} · {article.vendor_code || "без vendor"}
                              </p>
                              <p className="mt-1 text-xs text-[var(--color-muted)]">{article.category_keyword}</p>
                            </div>
                          </div>
                        ),
                      },
                      { key: "stock", header: "Остаток", align: "right", render: (article) => formatNumber(article.stock) },
                      {
                        key: "turnover",
                        header: (
                          <span className="inline-flex flex-col leading-[1.05]">
                            <span>Оборач.</span>
                            <span>3 дн</span>
                          </span>
                        ),
                        align: "right",
                        render: (article) =>
                          formatTurnoverDays(
                            computeTurnoverDays(article.stock, turnoverOrdersByRef.get(`${shop.id}:${article.product_id}`)),
                          ),
                      },
                      {
                        key: "campaigns",
                        header: <CatalogCampaignColumnsHeader />,
                        render: (article) => {
                          const slots = buildCatalogCampaignSlots(article);
                          return (
                          <div className="catalog-campaign-board min-w-[560px]">
                            {slots.length ? (
                              slots.map((slot) => (
                                <div key={`${article.article}-${slot.key}`} className={cn("catalog-campaign-card", `tone-${slot.displayStatus}`)}>
                                  <div className="catalog-campaign-card-head" title={`${slot.headline} · ${slot.zoneLabel}`}>
                                    <CatalogCampaignStatusIconBadge
                                      status={slot.displayStatus}
                                      label={
                                        slot.statusCode === "ACTIVE"
                                          ? "Активна"
                                          : slot.statusCode === "FROZEN"
                                            ? "Заморожена"
                                            : slot.statusCode === "PAUSED"
                                              ? "Приостановлена"
                                              : "Статус не задан"
                                      }
                                    />
                                    <span className={cn("catalog-campaign-kind-badge", `is-${slot.key}`)}>{slot.key === "cpc" ? "CPC" : "CPM"}</span>
                                    <CatalogCampaignZonePill label={slot.zoneLabel} kind={slot.zoneKind} iconOnly />
                                    <strong className="catalog-campaign-title">{slot.headline}</strong>
                                  </div>
                                </div>
                              ))
                            ) : (
                              <span className="text-[var(--color-muted)]">Нет кампаний</span>
                            )}
                          </div>
                          );
                        },
                      },
                      { key: "spend", header: "Расход", align: "right", render: (article) => formatMoney(article.expense_sum) },
                      { key: "views", header: "Показы", align: "right", render: (article) => formatCompactNumber(article.views) },
                      { key: "clicks", header: "Клики", align: "right", render: (article) => formatNumber(article.clicks) },
                      { key: "orders", header: "Заказы", align: "right", render: (article) => formatNumber(article.orders) },
                      { key: "ctr", header: "CTR", align: "right", render: (article) => formatPercent(article.ctr) },
                      { key: "cr", header: "CR", align: "right", render: (article) => formatPercent(article.cr) },
                      {
                        key: "actions",
                        header: "Открыть",
                        align: "right",
                        render: (article) => (
                          <Link
                            to={`/product${buildProductSearch(article.article, start, end)}`}
                            className="inline-flex items-center gap-2 rounded-2xl bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#342f49]"
                          >
                            Детали
                          </Link>
                        ),
                      },
                    ]}
                  />
                ) : null}
              </div>
            </SectionCard>
          );
        })}
      </div>

      {!visibleShops.length ? (
        <SectionCard title="Совпадений нет" caption="По текущим фильтрам ничего не нашлось.">
          <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--color-muted)]">
            <button
              type="button"
              onClick={clearLocalFilters}
              className="text-brand-200 underline underline-offset-4"
            >
              Очистить локальные фильтры
            </button>
            <span>или</span>
            <Link to={`/catalog${catalogSearch}`} className="text-brand-200 underline underline-offset-4">
              вернуться к полному периоду
            </Link>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
