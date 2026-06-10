// Testes do OperationsAgent (COO) com TODAS as dependencias fake.
//
// Cobre um ciclo completo: setor CRITICAL -> Problem criado -> acao LOW aplicada
// (executor fake) -> Problem caminha para REMEDIATING; e, no ciclo seguinte com
// o setor recuperado (HEALTHY), o Problem caminha para RESOLVED.
//
// Tambem valida: roteamento por tier (HIGH => QUEUED, NUNCA aplicada), tolerancia
// a falha por setor, persistencia de snapshots e dedupe de acoes identicas.

import { describe, it, expect, vi } from 'vitest';
import type { Json, Ports } from '@ebook-empire/core';
import type {
  AgentContext,
  AgentEnv,
  AgentLogger,
  AlertNotifyInput,
  Clock,
} from '../base.js';
import { OperationsAgent } from './operations-agent.js';
import type {
  HealthCollector,
  DiagnosisEngine,
  ActionCatalog,
  ActionExecutor,
  RemediationActionRef,
  ActionExecutionRef,
  Diagnosis,
  RemediationProposal,
  SectorHealth,
  Sector,
  ExecutionResult,
} from './contracts.js';

// ------------------------------------------------------------
// Fake Prisma — somente as tabelas que o COO toca:
// sectorHealthSnapshot, problem, remediationAction, agentRun.
// ------------------------------------------------------------
interface ProblemRow {
  id: string;
  sector: string;
  type: string;
  severity: number;
  status: string;
  rootCause: string | null;
  snapshotId: string | null;
  detectedAt: Date;
  resolvedAt: Date | null;
  metadata: unknown;
}
interface ActionRow {
  id: string;
  problemId: string;
  kind: string;
  riskTier: string;
  params: unknown;
  expectedEffect: string;
  status: string;
  reversible: boolean;
  dedupeKey: string;
  appliedAt: Date | null;
}

function makeFakePrisma() {
  const snapshots: { id: string; sector: string; score: number; kpis: unknown; cycleId: string | null; capturedAt: Date }[] = [];
  const problems: ProblemRow[] = [];
  const actions: ActionRow[] = [];
  const runs: { id: string; agent: string; status: string }[] = [];
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;

  const prisma = {
    sectorHealthSnapshot: {
      create: vi.fn(async ({ data, select }: any) => {
        const row = {
          id: id('snap'),
          sector: data.sector,
          score: data.score,
          kpis: data.kpis,
          cycleId: data.cycleId ?? null,
          capturedAt: data.capturedAt ?? new Date(),
        };
        snapshots.push(row);
        return select?.id ? { id: row.id } : row;
      }),
      // Suporta duas consultas:
      //  - loadSnapshotIds: { where: { cycleId } } -> { id, sector }
      //  - loadPriorStatuses: { where: { capturedAt: { lt } } } -> { sector, score }
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        let rows = [...snapshots];
        if (where?.cycleId !== undefined) {
          const cycleId = where.cycleId ?? null;
          rows = rows.filter((s) => (cycleId === null ? true : s.cycleId === cycleId));
        }
        if (where?.capturedAt?.lt) {
          const lt = new Date(where.capturedAt.lt).getTime();
          rows = rows.filter((s) => s.capturedAt.getTime() < lt);
        }
        if (orderBy?.capturedAt === 'desc') {
          rows = rows.sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
        }
        return rows.map((s) => ({ id: s.id, sector: s.sector, score: s.score }));
      }),
    },
    problem: {
      findFirst: vi.fn(async ({ where }: any) => {
        const statusIn: string[] = where.status?.in ?? [];
        return (
          problems
            .filter(
              (p) =>
                p.sector === where.sector &&
                p.type === where.type &&
                (statusIn.length === 0 || statusIn.includes(p.status)),
            )
            .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())[0] ?? null
        );
      }),
      create: vi.fn(async ({ data }: any) => {
        const row: ProblemRow = {
          id: id('prob'),
          sector: data.sector,
          type: data.type,
          severity: data.severity,
          status: data.status ?? 'OPEN',
          rootCause: data.rootCause ?? null,
          snapshotId: data.snapshotId ?? null,
          detectedAt: new Date('2026-06-10T12:00:00.000Z'),
          resolvedAt: null,
          metadata: data.metadata ?? null,
        };
        problems.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = problems.find((p) => p.id === where.id);
        if (!row) throw new Error(`problem ${where.id} nao encontrado`);
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const statusIn: string[] = where.status?.in ?? [];
        let count = 0;
        for (const p of problems) {
          if (p.sector === where.sector && (statusIn.length === 0 || statusIn.includes(p.status))) {
            Object.assign(p, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    remediationAction: {
      findUnique: vi.fn(async ({ where }: any) => actions.find((a) => a.dedupeKey === where.dedupeKey) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row: ActionRow = {
          id: id('act'),
          problemId: data.problemId,
          kind: data.kind,
          riskTier: data.riskTier,
          params: data.params,
          expectedEffect: data.expectedEffect,
          status: data.status ?? 'PROPOSED',
          reversible: data.reversible ?? false,
          dedupeKey: data.dedupeKey,
          appliedAt: null,
        };
        actions.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = actions.find((a) => a.id === where.id);
        if (!row) throw new Error(`action ${where.id} nao encontrada`);
        Object.assign(row, data);
        return row;
      }),
    },
    agentRun: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: id('run'), agent: data.agent, status: data.status ?? 'RUNNING' };
        runs.push(row);
        return { id: row.id };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = runs.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return {
          id: where.id,
          agent: row?.agent ?? 'OPERATIONS',
          status: data.status,
          startedAt: new Date(),
          finishedAt: data.finishedAt ?? null,
          durationMs: data.durationMs ?? null,
        };
      }),
    },
    _state: { snapshots, problems, actions, runs },
  };
  return prisma;
}

