import { useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Settings } from "lucide-react";
import { cn, formatDate, formatMoney, formatNumber, formatPercent, toNumber } from "../../lib/format";
import type { CatalogArticle, CatalogChartResponse } from "../../lib/types";

const CATALOG_ARTICLE_ANALYTICS_SETTINGS_STORAGE_KEY = "xway-catalog-article-analytics-settings-v1";

export interface CatalogArticleAnalyticsState {
  loading: boolean;
  error: string | null;
  rows: CatalogChartResponse["rows"] | null;
}

export function formatCatalogShortDate(value: string | null | undefined) {
  const rawValue = String(value || "");
  const dottedDate = rawValue.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dottedDate) {
    const day = dottedDate[1] || "";
    const month = dottedDate[2] || "";
    const year = dottedDate[3] || "";
    return `${day}.${month}.${year.slice(-2)}`;
  }
  const isoDate = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) {
    const year = isoDate[1] || "";
    const month = isoDate[2] || "";
    const day = isoDate[3] || "";
    return `${day}.${month}.${year.slice(-2)}`;
  }
  return rawValue || formatDate(value);
}

type CatalogArticleAnalyticsMetricKey =
  | "expense_sum"
  | "views"
  | "clicks"
  | "atbs"
  | "orders"
  | "ordered_total"
  | "avg_stock"
  | "sum_price"
  | "rel_sum_price"
  | "rel_shks"
  | "rel_atbs"
  | "ordered_sum_total"
  | "spent_sku_count"
  | "ctr"
  | "cpm"
  | "cpc"
  | "cpl"
  | "cpo_ads"
  | "cpo_overall"
  | "cpo_with_rel"
  | "cr1"
  | "cr2"
  | "crf"
  | "cr_total"
  | "view_to_click"
  | "view_to_atb"
  | "view_to_order"
  | "extra_revenue_share"
  | "avg_check_ads"
  | "drr_ads"
  | "drr_total"
  | "ads_revenue_share"
  | "roas_ads"
  | "roas_total";

type CatalogArticleAnalyticsMetric = {
  key: CatalogArticleAnalyticsMetricKey;
  label: string;
  format: (row: CatalogChartResponse["rows"][number]) => string;
};
type CatalogArticleCampaignTypeKey = "cpm-manual" | "cpm-unified" | "cpc";
type CatalogArticleCampaignTypeTotals = {
  views: number;
  clicks: number;
  atbs: number;
  orders: number;
  spend: number;
  revenue: number;
};

const EMPTY_CAMPAIGN_TYPE_TOTALS: CatalogArticleCampaignTypeTotals = {
  views: 0,
  clicks: 0,
  atbs: 0,
  orders: 0,
  spend: 0,
  revenue: 0,
};
const CATALOG_ARTICLE_CAMPAIGN_TYPES: Array<{
  key: CatalogArticleCampaignTypeKey;
  label: string;
  badge: string;
  color: string;
}> = [
  { key: "cpm-manual", label: "Ручная", badge: "CPM", color: "#2ea36f" },
  { key: "cpm-unified", label: "Единая", badge: "CPM", color: "#4b7bff" },
  { key: "cpc", label: "Клики", badge: "CPC", color: "#8b64f6" },
];
const CATALOG_ARTICLE_CAMPAIGN_TYPE_METRICS: Array<{
  key: "spend" | "views" | "clicks" | "orders" | "ctr" | "cr" | "drr";
  label: string;
  getValue: (totals: CatalogArticleCampaignTypeTotals) => number | null;
  format: (value: number | null) => string;
}> = [
  { key: "spend", label: "Расход", getValue: (totals) => totals.spend, format: (value) => formatMoney(value, true) },
  { key: "views", label: "Показы", getValue: (totals) => totals.views, format: (value) => formatNumber(value) },
  { key: "clicks", label: "Клики", getValue: (totals) => totals.clicks, format: (value) => formatNumber(value) },
  { key: "orders", label: "Заказы", getValue: (totals) => totals.orders, format: (value) => formatNumber(value) },
  { key: "ctr", label: "CTR", getValue: (totals) => catalogMetricRate(totals.clicks, totals.views), format: (value) => formatPercent(value) },
  { key: "cr", label: "CR", getValue: (totals) => catalogMetricRate(totals.orders, totals.clicks), format: (value) => formatPercent(value) },
  { key: "drr", label: "ДРР", getValue: (totals) => catalogMetricRate(totals.spend, totals.revenue), format: (value) => formatPercent(value) },
];

