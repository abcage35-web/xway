import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ChevronDown, Maximize2, Pause, Play, Snowflake } from "lucide-react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { buildDailyBidRows, formatBidMoney, resolveBidKind, resolveBidLabel } from "../lib/bid-history";
import { cn, formatCompactNumber, formatMoney, formatNumber, formatPercent, toNumber } from "../lib/format";
import type { CampaignSummary, ClusterDailyRow, DailyStat, HeatmapPayload, OrdersHeatmapPayload, ProductSummary } from "../lib/types";

const CHART_GRID = "var(--color-line)";
const CHART_TICK = "var(--color-muted)";
const CHART_TOOLTIP = {
  borderRadius: 16,
  border: "1px solid var(--color-line)",
  background: "var(--color-surface)",
  color: "var(--color-ink)",
  boxShadow: "0 18px 40px rgba(44,35,66,0.12)",
};
const OVERVIEW_WINDOWS = [7, 14, 30, 60] as const;
const DATE_TICK_PROPS = {
  fill: CHART_TICK,
  fontSize: 10,
  fontWeight: 700,
} as const;
const CAMPAIGN_INLINE_LEFT_AXIS_WIDTH = 0;
const CAMPAIGN_INLINE_RIGHT_AXIS_WIDTH = 42;
const CAMPAIGN_INLINE_TOOLTIP_GAP = 20;
const CAMPAIGN_INLINE_TOOLTIP_EDGE_PADDING = 16;
const CAMPAIGN_INLINE_STATUS_VIEW_STORAGE_KEY = "xway-campaign-inline-status-view";

function getTooltipBoundaryRect(element: HTMLElement | null, fallbackRect: DOMRect) {
  if (typeof window === "undefined") {
    return fallbackRect;
  }
  let current = element?.parentElement ?? null;
  while (current && current !== document.body) {
    const styles = window.getComputedStyle(current);
    const overflowY = styles.overflowY === "visible" ? styles.overflow : styles.overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "clip") {
      return current.getBoundingClientRect();
    }
    current = current.parentElement;
  }
  return fallbackRect;
}

export type OverviewWindow = (typeof OVERVIEW_WINDOWS)[number];
export type CampaignOverviewStatusKey = "active" | "paused" | "freeze" | "unknown";
export interface CampaignOverviewStatusEntry {
  key: CampaignOverviewStatusKey;
  label: string;
  startTime: string;
  endTime: string | null;
  originalStart?: string | null;
  originalEnd?: string | null;
  actorLabel?: string | null;
  reasons: string[];
  reasonKinds?: Array<"schedule" | "budget" | "limit">;
  issueKinds?: Array<"budget" | "limit">;
}
export interface CampaignOverviewStatusDay {
  day: string;
  label: string;
  entries: CampaignOverviewStatusEntry[];
}
type LegendItem = {
  key: string;
  label: string;
  value?: string;
  color: string;
  active: boolean;
  onToggle?: () => void;
};
type ChartTooltipScalarValue = number | string | null | undefined;
type OverviewTooltipMetricConfig = {
  key: string;
  label: string;
  color: string;
  formatter: (value: ChartTooltipScalarValue) => string;
};
type CampaignTypeContributionMetricKey = "views" | "clicks" | "atbs" | "orders" | "spend" | "revenue";
type CampaignTypeContributionTableMetricKey = "spend" | "views" | "clicks" | "orders" | "ctr" | "cr" | "drr";
type CampaignTypeContributionType = {
  key: string;
  label: string;
  color: string;
  order: number;
};
type CampaignTypeContributionTypeTotals = {
  views: number;
  clicks: number;
  atbs: number;
  orders: number;
  spend: number;
  revenue: number;
};
type CampaignTypeContributionRow = {
  day: string;
  label: string;
  total: number;
  [key: string]: string | number;
};

const EMPTY_CAMPAIGN_TYPE_TOTALS: CampaignTypeContributionTypeTotals = {
  views: 0,
  clicks: 0,
  atbs: 0,
  orders: 0,
  spend: 0,
  revenue: 0,
};
const CAMPAIGN_TYPE_CONTRIBUTION_TABLE_METRICS: Array<{
  key: CampaignTypeContributionTableMetricKey;
  label: string;
  getValue: (totals: CampaignTypeContributionTypeTotals) => number | null;
  formatter: (value: ChartTooltipScalarValue) => string;
}> = [
  { key: "spend", label: "Расход", getValue: (totals) => totals.spend, formatter: (value) => formatMoney(value, true) },
  { key: "views", label: "Показы", getValue: (totals) => totals.views, formatter: (value) => formatCompactNumber(value) },
  { key: "clicks", label: "Клики", getValue: (totals) => totals.clicks, formatter: (value) => formatNumber(value) },
  { key: "orders", label: "Заказы", getValue: (totals) => totals.orders, formatter: (value) => formatNumber(value) },
  { key: "ctr", label: "CTR", getValue: (totals) => computeRate(totals.clicks, totals.views), formatter: (value) => formatPercent(value) },
  { key: "cr", label: "CR", getValue: (totals) => computeRate(totals.orders, totals.clicks), formatter: (value) => formatPercent(value) },
  { key: "drr", label: "ДРР", getValue: (totals) => computeDrr(totals.spend, totals.revenue), formatter: (value) => formatPercent(value) },
] as const;

function chartTooltipFormatter(
  value: number | string | readonly (number | string)[] | undefined,
  name: string | number | undefined,
): [string, string] {
  const label = String(name || "Значение");
  const lowerName = label.toLowerCase();
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  if (lowerName.includes("расход") || lowerName.includes("ставка")) {
    return [formatMoney(normalizedValue), label];
  }
  if (lowerName.includes("ctr") || lowerName.includes("cr") || lowerName.includes("ocr") || lowerName.includes("доля")) {
    return [formatPercent(normalizedValue), label];
  }
  return [formatNumber(normalizedValue), label];
}

function normalizeChartTooltipValue(value: unknown): ChartTooltipScalarValue {
  if (Array.isArray(value)) {
    return value[0] as ChartTooltipScalarValue;
  }
  if (typeof value === "number" || typeof value === "string" || value === null || value === undefined) {
    return value;
  }
  return undefined;
}

function sortDailyRows(rows: DailyStat[]) {
  return [...rows].sort((left, right) => left.day.localeCompare(right.day));
}

export function resolveOverviewWindow(spanDays: number | null | undefined): OverviewWindow {
  void spanDays;
  return 14;
}

function sliceByWindow<T>(rows: T[], window: OverviewWindow) {
  return rows.length > window ? rows.slice(rows.length - window) : rows;
}

