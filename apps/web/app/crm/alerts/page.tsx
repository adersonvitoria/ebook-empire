'use client';

// CRM — Alertas externos (Feature 1). Log de alertas (SENT/SUPPRESSED/FAILED) +
// form de AlertSettings (canais, destinatarios, eventos, throttle) + botao de
// teste. Consome GET /alerts, GET/PUT /alerts/settings, POST /alerts/test.
// Trata 404 (rota aquecendo) e API fora do ar graciosamente.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CrmTabs } from '../crm-tabs';
import {
  api,
  ApiError,
  formatDateTime,
  type AlertChannel,
  type AlertEvent,
  type AlertLog,
  type AlertSettings,
  type AlertStatus,
} from '@/lib/api';
import { useAuth, isUnauthorized } from '@/lib/auth';

const ALL_CHANNELS: AlertChannel[] = ['EMAIL', 'WHATSAPP'];

const ALL_EVENTS: { value: AlertEvent; label: string }[] = [
  { value: 'KILL_SWITCH_ON', label: 'Kill switch LIGADO' },
  { value: 'KILL_SWITCH_OFF', label: 'Kill switch DESLIGADO' },
  { value: 'SECTOR_CRITICAL', label: 'Setor em estado critico' },
  { value: 'ACTION_AUTO_FAILED', label: 'Acao automatica falhou' },
  { value: 'ACTION_HIGH_QUEUED', label: 'Acao HIGH enfileirada' },
];

const EVENT_LABELS: Record<AlertEvent, string> = {
  KILL_SWITCH_ON: 'Kill switch LIGADO',
  KILL_SWITCH_OFF: 'Kill switch DESLIGADO',
  SECTOR_CRITICAL: 'Setor critico',
  ACTION_AUTO_FAILED: 'Acao AUTO falhou',
  ACTION_HIGH_QUEUED: 'Acao HIGH enfileirada',
};

const STATUS_BADGE: Record<AlertStatus, string> = {
  SENT: 'bg-emerald-500/20 text-emerald-300',
  FAILED: 'bg-red-500/20 text-red-300',
  SUPPRESSED: 'bg-neutral-700/40 text-neutral-300',
};

const STATUS_LABEL: Record<AlertStatus, string> = {
  SENT: 'Enviado',
  FAILED: 'Falhou',
  SUPPRESSED: 'Suprimido',
};

const inputClass =
  'w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none';

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

