// Testes dos COLETORES de producao (COO-Scale / Fase 5) do DbHealthCollector:
// collectMarketplace / collectFunnel / collectAffiliate / collectContentOpportunitySignal.
// Prisma fake deterministico; verifica as agregacoes/contagens REAIS por filtro.

import { describe, it, expect, vi } from 'vitest';
import { DbHealthCollector } from './health-collector.js';
import type { AgentContext } from '../base.js';

function makeCtx(prisma: Record<string, unknown>): AgentContext {
  return {
    prisma: prisma as unknown as AgentContext['prisma'],
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
    clock: { now: () => new Date('2026-06-10T15:00:00.000Z') },
  };
}

describe('collectMarketplace', () => {
  it('classifica products sem listing/externalId/capa e listings mortas', async () => {
    const products = [
      // sincronizado e vendendo: saudavel.
      {
        id: 'p1',
        externalProductId: 'ext1',
        listings: [{ id: 'l1' }],
        ebook: { coverImagePath: 'cover1.png' },
        orders: [{ id: 'o1' }],
      },
      // tem listing mas SEM venda em 30d => dead; sem capa.
      {
        id: 'p2',
        externalProductId: 'ext2',
        listings: [{ id: 'l2' }],
        ebook: { coverImagePath: null },
        orders: [],
      },
      // sem listing nem externalId => nao publicado externamente.
      {
        id: 'p3',
        externalProductId: null,
        listings: [],
        ebook: { coverImagePath: 'cover3.png' },
        orders: [],
      },
    ];
    const ctx = makeCtx({
      product: { findMany: vi.fn(async () => products) },
    });
    const k = await new DbHealthCollector().collectMarketplace(ctx);
    expect(k.products).toBe(3);
    expect(k.productsWithoutListing).toBe(1); // p3
    expect(k.productsWithoutExternalId).toBe(1); // p3
    expect(k.ebooksWithoutCover).toBe(1); // p2
    expect(k.deadListings).toBe(1); // p2 (tem listing, sem venda)
  });
});

describe('collectFunnel', () => {
  it('conta eventos por estagio na janela 7d', async () => {
    const byType: Record<string, number> = {
      IMPRESSION: 1000,
      CLICK: 400,
      LANDING_VIEW: 300,
      CHECKOUT_STARTED: 50,
      PAID: 10,
    };
    const count = vi.fn(async (args: { where?: { type?: string } }) => {
      const t = args?.where?.type ?? '';
      return byType[t] ?? 0;
    });
    const ctx = makeCtx({ event: { count } });
    const k = await new DbHealthCollector().collectFunnel(ctx);
    expect(k).toEqual({
      impressions: 1000,
      clicks: 400,
      landingViews: 300,
      checkoutsStarted: 50,
      paid: 10,
    });
  });
});

describe('collectAffiliate', () => {
  it('conta por status e soma receita atribuida (utmSource/utmMedium)', async () => {
    const count = vi.fn(async (args: { where?: { status?: string } }) => {
      const s = args?.where?.status;
      if (s === 'PROSPECT') return 5;
      if (s === 'ACTIVE') return 2;
      if (s === 'PAUSED') return 1;
      return 8; // total (sem where.status)
    });
    const aggregate = vi.fn(async (args: { where?: Record<string, unknown> }) => {
      // valida que o filtro de afiliado foi aplicado.
      expect(args.where?.utmMedium).toBe('afiliado');
      expect(args.where?.utmSource).toEqual({ in: ['hotmart', 'kiwify'] });
      return { _sum: { priceCents: 47000 } };
    });
    const ctx = makeCtx({ affiliate: { count }, order: { aggregate } });
    const k = await new DbHealthCollector().collectAffiliate(ctx);
    expect(k).toEqual({
      prospects: 5,
      active: 2,
      paused: 1,
      total: 8,
      attributedRevenueCents: 47000,
    });
  });
});

describe('collectContentOpportunitySignal', () => {
  it('conta MarketOpportunity PENDING com potentialScore > 70', async () => {
    const count = vi.fn(async (args: { where?: Record<string, unknown> }) => {
      expect(args.where?.status).toBe('PENDING');
      expect(args.where?.potentialScore).toEqual({ gt: 70 });
      return 3;
    });
    const ctx = makeCtx({ marketOpportunity: { count } });
    const sig = await new DbHealthCollector().collectContentOpportunitySignal(ctx);
    expect(sig).toEqual({ pendingHighScore: 3, count: 3 });
  });
});
