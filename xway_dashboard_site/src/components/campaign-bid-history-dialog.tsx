import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { buildDailyBidRows, countBidDayChanges, formatBidMoney, parseBidHistoryDate, resolveBidKind, resolveBidLabel, type DailyBidRow } from "../lib/bid-history";
import { formatNumber, toNumber } from "../lib/format";
import type { CampaignSummary } from "../lib/types";
import { EmptyState, MetricTable, SectionCard } from "./ui";

interface CampaignBidHistoryDialogTarget {
  productArticle: string;
  campaign: CampaignSummary;
  rangeLabel: string;
}

type BidHistoryWindowPreset = "all" | 7 | 14 | 30 | 60 | 90 | "custom";

function formatLocalIsoDay(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftIsoDay(day: string, deltaDays: number) {
  const parsed = new Date(`${day}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return day;
  }
  parsed.setDate(parsed.getDate() + deltaDays);
  return formatLocalIsoDay(parsed);
}

function clampIsoDay(day: string | null, minDay: string | null, maxDay: string | null) {
  if (!day) {
    return null;
  }
  if (minDay && day < minDay) {
    return minDay;
  }
  if (maxDay && day > maxDay) {
    return maxDay;
  }
  return day;
}

function formatBidRangeLabel(startDay: string | null, endDay: string | null) {
  if (!startDay && !endDay) {
    return "—";
  }
  const formatOne = (day: string) => {
    const parsed = new Date(`${day}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) {
      return day;
    }
    return parsed.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "short",
    });
  };
  if (startDay && endDay) {
    return startDay === endDay ? formatOne(startDay) : `${formatOne(startDay)} - ${formatOne(endDay)}`;
  }
  return formatOne(startDay || endDay || "");
}

