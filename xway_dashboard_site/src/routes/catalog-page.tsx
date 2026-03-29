import { useDeferredValue, useEffect, useRef, useState, startTransition } from "react";
import { ExternalLink, FolderOpen, Layers3, MousePointerClick, PackageCheck, Pause, Play, Search as SearchIcon, ShoppingBag, ShoppingCart, Snowflake, ThumbsUp } from "lucide-react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useNavigate } from "react-router";
import { fetchCatalog } from "../lib/api";
import { buildPresetRange, cn, formatCompactNumber, formatDateRange, formatMoney, formatNumber, formatPercent, getRangePreset, shiftIsoDate, toNumber } from "../lib/format";
import type { CatalogArticle, CatalogCampaignState, CatalogResponse, CatalogShop } from "../lib/types";
import { InlineMetricSet, KeyValueRow, MetricCard, MetricTable, PageHero, RangeToolbar, SearchField, SectionCard } from "../components/ui";

interface CatalogLoaderData {
  payload: CatalogResponse;
  comparePayload: CatalogResponse | null;
  start?: string | null;
  end?: string | null;
}

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
}: {
  label: string;
  kind: "search" | "recom" | "both";
}) {
  if (kind === "both") {
    return (
      <span className="catalog-campaign-zone-pill is-both">
        <SearchIcon className="size-4" strokeWidth={2.05} />
        <span>Поиск</span>
        <span className="catalog-campaign-zone-separator">+</span>
        <ThumbsUp className="size-4" strokeWidth={2.05} />
        <span>Рекомендации</span>
      </span>
    );
  }

  if (kind === "recom") {
    return (
      <span className="catalog-campaign-zone-pill is-recom">
        <ThumbsUp className="size-4" strokeWidth={2.05} />
        <span>Рекомендации</span>
      </span>
    );
  }

  return (
    <span className="catalog-campaign-zone-pill is-search">
      <SearchIcon className="size-4" strokeWidth={2.05} />
      <span>{label}</span>
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
  params.set("selected", article);
  if (start) {
    params.set("start", start);
  }
  if (end) {
    params.set("end", end);
  }
  return `?${params.toString()}`;
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

  return { payload, comparePayload, start, end };
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

function filterShops(payload: CatalogResponse, query: string) {
  return payload.shops
    .map((shop) => {
      const articles = shop.articles.filter((article) => articleMatches(article, query));
      const shopMatches = shop.name.toLowerCase().includes(query);
      if (query && !articles.length && !shopMatches) {
        return null;
      }
      return {
        ...shop,
        articles: query && shopMatches && !articles.length ? shop.articles : articles.length ? articles : shop.articles,
      };
    })
    .filter(Boolean) as CatalogShop[];
}

export function CatalogPage() {
  const { payload, comparePayload, start, end } = useLoaderData() as CatalogLoaderData;
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [collapsedShopIds, setCollapsedShopIds] = useState<string[]>([]);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  const visibleShops = filterShops(payload, deferredQuery);
  const preset = getRangePreset(start, end);
  const catalogSearch = buildCatalogSearch(start, end);

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
          extra={<SearchField value={query} onChange={(value) => startTransition(() => setQuery(value))} placeholder="Фильтр по артикулу, названию, бренду, категории" />}
        />
      </div>

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

      <div className="space-y-5">
        {visibleShops.map((shop) => {
          const collapsed = collapsedShopIds.includes(String(shop.id));
          const totals = shop.listing_meta?.shop_totals;

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
                    { label: "Показы", value: formatCompactNumber(totals?.views) },
                    { label: "Клики", value: formatCompactNumber(totals?.clicks) },
                    { label: "Заказы", value: formatNumber(totals?.orders) },
                    { label: "Расход", value: formatMoney(totals?.sum) },
                    { label: "CR", value: formatPercent(totals?.cr) },
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
                        key: "campaigns",
                        header: <CatalogCampaignColumnsHeader />,
                        render: (article) => {
                          const slots = buildCatalogCampaignSlots(article);
                          return (
                          <div className="catalog-campaign-board min-w-[560px]">
                            {slots.length ? (
                              slots.map((slot) => (
                                <div key={`${article.article}-${slot.key}`} className={cn("catalog-campaign-card", `tone-${slot.displayStatus}`)}>
                                  <div className="catalog-campaign-card-head">
                                    <div className="catalog-campaign-copy">
                                      <div className="catalog-campaign-title-row">
                                        <span className={cn("catalog-campaign-kind-badge", `is-${slot.key}`)}>{slot.key === "cpc" ? "CPC" : "CPM"}</span>
                                        <strong className="catalog-campaign-title">{slot.headline}</strong>
                                      </div>
                                      <CatalogCampaignZonePill label={slot.zoneLabel} kind={slot.zoneKind} />
                                    </div>
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
        <SectionCard title="Совпадений нет" caption={`По фильтру "${query}" ничего не нашлось.`}>
          <div className="text-sm text-[var(--color-muted)]">Очистите фильтр или вернитесь к полному периоду: <Link to={`/catalog${catalogSearch}`} className="text-brand-200 underline underline-offset-4">показать все артикулы</Link>.</div>
        </SectionCard>
      ) : null}
    </div>
  );
}
