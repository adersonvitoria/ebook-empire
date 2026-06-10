// Testes do SalesAgent — criacao de oferta-ancora, ajuste de preco por
// conversao e geracao de copy. Usa Prisma fake e LLMPort stub via ctx.ports.

import { describe, it, expect, vi } from 'vitest';
import { SalesAgent } from './sales.js';
import type { AgentContext } from './base.js';

function makeCtx(overrides: {
  ebooks: any[];
  events?: number;
  paidOrders?: number;
}): { ctx: AgentContext; created: any[]; updated: any[]; llmCalls: number } {
  const created: any[] = [];
  const updated: any[] = [];
  let llmCalls = 0;

  const prisma: any = {
    ebook: {
      findMany: vi.fn(async () => overrides.ebooks),
    },
    product: {
      create: vi.fn(async ({ data }: any) => {
        created.push(data);
        return { id: `prod_${created.length}`, ...data };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        updated.push({ where, data });
        return { id: where.id, ...data };
      }),
    },
    event: {
      count: vi.fn(async () => overrides.events ?? 0),
    },
    order: {
      count: vi.fn(async () => overrides.paidOrders ?? 0),
    },
    agentRun: {
      create: vi.fn(async () => ({ id: 'run_1' })),
      update: vi.fn(async () => ({})),
    },
  };

  const llm = {
    generateText: vi.fn(async () => {
      llmCalls++;
      return {
        text: 'Copy de venda persuasiva gerada pelo modelo para o ebook.',
        usage: { inputTokens: 100, outputTokens: 200, costCents: 3 },
      };
    }),
    generateJson: vi.fn(),
  };

  const ctx = {
    prisma,
    ports: { llm } as any,
    env: {
      ENABLE_AGENTS: true,
      MAX_AD_BUDGET_BRL: 300,
      TARGET_DAILY_REVENUE_BRL: 1000,
      PUBLIC_BASE_URL: 'http://localhost:3001',
      CONTENT_MODEL: 'claude-sonnet-4-6',
      PLANNING_MODEL: 'claude-opus-4-8',
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clock: { now: () => new Date('2026-06-10T12:00:00Z') },
  } as unknown as AgentContext;

  return { ctx, created, updated, llmCalls: () => llmCalls } as any;
}

describe('SalesAgent', () => {
  it('SKIP quando nao ha ebook publicado', async () => {
    const { ctx } = makeCtx({ ebooks: [] });
    const agent = new SalesAgent();
    const res = await agent.run(ctx);
    expect(res.status).toBe('SKIPPED');
  });

  it('cria oferta-ancora (R$47) para ebook publicado sem produto ativo', async () => {
    const { ctx, created } = makeCtx({
      ebooks: [
        {
          id: 'ebook_1',
          title: 'Renda Extra com IA',
          niche: 'financas',
          slug: 'renda-extra-ia',
          status: 'PUBLISHED',
          products: [],
        },
      ],
    });
    const agent = new SalesAgent();
    const res = await agent.run(ctx);

    expect(res.status).toBe('SUCCESS');
    expect(created).toHaveLength(1);
    expect(created[0].priceCents).toBe(4700);
    expect(created[0].active).toBe(true);
    expect(created[0].slug).toContain('renda-extra-ia');
    expect((res.output as any).createdProducts).toBe(1);
  });

  it('sobe o preco quando conversao alta (>=40%) com volume suficiente', async () => {
    const { ctx, updated } = makeCtx({
      ebooks: [
        {
          id: 'ebook_1',
          title: 'Ebook',
          niche: 'nicho',
          slug: 'ebook',
          status: 'PUBLISHED',
          products: [
            {
              id: 'prod_1',
              priceCents: 4700,
              active: true,
              description: 'descricao longa o suficiente para nao acionar geracao de copy por LLM aqui.',
            },
          ],
        },
      ],
      events: 20, // checkouts
      paidOrders: 10, // 50% conversao
    });
    const agent = new SalesAgent();
    const res = await agent.run(ctx);

    expect(res.status).toBe('SUCCESS');
    const priceUpdate = updated.find((u) => u.data.priceCents !== undefined);
    expect(priceUpdate.data.priceCents).toBe(5700); // +R$10
  });

  it('reduz o preco quando conversao baixa (<10%)', async () => {
    const { ctx, updated } = makeCtx({
      ebooks: [
        {
          id: 'ebook_1',
          title: 'Ebook',
          niche: 'nicho',
          slug: 'ebook',
          status: 'PUBLISHED',
          products: [
            {
              id: 'prod_1',
              priceCents: 4700,
              active: true,
              description: 'descricao longa o suficiente para nao acionar geracao de copy por LLM.',
            },
          ],
        },
      ],
      events: 30,
      paidOrders: 1, // ~3% conversao
    });
    const agent = new SalesAgent();
    await agent.run(ctx);
    const priceUpdate = updated.find((u) => u.data.priceCents !== undefined);
    expect(priceUpdate.data.priceCents).toBe(3700); // -R$10
  });

  it('gera copy via LLM quando descricao e curta', async () => {
    const ctxBundle = makeCtx({
      ebooks: [
        {
          id: 'ebook_1',
          title: 'Ebook',
          niche: 'nicho',
          slug: 'ebook',
          status: 'PUBLISHED',
          products: [{ id: 'prod_1', priceCents: 4700, active: true, description: '' }],
        },
      ],
      events: 0,
      paidOrders: 0,
    });
    const agent = new SalesAgent();
    const res = await agent.run(ctxBundle.ctx);

    expect(res.status).toBe('SUCCESS');
    expect((res.output as any).copyUpdates).toBe(1);
    expect(res.tokensIn).toBe(100);
    expect(res.tokensOut).toBe(200);
    expect(res.costCents).toBe(3);
  });
});
