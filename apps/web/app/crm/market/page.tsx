'use client';

// Analise de Mercado (setor MARKET_RESEARCH) — board de oportunidades rankeadas
// por POTENCIAL DE SUCESSO. Consome GET /market/opportunities e GET /market/top.
// O botao "rodar analise" dispara POST /market/scan (protegido por JWT) — sem
// token a API responde 401; tratamos isso de forma graciosa.
//
// Dono deste arquivo: MODULO Mercado. Faz fetch direto contra API_BASE (lib/api.ts
// e da Fundacao e ainda nao tem metodos de mercado) reusando ApiError.
//
// Scores sao 0..100 (NAO centavos) — nunca usar formatBRL aqui.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, ApiError, authHeaders, formatDateTime } from '@/lib/api';
import { useAuth } from '@/lib/auth';

// ------------------------------------------------------------
// Tipos espelhados de @ebook-empire/core (market.ts). O browser nao importa core.
// ------------------------------------------------------------
type MarketOpportunityStatus = 'PENDING' | 'SELECTED' | 'USED' | 'DISCARDED';

interface MarketOpportunity {
  id: string;
  segment: string;
  niche: string;
  demandScore: number;
  competitionScore: number;
  potentialScore: number;
  rationale: string;
  titleIdeas: string[];
  angles: string[];
  evidence: string[];
  status: MarketOpportunityStatus;
  rankedAt: string;
  createdAt: string;
}

interface OpportunitiesResponse {
  total: number;
  opportunities: MarketOpportunity[];
}

// ------------------------------------------------------------
// Fetch helpers (diretos — reusam ApiError da Fundacao).
// ------------------------------------------------------------
function buildUrl(path: string): string {
  return new URL(path.replace(/^\//, ''), `${API_BASE.replace(/\/$/, '')}/`).toString();
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path), { signal, cache: 'no-store' });
  } catch (err) {
    throw new ApiError(err instanceof Error ? err.message : 'falha de rede', 0);
  }
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  return (await res.json()) as T;
}

