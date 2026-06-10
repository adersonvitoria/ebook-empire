// Testes dos LEVERS de producao (COO-Scale / Fase 5) em LiveRemediationLevers:
// generateMoreEbooks, pauseListing (+ revert), boostAffiliateOutreach,
// sendAffiliateEmail. Prisma + ports stubados (deterministico, sem rede).

import { describe, it, expect, vi } from 'vitest';
import { LiveRemediationLevers } from './levers-live.js';
import type { AgentContext } from '../base.js';

function makeCtx(overrides: {
  prisma?: Record<string, unknown>;
  affiliateFindUnique?: () => unknown;
} = {}): AgentContext {
  const agentRunRows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const basePrisma: Record<string, unknown> = {
    ebook: { count: vi.fn(async () => 0) },
    product: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        active: true,
      })),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id,
        ...data,
      })),
    },
    affiliate: {
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () =>
        overrides.affiliateFindUnique ? overrides.affiliateFindUnique() : null,
      ),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    // Ciclo de vida do Agent (AffiliateOutreachAgent.execute):
    agentRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `run_${++seq}`;
        agentRunRows.set(id, { id, ...data });
        return { id };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = agentRunRows.get(where.id) ?? { id: where.id };
        Object.assign(row, data);
        return row;
      }),
    },
    // marketOpportunity p/ launch pipeline (fallback do GATE 1 quando vazio).
    marketOpportunity: { findFirst: vi.fn(async () => null) },
    event: { create: vi.fn(async () => ({})) },
  };
  const prisma = { ...basePrisma, ...(overrides.prisma ?? {}) };
  return {
    prisma: prisma as unknown as AgentContext['prisma'],
    ports: {
      email: { send: vi.fn(async () => ({})) },
      whatsapp: undefined,
      llm: {
        generateText: vi.fn(async () => ({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } })),
        generateJson: vi.fn(async () => ({
          data: { subject: 's', emailBody: 'b', whatsappBody: 'w' },
          usage: { inputTokens: 1, outputTokens: 1 },
        })),
      },
    } as unknown as AgentContext['ports'],
    env: {
      ENABLE_AGENTS: true,
      MAX_AD_BUDGET_BRL: 300,
      TARGET_DAILY_REVENUE_BRL: 1000,
      PUBLIC_BASE_URL: 'http://localhost:3001',
      CONTENT_MODEL: 'claude-sonnet-4-6',
      PLANNING_MODEL: 'claude-opus-4-8',
      AFFILIATE_OUTREACH_COOLDOWN_DAYS: 7,
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clock: { now: () => new Date('2026-06-10T09:00:00.000Z') },
  };
}

describe('LiveRemediationLevers — producao (COO-Scale)', () => {
  it('pauseListing desativa o Product e guarda active=true no beforeState', async () => {
    const ctx = makeCtx();
    const res = await new LiveRemediationLevers().pauseListing(ctx, { productId: 'prod_1' });
    expect(res.beforeState).toMatchObject({ productId: 'prod_1', active: true });
    expect(res.afterState).toMatchObject({ productId: 'prod_1', active: false });
    expect(ctx.prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod_1' },
      data: { active: false },
    });
  });

  it('pauseListing lanca se o produto nao existe', async () => {
    const ctx = makeCtx({
      prisma: { product: { findUnique: vi.fn(async () => null), update: vi.fn() } },
    });
    await expect(
      new LiveRemediationLevers().pauseListing(ctx, { productId: 'nope' }),
    ).rejects.toThrow(/produto nao encontrado/);
  });

  it('revert(PAUSE_LISTING) religa o Product (active=true)', async () => {
    const ctx = makeCtx();
    const res = await new LiveRemediationLevers().revert(ctx, 'PAUSE_LISTING', {
      productId: 'prod_1',
      active: true,
    });
    expect(res.afterState).toMatchObject({ productId: 'prod_1', active: true });
    expect(ctx.prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod_1' },
      data: { active: true },
    });
  });

  it('generateMoreEbooks chama o launch pipeline N vezes (GATE 1 aborta sem oportunidade)', async () => {
    const ctx = makeCtx();
    const res = await new LiveRemediationLevers().generateMoreEbooks(ctx, { count: 3 });
    // Sem MarketOpportunity, cada lancamento para no GATE de mercado -> nada publicado.
    expect(res.beforeState).toMatchObject({ requested: 3 });
    expect(res.afterState).toMatchObject({ launched: [] });
    // chamou ebook.count 2x (antes/depois).
    expect(ctx.prisma.ebook.count).toHaveBeenCalledTimes(2);
  });

  it('boostAffiliateOutreach roda o AffiliateOutreachAgent (skip sem prospects, sem rede)', async () => {
    const ctx = makeCtx();
    const res = await new LiveRemediationLevers().boostAffiliateOutreach(ctx, {});
    expect(res.afterState).toMatchObject({ boosted: true });
    // ciclo de vida do agente gravou AgentRun (create + update).
    expect(ctx.prisma.agentRun.create).toHaveBeenCalled();
  });

  it('sendAffiliateEmail retorna contacted=false p/ afiliado inexistente', async () => {
    const ctx = makeCtx({ affiliateFindUnique: () => null });
    const res = await new LiveRemediationLevers().sendAffiliateEmail(ctx, {
      affiliateId: 'aff_x',
    });
    expect(res.afterState).toMatchObject({ affiliateId: 'aff_x', contacted: false });
  });

  it('sendAffiliateEmail lanca sem affiliateId', async () => {
    const ctx = makeCtx();
    await expect(
      new LiveRemediationLevers().sendAffiliateEmail(ctx, { affiliateId: '' }),
    ).rejects.toThrow(/affiliateId ausente/);
  });
});
