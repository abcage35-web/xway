import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { fetchClusterDetail } from "../lib/api";
import { formatMoney, formatNumber, formatPercent } from "../lib/format";
import type { ClusterDetailResponse } from "../lib/types";
import { ClusterDailyChart } from "./charts";
import { KeyValueRow, LoadingState, MetricTable, SectionCard } from "./ui";

interface ClusterDialogTarget {
  shopId: number;
  productId: number;
  campaignId: number;
  normqueryId: number;
  clusterName: string;
  campaignName: string;
  start?: string | null;
  end?: string | null;
}

export function ClusterDetailDialog({
  target,
  onClose,
}: {
  target: ClusterDialogTarget | null;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState<ClusterDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!target) {
      setPayload(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPayload(null);

    fetchClusterDetail({
      shopId: target.shopId,
      productId: target.productId,
      campaignId: target.campaignId,
      normqueryId: target.normqueryId,
      start: target.start,
      end: target.end,
      signal: controller.signal,
    })
      .then((nextPayload) => {
        setPayload(nextPayload);
      })
      .catch((reason) => {
        if (controller.signal.aborted) {
          return;
        }
        setError(reason instanceof Error ? reason.message : "Не удалось загрузить детализацию кластера.");
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [target]);

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
            <p className="text-xs uppercase tracking-[0.24em] text-brand-200">Кластер</p>
            <h2 className="font-display mt-2 text-2xl font-semibold text-[var(--color-ink)]">{target.clusterName}</h2>
            <p className="mt-2 text-sm text-[var(--color-muted)]">{target.campaignName}</p>
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
          {loading ? <LoadingState title="Загружаю историю и дневную детализацию..." /> : null}

          {!loading && error ? (
            <SectionCard title="Не удалось открыть кластер" caption={error}>
              <div className="text-sm text-[var(--color-muted)]">
                Проверьте доступность `/api/cluster-detail` и попробуйте открыть карточку ещё раз.
              </div>
            </SectionCard>
          ) : null}

          {!loading && payload ? (
            <div className="space-y-6">
              <div className="grid gap-6 xl:grid-cols-[1.65fr,0.95fr]">
                <SectionCard title="Дневная динамика" caption="Позиция, показы, клики, корзины, заказы, расход и ДРР по дням">
                  <ClusterDailyChart daily={payload.daily} />
                </SectionCard>

                <SectionCard title="Сводка кластера" caption="Быстрый контекст по текущей детализации">
                  <div className="space-y-1">
                    <KeyValueRow label="Текущая позиция" value={formatNumber(payload.position)} />
                    <KeyValueRow label="Записей истории" value={formatNumber(payload.history.length)} />
                    <KeyValueRow label="Изменений ставки" value={formatNumber(payload.bid_history.length)} />
                    <KeyValueRow label="Период" value={`${payload.range.current_start} → ${payload.range.current_end}`} />
                  </div>
                </SectionCard>
              </div>

              <SectionCard title="История ставок" caption="Последние изменения бидов внутри кластера">
                <MetricTable
                  rows={payload.bid_history}
                  emptyText="История ставок по этому кластеру пока отсутствует."
                  columns={[
                    { key: "ts", header: "Время", render: (row) => row.ts },
                    { key: "bid", header: "Ставка", align: "right", render: (row) => formatMoney(row.bid) },
                    { key: "author", header: "Инициатор", render: (row) => row.author },
                  ]}
                />
              </SectionCard>

              <SectionCard title="История действий" caption="Системные события по кластеру">
                <MetricTable
                  rows={payload.history}
                  emptyText="История действий по этому кластеру пока не пришла из XWAY."
                  columns={[
                    { key: "ts", header: "Время", render: (row) => row.ts },
                    { key: "action", header: "Действие", render: (row) => row.action },
                    { key: "author", header: "Инициатор", render: (row) => row.author },
                  ]}
                />
              </SectionCard>

              <SectionCard title="Сырые дневные значения" caption="Полезно для быстрой проверки позиций и эффективности">
                <MetricTable
                  rows={Object.entries(payload.daily).sort((left, right) => left[0].localeCompare(right[0])).map(([day, row]) => ({ day, ...row }))}
                  emptyText="По дням пока нет ни одной строки."
                  columns={[
                    { key: "day", header: "Дата", render: (row) => row.day },
                    { key: "views", header: "Показы", align: "right", render: (row) => formatNumber(row.views) },
                    { key: "clicks", header: "Клики", align: "right", render: (row) => formatNumber(row.clicks) },
                    { key: "ctr", header: "CTR", align: "right", render: (row) => formatPercent(row.CTR) },
                    { key: "cpc", header: "CPC", align: "right", render: (row) => formatMoney(row.CPC, true) },
                    { key: "expense", header: "Расход", align: "right", render: (row) => formatMoney(row.expense) },
                    { key: "pos", header: "Позиция", align: "right", render: (row) => formatNumber(row.rates_promo_pos ?? row.org_pos) },
                  ]}
                />
              </SectionCard>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export type { ClusterDialogTarget };
