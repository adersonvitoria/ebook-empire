// Testes do framework de TIMES (SectorTeam: assess -> strategize -> execute)
// com LLM stub e bindings stub. Cobre:
//   - ciclo completo grava 3 AgentRun (1 por papel) com role+sector;
//   - tolerancia a falha do executor (capability que lanca) sem derrubar o time;
//   - fallback deterministico quando o LLM falha (source RULES);
//   - 1-2 configs do registry dos 7 setores (binding aciona o Agent concreto).
//
// Sem banco real: fake minimo de PrismaClient (apenas agentRun, com role/sector).

import { describe, it, expect, vi } from 'vitest';
import type { AgentName, Ports } from '@ebook-empire/core';
import {
  Agent,
  type AgentContext,
  type AgentRunResult,
  type AgentEnv,
  type AgentLogger,
  type Clock,
} from '../base.js';
import { SectorTeam } from './sector-team.js';
import { buildSectorRegistry, type SectorConfig } from './sector-config.js';

// ------------------------------------------------------------
// Fake PrismaClient — so agentRun, guardando role/sector.
// ------------------------------------------------------------
interface FakeRun {
  id: string;
  agent: AgentName;
  role: string | null;
  sector: string | null;
  status: string;
  cycleId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  output: unknown;
  error: string | null;
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
          role: data.role ?? null,
          sector: data.sector ?? null,
          status: data.status ?? 'RUNNING',
          cycleId: data.cycleId ?? null,
          startedAt: data.startedAt ?? new Date(),
          finishedAt: null,
          durationMs: null,
          output: null,
          error: null,
        };
        rows.push(row);
        return { id: row.id };
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<FakeRun> }) => {
          const row = rows.find((r) => r.id === where.id);
          if (!row) throw new Error(`run ${where.id} nao encontrado`);
          Object.assign(row, data);
          return { id: row.id };
        },
      ),
    },
    _rows: rows,
  };
  return prisma;
}

// ------------------------------------------------------------
// LLM stub que devolve um Assessment e uma Strategy validos.
// ------------------------------------------------------------
function makeLlm(opts?: { fail?: boolean }): Ports['llm'] {
  return {
    generateText: vi.fn(),
    generateJson: vi.fn(async <T>(input: { parse: (raw: unknown) => T; system?: string }) => {
      if (opts?.fail) throw new Error('llm indisponivel');
      // Decide o formato pelo system prompt (ESPECIALISTA vs ESTRATEGISTA).
      const isStrategist = (input.system ?? '').includes('ESTRATEGISTA');
      const raw = isStrategist
        ? {
            sector: 'CONTENT',
            objective: 'Crescer catalogo',
            mode: 'GROW',
            actions: [
              { capability: 'generateEbook', priority: 90, params: {}, reason: 'gerar ebook' },
            ],
            successCriteria: ['score >= 70'],
            rationale: 'precisamos de catalogo',
          }
        : {
            sector: 'CONTENT',
            healthScore: 30,
            status: 'CRITICAL',
            findings: ['catalogo vazio'],
            risks: ['sem receita'],
            opportunities: ['gerar ebooks'],
            evidence: {},
            confidence: 0.8,
            source: 'LLM',
          };
      return {
        data: input.parse(raw),
        usage: { inputTokens: 50, outputTokens: 30, costCents: 2 },
      };
    }),
  } as unknown as Ports['llm'];
}

function makePorts(llm: Ports['llm']): Ports {
  return {
    llm,
    payment: {} as Ports['payment'],
    email: {} as Ports['email'],
    storage: {} as Ports['storage'],
    instagram: {} as Ports['instagram'],
    ads: {} as Ports['ads'],
  };
}

const silentLog: AgentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
const clock: Clock = { now: () => new Date('2026-06-10T12:00:00.000Z') };

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

function makeCtx(prisma: ReturnType<typeof makeFakePrisma>, ports: Ports): AgentContext {
  return {
    prisma: prisma as unknown as AgentContext['prisma'],
    ports,
    env: makeEnv(),
    log: silentLog,
    clock,
    cycleId: 'cycle_team_test',
  };
}

// Agente stub que apenas grava seu AgentRun via ciclo de vida real.
class StubChild extends Agent {
  readonly name: AgentName;
  constructor(name: AgentName, private readonly result: AgentRunResult) {
    super();
    this.name = name;
  }
  async run(): Promise<AgentRunResult> {
    return this.result;
  }
}

