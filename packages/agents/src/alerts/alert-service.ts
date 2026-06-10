// AlertService — orquestra a notificacao externa de eventos do Command Center.
// Implementa o AlertNotifier exposto no AgentContext (base.ts): notify() NUNCA
// rejeita — engole erros de canal E de persistencia (best-effort), para nao
// derrubar o ciclo do COO.
//
// Responsabilidades:
//  1) Carregar AlertSettings (singleton, FAIL-OPEN: ausente => alertas ligados,
//     canal EMAIL por default — espelha o @default do schema).
//  2) Resolver severidade (default por evento) e montar title/body em pt-BR.
//  3) DEDUPE/THROTTLE por dedupeKey (`${event}:${sector ?? 'GLOBAL'}`) dentro da
//     janela throttleMinutes: se ja houve linha SENT recente, grava 1 linha
//     SUPPRESSED e NAO dispara canal.
//  4) Fan-out pelos canais habilitados (NotificationPort, best-effort) e PERSISTE
//     1 AlertLog por canal disparado (status SENT/FAILED).
//
// Ver docs/ALERTS.md secoes 2, 4, 5, 6. Tipos/enums em @ebook-empire/core.

import type { PrismaClient } from '@prisma/client';
import {
  buildAlertDedupeKey,
  DEFAULT_SEVERITY_BY_EVENT,
  type AlertChannel,
  type AlertEvent,
  type AlertDeliveryResult,
  type AlertMessage,
  type AlertSettings,
  type AlertSeverity,
  type NotificationPort,
  type Sector,
} from '@ebook-empire/core';

import type { AgentLogger, AlertNotifier, AlertNotifyInput, Clock } from '../base.js';
import { systemClock } from '../base.js';

// ------------------------------------------------------------
// AlertSettings default (FAIL-OPEN). Espelha os @default do schema Prisma:
// alertsEnabled=true, channels=[EMAIL], enabledEvents=[] (todos), throttle=60.
// ------------------------------------------------------------
export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  alertsEnabled: true,
  channels: ['EMAIL'],
  emailRecipients: [],
  whatsappRecipients: [],
  enabledEvents: [],
  throttleMinutes: 60,
};

// ------------------------------------------------------------
// Dependencias injetadas (DI -> stubs em testes).
// ------------------------------------------------------------
export interface AlertServiceDeps {
  prisma: PrismaClient;
  notifier: NotificationPort;
  log: AgentLogger;
  /** Relogio injetavel (deterministico em testes). Default: systemClock. */
  clock?: Clock;
}

// ============================================================
// AlertService
// ============================================================
export class AlertService implements AlertNotifier {
  private readonly prisma: PrismaClient;
  private readonly notifier: NotificationPort;
  private readonly log: AgentLogger;
  private readonly clock: Clock;