// ------------------------------------------------------------
// Fakes das 4 interfaces (DI).
// ------------------------------------------------------------
function makeHealth(sector: Sector, score: number): SectorHealth {
  return { sector, score, status: score >= 70 ? 'HEALTHY' : score >= 40 ? 'WARNING' : 'CRITICAL', kpis: { score } as Json };
}

class FakeCollector implements HealthCollector {
  constructor(private readonly healths: SectorHealth[]) {}
  // Espelha o DbHealthCollector real: o collector e o UNICO dono da persistencia
  // do SectorHealthSnapshot (1/setor por cycleId). O COO so le os ids depois.
  async collect(ctx: AgentContext): Promise<SectorHealth[]> {
    for (const h of this.healths) {
      await ctx.prisma.sectorHealthSnapshot.create({
        data: { sector: h.sector, score: Math.round(h.score), kpis: (h.kpis ?? {}) as never, cycleId: ctx.cycleId ?? null },
      });
    }
    return this.healths;
  }
}

class FakeDiagnosis implements DiagnosisEngine {
  constructor(private readonly type: string = 'DELIVERY_BACKLOG') {}
  async diagnose(_ctx: AgentContext, sector: Sector, health: SectorHealth): Promise<Diagnosis> {
    return {
      sector,
      type: this.type,
      severity: 100 - Math.round(health.score),
      status: 'OPEN',
      rootCause: `setor ${sector} degradado`,
      confidence: 0.9,
      evidence: ['backlog alto'],
      suggestedActionKinds: ['RETRY_DELIVERIES'],
      source: 'RULES',
    };
  }
}

class FakeCatalog implements ActionCatalog {
  constructor(private readonly proposals: RemediationProposal[]) {}
  propose(): RemediationProposal[] {
    return this.proposals;
  }
}

// Executor fake: aplica LOW com sucesso (a menos que configurado p/ bloquear/falhar).
class FakeExecutor implements ActionExecutor {
  applied: string[] = [];
  constructor(
    private readonly behavior: 'ok' | 'blocked' | 'fail' = 'ok',
  ) {}
  async apply(ctx: AgentContext, action: RemediationActionRef): Promise<ExecutionResult> {
    if (this.behavior === 'blocked') {
      return { success: false, beforeState: {}, afterState: {}, blockedByGuardrail: 'KILL_SWITCH' };
    }
    if (this.behavior === 'fail') {
      return { success: false, beforeState: {}, afterState: {}, error: 'falhou' };
    }
    this.applied.push(action.id);
    // Simula o que o executor real faz: marca a acao como APPLIED.
    await ctx.prisma.remediationAction.update({ where: { id: action.id }, data: { status: 'APPLIED' } });
    return { success: true, beforeState: { before: true }, afterState: { after: true } };
  }
  async rollback(_ctx: AgentContext, _exec: ActionExecutionRef): Promise<ExecutionResult> {
    return { success: true, beforeState: {}, afterState: {} };
  }
}

