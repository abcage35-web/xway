import { useDeferredValue, useEffect, useRef, useState, startTransition, type ReactNode } from "react";
import { ArrowUpDown, ChevronDown, ExternalLink, FolderOpen, Layers3, MousePointerClick, PackageCheck, Pause, Play, Search as SearchIcon, ShoppingBag, ShoppingCart, SlidersHorizontal, Snowflake, ThumbsUp, X } from "lucide-react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useNavigate } from "react-router";
import { fetchCatalog, fetchCatalogChart, fetchCatalogIssues } from "../lib/api";
import type { CatalogArticleYesterdayIssues } from "../lib/catalog-article-issues";
import { buildPresetRange, cn, formatCompactNumber, formatDate, formatDateRange, formatMoney, formatNumber, formatPercent, getRangePreset, getTodayIso, shiftIsoDate, toNumber } from "../lib/format";
import type { CatalogArticle, CatalogCampaignState, CatalogChartResponse, CatalogResponse, CatalogShop } from "../lib/types";
import { CatalogSelectionChart } from "../components/catalog-selection-chart";
import { SearchableMultiSelect, type SearchableMultiSelectOption } from "../components/searchable-multi-select";
import { InlineMetricSet, MetricCard, MetricTable, PageHero, RangeToolbar, SearchField, SectionCard } from "../components/ui";

interface CatalogLoaderData {
  payload: CatalogResponse;
  comparePayload: CatalogResponse | null;
  turnoverPayload: CatalogResponse | null;
  start?: string | null;
  end?: string | null;
}

type CatalogChartWindow = 7 | 14 | 30 | 60;
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

const CATALOG_FILTER_TOOLBAR_COLLAPSED_STORAGE_KEY = "xway-catalog-filter-toolbar-collapsed";
const CATALOG_FILTER_TOOLBAR_DETAILS_EXPANDED_STORAGE_KEY = "xway-catalog-filter-toolbar-details-expanded";
const CATALOG_ISSUES_CACHE_STORAGE_KEY = "xway-catalog-issues-cache-v3";
const CATALOG_ISSUES_SETTINGS_STORAGE_KEY = "xway-catalog-issues-settings-v1";
const CATALOG_ISSUES_COLLAPSED_STORAGE_KEY = "xway-catalog-issues-collapsed-v1";
const CATALOG_ISSUES_FETCH_CHUNK_SIZE = 20;
const CATALOG_ISSUES_MAX_ATTEMPTS = 3;
const CATALOG_ISSUES_RETRY_DELAY_MS = 1200;
const CATALOG_ISSUE_TURNOVER_THRESHOLD_DEFAULT = 3;
const CATALOG_ISSUE_KIND_ORDER = ["budget", "limit", "turnover"] as const;

type CatalogIssueKind = CatalogArticleYesterdayIssues["issues"][number]["kind"];
type CatalogIssueVisibilityState = Record<Extract<CatalogIssueKind, "budget" | "limit" | "turnover">, boolean>;

interface CatalogIssueSettingsState {
  turnoverThreshold: number;
  visibleKinds: CatalogIssueVisibilityState;
}

interface CatalogIssueTargetMeta {
  ref: string;
  article: string;
  name: string;
  productUrl: string;
  imageUrl?: string | null;
  stock: number | string | null | undefined;
  turnoverDays: number | null;
  campaignSlots: CatalogCampaignSlot[];
}

const DEFAULT_CATALOG_ISSUE_VISIBILITY: CatalogIssueVisibilityState = {
  budget: true,
  limit: true,
  turnover: true,
};

type CatalogSortField =
  | "article"
  | "name"
  | "stock"
  | "turnover"
  | "campaigns"
  | "spend"
  | "views"
  | "clicks"
  | "orders"
  | "ctr"
  | "cr";

type CatalogSortDirection = "asc" | "desc";

interface CatalogIssueCacheEntry {
  product_ref: string;
  issues: CatalogArticleYesterdayIssues["issues"];
  campaigns: NonNullable<CatalogArticleYesterdayIssues["issues"][number]["campaigns"]>;
}

interface CatalogIssueFetchResult {
  rows: CatalogIssueCacheEntry[];
  loadedRefs: string[];
  failedRefs: string[];
}

interface CatalogIssueCachePayload {
  day: string;
  rowsByRef: Record<string, CatalogIssueCacheEntry>;
  updatedAt: string;
}

interface CatalogChartProgressState {
  cacheKey: string;
  selectionCount: number;
  loadedProductsCount: number;
  chunkCount: number;
  loadedChunkCount: number;
  errorCount: number;
}

interface CatalogChartCacheEntry {
  response: CatalogChartResponse;
  productRefsKey: string;
  rangeStart: string;
  rangeEnd: string;
}

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

function resolveCatalogCampaignStatusLabel(statusCode: string | null | undefined) {
  const normalized = String(statusCode || "").trim().toUpperCase();
  if (normalized === "ACTIVE") {
    return "Активна";
  }
  if (normalized === "PAUSED") {
    return "Пауза";
  }
  if (normalized === "FROZEN") {
    return "Заморожена";
  }
  return normalized || "Статус не задан";
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
  iconOnly = false,
}: {
  label: string;
  kind: "search" | "recom" | "both";
  iconOnly?: boolean;
}) {
  if (kind === "both") {
    return (
      <span className={cn("catalog-campaign-zone-pill is-both", iconOnly && "is-icon-only")} title={label} aria-label={label}>
        <SearchIcon className="size-4" strokeWidth={2.05} />
        {iconOnly ? null : <span>Поиск</span>}
        <span className="catalog-campaign-zone-separator">+</span>
        <ThumbsUp className="size-4" strokeWidth={2.05} />
        {iconOnly ? null : <span>Рекомендации</span>}
      </span>
    );
  }

  if (kind === "recom") {
    return (
      <span className={cn("catalog-campaign-zone-pill is-recom", iconOnly && "is-icon-only")} title={label} aria-label={label}>
        <ThumbsUp className="size-4" strokeWidth={2.05} />
        {iconOnly ? null : <span>Рекомендации</span>}
      </span>
    );
  }

  return (
    <span className={cn("catalog-campaign-zone-pill is-search", iconOnly && "is-icon-only")} title={label} aria-label={label}>
      <SearchIcon className="size-4" strokeWidth={2.05} />
      {iconOnly ? null : <span>{label}</span>}
    </span>
  );
}

function resolveCatalogIssueKindLabel(kind: CatalogIssueKind) {
  if (kind === "budget") {
    return "Нет бюджета";
  }
  if (kind === "limit") {
    return "Израсходован лимит";
  }
  return "Низкая оборачиваемость";
}

function resolveCatalogIssueKindCaption(kind: CatalogIssueKind) {
  if (kind === "budget") {
    return "Остановки из-за нехватки бюджета";
  }
  if (kind === "limit") {
    return "Остановки из-за дневного лимита";
  }
  return "Активная реклама при низкой оборачиваемости";
}

function resolveCatalogIssueKindTone(kind: CatalogIssueKind) {
  if (kind === "budget") {
    return {
      shell: "border-rose-200 bg-rose-50/70",
      badge: "bg-rose-100 text-rose-700",
      metric: "border-rose-200/80 bg-white/70 text-rose-700",
    };
  }
  if (kind === "limit") {
    return {
      shell: "border-amber-200 bg-amber-50/70",
      badge: "bg-amber-100 text-amber-700",
      metric: "border-amber-200/80 bg-white/70 text-amber-700",
    };
  }
  return {
    shell: "border-sky-200 bg-sky-50/70",
    badge: "bg-sky-100 text-sky-700",
    metric: "border-sky-200/80 bg-white/70 text-sky-700",
  };
}

