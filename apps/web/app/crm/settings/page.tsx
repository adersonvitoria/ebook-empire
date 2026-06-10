'use client';

// CRM — Guardrails. Toggle do kill switch GLOBAL, edicao dos limites de
// autonomia (maxAutoActionsPerCycle, cooldownMinutes, teto de orcamento de ads)
// e botao para disparar um scan manual do OperationsAgent.
// Consome GET/PUT /crm/guardrails, POST /crm/killswitch e POST /crm/scan.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CrmTabs } from '../crm-tabs';
import { api, ApiError, formatDateTime, type GuardrailConfig } from '@/lib/api';
import { useAuth, isUnauthorized } from '@/lib/auth';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-neutral-200">{label}</span>
      {hint ? <span className="mt-0.5 block text-xs text-neutral-500">{hint}</span> : null}
      <div className="mt-2">{children}</div>
    </label>
  );
}

const inputClass =
  'w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none';

export default function CrmSettingsPage() {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();

  const query = useQuery({
    queryKey: ['crm', 'guardrails'],
    queryFn: ({ signal }) => api.crmGuardrails(signal),
    retry: false,
  });

  // Form local — inicializado a partir do servidor.
  const [maxAuto, setMaxAuto] = useState('');
  const [cooldown, setCooldown] = useState('');
  const [maxBudgetReais, setMaxBudgetReais] = useState('');

  useEffect(() => {
    const g = query.data;
    if (!g) return;
    setMaxAuto(String(g.maxAutoActionsPerCycle));
    setCooldown(String(g.cooldownMinutes));
    setMaxBudgetReais(
      g.maxAdBudgetCents != null ? String(g.maxAdBudgetCents / 100) : '',
    );
  }, [query.data]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['crm', 'guardrails'] });
    void queryClient.invalidateQueries({ queryKey: ['crm', 'overview'] });
  };

  const killSwitchMutation = useMutation({
    mutationFn: (enabled: boolean) => api.crmSetKillSwitch(enabled),
    onSuccess: invalidate,
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      api.crmUpdateGuardrails({
        maxAutoActionsPerCycle: maxAuto === '' ? undefined : Number(maxAuto),
        cooldownMinutes: cooldown === '' ? undefined : Number(cooldown),
        // Reais -> centavos Int. Vazio limpa o override (null).
        maxAdBudgetCents:
          maxBudgetReais === '' ? null : Math.round(Number(maxBudgetReais) * 100),
      }),
    onSuccess: invalidate,
  });

  const scanMutation = useMutation({
    mutationFn: () => api.crmScan(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['crm'] });
    },
  });

  const g: GuardrailConfig | undefined = query.data;
  const missing = query.error instanceof ApiError && query.error.status === 404;

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Guardrails</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Limites de seguranca da operacao autonoma e controle de emergencia.
        </p>
      </header>

      <CrmTabs active="/crm/settings" />

      {query.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando configuracao…</p>
      ) : query.isError && !missing ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          Nao foi possivel carregar os guardrails. Verifique se a API esta no ar.
        </div>
      ) : (
        <div className="max-w-2xl space-y-6">
          {missing ? (
            <div className="rounded-xl border border-dashed border-neutral-800 p-4 text-sm text-neutral-400">
              Rota <code className="text-neutral-300">/crm/guardrails</code> ainda nao
              disponivel — os controles abaixo ficarao ativos quando a API responder.
            </div>
          ) : null}

          {/* Kill switch */}
          <div
            className={`rounded-xl border p-5 ${
              g?.killSwitch
                ? 'border-red-500/40 bg-red-500/5'
                : 'border-neutral-800 bg-neutral-900/50'
            }`}
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-white">Kill switch global</p>
                <p className="mt-1 text-xs text-neutral-500">
                  Quando ligado, NENHUMA acao e aplicada automaticamente. Aprovacoes
                  humanas tambem ficam bloqueadas ate desligar.
                </p>
              </div>
              <button
                onClick={() => killSwitchMutation.mutate(!(g?.killSwitch ?? false))}
                disabled={killSwitchMutation.isPending || !g || !isAuthenticated}
                title={!isAuthenticated ? 'Faca login para agir' : undefined}
                className={`shrink-0 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                  g?.killSwitch
                    ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                    : 'bg-red-600 text-white hover:bg-red-500'
                }`}
              >
                {killSwitchMutation.isPending
                  ? 'Aplicando…'
                  : !isAuthenticated
                    ? 'Faca login para agir'
                    : g?.killSwitch
                      ? 'Desligar kill switch'
                      : 'Ligar kill switch'}
              </button>
            </div>
            {g ? (
              <p className="mt-3 text-xs font-medium">
                Estado atual:{' '}
                <span className={g.killSwitch ? 'text-red-400' : 'text-emerald-400'}>
                  {g.killSwitch ? 'LIGADO (operacao pausada)' : 'desligado (operando)'}
                </span>
              </p>
            ) : null}
            {killSwitchMutation.isError ? (
              <p className="mt-2 text-xs text-red-400">
                {isUnauthorized(killSwitchMutation.error)
                  ? 'Sessao invalida ou expirada — faca login novamente.'
                  : 'Falha ao alterar o kill switch.'}
              </p>
            ) : null}
          </div>

          {/* Limites */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <p className="mb-4 text-sm font-semibold text-white">Limites de autonomia</p>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field
                label="Acoes automaticas por ciclo"
                hint="Maximo de acoes LOW risk aplicadas a cada tick do COO."
              >
                <input
                  type="number"
                  min={0}
                  value={maxAuto}
                  onChange={(e) => setMaxAuto(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Cooldown (minutos)"
                hint="Intervalo minimo entre acoes do mesmo tipo por setor."
              >
                <input
                  type="number"
                  min={0}
                  value={cooldown}
                  onChange={(e) => setCooldown(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Teto de orcamento de ads (R$/dia)"
                hint="Limite financeiro para acoes de orcamento. Vazio = usa MAX_AD_BUDGET_BRL."
              >
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={maxBudgetReais}
                  onChange={(e) => setMaxBudgetReais(e.target.value)}
                  className={inputClass}
                />
              </Field>
            </div>
            <div className="mt-5 flex items-center gap-3">
              <button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || !g || !isAuthenticated}
                title={!isAuthenticated ? 'Faca login para agir' : undefined}
                className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-fg transition-colors hover:bg-brand/80 disabled:opacity-50"
              >
                {saveMutation.isPending
                  ? 'Salvando…'
                  : !isAuthenticated
                    ? 'Faca login para salvar'
                    : 'Salvar limites'}
              </button>
              {saveMutation.isSuccess ? (
                <span className="text-xs text-emerald-400">Limites atualizados.</span>
              ) : null}
              {saveMutation.isError ? (
                <span className="text-xs text-red-400">
                  {isUnauthorized(saveMutation.error)
                    ? 'Faca login para salvar.'
                    : 'Falha ao salvar.'}
                </span>
              ) : null}
            </div>
            {g?.updatedAt ? (
              <p className="mt-3 text-xs text-neutral-500">
                Atualizado em {formatDateTime(g.updatedAt)}
              </p>
            ) : null}
          </div>

          {/* Scan manual */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-white">Scan manual</p>
                <p className="mt-1 text-xs text-neutral-500">
                  Forca o OperationsAgent a coletar saude, diagnosticar e propor
                  remediacoes agora, fora do tick automatico.
                </p>
              </div>
              <button
                onClick={() => scanMutation.mutate()}
                disabled={scanMutation.isPending || !isAuthenticated}
                title={!isAuthenticated ? 'Faca login para agir' : undefined}
                className="shrink-0 rounded-md border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800 disabled:opacity-50"
              >
                {scanMutation.isPending
                  ? 'Rodando scan…'
                  : !isAuthenticated
                    ? 'Faca login'
                    : 'Rodar scan'}
              </button>
            </div>
            {scanMutation.isSuccess ? (
              <p className="mt-3 text-xs text-emerald-400">
                Scan disparado
                {typeof scanMutation.data?.problems === 'number'
                  ? ` — ${scanMutation.data.problems} problema(s) detectado(s).`
                  : '.'}
              </p>
            ) : null}
            {scanMutation.isError ? (
              <p className="mt-3 text-xs text-red-400">
                {isUnauthorized(scanMutation.error)
                  ? 'Faca login para disparar o scan.'
                  : scanMutation.error instanceof ApiError &&
                      scanMutation.error.status === 404
                    ? 'Rota /crm/scan ainda nao implementada.'
                    : 'Falha ao disparar o scan.'}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
