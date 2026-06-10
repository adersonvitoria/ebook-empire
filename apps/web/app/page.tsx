'use client';

// Overview — KPIs do dia: receita, progresso da meta de R$1000/dia, ROAS,
// vendas pagas e ebooks ativos. Consome /agents/kpi (AnalyticsAgent) e
// complementa com contagens de ebooks. Trata graciosamente rotas ausentes.

import { useQuery } from '@tanstack/react-query';
import {
  api,
  ApiError,
  formatBRL,
  formatNumber,
  formatRoas,
  type KPISnapshot,
} from '@/lib/api';

const META_DIARIA_CENTS = 100_000; // R$1000,00/dia

function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
      {subtitle ? <p className="mt-1 text-sm text-neutral-400">{subtitle}</p> : null}
    </header>
  );
}

function KpiCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-5 ${
        accent
          ? 'border-brand/40 bg-brand/10'
          : 'border-neutral-800 bg-neutral-900/50'
      }`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      {hint ? <p className="mt-1 text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

function MetaProgress({ kpi }: { kpi: KPISnapshot }) {
  const target = kpi.targetRevenueCents || META_DIARIA_CENTS;
  const pct = target > 0 ? Math.min(100, (kpi.revenueCents / target) * 100) : 0;
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Progresso da meta diaria
          </p>
          <p className="mt-2 text-2xl font-semibold text-white">
            {formatBRL(kpi.revenueCents)}{' '}
            <span className="text-sm font-normal text-neutral-500">
              / {formatBRL(target)}
            </span>
          </p>
        </div>
        <span
          className={`text-sm font-semibold ${
            kpi.metTarget ? 'text-emerald-400' : 'text-neutral-300'
          }`}
        >
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className={`h-full rounded-full transition-all ${
            kpi.metTarget ? 'bg-emerald-500' : 'bg-brand'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {kpi.metTarget ? (
        <p className="mt-2 text-xs text-emerald-400">Meta do dia atingida.</p>
      ) : (
        <p className="mt-2 text-xs text-neutral-500">
          Faltam {formatBRL(Math.max(0, target - kpi.revenueCents))} para a meta.
        </p>
      )}
    </div>
  );
}

export default function OverviewPage() {
  const kpiQuery = useQuery({
    queryKey: ['kpis'],
    queryFn: ({ signal }) => api.kpis(signal),
    retry: false,
  });

  const ebooksQuery = useQuery({
    queryKey: ['ebooks', 'published-count'],
    queryFn: ({ signal }) => api.listEbooks({ status: 'PUBLISHED', limit: 100 }, signal),
    retry: false,
  });

  const kpi = kpiQuery.data;
  const ebooksAtivos = ebooksQuery.data?.total ?? ebooksQuery.data?.data.length;

  // 404 da rota de KPI = AnalyticsAgent/rota ainda nao implementada.
  const kpiMissing =
    kpiQuery.error instanceof ApiError && kpiQuery.error.status === 404;

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="Indicadores do dia — meta de faturamento R$1.000/dia."
      />

      {kpiQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando indicadores…</p>
      ) : kpi ? (
        <div className="space-y-6">
          <MetaProgress kpi={kpi} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Receita do dia"
              value={formatBRL(kpi.revenueCents)}
              hint={`Lucro ${formatBRL(kpi.profitCents)}`}
              accent
            />
            <KpiCard
              label="Vendas pagas"
              value={formatNumber(kpi.paidOrders)}
              hint={
                kpi.aovCents !== undefined
                  ? `Ticket medio ${formatBRL(kpi.aovCents)}`
                  : undefined
              }
            />
            <KpiCard
              label="ROAS"
              value={formatRoas(kpi.roas)}
              hint={`Investido ${formatBRL(kpi.spendCents)}`}
            />
            <KpiCard
              label="Ebooks ativos"
              value={
                ebooksQuery.isLoading
                  ? '…'
                  : ebooksAtivos !== undefined
                    ? formatNumber(ebooksAtivos)
                    : '—'
              }
              hint="Publicados"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="CAC"
              value={kpi.cacCents !== undefined ? formatBRL(kpi.cacCents) : '—'}
            />
            <KpiCard
              label="CPA"
              value={kpi.cpaCents !== undefined ? formatBRL(kpi.cpaCents) : '—'}
            />
            <KpiCard label="Custo de LLM" value={formatBRL(kpi.llmCostCents)} />
            <KpiCard
              label="ROI"
              value={kpi.roi !== undefined ? `${(kpi.roi * 100).toFixed(0)}%` : '—'}
            />
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
          <p className="text-sm text-neutral-300">
            {kpiMissing
              ? 'O AnalyticsAgent ainda nao publicou um snapshot de KPIs (rota /agents/kpi indisponivel).'
              : 'Nao foi possivel carregar os indicadores. Verifique se a API esta no ar.'}
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            {kpiQuery.error instanceof Error ? kpiQuery.error.message : null}
          </p>
        </div>
      )}
    </div>
  );
}