export default function CrmAlertsPage() {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();

  const settingsQuery = useQuery({
    queryKey: ['alerts', 'settings'],
    queryFn: ({ signal }) => api.getAlertSettings(signal),
    retry: false,
  });

  const logsQuery = useQuery({
    queryKey: ['alerts', 'log'],
    queryFn: ({ signal }) => api.listAlerts({ limit: 50 }, signal),
    retry: false,
    refetchInterval: 30_000,
  });

  // Form local — inicializado a partir do servidor.
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [emailRecipients, setEmailRecipients] = useState('');
  const [whatsappRecipients, setWhatsappRecipients] = useState('');
  const [enabledEvents, setEnabledEvents] = useState<AlertEvent[]>([]);
  const [throttle, setThrottle] = useState('');

  useEffect(() => {
    const s = settingsQuery.data;
    if (!s) return;
    setAlertsEnabled(s.alertsEnabled);
    setChannels(s.channels);
    setEmailRecipients(s.emailRecipients.join(', '));
    setWhatsappRecipients(s.whatsappRecipients.join(', '));
    setEnabledEvents(s.enabledEvents);
    setThrottle(String(s.throttleMinutes));
  }, [settingsQuery.data]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['alerts'] });
  };

  const toCsvList = (raw: string): string[] =>
    raw
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateAlertSettings({
        alertsEnabled,
        channels,
        emailRecipients: toCsvList(emailRecipients),
        whatsappRecipients: toCsvList(whatsappRecipients),
        enabledEvents,
        throttleMinutes: throttle === '' ? undefined : Number(throttle),
      }),
    onSuccess: invalidate,
  });

  const testMutation = useMutation({
    mutationFn: () => api.testAlert(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['alerts', 'log'] });
    },
  });

  const toggleChannel = (c: AlertChannel) => {
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };
  const toggleEvent = (e: AlertEvent) => {
    setEnabledEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));
  };

  const s: AlertSettings | undefined = settingsQuery.data;
  const settingsMissing = settingsQuery.error instanceof ApiError && settingsQuery.error.status === 404;
  const logs: AlertLog[] = logsQuery.data?.data ?? [];
  const logsMissing = logsQuery.error instanceof ApiError && logsQuery.error.status === 404;

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Alertas externos</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Notificacoes por email e WhatsApp quando eventos operacionais criticos
          acontecem (kill switch, setor critico, acao AUTO com falha, acao HIGH na fila).
        </p>
      </header>

      <CrmTabs active="/crm/alerts" />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* ---- Configuracao ---- */}
        <section className="space-y-6">
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <p className="mb-4 text-sm font-semibold text-white">Configuracao de alertas</p>

            {settingsMissing ? (
              <div className="mb-4 rounded-lg border border-dashed border-neutral-800 p-3 text-xs text-neutral-400">
                Rota <code className="text-neutral-300">/alerts/settings</code> ainda nao
                disponivel — os controles ficarao ativos quando a API responder.
              </div>
            ) : null}

            <div className="space-y-5">
              {/* Liga/desliga global */}
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-neutral-200">Alertas habilitados</p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    Desligado = nenhum alerta externo e disparado.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAlertsEnabled((v) => !v)}
                  className={`shrink-0 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                    alertsEnabled
                      ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                      : 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'
                  }`}
                >
                  {alertsEnabled ? 'Ligado' : 'Desligado'}
                </button>
              </div>

              {/* Canais */}
              <Field label="Canais" hint="Para onde os alertas sao enviados.">
                <div className="flex flex-wrap gap-2">
                  {ALL_CHANNELS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggleChannel(c)}
                      className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                        channels.includes(c)
                          ? 'border-brand bg-brand/10 text-white'
                          : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      {c === 'EMAIL' ? 'Email' : 'WhatsApp'}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="Destinatarios de email" hint="Separe varios por virgula.">
                <input
                  value={emailRecipients}
                  onChange={(e) => setEmailRecipients(e.target.value)}
                  placeholder="ana@empresa.com, suporte@empresa.com"
                  className={inputClass}
                />
              </Field>

              <Field
                label="Destinatarios de WhatsApp"
                hint="Numeros em formato internacional (ex.: 5511999998888), separados por virgula."
              >
                <input
                  value={whatsappRecipients}
                  onChange={(e) => setWhatsappRecipients(e.target.value)}
                  placeholder="5511999998888"
                  className={inputClass}
                />
              </Field>

              {/* Eventos */}
              <Field
                label="Eventos habilitados"
                hint="Nenhum selecionado = todos os eventos disparam alerta."
              >
                <div className="flex flex-col gap-2">
                  {ALL_EVENTS.map((ev) => (
                    <label key={ev.value} className="flex items-center gap-2 text-sm text-neutral-300">
                      <input
                        type="checkbox"
                        checked={enabledEvents.includes(ev.value)}
                        onChange={() => toggleEvent(ev.value)}
                        className="h-4 w-4 rounded border-neutral-700 bg-neutral-900"
                      />
                      {ev.label}
                    </label>
                  ))}
                </div>
              </Field>

              <Field
                label="Throttle (minutos)"
                hint="Janela minima entre alertas iguais (mesmo evento+setor)."
              >
                <input
                  type="number"
                  min={0}
                  value={throttle}
                  onChange={(e) => setThrottle(e.target.value)}
                  className={inputClass}
                />
              </Field>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || !s || !isAuthenticated}
                  title={!isAuthenticated ? 'Faca login para agir' : undefined}
                  className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-fg transition-colors hover:bg-brand/80 disabled:opacity-50"
                >
                  {saveMutation.isPending
                    ? 'Salvando…'
                    : !isAuthenticated
                      ? 'Faca login para salvar'
                      : 'Salvar configuracao'}
                </button>
                {saveMutation.isSuccess ? (
                  <span className="text-xs text-emerald-400">Configuracao salva.</span>
                ) : null}
                {saveMutation.isError ? (
                  <span className="text-xs text-red-400">
                    {isUnauthorized(saveMutation.error)
                      ? 'Faca login para salvar.'
                      : 'Falha ao salvar.'}
                  </span>
                ) : null}
              </div>
              {s?.updatedAt ? (
                <p className="text-xs text-neutral-500">Atualizado em {formatDateTime(s.updatedAt)}</p>
              ) : null}
            </div>
          </div>

          {/* Enviar teste */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-white">Enviar alerta de teste</p>
                <p className="mt-1 text-xs text-neutral-500">
                  Dispara uma mensagem de teste pelos canais habilitados. Com canais
                  reais configurados, um envio real ocorrera.
                </p>
              </div>
              <button
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending || !isAuthenticated}
                title={!isAuthenticated ? 'Faca login para agir' : undefined}
                className="shrink-0 rounded-md border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800 disabled:opacity-50"
              >
                {testMutation.isPending
                  ? 'Enviando…'
                  : !isAuthenticated
                    ? 'Faca login'
                    : 'Enviar teste'}
              </button>
            </div>
            {testMutation.isSuccess ? (
              <div className="mt-3 space-y-1 text-xs">
                {testMutation.data.results.map((r) => (
                  <p key={r.channel} className={r.status === 'SENT' ? 'text-emerald-400' : 'text-red-400'}>
                    {r.channel}: {r.status === 'SENT' ? 'enviado' : `falhou${r.error ? ` — ${r.error}` : ''}`}
                  </p>
                ))}
              </div>
            ) : null}
            {testMutation.isError ? (
              <p className="mt-3 text-xs text-red-400">
                {isUnauthorized(testMutation.error)
                  ? 'Faca login para enviar o alerta de teste.'
                  : testMutation.error instanceof ApiError && testMutation.error.status === 503
                    ? 'Canais de notificacao ainda indisponiveis.'
                    : testMutation.error instanceof ApiError && testMutation.error.status === 404
                      ? 'Rota /alerts/test ainda nao implementada.'
                      : 'Falha ao enviar o alerta de teste.'}
              </p>
            ) : null}
          </div>
        </section>

        {/* ---- Log de alertas ---- */}
        <section>
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm font-semibold text-white">Historico de alertas</p>
              <span className="text-xs text-neutral-500">{logs.length} registro(s)</span>
            </div>

            {logsQuery.isLoading ? (
              <p className="text-sm text-neutral-500">Carregando alertas…</p>
            ) : logsQuery.isError && !logsMissing ? (
              <p className="text-sm text-neutral-400">
                Nao foi possivel carregar o historico. Verifique se a API esta no ar.
              </p>
            ) : logsMissing ? (
              <p className="text-sm text-neutral-400">
                Rota <code className="text-neutral-300">/alerts</code> ainda nao disponivel.
              </p>
            ) : logs.length === 0 ? (
              <p className="text-sm text-neutral-500">Nenhum alerta registrado ainda.</p>
            ) : (
              <ul className="divide-y divide-neutral-800">
                {logs.map((log) => (
                  <li key={log.id} className="py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-neutral-100">{log.title}</p>
                        <p className="mt-0.5 text-xs text-neutral-500">
                          {EVENT_LABELS[log.event] ?? log.event}
                          {log.sector ? ` · ${log.sector}` : ''} · {log.channel} ·{' '}
                          {formatDateTime(log.createdAt)}
                        </p>
                        {log.error ? (
                          <p className="mt-1 line-clamp-2 text-xs text-red-400">{log.error}</p>
                        ) : null}
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[log.status]}`}
                      >
                        {STATUS_LABEL[log.status]}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
