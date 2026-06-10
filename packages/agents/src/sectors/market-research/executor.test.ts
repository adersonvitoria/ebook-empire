// Testes do MarketExecutor — persistencia + FILTRO DE RECENCIA.
// Foca no comportamento novo (FASE 2): pular nichos USED recentemente.
// Fake de PrismaClient em memoria (apenas marketOpportunity + event).

import { describe, it, expect, vi } from 'vitest';
import type { MarketOpportunity } from '@ebook-empire/core';
import type { AgentContext, AgentEnv, Clock } from '../../base.js';
import { MarketExecutor } from './executor.js';

interface Row {
  id: string;
  [key: string]: unknown;
}

// now fixo: 2026-06-10. Janela default = 14 dias => corte em 2026-05-27.
const clock: Clock = { now: () => new Date('2026-06-10T12:00:00.000Z') };

function makeFakePrisma(usedRows: Array<{ niche: string; updatedAt: Date }> = []) {
  const opportunities: Row[] = [];
  const events: Row[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}_${++seq}`;
  // Linhas USED pre-existentes (para o filtro de recencia consultar).
  const used = usedRows.map((u, i) => ({
    id: `used_${i}`,
    niche: u.niche,
    status: 'USED' as const,
    updatedAt: u.updatedAt,
  }));

  return {
    _opportunities: opportunities,
    _events: events,
    marketOpportunity: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = clock.now();
        const row: Row = { id: nextId('opp'), createdAt: now, updatedAt: now, usedByEbookId: null, ...data };
        opportunities.push(row);
        return row;
      }),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where?: { status?: string; updatedAt?: { gt?: Date } };
        } = {}) => {
          return used.filter((r) => {
            if (where?.status && r.status !== where.status) return false;
            if (where?.updatedAt?.gt && !(r.updatedAt > where.updatedAt.gt)) return false;
            return true;
          });
        },
      ),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId('event'), ...data };
        events.push(row);
        return row;
      }),
    },
  };
}

function makeEnv(): AgentEnv {
  return {
    ENABLE_AGENTS: true,
    MAX_AD_BUDGET_BRL: 300,
    TARGET_DAILY_REVENUE_BRL: 1000,
    PUBLIC_BASE_URL: 'http://localhost:3001',
    CONTENT_MODEL: 'claude-sonnet-4-6',
    PLANNING_MODEL: 'claude-opus-4-8',
    MARKET_RESEARCH_WINDOW_DAYS: 14,
  };
}

function makeCtx(prisma: ReturnType<typeof makeFakePrisma>): AgentContext {
  return {
    prisma: prisma as never,
    ports: {} as never,
    env: makeEnv(),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    clock,
  };
}

function opp(niche: string, potentialScore: number): MarketOpportunity {
  return {
    segment: 'Seg',
    niche,
    demandScore: 50,
    competitionScore: 30,
    potentialScore,
    rationale: 'r',
    titleIdeas: ['t'],
    angles: ['a'],
    evidence: ['e'],
  };
}

describe('MarketExecutor.persist — filtro de recencia', () => {
  it('persiste todas quando nao ha nichos USED recentes', async () => {
    const prisma = makeFakePrisma([]);
    const ctx = makeCtx(prisma);
    const records = await new MarketExecutor().persist(ctx, [opp('Yoga', 80), opp('Financas', 60)]);
    expect(records.length).toBe(2);
    expect(prisma._opportunities.length).toBe(2);
  });

  it('pula nicho USED dentro da janela (case-insensitive)', async () => {
    const prisma = makeFakePrisma([
      { niche: 'yoga', updatedAt: new Date('2026-06-05T00:00:00.000Z') }, // dentro de 14d
    ]);
    const ctx = makeCtx(prisma);
    const records = await new MarketExecutor().persist(ctx, [opp('Yoga', 80), opp('Financas', 60)]);
    // Yoga foi pulado; so Financas persiste e fica SELECTED.
    expect(records.map((r) => r.niche)).toEqual(['Financas']);
    expect(records[0]!.status).toBe('SELECTED');
  });

  it('NAO pula nicho USED fora da janela (mais de 14 dias)', async () => {
    const prisma = makeFakePrisma([
      { niche: 'Yoga', updatedAt: new Date('2026-05-01T00:00:00.000Z') }, // > 14 dias
    ]);
    const ctx = makeCtx(prisma);
    const records = await new MarketExecutor().persist(ctx, [opp('Yoga', 80)]);
    expect(records.map((r) => r.niche)).toEqual(['Yoga']);
  });

  it('retorna vazio (sem Event) quando todos os candidatos foram usados recentemente', async () => {
    const prisma = makeFakePrisma([
      { niche: 'Yoga', updatedAt: new Date('2026-06-05T00:00:00.000Z') },
    ]);
    const ctx = makeCtx(prisma);
    const records = await new MarketExecutor().persist(ctx, [opp('Yoga', 80)]);
    expect(records.length).toBe(0);
    expect(prisma._opportunities.length).toBe(0);
    expect(prisma._events.length).toBe(0);
  });
});
