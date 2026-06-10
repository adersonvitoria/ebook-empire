// Testes do ActionCatalog (StaticActionCatalog.propose/buildProposal) focados nos
// ProblemTypes/ActionKinds dos setores NOVOS de producao (COO-Scale / Fase 5):
//   MARKETPLACE  DEAD_LISTING            -> PAUSE_LISTING
//   MARKETPLACE  MISSING_COVER           -> GENERATE_MORE_EBOOKS
//   FUNNEL       LANDING_DROPOFF         -> REGENERATE_LANDING_COPY
//   FUNNEL       HIGH_CART_ABANDONMENT   -> REGENERATE_LANDING_COPY
//   AFFILIATE    NO_AFFILIATE_ACTIVITY   -> BOOST_AFFILIATE_OUTREACH
//   AFFILIATE    AFFILIATE_REVENUE_ZERO  -> SEND_AFFILIATE_EMAIL / BOOST_AFFILIATE_OUTREACH
//   ORCHESTRATION REVENUE_BELOW_TARGET   -> GENERATE_MORE_EBOOKS
//
// O catalogo e PURO: ctx so e usado para ler env. Montamos um ctx minimo.

import { describe, it, expect, vi } from 'vitest';
import type { Json } from '@ebook-empire/core';
import { remediationParamsSchema } from '@ebook-empire/core';
import type { AgentContext } from '../base.js';
import { StaticActionCatalog } from './action-catalog.js';
import type {
  ProblemRef,
  Diagnosis,
  CrmSector,
  ActionKind,
} from './contracts.js';

function makeCtx(): AgentContext {
  return {
    prisma: {} as AgentContext['prisma'],
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
    clock: { now: () => new Date('2026-06-10T09:00:00.000Z') },
  };
}

function makeProblem(sector: CrmSector, type: string, metadata: Record<string, Json>): ProblemRef {
  return {
    id: `prob-${sector}-${type}`,
    sector,
    type,
    severity: 80,
    status: 'OPEN',
    rootCause: 'teste',
    snapshotId: null,
    detectedAt: new Date('2026-06-10T09:00:00.000Z'),
    resolvedAt: null,
    metadata: metadata as Json,
  };
}

function makeDiagnosis(
  sector: CrmSector,
  type: string,
  suggested: ActionKind[],
): Diagnosis {
  return {
    sector,
    type,
    severity: 80,
    status: 'OPEN',
    rootCause: 'teste',
    confidence: 0.6,
    evidence: ['evidencia'],
    suggestedActionKinds: suggested,
    source: 'RULES',
  };
}

function propose(
  sector: CrmSector,
  type: string,
  suggested: ActionKind[],
  metadata: Record<string, Json>,
) {
  const catalog = new StaticActionCatalog();
  return catalog.propose(
    makeCtx(),
    makeProblem(sector, type, metadata),
    makeDiagnosis(sector, type, suggested),
  );
}

/** Valida que os params da proposta passam no schema canonico (discriminated union). */
function expectValidParams(params: Json): void {
  const parsed = remediationParamsSchema.safeParse(params);
  expect(parsed.success, JSON.stringify(params)).toBe(true);
}