// ------------------------------------------------------------
// Contexto fake.
// ------------------------------------------------------------
const silentLog: AgentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const fixedClock: Clock = { now: () => new Date('2026-06-10T12:00:00.000Z') };

function makeEnv(): AgentEnv {
  return {
    ENABLE_AGENTS: true,
    MAX_AD_BUDGET_BRL: 300,
    TARGET_DAILY_REVENUE_BRL: 1000,
    PUBLIC_BASE_URL: 'http://localhost:3001',
    CONTENT_MODEL: 'claude-sonnet-4-6',
    PLANNING_MODEL: 'claude-opus-4-8',
  };
}

function makeCtx(prisma: ReturnType<typeof makeFakePrisma>): AgentContext {
  return {
    prisma: prisma as unknown as AgentContext['prisma'],
    ports: {} as Ports,
    env: makeEnv(),
    log: silentLog,
    clock: fixedClock,
    cycleId: 'cycle_fast_test',
  };
}

const retryProposal: RemediationProposal = {
  kind: 'RETRY_DELIVERIES',
  riskTier: 'LOW',
  sector: 'DELIVERY',
  params: { limit: 50 } as Json,
  expectedEffect: 'reprocessar entregas pendentes',
  reversible: false,
};

const budgetProposal: RemediationProposal = {
  kind: 'INCREASE_AD_BUDGET',
  riskTier: 'HIGH',
  sector: 'TRAFFIC',
  params: { campaignId: 'c1', newDailyBudgetCents: 5000 } as Json,
  expectedEffect: 'aumentar budget',
  reversible: true,
};

