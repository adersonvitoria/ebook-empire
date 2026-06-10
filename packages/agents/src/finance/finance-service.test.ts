// Testes do FinanceService (Feature 2).
//  - Nucleo PURO da DRE (computeDreFromAggregates) + taxas Asaas por order:
//    cenario seedado com receita/taxas/spend/llm confere lucro e margem.
//  - DRE via Prisma fake: receita + taxas + spend + llm somados corretamente.
//  - Atribuicao por ebook (via campanha -> product -> ebook) e bucket unattributed.
//  - Atribuicao por campanha (ROAS) e bucket organic.
//  - Idempotencia do snapshot (upsert pela date).

import { describe, it, expect, vi } from 'vitest';

import type { AgentContext } from '../base.js';
import {
  FinanceService,
  computeDreFromAggregates,
  paymentFeeForOrderCents,
  paymentFeesForOrders,
  marginPctOf,
} from './finance-service.js';

// Fees default do env: 0,99% + R$0,49 por order.
const FEES = { asaasFeePercent: 0.99, asaasFeeFixedCents: 49 };

// ============================================================
// Taxas por order (puro)
// ============================================================
describe('paymentFeeForOrderCents', () => {
  it('soma percentual (half-up) + fixo por order', () => {
    // 0,99% de 4700 = 46,53 -> 47; + 49 = 96.
    expect(paymentFeeForOrderCents(4700, FEES)).toBe(47 + 49);
    // 0,99% de 9700 = 96,03 -> 96; + 49 = 145.
    expect(paymentFeeForOrderCents(9700, FEES)).toBe(96 + 49);
  });

  it('soma por order (nao sobre o total) — cada order paga o fixo', () => {
    const prices = [4700, 9700];
    expect(paymentFeesForOrders(prices, FEES)).toBe(
      paymentFeeForOrderCents(4700, FEES) + paymentFeeForOrderCents(9700, FEES),
    );
  });
});

describe('marginPctOf', () => {
  it('arredonda a 2 casas; null se receita 0', () => {
    expect(marginPctOf(7800, 12000)).toBe(65); // 65,00%
    expect(marginPctOf(1, 3)).toBe(33.33); // 33,333.. -> 33.33
    expect(marginPctOf(0, 0)).toBeNull();
    expect(marginPctOf(-100, 0)).toBeNull();
  });
});

// ============================================================
// DRE pura (numerica exata)
// ============================================================
describe('computeDreFromAggregates', () => {
  it('lucro = gross - fees - adSpend - llm; margem 2 casas; meta', () => {
    const dre = computeDreFromAggregates({
      date: '2026-06-10',
      grossRevenueCents: 120000, // R$1200
      paymentFeesCents: 1237, // taxas
      adSpendCents: 40000, // R$400
      llmCostCents: 2000, // R$20
      paidOrders: 24,
      targetRevenueCents: 100000, // R$1000
      dayFraction: 1,
      isPartial: false,
    });
    expect(dre.netProfitCents).toBe(120000 - 1237 - 40000 - 2000); // 76763
    expect(dre.marginPct).toBe(Math.round((76763 / 120000) * 10000) / 100); // 63.97
    expect(dre.meta.metTarget).toBe(true);
    expect(dre.meta.progressPct).toBe(120); // 120000/100000
    expect(dre.meta.isPartial).toBe(false);
    expect(dre.meta.projectedRevenueCents).toBe(120000); // dia fechado
  });

  it('marginPct null quando receita 0; lucro pode ser negativo', () => {
    const dre = computeDreFromAggregates({
      date: '2026-06-10',
      grossRevenueCents: 0,
      paymentFeesCents: 0,
      adSpendCents: 5000,
      llmCostCents: 1000,
      paidOrders: 0,
      targetRevenueCents: 100000,
      dayFraction: 1,
      isPartial: false,
    });
    expect(dre.netProfitCents).toBe(-6000);
    expect(dre.marginPct).toBeNull();
    expect(dre.meta.metTarget).toBe(false);
  });

  it('projecao linear extrapola receita pela fracao do dia (parcial)', () => {
    // meio do dia (50%), R$500 -> projecao R$1000 (bate a meta projetada).
    const dre = computeDreFromAggregates({
      date: '2026-06-10',
      grossRevenueCents: 50000,
      paymentFeesCents: 500,
      adSpendCents: 10000,
      llmCostCents: 0,
      paidOrders: 10,
      targetRevenueCents: 100000,
      dayFraction: 0.5,
      isPartial: true,
    });
    expect(dre.meta.projectedRevenueCents).toBe(100000);
    expect(dre.meta.projectedMetTarget).toBe(true);
    expect(dre.meta.metTarget).toBe(false); // realizado ainda abaixo
  });
});

