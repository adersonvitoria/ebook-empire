'use client';

// CRM — Timeline de acoes de remediacao (aplicadas, falhas, revertidas). Mostra
// kind, tier de risco, status, efeito esperado, gatilho (AUTO/HUMAN) e permite
// rollback de acoes APPLIED reversiveis. Consome GET /crm/actions e
// POST /crm/executions/:id/rollback.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CrmTabs } from '../crm-tabs';
import {
  api,
  ApiError,
  formatDateTime,
  type ActionStatus,
  type CrmAction,
} from '@/lib/api';
import { useAuth, isUnauthorized } from '@/lib/auth';

const ACTION_STATUSES: ActionStatus[] = [
  'PROPOSED',
  'QUEUED',
  'APPROVED',
  'REJECTED',
  'APPLIED',
  'FAILED',
  'ROLLED_BACK',
];

const STATUS_STYLES: Record<ActionStatus, string> = {
  PROPOSED: 'bg-neutral-700/40 text-neutral-300',
  QUEUED: 'bg-amber-500/20 text-amber-300',
  APPROVED: 'bg-sky-500/20 text-sky-300',
  REJECTED: 'bg-neutral-700/40 text-neutral-400',
  APPLIED: 'bg-emerald-500/20 text-emerald-300',
  FAILED: 'bg-red-500/20 text-red-300',
  ROLLED_BACK: 'bg-purple-500/20 text-purple-300',
};

function RiskBadge({ tier }: { tier: CrmAction['riskTier'] }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        tier === 'HIGH'
          ? 'bg-red-500/15 text-red-300'
          : 'bg-emerald-500/15 text-emerald-300'
      }`}
    >
      {tier === 'HIGH' ? 'Alto risco' : 'Baixo risco'}
    </span>
  );
}

export default function CrmActionsPage() {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const [status, setStatus] = useState<ActionStatus | ''>('');

  const query = useQuery({
    queryKey: ['crm', 'actions', status],
    queryFn: ({ signal }) =>
      api.crmListActions({ status: status || undefined, limit: 100 }, signal),
    retry: false,
    refetchInterval: 20_000,
  });

  const rollbackMutation = useMutation({
    mutationFn: (executionId: string) => api.crmRollback(executionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['crm', 'actions'] });
      void queryClient.invalidateQueries({ queryKey: ['crm', 'overview'] });
    },
  });

  const actions = query.data?.data ?? [];
  const missing = query.error instanceof ApiError && query.error.status === 404;

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Acoes</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Historico de remediacoes propostas e executadas pelo executor autonomo.
        </p>
      </header>

      <CrmTabs active="/crm/actions" />

      <div className="mb-5 flex flex-wrap gap-3">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as ActionStatus | '')}
          className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200"
        >
          <option value="">Todos os status</option>
          {ACTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando acoes…</p>
      ) : query.isError && !missing ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          Nao foi possivel carregar as acoes. Verifique se a API esta no ar.
        </div>
      ) : missing ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Rota <code className="text-neutral-300">/crm/actions</code> ainda nao
          disponivel.
        </div>
      ) : actions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Nenhuma acao registrada ainda.
        </div>
      ) : (
        <ol className="relative space-y-3 border-l border-neutral-800 pl-5">
          {actions.map((a: CrmAction) => {
            const exec = a.execution;
            const canRollback =
              a.status === 'APPLIED' && a.reversible && !!exec?.id && exec.success;
            return (
              <li key={a.id} className="relative">
                <span className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-neutral-600" />
                <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-white">
                          {a.kind}
                        </span>
                        <RiskBadge tier={a.riskTier} />
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[a.status]}`}
                        >
                          {a.status}
                        </span>
                        {exec ? (
                          <span className="rounded-md bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                            {exec.triggeredBy === 'AUTO' ? 'Automatico' : 'Humano'}
                          </span>
                        ) : null}
                      </div>
                      {a.expectedEffect ? (
                        <p className="mt-2 text-sm text-neutral-400">
                          {a.expectedEffect}
                        </p>
                      ) : null}
                      {exec?.error ? (
                        <p className="mt-1 text-xs text-red-400">{exec.error}</p>
                      ) : null}
                      <p className="mt-2 text-xs text-neutral-500">
                        Criada em {formatDateTime(a.createdAt)}
                        {exec?.finishedAt
                          ? ` · executada em ${formatDateTime(exec.finishedAt)}`
                          : ''}
                      </p>
                    </div>

                    {canRollback ? (
                      <button
                        onClick={() => rollbackMutation.mutate(exec!.id)}
                        disabled={rollbackMutation.isPending || !isAuthenticated}
                        title={!isAuthenticated ? 'Faca login para agir' : undefined}
                        className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-800 disabled:opacity-50"
                      >
                        {rollbackMutation.isPending
                          ? 'Revertendo…'
                          : !isAuthenticated
                            ? 'Login p/ reverter'
                            : 'Reverter'}
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {rollbackMutation.isError ? (
        <p className="mt-4 text-xs text-red-400">
          {isUnauthorized(rollbackMutation.error)
            ? 'Faca login para reverter acoes.'
            : 'Falha ao reverter a acao. Pode nao ser reversivel ou a rota nao existe.'}
        </p>
      ) : null}
    </div>
  );
}
