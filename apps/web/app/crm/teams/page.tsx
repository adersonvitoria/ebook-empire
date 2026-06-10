'use client';

// CRM — TIMES por setor (framework Specialist/Strategist/Executor).
// Para cada setor mostra o ultimo Assessment (especialista), Strategy
// (estrategista) e ExecutionOutcome (executor), montados a partir do historico
// de AgentRun (cada execucao de papel grava role+sector+output).
//
// Consome GET /agents/runs (via api.teamRuns). Degrada com gracia: se a rota
// nao expor role/sector/output, mostra estado vazio por setor (sem quebrar).

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  ApiError,
  TEAM_SECTORS,
  type TeamRun,
  type TeamSector,
  type TeamSectorView,
  type Assessment,
  type Strategy,
  type ExecutionOutcome,
  type SectorStatus,
  formatDateTime,
} from '@/lib/api';

const SECTOR_LABELS: Record<TeamSector, string> = {
  CONTENT: 'Conteudo',
  SALES: 'Vendas',
  DELIVERY: 'Entrega',
  SOCIAL: 'Social',
  TRAFFIC: 'Trafego',
  ANALYTICS: 'Analytics',
  ORCHESTRATION: 'Orquestracao',
  MARKET_RESEARCH: 'Analise de Mercado',
  EBOOK_QA: 'QA de Ebooks',
};

const STATUS_TEXT: Record<SectorStatus, string> = {
  HEALTHY: 'text-emerald-400',
  WARNING: 'text-amber-400',
  CRITICAL: 'text-red-400',
};

const STATUS_RING: Record<SectorStatus, string> = {
  HEALTHY: 'border-emerald-500/40 bg-emerald-500/5',
  WARNING: 'border-amber-500/40 bg-amber-500/5',
  CRITICAL: 'border-red-500/40 bg-red-500/5',
};

// ------------------------------------------------------------
// Monta a visao por setor a partir do historico de runs. Para cada setor,
// pega o run mais recente de cada papel (SPECIALIST/STRATEGIST/EXECUTOR) e le
// o respectivo output (Assessment/Strategy/ExecutionOutcome).
// ------------------------------------------------------------
function buildSectorViews(runs: TeamRun[]): TeamSectorView[] {
  // runs ja vem ordenado desc por startedAt (rota /agents/runs); preservamos.
  const bySector = new Map<TeamSector, TeamSectorView>();

  for (const sector of TEAM_SECTORS) {
    bySector.set(sector, { sector });
  }

  for (const run of runs) {
    if (!run.sector || !run.role) continue;
    const sector = run.sector as TeamSector;
    const view = bySector.get(sector);
    if (!view) continue;
    if (!view.lastRunAt) view.lastRunAt = run.startedAt;

    if (run.role === 'SPECIALIST' && !view.assessment) {
      view.assessment = (run.output as Assessment) ?? null;
    } else if (run.role === 'STRATEGIST' && !view.strategy) {
      view.strategy = (run.output as Strategy) ?? null;
    } else if (run.role === 'EXECUTOR' && !view.outcome) {
      view.outcome = (run.output as ExecutionOutcome) ?? null;
    }
  }

  return TEAM_SECTORS.map((s) => bySector.get(s)!);
}

function Pill({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{children}</span>
  );
}

