// Testes do ContentAgent com StubLLMAdapter (deterministico, sem rede/DB real).
// Usa um fake minimo de PrismaClient e ports em memoria.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StubLLMAdapter } from '@ebook-empire/adapters';
import type {
  Ports,
  StoragePort,
  PaymentPort,
  EmailPort,
  InstagramPort,
  AdsPort,
} from '@ebook-empire/core';
import { ContentAgent, slugify, clampMetaDescription, META_DESCRIPTION_MAX } from './content.js';
import type { AgentContext, AgentEnv, Clock } from './base.js';

// ------------------------------------------------------------
// Fake de PrismaClient em memoria (apenas os modelos/metodos usados).
// ------------------------------------------------------------
interface Row {
  id: string;
  [key: string]: unknown;
}

function makeFakePrisma() {
  const ebooks: Row[] = [];
  const products: Row[] = [];
  const events: Row[] = [];
  const agentRuns: Row[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}_${++seq}`;

  return {
    _ebooks: ebooks,
    _products: products,
    _events: events,
    _agentRuns: agentRuns,

    agentRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId('run'), ...data };
        agentRuns.push(row);
        return row;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = agentRuns.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
      ),
    },

    ebook: {
      findUnique: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
        return (
          ebooks.find(
            (e) =>
              (where.slug && e.slug === where.slug) || (where.id && e.id === where.id),
          ) ?? null
        );
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId('ebook'), ...data };
        ebooks.push(row);
        return row;
      }),
    },

    product: {
      findUnique: vi.fn(async ({ where }: { where: { slug?: string } }) => {
        return products.find((p) => where.slug && p.slug === where.slug) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId('product'), ...data };
        products.push(row);
        return row;
      }),
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

// StoragePort em memoria.
function makeMemoryStorage(): StoragePort & { _objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    _objects: objects,
    async putObject(key, bytes) {
      objects.set(key, bytes);
    },
    async getObject(key) {
      const b = objects.get(key);
      if (!b) throw new Error('not found');
      return b;
    },
    async getSignedUrl(key) {
      return `mem://${key}`;
    },
  };
}

// Ports nao usados pelo ContentAgent — lancam se chamados.
const ni = (n: string) => () => {
  throw new Error(`${n} nao deveria ser chamado`);
};
const unusedPayment = {
  createPixCharge: ni('createPixCharge'),
  getPayment: ni('getPayment'),
  parseWebhook: ni('parseWebhook'),
} as unknown as PaymentPort;
const unusedEmail = { send: ni('send') } as unknown as EmailPort;
const unusedInstagram = {
  publishPost: ni('publishPost'),
  uploadMedia: ni('uploadMedia'),
  getAccountInsights: ni('getAccountInsights'),
  getPostInsights: ni('getPostInsights'),
} as unknown as InstagramPort;
const unusedAds = {
  createCampaign: ni('createCampaign'),
  updateBudget: ni('updateBudget'),
  setStatus: ni('setStatus'),
  getInsights: ni('getInsights'),
} as unknown as AdsPort;

const env: AgentEnv = {
  ENABLE_AGENTS: true,
  MAX_AD_BUDGET_BRL: 300,
  TARGET_DAILY_REVENUE_BRL: 1000,
  PUBLIC_BASE_URL: 'http://localhost:3001',
  CONTENT_MODEL: 'claude-sonnet-4-6',
  PLANNING_MODEL: 'claude-opus-4-8',
};

const clock: Clock = { now: () => new Date('2026-06-10T12:00:00.000Z') };

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeCtx(prisma: ReturnType<typeof makeFakePrisma>, storage: StoragePort): AgentContext {
  const ports: Ports = {
    llm: new StubLLMAdapter(),
    storage,
    payment: unusedPayment,
    email: unusedEmail,
    instagram: unusedInstagram,
    ads: unusedAds,
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma: prisma as any,
    ports,
    env,
    log,
    clock,
    cycleId: 'cycle_test',
  };
}

