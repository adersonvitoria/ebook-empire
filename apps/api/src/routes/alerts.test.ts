// Testes de integracao das rotas /alerts (Alertas externos — Feature 1).
// Cobre: GET /alerts/settings (defaults fail-OPEN e valores do DB), PUT /alerts/
// settings (patch parcial -> upsert), POST /alerts/test (fan-out por canal +
// persistencia de AlertLog), e GET /alerts (log paginado).
//
// Segue o padrao de crm.test.ts: env minimo, Prisma fake em memoria, vi.mock dos
// modulos que a rota importa (../db.js e ../scheduler.js). O decorator
// fastify.authenticate (normalmente criado em server.ts) e simulado com no-op.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// --- env minimo p/ carregar dependencias sem .env real ---
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.USE_STUBS = 'true';
process.env.ALERT_EMAIL_TO = 'boot@empresa.com';
process.env.ALERT_WHATSAPP_TO = '5511999998888';
process.env.ALERT_THROTTLE_MINUTES = '45';

// ------------------------------------------------------------
// Prisma fake em memoria (apenas alertSettings + alertLog).
// ------------------------------------------------------------
let seq = 0;
const id = (p: string) => `${p}_${++seq}`;

interface Store {
  settings: any | null;
  logs: any[];
}
let store: Store;

const prismaMock = {
  alertSettings: {
    findUnique: async () => store.settings,
    upsert: async ({ create, update }: any) => {
      const apply = (target: any, patch: any) => {
        for (const [k, v] of Object.entries(patch)) {
          // Campos de array vem como { set: [...] } (Prisma scalar list update).
          if (v && typeof v === 'object' && 'set' in (v as any)) target[k] = (v as any).set;
          else target[k] = v;
        }
      };
      if (store.settings) {
        apply(store.settings, update);
        store.settings.updatedAt = new Date();
      } else {
        store.settings = {
          id: 'singleton',
          alertsEnabled: true,
          channels: ['EMAIL'],
          emailRecipients: [],
          whatsappRecipients: [],
          enabledEvents: [],
          throttleMinutes: 60,
          updatedAt: new Date(),
        };
        apply(store.settings, create);
      }
      return store.settings;
    },
  },
  alertLog: {
    findMany: async ({ where, take, skip }: any = {}) => {
      let rows = [...store.logs];
      if (where?.event) rows = rows.filter((l) => l.event === where.event);
      if (where?.channel) rows = rows.filter((l) => l.channel === where.channel);
      if (where?.status) rows = rows.filter((l) => l.status === where.status);
      rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      if (typeof skip === 'number') rows = rows.slice(skip);
      if (typeof take === 'number') rows = rows.slice(0, take);
      return rows;
    },
    count: async ({ where }: any = {}) => {
      let rows = [...store.logs];
      if (where?.event) rows = rows.filter((l) => l.event === where.event);
      if (where?.channel) rows = rows.filter((l) => l.channel === where.channel);
      if (where?.status) rows = rows.filter((l) => l.status === where.status);
      return rows.length;
    },
    createMany: async ({ data }: any) => {
      const rows = Array.isArray(data) ? data : [data];
      for (const r of rows) store.logs.push({ id: id('log'), createdAt: new Date(), ...r });
      return { count: rows.length };
    },
  },
};

// ------------------------------------------------------------
// Scheduler fake: getNotification devolve uma NotificationPort que faz fan-out
// configuravel (canais habilitados -> SENT/FAILED). Controlado por `notifyBehavior`.
// ------------------------------------------------------------
let notifyBehavior: 'ok' | 'email-fails' | 'unavailable' = 'ok';
const notificationSend = vi.fn(async (message: any) => {
  if (notifyBehavior === 'unavailable') throw new Error('inesperado');
  return (message.channels as string[]).map((channel: string) => {
    if (notifyBehavior === 'email-fails' && channel === 'EMAIL') {
      return { channel, status: 'FAILED', error: 'smtp recusou' };
    }
    return { channel, status: 'SENT', providerId: `prov-${channel}` };
  });
});
const getNotification = vi.fn(async () =>
  notifyBehavior === 'unavailable' ? null : { send: notificationSend },
);

vi.mock('../db.js', () => ({ prisma: prismaMock }));
vi.mock('../scheduler.js', () => ({ getNotification }));

let app: FastifyInstance;

beforeAll(async () => {
  const routeMod = await import('./alerts.js');
  app = Fastify();
  app.decorate('authenticate', async () => {});
  await app.register(routeMod.default);
  await app.ready();
});

beforeEach(() => {
  seq = 0;
  notifyBehavior = 'ok';
  notificationSend.mockClear();
  getNotification.mockClear();
  store = { settings: null, logs: [] };
});

