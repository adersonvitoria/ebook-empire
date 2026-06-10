// Testes do OrchestratorAgent (o "CEO").
// Cobre um CICLO COMPLETO end-to-end com todos os adapters/agentes STUB:
//   Content gera ebook -> Sales registra venda simulada -> Delivery entrega ->
//   Analytics calcula KPI. Valida ordem, tolerancia a falha de filho, guardrails
//   deterministicos e gravacao do AgentRun do ciclo.
//
// Sem banco real: usamos um fake minimo de PrismaClient (apenas agentRun) e um
// estado de negocio em memoria mutado pelos agentes-filho stub.

import { describe, it, expect, vi } from 'vitest';
import type { AgentName, KPISnapshot, Ports } from '@ebook-empire/core';
import {
  Agent,
  type AgentContext,
  type AgentRunResult,
  type AgentEnv,
  type AgentLogger,
  type Clock,
} from './base.js';
import {
  OrchestratorAgent,
  computeGuardrails,
  deterministicPlan,
  mergeWithPipeline,
  applyWeeklyEbookBudget,
  isoWeekBoundsSaoPaulo,
  CYCLE_ORDER,
  type Guardrails,
} from './orchestrator.js';

// ------------------------------------------------------------
// Estado de negocio em memoria (simula o "mundo" da empresa).
// ------------------------------------------------------------
interface World {
  ebooks: number;
  paidOrders: number;
  revenueCents: number;
  spendCents: number;
  delivered: number;
  log: AgentName[]; // ordem em que os filhos rodaram
}

function newWorld(): World {
  return { ebooks: 0, paidOrders: 0, revenueCents: 0, spendCents: 0, delivered: 0, log: [] };
}

// ------------------------------------------------------------
// Fake minimo de PrismaClient — so a tabela agentRun (usada pelo ciclo de vida).
// ------------------------------------------------------------
interface FakeRun {
  id: string;
  agent: AgentName;
  status: string;
  cycleId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  costCents: number | null;
}

function makeFakePrisma() {
  const rows: FakeRun[] = [];
  let seq = 0;
  const prisma = {
    agentRun: {
      create: vi.fn(async ({ data }: { data: Partial<FakeRun> }) => {
        const row: FakeRun = {
          id: `run_${++seq}`,
          agent: data.agent as AgentName,
          status: data.status ?? 'RUNNING',
          cycleId: data.cycleId ?? null,
          startedAt: data.startedAt ?? new Date(),
          finishedAt: null,
          durationMs: null,
          costCents: null,
        };
        rows.push(row);
        return { id: row.id };
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<FakeRun> }) => {
          const row = rows.find((r) => r.id === where.id);
          if (!row) throw new Error(`run ${where.id} nao encontrado`);
          Object.assign(row, data);
          return {
            id: row.id,
            agent: row.agent,
            status: row.status,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
            durationMs: row.durationMs,
          };
        },
      ),
      count: vi.fn(
        async ({
          where,
        }: {
          where?: {
            agent?: AgentName;
            status?: string;
            startedAt?: { gte?: Date; lt?: Date };
          };
        } = {}) => {
          return rows.filter((r) => {
            if (where?.agent && r.agent !== where.agent) return false;
            if (where?.status && r.status !== where.status) return false;
            if (where?.startedAt?.gte && r.startedAt < where.startedAt.gte) return false;
            if (where?.startedAt?.lt && r.startedAt >= where.startedAt.lt) return false;
            return true;
          }).length;
        },
      ),
    },
    _rows: rows,
  };
  return prisma;
}

// ------------------------------------------------------------
// Ports stub (apenas LLM e relevante para o orchestrator).
// ------------------------------------------------------------
function makeStubPorts(opts?: { failLlm?: boolean }): Ports {
  const llm = {
    generateText: vi.fn(),
    generateJson: vi.fn(async <T>(input: { parse: (raw: unknown) => T }) => {
      if (opts?.failLlm) throw new Error('llm indisponivel');
      // Plano valido: roda a pipeline inteira.
      const raw = {
        mode: 'GROW',
        rationale: 'plano de teste',
        actions: CYCLE_ORDER.map((agent, i) => ({
          agent,
          priority: 90 - i * 5,
          reason: `acao ${agent}`,
        })),
      };
      return { data: input.parse(raw), usage: { inputTokens: 100, outputTokens: 50, costCents: 3 } };
    }),
  };
  return {
    llm: llm as unknown as Ports['llm'],
    payment: {} as Ports['payment'],
    email: {} as Ports['email'],
    storage: {} as Ports['storage'],
    instagram: {} as Ports['instagram'],
    ads: {} as Ports['ads'],
  };
}

