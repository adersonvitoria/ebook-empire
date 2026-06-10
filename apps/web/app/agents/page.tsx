'use client';

// Agents — historico de execucoes (AgentRun) e botao para disparar um ciclo
// do Orchestrator (CEO). Consome GET /agents/runs e POST /agents/run-cycle.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  formatBRL,
  formatDateTime,
  formatDuration,
  formatNumber,
  type AgentRun,
  type AgentRunStatus,
} from '@/lib/api';
import { useAuth, isUnauthorized } from '@/lib/auth';

const STATUS_STYLES: Record<AgentRunStatus, string> = {
  RUNNING: 'bg-sky-500/20 text-sky-300',
  SUCCESS: 'bg-emerald-500/20 text-emerald-300',
  FAILED: 'bg-red-500/20 text-red-300',
  SKIPPED: 'bg-neutral-700/40 text-neutral-400',
};

function StatusBadge({ status }: { status: AgentRunStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

export default function AgentsPage() {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();

  const runsQuery = useQuery({
    queryKey: ['agents', 'runs'],
    queryFn: ({ signal }) => api.listAgentRuns({ limit: 100 }, signal),
    retry: false,
    // execucoes mudam com frequencia — atualiza a cada 15s.
    refetchInterval: 15_000,
  });

  const cycleMutation = useMutation({
    mutationFn: () => api.runCycle(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents', 'runs'] });
    },
  });

  const runs = runsQuery.data?.data ?? [];
  const listMissing =
    runsQuery.error instanceof ApiError && runsQuery.error.status === 404;

  return (
    <div>
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Agents</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Historico de execucoes dos agentes e disparo manual de ciclo.
          </p>
        </div>
        <div className="flex flex-col items-end">
          <button
            onClick={() => cycleMutation.mutate()}
            disabled={cycleMutation.isPending || !isAuthenticated}
            title={!isAuthenticated ? 'Faca login para agir' : undefined}
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-fg transition-colors hover:bg-brand/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cycleMutation.isPending
              ? 'Rodando ciclo…'
              : !isAuthenticated
                ? 'Faca login para rodar'
                : 'Rodar ciclo'}
          </button>
          {cycleMutation.isError ? (
            <p className="mt-2 text-xs text-red-400">
              {isUnauthorized(cycleMutation.error)
                ? 'Faca login para disparar o ciclo.'
                : cycleMutation.error instanceof ApiError &&
                    cycleMutation.error.status === 404
                  ? 'Rota /agents/run-cycle ainda nao implementada.'
                  : 'Falha ao disparar ciclo.'}
            </p>
          ) : null}
          {cycleMutation.isSuccess ? (
            <p className="mt-2 text-xs text-emerald-400">Ciclo disparado.</p>
          ) : null}
        </div>
      </header>

      {runsQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando execucoes…</p>
      ) : runsQuery.isError ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          {listMissing
            ? 'Rota /agents/runs ainda nao implementada.'
            : 'Nao foi possivel carregar as execucoes. Verifique se a API esta no ar.'}
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Nenhuma execucao registrada. Dispare um ciclo acima.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900/80 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">Agente</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Inicio</th>
                <th className="px-4 py-3 font-medium">Duracao</th>
                <th className="px-4 py-3 font-medium">Tokens</th>
                <th className="px-4 py-3 font-medium">Custo</th>
                <th className="px-4 py-3 font-medium">Ciclo</th>
                <th className="px-4 py-3 font-medium">Erro</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {runs.map((run: AgentRun) => (
                <tr key={run.id} className="hover:bg-neutral-900/40">
                  <td className="px-4 py-3 font-medium text-white">{run.agent}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-4 py-3 text-neutral-400">
                    {formatDateTime(run.startedAt)}
                  </td>
                  <td className="px-4 py-3 text-neutral-400">
                    {formatDuration(run.durationMs)}
                  </td>
                  <td className="px-4 py-3 text-neutral-400">
                    {run.tokensIn !== null && run.tokensIn !== undefined
                      ? `${formatNumber(run.tokensIn)} / ${formatNumber(run.tokensOut)}`
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-neutral-400">
                    {run.costCents !== null && run.costCents !== undefined
                      ? formatBRL(run.costCents)
                      : '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-neutral-500">
                    {run.cycleId ? `${run.cycleId.slice(0, 8)}…` : '—'}
                  </td>
                  <td className="max-w-[16rem] truncate px-4 py-3 text-xs text-red-400">
                    {run.error ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
