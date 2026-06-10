// Testes COO-Scale (Fase 5): scorers puros dos setores de producao
// (MARKETPLACE/FUNNEL/AFFILIATE), subscore metaProgress do ANALYTICS, regras de
// diagnostico novas (CRM_SECTOR_RULES + REVENUE_BELOW_TARGET) e a consistencia
// das 4 LOCALIZACOES dos novos ActionKinds.

import { describe, it, expect } from 'vitest';
import {
  ACTION_KINDS_SCALE,
  assertFourLocations,
} from './__fixtures__/scale-consistency.js';
import {
  scoreMarketplace,
  scoreFunnel,
  scoreAffiliate,
  crmWeightedScore,
  CRM_SUBSCORE_WEIGHTS,
} from './health-collector.js';
import { metaProgressSubscore } from '../analytics.js';
import { runCrmRules, runRules } from './diagnosis.js';

// ============================================================
// metaProgressSubscore (puro)
// ============================================================
describe('metaProgressSubscore', () => {
  it('= min(100, round(revenue/target*100))', () => {
    expect(metaProgressSubscore(50000, 100000)).toBe(50);
    expect(metaProgressSubscore(100000, 100000)).toBe(100);
    expect(metaProgressSubscore(250000, 100000)).toBe(100); // capado em 100
    expect(metaProgressSubscore(0, 100000)).toBe(0);
  });
  it('sem meta (<=0) => 100 (nao penaliza)', () => {
    expect(metaProgressSubscore(0, 0)).toBe(100);
  });
});

// ============================================================
// Scorers de producao (puros)
// ============================================================
describe('scoreMarketplace (puro)', () => {
  it('sem products => sem sinal (neutro)', () => {
    const s = scoreMarketplace({
      products: 0,
      productsWithoutListing: 0,
      productsWithoutExternalId: 0,
      ebooksWithoutCover: 0,
      deadListings: 0,
    });
    expect(s.hasSignal).toBe(false);
  });
  it('listings mortas + sem capa => derruba liveness/content', () => {
    const s = scoreMarketplace({
      products: 4,
      productsWithoutListing: 0,
      productsWithoutExternalId: 0,
      ebooksWithoutCover: 4, // content = 100 - 4*20 = 20
      deadListings: 2, // liveness = 100 - 2*25 = 50
    });
    expect(s.hasSignal).toBe(true);
    expect(s.subscores.content).toBe(20);
    expect(s.subscores.liveness).toBe(50);
    const score = crmWeightedScore(CRM_SUBSCORE_WEIGHTS.MARKETPLACE, s.subscores);
    expect(score).toBeLessThan(70);
  });
});

describe('scoreFunnel (puro)', () => {
  it('alto abandono de carrinho => payment baixo', () => {
    const s = scoreFunnel({
      impressions: 1000,
      clicks: 500,
      landingViews: 400,
      checkoutsStarted: 100,
      paid: 5, // paymentRate = 5/100 = 5% -> (0.05/0.4)*100 = 12.5 -> 13
    });
    expect(s.hasSignal).toBe(true);
    expect(s.subscores.payment).toBeLessThan(50);
  });
  it('sem trafego no topo => sem sinal', () => {
    const s = scoreFunnel({
      impressions: 0,
      clicks: 0,
      landingViews: 0,
      checkoutsStarted: 0,
      paid: 0,
    });
    expect(s.hasSignal).toBe(false);
  });
});

describe('scoreAffiliate (puro)', () => {
  it('ativos sem receita => revenue baixo', () => {
    const s = scoreAffiliate({
      prospects: 0,
      active: 3,
      paused: 0,
      total: 10,
      attributedRevenueCents: 0,
    });
    expect(s.hasSignal).toBe(true);
    expect(s.subscores.revenue).toBe(30);
  });
});

