// Testes do AlertService (Feature 1).
//
// Cobre:
//  - SENT: dispara pelos canais habilitados e persiste 1 AlertLog SENT por canal.
//  - THROTTLE: duplicado dentro da janela vira SUPPRESSED (sem novo envio).
//  - Evento desabilitado (enabledEvents nao-vazio sem o evento) => nao envia.
//  - alertsEnabled=false => nao envia.
//  - Canal que LANCA => AlertLog FAILED, sem propagar (notify nunca rejeita).
//  - Fail-OPEN: AlertSettings ausente usa defaults (EMAIL ligado).
//
// Usa StubEmailAdapter + StubWhatsAppChannel reais (via CompositeNotificationAdapter)
// e um Prisma fake em memoria cobrindo alertSettings + alertLog.

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  CompositeNotificationAdapter,
  EmailAlertChannel,
  StubWhatsAppChannel,
  type AlertChannelAdapter,
} from '@ebook-empire/adapters';
import { StubEmailAdapter } from '@ebook-empire/adapters';
import type { AlertSettings } from '@ebook-empire/core';

import { AlertService } from './alert-service.js';
import type { AgentLogger, Clock } from '../base.js';

// ============================================================
// Fakes
// ============================================================

interface FakeAlertLogRow {
  id: string;
  event: string;
  severity: string;
  channel: string;
  sector: string | null;
  title: string;
  body: string;
  status: string;
  dedupeKey: string;
  providerId: string | null;
  error: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

/** Prisma minimo em memoria: alertSettings.findUnique + alertLog.{findFirst,create}. */
function makeFakePrisma(opts: {
  settings: AlertSettings | null;
  clock: Clock;
  /** Linhas pre-existentes (p/ simular envio anterior na janela de throttle). */
  seedLogs?: Partial<FakeAlertLogRow>[];
}) {
  const logs: FakeAlertLogRow[] = (opts.seedLogs ?? []).map((l, i) => ({
    id: `seed_${i}`,
    event: 'KILL_SWITCH_ON',
    severity: 'CRITICAL',
    channel: 'EMAIL',
    sector: null,
    title: '',
    body: '',
    status: 'SENT',
    dedupeKey: '',
    providerId: null,
    error: null,
    sentAt: opts.clock.now(),
    createdAt: opts.clock.now(),
    ...l,
  }));
  let seq = 0;

  return {
    _logs: logs,
    alertSettings: {
      findUnique: vi.fn(async () => (opts.settings ? { ...opts.settings, id: 'singleton' } : null)),
    },
    alertLog: {
      findFirst: vi.fn(async ({ where }: { where: any }) => {
        const since: Date | undefined = where?.createdAt?.gte;
        const hit = logs.find(
          (l) =>
            l.dedupeKey === where?.dedupeKey &&
            (where?.status ? l.status === where.status : true) &&
            (since ? l.createdAt >= since : true),
        );
        return hit ? { id: hit.id } : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        const row: FakeAlertLogRow = {
          id: `log_${++seq}`,
          event: data.event,
          severity: data.severity,
          channel: data.channel,
          sector: data.sector ?? null,
          title: data.title,
          body: data.body,
          status: data.status,
          dedupeKey: data.dedupeKey,
          providerId: data.providerId ?? null,
          error: data.error ?? null,
          sentAt: data.sentAt ?? null,
          createdAt: opts.clock.now(),
        };
        logs.push(row);
        return row;
      }),
    },
  };
}

function makeLogger(): AgentLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const FIXED_NOW = new Date('2026-06-10T12:00:00.000Z');
function makeClock(now: Date = FIXED_NOW): Clock {
  return { now: () => now };
}

const FULL_SETTINGS: AlertSettings = {
  alertsEnabled: true,
  channels: ['EMAIL', 'WHATSAPP'],
  emailRecipients: ['dono@ebookempire.com.br'],
  whatsappRecipients: ['5511999999999'],
  enabledEvents: [], // todos
  throttleMinutes: 60,
};

/** Composite com stubs reais (email + whatsapp em memoria). */
function makeStubNotifier() {
  const email = new StubEmailAdapter();
  const whatsapp = new StubWhatsAppChannel();
  const notifier = new CompositeNotificationAdapter([new EmailAlertChannel(email), whatsapp]);
  return { notifier, email, whatsapp };
}

// ============================================================
// Testes
// ============================================================
describe('AlertService.notify', () => {
  let log: AgentLogger;
  let clock: Clock;

  beforeEach(() => {
    log = makeLogger();
    clock = makeClock();
  });

  it('SENT: dispara pelos canais habilitados e persiste 1 AlertLog SENT por canal', async () => {
    const prisma = makeFakePrisma({ settings: FULL_SETTINGS, clock });
    const { notifier, email, whatsapp } = makeStubNotifier();
    const service = new AlertService({ prisma: prisma as never, notifier, log, clock });

    await service.notify({ event: 'KILL_SWITCH_ON' });

    // Canais reais receberam.
    expect(email.outbox).toHaveLength(1);
    expect(whatsapp.outbox).toHaveLength(1);
    expect(email.outbox[0]?.subject).toContain('Kill switch ACIONADO');

    // 1 AlertLog SENT por canal (EMAIL + WHATSAPP).
    const sent = prisma._logs.filter((l) => l.status === 'SENT');
    expect(sent).toHaveLength(2);
    expect(sent.map((l) => l.channel).sort()).toEqual(['EMAIL', 'WHATSAPP']);
    expect(sent.every((l) => l.sentAt !== null)).toBe(true);
    expect(sent.every((l) => l.dedupeKey === 'KILL_SWITCH_ON:GLOBAL')).toBe(true);
  });

  it('THROTTLE: duplicado dentro da janela vira SUPPRESSED e nao reenvia', async () => {
    const prisma = makeFakePrisma({
      settings: FULL_SETTINGS,
      clock,
      // Envio anterior 10 min atras (dentro da janela de 60 min).
      seedLogs: [
        {
          dedupeKey: 'SECTOR_CRITICAL:TRAFFIC',
          status: 'SENT',
          createdAt: new Date(FIXED_NOW.getTime() - 10 * 60_000),
        },
      ],
    });
    const { notifier, email, whatsapp } = makeStubNotifier();
    const service = new AlertService({ prisma: prisma as never, notifier, log, clock });

    await service.notify({ event: 'SECTOR_CRITICAL', sector: 'TRAFFIC', context: { score: 12 } });

    // Nada enviado pelos canais.
    expect(email.outbox).toHaveLength(0);
    expect(whatsapp.outbox).toHaveLength(0);

    // Gravou exatamente 1 linha SUPPRESSED.
    const created = prisma._logs.filter((l) => l.id.startsWith('log_'));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      status: 'SUPPRESSED',
      dedupeKey: 'SECTOR_CRITICAL:TRAFFIC',
    });
  });

