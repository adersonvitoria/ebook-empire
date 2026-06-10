// Teste do conserto gatherContentContext() em gatherActionContext (COO-Scale):
// um setor CONTENT degradado deve popular Problem.metadata.niche/count a partir
// da MarketOpportunity PENDING de MAIOR potentialScore + velocidade do nicho.

import { describe, it, expect, vi } from 'vitest';
import { StubLLMAdapter } from '@ebook-empire/adapters';
import { statusFromScore, type SectorHealth, type Json } from '@ebook-empire/core';
import type { AgentContext } from '../base.js';
import { RuleDiagnosisEngine } from './diagnosis.js';

function makeFakePrisma(opts: {
  opportunity: { id: string; niche: string; potentialScore: number } | null;
  nicheVelocity: number;
}) {
  const problems: Array<Record<string, unknown>> = [];
  const prisma = {
    problem: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: `prob-${problems.length + 1}`, ...args.data };
        problems.push(row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const p = problems.find((x) => x.id === args.where.id);
        if (p) Object.assign(p, args.data);
        return p;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    marketOpportunity: {
      findFirst: vi.fn(async (args: { where?: Record<string, unknown>; orderBy?: unknown }) => {
        expect(args.where?.status).toBe('PENDING');
        expect(args.orderBy).toEqual({ potentialScore: 'desc' });
        return opts.opportunity;
      }),
    },
    order: {
      count: vi.fn(async (args: { where?: Record<string, unknown> }) => {
        // valida o join Order -> Product -> Ebook.niche.
        expect(args.where?.product).toEqual({ ebook: { niche: opts.opportunity?.niche } });
        return opts.nicheVelocity;
      }),
    },
  };
  return { prisma, problems };
}

function makeCtx(prisma: unknown): AgentContext {
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
    clock: { now: () => new Date('2026-06-10T15:00:00.000Z') },
  };
}

function health(score: number, kpis: Json): SectorHealth {
  return { sector: 'CONTENT', score, status: statusFromScore(score), kpis };
}

describe('gatherContentContext (CONTENT)', () => {
  it('popula metadata.niche/count a partir da oportunidade PENDING de maior score', async () => {
    const { prisma, problems } = makeFakePrisma({
      opportunity: { id: 'opp-1', niche: 'Financas do zero', potentialScore: 88 },
      nicheVelocity: 2, // 2 vendas recentes no nicho => count = 1 + 2 = 3
    });
    const ctx = makeCtx(prisma);

    await new RuleDiagnosisEngine().diagnose(
      ctx,
      'CONTENT',
      health(10, {
        publishedWithActiveProduct: 0, // EMPTY_CATALOG
        runsToday: 0,
        failedRunsToday: 0,
        hasSignal: true,
        subscores: { pipeline: 0, stuck: 100, op: 60 },
      }),
    );

    expect(problems).toHaveLength(1);
    const meta = problems[0]!.metadata as Record<string, unknown>;
    expect(meta.niche).toBe('Financas do zero');
    expect(meta.opportunityId).toBe('opp-1');
    expect(meta.nicheVelocity7d).toBe(2);
    expect(meta.count).toBe(3);
  });

  it('sem oportunidade PENDING => metadata sem niche (catalogo nao propoe)', async () => {
    const { prisma, problems } = makeFakePrisma({ opportunity: null, nicheVelocity: 0 });
    const ctx = makeCtx(prisma);

    await new RuleDiagnosisEngine().diagnose(
      ctx,
      'CONTENT',
      health(10, {
        publishedWithActiveProduct: 0,
        runsToday: 0,
        failedRunsToday: 0,
        hasSignal: true,
        subscores: { pipeline: 0, stuck: 100, op: 60 },
      }),
    );

    const meta = problems[0]!.metadata as Record<string, unknown>;
    expect(meta.niche).toBeUndefined();
  });
});
