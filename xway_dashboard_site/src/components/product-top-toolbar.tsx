import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { cn } from "../lib/format";

const MONTHS_RU = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

const DAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const TOOLBAR_COLLAPSED_STORAGE_KEY = "xway-product-toolbar-collapsed";

function parseDate(iso: string) {
  if (!iso) {
    return null;
  }
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(iso: string) {
  const parsed = parseDate(iso);
  if (!parsed) {
    return "—";
  }
  return parsed.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number) {
  const day = new Date(year, month, 1).getDay();
  return (day + 6) % 7;
}

function ToolbarLogo({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" className={className}>
      <defs>
        <linearGradient id="toolbar-logo-bg" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2EB67D" />
          <stop offset="0.55" stopColor="#1C9ED8" />
          <stop offset="1" stopColor="#F17828" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="18" fill="#F7F6FA" />
      <rect x="8" y="8" width="48" height="48" rx="14" fill="url(#toolbar-logo-bg)" />
      <path d="M19 19h10.5l6.5 10 6.5-10H45L37 31l8 14H34.5L29 36l-5.5 9H13l8-14-8-12Z" fill="#FDFCFB" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="flex-shrink-0 opacity-50">
      <rect x="1" y="3" width="12" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 1v2M10 1v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M1 6h12" stroke="currentColor" strokeWidth="1.1" strokeOpacity="0.5" />
    </svg>
  );
}

function CalendarPortal({
  anchorRect,
  onClose,
  children,
}: {
  anchorRect: DOMRect;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = 256;
  const gap = 6;
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportLeft = window.visualViewport?.offsetLeft ?? 0;
  const top = anchorRect.bottom + gap;
  const left = Math.max(viewportLeft + 12, Math.min(anchorRect.left, viewportLeft + viewportWidth - width - 12));

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleMouseDown, true);
    return () => document.removeEventListener("mousedown", handleMouseDown, true);
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top, left, width, zIndex: 99999 }}
      className="overflow-hidden rounded-[20px] border border-[var(--color-line)] bg-white shadow-[0_20px_60px_rgba(44,35,66,0.22)]"
    >
      {children}
    </div>,
    document.body,
  );
}

function ToolbarDatePicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (iso: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const parsed = parseDate(value);
  const today = new Date();
  const [viewYear, setViewYear] = useState(parsed?.getFullYear() ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(parsed?.getMonth() ?? today.getMonth());

  useEffect(() => {
    if (!open) {
      return;
    }
    const updateRect = () => {
      if (buttonRef.current) {
        setAnchorRect(buttonRef.current.getBoundingClientRect());
      }
    };
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    window.visualViewport?.addEventListener("scroll", updateRect);
    window.visualViewport?.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
      window.visualViewport?.removeEventListener("scroll", updateRect);
      window.visualViewport?.removeEventListener("resize", updateRect);
    };
  }, [open]);

  useEffect(() => {
    const nextDate = parseDate(value);
    if (nextDate) {
      setViewMonth(nextDate.getMonth());
      setViewYear(nextDate.getFullYear());
    }
  }, [value]);

  const totalDays = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfWeek(viewYear, viewMonth);
  const cells: Array<number | null> = [...Array(firstDay).fill(null), ...Array.from({ length: totalDays }, (_, index) => index + 1)];
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  const openCalendar = () => {
    if (buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setOpen((current) => !current);
  };

  const selectDay = (day: number) => {
    onChange(toIso(new Date(viewYear, viewMonth, day)));
    setOpen(false);
  };

  const isSelected = (day: number) =>
    !!parsed &&
    parsed.getFullYear() === viewYear &&
    parsed.getMonth() === viewMonth &&
    parsed.getDate() === day;

  const isToday = (day: number) =>
    today.getFullYear() === viewYear &&
    today.getMonth() === viewMonth &&
    today.getDate() === day;

  return (
    <div className="flex flex-shrink-0 items-center gap-1.5">
      <span className="text-xs font-semibold leading-none text-[var(--color-muted)]">{label}</span>
      <button
        ref={buttonRef}
        type="button"
        onClick={openCalendar}
        className={cn(
          "flex h-8 items-center gap-2 rounded-[11px] border px-3 text-sm font-semibold whitespace-nowrap transition-all",
          open
            ? "border-[rgba(241,120,40,0.45)] bg-white text-[var(--color-ink)] shadow-[0_0_0_3px_rgba(241,120,40,0.1)]"
            : "border-[var(--color-line)] bg-[var(--color-surface-soft)] text-[var(--color-ink)] hover:border-[rgba(241,120,40,0.3)] hover:bg-white",
        )}
      >
        {formatDisplayDate(value)}
        <CalendarIcon />
      </button>

      {open && anchorRect ? (
        <CalendarPortal anchorRect={anchorRect} onClose={() => setOpen(false)}>
          <div className="flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-3">
            <button type="button" onClick={() => (viewMonth === 0 ? (setViewMonth(11), setViewYear((year) => year - 1)) : setViewMonth((month) => month - 1))} className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-line)]">
              <ChevronLeft className="h-4 w-4 text-[var(--color-muted)]" />
            </button>
            <span className="font-display text-sm text-[var(--color-ink)]">
              {MONTHS_RU[viewMonth]} {viewYear}
            </span>
            <button type="button" onClick={() => (viewMonth === 11 ? (setViewMonth(0), setViewYear((year) => year + 1)) : setViewMonth((month) => month + 1))} className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-line)]">
              <ChevronRight className="h-4 w-4 text-[var(--color-muted)]" />
            </button>
          </div>

          <div className="grid grid-cols-7 px-2 pb-1 pt-2">
            {DAYS_SHORT.map((day) => (
              <div key={day} className="flex h-7 items-center justify-center">
                <span className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-muted)]">{day}</span>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-y-0.5 px-2 pb-3">
            {cells.map((day, index) =>
              day ? (
                <button
                  key={`${day}-${index}`}
                  type="button"
                  onClick={() => selectDay(day)}
                  className={cn(
                    "flex h-8 w-full items-center justify-center rounded-[10px] text-sm font-semibold transition-all",
                    isSelected(day)
                      ? "bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-deep)] text-white shadow-[0_4px_12px_rgba(241,120,40,0.35)]"
                      : isToday(day)
                        ? "border border-[rgba(241,120,40,0.4)] bg-[rgba(241,120,40,0.06)] text-[var(--color-accent-deep)]"
                        : "text-[var(--color-ink)] hover:bg-[var(--color-surface-strong)]",
                  )}
                >
                  {day}
                </button>
              ) : (
                <div key={`empty-${index}`} />
              ),
            )}
          </div>

          <div className="flex gap-1.5 border-t border-[var(--color-line)] px-3 pb-3 pt-1">
            {[
              { label: "Сегодня", days: 0 },
              { label: "−7 дн", days: 7 },
              { label: "−30 дн", days: 30 },
            ].map((preset) => (
              <button
                type="button"
                key={preset.label}
                onClick={() => {
                  const nextDate = new Date();
                  nextDate.setDate(nextDate.getDate() - preset.days);
                  setViewMonth(nextDate.getMonth());
                  setViewYear(nextDate.getFullYear());
                  onChange(toIso(nextDate));
                  setOpen(false);
                }}
                className="h-7 flex-1 rounded-[9px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] text-[10px] font-bold text-[var(--color-muted)] transition-all hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </CalendarPortal>
      ) : null}
    </div>
  );
}

export function ProductTopToolbar({
  start,
  end,
  preset,
  productPath,
  catalogPath,
  activeView = "product",
  compareEnabled,
  onCompareEnabledChange,
  onRangeChange,
  onPresetChange,
  onRefresh,
  onScrollTop,
  refreshing = false,
  onHeightChange,
}: {
  start: string;
  end: string;
  preset: string;
  productPath: string;
  catalogPath: string;
  activeView?: "product" | "catalog";
  compareEnabled: boolean;
  onCompareEnabledChange: (next: boolean) => void;
  onRangeChange: (next: { start: string; end: string }) => void;
  onPresetChange: (preset: string) => void;
  onRefresh: () => void;
  onScrollTop: () => void;
  refreshing?: boolean;
  onHeightChange?: (height: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(TOOLBAR_COLLAPSED_STORAGE_KEY) === "1";
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const periods = [
    { value: "today", label: "сегодня" },
    { value: "yesterday", label: "вчера" },
    { value: "3", label: "3" },
    { value: "7", label: "7" },
    { value: "14", label: "14" },
    { value: "30", label: "30" },
  ];

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(TOOLBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    if (!onHeightChange || typeof window === "undefined") {
      return;
    }

    const updateHeight = () => {
      const nextHeight = Math.ceil(rootRef.current?.getBoundingClientRect().bottom ?? 0);
      onHeightChange(nextHeight);
    };

    updateHeight();

    if (!rootRef.current || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(updateHeight);
    observer.observe(rootRef.current);
    window.addEventListener("resize", updateHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [activeView, collapsed, compareEnabled, end, onHeightChange, preset, refreshing, start]);

  if (collapsed) {
    return (
      <div ref={rootRef} className="fixed right-[18px] top-3 z-40">
        <div className="flex items-center gap-2 rounded-[22px] border border-[var(--color-line)] bg-white/95 px-3 py-2 shadow-[0_12px_40px_rgba(44,35,66,0.1)] backdrop-blur-xl">
          <button
            type="button"
            onClick={onScrollTop}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-surface-soft)] transition-all hover:bg-[var(--color-line)]"
            title="Наверх"
          >
            <ToolbarLogo className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--color-line)] bg-[var(--color-surface-soft)] text-[var(--color-muted)] transition-all hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
            title="Развернуть меню"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="fixed left-[18px] right-[18px] top-3 z-40">
      <div className="flex items-center gap-2 overflow-x-auto rounded-[22px] border border-[var(--color-line)] bg-white/95 px-3 py-2 shadow-[0_12px_40px_rgba(44,35,66,0.1)] backdrop-blur-xl">
        <ToolbarLogo className="h-6 w-6 flex-shrink-0" />
        <div className="h-5 w-px flex-shrink-0 bg-[var(--color-line)]" />

        <ToolbarDatePicker label="с" value={start} onChange={(value) => onRangeChange({ start: value, end })} />
        <ToolbarDatePicker label="по" value={end} onChange={(value) => onRangeChange({ start, end: value })} />

        <button
          type="button"
          onClick={onRefresh}
          className="flex h-8 flex-shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-deep)] px-4 text-sm font-semibold whitespace-nowrap text-white shadow-[0_6px_16px_rgba(241,120,40,0.28)] transition-all hover:shadow-[0_10px_24px_rgba(241,120,40,0.38)] disabled:cursor-progress disabled:opacity-70"
          disabled={refreshing}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          Обновить
        </button>

        <div className="min-w-[8px] flex-1" />

        <label className="flex h-8 flex-shrink-0 cursor-pointer items-center gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-surface-soft)] px-3 text-sm font-semibold whitespace-nowrap text-[var(--color-ink)] transition-all hover:border-[rgba(241,120,40,0.22)] hover:bg-white">
          <span
            className={cn(
              "flex h-4 w-4 items-center justify-center rounded-[5px] border transition-all",
              compareEnabled
                ? "border-[rgba(241,120,40,0.45)] bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-deep)] text-white shadow-[0_4px_10px_rgba(241,120,40,0.22)]"
                : "border-[var(--color-line)] bg-white text-transparent",
            )}
            aria-hidden="true"
          >
            <Check className="h-3 w-3" />
          </span>
          <span>Сравнение периода</span>
          <input
            type="checkbox"
            checked={compareEnabled}
            onChange={(event) => onCompareEnabledChange(event.target.checked)}
            className="sr-only"
          />
        </label>

        <div className="chart-window-switch flex-shrink-0" aria-label="Период сравнения">
          {periods.map((period) => (
            <button
              type="button"
              key={period.value}
              onClick={() => onPresetChange(period.value)}
              className={cn(
                "chart-window-chip h-8 px-3 text-sm",
                preset === period.value && "is-active",
              )}
            >
              {period.label}
            </button>
          ))}
        </div>

        <div className="h-5 w-px flex-shrink-0 bg-[var(--color-line)]" />

        <div className="flex flex-shrink-0 items-center rounded-full border border-[var(--color-line)] bg-[rgba(248,247,252,0.94)] p-0.5">
          {activeView === "product" ? (
            <>
              <span className="inline-flex h-7 items-center rounded-full bg-white px-3 text-sm font-semibold leading-none whitespace-nowrap text-[var(--color-ink)] shadow-[0_4px_12px_rgba(44,35,66,0.1)]">
                Товар
              </span>
              <Link to={catalogPath} className="inline-flex h-7 items-center rounded-full px-3 text-sm font-semibold leading-none whitespace-nowrap text-[var(--color-muted)] transition-all hover:text-[var(--color-ink)]">
                Артикулы
              </Link>
            </>
          ) : (
            <>
              <Link to={productPath} className="inline-flex h-7 items-center rounded-full px-3 text-sm font-semibold leading-none whitespace-nowrap text-[var(--color-muted)] transition-all hover:text-[var(--color-ink)]">
                Товар
              </Link>
              <span className="inline-flex h-7 items-center rounded-full bg-white px-3 text-sm font-semibold leading-none whitespace-nowrap text-[var(--color-ink)] shadow-[0_4px_12px_rgba(44,35,66,0.1)]">
                Артикулы
              </span>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-[var(--color-line)] bg-[var(--color-surface-soft)] text-[var(--color-muted)] transition-all hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
          title="Свернуть меню"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
