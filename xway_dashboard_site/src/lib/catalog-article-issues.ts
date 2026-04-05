import { buildCampaignIssueSummaries, type CampaignOverviewStatusDay, type CampaignOverviewStatusEntry } from "../components/charts";
import type { CampaignPauseHistoryEntry, CampaignSummary, ProductSummary } from "./types";

export interface CatalogArticleIssueSummary {
  kind: "budget" | "limit";
  title: string;
  hours: number;
  incidents: number;
  estimatedGap: number | null;
  campaignIds: number[];
  campaignLabels: string[];
  campaigns: CatalogArticleIssueCampaign[];
}

export interface CatalogArticleIssueCampaign {
  id: number;
  label: string;
  paymentType: "cpm" | "cpc" | null;
  zoneKind: "search" | "recom" | "both" | null;
  statusCode: string | null;
  statusLabel: string | null;
  displayStatus: "active" | "paused" | "freeze" | "muted";
}

export interface CatalogArticleYesterdayIssues {
  article: string;
  name: string;
  productUrl: string;
  issues: CatalogArticleIssueSummary[];
}

type CampaignStatusStateKey = "active" | "paused" | "freeze" | "unknown";
type CampaignIssueKind = "budget" | "limit";
type CampaignPauseReasonKind = "schedule" | "budget" | "limit";

interface StatusDateTimeParts {
  date: string;
  time: string;
}

function splitStatusDateTime(value?: string | null): StatusDateTimeParts {
  const text = String(value || "").trim();
  if (!text) {
    return { date: "—", time: "" };
  }
  const parts = text.split(",");
  if (parts.length >= 2) {
    const [datePart = "—", ...timeParts] = parts;
    return {
      date: datePart.trim() || "—",
      time: timeParts.join(",").trim(),
    };
  }
  const match = text.match(/^(.*?)(\d{1,2}:\d{2})$/);
  if (match) {
    return {
      date: (match[1] ?? "").trim() || "—",
      time: (match[2] ?? "").trim(),
    };
  }
  return { date: text, time: "" };
}

function parseRuDateLabel(value?: string | null) {
  const match = String(value || "").trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) {
    return null;
  }
  const [, day, month, year] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function parseStatusDateTimeValue(
  value?: string | null,
  options: {
    fallbackDate?: Date | null;
    fallbackYear?: number | null;
  } = {},
) {
  const parts = splitStatusDateTime(value);
  const fallbackDate = options.fallbackDate instanceof Date && !Number.isNaN(options.fallbackDate.getTime()) ? new Date(options.fallbackDate) : null;
  const explicitDate = parseRuDateLabel(parts.date);
  const baseDate =
    explicitDate ||
    fallbackDate ||
    (Number.isFinite(options.fallbackYear) ? new Date(Number(options.fallbackYear), 0, 1) : null);
  if (!baseDate) {
    return null;
  }
  const parsed = new Date(baseDate);
  if (parts.time) {
    const [hours = 0, minutes = 0] = parts.time.split(":").map((item) => Number(item));
    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
      parsed.setHours(hours, minutes, 0, 0);
    }
  } else {
    parsed.setHours(0, 0, 0, 0);
  }
  return parsed;
}

function parseCampaignIntervalEnd(item: Pick<CampaignPauseHistoryEntry, "end">, startAt: Date) {
  const rawEnd = String(item.end || "").trim();
  if (!rawEnd) {
    return new Date();
  }
  const parsed = parseStatusDateTimeValue(rawEnd, {
    fallbackDate: startAt,
    fallbackYear: startAt.getFullYear(),
  });
  if (!parsed) {
    return new Date(startAt);
  }
  const endAt = new Date(parsed);
  const endDateLabel = splitStatusDateTime(rawEnd).date;
  const hasDatePart = Boolean(parseRuDateLabel(endDateLabel));
  if (!hasDatePart && endAt <= startAt) {
    endAt.setDate(endAt.getDate() + 1);
  }
  return endAt;
}

function formatStatusClock(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function splitPauseReasonTokens(values: string[] | string | null | undefined) {
  const source = Array.isArray(values) ? values : [values];
  return source
    .flatMap((value) => String(value || "").split(/[;,/]/))
    .map((value) => value.trim())
    .filter(Boolean);
}

function mergeStatusNameField(...values: Array<string | null | undefined>) {
  const parts: string[] = [];
  values.forEach((value) => {
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => {
        if (!parts.includes(item)) {
          parts.push(item);
        }
      });
  });
  return parts.join(", ");
}