// ------------------------------------------------------------
// Agente-filho STUB generico: estende Agent de verdade (usa o ciclo de vida
// real -> grava AgentRun no fake prisma) e muta o World.
// ------------------------------------------------------------
class StubChild extends Agent {
  readonly name: AgentName;
  constructor(
    name: AgentName,
    private readonly effect: (w: World) => AgentRunResult,
    private readonly world: World,
  ) {
    super();
    this.name = name;
  }
  async run(): Promise<AgentRunResult> {
    this.world.log.push(this.name);
    return this.effect(this.world);
  }
}

// Filho que SEMPRE lanca (testa tolerancia a falha).
class FailingChild extends Agent {
  readonly name: AgentName;
  constructor(name: AgentName, private readonly world: World) {
    super();
    this.name = name;
  }
  async run(): Promise<AgentRunResult> {
    this.world.log.push(this.name);
    throw new Error(`${this.name} explodiu`);
  }
}

// ------------------------------------------------------------
// Helpers de contexto.
// ------------------------------------------------------------
const silentLog: AgentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const fixedClock: Clock = { now: () => new Date('2026-06-10T12:00:00.000Z') };

function makeEnv(over?: Partial<AgentEnv>): AgentEnv {
  return {
    ENABLE_AGENTS: true,
    MAX_AD_BUDGET_BRL: 300,
    TARGET_DAILY_REVENUE_BRL: 1000,
    PUBLIC_BASE_URL: 'http://localhost:3001',
    CONTENT_MODEL: 'claude-sonnet-4-6',
    PLANNING_MODEL: 'claude-opus-4-8',
    ...over,
  };
}

function makeCtx(
  prisma: ReturnType<typeof makeFakePrisma>,
  ports: Ports,
  envOver?: Partial<AgentEnv>,
): AgentContext {
  return {
    prisma: prisma as unknown as AgentContext['prisma'],
    ports,
    env: makeEnv(envOver),
    log: silentLog,
    clock: fixedClock,
    cycleId: 'cycle_test',
  };
}

// launchEbook STUB (pipeline de lancamento): substitui a geracao "crua" de
// CONTENT. Muta o World como o CONTENT child fazia (w.ebooks += 1) e registra o
// AgentRun do CONTENT no fake prisma (para manter a contagem de 7 runs do ciclo).
function makeLaunchStub(
  world: World,
  prisma: ReturnType<typeof makeFakePrisma>,
  opts?: { launched?: boolean },
) {
  return async (ctx: AgentContext) => {
    world.log.push('CONTENT');
    // Grava um AgentRun do CONTENT (o pipeline real grava via ciclo de vida do
    // ContentAgent; aqui simulamos para o teste de contagem).
    const run = await prisma.agentRun.create({
      data: { agent: 'CONTENT', status: 'RUNNING', cycleId: ctx.cycleId ?? null, startedAt: ctx.clock.now() },
    });
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'SUCCESS', finishedAt: ctx.clock.now(), durationMs: 0 },
    });
    const launched = opts?.launched ?? true;
    if (launched) world.ebooks += 1;
    return {
      launched,
      stage: launched ? ('PUBLISHED' as const) : ('QUALITY_GATE' as const),
      reason: launched ? 'lancado (stub)' : 'reprovado no QA (stub)',
      fixIterations: 0,
    };
  };
}

// Monta o registry com a pipeline completa, simulando o negocio.
// NOTA: CONTENT NAO entra no registry — ele e tratado pelo pipeline de
// lancamento (launchEbook), injetado no OrchestratorAgent.
function makeFullPipeline(world: World) {
  const registry = new Map<AgentName, Agent>();
  registry.set('SALES', new StubChild('SALES', (w) => {
    // venda simulada: 25 pedidos a R$47
    w.paidOrders += 25;
    w.revenueCents += 25 * 4700;
    return { status: 'SUCCESS', metrics: { paid: 25 } };
  }, world));
  registry.set('SOCIAL', new StubChild('SOCIAL', () => ({ status: 'SUCCESS' }), world));
  registry.set('TRAFFIC', new StubChild('TRAFFIC', (w) => {
    w.spendCents += 20_000; // R$200 de spend
    return { status: 'SUCCESS', metrics: { spendCents: 20_000 } };
  }, world));
  registry.set('DELIVERY', new StubChild('DELIVERY', (w) => {
    w.delivered += w.paidOrders;
    return { status: 'SUCCESS', metrics: { delivered: w.delivered } };
  }, world));
  registry.set('ANALYTICS', new StubChild('ANALYTICS', () => ({ status: 'SUCCESS' }), world));
  return registry;
}

