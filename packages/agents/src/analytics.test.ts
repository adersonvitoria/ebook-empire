// Testes do calculo de KPI/ROAS (computeKpis) e da recomendacao de budget.

import { describe, it, expect } from 'vitest';
import {
  computeKpis,
  recommendBudget,
  saoPauloDay,
  saoPauloDayBoundsUtc,
} from './analytics.js';

describe('computeKpis', () => {
  const target = 100000; // R$1000/dia

  it('calcula ROAS, ROI, CAC, CPA, AOV e lucro', () => {
    const kpi = computeKpis({
      date: '2026-06-10',
      revenueCents: 120000, // R$1200
      spendCents: 40000, // R$400
      llmCostCents: 2000, // R$20
      paidOrders: 24,
      conversions: 20,
      targetRevenueCents: target,
    });

    expect(kpi.roas).toBeCloseTo(3.0); // 120000/40000
    expect(kpi.roi).toBeCloseTo(2.0); // (120000-40000)/40000
    expect(kpi.cacCents).toBe(Math.round(40000 / 24)); // 1667
    expect(kpi.cpaCents).toBe(Math.round(40000 / 20)); // 2000
    expect(kpi.aovCents).toBe(Math.round(120000 / 24)); // 5000
    expect(kpi.profitCents).toBe(120000 - 40000 - 2000); // 78000
    expect(kpi.metTarget).toBe(true); // 120000 >= 100000
  });

  it('null-guard quando spend=0 (ROAS/ROI/CAC/CPA undefined)', () => {
    const kpi = computeKpis({
      date: '2026-06-10',
      revenueCents: 47000,
      spendCents: 0,
      llmCostCents: 0,
      paidOrders: 10,
      conversions: 0,
      targetRevenueCents: target,
    });
    expect(kpi.roas).toBeUndefined();
    expect(kpi.roi).toBeUndefined();
    expect(kpi.cacCents).toBeUndefined();
    expect(kpi.cpaCents).toBeUndefined();
    expect(kpi.aovCents).toBe(4700); // receita organica
    expect(kpi.profitCents).toBe(47000);
  });

  it('null-guard quando paidOrders=0 (AOV/CAC undefined)', () => {
    const kpi = computeKpis({
      date: '2026-06-10',
      revenueCents: 0,
      spendCents: 5000,
      llmCostCents: 0,
      paidOrders: 0,
      conversions: 0,
      targetRevenueCents: target,
    });
    expect(kpi.aovCents).toBeUndefined();
    expect(kpi.cacCents).toBeUndefined();
    expect(kpi.roas).toBeCloseTo(0); // 0/5000
    expect(kpi.metTarget).toBe(false);
  });

  it('metTarget=true exatamente na meta', () => {
    const kpi = computeKpis({
      date: '2026-06-10',
      revenueCents: target,
      spendCents: 10000,
      llmCostCents: 0,
      paidOrders: 5,
      conversions: 5,
      targetRevenueCents: target,
    });
    expect(kpi.metTarget).toBe(true);
  });
});

describe('recommendBudget', () => {
  const target = 100000;
  const maxDailySpendCents = 30000;

  function kpiWith(revenueCents: number, spendCents: number) {
    return computeKpis({
      date: '2026-06-10',
      revenueCents,
      spendCents,
      llmCostCents: 0,
      paidOrders: spendCents > 0 ? 5 : 0,
      conversions: 5,
      targetRevenueCents: target,
    });
  }

  it('PAUSE_ALL quando ha spend e receita zero', () => {
    const r = recommendBudget(kpiWith(0, 10000), { maxDailySpendCents });
    expect(r.action).toBe('PAUSE_ALL');
    expect(r.suggestedSpendDeltaCents).toBeLessThan(0);
  });

  it('SCALE_DOWN quando ROAS < 1 mas ha alguma receita', () => {
    const r = recommendBudget(kpiWith(5000, 10000), { maxDailySpendCents }); // ROAS 0.5
    expect(r.action).toBe('SCALE_DOWN');
    expect(r.suggestedSpendDeltaCents).toBe(-5000); // -50% do spend
  });

  it('HOLD quando meta batida e ROAS saudavel', () => {
    const r = recommendBudget(kpiWith(120000, 30000), { maxDailySpendCents }); // ROAS 4, meta ok
    expect(r.action).toBe('HOLD');
    expect(r.suggestedSpendDeltaCents).toBe(0);
  });

  it('SCALE_UP lucrativo e abaixo da meta — gap/ROAS limitado por headroom', () => {
    // revenue 50000, spend 10000 => ROAS 5; gap 50000; wanted = 50000/5 = 10000;
    // headroom = 30000 - 10000 = 20000 => sugere +10000.
    const r = recommendBudget(kpiWith(50000, 10000), { maxDailySpendCents });
    expect(r.action).toBe('SCALE_UP');
    expect(r.revenueGapCents).toBe(50000);
    expect(r.suggestedSpendDeltaCents).toBe(10000);
  });

  it('SCALE_UP capado pelo headroom restante', () => {
    // revenue 40000, spend 28000 => ROAS ~1.43; gap 60000; wanted = 60000/1.43 ~ 41958;
    // headroom = 30000 - 28000 = 2000 => sugere +2000.
    const r = recommendBudget(kpiWith(40000, 28000), { maxDailySpendCents });
    expect(r.action).toBe('SCALE_UP');
    expect(r.suggestedSpendDeltaCents).toBe(2000);
  });

  it('sem spend e abaixo da meta — inicia trafego com passo conservador', () => {
    const r = recommendBudget(kpiWith(20000, 0), { maxDailySpendCents });
    expect(r.action).toBe('SCALE_UP');
    expect(r.suggestedSpendDeltaCents).toBe(Math.round(maxDailySpendCents * 0.2)); // 6000
  });
});

describe('helpers de data Sao Paulo', () => {
  it('saoPauloDay converte instante UTC para dia local (UTC-3)', () => {
    // 2026-06-11T01:00:00Z = 2026-06-10 22:00 em Sao Paulo.
    expect(saoPauloDay(new Date('2026-06-11T01:00:00.000Z'))).toBe('2026-06-10');
    // 2026-06-11T03:00:00Z = 2026-06-11 00:00 em Sao Paulo.
    expect(saoPauloDay(new Date('2026-06-11T03:00:00.000Z'))).toBe('2026-06-11');
  });

  it('saoPauloDayBoundsUtc: 00:00 local = 03:00 UTC e janela de 24h', () => {
    const { startUtc, endUtc } = saoPauloDayBoundsUtc('2026-06-10');
    expect(startUtc.toISOString()).toBe('2026-06-10T03:00:00.000Z');
    expect(endUtc.toISOString()).toBe('2026-06-11T03:00:00.000Z');
  });
});