function catalogMetricRate(numerator: number | string | null | undefined, denominator: number | string | null | undefined) {
  const top = toNumber(numerator);
  const bottom = toNumber(denominator);
  return top !== null && bottom !== null && bottom > 0 ? (top / bottom) * 100 : null;
}

function catalogMetricMoneyPer(numerator: number | string | null | undefined, denominator: number | string | null | undefined) {
  const top = toNumber(numerator);
  const bottom = toNumber(denominator);
  return top !== null && bottom !== null && bottom > 0 ? top / bottom : null;
}

function catalogMetricCpm(spend: number | string | null | undefined, views: number | string | null | undefined) {
  const value = catalogMetricMoneyPer(spend, views);
  return value === null ? null : value * 1000;
}

function buildCampaignTypeTotals(rows: CatalogChartResponse["rows"]): Record<CatalogArticleCampaignTypeKey, CatalogArticleCampaignTypeTotals> {
  const totals = Object.fromEntries(
    CATALOG_ARTICLE_CAMPAIGN_TYPES.map((type) => [type.key, { ...EMPTY_CAMPAIGN_TYPE_TOTALS }]),
  ) as Record<CatalogArticleCampaignTypeKey, CatalogArticleCampaignTypeTotals>;

  rows.forEach((row) => {
    CATALOG_ARTICLE_CAMPAIGN_TYPES.forEach((type) => {
      const metrics = row.metrics_by_campaign_type?.[type.key];
      if (metrics) {
        totals[type.key].views += toNumber(metrics.views) ?? 0;
        totals[type.key].clicks += toNumber(metrics.clicks) ?? 0;
        totals[type.key].atbs += toNumber(metrics.atbs) ?? 0;
        totals[type.key].orders += toNumber(metrics.orders) ?? 0;
        totals[type.key].spend += toNumber(metrics.spend) ?? 0;
        totals[type.key].revenue += toNumber(metrics.revenue) ?? 0;
      } else {
        totals[type.key].orders += toNumber(row.orders_by_campaign_type?.[type.key]) ?? 0;
      }
    });
  });

  return totals;
}