// readKpi deterministico derivado do World.
function kpiFromWorld(world: World, env: AgentEnv): KPISnapshot {
  const targetRevenueCents = env.TARGET_DAILY_REVENUE_BRL * 100;
  const roas = world.spendCents > 0 ? world.revenueCents / world.spendCents : undefined;
  return {
    date: '2026-06-10',
    revenueCents: world.revenueCents,
    spendCents: world.spendCents,
    profitCents: world.revenueCents - world.spendCents,
    llmCostCents: 0,
    paidOrders: world.paidOrders,
    roas,
    targetRevenueCents,
    metTarget: world.revenueCents >= targetRevenueCents,
  };
}

// ============================================================
// TESTES
// ============================================================
describe('OrchestratorAgent — ciclo completo end-to-end (stubs)', () => {
  it('roda a pipeline inteira na ordem e grava AgentRun do ciclo', async () => {
    const world = newWorld();
    const prisma = makeFakePrisma();
    const ports = makeStubPorts();
    const ctx = makeCtx(prisma, ports);

    const orchestrator = new OrchestratorAgent({
      registry: makeFullPipeline(world),
      readKpi: async () => kpiFromWorld(world, ctx.env),
      launchEbook: makeLaunchStub(world, prisma),
    });

    const record = await orchestrator.execute(ctx);

    // Ciclo do ORCHESTRATOR gravado com SUCCESS.
    expect(record.status).toBe('SUCCESS');
    expect(record.agent).toBe('ORCHESTRATOR');

    // Todos os 6 filhos rodaram (1 ebook gerado, vendas, entrega).
    expect(world.ebooks).toBe(1);
    expect(world.paidOrders).toBe(25);
    expect(world.delivered).toBe(25);
    expect(new Set(world.log)).toEqual(new Set(CYCLE_ORDER));

    // AgentRun: 1 do orchestrator + 6 dos filhos = 7 registros.
    expect(prisma._rows.length).toBe(7);
    const success = prisma._rows.filter((r) => r.status === 'SUCCESS');
    expect(success.length).toBe(7);
  });

  it('tolera um filho que falha sem derrubar o ciclo', async () => {
    const world = newWorld();
    const prisma = makeFakePrisma();
    const ports = makeStubPorts();
    const ctx = makeCtx(prisma, ports);

    const registry = makeFullPipeline(world);
    registry.set('TRAFFIC', new FailingChild('TRAFFIC', world)); // TRAFFIC explode

    const orchestrator = new OrchestratorAgent({
      registry,
      readKpi: async () => kpiFromWorld(world, ctx.env),
      launchEbook: makeLaunchStub(world, prisma),
    });

    const record = await orchestrator.execute(ctx);

    // O ciclo ainda conclui com SUCCESS (CEO tolera filho com falha).
    expect(record.status).toBe('SUCCESS');
    // Entrega ainda aconteceu mesmo com TRAFFIC falhando.
    expect(world.delivered).toBe(25);
    // Exatamente um AgentRun FAILED (o TRAFFIC).
    const failed = prisma._rows.filter((r) => r.status === 'FAILED');
    expect(failed.length).toBe(1);
    expect(failed[0]?.agent).toBe('TRAFFIC');
  });

  it('executa filhos em ordem de prioridade decrescente', async () => {
    const world = newWorld();
    const prisma = makeFakePrisma();
    const ports = makeStubPorts();
    const ctx = makeCtx(prisma, ports);

    // readKpi sem receita -> guardrail needsContent => CONTENT vira prioridade alta.
    const orchestrator = new OrchestratorAgent({
      registry: makeFullPipeline(world),
      readKpi: async () => kpiFromWorld(newWorld(), ctx.env), // mundo vazio p/ KPI
      launchEbook: makeLaunchStub(world, prisma),
    });

    // LLM falha de proposito -> plano deterministico (prioridades guardrail-aware).
    const ctxFail = makeCtx(prisma, makeStubPorts({ failLlm: true }));
    const orch2 = new OrchestratorAgent({
      registry: makeFullPipeline(world),
      readKpi: async () => kpiFromWorld(newWorld(), ctxFail.env),
      launchEbook: makeLaunchStub(world, prisma),
    });
    await orch2.execute(ctxFail);

    // No plano deterministico sem receita: DELIVERY(90) e CONTENT(95) no topo,
    // TRAFFIC rebaixado (sem ROAS). CONTENT deve rodar antes de ANALYTICS.
    const idxContent = world.log.indexOf('CONTENT');
    const idxAnalytics = world.log.indexOf('ANALYTICS');
    expect(idxContent).toBeGreaterThanOrEqual(0);
    expect(idxContent).toBeLessThan(idxAnalytics);
    // suppress unused warning for first orchestrator
    expect(orchestrator).toBeDefined();
  });

  it('marca SKIPPED para agente da pipeline nao registrado', async () => {
    const world = newWorld();
    const prisma = makeFakePrisma();
    const ports = makeStubPorts();
    const ctx = makeCtx(prisma, ports);

    const registry = makeFullPipeline(world);
    registry.delete('SOCIAL'); // SOCIAL ausente

    const orchestrator = new OrchestratorAgent({
      registry,
      readKpi: async () => kpiFromWorld(world, ctx.env),
      launchEbook: makeLaunchStub(world, prisma),
    });

    const record = await orchestrator.execute(ctx);
    expect(record.status).toBe('SUCCESS');
    // SOCIAL nao rodou (nao esta no log de execucao).
    expect(world.log).not.toContain('SOCIAL');
  });

  it('usa plano deterministico quando o LLM de planejamento falha', async () => {
    const world = newWorld();
    const prisma = makeFakePrisma();
    const ports = makeStubPorts({ failLlm: true });
    const ctx = makeCtx(prisma, ports);

    const orchestrator = new OrchestratorAgent({
      registry: makeFullPipeline(world),
      readKpi: async () => kpiFromWorld(world, ctx.env),
      launchEbook: makeLaunchStub(world, prisma),
    });

    const record = await orchestrator.execute(ctx);
    expect(record.status).toBe('SUCCESS');
    // Pipeline ainda roda inteira via fallback deterministico.
    expect(new Set(world.log)).toEqual(new Set(CYCLE_ORDER));
  });
});

