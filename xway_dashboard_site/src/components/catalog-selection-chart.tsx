import { useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn, formatCompactNumber, formatMoney, formatNumber, formatPercent } from "../lib/format";
import type { CatalogChartRow, CatalogChartTotals } from "../lib/types";

type CatalogSeriesKey = "views" | "clicks" | "atbs" | "orders" | "expense_sum" | "ctr" | "cr1" | "cr2" | "crf";
type CatalogDrrSeriesKey = "drr_total" | "drr_ads";
type CatalogTooltipSeriesKey = CatalogSeriesKey | CatalogDrrSeriesKey;
type ChartMode = "combined" | "split";
type SplitPanelKey = "views" | "clicks" | "atbs" | "orders" | "crf";
type CrfRenderMode = "line" | "bar";
export type OrdersDisplayMode = "all" | "campaign-types";
type LegendItem = {
  key: CatalogSeriesKey;
  label: string;
  value: string;
  color: string;
  active: boolean;
  onToggle: () => void;
};
type SeriesToggleItem = {
  key: CatalogTooltipSeriesKey;
  label: string;
  color: string;
  active: boolean;
  onToggle: () => void;
};
type SplitChartConfig = {
  panel: SplitPanelKey;
  title: string;
  primaryKey: CatalogSeriesKey;
  rateKey?: CatalogSeriesKey;
};
type CatalogChartAxisMetric = {
  key: string;
  label: string;
  color: string;
  active?: boolean;
  getValue: (row: CatalogChartRow & { label: string }) => string;
};
type CatalogChartValueTableMetric = CatalogChartAxisMetric;
type CatalogChartDisplayRow = CatalogChartRow & { label: string } & Record<string, unknown>;
type CatalogChartXAxisTickProps = {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string | number };
  rows: Array<CatalogChartRow & { label: string }>;
  metrics: CatalogChartAxisMetric[];
  compact?: boolean;
};
type CatalogOrderTypeSeries = {
  key: string;
  dataKey: string;
  label: string;
  color: string;
  order: number;
};

const CHART_GRID = "#e7e3ee";
const CHART_SYNC_ID = "catalog-selection-chart";
const DATE_TICK_PROPS = {
  fill: "#807a93",
  fontSize: 10,
  fontWeight: 700,
} as const;
const DEFAULT_HIDDEN_SERIES: CatalogSeriesKey[] = ["expense_sum", "ctr"];
const DEFAULT_SPLIT_HIDDEN_SERIES: Record<SplitPanelKey, CatalogSeriesKey[]> = {
  views: [],
  clicks: ["ctr"],
  atbs: [],
  orders: [],
  crf: [],
};
const CATALOG_ORDER_TYPE_SERIES: CatalogOrderTypeSeries[] = [
  { key: "cpm-manual", dataKey: "orders_type_cpm_manual", label: "CPM · Ручная", color: "#2ea36f", order: 1 },
  { key: "cpm-unified", dataKey: "orders_type_cpm_unified", label: "CPM · Единая", color: "#4b7bff", order: 2 },
  { key: "cpc", dataKey: "orders_type_cpc", label: "CPC", color: "#8b64f6", order: 3 },
];

function formatChartDateLabel(value: string | null | undefined) {
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
  return rawValue;
}
const CATALOG_SERIES: Array<{
  key: CatalogSeriesKey;
  label: string;
  color: string;
  kind: "count" | "money" | "rate";
}> = [
  { key: "views", label: "Просмотры", color: "#4b7bff", kind: "count" },
  { key: "clicks", label: "Клики", color: "#8b64f6", kind: "count" },
  { key: "atbs", label: "Корзины", color: "#14a6a1", kind: "count" },
  { key: "orders", label: "Заказы", color: "#4ba66f", kind: "count" },
  { key: "expense_sum", label: "Расход", color: "#f17828", kind: "money" },
  { key: "ctr", label: "CTR", color: "#3158c9", kind: "rate" },
  { key: "cr1", label: "CR1", color: "#2998df", kind: "rate" },
  { key: "cr2", label: "CR2", color: "#a855f7", kind: "rate" },
  { key: "crf", label: "CRF", color: "#f04c7c", kind: "rate" },
];
const CATALOG_DRR_SERIES: Array<{
  key: CatalogDrrSeriesKey;
  label: string;
  color: string;
  kind: "rate";
}> = [
  { key: "drr_total", label: "ДРР общ.", color: "#ff6b8a", kind: "rate" },
  { key: "drr_ads", label: "ДРР РК", color: "#f17828", kind: "rate" },
];
const CATALOG_TOOLTIP_SERIES = [...CATALOG_SERIES, ...CATALOG_DRR_SERIES];
const SPLIT_CHARTS: SplitChartConfig[] = [
  { panel: "views", title: "Просмотры / расход", primaryKey: "views" },
  { panel: "clicks", title: "Клики / расход / CTR", primaryKey: "clicks", rateKey: "ctr" },
  { panel: "atbs", title: "Корзины / расход / CR1", primaryKey: "atbs", rateKey: "cr1" },
  { panel: "orders", title: "Заказы / расход / CR2", primaryKey: "orders", rateKey: "cr2" },
];