function CatalogIssueCampaignEntry({
  campaign,
  issueKind,
}: {
  campaign: NonNullable<CatalogArticleYesterdayIssues["issues"][number]["campaigns"]>[number];
  issueKind: CatalogIssueKind;
}) {
  const tone = resolveCatalogIssueKindTone(issueKind);
  return (
    <div
      className="flex flex-col gap-2 rounded-[18px] border border-[var(--color-line)] bg-white/88 px-3 py-2.5 shadow-[0_8px_18px_rgba(44,35,66,0.04)]"
      title={`${campaign.label}${campaign.statusLabel ? ` · ${campaign.statusLabel}` : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <CatalogCampaignStatusIconBadge status={campaign.displayStatus} label={campaign.statusLabel || "Статус не задан"} />
        <span className={cn("catalog-campaign-kind-badge", campaign.paymentType === "cpc" ? "is-cpc" : "is-manual")}>
          {campaign.paymentType === "cpc" ? "CPC" : "CPM"}
        </span>
        {campaign.zoneKind ? (
          <CatalogCampaignZonePill
            label={
              campaign.zoneKind === "both"
                ? "Поиск + Рекомендации"
                : campaign.zoneKind === "recom"
                  ? "Рекомендации"
                  : "Поиск"
            }
            kind={campaign.zoneKind}
            iconOnly
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-ink)]">{campaign.label.replace(/^РК\s*/, "")}</span>
      </div>
      {campaign.hours > 0 || campaign.incidents > 0 || campaign.estimatedGap !== null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {campaign.hours > 0 ? (
            <span className={cn("rounded-full border px-2 py-1 text-[11px] font-medium", tone.metric)}>
              {formatNumber(campaign.hours, 1)} ч
            </span>
          ) : null}
          {campaign.incidents > 0 ? (
            <span className={cn("rounded-full border px-2 py-1 text-[11px] font-medium", tone.metric)}>
              {formatIssueIncidents(campaign.incidents)}
            </span>
          ) : null}
          {campaign.estimatedGap !== null ? (
            <span className={cn("rounded-full border px-2 py-1 text-[11px] font-medium", tone.metric)}>
              ≈ {formatMoney(campaign.estimatedGap)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CatalogIssueCell({
  issue,
}: {
  issue: CatalogArticleYesterdayIssues["issues"][number] | null;
}) {
  if (!issue) {
    return <div className="min-h-[72px]" aria-hidden="true" />;
  }

  const tone = resolveCatalogIssueKindTone(issue.kind);

  return (
    <div className={cn("flex h-full flex-col gap-2 rounded-[20px] border p-3", tone.shell)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold", tone.badge)}>
          {issue.title}
        </span>
        {issue.kind === "turnover" ? (
          <>
            {issue.turnoverDays !== undefined && issue.turnoverDays !== null ? (
              <span className={cn("rounded-full border px-2 py-1 text-[11px] font-medium", tone.metric)}>
                {formatTurnoverDays(issue.turnoverDays)}
              </span>
            ) : null}
            {issue.thresholdDays !== undefined && issue.thresholdDays !== null ? (
              <span className={cn("rounded-full border px-2 py-1 text-[11px] font-medium", tone.metric)}>
                ≤ {formatTurnoverDays(issue.thresholdDays)}
              </span>
            ) : null}
          </>
        ) : (
          <>
            {issue.hours > 0 ? (
              <span className={cn("rounded-full border px-2 py-1 text-[11px] font-medium", tone.metric)}>
                {formatNumber(issue.hours, 1)} ч
              </span>
            ) : null}
            {issue.incidents > 0 ? (
              <span className={cn("rounded-full border px-2 py-1 text-[11px] font-medium", tone.metric)}>
                {formatIssueIncidents(issue.incidents)}
              </span>
            ) : null}
            {issue.estimatedGap !== null ? (
              <span className={cn("rounded-full border px-2 py-1 text-[11px] font-medium", tone.metric)}>
                ≈ {formatMoney(issue.estimatedGap)}
              </span>
            ) : null}
          </>
        )}
      </div>
      {issue.campaigns.length ? (
        <div className="space-y-2">
          {issue.campaigns.map((campaign) => (
            <CatalogIssueCampaignEntry key={`${issue.kind}-${campaign.id}`} campaign={campaign} issueKind={issue.kind} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CatalogIssuesSettingsDialog({
  open,
  onClose,
  turnoverThreshold,
  onTurnoverThresholdChange,
  visibleKinds,
  onToggleKind,
}: {
  open: boolean;
  onClose: () => void;
  turnoverThreshold: number;
  onTurnoverThresholdChange: (value: number) => void;
  visibleKinds: CatalogIssueVisibilityState;
  onToggleKind: (kind: keyof CatalogIssueVisibilityState) => void;
}) {
  useEffect(() => {
    if (!open) {
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
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[5000] flex items-center justify-center p-1 sm:p-2">
      <button type="button" aria-label="Закрыть" className="absolute inset-0 bg-[rgba(38,33,58,0.28)] backdrop-blur-sm" onClick={onClose} />
      <div className="glass-panel relative z-[5001] w-full max-w-[720px] overflow-hidden rounded-[34px]">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-brand-200">Ошибки каталога</p>
            <h2 className="mt-2 font-display text-2xl font-semibold text-[var(--color-ink)]">Настройки блока</h2>
            <p className="mt-2 text-sm text-[var(--color-muted)]">Бюджет и лимиты приходят из детальных РК, оборачиваемость считается локально по текущей выборке.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="metric-chip rounded-2xl p-3 text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="space-y-5 px-6 py-5">
          <label className="metric-chip flex flex-col gap-2 rounded-[24px] px-4 py-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">Порог оборачиваемости</span>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={String(turnoverThreshold)}
                onChange={(event) => {
                  const nextValue = Number(event.target.value);
                  if (Number.isFinite(nextValue) && nextValue > 0) {
                    onTurnoverThresholdChange(nextValue);
                  }
                }}
                className="w-full min-w-0 bg-transparent text-base font-semibold text-[var(--color-ink)] outline-none"
              />
              <span className="text-sm text-[var(--color-muted)]">дней</span>
            </div>
          </label>

          <div className="space-y-2">
            {CATALOG_ISSUE_KIND_ORDER.map((kind) => (
              <label key={kind} className="metric-chip flex items-center justify-between gap-4 rounded-[22px] px-4 py-3">
                <div className="space-y-1">
                  <strong className="text-sm text-[var(--color-ink)]">{resolveCatalogIssueKindLabel(kind)}</strong>
                  <p className="text-xs text-[var(--color-muted)]">{resolveCatalogIssueKindCaption(kind)}</p>
                </div>
                <input
                  type="checkbox"
                  checked={visibleKinds[kind]}
                  onChange={() => onToggleKind(kind)}
                  className="h-4 w-4 accent-[var(--color-brand-500)]"
                />
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
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
  if (start) {
    params.set("start", start);
  }
  if (end) {
    params.set("end", end);
  }
  return `?${params.toString()}`;
}

function readCatalogIssueSettings(): CatalogIssueSettingsState {
  if (typeof window === "undefined") {
    return {
      turnoverThreshold: CATALOG_ISSUE_TURNOVER_THRESHOLD_DEFAULT,
      visibleKinds: { ...DEFAULT_CATALOG_ISSUE_VISIBILITY },
    };
  }
  try {
    const raw = window.localStorage.getItem(CATALOG_ISSUES_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {
        turnoverThreshold: CATALOG_ISSUE_TURNOVER_THRESHOLD_DEFAULT,
        visibleKinds: { ...DEFAULT_CATALOG_ISSUE_VISIBILITY },
      };
    }
    const parsed = JSON.parse(raw) as Partial<CatalogIssueSettingsState> & {
      visibleKinds?: Partial<CatalogIssueVisibilityState>;
    };
    const threshold = Number(parsed.turnoverThreshold);
    return {
      turnoverThreshold: Number.isFinite(threshold) && threshold > 0 ? threshold : CATALOG_ISSUE_TURNOVER_THRESHOLD_DEFAULT,
      visibleKinds: {
        budget: parsed.visibleKinds?.budget ?? DEFAULT_CATALOG_ISSUE_VISIBILITY.budget,
        limit: parsed.visibleKinds?.limit ?? DEFAULT_CATALOG_ISSUE_VISIBILITY.limit,
        turnover: parsed.visibleKinds?.turnover ?? DEFAULT_CATALOG_ISSUE_VISIBILITY.turnover,
      },
    };
  } catch {
    return {
      turnoverThreshold: CATALOG_ISSUE_TURNOVER_THRESHOLD_DEFAULT,
      visibleKinds: { ...DEFAULT_CATALOG_ISSUE_VISIBILITY },
    };
  }
}

function readCatalogIssuesCollapsed() {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(CATALOG_ISSUES_COLLAPSED_STORAGE_KEY) === "1";
}

function readCatalogIssuesCache(day: string): Record<string, CatalogIssueCacheEntry> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(CATALOG_ISSUES_CACHE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as CatalogIssueCachePayload;
    if (!parsed || parsed.day !== day || !parsed.rowsByRef || typeof parsed.rowsByRef !== "object") {
      return {};
    }
    return parsed.rowsByRef;
  } catch {
    return {};
  }
}

function writeCatalogIssuesCache(day: string, rowsByRef: Record<string, CatalogIssueCacheEntry>) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const payload: CatalogIssueCachePayload = {
      day,
      rowsByRef,
      updatedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(CATALOG_ISSUES_CACHE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota and privacy-mode failures.
  }
}

function parseNumericFilterValue(value: string) {
  const normalized = String(value || "").replace(",", ".").trim();
  if (!normalized) {
    return null;
  }
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function catalogChartRate(numerator: number, denominator: number) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function finalizeCatalogChartRow(row: CatalogChartResponse["rows"][number]) {
  const views = toNumber(row.views) ?? 0;
  const clicks = toNumber(row.clicks) ?? 0;
  const atbs = toNumber(row.atbs) ?? 0;
  const orders = toNumber(row.orders) ?? 0;
  const expenseSum = toNumber(row.expense_sum) ?? 0;
  const spentSkuCount = toNumber(row.spent_sku_count) ?? 0;

  return {
    ...row,
    views,
    clicks,
    atbs,
    orders,
    expense_sum: expenseSum,
    spent_sku_count: spentSkuCount,
    ctr: catalogChartRate(clicks, views),
    cr1: catalogChartRate(atbs, clicks),
    cr2: catalogChartRate(orders, atbs),
    crf: catalogChartRate(orders, clicks),
  };
}

function buildCatalogChartTotals(rows: CatalogChartResponse["rows"]): CatalogChartResponse["totals"] {
  const totals = rows.reduce(
    (accumulator, row) => {
      accumulator.views += toNumber(row.views) ?? 0;
      accumulator.clicks += toNumber(row.clicks) ?? 0;
      accumulator.atbs += toNumber(row.atbs) ?? 0;
      accumulator.orders += toNumber(row.orders) ?? 0;
      accumulator.expense_sum += toNumber(row.expense_sum) ?? 0;
      return accumulator;
    },
    {
      views: 0,
      clicks: 0,
      atbs: 0,
      orders: 0,
      expense_sum: 0,
    },
  );

  return {
    ...totals,
    ctr: catalogChartRate(totals.clicks, totals.views),
    cr1: catalogChartRate(totals.atbs, totals.clicks),
    cr2: catalogChartRate(totals.orders, totals.atbs),
    crf: catalogChartRate(totals.orders, totals.clicks),
  };
}

function mergeCatalogChartResponses(
  current: CatalogChartResponse | null,
  incoming: CatalogChartResponse,
  selectionCount: number,
): CatalogChartResponse {
  const rowsByDay = new Map<string, CatalogChartResponse["rows"][number]>();
  const seedRows = current?.rows.length ? current.rows : incoming.rows;

  seedRows.forEach((row) => {
    rowsByDay.set(row.day, {
      ...row,
      views: 0,
      clicks: 0,
      atbs: 0,
      orders: 0,
      expense_sum: 0,
      spent_sku_count: 0,
      ctr: null,
      cr1: null,
      cr2: null,
      crf: null,
    });
  });

  [current?.rows ?? [], incoming.rows].forEach((sourceRows) => {
    sourceRows.forEach((row) => {
      const target = rowsByDay.get(row.day);
      if (!target) {
        rowsByDay.set(row.day, finalizeCatalogChartRow(row));
        return;
      }
      target.views += toNumber(row.views) ?? 0;
      target.clicks += toNumber(row.clicks) ?? 0;
      target.atbs += toNumber(row.atbs) ?? 0;
      target.orders += toNumber(row.orders) ?? 0;
      target.expense_sum += toNumber(row.expense_sum) ?? 0;
      target.spent_sku_count += toNumber(row.spent_sku_count) ?? 0;
    });
  });

  const rows = [...rowsByDay.values()]
    .map((row) => finalizeCatalogChartRow(row))
    .sort((left, right) => left.day.localeCompare(right.day));

  return {
    ok: true,
    generated_at: incoming.generated_at,
    range: incoming.range,
    selection_count: selectionCount,
    loaded_products_count: (current?.loaded_products_count ?? 0) + (incoming.loaded_products_count ?? 0),
    rows,
    totals: buildCatalogChartTotals(rows),
    errors: [...(current?.errors ?? []), ...(incoming.errors ?? [])],
  };
}

function sliceCatalogChartResponse(
  response: CatalogChartResponse,
  requestedStart: string,
  requestedEnd: string,
): CatalogChartResponse {
  const rows = response.rows
    .filter((row) => row.day >= requestedStart && row.day <= requestedEnd)
    .map((row) => finalizeCatalogChartRow(row));

  return {
    ...response,
    range: {
      ...response.range,
      current_start: requestedStart,
      current_end: requestedEnd,
      span_days: rows.length,
    },
    rows,
    totals: buildCatalogChartTotals(rows),
  };
}

function resolveCachedCatalogChartResponse(
  cache: Map<string, CatalogChartCacheEntry>,
  options: {
    cacheKey: string;
    productRefsKey: string;
    rangeStart: string;
    rangeEnd: string;
  },
) {
  const exact = cache.get(options.cacheKey);
  if (exact) {
    return exact.response;
  }

  let coveringEntry: CatalogChartCacheEntry | null = null;
  for (const entry of cache.values()) {
    if (entry.productRefsKey !== options.productRefsKey || entry.rangeEnd !== options.rangeEnd) {
      continue;
    }
    if (entry.rangeStart > options.rangeStart) {
      continue;
    }
    if (!coveringEntry || entry.rangeStart > coveringEntry.rangeStart) {
      coveringEntry = entry;
    }
  }

  if (!coveringEntry) {
    return null;
  }
  return sliceCatalogChartResponse(coveringEntry.response, options.rangeStart, options.rangeEnd);
}

function matchesNumericRange(value: number | null | undefined, from: string, to: string) {
  if (value === null || value === undefined) {
    return !from && !to;
  }
  const min = parseNumericFilterValue(from);
  const max = parseNumericFilterValue(to);
  if (min !== null && value < min) {
    return false;
  }
  if (max !== null && value > max) {
    return false;
  }
  return true;
}

function FilterField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("metric-chip flex flex-col gap-1 rounded-2xl px-3.5 py-2.5", className)}>
      <span className="text-[10px] uppercase tracking-[0.24em] text-[var(--color-muted)]">{label}</span>
      {children}
    </label>
  );
}

function NumericRangeField({
  label,
  fromValue,
  toValue,
  onFromChange,
  onToChange,
  step = "any",
}: {
  label: string;
  fromValue: string;
  toValue: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  step?: string;
}) {
  return (
    <FilterField label={label}>
      <div className="grid grid-cols-2 gap-2">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={fromValue}
          onChange={(event) => onFromChange(event.target.value)}
          placeholder="от"
          className="min-w-0 bg-transparent text-sm text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
        />
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={toValue}
          onChange={(event) => onToChange(event.target.value)}
          placeholder="до"
          className="min-w-0 bg-transparent text-sm text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
        />
      </div>
    </FilterField>
  );
}

function CatalogStickyFilterShell({
  toolbar,
  filters,
  onHeightChange,
  activeFiltersCount = 0,
}: {
  toolbar: (controls: {
    collapseAll: () => void;
    detailsExpanded: boolean;
    toggleDetails: () => void;
  }) => ReactNode;
  filters: ReactNode;
  onHeightChange: (height: number) => void;
  activeFiltersCount?: number;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(CATALOG_FILTER_TOOLBAR_COLLAPSED_STORAGE_KEY) === "1";
  });
  const [detailsExpanded, setDetailsExpanded] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(CATALOG_FILTER_TOOLBAR_DETAILS_EXPANDED_STORAGE_KEY) === "1";
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const [layout, setLayout] = useState({ height: 0, left: 0, right: 0 });
  const topOffset = 12;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(CATALOG_FILTER_TOOLBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(CATALOG_FILTER_TOOLBAR_DETAILS_EXPANDED_STORAGE_KEY, detailsExpanded ? "1" : "0");
  }, [detailsExpanded]);

  useEffect(() => {
    if (!rootRef.current || !innerRef.current) {
      return;
    }
    const rootNode = rootRef.current;
    const innerNode = innerRef.current;

    const updateLayout = () => {
      const wrapperRect = rootNode.getBoundingClientRect();
      const innerRect = innerNode.getBoundingClientRect();
      const nextLayout = {
        height: Math.ceil(innerRect.height),
        left: Math.round(wrapperRect.left),
        right: Math.max(0, Math.round(window.innerWidth - wrapperRect.right)),
      };
      setLayout((current) =>
        current.height === nextLayout.height && current.left === nextLayout.left && current.right === nextLayout.right ? current : nextLayout,
      );
      const pinned = wrapperRect.top <= topOffset;
      setIsPinned(pinned);
      const effectiveHeight = pinned ? topOffset + nextLayout.height + 8 : Math.ceil(wrapperRect.top + innerRect.height);
      onHeightChange(effectiveHeight);
    };

    updateLayout();
    window.addEventListener("scroll", updateLayout, { passive: true });
    window.addEventListener("resize", updateLayout);

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateLayout);
      observer.observe(rootNode);
      observer.observe(innerNode);
      return () => {
        observer.disconnect();
        window.removeEventListener("scroll", updateLayout);
        window.removeEventListener("resize", updateLayout);
      };
    }

    return () => {
      window.removeEventListener("scroll", updateLayout);
      window.removeEventListener("resize", updateLayout);
    };
  }, [collapsed, detailsExpanded, onHeightChange]);

  if (collapsed) {
    return (
      <div ref={rootRef} className="relative z-[39] w-full" style={layout.height ? { minHeight: `${layout.height}px` } : undefined}>
        <div
          ref={innerRef}
          className="ml-auto flex w-fit items-center gap-2 rounded-[20px] border border-[var(--color-line)] bg-white/95 px-2.5 py-1.5 shadow-[0_12px_40px_rgba(44,35,66,0.1)] backdrop-blur-xl"
          style={isPinned ? { position: "fixed", top: `${topOffset}px`, right: "18px", zIndex: 39 } : undefined}
        >
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="flex h-8 items-center gap-2 rounded-full bg-[var(--color-surface-soft)] px-3 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-surface-strong)]"
          >
            <SlidersHorizontal className="size-4" />
            {activeFiltersCount > 0 ? `Фильтры · ${formatNumber(activeFiltersCount)}` : "Фильтры"}
            <ChevronDown className="size-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative z-[39] w-full" style={layout.height ? { minHeight: `${layout.height}px` } : undefined}>
      <div
        ref={innerRef}
        className="space-y-2.5"
        style={
          isPinned
            ? {
                position: "fixed",
                top: `${topOffset}px`,
                left: `${layout.left}px`,
                right: `${layout.right}px`,
                zIndex: 39,
              }
            : undefined
        }
      >
        {toolbar({
          collapseAll: () => setCollapsed(true),
          detailsExpanded,
          toggleDetails: () => setDetailsExpanded((current) => !current),
        })}
        {detailsExpanded ? filters : null}
      </div>
    </div>
  );
}

function resolveCatalogChartWindow(spanDays: number | null | undefined): CatalogChartWindow {
  const numeric = Number(spanDays || 0);
  if (numeric <= 7) {
    return 7;
  }
  if (numeric <= 14) {
    return 14;
  }
  if (numeric <= 30) {
    return 30;
  }
  return 60;
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

  const turnoverEnd = payload.range.current_end;
  const turnoverStart = shiftIsoDate(turnoverEnd, -2);
  let turnoverPayload: CatalogResponse | null = null;

  if (payload.range.current_start === turnoverStart && payload.range.current_end === turnoverEnd) {
    turnoverPayload = payload;
  } else {
    try {
      turnoverPayload = await fetchCatalog({ request, start: turnoverStart, end: turnoverEnd });
    } catch {
      turnoverPayload = null;
    }
  }

  return { payload, comparePayload, turnoverPayload, start, end };
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

function normalizeCategoryValue(value: string | null | undefined) {
  return String(value || "").trim() || "__empty__";
}

function formatCategoryLabel(value: string | null | undefined) {
  return String(value || "").trim() || "Без категории";
}

function buildShopOptionsFromShops(shops: CatalogShop[]): SearchableMultiSelectOption[] {
  return shops
    .map((shop) => ({
      value: String(shop.id),
      label: shop.name,
      searchText: [shop.marketplace, shop.tariff_code, shop.name].filter(Boolean).join(" "),
    }))
    .sort((left, right) => left.label.localeCompare(right.label, "ru"));
}

function buildShopOptions(payload: CatalogResponse): SearchableMultiSelectOption[] {
  return buildShopOptionsFromShops(payload.shops);
}

function buildCategoryOptions(payload: CatalogResponse): SearchableMultiSelectOption[] {
  const byCategory = new Map<string, SearchableMultiSelectOption>();
  payload.shops.forEach((shop) => {
    shop.articles.forEach((article) => {
      const value = normalizeCategoryValue(article.category_keyword);
      if (!byCategory.has(value)) {
        byCategory.set(value, {
          value,
          label: formatCategoryLabel(article.category_keyword),
          searchText: [article.category_keyword, article.name, article.brand, shop.name].filter(Boolean).join(" "),
        });
      }
    });
  });
  return [...byCategory.values()].sort((left, right) => left.label.localeCompare(right.label, "ru"));
}

function buildSkuOptions(payload: CatalogResponse): SearchableMultiSelectOption[] {
  const bySku = new Map<string, SearchableMultiSelectOption>();
  payload.shops.forEach((shop) => {
    shop.articles.forEach((article) => {
      if (bySku.has(article.article)) {
        return;
      }
      bySku.set(article.article, {
        value: article.article,
        label: `${article.article} · ${article.name || "Без названия"}`,
        searchText: [article.article, article.name, article.brand, article.vendor_code, article.category_keyword, shop.name].filter(Boolean).join(" "),
      });
    });
  });
  return [...bySku.values()].sort((left, right) => left.label.localeCompare(right.label, "ru"));
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

function summarizeCatalogArticles(articles: CatalogArticle[]) {
  return articles.reduce(
    (totals, article) => {
      totals.views += toNumber(article.views) ?? 0;
      totals.clicks += toNumber(article.clicks) ?? 0;
      totals.orders += toNumber(article.orders) ?? 0;
      totals.expense_sum += toNumber(article.expense_sum) ?? 0;
      return totals;
    },
    {
      views: 0,
      clicks: 0,
      orders: 0,
      expense_sum: 0,
    },
  );
}

function computeTurnoverDays(stock: number | string | null | undefined, orderedReport3d: number | string | null | undefined, windowDays = 3) {
  const stockValue = toNumber(stock);
  if (stockValue === null || stockValue <= 0) {
    return null;
  }
  const orderedValue = toNumber(orderedReport3d);
  if (orderedValue === null) {
    return null;
  }
  if (orderedValue <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return stockValue / (orderedValue / windowDays);
}

function formatTurnoverDays(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "—";
  }
  if (!Number.isFinite(value)) {
    return "∞";
  }
  return `${formatNumber(value, value >= 10 ? 0 : 1)} дн`;
}

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function formatIssueIncidents(count: number) {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs >= 11 && abs <= 19) {
    return `${count} остановок`;
  }
  if (last === 1) {
    return `${count} остановка`;
  }
  if (last >= 2 && last <= 4) {
    return `${count} остановки`;
  }
  return `${count} остановок`;
}

function getArticleIssueHoursTotal(item: CatalogArticleYesterdayIssues) {
  return item.issues.reduce((sum, issue) => sum + issue.hours, 0);
}

function getArticleIssueIncidentsTotal(item: CatalogArticleYesterdayIssues) {
  return item.issues.reduce((sum, issue) => sum + issue.incidents, 0);
}

function getArticleIssueKindsCount(item: CatalogArticleYesterdayIssues) {
  return item.issues.length;
}

function getArticleIssueByKind(item: CatalogArticleYesterdayIssues, kind: CatalogIssueKind) {
  return item.issues.find((issue) => issue.kind === kind) || null;
}

function buildCatalogTurnoverIssue(
  meta: CatalogIssueTargetMeta,
  availableCampaigns: NonNullable<CatalogArticleYesterdayIssues["issues"][number]["campaigns"]> | null | undefined,
  turnoverThreshold: number,
): CatalogArticleYesterdayIssues["issues"][number] | null {
  if (!Number.isFinite(turnoverThreshold) || turnoverThreshold <= 0) {
    return null;
  }
  if (meta.turnoverDays === null || !Number.isFinite(meta.turnoverDays) || meta.turnoverDays > turnoverThreshold) {
    return null;
  }
  const activeCampaigns =
    availableCampaigns && availableCampaigns.length
      ? availableCampaigns.filter((campaign) => campaign.displayStatus === "active")
      : meta.campaignSlots
          .filter((slot) => slot.displayStatus === "active")
          .map((slot) => ({
            id: `slot-${slot.key}`,
            label: slot.headline,
            paymentType: (slot.key === "cpc" ? "cpc" : "cpm") as "cpc" | "cpm",
            zoneKind: slot.zoneKind,
            statusCode: slot.statusCode,
            statusLabel: resolveCatalogCampaignStatusLabel(slot.statusCode),
            displayStatus: slot.displayStatus,
            hours: 0,
            incidents: 0,
            estimatedGap: null,
          }));
  if (!activeCampaigns.length) {
    return null;
  }
  return {
    kind: "turnover",
    title: "Низкая оборачиваемость",
    hours: 0,
    incidents: 0,
    estimatedGap: null,
    campaignIds: activeCampaigns.map((campaign) => campaign.id),
    campaignLabels: activeCampaigns.map((campaign) => campaign.label),
    turnoverDays: meta.turnoverDays,
    thresholdDays: turnoverThreshold,
    campaigns: activeCampaigns,
  };
}

type CatalogIssueDisplayRow = CatalogArticleYesterdayIssues & {
  ref: string;
  imageUrl: string | null;
  turnoverDays: number | null;
};

function mapCatalogIssueRows(
  targets: CatalogIssueTargetMeta[],
  rowsByRef: Record<string, CatalogIssueCacheEntry>,
  options: CatalogIssueSettingsState,
) {
  return targets
    .map((meta) => {
      const cached = rowsByRef[meta.ref];
      const remoteIssues = cached?.issues || [];
      const turnoverIssue = options.visibleKinds.turnover ? buildCatalogTurnoverIssue(meta, cached?.campaigns, options.turnoverThreshold) : null;
      const issues = [...remoteIssues, ...(turnoverIssue ? [turnoverIssue] : [])].filter((issue) => options.visibleKinds[issue.kind]);
      if (!issues.length) {
        return null;
      }
      return {
        ref: meta.ref,
        article: meta.article,
        name: meta.name,
        productUrl: meta.productUrl,
        imageUrl: meta.imageUrl || null,
        turnoverDays: meta.turnoverDays,
        issues: issues.sort(
          (left, right) => CATALOG_ISSUE_KIND_ORDER.indexOf(left.kind as (typeof CATALOG_ISSUE_KIND_ORDER)[number]) - CATALOG_ISSUE_KIND_ORDER.indexOf(right.kind as (typeof CATALOG_ISSUE_KIND_ORDER)[number]),
        ),
      };
    })
    .filter((item): item is CatalogIssueDisplayRow => item !== null)
    .sort((left, right) => {
      const hoursDiff = getArticleIssueHoursTotal(right) - getArticleIssueHoursTotal(left);
      if (hoursDiff !== 0) {
        return hoursDiff;
      }
      const incidentsDiff = getArticleIssueIncidentsTotal(right) - getArticleIssueIncidentsTotal(left);
      if (incidentsDiff !== 0) {
        return incidentsDiff;
      }
      const kindsDiff = getArticleIssueKindsCount(right) - getArticleIssueKindsCount(left);
      if (kindsDiff !== 0) {
        return kindsDiff;
      }
      const leftTurnover = getArticleIssueByKind(left, "turnover")?.turnoverDays ?? Number.POSITIVE_INFINITY;
      const rightTurnover = getArticleIssueByKind(right, "turnover")?.turnoverDays ?? Number.POSITIVE_INFINITY;
      if (leftTurnover !== rightTurnover) {
        return leftTurnover - rightTurnover;
      }
      return left.article.localeCompare(right.article, "ru");
    });
}

function resolveCatalogIssueCopyCampaignId(campaign: NonNullable<CatalogArticleYesterdayIssues["issues"][number]["campaigns"]>[number]) {
  return typeof campaign.id === "number" && Number.isFinite(campaign.id) ? formatNumber(campaign.id) : String(campaign.label || campaign.id || "РК");
}

function resolveCatalogIssueCopyCampaignType(campaign: NonNullable<CatalogArticleYesterdayIssues["issues"][number]["campaigns"]>[number]) {
  return campaign.paymentType === "cpc" ? "CPC" : "CPM";
}

function resolveCatalogIssueCopyCampaignZone(campaign: NonNullable<CatalogArticleYesterdayIssues["issues"][number]["campaigns"]>[number]) {
  if (campaign.zoneKind === "both") {
    return "поиск + рекомендации";
  }
  if (campaign.zoneKind === "recom") {
    return "рекомендации";
  }
  if (campaign.zoneKind === "search") {
    return "поиск";
  }
  return "зона не указана";
}

function formatCatalogIssueCopyCampaignDetails(
  issue: CatalogArticleYesterdayIssues["issues"][number],
  campaign: NonNullable<CatalogArticleYesterdayIssues["issues"][number]["campaigns"]>[number],
) {
  if (issue.kind === "turnover") {
    const turnoverText = issue.turnoverDays !== undefined && issue.turnoverDays !== null ? formatTurnoverDays(issue.turnoverDays) : "—";
    const thresholdText = issue.thresholdDays !== undefined && issue.thresholdDays !== null ? formatTurnoverDays(issue.thresholdDays) : "—";
    return `оборачиваемость ${turnoverText} (порог <= ${thresholdText})`;
  }

  const hoursValue = campaign.hours > 0 ? campaign.hours : issue.campaigns.length === 1 ? issue.hours : null;
  const gapValue = campaign.estimatedGap !== null ? campaign.estimatedGap : issue.campaigns.length === 1 ? issue.estimatedGap : null;
  const hoursText = hoursValue !== null && hoursValue > 0 ? `${formatNumber(hoursValue, 1)} ч` : null;
  const gapText = gapValue !== null ? `≈ ${formatMoney(gapValue)}` : null;

  if (hoursText && gapText) {
    return `${hoursText} (${gapText})`;
  }
  if (hoursText) {
    return hoursText;
  }
  if (gapText) {
    return gapText;
  }
  return issue.title;
}

function buildCatalogIssuesCopyText(rows: CatalogIssueDisplayRow[]) {
  return rows
    .flatMap((row) =>
      row.issues.map((issue) => {
        const lines = [`${row.article} - ${issue.title}`];
        issue.campaigns.forEach((campaign) => {
          lines.push(
            `- ${resolveCatalogIssueCopyCampaignId(campaign)} : ${resolveCatalogIssueCopyCampaignType(campaign)} / ${resolveCatalogIssueCopyCampaignZone(campaign)} - ${formatCatalogIssueCopyCampaignDetails(issue, campaign)}`,
          );
        });
        return lines.join("\n");
      }),
    )
    .join("\n\n");
}

async function copyTextToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable");
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error("Clipboard copy failed");
  }
}

async function readApiErrorMessage(error: unknown) {
  const normalizeMessage = (message: string) => {
    const text = String(message || "").trim();
    if (!text) {
      return "Не удалось собрать ошибки по артикулам.";
    }
    const hasHtml = /<!doctype html>|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text);
    const statusMatch = text.match(/\b(5\d{2}|4\d{2})\b/);
    if (hasHtml && statusMatch?.[1] === "503") {
      return "XWAY временно недоступен (503).";
    }
    if (hasHtml && statusMatch?.[1]) {
      return `Ошибка API (${statusMatch[1]}).`;
    }
    return text;
  };

  if (error instanceof Response) {
    if (error.bodyUsed) {
      return error.statusText ? `Ошибка API (${error.status}): ${error.statusText}` : `Ошибка API (${error.status})`;
    }
    const text = await error.clone().text();
    if (!text) {
      return `Ошибка API (${error.status})`;
    }
    try {
      const parsed = JSON.parse(text) as { error?: string };
      return normalizeMessage(parsed.error || text);
    } catch {
      return normalizeMessage(text);
    }
  }
  if (error instanceof Error) {
    return normalizeMessage(error.message);
  }
  return "Не удалось собрать ошибки по артикулам.";
}

function waitForCatalogIssuesRetry(ms: number, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  return new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);

    const handleAbort = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", handleAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

async function isWorkerSubrequestLimitError(error: unknown) {
  const message = await readApiErrorMessage(error);
  return /too many subrequests/i.test(message);
}

function filterShops(
  payload: CatalogResponse,
  filters: {
    query: string;
    selectedShopIds: string[];
    selectedCategories: string[];
    selectedSkus: string[];
  },
) {
  return payload.shops
    .map((shop) => {
      if (filters.selectedShopIds.length && !filters.selectedShopIds.includes(String(shop.id))) {
        return null;
      }

      const baseArticles = shop.articles.filter((article) => {
        if (filters.selectedCategories.length && !filters.selectedCategories.includes(normalizeCategoryValue(article.category_keyword))) {
          return false;
        }
        if (filters.selectedSkus.length && !filters.selectedSkus.includes(article.article)) {
          return false;
        }
        return true;
      });

      if (!baseArticles.length) {
        return null;
      }

      const shopMatches = shop.name.toLowerCase().includes(filters.query);
      const articles = filters.query
        ? (shopMatches ? baseArticles : baseArticles.filter((article) => articleMatches(article, filters.query)))
        : baseArticles;

      if (!articles.length) {
        return null;
      }

      return {
        ...shop,
        articles,
      };
    })
    .filter(Boolean) as CatalogShop[];
}

export function CatalogPage() {
  const { payload, comparePayload, turnoverPayload, start, end } = useLoaderData() as CatalogLoaderData;
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selectedShopIds, setSelectedShopIds] = useState<string[]>([]);
  const [selectedIssueShopIds, setSelectedIssueShopIds] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedSkus, setSelectedSkus] = useState<string[]>([]);
  const [stockFrom, setStockFrom] = useState("");
  const [stockTo, setStockTo] = useState("");
  const [turnoverFrom, setTurnoverFrom] = useState("");
  const [turnoverTo, setTurnoverTo] = useState("");
  const [sortField, setSortField] = useState<CatalogSortField>("stock");
  const [sortDirection, setSortDirection] = useState<CatalogSortDirection>("desc");
  const [chartCollapsed, setChartCollapsed] = useState(false);
  const [chartWindow, setChartWindow] = useState<CatalogChartWindow>(() => resolveCatalogChartWindow(payload.range.span_days));
  const [chartData, setChartData] = useState<CatalogChartResponse | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartProgress, setChartProgress] = useState<CatalogChartProgressState | null>(null);
  const [articleIssuesLoading, setArticleIssuesLoading] = useState(false);
  const [articleIssuesError, setArticleIssuesError] = useState<string | null>(null);
  const [articleIssuesCopyState, setArticleIssuesCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [articleIssueCacheByRef, setArticleIssueCacheByRef] = useState<Record<string, CatalogIssueCacheEntry>>(() => readCatalogIssuesCache(shiftIsoDate(getTodayIso(), -1)));
  const [articleIssuesCollapsed, setArticleIssuesCollapsed] = useState(() => readCatalogIssuesCollapsed());
  const [articleIssueSettingsOpen, setArticleIssueSettingsOpen] = useState(false);
  const [articleIssueSettings, setArticleIssueSettings] = useState<CatalogIssueSettingsState>(() => readCatalogIssueSettings());
  const [collapsedShopIds, setCollapsedShopIds] = useState<string[]>([]);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const chartFetchAbortRef = useRef<AbortController | null>(null);
  const chartCacheRef = useRef<Map<string, CatalogChartCacheEntry>>(new Map());
  const articleIssuesAbortRef = useRef<AbortController | null>(null);
  const articleIssuesCopyResetRef = useRef<number | null>(null);

  const shopOptions = buildShopOptions(payload);
  const categoryOptions = buildCategoryOptions(payload);
  const skuOptions = buildSkuOptions(payload);
  const turnoverOrdersByRef = new Map(
    (turnoverPayload?.shops || []).flatMap((shop) =>
      shop.articles.map((article) => [`${shop.id}:${article.product_id}`, article.ordered_report] as const),
    ),
  );
  const visibleShops = filterShops(payload, {
    query: deferredQuery,
    selectedShopIds,
    selectedCategories,
    selectedSkus,
  })
    .map((shop) => {
      const nextArticles = shop.articles
        .filter((article) => {
          const stockValue = toNumber(article.stock);
          const turnoverValue = computeTurnoverDays(article.stock, turnoverOrdersByRef.get(`${shop.id}:${article.product_id}`));
          return matchesNumericRange(stockValue, stockFrom, stockTo) && matchesNumericRange(turnoverValue, turnoverFrom, turnoverTo);
        })
        .sort((left, right) => {
          const resolveSortValue = (article: CatalogArticle) => {
            switch (sortField) {
              case "article":
                return Number(article.article) || article.article;
              case "name":
                return String(article.name || "");
              case "stock":
                return toNumber(article.stock) ?? Number.NEGATIVE_INFINITY;
              case "turnover":
                return computeTurnoverDays(article.stock, turnoverOrdersByRef.get(`${shop.id}:${article.product_id}`)) ?? Number.NEGATIVE_INFINITY;
              case "campaigns":
                return article.campaign_states.length;
              case "spend":
                return toNumber(article.expense_sum) ?? Number.NEGATIVE_INFINITY;
              case "views":
                return toNumber(article.views) ?? Number.NEGATIVE_INFINITY;
              case "clicks":
                return toNumber(article.clicks) ?? Number.NEGATIVE_INFINITY;
              case "orders":
                return toNumber(article.orders) ?? Number.NEGATIVE_INFINITY;
              case "ctr":
                return toNumber(article.ctr) ?? Number.NEGATIVE_INFINITY;
              case "cr":
              default:
                return toNumber(article.cr) ?? Number.NEGATIVE_INFINITY;
            }
          };

          const leftValue = resolveSortValue(left);
          const rightValue = resolveSortValue(right);
          let result = 0;
          if (typeof leftValue === "string" || typeof rightValue === "string") {
            result = String(leftValue || "").localeCompare(String(rightValue || ""), "ru");
          } else {
            result = (leftValue as number) - (rightValue as number);
          }
          if (result === 0) {
            result = left.article.localeCompare(right.article, "ru");
          }
          return sortDirection === "asc" ? result : -result;
        });

      if (!nextArticles.length) {
        return null;
      }

      return {
        ...shop,
        articles: nextArticles,
      };
    })
    .filter(Boolean) as CatalogShop[];
  const issueShopOptions = buildShopOptionsFromShops(visibleShops);
  const issueShopOptionKey = issueShopOptions.map((option) => option.value).join(",");
  const issueScopedShops = visibleShops.filter(
    (shop) => !selectedIssueShopIds.length || selectedIssueShopIds.includes(String(shop.id)),
  );
  const visibleIssueTargets = [...new Map(
    issueScopedShops.flatMap((shop) =>
      shop.articles.map((article) => [
        `${shop.id}:${article.product_id}`,
        {
          ref: `${shop.id}:${article.product_id}`,
          article: article.article,
          name: article.name || `Артикул ${article.article}`,
          productUrl: article.product_url,
          imageUrl: article.image_url || null,
          stock: article.stock,
          turnoverDays: computeTurnoverDays(article.stock, turnoverOrdersByRef.get(`${shop.id}:${article.product_id}`)),
          campaignSlots: buildCatalogCampaignSlots(article),
        },
      ]),
    ),
  ).values()].filter((item) => (toNumber(item.stock) ?? 0) > 0) as CatalogIssueTargetMeta[];
  const visibleArticleCodes = [...new Set(visibleShops.flatMap((shop) => shop.articles.map((article) => article.article)))].sort((left, right) => left.localeCompare(right, "ru"));
  const visibleIssueTargetRefs = visibleIssueTargets.map((item) => item.ref);
  const visibleArticles = [...new Map(
    visibleShops.flatMap((shop) =>
      shop.articles.map((article) => [
        `${shop.id}:${article.product_id}`,
        {
          shopId: shop.id,
          productId: article.product_id,
        },
      ]),
    ),
  ).values()];
  const visibleIssueTargetRefsKey = visibleIssueTargetRefs.join(",");
  const chartSelectionCount = visibleArticles.length;
  const chartProductRefs = visibleArticles.map((item) => `${item.shopId}:${item.productId}`);
  const chartProductRefsKey = chartProductRefs.join(",");
  const chartRangeEnd = payload.range.current_end;
  const chartRangeStart = shiftIsoDate(chartRangeEnd, -(chartWindow - 1));
  const chartCacheKey = `${chartRangeStart}|${chartRangeEnd}|${chartProductRefsKey}`;
  const chartRangeLabel = formatDateRange(chartRangeStart, chartRangeEnd);
  const yesterdayIso = shiftIsoDate(getTodayIso(), -1);
  const yesterdayLabel = formatDate(yesterdayIso);
  const preset = getRangePreset(start, end);
  const catalogSearch = buildCatalogSearch(start, end);
  const issueScopeShopCount = issueScopedShops.length;
  const articleIssueRows = mapCatalogIssueRows(visibleIssueTargets, articleIssueCacheByRef, articleIssueSettings);
  const enabledIssueKinds = CATALOG_ISSUE_KIND_ORDER.filter((kind) => articleIssueSettings.visibleKinds[kind]);
  const articleIssuesCompletedCount = visibleIssueTargetRefs.filter((ref) => Boolean(articleIssueCacheByRef[ref])).length;
  const articleIssuesTotalCount = visibleIssueTargetRefs.length;
  const articleIssuesPendingCount = Math.max(articleIssuesTotalCount - articleIssuesCompletedCount, 0);
  const articleIssueGridTemplate =
    enabledIssueKinds.length > 0
      ? `minmax(280px,1.1fr) repeat(${enabledIssueKinds.length}, minmax(250px,1fr))`
      : "minmax(280px,1fr)";

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
    return () => {
      chartFetchAbortRef.current?.abort();
      articleIssuesAbortRef.current?.abort();
      if (articleIssuesCopyResetRef.current !== null) {
        window.clearTimeout(articleIssuesCopyResetRef.current);
      }
    };
  }, []);

  useEffect(() => {
    writeCatalogIssuesCache(yesterdayIso, articleIssueCacheByRef);
  }, [articleIssueCacheByRef, yesterdayIso]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(CATALOG_ISSUES_COLLAPSED_STORAGE_KEY, articleIssuesCollapsed ? "1" : "0");
  }, [articleIssuesCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(CATALOG_ISSUES_SETTINGS_STORAGE_KEY, JSON.stringify(articleIssueSettings));
  }, [articleIssueSettings]);

  useEffect(() => {
    setArticleIssueCacheByRef(readCatalogIssuesCache(yesterdayIso));
  }, [yesterdayIso]);

  useEffect(() => {
    const allowedValues = new Set(issueShopOptions.map((option) => option.value));
    setSelectedIssueShopIds((current) => {
      const next = current.filter((value) => allowedValues.has(value));
      return next.length === current.length ? current : next;
    });
  }, [issueShopOptionKey]);

  useEffect(() => {
    articleIssuesAbortRef.current?.abort();
    setArticleIssuesLoading(false);
    setArticleIssuesError(null);
  }, [visibleIssueTargetRefsKey]);

  useEffect(() => {
    chartFetchAbortRef.current?.abort();
    if (chartCollapsed) {
      setChartLoading(false);
      setChartError(null);
      setChartProgress(null);
      return;
    }
    if (!chartSelectionCount) {
      setChartLoading(false);
      setChartError(null);
      setChartData(null);
      setChartProgress(null);
      return;
    }

    const cached = resolveCachedCatalogChartResponse(chartCacheRef.current, {
      cacheKey: chartCacheKey,
      productRefsKey: chartProductRefsKey,
      rangeStart: chartRangeStart,
      rangeEnd: chartRangeEnd,
    });
    if (cached) {
      setChartLoading(false);
      setChartError(null);
      setChartData(cached);
      setChartProgress({
        cacheKey: chartCacheKey,
        selectionCount: cached.selection_count,
        loadedProductsCount: cached.loaded_products_count,
        chunkCount: 0,
        loadedChunkCount: 0,
        errorCount: cached.errors.length,
      });
      return;
    }

    const controller = new AbortController();
    chartFetchAbortRef.current = controller;
    const timer = window.setTimeout(() => {
      setChartLoading(true);
      setChartError(null);
      setChartData(null);
      const productChunks = chunkItems(chartProductRefs, 24);
      setChartProgress({
        cacheKey: chartCacheKey,
        selectionCount: chartSelectionCount,
        loadedProductsCount: 0,
        chunkCount: productChunks.length,
        loadedChunkCount: 0,
        errorCount: 0,
      });

      (async () => {
        try {
          let nextResponse: CatalogChartResponse | null = null;
          for (let chunkIndex = 0; chunkIndex < productChunks.length; chunkIndex += 1) {
            const chunkResponse = await fetchCatalogChart({
              productRefs: productChunks[chunkIndex]!,
              start: chartRangeStart,
              end: chartRangeEnd,
              signal: controller.signal,
            });
            if (controller.signal.aborted) {
              return;
            }
            nextResponse = mergeCatalogChartResponses(nextResponse, chunkResponse, chartSelectionCount);
            setChartData(nextResponse);
            setChartProgress({
              cacheKey: chartCacheKey,
              selectionCount: chartSelectionCount,
              loadedProductsCount: nextResponse.loaded_products_count,
              chunkCount: productChunks.length,
              loadedChunkCount: chunkIndex + 1,
              errorCount: nextResponse.errors.length,
            });
          }

          if (nextResponse) {
            chartCacheRef.current.set(chartCacheKey, {
              response: nextResponse,
              productRefsKey: chartProductRefsKey,
              rangeStart: chartRangeStart,
              rangeEnd: chartRangeEnd,
            });
          }
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          setChartError(error instanceof Error ? error.message : "Не удалось загрузить агрегированный график.");
        } finally {
          if (!controller.signal.aborted) {
            setChartLoading(false);
          }
        }
      })();
    }, 260);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [chartCacheKey, chartCollapsed, chartProductRefsKey, chartSelectionCount, chartRangeEnd, chartRangeStart]);

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
  const clearLocalFilters = () => {
    setQuery("");
    setSelectedShopIds([]);
    setSelectedIssueShopIds([]);
    setSelectedCategories([]);
    setSelectedSkus([]);
    setStockFrom("");
    setStockTo("");
    setTurnoverFrom("");
    setTurnoverTo("");
    setSortField("stock");
    setSortDirection("desc");
  };
  const activeListFilterCount =
    (query.trim() ? 1 : 0) +
    (selectedShopIds.length ? 1 : 0) +
    (selectedCategories.length ? 1 : 0) +
    (selectedSkus.length ? 1 : 0) +
    (stockFrom || stockTo ? 1 : 0) +
    (turnoverFrom || turnoverTo ? 1 : 0);

  const collectArticleIssues = async () => {
    articleIssuesAbortRef.current?.abort();
    if (!visibleIssueTargetRefs.length) {
      setArticleIssuesError(null);
      setArticleIssuesLoading(false);
      return;
    }

    const controller = new AbortController();
    articleIssuesAbortRef.current = controller;
    setArticleIssuesLoading(true);
    setArticleIssuesError(null);

    try {
      const partialErrorMessages = new Set<string>();
      const missingRefs = visibleIssueTargetRefs.filter((ref) => !articleIssueCacheByRef[ref]);
      if (!missingRefs.length) {
        setArticleIssuesLoading(false);
        return;
      }

      const fetchIssueRowsChunk = async (refs: string[]): Promise<CatalogIssueCacheEntry[]> => {
        const response = await fetchCatalogIssues({
          productRefs: refs,
          start: yesterdayIso,
          end: yesterdayIso,
          signal: controller.signal,
        });
        return response.rows.map((row) => ({
          product_ref: row.product_ref,
          issues: row.issues.map((issue) => ({
            kind: issue.kind,
            title: issue.title,
            hours: issue.hours,
            incidents: issue.incidents,
            estimatedGap: issue.estimated_gap,
            campaignIds: issue.campaign_ids,
            campaignLabels: issue.campaign_labels,
            campaigns: issue.campaigns.map((campaign) => ({
              id: campaign.id,
              label: campaign.label,
              paymentType: campaign.payment_type,
              zoneKind: campaign.zone_kind,
              statusCode: campaign.status_code,
              statusLabel: campaign.status_label,
              displayStatus: campaign.display_status,
              hours: campaign.hours,
              incidents: campaign.incidents,
              estimatedGap: campaign.estimated_gap,
            })),
          })),
          campaigns: row.campaigns.map((campaign) => ({
            id: campaign.id,
            label: campaign.label,
            paymentType: campaign.payment_type,
            zoneKind: campaign.zone_kind,
            statusCode: campaign.status_code,
            statusLabel: campaign.status_label,
            displayStatus: campaign.display_status,
            hours: campaign.hours,
            incidents: campaign.incidents,
            estimatedGap: campaign.estimated_gap,
          })),
        }));
      };

      const fetchIssueRowsAdaptive = async (refs: string[]): Promise<CatalogIssueFetchResult> => {
        try {
          const rows = await fetchIssueRowsChunk(refs);
          return {
            rows,
            loadedRefs: refs,
            failedRefs: [],
          };
        } catch (error) {
          if (refs.length > 1 && (await isWorkerSubrequestLimitError(error))) {
            const middle = Math.ceil(refs.length / 2);
            const left = await fetchIssueRowsAdaptive(refs.slice(0, middle));
            const right = await fetchIssueRowsAdaptive(refs.slice(middle));
            return {
              rows: [...left.rows, ...right.rows],
              loadedRefs: [...left.loadedRefs, ...right.loadedRefs],
              failedRefs: [...left.failedRefs, ...right.failedRefs],
            };
          }
          if (!controller.signal.aborted) {
            partialErrorMessages.add(await readApiErrorMessage(error));
          }
          return {
            rows: [],
            loadedRefs: [],
            failedRefs: refs,
          };
        }
      };

      let pendingRefs = missingRefs;
      for (let attempt = 0; attempt < CATALOG_ISSUES_MAX_ATTEMPTS && pendingRefs.length; attempt += 1) {
        const failedRefs = new Set<string>();
        const chunks = chunkItems(pendingRefs, CATALOG_ISSUES_FETCH_CHUNK_SIZE);

        for (const chunk of chunks) {
          const result = await fetchIssueRowsAdaptive(chunk);
          if (controller.signal.aborted) {
            return;
          }

          if (result.loadedRefs.length) {
            const rowsByRef = new Map(result.rows.map((row) => [row.product_ref, row]));
            setArticleIssueCacheByRef((current) => {
              const next = { ...current };
              result.loadedRefs.forEach((ref) => {
                next[ref] = rowsByRef.get(ref) || { product_ref: ref, issues: [], campaigns: [] };
              });
              return next;
            });
          }

          result.failedRefs.forEach((ref) => {
            failedRefs.add(ref);
          });
        }

        pendingRefs = [...failedRefs];
        if (pendingRefs.length && attempt < CATALOG_ISSUES_MAX_ATTEMPTS - 1) {
          try {
            await waitForCatalogIssuesRetry(CATALOG_ISSUES_RETRY_DELAY_MS, controller.signal);
          } catch {
            return;
          }
        }
      }

      if (pendingRefs.length) {
        const [firstMessage] = [...partialErrorMessages];
        setArticleIssuesError(
          `Не удалось догрузить ${formatNumber(pendingRefs.length)} из ${formatNumber(articleIssuesTotalCount)} артикулов. Уже показаны найденные ошибки. ${firstMessage || "Попробуйте повторить дозагрузку."}`,
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setArticleIssuesError(await readApiErrorMessage(error));
    } finally {
      if (!controller.signal.aborted) {
        setArticleIssuesLoading(false);
      }
    }
  };

  const handleCopyArticleIssues = async () => {
    const text = buildCatalogIssuesCopyText(articleIssueRows);
    if (!text) {
      return;
    }
    try {
      await copyTextToClipboard(text);
      setArticleIssuesCopyState("copied");
    } catch {
      setArticleIssuesCopyState("error");
    } finally {
      if (articleIssuesCopyResetRef.current !== null) {
        window.clearTimeout(articleIssuesCopyResetRef.current);
      }
      articleIssuesCopyResetRef.current = window.setTimeout(() => {
        setArticleIssuesCopyState("idle");
        articleIssuesCopyResetRef.current = null;
      }, 2200);
    }
  };

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

      <CatalogStickyFilterShell
        onHeightChange={setToolbarHeight}
        activeFiltersCount={activeListFilterCount}
        toolbar={({ collapseAll, detailsExpanded, toggleDetails }) => (
          <RangeToolbar
            start={start}
            end={end}
            preset={preset}
            onPresetChange={handlePresetChange}
            onRangeChange={handleRangeChange}
            extra={
              <>
                <button
                  type="button"
                  onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                  className="metric-chip inline-flex items-center gap-2 rounded-2xl px-3.5 py-2 text-sm text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
                >
                  <ArrowUpDown className="size-4 rotate-90" />
                  Наверх
                </button>
                <button
                  type="button"
                  onClick={collapseAll}
                  className="metric-chip inline-flex items-center gap-2 rounded-2xl px-3.5 py-2 text-sm text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
                >
                  <SlidersHorizontal className="size-4" />
                  Скрыть фильтры
                </button>
                {activeListFilterCount > 0 ? (
                  <button
                    type="button"
                    onClick={clearLocalFilters}
                    className="metric-chip inline-flex items-center gap-2 rounded-2xl px-3.5 py-2 text-sm text-brand-200 transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-brand-500)]"
                  >
                    Сбросить выборку
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={toggleDetails}
                  className={cn(
                    "metric-chip inline-flex items-center gap-2 rounded-2xl px-3.5 py-2 text-sm transition hover:bg-[var(--color-surface-strong)]",
                    activeListFilterCount > 0 ? "text-brand-200" : "text-[var(--color-ink)]",
                  )}
                >
                  <span>
                    {detailsExpanded ? "Свернуть параметры" : "Параметры списка"}
                    {activeListFilterCount > 0 ? ` · ${formatNumber(activeListFilterCount)}` : ""}
                  </span>
                  <ChevronDown className={cn("size-4 transition-transform", detailsExpanded && "rotate-180")} />
                </button>
              </>
            }
          />
        )}
        filters={
          <div className="glass-panel rounded-[28px] p-3 sm:p-3.5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Фильтры списка артикулов</h3>
                <p className="text-sm text-[var(--color-muted)]">Поиск, кабинеты, остаток, оборачиваемость и сортировка таблиц по кабинетам.</p>
              </div>
              <button
                type="button"
                onClick={clearLocalFilters}
                className="metric-chip rounded-2xl px-3.5 py-2 text-sm text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
              >
                Сбросить фильтры
              </button>
            </div>

            <div className="grid gap-2.5 xl:grid-cols-[minmax(260px,1.35fr)_repeat(3,minmax(220px,1fr))]">
              <div className="min-w-0">
                <SearchField value={query} onChange={(value) => startTransition(() => setQuery(value))} placeholder="Фильтр по артикулу, названию, бренду, категории" />
              </div>
              <SearchableMultiSelect
                label="Кабинет"
                allLabel="Все кабинеты"
                options={shopOptions}
                selectedValues={selectedShopIds}
                onChange={setSelectedShopIds}
                emptyText="Кабинеты не найдены"
              />
              <SearchableMultiSelect
                label="Категория"
                allLabel="Все категории"
                options={categoryOptions}
                selectedValues={selectedCategories}
                onChange={setSelectedCategories}
                emptyText="Категории не найдены"
              />
              <SearchableMultiSelect
                label="SKU"
                allLabel="Все SKU"
                options={skuOptions}
                selectedValues={selectedSkus}
                onChange={setSelectedSkus}
                emptyText="SKU не найдены"
              />
            </div>

            <div className="mt-2.5 grid gap-2.5 lg:grid-cols-2 xl:grid-cols-4">
              <NumericRangeField
                label="Остаток"
                fromValue={stockFrom}
                toValue={stockTo}
                onFromChange={setStockFrom}
                onToChange={setStockTo}
                step="1"
              />
              <NumericRangeField
                label="Оборачиваемость, дн"
                fromValue={turnoverFrom}
                toValue={turnoverTo}
                onFromChange={setTurnoverFrom}
                onToChange={setTurnoverTo}
              />
              <FilterField label="Сортировать по">
                <select
                  value={sortField}
                  onChange={(event) => setSortField(event.target.value as CatalogSortField)}
                  className="bg-transparent text-sm text-[var(--color-ink)] outline-none"
                >
                  <option value="stock">Остаток</option>
                  <option value="turnover">Оборачиваемость</option>
                  <option value="campaigns">Кол-во РК</option>
                  <option value="spend">Расход</option>
                  <option value="views">Показы</option>
                  <option value="clicks">Клики</option>
                  <option value="orders">Заказы</option>
                  <option value="ctr">CTR</option>
                  <option value="cr">CR</option>
                  <option value="article">Артикул</option>
                  <option value="name">Название</option>
                </select>
              </FilterField>
              <FilterField label="Направление">
                <select
                  value={sortDirection}
                  onChange={(event) => setSortDirection(event.target.value as CatalogSortDirection)}
                  className="bg-transparent text-sm text-[var(--color-ink)] outline-none"
                >
                  <option value="desc">По убыванию</option>
                  <option value="asc">По возрастанию</option>
                </select>
              </FilterField>
            </div>
          </div>
        }
      />

      <SectionCard
        title="График каталога"
        caption={`Отображение за ${chartWindow} дн. · ${chartRangeLabel}. Отдельная шкала рассчитывается для каждого показателя, поэтому сильные расхождения по абсолютным значениям не сжимают остальные линии.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="chart-window-switch" aria-label="Период графика каталога">
              {[7, 14, 30, 60].map((windowValue) => (
                <button
                  key={windowValue}
                  type="button"
                  onClick={() => setChartWindow(windowValue as CatalogChartWindow)}
                  className={chartWindow === windowValue ? "chart-window-chip is-active" : "chart-window-chip"}
                >
                  {windowValue}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setChartCollapsed((current) => !current)}
              className="metric-chip rounded-2xl px-4 py-2 text-sm text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
            >
              {chartCollapsed ? "Показать график" : "Скрыть график"}
            </button>
          </div>
        }
      >
        {!chartCollapsed ? (
          <CatalogSelectionChart
            rows={chartData?.rows ?? []}
            totals={chartData?.totals ?? null}
            selectionCount={chartSelectionCount}
            loadedProductsCount={chartProgress?.cacheKey === chartCacheKey ? chartProgress.loadedProductsCount : chartData?.loaded_products_count ?? null}
            chunkCount={chartProgress?.cacheKey === chartCacheKey ? chartProgress.chunkCount : null}
            loadedChunkCount={chartProgress?.cacheKey === chartCacheKey ? chartProgress.loadedChunkCount : null}
            errorCount={chartProgress?.cacheKey === chartCacheKey ? chartProgress.errorCount : chartData?.errors.length ?? null}
            isLoading={chartLoading}
            error={chartError}
            rangeLabel={chartRangeLabel}
            windowDays={chartWindow}
          />
        ) : (
          <div className="text-sm text-[var(--color-muted)]">
            График скрыт. В текущую выборку попало {formatNumber(chartSelectionCount)} {formatProductsWord(chartSelectionCount)}. При открытии он загрузится отдельно за последние {chartWindow} дн.
          </div>
        )}
      </SectionCard>

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

      <SectionCard
        title="Ошибки по артикулам"
        caption={`Бюджет и лимиты догружаются по видимым артикулам с остатком > 0 за ${yesterdayLabel}. Оборачиваемость считается сразу по текущей выборке, порог сейчас ${formatTurnoverDays(articleIssueSettings.turnoverThreshold)}.`}
        actions={
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
            <SearchableMultiSelect
              label="Кабинеты для сбора"
              allLabel="Все кабинеты"
              options={issueShopOptions}
              selectedValues={selectedIssueShopIds}
              onChange={setSelectedIssueShopIds}
              emptyText="Кабинеты в текущей выборке не найдены"
              className="min-w-[280px]"
            />
            <button
              type="button"
              onClick={handleCopyArticleIssues}
              disabled={!articleIssueRows.length}
              className={cn(
                "metric-chip inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm transition",
                articleIssueRows.length
                  ? articleIssuesCopyState === "copied"
                    ? "text-emerald-700 hover:bg-[var(--color-surface-strong)]"
                    : articleIssuesCopyState === "error"
                      ? "text-rose-700 hover:bg-[var(--color-surface-strong)]"
                      : "text-[var(--color-ink)] hover:bg-[var(--color-surface-strong)]"
                  : "cursor-not-allowed text-[var(--color-muted)] opacity-70",
              )}
            >
              {articleIssuesCopyState === "copied"
                ? "Скопировано"
                : articleIssuesCopyState === "error"
                  ? "Ошибка копирования"
                  : "Скопировать ошибки"}
            </button>
            <button
              type="button"
              onClick={() => setArticleIssueSettingsOpen(true)}
              className="metric-chip inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm text-[var(--color-ink)] transition hover:bg-[var(--color-surface-strong)]"
            >
              <SlidersHorizontal className="size-4" />
              Настройки
            </button>
            <button
              type="button"
              onClick={collectArticleIssues}
              disabled={articleIssuesLoading || !visibleIssueTargetRefs.length}
              className={cn(
                "metric-chip rounded-2xl px-4 py-2 text-sm transition",
                articleIssuesLoading || !visibleIssueTargetRefs.length
                  ? "cursor-not-allowed text-[var(--color-muted)] opacity-70"
                  : "text-[var(--color-ink)] hover:bg-[var(--color-surface-strong)]",
              )}
            >
              {articleIssuesLoading
                ? "Собираем ошибки..."
                : articleIssuesPendingCount > 0 && articleIssuesPendingCount < articleIssuesTotalCount
                  ? `Догрузить ${formatNumber(articleIssuesPendingCount)}`
                  : "Собрать ошибки за вчера"}
            </button>
            <button
              type="button"
              onClick={() => setArticleIssuesCollapsed((current) => !current)}
              className="metric-chip inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
            >
              <span>{articleIssuesCollapsed ? "Развернуть блок" : "Свернуть блок"}</span>
              <ChevronDown className={cn("size-4 transition-transform", !articleIssuesCollapsed && "rotate-180")} />
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-muted)]">
            <span className="metric-chip rounded-2xl px-3 py-2">{formatNumber(visibleArticleCodes.length)} артикулов в текущей выборке</span>
            <span className="metric-chip rounded-2xl px-3 py-2">{formatNumber(issueScopeShopCount)} кабинетов для сбора</span>
            <span className="metric-chip rounded-2xl px-3 py-2">{formatNumber(visibleIssueTargetRefs.length)} с остатком &gt; 0</span>
            {articleIssuesTotalCount ? (
              <span className="metric-chip rounded-2xl px-3 py-2">
                Обработано {formatNumber(articleIssuesCompletedCount)} / {formatNumber(articleIssuesTotalCount)}
              </span>
            ) : null}
            <span className="metric-chip rounded-2xl px-3 py-2">
              Порог оборачиваемости {formatTurnoverDays(articleIssueSettings.turnoverThreshold)}
            </span>
            {enabledIssueKinds.map((kind) => (
              <span key={kind} className="metric-chip rounded-2xl px-3 py-2">
                {resolveCatalogIssueKindLabel(kind)}
              </span>
            ))}
            {articleIssueRows.length ? (
              <span className="metric-chip rounded-2xl px-3 py-2">
                {formatNumber(articleIssueRows.length)} с ошибками в блоке
              </span>
            ) : null}
          </div>

          {articleIssuesError ? (
            <div className="rounded-[22px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {articleIssuesError}
            </div>
          ) : null}

          {!articleIssuesCollapsed ? (
            <>
              {articleIssuesLoading ? (
                <div className="rounded-[22px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-4 text-sm text-[var(--color-muted)]">
                  {articleIssueRows.length
                    ? `Обработано ${formatNumber(articleIssuesCompletedCount)} из ${formatNumber(articleIssuesTotalCount)} артикулов. Уже показаны найденные ошибки.`
                    : `Загружаю вчерашние ошибки по ${formatNumber(visibleIssueTargetRefs.length)} артикулам с остатком > 0.`}
                </div>
              ) : null}

              {!enabledIssueKinds.length ? (
                <div className="rounded-[22px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] px-4 py-4 text-sm text-[var(--color-muted)]">
                  Все типы ошибок скрыты в настройках блока.
                </div>
              ) : null}

              {!articleIssuesLoading && !articleIssuesError && enabledIssueKinds.length > 0 && !articleIssueRows.length ? (
                <div className="rounded-[22px] border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-700">
                  За {yesterdayLabel} по текущей выборке не найдено ошибок по выбранным типам.
                </div>
              ) : null}

              {articleIssueRows.length ? (
                <div className="overflow-x-auto pb-1">
                  <div className="space-y-2" style={{ minWidth: `${280 + enabledIssueKinds.length * 250}px` }}>
                    <div
                      className="grid gap-3 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]"
                      style={{ gridTemplateColumns: articleIssueGridTemplate }}
                    >
                      <div>Товар</div>
                      {enabledIssueKinds.map((kind) => (
                        <div key={`issue-header-${kind}`} className="px-1">
                          <div>{resolveCatalogIssueKindLabel(kind)}</div>
                          <div className="mt-1 text-[10px] font-normal normal-case tracking-normal text-[var(--color-muted)]">
                            {resolveCatalogIssueKindCaption(kind)}
                          </div>
                        </div>
                      ))}
                    </div>

                    {articleIssueRows.map((item) => {
                      const totalHours = getArticleIssueHoursTotal(item);
                      const totalIncidents = getArticleIssueIncidentsTotal(item);
                      const turnoverIssue = getArticleIssueByKind(item, "turnover");
                      return (
                        <article
                          key={item.ref}
                          className="rounded-[22px] border border-[var(--color-line)] bg-white/92 p-3 shadow-[0_10px_24px_rgba(44,35,66,0.05)]"
                        >
                          <div className="grid gap-3" style={{ gridTemplateColumns: articleIssueGridTemplate }}>
                            <div className="min-w-0">
                              <div className="flex items-start gap-3">
                                <Link
                                  to={`/product${buildProductSearch(item.article, yesterdayIso, yesterdayIso)}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="h-[86px] w-[64px] shrink-0 overflow-hidden rounded-[18px] border border-[var(--color-line)] bg-[var(--color-surface-soft)] shadow-[0_8px_20px_rgba(44,35,66,0.06)]"
                                  aria-label={`Открыть товар ${item.name}`}
                                >
                                  {item.imageUrl ? <img src={item.imageUrl} alt={item.name} className="h-full w-full object-cover" /> : null}
                                </Link>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <Link
                                      to={`/product${buildProductSearch(item.article, yesterdayIso, yesterdayIso)}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="min-w-0 font-display text-[1.05rem] font-semibold leading-tight text-[var(--color-ink)] hover:text-brand-200"
                                      title={item.name}
                                    >
                                      <span className="line-clamp-2">{item.name}</span>
                                    </Link>
                                    {totalHours > 0 ? (
                                      <span className="metric-chip rounded-2xl px-2.5 py-1 text-[11px] text-[var(--color-muted)]">
                                        {formatNumber(totalHours, 1)} ч простоя
                                      </span>
                                    ) : null}
                                    {totalIncidents > 0 ? (
                                      <span className="metric-chip rounded-2xl px-2.5 py-1 text-[11px] text-[var(--color-muted)]">
                                        {formatIssueIncidents(totalIncidents)}
                                      </span>
                                    ) : null}
                                    {turnoverIssue?.turnoverDays !== undefined && turnoverIssue?.turnoverDays !== null ? (
                                      <span className="metric-chip rounded-2xl px-2.5 py-1 text-[11px] text-[var(--color-muted)]">
                                        {formatTurnoverDays(turnoverIssue.turnoverDays)}
                                      </span>
                                    ) : null}
                                  </div>
                                  <p className="mt-1 truncate text-xs text-[var(--color-muted)]" title={item.name}>
                                    Артикул {item.article}
                                  </p>
                                </div>
                                <a
                                  href={item.productUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex shrink-0 items-center gap-1 rounded-2xl border border-[var(--color-line)] px-2.5 py-1.5 text-xs text-brand-200 transition hover:bg-[var(--color-surface-soft)]"
                                >
                                  XWAY
                                  <ExternalLink className="size-3.5" />
                                </a>
                              </div>
                            </div>

                            {enabledIssueKinds.map((kind) => (
                              <CatalogIssueCell key={`${item.ref}-${kind}`} issue={getArticleIssueByKind(item, kind)} />
                            ))}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </SectionCard>

      <div className="space-y-5">
        {visibleShops.map((shop) => {
          const collapsed = collapsedShopIds.includes(String(shop.id));
          const totals = summarizeCatalogArticles(shop.articles);

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
                    { label: "Показы", value: formatCompactNumber(totals.views) },
                    { label: "Клики", value: formatCompactNumber(totals.clicks) },
                    { label: "Заказы", value: formatNumber(totals.orders) },
                    { label: "Расход", value: formatMoney(totals.expense_sum) },
                    { label: "CR", value: formatPercent(totals.clicks > 0 ? (totals.orders / totals.clicks) * 100 : null) },
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
                        key: "turnover",
                        header: (
                          <span className="inline-flex flex-col leading-[1.05]">
                            <span>Оборач.</span>
                            <span>3 дн</span>
                          </span>
                        ),
                        align: "right",
                        render: (article) =>
                          formatTurnoverDays(
                            computeTurnoverDays(article.stock, turnoverOrdersByRef.get(`${shop.id}:${article.product_id}`)),
                          ),
                      },
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
                                  <div className="catalog-campaign-card-head" title={`${slot.headline} · ${slot.zoneLabel}`}>
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
                                    <span className={cn("catalog-campaign-kind-badge", `is-${slot.key}`)}>{slot.key === "cpc" ? "CPC" : "CPM"}</span>
                                    <CatalogCampaignZonePill label={slot.zoneLabel} kind={slot.zoneKind} iconOnly />
                                    <strong className="catalog-campaign-title">{slot.headline}</strong>
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
                            target="_blank"
                            rel="noreferrer"
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
        <SectionCard title="Совпадений нет" caption="По текущим фильтрам ничего не нашлось.">
          <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--color-muted)]">
            <button
              type="button"
              onClick={clearLocalFilters}
              className="text-brand-200 underline underline-offset-4"
            >
              Очистить локальные фильтры
            </button>
            <span>или</span>
            <Link to={`/catalog${catalogSearch}`} target="_blank" rel="noreferrer" className="text-brand-200 underline underline-offset-4">
              вернуться к полному периоду
            </Link>
          </div>
        </SectionCard>
      ) : null}

      <CatalogIssuesSettingsDialog
        open={articleIssueSettingsOpen}
        onClose={() => setArticleIssueSettingsOpen(false)}
        turnoverThreshold={articleIssueSettings.turnoverThreshold}
        onTurnoverThresholdChange={(value) =>
          setArticleIssueSettings((current) => ({
            ...current,
            turnoverThreshold: value > 0 ? value : CATALOG_ISSUE_TURNOVER_THRESHOLD_DEFAULT,
          }))
        }
        visibleKinds={articleIssueSettings.visibleKinds}
        onToggleKind={(kind) =>
          setArticleIssueSettings((current) => ({
            ...current,
            visibleKinds: {
              ...current.visibleKinds,
              [kind]: !current.visibleKinds[kind],
            },
          }))
        }
      />
    </div>
  );
}
