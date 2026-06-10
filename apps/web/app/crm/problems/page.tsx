'use client';

// CRM — Feed de problemas detectados pelo motor de diagnostico. Filtravel por
// status e setor. Consome GET /crm/problems. Le ?sector= da URL (vindo do card
// de overview). Trata 404 e API fora do ar graciosamente.

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { CrmTabs } from '../page';
import {
  api,
  ApiError,
  formatDateTime,
  SECTORS,
  type CrmProblem,
  type ProblemStatus,
  type Sector,
} from '@/lib/api';

const PROBLEM_STATUSES: ProblemStatus[] = [
  'OPEN',
  'DIAGNOSING',
  'REMEDIATING',
  'RESOLVED',
  'IGNORED',
];

const STATUS_STYLES: Record<ProblemStatus, string> = {
  OPEN: 'bg-red-500/20 text-red-300',
  DIAGNOSING: 'bg-amber-500/20 text-amber-300',
  REMEDIATING: 'bg-sky-500/20 text-sky-300',
  RESOLVED: 'bg-emerald-500/20 text-emerald-300',
  IGNORED: 'bg-neutral-700/40 text-neutral-400',
};

function severityTone(severity: number): string {
  if (severity >= 60) return 'text-red-400';
  if (severity >= 30) return 'text-amber-400';
  return 'text-neutral-300';
}

// useSearchParams exige boundary de Suspense no build do Next 14.
export default function CrmProblemsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-neutral-500">Carregando…</p>}>
      <CrmProblemsInner />
    </Suspense>
  );
}

function CrmProblemsInner() {
  const searchParams = useSearchParams();
  const initialSector = (searchParams.get('sector') as Sector | null) ?? undefined;

  const [status, setStatus] = useState<ProblemStatus | ''>('');
  const [sector, setSector] = useState<Sector | ''>(initialSector ?? '');

  const query = useQuery({
    queryKey: ['crm', 'problems', status, sector],
    queryFn: ({ signal }) =>
      api.crmListProblems(
        {
          status: status || undefined,
          sector: sector || undefined,
          limit: 100,
        },
        signal,
      ),
    retry: false,
    refetchInterval: 20_000,
  });

  const problems = query.data?.data ?? [];
  const missing = query.error instanceof ApiError && query.error.status === 404;

  const selectClass =
    'rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200';

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Problemas</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Causas raiz detectadas por setor — diagnostico por regras + LLM.
        </p>
      </header>

      <CrmTabs active="/crm/problems" />

      <div className="mb-5 flex flex-wrap gap-3">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as ProblemStatus | '')}
          className={selectClass}
        >
          <option value="">Todos os status</option>
          {PROBLEM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={sector}
          onChange={(e) => setSector(e.target.value as Sector | '')}
          className={selectClass}
        >
          <option value="">Todos os setores</option>
          {SECTORS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando problemas…</p>
      ) : query.isError && !missing ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          Nao foi possivel carregar os problemas. Verifique se a API esta no ar.
        </div>
      ) : missing ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Rota <code className="text-neutral-300">/crm/problems</code> ainda nao
          disponivel.
        </div>
      ) : problems.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Nenhum problema encontrado com os filtros atuais.
        </div>
      ) : (
        <ul className="space-y-3">
          {problems.map((p: CrmProblem) => (
            <li
              key={p.id}
              className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-300">
                      {p.sector}
                    </span>
                    <span className="text-sm font-semibold text-white">{p.type}</span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[p.status]}`}
                    >
                      {p.status}
                    </span>
                  </div>
                  {p.rootCause ? (
                    <p className="mt-2 text-sm text-neutral-400">{p.rootCause}</p>
                  ) : null}
                  <p className="mt-2 text-xs text-neutral-500">
                    Detectado em {formatDateTime(p.detectedAt)}
                    {p.resolvedAt
                      ? ` · resolvido em ${formatDateTime(p.resolvedAt)}`
                      : ''}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs uppercase tracking-wide text-neutral-500">
                    Severidade
                  </p>
                  <p className={`text-lg font-semibold ${severityTone(p.severity)}`}>
                    {Math.round(p.severity)}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