function resolveCampaignActivityStatusKey(item?: CampaignPauseHistoryEntry | null): CampaignStatusStateKey {
  if (item?.is_freeze) {
    return "freeze";
  }
  const status = String(item?.status || "").toLowerCase();
  const reasons = [...(item?.pause_reasons || []), item?.paused_limiter]
    .map((token) => String(token || "").toLowerCase())
    .join(" ");
  if (/актив|active/.test(status)) {
    return "active";
  }
  if (
    /приост|pause|paused|stop|неактив|inactive/.test(status) ||
    /schedule|распис|budget|бюджет|limit|лимит/.test(reasons) ||
    Boolean(item?.paused_limiter) ||
    Boolean(item?.paused_user)
  ) {
    return "paused";
  }
  return "unknown";
}

function translatePauseReasonToken(value: string) {
  const token = String(value || "").trim();
  if (!token) {
    return "";
  }
  if (/campaign_limiter/i.test(token)) {
    return "Лимит расходов";
  }
  if (/schedule|распис/i.test(token)) {
    return "Расписание показов";
  }
  if (/budget|бюджет|money|баланс|остаток|fund/i.test(token)) {
    return "Нет бюджета";
  }
  if (/freeze|замороз/i.test(token)) {
    return "Заморозка";
  }
  if (/user|пользоват/i.test(token)) {
    return "Пользователь";
  }
  if (/spend_limit|day_limit|daily_limit|limit|лимит|day|день/i.test(token)) {
    return "Лимит расходов";
  }
  return token;
}

function resolvePauseActorLabel(item?: CampaignPauseHistoryEntry | null) {
  if (!item) {
    return null;
  }
  const frozenBy = mergeStatusNameField(item.paused_user, item.stopped_user);
  const resumedBy = mergeStatusNameField(item.unpaused_user ?? undefined);

  if (item.is_freeze && frozenBy) {
    return `Заморозил: ${frozenBy}`;
  }
  if (item.is_unfreeze && resumedBy) {
    return `Разморозил: ${resumedBy}`;
  }
  return null;
}

function resolvePauseReasonKinds(item?: CampaignPauseHistoryEntry | null): CampaignPauseReasonKind[] {
  const tokens = [...splitPauseReasonTokens(item?.pause_reasons || []), ...splitPauseReasonTokens(item?.paused_limiter)];
  const joined = tokens.map((token) => token.toLowerCase()).join(" ");
  const hasSchedule = /schedule|распис/.test(joined);
  const hasLimit = /campaign_limiter|spend_limit|day_limit|daily_limit|limit|лимит|день|day/.test(joined);
  const hasBudget = /budget|бюджет|money|баланс|остаток|fund/.test(joined);
  const reasonKinds: CampaignPauseReasonKind[] = [];

  if (hasSchedule) {
    reasonKinds.push("schedule");
  }
  if (hasBudget) {
    reasonKinds.push("budget");
  }
  if (hasLimit) {
    reasonKinds.push("limit");
  }
  return reasonKinds;
}

function resolvePauseIssueKinds(item?: CampaignPauseHistoryEntry | null): CampaignIssueKind[] {
  if (item?.is_freeze) {
    return [];
  }
  const reasonKinds = resolvePauseReasonKinds(item);
  const issueKinds: CampaignIssueKind[] = [];
  if (reasonKinds.includes("limit")) {
    issueKinds.push("limit");
  }
  if (reasonKinds.includes("budget")) {
    issueKinds.push("budget");
  }
  return issueKinds;
}

function resolvePauseContext(item?: CampaignPauseHistoryEntry | null) {
  const tokens = [...splitPauseReasonTokens(item?.pause_reasons || []), ...splitPauseReasonTokens(item?.paused_limiter)];
  const actorLabel = resolvePauseActorLabel(item);
  const reasonKinds = resolvePauseReasonKinds(item);
  const issueKinds = resolvePauseIssueKinds(item);
  if (!tokens.length && item?.paused_user) {
    tokens.push("user");
  }
  const seen = new Set<string>();
  const reasonLabels = tokens
    .map((token) => translatePauseReasonToken(token))
    .filter((label) => !(actorLabel && label === "Пользователь"))
    .filter((label) => {
      if (!label || seen.has(label)) {
        return false;
      }
      seen.add(label);
      return true;
    });

  return {
    actorLabel,
    reasonLabels,
    reasonKinds,
    issueKinds,
  };
}

function campaignRawPauseHistoryIntervals(campaign: CampaignSummary) {
  const pauseHistory = campaign.status_logs?.pause_history;
  return Array.isArray(pauseHistory?.intervals) ? pauseHistory.intervals : Array.isArray(pauseHistory?.merged_intervals) ? pauseHistory.merged_intervals : [];
}