describe('GET /alerts/settings', () => {
  it('retorna defaults fail-OPEN das envs quando o singleton nao existe', async () => {
    const res = await app.inject({ method: 'GET', url: '/alerts/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.alertsEnabled).toBe(true);
    expect(body.channels).toEqual(['EMAIL']);
    expect(body.emailRecipients).toEqual(['boot@empresa.com']);
    expect(body.whatsappRecipients).toEqual(['5511999998888']);
    expect(body.enabledEvents).toEqual([]); // vazio = todos
    expect(body.throttleMinutes).toBe(45); // ALERT_THROTTLE_MINUTES
  });

  it('retorna o registro do DB quando existe (prioridade sobre as envs)', async () => {
    store.settings = {
      id: 'singleton',
      alertsEnabled: false,
      channels: ['WHATSAPP'],
      emailRecipients: ['ops@empresa.com'],
      whatsappRecipients: [],
      enabledEvents: ['SECTOR_CRITICAL'],
      throttleMinutes: 10,
      updatedAt: new Date(),
    };
    const res = await app.inject({ method: 'GET', url: '/alerts/settings' });
    const body = res.json();
    expect(body.alertsEnabled).toBe(false);
    expect(body.channels).toEqual(['WHATSAPP']);
    expect(body.enabledEvents).toEqual(['SECTOR_CRITICAL']);
    expect(body.throttleMinutes).toBe(10);
  });
});

describe('PUT /alerts/settings', () => {
  it('aplica patch parcial e faz upsert do singleton', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/alerts/settings',
      payload: {
        alertsEnabled: false,
        channels: ['EMAIL', 'WHATSAPP'],
        emailRecipients: ['a@x.com', 'b@x.com'],
        enabledEvents: ['KILL_SWITCH_ON', 'SECTOR_CRITICAL'],
        throttleMinutes: 30,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.updated).toBe(true);
    expect(body.settings.alertsEnabled).toBe(false);
    expect(body.settings.channels).toEqual(['EMAIL', 'WHATSAPP']);
    expect(body.settings.emailRecipients).toEqual(['a@x.com', 'b@x.com']);
    expect(body.settings.enabledEvents).toEqual(['KILL_SWITCH_ON', 'SECTOR_CRITICAL']);
    expect(body.settings.throttleMinutes).toBe(30);
    // Persistiu no store.
    expect(store.settings.alertsEnabled).toBe(false);
  });

  it('rejeita body vazio (400)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/alerts/settings', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it('rejeita canal invalido (400)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/alerts/settings',
      payload: { channels: ['SMS'] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /alerts/test', () => {
  it('dispara fan-out pelos canais habilitados e persiste 1 AlertLog por canal', async () => {
    store.settings = {
      id: 'singleton',
      alertsEnabled: true,
      channels: ['EMAIL', 'WHATSAPP'],
      emailRecipients: ['ops@empresa.com'],
      whatsappRecipients: ['5511999998888'],
      enabledEvents: [],
      throttleMinutes: 60,
      updatedAt: new Date(),
    };
    const res = await app.inject({ method: 'POST', url: '/alerts/test', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tested).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: any) => r.status === 'SENT')).toBe(true);

    expect(notificationSend).toHaveBeenCalledOnce();
    // 1 AlertLog por canal (auditoria do teste).
    expect(store.logs).toHaveLength(2);
    expect(store.logs.map((l) => l.channel).sort()).toEqual(['EMAIL', 'WHATSAPP']);
    expect(store.logs.every((l) => l.status === 'SENT')).toBe(true);
  });

  it('retorna 502 quando todos os canais falham, registrando FAILED', async () => {
    notifyBehavior = 'email-fails';
    store.settings = {
      id: 'singleton',
      alertsEnabled: true,
      channels: ['EMAIL'],
      emailRecipients: ['ops@empresa.com'],
      whatsappRecipients: [],
      enabledEvents: [],
      throttleMinutes: 60,
      updatedAt: new Date(),
    };
    const res = await app.inject({ method: 'POST', url: '/alerts/test', payload: {} });
    expect(res.statusCode).toBe(502);
    expect(res.json().results[0].status).toBe('FAILED');
    expect(store.logs[0].status).toBe('FAILED');
    expect(store.logs[0].error).toBe('smtp recusou');
  });

  it('409 quando alertsEnabled=false', async () => {
    store.settings = {
      id: 'singleton',
      alertsEnabled: false,
      channels: ['EMAIL'],
      emailRecipients: ['ops@empresa.com'],
      whatsappRecipients: [],
      enabledEvents: [],
      throttleMinutes: 60,
      updatedAt: new Date(),
    };
    const res = await app.inject({ method: 'POST', url: '/alerts/test', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('alerts_disabled');
    expect(notificationSend).not.toHaveBeenCalled();
  });

  it('503 quando a NotificationPort esta indisponivel', async () => {
    notifyBehavior = 'unavailable';
    // settings default fail-OPEN (alertsEnabled=true, channels=[EMAIL]).
    const res = await app.inject({ method: 'POST', url: '/alerts/test', payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('notification_unavailable');
  });
});

describe('GET /alerts', () => {
  it('lista AlertLog paginado e filtra por status', async () => {
    const now = Date.now();
    store.logs = [
      { id: 'l1', event: 'SECTOR_CRITICAL', severity: 'CRITICAL', channel: 'EMAIL', status: 'SENT', createdAt: new Date(now) },
      { id: 'l2', event: 'KILL_SWITCH_ON', severity: 'CRITICAL', channel: 'WHATSAPP', status: 'SUPPRESSED', createdAt: new Date(now - 1000) },
      { id: 'l3', event: 'ACTION_AUTO_FAILED', severity: 'CRITICAL', channel: 'EMAIL', status: 'FAILED', createdAt: new Date(now - 2000) },
    ];
    const all = await app.inject({ method: 'GET', url: '/alerts' });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(3);
    expect(all.json().data).toHaveLength(3);

    const failed = await app.inject({ method: 'GET', url: '/alerts?status=FAILED' });
    expect(failed.json().total).toBe(1);
    expect(failed.json().data[0].event).toBe('ACTION_AUTO_FAILED');
  });

  it('rejeita filtro invalido (400)', async () => {
    const res = await app.inject({ method: 'GET', url: '/alerts?status=NOPE' });
    expect(res.statusCode).toBe(400);
  });
});
