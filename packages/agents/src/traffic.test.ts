// Testes da otimizacao de budget (decideBudget) — heuristica orientada a ROAS.

import { describe, it, expect } from 'vitest';
import { decideBudget, DEFAULT_BUDGET_POLICY, buildDestinationUrl } from './traffic.js';

const policy = DEFAULT_BUDGET_POLICY;

describe('decideBudget', () => {
  it('HOLD em warm-up (gasto insuficiente)', () => {
    const d = decideBudget({
      currentDailyBudgetCents: 5000,
      spendCents: 500, // < minSpendForDecisionCents (2000)
      revenueCents: 0,
    });
    expect(d.action).toBe('HOLD');
    expect(d.newDailyBudgetCents).toBe(5000);
  });

  it('PAUSE quando ROAS < 1 (queima caixa)', () => {
    const d = decideBudget({
      currentDailyBudgetCents: 5000,
      spendCents: 5000,
      revenueCents: 3000, // ROAS 0.6
    });
    expect(d.action).toBe('PAUSE');
    expect(d.roas).toBeCloseTo(0.6);
    // PAUSE nao altera o budget.
    expect(d.newDailyBudgetCents).toBe(5000);
  });

  it('SCALE_UP quando ROAS >= 2 (escala +20%)', () => {
    const d = decideBudget({
      currentDailyBudgetCents: 5000,
      spendCents: 5000,
      revenueCents: 12000, // ROAS 2.4
    });
    expect(d.action).toBe('SCALE_UP');
    expect(d.newDailyBudgetCents).toBe(6000); // +20%
  });

  it('SCALE_UP respeita o teto maxDailyBudgetCents', () => {
    const d = decideBudget(
      {
        currentDailyBudgetCents: 29000,
        spendCents: 29000,
        revenueCents: 90000, // ROAS forte
      },
      policy,
    );
    expect(d.newDailyBudgetCents).toBe(policy.maxDailyBudgetCents); // capado em 30000
  });

  it('SCALE_DOWN quando ROAS entre pause e scaleDown (reduz -30%)', () => {
    const d = decideBudget({
      currentDailyBudgetCents: 5000,
      spendCents: 5000,
      revenueCents: 6000, // ROAS 1.2 (>=1 e <1.5)
    });
    expect(d.action).toBe('SCALE_DOWN');
    expect(d.newDailyBudgetCents).toBe(3500); // -30%
  });

  it('SCALE_DOWN respeita o piso minDailyBudgetCents', () => {
    const d = decideBudget({
      currentDailyBudgetCents: 1100,
      spendCents: 5000,
      revenueCents: 6000, // ROAS 1.2
    });
    expect(d.newDailyBudgetCents).toBe(policy.minDailyBudgetCents); // 1000
  });

  it('HOLD na zona saudavel (1.5 <= ROAS < 2)', () => {
    const d = decideBudget({
      currentDailyBudgetCents: 5000,
      spendCents: 5000,
      revenueCents: 8500, // ROAS 1.7
    });
    expect(d.action).toBe('HOLD');
    expect(d.newDailyBudgetCents).toBe(5000);
  });

  it('roas undefined quando spend=0', () => {
    const d = decideBudget({
      currentDailyBudgetCents: 5000,
      spendCents: 0,
      revenueCents: 0,
    });
    expect(d.roas).toBeUndefined();
    expect(d.action).toBe('HOLD');
  });
});

describe('buildDestinationUrl', () => {
  it('injeta UTMs de trafego pago', () => {
    const url = buildDestinationUrl('http://localhost:3001', 'meu-produto', 'eb-x');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/p/meu-produto');
    expect(parsed.searchParams.get('utm_source')).toBe('meta');
    expect(parsed.searchParams.get('utm_medium')).toBe('paid');
    expect(parsed.searchParams.get('utm_campaign')).toBe('eb-x');
  });
});
