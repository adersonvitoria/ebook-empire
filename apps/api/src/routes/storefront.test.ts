// Testes de integracao da VITRINE PUBLICA (storefront).
// Usa StubLLMAdapter (USE_STUBS=true) e um Prisma fake em memoria.
// Cobre: featured (maior potencial), produto por slug (200/404), chat (reply
// stub), rate-limit por IP (429 ao estourar) e SALES_BOT_ENABLED=false (canned).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// --- env minimo ANTES de importar env.ts/rota (lido uma vez no boot) ---
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.USE_STUBS = 'true';
process.env.SALES_BOT_ENABLED = 'true';
// Capacidade pequena para o teste de rate-limit estourar rapido.
process.env.SALES_BOT_PER_IP_PER_30MIN = '3';
process.env.SALES_BOT_DAILY_LIMIT = '1000';

// ------------------------------------------------------------
// Prisma fake em memoria (apenas o que a rota usa).
// ------------------------------------------------------------
interface Store {
  products: any[];
}
let store: Store;

function matchProductInclude(p: any) {
  return {
    ...p,
    ebook: {
      ...p._ebook,
      marketOpportunity: p._ebook.marketOpportunity ?? null,
    },
  };
}

const prismaMock = {
  product: {
    findMany: async ({ where }: any) => {
      return store.products
        .filter((p) => {
          if (where?.active !== undefined && p.active !== where.active) return false;
          if (where?.ebook?.status && p._ebook.status !== where.ebook.status) return false;
          return true;
        })
        .map(matchProductInclude);
    },
    findUnique: async ({ where, include }: any) => {
      const p = store.products.find((x) => x.slug === where.slug);
      if (!p) return null;
      if (include?.ebook?.include?.marketOpportunity) return matchProductInclude(p);
      // chat: include { ebook: true }
      return { ...p, ebook: p._ebook };
    },
  },
};

vi.mock('../db.js', () => ({ prisma: prismaMock }));
// O barrel @ebook-empire/adapters aponta para ./dist; resolvemos via o fonte.
vi.mock('@ebook-empire/adapters', async () => {
  const mod = await import('../../../../packages/adapters/src/llm.js');
  return { createLLMAdapter: mod.createLLMAdapter };
});

let app: FastifyInstance;
let resetGuards: () => void;

beforeAll(async () => {
  const routeMod = await import('./storefront.js');
  resetGuards = (routeMod as any)._resetStorefrontGuards;
  app = Fastify();
  await app.register(routeMod.default);
  await app.ready();
});

function ebook(over: Record<string, any> = {}) {
  return {
    title: 'Ebook Teste',
    niche: 'Produtividade',
    language: 'pt-BR',
    status: 'PUBLISHED',
    outline: {
      title: 'Ebook Teste',
      niche: 'Produtividade',
      subtitle: 'Do zero ao avancado',
      chapters: [
        { title: 'Capitulo 1', summary: 'Resumo 1' },
        { title: 'Capitulo 2', summary: 'Resumo 2' },
        { title: 'Capitulo 3', summary: 'Resumo 3' },
      ],
    },
    coverImagePath: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    marketOpportunity: { potentialScore: 50, angles: ['Dor A', 'Dor B'] },
    ...over,
  };
}

function product(over: Record<string, any> = {}, ebookOver: Record<string, any> = {}) {
  return {
    id: over.id ?? 'prod_1',
    slug: over.slug ?? 'ebook-teste-oferta',
    name: over.name ?? 'Ebook Teste',
    description: over.description ?? 'Ebook sobre Produtividade.',
    priceCents: over.priceCents ?? 4700,
    currency: over.currency ?? 'BRL',
    active: over.active ?? true,
    createdAt: over.createdAt ?? new Date('2024-01-01T00:00:00Z'),
    _ebook: ebook(ebookOver),
  };
}

beforeEach(() => {
  resetGuards();
  store = { products: [product()] };
});

