import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ExternalLink, Key, MessageSquare, RefreshCw, Send } from "lucide-react";
import { Link } from "react-router";
import { fetchPachkaReport, sendPachkaReport } from "../lib/api";
import { cn, formatDateRange, formatDateTime, formatMoney, formatNumber, formatPercent } from "../lib/format";
import type { PachkaReportResponse, PachkaReportRow } from "../lib/types";
import { MetricCard, PageHero, SectionCard } from "../components/ui";

type SendState = "idle" | "sending" | "sent" | "error";

function readApiError(error: unknown) {
  if (error instanceof Response) {
    return `${error.status} ${error.statusText}`;
  }
  return error instanceof Error ? error.message : "Не удалось загрузить данные.";
}

function statusLabel(value: boolean) {
  return value ? "настроено" : "не настроено";
}

function StatusPill({
  active,
  label,
}: {
  active: boolean;
  label: string;
}) {
  return (
    <span className={cn("pachka-status-pill", active ? "is-ok" : "is-missing")}>
      {active ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
      {label}
    </span>
  );
}

function rowStock(row: PachkaReportRow) {
  return row.stock_mpvibe ?? row.stock_xway ?? 0;
}

function ReportRowList({
  rows,
  mode,
}: {
  rows: PachkaReportRow[];
  mode: "drr" | "stock" | "mpvibe";
}) {
  if (!rows.length) {
    return <div className="pachka-empty-row">Нет строк для этого блока.</div>;
  }

  return (
    <div className="pachka-row-list">
      {rows.map((row, index) => (
        <div key={`${row.ref}-${index}`} className="pachka-row">
          <div className="pachka-row-rank">{index + 1}</div>
          <div className="min-w-0">
            <div className="pachka-row-title">
              <span>{row.article}</span>
              {row.source === "mpvibe" ? <span className="pachka-source-tag">только MPVibe</span> : null}
            </div>
            <div className="pachka-row-name">{row.name}</div>
            <div className="pachka-row-meta">{row.shop_name}</div>
          </div>
          <div className="pachka-row-metrics">
            {mode === "drr" ? (
              <>
                <strong>{formatPercent(row.drr)}</strong>
                <span>{formatMoney(row.spend)}</span>
              </>
            ) : (
              <>
                <strong>{formatNumber(rowStock(row))}</strong>
                <span>FBO</span>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PachkaReportPage() {
  const [report, setReport] = useState<PachkaReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [sendState, setSendState] = useState<SendState>("idle");
  const [sendError, setSendError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadReport = async (forceRefresh = false) => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      setReport(await fetchPachkaReport({ forceRefresh, signal: controller.signal }));
    } catch (requestError) {
      if (!controller.signal.aborted) {
        setError(readApiError(requestError));
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  };

  useEffect(() => {
    void loadReport(false);
    return () => abortRef.current?.abort();
  }, []);

  const configReady = Boolean(report?.config.token_configured && report.config.entity_configured && report.config.secret_configured);
  const sendDisabled = !configReady || !secret.trim() || sendState === "sending";
  const rangeLabel = report ? formatDateRange(report.range.start, report.range.end) : "Диапазон";
  const generatedLabel = report?.generated_at ? formatDateTime(report.generated_at) : "—";
  const messageLines = useMemo(() => (report?.message || "").split("\n").length, [report?.message]);
  const stockMinValue = report?.config.stock_min_value ?? 100;

  const handleSend = async (event: FormEvent) => {
    event.preventDefault();
    if (sendDisabled) {
      return;
    }
    setSendState("sending");
    setSendError(null);
    try {
      const response = await sendPachkaReport({ secret: secret.trim() });
      setReport(response.report ?? report);
      setSendState("sent");
    } catch (requestError) {
      setSendState("error");
      setSendError(readApiError(requestError));
    }
  };

  return (
    <div className="pachka-report-page space-y-6">
      <PageHero
        compact
        title="Отчёт в Pachka"
        metrics={
          <>
            <span className="metric-chip rounded-2xl px-3.5 py-2 text-sm font-medium text-[var(--color-ink)]">{rangeLabel}</span>
            <span className="metric-chip rounded-2xl px-3.5 py-2 text-sm font-medium text-[var(--color-muted)]">{generatedLabel}</span>
            {loading ? <span className="metric-chip rounded-2xl px-3.5 py-2 text-sm font-medium text-[var(--color-muted)]">Загружается</span> : null}
          </>
        }
        actions={
          <Link to="/drr-analytics" className="metric-chip inline-flex items-center justify-center gap-2 rounded-2xl px-3.5 py-2 text-sm font-medium text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]">
            <ExternalLink className="size-4" />
            ДРР
          </Link>
        }
      />

      {error ? <div className="pachka-alert is-error">{error}</div> : null}
      {report?.warnings.length ? <div className="pachka-alert is-warning">{report.warnings.join("; ")}</div> : null}

      <div className="grid gap-2.5 md:grid-cols-4">
        <MetricCard label="Расход" value={formatMoney(report?.totals.spend ?? null)} density="compact" />
        <MetricCard label="SKU XWAY" value={formatNumber(report?.totals.xway_rows ?? null)} density="compact" />
        <MetricCard label="MPVibe-only FBO" value={formatNumber(report?.totals.mpvibe_only_rows ?? null)} hint={`остаток > ${formatNumber(stockMinValue)}`} density="compact" />
        <MetricCard label="Остатки без расхода" value={formatNumber(report?.totals.zero_spend_stock_rows ?? null)} hint={`остаток > ${formatNumber(stockMinValue)}`} density="compact" />
      </div>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <SectionCard
          title="Сообщение"
          caption={report ? `${messageLines} строк · ${report.config.cron} UTC` : "Предпросмотр"}
          actions={
            <button
              type="button"
              onClick={() => void loadReport(true)}
              disabled={loading}
              className="metric-chip inline-flex h-10 items-center gap-2 rounded-2xl px-3.5 text-sm font-semibold text-brand-200 transition hover:bg-[var(--color-surface-strong)] disabled:cursor-progress disabled:opacity-70"
            >
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
              Обновить
            </button>
          }
        >
          <pre className="pachka-message-preview">{report?.message || "Нет данных для предпросмотра."}</pre>
        </SectionCard>

        <SectionCard title="Pachka" caption="Статус интеграции">
          <div className="pachka-config-list">
            <div>
              <span>Токен бота</span>
              <StatusPill active={Boolean(report?.config.token_configured)} label={statusLabel(Boolean(report?.config.token_configured))} />
            </div>
            <div>
              <span>ID чата</span>
              <StatusPill active={Boolean(report?.config.entity_configured)} label={statusLabel(Boolean(report?.config.entity_configured))} />
            </div>
            <div>
              <span>Секрет отправки</span>
              <StatusPill active={Boolean(report?.config.secret_configured)} label={statusLabel(Boolean(report?.config.secret_configured))} />
            </div>
            <div>
              <span>MPVibe</span>
              <StatusPill active={Boolean(report?.sources.mpvibe.available)} label={report?.sources.mpvibe.available ? "доступен" : "недоступен"} />
            </div>
          </div>

          <form className="pachka-send-form" onSubmit={handleSend}>
            <label>
              <span>
                <Key className="size-3.5" />
                Секрет
              </span>
              <input
                type="password"
                value={secret}
                onChange={(event) => {
                  setSecret(event.target.value);
                  setSendState("idle");
                  setSendError(null);
                }}
                placeholder="PACHKA_REPORT_SECRET"
              />
            </label>
            <button type="submit" disabled={sendDisabled}>
              {sendState === "sending" ? <RefreshCw className="size-4 animate-spin" /> : <Send className="size-4" />}
              Отправить
            </button>
          </form>

          {sendState === "sent" ? <div className="pachka-alert is-success">Сообщение отправлено.</div> : null}
          {sendError ? <div className="pachka-alert is-error">{sendError}</div> : null}
          {!configReady && report ? <div className="pachka-alert is-warning">Не хватает серверной настройки для отправки.</div> : null}
        </SectionCard>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <SectionCard title="Топ ДРР" caption="По расходу и максимальному ДРР">
          <ReportRowList rows={report?.top_drr ?? []} mode="drr" />
        </SectionCard>
        <SectionCard title="FBO без расхода" caption={`Остаток > ${formatNumber(stockMinValue)}, расход нулевой`}>
          <ReportRowList rows={report?.stock_no_spend ?? []} mode="stock" />
        </SectionCard>
        <SectionCard title="Только MPVibe" caption={`FBO > ${formatNumber(stockMinValue)}, нет в XWAY`}>
          <ReportRowList rows={report?.mpvibe_only_stock ?? []} mode="mpvibe" />
        </SectionCard>
      </section>

      <div className="pachka-footer-note">
        <MessageSquare className="size-4" />
        Ежедневная отправка идёт отдельным Cloudflare cron worker раз в 24 часа.
      </div>
    </div>
  );
}
