import { Group } from "@visx/group";
import { Text as VisxText } from "@visx/text";
import { useTooltip } from "@visx/tooltip";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronRight, LoaderCircle, Search, Sparkles } from "lucide-react";
import { cn, formatCompactNumber, formatDateRange, formatDelta, formatMoney, formatNumber, formatPercent, relativeDeltaClass, statusTone } from "../lib/format";
import type { ScheduleAggregate } from "../lib/types";

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  headerSummary?: ReactNode;
  align?: "left" | "right";
  dividerBefore?: boolean;
  headerClassName?: string;
  cellClassName?: string;
  stickyLeft?: number;
  render: (row: T) => ReactNode;
}

export function AppSurface({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex min-h-screen w-full flex-col pb-8">{children}</div>;
}

export function StatusBadge({
  label,
  active,
  status,
}: {
  label: string;
  active: boolean;
  status?: string | null;
}) {
  const tone = statusTone(active, status);
  const palette = {
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    slate: "border-slate-200 bg-slate-100 text-slate-600",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
  } as const;

  return (
    <span className={cn("inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium", palette[tone])}>
      <span className={cn("size-1.5 rounded-full", active ? "bg-emerald-500" : "bg-slate-400")} />
      {label}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  delta,
  deltaText,
  deltaClassName,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: number | null;
  deltaText?: ReactNode;
  deltaClassName?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="glass-panel rounded-[22px] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">{label}</p>
          <div className="font-display text-2xl font-semibold leading-tight text-[var(--color-ink)]">{value}</div>
          {hint ? <p className="text-sm text-[var(--color-muted)]">{hint}</p> : null}
        </div>
        {icon ? <div className="metric-chip rounded-2xl p-2.5 text-brand-200">{icon}</div> : null}
      </div>
      {deltaText !== undefined || delta !== undefined ? (
        <p className={cn("mt-3 text-xs font-medium leading-snug", deltaText !== undefined ? deltaClassName : relativeDeltaClass(delta))}>
          {deltaText !== undefined ? deltaText : delta === null ? "Без сравнения" : `${formatDelta(delta)} к прошлому периоду`}
        </p>
      ) : null}
    </div>
  );
}

export function SectionCard({
  title,
  caption,
  actions,
  children,
  className,
}: {
  title: string;
  caption?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("glass-panel rounded-[30px] p-5 sm:p-6", className)}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="font-display text-xl font-semibold text-[var(--color-ink)] sm:text-2xl">{title}</h2>
          {caption ? <div className="text-sm text-[var(--color-muted)]">{caption}</div> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  text,
}: {
  title: string;
  text: string;
}) {
  return (
    <div className="glass-panel flex min-h-56 flex-col items-center justify-center rounded-[30px] border border-dashed border-[var(--color-line-strong)] p-8 text-center">
      <div className="metric-chip mb-4 rounded-2xl p-3 text-brand-200">
        <Sparkles className="size-5" />
      </div>
      <h3 className="font-display text-xl font-semibold text-[var(--color-ink)]">{title}</h3>
      <p className="mt-2 max-w-xl text-sm text-[var(--color-muted)]">{text}</p>
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <label className={cn("metric-chip flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-sm text-[var(--color-muted)]", className)}>
      <Search className="size-4 text-brand-200" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
      />
    </label>
  );
}

export function MetricTable<T>({
  columns,
  rows,
  emptyText = "Данные отсутствуют",
  variant = "default",
  className,
  stickyHeader = false,
  headerStickyTop = 0,
}: {
  columns: TableColumn<T>[];
  rows: T[];
  emptyText?: string;
  variant?: "default" | "flat";
  className?: string;
  stickyHeader?: boolean;
  headerStickyTop?: number | string;
}) {
  const tableViewportRef = useRef<HTMLDivElement | null>(null);
  const tableElementRef = useRef<HTMLTableElement | null>(null);
  const [headerCloneState, setHeaderCloneState] = useState<{
    columnWidths: number[];
    tableWidth: number;
    headerHeight: number;
    top: number;
    viewportLeft: number;
    viewportWidth: number;
    scrollLeft: number;
    isPinned: boolean;
  }>({
    columnWidths: [],
    tableWidth: 0,
    headerHeight: 0,
    top: 0,
    viewportLeft: 0,
    viewportWidth: 0,
    scrollLeft: 0,
    isPinned: false,
  });
  const columnKeys = columns.map((column) => column.key).join("|");

  useEffect(() => {
    const viewportNode = tableViewportRef.current;
    const tableNode = tableElementRef.current;
    if (!viewportNode || !tableNode) {
      return;
    }

    const resolveEffectiveScrollLeft = () => {
      const rawScrollLeft = Math.round(viewportNode.scrollLeft + (window.scrollX || window.pageXOffset || 0));
      const tableWidth = Math.round(tableNode.getBoundingClientRect().width);
      const viewportWidth = Math.round(viewportNode.getBoundingClientRect().width);
      const maxScrollLeft = Math.max(0, tableWidth - viewportWidth);
      return Math.max(0, Math.min(rawScrollLeft, maxScrollLeft));
    };

    const syncScrollLeft = () => {
      const nextScrollLeft = resolveEffectiveScrollLeft();
      setHeaderCloneState((current) => (current.scrollLeft === nextScrollLeft ? current : { ...current, scrollLeft: nextScrollLeft }));
    };

    const syncHeaderMetrics = () => {
      const headerCells = [...tableNode.querySelectorAll<HTMLTableCellElement>("thead tr:first-child > th")].slice(0, columns.length);
      const nextColumnWidths = headerCells.map((cell) => Math.round(cell.getBoundingClientRect().width));
      const nextTableWidth = Math.round(tableNode.getBoundingClientRect().width);
      const viewportRect = viewportNode.getBoundingClientRect();
      const tableRect = tableNode.getBoundingClientRect();
      const headerRect = headerCells[0]?.getBoundingClientRect();
      const stickyTop = typeof headerStickyTop === "number" ? headerStickyTop : Number.parseFloat(String(headerStickyTop)) || 0;
      const nextHeaderHeight = Math.ceil(headerRect?.height ?? 0);
      const nextTop = Math.round(Math.min(stickyTop, tableRect.bottom - nextHeaderHeight));
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const tableContinuesBelowViewport = tableRect.bottom > viewportHeight - 16;
      const nextViewportLeft = Math.round(viewportRect.left);
      const nextViewportWidth = Math.round(viewportRect.width);
      const nextIsPinned = Boolean(
        stickyHeader &&
          headerRect &&
          nextHeaderHeight > 0 &&
          headerRect.top <= stickyTop &&
          tableRect.bottom > 0 &&
          nextTop + nextHeaderHeight > 0 &&
          tableContinuesBelowViewport,
      );
      syncScrollLeft();
      setHeaderCloneState((current) => {
        const sameWidths =
          current.columnWidths.length === nextColumnWidths.length &&
          current.columnWidths.every((value, index) => value === nextColumnWidths[index]);
        if (
          sameWidths &&
          current.tableWidth === nextTableWidth &&
          current.headerHeight === nextHeaderHeight &&
          current.top === nextTop &&
          current.viewportLeft === nextViewportLeft &&
          current.viewportWidth === nextViewportWidth &&
          current.isPinned === nextIsPinned
        ) {
          return current;
        }
        return {
          ...current,
          columnWidths: nextColumnWidths,
          tableWidth: nextTableWidth,
          headerHeight: nextHeaderHeight,
          top: nextTop,
          viewportLeft: nextViewportLeft,
          viewportWidth: nextViewportWidth,
          isPinned: nextIsPinned,
        };
      });
    };

    syncHeaderMetrics();
    viewportNode.addEventListener("scroll", syncScrollLeft, { passive: true });
    window.addEventListener("scroll", syncHeaderMetrics, { passive: true });
    window.addEventListener("resize", syncHeaderMetrics);

    if (typeof ResizeObserver === "undefined") {
      return () => {
        viewportNode.removeEventListener("scroll", syncScrollLeft);
        window.removeEventListener("scroll", syncHeaderMetrics);
        window.removeEventListener("resize", syncHeaderMetrics);
      };
    }

    const observer = new ResizeObserver(syncHeaderMetrics);
    observer.observe(viewportNode);
    observer.observe(tableNode);
    [...tableNode.querySelectorAll<HTMLTableCellElement>("thead th")].forEach((cell) => observer.observe(cell));
    return () => {
      viewportNode.removeEventListener("scroll", syncScrollLeft);
      window.removeEventListener("scroll", syncHeaderMetrics);
      window.removeEventListener("resize", syncHeaderMetrics);
      observer.disconnect();
    };
  }, [columnKeys, columns.length, headerStickyTop, rows.length, stickyHeader]);

  if (!rows.length) {
    return <EmptyState title="Пока пусто" text={emptyText} />;
  }

  const hasHeaderSummary = columns.some((column) => column.headerSummary !== undefined);
  const showStickyHeaderClone =
    stickyHeader &&
    headerCloneState.isPinned &&
    headerCloneState.columnWidths.length === columns.length &&
    headerCloneState.tableWidth > 0 &&
    headerCloneState.viewportWidth > 0;
  const colgroup = headerCloneState.columnWidths.length === columns.length ? (
    <colgroup>
      {headerCloneState.columnWidths.map((width, index) => (
        <col key={`${columns[index]?.key || index}-width`} style={{ width: `${width}px`, minWidth: `${width}px` }} />
      ))}
    </colgroup>
  ) : null;

  const renderHeader = ({ clone = false, hidden = false }: { clone?: boolean; hidden?: boolean } = {}) => (
    <thead className={cn("bg-[var(--color-surface-soft)]", hidden && "invisible")}>
      <tr>
        {columns.map((column) => (
          <th
            key={column.key}
            style={{
              ...(column.stickyLeft !== undefined ? { left: `${column.stickyLeft}px` } : {}),
            }}
            className={cn(
              "bg-[var(--color-surface-soft)] px-4 py-3 text-xs font-medium uppercase tracking-[0.24em] text-[var(--color-muted)]",
              column.stickyLeft !== undefined && "metric-table-sticky-col metric-table-sticky-head",
              column.dividerBefore && "border-l border-[var(--color-line)]",
              column.align === "right" ? "text-right" : "text-left",
              !clone && column.stickyLeft !== undefined && "sticky z-[12]",
              clone && column.stickyLeft !== undefined && "z-[12]",
              column.headerClassName,
            )}
          >
            {column.header}
          </th>
        ))}
      </tr>
      {hasHeaderSummary ? (
        <tr className="metric-table-summary-row">
          {columns.map((column) => (
            <th
              key={`${column.key}-summary`}
              style={column.stickyLeft !== undefined ? { left: `${column.stickyLeft}px` } : undefined}
              className={cn(
                "metric-table-summary-head bg-[var(--color-surface-soft)] px-4 py-2 text-[0.8rem] font-semibold normal-case tracking-normal text-[var(--color-ink)]",
                column.stickyLeft !== undefined && "metric-table-sticky-col metric-table-sticky-head",
                column.dividerBefore && "border-l border-[var(--color-line)]",
                column.align === "right" ? "text-right" : "text-left",
                !clone && column.stickyLeft !== undefined && "sticky z-[12]",
                clone && column.stickyLeft !== undefined && "z-[12]",
                column.headerClassName,
              )}
            >
              {column.headerSummary}
            </th>
          ))}
        </tr>
      ) : null}
    </thead>
  );

  return (
    <div
      className={cn(
        variant === "default"
          ? "table-shell overflow-visible rounded-[28px] border border-[var(--color-line)] bg-white"
          : "table-shell-flat overflow-visible rounded-none border-0 bg-transparent shadow-none",
        className,
      )}
    >
      {showStickyHeaderClone && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none z-30 overflow-hidden border-b border-[var(--color-line)] bg-[var(--color-surface-soft)] shadow-[0_14px_28px_rgba(44,35,66,0.08)]"
              style={{
                position: "fixed",
                top: `${headerCloneState.top}px`,
                left: "0",
                right: "0",
                height: `${headerCloneState.headerHeight}px`,
                zIndex: 38,
              }}
            >
              <div
                className="absolute inset-y-0 overflow-hidden"
                style={{
                  left: `${headerCloneState.viewportLeft}px`,
                  width: `${headerCloneState.viewportWidth}px`,
                }}
              >
                <table
                  aria-hidden="true"
                  className="data-table text-sm"
                  style={{
                    width: `${headerCloneState.tableWidth}px`,
                    tableLayout: "fixed",
                    transform: `translateX(-${headerCloneState.scrollLeft}px)`,
                  }}
                >
                  {colgroup}
                  {renderHeader({ clone: true })}
                </table>
              </div>
            </div>,
            document.body,
          )
        : null}

      <div ref={tableViewportRef} className={cn("overflow-x-auto", variant === "flat" ? "overflow-y-hidden" : "overflow-y-visible")}>
        <table
          ref={tableElementRef}
          className="data-table min-w-full divide-y divide-[var(--color-line)] text-sm"
          style={showStickyHeaderClone && headerCloneState.tableWidth ? { width: `${headerCloneState.tableWidth}px` } : undefined}
        >
          {colgroup}
          {renderHeader()}
          <tbody className="divide-y divide-[var(--color-line)] bg-white">
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="transition hover:bg-[var(--color-surface-soft)]">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    style={column.stickyLeft !== undefined ? { left: `${column.stickyLeft}px` } : undefined}
                    className={cn(
                      "px-4 py-3 align-top text-[var(--color-ink)]",
                      column.stickyLeft !== undefined && "metric-table-sticky-col metric-table-sticky-cell",
                      column.dividerBefore && "border-l border-[var(--color-line)]",
                      column.align === "right" ? "text-right" : "text-left",
                      column.cellClassName,
                    )}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RangeToolbar({
  start,
  end,
  preset,
  onPresetChange,
  onRangeChange,
  extra,
}: {
  start?: string | null;
  end?: string | null;
  preset: string;
  onPresetChange: (preset: string) => void;
  onRangeChange: (next: { start: string; end: string }) => void;
  extra?: ReactNode;
}) {
  return (
    <div className="glass-panel flex flex-col gap-3 rounded-[28px] p-3 sm:p-3.5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-1 flex-col gap-3 xl:flex-row xl:items-center">
        <div className="metric-chip inline-flex w-full items-center gap-3 rounded-2xl px-3.5 py-2.5 xl:w-auto">
          <CalendarDays className="size-4 text-brand-200" />
          <select
            value={preset}
            onChange={(event) => onPresetChange(event.target.value)}
            className="w-full bg-transparent text-sm text-[var(--color-ink)] outline-none"
          >
            <option value="custom">
              Свой диапазон
            </option>
            <option value="today">
              Сегодня
            </option>
            <option value="yesterday">
              Вчера
            </option>
            <option value="3">
              Последние 3 дня
            </option>
            <option value="7">
              Последние 7 дней
            </option>
            <option value="14">
              Последние 14 дней
            </option>
            <option value="30">
              Последние 30 дней
            </option>
          </select>
        </div>

        <div className="grid flex-1 gap-3 sm:grid-cols-2">
          <label className="metric-chip flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm">
            <span className="text-[var(--color-muted)]">Начало</span>
            <input
              type="date"
              value={start || ""}
              onChange={(event) => onRangeChange({ start: event.target.value, end: end || event.target.value })}
              className="ml-auto bg-transparent text-[var(--color-ink)] outline-none"
            />
          </label>
          <label className="metric-chip flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm">
            <span className="text-[var(--color-muted)]">Конец</span>
            <input
              type="date"
              value={end || ""}
              onChange={(event) => onRangeChange({ start: start || event.target.value, end: event.target.value })}
              className="ml-auto bg-transparent text-[var(--color-ink)] outline-none"
            />
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">{extra}</div>
    </div>
  );
}

export function KeyValueRow({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] py-2 last:border-b-0">
      <span className="text-sm text-[var(--color-muted)]">{label}</span>
      <span className="text-right text-sm font-medium text-[var(--color-ink)]">{value}</span>
    </div>
  );
}

export function MiniStat({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="mini-stat metric-chip rounded-2xl px-3 py-2">
      <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--color-muted)]">{label}</p>
      <p className="mt-1 text-sm font-semibold text-[var(--color-ink)]">{value}</p>
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  items,
  onChange,
}: {
  value: T;
  items: Array<{ value: T; label: string; count?: number | null }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="glass-panel flex flex-wrap gap-2 rounded-[28px] p-2">
      {items.map((item) => (
        <button
          type="button"
          key={item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm font-medium transition",
            value === item.value
              ? "bg-white text-[var(--color-ink)] shadow-[0_6px_16px_rgba(44,35,66,0.12)]"
              : "text-[var(--color-muted)] hover:bg-[var(--color-surface-soft)] hover:text-[var(--color-ink)]",
          )}
        >
          {item.label}
          {item.count !== undefined ? <span className="ml-2 text-xs opacity-70">{formatCompactNumber(item.count)}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function LoadingBar({ active }: { active: boolean }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50">
      <div className={cn("h-1 origin-left bg-gradient-to-r from-brand-300 via-accent-500 to-coral-500 transition-transform duration-500", active ? "scale-x-100 opacity-100" : "scale-x-0 opacity-0")} />
    </div>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn("skeleton-shimmer rounded-[18px] bg-[var(--color-surface-strong)]", className)} />;
}

function LoadingScreenCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="rounded-[18px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-4">
      <div className="space-y-3">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index}>
            {index > 0 ? <div className="mb-3 h-px bg-[var(--color-line)]" /> : null}
            <SkeletonBlock className="h-3.5 w-28 rounded-full" />
            <SkeletonBlock className="mt-2 h-5 w-36 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function RouteLoadingScreen() {
  return (
    <div className="space-y-4">
      <div className="glass-panel rounded-[24px] p-4">
        <div className="flex flex-wrap items-center gap-3">
          <SkeletonBlock className="size-10 rounded-2xl" />
          <SkeletonBlock className="h-8 w-px rounded-none" />
          <SkeletonBlock className="h-12 w-[168px] rounded-[16px]" />
          <SkeletonBlock className="h-12 w-[168px] rounded-[16px]" />
          <SkeletonBlock className="h-12 w-[154px] rounded-full" />
          <div className="min-w-4 flex-1" />
          <SkeletonBlock className="h-12 w-[108px] rounded-full" />
          <SkeletonBlock className="h-12 w-[108px] rounded-full" />
          <SkeletonBlock className="h-12 w-[108px] rounded-full" />
        </div>
      </div>

      <div className="glass-panel rounded-[30px] p-4 sm:p-5">
        <div className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)] gap-4 sm:grid-cols-[102px_minmax(0,1fr)]">
          <SkeletonBlock className="aspect-[51/68] w-[88px] rounded-[24px] sm:w-[102px]" />
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap gap-2">
              <SkeletonBlock className="h-8 w-32 rounded-full" />
              <SkeletonBlock className="h-8 w-28 rounded-full" />
              <SkeletonBlock className="h-8 w-40 rounded-full" />
            </div>
            <SkeletonBlock className="h-8 w-[62%]" />
            <SkeletonBlock className="h-4 w-[76%]" />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="rounded-[18px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] p-3">
              <SkeletonBlock className="h-3.5 w-24 rounded-full" />
              <SkeletonBlock className="mt-2 h-5 w-28 rounded-full" />
            </div>
          ))}
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <LoadingScreenCard rows={3} />
          <LoadingScreenCard rows={2} />
          <LoadingScreenCard rows={2} />
        </div>

        <div className="mt-4 overflow-hidden rounded-[20px] border border-[var(--color-line)] bg-white">
          <div className="grid border-b border-[var(--color-line)] bg-[var(--color-surface-soft)] px-3 py-2 sm:grid-cols-5">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className={cn("py-1", index > 0 && "sm:border-l sm:border-[var(--color-line)] sm:pl-3")}>
                <SkeletonBlock className="h-3.5 w-24 rounded-full" />
              </div>
            ))}
          </div>
          <div className="grid gap-0 sm:grid-cols-5">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className={cn("border-b border-[var(--color-line)] p-3 last:border-b-0 sm:min-h-[124px]", index > 0 && "sm:border-l sm:border-[var(--color-line)]")}>
                <SkeletonBlock className="h-full min-h-[96px] w-full rounded-[14px]" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="glass-panel rounded-[30px] p-4 sm:p-5">
        <div className="flex flex-wrap gap-2 rounded-[18px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] p-2">
          {Array.from({ length: 6 }, (_, index) => (
            <SkeletonBlock key={index} className="h-10 w-28 rounded-[12px]" />
          ))}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <SkeletonBlock className="h-64 w-full rounded-[24px]" />
          <SkeletonBlock className="h-64 w-full rounded-[24px]" />
        </div>
      </div>
    </div>
  );
}

