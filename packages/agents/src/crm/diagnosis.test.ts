// Testes do motor de DIAGNOSTICO (diagnosis).
//  - runRules (puro): elege o ProblemType primario por setor.
//  - RuleDiagnosisEngine.diagnose com Prisma fake + StubLLMAdapter:
//      * setor HEALTHY => sem problema persistido + auto-cura.
//      * setor CRITICAL => cria Problem OPEN com causa raiz (LLM), idempotente.

import { describe, it, expect, vi } from 'vitest';
import { StubLLMAdapter } from '@ebook-empire/adapters';
import { statusFromScore, type SectorHealth, type Json } from '@ebook-empire/core';

import type { AgentContext } from '../base.js';
import { RuleDiagnosisEngine, runRules } from './diagnosis.js';

// ============================================================
// runRules (puro)
// ============================================================
describe('runRules', () => {
  it('DELIVERY com backlog => DELIVERY_BACKLOG', () => {
    const hit = runRules('DELIVERY', {
      pendingDeliveries: 4,
      failedRunsToday: 0,
      subscores: { backlog: 20, op: 60 },
    });
    expect(hit?.type).toBe('DELIVERY_BACKLOG');
    expect(hit?.suggestedActionKinds).toContain('RETRY_DELIVERIES');
  });

  it('DELIVERY com falhas tem prioridade sobre backlog', () => {
    const hit = runRules('DELIVERY', { pendingDeliveries: 4, failedRunsToday: 2 });
    expect(hit?.type).toBe('DELIVERY_FAILURES');
  });

  it('CONTENT sem catalogo => EMPTY_CATALOG', () => {
    const hit = runRules('CONTENT', {
      publishedWithActiveProduct: 0,
      runsToday: 0,
      failedRunsToday: 0,
    });
    expect(hit?.type).toBe('EMPTY_CATALOG');
    expect(hit?.suggestedActionKinds).toContain('GENERATE_EBOOK');
  });

  it('TRAFFIC com ROAS negativo => NEGATIVE_ROAS', () => {
    const hit = runRules('TRAFFIC', {
      activeCampaigns: 1,
      spendCents: 10000,
      attributedRevenueCents: 3000,
      maxAdBudgetCents: 30000,
    });
    expect(hit?.type).toBe('NEGATIVE_ROAS');
  });

  it('setor sem condicao de problema => null', () => {
    expect(runRules('DELIVERY', { pendingDeliveries: 0, failedRunsToday: 0 })).toBeNull();
  });
});

// ============================================================
// RuleDiagnosisEngine.diagnose
// ============================================================
function makeFakePrisma() {
  const problems: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const updateManyCalls: Array<Record<string, unknown>> = [];

  const ACTIVE = ['OPEN', 'DIAGNOSING', 'REMEDIATING'];

  const prisma = {
    problem: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        const statusIn = (w.status as { in?: string[] })?.in ?? ACTIVE;
        return (
          problems.find(
            (p) =>
              p.sector === w.sector &&
              p.type === w.type &&
              statusIn.includes(p.status as string),
          ) ?? null
        );
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: `prob-${problems.length + 1}`, ...args.data };
        problems.push(row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const p = problems.find((x) => x.id === args.where.id);
        if (p) Object.assign(p, args.data);
        updates.push(args.data);
        return p;
      }),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updateManyCalls.push(args);
        const statusIn = (args.where.status as { in?: string[] })?.in ?? ACTIVE;
        let count = 0;
        for (const p of problems) {
          if (p.sector === args.where.sector && statusIn.includes(p.status as string)) {
            Object.assign(p, args.data);
            count += 1;
          }
        }
        return { count };
      }),
    },
  };

  return { prisma, problems, updates, updateManyCalls };
}

function makeCtx(prisma: unknown): AgentContext {
  const fixedNow = new Date('2026-06-10T15:00:00.000Z');
  return {
    prisma: prisma as AgentContext['prisma'],
    ports: { llm: new StubLLMAdapter() } as unknown as AgentContext['ports'],
    env: {
      ENABLE_AGENTS: true,
      MAX_AD_BUDGET_BRL: 300,
      TARGET_DAILY_REVENUE_BRL: 1000,
      PUBLIC_BASE_URL: 'http://localhost:3001',
      CONTENT_MODEL: 'claude-sonnet-4-6',
      PLANNING_MODEL: 'claude-opus-4-8',
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clock: { now: () => fixedNow },
  };
}

function health(sector: SectorHealth['sector'], score: number, kpis: Json): SectorHealth {
  return { sector, score, status: statusFromScore(score), kpis };
}

describe('RuleDiagnosisEngine.diagnose', () => {
  it('setor HEALTHY: nao cria Problem e resolve ativos (auto-cura)', async () => {
    const { prisma, problems, updateManyCalls } = makeFakePrisma();
    // problema antigo aberto que deve ser auto-resolvido.
    problems.push({ id: 'prob-old', sector: 'DELIVERY', type: 'DELIVERY_BACKLOG', status: 'OPEN' });
    const ctx = makeCtx(prisma);

    const d = await new RuleDiagnosisEngine().diagnose(
      ctx,
      'DELIVERY',
      health('DELIVERY', 90, { pendingDeliveries: 0, hasSignal: true, subscores: { backlog: 100, op: 100 } }),
    );

    expect(d.confidence).toBe(0); // sem problema acionavel
    expect(prisma.problem.create).not.toHaveBeenCalled();
    // auto-cura disparou updateMany resolvendo o problema antigo.
    expect(updateManyCalls).toHaveLength(1);
    expect(problems.find((p) => p.id === 'prob-old')!.status).toBe('RESOLVED');
  });

  it('setor CRITICAL: cria Problem OPEN com causa raiz (LLM) e evidencias', async () => {
    const { prisma, problems } = makeFakePrisma();
    const ctx = makeCtx(prisma);

    const d = await new RuleDiagnosisEngine().diagnose(
      ctx,
      'DELIVERY',
      health('DELIVERY', 10, {
        pendingDeliveries: 6,
        failedRunsToday: 0,
        hasSignal: true,
        subscores: { backlog: 0, op: 60 },
      }),
    );

    expect(d.type).toBe('DELIVERY_BACKLOG');
    expect(d.severity).toBe(90); // 100 - 10
    expect(d.source).toBe('LLM'); // StubLLMAdapter retorna texto => enriquecido
    expect(d.rootCause.length).toBeGreaterThan(0);
    expect(d.suggestedActionKinds).toContain('RETRY_DELIVERIES');

    expect(prisma.problem.create).toHaveBeenCalledOnce();
    expect(problems).toHaveLength(1);
    expect(problems[0]!.status).toBe('OPEN');
    expect(problems[0]!.sector).toBe('DELIVERY');
  });

  it('idempotente: segundo diagnostico do mesmo sector/type atualiza, nao duplica', async () => {
    const { prisma, problems } = makeFakePrisma();
    const ctx = makeCtx(prisma);
    const engine = new RuleDiagnosisEngine();
    const h = health('DELIVERY', 10, {
      pendingDeliveries: 6,
      failedRunsToday: 0,
      hasSignal: true,
      subscores: { backlog: 0, op: 60 },
    });

    await engine.diagnose(ctx, 'DELIVERY', h);
    await engine.diagnose(ctx, 'DELIVERY', h);

    expect(prisma.problem.create).toHaveBeenCalledOnce(); // criou so uma vez
    expect(prisma.problem.update).toHaveBeenCalledOnce(); // segundo apenas atualizou
    expect(problems).toHaveLength(1);
  });
});
