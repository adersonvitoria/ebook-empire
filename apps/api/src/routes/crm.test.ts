// Testes de integracao das rotas /crm (CRM / Command Center).
// Cobre: GET /crm/overview, GET /crm/problems e o fluxo
// POST /crm/actions/:id/approve -> APPLIED com fakes (Prisma fake em memoria +
// scheduler fake expondo applyApprovedAction). Sem banco real.
//
// Segue o padrao de checkout.test.ts: env minimo, Prisma fake, vi.mock dos
// modulos que a rota importa. O decorator fastify.authenticate (normalmente
// criado em server.ts) e simulado aqui com um decorate de no-op.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// --- env minimo p/ carregar dependencias sem .env real ---
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.USE_STUBS = 'true';

// ------------------------------------------------------------
// Prisma fake em memoria (apenas modelos/metodos usados pela rota /crm).
// ------------------------------------------------------------
let seq = 0;
const id = (p: string) => `${p}_${++seq}`;

interface Store {
  snapshots: any[];
  problems: any[];
  actions: any[];
  executions: any[];
  guardrail: any | null;
}
let store: Store;

const prismaMock = {
  sectorHealthSnapshot: {
    findMany: async ({ where, orderBy, take, select }: any = {}) => {
      let rows = [...store.snapshots];
      if (where?.sector) rows = rows.filter((s) => s.sector === where.sector);
      if (where?.capturedAt?.gte) {
        const gte = new Date(where.capturedAt.gte).getTime();
        rows = rows.filter((s) => new Date(s.capturedAt).getTime() >= gte);
      }
      rows.sort((a, b) =>
        orderBy?.capturedAt === 'desc'
          ? new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
          : 0,
      );
      if (typeof take === 'number') rows = rows.slice(0, take);
      void select;
      return rows;
    },
  },
  problem: {
    count: async ({ where }: any = {}) => {
      let rows = [...store.problems];
      if (where?.status?.in) rows = rows.filter((p) => where.status.in.includes(p.status));
      else if (where?.status) rows = rows.filter((p) => p.status === where.status);
      if (where?.sector) rows = rows.filter((p) => p.sector === where.sector);
      return rows.length;
    },
    groupBy: async ({ by }: any) => {
      if (by?.[0] !== 'status') return [];
      const counts: Record<string, number> = {};
      for (const p of store.problems) counts[p.status] = (counts[p.status] ?? 0) + 1;
      return Object.entries(counts).map(([status, n]) => ({
        status,
        _count: { _all: n },
      }));
    },
    findMany: async ({ where, take, skip, select }: any = {}) => {
      let rows = [...store.problems];
      if (where?.status?.in) rows = rows.filter((p) => where.status.in.includes(p.status));
      else if (where?.status) rows = rows.filter((p) => p.status === where.status);
      if (where?.sector) rows = rows.filter((p) => p.sector === where.sector);
      rows.sort(
        (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
      );
      if (typeof skip === 'number') rows = rows.slice(skip);
      if (typeof take === 'number') rows = rows.slice(0, take);
      // Resolve _count.actions quando solicitado pelo select.
      if (select?._count) {
        rows = rows.map((p) => ({
          ...p,
          _count: { actions: store.actions.filter((a) => a.problemId === p.id).length },
        }));
      }
      return rows;
    },
    findUnique: async ({ where }: any) => {
      const p = store.problems.find((x) => x.id === where.id);
      return p ?? null;
    },
  },
  remediationAction: {
    count: async ({ where }: any = {}) => {
      let rows = [...store.actions];
      if (where?.riskTier) rows = rows.filter((a) => a.riskTier === where.riskTier);
      if (where?.status) rows = rows.filter((a) => a.status === where.status);
      if (where?.problemId) rows = rows.filter((a) => a.problemId === where.problemId);
      return rows.length;
    },
    groupBy: async ({ by }: any) => {
      if (by?.[0] !== 'status') return [];
      const counts: Record<string, number> = {};
      for (const a of store.actions) counts[a.status] = (counts[a.status] ?? 0) + 1;
      return Object.entries(counts).map(([status, n]) => ({
        status,
        _count: { _all: n },
      }));
    },
    findMany: async ({ where, take, skip }: any = {}) => {
      let rows = [...store.actions];
      if (where?.status) rows = rows.filter((a) => a.status === where.status);
      if (where?.riskTier) rows = rows.filter((a) => a.riskTier === where.riskTier);
      if (where?.problemId) rows = rows.filter((a) => a.problemId === where.problemId);
      rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      if (typeof skip === 'number') rows = rows.slice(skip);
      if (typeof take === 'number') rows = rows.slice(0, take);
      return rows.map((a) => ({
        ...a,
        problem: store.problems.find((p) => p.id === a.problemId) ?? null,
        executions: store.executions
          .filter((e) => e.actionId === a.id)
          .sort((x, y) => new Date(y.startedAt).getTime() - new Date(x.startedAt).getTime())
          .slice(0, 1),
      }));
    },
    findUnique: async ({ where, include }: any) => {
      const a = store.actions.find((x) => x.id === where.id);
      if (!a) return null;
      if (include?.executions) {
        let execs = store.executions.filter((e) => e.actionId === a.id);
        if (include.executions.where) {
          const w = include.executions.where;
          execs = execs.filter(
            (e) =>
              (w.isRollback === undefined || e.isRollback === w.isRollback) &&
              (w.success === undefined || e.success === w.success),
          );
        }
        return { ...a, executions: execs };
      }
      return a;
    },
    update: async ({ where, data }: any) => {
      const a = store.actions.find((x) => x.id === where.id);
      Object.assign(a, data);
      return a;
    },
  },
  guardrailConfig: {
    findUnique: async () => store.guardrail,
    upsert: async ({ create, update }: any) => {
      if (store.guardrail) {
        Object.assign(store.guardrail, update, { updatedAt: new Date() });
      } else {
        store.guardrail = {
          id: 'singleton',
          killSwitch: false,
          maxAutoActionsPerCycle: 5,
          cooldownMinutes: 30,
          maxAdBudgetCents: null,
          updatedAt: new Date(),
          ...create,
        };
      }
      return store.guardrail;
    },
  },
};

// ------------------------------------------------------------
// Scheduler fake: applyApprovedAction marca a acao APPLIED e registra execucao.
// ------------------------------------------------------------
const applyApprovedAction = vi.fn(async (_app: unknown, actionId: string) => {
  const action = store.actions.find((a) => a.id === actionId);
  if (!action) return { success: false, error: 'acao nao encontrada' };
  action.status = 'APPLIED';
  action.appliedAt = new Date();
  store.executions.push({
    id: id('exec'),
    actionId,
    success: true,
    triggeredBy: 'HUMAN',
    isRollback: false,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  return { success: true };
});
const runOperationsCycle = vi.fn(async () => ({ cycleId: 'cyc_test', status: 'SUCCESS' }));

vi.mock('../db.js', () => ({ prisma: prismaMock }));
vi.mock('../scheduler.js', () => ({ applyApprovedAction, runOperationsCycle }));

let app: FastifyInstance;

beforeAll(async () => {
  const routeMod = await import('./crm.js');
  app = Fastify();
  // Simula o decorator de auth criado em server.ts (no-op autoriza tudo).
  app.decorate('authenticate', async () => {});
  await app.register(routeMod.default);
  await app.ready();
});

beforeEach(() => {
  seq = 0;
  applyApprovedAction.mockClear();
  runOperationsCycle.mockClear();
  const now = new Date();
  store = {
    snapshots: [
      { id: 'snap_c', sector: 'CONTENT', score: 85, kpis: {}, capturedAt: now, cycleId: 'c1' },
      { id: 'snap_t', sector: 'TRAFFIC', score: 30, kpis: { roas: 0.4 }, capturedAt: now, cycleId: 'c1' },
    ],
    problems: [
      {
        id: 'prob_1',
        sector: 'TRAFFIC',
        type: 'NEGATIVE_ROAS',
        severity: 70,
        status: 'OPEN',
        rootCause: 'ROAS abaixo de 1.',
        detectedAt: now,
        resolvedAt: null,
      },
    ],
    actions: [
      {
        id: 'act_high',
        problemId: 'prob_1',
        kind: 'INCREASE_AD_BUDGET',
        riskTier: 'HIGH',
        params: { campaignId: 'camp_1', newDailyBudgetCents: 10000 },
        expectedEffect: 'Aumentar alcance da campanha.',
        status: 'QUEUED',
        reversible: true,
        dedupeKey: 'prob_1:INCREASE_AD_BUDGET:abc',
        appliedAt: null,
        createdAt: now,
      },
    ],
    executions: [],
    guardrail: {
      id: 'singleton',
      killSwitch: false,
      maxAutoActionsPerCycle: 5,
      cooldownMinutes: 30,
      maxAdBudgetCents: null, // teto = MAX_AD_BUDGET_BRL*100 = 300*100 = 30000
      updatedAt: now,
    },
  };
});

describe('GET /crm/overview', () => {
  it('retorna saude por setor, score global e contadores', async () => {
    const res = await app.inject({ method: 'GET', url: '/crm/overview' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // 7 setores sempre presentes (setores sem snapshot vem com score null).
    expect(body.sectors).toHaveLength(7);
    const content = body.sectors.find((s: any) => s.sector === 'CONTENT');
    expect(content.score).toBe(85);
    expect(content.status).toBe('HEALTHY');
    const traffic = body.sectors.find((s: any) => s.sector === 'TRAFFIC');
    expect(traffic.status).toBe('CRITICAL'); // score 30 < 40

    // Score global = media dos setores com snapshot ((85+30)/2 = 57.5 -> 58).
    expect(body.globalScore).toBe(58);
    expect(body.globalStatus).toBe('WARNING');

    // Contadores.
    expect(body.problems.open).toBe(1);
    expect(body.actions.pendingApproval).toBe(1); // 1 HIGH QUEUED
    expect(body.guardrails.killSwitch).toBe(false);
  });
});

describe('GET /crm/problems', () => {
  it('lista problemas com paginacao e contagem de acoes', async () => {
    const res = await app.inject({ method: 'GET', url: '/crm/problems' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.problems[0].type).toBe('NEGATIVE_ROAS');
    expect(body.problems[0].actionCount).toBe(1);
  });

  it('filtra por sector', async () => {
    const res = await app.inject({ method: 'GET', url: '/crm/problems?sector=CONTENT' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
  });

  it('rejeita querystring invalida (400)', async () => {
    const res = await app.inject({ method: 'GET', url: '/crm/problems?status=NOPE' });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /crm/actions/:id/approve', () => {
  it('aprova acao HIGH QUEUED e dispara aplicacao -> APPLIED', async () => {
    const res = await app.inject({ method: 'POST', url: '/crm/actions/act_high/approve' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.approved).toBe(true);
    expect(body.applied).toBe(true);

    expect(applyApprovedAction).toHaveBeenCalledOnce();
    const action = store.actions.find((a) => a.id === 'act_high');
    expect(action.status).toBe('APPLIED');
    expect(store.executions).toHaveLength(1);
  });

  it('bloqueia quando orcamento excede o teto financeiro (3a camada)', async () => {
    store.actions[0].params = { campaignId: 'camp_1', newDailyBudgetCents: 99_999_999 };
    const res = await app.inject({ method: 'POST', url: '/crm/actions/act_high/approve' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('budget_cap_exceeded');
    expect(applyApprovedAction).not.toHaveBeenCalled();
    // Acao permanece QUEUED (nao aprovada).
    expect(store.actions[0].status).toBe('QUEUED');
  });

  it('409 se a acao nao esta QUEUED', async () => {
    store.actions[0].status = 'APPLIED';
    const res = await app.inject({ method: 'POST', url: '/crm/actions/act_high/approve' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('invalid_status');
  });

  it('404 para acao inexistente', async () => {
    const res = await app.inject({ method: 'POST', url: '/crm/actions/nope/approve' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /crm/killswitch', () => {
  it('liga o kill switch e persiste no singleton', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/crm/killswitch',
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().killSwitch).toBe(true);
    expect(store.guardrail.killSwitch).toBe(true);
  });
});

describe('POST /crm/scan', () => {
  it('dispara runOperationsCycle e retorna 202', async () => {
    const res = await app.inject({ method: 'POST', url: '/crm/scan', payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json().triggered).toBe(true);
    expect(runOperationsCycle).toHaveBeenCalledOnce();
  });
});
