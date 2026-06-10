'use client';

// CRM — Qualidade (setor EBOOK_QA). Lista as auditorias de ebooks (EbookAudit)
// com verdict/score/issues e botoes para auditar e rodar o loop de correcao.
// Consome GET /quality/audits e POST /quality/audit|fix (este modulo e dono das
// rotas). Trata 404 (rota aquecendo) e API fora do ar graciosamente.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CrmTabs } from '../crm-tabs';
import { API_BASE, ApiError, authHeaders, formatDateTime } from '@/lib/api';
import { useAuth, isUnauthorized } from '@/lib/auth';

// ------------------------------------------------------------
// Tipos espelhados (o browser nao importa @ebook-empire/core).
// ------------------------------------------------------------
type Verdict = 'PASS' | 'NEEDS_FIX' | 'FAIL';
type IssueSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKER';

interface EbookIssue {
  category: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
  suggestion: string;
  chapterIndex?: number | null;
}

interface EbookAuditRow {
  id: string;
  ebookId: string;
  score: number;
  verdict: Verdict;
  issues: EbookIssue[];
  recommendations: string[];
  dimensionScores: {
    structure: number;
    contentQuality: number;
    marketFit: number;
    compliance: number;
  };
  iteration: number;
  auditedAt: string;
  createdAt: string;
  ebook?: { id: string; title: string; niche: string; status: string } | null;
}

const VERDICTS: Verdict[] = ['PASS', 'NEEDS_FIX', 'FAIL'];

const VERDICT_STYLES: Record<Verdict, string> = {
  PASS: 'bg-emerald-500/20 text-emerald-300',
  NEEDS_FIX: 'bg-amber-500/20 text-amber-300',
  FAIL: 'bg-red-500/20 text-red-300',
};

const SEVERITY_STYLES: Record<IssueSeverity, string> = {
  BLOCKER: 'bg-red-500/20 text-red-300',
  HIGH: 'bg-orange-500/20 text-orange-300',
  MEDIUM: 'bg-amber-500/20 text-amber-300',
  LOW: 'bg-neutral-700/40 text-neutral-400',
};

function scoreTone(score: number): string {
  if (score >= 70) return 'text-emerald-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-red-400';
}

// ------------------------------------------------------------
// Fetch helpers (diretos contra a API; lib/api.ts ainda nao expoe /quality).
// ------------------------------------------------------------
async function fetchAudits(
  params: { verdict?: string },
  signal?: AbortSignal,
): Promise<{ items: EbookAuditRow[]; total: number }> {
  const url = new URL('quality/audits', `${API_BASE.replace(/\/$/, '')}/`);
  if (params.verdict) url.searchParams.set('verdict', params.verdict);
  url.searchParams.set('limit', '100');
  const res = await fetch(url.toString(), { cache: 'no-store', signal });
  if (!res.ok) throw new ApiError(res.statusText || `HTTP ${res.status}`, res.status);
  return res.json();
}

async function postQa(path: string): Promise<unknown> {
  const url = new URL(path, `${API_BASE.replace(/\/$/, '')}/`).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(true),
    body: '{}',
    cache: 'no-store',
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = (await res.json()) as { error?: string; detail?: string };
      detail = data.detail ?? data.error ?? detail;
    } catch {
      /* sem corpo */
    }
    throw new ApiError(detail || `HTTP ${res.status}`, res.status);
  }
  return res.json();
}