function getSeriesMeta(key: CatalogSeriesKey) {
  return CATALOG_SERIES.find((series) => series.key === key);
}

function toggleLegendKey<T extends string>(current: T[], key: T) {
  return current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
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

function formatLegendValue(key: CatalogSeriesKey, totals: CatalogChartTotals | null) {
  if (!totals) {
    return "—";
  }
  if (key === "expense_sum") {
    return formatMoney(totals.expense_sum, true);
  }
  if (key === "orders") {
    return formatNumber(totals.orders);
  }
  if (key === "views" || key === "clicks" || key === "atbs") {
    return formatCompactNumber(totals[key]);
  }
  return formatPercent(totals[key]);
}

function formatTooltipValue(key: CatalogTooltipSeriesKey, value: unknown) {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  if (key === "expense_sum") {
    return formatMoney(normalizedValue, true);
  }
  if (key === "ctr" || key === "cr1" || key === "cr2" || key === "crf" || key === "drr_total" || key === "drr_ads") {
    return formatPercent(normalizedValue);
  }
  if (key === "views") {
    return formatCompactNumber(normalizedValue);
  }
  return formatNumber(normalizedValue);
}

function formatOrderTypeTooltipValue(value: unknown) {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  return formatNumber(normalizedValue);
}

function getCatalogOrderTypeValue(row: CatalogChartRow, typeKey: string) {
  const value = row.orders_by_campaign_type?.[typeKey];
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <div className="chart-legend">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={item.onToggle}
          className={cn("chart-legend-item", !item.active && "is-inactive")}
          style={{ ["--swatch" as string]: item.color }}
          aria-pressed={item.active}
        >
          <i />
          {item.label} {item.value}
        </button>
      ))}
    </div>
  );
}

function SeriesToggleRow({ items }: { items: SeriesToggleItem[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={item.onToggle}
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] transition",
            item.active
              ? "border-[rgba(75,123,255,0.22)] bg-white/90 text-[var(--color-ink)] shadow-[0_8px_18px_rgba(31,23,53,0.06)]"
              : "border-[rgba(128,122,147,0.18)] bg-white/55 text-[var(--color-muted)] opacity-70",
          )}
          aria-pressed={item.active}
        >
          <span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} />
          {item.label}
        </button>
      ))}
    </div>
  );
}