// ============================================================
// Guardrails e planos (unidades puras)
// ============================================================
describe('guardrails deterministicos', () => {
  const env = makeEnv();
  const baseKpi: KPISnapshot = {
    date: '2026-06-10',
    revenueCents: 0,
    spendCents: 0,
    profitCents: 0,
    llmCostCents: 0,
    paidOrders: 0,
    targetRevenueCents: 100_000,
    metTarget: false,
  };
  const ctx = { env } as unknown as AgentContext;

  it('needsContent=true quando nao ha receita', () => {
    const g = computeGuardrails(baseKpi, ctx);
    expect(g.needsContent).toBe(true);
    expect(g.mode).toBe('GROW');
  });

  it('canScaleAds=false quando ROAS abaixo do limiar', () => {
    const kpi: KPISnapshot = { ...baseKpi, revenueCents: 5_000, spendCents: 10_000, roas: 0.5, paidOrders: 2 };
    const g = computeGuardrails(kpi, ctx);
    expect(g.canScaleAds).toBe(false);
  });

  it('canScaleAds=true com ROAS saudavel e budget sob o teto', () => {
    const kpi: KPISnapshot = { ...baseKpi, revenueCents: 30_000, spendCents: 10_000, roas: 3, paidOrders: 5 };
    const g = computeGuardrails(kpi, ctx);
    expect(g.canScaleAds).toBe(true);
  });

  it('canScaleAds=false quando spend atinge o teto de budget', () => {
    // teto = 300 BRL = 30000 centavos
    const kpi: KPISnapshot = { ...baseKpi, revenueCents: 100_000, spendCents: 30_000, roas: 3.3, paidOrders: 10 };
    const g = computeGuardrails(kpi, ctx);
    expect(g.canScaleAds).toBe(false);
  });

  it('mode=SUSTAIN quando a meta e atingida', () => {
    const kpi: KPISnapshot = { ...baseKpi, revenueCents: 120_000, metTarget: true, paidOrders: 30 };
    const g = computeGuardrails(kpi, ctx);
    expect(g.mode).toBe('SUSTAIN');
  });
});