// ============================================================
// Prisma fake para os metodos com DB
// ============================================================
interface SeedOrder {
  priceCents: number;
  ebookId: string;
  adCampaignId: string | null;
}
interface SeedInsight {
  campaignId: string;
  spendCents: number;
}

function makeFakePrisma(seed: {
  orders: SeedOrder[];
  insights: SeedInsight[];
  llmCostCents: number;
  campaigns?: Array<{ id: string; name: string; productId: string | null }>;
  products?: Array<{ id: string; ebookId: string }>;
  ebooks?: Array<{ id: string; title: string }>;
}) {
  const upserts: Array<Record<string, unknown>> = [];

  function selectFields<T extends Record<string, unknown>>(
    rows: T[],
    select?: Record<string, boolean>,
  ): T[] {
    if (!select) return rows;
    return rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(select)) out[k] = r[k];
      return out as T;
    });
  }

  const prisma = {
    order: {
      findMany: vi.fn(async (args: { select?: Record<string, boolean> }) =>
        selectFields(seed.orders as unknown as Array<Record<string, unknown>>, args?.select),
      ),
    },
    adInsight: {
      aggregate: vi.fn(async () => ({
        _sum: { spendCents: seed.insights.reduce((a, i) => a + i.spendCents, 0) },
      })),
      findMany: vi.fn(async (args: { select?: Record<string, boolean> }) =>
        selectFields(seed.insights as unknown as Array<Record<string, unknown>>, args?.select),
      ),
    },
    agentRun: {
      aggregate: vi.fn(async () => ({ _sum: { costCents: seed.llmCostCents } })),
    },
    adCampaign: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } }; select?: Record<string, boolean> }) => {
        const ids = new Set(args.where.id.in);
        const rows = (seed.campaigns ?? []).filter((c) => ids.has(c.id));
        return selectFields(rows as Array<Record<string, unknown>>, args?.select);
      }),
    },
    product: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } }; select?: Record<string, boolean> }) => {
        const ids = new Set(args.where.id.in);
        const rows = (seed.products ?? []).filter((p) => ids.has(p.id));
        return selectFields(rows as Array<Record<string, unknown>>, args?.select);
      }),
    },
    ebook: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } }; select?: Record<string, boolean> }) => {
        const ids = new Set(args.where.id.in);
        const rows = (seed.ebooks ?? []).filter((e) => ids.has(e.id));
        return selectFields(rows as Array<Record<string, unknown>>, args?.select);
      }),
    },
    financeSnapshot: {
      upsert: vi.fn(async (args: { where: { date: Date }; create: Record<string, unknown> }) => {
        const dateIso = args.where.date.toISOString();
        const existing = upserts.find((u) => (u.date as Date).toISOString() === dateIso);
        if (existing) {
          Object.assign(existing, args.create);
          return existing;
        }
        const row = { id: `snap-${upserts.length + 1}`, ...args.create };
        upserts.push(row);
        return row;
      }),
    },
  };

  return { prisma, upserts };
}

function makeCtx(prisma: unknown, now = new Date('2026-06-11T03:30:00.000Z')): AgentContext {
  // 2026-06-11T03:30Z = 2026-06-11 00:30 SP. Pedimos sempre day explicito nos
  // testes para nao depender do dia "de hoje".
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
      ASAAS_FEE_PERCENT: 0.99,
      ASAAS_FEE_FIXED_CENTS: 49,
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clock: { now: () => now },
    cycleId: 'cycle-test',
  };
}

