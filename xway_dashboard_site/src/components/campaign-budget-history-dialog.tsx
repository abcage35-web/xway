import { useEffect } from "react";
import { X } from "lucide-react";
import { formatMoney, formatNumber } from "../lib/format";
import type { BudgetHistoryEntry, CampaignSummary } from "../lib/types";
import { EmptyState, MetricTable, SectionCard } from "./ui";

interface CampaignBudgetHistoryDialogTarget {
  productArticle: string;
  campaign: CampaignSummary;
}

function formatBudgetProducer(value?: string | null) {
  const token = String(value || "").trim();
  if (!token) {
    return "—";
  }
  if (/rule|авто|deposit|пополн/i.test(token)) {
    return "Правило автопополнения";
  }
  return token;
}

export function CampaignBudgetHistoryDialog({
  target,
  onClose,
}: {
  target: CampaignBudgetHistoryDialogTarget | null;
  onClose: () => void;
}) {
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

  const budgetRule = target.campaign.budget_rule_config ?? null;
  const historyRows = target.campaign.budget_history;
  const lastTopup = budgetRule?.last_topup ?? historyRows[0] ?? null;

  return (
    <div className="fixed inset-0 z-[5000] flex items-center justify-center p-1 sm:p-2">
      <button type="button" aria-label="Закрыть" className="absolute inset-0 bg-[rgba(38,33,58,0.28)] backdrop-blur-sm" onClick={onClose} />
      <div className="glass-panel relative z-[5001] flex h-[calc(100vh-8px)] max-h-[calc(100vh-8px)] w-full max-w-[calc(100vw-8px)] flex-col overflow-hidden rounded-[34px]">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-brand-200">{target.productArticle}</p>
            <h2 className="mt-2 font-display text-2xl font-semibold text-[var(--color-ink)]">Логи пополнений бюджета</h2>
            <p className="mt-2 text-sm text-[var(--color-muted)]">{target.campaign.name}</p>
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
              title="История пополнений"
              caption={`${formatNumber(historyRows.length)} записей`}
              actions={
                <div className="flex flex-wrap justify-end gap-2">
                  <div className="metric-chip min-w-[132px] rounded-[20px] px-3 py-2 text-left">
                    <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-muted)]">Правило бюджета</span>
                    <strong className="mt-1 block text-sm text-[var(--color-ink)]">
                      {budgetRule ? (budgetRule.active ? "Активно" : "Выключено") : "Не задано"}
                    </strong>
                  </div>
                  <div className="metric-chip min-w-[132px] rounded-[20px] px-3 py-2 text-left">
                    <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-muted)]">Последнее пополнение</span>
                    <strong className="mt-1 block text-sm text-[var(--color-ink)]">
                      {lastTopup ? formatMoney(lastTopup.deposit, true) : "—"}
                    </strong>
                  </div>
                  <div className="metric-chip min-w-[180px] rounded-[20px] px-3 py-2 text-left">
                    <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-muted)]">Последняя запись</span>
                    <strong className="mt-1 block text-sm text-[var(--color-ink)]">{lastTopup?.datetime || "—"}</strong>
                  </div>
                </div>
              }
            >
              {historyRows.length ? (
                <MetricTable<BudgetHistoryEntry>
                  rows={historyRows}
                  emptyText="История пополнений по этой кампании пока не пришла."
                  columns={[
                    { key: "datetime", header: "Время", render: (row) => row.datetime || "—" },
                    { key: "deposit", header: "Сумма", align: "right", render: (row) => formatMoney(row.deposit, true) },
                    { key: "producer", header: "Источник", render: (row) => formatBudgetProducer(row.producer) },
                    { key: "id", header: "ID", align: "right", render: (row) => (row.id ? formatNumber(row.id) : "—") },
                  ]}
                />
              ) : (
                <EmptyState title="Логи пополнений пусты" text="По этой кампании XWAY пока не вернул записей о пополнениях бюджета." />
              )}
            </SectionCard>
          </div>
        </div>
      </div>
    </div>
  );
}

export type { CampaignBudgetHistoryDialogTarget };