function TeamCard({ view }: { view: TeamSectorView }) {
  const { assessment, strategy, outcome } = view;
  const status = assessment?.status;
  const ring = status ? STATUS_RING[status] : 'border-neutral-800 bg-neutral-900/50';

  return (
    <div className={`rounded-xl border p-5 ${ring}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold text-white">{SECTOR_LABELS[view.sector]}</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {view.lastRunAt ? `Ultimo ciclo: ${formatDateTime(view.lastRunAt)}` : 'Sem ciclos ainda'}
          </p>
        </div>
        {assessment ? (
          <div className="text-right">
            <p className="text-2xl font-semibold text-white">
              {Math.round(assessment.healthScore)}
              <span className="text-sm font-normal text-neutral-500">/100</span>
            </p>
            <p className={`text-xs font-medium ${status ? STATUS_TEXT[status] : ''}`}>
              {assessment.source === 'LLM' ? 'IA' : 'Regras'}
            </p>
          </div>
        ) : null}
      </div>

      {!assessment && !strategy && !outcome ? (
        <p className="mt-4 text-xs text-neutral-500">
          Nenhum dado de time para este setor ainda. Rode um ciclo dos times.
        </p>
      ) : null}

      {/* ESPECIALISTA — Assessment */}
      {assessment ? (
        <section className="mt-4 border-t border-neutral-800 pt-3">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
            Especialista
          </p>
          {assessment.findings.slice(0, 3).map((f, i) => (
            <p key={i} className="text-sm text-neutral-200">• {f}</p>
          ))}
          {assessment.risks.length > 0 ? (
            <p className="mt-1 text-xs text-red-300">Riscos: {assessment.risks.join('; ')}</p>
          ) : null}
        </section>
      ) : null}

      {/* ESTRATEGISTA — Strategy */}
      {strategy ? (
        <section className="mt-3 border-t border-neutral-800 pt-3">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Estrategista
            </p>
            <Pill tone={strategy.mode === 'GROW' ? 'bg-sky-500/20 text-sky-300' : 'bg-neutral-700/50 text-neutral-300'}>
              {strategy.mode}
            </Pill>
          </div>
          <p className="text-sm text-neutral-200">{strategy.objective}</p>
          <div className="mt-2 space-y-1">
            {strategy.actions
              .slice()
              .sort((a, b) => b.priority - a.priority)
              .slice(0, 4)
              .map((a, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-neutral-300">
                    {a.priority}
                  </span>
                  <span className="text-neutral-300">{a.capability}</span>
                  <span className="truncate text-neutral-500">— {a.reason}</span>
                </div>
              ))}
          </div>
        </section>
      ) : null}

      {/* EXECUTOR — ExecutionOutcome */}
      {outcome ? (
        <section className="mt-3 border-t border-neutral-800 pt-3">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
            Executor
          </p>
          <div className="flex gap-2">
            <Pill tone="bg-emerald-500/20 text-emerald-300">{outcome.succeeded} ok</Pill>
            {outcome.failed > 0 ? (
              <Pill tone="bg-red-500/20 text-red-300">{outcome.failed} falha</Pill>
            ) : null}
            {outcome.skipped > 0 ? (
              <Pill tone="bg-neutral-700/50 text-neutral-300">{outcome.skipped} pulada</Pill>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-neutral-500">{outcome.summary}</p>
        </section>
      ) : null}
    </div>
  );
}

export default function TeamsPage() {
  const query = useQuery({
    queryKey: ['crm', 'teams'],
    queryFn: ({ signal }) => api.teamRuns({ limit: 300 }, signal),
    retry: false,
    refetchInterval: 30_000,
  });

  const missing = query.error instanceof ApiError && query.error.status === 404;
  const views = buildSectorViews(query.data?.data ?? []);

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Times por setor</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Cada setor opera como um time de 3 papeis — Especialista (diagnostico),
          Estrategista (plano) e Executor (acoes) — rumo a meta de faturamento diaria.
        </p>
      </header>

      <nav className="mb-6 flex flex-wrap gap-1 border-b border-neutral-800">
        <Link href="/crm" className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-neutral-400 hover:text-neutral-200">
          Visao geral
        </Link>
        <Link href="/crm/teams" className="-mb-px border-b-2 border-brand px-3 py-2 text-sm text-white">
          Times
        </Link>
        <Link href="/crm/market" className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-neutral-400 hover:text-neutral-200">
          Mercado
        </Link>
        <Link href="/crm/quality" className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-neutral-400 hover:text-neutral-200">
          Qualidade
        </Link>
      </nav>

      {query.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando times…</p>
      ) : query.isError && !missing ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          Nao foi possivel carregar os times. Verifique se a API esta no ar.
          <p className="mt-2 text-xs text-neutral-500">
            {query.error instanceof Error ? query.error.message : null}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {missing ? (
            <div className="rounded-xl border border-dashed border-neutral-800 p-4 text-sm text-neutral-400">
              O historico de execucoes ainda esta aquecendo. Dispare um ciclo dos times.
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {views.map((v) => (
              <TeamCard key={v.sector} view={v} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
