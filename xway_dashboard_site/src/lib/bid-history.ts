import { formatMoney, parseXwayDateTime, toNumber } from "./format";
import type { BidLogEntry, CampaignSummary } from "./types";

export type BidKind = "cpm" | "cpc";

export interface DailyBidRow {
  day: string;
  label: string;
  bid: number | null;
  changes: number;
  changed: boolean;
  changeDelta: number | null;
  lastChangeOrigin: string | null;
  lastChangeActor: string | null;
  views: number | null;
  clicks: number | null;
  spend: number | null;
}

export interface BuildDailyBidRowsOptions {
  mode?: "period" | "history";
  startDay?: string | null;
  endDay?: string | null;
}

function formatLocalIsoDay(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function enumerateIsoDays(startDay: string, endDay: string) {
  const start = new Date(`${startDay}T00:00:00`);
  const end = new Date(`${endDay}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start.getTime() > end.getTime()) {
    return [];
  }

  const days: string[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    days.push(formatLocalIsoDay(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function extractBidChangeActor(origin: string | null | undefined) {
  const normalized = String(origin || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  const actorMatch = normalized.match(/^(?:пользователь|user|менеджер|author|автор)\s*:\s*(.+)$/i);
  if (actorMatch?.[1]) {
    return actorMatch[1].trim();
  }
  return normalized;
}

export function parseBidHistoryDate(row: BidLogEntry) {
  if (row.datetime_sort) {
    const parsed = new Date(row.datetime_sort);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const explicit = parseXwayDateTime(row.datetime);
  if (explicit) {
    return explicit;
  }

  const fallbackValue = String(row.datetime || "").replace(" ", "T");
  const parsed = new Date(fallbackValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatBidDayLabel(day: string) {
  const parsed = new Date(`${day}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return day;
  }
  return parsed.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

type BidCampaignSource = Pick<CampaignSummary, "payment_type" | "auction_mode" | "auto_type" | "name">;

export function resolveBidKind(campaign: BidCampaignSource): BidKind {
  const paymentType = String(campaign.payment_type || "").toLowerCase();
  if (paymentType.includes("cpc") || paymentType.includes("click") || paymentType.includes("клик")) {
    return "cpc";
  }
  if (paymentType.includes("cpm") || paymentType.includes("view")) {
    return "cpm";
  }

  const campaignText = [campaign.name, campaign.auction_mode, campaign.auto_type]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");

  if (campaignText.includes("оплата за клики") || campaignText.includes("cpc") || campaignText.includes("click") || campaignText.includes("клик")) {
    return "cpc";
  }

  return "cpm";
}

export function resolveBidLabel(campaign: BidCampaignSource) {
  return resolveBidKind(campaign) === "cpc" ? "Ставка CPC" : "Ставка CPM";
}

export function formatBidMoney(
  value: number | string | null | undefined,
  bidKindOrCampaign: BidKind | BidCampaignSource,
) {
  const bidKind = typeof bidKindOrCampaign === "string" ? bidKindOrCampaign : resolveBidKind(bidKindOrCampaign);
  return formatMoney(value, bidKind === "cpc");
}

export function formatSignedBidMoney(
  value: number | string | null | undefined,
  bidKindOrCampaign: BidKind | BidCampaignSource,
) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }
  return `${numeric > 0 ? "+" : ""}${formatBidMoney(numeric, bidKindOrCampaign)}`;
}