async function postScan(): Promise<{ count: number }> {
  let res: Response;
  try {
    res = await fetch(buildUrl('/market/scan'), {
      method: 'POST',
      headers: authHeaders(true),
      body: '{}',
      cache: 'no-store',
    });
  } catch (err) {
    throw new ApiError(err instanceof Error ? err.message : 'falha de rede', 0);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = (await res.json()) as { error?: string; message?: string };
      detail = data.message ?? data.error ?? detail;
    } catch {
      /* sem corpo */
    }
    throw new ApiError(detail || `HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as { count: number };
}

// ------------------------------------------------------------
// Barra de score 0..100 (verde = bom; para competicao, MAIOR = pior).
// ------------------------------------------------------------
function ScoreBar({
  label,
  value,
  invert,
}: {
  label: string;
  value: number;
  invert?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, value));
  // Para demanda/potencial: alto = verde. Para competicao (invert): alto = vermelho.
  const good = invert ? pct < 40 : pct >= 60;
  const mid = invert ? pct < 70 : pct >= 40;
  const cls = good ? 'bg-emerald-500' : mid ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-neutral-400">{label}</span>
        <span className="text-neutral-300">{pct}/100</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-neutral-800">
        <div className={`h-full rounded-full ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: MarketOpportunityStatus }) {
  const map: Record<MarketOpportunityStatus, string> = {
    SELECTED: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    USED: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
    PENDING: 'bg-neutral-700/30 text-neutral-300 border-neutral-700',
    DISCARDED: 'bg-red-500/15 text-red-400 border-red-500/30',
  };
  const label: Record<MarketOpportunityStatus, string> = {
    SELECTED: 'Selecionada',
    USED: 'Usada',
    PENDING: 'Pendente',
    DISCARDED: 'Descartada',
  };
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${map[status]}`}>
      {label[status]}
    </span>
  );
}

function OpportunityCard({ opp, rank }: { opp: MarketOpportunity; rank: number }) {
  const top = rank === 0 && opp.status === 'SELECTED';
  return (
    <div
      className={`rounded-xl border p-5 ${
        top
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : 'border-neutral-800 bg-neutral-900/50'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">{opp.segment}</p>
          <h3 className="mt-0.5 text-lg font-semibold text-white">{opp.niche}</h3>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className="text-2xl font-bold text-emerald-400">{opp.potentialScore}</span>
          <StatusPill status={opp.status} />
        </div>
      </div>

      <p className="mt-3 text-sm text-neutral-300">{opp.rationale}</p>

      <div className="mt-4 space-y-2">
        <ScoreBar label="Demanda" value={opp.demandScore} />
        <ScoreBar label="Competicao (menor e melhor)" value={opp.competitionScore} invert />
        <ScoreBar label="Potencial" value={opp.potentialScore} />
      </div>

      {opp.titleIdeas.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Titulos sugeridos
          </p>
          <ul className="mt-1 list-inside list-disc text-sm text-neutral-300">
            {opp.titleIdeas.slice(0, 4).map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {opp.angles.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {opp.angles.slice(0, 4).map((a, i) => (
            <span
              key={i}
              className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300"
            >
              {a}
            </span>
          ))}
        </div>
      ) : null}

      {opp.evidence.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-300">
            Evidencias ({opp.evidence.length})
          </summary>
          <ul className="mt-2 list-inside list-disc text-xs text-neutral-400">
            {opp.evidence.slice(0, 8).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="mt-3 text-xs text-neutral-600">Rankeada em {formatDateTime(opp.rankedAt)}</p>
    </div>
  );
}

export default function MarketPage() {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['market', 'opportunities'],
    queryFn: ({ signal }) =>
      getJson<OpportunitiesResponse>('/market/opportunities?limit=50', signal),
    retry: false,
    refetchInterval: 60_000,
  });

  const scan = useMutation({
    mutationFn: postScan,
    onSuccess: (res) => {
      setScanMsg(`Analise concluida — ${res.count} oportunidades rankeadas.`);
      void queryClient.invalidateQueries({ queryKey: ['market'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) {
        setScanMsg('Rodar a analise exige autenticacao (Bearer JWT). Faca login para disparar o scan.');
      } else if (err instanceof ApiError && err.status === 0) {
        setScanMsg('API fora do ar — nao foi possivel rodar a analise.');
      } else {
        setScanMsg(`Falha ao rodar a analise: ${err instanceof Error ? err.message : 'erro'}`);
      }
    },
  });

  const opportunities = list.data?.opportunities ?? [];
  const missing = list.error instanceof ApiError && list.error.status === 404;
  const offline = list.error instanceof ApiError && list.error.status === 0;

  return (
    <div>
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Analise de mercado</h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-400">
            Oportunidades de nicho ordenadas por potencial de sucesso (demanda x competicao).
            Nenhum ebook e lancado sem uma oportunidade selecionada — toda criacao parte daqui.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setScanMsg(null);
            scan.mutate();
          }}
          disabled={scan.isPending || !isAuthenticated}
          title={!isAuthenticated ? 'Faca login para agir' : undefined}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {scan.isPending
            ? 'Rodando analise…'
            : !isAuthenticated
              ? 'Faca login para rodar'
              : 'Rodar analise'}
        </button>
      </header>

      {scanMsg ? (
        <div className="mb-6 rounded-lg border border-neutral-800 bg-neutral-900/50 p-3 text-sm text-neutral-300">
          {scanMsg}
        </div>
      ) : null}

      {list.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando oportunidades…</p>
      ) : missing ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-4 text-sm text-neutral-400">
          O endpoint <code className="text-neutral-300">/market/opportunities</code> ainda esta
          aquecendo. Clique em <strong>Rodar analise</strong> para gerar o primeiro ranking.
        </div>
      ) : list.isError ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          Nao foi possivel carregar as oportunidades.{' '}
          {offline ? 'Verifique se a API esta no ar.' : null}
        </div>
      ) : opportunities.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-400">
          Nenhuma oportunidade ainda. Clique em <strong>Rodar analise</strong> para mapear nichos
          com maior potencial.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {opportunities.map((opp, i) => (
            <OpportunityCard key={opp.id} opp={opp} rank={i} />
          ))}
        </div>
      )}
    </div>
  );
}