function ChartModeToggle({
  value,
  onChange,
}: {
  value: ChartMode;
  onChange: (nextValue: ChartMode) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-full border border-[rgba(75,123,255,0.16)] bg-white/86 p-1 shadow-[0_10px_24px_rgba(31,23,53,0.06)]">
      {([
        ["combined", "Цельный"],
        ["split", "Раздельный"],
      ] as const).map(([mode, label]) => {
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition",
              active
                ? "bg-[var(--color-active-bg)] text-[var(--color-active-ink)] shadow-[0_10px_20px_rgba(38,33,58,0.18)] hover:bg-[var(--color-active-bg-hover)]"
                : "text-[var(--color-muted)]",
            )}
            aria-pressed={active}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function CatalogChartTooltip({
  active,
  label,
  payload,
}: {
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown; color?: string; payload?: unknown }>;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const rawRow = payload.find((entry) => entry?.payload && typeof entry.payload === "object")?.payload as
    | Partial<CatalogChartRow>
    | undefined;
  const spentSkuCount = typeof rawRow?.spent_sku_count === "number" ? rawRow.spent_sku_count : null;
  const payloadByKey = new Map<string, { value?: unknown; color?: string }>();
  payload.forEach((entry) => {
    const rawKey = entry?.dataKey;
    const key = typeof rawKey === "string" || typeof rawKey === "number" ? String(rawKey) : "";
    if (key) {
      payloadByKey.set(key, entry);
    }
  });
  const visibleItems = CATALOG_TOOLTIP_SERIES.filter((series) => payloadByKey.has(series.key));
  const orderTypeItems = CATALOG_ORDER_TYPE_SERIES.filter((series) => payloadByKey.has(series.dataKey));
  if (!visibleItems.length && !orderTypeItems.length && spentSkuCount === null) {
    return null;
  }

  return (
    <div className="rounded-[18px] border border-[var(--color-line)] bg-white/96 px-4 py-3 shadow-[0_18px_40px_rgba(44,35,66,0.12)]">
      <div className="text-sm font-semibold text-[var(--color-ink)]">{label}</div>
      <div className="mt-2 space-y-2">
        {visibleItems.map((series) => {
          const entry = payloadByKey.get(series.key);
          return (
            <div key={series.key} className="flex items-center justify-between gap-4 text-sm">
              <span className="inline-flex items-center gap-2 text-[var(--color-muted)]">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: entry?.color || series.color }} />
                {series.label}
              </span>
              <span className="font-medium text-[var(--color-ink)]">{formatTooltipValue(series.key, entry?.value)}</span>
            </div>
          );
        })}
        {orderTypeItems.map((series) => {
          const entry = payloadByKey.get(series.dataKey);
          return (
            <div key={series.dataKey} className="flex items-center justify-between gap-4 text-sm">
              <span className="inline-flex items-center gap-2 text-[var(--color-muted)]">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: entry?.color || series.color }} />
                {series.label}
              </span>
              <span className="font-medium text-[var(--color-ink)]">{formatOrderTypeTooltipValue(entry?.value)}</span>
            </div>
          );
        })}
        {spentSkuCount !== null ? (
          <div className="flex items-center justify-between gap-4 border-t border-[rgba(75,123,255,0.12)] pt-2 text-sm">
            <span className="inline-flex items-center gap-2 text-[var(--color-muted)]">
              <span className="size-2.5 rounded-full bg-[#f17828]" />
              SKU с тратами
            </span>
            <span className="font-medium text-[var(--color-ink)]">{formatNumber(spentSkuCount)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CatalogChartValueTable({
  rows,
  metrics,
  compact = false,
}: {
  rows: Array<CatalogChartRow & { label: string }>;
  metrics: CatalogChartValueTableMetric[];
  compact?: boolean;
}) {
  if (!rows.length || !metrics.length) {
    return null;
  }

  return (
    <div className={cn("catalog-chart-value-table", compact && "is-compact")}>
      <div className="catalog-chart-value-table-scroll">
        <div
          className="catalog-chart-value-table-grid"
          style={{ gridTemplateColumns: `minmax(${compact ? 70 : 86}px, auto) repeat(${rows.length}, minmax(${compact ? 42 : 54}px, 1fr))` }}
        >
          <div className="catalog-chart-value-table-head is-label">Дата</div>
          {rows.map((row) => (
            <div key={`date-${row.day}`} className="catalog-chart-value-table-head">
              {row.day_label}
            </div>
          ))}
          {metrics.map((metric) => (
            <div className={cn("contents", metric.active === false && "is-muted")} key={metric.key}>
              <div className="catalog-chart-value-table-metric" style={{ ["--swatch" as string]: metric.color }}>
                <i />
                <span>{metric.label}</span>
              </div>
              {rows.map((row) => (
                <div key={`${metric.key}-${row.day}`} className="catalog-chart-value-table-value">
                  {metric.getValue(row)}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function OrderCampaignTypeLegend({
  rows,
  series,
}: {
  rows: CatalogChartDisplayRow[];
  series: CatalogOrderTypeSeries[];
}) {
  if (!series.length) {
    return null;
  }

  const grandTotal = series.reduce(
    (sum, item) => sum + rows.reduce((seriesSum, row) => seriesSum + (Number(row[item.dataKey]) || 0), 0),
    0,
  );

  return (
    <div className="chart-legend">
      {series.map((item) => {
        const total = rows.reduce((sum, row) => sum + (Number(row[item.dataKey]) || 0), 0);
        const share = grandTotal > 0 ? (total / grandTotal) * 100 : 0;
        return (
          <span
            key={item.key}
            className="chart-legend-item"
            style={{ ["--swatch" as string]: item.color }}
          >
            <i />
            {item.label} {formatNumber(total)} · {formatPercent(share)}
          </span>
        );
      })}
    </div>
  );
}

function OrdersDisplayToggle({
  value,
  onChange,
}: {
  value: OrdersDisplayMode;
  onChange: (nextValue: OrdersDisplayMode) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-full border border-[rgba(75,123,255,0.14)] bg-white/84 p-1">
      {([
        ["all", "Все"],
        ["campaign-types", "РК"],
      ] as const).map(([mode, label]) => {
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            className={cn(
              "rounded-full px-3 py-1 text-[11px] font-semibold transition",
              active
                ? "bg-[var(--color-active-bg)] text-[var(--color-active-ink)] hover:bg-[var(--color-active-bg-hover)]"
                : "text-[var(--color-muted)]",
            )}
            aria-pressed={active}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function catalogChartAxisHeight(metrics: CatalogChartAxisMetric[], compact = false) {
  const visibleMetricCount = metrics.filter((metric) => metric.active !== false).length;
  return (compact ? 30 : 38) + visibleMetricCount * (compact ? 14 : 16);
}

function CatalogChartXAxisTick({ x = 0, y = 0, payload, rows, metrics, compact = false }: CatalogChartXAxisTickProps) {
  const tickX = Number(x) || 0;
  const tickY = Number(y) || 0;
  const label = String(payload?.value ?? "");
  const row = rows.find((item) => item.label === label);
  const visibleMetrics = metrics.filter((metric) => metric.active !== false);
  const valueFontSize = compact ? 9 : 10;
  const lineHeight = compact ? 14 : 16;
  const axisTopGap = compact ? 8 : 12;

  return (
    <g transform={`translate(${tickX},${tickY})`} className="catalog-chart-axis-tick">
      <text className="catalog-chart-axis-date" textAnchor="middle" x={0} y={axisTopGap}>
        {label}
      </text>
      {row
        ? visibleMetrics.map((metric, index) => (
            <text
              key={metric.key}
              textAnchor="middle"
              x={0}
              y={axisTopGap + (index + 1) * lineHeight}
              fill={metric.color}
              fontSize={valueFontSize}
              fontWeight={800}
            >
              {metric.getValue(row)}
            </text>
          ))
        : null}
    </g>
  );
}

function SplitMetricChart({
  title,
  rows,
  primaryKey,
  rateKey,
  hiddenKeys,
  onToggleKey,
  ordersDisplayMode = "all",
  onChangeOrdersDisplayMode,
  orderCampaignTypeSeries = [],
}: {
  title: string;
  rows: CatalogChartDisplayRow[];
  primaryKey: CatalogSeriesKey;
  rateKey?: CatalogSeriesKey;
  hiddenKeys: CatalogSeriesKey[];
  onToggleKey: (key: CatalogSeriesKey) => void;
  ordersDisplayMode?: OrdersDisplayMode;
  onChangeOrdersDisplayMode?: (nextMode: OrdersDisplayMode) => void;
  orderCampaignTypeSeries?: CatalogOrderTypeSeries[];
}) {
  const primaryMeta = getSeriesMeta(primaryKey)!;
  const expenseMeta = getSeriesMeta("expense_sum")!;
  const rateMeta = rateKey ? getSeriesMeta(rateKey) : null;
  const primaryVisible = !hiddenKeys.includes(primaryKey);
  const expenseVisible = !hiddenKeys.includes("expense_sum");
  const rateVisible = rateKey ? !hiddenKeys.includes(rateKey) : false;
  const showOrderTypeBars = primaryKey === "orders" && ordersDisplayMode === "campaign-types";
  const hasOrderTypeBars = showOrderTypeBars && orderCampaignTypeSeries.length > 0;
  const hasVisiblePrimary = primaryVisible && (!showOrderTypeBars || hasOrderTypeBars);
  const hasVisibleSeries = hasVisiblePrimary || expenseVisible || rateVisible;

  return (
    <div className="rounded-[22px] border border-white/60 bg-white/52 px-4 py-4 shadow-[0_16px_38px_rgba(31,23,53,0.05)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h5 className="font-display text-[1.02rem] font-semibold text-[var(--color-ink)]">{title}</h5>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Бары для основного объёма, расход линией, rate пунктиром.
          </p>
        </div>
        {primaryKey === "orders" && onChangeOrdersDisplayMode ? (
          <OrdersDisplayToggle value={ordersDisplayMode} onChange={onChangeOrdersDisplayMode} />
        ) : null}
      </div>

      <div className="mt-3 h-[250px]">
        {!hasVisibleSeries ? (
          <div className="flex h-full items-center justify-center rounded-[18px] border border-dashed border-[rgba(128,122,147,0.2)] bg-[rgba(255,255,255,0.4)] px-4 text-sm text-[var(--color-muted)]">
            Включи хотя бы одну серию ниже.
          </div>
        ) : (
          <ResponsiveContainer>
            <ComposedChart data={rows} syncId={CHART_SYNC_ID} margin={{ top: 10, right: 10, left: 8, bottom: 8 }}>
              <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={false} />
              <XAxis
                dataKey="label"
                tick={DATE_TICK_PROPS}
                axisLine={false}
                tickLine={false}
                tickMargin={12}
                interval="preserveStartEnd"
                minTickGap={18}
                angle={-35}
                height={68}
                textAnchor="end"
              />
              <YAxis yAxisId={primaryKey} hide allowDecimals={primaryMeta.kind !== "count"} domain={["auto", "auto"]} />
              <YAxis yAxisId="expense_sum" hide orientation="right" allowDecimals domain={["auto", "auto"]} />
              {rateKey ? <YAxis yAxisId={rateKey} hide orientation="right" allowDecimals domain={["auto", "auto"]} /> : null}
              <Tooltip isAnimationActive={false} content={(props) => <CatalogChartTooltip {...props} />} />
              {primaryVisible && showOrderTypeBars ? (
                orderCampaignTypeSeries.map((series) => (
                  <Bar
                    key={series.key}
                    yAxisId={primaryKey}
                    dataKey={series.dataKey}
                    name={series.label}
                    stackId="orders-by-campaign-type"
                    fill={series.color}
                    radius={[8, 8, 0, 0]}
                    maxBarSize={24}
                    fillOpacity={0.92}
                    isAnimationActive={false}
                  />
                ))
              ) : primaryVisible ? (
                <Bar
                  yAxisId={primaryKey}
                  dataKey={primaryKey}
                  name={primaryMeta.label}
                  fill={primaryMeta.color}
                  radius={[8, 8, 0, 0]}
                  maxBarSize={24}
                  fillOpacity={0.9}
                  isAnimationActive={false}
                />
              ) : null}
              {expenseVisible ? (
                <Line
                  yAxisId="expense_sum"
                  dataKey="expense_sum"
                  name={expenseMeta.label}
                  type="monotone"
                  stroke={expenseMeta.color}
                  strokeWidth={2.6}
                  dot={false}
                  activeDot={{ r: 4.5 }}
                  connectNulls
                  isAnimationActive={false}
                />
              ) : null}
              {rateKey && rateVisible && rateMeta ? (
                <Line
                  yAxisId={rateKey}
                  dataKey={rateKey}
                  name={rateMeta.label}
                  type="monotone"
                  stroke={rateMeta.color}
                  strokeWidth={2.4}
                  strokeDasharray="6 4"
                  dot={false}
                  activeDot={{ r: 4.5 }}
                  connectNulls
                  isAnimationActive={false}
                />
              ) : null}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <SeriesToggleRow
        items={[
          {
            key: primaryKey,
            label: primaryMeta.label,
            color: primaryMeta.color,
            active: primaryVisible,
            onToggle: () => onToggleKey(primaryKey),
          },
          {
            key: "expense_sum",
            label: expenseMeta.label,
            color: expenseMeta.color,
            active: expenseVisible,
            onToggle: () => onToggleKey("expense_sum"),
          },
          ...(rateKey && rateMeta
            ? [
                {
                  key: rateKey,
                  label: rateMeta.label,
                  color: rateMeta.color,
                  active: rateVisible,
                  onToggle: () => onToggleKey(rateKey),
                },
              ]
            : []),
        ]}
      />
      {showOrderTypeBars && primaryVisible ? <OrderCampaignTypeLegend rows={rows} series={orderCampaignTypeSeries} /> : null}
    </div>
  );
}

function SplitSkuChart({ rows }: { rows: Array<CatalogChartRow & { label: string }> }) {
  const skuMetrics: CatalogChartAxisMetric[] = [
    {
      key: "spent_sku_count",
      label: "SKU",
      color: "#f17828",
      getValue: (row) => formatNumber(row.spent_sku_count),
    },
  ];
  const axisHeight = catalogChartAxisHeight(skuMetrics, true);

  return (
    <div className="rounded-[22px] border border-white/60 bg-white/52 px-4 py-4 shadow-[0_16px_38px_rgba(31,23,53,0.05)]">
      <div className="mb-3 flex items-center justify-between gap-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--color-muted)]">
        <span>SKU с тратами по дням</span>
        <span>Кол-во SKU с расходом &gt; 0</span>
      </div>
      <div className="h-[160px]">
        <ResponsiveContainer>
          <ComposedChart data={rows} syncId={CHART_SYNC_ID} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
            <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={false} />
            <XAxis
              dataKey="label"
              tick={(props) => <CatalogChartXAxisTick {...props} rows={rows} metrics={skuMetrics} compact />}
              axisLine={false}
              tickLine={false}
              interval={0}
              height={axisHeight}
            />
            <YAxis hide allowDecimals={false} domain={[0, "auto"]} />
            <Tooltip isAnimationActive={false} content={(props) => <CatalogChartTooltip {...props} />} />
            <Bar
              dataKey="spent_sku_count"
              name="SKU с тратами"
              fill="#f17828"
              radius={[8, 8, 0, 0]}
              maxBarSize={20}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function CatalogDrrChart({
  rows,
  hiddenKeys,
  onToggleKey,
  compact = false,
}: {
  rows: Array<CatalogChartRow & { label: string }>;
  hiddenKeys: CatalogDrrSeriesKey[];
  onToggleKey: (key: CatalogDrrSeriesKey) => void;
  compact?: boolean;
}) {
  const visibleSeries = CATALOG_DRR_SERIES.filter((series) => !hiddenKeys.includes(series.key));
  const hasVisibleSeries = visibleSeries.length > 0;
  const axisMetrics: CatalogChartAxisMetric[] = CATALOG_DRR_SERIES.map((series) => ({
    key: series.key,
    label: series.label,
    color: series.color,
    active: !hiddenKeys.includes(series.key),
    getValue: (row) => formatPercent(row[series.key]),
  }));
  const axisHeight = catalogChartAxisHeight(axisMetrics, compact);
  const shellClassName = compact
    ? "rounded-[22px] border border-white/60 bg-white/45 px-3 py-3"
    : "rounded-[22px] border border-white/60 bg-white/52 px-4 py-4 shadow-[0_16px_38px_rgba(31,23,53,0.05)]";

  return (
    <div className={shellClassName}>
      <div className={cn("flex items-start justify-between gap-3", compact ? "mb-2" : "mb-3")}>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--color-muted)]">
            ДРР по дням
          </div>
          <div className="mt-1 text-xs text-[var(--color-muted)]">
            Общие заказы и РК-заказы
          </div>
        </div>
      </div>
      <div className={compact ? "h-[142px]" : "h-[218px]"}>
        {!hasVisibleSeries ? (
          <div className="flex h-full items-center justify-center rounded-[18px] border border-dashed border-[rgba(128,122,147,0.2)] bg-[rgba(255,255,255,0.4)] px-4 text-sm text-[var(--color-muted)]">
            Включи хотя бы одну ДРР-линию ниже.
          </div>
        ) : (
          <ResponsiveContainer>
            <ComposedChart data={rows} syncId={CHART_SYNC_ID} margin={{ top: compact ? 14 : 22, right: 8, left: 8, bottom: compact ? 4 : 8 }}>
              <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={false} />
              <XAxis
                dataKey="label"
                tick={(props) => <CatalogChartXAxisTick {...props} rows={rows} metrics={axisMetrics} compact={compact} />}
                axisLine={false}
                tickLine={false}
                interval={0}
                minTickGap={0}
                height={axisHeight}
              />
              <YAxis yAxisId="drr" hide orientation="right" allowDecimals domain={["auto", "auto"]} />
              <Tooltip isAnimationActive={false} content={(props) => <CatalogChartTooltip {...props} />} />
              {visibleSeries.map((series) => (
                <Line
                  key={series.key}
                  yAxisId="drr"
                  dataKey={series.key}
                  name={series.label}
                  type="monotone"
                  stroke={series.color}
                  strokeWidth={compact ? 2.2 : 2.5}
                  strokeDasharray={series.key === "drr_ads" ? "6 4" : undefined}
                  dot={false}
                  activeDot={{ r: 4.5 }}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <SeriesToggleRow
        items={CATALOG_DRR_SERIES.map((series) => ({
          key: series.key,
          label: series.label,
          color: series.color,
          active: !hiddenKeys.includes(series.key),
          onToggle: () => onToggleKey(series.key),
        }))}
      />
    </div>
  );
}

function SplitCrfChart({
  rows,
  hiddenKeys,
  onToggleKey,
  renderMode,
  onChangeRenderMode,
}: {
  rows: Array<CatalogChartRow & { label: string }>;
  hiddenKeys: CatalogSeriesKey[];
  onToggleKey: (key: CatalogSeriesKey) => void;
  renderMode: CrfRenderMode;
  onChangeRenderMode: (nextMode: CrfRenderMode) => void;
}) {
  const crfMeta = getSeriesMeta("crf")!;
  const crfVisible = !hiddenKeys.includes("crf");

  return (
    <div className="rounded-[22px] border border-white/60 bg-white/52 px-4 py-4 shadow-[0_16px_38px_rgba(31,23,53,0.05)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h5 className="font-display text-[1.02rem] font-semibold text-[var(--color-ink)]">CRF</h5>
          <p className="mt-1 text-xs text-[var(--color-muted)]">Можно показать пунктирной линией или барами.</p>
        </div>
        <div className="inline-flex items-center rounded-full border border-[rgba(75,123,255,0.14)] bg-white/84 p-1">
          {([
            ["line", "Линия"],
            ["bar", "Бары"],
          ] as const).map(([mode, label]) => {
            const active = renderMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => onChangeRenderMode(mode)}
                className={cn(
                  "rounded-full px-3 py-1 text-[11px] font-semibold transition",
                  active
                    ? "bg-[var(--color-active-bg)] text-[var(--color-active-ink)] hover:bg-[var(--color-active-bg-hover)]"
                    : "text-[var(--color-muted)]",
                )}
                aria-pressed={active}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-3 h-[260px]">
        {!crfVisible ? (
          <div className="flex h-full items-center justify-center rounded-[18px] border border-dashed border-[rgba(128,122,147,0.2)] bg-[rgba(255,255,255,0.4)] px-4 text-sm text-[var(--color-muted)]">
            CRF скрыт. Включи его кнопкой ниже.
          </div>
        ) : (
          <ResponsiveContainer>
            <ComposedChart data={rows} syncId={CHART_SYNC_ID} margin={{ top: 10, right: 10, left: 8, bottom: 8 }}>
              <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={false} />
              <XAxis
                dataKey="label"
                tick={DATE_TICK_PROPS}
                axisLine={false}
                tickLine={false}
                tickMargin={12}
                interval="preserveStartEnd"
                minTickGap={18}
                angle={-35}
                height={68}
                textAnchor="end"
              />
              <YAxis yAxisId="crf" hide orientation="right" allowDecimals domain={["auto", "auto"]} />
              <Tooltip isAnimationActive={false} content={(props) => <CatalogChartTooltip {...props} />} />
              {renderMode === "bar" ? (
                <Bar
                  yAxisId="crf"
                  dataKey="crf"
                  name={crfMeta.label}
                  fill={crfMeta.color}
                  radius={[8, 8, 0, 0]}
                  maxBarSize={24}
                  fillOpacity={0.9}
                  isAnimationActive={false}
                />
              ) : (
                <Line
                  yAxisId="crf"
                  dataKey="crf"
                  name={crfMeta.label}
                  type="monotone"
                  stroke={crfMeta.color}
                  strokeWidth={2.4}
                  strokeDasharray="6 4"
                  dot={false}
                  activeDot={{ r: 4.5 }}
                  connectNulls
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <SeriesToggleRow
        items={[
          {
            key: "crf",
            label: crfMeta.label,
            color: crfMeta.color,
            active: crfVisible,
            onToggle: () => onToggleKey("crf"),
          },
        ]}
      />
    </div>
  );
}

export function CatalogSelectionChart({
  rows,
  totals,
  selectionCount,
  loadedProductsCount,
  loadTargetCount,
  chunkCount,
  loadedChunkCount,
  errorCount,
  isLoading,
  error,
  rangeLabel,
  windowDays,
  onRetryErrors,
  ordersDisplayMode,
  onChangeOrdersDisplayMode,
  orderTypeLoading = false,
  orderTypeError = null,
}: {
  rows: CatalogChartRow[];
  totals: CatalogChartTotals | null;
  selectionCount: number;
  loadedProductsCount?: number | null;
  loadTargetCount?: number | null;
  chunkCount?: number | null;
  loadedChunkCount?: number | null;
  errorCount?: number | null;
  isLoading: boolean;
  error?: string | null;
  rangeLabel: string;
  windowDays: number;
  onRetryErrors?: () => void;
  ordersDisplayMode?: OrdersDisplayMode;
  onChangeOrdersDisplayMode?: (nextMode: OrdersDisplayMode) => void;
  orderTypeLoading?: boolean;
  orderTypeError?: string | null;
}) {
  const [chartMode, setChartMode] = useState<ChartMode>("combined");
  const [hiddenSeries, setHiddenSeries] = useState<CatalogSeriesKey[]>(DEFAULT_HIDDEN_SERIES);
  const [splitHiddenSeries, setSplitHiddenSeries] = useState<Record<SplitPanelKey, CatalogSeriesKey[]>>(
    DEFAULT_SPLIT_HIDDEN_SERIES,
  );
  const [hiddenDrrSeries, setHiddenDrrSeries] = useState<CatalogDrrSeriesKey[]>([]);
  const [crfRenderMode, setCrfRenderMode] = useState<CrfRenderMode>("line");
  const [internalOrdersDisplayMode, setInternalOrdersDisplayMode] = useState<OrdersDisplayMode>("all");
  const resolvedOrdersDisplayMode = ordersDisplayMode ?? internalOrdersDisplayMode;
  const setResolvedOrdersDisplayMode = onChangeOrdersDisplayMode ?? setInternalOrdersDisplayMode;
  const loadingTargetCount = loadTargetCount ?? selectionCount;

  const activeSeries = CATALOG_SERIES.filter((series) => !hiddenSeries.includes(series.key));
  const chartRows: CatalogChartDisplayRow[] = rows.map((row) => ({
    ...row,
    label: formatChartDateLabel(row.day_label || row.day),
    ...Object.fromEntries(
      CATALOG_ORDER_TYPE_SERIES.map((series) => [series.dataKey, getCatalogOrderTypeValue(row, series.key)]),
    ),
  }));
  const visibleOrderTypeSeries = CATALOG_ORDER_TYPE_SERIES.filter((series) =>
    chartRows.some((row) => (Number(row[series.dataKey]) || 0) > 0),
  ).sort((left, right) => left.order - right.order);
  const skuAxisMetrics: CatalogChartAxisMetric[] = [
    {
      key: "spent_sku_count",
      label: "SKU",
      color: "#f17828",
      getValue: (row) => formatNumber(row.spent_sku_count),
    },
  ];
  const compactSkuAxisHeight = catalogChartAxisHeight(skuAxisMetrics, true);
  const legendItems: LegendItem[] = CATALOG_SERIES.map((series) => ({
    key: series.key,
    label: series.label,
    value: formatLegendValue(series.key, totals),
    color: series.color,
    active: !hiddenSeries.includes(series.key),
    onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, series.key)),
  }));

  const toggleSplitPanelKey = (panel: SplitPanelKey, key: CatalogSeriesKey) => {
    setSplitHiddenSeries((current) => ({
      ...current,
      [panel]: toggleLegendKey(current[panel] || [], key),
    }));
  };
  const toggleDrrKey = (key: CatalogDrrSeriesKey) => {
    setHiddenDrrSeries((current) => toggleLegendKey(current, key));
  };

  const emptyStateClassName = chartMode === "combined" ? "min-h-[420px]" : "min-h-[260px]";

  return (
    <div className="chart-card catalog-selection-chart-card border-[rgba(75,123,255,0.14)]">
      <div className="chart-card-head">
        <div>
          <h4 className="font-display font-semibold text-[var(--color-ink)]">Динамика по выборке</h4>
          <p>
            За {windowDays} дн. · {rangeLabel}. В графике {formatNumber(selectionCount)} {formatProductsWord(selectionCount)}
            {loadedProductsCount !== undefined && loadedProductsCount !== null && loadedProductsCount < selectionCount
              ? `, загружено ${formatNumber(loadedProductsCount)}`
              : ""}.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-sm text-[var(--color-muted)]">
          <ChartModeToggle value={chartMode} onChange={setChartMode} />
          {isLoading ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1.5">
              <LoaderCircle className="size-4 animate-spin text-brand-200" />
              {loadedProductsCount !== undefined && loadedProductsCount !== null
                ? `Загружено ${formatNumber(loadedProductsCount)} / ${formatNumber(loadingTargetCount)}`
                : "Обновляем график"}
            </span>
          ) : null}
          {!isLoading && chunkCount && chunkCount > 0 ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-white/72 px-3 py-1.5 text-xs">
              Чанки {formatNumber(loadedChunkCount ?? chunkCount)} / {formatNumber(chunkCount)}
            </span>
          ) : null}
          {errorCount ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">
              <span className="px-1">Ошибок: {formatNumber(errorCount)}</span>
              {onRetryErrors ? (
                <button
                  type="button"
                  onClick={onRetryErrors}
                  disabled={isLoading}
                  title="Обновить товары с ошибками"
                  aria-label="Обновить товары с ошибками"
                  className="inline-flex size-7 items-center justify-center rounded-full bg-white text-rose-700 shadow-[0_6px_14px_rgba(190,18,60,0.12)] transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <RefreshCw className={cn("size-3.5", isLoading && "animate-spin")} />
                </button>
              ) : null}
            </span>
          ) : null}
          {orderTypeLoading ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1.5 text-xs">
              <LoaderCircle className="size-4 animate-spin text-brand-200" />
              Р“СЂСѓР·РёРј Р Рљ
            </span>
          ) : orderTypeError ? (
            <span className="inline-flex rounded-full bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
              Р Рљ РЅРµ РґРѕРіСЂСѓР¶РµРЅС‹
            </span>
          ) : null}
        </div>
      </div>

      <div className="trend-chart space-y-4">
        {!selectionCount ? (
          <div className={cn("flex items-center justify-center text-sm text-[var(--color-muted)]", emptyStateClassName)}>
            Под выбранные фильтры товары не попали.
          </div>
        ) : error ? (
          <div className={cn("flex items-center justify-center text-center text-sm text-rose-600", emptyStateClassName)}>
            Не удалось загрузить график: {error}
          </div>
        ) : isLoading && !rows.length ? (
          <div className={cn("flex items-center justify-center text-sm text-[var(--color-muted)]", emptyStateClassName)}>
            Загружаем агрегированные ряды по каталогу…
          </div>
        ) : !rows.length ? (
          <div className={cn("flex items-center justify-center text-sm text-[var(--color-muted)]", emptyStateClassName)}>
            За этот период для выборки нет дневной статистики.
          </div>
        ) : chartMode === "combined" ? (
          !activeSeries.length ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">
              Включи хотя бы один показатель в легенде ниже.
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="h-[280px] sm:h-[340px]">
                <ResponsiveContainer>
                  <ComposedChart data={chartRows} syncId={CHART_SYNC_ID} margin={{ top: 12, right: 8, left: 8, bottom: 8 }}>
                    <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={DATE_TICK_PROPS}
                      axisLine={false}
                      tickLine={false}
                      tickMargin={12}
                      interval="preserveStartEnd"
                      minTickGap={18}
                      angle={-35}
                      height={68}
                      textAnchor="end"
                    />
                    {CATALOG_SERIES.map((series, index) => (
                      <YAxis
                        key={series.key}
                        yAxisId={series.key}
                        hide
                        orientation={index % 2 === 0 ? "left" : "right"}
                        allowDecimals={series.kind !== "count"}
                        domain={["auto", "auto"]}
                      />
                    ))}
                    <Tooltip isAnimationActive={false} content={(props) => <CatalogChartTooltip {...props} />} />
                    {activeSeries.map((series) => (
                      <Line
                        key={series.key}
                        yAxisId={series.key}
                        dataKey={series.key}
                        name={series.label}
                        type="monotone"
                        stroke={series.color}
                        strokeWidth={series.kind === "rate" ? 2.3 : series.key === "expense_sum" ? 2.8 : 2.6}
                        strokeDasharray={series.kind === "rate" ? "6 4" : undefined}
                        dot={false}
                        activeDot={{ r: 4.5 }}
                        connectNulls
                        isAnimationActive={false}
                      />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <div className="rounded-[22px] border border-white/60 bg-white/45 px-3 py-3">
                <div className="mb-2 flex items-center justify-between gap-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--color-muted)]">
                  <span>SKU с тратами по дням</span>
                  <span>Кол-во SKU с расходом &gt; 0</span>
                </div>
                <div className="h-[118px]">
                  <ResponsiveContainer>
                    <ComposedChart data={chartRows} syncId={CHART_SYNC_ID} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                      <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={false} />
                      <XAxis
                        dataKey="label"
                        tick={(props) => <CatalogChartXAxisTick {...props} rows={chartRows} metrics={skuAxisMetrics} compact />}
                        axisLine={false}
                        tickLine={false}
                        interval={0}
                        height={compactSkuAxisHeight}
                      />
                      <YAxis hide allowDecimals={false} domain={[0, "auto"]} />
                      <Tooltip isAnimationActive={false} content={(props) => <CatalogChartTooltip {...props} />} />
                      <Bar
                        dataKey="spent_sku_count"
                        name="SKU с тратами"
                        fill="#f17828"
                        radius={[6, 6, 0, 0]}
                        maxBarSize={18}
                        isAnimationActive={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <CatalogDrrChart rows={chartRows} hiddenKeys={hiddenDrrSeries} onToggleKey={toggleDrrKey} compact />
            </div>
          )
        ) : (
          <div className="space-y-4">
            <SplitSkuChart rows={chartRows} />
            <CatalogDrrChart rows={chartRows} hiddenKeys={hiddenDrrSeries} onToggleKey={toggleDrrKey} />

            <div className="grid gap-4 xl:grid-cols-2">
              {SPLIT_CHARTS.map((config) => (
                <SplitMetricChart
                  key={config.panel}
                  title={config.title}
                  rows={chartRows}
                  primaryKey={config.primaryKey}
                  rateKey={config.rateKey}
                  hiddenKeys={splitHiddenSeries[config.panel]}
                  onToggleKey={(key) => toggleSplitPanelKey(config.panel, key)}
                  ordersDisplayMode={resolvedOrdersDisplayMode}
                  onChangeOrdersDisplayMode={setResolvedOrdersDisplayMode}
                  orderCampaignTypeSeries={visibleOrderTypeSeries}
                />
              ))}
            </div>

            <SplitCrfChart
              rows={chartRows}
              hiddenKeys={splitHiddenSeries.crf}
              onToggleKey={(key) => toggleSplitPanelKey("crf", key)}
              renderMode={crfRenderMode}
              onChangeRenderMode={setCrfRenderMode}
            />
          </div>
        )}
      </div>

      {chartMode === "combined" ? <ChartLegend items={legendItems} /> : null}
    </div>
  );
}