// ============================================================
// TESTES
// ============================================================
describe('OperationsAgent (COO) — ciclo de operacoes', () => {
  it('setor CRITICAL -> cria Problem -> acao LOW aplicada AUTO -> Problem REMEDIATING; recuperacao -> RESOLVED', async () => {
    const prisma = makeFakePrisma();
    const executor = new FakeExecutor('ok');
    const coo = new OperationsAgent(
      new FakeCollector([makeHealth('DELIVERY', 20)]), // CRITICAL
      new FakeDiagnosis('DELIVERY_BACKLOG'),
      new FakeCatalog([retryProposal]),
      executor,
    );

    // --- Ciclo 1: setor CRITICAL ---
    const rec1 = await coo.execute(makeCtx(prisma));
    expect(rec1.status).toBe('SUCCESS');
    expect(rec1.agent).toBe('OPERATIONS');

    // Snapshot persistido.
    expect(prisma._state.snapshots.length).toBe(1);
    // Problem criado.
    expect(prisma._state.problems.length).toBe(1);
    const prob = prisma._state.problems[0]!;
    expect(prob.type).toBe('DELIVERY_BACKLOG');
    expect(prob.severity).toBe(80); // 100 - 20
    // Acao LOW criada e aplicada AUTO pelo executor.
    expect(prisma._state.actions.length).toBe(1);
    expect(executor.applied.length).toBe(1);
    expect(prisma._state.actions[0]!.status).toBe('APPLIED');
    // Problem caminhou para REMEDIATING (acao auto-aplicada).
    expect(prob.status).toBe('REMEDIATING');

    // --- Ciclo 2: setor recuperado (HEALTHY) ---
    const coo2 = new OperationsAgent(
      new FakeCollector([makeHealth('DELIVERY', 90)]), // HEALTHY
      new FakeDiagnosis('DELIVERY_BACKLOG'),
      new FakeCatalog([retryProposal]),
      new FakeExecutor('ok'),
    );
    const rec2 = await coo2.execute(makeCtx(prisma));
    expect(rec2.status).toBe('SUCCESS');

    // O Problem ativo foi RESOLVED (com resolvedAt).
    expect(prob.status).toBe('RESOLVED');
    expect(prob.resolvedAt).not.toBeNull();
  });

  it('acao HIGH risk vai para a fila de aprovacao (QUEUED) e NUNCA e aplicada automaticamente', async () => {
    const prisma = makeFakePrisma();
    const executor = new FakeExecutor('ok');
    const coo = new OperationsAgent(
      new FakeCollector([makeHealth('TRAFFIC', 30)]), // CRITICAL
      new FakeDiagnosis('NEGATIVE_ROAS'),
      new FakeCatalog([budgetProposal]),
      executor,
    );

    await coo.execute(makeCtx(prisma));

    expect(prisma._state.actions.length).toBe(1);
    expect(prisma._state.actions[0]!.status).toBe('QUEUED');
    // Executor nunca foi chamado para acao HIGH.
    expect(executor.applied.length).toBe(0);
  });

  it('nao aplica acao LOW quando o executor reporta bloqueio por guardrail', async () => {
    const prisma = makeFakePrisma();
    const coo = new OperationsAgent(
      new FakeCollector([makeHealth('DELIVERY', 20)]),
      new FakeDiagnosis('DELIVERY_BACKLOG'),
      new FakeCatalog([retryProposal]),
      new FakeExecutor('blocked'),
    );

    const rec = await coo.execute(makeCtx(prisma));
    expect(rec.status).toBe('SUCCESS');
    // Acao criada mas NAO marcada como APPLIED (executor bloqueou).
    expect(prisma._state.actions[0]!.status).toBe('PROPOSED');
  });

  it('dedupe: nao recria a mesma acao no ciclo seguinte', async () => {
    const prisma = makeFakePrisma();
    const mkCoo = () =>
      new OperationsAgent(
        new FakeCollector([makeHealth('DELIVERY', 20)]),
        new FakeDiagnosis('DELIVERY_BACKLOG'),
        new FakeCatalog([retryProposal]),
        new FakeExecutor('ok'),
      );

    await mkCoo().execute(makeCtx(prisma));
    await mkCoo().execute(makeCtx(prisma));

    // Mesmo problem (reusado) e mesma acao (dedupeKey) => 1 problem, 1 acao.
    expect(prisma._state.problems.length).toBe(1);
    expect(prisma._state.actions.length).toBe(1);
  });

  it('tolera falha por setor sem derrubar o ciclo', async () => {
    const prisma = makeFakePrisma();
    // Diagnosis que explode so para DELIVERY; SALES segue normal.
    class ExplodingDiagnosis implements DiagnosisEngine {
      async diagnose(_ctx: AgentContext, sector: Sector, health: SectorHealth): Promise<Diagnosis> {
        if (sector === 'DELIVERY') throw new Error('diagnostico explodiu');
        return new FakeDiagnosis('LOW_CONVERSION').diagnose(_ctx, sector, health);
      }
    }
    const coo = new OperationsAgent(
      new FakeCollector([makeHealth('DELIVERY', 10), makeHealth('SALES', 30)]),
      new ExplodingDiagnosis(),
      new FakeCatalog([{ ...retryProposal, sector: 'SALES', kind: 'RECOMPUTE_KPIS', params: {} as Json }]),
      new FakeExecutor('ok'),
    );

    const rec = await coo.execute(makeCtx(prisma));
    // Ciclo conclui SUCCESS mesmo com DELIVERY explodindo.
    expect(rec.status).toBe('SUCCESS');
    // SALES gerou Problem normalmente.
    expect(prisma._state.problems.some((p) => p.sector === 'SALES')).toBe(true);
    // DELIVERY nao gerou Problem (falhou antes).
    expect(prisma._state.problems.some((p) => p.sector === 'DELIVERY')).toBe(false);
  });

  it('dispara alertas: SECTOR_CRITICAL na transicao, ACTION_HIGH_QUEUED e ACTION_AUTO_FAILED', async () => {
    // --- SECTOR_CRITICAL + HIGH_QUEUED (setor CRITICAL com proposta HIGH) ---
    const prismaHigh = makeFakePrisma();
    const notify = vi.fn<(input: AlertNotifyInput) => Promise<void>>(async () => {});
    const ctxHigh: AgentContext = { ...makeCtx(prismaHigh), alert: { notify } };
    const cooHigh = new OperationsAgent(
      new FakeCollector([makeHealth('TRAFFIC', 20)]), // CRITICAL (sem snapshot anterior)
      new FakeDiagnosis('NEGATIVE_ROAS'),
      new FakeCatalog([budgetProposal]), // HIGH
      new FakeExecutor('ok'),
    );
    await cooHigh.execute(ctxHigh);

    const events = notify.mock.calls.map((c) => c[0].event);
    // Transicao para CRITICAL (anterior desconhecido != CRITICAL) dispara SECTOR_CRITICAL.
    expect(events).toContain('SECTOR_CRITICAL');
    // Acao HIGH enfileirada dispara ACTION_HIGH_QUEUED.
    expect(events).toContain('ACTION_HIGH_QUEUED');
    const sectorCall = notify.mock.calls.find((c) => c[0].event === 'SECTOR_CRITICAL');
    expect(sectorCall?.[0].sector).toBe('TRAFFIC');

    // --- ACTION_AUTO_FAILED (acao LOW que o executor reporta como falha) ---
    const prismaFail = makeFakePrisma();
    const notify2 = vi.fn<(input: AlertNotifyInput) => Promise<void>>(async () => {});
    const ctxFail: AgentContext = { ...makeCtx(prismaFail), alert: { notify: notify2 } };
    const cooFail = new OperationsAgent(
      new FakeCollector([makeHealth('DELIVERY', 20)]),
      new FakeDiagnosis('DELIVERY_BACKLOG'),
      new FakeCatalog([retryProposal]), // LOW
      new FakeExecutor('fail'), // executor reporta falha (sem guardrail)
    );
    await cooFail.execute(ctxFail);
    const failEvents = notify2.mock.calls.map((c) => c[0].event);
    expect(failEvents).toContain('ACTION_AUTO_FAILED');
  });

  it('bloqueio por guardrail NAO dispara ACTION_AUTO_FAILED', async () => {
    const prisma = makeFakePrisma();
    const notify = vi.fn<(input: AlertNotifyInput) => Promise<void>>(async () => {});
    const ctx: AgentContext = { ...makeCtx(prisma), alert: { notify } };
    const coo = new OperationsAgent(
      new FakeCollector([makeHealth('DELIVERY', 20)]),
      new FakeDiagnosis('DELIVERY_BACKLOG'),
      new FakeCatalog([retryProposal]),
      new FakeExecutor('blocked'), // bloqueio por guardrail
    );
    await coo.execute(ctx);
    const events = notify.mock.calls.map((c) => c[0].event);
    expect(events).not.toContain('ACTION_AUTO_FAILED');
  });

  it('alert ausente (ctx.alert undefined) nao quebra o ciclo', async () => {
    const prisma = makeFakePrisma();
    // makeCtx NAO injeta alert => ctx.alert e undefined; optional chaining cobre.
    const coo = new OperationsAgent(
      new FakeCollector([makeHealth('TRAFFIC', 10)]),
      new FakeDiagnosis('NEGATIVE_ROAS'),
      new FakeCatalog([budgetProposal]),
      new FakeExecutor('ok'),
    );
    const rec = await coo.execute(makeCtx(prisma));
    expect(rec.status).toBe('SUCCESS');
  });

  it('setor HEALTHY sem problems ativos nao cria nada', async () => {
    const prisma = makeFakePrisma();
    const coo = new OperationsAgent(
      new FakeCollector([makeHealth('CONTENT', 95)]),
      new FakeDiagnosis(),
      new FakeCatalog([retryProposal]),
      new FakeExecutor('ok'),
    );
    await coo.execute(makeCtx(prisma));
    expect(prisma._state.problems.length).toBe(0);
    expect(prisma._state.actions.length).toBe(0);
    // Snapshot ainda e gravado (saude registrada para tendencia).
    expect(prisma._state.snapshots.length).toBe(1);
  });
});
