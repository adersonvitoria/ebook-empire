// Testes do setor MARKET_RESEARCH (ranking deterministico + service rankAndPick).
// Usa o StubMarketDataAdapter (sem rede) + StubLLMAdapter + fake de PrismaClient
// em memoria (apenas os modelos usados). Tudo deterministico.

import { describe, it, expect, vi } from 'vitest';
import { StubLLMAdapter, StubMarketDataAdapter } from '@ebook-empire/adapters';
import type { Ports } from '@ebook-empire/core';
import type { AgentContext, AgentEnv, Clock } from '../../base.js';
import {
  aggregateExternal,
  syntheticHealthScore,
  type NicheSignal,
} from './specialist.js';
import {
  MarketStrategist,
  scoreOpportunity,
  demandScoreOf,
  competitionScoreOf,
  potentialScoreOf,
} from './strategist.js';
import { MarketResearchService } from './service.js';

// ------------------------------------------------------------
// Fake de PrismaClient em memoria (agentRun/marketOpportunity/event/order/ebook).
// ------------------------------------------------------------
interface Row {
  id: string;
  [key: string]: unknown;
}

function makeFakePrisma() {
  const agentRuns: Row[] = [];
  const opportunities: Row[] = [];
  const events: Row[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}_${++seq}`;

  return {
    _agentRuns: agentRuns,
    _opportunities: opportunities,
    _events: events,

    agentRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId('run'), ...data };
        agentRuns.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = agentRuns.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },

    marketOpportunity: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date('2026-06-10T12:00:00.000Z');
        const row: Row = {
          id: nextId('opp'),
          usedByEbookId: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        opportunities.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where, take }: { where?: { status?: string }; take?: number }) => {
        let rows = [...opportunities];
        if (where?.status) rows = rows.filter((r) => r.status === where.status);
        rows.sort((a, b) => (b.potentialScore as number) - (a.potentialScore as number));
        return typeof take === 'number' ? rows.slice(0, take) : rows;
      }),
      findFirst: vi.fn(async ({ where }: { where?: { status?: string } }) => {
        let rows = [...opportunities];
        if (where?.status) rows = rows.filter((r) => r.status === where.status);
        rows.sort((a, b) => (b.potentialScore as number) - (a.potentialScore as number));
        return rows[0] ?? null;
      }),
    },

    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId('event'), ...data };
        events.push(row);
        return row;
      }),
    },

    // Sinais internos: por padrao sem vendas/catalogo.
    order: {
      aggregate: vi.fn(async () => ({ _sum: { priceCents: null }, _count: { _all: 0 } })),
    },
    ebook: {
      count: vi.fn(async () => 0),
    },
  };
}

function makePorts(): Ports {
  const ni = (n: string) => () => {
    throw new Error(`${n} nao deveria ser chamado`);
  };
  return {
    llm: new StubLLMAdapter(),
    marketData: new StubMarketDataAdapter(),
    payment: { createPixCharge: ni('payment'), getPayment: ni('payment'), parseWebhook: ni('payment') } as never,
    email: { send: ni('email') } as never,
    storage: { putObject: ni('storage'), getObject: ni('storage'), getSignedUrl: ni('storage') } as never,
    instagram: {
      publishPost: ni('ig'),
      uploadMedia: ni('ig'),
      getAccountInsights: ni('ig'),
      getPostInsights: ni('ig'),
    } as never,
    ads: { createCampaign: ni('ads'), updateBudget: ni('ads'), setStatus: ni('ads'), getInsights: ni('ads') } as never,
  };
}

const clock: Clock = { now: () => new Date('2026-06-10T12:00:00.000Z') };

function makeEnv(): AgentEnv {
  return {
    ENABLE_AGENTS: true,
    MAX_AD_BUDGET_BRL: 300,
    TARGET_DAILY_REVENUE_BRL: 1000,
    PUBLIC_BASE_URL: 'http://localhost:3001',
    CONTENT_MODEL: 'claude-sonnet-4-6',
    PLANNING_MODEL: 'claude-opus-4-8',
    MARKET_DATA_PROVIDER: 'stub',
    MARKET_SEARCH_GL: 'br',
    MARKET_SEARCH_HL: 'pt-br',
    MARKET_RESEARCH_WINDOW_DAYS: 14,
    MARKET_MAX_QUERIES_PER_RUN: 10,
  };
}

function makeCtx(prisma: ReturnType<typeof makeFakePrisma>): AgentContext {
  return {
    prisma: prisma as never,
    ports: makePorts(),
    env: makeEnv(),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    clock,
  };
}

// ============================================================
// Scoring deterministico (puro)
// ============================================================
describe('scoring de oportunidade (puro)', () => {
  const baseSignal = (over: Partial<NicheSignal> = {}): NicheSignal => ({
    segment: 'Seg',
    niche: 'Nicho',
    searches: [],
    external: { paaCount: 0, relatedCount: 0, organicCount: 0, knowledgeGraphHits: 0, queriesRun: 1 },
    internal: { revenueCents: 0, paidOrders: 0, publishedEbooks: 0 },
    ...over,
  });

  it('demanda sobe com peopleAlsoAsk e buscas relacionadas', () => {
    const low = demandScoreOf(baseSignal());
    const high = demandScoreOf(
      baseSignal({ external: { paaCount: 8, relatedCount: 12, organicCount: 0, knowledgeGraphHits: 0, queriesRun: 1 } }),
    );
    expect(high).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(60);
  });

  it('competicao sobe com muitos organicos e knowledgeGraph', () => {
    const low = competitionScoreOf(baseSignal());
    const high = competitionScoreOf(
      baseSignal({ external: { paaCount: 0, relatedCount: 0, organicCount: 10, knowledgeGraphHits: 1, queriesRun: 1 } }),
    );
    expect(high).toBeGreaterThan(low);
  });

  it('potencial premia demanda alta x competicao baixa', () => {
    const goodNiche = potentialScoreOf(80, 10, baseSignal());
    const crowdedNiche = potentialScoreOf(80, 90, baseSignal());
    expect(goodNiche).toBeGreaterThan(crowdedNiche);
  });

  it('da bonus de espaco livre quando nao ha catalogo proprio', () => {
    const open = potentialScoreOf(60, 30, baseSignal({ internal: { revenueCents: 0, paidOrders: 0, publishedEbooks: 0 } }));
    const saturated = potentialScoreOf(60, 30, baseSignal({ internal: { revenueCents: 0, paidOrders: 0, publishedEbooks: 3 } }));
    expect(open).toBeGreaterThan(saturated);
  });

  it('scoreOpportunity inclui evidencias de PAA', () => {
    const opp = scoreOpportunity(
      baseSignal({
        searches: [
          {
            query: 'q',
            totalOrganic: 5,
            organic: [],
            relatedSearches: ['rel-a'],
            peopleAlsoAsk: [{ question: 'Como comecar?' }],
            knowledgeGraphPresent: false,
          },
        ],
        external: { paaCount: 1, relatedCount: 1, organicCount: 5, knowledgeGraphHits: 0, queriesRun: 1 },
      }),
    );
    expect(opp.evidence.some((e) => e.includes('Como comecar?'))).toBe(true);
    expect(opp.titleIdeas.length).toBeGreaterThan(0);
  });
});

describe('aggregateExternal / syntheticHealthScore', () => {
  it('agrega sinais de varias buscas', () => {
    const agg = aggregateExternal([
      { query: 'a', totalOrganic: 5, organic: [], relatedSearches: ['x', 'y'], peopleAlsoAsk: [{ question: 'p?' }], knowledgeGraphPresent: true },
      { query: 'b', totalOrganic: 3, organic: [], relatedSearches: ['z'], peopleAlsoAsk: [], knowledgeGraphPresent: false },
    ]);
    expect(agg.organicCount).toBe(8);
    expect(agg.relatedCount).toBe(3);
    expect(agg.paaCount).toBe(1);
    expect(agg.knowledgeGraphHits).toBe(1);
    expect(agg.queriesRun).toBe(2);
  });

  it('health sintetico sobe com cobertura de demanda', () => {
    const empty = syntheticHealthScore([]);
    expect(empty).toBe(50);
  });
});

// ============================================================
// MarketStrategist.rank — ordenacao por potentialScore
// ============================================================
describe('MarketStrategist.rank', () => {
  it('retorna oportunidades ordenadas por potentialScore desc', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma);
    const strategist = new MarketStrategist();

    const signals: NicheSignal[] = [
      {
        segment: 'A',
        niche: 'baixo',
        searches: [],
        external: { paaCount: 1, relatedCount: 1, organicCount: 10, knowledgeGraphHits: 1, queriesRun: 1 },
        internal: { revenueCents: 0, paidOrders: 0, publishedEbooks: 3 },
      },
      {
        segment: 'B',
        niche: 'alto',
        searches: [],
        external: { paaCount: 8, relatedCount: 12, organicCount: 2, knowledgeGraphHits: 0, queriesRun: 1 },
        internal: { revenueCents: 0, paidOrders: 0, publishedEbooks: 0 },
      },
    ];

    const { opportunities } = await strategist.rank(ctx, signals);
    expect(opportunities[0]!.niche).toBe('alto');
    expect(opportunities[0]!.potentialScore).toBeGreaterThanOrEqual(opportunities[1]!.potentialScore);
  });
});

// ============================================================
// MarketResearchService — runTeam + rankAndPick (GATE 1)
// ============================================================
describe('MarketResearchService.rankAndPick', () => {
  it('roda o time, persiste e retorna a oportunidade de MAIOR potencial (SELECTED)', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma);
    const service = new MarketResearchService();

    const top = await service.rankAndPick(ctx);

    // GATE 1: deve retornar uma oportunidade.
    expect(top).not.toBeNull();
    expect(top!.status).toBe('SELECTED');

    // Persistiu varias oportunidades; o topo tem o maior potentialScore.
    const persisted = prisma._opportunities;
    expect(persisted.length).toBeGreaterThan(0);
    const maxPotential = Math.max(...persisted.map((o) => o.potentialScore as number));
    expect(top!.potentialScore).toBe(maxPotential);

    // Apenas o topo fica SELECTED; os demais PENDING.
    const selected = persisted.filter((o) => o.status === 'SELECTED');
    expect(selected).toHaveLength(1);

    // Gravou AgentRuns dos 3 papeis (SPECIALIST/STRATEGIST/EXECUTOR).
    const roles = prisma._agentRuns.map((r) => r.role);
    expect(roles).toContain('SPECIALIST');
    expect(roles).toContain('STRATEGIST');
    expect(roles).toContain('EXECUTOR');
    // Todos no setor MARKET_RESEARCH e agente MARKET_RESEARCH.
    expect(prisma._agentRuns.every((r) => r.sector === 'MARKET_RESEARCH')).toBe(true);
    expect(prisma._agentRuns.every((r) => r.agent === 'MARKET_RESEARCH')).toBe(true);

    // Emitiu o Event MARKET_OPPORTUNITY_RANKED.
    expect(prisma._events.some((e) => e.type === 'MARKET_OPPORTUNITY_RANKED')).toBe(true);
  });

  it('latestOpportunities e topOpportunity refletem o que foi persistido', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma);
    const service = new MarketResearchService();

    await service.rankAndPick(ctx);

    const latest = await service.latestOpportunities(ctx, { limit: 100 });
    expect(latest.length).toBe(prisma._opportunities.length);
    // ordenado por potentialScore desc
    for (let i = 1; i < latest.length; i += 1) {
      expect(latest[i - 1]!.potentialScore).toBeGreaterThanOrEqual(latest[i]!.potentialScore);
    }

    const top = await service.topOpportunity(ctx);
    expect(top).not.toBeNull();
    expect(top!.status).toBe('SELECTED');
  });

  it('falha claro (pt-BR) quando MarketDataPort esta ausente', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma);
    // Remove a MarketDataPort.
    (ctx.ports as { marketData?: unknown }).marketData = undefined;

    const service = new MarketResearchService();
    await expect(service.rankAndPick(ctx)).rejects.toThrow(/MarketDataPort ausente/);
  });
});