describe('FinanceService.computeDre (DB)', () => {
  it('soma receita, taxas (por order), spend e llm de um cenario seedado', async () => {
    const { prisma } = makeFakePrisma({
      orders: [
        { priceCents: 4700, ebookId: 'eb1', adCampaignId: 'c1' },
        { priceCents: 4700, ebookId: 'eb1', adCampaignId: 'c1' },
        { priceCents: 9700, ebookId: 'eb2', adCampaignId: null },
      ],
      insights: [{ campaignId: 'c1', spendCents: 8000 }],
      llmCostCents: 1500,
    });
    const dre = await new FinanceService().computeDre(makeCtx(prisma), { day: '2026-06-10' });

    const gross = 4700 + 4700 + 9700; // 19100
    const fees =
      paymentFeeForOrderCents(4700, FEES) * 2 + paymentFeeForOrderCents(9700, FEES);
    expect(dre.grossRevenueCents).toBe(gross);
    expect(dre.paidOrders).toBe(3);
    expect(dre.paymentFeesCents).toBe(fees);
    expect(dre.adSpendCents).toBe(8000);
    expect(dre.llmCostCents).toBe(1500);
    expect(dre.netProfitCents).toBe(gross - fees - 8000 - 1500);
    expect(dre.marginPct).toBe(marginPctOf(dre.netProfitCents, gross));
    expect(dre.meta.isPartial).toBe(false); // dia 06-10 ja fechou (now=06-11)
  });
});

describe('FinanceService.marginByEbook', () => {
  it('atribui receita/taxas por ebook e spend via campanha->product->ebook', async () => {
    const { prisma } = makeFakePrisma({
      orders: [
        { priceCents: 4700, ebookId: 'eb1', adCampaignId: 'c1' },
        { priceCents: 4700, ebookId: 'eb1', adCampaignId: 'c1' },
        { priceCents: 9700, ebookId: 'eb2', adCampaignId: null },
      ],
      // c1 -> p1 -> eb1 (spend atribuido a eb1); c9 sem product => unattributed.
      insights: [
        { campaignId: 'c1', spendCents: 6000 },
        { campaignId: 'c9', spendCents: 2000 },
      ],
      llmCostCents: 0,
      campaigns: [
        { id: 'c1', name: 'Camp 1', productId: 'p1' },
        { id: 'c9', name: 'Orfã', productId: null },
      ],
      products: [{ id: 'p1', ebookId: 'eb1' }],
      ebooks: [
        { id: 'eb1', title: 'Ebook Um' },
        { id: 'eb2', title: 'Ebook Dois' },
      ],
    });
    const res = await new FinanceService().marginByEbook(makeCtx(prisma), { day: '2026-06-10' });

    expect(res.unattributedAdSpendCents).toBe(2000); // c9 sem product
    const byId = new Map(res.ebooks.map((e) => [e.ebookId, e]));
    const eb1 = byId.get('eb1')!;
    const eb2 = byId.get('eb2')!;

    expect(eb1.revenueCents).toBe(9400); // 2x 4700
    expect(eb1.orders).toBe(2);
    expect(eb1.adSpendAttributedCents).toBe(6000);
    expect(eb1.paymentFeesCents).toBe(paymentFeeForOrderCents(4700, FEES) * 2);
    expect(eb1.netProfitCents).toBe(9400 - eb1.paymentFeesCents - 6000);
    expect(eb1.title).toBe('Ebook Um');

    expect(eb2.revenueCents).toBe(9700);
    expect(eb2.adSpendAttributedCents).toBe(0); // sem campanha mapeada
    expect(eb2.netProfitCents).toBe(9700 - paymentFeeForOrderCents(9700, FEES));
  });
});

