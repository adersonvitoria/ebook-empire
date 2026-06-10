// Testes do modulo de SAUDE (health-collector).
//  - Funcoes de scoring PURAS (sem DB): um setor HEALTHY e um CRITICAL.
//  - DbHealthCollector.collect com Prisma fake: persiste 7 snapshots e deriva
//    status correto (DELIVERY com backlog => CRITICAL; CONTENT com catalogo => HEALTHY).

import { describe, it, expect, vi } from 'vitest';
import { statusFromScore } from '@ebook-empire/core';

import type { AgentContext } from '../base.js';
import {
  DbHealthCollector,
  clampScore,
  weightedScore,
  scoreContent,
  scoreDelivery,
  scoreTraffic,
} from './health-collector.js';

// ============================================================
// Funcoes puras
// ============================================================
describe('clampScore', () => {
  it('limita a 0..100 inteiro e trata nao-finito como 0', () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(150)).toBe(100);
    expect(clampScore(72.6)).toBe(73);
    expect(clampScore(Number.NaN)).toBe(0);
  });
});

describe('weightedScore', () => {
  it('faz media ponderada pelos pesos do setor', () => {
    // DELIVERY: backlog 0.6, op 0.4 => 100*0.6 + 50*0.4 = 80
    expect(weightedScore('DELIVERY', { backlog: 100, op: 50 })).toBe(80);
  });
  it('renormaliza quando faltam subscores', () => {
    // so backlog presente => 100 (peso unico).
    expect(weightedScore('DELIVERY', { backlog: 100 })).toBe(100);
  });
});

describe('scoreContent (puro)', () => {
  it('HEALTHY: catalogo cheio, sem presos, runs ok', () => {
    const s = scoreContent({
      publishedWithActiveProduct: 3,
      stuckEbooks: 0,
      runsToday: 2,
      failedRunsToday: 0,
    });
    expect(s.hasSignal).toBe(true);
    const score = weightedScore('CONTENT', s.subscores);
    expect(statusFromScore(score)).toBe('HEALTHY');
  });
});

describe('scoreDelivery (puro)', () => {
  it('CRITICAL: muitos pedidos pagos presos na fila', () => {
    const s = scoreDelivery({
      pendingDeliveries: 6, // backlog = 100 - 6*20 = -20 -> 0
      paidToday: 6,
      runsToday: 1,
      failedRunsToday: 1, // op = 0
    });
    expect(s.hasSignal).toBe(true);
    const score = weightedScore('DELIVERY', s.subscores);
    expect(score).toBe(0);
    expect(statusFromScore(score)).toBe('CRITICAL');
  });
});

describe('scoreTraffic (puro)', () => {
  it('sem campanha/spend => sem sinal (neutro, nao gera alarme)', () => {
    const s = scoreTraffic({
      activeCampaigns: 0,
      spendCents: 0,
      attributedRevenueCents: 0,
      maxAdBudgetCents: 30000,
    });
    expect(s.hasSignal).toBe(false);
  });
});

// ============================================================
// DbHealthCollector.collect com Prisma fake
// ============================================================

/** Conta chamadas count() por uma heuristica do `where` recebido. */
function makeFakePrisma(opts: {
  publishedWithActiveProduct: number;
  pendingDeliveries: number;
}) {
  const snapshots: Array<Record<string, unknown>> = [];

  const count = vi.fn(async (args: { where?: Record<string, unknown> }) => {
    const w = args?.where ?? {};
    // PUBLISHED com produto ativo (CONTENT pipeline + analytics nenhum).
    if (w.status === 'PUBLISHED' && w.products) return opts.publishedWithActiveProduct;
    // pedidos PAID sem grant (DELIVERY backlog).
    if (w.status === 'PAID' && w.deliveryGrant === null) return opts.pendingDeliveries;
    // todo o resto: 0 (sem runs/falhas/etc).
    return 0;
  });

  const prisma = {
    ebook: {
      count,
      findMany: vi.fn(async () => []), // sales publishedWithoutProduct = 0
    },
    order: { count, aggregate: vi.fn(async () => ({ _sum: { priceCents: 0 } })) },
    // product.count (SALES) + product.findMany (MARKETPLACE: sem products => sem sinal).
    product: { count, findMany: vi.fn(async () => []) },
    event: {
      count,
      findFirst: vi.fn(async () => null), // sem insight => minutesSinceLastInsight = Infinity
    },
    socialPost: { count, findMany: vi.fn(async () => []) },
    adCampaign: { count },
    adInsight: { aggregate: vi.fn(async () => ({ _sum: { spendCents: 0 } })) },
    // AFFILIATE: sem afiliados => sem sinal (neutro).
    affiliate: { count },
    agentRun: {
      count,
      findFirst: vi.fn(async () => null),
    },
    sectorHealthSnapshot: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        snapshots.push(args.data);
        return { id: `snap-${snapshots.length}`, ...args.data };
      }),
    },
  };

  return { prisma, snapshots };
}

function makeCtx(prisma: unknown): AgentContext {
  const fixedNow = new Date('2026-06-10T15:00:00.000Z');
  return {
    prisma: prisma as AgentContext['prisma'],
    ports: {} as AgentContext['ports'],
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
    cycleId: 'cycle-test',
  };
}