export function LoadingOverlay({ active }: { active: boolean }) {
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-40 transition duration-300",
        active ? "opacity-100" : "opacity-0",
      )}
      aria-hidden={!active}
    >
      <div className="absolute inset-0 bg-[rgba(244,243,247,0.52)] backdrop-blur-[6px]" />
      <div className="mx-auto flex h-full w-full max-w-[1680px] items-start justify-end px-4 pb-8 pt-24 sm:px-6 lg:px-8">
        <div className="w-full max-w-[360px] rounded-[28px] border border-[var(--color-line)] bg-white/94 p-4 shadow-[0_24px_60px_rgba(44,35,66,0.12)]">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-[var(--color-surface-soft)] text-brand-200">
              <LoaderCircle className={cn("size-5", active && "animate-spin")} />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[var(--color-ink)]">Загружаем данные</p>
              <p className="text-xs text-[var(--color-muted)]">Обновляем карточки, таблицы и графики для текущего экрана.</p>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <SkeletonBlock className="h-12 w-full rounded-[16px]" />
            <SkeletonBlock className="h-24 w-full rounded-[18px]" />
            <div className="grid grid-cols-2 gap-2">
              <SkeletonBlock className="h-14 w-full rounded-[16px]" />
              <SkeletonBlock className="h-14 w-full rounded-[16px]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PageHero({
  title,
  subtitle,
  metrics,
  actions,
}: {
  title: string;
  subtitle: ReactNode;
  metrics?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="glass-panel relative overflow-hidden rounded-[34px] p-6 sm:p-7">
      <div className="absolute -right-14 -top-14 h-40 w-40 rounded-full bg-[radial-gradient(circle,_rgba(255,157,92,0.14)_0%,_rgba(255,157,92,0)_72%)]" />
      <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-brand-300/60 to-transparent" />
      <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <p className="mb-3 text-xs uppercase tracking-[0.28em] text-brand-200">XWAY Dashboard</p>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-[var(--color-ink)] sm:text-5xl">{title}</h1>
          <div className="mt-3 text-sm leading-6 text-[var(--color-muted)] sm:text-base">{subtitle}</div>
        </div>
        <div className="flex flex-col gap-4 xl:items-end">
          {metrics ? <div className="flex flex-wrap gap-2">{metrics}</div> : null}
          {actions}
        </div>
      </div>
    </div>
  );
}