function CatalogArticleCampaignTypeMatrix({ rows }: { rows: CatalogChartResponse["rows"] }) {
  const totalsByType = buildCampaignTypeTotals(rows);
  const visibleTypes = CATALOG_ARTICLE_CAMPAIGN_TYPES.filter((type) =>
    Object.values(totalsByType[type.key]).some((value) => value > 0),
  );
  if (!visibleTypes.length) {
    return null;
  }

  return (
    <div className="catalog-article-analytics-scroll is-campaign-types">
      <table className="catalog-article-analytics-table catalog-article-campaign-type-table">
        <thead>
          <tr>
            <th>Тип РК</th>
            {CATALOG_ARTICLE_CAMPAIGN_TYPE_METRICS.map((metric) => (
              <th key={metric.key}>{metric.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleTypes.map((type) => {
            const totals = totalsByType[type.key];
            return (
              <tr key={type.key}>
                <th>
                  <span className="catalog-article-campaign-type-label">
                    <span style={{ backgroundColor: type.color }}>{type.badge}</span>
                    <strong>{type.label}</strong>
                  </span>
                </th>
                {CATALOG_ARTICLE_CAMPAIGN_TYPE_METRICS.map((metric) => {
                  const value = metric.getValue(totals);
                  return (
                    <td key={`${type.key}-${metric.key}`}>
                      <span className="catalog-article-campaign-type-value" style={{ backgroundColor: type.color }}>
                        {metric.format(value)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const CATALOG_ARTICLE_ANALYTICS_METRICS: CatalogArticleAnalyticsMetric[] = [
  { key: "expense_sum", label: "Расход", format: (row) => formatMoney(row.expense_sum, true) },
  { key: "views", label: "Показы", format: (row) => formatNumber(row.views) },
  { key: "clicks", label: "Клики", format: (row) => formatNumber(row.clicks) },
  { key: "atbs", label: "Корзины", format: (row) => formatNumber(row.atbs) },
  { key: "orders", label: "Заказы РК", format: (row) => formatNumber(row.orders) },
  { key: "ordered_total", label: "Заказы всего", format: (row) => formatNumber(row.ordered_total) },
  { key: "avg_stock", label: "Средний остаток", format: (row) => formatNumber(row.avg_stock) },
  { key: "sum_price", label: "Заказано с РК", format: (row) => formatMoney(row.sum_price, true) },
  { key: "rel_sum_price", label: "Доп. выручка", format: (row) => formatMoney(row.rel_sum_price, true) },
  { key: "rel_shks", label: "Доп. заказы", format: (row) => formatNumber(row.rel_shks) },
  { key: "rel_atbs", label: "Доп. корзины", format: (row) => formatNumber(row.rel_atbs) },
  { key: "ordered_sum_total", label: "Заказано всего", format: (row) => formatMoney(row.ordered_sum_total, true) },
  { key: "spent_sku_count", label: "SKU с расходом", format: (row) => formatNumber(row.spent_sku_count) },
  { key: "ctr", label: "CTR", format: (row) => formatPercent(row.ctr ?? catalogMetricRate(row.clicks, row.views)) },
  { key: "cpm", label: "CPM", format: (row) => formatMoney(catalogMetricCpm(row.expense_sum, row.views), true) },
  { key: "cpc", label: "CPC", format: (row) => formatMoney(catalogMetricMoneyPer(row.expense_sum, row.clicks), true) },
  { key: "cpl", label: "CPL", format: (row) => formatMoney(catalogMetricMoneyPer(row.expense_sum, row.atbs), true) },
  { key: "cpo_ads", label: "CPO РК", format: (row) => formatMoney(catalogMetricMoneyPer(row.expense_sum, row.orders), true) },
  { key: "cpo_overall", label: "CPO общий", format: (row) => formatMoney(catalogMetricMoneyPer(row.expense_sum, row.ordered_total), true) },
  { key: "cpo_with_rel", label: "CPO с доп. заказами", format: (row) => formatMoney(catalogMetricMoneyPer(row.expense_sum, (toNumber(row.orders) ?? 0) + (toNumber(row.rel_shks) ?? 0)), true) },
  { key: "cr1", label: "Клик -> корзина", format: (row) => formatPercent(row.cr1 ?? catalogMetricRate(row.atbs, row.clicks)) },
  { key: "cr2", label: "Корзина -> заказ", format: (row) => formatPercent(row.cr2 ?? catalogMetricRate(row.orders, row.atbs)) },
  { key: "crf", label: "Клик -> заказ", format: (row) => formatPercent(row.crf ?? catalogMetricRate(row.orders, row.clicks)) },
  { key: "cr_total", label: "CR общий", format: (row) => formatPercent(row.cr_total ?? catalogMetricRate(row.ordered_total, row.views)) },
  { key: "view_to_click", label: "Показ -> клик", format: (row) => formatPercent(catalogMetricRate(row.clicks, row.views)) },
  { key: "view_to_atb", label: "Показ -> корзина", format: (row) => formatPercent(catalogMetricRate(row.atbs, row.views)) },
  { key: "view_to_order", label: "Показ -> заказ", format: (row) => formatPercent(catalogMetricRate(row.orders, row.views)) },
  { key: "extra_revenue_share", label: "Доля доп. выручки", format: (row) => formatPercent(catalogMetricRate(row.rel_sum_price, row.ordered_sum_total)) },
  { key: "avg_check_ads", label: "Средний чек РК", format: (row) => formatMoney(catalogMetricMoneyPer(row.sum_price, row.orders), true) },
  { key: "drr_ads", label: "ДРР РК", format: (row) => formatPercent(row.drr_ads ?? catalogMetricRate(row.expense_sum, row.sum_price)) },
  { key: "drr_total", label: "ДРР общий", format: (row) => formatPercent(row.drr_total ?? catalogMetricRate(row.expense_sum, row.ordered_sum_total)) },
  { key: "ads_revenue_share", label: "Доля заказов РК", format: (row) => formatPercent(catalogMetricRate(row.sum_price, row.ordered_sum_total)) },
  { key: "roas_ads", label: "ROAS РК", format: (row) => formatNumber(catalogMetricMoneyPer(row.sum_price, row.expense_sum), 2) },
  { key: "roas_total", label: "ROAS общий", format: (row) => formatNumber(catalogMetricMoneyPer(row.ordered_sum_total, row.expense_sum), 2) },
];

const CATALOG_ARTICLE_ANALYTICS_METRIC_KEYS = CATALOG_ARTICLE_ANALYTICS_METRICS.map((metric) => metric.key);

function normalizeCatalogArticleAnalyticsSettings(rawValue: unknown) {
  const defaults = {
    order: [...CATALOG_ARTICLE_ANALYTICS_METRIC_KEYS],
    visible: Object.fromEntries(CATALOG_ARTICLE_ANALYTICS_METRIC_KEYS.map((key) => [key, true])) as Record<CatalogArticleAnalyticsMetricKey, boolean>,
  };
  if (!rawValue || typeof rawValue !== "object") {
    return defaults;
  }
  const raw = rawValue as { order?: unknown; visible?: unknown };
  const rawOrder = Array.isArray(raw.order) ? raw.order.filter((key): key is CatalogArticleAnalyticsMetricKey => CATALOG_ARTICLE_ANALYTICS_METRIC_KEYS.includes(key as CatalogArticleAnalyticsMetricKey)) : [];
  const order = [...rawOrder, ...CATALOG_ARTICLE_ANALYTICS_METRIC_KEYS.filter((key) => !rawOrder.includes(key))];
  const rawVisible = raw.visible && typeof raw.visible === "object" ? (raw.visible as Record<string, unknown>) : {};
  return {
    order,
    visible: Object.fromEntries(CATALOG_ARTICLE_ANALYTICS_METRIC_KEYS.map((key) => [key, rawVisible[key] !== false])) as Record<CatalogArticleAnalyticsMetricKey, boolean>,
  };
}

function readCatalogArticleAnalyticsSettings() {
  if (typeof window === "undefined") {
    return normalizeCatalogArticleAnalyticsSettings(null);
  }
  try {
    return normalizeCatalogArticleAnalyticsSettings(JSON.parse(window.localStorage.getItem(CATALOG_ARTICLE_ANALYTICS_SETTINGS_STORAGE_KEY) || "null"));
  } catch {
    return normalizeCatalogArticleAnalyticsSettings(null);
  }
}

function CatalogArticleAnalyticsSettingsRow({
  metric,
  checked,
  onToggle,
}: {
  metric: CatalogArticleAnalyticsMetric;
  checked: boolean;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: metric.key });
  return (
    <div
      ref={setNodeRef}
      className={cn("catalog-article-analytics-settings-row", isDragging && "is-dragging")}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button type="button" className="catalog-article-analytics-drag-handle" aria-label={`Перетащить ${metric.label}`} {...attributes} {...listeners}>
        <GripVertical className="size-4" />
      </button>
      <label>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span>{metric.label}</span>
      </label>
    </div>
  );
}

export function CatalogArticleAnalyticsPanel({
  article,
  state,
}: {
  article: CatalogArticle;
  state: CatalogArticleAnalyticsState | undefined;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(readCatalogArticleAnalyticsSettings);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const metricsByKey = new Map(CATALOG_ARTICLE_ANALYTICS_METRICS.map((metric) => [metric.key, metric]));
  const orderedMetrics = settings.order.map((key) => metricsByKey.get(key)).filter((metric): metric is CatalogArticleAnalyticsMetric => Boolean(metric));
  const visibleMetrics = orderedMetrics.filter((metric) => settings.visible[metric.key] !== false);
  const updateSettings = (updater: (current: ReturnType<typeof readCatalogArticleAnalyticsSettings>) => ReturnType<typeof readCatalogArticleAnalyticsSettings>) => {
    setSettings((current) => {
      const next = updater(current);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(CATALOG_ARTICLE_ANALYTICS_SETTINGS_STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });
  };
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    updateSettings((current) => {
      const oldIndex = current.order.indexOf(active.id as CatalogArticleAnalyticsMetricKey);
      const newIndex = current.order.indexOf(over.id as CatalogArticleAnalyticsMetricKey);
      if (oldIndex < 0 || newIndex < 0) {
        return current;
      }
      return { ...current, order: arrayMove(current.order, oldIndex, newIndex) };
    });
  };

  if (!state || state.loading) {
    return (
      <div className="catalog-article-analytics-panel">
        <div className="catalog-article-analytics-state">Загружаем динамику по дням...</div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="catalog-article-analytics-panel">
        <div className="catalog-article-analytics-state is-error">{state.error}</div>
      </div>
    );
  }

  const rows = [...(state.rows || [])].reverse();
  if (!rows.length) {
    return (
      <div className="catalog-article-analytics-panel">
        <div className="catalog-article-analytics-state">По товару нет дневной статистики за выбранный период.</div>
      </div>
    );
  }

  return (
    <div className="catalog-article-analytics-panel">
      <div className="catalog-article-analytics-head">
        <span>Динамика по дням</span>
        <small>
          {article.name} · арт.: {article.article}
        </small>
        <button
          type="button"
          className={cn("catalog-article-analytics-settings-button", settingsOpen && "is-active")}
          onClick={() => setSettingsOpen((current) => !current)}
          aria-expanded={settingsOpen}
        >
          <Settings className="size-4" />
          Метрики
        </button>
      </div>
      {settingsOpen ? (
        <div className="catalog-article-analytics-settings">
          <div className="catalog-article-analytics-settings-head">
            <span>Отображение метрик</span>
            <button type="button" onClick={() => updateSettings(() => normalizeCatalogArticleAnalyticsSettings(null))}>
              Сбросить
            </button>
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={settings.order} strategy={verticalListSortingStrategy}>
              <div className="catalog-article-analytics-settings-list">
                {orderedMetrics.map((metric) => (
                  <CatalogArticleAnalyticsSettingsRow
                    key={metric.key}
                    metric={metric}
                    checked={settings.visible[metric.key] !== false}
                    onToggle={() =>
                      updateSettings((current) => ({
                        ...current,
                        visible: {
                          ...current.visible,
                          [metric.key]: current.visible[metric.key] === false,
                        },
                      }))
                    }
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      ) : null}
      <CatalogArticleCampaignTypeMatrix rows={rows} />
      <div className="catalog-article-analytics-scroll">
        <table className="catalog-article-analytics-table">
          <thead>
            <tr>
              <th>Метрика</th>
              {rows.map((row) => (
                <th key={row.day}>{formatCatalogShortDate(row.day_label || row.day)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleMetrics.map((metric) => (
              <tr key={metric.key}>
                <th>{metric.label}</th>
                {rows.map((row) => (
                  <td key={`${metric.key}-${row.day}`}>{metric.format(row)}</td>
                ))}
              </tr>
            ))}
            {!visibleMetrics.length ? (
              <tr>
                <th>Метрики скрыты</th>
                {rows.map((row) => (
                  <td key={`empty-${row.day}`}>—</td>
                ))}
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