describe('DbHealthCollector.collect', () => {
  it('persiste 10 snapshots (7 saude + 3 producao) e deriva DELIVERY=CRITICAL, CONTENT=HEALTHY', async () => {
    const { prisma, snapshots } = makeFakePrisma({
      publishedWithActiveProduct: 3, // CONTENT pipeline cheio
      pendingDeliveries: 6, // DELIVERY com backlog forte
    });
    const ctx = makeCtx(prisma);

    const results = await new DbHealthCollector().collect(ctx);

    // 10 setores operaveis (CRM_SECTORS) -> 10 snapshots persistidos.
    expect(results).toHaveLength(10);
    expect(snapshots).toHaveLength(10);

    // Status NUNCA persistido (apenas score + kpis).
    for (const snap of snapshots) {
      expect(snap).not.toHaveProperty('status');
      expect(typeof snap.score).toBe('number');
      expect(snap.cycleId).toBe('cycle-test');
    }

    const bySector = new Map(results.map((r) => [r.sector, r]));
    const delivery = bySector.get('DELIVERY')!;
    expect(delivery.status).toBe('CRITICAL');
    expect(delivery.score).toBeLessThan(40);

    const content = bySector.get('CONTENT')!;
    // catalogo cheio + sem presos; op neutro (sem runs) => >=70.
    expect(content.status).toBe('HEALTHY');

    // Os 3 setores de producao estao cobertos (sem volume => neutro, hasSignal=false).
    for (const s of ['MARKETPLACE', 'FUNNEL', 'AFFILIATE'] as const) {
      const h = bySector.get(s);
      expect(h, `setor ${s} coberto`).toBeDefined();
      expect((h!.kpis as { hasSignal?: boolean }).hasSignal).toBe(false);
    }
  });

  it('cobre os 3 setores de producao com sinal e os diagnostica (DEAD_LISTING/HIGH_CART_ABANDONMENT/AFFILIATE_REVENUE_ZERO)', async () => {
    const snapshots: Array<Record<string, unknown>> = [];
    // MARKETPLACE: 2 products, 1 com listing morta (sem venda 30d) => deadListings=1.
    const marketplaceProducts = [
      { id: 'p1', externalProductId: 'ext1', listings: [{ id: 'l1' }], ebook: { coverImagePath: 'c.png' }, orders: [{ id: 'o1' }] },
      { id: 'p2', externalProductId: 'ext2', listings: [{ id: 'l2' }], ebook: { coverImagePath: 'c2.png' }, orders: [] },
    ];
    // FUNNEL: muito checkout, pouco pago => payment baixo (HIGH_CART_ABANDONMENT).
    const funnelByType: Record<string, number> = {
      IMPRESSION: 1000, CLICK: 800, LANDING_VIEW: 700, CHECKOUT_STARTED: 200, PAID: 5,
    };
    // AFFILIATE: 3 ativos, sem receita => AFFILIATE_REVENUE_ZERO.
    const affiliateByStatus: Record<string, number> = { PROSPECT: 0, ACTIVE: 3, PAUSED: 0 };

    const eventCount = vi.fn(async (args: { where?: { type?: string } }) => funnelByType[args?.where?.type ?? ''] ?? 0);
    const prisma = {
      ebook: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      order: { count: vi.fn(async () => 0), aggregate: vi.fn(async () => ({ _sum: { priceCents: 0 } })) },
      product: { count: vi.fn(async () => 0), findMany: vi.fn(async () => marketplaceProducts) },
      event: { count: eventCount, findFirst: vi.fn(async () => null) },
      socialPost: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      adCampaign: { count: vi.fn(async () => 0) },
      adInsight: { aggregate: vi.fn(async () => ({ _sum: { spendCents: 0 } })) },
      affiliate: {
        count: vi.fn(async (args: { where?: { status?: string } }) =>
          args?.where?.status ? (affiliateByStatus[args.where.status] ?? 0) : 3),
      },
      agentRun: { count: vi.fn(async () => 0), findFirst: vi.fn(async () => null) },
      sectorHealthSnapshot: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          snapshots.push(args.data);
          return { id: `snap-${snapshots.length}`, ...args.data };
        }),
      },
    };
    const ctx = makeCtx(prisma);
    const results = await new DbHealthCollector().collect(ctx);
    const bySector = new Map(results.map((r) => [r.sector, r]));

    const market = bySector.get('MARKETPLACE')!;
    expect((market.kpis as { hasSignal?: boolean }).hasSignal).toBe(true);
    expect((market.kpis as { deadListings?: number }).deadListings).toBe(1);

    const funnel = bySector.get('FUNNEL')!;
    expect((funnel.kpis as { hasSignal?: boolean }).hasSignal).toBe(true);
    expect((funnel.kpis as { subscores: { payment: number } }).subscores.payment).toBeLessThan(50);

    const affiliate = bySector.get('AFFILIATE')!;
    expect((affiliate.kpis as { hasSignal?: boolean }).hasSignal).toBe(true);
    expect((affiliate.kpis as { subscores: { revenue: number } }).subscores.revenue).toBe(30);
  });
});