// Config de teste: setor CONTENT, KPI fixo, 1 capability que aciona um stub.
function makeContentConfig(opts?: {
  health?: { score: number };
  childResult?: AgentRunResult;
  childThrows?: boolean;
}): SectorConfig {
  return {
    sector: 'CONTENT',
    agentName: 'CONTENT',
    specialistSystem: 'Voce e o ESPECIALISTA do setor CONTEUDO.',
    strategistSystem: 'Voce e o ESTRATEGISTA do setor CONTEUDO.',
    readHealth: async () => ({ score: opts?.health?.score ?? 30, kpis: { publishedWithActiveProduct: 0 } }),
    executorBindings: {
      generateEbook: async (ctx) => {
        if (opts?.childThrows) throw new Error('content explodiu');
        const child = new StubChild('CONTENT', opts?.childResult ?? { status: 'SUCCESS' });
        const rec = await child.execute(ctx);
        return { status: rec.status === 'FAILED' ? 'FAILED' : 'SUCCESS', agentRunId: rec.id };
      },
    },
  };
}

describe('SectorTeam — assess -> strategize -> execute (stubs)', () => {
  it('roda o ciclo completo e grava 1 AgentRun por papel (role+sector)', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma, makePorts(makeLlm()));
    const team = new SectorTeam(makeContentConfig());

    const result = await team.run(ctx);

    expect(result.sector).toBe('CONTENT');
    expect(result.assessment.source).toBe('LLM');
    expect(result.assessment.status).toBe('CRITICAL'); // score 30 -> CRITICAL
    expect(result.strategy.actions.length).toBeGreaterThan(0);
    expect(result.outcome.succeeded).toBe(1);
    expect(result.failedRoles).toEqual([]);

    // 3 papeis (SPECIALIST/STRATEGIST/EXECUTOR) + 1 do agente filho (CONTENT.execute).
    const roleRuns = prisma._rows.filter((r) => r.role !== null);
    expect(roleRuns.map((r) => r.role).sort()).toEqual(['EXECUTOR', 'SPECIALIST', 'STRATEGIST']);
    expect(roleRuns.every((r) => r.sector === 'CONTENT')).toBe(true);
    expect(roleRuns.every((r) => r.status === 'SUCCESS')).toBe(true);
  });

  it('forca status a partir do score real mesmo se o LLM divergir', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma, makePorts(makeLlm()));
    // health saudavel (score 90) -> status deve virar HEALTHY apesar do LLM dizer CRITICAL.
    const team = new SectorTeam(makeContentConfig({ health: { score: 90 } }));
    const result = await team.run(ctx);
    expect(result.assessment.healthScore).toBe(90);
    expect(result.assessment.status).toBe('HEALTHY');
  });

  it('usa fallback deterministico (RULES) quando o LLM falha', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma, makePorts(makeLlm({ fail: true })));
    const team = new SectorTeam(makeContentConfig());

    const result = await team.run(ctx);

    expect(result.assessment.source).toBe('RULES');
    // O fallback da Strategy aciona todas as capabilities do binding.
    expect(result.strategy.actions.map((a) => a.capability)).toContain('generateEbook');
    expect(result.outcome.succeeded).toBe(1);
    expect(result.failedRoles).toEqual([]);
  });

  it('tolera capability que lanca: outcome marca FAILED, time nao derruba', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma, makePorts(makeLlm()));
    const team = new SectorTeam(makeContentConfig({ childThrows: true }));

    const result = await team.run(ctx);

    expect(result.outcome.failed).toBe(1);
    expect(result.outcome.succeeded).toBe(0);
    // O papel EXECUTOR ainda grava SUCCESS (o erro e por-acao, capturado no outcome).
    const executorRun = prisma._rows.find((r) => r.role === 'EXECUTOR');
    expect(executorRun?.status).toBe('SUCCESS');
  });
});

describe('buildSectorRegistry — config dos 7 setores', () => {
  it('cobre os 7 setores com agentName e ao menos 1 capability cada', () => {
    const reg = buildSectorRegistry();
    const sectors = Object.keys(reg).sort();
    expect(sectors).toEqual(
      ['ANALYTICS', 'CONTENT', 'DELIVERY', 'ORCHESTRATION', 'SALES', 'SOCIAL', 'TRAFFIC'].sort(),
    );
    for (const cfg of Object.values(reg)) {
      expect(Object.keys(cfg.executorBindings).length).toBeGreaterThan(0);
      expect(cfg.agentName).toBeTruthy();
    }
    expect(reg.CONTENT.executorBindings.generateEbook).toBeTypeOf('function');
    expect(reg.ORCHESTRATION.agentName).toBe('ORCHESTRATOR');
  });

  it('binding de agente aciona o Agent resolvido via deps.makeAgent', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma, makePorts(makeLlm()));
    const reg = buildSectorRegistry({
      readSectorHealth: async (_ctx, sector) => ({ sector, score: 50, status: 'WARNING', kpis: {} }),
      makeAgent: (name) => new StubChild(name, { status: 'SUCCESS' }),
    });
    const team = new SectorTeam(reg.SALES);
    const result = await team.run(ctx);
    expect(result.outcome.succeeded).toBe(1);
    // o agente SALES foi acionado (AgentRun proprio gravado).
    expect(prisma._rows.some((r) => r.agent === 'SALES' && r.role === null)).toBe(true);
  });
});
