// Testes do pipeline de lancamento (GATES de mercado + qualidade) com stubs
// deterministicos (sem rede/DB real). Cobre os 4 cenarios obrigatorios:
//   1) sem oportunidade -> recusa (GATE 1, nada publicado)
//   2) com oportunidade + QA PASS -> publica e cria Product
//   3) QA NEEDS_FIX -> corrige no loop e so publica apos PASS
//   4) QA FAIL -> nunca publica

import { describe, it, expect, vi } from 'vitest';
import type {
  EbookAudit,
  EbookAuditVerdict,
  MarketOpportunityRecord,
  Ports,
} from '@ebook-empire/core';
import type { AgentContext, AgentEnv, AgentLogger, Clock } from '../base.js';
import {
  createAndLaunchEbook,
  createDefaultPublish,
  type EbookQaCapability,
  type LaunchDeps,
  type MarketResearchCapability,
  type ContentGenerationCapability,
} from './launch-pipeline.js';

// ------------------------------------------------------------
// Fake minimo de PrismaClient (ebook/product/event) para o publish default.
// ------------------------------------------------------------
interface Row {
  id: string;
  [key: string]: unknown;
}
function makeFakePrisma() {
  const ebooks: Row[] = [];
  const products: Row[] = [];
  const events: Row[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}_${++seq}`;
  return {
    _ebooks: ebooks,
    _products: products,
    _events: events,
    ebook: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId('ebook'), ...data };
        ebooks.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => {
        return ebooks.find((e) => e.id === where.id) ?? null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = ebooks.find((e) => e.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
      ),
    },
    product: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId('product'), ...data };
        products.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: { ebookId: string; active: boolean } }) => {
        return (
          products.find((p) => p.ebookId === where.ebookId && p.active === where.active) ?? null
        );
      }),
      findUnique: vi.fn(async ({ where }: { where: { slug?: string } }) => {
        return products.find((p) => where.slug && p.slug === where.slug) ?? null;
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

const env: AgentEnv = {
  ENABLE_AGENTS: true,
  MAX_AD_BUDGET_BRL: 300,
  TARGET_DAILY_REVENUE_BRL: 1000,
  PUBLIC_BASE_URL: 'http://localhost:3001',
  CONTENT_MODEL: 'claude-sonnet-4-6',
  PLANNING_MODEL: 'claude-opus-4-8',
  QA_MAX_FIX_ITERATIONS: 2,
};

const log: AgentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const clock: Clock = { now: () => new Date('2026-06-10T12:00:00.000Z') };

function makeCtx(prisma: ReturnType<typeof makeFakePrisma>): AgentContext {
  return {
    prisma: prisma as unknown as AgentContext['prisma'],
    ports: {} as Ports,
    env,
    log,
    clock,
    cycleId: 'cycle_test',
  };
}

// ------------------------------------------------------------
// Stubs das capacidades injetaveis.
// ------------------------------------------------------------
function makeOpportunity(): MarketOpportunityRecord {
  return {
    id: 'opp_1',
    segment: 'Financas Pessoais',
    niche: 'Investir do zero',
    demandScore: 80,
    competitionScore: 30,
    potentialScore: 90,
    rationale: 'Alta demanda e baixa concorrencia.',
    titleIdeas: ['Investir do Zero em 30 Dias'],
    angles: ['iniciantes'],
    evidence: ['related: como investir', 'paa: por onde comecar'],
    status: 'SELECTED',
    createdAt: new Date('2026-06-10T11:00:00.000Z'),
    rankedAt: new Date('2026-06-10T11:00:00.000Z'),
    updatedAt: new Date('2026-06-10T11:00:00.000Z'),
  };
}

function marketWith(opp: MarketOpportunityRecord | null): MarketResearchCapability {
  return { rankAndPick: vi.fn(async () => opp) };
}

function makeAudit(verdict: EbookAuditVerdict, score: number, iteration = 0): EbookAudit {
  return {
    ebookId: 'ebook_1',
    score,
    verdict,
    issues: [],
    recommendations: [],
    dimensionScores: { structure: score, contentQuality: score, marketFit: score, compliance: score },
    iteration,
    auditedAt: '2026-06-10T12:00:00.000Z',
  };
}

// Content stub: cria um ebook DRAFT no fake prisma e devolve o id.
function contentStub(prisma: ReturnType<typeof makeFakePrisma>): ContentGenerationCapability {
  return {
    generateDraft: vi.fn(async (_ctx, input) => {
      const e = await prisma.ebook.create({
        data: {
          title: input.title ?? 'Ebook',
          niche: input.niche,
          slug: `slug-${prisma._ebooks.length + 1}`,
          status: 'DRAFT',
          marketOpportunityId: input.marketOpportunityId,
        },
      });
      return { ebookId: e.id };
    }),
  };
}

function deps(
  prisma: ReturnType<typeof makeFakePrisma>,
  over: Partial<LaunchDeps>,
): Partial<LaunchDeps> {
  return {
    content: contentStub(prisma),
    publish: createDefaultPublish(),
    ...over,
  };
}

// ============================================================
// TESTES
// ============================================================
describe('createAndLaunchEbook — GATES', () => {
  it('GATE 1: sem oportunidade -> recusa e NAO gera ebook', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma);
    const content = contentStub(prisma);

    const result = await createAndLaunchEbook(ctx, {}, {
      market: marketWith(null),
      qa: { auditEbook: vi.fn() } as unknown as EbookQaCapability,
      content,
      publish: createDefaultPublish(),
    });

    expect(result.launched).toBe(false);
    expect(result.stage).toBe('MARKET_GATE');
    // Nenhum ebook gerado, nenhum product criado.
    expect(prisma._ebooks.length).toBe(0);
    expect(prisma._products.length).toBe(0);
    expect((content.generateDraft as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('oportunidade + QA PASS -> publica (PUBLISHED) e cria Product ativo', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma);

    const qa: EbookQaCapability = { auditEbook: vi.fn(async () => makeAudit('PASS', 88)) };

    const result = await createAndLaunchEbook(
      ctx,
      {},
      deps(prisma, { market: marketWith(makeOpportunity()), qa }),
    );

    expect(result.launched).toBe(true);
    expect(result.stage).toBe('PUBLISHED');
    expect(result.verdict).toBe('PASS');
    expect(result.fixIterations).toBe(0);

    // Ebook publicado + vinculado a oportunidade.
    expect(prisma._ebooks.length).toBe(1);
    const ebook = prisma._ebooks[0]!;
    expect(ebook.status).toBe('PUBLISHED');
    expect(ebook.marketOpportunityId).toBe('opp_1');

    // Product ativo criado (ancora R$47).
    expect(prisma._products.length).toBe(1);
    expect(prisma._products[0]!.priceCents).toBe(4700);
    expect(prisma._products[0]!.active).toBe(true);

    // Event EBOOK_PUBLISHED emitido via pipeline.
    expect(prisma._events.length).toBe(1);
    expect(prisma._events[0]!.type).toBe('EBOOK_PUBLISHED');
  });

  it('QA NEEDS_FIX -> corrige no loop e so publica apos PASS', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma);

    // 1a auditoria NEEDS_FIX; apos 1 correcao -> PASS.
    const auditEbook = vi
      .fn<(ctx: AgentContext, ebookId: string, iteration?: number) => Promise<EbookAudit>>()
      .mockResolvedValueOnce(makeAudit('NEEDS_FIX', 60, 0))
      .mockResolvedValueOnce(makeAudit('PASS', 82, 1));
    const applyFix = vi.fn(async () => {});
    const qa: EbookQaCapability = { auditEbook, applyFix };

    const result = await createAndLaunchEbook(
      ctx,
      {},
      deps(prisma, { market: marketWith(makeOpportunity()), qa }),
    );

    expect(result.launched).toBe(true);
    expect(result.fixIterations).toBe(1);
    expect(applyFix).toHaveBeenCalledTimes(1);
    expect(auditEbook).toHaveBeenCalledTimes(2);
    expect(prisma._products.length).toBe(1);
    expect(prisma._ebooks[0]!.status).toBe('PUBLISHED');
  });

  it('QA NEEDS_FIX que nao melhora -> esgota iteracoes e NAO publica', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma);

    const qa: EbookQaCapability = {
      auditEbook: vi.fn(async () => makeAudit('NEEDS_FIX', 55)),
      applyFix: vi.fn(async () => {}),
    };

    const result = await createAndLaunchEbook(
      ctx,
      { maxFixIterations: 2 },
      deps(prisma, { market: marketWith(makeOpportunity()), qa }),
    );

    expect(result.launched).toBe(false);
    expect(result.stage).toBe('QUALITY_GATE');
    expect(result.verdict).toBe('NEEDS_FIX');
    expect(result.fixIterations).toBe(2);
    // Ebook gerado mas mantido DRAFT; sem Product.
    expect(prisma._ebooks[0]!.status).toBe('DRAFT');
    expect(prisma._products.length).toBe(0);
    // applyFix chamado exatamente maxFixIterations vezes.
    expect((qa.applyFix as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it('QA FAIL -> NUNCA publica (mantem DRAFT, sem Product)', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx(prisma);

    const qa: EbookQaCapability = {
      auditEbook: vi.fn(async () => makeAudit('FAIL', 20)),
      applyFix: vi.fn(async () => {}),
    };

    const result = await createAndLaunchEbook(
      ctx,
      {},
      deps(prisma, { market: marketWith(makeOpportunity()), qa }),
    );

    expect(result.launched).toBe(false);
    expect(result.stage).toBe('QUALITY_GATE');
    expect(result.verdict).toBe('FAIL');
    // FAIL nao entra no loop de correcao.
    expect((qa.applyFix as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(prisma._ebooks[0]!.status).toBe('DRAFT');
    expect(prisma._products.length).toBe(0);
  });
});
