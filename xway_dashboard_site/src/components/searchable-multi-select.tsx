import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "../lib/format";

export interface SearchableMultiSelectOption {
  value: string;
  label: string;
  searchText?: string;
}

export function SearchableMultiSelect({
  label,
  allLabel,
  options,
  selectedValues,
  onChange,
  emptyText = "Ничего не найдено",
  className,
}: {
  label: string;
  allLabel: string;
  options: SearchableMultiSelectOption[];
  selectedValues: string[];
  onChange: (values: string[]) => void;
  emptyText?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedSet = new Set(selectedValues);
  const normalizedSearch = search.trim().toLowerCase();
  const filteredOptions = options.filter((option) => {
    if (!normalizedSearch) {
      return true;
    }
    const haystack = `${option.label} ${option.searchText || ""}`.toLowerCase();
    return haystack.includes(normalizedSearch);
  });
  const selectedOptions = options.filter((option) => selectedSet.has(option.value));
  const summary = !selectedOptions.length
    ? allLabel
    : selectedOptions.length === 1
      ? selectedOptions[0]?.label || allLabel
      : `${selectedOptions.length} выбрано`;

  useEffect(() => {
    if (!open) {
      setSearch("");
      return;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!rootRef.current || !(target instanceof Node)) {
        return;
      }
      if (!rootRef.current.contains(target)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [open]);

  const toggleValue = (value: string) => {
    if (selectedSet.has(value)) {
      onChange(selectedValues.filter((item) => item !== value));
      return;
    }
    onChange([...selectedValues, value]);
  };

  return (
    <div ref={rootRef} className={cn("relative min-w-[220px] flex-1 sm:flex-none", className)}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "metric-chip flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left transition",
          open && "border-[var(--color-brand-300)] shadow-[0_10px_30px_rgba(44,35,66,0.08)]",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--color-muted)]">{label}</p>
          <p className="truncate text-sm font-medium text-[var(--color-ink)]">{summary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selectedValues.length ? (
            <span className="rounded-full bg-[var(--color-brand-100)] px-2 py-0.5 text-xs font-semibold text-brand-200">
              {selectedValues.length}
            </span>
          ) : null}
          <ChevronDown className={cn("size-4 text-[var(--color-muted)] transition", open && "rotate-180 text-brand-200")} />
        </div>
      </button>

      {open ? (
        <div className="glass-panel absolute left-0 top-[calc(100%+10px)] z-40 w-full min-w-[280px] rounded-[24px] p-3">
          <div className="metric-chip flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm text-[var(--color-muted)]">
            <Search className="size-4 text-brand-200" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`Поиск: ${label.toLowerCase()}`}
              className="w-full bg-transparent text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
            />
          </div>

          <div className="mt-3 max-h-72 space-y-1 overflow-y-auto pr-1">
            {filteredOptions.length ? (
              filteredOptions.map((option) => {
                const checked = selectedSet.has(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => toggleValue(option.value)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-2xl px-3 py-2.5 text-left transition",
                      checked ? "bg-[var(--color-brand-100)] text-[var(--color-ink)]" : "hover:bg-[var(--color-surface-soft)]",
                    )}
                    role="option"
                    aria-selected={checked}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border",
                        checked
                          ? "border-brand-200 bg-brand-200 text-white"
                          : "border-[var(--color-line-strong)] bg-white text-transparent",
                      )}
                    >
                      <Check className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 text-sm leading-5">{option.label}</span>
                  </button>
                );
              })
            ) : (
              <div className="rounded-2xl bg-[var(--color-surface-soft)] px-3 py-6 text-center text-sm text-[var(--color-muted)]">
                {emptyText}
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--color-line)] px-1 pt-3">
            <span className="text-xs text-[var(--color-muted)]">Выбрано: {selectedValues.length}</span>
            <button
              type="button"
              onClick={() => onChange([])}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-muted)] transition hover:text-brand-200"
            >
              <X className="size-3.5" />
              Сбросить
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