export function buildDailyBidRows(campaign: CampaignSummary, options: BuildDailyBidRowsOptions = {}): DailyBidRow[] {
  const mode = options.mode ?? "period";
  const startDay = options.startDay || null;
  const endDay = options.endDay || null;
  const history = [...(campaign.bid_history || [])]
    .map((row) => ({
      ...row,
      at: parseBidHistoryDate(row),
      bid: toNumber(row.cpm),
    }))
    .filter((row): row is BidLogEntry & { at: Date; bid: number | null } => Boolean(row.at))
    .sort((left, right) => left.at.getTime() - right.at.getTime());

  const historyByDay = new Map<string, Array<BidLogEntry & { at: Date; bid: number | null }>>();
  history.forEach((row) => {
    const key = formatLocalIsoDay(row.at);
    const bucket = historyByDay.get(key) || [];
    bucket.push(row);
    historyByDay.set(key, bucket);
  });

  const dailyExact = [...(campaign.daily_exact || [])].sort((left, right) => left.day.localeCompare(right.day));
  const fallbackBid = toNumber(campaign.bid);

  const baseRows =
    mode === "history"
      ? (() => {
          const historyDays = [...historyByDay.keys()].sort((left, right) => left.localeCompare(right));
          const sourceStartDay = historyDays[0] ?? dailyExact[0]?.day ?? null;
          const sourceEndDay = historyDays[historyDays.length - 1] ?? dailyExact[dailyExact.length - 1]?.day ?? null;
          const effectiveStartDay = startDay ?? sourceStartDay;
          const effectiveEndDay = endDay ?? sourceEndDay;

          if (!effectiveStartDay || !effectiveEndDay) {
            return [];
          }

          const allDays = enumerateIsoDays(effectiveStartDay, effectiveEndDay);
          let cursor = 0;
          let activeBid = fallbackBid;

          return allDays.map((day) => {
            const dayEnd = new Date(`${day}T23:59:59`);
            while (cursor < history.length) {
              const historyEntry = history[cursor];
              if (!historyEntry || historyEntry.at.getTime() > dayEnd.getTime()) {
                break;
              }
              activeBid = historyEntry.bid ?? activeBid;
              cursor += 1;
            }

            const dayRows = historyByDay.get(day) || [];
            const lastDayRow = dayRows[dayRows.length - 1];
            return {
              day,
              label: formatBidDayLabel(day),
              bid: lastDayRow?.bid ?? activeBid ?? fallbackBid,
              lastChangeOrigin: lastDayRow?.origin ?? null,
              lastChangeActor: extractBidChangeActor(lastDayRow?.origin ?? null),
              views: null,
              clicks: null,
              spend: null,
            };
          });
        })()
      : dailyExact.length
        ? (() => {
            let cursor = 0;
            let activeBid = history.length ? history[0]?.bid ?? fallbackBid : fallbackBid;

            return dailyExact.map((row) => {
              const dayEnd = new Date(`${row.day}T23:59:59`);
              while (cursor < history.length) {
                const historyEntry = history[cursor];
                if (!historyEntry || historyEntry.at.getTime() > dayEnd.getTime()) {
                  break;
                }
                activeBid = historyEntry.bid ?? activeBid;
                cursor += 1;
              }

              const dayRows = historyByDay.get(row.day) || [];
              const lastDayRow = dayRows[dayRows.length - 1];
              return {
                day: row.day,
                label: formatBidDayLabel(row.day),
                bid: lastDayRow?.bid ?? activeBid ?? fallbackBid,
                lastChangeOrigin: lastDayRow?.origin ?? null,
                lastChangeActor: extractBidChangeActor(lastDayRow?.origin ?? null),
                views: toNumber(row.views),
                clicks: toNumber(row.clicks),
                spend: toNumber(row.expense_sum),
              };
            });
          })()
        : [...historyByDay.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([day, rows]) => {
              const lastDayRow = rows[rows.length - 1];
              return {
                day,
                label: formatBidDayLabel(day),
                bid: lastDayRow?.bid ?? fallbackBid,
                lastChangeOrigin: lastDayRow?.origin ?? null,
                lastChangeActor: extractBidChangeActor(lastDayRow?.origin ?? null),
                views: null,
                clicks: null,
                spend: null,
              };
            });

  let previousDayBid: number | null = null;
  const rowsWithChanges = baseRows.map((row) => {
    const currentBid = row.bid;
    const changeDelta = currentBid !== null && previousDayBid !== null ? currentBid - previousDayBid : null;
    const changed = changeDelta !== null && Math.abs(changeDelta) > 0.001;
    if (currentBid !== null) {
      previousDayBid = currentBid;
    }
    return {
      ...row,
      changes: changed ? 1 : 0,
      changed,
      changeDelta,
    };
  });

  return rowsWithChanges.filter((row) => (!startDay || row.day >= startDay) && (!endDay || row.day <= endDay));
}

export function countBidDayChanges(rows: DailyBidRow[]) {
  return rows.reduce((sum, row) => sum + (row.changed ? 1 : 0), 0);
}

export function buildBidChangeFromPreviousDay(campaign: CampaignSummary) {
  const rows = buildDailyBidRows(campaign).filter((row): row is DailyBidRow & { bid: number } => row.bid !== null);
  if (rows.length < 2) {
    return null;
  }
  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  if (!latest || !previous || latest.bid === null || previous.bid === null) {
    return null;
  }
  const delta = latest.bid - previous.bid;
  return {
    delta,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
  } as const;
}
