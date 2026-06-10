// AnalyticsAgent — consolida resultados do dia.
// Ingere AdInsight + Order/Payment + AgentRun (custo LLM), calcula receita do
// dia, ROAS/ROI, CAC/CPA, ticket medio e progresso da meta (R$1000/dia), e
// emite recomendacao de realocacao de budget rumo a meta. Registra AgentRun.
//
// Convencao de unidade: dinheiro SEMPRE em Int centavos BRL.
// O calculo de KPI e PURO (computeKpis) — base dos testes, sem DB.

import { Agent } from './base.js';
import type { AgentContext, AgentRunResult } from './base.js';
import type { AgentName, KPISnapshot } from '@ebook-empire/core';

/**
 * Subscore 0..100 do progresso da meta diaria de faturamento (COO-Scale / Fase 5).
 * = min(100, round(revenueCents / targetRevenueCents * 100)). Sem meta (<=0) => 100
 * (nada a perseguir, nao penaliza o setor ANALYTICS). Puro/testavel.
 */
export function metaProgressSubscore(
  revenueCents: number,
  targetRevenueCents: number,
): number {
  if (!(targetRevenueCents > 0)) return 100;
  const pct = Math.round((revenueCents / targetRevenueCents) * 100);
  return Math.max(0, Math.min(100, pct));
}

// ------------------------------------------------------------
// Entrada agregada do dia (ja somada a partir do banco).
// ------------------------------------------------------------
export interface KpiInput {
  /** Dia de referencia YYYY-MM-DD (America/Sao_Paulo). */
  date: string;
  /** Receita contabil do dia (Order.priceCents onde PAID/DELIVERED). */
  revenueCents: number;
  /** Spend total de ads do dia (AdInsight). */
  spendCents: number;
  /** Custo de LLM dos agentes no dia (AgentRun.costCents). */
  llmCostCents: number;
  /** Numero de pedidos pagos no dia. */
  paidOrders: number;
  /** Conversoes reportadas pelos ads (AdInsight.conversions). */
  conversions: number;
  /** Meta diaria de faturamento em centavos. */
  targetRevenueCents: number;
}

/**
 * Calcula o KPISnapshot do dia de forma pura/deterministica.
 * Todas as razoes sao null-guarded (undefined quando divisor=0).
 */
export function computeKpis(input: KpiInput): KPISnapshot {
  const {
    date,
    revenueCents,
    spendCents,
    llmCostCents,
    paidOrders,
    conversions,
    targetRevenueCents,
  } = input;

  const profitCents = revenueCents - spendCents - llmCostCents;

  const roas = spendCents > 0 ? revenueCents / spendCents : undefined;
  const roi = spendCents > 0 ? (revenueCents - spendCents) / spendCents : undefined;
  const cacCents =
    spendCents > 0 && paidOrders > 0 ? Math.round(spendCents / paidOrders) : undefined;
  const cpaCents =
    spendCents > 0 && conversions > 0 ? Math.round(spendCents / conversions) : undefined;
  const aovCents = paidOrders > 0 ? Math.round(revenueCents / paidOrders) : undefined;
  const metTarget = revenueCents >= targetRevenueCents;
  const metaProgress = metaProgressSubscore(revenueCents, targetRevenueCents);

  return {
    date,
    revenueCents,
    spendCents,
    profitCents,
    llmCostCents,
    paidOrders,
    roas,
    roi,
    cacCents,
    cpaCents,
    aovCents,
    targetRevenueCents,
    metTarget,
    metaProgress,
  };
}

// ------------------------------------------------------------
// Recomendacao de realocacao de budget rumo a meta.
// ------------------------------------------------------------
export interface BudgetRecommendation {
  /** Acao macro sugerida para o conjunto de campanhas. */
  action: 'SCALE_UP' | 'SCALE_DOWN' | 'HOLD' | 'PAUSE_ALL';
  /** Quanto do gap de receita falta cobrir (centavos, >=0). */
  revenueGapCents: number;
  /** Delta de spend diario agregado sugerido (centavos; pode ser negativo). */
  suggestedSpendDeltaCents: number;
  reason: string;
}

/**
 * Recomenda realocacao de budget com base no KPI do dia e na meta.
 * Heuristica:
 *  - ROAS lucrativo (>=1) e meta nao batida => escalar p/ cobrir o gap,
 *    estimando spend extra = gap / ROAS (limitado pelo headroom).
 *  - ROAS < 1 (queima caixa) => reduzir/pausar.
 *  - Meta batida e lucrativo => manter.
 */