export function ScheduleMatrix({
  ...props
}: ScheduleMatrixProps) {
  if (props.compact && !props.showCounts) {
    return <CompactScheduleMatrix {...props} />;
  }

  return <SvgScheduleMatrix {...props} />;
}

type ScheduleMatrixProps = {
  schedule: ScheduleAggregate;
  compact?: boolean;
  showCounts?: boolean;
  showDayHeaderLabel?: boolean;
  autoWidth?: boolean;
  hourColumnWidth?: string;
  dayLabelWidth?: number;
  hourLabelStep?: number;
  responsiveResetKey?: string | number;
  stretchToFitHeight?: boolean;
};

function compactDayLabelValue(key: string, label: string) {
  const normalizedKey = String(key || "").toLowerCase();
  const normalizedLabel = String(label || "").toLowerCase();
  const mapping: Record<string, string> = {
    mon: "ПН",
    monday: "ПН",
    tue: "ВТ",
    tuesday: "ВТ",
    wed: "СР",
    wednesday: "СР",
    thu: "ЧТ",
    thursday: "ЧТ",
    fri: "ПТ",
    friday: "ПТ",
    sat: "СБ",
    saturday: "СБ",
    sun: "ВС",
    sunday: "ВС",
  };

  return mapping[normalizedKey] || mapping[normalizedLabel] || label.slice(0, 2).toUpperCase();
}