describe('GET /storefront/featured', () => {
  it('retorna o produto de MAIOR potentialScore', async () => {
    store.products = [
      product({ slug: 'a', name: 'A', priceCents: 4700 }, { marketOpportunity: { potentialScore: 30, angles: [] } }),
      product({ slug: 'b', name: 'B', priceCents: 9700 }, { marketOpportunity: { potentialScore: 90, angles: ['x'] } }),
      product({ slug: 'c', name: 'C', priceCents: 2700 }, { marketOpportunity: { potentialScore: 60, angles: [] } }),
    ];
    const res = await app.inject({ method: 'GET', url: '/storefront/featured' });
    expect(res.statusCode).toBe(200);
    const dto = res.json();
    expect(dto.product.slug).toBe('b');
    expect(dto.product.priceFormatted).toContain('97,00');
    expect(dto.opportunity.potentialScore).toBe(90);
    expect(dto.ebook.whatsInside).toHaveLength(3);
    expect(dto.copy.headline).toBe('B');
  });

  it('404 no_featured_product quando nao ha produto PUBLISHED ativo', async () => {
    store.products = [];
    const res = await app.inject({ method: 'GET', url: '/storefront/featured' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('no_featured_product');
  });
});

describe('GET /storefront/products/:slug', () => {
  it('200 com o DTO do produto', async () => {
    const res = await app.inject({ method: 'GET', url: '/storefront/products/ebook-teste-oferta' });
    expect(res.statusCode).toBe(200);
    const dto = res.json();
    expect(dto.product.slug).toBe('ebook-teste-oferta');
    expect(dto.ebook.subtitle).toBe('Do zero ao avancado');
    expect(dto.copy.painPoints).toContain('Dor A');
  });

  it('404 para slug inexistente', async () => {
    const res = await app.inject({ method: 'GET', url: '/storefront/products/nao-existe' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('product_not_found');
  });

  it('404 para produto inativo', async () => {
    store.products = [product({ active: false })];
    const res = await app.inject({ method: 'GET', url: '/storefront/products/ebook-teste-oferta' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /storefront/chat', () => {
  it('retorna reply (source llm) sob USE_STUBS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/storefront/chat',
      payload: {
        productSlug: 'ebook-teste-oferta',
        messages: [{ role: 'user', content: 'Quanto custa?' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('llm');
    expect(typeof body.reply).toBe('string');
    expect(body.reply.length).toBeGreaterThan(0);
  });

  it('404 para produto inexistente', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/storefront/chat',
      payload: {
        productSlug: 'nao-existe',
        messages: [{ role: 'user', content: 'oi' }],
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('product_not_found');
  });

  it('400 quando a ultima mensagem nao e do usuario', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/storefront/chat',
      payload: {
        productSlug: 'ebook-teste-oferta',
        messages: [{ role: 'assistant', content: 'oi' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('429 quando estoura o rate-limit por IP', async () => {
    const payload = {
      productSlug: 'ebook-teste-oferta',
      messages: [{ role: 'user', content: 'ola' }],
    };
    // Capacidade=3 (env). 3 ok, o 4o estoura.
    for (let i = 0; i < 3; i++) {
      const ok = await app.inject({ method: 'POST', url: '/storefront/chat', payload });
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await app.inject({ method: 'POST', url: '/storefront/chat', payload });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('rate_limited');
    expect(blocked.json().retryAfterSec).toBeGreaterThan(0);
    expect(blocked.headers['retry-after']).toBeTruthy();
  });
});

describe('POST /storefront/chat — guardrails canned', () => {
  it('SALES_BOT_ENABLED=false -> canned sem chamar LLM', async () => {
    const routeMod = await import('./storefront.js');
    const llm = (routeMod as any)._llmPort;
    const spy = vi.spyOn(llm, 'generateText');
    const envMod = await import('../env.js');
    const original = envMod.env.SALES_BOT_ENABLED;
    (envMod.env as any).SALES_BOT_ENABLED = false;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/storefront/chat',
        payload: {
          productSlug: 'ebook-teste-oferta',
          messages: [{ role: 'user', content: 'oi' }],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().source).toBe('canned');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      (envMod.env as any).SALES_BOT_ENABLED = original;
      spy.mockRestore();
    }
  });
});