export function recommendBudget(
  kpi: KPISnapshot,
  opts: { maxDailySpendCents: number },
): BudgetRecommendation {
  const revenueGapCents = Math.max(0, kpi.targetRevenueCents - kpi.revenueCents);

  // Sem spend ainda: se ja temos receita organica abaixo da meta, sugerir
  // iniciar trafego com um passo conservador; senao HOLD.
  if (kpi.spendCents === 0) {
    if (revenueGapCents > 0) {
      const step = Math.min(Math.round(opts.maxDailySpendCents * 0.2), opts.maxDailySpendCents);
      return {
        action: 'SCALE_UP',
        revenueGapCents,
        suggestedSpendDeltaCents: step,
        reason: 'sem spend e abaixo da meta — iniciar trafego com passo conservador',
      };
    }
    return {
      action: 'HOLD',
      revenueGapCents,
      suggestedSpendDeltaCents: 0,
      reason: 'meta atingida sem spend — manter',
    };
  }

  const roas = kpi.roas ?? 0;

  // Queima caixa: ROAS < 1 => cortar.
  if (roas < 1) {
    return {
      action: kpi.revenueCents === 0 ? 'PAUSE_ALL' : 'SCALE_DOWN',
      revenueGapCents,
      suggestedSpendDeltaCents: -Math.round(kpi.spendCents * 0.5),
      reason: `ROAS ${roas.toFixed(2)} < 1 — reduzir/pausar para estancar prejuizo`,
    };
  }

  // Lucrativo e meta batida => manter.
  if (revenueGapCents === 0) {
    return {
      action: 'HOLD',
      revenueGapCents,
      suggestedSpendDeltaCents: 0,
      reason: 'meta atingida com ROAS saudavel — manter',
    };
  }

  // Lucrativo e abaixo da meta => escalar para cobrir o gap.
  // Spend extra estimado = gap / ROAS (precisamos de mais trafego do mesmo nivel).
  const headroom = Math.max(0, opts.maxDailySpendCents - kpi.spendCents);
  const wanted = Math.round(revenueGapCents / roas);
  const suggestedSpendDeltaCents = Math.min(wanted, headroom);

  return {
    action: suggestedSpendDeltaCents > 0 ? 'SCALE_UP' : 'HOLD',
    revenueGapCents,
    suggestedSpendDeltaCents,
    reason:
      suggestedSpendDeltaCents > 0
        ? `ROAS ${roas.toFixed(2)} lucrativo e abaixo da meta — escalar +${suggestedSpendDeltaCents}c`
        : `lucrativo mas budget no teto (${opts.maxDailySpendCents}c) — manter`,
  };
}

// ------------------------------------------------------------
// Helpers de data (dia America/Sao_Paulo = UTC-3, sem DST relevante aqui).
// ------------------------------------------------------------
const SAO_PAULO_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Dia local (America/Sao_Paulo) no formato YYYY-MM-DD para um instante. */
export function saoPauloDay(now: Date): string {
  return new Date(now.getTime() - SAO_PAULO_OFFSET_MS).toISOString().slice(0, 10);
}

/** Limites UTC [inicio, fim) do dia local de Sao Paulo. */
export function saoPauloDayBoundsUtc(localDay: string): { startUtc: Date; endUtc: Date } {
  // 00:00 local = 03:00 UTC do mesmo dia.
  const startUtc = new Date(`${localDay}T00:00:00.000Z`).getTime() + SAO_PAULO_OFFSET_MS;
  const endUtc = startUtc + 24 * 60 * 60 * 1000;
  return { startUtc: new Date(startUtc), endUtc: new Date(endUtc) };
}

// ============================================================
// AnalyticsAgent
// ============================================================
export class AnalyticsAgent extends Agent {
  readonly name: AgentName = 'ANALYTICS';

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const { prisma, env, clock, log } = ctx;

    const day = saoPauloDay(clock.now());
    const { startUtc, endUtc } = saoPauloDayBoundsUtc(day);
    const targetRevenueCents = env.TARGET_DAILY_REVENUE_BRL * 100;

    // 1) Receita do dia (pedidos pagos por paidAt no dia local).
    const revenueAgg = await prisma.order.aggregate({
      _sum: { priceCents: true },
      _count: { _all: true },
      where: {
        status: { in: ['PAID', 'DELIVERED'] },
        paidAt: { gte: startUtc, lt: endUtc },
      },
    });
    const revenueCents = revenueAgg._sum.priceCents ?? 0;
    const paidOrders = revenueAgg._count._all;

    // 2) Spend + conversoes do dia (AdInsight por date = dia).
    const insightAgg = await prisma.adInsight.aggregate({
      _sum: { spendCents: true, conversions: true },
      where: { date: new Date(`${day}T00:00:00.000Z`) },
    });
    const spendCents = insightAgg._sum.spendCents ?? 0;
    const conversions = insightAgg._sum.conversions ?? 0;

    // 3) Custo de LLM do dia (AgentRun.costCents no intervalo).
    const llmAgg = await prisma.agentRun.aggregate({
      _sum: { costCents: true },
      where: { startedAt: { gte: startUtc, lt: endUtc } },
    });
    const llmCostCents = llmAgg._sum.costCents ?? 0;

    // 4) Calcula KPIs (puro).
    const kpi = computeKpis({
      date: day,
      revenueCents,
      spendCents,
      llmCostCents,
      paidOrders,
      conversions,
      targetRevenueCents,
    });

    // 5) Recomendacao de realocacao de budget rumo a meta.
    const recommendation = recommendBudget(kpi, {
      maxDailySpendCents: env.MAX_AD_BUDGET_BRL * 100,
    });

    log.info({ kpi, recommendation }, 'analytics do dia');

    // 6) Emite evento operacional de ingestao (idempotencia interna nao usa provider).
    await prisma.event.create({
      data: {
        type: 'INSIGHT_INGESTED',
        revenueCents,
        costCents: spendCents,
        metadata: {
          date: day,
          roas: kpi.roas ?? null,
          metTarget: kpi.metTarget,
          recommendation: recommendation.action,
        } as never,
      },
    });

    return {
      status: 'SUCCESS',
      output: { kpi, recommendation } as never,
      metrics: {
        revenueCents,
        spendCents,
        profitCents: kpi.profitCents,
        progressPct:
          targetRevenueCents > 0
            ? Math.round((revenueCents / targetRevenueCents) * 100)
            : 0,
        // Subscore de progresso da meta (alimenta o health do setor ANALYTICS).
        metaProgress: kpi.metaProgress ?? metaProgressSubscore(revenueCents, targetRevenueCents),
      } as never,
    };
  }
}