  constructor(deps: AlertServiceDeps) {
    this.prisma = deps.prisma;
    this.notifier = deps.notifier;
    this.log = deps.log;
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Notifica um evento externo. Best-effort: jamais lanca. Resolve para void
   * mesmo se as settings, o dedupe, os canais ou a persistencia falharem.
   */
  async notify(input: AlertNotifyInput): Promise<void> {
    try {
      await this.notifyInner(input);
    } catch (err) {
      // Ultima rede de seguranca — nada do alerta pode derrubar o chamador.
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ event: input.event, err: message }, 'AlertService.notify falhou (engolido)');
    }
  }

  // ----------------------------------------------------------
  // Fluxo principal (pode lancar; notify() captura).
  // ----------------------------------------------------------
  private async notifyInner(input: AlertNotifyInput): Promise<void> {
    const settings = await this.loadSettings();

    // 1) Alertas desligados globalmente => nao faz nada.
    if (!settings.alertsEnabled) {
      this.log.debug({ event: input.event }, 'alertas desligados — ignorando');
      return;
    }

    // 2) Evento desabilitado (enabledEvents nao-vazio e nao contem o evento).
    if (settings.enabledEvents.length > 0 && !settings.enabledEvents.includes(input.event)) {
      this.log.debug({ event: input.event }, 'evento desabilitado — ignorando');
      return;
    }

    // input.sector e CrmSector (10). O subsistema de alertas tipa sector como
    // Sector (7) na sua trilha/dedupe; os 3 setores de producao chegam aqui so
    // como rotulo/dedupe string (a coluna AlertLog.sector e o enum
    // OperationalSector de 10 — valido em runtime). Coercao localizada para nao
    // espalhar CrmSector por core/alerts (schema/AlertMessage) nesta rodada.
    const sector = (input.sector ?? null) as Sector | null;
    const severity: AlertSeverity = input.severity ?? DEFAULT_SEVERITY_BY_EVENT[input.event];
    const dedupeKey = buildAlertDedupeKey(input.event, sector);
    const { title, body } = renderMessage(input.event, severity, sector, input.context ?? {});

    // 3) Sem canais habilitados => nada a enviar (registra como SUPPRESSED p/ trilha).
    const channels = settings.channels;
    if (channels.length === 0) {
      this.log.debug({ event: input.event }, 'nenhum canal habilitado — ignorando');
      return;
    }

    // 4) DEDUPE/THROTTLE: se houve linha SENT recente do mesmo dedupeKey, suprime.
    if (settings.throttleMinutes > 0 && (await this.isThrottled(dedupeKey, settings.throttleMinutes))) {
      await this.persistSuppressed({ event: input.event, severity, sector, title, body, dedupeKey });
      this.log.debug({ dedupeKey }, 'alerta suprimido por throttle');
      return;
    }

    // 5) Monta a mensagem e faz fan-out best-effort.
    const message: AlertMessage = {
      event: input.event,
      severity,
      sector,
      title,
      body,
      dedupeKey,
      channels,
      emailRecipients: settings.emailRecipients,
      whatsappRecipients: settings.whatsappRecipients,
    };

    let results: AlertDeliveryResult[];
    try {
      results = await this.notifier.send(message);
    } catch (err) {
      // NotificationPort nunca deveria lancar (Composite e best-effort), mas
      // se lancar, registramos FAILED para cada canal pedido e seguimos.
      const error = err instanceof Error ? err.message : String(err);
      results = channels.map((channel) => ({ channel, status: 'FAILED', error }));
    }

    // 6) Persiste 1 AlertLog por canal (SENT/FAILED). Best-effort por linha.
    const sentAt = this.clock.now();
    for (const r of results) {
      await this.persistDelivery({
        event: input.event,
        severity,
        sector,
        title,
        body,
        dedupeKey,
        channel: r.channel,
        status: r.status,
        providerId: r.providerId ?? null,
        error: r.error ?? null,
        sentAt: r.status === 'SENT' ? sentAt : null,
      });
    }
  }

  // ----------------------------------------------------------
  // AlertSettings (singleton, fail-open).
  // ----------------------------------------------------------
  private async loadSettings(): Promise<AlertSettings> {
    try {
      const row = await this.prisma.alertSettings.findUnique({ where: { id: 'singleton' } });
      if (!row) return DEFAULT_ALERT_SETTINGS;
      return {
        alertsEnabled: row.alertsEnabled,
        channels: row.channels as AlertChannel[],
        emailRecipients: row.emailRecipients,
        whatsappRecipients: row.whatsappRecipients,
        enabledEvents: row.enabledEvents as AlertEvent[],
        throttleMinutes: row.throttleMinutes,
        updatedAt: row.updatedAt,
      };
    } catch (err) {
      // Fail-OPEN: se a leitura falhar, usa defaults (alertas ligados).
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: message }, 'falha ao ler AlertSettings — usando defaults (fail-open)');
      return DEFAULT_ALERT_SETTINGS;
    }
  }

  // ----------------------------------------------------------
  // Throttle: existe linha SENT do mesmo dedupeKey na janela?
  // ----------------------------------------------------------
  private async isThrottled(dedupeKey: string, throttleMinutes: number): Promise<boolean> {
    const since = new Date(this.clock.now().getTime() - throttleMinutes * 60_000);
    const recent = await this.prisma.alertLog.findFirst({
      where: { dedupeKey, status: 'SENT', createdAt: { gte: since } },
      select: { id: true },
    });
    return recent !== null;
  }

  // ----------------------------------------------------------
  // Persistencia de AlertLog.
  // ----------------------------------------------------------
  private async persistSuppressed(data: {
    event: AlertEvent;
    severity: AlertSeverity;
    sector: Sector | null;
    title: string;
    body: string;
    dedupeKey: string;
  }): Promise<void> {
    // Canal sentinela: usa o primeiro canal conceitual (EMAIL) so para satisfazer
    // o NOT NULL do schema; a linha SUPPRESSED nao representa entrega real.
    await this.safeCreateLog({
      event: data.event,
      severity: data.severity,
      sector: data.sector,
      channel: 'EMAIL',
      title: data.title,
      body: data.body,
      status: 'SUPPRESSED',
      dedupeKey: data.dedupeKey,
      providerId: null,
      error: null,
      sentAt: null,
    });
  }

  private async persistDelivery(data: {
    event: AlertEvent;
    severity: AlertSeverity;
    sector: Sector | null;
    title: string;
    body: string;
    dedupeKey: string;
    channel: AlertChannel;
    status: 'SENT' | 'FAILED';
    providerId: string | null;
    error: string | null;
    sentAt: Date | null;
  }): Promise<void> {
    await this.safeCreateLog(data);
  }

  /** Cria 1 AlertLog; engole erro de persistencia (best-effort). */
  private async safeCreateLog(data: {
    event: AlertEvent;
    severity: AlertSeverity;
    sector: Sector | null;
    channel: AlertChannel;
    title: string;
    body: string;
    status: 'SENT' | 'FAILED' | 'SUPPRESSED';
    dedupeKey: string;
    providerId: string | null;
    error: string | null;
    sentAt: Date | null;
  }): Promise<void> {
    try {
      await this.prisma.alertLog.create({
        data: {
          event: data.event,
          severity: data.severity,
          sector: data.sector,
          channel: data.channel,
          title: data.title,
          body: data.body,
          status: data.status,
          dedupeKey: data.dedupeKey,
          providerId: data.providerId,
          error: data.error,
          sentAt: data.sentAt,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ dedupeKey: data.dedupeKey, err: message }, 'falha ao persistir AlertLog (engolido)');
    }
  }
}