function formatIssueCampaignName(campaign: CampaignSummary) {
  return `РК ${campaign.id}`;
}

function formatYesterdayLabel(day: string) {
  const parsed = new Date(`${day}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return day;
  }
  const weekday = parsed.toLocaleDateString("ru-RU", { weekday: "short" });
  const date = parsed.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  return `${weekday} ${date}`;
}

function buildCampaignYesterdayStatusDay(campaign: CampaignSummary, yesterday: string): CampaignOverviewStatusDay {
  const dayStart = new Date(`${yesterday}T00:00:00`);
  const dayEnd = new Date(`${yesterday}T23:59:59.999`);

  const entries: CampaignOverviewStatusEntry[] = campaignRawPauseHistoryIntervals(campaign)
    .flatMap((item) => {
      const startAt = parseStatusDateTimeValue(item.start);
      const endAt = startAt ? parseCampaignIntervalEnd(item, startAt) : null;
      if (!startAt || !endAt) {
        return [];
      }
      if (startAt > dayEnd || endAt < dayStart) {
        return [];
      }
      const effectiveStart = startAt > dayStart ? startAt : dayStart;
      const effectiveEnd = endAt < dayEnd ? endAt : dayEnd;
      const context = resolvePauseContext(item);
      return [{
        key: resolveCampaignActivityStatusKey(item),
        label: item.is_freeze ? "Заморожена" : item.status || "Статус",
        startTime: formatStatusClock(effectiveStart),
        endTime: effectiveEnd.getTime() >= dayEnd.getTime() ? null : formatStatusClock(effectiveEnd),
        reasons: context.reasonLabels,
        reasonKinds: context.reasonKinds,
        actorLabel: context.actorLabel ?? null,
        issueKinds: context.issueKinds,
      }];
    })
    .sort((left, right) => left.startTime.localeCompare(right.startTime));

  return {
    day: yesterday,
    label: formatYesterdayLabel(yesterday),
    entries,
  };
}

export function buildCatalogArticleYesterdayIssues(product: ProductSummary, yesterday: string): CatalogArticleYesterdayIssues | null {
  const aggregated = new Map<
    CatalogArticleIssueSummary["kind"],
    CatalogArticleIssueSummary & { campaignIdSet: Set<number>; campaignLabelSet: Set<string> }
  >();

  product.campaigns.forEach((campaign) => {
    const yesterdayStatusDay = buildCampaignYesterdayStatusDay(campaign, yesterday);
    const yesterdayIssueSummaries = buildCampaignIssueSummaries(campaign, [yesterdayStatusDay]);
    yesterdayIssueSummaries.forEach((summary) => {
      const dayEntry = summary.days.find((entry) => entry.day === yesterday);
      if (!dayEntry) {
        return;
      }
      const current: CatalogArticleIssueSummary & { campaignIdSet: Set<number>; campaignLabelSet: Set<string> } =
        aggregated.get(summary.kind) ||
        {
          kind: summary.kind,
          title: summary.label,
          hours: 0,
          incidents: 0,
          estimatedGap: 0,
          campaignIds: [] as number[],
          campaignLabels: [] as string[],
          campaigns: [] as CatalogArticleIssueCampaign[],
          campaignIdSet: new Set<number>(),
          campaignLabelSet: new Set<string>(),
        };
      current.hours += dayEntry.hours;
      current.incidents += dayEntry.incidents;
      if (dayEntry.estimatedGap !== null) {
        current.estimatedGap = (current.estimatedGap ?? 0) + dayEntry.estimatedGap;
      }
      if (!current.campaignIdSet.has(campaign.id)) {
        current.campaignIdSet.add(campaign.id);
        current.campaignIds.push(campaign.id);
      }
      const campaignLabel = formatIssueCampaignName(campaign);
      if (!current.campaignLabelSet.has(campaignLabel)) {
        current.campaignLabelSet.add(campaignLabel);
        current.campaignLabels.push(campaignLabel);
      }
      aggregated.set(summary.kind, current);
    });
  });

  const issues = (["budget", "limit"] as const)
    .map((kind) => aggregated.get(kind))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map(({ campaignIdSet: _campaignIdSet, campaignLabelSet: _campaignLabelSet, ...item }) => ({
      ...item,
      estimatedGap: typeof item.estimatedGap === "number" && Number.isFinite(item.estimatedGap) && item.estimatedGap > 0 ? item.estimatedGap : null,
    }));

  if (!issues.length) {
    return null;
  }

  return {
    article: product.article,
    name: product.identity.name || `Артикул ${product.article}`,
    productUrl: product.product_url,
    issues,
  };
}
