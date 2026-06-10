'use client';

// CRM / Command Center — Overview de operacao autonoma (COO / OperationsAgent).
// Grid de cards por setor com score/cor/status/tendencia + top problema, e
// contadores globais (problemas abertos, aprovacoes pendentes, kill switch).
// Consome GET /crm/overview. Trata 404 (rota aquecendo) e API fora do ar.

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  ApiError,
  SECTORS,
  statusFromScore,
  type CrmOverview,
  type SectorHealthView,
  type SectorStatus,
  type Sector,
} from '@/lib/api';

// Rotulos pt-BR dos setores.
const SECTOR_LABELS: Record<Sector, string> = {
  CONTENT: 'Conteudo',
  SALES: 'Vendas',
  DELIVERY: 'Entrega',
  SOCIAL: 'Social',
  TRAFFIC: 'Trafego',
  ANALYTICS: 'Analytics',
  ORCHESTRATION: 'Orquestracao',
};

const STATUS_LABELS: Record<SectorStatus, string> = {
  HEALTHY: 'Saudavel',
  WARNING: 'Atencao',
  CRITICAL: 'Critico',
};

// Cores por status — borda/fundo do card e a barra de score.
const STATUS_RING: Record<SectorStatus, string> = {
  HEALTHY: 'border-emerald-500/40 bg-emerald-500/5',
  WARNING: 'border-amber-500/40 bg-amber-500/5',
  CRITICAL: 'border-red-500/40 bg-red-500/5',
};

const STATUS_BAR: Record<SectorStatus, string> = {
  HEALTHY: 'bg-emerald-500',
  WARNING: 'bg-amber-500',
  CRITICAL: 'bg-red-500',
};

const STATUS_TEXT: Record<SectorStatus, string> = {
  HEALTHY: 'text-emerald-400',
  WARNING: 'text-amber-400',
  CRITICAL: 'text-red-400',
};

// --- Sub-navegacao do modulo CRM (compartilhada visualmente entre as pages) ---
export function CrmTabs({ active }: { active: string }) {
  const tabs = [
    { href: '/crm', label: 'Visao geral' },
    { href: '/crm/problems', label: 'Problemas' },
    { href: '/crm/actions', label: 'Acoes' },
    { href: '/crm/approvals', label: 'Aprovacoes' },
    { href: '/crm/settings', label: 'Guardrails' },
  ];
  return (
    <nav className="mb-6 flex flex-wrap gap-1 border-b border-neutral-800">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
            t.href === active
              ? 'border-brand text-white'
              : 'border-transparent text-neutral-400 hover:text-neutral-200'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

function TrendBadge({ trend }: { trend?: number | null }) {
  if (trend === null || trend === undefined || trend === 0) {
    return <span className="text-xs text-neutral-500">estavel</span>;
  }
  const up = trend > 0;
  return (
    <span className={`text-xs font-medium ${up ? 'text-emerald-400' : 'text-red-400'}`}>
      {up ? '▲' : '▼'} {Math.abs(trend).toFixed(0)} pts
    </span>
  );
}

function SectorCard({ health }: { health: SectorHealthView }) {
  const status = health.status ?? statusFromScore(health.score);
  return (
    <div className={`rounded-xl border p-5 ${STATUS_RING[status]}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold text-white">
            {SECTOR_LABELS[health.sector] ?? health.sector}
          </p>
          <p className={`mt-0.5 text-xs font-medium ${STATUS_TEXT[status]}`}>
            {STATUS_LABELS[status]}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold text-white">
            {Math.round(health.score)}
            <span className="text-sm font-normal text-neutral-500">/100</span>
          </p>
          <TrendBadge trend={health.trend} />
        </div>
      </div>

      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className={`h-full rounded-full transition-all ${STATUS_BAR[status]}`}
          style={{ width: `${Math.max(0, Math.min(100, health.score))}%` }}
        />
      </div>

      {health.topProblem ? (
        <Link
          href={`/crm/problems?sector=${health.sector}`}
          className="mt-4 block rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 transition-colors hover:border-neutral-700"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Principal problema
          </p>
          <p className="mt-1 text-sm text-neutral-200">
            {health.topProblem.type}
          </p>
          {health.topProblem.rootCause ? (
            <p className="mt-1 line-clamp-2 text-xs text-neutral-500">
              {health.topProblem.rootCause}
            </p>
          ) : null}
        </Link>
      ) : (
        <p className="mt-4 text-xs text-neutral-500">Sem problemas em aberto.</p>
      )}
    </div>
  );
}

function CounterCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: 'red' | 'amber' | 'emerald';
}) {
  const tone =
    accent === 'red'
      ? 'text-red-400'
      : accent === 'amber'
        ? 'text-amber-400'
        : accent === 'emerald'
          ? 'text-emerald-400'
          : 'text-white';
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </p>
      <p className={`mt-2 text-2xl font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

export default function CrmOverviewPage() {
  const query = useQuery({
    queryKey: ['crm', 'overview'],
    queryFn: ({ signal }) => api.crmOverview(signal),
    retry: false,
    refetchInterval: 30_000,
  });

  const data: CrmOverview | undefined = query.data;
  const missing = query.error instanceof ApiError && query.error.status === 404;

  // Garante todos os 7 setores no grid, mesmo que a API ainda nao tenha snapshot.
  const bySector = new Map(data?.sectors.map((s) => [s.sector, s]) ?? []);
  const sectors: SectorHealthView[] = SECTORS.map(
    (sector) =>
      bySector.get(sector) ?? {
        sector,
        score: 0,
        status: 'CRITICAL' as SectorStatus,
        kpis: {},
        topProblem: null,
      },
  );

  return (
    <div>
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            CRM — Command Center
          </h1>
          <p className="mt-1 text-sm text-neutral-400">
            Saude operacional por setor, governada pelo COO (OperationsAgent).
          </p>
        </div>
        {data ? (
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              data.killSwitch
                ? 'bg-red-500/20 text-red-300'
                : 'bg-emerald-500/20 text-emerald-300'
            }`}
          >
            {data.killSwitch ? 'Kill switch LIGADO' : 'Operacao automatica ativa'}
          </span>
        ) : null}
      </header>

      <CrmTabs active="/crm" />

      {query.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando saude dos setores…</p>
      ) : query.isError && !missing ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          Nao foi possivel carregar a visao geral. Verifique se a API esta no ar.
          <p className="mt-2 text-xs text-neutral-500">
            {query.error instanceof Error ? query.error.message : null}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {missing ? (
            <div className="rounded-xl border border-dashed border-neutral-800 p-4 text-sm text-neutral-400">
              O endpoint <code className="text-neutral-300">/crm/overview</code> ainda
              esta aquecendo. Rode um scan em Guardrails para gerar os primeiros
              snapshots.
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <CounterCard
              label="Problemas abertos"
              value={data?.counts.openProblems ?? 0}
              accent={data && data.counts.openProblems > 0 ? 'amber' : 'emerald'}
            />
            <CounterCard
              label="Aprovacoes pendentes"
              value={data?.counts.queuedApprovals ?? 0}
              accent={data && data.counts.queuedApprovals > 0 ? 'red' : 'emerald'}
            />
            <CounterCard
              label="Acoes aplicadas"
              value={data?.counts.appliedActions ?? 0}
              accent="emerald"
            />
            <CounterCard
              label="Acoes com falha"
              value={data?.counts.failedActions ?? 0}
              accent={data && (data.counts.failedActions ?? 0) > 0 ? 'red' : undefined}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sectors.map((s) => (
              <SectorCard key={s.sector} health={s} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