describe('StaticActionCatalog.propose — setores de producao (COO-Scale)', () => {
  it('MARKETPLACE DEAD_LISTING => PAUSE_LISTING com productId+provider', () => {
    const proposals = propose(
      'MARKETPLACE',
      'DEAD_LISTING',
      ['PAUSE_LISTING', 'BOOST_AFFILIATE_OUTREACH'],
      { productId: 'prod-1', provider: 'hotmart' },
    );
    const pause = proposals.find((p) => p.kind === 'PAUSE_LISTING');
    expect(pause).toBeDefined();
    expect(pause!.riskTier).toBe('HIGH');
    expect(pause!.sector).toBe('MARKETPLACE');
    expect((pause!.params as { productId: string }).productId).toBe('prod-1');
    expectValidParams(pause!.params);
  });

  it('MARKETPLACE MISSING_COVER => GENERATE_MORE_EBOOKS (LOW)', () => {
    const proposals = propose(
      'MARKETPLACE',
      'MISSING_COVER',
      ['GENERATE_MORE_EBOOKS'],
      { niche: 'financas pessoais', count: 2 },
    );
    const gen = proposals.find((p) => p.kind === 'GENERATE_MORE_EBOOKS');
    expect(gen).toBeDefined();
    expect(gen!.riskTier).toBe('LOW');
    expect((gen!.params as { niche?: string }).niche).toBe('financas pessoais');
    expectValidParams(gen!.params);
  });

  it('FUNNEL LANDING_DROPOFF => REGENERATE_LANDING_COPY', () => {
    const proposals = propose(
      'FUNNEL',
      'LANDING_DROPOFF',
      ['REGENERATE_LANDING_COPY'],
      { productId: 'prod-2' },
    );
    const copy = proposals.find((p) => p.kind === 'REGENERATE_LANDING_COPY');
    expect(copy).toBeDefined();
    expect(copy!.riskTier).toBe('LOW');
    expect(copy!.sector).toBe('FUNNEL');
    expectValidParams(copy!.params);
  });

  it('FUNNEL HIGH_CART_ABANDONMENT => REGENERATE_LANDING_COPY', () => {
    const proposals = propose(
      'FUNNEL',
      'HIGH_CART_ABANDONMENT',
      ['REGENERATE_LANDING_COPY'],
      { productId: 'prod-3' },
    );
    expect(proposals.some((p) => p.kind === 'REGENERATE_LANDING_COPY')).toBe(true);
  });

  it('AFFILIATE NO_AFFILIATE_ACTIVITY => BOOST_AFFILIATE_OUTREACH (sem params obrigatorios)', () => {
    const proposals = propose(
      'AFFILIATE',
      'NO_AFFILIATE_ACTIVITY',
      ['BOOST_AFFILIATE_OUTREACH'],
      {},
    );
    const boost = proposals.find((p) => p.kind === 'BOOST_AFFILIATE_OUTREACH');
    expect(boost).toBeDefined();
    expect(boost!.riskTier).toBe('LOW');
    expect(boost!.sector).toBe('AFFILIATE');
    expectValidParams(boost!.params);
  });

  it('AFFILIATE AFFILIATE_REVENUE_ZERO => SEND_AFFILIATE_EMAIL (com affiliateId+templateKey)', () => {
    const proposals = propose(
      'AFFILIATE',
      'AFFILIATE_REVENUE_ZERO',
      ['BOOST_AFFILIATE_OUTREACH', 'SEND_AFFILIATE_EMAIL'],
      { affiliateId: 'aff-1', templateKey: 'reativacao' },
    );
    const send = proposals.find((p) => p.kind === 'SEND_AFFILIATE_EMAIL');
    expect(send).toBeDefined();
    expect((send!.params as { affiliateId: string }).affiliateId).toBe('aff-1');
    expectValidParams(send!.params);
    // BOOST tambem deve estar entre as propostas (kind permitido para o setor).
    expect(proposals.some((p) => p.kind === 'BOOST_AFFILIATE_OUTREACH')).toBe(true);
  });

  it('AFFILIATE_REVENUE_ZERO sem affiliateId NAO propoe SEND_AFFILIATE_EMAIL, mas propoe BOOST', () => {
    const proposals = propose(
      'AFFILIATE',
      'AFFILIATE_REVENUE_ZERO',
      ['BOOST_AFFILIATE_OUTREACH', 'SEND_AFFILIATE_EMAIL'],
      {}, // sem affiliateId
    );
    expect(proposals.some((p) => p.kind === 'SEND_AFFILIATE_EMAIL')).toBe(false);
    expect(proposals.some((p) => p.kind === 'BOOST_AFFILIATE_OUTREACH')).toBe(true);
  });

  it('ORCHESTRATION REVENUE_BELOW_TARGET => GENERATE_MORE_EBOOKS', () => {
    const proposals = propose(
      'ORCHESTRATION',
      'REVENUE_BELOW_TARGET',
      ['GENERATE_MORE_EBOOKS'],
      { niche: 'investimentos', count: 3 },
    );
    const gen = proposals.find((p) => p.kind === 'GENERATE_MORE_EBOOKS');
    expect(gen).toBeDefined();
    expect(gen!.sector).toBe('ORCHESTRATION');
    expect((gen!.params as { count?: number }).count).toBe(3);
    expectValidParams(gen!.params);
  });
});
