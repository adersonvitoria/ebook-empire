// Rota /alerts — Alertas externos do Command Center (Feature 1).
//
// Dono: MODULO ROTAS /alerts (wiring de alertas). server.ts (Fundacao) ja
// registra este plugin. Convencao (ver crm.ts/health.ts): default export async
// (fastify) => {}; validacao Zod safeParse com 400 { error: 'bad_request', issues };
// pt-BR; escrita protegida por fastify.authenticate (Bearer JWT).
//
// Endpoints (ver docs/ALERTS.md secao 10):
//   GET  /alerts/health         disponibilidade do modulo (mantido da Fundacao)
//   GET  /alerts                lista AlertLog paginada (filtros event/channel/status)
//   GET  /alerts/settings       retorna AlertSettings (defaults fail-OPEN se ausente)
//   PUT  /alerts/settings       [JWT] patch parcial de AlertSettings
//   POST /alerts/settings       [JWT] alias de PUT (mesma semantica de patch)
//   POST /alerts/test           [JWT] dispara alerta de teste pelos canais habilitados
//
// AlertSettings e fail-OPEN (ver ALERTS.md secao 6): ausente => defaults com
// alertsEnabled=true, channels=[EMAIL], destinatarios das envs de boot
// (ALERT_EMAIL_TO / ALERT_WHATSAPP_TO), enabledEvents=[] (todos),
// throttleMinutes=ALERT_THROTTLE_MINUTES.

import type { FastifyInstance } from 'fastify';

import {
  listAlertsQuerySchema,
  updateAlertSettingsBodySchema,
  testAlertBodySchema,
  type AlertChannel,
  type AlertEvent,
  type AlertSettings,
  type AlertMessage,
  type AlertDeliveryResult,
} from '@ebook-empire/core';

import { prisma } from '../db.js';
import { env } from '../env.js';

// ------------------------------------------------------------
// Acesso DEFENSIVO ao scheduler (dono: modulo OperationsAgent/WIRING). O
// scheduler expoe getNotification(app) -> NotificationPort (fan-out de canais).
// Importamos tolerante para a rota compilar/rodar mesmo se o scheduler ainda nao
// expoe a funcao (fail-safe: POST /alerts/test devolve 503 amigavel).
// ------------------------------------------------------------
type NotificationLike = {
  send: (input: AlertMessage) => Promise<AlertDeliveryResult[]>;
};

type SchedulerModule = {
  getNotification?: (app: FastifyInstance) => Promise<NotificationLike | null>;
};

async function loadScheduler(): Promise<SchedulerModule> {
  try {
    return (await import('../scheduler.js')) as SchedulerModule;
  } catch {
    return {};
  }
}

// ------------------------------------------------------------
// Le AlertSettings (singleton) com fallback fail-OPEN das envs de boot.
// Prioridade: registro do DB > envs (ALERTS.md secao 6).
// ------------------------------------------------------------
function csvToList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function readAlertSettings(): Promise<AlertSettings> {
  const row = await prisma.alertSettings.findUnique({ where: { id: 'singleton' } });
  if (row) {
    return {
      alertsEnabled: row.alertsEnabled,
      channels: row.channels as AlertChannel[],
      emailRecipients: row.emailRecipients,
      whatsappRecipients: row.whatsappRecipients,
      enabledEvents: row.enabledEvents as AlertEvent[],
      throttleMinutes: row.throttleMinutes,
      updatedAt: row.updatedAt,
    };
  }
  // Fail-OPEN: defaults vindos das envs de boot.
  return {
    alertsEnabled: env.ALERTS_ENABLED,
    channels: ['EMAIL'],
    emailRecipients: csvToList(env.ALERT_EMAIL_TO),
    whatsappRecipients: csvToList(env.ALERT_WHATSAPP_TO),
    enabledEvents: [],
    throttleMinutes: env.ALERT_THROTTLE_MINUTES,
  };
}