function formatBidTooltipDate(day: string) {
  const parsed = new Date(`${day}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return day;
  }
  return parsed.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function resolveBidTickInterval(pointsCount: number) {
  if (pointsCount <= 16) {
    return 0;
  }
  if (pointsCount <= 28) {
    return 1;
  }
  if (pointsCount <= 45) {
    return 2;
  }
  if (pointsCount <= 75) {
    return 4;
  }
  return 6;
}

function BidHistoryTooltip({
  active,
  payload,
  bidLabel,
  bidKind,
}: {
  active?: boolean;
  payload?: Array<{ payload?: DailyBidRow }>;
  bidLabel: string;
  bidKind: "cpm" | "cpc";
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) {
    return null;
  }

  const showChangeMeta = Boolean(row.changed && row.changeDelta !== null);
  const deltaText = showChangeMeta ? `${row.changeDelta! > 0 ? "+" : ""}${formatBidMoney(row.changeDelta, bidKind)}` : null;
  const actorText = showChangeMeta ? row.lastChangeActor || row.lastChangeOrigin || null : null;

  return (
    <div
      className="rounded-[16px] border border-[#e3e1ea] bg-[rgba(255,255,255,0.96)] px-4 py-3 shadow-[0_18px_40px_rgba(44,35,66,0.12)]"
      style={{ minWidth: 260 }}
    >
      <div className="text-[17px] font-semibold text-[var(--color-ink)]">{formatBidTooltipDate(row.day)}</div>
      <div className="mt-2 text-[16px] font-medium text-[#4b7bff]">
        {bidLabel}: {formatBidMoney(row.bid, bidKind)}
      </div>
      {showChangeMeta && deltaText ? (
        <div className="mt-1 text-[15px] font-medium text-[var(--color-ink)]">Изменение к пред. дню: {deltaText}</div>
      ) : null}
      {showChangeMeta && actorText ? (
        <div className="mt-1 text-[15px] text-[var(--color-muted)]">Кто менял: {actorText}</div>
      ) : null}
    </div>
  );
}

export function CampaignBidHistoryDialog({
  target,
  onClose,
}: {
  target: CampaignBidHistoryDialogTarget | null;
  onClose: () => void;
}) {
  const allBidRows = useMemo(
    () => (target ? buildDailyBidRows(target.campaign, { mode: "history" }) : []),
    [target],
  );
  const minDay = allBidRows[0]?.day ?? null;
  const maxDay = allBidRows[allBidRows.length - 1]?.day ?? null;
  const [windowPreset, setWindowPreset] = useState<BidHistoryWindowPreset>(14);
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [rangeEnd, setRangeEnd] = useState<string | null>(null);
  const [isRawHistoryCollapsed, setRawHistoryCollapsed] = useState(true);
  const effectiveRangeStart = rangeStart ?? minDay;
  const effectiveRangeEnd = rangeEnd ?? maxDay;

  useEffect(() => {
    setWindowPreset(14);
    setRawHistoryCollapsed(true);
    if (!minDay || !maxDay) {
      setRangeStart(minDay);
      setRangeEnd(maxDay);
      return;
    }
    const startCandidate = shiftIsoDay(maxDay, -(14 - 1));
    setRangeStart(startCandidate < minDay ? minDay : startCandidate);
    setRangeEnd(maxDay);
  }, [target, minDay, maxDay]);

  const bidRows = useMemo(
    () =>
      allBidRows.filter(
        (row) => (!effectiveRangeStart || row.day >= effectiveRangeStart) && (!effectiveRangeEnd || row.day <= effectiveRangeEnd),
      ),
    [allBidRows, effectiveRangeEnd, effectiveRangeStart],
  );
  const bidLabel = target ? resolveBidLabel(target.campaign) : "Ставка";
  const bidKind = target ? resolveBidKind(target.campaign) : "cpm";
  const latestBid = bidRows[bidRows.length - 1]?.bid ?? (target ? toNumber(target.campaign.bid) : null);
  const totalChanges = useMemo(() => countBidDayChanges(bidRows), [bidRows]);
  const displayRangeLabel = useMemo(
    () => formatBidRangeLabel(effectiveRangeStart, effectiveRangeEnd),
    [effectiveRangeEnd, effectiveRangeStart],
  );
  const filteredBidHistory = useMemo(() => {
    if (!target) {
      return [];
    }
    return (target.campaign.bid_history || []).filter((row) => {
      const parsed = parseBidHistoryDate(row);
      if (!parsed) {
        return !effectiveRangeStart && !effectiveRangeEnd;
      }
      const day = formatLocalIsoDay(parsed);
      return (!effectiveRangeStart || day >= effectiveRangeStart) && (!effectiveRangeEnd || day <= effectiveRangeEnd);
    });
  }, [effectiveRangeEnd, effectiveRangeStart, target]);
  const xTickInterval = useMemo(() => resolveBidTickInterval(bidRows.length), [bidRows.length]);

  const handlePresetChange = (preset: Exclude<BidHistoryWindowPreset, "custom">) => {
    setWindowPreset(preset);
    if (!minDay || !maxDay || preset === "all") {
      setRangeStart(minDay);
      setRangeEnd(maxDay);
      return;
    }

    const startCandidate = shiftIsoDay(maxDay, -(preset - 1));
    setRangeStart(startCandidate < minDay ? minDay : startCandidate);
    setRangeEnd(maxDay);
  };

  const handleStartChange = (value: string) => {
    const nextStart = clampIsoDay(value || minDay, minDay, maxDay);
    const currentEnd = effectiveRangeEnd;
    setWindowPreset("custom");
    setRangeStart(nextStart);
    setRangeEnd(nextStart && currentEnd && nextStart > currentEnd ? nextStart : currentEnd);
  };

  const handleEndChange = (value: string) => {
    const nextEnd = clampIsoDay(value || maxDay, minDay, maxDay);
    const currentStart = effectiveRangeStart;
    setWindowPreset("custom");
    setRangeStart(currentStart && nextEnd && currentStart > nextEnd ? nextEnd : currentStart);
    setRangeEnd(nextEnd);
  };

  useEffect(() => {
    if (!target) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeydown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [onClose, target]);

  if (!target) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[5000] flex items-center justify-center p-1 sm:p-2">
      <button type="button" aria-label="Закрыть" className="absolute inset-0 bg-[rgba(38,33,58,0.28)] backdrop-blur-sm" onClick={onClose} />
      <div className="glass-panel relative z-[5001] flex h-[calc(100vh-8px)] max-h-[calc(100vh-8px)] w-full max-w-[calc(100vw-8px)] flex-col overflow-hidden rounded-[34px]">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-brand-200">{target.productArticle}</p>
            <h2 className="font-display mt-2 text-2xl font-semibold text-[var(--color-ink)]">{target.campaign.name}</h2>
            <p className="mt-2 text-sm text-[var(--color-muted)]">{bidLabel} · {displayRangeLabel}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="metric-chip rounded-2xl p-3 text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-6">
            <SectionCard
              title="Изменение ставки по дням"
              caption="Последняя известная ставка на конец каждого дня по всем доступным логам"
              actions={
                <div className="flex flex-col items-end gap-3">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <div className="chart-window-switch">
                      {[
                        { key: "all" as const, label: "Все" },
                        { key: 7 as const, label: "7" },
                        { key: 14 as const, label: "14" },
                        { key: 30 as const, label: "30" },
                        { key: 60 as const, label: "60" },
                        { key: 90 as const, label: "90" },
                      ].map((option) => (
                        <button
                          key={String(option.key)}
                          type="button"
                          onClick={() => handlePresetChange(option.key)}
                          className={windowPreset === option.key ? "chart-window-chip is-active" : "chart-window-chip"}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <label className="metric-chip flex min-h-[42px] items-center gap-3 rounded-2xl px-4 py-2.5 text-sm text-[var(--color-muted)]">
                      <span>Начало</span>
                      <input
                        type="date"
                        min={minDay || undefined}
                        max={maxDay || undefined}
                        value={rangeStart || ""}
                        onChange={(event) => handleStartChange(event.target.value)}
                        className="ml-auto bg-transparent text-[var(--color-ink)] outline-none"
                      />
                    </label>
                    <label className="metric-chip flex min-h-[42px] items-center gap-3 rounded-2xl px-4 py-2.5 text-sm text-[var(--color-muted)]">
                      <span>Конец</span>
                      <input
                        type="date"
                        min={minDay || undefined}
                        max={maxDay || undefined}
                        value={rangeEnd || ""}
                        onChange={(event) => handleEndChange(event.target.value)}
                        className="ml-auto bg-transparent text-[var(--color-ink)] outline-none"
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <div className="metric-chip min-w-[124px] rounded-[20px] px-3 py-2 text-left">
                      <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-muted)]">Тип ставки</span>
                      <strong className="mt-1 block text-sm text-[var(--color-ink)]">{bidLabel}</strong>
                    </div>
                    <div className="metric-chip min-w-[132px] rounded-[20px] px-3 py-2 text-left">
                      <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-muted)]">Текущая ставка</span>
                      <strong className="mt-1 block text-sm text-[var(--color-ink)]">{formatBidMoney(latestBid, bidKind)}</strong>
                    </div>
                    <div className="metric-chip min-w-[132px] rounded-[20px] px-3 py-2 text-left">
                      <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-muted)]">Изменений</span>
                      <strong className="mt-1 block text-sm text-[var(--color-ink)]">{formatNumber(totalChanges)}</strong>
                    </div>
                    <div className="metric-chip min-w-[140px] rounded-[20px] px-3 py-2 text-left">
                      <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-muted)]">Период</span>
                      <strong className="mt-1 block text-sm text-[var(--color-ink)]">{displayRangeLabel}</strong>
                    </div>
                  </div>
                </div>
              }
            >
                {bidRows.length ? (
                  <div className="h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={bidRows} margin={{ top: 8, right: 18, left: 0, bottom: 8 }}>
                        <CartesianGrid stroke="#e7e3ee" strokeDasharray="3 3" />
                        <XAxis
                          dataKey="label"
                          interval={xTickInterval}
                          height={54}
                          tickMargin={10}
                          angle={-35}
                          textAnchor="end"
                          tick={{ fill: "#807a93", fontSize: 10, fontWeight: 700 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fill: "#807a93", fontSize: 10, fontWeight: 700 }}
                          axisLine={false}
                          tickLine={false}
                          width={72}
                          tickFormatter={(value) => formatNumber(value)}
                        />
                        <Tooltip
                          content={<BidHistoryTooltip bidLabel={bidLabel} bidKind={bidKind} />}
                          contentStyle={{
                            borderRadius: 16,
                            border: "1px solid #e3e1ea",
                            background: "rgba(255,255,255,0.96)",
                            boxShadow: "0 18px 40px rgba(44,35,66,0.12)",
                          }}
                        />
                        <Line type="monotone" dataKey="bid" stroke="#4b7bff" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyState title="История ставки пуста" text="По этой кампании пока нет дневных точек для построения графика." />
                )}
              </SectionCard>

            <SectionCard
              title="История изменений"
              caption="Сырые записи XWAY по изменению ставки"
              actions={
                <button
                  type="button"
                  onClick={() => setRawHistoryCollapsed((current) => !current)}
                  className="metric-chip inline-flex min-h-[38px] items-center gap-2 rounded-2xl px-3 py-2 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-surface-strong)]"
                  aria-expanded={!isRawHistoryCollapsed}
                  aria-controls="bid-history-raw-table"
                >
                  {isRawHistoryCollapsed ? "Развернуть" : "Свернуть"}
                  {isRawHistoryCollapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
                </button>
              }
            >
              <div id="bid-history-raw-table">
                {!isRawHistoryCollapsed ? (
                  <MetricTable
                    rows={filteredBidHistory}
                    emptyText="В выбранном диапазоне нет записей по изменению ставки."
                    columns={[
                      { key: "datetime", header: "Время", render: (row) => row.datetime },
                      { key: "cpm", header: bidLabel, align: "right", render: (row) => formatBidMoney(row.cpm, bidKind) },
                      { key: "zone", header: "Зона", render: (row) => row.zone || "—" },
                      { key: "origin", header: "Источник", render: (row) => row.origin || "—" },
                      { key: "new_position", header: "Новая позиция", align: "right", render: (row) => row.new_position || "—" },
                    ]}
                  />
                ) : (
                  <div className="rounded-[24px] border border-dashed border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-4 text-sm text-[var(--color-muted)]">
                    Таблица изменений свернута. Записей в текущем диапазоне: {formatNumber(filteredBidHistory.length)}.
                  </div>
                )}
              </div>
            </SectionCard>
          </div>
        </div>
      </div>
    </div>
  );
}

export type { CampaignBidHistoryDialogTarget };