function tooltipDayLabelValue(key: string, label: string) {
  const normalizedKey = String(key || "").toLowerCase();
  const normalizedLabel = String(label || "").toLowerCase();
  const mapping: Record<string, string> = {
    mon: "Пн",
    monday: "Пн",
    tue: "Вт",
    tuesday: "Вт",
    wed: "Ср",
    wednesday: "Ср",
    thu: "Чт",
    thursday: "Чт",
    fri: "Пт",
    friday: "Пт",
    sat: "Сб",
    saturday: "Сб",
    sun: "Вс",
    sunday: "Вс",
  };

  return mapping[normalizedKey] || mapping[normalizedLabel] || `${label.slice(0, 1).toUpperCase()}${label.slice(1, 2).toLowerCase()}`;
}

function resolveScheduleCellTone(count: number, active: boolean, maxCount: number) {
  if (!active || count <= 0) {
    return {
      fill: "rgba(236, 240, 250, 0.72)",
      stroke: "rgba(214, 220, 236, 0.82)",
      count: "rgba(132, 140, 166, 0.78)",
    };
  }

  const intensity = Math.max(0, Math.min(count / maxCount, 1));
  if (intensity >= 0.66) {
    return {
      fill: "rgba(51, 184, 126, 0.96)",
      stroke: "rgba(28, 154, 103, 0.98)",
      count: "rgba(247, 255, 250, 0.98)",
    };
  }
  if (intensity >= 0.33) {
    return {
      fill: "rgba(118, 220, 170, 0.92)",
      stroke: "rgba(86, 192, 142, 0.96)",
      count: "rgba(18, 89, 63, 0.92)",
    };
  }
  return {
    fill: "rgba(197, 241, 219, 0.94)",
    stroke: "rgba(157, 220, 190, 0.96)",
    count: "rgba(28, 101, 72, 0.88)",
  };
}