export default async function alertsRoutes(fastify: FastifyInstance): Promise<void> {
  // ==========================================================
  // GET /alerts/health — disponibilidade do modulo (Fundacao; mantido).
  // ==========================================================
  fastify.get('/alerts/health', async (_request, reply) => {
    return reply.code(200).send({ status: 'ok', module: 'alerts' });
  });

  // ==========================================================
  // GET /alerts — lista AlertLog paginada (filtros event/channel/status).
  // ==========================================================
  fastify.get('/alerts', async (request, reply) => {
    const parsed = listAlertsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { event, channel, status, limit, offset } = parsed.data;

    const where = {
      ...(event ? { event } : {}),
      ...(channel ? { channel } : {}),
      ...(status ? { status } : {}),
    };

    const [logs, total] = await Promise.all([
      prisma.alertLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          event: true,
          severity: true,
          channel: true,
          sector: true,
          title: true,
          body: true,
          status: true,
          dedupeKey: true,
          providerId: true,
          error: true,
          sentAt: true,
          createdAt: true,
        },
      }),
      prisma.alertLog.count({ where }),
    ]);

    return reply.send({ total, limit, offset, data: logs });
  });

  // ==========================================================
  // GET /alerts/settings — retorna AlertSettings (defaults fail-OPEN se ausente).
  // ==========================================================
  fastify.get('/alerts/settings', async (_request, reply) => {
    const settings = await readAlertSettings();
    return reply.send(settings);
  });

  // ==========================================================
  // PUT/POST /alerts/settings — [JWT] patch parcial de AlertSettings (upsert).
  // ==========================================================
  const updateSettingsHandler = async (
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) => {
    const body = updateAlertSettingsBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
    }
    const patch = body.data;

    // So aplica os campos enviados (patch parcial). Na criacao do singleton, os
    // ausentes herdam os defaults do schema Prisma.
    const data = {
      ...(patch.alertsEnabled !== undefined ? { alertsEnabled: patch.alertsEnabled } : {}),
      ...(patch.channels !== undefined ? { channels: { set: patch.channels } } : {}),
      ...(patch.emailRecipients !== undefined ? { emailRecipients: { set: patch.emailRecipients } } : {}),
      ...(patch.whatsappRecipients !== undefined ? { whatsappRecipients: { set: patch.whatsappRecipients } } : {}),
      ...(patch.enabledEvents !== undefined ? { enabledEvents: { set: patch.enabledEvents } } : {}),
      ...(patch.throttleMinutes !== undefined ? { throttleMinutes: patch.throttleMinutes } : {}),
    };

    const updated = await prisma.alertSettings.upsert({
      where: { id: 'singleton' },
      update: data,
      create: { id: 'singleton', ...data },
    });

    return reply.send({
      updated: true,
      settings: {
        alertsEnabled: updated.alertsEnabled,
        channels: updated.channels,
        emailRecipients: updated.emailRecipients,
        whatsappRecipients: updated.whatsappRecipients,
        enabledEvents: updated.enabledEvents,
        throttleMinutes: updated.throttleMinutes,
        updatedAt: updated.updatedAt,
      },
    });
  };

  fastify.put('/alerts/settings', { preHandler: fastify.authenticate }, updateSettingsHandler);
  fastify.post('/alerts/settings', { preHandler: fastify.authenticate }, updateSettingsHandler);

  // ==========================================================
  // POST /alerts/test — [JWT] dispara alerta de teste pelos canais habilitados.
  // Bypassa dedupe/throttle do AlertService chamando a NotificationPort direto
  // (precisamos do resultado POR CANAL). Persiste 1 AlertLog por canal disparado.
  //
  // ATENCAO: com USE_STUBS=false dispara canais REAIS (email/WhatsApp). A UI deve
  // deixar claro que um envio real ocorrera.
  // ==========================================================
  fastify.post('/alerts/test', { preHandler: fastify.authenticate }, async (request, reply) => {
    const body = testAlertBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
    }
    const sector = body.data.sector ?? null;

    const settings = await readAlertSettings();
    if (!settings.alertsEnabled) {
      return reply.code(409).send({
        error: 'alerts_disabled',
        message: 'Alertas estao desligados em AlertSettings (alertsEnabled=false).',
      });
    }
    if (settings.channels.length === 0) {
      return reply.code(409).send({
        error: 'no_channels',
        message: 'Nenhum canal de alerta habilitado em AlertSettings.',
      });
    }

    const scheduler = await loadScheduler();
    const notification =
      typeof scheduler.getNotification === 'function' ? await scheduler.getNotification(fastify) : null;
    if (!notification) {
      return reply.code(503).send({
        error: 'notification_unavailable',
        message: 'Canais de notificacao ainda indisponiveis (AlertService nao composto).',
      });
    }

    const title = 'Alerta de teste — Ebook Empire Command Center';
    const body_ = sector
      ? `Este e um alerta de teste do setor ${sector}. Se voce recebeu esta mensagem, o canal esta funcionando.`
      : 'Este e um alerta de teste do Command Center. Se voce recebeu esta mensagem, o canal esta funcionando.';

    const message: AlertMessage = {
      event: 'SECTOR_CRITICAL', // evento sentinela apenas para o teste de canais
      severity: 'INFO',
      sector,
      title,
      body: body_,
      dedupeKey: `TEST:${Date.now()}`, // unico => nunca suprimido
      channels: settings.channels,
      emailRecipients: settings.emailRecipients,
      whatsappRecipients: settings.whatsappRecipients,
    };

    let results: AlertDeliveryResult[] = [];
    try {
      results = await notification.send(message);
    } catch (err) {
      fastify.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'alerts/test: falha inesperada no fan-out de canais',
      );
      return reply.code(500).send({
        error: 'test_failed',
        message: 'Falha inesperada ao disparar o alerta de teste.',
      });
    }

    // Persiste 1 AlertLog por canal retornado (auditoria do teste). Best-effort.
    try {
      const now = new Date();
      await prisma.alertLog.createMany({
        data: results.map((r) => ({
          event: message.event,
          severity: message.severity,
          channel: r.channel,
          sector,
          title,
          body: body_,
          status: r.status,
          dedupeKey: message.dedupeKey,
          providerId: r.providerId ?? null,
          error: r.error ?? null,
          sentAt: r.status === 'SENT' ? now : null,
        })),
      });
    } catch (err) {
      fastify.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'alerts/test: falha ao persistir AlertLog do teste (ignorada)',
      );
    }

    const anySent = results.some((r) => r.status === 'SENT');
    return reply.code(anySent ? 200 : 502).send({
      tested: true,
      sector,
      channels: settings.channels,
      results,
    });
  });
}