describe('slugify', () => {
  it('remove acentos e normaliza', () => {
    expect(slugify('Produtividade Máxima!')).toBe('produtividade-maxima');
  });
  it('trunca em 80 chars', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe('clampMetaDescription (SEO)', () => {
  it('mantem descricoes curtas intactas (apenas normaliza espacos)', () => {
    const d = clampMetaDescription('Aprenda  a   investir   do zero.');
    expect(d).toBe('Aprenda a investir do zero.');
    expect(d.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
  });
  it('corta descricoes longas no limite de meta description', () => {
    const long = 'palavra '.repeat(60).trim(); // ~419 chars
    const d = clampMetaDescription(long);
    expect(d.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
    expect(d.endsWith('…')).toBe(true);
    // Nao corta no meio de uma palavra (termina em reticencias apos um token).
    expect(d).not.toMatch(/pala…$/);
  });
});

describe('ContentAgent', () => {
  beforeEach(() => {
    log.info.mockClear();
    log.error.mockClear();
  });

  it('vincula generatedByRunId ao AgentRun corrente via execute()', async () => {
    const prisma = makeFakePrisma();
    const storage = makeMemoryStorage();
    const agent = new ContentAgent(undefined, { niche: 'SEO' });

    await agent.execute(makeCtx(prisma, storage));

    const ebook = prisma._ebooks[0]!;
    const run = prisma._agentRuns[0]!;
    expect(ebook.generatedByRunId).toBe(run.id);
  });

  it('marketingDescription respeita o limite de meta description (<=160)', async () => {
    const prisma = makeFakePrisma();
    const storage = makeMemoryStorage();
    const agent = new ContentAgent(undefined, { niche: 'Produtividade' });

    await agent.execute(makeCtx(prisma, storage));

    const product = prisma._products[0]!;
    expect((product.description as string).length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
  });

  it('SKIPPED quando niche ausente', async () => {
    const prisma = makeFakePrisma();
    const storage = makeMemoryStorage();
    const agent = new ContentAgent(undefined, {});
    const record = await agent.execute(makeCtx(prisma, storage));
    expect(record.status).toBe('SKIPPED');
    // Nenhum ebook criado.
    expect(prisma._ebooks.length).toBe(0);
  });

  it('gera ebook + product e persiste PDF com o StubLLMAdapter', async () => {
    const prisma = makeFakePrisma();
    const storage = makeMemoryStorage();
    const agent = new ContentAgent(undefined, { niche: 'Marketing Digital' });

    const record = await agent.execute(makeCtx(prisma, storage));

    expect(record.status).toBe('SUCCESS');
    // Ebook criado, publicado.
    expect(prisma._ebooks.length).toBe(1);
    const ebook = prisma._ebooks[0]!;
    expect(ebook.status).toBe('PUBLISHED');
    expect(ebook.niche).toBe('Marketing Digital');
    expect(typeof ebook.pdfPath).toBe('string');
    expect(ebook.contentMarkdown).toContain('#');

    // Product criado com preco-ancora R$47,00 (4700 centavos).
    expect(prisma._products.length).toBe(1);
    const product = prisma._products[0]!;
    expect(product.priceCents).toBe(4700);
    expect(product.currency).toBe('BRL');
    expect(product.active).toBe(true);

    // PDF persistido no storage sob a key referenciada pelo ebook.
    expect(storage._objects.has(ebook.pdfPath as string)).toBe(true);
    const pdfBytes = storage._objects.get(ebook.pdfPath as string)!;
    expect(pdfBytes.length).toBeGreaterThan(0);

    // Event EBOOK_PUBLISHED emitido.
    expect(prisma._events.length).toBe(1);
    expect(prisma._events[0]!.type).toBe('EBOOK_PUBLISHED');

    // Expoe ids para o chamador vincular generatedByRunId.
    expect(agent.lastEbookId).toBe(ebook.id);
    expect(agent.lastProductId).toBe(product.id);
  });

  it('acumula tokens/custo (>0) no AgentRunResult', async () => {
    const prisma = makeFakePrisma();
    const storage = makeMemoryStorage();
    const agent = new ContentAgent(undefined, { niche: 'Financas Pessoais' });

    // Espia o run direto para inspecionar o resultado bruto.
    const ctx = makeCtx(prisma, storage);
    const result = await agent.run(ctx);

    expect(result.status).toBe('SUCCESS');
    expect((result.tokensIn ?? 0)).toBeGreaterThan(0);
    expect((result.tokensOut ?? 0)).toBeGreaterThan(0);
    expect((result.costCents ?? 0)).toBeGreaterThanOrEqual(0);
    expect(result.metrics).toMatchObject({ chapters: expect.any(Number) });
  });

  it('gera slugs unicos quando ja existe colisao', async () => {
    const prisma = makeFakePrisma();
    const storage = makeMemoryStorage();

    const a1 = new ContentAgent(undefined, { niche: 'Yoga' });
    await a1.execute(makeCtx(prisma, storage));
    const a2 = new ContentAgent(undefined, { niche: 'Yoga' });
    await a2.execute(makeCtx(prisma, storage));

    const slugs = prisma._ebooks.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length); // todos unicos
  });
});
