'use client';

// CRM — Fila de aprovacao humana. Acoes HIGH risk (financeiras / voltadas ao
// cliente) ficam QUEUED ate aprovacao. Botoes Aprovar / Rejeitar.
// Consome GET /crm/approvals, POST /crm/actions/:id/approve e /reject.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CrmTabs } from '../crm-tabs';
import {
  api,
  ApiError,
  formatBRL,
  formatDateTime,
  type CrmAction,
} from '@/lib/api';

// Renderiza os params de forma legivel (centavos -> BRL onde aplicavel).
function ParamsSummary({ params }: { params: Record<string, unknown> }) {
  const entries = Object.entries(params).filter(([k]) => k !== 'kind');
  if (entries.length === 0) return null;
  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:max-w-md">
      {entries.map(([key, value]) => {
        const isCents = /Cents$/.test(key) && typeof value === 'number';
        return (
          <div key={key} className="contents">
            <dt className="text-neutral-500">{key}</dt>
            <dd className="text-neutral-300">
              {isCents ? formatBRL(value as number) : String(value)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export default function CrmApprovalsPage() {
  const queryClient = useQueryClient();
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});

  const query = useQuery({
    queryKey: ['crm', 'approvals'],
    queryFn: ({ signal }) => api.crmListApprovals(signal),
    retry: false,
    refetchInterval: 15_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['crm', 'approvals'] });
    void queryClient.invalidateQueries({ queryKey: ['crm', 'actions'] });
    void queryClient.invalidateQueries({ queryKey: ['crm', 'overview'] });
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) => api.crmApproveAction(id),
    onSuccess: invalidate,
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.crmRejectAction(id, reason),
    onSuccess: invalidate,
  });

  const pending = approveMutation.isPending || rejectMutation.isPending;
  const actions = query.data?.data ?? [];
  const missing = query.error instanceof ApiError && query.error.status === 404;

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Aprovacoes</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Acoes de alto risco (financeiras / voltadas ao cliente) aguardando decisao
          humana.
        </p>
      </header>

      <CrmTabs active="/crm/approvals" />

      {query.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando fila…</p>
      ) : query.isError && !missing ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          Nao foi possivel carregar a fila. Verifique se a API esta no ar.
        </div>
      ) : missing ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Rota <code className="text-neutral-300">/crm/approvals</code> ainda nao
          disponivel.
        </div>
      ) : actions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Nenhuma acao aguardando aprovacao. Tudo sob controle.
        </div>
      ) : (
        <ul className="space-y-4">
          {actions.map((a: CrmAction) => (
            <li
              key={a.id}
              className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-white">{a.kind}</span>
                {a.sector ? (
                  <span className="rounded-md bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
                    {a.sector}
                  </span>
                ) : null}
                <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-300">
                  Alto risco
                </span>
              </div>

              {a.expectedEffect ? (
                <p className="mt-2 text-sm text-neutral-300">{a.expectedEffect}</p>
              ) : null}
              <ParamsSummary params={a.params} />
              <p className="mt-2 text-xs text-neutral-500">
                Enfileirada em {formatDateTime(a.createdAt)}
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => approveMutation.mutate(a.id)}
                  disabled={pending}
                  className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  Aprovar
                </button>
                <input
                  type="text"
                  placeholder="Motivo (opcional)"
                  value={rejectReason[a.id] ?? ''}
                  onChange={(e) =>
                    setRejectReason((prev) => ({ ...prev, [a.id]: e.target.value }))
                  }
                  className="min-w-[12rem] flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200"
                />
                <button
                  onClick={() =>
                    rejectMutation.mutate({ id: a.id, reason: rejectReason[a.id] })
                  }
                  disabled={pending}
                  className="rounded-md border border-red-500/40 px-4 py-1.5 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                >
                  Rejeitar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {approveMutation.isError || rejectMutation.isError ? (
        <p className="mt-4 text-xs text-red-400">
          Falha ao processar a decisao. Tente novamente.
        </p>
      ) : null}
    </div>
  );
}
