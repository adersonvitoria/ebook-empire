// Testes do MarketplaceAgent: sincroniza ebooks PUBLISHED em Hotmart+Kiwify,
// upsert idempotente de MarketplaceListing, skip de provedores ja sincronizados,
// e SKIPPED quando nao ha nada a fazer. Usa StubMarketplaceAdapter (mapa por
// provedor) + StubStorage + Prisma fake em memoria.

import { describe, it, expect, vi } from 'vitest';

import { StubMarketplaceAdapter } from '@ebook-empire/adapters';
import type { StoragePort } from '@ebook-empire/core';
import { MarketplaceAgent } from './marketplace.js';
import type { AgentContext } from './base.js';

class StubStorage implements StoragePort {
  async putObject(): Promise<void> {}
  async getObject(key: string): Promise<Buffer> {
    return Buffer.from(`pdf:${key}`, 'utf-8');
  }
  async getSignedUrl(key: string): Promise<string> {
    return `https://stub/${key}`;
  }
}

interface FakeEbook {
  id: string;
  status: string;
  pdfPath: string | null;
  updatedAt: Date;
  products: Array<{
    id: string;
    name: string;
    description: string | null;
    priceCents: number;
    currency: string;
    active: boolean;
    affiliateCommissionPct: number | null;
    ebookId: string;
    listings: Array<{ provider: string }>;
  }>;
}

function makeFakePrisma(ebooks: FakeEbook[]) {
  const listings: Array<Record<string, unknown>> = [];
  const agentRuns: Array<Record<string, unknown>> = [];
  let seq = 0;

  const prisma = {
    ebook: {
      findMany: vi.fn(async (args: { where: { status: string }; take: number }) =>
        ebooks.filter((e) => e.status === args.where.status).slice(0, args.take),
      ),
    },
    marketplaceListing: {
      upsert: vi.fn(
        async (args: {
          where: { productId_provider: { productId: string; provider: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const { productId, provider } = args.where.productId_provider;
          const existing = listings.find(
            (l) => l.productId === productId && l.provider === provider,
          );
          if (existing) {
            Object.assign(existing, args.update);
            return existing;
          }
          const row = { id: `list_${++seq}`, ...args.create };
          listings.push(row);
          // Reflete no ebook em memoria para o proximo run pular.
          const eb = ebooks.find((e) => e.products.some((p) => p.id === productId));
          eb?.products
            .find((p) => p.id === productId)
            ?.listings.push({ provider });
          return row;
        },
      ),
    },
    agentRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `run_${++seq}`, ...data };
        agentRuns.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = agentRuns.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
  };
  return { prisma, listings, agentRuns };
}

function makeCtx(prisma: unknown): AgentContext {
  const storage = new StubStorage();
  return {
    prisma: prisma as AgentContext['prisma'],
    ports: {
      storage,
      marketplace: {
        HOTMART: new StubMarketplaceAdapter({ provider: 'HOTMART' }),
        KIWIFY: new StubMarketplaceAdapter({ provider: 'KIWIFY' }),
      },
    } as unknown as AgentContext['ports'],
    env: {
      ENABLE_AGENTS: true,
      MAX_AD_BUDGET_BRL: 300,
      TARGET_DAILY_REVENUE_BRL: 1000,
      PUBLIC_BASE_URL: 'http://localhost:3001',
      CONTENT_MODEL: 'claude-sonnet-4-6',
      PLANNING_MODEL: 'claude-opus-4-8',
      MARKETPLACE_AFFILIATE_COMMISSION_PCT: 50,
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clock: { now: () => new Date('2026-06-10T12:00:00.000Z') },
  };
}

function makeEbook(id: string, listingsByProduct: string[] = []): FakeEbook {
  return {
    id,
    status: 'PUBLISHED',
    pdfPath: `ebooks/${id}.pdf`,
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    products: [
      {
        id: `prod_${id}`,
        name: `Ebook ${id}`,
        description: 'desc',
        priceCents: 4700,
        currency: 'BRL',
        active: true,
        affiliateCommissionPct: null,
        ebookId: id,
        listings: listingsByProduct.map((provider) => ({ provider })),
      },
    ],
  };
}

describe('MarketplaceAgent.run', () => {
  it('cria listings em Hotmart e Kiwify para ebook PUBLISHED sem listing', async () => {
    const ebook = makeEbook('1');
    const { prisma, listings } = makeFakePrisma([ebook]);
    const ctx = makeCtx(prisma);

    const result = await new MarketplaceAgent().run(ctx);
    expect(result.status).toBe('SUCCESS');
    expect((result.output as { listingsCreated: number }).listingsCreated).toBe(2);

    const providers = listings.map((l) => l.provider).sort();
    expect(providers).toEqual(['HOTMART', 'KIWIFY']);
    expect(listings[0]!.externalProductId).toContain('prod_1');
    expect(listings[0]!.syncedAt).toBeInstanceOf(Date);
  });

  it('pula provedor ja sincronizado (so cria o que falta)', async () => {
    const ebook = makeEbook('2', ['HOTMART']); // ja tem Hotmart
    const { prisma, listings } = makeFakePrisma([ebook]);
    const ctx = makeCtx(prisma);

    const result = await new MarketplaceAgent().run(ctx);
    expect(result.status).toBe('SUCCESS');
    expect((result.output as { listingsCreated: number }).listingsCreated).toBe(1);
    expect(listings).toHaveLength(1);
    expect(listings[0]!.provider).toBe('KIWIFY');
  });

  it('SKIPPED quando todos os ebooks ja estao sincronizados', async () => {
    const ebook = makeEbook('3', ['HOTMART', 'KIWIFY']);
    const { prisma } = makeFakePrisma([ebook]);
    const ctx = makeCtx(prisma);

    const result = await new MarketplaceAgent().run(ctx);
    expect(result.status).toBe('SKIPPED');
  });

  it('SKIPPED quando nao ha ebook PUBLISHED', async () => {
    const { prisma } = makeFakePrisma([]);
    const ctx = makeCtx(prisma);
    const result = await new MarketplaceAgent().run(ctx);
    expect(result.status).toBe('SKIPPED');
  });

  it('SKIPPED quando MarketplacePort ausente no wiring', async () => {
    const { prisma } = makeFakePrisma([makeEbook('4')]);
    const ctx = makeCtx(prisma);
    (ctx.ports as { marketplace?: unknown }).marketplace = undefined;
    const result = await new MarketplaceAgent().run(ctx);
    expect(result.status).toBe('SKIPPED');
  });

  it('e idempotente: segundo run nao recria listings', async () => {
    const ebook = makeEbook('5');
    const { prisma, listings } = makeFakePrisma([ebook]);
    const ctx = makeCtx(prisma);

    await new MarketplaceAgent().run(ctx);
    expect(listings).toHaveLength(2);
    const second = await new MarketplaceAgent().run(ctx);
    expect(second.status).toBe('SKIPPED');
    expect(listings).toHaveLength(2);
  });
});