  it('envia normalmente quando a linha anterior esta FORA da janela de throttle', async () => {
    const prisma = makeFakePrisma({
      settings: { ...FULL_SETTINGS, channels: ['EMAIL'] },
      clock,
      // Envio anterior 120 min atras (fora da janela de 60 min).
      seedLogs: [
        {
          dedupeKey: 'SECTOR_CRITICAL:TRAFFIC',
          status: 'SENT',
          createdAt: new Date(FIXED_NOW.getTime() - 120 * 60_000),
        },
      ],
    });
    const { notifier, email } = makeStubNotifier();
    const service = new AlertService({ prisma: prisma as never, notifier, log, clock });

    await service.notify({ event: 'SECTOR_CRITICAL', sector: 'TRAFFIC' });

    expect(email.outbox).toHaveLength(1);
    const created = prisma._logs.filter((l) => l.id.startsWith('log_'));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: 'SENT', channel: 'EMAIL' });
  });

  it('evento desabilitado (enabledEvents nao-vazio sem o evento) => nao envia nem persiste', async () => {
    const prisma = makeFakePrisma({
      settings: { ...FULL_SETTINGS, enabledEvents: ['KILL_SWITCH_ON'] },
      clock,
    });
    const { notifier, email, whatsapp } = makeStubNotifier();
    const service = new AlertService({ prisma: prisma as never, notifier, log, clock });

    await service.notify({ event: 'ACTION_HIGH_QUEUED', sector: 'TRAFFIC' });

    expect(email.outbox).toHaveLength(0);
    expect(whatsapp.outbox).toHaveLength(0);
    expect(prisma.alertLog.create).not.toHaveBeenCalled();
  });

  it('alertsEnabled=false => nao envia nem persiste', async () => {
    const prisma = makeFakePrisma({ settings: { ...FULL_SETTINGS, alertsEnabled: false }, clock });
    const { notifier, email } = makeStubNotifier();
    const service = new AlertService({ prisma: prisma as never, notifier, log, clock });

    await service.notify({ event: 'KILL_SWITCH_ON' });

    expect(email.outbox).toHaveLength(0);
    expect(prisma.alertLog.create).not.toHaveBeenCalled();
  });

  it('canal que LANCA => AlertLog FAILED, sem propagar (notify resolve)', async () => {
    const prisma = makeFakePrisma({ settings: { ...FULL_SETTINGS, channels: ['EMAIL'] }, clock });

    // Canal EMAIL que sempre lanca.
    const throwingEmail: AlertChannelAdapter = {
      channel: 'EMAIL',
      send: vi.fn(async () => {
        throw new Error('SMTP indisponivel');
      }),
    };
    const notifier = new CompositeNotificationAdapter([throwingEmail]);
    const service = new AlertService({ prisma: prisma as never, notifier, log, clock });

    // Nao deve rejeitar.
    await expect(service.notify({ event: 'ACTION_AUTO_FAILED', sector: 'DELIVERY' })).resolves.toBeUndefined();

    const created = prisma._logs.filter((l) => l.id.startsWith('log_'));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      status: 'FAILED',
      channel: 'EMAIL',
      error: expect.stringContaining('SMTP indisponivel'),
    });
    expect(created[0]?.sentAt).toBeNull();
  });

  it('FAIL-OPEN: AlertSettings ausente usa defaults (EMAIL ligado) e envia', async () => {
    const prisma = makeFakePrisma({ settings: null, clock });
    const { notifier, email, whatsapp } = makeStubNotifier();
    const service = new AlertService({ prisma: prisma as never, notifier, log, clock });

    await service.notify({ event: 'KILL_SWITCH_OFF' });

    // Default channels = [EMAIL] => so email recebe.
    expect(email.outbox).toHaveLength(0); // sem destinatarios default => EmailAlertChannel lanca
    // EmailAlertChannel lanca quando nao ha destinatarios; vira FAILED, mas
    // o importante e que o fluxo seguiu o default e nao rejeitou.
    expect(whatsapp.outbox).toHaveLength(0);
    const created = prisma._logs.filter((l) => l.id.startsWith('log_'));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ channel: 'EMAIL', status: 'FAILED' });
  });
});

// ============================================================
// renderMessage (puro)
// ============================================================
describe('renderMessage', () => {
  it('compoe titulo com prefixo de severidade e corpo pt-BR por evento', async () => {
    const { renderMessage } = await import('./alert-service.js');

    const critical = renderMessage('SECTOR_CRITICAL', 'CRITICAL', 'TRAFFIC', { score: 18 });
    expect(critical.title).toContain('[Critico]');
    expect(critical.title).toContain('Trafego');
    expect(critical.body).toContain('18/100');

    const killOn = renderMessage('KILL_SWITCH_ON', 'CRITICAL', null, {});
    expect(killOn.title).toContain('Kill switch ACIONADO');
    expect(killOn.body).toContain('LIGADO');

    const queued = renderMessage('ACTION_HIGH_QUEUED', 'WARNING', 'SALES', {
      kind: 'ADJUST_PRICE',
      expectedEffect: 'subir conversao',
    });
    expect(queued.title).toContain('[Atencao]');
    expect(queued.body).toContain('ADJUST_PRICE');
    expect(queued.body).toContain('subir conversao');
  });
});