function CompactScheduleMatrix({
  schedule,
  compact = false,
  showCounts = true,
  showDayHeaderLabel = true,
  dayLabelWidth,
}: ScheduleMatrixProps) {
  if (!schedule.days.length) {
    return <EmptyState title="Расписание не пришло" text="По этому периоду у кампаний пока нет часовой раскладки." />;
  }

  const maxCount = Math.max(schedule.max_count || 1, 1);
  const resolvedDayLabelWidth = dayLabelWidth ?? (compact ? 30 : 56);
  const cellRadius = compact ? 4 : 6;

  return (
    <div className="schedule-grid-card-wrapper relative z-0 overflow-visible">
      <div
        className={cn("schedule-grid-card is-dom-compact w-full", compact ? "min-w-0 is-compact" : "min-w-0")}
        style={{ ["--schedule-day-label-width" as string]: `${resolvedDayLabelWidth}px` }}
        role="img"
        aria-label="Тепловая карта активности расписания по дням и часам"
      >
        <div className="schedule-header">
          <span
            className="schedule-day title"
            style={!showDayHeaderLabel ? { visibility: "hidden" } : undefined}
            aria-hidden={!showDayHeaderLabel}
          >
            День
          </span>
          <div className="schedule-hours">
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={`schedule-hour-${hour}`}>{hour}</span>
            ))}
          </div>
        </div>

        {schedule.days.map((day) => (
          <div key={day.key} className="schedule-row">
            <span className="schedule-day">{compactDayLabelValue(day.key, day.label)}</span>
            <div className="schedule-cells">
              {day.hours.map((slot) => {
                const count = Number(slot.count || 0);
                const active = Boolean(slot.active || count > 0);
                const tone = resolveScheduleCellTone(count, active, maxCount);
                const tooltipTitle = `${tooltipDayLabelValue(day.key, day.label)}, ${slot.hour}:00`;

                return (
                  <div
                    key={`${day.key}-${slot.hour}`}
                    className={cn("schedule-cell", active && "active", showCounts && count > 0 && "has-count", showCounts && count <= 0 && "is-no-count")}
                    style={{
                      background: tone.fill,
                      boxShadow: `inset 0 0 0 1px ${tone.stroke}`,
                      borderRadius: `${cellRadius}px`,
                    }}
                  >
                    {showCounts && count > 0 ? <span className="schedule-cell-count" style={{ color: tone.count }}>{String(count)}</span> : null}
                    <span className="schedule-cell-tooltip">
                      <strong>{tooltipTitle}</strong>
                      <span>
                        {active
                          ? count > 1
                            ? `${count} РК активно`
                            : "Активно"
                          : "Неактивно"}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SvgScheduleMatrix({
  schedule,
  compact = false,
  showCounts = true,
  showDayHeaderLabel = true,
  autoWidth = false,
  hourColumnWidth,
  dayLabelWidth,
  hourLabelStep = 1,
  responsiveResetKey,
  stretchToFitHeight = false,
}: ScheduleMatrixProps) {
  if (!schedule.days.length) {
    return <EmptyState title="Расписание не пришло" text="По этому периоду у кампаний пока нет часовой раскладки." />;
  }

  const maxCount = Math.max(schedule.max_count || 1, 1);
  const resolvedDayLabelWidth = dayLabelWidth ?? (compact ? 30 : 56);
  const resolvedHourWidth = (() => {
    const numeric = Number.parseFloat(String(hourColumnWidth || "").replace("px", "").trim());
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
    return compact ? 16 : 26;
  })();
  const hourGap = compact ? 3 : 4;
  const headerHeight = compact ? 18 : 24;
  const rowGap = compact ? 4 : 6;
  const rowHeight = compact ? 12 : showCounts ? 22 : 18;
  const cellHeight = compact ? 9 : showCounts ? 18 : 14;
  const cellRadius = compact ? 4 : 6;
  const axisFontSize = compact ? 8 : 10;
  const dayFontSize = compact ? 9 : 11;
  const countFontSize = compact ? 6.5 : 9;
  const totalHoursWidth = resolvedHourWidth * 24 + hourGap * 23;
  const chartNaturalWidth = resolvedDayLabelWidth + totalHoursWidth;
  const chartNaturalHeight = headerHeight + schedule.days.length * rowHeight + Math.max(schedule.days.length - 1, 0) * rowGap;
  const {
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
    showTooltip,
    hideTooltip,
  } = useTooltip<{
    dayLabel: string;
    hour: number;
    count: number;
    active: boolean;
    placement: "top" | "bottom";
  }>();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportBounds, setViewportBounds] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }

    const updateBounds = () => {
      const nextWidth = Math.round(node.getBoundingClientRect().width);
      const nextHeight = Math.round(node.getBoundingClientRect().height);
      setViewportBounds((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { width: nextWidth, height: nextHeight },
      );
    };

    let frameId = window.requestAnimationFrame(updateBounds);
    updateBounds();

    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updateBounds);
    });
    observer.observe(node);

    window.addEventListener("resize", updateBounds);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", updateBounds);
      observer.disconnect();
    };
  }, [responsiveResetKey]);

  const measuredWidth = Math.max(viewportBounds.width, 0);
  const measuredHeight = Math.max(viewportBounds.height, 0);
  const svgWidth = autoWidth
    ? chartNaturalWidth
    : measuredWidth || chartNaturalWidth;
  const svgHeight = stretchToFitHeight
    ? Math.max(measuredHeight || chartNaturalHeight, chartNaturalHeight)
    : chartNaturalHeight;
  const responsiveDayLabelWidth = autoWidth
    ? resolvedDayLabelWidth
    : Math.min(resolvedDayLabelWidth, svgWidth * (compact ? 0.08 : 0.1));
  const desiredRightEdgeGutter = autoWidth ? 0 : compact ? 6 : 8;
  const availableHeatmapWidth = Math.max(svgWidth - responsiveDayLabelWidth, 0);
  const desiredHourGap = autoWidth
    ? hourGap
    : availableHeatmapWidth < (compact ? 300 : 420)
      ? compact
        ? 1
        : 2
      : hourGap;
  const rightEdgeGutter = Math.min(desiredRightEdgeGutter, availableHeatmapWidth);
  const heatmapBudget = Math.max(availableHeatmapWidth - rightEdgeGutter, 0);
  const responsiveHourGap = Math.min(desiredHourGap, heatmapBudget / 23 || 0);
  const computedHourWidth = Math.max((heatmapBudget - responsiveHourGap * 23) / 24, 0);
  const heatmapWidth = computedHourWidth * 24 + responsiveHourGap * 23;
  const responsiveAxisFontSize = autoWidth
    ? axisFontSize
    : computedHourWidth < 8
      ? Math.max(axisFontSize - 2, 6)
      : computedHourWidth < 11
        ? Math.max(axisFontSize - 1, 7)
        : axisFontSize;
  const responsiveDayFontSize = autoWidth
    ? dayFontSize
    : computedHourWidth < 9
      ? Math.max(dayFontSize - 1, 8)
      : dayFontSize;
  const responsiveHourLabelStep = autoWidth
    ? hourLabelStep
    : computedHourWidth < 6
      ? Math.max(hourLabelStep, 3)
      : computedHourWidth < 8
        ? Math.max(hourLabelStep, 2)
        : hourLabelStep;
  const rowPadding = Math.max((rowHeight - cellHeight) / 2, 0);
  const availableRowsHeight = Math.max(svgHeight - headerHeight - Math.max(schedule.days.length - 1, 0) * rowGap, schedule.days.length * rowHeight);
  const computedRowHeight = availableRowsHeight / schedule.days.length;
  const computedCellHeight = Math.max(computedRowHeight - rowPadding * 2, cellHeight);

  return (
    <div className="schedule-grid-card-wrapper relative z-0 overflow-visible">
      <div className={cn("schedule-grid-card w-full", compact ? "min-w-0 is-compact" : "min-w-0", autoWidth && "is-auto-width")}>
        <div className="schedule-modern-scroll">
          <div ref={viewportRef} className="schedule-modern-viewport">
            <div className="schedule-modern-canvas">
              <svg
                width={svgWidth}
                height={svgHeight}
                viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                className="schedule-modern-svg"
                style={{
                  width: autoWidth ? `${svgWidth}px` : "100%",
                  height: stretchToFitHeight ? "100%" : `${svgHeight}px`,
                }}
                role="img"
                aria-label="Тепловая карта активности расписания по дням и часам"
              >
                <Group top={0} left={0}>
                  {showDayHeaderLabel ? (
                    <VisxText
                      x={0}
                      y={headerHeight - 6}
                      verticalAnchor="end"
                      className="schedule-modern-axis-title"
                      style={{ fontSize: responsiveAxisFontSize, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}
                    >
                      День
                    </VisxText>
                  ) : null}

                  {Array.from({ length: 24 }, (_, index) => {
                    const x = responsiveDayLabelWidth + index * (computedHourWidth + responsiveHourGap) + computedHourWidth / 2;
                    return (
                      <VisxText
                        key={`schedule-hour-${index}`}
                        x={x}
                        y={headerHeight - 6}
                        textAnchor="middle"
                        verticalAnchor="end"
                        className="schedule-modern-axis-text"
                        style={{ fontSize: responsiveAxisFontSize, fontWeight: 700 }}
                      >
                        {index % responsiveHourLabelStep === 0 ? String(index) : ""}
                      </VisxText>
                    );
                  })}

                  {schedule.days.map((day, dayIndex) => {
                    const rowTop = headerHeight + dayIndex * (computedRowHeight + rowGap);
                    const laneTop = rowTop + (computedRowHeight - computedCellHeight) / 2;
                    return (
                      <Group key={day.key} top={rowTop} left={0}>
                        <VisxText
                          x={0}
                          y={computedRowHeight / 2}
                          verticalAnchor="middle"
                          className="schedule-modern-day-text"
                          style={{ fontSize: responsiveDayFontSize, fontWeight: 700, letterSpacing: compact ? "0.06em" : "0.08em", textTransform: "uppercase" }}
                        >
                          {compactDayLabelValue(day.key, day.label)}
                        </VisxText>

                        <rect
                          x={responsiveDayLabelWidth}
                          y={(computedRowHeight - computedCellHeight) / 2}
                          width={heatmapWidth}
                          height={computedCellHeight}
                          rx={cellRadius + 2}
                          fill="rgba(247, 249, 253, 0.82)"
                        />

                        {day.hours.map((slot, hourIndex) => {
                          const x = responsiveDayLabelWidth + hourIndex * (computedHourWidth + responsiveHourGap);
                          const count = Number(slot.count || 0);
                          const active = Boolean(slot.active || count > 0);
                          const tone = resolveScheduleCellTone(count, active, maxCount);
                          const tooltipTitle = `${tooltipDayLabelValue(day.key, day.label)}, ${slot.hour}:00`;
                          const slotTop = laneTop;
                          const slotBottom = laneTop + computedCellHeight;
                          const tooltipAnchorLeft = x + computedHourWidth / 2;
                          const showBelow = slotTop < (compact ? 24 : 38);

                          return (
                            <Group key={`${day.key}-${slot.hour}`}>
                              <rect
                                x={x}
                                y={(computedRowHeight - computedCellHeight) / 2}
                                width={computedHourWidth}
                                height={computedCellHeight}
                                rx={cellRadius}
                                fill={tone.fill}
                                stroke={tone.stroke}
                                strokeWidth={1}
                                onPointerEnter={() =>
                                  showTooltip({
                                    tooltipData: {
                                      dayLabel: tooltipTitle,
                                      hour: slot.hour,
                                      count,
                                      active,
                                      placement: showBelow ? "bottom" : "top",
                                    },
                                    tooltipLeft: tooltipAnchorLeft,
                                    tooltipTop: showBelow ? slotBottom : slotTop,
                                  })
                                }
                                onPointerMove={() =>
                                  showTooltip({
                                    tooltipData: {
                                      dayLabel: tooltipTitle,
                                      hour: slot.hour,
                                      count,
                                      active,
                                      placement: showBelow ? "bottom" : "top",
                                    },
                                    tooltipLeft: tooltipAnchorLeft,
                                    tooltipTop: showBelow ? slotBottom : slotTop,
                                  })
                                }
                                onPointerLeave={() => hideTooltip()}
                              />
                              {showCounts && count > 0 && computedHourWidth >= 14 ? (
                                <VisxText
                                  x={x + computedHourWidth / 2}
                                  y={computedRowHeight / 2}
                                  textAnchor="middle"
                                  verticalAnchor="middle"
                                  style={{ fontSize: countFontSize, fontWeight: 700, fill: tone.count }}
                                >
                                  {String(count)}
                                </VisxText>
                              ) : null}
                            </Group>
                          );
                        })}
                      </Group>
                    );
                  })}
                </Group>
              </svg>
            </div>
          </div>
          {tooltipOpen && tooltipData ? (
            <div
              className={cn("schedule-modern-tooltip", tooltipData.placement === "bottom" && "is-below")}
              style={{
                left: tooltipLeft ?? 0,
                top: tooltipTop ?? 0,
              }}
            >
              <strong>{tooltipData.dayLabel}</strong>
              <span>
                {tooltipData.active
                  ? tooltipData.count > 1
                    ? `${tooltipData.count} РК активно`
                    : "Активно"
                  : "Неактивно"}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ProductListCard({
  title,
  subtitle,
  imageUrl,
  chips,
  onClick,
  active,
}: {
  title: string;
  subtitle: ReactNode;
  imageUrl?: string | null;
  chips?: ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "glass-panel flex w-full items-start gap-3 rounded-[24px] p-3 text-left transition hover:-translate-y-0.5 hover:border-brand-300/35",
        active && "border-brand-300/40 bg-brand-100/80",
      )}
    >
      <div className="h-16 aspect-[51/68] shrink-0 overflow-hidden rounded-2xl bg-[var(--color-surface-strong)]">
        {imageUrl ? (
          <img src={imageUrl} alt={title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-[var(--color-muted)]">N/A</div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-[var(--color-ink)]">{title}</p>
        <div className="mt-1 text-sm text-[var(--color-muted)]">{subtitle}</div>
        {chips ? <div className="mt-2 flex flex-wrap gap-2">{chips}</div> : null}
      </div>
      <ChevronRight className="mt-1 size-4 shrink-0 text-[var(--color-muted)]" />
    </button>
  );
}

export function InlineMetricSet({
  values,
}: {
  values: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {values.map((item) => (
        <MiniStat key={item.label} label={item.label} value={item.value} />
      ))}
    </div>
  );
}

export function LoadingState({ title = "Загрузка данных" }: { title?: string }) {
  return (
    <div className="glass-panel flex min-h-64 flex-col items-center justify-center rounded-[30px] gap-3">
      <LoaderCircle className="size-6 animate-spin text-brand-200" />
      <p className="text-sm text-[var(--color-muted)]">{title}</p>
    </div>
  );
}

export function ComparisonHint({
  current,
  previous,
  type,
}: {
  current: number | string | null | undefined;
  previous: number | string | null | undefined;
  type: "number" | "money" | "percent";
}) {
  const currentNumber = typeof current === "string" ? Number(current) : current;
  const previousNumber = typeof previous === "string" ? Number(previous) : previous;
  if (previousNumber === null || previousNumber === undefined || Number.isNaN(previousNumber)) {
    return <span className="text-[var(--color-muted)]">Нет данных для сравнения</span>;
  }

  const delta = (currentNumber ?? 0) - previousNumber;
  const formatValue = () => {
    if (type === "money") {
      return `${formatMoney(previousNumber)} ранее`;
    }
    if (type === "percent") {
      return `${formatPercent(previousNumber)} ранее`;
    }
    return `${formatNumber(previousNumber)} ранее`;
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>{formatValue()}</span>
      <span className={relativeDeltaClass(delta)}>{type === "money" ? formatMoney(delta, true) : type === "percent" ? formatPercent(delta) : formatNumber(delta)}</span>
    </span>
  );
}

export function ProductMetaChips({
  stock,
  views,
  spend,
  period,
}: {
  stock?: number | null;
  views?: number | null;
  spend?: number | null;
  period?: { start?: string | null; end?: string | null };
}) {
  return (
    <>
      <MiniStat label="Период" value={formatDateRange(period?.start, period?.end)} />
      <MiniStat label="Остаток" value={formatNumber(stock)} />
      <MiniStat label="Показы" value={formatCompactNumber(views)} />
      <MiniStat label="Расход" value={formatMoney(spend)} />
    </>
  );
}