// ============================================================
// Regras de diagnostico novas (puras)
// ============================================================
describe('runCrmRules', () => {
  it('MARKETPLACE com listing morta => DEAD_LISTING', () => {
    const hit = runCrmRules('MARKETPLACE', {
      deadListings: 2,
      subscores: { content: 100, liveness: 50, coverage: 100 },
    });
    expect(hit?.type).toBe('DEAD_LISTING');
    expect(hit?.suggestedActionKinds).toContain('PAUSE_LISTING');
  });
  it('MARKETPLACE sem capa tem prioridade sobre dead listing', () => {
    const hit = runCrmRules('MARKETPLACE', {
      deadListings: 2,
      subscores: { content: 20, liveness: 50, coverage: 100 },
    });
    expect(hit?.type).toBe('MISSING_COVER');
    expect(hit?.suggestedActionKinds).toContain('GENERATE_MORE_EBOOKS');
  });
  it('FUNNEL com abandono de carrinho => HIGH_CART_ABANDONMENT', () => {
    const hit = runCrmRules('FUNNEL', {
      checkoutsStarted: 100,
      paid: 5,
      subscores: { landing: 100, checkout: 100, payment: 13 },
    });
    expect(hit?.type).toBe('HIGH_CART_ABANDONMENT');
  });
  it('AFFILIATE ativos sem receita => AFFILIATE_REVENUE_ZERO', () => {
    const hit = runCrmRules('AFFILIATE', {
      active: 3,
      total: 10,
      subscores: { revenue: 30, activeRatio: 100, pipeline: 100 },
    });
    expect(hit?.type).toBe('AFFILIATE_REVENUE_ZERO');
    expect(hit?.suggestedActionKinds).toContain('BOOST_AFFILIATE_OUTREACH');
  });
  it('AFFILIATE sem atividade => NO_AFFILIATE_ACTIVITY', () => {
    const hit = runCrmRules('AFFILIATE', {
      active: 0,
      total: 5,
      subscores: { revenue: 100, activeRatio: 0, pipeline: 100 },
    });
    expect(hit?.type).toBe('NO_AFFILIATE_ACTIVITY');
  });
});

describe('ORCHESTRATION REVENUE_BELOW_TARGET (puro)', () => {
  it('lucro < 50% da meta antes do meio-dia UTC => GENERATE_MORE_EBOOKS', () => {
    const hit = runRules('ORCHESTRATION', {
      beforeNoonUtc: true,
      netProfitCentsToday: 10000, // R$100
      targetRevenueCents: 100000, // meta R$1000 -> metade = R$500
      subscores: { heartbeat: 100, cycleSuccess: 100, childHealth: 100 },
    });
    expect(hit?.type).toBe('REVENUE_BELOW_TARGET');
    expect(hit?.suggestedActionKinds).toContain('GENERATE_MORE_EBOOKS');
  });
  it('depois do meio-dia UTC NAO dispara (cai p/ regras de heartbeat)', () => {
    const hit = runRules('ORCHESTRATION', {
      beforeNoonUtc: false,
      netProfitCentsToday: 0,
      targetRevenueCents: 100000,
      subscores: { heartbeat: 100, cycleSuccess: 100, childHealth: 100 },
    });
    expect(hit).toBeNull();
  });
  it('meta ja perto da metade => nao dispara', () => {
    const hit = runRules('ORCHESTRATION', {
      beforeNoonUtc: true,
      netProfitCentsToday: 60000,
      targetRevenueCents: 100000,
      subscores: { heartbeat: 100, cycleSuccess: 100, childHealth: 100 },
    });
    expect(hit).toBeNull();
  });
});

// ============================================================
// CONSISTENCIA DAS 4 LOCALIZACOES (verificacao propria — REGRA DOS 4)
// ============================================================
describe('regra das 4 localizacoes (novos ActionKinds)', () => {
  it('cada ActionKind novo existe nas 4 localizacoes com nome IDENTICO', async () => {
    await expect(assertFourLocations()).resolves.toBeUndefined();
    expect(ACTION_KINDS_SCALE).toEqual([
      'GENERATE_MORE_EBOOKS',
      'PAUSE_LISTING',
      'BOOST_AFFILIATE_OUTREACH',
      'SEND_AFFILIATE_EMAIL',
    ]);
  });
});