describe('planos', () => {
  const g: Guardrails = {
    mode: 'GROW',
    maxAdBudgetCents: 30_000,
    canScaleAds: false,
    needsContent: true,
    metTarget: false,
  };

  it('deterministicPlan cobre toda a pipeline e prioriza CONTENT quando needsContent', () => {
    const plan = deterministicPlan(g);
    expect(plan.actions.map((a) => a.agent).sort()).toEqual([...CYCLE_ORDER].sort());
    const content = plan.actions.find((a) => a.agent === 'CONTENT');
    const traffic = plan.actions.find((a) => a.agent === 'TRAFFIC');
    expect(content?.priority).toBeGreaterThan(traffic?.priority ?? 0);
  });

  it('mergeWithPipeline inclui agentes ausentes e rebaixa TRAFFIC se nao pode escalar', () => {
    const partial = {
      mode: 'GROW' as const,
      rationale: 'parcial',
      actions: [{ agent: 'TRAFFIC' as AgentName, priority: 99, reason: 'quero escalar' }],
    };
    const merged = mergeWithPipeline(partial, g);
    // Todos os agentes da pipeline presentes.
    expect(merged.actions.map((a) => a.agent).sort()).toEqual([...CYCLE_ORDER].sort());
    // TRAFFIC rebaixado (guardrail canScaleAds=false).
    const traffic = merged.actions.find((a) => a.agent === 'TRAFFIC');
    expect(traffic?.priority).toBeLessThanOrEqual(30);
  });
});

// ============================================================
// Budget semanal de ebooks (guardrail async)
// ============================================================
describe('applyWeeklyEbookBudget', () => {
  function healthyGuardrails(): Guardrails {
    return {
      mode: 'SUSTAIN',
      maxAdBudgetCents: 30_000,
      canScaleAds: true,
      needsContent: false, // KPIs saudaveis: sem necessidade por receita
      metTarget: true,
    };
  }

  // Semana ISO de 2026-06-10 (quarta): segunda 2026-06-08 .. 2026-06-15 (BRT).
  function ctxWithRuns(
    prisma: ReturnType<typeof makeFakePrisma>,
    over?: Partial<AgentEnv>,
  ): AgentContext {
    return makeCtx(prisma, makeStubPorts(), { WEEKLY_EBOOK_TARGET: 3, ...over });
  }

  it('forca needsContent quando abaixo do target semanal (apesar de KPI saudavel)', async () => {
    const prisma = makeFakePrisma();
    const ctx = ctxWithRuns(prisma);
    const g = healthyGuardrails();

    const res = await applyWeeklyEbookBudget(ctx, g);
    expect(res.weekEbooks).toBe(0);
    expect(res.target).toBe(3);
    expect(res.forced).toBe(true);
    expect(g.needsContent).toBe(true);
  });

  it('NAO forca quando o target semanal ja foi batido', async () => {
    const prisma = makeFakePrisma();
    // 3 CONTENT runs SUCCESS dentro da semana ISO corrente.
    for (let i = 0; i < 3; i += 1) {
      prisma._rows.push({
        id: `seed_${i}`,
        agent: 'CONTENT',
        status: 'SUCCESS',
        cycleId: null,
        startedAt: new Date('2026-06-09T10:00:00.000Z'),
        finishedAt: new Date('2026-06-09T10:01:00.000Z'),
        durationMs: 60_000,
        costCents: 0,
      });
    }
    const ctx = ctxWithRuns(prisma);
    const g = healthyGuardrails();

    const res = await applyWeeklyEbookBudget(ctx, g);
    expect(res.weekEbooks).toBe(3);
    expect(res.forced).toBe(false);
    expect(g.needsContent).toBe(false);
  });

  it('ignora CONTENT runs FORA da semana ISO corrente', async () => {
    const prisma = makeFakePrisma();
    // Run de uma semana anterior (2026-06-01) — nao conta.
    prisma._rows.push({
      id: 'old',
      agent: 'CONTENT',
      status: 'SUCCESS',
      cycleId: null,
      startedAt: new Date('2026-06-01T10:00:00.000Z'),
      finishedAt: new Date('2026-06-01T10:01:00.000Z'),
      durationMs: 60_000,
      costCents: 0,
    });
    const ctx = ctxWithRuns(prisma);
    const g = healthyGuardrails();

    const res = await applyWeeklyEbookBudget(ctx, g);
    expect(res.weekEbooks).toBe(0);
    expect(g.needsContent).toBe(true);
  });
});

describe('isoWeekBoundsSaoPaulo', () => {
  it('quarta 2026-06-10 cai na semana ISO de segunda 2026-06-08 (BRT)', () => {
    const { start, end } = isoWeekBoundsSaoPaulo(new Date('2026-06-10T12:00:00.000Z'));
    // Segunda 2026-06-08 00:00 BRT = 03:00 UTC.
    expect(start.toISOString()).toBe('2026-06-08T03:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-15T03:00:00.000Z');
  });
});