describe('FinanceService.marginByCampaign', () => {
  it('calcula ROAS por campanha e separa receita organica', async () => {
    const { prisma } = makeFakePrisma({
      orders: [
        { priceCents: 10000, ebookId: 'eb1', adCampaignId: 'c1' },
        { priceCents: 10000, ebookId: 'eb1', adCampaignId: 'c1' },
        { priceCents: 5000, ebookId: 'eb2', adCampaignId: null }, // organico
      ],
      insights: [{ campaignId: 'c1', spendCents: 8000 }],
      llmCostCents: 0,
      campaigns: [{ id: 'c1', name: 'Camp 1', productId: 'p1' }],
    });
    const res = await new FinanceService().marginByCampaign(makeCtx(prisma), {
      day: '2026-06-10',
    });

    expect(res.organic.revenueCents).toBe(5000);
    expect(res.organic.orders).toBe(1);

    const c1 = res.campaigns.find((c) => c.campaignId === 'c1')!;
    expect(c1.revenueCents).toBe(20000);
    expect(c1.spendCents).toBe(8000);
    expect(c1.roas).toBeCloseTo(20000 / 8000); // 2.5
    const fees = paymentFeeForOrderCents(10000, FEES) * 2;
    expect(c1.netProfitCents).toBe(20000 - fees - 8000);
  });

  it('roas null quando campanha tem receita mas sem spend', async () => {
    const { prisma } = makeFakePrisma({
      orders: [{ priceCents: 10000, ebookId: 'eb1', adCampaignId: 'c1' }],
      insights: [],
      llmCostCents: 0,
      campaigns: [{ id: 'c1', name: 'Camp 1', productId: null }],
    });
    const res = await new FinanceService().marginByCampaign(makeCtx(prisma), {
      day: '2026-06-10',
    });
    const c1 = res.campaigns.find((c) => c.campaignId === 'c1')!;
    expect(c1.roas).toBeNull();
    expect(c1.spendCents).toBe(0);
  });
});

describe('FinanceService.persistSnapshot (idempotente)', () => {
  it('upsert pela date: rodar 2x produz 1 linha com os mesmos valores', async () => {
    const seed = {
      orders: [{ priceCents: 4700, ebookId: 'eb1', adCampaignId: null }],
      insights: [{ campaignId: 'c1', spendCents: 1000 }],
      llmCostCents: 200,
    };
    const { prisma, upserts } = makeFakePrisma(seed);
    const svc = new FinanceService();
    const ctx = makeCtx(prisma);

    const first = await svc.persistSnapshot(ctx, { day: '2026-06-10' });
    const second = await svc.persistSnapshot(ctx, { day: '2026-06-10' });

    expect(upserts).toHaveLength(1); // idempotente por date
    expect(second.id).toBe(first.id);
    expect(second.date).toBe('2026-06-10');
    expect(second.grossRevenueCents).toBe(4700);
    expect(second.paymentFeesCents).toBe(paymentFeeForOrderCents(4700, FEES));
    expect(second.adSpendCents).toBe(1000);
    expect(second.llmCostCents).toBe(200);
    expect(second.netProfitCents).toBe(
      4700 - paymentFeeForOrderCents(4700, FEES) - 1000 - 200,
    );
  });
});

describe('FinanceService.goalProgress', () => {
  it('reporta meta, atual, pct e projecao (dia parcial)', async () => {
    // now=06-10 12:00 SP -> dia em curso, fracao 0.5.
    const { prisma } = makeFakePrisma({
      orders: [{ priceCents: 50000, ebookId: 'eb1', adCampaignId: null }],
      insights: [],
      llmCostCents: 0,
    });
    const ctx = makeCtx(prisma, new Date('2026-06-10T15:00:00.000Z')); // 12:00 SP
    const g = await new FinanceService().goalProgress(ctx, { day: '2026-06-10' });
    expect(g.targetCents).toBe(100000);
    expect(g.currentCents).toBe(50000);
    expect(g.pct).toBe(50);
    expect(g.projectionCents).toBe(100000); // 50000 / 0.5
  });
});