// ============================================================
// Render da mensagem pt-BR (puro — base dos testes, sem DB).
// ============================================================

/** Rotulo amigavel pt-BR de cada setor. */
const SECTOR_LABELS: Record<Sector, string> = {
  CONTENT: 'Conteudo',
  SALES: 'Vendas',
  DELIVERY: 'Entrega',
  SOCIAL: 'Social',
  TRAFFIC: 'Trafego',
  ANALYTICS: 'Analytics',
  ORCHESTRATION: 'Orquestracao',
};

function sectorLabel(sector: Sector | null): string {
  return sector ? (SECTOR_LABELS[sector] ?? sector) : 'global';
}

/** Prefixo de severidade para o titulo. */
const SEVERITY_PREFIX: Record<AlertSeverity, string> = {
  INFO: 'Info',
  WARNING: 'Atencao',
  CRITICAL: 'Critico',
};

/**
 * Monta title/body pt-BR a partir do evento + contexto. Determinista e puro.
 * O contexto e um saco de chaves opcionais; cada evento usa o que precisa.
 */
export function renderMessage(
  event: AlertEvent,
  severity: AlertSeverity,
  sector: Sector | null,
  context: Record<string, unknown>,
): { title: string; body: string } {
  const prefix = SEVERITY_PREFIX[severity];
  const lines: string[] = [];

  let headline: string;
  switch (event) {
    case 'KILL_SWITCH_ON': {
      headline = 'Kill switch ACIONADO';
      lines.push('O kill switch foi LIGADO. Todas as acoes autonomas do Command Center estao bloqueadas.');
      break;
    }
    case 'KILL_SWITCH_OFF': {
      headline = 'Kill switch desligado';
      lines.push('O kill switch foi DESLIGADO. As acoes autonomas voltaram a ser permitidas.');
      break;
    }
    case 'SECTOR_CRITICAL': {
      headline = `Setor ${sectorLabel(sector)} em estado CRITICO`;
      lines.push(`O setor ${sectorLabel(sector)} entrou em estado CRITICO.`);
      if (typeof context.score === 'number') lines.push(`Score de saude: ${context.score}/100.`);
      if (typeof context.problemType === 'string') lines.push(`Problema detectado: ${context.problemType}.`);
      if (typeof context.rootCause === 'string') lines.push(`Causa provavel: ${context.rootCause}`);
      break;
    }
    case 'ACTION_AUTO_FAILED': {
      headline = 'Acao automatica FALHOU';
      lines.push('Uma acao automatica (LOW) do Command Center falhou ao ser aplicada.');
      if (typeof context.kind === 'string') lines.push(`Tipo de acao: ${context.kind}.`);
      if (sector) lines.push(`Setor: ${sectorLabel(sector)}.`);
      if (typeof context.error === 'string') lines.push(`Erro: ${context.error}`);
      break;
    }
    case 'ACTION_HIGH_QUEUED': {
      headline = 'Acao de alto risco aguardando aprovacao';
      lines.push('Uma acao de alto risco (HIGH) foi enfileirada e aguarda aprovacao humana.');
      if (typeof context.kind === 'string') lines.push(`Tipo de acao: ${context.kind}.`);
      if (sector) lines.push(`Setor: ${sectorLabel(sector)}.`);
      if (typeof context.expectedEffect === 'string') lines.push(`Efeito esperado: ${context.expectedEffect}`);
      break;
    }
    default: {
      // Exaustividade defensiva (nunca atingido com AlertEvent valido).
      headline = 'Alerta do Command Center';
      lines.push(`Evento: ${String(event)}.`);
    }
  }

  const title = `[${prefix}] Ebook Empire — ${headline}`;
  const body = lines.join('\n');
  return { title, body };
}