export default function CrmQualityPage() {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const [verdict, setVerdict] = useState<Verdict | ''>('');
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['quality', 'audits', verdict],
    queryFn: ({ signal }) => fetchAudits({ verdict: verdict || undefined }, signal),
    retry: false,
    refetchInterval: 20_000,
  });

  const auditMutation = useMutation({
    mutationFn: (ebookId: string) => postQa(`quality/audit/${ebookId}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['quality', 'audits'] }),
  });
  const fixMutation = useMutation({
    mutationFn: (ebookId: string) => postQa(`quality/fix/${ebookId}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['quality', 'audits'] }),
  });

  const audits = query.data?.items ?? [];
  const missing = query.error instanceof ApiError && query.error.status === 404;
  const busyId =
    auditMutation.isPending
      ? (auditMutation.variables as string)
      : fixMutation.isPending
        ? (fixMutation.variables as string)
        : null;

  const selectClass =
    'rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200';
  const btnClass =
    'rounded-md border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-800 disabled:opacity-40';

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Qualidade</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Auditoria de ebooks (EBOOK_QA) — score, problemas e loop de correcao. Um
          ebook so e lancado apos verdict PASS.
        </p>
      </header>

      <CrmTabs active="/crm/quality" />

      <div className="mb-5 flex flex-wrap gap-3">
        <select
          value={verdict}
          onChange={(e) => setVerdict(e.target.value as Verdict | '')}
          className={selectClass}
        >
          <option value="">Todos os vereditos</option>
          {VERDICTS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando auditorias…</p>
      ) : query.isError && !missing ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          Nao foi possivel carregar as auditorias. Verifique se a API esta no ar.
        </div>
      ) : missing ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Rota <code className="text-neutral-300">/quality/audits</code> ainda nao
          disponivel.
        </div>
      ) : audits.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Nenhuma auditoria encontrada com os filtros atuais.
        </div>
      ) : (
        <ul className="space-y-3">
          {audits.map((a) => {
            const isOpen = openId === a.id;
            const busy = busyId === a.ebookId;
            return (
              <li
                key={a.id}
                className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-white">
                        {a.ebook?.title ?? a.ebookId}
                      </span>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${VERDICT_STYLES[a.verdict]}`}
                      >
                        {a.verdict}
                      </span>
                      {a.ebook?.niche ? (
                        <span className="rounded-md bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
                          {a.ebook.niche}
                        </span>
                      ) : null}
                      <span className="text-xs text-neutral-500">
                        iteracao {a.iteration}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-neutral-500">
                      Auditado em {formatDateTime(a.auditedAt)} ·{' '}
                      {a.issues.length} problema(s)
                    </p>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-neutral-400">
                      <span>Estrutura {a.dimensionScores.structure}</span>
                      <span>Qualidade {a.dimensionScores.contentQuality}</span>
                      <span>Mercado {a.dimensionScores.marketFit}</span>
                      <span>Compliance {a.dimensionScores.compliance}</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <div className="text-right">
                      <p className="text-xs uppercase tracking-wide text-neutral-500">
                        Score
                      </p>
                      <p className={`text-lg font-semibold ${scoreTone(a.score)}`}>
                        {a.score}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={btnClass}
                        disabled={busy || !isAuthenticated}
                        title={!isAuthenticated ? 'Faca login para agir' : undefined}
                        onClick={() => auditMutation.mutate(a.ebookId)}
                      >
                        {busy && auditMutation.isPending ? '…' : 'Auditar'}
                      </button>
                      <button
                        type="button"
                        className={btnClass}
                        disabled={busy || a.verdict === 'PASS' || !isAuthenticated}
                        title={!isAuthenticated ? 'Faca login para agir' : undefined}
                        onClick={() => fixMutation.mutate(a.ebookId)}
                      >
                        {busy && fixMutation.isPending ? '…' : 'Corrigir'}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="text-xs text-neutral-500 hover:text-neutral-300"
                      onClick={() => setOpenId(isOpen ? null : a.id)}
                    >
                      {isOpen ? 'Ocultar detalhes' : 'Ver detalhes'}
                    </button>
                  </div>
                </div>

                {isOpen ? (
                  <div className="mt-4 space-y-3 border-t border-neutral-800 pt-3">
                    {a.issues.length > 0 ? (
                      <ul className="space-y-2">
                        {a.issues.map((issue, i) => (
                          <li key={i} className="text-sm">
                            <div className="flex items-center gap-2">
                              <span
                                className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[issue.severity]}`}
                              >
                                {issue.severity}
                              </span>
                              <span className="text-neutral-300">{issue.category}</span>
                              <span className="font-medium text-white">{issue.title}</span>
                            </div>
                            <p className="mt-1 text-xs text-neutral-400">{issue.detail}</p>
                            <p className="mt-0.5 text-xs text-neutral-500">
                              Sugestao: {issue.suggestion}
                            </p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-neutral-500">Sem problemas registrados.</p>
                    )}
                    {a.recommendations.length > 0 ? (
                      <div>
                        <p className="text-xs uppercase tracking-wide text-neutral-500">
                          Recomendacoes
                        </p>
                        <ul className="mt-1 list-inside list-disc text-sm text-neutral-400">
                          {a.recommendations.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {(auditMutation.isError || fixMutation.isError) && (
        <p className="mt-4 text-sm text-red-400">
          {isUnauthorized(auditMutation.error) || isUnauthorized(fixMutation.error)
            ? 'Faca login para auditar ou corrigir ebooks.'
            : `Falha na operacao: ${
                (auditMutation.error ?? fixMutation.error) instanceof Error
                  ? (auditMutation.error ?? (fixMutation.error as Error)).message
                  : 'erro desconhecido'
              }`}
        </p>
      )}
    </div>
  );
}