function formatDayLabel(day: string) {
  const parsed = new Date(`${day}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return day;
  }
  return parsed.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function formatFullDayLabel(day: string) {
  const parsed = new Date(`${day}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return day;
  }
  return parsed.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function computeRate(numerator: number | null | undefined, denominator: number | null | undefined) {
  if (numerator === null || numerator === undefined || denominator === null || denominator === undefined || denominator <= 0) {
    return null;
  }
  return (numerator / denominator) * 100;
}

function computeDrr(spend: number | null | undefined, revenue: number | null | undefined) {
  if (spend === null || spend === undefined || revenue === null || revenue === undefined || revenue <= 0) {
    return null;
  }
  return (spend / revenue) * 100;
}

function resolveCampaignTypeContributionType(campaign: CampaignSummary): CampaignTypeContributionType {
  const bidKind = resolveBidKind(campaign);
  if (bidKind === "cpc") {
    return { key: "cpc", label: "СРС", color: "#8b64f6", order: 3 };
  }
  if (campaign.unified) {
    return { key: "cpm-unified", label: "СРМ · Единая", color: "#4b7bff", order: 2 };
  }
  return { key: "cpm-manual", label: "СРМ · Ручная", color: "#2ea36f", order: 1 };
}

export function ChartWindowSwitch({
  activeWindow,
  onChange,
}: {
  activeWindow: OverviewWindow;
  onChange: (value: OverviewWindow) => void;
}) {
  return (
    <div className="chart-window-switch">
      {OVERVIEW_WINDOWS.map((window) => (
        <button
          key={window}
          type="button"
          onClick={() => onChange(window)}
          className={window === activeWindow ? "chart-window-chip is-active" : "chart-window-chip"}
        >
          {window}
        </button>
      ))}
    </div>
  );
}

function ChartLegend({
  items,
}: {
  items: LegendItem[];
}) {
  return (
    <div className="chart-legend">
      {items.map((item) => (
        item.onToggle ? (
          <button
            key={item.key}
            type="button"
            onClick={item.onToggle}
            className={cn("chart-legend-item", !item.active && "is-inactive")}
            style={{ ["--swatch" as string]: item.color }}
            aria-pressed={item.active}
          >
            <i />
            {item.label}
            {item.value ? ` ${item.value}` : ""}
          </button>
        ) : (
          <span key={item.key} className="chart-legend-item is-static" style={{ ["--swatch" as string]: item.color }}>
            <i />
            {item.label}
            {item.value ? ` ${item.value}` : ""}
          </span>
        )
      ))}
    </div>
  );
}

function ProductOverviewTooltip({
  active,
  label,
  payload,
  configs,
}: {
  active?: boolean;
  label?: string | number;
  payload?: readonly any[];
  configs: OverviewTooltipMetricConfig[];
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const payloadByKey = new Map<string, any>();
  payload.forEach((entry) => {
    const rawKey = entry?.dataKey ?? entry?.name ?? "";
    const key = typeof rawKey === "string" || typeof rawKey === "number" ? String(rawKey) : "";
    if (key) {
      payloadByKey.set(key, entry);
    }
  });

  const metrics = configs
    .map((config) => {
      const entry = payloadByKey.get(config.key);
      if (!entry) {
        return null;
      }
      const color = String(config.color || entry.color || entry.stroke || entry.fill);
      const rowStyle = {
        ["--tooltip-accent-dot" as string]: color,
      } as CSSProperties;

      return {
        key: config.key,
        label: config.label,
        value: config.formatter(normalizeChartTooltipValue(entry.value)),
        color,
        rowStyle,
      };
    })
    .filter(Boolean) as Array<{ key: string; label: string; value: string; color: string; rowStyle: CSSProperties }>;

  if (!metrics.length) {
    return null;
  }

  return (
    <div className="chart-tooltip chart-tooltip-inline chart-tooltip-embedded">
      <strong>{String(label || metrics[0]?.key || "")}</strong>
      <div className="chart-tooltip-metrics">
        {metrics.map((metric) => (
          <div key={metric.key} className="chart-tooltip-metric-row" style={metric.rowStyle}>
            <span className="chart-tooltip-metric-label" style={{ color: metric.color }}>
              {metric.label}
            </span>
            <span className="chart-tooltip-metric-value" style={{ color: metric.color }}>
              {metric.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CampaignTypeContributionTooltip({
  active,
  label,
  payload,
  metricLabel,
  metricFormatter,
  types,
}: {
  active?: boolean;
  label?: string | number;
  payload?: readonly any[];
  metricLabel: string;
  metricFormatter: (value: ChartTooltipScalarValue) => string;
  types: CampaignTypeContributionType[];
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const row = payload[0]?.payload as CampaignTypeContributionRow | undefined;
  if (!row) {
    return null;
  }

  const total = toNumber(row.total) ?? 0;
  return (
    <div className="chart-tooltip chart-tooltip-inline chart-tooltip-embedded">
      <strong>{String(label || row.label || "")}</strong>
      <div className="mt-1 text-[11px] font-semibold text-[var(--color-muted)]">
        {metricLabel}: {metricFormatter(total)}
      </div>
      <div className="chart-tooltip-metrics">
        {types.map((type) => {
          const absolute = toNumber(row[type.key]) ?? 0;
          const share = total > 0 ? (absolute / total) * 100 : 0;
          return (
            <div
              key={type.key}
              className="chart-tooltip-metric-row"
              style={{ ["--tooltip-accent-dot" as string]: type.color } as CSSProperties}
            >
              <span className="chart-tooltip-metric-label" style={{ color: type.color }}>
                {type.label}
              </span>
              <span className="chart-tooltip-metric-value" style={{ color: type.color }}>
                {metricFormatter(absolute)} · {formatPercent(share)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function toggleLegendKey(current: string[], key: string) {
  return current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
}

function buildCampaignOverviewRows(campaign: CampaignSummary, statusDays: CampaignOverviewStatusDay[] = []) {
  const periodBidRows = buildDailyBidRows(campaign);
  const historyBidRows = buildDailyBidRows(campaign, { mode: "history" });
  const bidByDay = new Map([...historyBidRows, ...periodBidRows].map((row) => [row.day, row.bid]));
  const dailyRows = [...(campaign.daily_exact || [])].sort((left, right) => left.day.localeCompare(right.day));
  const dailyRowsByDay = new Map(dailyRows.map((row) => [row.day, row]));
  const dayKeys = new Set<string>();

  dailyRows.forEach((row) => dayKeys.add(row.day));
  periodBidRows.forEach((row) => dayKeys.add(row.day));
  statusDays.forEach((row) => dayKeys.add(row.day));

  return [...dayKeys]
    .sort((left, right) => left.localeCompare(right))
    .map((day) => {
      const dailyRow = dailyRowsByDay.get(day);
      return {
        day,
        label: formatDayLabel(day),
        views: dailyRow ? (toNumber(dailyRow.views) ?? 0) : null,
        orders: dailyRow ? (toNumber(dailyRow.orders) ?? 0) : null,
        spend: dailyRow ? (toNumber(dailyRow.expense_sum) ?? 0) : null,
        bid: bidByDay.get(day) ?? toNumber(campaign.bid),
        drr: dailyRow ? computeDrr(toNumber(dailyRow.expense_sum), toNumber(dailyRow.sum_price)) : null,
      };
    });
}

function CampaignStatusDayGlyph({ statusKey }: { statusKey: CampaignOverviewStatusKey }) {
  if (statusKey === "active") {
    return <Play className="size-3.5" strokeWidth={2.2} />;
  }
  if (statusKey === "freeze") {
    return <Snowflake className="size-3.5" strokeWidth={2.05} />;
  }
  if (statusKey === "paused") {
    return <Pause className="size-3.5" strokeWidth={2.2} />;
  }
  return <span className="block size-1.5 rounded-full bg-current" />;
}

function buildCampaignStatusTooltipAriaLabel(day: string, entry: CampaignOverviewStatusEntry) {
  const endLabel = entry.endTime ? `до ${entry.endTime}` : "до конца дня";
  const details = [entry.actorLabel, ...entry.reasons].filter(Boolean);
  const reasons = details.length ? `. ${details.join(". ")}` : "";
  return `${formatFullDayLabel(day)}. ${entry.label}. Переход в ${entry.startTime}, ${endLabel}${reasons}`;
}

interface CampaignOverviewChartRow {
  day: string;
  label: string;
  views: number | null;
  orders: number | null;
  spend: number | null;
  bid: number | null;
  drr: number | null;
}

export interface CampaignIssueSummary {
  kind: "budget" | "limit";
  label: string;
  hours: number;
  incidents: number;
  estimatedGapTotal: number | null;
  days: Array<{
    day: string;
    label: string;
    hours: number;
    incidents: number;
    estimatedGap: number | null;
  }>;
}

export type CampaignStatusHourVariant =
  | "active"
  | "paused"
  | "paused-schedule"
  | "paused-limit"
  | "paused-budget"
  | "paused-mixed"
  | "freeze"
  | "unknown";

export interface CampaignIssueBreakdownSlot {
  hour: number;
  variant: CampaignStatusHourVariant;
  title: string;
}

export interface CampaignIssueBreakdownDay {
  day: string;
  label: string;
  hours: number;
  incidents: number;
  estimatedGap: number | null;
  note?: string | null;
  statusSlots?: CampaignIssueBreakdownSlot[];
}

function parseClockToMinutes(value: string | null | undefined, endOfDay = false) {
  if (!value) {
    return endOfDay ? 24 * 60 : 0;
  }
  const [hours = "0", minutes = "0"] = String(value).split(":");
  const total = Number(hours) * 60 + Number(minutes);
  return Number.isFinite(total) ? total : endOfDay ? 24 * 60 : 0;
}

function formatIssueStopCount(value: number) {
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

export function buildCampaignIssueSummaries(campaign: CampaignSummary, statusDays: CampaignOverviewStatusDay[]) {
  const summaries = new Map<CampaignIssueSummary["kind"], CampaignIssueSummary>();
  const totalStoppedHoursByDay = new Map<string, number>();
  const dailyExpenseByDay = new Map(
    [...(campaign.daily_exact || [])]
      .sort((left, right) => left.day.localeCompare(right.day))
      .map((row) => [row.day, toNumber(row.expense_sum)]),
  );
  const averageHourlySpendFallback = (() => {
    const positiveExpenses = [...dailyExpenseByDay.values()].filter((value): value is number => value !== null && value > 0);
    if (!positiveExpenses.length) {
      return 0;
    }
    return positiveExpenses.reduce((sum, value) => sum + value, 0) / (positiveExpenses.length * 24);
  })();

  statusDays.forEach((day) => {
    day.entries.forEach((entry) => {
      if (entry.key === "active") {
        return;
      }
      const startMinutes = parseClockToMinutes(entry.startTime);
      const endMinutes = parseClockToMinutes(entry.endTime, true);
      const durationHours = Math.max(endMinutes - startMinutes, 0) / 60;
      if (durationHours <= 0) {
        return;
      }
      totalStoppedHoursByDay.set(day.day, (totalStoppedHoursByDay.get(day.day) || 0) + durationHours);
    });
  });

  statusDays.forEach((day) => {
    day.entries.forEach((entry) => {
      if (!entry.issueKinds?.length || entry.key === "active") {
        return;
      }
      const startMinutes = parseClockToMinutes(entry.startTime);
      const endMinutes = parseClockToMinutes(entry.endTime, true);
      const durationHours = Math.max(endMinutes - startMinutes, 0) / 60;
      if (durationHours <= 0) {
        return;
      }
      entry.issueKinds.forEach((kind) => {
        const current = summaries.get(kind) || {
          kind,
          label: kind === "limit" ? "Израсходован лимит" : "Нет бюджета",
          hours: 0,
          incidents: 0,
          estimatedGapTotal: null,
          days: [],
        };
        current.hours += durationHours;
        current.incidents += 1;
        const dayEntry =
          current.days.find((item) => item.day === day.day) ||
          (() => {
            const nextDayEntry = {
              day: day.day,
              label: day.label,
              hours: 0,
              incidents: 0,
              estimatedGap: null,
            };
            current.days.push(nextDayEntry);
            return nextDayEntry;
          })();
        dayEntry.hours += durationHours;
        dayEntry.incidents += 1;
        summaries.set(kind, current);
      });
    });
  });

  return (["budget", "limit"] as const)
    .map((kind) => summaries.get(kind))
    .filter((summary): summary is CampaignIssueSummary => Boolean(summary))
    .map((summary) => {
      const days = summary.days
        .map((dayEntry) => {
          const totalStoppedHours = totalStoppedHoursByDay.get(dayEntry.day) || 0;
          const activeHours = Math.max(24 - totalStoppedHours, 0);
          const dailyExpense = dailyExpenseByDay.get(dayEntry.day) ?? null;
          const estimatedGap =
            dailyExpense !== null && dailyExpense > 0 && activeHours > 0
              ? (dailyExpense / activeHours) * dayEntry.hours
              : averageHourlySpendFallback > 0
                ? averageHourlySpendFallback * dayEntry.hours
                : null;

          return {
            ...dayEntry,
            estimatedGap,
          };
        })
        .sort((left, right) => left.day.localeCompare(right.day));
      const estimatedGapValues = days
        .map((day) => day.estimatedGap)
        .filter((value): value is number => value !== null && Number.isFinite(value));

      return {
        ...summary,
        estimatedGapTotal: estimatedGapValues.length ? estimatedGapValues.reduce((sum, value) => sum + value, 0) : null,
        days,
      };
    });
}

export function CampaignIssueDayBreakdownList({
  days,
  className,
}: {
  days: CampaignIssueBreakdownDay[];
  className?: string;
}) {
  if (!days.length) {
    return null;
  }

  return (
    <div className={cn("campaign-inline-issue-breakdown", className)}>
      {days.map((day) => (
        <div key={`issue-breakdown-${day.day}`} className="campaign-inline-issue-breakdown-day">
          <div className="campaign-inline-issue-day">
            <div className="campaign-inline-issue-day-copy">
              <span className="campaign-inline-issue-day-label">{day.label}</span>
              <span className="campaign-inline-issue-day-meta">{`${formatNumber(day.hours, 1)} ч · ${formatIssueStopCount(day.incidents)}`}</span>
            </div>
            <strong className="campaign-inline-issue-day-value">
              {day.estimatedGap !== null ? `≈ ${formatMoney(Math.round(day.estimatedGap), true)}` : "≈ —"}
            </strong>
          </div>
          {day.note ? <div className="campaign-inline-issue-day-note">{day.note}</div> : null}
          {day.statusSlots?.length ? (
            <div className="campaign-inline-issue-strip">
              <div className="campaign-status-strip-axis-track campaign-inline-issue-strip-axis-track" aria-hidden="true">
                {Array.from({ length: 24 }, (_, hour) => (
                  <span key={`issue-strip-axis-${day.day}-${hour}`} className="campaign-status-strip-axis-tick">
                    {hour % 3 === 0 ? formatHourTickLabel(hour) : ""}
                  </span>
                ))}
              </div>
              <div className="campaign-status-strip-track campaign-inline-issue-strip-track" aria-hidden="true">
                {day.statusSlots.map((slot) => (
                  <span
                    key={`issue-strip-slot-${day.day}-${slot.hour}`}
                    className={cn("campaign-status-strip-slot", `is-${slot.variant}`)}
                    title={slot.title}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function CampaignInlineIssuesPanel({
  campaign,
  campaignId,
  statusDays,
  className,
}: {
  campaign: CampaignSummary;
  campaignId: number;
  statusDays: CampaignOverviewStatusDay[];
  className?: string;
}) {
  const issueSummaries = useMemo(() => buildCampaignIssueSummaries(campaign, statusDays), [campaign, statusDays]);
  const totalIssueHours = issueSummaries.reduce((sum, item) => sum + item.hours, 0);
  const statusDayByDay = useMemo(() => new Map(statusDays.map((day) => [day.day, day])), [statusDays]);
  const [expandedIssues, setExpandedIssues] = useState<Record<CampaignIssueSummary["kind"], boolean>>({
    budget: false,
    limit: false,
  });
  const totalEstimatedGap = issueSummaries.reduce((sum, item) => sum + (item.estimatedGapTotal ?? 0), 0);
  const hasEstimatedGap = issueSummaries.some((item) => item.estimatedGapTotal !== null);

  useEffect(() => {
    setExpandedIssues({ budget: false, limit: false });
  }, [campaignId]);

  return (
    <div className={cn("campaign-inline-issues", className)}>
      <div className="campaign-inline-issues-head">
        <span>Ошибки по бюджету и лимитам</span>
        {issueSummaries.length ? (
          <small className="campaign-inline-issues-head-copy">
            <span>{`${formatNumber(totalIssueHours, 1)} ч простоя`}</span>
            {hasEstimatedGap ? <span>{`≈ не хватило ${formatMoney(Math.round(totalEstimatedGap), true)}`}</span> : null}
          </small>
        ) : (
          <small>без остановок в окне</small>
        )}
      </div>
      {issueSummaries.length ? (
        <div className="campaign-inline-issues-grid">
          {issueSummaries.map((issue) => (
            <div key={`${campaignId}-${issue.kind}`} className={cn("campaign-inline-issue-card", `is-${issue.kind}`)}>
              <div className="campaign-inline-issue-label">{issue.label}</div>
              <strong className="campaign-inline-issue-hours">{`${formatNumber(issue.hours, 1)} ч`}</strong>
              <span className="campaign-inline-issue-meta">{formatIssueStopCount(issue.incidents)}</span>
              <span className="campaign-inline-issue-gap">
                {issue.estimatedGapTotal !== null ? `≈ не хватило ${formatMoney(Math.round(issue.estimatedGapTotal), true)}` : "≈ не хватило —"}
              </span>
              {issue.days.length ? (
                <button
                  type="button"
                  className={cn("campaign-inline-issue-toggle", expandedIssues[issue.kind] && "is-open")}
                  onClick={() =>
                    setExpandedIssues((current) => ({
                      ...current,
                      [issue.kind]: !current[issue.kind],
                    }))
                  }
                >
                  <span>{expandedIssues[issue.kind] ? "Скрыть по дням" : "Показать по дням"}</span>
                  <ChevronDown size={14} strokeWidth={2.2} />
                </button>
              ) : null}
              {issue.days.length && expandedIssues[issue.kind] ? (
                <CampaignIssueDayBreakdownList
                  days={[...issue.days]
                    .sort((left, right) => right.day.localeCompare(left.day))
                    .map((day) => ({
                      ...day,
                      statusSlots: buildCampaignStatusHourSlots(statusDayByDay.get(day.day)).map((slot) => ({
                        hour: slot.hour,
                        variant: slot.variant,
                        title: slot.title,
                      })),
                    }))}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="campaign-inline-issue-empty">
          В выбранном окне не было остановок из-за бюджета или лимитов.
        </div>
      )}
    </div>
  );
}

type CampaignOverviewPauseReasonKind = NonNullable<CampaignOverviewStatusEntry["reasonKinds"]>[number];

interface CampaignStatusHourSlot {
  hour: number;
  key: CampaignOverviewStatusKey;
  label: string;
  variant: CampaignStatusHourVariant;
  legendKey: string;
  legendLabel: string;
  title: string;
}

type CampaignStatusSummaryPrimaryKey = "active" | "paused" | "freeze" | "unknown";

interface CampaignStatusSummarySlice {
  key: CampaignStatusSummaryPrimaryKey;
  label: string;
  variant: CampaignStatusHourVariant;
  hours: number;
  percent: number;
  color: string;
}

interface CampaignStatusPauseBreakdownItem {
  key: string;
  label: string;
  variant: CampaignStatusHourVariant;
  hours: number;
  percent: number;
  color: string;
}

interface CampaignStatusPauseBreakdownGroup {
  key: "default" | "negative";
  tone: "default" | "negative";
  items: CampaignStatusPauseBreakdownItem[];
}

const CAMPAIGN_PAUSE_REASON_ORDER: CampaignOverviewPauseReasonKind[] = ["schedule", "limit", "budget"];
const CAMPAIGN_STATUS_VARIANT_COLORS: Record<CampaignStatusHourVariant, string> = {
  active: "#3e9d69",
  paused: "#8b64f6",
  "paused-schedule": "#8b64f6",
  "paused-limit": "#d75f5f",
  "paused-budget": "#d75f5f",
  "paused-mixed": "#d75f5f",
  freeze: "#4b7bff",
  unknown: "rgba(224, 231, 255, 0.45)",
};

function buildCampaignStatusStripGradient(hourSlots: CampaignStatusHourSlot[]) {
  if (!hourSlots.length) {
    return "linear-gradient(180deg, rgba(224, 231, 255, 0.45) 0% 100%)";
  }

  const step = 100 / hourSlots.length;
  const segments = hourSlots.map((slot, index) => {
    const start = Number((index * step).toFixed(4));
    const end = Number(((index + 1) * step).toFixed(4));
    const color = CAMPAIGN_STATUS_VARIANT_COLORS[slot.variant] || CAMPAIGN_STATUS_VARIANT_COLORS.unknown;
    return `${color} ${start}% ${end}%`;
  });

  return `linear-gradient(180deg, ${segments.join(", ")})`;
}

function formatCampaignPauseReasonLabel(reasonKind: CampaignOverviewPauseReasonKind) {
  if (reasonKind === "schedule") {
    return "Расписание показов";
  }
  if (reasonKind === "limit") {
    return "Лимит расходов";
  }
  return "Исчерпан бюджет";
}

function resolvePauseBreakdownReasonKinds(item: Pick<CampaignStatusPauseBreakdownItem, "key" | "variant" | "label">) {
  if (item.variant === "paused-limit") {
    return ["limit"] as const;
  }
  if (item.variant === "paused-budget") {
    return ["budget"] as const;
  }
  const suffix = item.key.startsWith("paused-") ? item.key.slice("paused-".length) : "";
  const fromKey = suffix
    .split("+")
    .map((part) => part.trim())
    .filter((part): part is CampaignOverviewPauseReasonKind => part === "schedule" || part === "limit" || part === "budget");
  if (fromKey.length) {
    return fromKey;
  }
  const normalizedLabel = item.label.toLowerCase();
  const reasonKinds: CampaignOverviewPauseReasonKind[] = [];
  if (normalizedLabel.includes("распис")) {
    reasonKinds.push("schedule");
  }
  if (normalizedLabel.includes("лимит")) {
    reasonKinds.push("limit");
  }
  if (normalizedLabel.includes("бюджет")) {
    reasonKinds.push("budget");
  }
  return reasonKinds;
}

function resolveCampaignStatusHourDisplay(entry?: CampaignOverviewStatusEntry | null) {
  if (!entry) {
    return {
      key: "unknown" as const,
      label: "Нет данных",
      variant: "unknown" as const,
      legendKey: "unknown",
      legendLabel: "Нет данных",
    };
  }

  if (entry.key === "active") {
    return {
      key: entry.key,
      label: "Активна",
      variant: "active" as const,
      legendKey: "active",
      legendLabel: "Активна",
    };
  }

  if (entry.key === "freeze") {
    return {
      key: entry.key,
      label: "Заморожена",
      variant: "freeze" as const,
      legendKey: "freeze",
      legendLabel: "Заморожена",
    };
  }

  if (entry.key !== "paused") {
    return {
      key: entry.key,
      label: entry.label || "Нет данных",
      variant: "unknown" as const,
      legendKey: entry.key,
      legendLabel: entry.label || "Нет данных",
    };
  }

  const reasonKinds = CAMPAIGN_PAUSE_REASON_ORDER.filter((kind) => entry.reasonKinds?.includes(kind));
  const fallbackReasons = Array.from(new Set(entry.reasons.filter(Boolean)));
  const detailLabels = reasonKinds.length ? reasonKinds.map((kind) => formatCampaignPauseReasonLabel(kind)) : fallbackReasons;
  const reasonLabel = detailLabels.length ? detailLabels.join(" + ") : null;

  if (reasonKinds.length === 1) {
    const reasonKind = reasonKinds[0] as CampaignOverviewPauseReasonKind;
    const variant =
      reasonKind === "schedule"
        ? ("paused-schedule" as const)
        : reasonKind === "limit"
          ? ("paused-limit" as const)
          : ("paused-budget" as const);
    return {
      key: entry.key,
      label: "Приостановлена",
      variant,
      legendKey: `paused-${reasonKind}`,
      legendLabel: `Пауза: ${formatCampaignPauseReasonLabel(reasonKind).toLowerCase()}`,
    };
  }

  if (reasonKinds.length > 1) {
    return {
      key: entry.key,
      label: "Приостановлена",
      variant: "paused-mixed" as const,
      legendKey: `paused-${reasonKinds.join("+")}`,
      legendLabel: `Пауза: ${reasonKinds.map((kind) => formatCampaignPauseReasonLabel(kind).toLowerCase()).join(" + ")}`,
    };
  }

  return {
    key: entry.key,
    label: "Приостановлена",
    variant: "paused" as const,
    legendKey: "paused",
    legendLabel: reasonLabel ? `Пауза: ${reasonLabel.toLowerCase()}` : "Приостановлена",
  };
}

export function buildCampaignStatusHourSlots(statusDay: CampaignOverviewStatusDay | null | undefined): CampaignStatusHourSlot[] {
  const entries = statusDay?.entries || [];

  return Array.from({ length: 24 }, (_, hour) => {
    const slotStart = hour * 60;
    const slotEnd = (hour + 1) * 60;
    let dominantEntry: CampaignOverviewStatusEntry | null = null;
    let dominantOverlap = 0;

    entries.forEach((entry) => {
      const startMinutes = parseClockToMinutes(entry.startTime);
      const endMinutes = parseClockToMinutes(entry.endTime, true);
      const overlap = Math.max(0, Math.min(endMinutes, slotEnd) - Math.max(startMinutes, slotStart));

      if (overlap > dominantOverlap) {
        dominantEntry = entry;
        dominantOverlap = overlap;
      }
    });

    const display = resolveCampaignStatusHourDisplay(dominantEntry);
    const title = `${formatHourTickLabel(hour)}:00 - ${formatHourTickLabel((hour + 1) % 24)}:00 · ${display.legendLabel}`;

    return {
      hour,
      key: display.key,
      label: display.label,
      variant: display.variant,
      legendKey: display.legendKey,
      legendLabel: display.legendLabel,
      title,
    };
  });
}

function formatHourTickLabel(hour: number) {
  return String(hour).padStart(2, "0");
}

function capitalizeStatusSummaryLabel(value: string) {
  const text = String(value || "").trim();
  if (!text) {
    return "Другая причина";
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildCampaignStatusSummary(hourSlots: CampaignStatusHourSlot[]) {
  const totalHours = hourSlots.length || 24;
  const overallCounts: Record<CampaignStatusSummaryPrimaryKey, number> = {
    active: 0,
    paused: 0,
    freeze: 0,
    unknown: 0,
  };
  const pausedBreakdown = new Map<string, { label: string; variant: CampaignStatusHourVariant; hours: number }>();

  hourSlots.forEach((slot) => {
    if (slot.key === "active") {
      overallCounts.active += 1;
      return;
    }
    if (slot.key === "freeze") {
      overallCounts.freeze += 1;
      return;
    }
    if (slot.key === "paused") {
      overallCounts.paused += 1;
      const existing = pausedBreakdown.get(slot.legendKey);
      if (existing) {
        existing.hours += 1;
      } else {
        pausedBreakdown.set(slot.legendKey, {
          label: capitalizeStatusSummaryLabel(slot.legendLabel.replace(/^Пауза:\s*/i, "")),
          variant: slot.variant,
          hours: 1,
        });
      }
      return;
    }
    overallCounts.unknown += 1;
  });

  const overallOrder: Array<{ key: CampaignStatusSummaryPrimaryKey; label: string; variant: CampaignStatusHourVariant }> = [
    { key: "active", label: "Активна", variant: "active" },
    { key: "paused", label: "Приостановлена", variant: "paused" },
    { key: "freeze", label: "Заморожена", variant: "freeze" },
    { key: "unknown", label: "Нет данных", variant: "unknown" },
  ];

  const overall = overallOrder
    .map((item) => ({
      key: item.key,
      label: item.label,
      variant: item.variant,
      hours: overallCounts[item.key],
      percent: totalHours > 0 ? (overallCounts[item.key] / totalHours) * 100 : 0,
      color: CAMPAIGN_STATUS_VARIANT_COLORS[item.variant],
    }))
    .filter((item) => item.hours > 0);

  const pausedDetails = [...pausedBreakdown.entries()]
    .map(([key, item]) => ({
      key,
      label: item.label,
      variant: item.variant,
      hours: item.hours,
      percent: totalHours > 0 ? (item.hours / totalHours) * 100 : 0,
      color: CAMPAIGN_STATUS_VARIANT_COLORS[item.variant],
    }))
    .sort((left, right) => right.hours - left.hours);

  const pausedDetailGroups = (() => {
    const defaultItems: CampaignStatusPauseBreakdownItem[] = [];
    const negativeItems: CampaignStatusPauseBreakdownItem[] = [];

    pausedDetails.forEach((item) => {
      const reasonKinds = resolvePauseBreakdownReasonKinds(item);
      if (reasonKinds.some((kind) => kind === "limit" || kind === "budget")) {
        negativeItems.push(item);
        return;
      }
      defaultItems.push(item);
    });

    return [
      defaultItems.length
        ? ({
            key: "default",
            tone: "default",
            items: defaultItems,
          } satisfies CampaignStatusPauseBreakdownGroup)
        : null,
      negativeItems.length
        ? ({
            key: "negative",
            tone: "negative",
            items: negativeItems,
          } satisfies CampaignStatusPauseBreakdownGroup)
        : null,
    ].filter(Boolean) as CampaignStatusPauseBreakdownGroup[];
  })();

  const donutBackground = (() => {
    if (!overall.length) {
      return "conic-gradient(rgba(224, 231, 255, 0.18) 0% 100%)";
    }
    let cursor = 0;
    const segments = overall.map((slice) => {
      const start = cursor;
      cursor += slice.percent;
      return `${slice.color} ${start}% ${cursor}%`;
    });
    if (cursor < 100) {
      segments.push(`rgba(224, 231, 255, 0.18) ${cursor}% 100%`);
    }
    return `conic-gradient(${segments.join(", ")})`;
  })();

  return {
    overall,
    pausedDetailGroups,
    donutBackground,
  };
}

function renderCampaignInlineDayTooltipBody(
  day: string,
  row: CampaignOverviewChartRow | null | undefined,
  statusDay: CampaignOverviewStatusDay | null | undefined,
  bidKind: "cpm" | "cpc",
) {
  const entries = statusDay?.entries || [];
  const ordersLabel = bidKind === "cpc" ? "Заказы CPC" : "Заказы CPM";
  const hourSlots = buildCampaignStatusHourSlots(statusDay);
  const statusSummary = buildCampaignStatusSummary(hourSlots);
  const legendItems = Array.from(
    new Map(
      hourSlots
        .filter((slot) => slot.key !== "unknown")
        .map((slot) => [slot.legendKey, { key: slot.legendKey, label: slot.legendLabel, variant: slot.variant }]),
    ).values(),
  );

  return (
    <>
      <strong>{formatFullDayLabel(day)}</strong>
      {row ? (
        <div className="chart-tooltip-metrics">
          <div className="chart-tooltip-metric-row is-drr">
            <span className="chart-tooltip-metric-label">ДРР</span>
            <span className="chart-tooltip-metric-value">{formatPercent(row.drr)}</span>
          </div>
          <div className="chart-tooltip-metric-row is-views">
            <span className="chart-tooltip-metric-label">Показы</span>
            <span className="chart-tooltip-metric-value">{formatCompactNumber(row.views)}</span>
          </div>
          <div className="chart-tooltip-metric-row is-orders">
            <span className="chart-tooltip-metric-label">{ordersLabel}</span>
            <span className="chart-tooltip-metric-value">{formatNumber(row.orders)}</span>
          </div>
          <div className="chart-tooltip-metric-row is-spend">
            <span className="chart-tooltip-metric-label">Расход</span>
            <span className="chart-tooltip-metric-value">{formatMoney(row.spend, true)}</span>
          </div>
          <div className="chart-tooltip-metric-row is-bid">
            <span className="chart-tooltip-metric-label">{bidKind === "cpc" ? "Ставка CPC" : "Ставка CPM"}</span>
            <span className="chart-tooltip-metric-value">{formatBidMoney(row.bid, bidKind)}</span>
          </div>
        </div>
      ) : null}
      {entries.length ? (
        <>
          <div className="chart-tooltip-divider" />
          <div className="chart-tooltip-section-title">Статусы по часам</div>
          <div className="chart-tooltip-status-timeline">
            <div className="chart-tooltip-status-summary">
              <div className="chart-tooltip-status-donut" style={{ background: statusSummary.donutBackground } as CSSProperties}>
                <div className="chart-tooltip-status-donut-hole" />
              </div>
              <div className="chart-tooltip-status-summary-list">
                {statusSummary.overall.map((item) => (
                  <div key={`${day}-summary-${item.key}`} className="chart-tooltip-status-summary-row">
                    <span className="chart-tooltip-status-summary-copy">
                      <span className={cn("chart-tooltip-status-dot", `is-${item.variant}`)} />
                      <span>{item.label}</span>
                    </span>
                    <strong>{formatPercent(item.percent)}</strong>
                  </div>
                ))}
              </div>
            </div>
            {statusSummary.pausedDetailGroups.length ? (
              <div className="chart-tooltip-status-breakdown-grid">
                {statusSummary.pausedDetailGroups.map((group) => (
                  <div
                    key={`${day}-pause-breakdown-${group.key}`}
                    className={cn("chart-tooltip-status-breakdown", group.tone === "negative" && "is-negative")}
                  >
                    {group.items.map((item) => (
                      <div key={`${day}-pause-breakdown-${group.key}-${item.key}`} className="chart-tooltip-status-breakdown-row">
                        <span className="chart-tooltip-status-summary-copy">
                          <span className={cn("chart-tooltip-status-dot", `is-${item.variant}`)} />
                          <span>{item.label}</span>
                        </span>
                        <strong>{formatPercent(item.percent)}</strong>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="chart-tooltip-status-scale" aria-hidden="true">
              {hourSlots.map((slot) => (
                <span key={`${day}-tick-${slot.hour}`} className={cn("chart-tooltip-status-tick", slot.hour % 3 !== 0 && "is-muted")}>
                  {slot.hour % 3 === 0 ? formatHourTickLabel(slot.hour) : ""}
                </span>
              ))}
            </div>
            <div className="chart-tooltip-status-track" role="img" aria-label={`Почасовой статус за ${formatFullDayLabel(day)}`}>
              {hourSlots.map((slot) => (
                <span
                  key={`${day}-hour-${slot.hour}`}
                  className={cn("chart-tooltip-status-hour", `is-${slot.variant}`)}
                  title={slot.title}
                />
              ))}
            </div>
            {legendItems.length ? (
              <div className="chart-tooltip-status-legend">
                {legendItems.map((item) => (
                  <span key={`${day}-legend-${item.key}`} className="chart-tooltip-status-legend-item">
                    <span className={cn("chart-tooltip-status-dot", `is-${item.variant}`)} />
                    <span>{item.label}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}

function CampaignInlineOverviewTooltip({
  row,
  bidKind,
  statusDay,
}: {
  row: CampaignOverviewChartRow | null | undefined;
  bidKind: "cpm" | "cpc";
  statusDay?: CampaignOverviewStatusDay | null;
}) {
  if (!row?.day) {
    return null;
  }

  return (
    <div className="chart-tooltip chart-tooltip-inline chart-tooltip-embedded">
      {renderCampaignInlineDayTooltipBody(row.day, row, statusDay, bidKind)}
    </div>
  );
}

const CAMPAIGN_INLINE_STATUS_SLOTS = 4;

export function CampaignInlineOverviewChart({
  campaign,
  statusDays,
  activeWindow: controlledActiveWindow,
  onActiveWindowChange,
  headerAction,
  density = "default",
}: {
  campaign: CampaignSummary;
  statusDays: CampaignOverviewStatusDay[];
  activeWindow?: OverviewWindow;
  onActiveWindowChange?: (value: OverviewWindow) => void;
  headerAction?: ReactNode;
  density?: "default" | "overlay";
}) {
  const isWindowControlled = controlledActiveWindow !== undefined;
  const [internalActiveWindow, setInternalActiveWindow] = useState<OverviewWindow>(resolveOverviewWindow(campaign.daily_exact?.length || statusDays.length || 7));
  const [hiddenSeries, setHiddenSeries] = useState<string[]>([]);
  const [statusOverlayMode, setStatusOverlayMode] = useState<"strip" | "icons">(() => {
    if (typeof window === "undefined") {
      return "strip";
    }
    return window.localStorage.getItem(CAMPAIGN_INLINE_STATUS_VIEW_STORAGE_KEY) === "icons" ? "icons" : "strip";
  });
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);
  const [tooltipAnchorY, setTooltipAnchorY] = useState<number | null>(null);
  const [tooltipPlacement, setTooltipPlacement] = useState<"above" | "below">("above");
  const activeWindowCampaignIdRef = useRef<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const activeWindow = controlledActiveWindow ?? internalActiveWindow;
  const setActiveWindow = onActiveWindowChange ?? setInternalActiveWindow;

  useEffect(() => {
    if (isWindowControlled) {
      return;
    }
    const nextWindow = resolveOverviewWindow(campaign.daily_exact?.length || statusDays.length || 7);
    setInternalActiveWindow((current) => {
      if (activeWindowCampaignIdRef.current !== campaign.id) {
        activeWindowCampaignIdRef.current = campaign.id;
        return nextWindow;
      }
      return current > nextWindow ? nextWindow : current;
    });
  }, [campaign.id, campaign.daily_exact?.length, isWindowControlled, statusDays.length]);

  useEffect(() => {
    setHiddenSeries([]);
  }, [campaign.id]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(CAMPAIGN_INLINE_STATUS_VIEW_STORAGE_KEY, statusOverlayMode);
  }, [statusOverlayMode]);

  useEffect(() => {
    setHoveredDay(null);
    setTooltipAnchorY(null);
  }, [campaign.id, activeWindow]);

  const updateTooltipAnchorFromOffset = (offsetY: number) => {
    const plotHeight = plotRef.current?.getBoundingClientRect().height;
    if (!plotHeight || !Number.isFinite(offsetY)) {
      return;
    }
    const nextY = Math.max(
      CAMPAIGN_INLINE_TOOLTIP_EDGE_PADDING,
      Math.min(offsetY, plotHeight - CAMPAIGN_INLINE_TOOLTIP_EDGE_PADDING),
    );
    setTooltipAnchorY(nextY);
  };

  const updateTooltipAnchorFromClientY = (clientY: number) => {
    const plotRect = plotRef.current?.getBoundingClientRect();
    if (!plotRect) {
      return;
    }
    updateTooltipAnchorFromOffset(clientY - plotRect.top);
  };

  const updateTooltipAnchorFromElement = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    updateTooltipAnchorFromClientY(rect.top + rect.height / 2);
  };

  const bidKind = resolveBidKind(campaign);
  const bidLabel = resolveBidLabel(campaign);
  const isOverlayDensity = density === "overlay";
  const chartRows = useMemo(() => buildCampaignOverviewRows(campaign, statusDays), [campaign, statusDays]);
  const statusDaysByDay = useMemo(() => new Map(statusDays.map((day) => [day.day, day])), [statusDays]);
  const visibleRows = sliceByWindow(chartRows, activeWindow);
  const visibleRowsByDay = useMemo(() => new Map(visibleRows.map((row) => [row.day, row])), [visibleRows]);
  const visibleStatusDays = visibleRows.map((row) => statusDaysByDay.get(row.day) || { day: row.day, label: row.label, entries: [] });
  const visibleStatusHourSlots = useMemo(() => visibleStatusDays.map((day) => buildCampaignStatusHourSlots(day)), [visibleStatusDays]);
  const statusSlotCount = CAMPAIGN_INLINE_STATUS_SLOTS;
  const statusOverlayHeight =
    statusOverlayMode === "strip"
      ? isOverlayDensity
        ? 58
        : 66
      : (isOverlayDensity ? 72 : 86) + Math.max(0, statusSlotCount - 3) * (isOverlayDensity ? 24 : 30);
  const statusDateGap = isOverlayDensity ? 10 : 12;
  const chartBottomReserve = statusOverlayHeight - 18 + statusDateGap;
  const chartHeight = (isOverlayDensity ? 176 : 208) + statusOverlayHeight + statusDateGap;
  const viewsTotal = visibleRows.reduce((sum, row) => sum + (row.views ?? 0), 0);
  const ordersTotal = visibleRows.reduce((sum, row) => sum + (row.orders ?? 0), 0);
  const spendTotal = visibleRows.reduce((sum, row) => sum + (row.spend ?? 0), 0);
  const latestBid = visibleRows[visibleRows.length - 1]?.bid ?? toNumber(campaign.bid);
  const latestDrr = visibleRows[visibleRows.length - 1]?.drr ?? null;
  const ordersLabel = bidKind === "cpc" ? "Заказы CPC" : "Заказы CPM";
  const activeTooltipDay = hoveredDay && visibleRowsByDay.has(hoveredDay) ? hoveredDay : null;
  const activeTooltipRow = activeTooltipDay ? visibleRowsByDay.get(activeTooltipDay) ?? null : null;
  const activeTooltipStatusDay = activeTooltipDay ? statusDaysByDay.get(activeTooltipDay) ?? null : null;
  const activeTooltipIndex = activeTooltipDay ? visibleRows.findIndex((row) => row.day === activeTooltipDay) : -1;
  const activeTooltipAnchorY = tooltipAnchorY ?? 68;
  const activeTooltipAlignClass =
    activeTooltipIndex <= 1
      ? "is-align-start"
      : activeTooltipIndex >= visibleRows.length - 2
        ? "is-align-end"
        : "is-align-center";

  useLayoutEffect(() => {
    if (!activeTooltipRow || tooltipAnchorY === null) {
      return;
    }
    const plotRect = plotRef.current?.getBoundingClientRect();
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    if (!plotRect || !tooltipRect) {
      return;
    }
    const boundaryRect = getTooltipBoundaryRect(plotRef.current, plotRect);
    const anchorViewportY = plotRect.top + tooltipAnchorY;
    const spaceAbove = anchorViewportY - boundaryRect.top - CAMPAIGN_INLINE_TOOLTIP_GAP;
    const spaceBelow = boundaryRect.bottom - anchorViewportY - CAMPAIGN_INLINE_TOOLTIP_GAP;
    const nextPlacement =
      spaceAbove >= tooltipRect.height
        ? "above"
        : spaceBelow >= tooltipRect.height
          ? "below"
          : spaceAbove >= spaceBelow
            ? "above"
            : "below";
    setTooltipPlacement((current) => (current === nextPlacement ? current : nextPlacement));
  }, [activeTooltipRow, tooltipAnchorY, activeTooltipStatusDay, campaign.id, activeWindow]);

  if (!chartRows.length && !statusDays.length) {
    return null;
  }

  return (
    <div
      className={cn(
        "chart-card campaign-inline-chart border-[rgba(98,113,170,0.16)] bg-[linear-gradient(180deg,rgba(240,245,255,0.9),rgba(248,250,255,0.94))]",
        isOverlayDensity && "is-overlay-density",
      )}
    >
      <div className="chart-card-head campaign-inline-chart-head">
        <div className="campaign-inline-chart-title">
          <h4 className="font-display font-semibold text-[var(--color-ink)]">Показы, заказы, расход, ставка, ДРР и статусы</h4>
          <p>{bidLabel} · по дням внутри периода</p>
        </div>
        <div className="campaign-inline-chart-controls">
          <div className="campaign-inline-chart-controls-row">
            <ChartWindowSwitch activeWindow={activeWindow} onChange={setActiveWindow} />
            {headerAction}
          </div>
          <div className="chart-window-switch campaign-status-view-switch">
            <button type="button" onClick={() => setStatusOverlayMode("strip")} className={statusOverlayMode === "strip" ? "chart-window-chip is-active" : "chart-window-chip"}>
              Полоска
            </button>
            <button type="button" onClick={() => setStatusOverlayMode("icons")} className={statusOverlayMode === "icons" ? "chart-window-chip is-active" : "chart-window-chip"}>
              Иконки
            </button>
          </div>
        </div>
      </div>

      <div
        ref={plotRef}
        className="trend-chart campaign-inline-plot"
        style={{ height: `${chartHeight}px` }}
        onMouseLeave={() => {
          setHoveredDay(null);
          setTooltipAnchorY(null);
        }}
      >
        {visibleRows.length ? (
          <>
            <ResponsiveContainer>
              <ComposedChart
                data={visibleRows}
                margin={{ top: 12, right: 0, left: 0, bottom: chartBottomReserve }}
                onMouseMove={(state) => {
                  const nextPayloadRow = (
                    state as unknown as { activePayload?: Array<{ payload?: CampaignOverviewChartRow }> }
                  ).activePayload?.[0]?.payload;
                  const nextTooltipState = state as unknown as {
                    chartY?: number;
                    activeCoordinate?: { y?: number };
                  };
                  const nextIndex = typeof state.activeTooltipIndex === "number" ? state.activeTooltipIndex : null;
                  const nextRow = nextPayloadRow ?? (nextIndex !== null ? visibleRows[nextIndex] : null);
                  setHoveredDay(nextRow?.day ?? null);
                  const nextY =
                    typeof nextTooltipState.chartY === "number"
                      ? nextTooltipState.chartY
                      : typeof nextTooltipState.activeCoordinate?.y === "number"
                        ? nextTooltipState.activeCoordinate.y
                        : null;
                  if (nextY !== null) {
                    updateTooltipAnchorFromOffset(nextY);
                  }
                }}
                onMouseLeave={() => {
                  setHoveredDay(null);
                  setTooltipAnchorY(null);
                }}
              >
              <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={true} horizontal={true} />
              <XAxis
                dataKey="label"
                tick={DATE_TICK_PROPS}
                axisLine={false}
                tickLine={false}
                interval={0}
                minTickGap={0}
                angle={-35}
                height={isOverlayDensity ? 42 : 48}
                textAnchor="end"
              />
              <YAxis
                yAxisId="orders"
                hide
              />
              <YAxis yAxisId="views" hide />
              <YAxis
                yAxisId="bid"
                orientation="right"
                width={CAMPAIGN_INLINE_RIGHT_AXIS_WIDTH}
                tick={{ fill: CHART_TICK, fontSize: 10 }}
                tickMargin={2}
                axisLine={false}
                tickLine={false}
                tickFormatter={(value) => formatNumber(value)}
              />
              <YAxis yAxisId="drr" hide domain={["auto", "auto"]} />
              <YAxis yAxisId="spend" hide domain={["auto", "auto"]} />
              <Tooltip cursor={false} content={() => null} isAnimationActive={false} />
              {!hiddenSeries.includes("views") ? <Bar yAxisId="views" dataKey="views" name="Показы" fill="rgba(117,114,213,0.42)" stroke="rgba(117,114,213,0.56)" radius={[8, 8, 0, 0]} barSize={isOverlayDensity ? 16 : 18} /> : null}
              {!hiddenSeries.includes("orders") ? <Line yAxisId="orders" dataKey="orders" name={ordersLabel} type="monotone" stroke="#14a6a1" strokeWidth={2.6} dot={{ r: 2.5, fill: "#14a6a1" }} activeDot={{ r: 4.5 }} connectNulls /> : null}
              {!hiddenSeries.includes("spend") ? <Line yAxisId="spend" dataKey="spend" name="Расход" type="monotone" stroke="#e05b2a" strokeWidth={2.6} dot={{ r: 2.5, fill: "#e05b2a" }} activeDot={{ r: 4.5 }} connectNulls /> : null}
              {!hiddenSeries.includes("bid") ? <Line yAxisId="bid" dataKey="bid" name={bidLabel} type="monotone" stroke="#4b7bff" strokeWidth={2.6} dot={{ r: 2.5, fill: "#4b7bff" }} activeDot={{ r: 4.5 }} connectNulls /> : null}
              {!hiddenSeries.includes("drr") ? <Line yAxisId="drr" dataKey="drr" name="ДРР" type="monotone" stroke="#f17828" strokeWidth={2.6} dot={{ r: 2.5, fill: "#f17828" }} activeDot={{ r: 4.5 }} connectNulls /> : null}
              </ComposedChart>
            </ResponsiveContainer>

            <div
              className="campaign-inline-hover-grid"
              style={{
                paddingLeft: `${CAMPAIGN_INLINE_LEFT_AXIS_WIDTH}px`,
                paddingRight: `${CAMPAIGN_INLINE_RIGHT_AXIS_WIDTH}px`,
                gridTemplateColumns: `repeat(${Math.max(visibleRows.length, 1)}, minmax(0, 1fr))`,
                bottom: `${chartBottomReserve}px`,
              }}
            >
              {visibleRows.map((row) => (
                <button
                  key={`${campaign.id}-hover-${row.day}`}
                  type="button"
                  className="chart-hover-slice"
                  aria-label={`Показать данные за ${row.day}`}
                  onMouseEnter={(event) => {
                    setHoveredDay(row.day);
                    updateTooltipAnchorFromClientY(event.clientY);
                  }}
                  onMouseMove={(event) => {
                    setHoveredDay(row.day);
                    updateTooltipAnchorFromClientY(event.clientY);
                  }}
                  onFocus={(event) => {
                    setHoveredDay(row.day);
                    updateTooltipAnchorFromElement(event.currentTarget);
                  }}
                  onBlur={() => {
                    setHoveredDay(null);
                    setTooltipAnchorY(null);
                  }}
                />
              ))}
            </div>

            {activeTooltipRow && activeTooltipIndex >= 0 ? (
              <div
                className="campaign-inline-floating-tooltip-layer"
                style={{
                  top: `${Math.round(activeTooltipAnchorY)}px`,
                  paddingLeft: `${CAMPAIGN_INLINE_LEFT_AXIS_WIDTH}px`,
                  paddingRight: `${CAMPAIGN_INLINE_RIGHT_AXIS_WIDTH}px`,
                  gridTemplateColumns: `repeat(${Math.max(visibleRows.length, 1)}, minmax(0, 1fr))`,
                }}
              >
                <div
                  className={cn(
                    "campaign-inline-floating-tooltip-anchor",
                    activeTooltipAlignClass,
                    tooltipPlacement === "below" ? "is-place-below" : "is-place-above",
                  )}
                  style={{ gridColumn: `${activeTooltipIndex + 1} / span 1` }}
                >
                  <div ref={tooltipRef} className="campaign-inline-floating-tooltip">
                    <CampaignInlineOverviewTooltip row={activeTooltipRow} statusDay={activeTooltipStatusDay} bidKind={bidKind} />
                  </div>
                </div>
              </div>
            ) : null}

            <div
              className={cn("chart-status-overlay", statusOverlayMode === "strip" && "is-strip-mode")}
              style={{
                paddingLeft: `${CAMPAIGN_INLINE_LEFT_AXIS_WIDTH}px`,
                paddingRight: `${CAMPAIGN_INLINE_RIGHT_AXIS_WIDTH}px`,
                gridTemplateColumns: `repeat(${Math.max(visibleStatusDays.length, 1)}, minmax(0, 1fr))`,
              }}
            >
              {visibleStatusDays.map((day, dayIndex) => {
                const visibleEntries = day.entries.slice(0, statusSlotCount);
                const hourSlots = visibleStatusHourSlots[dayIndex] || [];
                const tooltipAlignClass =
                  dayIndex <= 1
                    ? "is-align-start"
                    : dayIndex >= visibleStatusDays.length - 2
                      ? "is-align-end"
                      : "is-align-center";

                return (
                  <div
                    key={`${campaign.id}-status-day-${day.day}`}
                    className={cn("chart-status-overlay-column", statusOverlayMode === "strip" && "is-strip-mode")}
                  >
                    {statusOverlayMode === "strip" ? (
                      <div
                        className="chart-status-strip"
                        aria-hidden="true"
                        title={hourSlots.map((slot) => slot.title).join("\n")}
                        style={{ background: buildCampaignStatusStripGradient(hourSlots) }}
                      />
                    ) : (
                      <div
                        className="chart-status-stack"
                        style={{ gridTemplateRows: `repeat(${statusSlotCount}, ${isOverlayDensity ? 20 : 22}px)` }}
                      >
                        {Array.from({ length: statusSlotCount }).map((_, index) => {
                          const entry = visibleEntries[index];
                          return (
                            <span key={`${day.day}-slot-${index}`} className={cn("chart-status-chip-wrap", tooltipAlignClass)}>
                              <span
                                tabIndex={entry ? 0 : -1}
                                aria-label={entry ? buildCampaignStatusTooltipAriaLabel(day.day, entry) : undefined}
                                onMouseEnter={(event) => {
                                  if (entry) {
                                    setHoveredDay(day.day);
                                    updateTooltipAnchorFromElement(event.currentTarget);
                                  }
                                }}
                                onMouseMove={(event) => {
                                  if (entry) {
                                    setHoveredDay(day.day);
                                    updateTooltipAnchorFromElement(event.currentTarget);
                                  }
                                }}
                                onFocus={(event) => {
                                  if (entry) {
                                    setHoveredDay(day.day);
                                    updateTooltipAnchorFromElement(event.currentTarget);
                                  }
                                }}
                                onBlur={() => {
                                  setHoveredDay(null);
                                  setTooltipAnchorY(null);
                                }}
                                className={cn(
                                  "chart-status-chip",
                                  entry && "is-active",
                                  entry && `status-${entry.key}`,
                                )}
                              >
                                {entry ? <CampaignStatusDayGlyph statusKey={entry.key} /> : null}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">Нет дневных данных для графика.</div>
        )}
      </div>

      <ChartLegend
        items={[
          { key: "views", label: "Показы", value: formatCompactNumber(viewsTotal), color: "#7572d5", active: !hiddenSeries.includes("views"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "views")) },
          { key: "orders", label: ordersLabel, value: formatNumber(ordersTotal), color: "#14a6a1", active: !hiddenSeries.includes("orders"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "orders")) },
          { key: "spend", label: "Расход", value: formatMoney(spendTotal, true), color: "#e05b2a", active: !hiddenSeries.includes("spend"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "spend")) },
          { key: "bid", label: bidLabel, value: formatBidMoney(latestBid, bidKind), color: "#4b7bff", active: !hiddenSeries.includes("bid"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "bid")) },
          { key: "drr", label: "ДРР", value: formatPercent(latestDrr), color: "#f17828", active: !hiddenSeries.includes("drr"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "drr")) },
          { key: "status-active", label: "Активна", color: "#3e9d69", active: true },
          { key: "status-freeze", label: "Заморожена", color: "#4b7bff", active: true },
          { key: "status-paused", label: "Приостановлена", color: "#8b64f6", active: true },
        ]}
      />
    </div>
  );
}

function buildClusterTrendRows(product: ProductSummary) {
  const byDay = new Map<
    string,
    {
      day: string;
      label: string;
      views: number;
      clicks: number;
      posSum: number;
      posCount: number;
      top1: number;
      top2: number;
      top3: number;
    }
  >();

  product.campaigns.forEach((campaign) => {
    campaign.clusters.items.forEach((cluster) => {
      Object.entries(cluster.daily || {}).forEach(([day, row]) => {
        const current = byDay.get(day) ?? {
          day,
          label: formatDayLabel(day),
          views: 0,
          clicks: 0,
          posSum: 0,
          posCount: 0,
          top1: 0,
          top2: 0,
          top3: 0,
        };
        current.views += toNumber(row.views) ?? 0;
        current.clicks += toNumber(row.clicks) ?? 0;

        const position = toNumber(row.rates_promo_pos) ?? toNumber(row.org_pos);
        if (position !== null && position > 0) {
          current.posSum += position;
          current.posCount += 1;
          const rounded = Math.round(position);
          if (rounded === 1) {
            current.top1 += 1;
          } else if (rounded === 2) {
            current.top2 += 1;
          } else if (rounded === 3) {
            current.top3 += 1;
          }
        }

        byDay.set(day, current);
      });
    });
  });

  return [...byDay.values()]
    .sort((left, right) => left.day.localeCompare(right.day))
    .map((row) => ({
      label: row.label,
      ctr: computeRate(row.clicks, row.views),
      avgPosition: row.posCount ? row.posSum / row.posCount : null,
      top1: row.top1,
      top2: row.top2,
      top3: row.top3,
    }));
}

export function DailyPerformanceChart({ rows }: { rows: DailyStat[] }) {
  const [hiddenSeries, setHiddenSeries] = useState<string[]>([]);
  const chartRows = rows.map((row) => ({
    label: row.day_label || formatFullDayLabel(row.day),
    views: toNumber(row.views) ?? 0,
    clicks: toNumber(row.clicks) ?? 0,
    spend: toNumber(row.expense_sum) ?? 0,
    orders: toNumber(row.orders) ?? 0,
    ctr: toNumber(row.CTR) ?? 0,
    drr: toNumber(row.DRR) ?? computeDrr(toNumber(row.expense_sum), toNumber(row.sum_price)) ?? 0,
  }));
  const dailyTooltipConfigs: OverviewTooltipMetricConfig[] = [
    { key: "views", label: "Показы", color: "#4b7bff", formatter: (value) => formatCompactNumber(value) },
    { key: "clicks", label: "Клики", color: "#3f8d7b", formatter: (value) => formatNumber(value) },
    { key: "spend", label: "Расход", color: "#f17828", formatter: (value) => formatMoney(value, true) },
    { key: "orders", label: "Заказы", color: "#8b64f6", formatter: (value) => formatNumber(value) },
    { key: "drr", label: "ДРР", color: "#ff6b8a", formatter: (value) => formatPercent(value) },
  ];
  const drrAxisMax = Math.max(10, ...chartRows.map((row) => row.drr ?? 0));
  const drrDomainMax = Math.ceil(drrAxisMax / 10) * 10;

  return (
    <div className="w-full">
      <div className="h-96 w-full">
        <ResponsiveContainer>
          <ComposedChart data={chartRows} margin={{ top: 8, right: 24, left: 0, bottom: 10 }}>
            <CartesianGrid stroke={CHART_GRID} vertical={false} />
            <XAxis
              dataKey="label"
              tick={DATE_TICK_PROPS}
              axisLine={false}
              tickLine={false}
              interval={0}
              minTickGap={0}
              angle={-35}
              height={58}
              textAnchor="end"
            />
            <YAxis yAxisId="traffic" tick={{ fill: CHART_TICK, fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(value) => formatCompactNumber(value)} />
            <YAxis yAxisId="money" orientation="right" tick={{ fill: CHART_TICK, fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(value) => formatCompactNumber(value)} />
            <YAxis yAxisId="ratio" hide orientation="right" domain={[0, drrDomainMax]} />
            <Tooltip content={(props) => <ProductOverviewTooltip {...props} configs={dailyTooltipConfigs} />} />
            {!hiddenSeries.includes("views") ? <Bar yAxisId="traffic" dataKey="views" name="Показы" fill="rgba(75,123,255,0.28)" radius={[12, 12, 0, 0]} /> : null}
            {!hiddenSeries.includes("clicks") ? <Line yAxisId="traffic" dataKey="clicks" name="Клики" type="monotone" stroke="#3f8d7b" strokeWidth={3} dot={false} /> : null}
            {!hiddenSeries.includes("spend") ? <Area yAxisId="money" dataKey="spend" name="Расход" type="monotone" stroke="#f17828" fill="rgba(255,157,92,0.2)" strokeWidth={2.4} /> : null}
            {!hiddenSeries.includes("orders") ? <Line yAxisId="money" dataKey="orders" name="Заказы" type="monotone" stroke="#8b64f6" strokeWidth={2.4} dot={{ r: 3, fill: "#8b64f6" }} /> : null}
            {!hiddenSeries.includes("drr") ? <Line yAxisId="ratio" dataKey="drr" name="ДРР" type="monotone" stroke="#ff6b8a" strokeWidth={2.2} dot={{ r: 3, fill: "#ff6b8a" }} activeDot={{ r: 4.2 }} /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ChartLegend
        items={[
          { key: "views", label: "Показы", color: "#4b7bff", active: !hiddenSeries.includes("views"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "views")) },
          { key: "clicks", label: "Клики", color: "#3f8d7b", active: !hiddenSeries.includes("clicks"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "clicks")) },
          { key: "spend", label: "Расход", color: "#f17828", active: !hiddenSeries.includes("spend"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "spend")) },
          { key: "orders", label: "Заказы", color: "#8b64f6", active: !hiddenSeries.includes("orders"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "orders")) },
          { key: "drr", label: "ДРР", color: "#ff6b8a", active: !hiddenSeries.includes("drr"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "drr")) },
        ]}
      />
    </div>
  );
}

export function CampaignPerformanceChart({ campaigns }: { campaigns: CampaignSummary[] }) {
  const [hiddenSeries, setHiddenSeries] = useState<string[]>([]);
  const rows = campaigns.map((campaign) => ({
    name: campaign.name.length > 22 ? `${campaign.name.slice(0, 22)}…` : campaign.name,
    spend: toNumber(campaign.metrics.sum) ?? 0,
    clicks: toNumber(campaign.metrics.clicks) ?? 0,
    orders: toNumber(campaign.metrics.orders) ?? 0,
    cpc: toNumber(campaign.metrics.cpc) ?? 0,
  }));

  return (
    <div className="w-full">
      <div className="h-80 w-full">
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid stroke={CHART_GRID} vertical={false} />
            <XAxis dataKey="name" tick={{ fill: CHART_TICK, fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="money" tick={{ fill: CHART_TICK, fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="count" orientation="right" tick={{ fill: CHART_TICK, fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip formatter={chartTooltipFormatter} contentStyle={CHART_TOOLTIP} />
            {!hiddenSeries.includes("spend") ? <Bar yAxisId="money" dataKey="spend" name="Расход" fill="rgba(241,120,40,0.36)" radius={[12, 12, 0, 0]} /> : null}
            {!hiddenSeries.includes("clicks") ? <Line yAxisId="count" type="monotone" dataKey="clicks" name="Клики" stroke="#4b7bff" strokeWidth={2.4} /> : null}
            {!hiddenSeries.includes("orders") ? <Line yAxisId="count" type="monotone" dataKey="orders" name="Заказы" stroke="#3e9d69" strokeWidth={2.4} /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ChartLegend
        items={[
          { key: "spend", label: "Расход", color: "#f17828", active: !hiddenSeries.includes("spend"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "spend")) },
          { key: "clicks", label: "Клики", color: "#4b7bff", active: !hiddenSeries.includes("clicks"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "clicks")) },
          { key: "orders", label: "Заказы", color: "#3e9d69", active: !hiddenSeries.includes("orders"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "orders")) },
        ]}
      />
    </div>
  );
}

export function HourlyPerformanceChart({
  heatmap,
  ordersHeatmap,
}: {
  heatmap: HeatmapPayload;
  ordersHeatmap: OrdersHeatmapPayload;
}) {
  const [hiddenSeries, setHiddenSeries] = useState<string[]>([]);
  const ordersMap = new Map(ordersHeatmap.by_hour.map((row) => [row.hour, row.orders]));
  const rows = heatmap.by_hour.map((row) => ({
    hour: `${row.hour}:00`,
    views: row.views,
    clicks: row.clicks,
    spent: row.spent,
    ctr: row.CTR,
    orders: ordersMap.get(row.hour) ?? 0,
    cr: computeRate(ordersMap.get(row.hour) ?? 0, row.views),
  }));
  const hourlyTooltipConfigs: OverviewTooltipMetricConfig[] = [
    { key: "views", label: "Показы", color: "#4b7bff", formatter: (value) => formatCompactNumber(value) },
    { key: "spent", label: "Расход", color: "#f17828", formatter: (value) => formatMoney(value, true) },
    { key: "orders", label: "Заказы", color: "#8b64f6", formatter: (value) => formatNumber(value) },
    { key: "cr", label: "CR", color: "#2ea36f", formatter: (value) => formatPercent(value) },
  ];
  const crAxisMax = Math.max(10, ...rows.map((row) => row.cr ?? 0));
  const crDomainMax = Math.ceil(crAxisMax / 10) * 10;

  return (
    <div className="w-full">
      <div className="h-96 w-full">
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 8, right: 18, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={CHART_GRID} vertical={false} />
            <XAxis dataKey="hour" tick={{ fill: CHART_TICK, fontSize: 12 }} axisLine={false} tickLine={false} interval={1} angle={-35} height={56} textAnchor="end" />
            <YAxis yAxisId="traffic" tick={{ fill: CHART_TICK, fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(value) => formatCompactNumber(value)} />
            <YAxis yAxisId="money" orientation="right" tick={{ fill: CHART_TICK, fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(value) => formatCompactNumber(value)} />
            <YAxis yAxisId="ratio" hide orientation="right" domain={[0, crDomainMax]} />
            <Tooltip content={(props) => <ProductOverviewTooltip {...props} configs={hourlyTooltipConfigs} />} />
            {!hiddenSeries.includes("views") ? <Area yAxisId="traffic" dataKey="views" name="Показы" type="monotone" stroke="#4b7bff" fill="rgba(75,123,255,0.16)" strokeWidth={2} /> : null}
            {!hiddenSeries.includes("spent") ? <Bar yAxisId="money" dataKey="spent" name="Расход" fill="rgba(241,120,40,0.32)" radius={[10, 10, 0, 0]} /> : null}
            {!hiddenSeries.includes("orders") ? <Line yAxisId="traffic" dataKey="orders" name="Заказы" type="monotone" stroke="#8b64f6" strokeWidth={2.2} dot={false} /> : null}
            {!hiddenSeries.includes("cr") ? <Line yAxisId="ratio" dataKey="cr" name="CR" type="monotone" stroke="#2ea36f" strokeWidth={2.2} strokeDasharray="6 5" dot={{ r: 2.6, fill: "#2ea36f" }} activeDot={{ r: 4.2 }} connectNulls /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ChartLegend
        items={[
          { key: "views", label: "Показы", color: "#4b7bff", active: !hiddenSeries.includes("views"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "views")) },
          { key: "spent", label: "Расход", color: "#f17828", active: !hiddenSeries.includes("spent"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "spent")) },
          { key: "orders", label: "Заказы", color: "#8b64f6", active: !hiddenSeries.includes("orders"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "orders")) },
          { key: "cr", label: "CR", color: "#2ea36f", active: !hiddenSeries.includes("cr"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "cr")) },
        ]}
      />
    </div>
  );
}

export function ClusterDailyChart({
  daily,
  productAverageCheck,
}: {
  daily: Record<string, ClusterDailyRow>;
  productAverageCheck?: number | null;
}) {
  const [hiddenSeries, setHiddenSeries] = useState<string[]>([]);
  const computeClusterOrdersDrrValue = (
    expense: number | null | undefined,
    orders: number | null | undefined,
    productAverageCheck: number | null | undefined,
  ) => {
    const spend = toNumber(expense);
    const ordersAds = toNumber(orders);
    const averageCheck = toNumber(productAverageCheck);
    if (spend === null || ordersAds === null || ordersAds <= 0 || averageCheck === null || averageCheck <= 0) {
      return null;
    }
    return (spend / (averageCheck * ordersAds)) * 100;
  };
  const rows = Object.entries(daily)
    .map(([day, row]) => ({
      rawDay: day,
      day: new Date(`${day}T00:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" }),
      pos: toNumber(row.rates_promo_pos ?? row.org_pos),
      views: toNumber(row.views) ?? 0,
      clicks: toNumber(row.clicks) ?? 0,
      baskets: toNumber(row.basket) ?? 0,
      orders: toNumber(row.orders) ?? 0,
      spend: toNumber(row.expense) ?? 0,
      drr: computeClusterOrdersDrrValue(row.expense ?? null, row.orders ?? null, productAverageCheck),
    }))
    .sort((left, right) => left.rawDay.localeCompare(right.rawDay));
  const clusterTooltipConfigs: OverviewTooltipMetricConfig[] = [
    { key: "pos", label: "Позиция", color: "#8b64f6", formatter: (value) => formatNumber(value) },
    { key: "views", label: "Показы", color: "#4b7bff", formatter: (value) => formatCompactNumber(value) },
    { key: "clicks", label: "Клики", color: "#3f8d7b", formatter: (value) => formatNumber(value) },
    { key: "baskets", label: "Корзины", color: "#14a6a1", formatter: (value) => formatNumber(value) },
    { key: "orders", label: "Заказы", color: "#4ba66f", formatter: (value) => formatNumber(value) },
    { key: "spend", label: "Расход", color: "#f17828", formatter: (value) => formatMoney(value, true) },
    { key: "drr", label: "ДРР (РК Заказы)", color: "#ff6b8a", formatter: (value) => formatPercent(value) },
  ];
  const positionAxisMax = Math.max(1, ...rows.map((row) => row.pos ?? 0));
  const drrAxisMax = Math.max(10, ...rows.map((row) => row.drr ?? 0));
  const drrDomainMax = Math.ceil(drrAxisMax / 10) * 10;

  return (
    <div className="w-full">
      <div className="h-72 w-full">
        <ResponsiveContainer>
          <ComposedChart data={rows}>
            <CartesianGrid stroke={CHART_GRID} vertical={false} />
            <XAxis dataKey="day" tick={DATE_TICK_PROPS} axisLine={false} tickLine={false} interval={0} minTickGap={0} angle={-35} height={58} textAnchor="end" />
            <YAxis yAxisId="traffic" tick={{ fill: CHART_TICK, fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(value) => formatCompactNumber(value)} />
            <YAxis yAxisId="money" hide orientation="right" />
            <YAxis yAxisId="position" orientation="right" reversed domain={[positionAxisMax, 1]} tick={{ fill: CHART_TICK, fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="ratio" hide orientation="right" domain={[0, drrDomainMax]} />
            <Tooltip content={(props) => <ProductOverviewTooltip {...props} configs={clusterTooltipConfigs} />} />
            {!hiddenSeries.includes("views") ? <Bar yAxisId="traffic" dataKey="views" name="Показы" fill="rgba(75,123,255,0.28)" radius={[10, 10, 0, 0]} /> : null}
            {!hiddenSeries.includes("clicks") ? <Line yAxisId="traffic" dataKey="clicks" name="Клики" stroke="#3f8d7b" strokeWidth={2.4} dot={false} /> : null}
            {!hiddenSeries.includes("baskets") ? <Line yAxisId="traffic" dataKey="baskets" name="Корзины" stroke="#14a6a1" strokeWidth={2.4} dot={{ r: 2.5, fill: "#14a6a1" }} activeDot={{ r: 4 }} /> : null}
            {!hiddenSeries.includes("orders") ? <Line yAxisId="traffic" dataKey="orders" name="Заказы" stroke="#4ba66f" strokeWidth={2.4} dot={{ r: 2.5, fill: "#4ba66f" }} activeDot={{ r: 4 }} /> : null}
            {!hiddenSeries.includes("spend") ? <Area yAxisId="money" dataKey="spend" name="Расход" stroke="#f17828" fill="rgba(255,157,92,0.2)" strokeWidth={2} /> : null}
            {!hiddenSeries.includes("drr") ? <Line yAxisId="ratio" dataKey="drr" name="ДРР" stroke="#ff6b8a" strokeWidth={2.2} dot={{ r: 2.5, fill: "#ff6b8a" }} activeDot={{ r: 4 }} connectNulls /> : null}
            {!hiddenSeries.includes("pos") ? <Line yAxisId="position" dataKey="pos" name="Позиция" stroke="#8b64f6" strokeWidth={2.2} dot={{ r: 3.2, fill: "#ffffff", stroke: "#8b64f6", strokeWidth: 2 }} activeDot={{ r: 4.8, fill: "#ffffff", stroke: "#8b64f6", strokeWidth: 2 }} connectNulls /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ChartLegend
        items={[
          { key: "pos", label: "Позиция", color: "#8b64f6", active: !hiddenSeries.includes("pos"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "pos")) },
          { key: "views", label: "Показы", color: "#4b7bff", active: !hiddenSeries.includes("views"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "views")) },
          { key: "clicks", label: "Клики", color: "#3f8d7b", active: !hiddenSeries.includes("clicks"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "clicks")) },
          { key: "baskets", label: "Корзины", color: "#14a6a1", active: !hiddenSeries.includes("baskets"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "baskets")) },
          { key: "orders", label: "Заказы", color: "#4ba66f", active: !hiddenSeries.includes("orders"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "orders")) },
          { key: "spend", label: "Расход", color: "#f17828", active: !hiddenSeries.includes("spend"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "spend")) },
          { key: "drr", label: "ДРР (РК Заказы)", color: "#ff6b8a", active: !hiddenSeries.includes("drr"), onToggle: () => setHiddenSeries((current) => toggleLegendKey(current, "drr")) },
        ]}
      />
    </div>
  );
}

export function ProductOverviewCharts({
  product,
  activeWindow: controlledActiveWindow,
  onActiveWindowChange,
  layout = "inline",
  onOpenOverlay,
}: {
  product: ProductSummary;
  activeWindow?: OverviewWindow;
  onActiveWindowChange?: (value: OverviewWindow) => void;
  layout?: "inline" | "overlay";
  onOpenOverlay?: (() => void) | null;
}) {
  const isWindowControlled = controlledActiveWindow !== undefined;
  const [internalActiveWindow, setInternalActiveWindow] = useState<OverviewWindow>(resolveOverviewWindow(product.period.span_days));
  const [hiddenSpendSeries, setHiddenSpendSeries] = useState<string[]>([]);
  const [hiddenTrafficSeries, setHiddenTrafficSeries] = useState<string[]>([]);
  const [hiddenBasketOrderSeries, setHiddenBasketOrderSeries] = useState<string[]>([]);
  const [hiddenStockSeries, setHiddenStockSeries] = useState<string[]>([]);
  const [hiddenEfficiencySeries, setHiddenEfficiencySeries] = useState<string[]>([]);
  const [hiddenClusterSeries, setHiddenClusterSeries] = useState<string[]>([]);
  const activeWindowProductKeyRef = useRef<string | null>(null);
  const activeWindow = controlledActiveWindow ?? internalActiveWindow;
  const setActiveWindow = onActiveWindowChange ?? setInternalActiveWindow;
  const overviewSyncId = `product-overview-${layout}-${product.article}`;
  const isOverlayLayout = layout === "overlay";
  const chartHeightClass = isOverlayLayout ? "h-[280px]" : "h-[212px]";

  useEffect(() => {
    if (isWindowControlled) {
      return;
    }
    const nextWindow = resolveOverviewWindow(product.period.span_days);
    const productWindowKey = `${product.article}:${product.period.current_end || ""}`;
    let resolvedWindow = activeWindow;
    if (activeWindowProductKeyRef.current !== productWindowKey) {
      activeWindowProductKeyRef.current = productWindowKey;
      resolvedWindow = nextWindow;
    } else if (activeWindow > nextWindow) {
      resolvedWindow = nextWindow;
    }
    if (resolvedWindow !== activeWindow) {
      setActiveWindow(resolvedWindow);
    }
  }, [activeWindow, isWindowControlled, product.article, product.period.current_start, product.period.current_end, product.period.span_days, setActiveWindow]);

  useEffect(() => {
    setHiddenSpendSeries([]);
    setHiddenTrafficSeries([]);
    setHiddenBasketOrderSeries([]);
    setHiddenStockSeries([]);
    setHiddenEfficiencySeries([]);
    setHiddenClusterSeries([]);
  }, [product.article]);

  const visibleDailyRows = sliceByWindow(sortDailyRows(product.daily_stats), activeWindow);
  const spendRows = visibleDailyRows.map((row) => ({
    label: formatDayLabel(row.day),
    spend: toNumber(row.expense_sum) ?? 0,
    ordersAds: toNumber(row.orders) ?? 0,
    totalOrders: toNumber(row.ordered_total) ?? 0,
    adsShare: computeRate(toNumber(row.orders), toNumber(row.ordered_total)) ?? 0,
    drr: toNumber(row.DRR) ?? computeDrr(toNumber(row.expense_sum), toNumber(row.sum_price)) ?? 0,
    revenueAds: toNumber(row.sum_price) ?? 0,
  }));
  const trafficRows = visibleDailyRows.map((row) => ({
    label: formatDayLabel(row.day),
    views: toNumber(row.views) ?? 0,
    clicks: toNumber(row.clicks) ?? 0,
    atbs: toNumber(row.atbs) ?? 0,
  }));
  const basketOrderRows = visibleDailyRows.map((row) => ({
    label: formatDayLabel(row.day),
    atbs: toNumber(row.atbs) ?? 0,
    ordersAds: toNumber(row.orders) ?? 0,
  }));
  const stockRows = visibleDailyRows.map((row) => ({
    label: formatDayLabel(row.day),
    avgStock: toNumber(row.avg_stock),
  }));
  const campaignTypeContribution = useMemo(() => {
    const dayRows = visibleDailyRows.map((row) => ({
      day: row.day,
      label: formatDayLabel(row.day),
    }));
    const dayLookup = new Map(dayRows.map((row) => [row.day, row]));
    const typesMap = new Map<string, CampaignTypeContributionType>();
    const metricMaps = {
      views: new Map<string, Record<string, number>>(),
      clicks: new Map<string, Record<string, number>>(),
      atbs: new Map<string, Record<string, number>>(),
      orders: new Map<string, Record<string, number>>(),
      spend: new Map<string, Record<string, number>>(),
      revenue: new Map<string, Record<string, number>>(),
    } satisfies Record<CampaignTypeContributionMetricKey, Map<string, Record<string, number>>>;

    dayRows.forEach((row) => {
      (Object.keys(metricMaps) as CampaignTypeContributionMetricKey[]).forEach((metricKey) => {
        metricMaps[metricKey].set(row.day, {});
      });
    });

    product.campaigns.forEach((campaign) => {
      const type = resolveCampaignTypeContributionType(campaign);
      typesMap.set(type.key, type);
      (campaign.daily_exact || []).forEach((row) => {
        if (!dayLookup.has(row.day)) {
          return;
        }
        const viewsBucket = metricMaps.views.get(row.day);
        const clicksBucket = metricMaps.clicks.get(row.day);
        const atbsBucket = metricMaps.atbs.get(row.day);
        const ordersBucket = metricMaps.orders.get(row.day);
        const spendBucket = metricMaps.spend.get(row.day);
        const revenueBucket = metricMaps.revenue.get(row.day);
        if (!viewsBucket || !clicksBucket || !atbsBucket || !ordersBucket || !spendBucket || !revenueBucket) {
          return;
        }
        viewsBucket[type.key] = (viewsBucket[type.key] ?? 0) + (toNumber(row.views) ?? 0);
        clicksBucket[type.key] = (clicksBucket[type.key] ?? 0) + (toNumber(row.clicks) ?? 0);
        atbsBucket[type.key] = (atbsBucket[type.key] ?? 0) + (toNumber(row.atbs) ?? 0);
        ordersBucket[type.key] = (ordersBucket[type.key] ?? 0) + (toNumber(row.orders) ?? 0);
        spendBucket[type.key] = (spendBucket[type.key] ?? 0) + (toNumber(row.expense_sum) ?? 0);
        revenueBucket[type.key] = (revenueBucket[type.key] ?? 0) + (toNumber(row.sum_price) ?? 0);
      });
    });

    const types = [...typesMap.values()].sort((left, right) => left.order - right.order);
    const rowsByMetric = (Object.keys(metricMaps) as CampaignTypeContributionMetricKey[]).reduce(
      (acc, metricKey) => {
        acc[metricKey] = dayRows.map((dayRow) => {
          const values = metricMaps[metricKey].get(dayRow.day) ?? {};
          const total = types.reduce((sum, type) => sum + (toNumber(values[type.key]) ?? 0), 0);
          const typeValues = Object.fromEntries(
            types.map((type) => [type.key, toNumber(values[type.key]) ?? 0]),
          );
          return {
            day: dayRow.day,
            label: dayRow.label,
            total,
            ...typeValues,
          };
        });
        return acc;
      },
      {} as Record<CampaignTypeContributionMetricKey, CampaignTypeContributionRow[]>,
    );
    const totalsByMetric = (Object.keys(metricMaps) as CampaignTypeContributionMetricKey[]).reduce(
      (acc, metricKey) => {
        acc[metricKey] = Object.fromEntries(
          types.map((type) => [
            type.key,
            rowsByMetric[metricKey].reduce((sum, row) => sum + (toNumber(row[type.key]) ?? 0), 0),
          ]),
        );
        return acc;
      },
      {} as Record<CampaignTypeContributionMetricKey, Record<string, number>>,
    );
    const totalsByType = types.reduce<Record<string, CampaignTypeContributionTypeTotals>>((acc, type) => {
      acc[type.key] = {
        views: totalsByMetric.views[type.key] ?? 0,
        clicks: totalsByMetric.clicks[type.key] ?? 0,
        atbs: totalsByMetric.atbs[type.key] ?? 0,
        orders: totalsByMetric.orders[type.key] ?? 0,
        spend: totalsByMetric.spend[type.key] ?? 0,
        revenue: totalsByMetric.revenue[type.key] ?? 0,
      };
      return acc;
    }, {});

    return { types, rowsByMetric, totalsByMetric, totalsByType };
  }, [product.campaigns, visibleDailyRows]);
  const efficiencyRows = visibleDailyRows.map((row) => {
    const clicks = toNumber(row.clicks);
    const atbs = toNumber(row.atbs);
    const orders = toNumber(row.orders);
    const totalOrders = toNumber(row.ordered_total);
    return {
      label: formatDayLabel(row.day),
      ctr: toNumber(row.CTR) ?? computeRate(clicks, toNumber(row.views)),
      cr1: computeRate(atbs, clicks),
      cr2: computeRate(orders, atbs),
      crf: toNumber(row.CR) ?? computeRate(totalOrders, clicks),
    };
  });
  const clusterRows = sliceByWindow(buildClusterTrendRows(product), activeWindow);

  const spendTotal = spendRows.reduce((sum, row) => sum + row.spend, 0);
  const ordersAdsTotal = spendRows.reduce((sum, row) => sum + row.ordersAds, 0);
  const totalOrdersTotal = spendRows.reduce((sum, row) => sum + row.totalOrders, 0);
  const revenueAdsTotal = spendRows.reduce((sum, row) => sum + row.revenueAds, 0);
  const adsShareTotal = computeRate(ordersAdsTotal, totalOrdersTotal);
  const drrTotal = computeDrr(spendTotal, revenueAdsTotal);
  const spendPercentAxisMax = Math.max(
    100,
    ...spendRows.flatMap((row) => [row.adsShare ?? 0, row.drr ?? 0]),
  );
  const spendPercentDomainMax = Math.ceil(spendPercentAxisMax / 10) * 10;
  const trafficTotals = trafficRows.reduce(
    (totals, row) => ({
      views: totals.views + row.views,
      clicks: totals.clicks + row.clicks,
      atbs: totals.atbs + row.atbs,
    }),
    { views: 0, clicks: 0, atbs: 0 },
  );
  const basketOrderTotals = basketOrderRows.reduce(
    (totals, row) => ({
      atbs: totals.atbs + row.atbs,
      ordersAds: totals.ordersAds + row.ordersAds,
    }),
    { atbs: 0, ordersAds: 0 },
  );
  const stockValues = stockRows
    .map((row) => row.avgStock)
    .filter((value): value is number => value !== null && value !== undefined);
  const latestStock = [...stockRows].reverse().find((row) => row.avgStock !== null && row.avgStock !== undefined)?.avgStock ?? null;
  const averageStock = stockValues.length ? stockValues.reduce((sum, value) => sum + value, 0) / stockValues.length : null;
  const latestEfficiency = efficiencyRows[efficiencyRows.length - 1] ?? null;
  const latestCluster = clusterRows[clusterRows.length - 1] ?? null;
  const clusterTotals = clusterRows.reduce(
    (totals, row) => ({
      top1: totals.top1 + row.top1,
      top2: totals.top2 + row.top2,
      top3: totals.top3 + row.top3,
    }),
    { top1: 0, top2: 0, top3: 0 },
  );
  const visibleEfficiencyKeys = ["ctr", "cr1", "cr2", "crf"].filter((key) => !hiddenEfficiencySeries.includes(key));
  const efficiencyItems = [
    { key: "ctr", label: "CTR", color: "#2ea36f", value: latestEfficiency?.ctr },
    { key: "cr1", label: "CR1", color: "#2998df", value: latestEfficiency?.cr1 },
    { key: "cr2", label: "CR2", color: "#8b64f6", value: latestEfficiency?.cr2 },
    { key: "crf", label: "CRF", color: "#f17828", value: latestEfficiency?.crf },
  ] as const;
  const spendTooltipConfigs: OverviewTooltipMetricConfig[] = [
    { key: "adsShare", label: "Доля заказов с РК", color: "#8b64f6", formatter: (value) => formatPercent(value) },
    { key: "drr", label: "ДРР", color: "#ff6b8a", formatter: (value) => formatPercent(value) },
    { key: "totalOrders", label: "Заказы всего", color: "#8b93aa", formatter: (value) => formatNumber(value) },
    { key: "ordersAds", label: "Заказы с РК", color: "#4ba66f", formatter: (value) => formatNumber(value) },
    { key: "spend", label: "Расход", color: "#f17828", formatter: (value) => formatMoney(value, true) },
  ];
  const trafficTooltipConfigs: OverviewTooltipMetricConfig[] = [
    { key: "views", label: "Показы", color: "#4b7bff", formatter: (value) => formatCompactNumber(value) },
    { key: "clicks", label: "Клики", color: "#7e5cef", formatter: (value) => formatNumber(value) },
    { key: "atbs", label: "Корзины", color: "#2ea36f", formatter: (value) => formatNumber(value) },
  ];
  const basketOrderTooltipConfigs: OverviewTooltipMetricConfig[] = [
    { key: "atbs", label: "Корзины с РК", color: "#14a6a1", formatter: (value) => formatNumber(value) },
    { key: "ordersAds", label: "Заказы с РК", color: "#4ba66f", formatter: (value) => formatNumber(value) },
  ];
  const campaignTypeContributionTableMetrics = CAMPAIGN_TYPE_CONTRIBUTION_TABLE_METRICS.map((metric) => {
    const maxValue = Math.max(
      0,
      ...campaignTypeContribution.types.map((type) =>
        metric.getValue(campaignTypeContribution.totalsByType[type.key] ?? EMPTY_CAMPAIGN_TYPE_TOTALS) ?? 0,
      ),
    );
    return { ...metric, maxValue };
  });
  const stockTooltipConfigs: OverviewTooltipMetricConfig[] = [
    { key: "avgStock", label: "Средний остаток", color: "#2ea36f", formatter: (value) => `${formatNumber(value)} шт` },
  ];
  const efficiencyTooltipConfigs: OverviewTooltipMetricConfig[] = [
    { key: "ctr", label: "CTR", color: "#2ea36f", formatter: (value) => formatPercent(value) },
    { key: "cr1", label: "CR1", color: "#2998df", formatter: (value) => formatPercent(value) },
    { key: "cr2", label: "CR2", color: "#8b64f6", formatter: (value) => formatPercent(value) },
    { key: "crf", label: "CRF", color: "#f17828", formatter: (value) => formatPercent(value) },
  ];
  const clusterTooltipConfigs: OverviewTooltipMetricConfig[] = [
    { key: "ctr", label: "CTR кластеров", color: "#2ea36f", formatter: (value) => formatPercent(value) },
    { key: "avgPosition", label: "Ср. позиция", color: "#7f8ba3", formatter: (value) => formatNumber(value) },
    { key: "top1", label: "Топ-1 поз.", color: "#6949f6", formatter: (value) => formatNumber(value) },
    { key: "top2", label: "Топ-2 поз.", color: "#8f74fb", formatter: (value) => formatNumber(value) },
    { key: "top3", label: "Топ-3 поз.", color: "#baa9ff", formatter: (value) => formatNumber(value) },
  ];

  return (
    <div className={cn("product-overview-charts-grid grid gap-3", isOverlayLayout ? "grid-cols-1 lg:grid-cols-2" : "xl:grid-cols-4")}>
      <div className="chart-card border-[rgba(241,120,40,0.16)] bg-[linear-gradient(180deg,rgba(255,245,230,0.96),rgba(255,249,240,0.92))]">
        <div className="chart-card-head">
          <div>
            <h4 className="font-display font-semibold text-[var(--color-ink)]">Расход и заказы</h4>
          </div>
          <div className="flex items-center gap-2">
            {!isOverlayLayout && onOpenOverlay ? (
              <button
                type="button"
                onClick={onOpenOverlay}
                aria-label="Развернуть графики"
                className="chart-expand-button"
              >
                <Maximize2 className="size-4" />
              </button>
            ) : null}
            <ChartWindowSwitch activeWindow={activeWindow} onChange={setActiveWindow} />
          </div>
        </div>
        <div className={cn("trend-chart", chartHeightClass)}>
          <ResponsiveContainer>
            <ComposedChart data={spendRows} margin={{ top: 12, right: 10, left: 6, bottom: 8 }} syncId={overviewSyncId} syncMethod="value">
              <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={true} horizontal={false} />
              <XAxis
                dataKey="label"
                tick={DATE_TICK_PROPS}
                axisLine={false}
                tickLine={false}
                interval={0}
                minTickGap={0}
                angle={-35}
                height={48}
                textAnchor="end"
              />
              <YAxis yAxisId="orders" hide />
              <YAxis yAxisId="spend" hide orientation="right" />
              <YAxis yAxisId="share" hide orientation="right" domain={[0, spendPercentDomainMax]} />
              <Tooltip content={(props) => <ProductOverviewTooltip {...props} configs={spendTooltipConfigs} />} />
              {!hiddenSpendSeries.includes("ordersAds") ? <Bar yAxisId="orders" dataKey="ordersAds" name="Заказы с РК" fill="#4ba66f" radius={[10, 10, 0, 0]} barSize={12} /> : null}
              {!hiddenSpendSeries.includes("totalOrders") ? <Bar yAxisId="orders" dataKey="totalOrders" name="Заказы всего" fill="#8b93aa" radius={[10, 10, 0, 0]} barSize={12} /> : null}
              {!hiddenSpendSeries.includes("spend") ? <Line yAxisId="spend" dataKey="spend" name="Расход" type="monotone" stroke="#f17828" strokeWidth={2.8} dot={{ r: 2.5, fill: "#f17828" }} activeDot={{ r: 4.5 }} /> : null}
              {!hiddenSpendSeries.includes("adsShare") ? <Line yAxisId="share" dataKey="adsShare" name="Доля заказов с РК" type="monotone" stroke="#8b64f6" strokeWidth={2.4} strokeDasharray="5 4" dot={{ r: 2.2, fill: "#8b64f6" }} activeDot={{ r: 4.2 }} /> : null}
              {!hiddenSpendSeries.includes("drr") ? <Line yAxisId="share" dataKey="drr" name="ДРР" type="monotone" stroke="#ff6b8a" strokeWidth={2.2} dot={{ r: 2.2, fill: "#ff6b8a" }} activeDot={{ r: 4.2 }} /> : null}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <ChartLegend
          items={[
            { key: "spend", label: "Расход", value: formatMoney(spendTotal, true), color: "#f17828", active: !hiddenSpendSeries.includes("spend"), onToggle: () => setHiddenSpendSeries((current) => toggleLegendKey(current, "spend")) },
            { key: "ordersAds", label: "Заказы с РК", value: formatNumber(ordersAdsTotal), color: "#4ba66f", active: !hiddenSpendSeries.includes("ordersAds"), onToggle: () => setHiddenSpendSeries((current) => toggleLegendKey(current, "ordersAds")) },
            { key: "totalOrders", label: "Заказы всего", value: formatNumber(totalOrdersTotal), color: "#8b93aa", active: !hiddenSpendSeries.includes("totalOrders"), onToggle: () => setHiddenSpendSeries((current) => toggleLegendKey(current, "totalOrders")) },
            { key: "adsShare", label: "Доля заказов с РК", value: formatPercent(adsShareTotal), color: "#8b64f6", active: !hiddenSpendSeries.includes("adsShare"), onToggle: () => setHiddenSpendSeries((current) => toggleLegendKey(current, "adsShare")) },
            { key: "drr", label: "ДРР", value: formatPercent(drrTotal), color: "#ff6b8a", active: !hiddenSpendSeries.includes("drr"), onToggle: () => setHiddenSpendSeries((current) => toggleLegendKey(current, "drr")) },
          ]}
        />
      </div>

      <div className="chart-card border-[rgba(75,123,255,0.16)] bg-[linear-gradient(180deg,rgba(237,244,255,0.96),rgba(245,248,255,0.92))]">
        <div className="chart-card-head">
          <div>
            <h4 className="font-display font-semibold text-[var(--color-ink)]">Трафик: показы, клики и корзины</h4>
          </div>
          <ChartWindowSwitch activeWindow={activeWindow} onChange={setActiveWindow} />
        </div>
        <div className={cn("trend-chart", chartHeightClass)}>
          <ResponsiveContainer>
            <ComposedChart data={trafficRows} margin={{ top: 12, right: 10, left: 6, bottom: 8 }} syncId={overviewSyncId} syncMethod="value">
              <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={true} horizontal={false} />
              <XAxis
                dataKey="label"
                tick={DATE_TICK_PROPS}
                axisLine={false}
                tickLine={false}
                interval={0}
                minTickGap={0}
                angle={-35}
                height={48}
                textAnchor="end"
              />
              <YAxis yAxisId="views" hide />
              <YAxis yAxisId="actions" hide orientation="right" />
              <Tooltip content={(props) => <ProductOverviewTooltip {...props} configs={trafficTooltipConfigs} />} />
              {!hiddenTrafficSeries.includes("views") ? <Line yAxisId="views" dataKey="views" name="Показы" type="monotone" stroke="#4b7bff" strokeWidth={2.8} dot={{ r: 2.5, fill: "#4b7bff" }} activeDot={{ r: 4.5 }} /> : null}
              {!hiddenTrafficSeries.includes("clicks") ? <Line yAxisId="actions" dataKey="clicks" name="Клики" type="monotone" stroke="#7e5cef" strokeWidth={2.8} dot={{ r: 2.5, fill: "#7e5cef" }} activeDot={{ r: 4.5 }} /> : null}
              {!hiddenTrafficSeries.includes("atbs") ? <Line yAxisId="actions" dataKey="atbs" name="Корзины" type="monotone" stroke="#2ea36f" strokeWidth={2.8} dot={{ r: 2.5, fill: "#2ea36f" }} activeDot={{ r: 4.5 }} /> : null}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <ChartLegend
          items={[
            { key: "views", label: "Показы", value: formatCompactNumber(trafficTotals.views), color: "#4b7bff", active: !hiddenTrafficSeries.includes("views"), onToggle: () => setHiddenTrafficSeries((current) => toggleLegendKey(current, "views")) },
            { key: "clicks", label: "Клики", value: formatNumber(trafficTotals.clicks), color: "#7e5cef", active: !hiddenTrafficSeries.includes("clicks"), onToggle: () => setHiddenTrafficSeries((current) => toggleLegendKey(current, "clicks")) },
            { key: "atbs", label: "Корзины", value: formatNumber(trafficTotals.atbs), color: "#2ea36f", active: !hiddenTrafficSeries.includes("atbs"), onToggle: () => setHiddenTrafficSeries((current) => toggleLegendKey(current, "atbs")) },
          ]}
        />
      </div>

      <div
        className={cn(
          "chart-card border-[rgba(113,92,216,0.16)] bg-[linear-gradient(180deg,rgba(243,241,255,0.96),rgba(249,247,255,0.92))]",
          "xl:col-span-2",
          isOverlayLayout && "lg:col-span-2",
        )}
      >
        <div className="chart-card-head">
          <div>
            <h4 className="font-display font-semibold text-[var(--color-ink)]">Вклад типов РК</h4>
          </div>
          <ChartWindowSwitch activeWindow={activeWindow} onChange={setActiveWindow} />
        </div>
        <div className={cn("trend-chart", chartHeightClass, "overflow-x-auto")}>
          {campaignTypeContribution.types.length ? (
            <div
              className="grid min-w-[760px] overflow-hidden rounded-[14px] border border-[var(--color-line)] bg-[var(--color-surface)]"
              style={{ gridTemplateColumns: `minmax(130px,1.15fr) repeat(${campaignTypeContributionTableMetrics.length}, minmax(92px,1fr))` }}
            >
              <div className="border-b border-[var(--color-line)] bg-[var(--color-surface-strong)] px-3 py-2 text-[10px] font-black uppercase tracking-[0.18em] text-[var(--color-ink)]">
                Тип РК
              </div>
              {campaignTypeContributionTableMetrics.map((metric) => (
                <div
                  key={metric.key}
                  className="border-b border-[var(--color-line)] bg-[var(--color-surface-strong)] px-3 py-2 text-center text-[10px] font-black uppercase tracking-[0.18em] text-[var(--color-ink)]"
                >
                  {metric.label}
                </div>
              ))}
              {campaignTypeContribution.types.map((type) => {
                const typeTotals = campaignTypeContribution.totalsByType[type.key] ?? EMPTY_CAMPAIGN_TYPE_TOTALS;
                return (
                  <div key={type.key} className="contents">
                    <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
                      <span
                        className="rounded-full px-2.5 py-1 text-[10px] font-black uppercase leading-none text-white shadow-[0_8px_16px_rgba(31,23,53,0.12)]"
                        style={{ backgroundColor: type.color }}
                      >
                        {type.key === "cpc" ? "CPC" : "CPM"}
                      </span>
                      <span className="truncate text-[11px] font-bold text-[var(--color-ink)]">{type.label.replace(/^CPM ·\s*/, "").replace(/^CPC$/, "Клики")}</span>
                    </div>
                    {campaignTypeContributionTableMetrics.map((metric) => {
                      const value = metric.getValue(typeTotals);
                      const ratio = metric.maxValue > 0 && value !== null ? Math.max(0.18, Math.min(1, value / metric.maxValue)) : 0.18;
                      return (
                        <div key={`${type.key}-${metric.key}`} className="border-b border-[var(--color-line)] px-3 py-2">
                          <div
                            className="flex h-5 w-full items-center justify-center rounded-[5px] px-2 text-[10px] font-black leading-none text-white shadow-[0_8px_16px_rgba(31,23,53,0.1)]"
                            style={{ backgroundColor: type.color, opacity: 0.48 + ratio * 0.52 }}
                            title={`${type.label} · ${metric.label}: ${metric.formatter(value)}`}
                          >
                            {metric.formatter(value)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">Нет дневных данных по типам РК.</div>
          )}
        </div>
      </div>

      <div className="chart-card border-[rgba(20,166,161,0.18)] bg-[linear-gradient(180deg,rgba(235,250,248,0.96),rgba(244,253,251,0.92))]">
        <div className="chart-card-head">
          <div>
            <h4 className="font-display font-semibold text-[var(--color-ink)]">Корзины и заказы с РК</h4>
          </div>
          <ChartWindowSwitch activeWindow={activeWindow} onChange={setActiveWindow} />
        </div>
        <div className={cn("trend-chart", chartHeightClass)}>
          <ResponsiveContainer>
            <ComposedChart data={basketOrderRows} margin={{ top: 12, right: 10, left: 6, bottom: 8 }} syncId={overviewSyncId} syncMethod="value">
              <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={true} horizontal={false} />
              <XAxis
                dataKey="label"
                tick={DATE_TICK_PROPS}
                axisLine={false}
                tickLine={false}
                interval={0}
                minTickGap={0}
                angle={-35}
                height={48}
                textAnchor="end"
              />
              <YAxis yAxisId="counts" hide />
              <Tooltip content={(props) => <ProductOverviewTooltip {...props} configs={basketOrderTooltipConfigs} />} />
              {!hiddenBasketOrderSeries.includes("atbs") ? <Bar yAxisId="counts" dataKey="atbs" name="Корзины с РК" fill="#14a6a1" radius={[10, 10, 0, 0]} barSize={10} /> : null}
              {!hiddenBasketOrderSeries.includes("ordersAds") ? <Line yAxisId="counts" dataKey="ordersAds" name="Заказы с РК" type="monotone" stroke="#4ba66f" strokeWidth={2.8} dot={{ r: 2.5, fill: "#4ba66f" }} activeDot={{ r: 4.5 }} /> : null}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <ChartLegend
          items={[
            { key: "atbs", label: "Корзины с РК", value: formatNumber(basketOrderTotals.atbs), color: "#14a6a1", active: !hiddenBasketOrderSeries.includes("atbs"), onToggle: () => setHiddenBasketOrderSeries((current) => toggleLegendKey(current, "atbs")) },
            { key: "ordersAds", label: "Заказы с РК", value: formatNumber(basketOrderTotals.ordersAds), color: "#4ba66f", active: !hiddenBasketOrderSeries.includes("ordersAds"), onToggle: () => setHiddenBasketOrderSeries((current) => toggleLegendKey(current, "ordersAds")) },
          ]}
        />
      </div>

      <div className="chart-card border-[rgba(46,163,111,0.18)] bg-[linear-gradient(180deg,rgba(236,250,243,0.96),rgba(244,253,248,0.92))]">
        <div className="chart-card-head">
          <div>
            <h4 className="font-display font-semibold text-[var(--color-ink)]">Средний остаток</h4>
          </div>
          <ChartWindowSwitch activeWindow={activeWindow} onChange={setActiveWindow} />
        </div>
        <div className={cn("trend-chart", chartHeightClass)}>
          {stockValues.length ? (
            <ResponsiveContainer>
              <ComposedChart data={stockRows} margin={{ top: 12, right: 10, left: 6, bottom: 8 }} syncId={overviewSyncId} syncMethod="value">
                <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={true} horizontal={false} />
                <XAxis
                  dataKey="label"
                  tick={DATE_TICK_PROPS}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                  minTickGap={0}
                  angle={-35}
                  height={48}
                  textAnchor="end"
                />
                <YAxis hide domain={["auto", "auto"]} />
                <Tooltip content={(props) => <ProductOverviewTooltip {...props} configs={stockTooltipConfigs} />} />
                {!hiddenStockSeries.includes("avgStock") ? (
                  <>
                    <Area dataKey="avgStock" name="Средний остаток" type="monotone" stroke="none" fill="rgba(46,163,111,0.14)" connectNulls />
                    <Line dataKey="avgStock" name="Средний остаток" type="monotone" stroke="#2ea36f" strokeWidth={2.8} dot={{ r: 2.5, fill: "#2ea36f" }} activeDot={{ r: 4.5 }} connectNulls />
                  </>
                ) : null}
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">Нет данных по среднему остатку.</div>
          )}
        </div>
        <ChartLegend
          items={[
            {
              key: "avgStock",
              label: "Ср. остаток",
              value: averageStock !== null && averageStock !== undefined ? `${formatNumber(averageStock)} шт` : latestStock !== null && latestStock !== undefined ? `${formatNumber(latestStock)} шт` : "—",
              color: "#2ea36f",
              active: !hiddenStockSeries.includes("avgStock"),
              onToggle: () => setHiddenStockSeries((current) => toggleLegendKey(current, "avgStock")),
            },
          ]}
        />
      </div>

      <div className="chart-card border-[rgba(221,185,84,0.18)] bg-[linear-gradient(180deg,rgba(255,248,231,0.96),rgba(255,252,241,0.92))]">
        <div className="chart-card-head">
          <div>
            <h4 className="font-display font-semibold text-[var(--color-ink)]">Эффективность: CTR, CR1, CR2, CRF</h4>
          </div>
          <ChartWindowSwitch activeWindow={activeWindow} onChange={setActiveWindow} />
        </div>
        <div className={cn("trend-chart", chartHeightClass)}>
          {visibleEfficiencyKeys.length ? (
            <ResponsiveContainer>
              <ComposedChart data={efficiencyRows} margin={{ top: 12, right: 10, left: 6, bottom: 8 }} syncId={overviewSyncId} syncMethod="value">
                <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={true} horizontal={false} />
                <XAxis
                  dataKey="label"
                  tick={DATE_TICK_PROPS}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                  minTickGap={0}
                  angle={-35}
                  height={48}
                  textAnchor="end"
                />
                <YAxis hide domain={["auto", "auto"]} />
                <Tooltip content={(props) => <ProductOverviewTooltip {...props} configs={efficiencyTooltipConfigs} />} />
                {!hiddenEfficiencySeries.includes("ctr") ? <Line dataKey="ctr" name="CTR" type="monotone" stroke="#2ea36f" strokeWidth={2.8} dot={{ r: 2.5, fill: "#2ea36f" }} activeDot={{ r: 4.5 }} connectNulls /> : null}
                {!hiddenEfficiencySeries.includes("cr1") ? <Line dataKey="cr1" name="CR1" type="monotone" stroke="#2998df" strokeWidth={2.8} dot={{ r: 2.5, fill: "#2998df" }} activeDot={{ r: 4.5 }} connectNulls /> : null}
                {!hiddenEfficiencySeries.includes("cr2") ? <Line dataKey="cr2" name="CR2" type="monotone" stroke="#8b64f6" strokeWidth={2.8} dot={{ r: 2.5, fill: "#8b64f6" }} activeDot={{ r: 4.5 }} connectNulls /> : null}
                {!hiddenEfficiencySeries.includes("crf") ? <Line dataKey="crf" name="CRF" type="monotone" stroke="#f17828" strokeWidth={2.8} dot={{ r: 2.5, fill: "#f17828" }} activeDot={{ r: 4.5 }} connectNulls /> : null}
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">Включи хотя бы одну метрику в легенде ниже.</div>
          )}
        </div>
        <ChartLegend
          items={efficiencyItems.map((item) => ({
            key: item.key,
            label: item.label,
            value: formatPercent(item.value),
            color: item.color,
            active: !hiddenEfficiencySeries.includes(item.key),
            onToggle: () => setHiddenEfficiencySeries((current) => toggleLegendKey(current, item.key)),
          }))}
        />
      </div>

      <div className="chart-card border-[rgba(136,116,210,0.16)] bg-[linear-gradient(180deg,rgba(244,241,255,0.96),rgba(249,246,255,0.92))]">
        <div className="chart-card-head">
          <div>
            <h4 className="font-display font-semibold text-[var(--color-ink)]">Позиция кластеров и CTR</h4>
          </div>
          <ChartWindowSwitch activeWindow={activeWindow} onChange={setActiveWindow} />
        </div>
        <div className={cn("trend-chart", chartHeightClass)}>
          {clusterRows.length ? (
            <ResponsiveContainer>
              <ComposedChart data={clusterRows} margin={{ top: 12, right: 10, left: 6, bottom: 8 }} syncId={overviewSyncId} syncMethod="value">
                <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 4" vertical={true} horizontal={false} />
                <XAxis
                  dataKey="label"
                  tick={DATE_TICK_PROPS}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                  minTickGap={0}
                  angle={-35}
                  height={48}
                  textAnchor="end"
                />
                <YAxis yAxisId="clusters" hide />
                <YAxis yAxisId="position" hide orientation="right" reversed />
                <YAxis yAxisId="ctr" hide orientation="right" />
                <Tooltip content={(props) => <ProductOverviewTooltip {...props} configs={clusterTooltipConfigs} />} />
                {!hiddenClusterSeries.includes("top1") ? <Bar yAxisId="clusters" dataKey="top1" name="Топ-1 поз." fill="#6949f6" radius={[8, 8, 0, 0]} barSize={10} /> : null}
                {!hiddenClusterSeries.includes("top2") ? <Bar yAxisId="clusters" dataKey="top2" name="Топ-2 поз." fill="#8f74fb" radius={[8, 8, 0, 0]} barSize={10} /> : null}
                {!hiddenClusterSeries.includes("top3") ? <Bar yAxisId="clusters" dataKey="top3" name="Топ-3 поз." fill="#baa9ff" radius={[8, 8, 0, 0]} barSize={10} /> : null}
                {!hiddenClusterSeries.includes("avgPosition") ? <Line yAxisId="position" dataKey="avgPosition" name="Ср. позиция" type="monotone" stroke="#7f8ba3" strokeWidth={2.8} dot={false} activeDot={{ r: 4.5 }} connectNulls /> : null}
                {!hiddenClusterSeries.includes("ctr") ? <Line yAxisId="ctr" dataKey="ctr" name="CTR кластеров" type="monotone" stroke="#2ea36f" strokeWidth={2.8} dot={false} activeDot={{ r: 4.5 }} connectNulls /> : null}
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">Нет дневных данных по кластерам.</div>
          )}
        </div>
        <ChartLegend
          items={[
            { key: "avgPosition", label: "Ср. позиция", value: latestCluster?.avgPosition !== null && latestCluster?.avgPosition !== undefined ? formatNumber(latestCluster.avgPosition, 1) : "—", color: "#7f8ba3", active: !hiddenClusterSeries.includes("avgPosition"), onToggle: () => setHiddenClusterSeries((current) => toggleLegendKey(current, "avgPosition")) },
            { key: "ctr", label: "CTR кластеров", value: formatPercent(latestCluster?.ctr), color: "#2ea36f", active: !hiddenClusterSeries.includes("ctr"), onToggle: () => setHiddenClusterSeries((current) => toggleLegendKey(current, "ctr")) },
            { key: "top1", label: "Топ-1 поз.", value: formatNumber(clusterTotals.top1), color: "#6949f6", active: !hiddenClusterSeries.includes("top1"), onToggle: () => setHiddenClusterSeries((current) => toggleLegendKey(current, "top1")) },
            { key: "top2", label: "Топ-2 поз.", value: formatNumber(clusterTotals.top2), color: "#8f74fb", active: !hiddenClusterSeries.includes("top2"), onToggle: () => setHiddenClusterSeries((current) => toggleLegendKey(current, "top2")) },
            { key: "top3", label: "Топ-3 поз.", value: formatNumber(clusterTotals.top3), color: "#baa9ff", active: !hiddenClusterSeries.includes("top3"), onToggle: () => setHiddenClusterSeries((current) => toggleLegendKey(current, "top3")) },
          ]}
        />
      </div>
    </div>
  );
}
