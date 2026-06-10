// FinanceService — Financeiro consolidado (Feature 2).
//
// Computa, on-demand, a DRE simplificada do dia (janela America/Sao_Paulo),
// margem/contribuicao por ebook e por campanha (com ROAS), progresso da meta
// diaria + projecao simples, e persiste o consolidado em FinanceSnapshot
// (idempotente por date — upsert).
//
// Convencao de unidade: dinheiro SEMPRE Int centavos BRL. As UNICAS excecoes
// sao razoes/percentuais (marginPct, roas) que sao number | null — igual ao
// AnalyticsAgent. Strings de usuario em pt-BR.
//
// Reaproveitamento:
//  - saoPauloDay / saoPauloDayBoundsUtc do AnalyticsAgent (janela do dia).
//  - mesmos agregados de receita/spend/LLM que o AnalyticsAgent ja usa.
//
// O nucleo de calculo da DRE e PURO (computeDreFromAggregates) — base dos
// testes numericos exatos, sem DB.

import type {
  CampaignBreakdownResult,
  CampaignMargin,
  DreResult,
  EbookBreakdownResult,
  EbookMargin,
  FinanceSnapshotView,
} from '@ebook-empire/core';

import type { AgentContext } from '../base.js';
import { saoPauloDay, saoPauloDayBoundsUtc } from '../analytics.js';

// ------------------------------------------------------------
// Configuracao de taxas (vinda do env). Asaas PIX cobra um percentual + fixo
// por transacao paga. ASAAS_FEE_PERCENT e em PONTOS PERCENTUAIS (ex.: 0.99 =>
// 0,99%). ASAAS_FEE_FIXED_CENTS e em centavos por order.
// ------------------------------------------------------------
export interface FeeConfig {
  /** Percentual por transacao em pontos percentuais (0.99 = 0,99%). */
  asaasFeePercent: number;
  /** Taxa fixa por transacao paga, em centavos. */
  asaasFeeFixedCents: number;
}

/** Le a config de taxas do env do contexto (defaults stub-friendly). */
export function feeConfigFromEnv(env: AgentContext['env']): FeeConfig {
  return {
    asaasFeePercent: Number(env.ASAAS_FEE_PERCENT ?? 0.99),
    asaasFeeFixedCents: Number(env.ASAAS_FEE_FIXED_CENTS ?? 49),
  };
}

/**
 * Taxa de pagamento de UMA order paga (centavos). Arredondamento half-up no
 * componente percentual + fixo. Determinstico por order (somar por order, NAO
 * sobre o total, para bater com a cobranca real do Asaas por transacao).
 */
export function paymentFeeForOrderCents(priceCents: number, fees: FeeConfig): number {
  const pct = Math.round((priceCents * fees.asaasFeePercent) / 100);
  return pct + fees.asaasFeeFixedCents;
}

/** Soma das taxas de uma lista de orders pagas (cada uma arredondada). */
export function paymentFeesForOrders(priceCentsList: number[], fees: FeeConfig): number {
  return priceCentsList.reduce((acc, price) => acc + paymentFeeForOrderCents(price, fees), 0);
}

/** Margem liquida % com 2 casas, ou null se receita 0 (mesmo guard do core). */
export function marginPctOf(netProfitCents: number, grossRevenueCents: number): number | null {
  if (grossRevenueCents <= 0) return null;
  return Math.round((netProfitCents / grossRevenueCents) * 10000) / 100;
}

// ------------------------------------------------------------
// Nucleo PURO da DRE (sem DB) — base dos testes numericos.
// ------------------------------------------------------------
export interface DreAggregates {
  date: string;
  grossRevenueCents: number;
  paymentFeesCents: number;
  adSpendCents: number;
  llmCostCents: number;
  paidOrders: number;
  targetRevenueCents: number;
  /** Fracao [0..1] do dia ja decorrida (para projecao). 1 => dia fechado. */
  dayFraction: number;
  /** true quando o dia ainda esta em curso (hoje SP). */
  isPartial: boolean;
}

/**
 * Monta o DreResult a partir de agregados ja somados. PURO/deterministico.
 *   netProfit = gross - fees - adSpend - llm
 * Projecao simples: extrapola a receita bruta proporcional a fracao do dia
 * decorrida (linear). Para dia fechado, projecao = receita realizada.
 */
export function computeDreFromAggregates(agg: DreAggregates): DreResult {
  const netProfitCents =
    agg.grossRevenueCents - agg.paymentFeesCents - agg.adSpendCents - agg.llmCostCents;
  const marginPct = marginPctOf(netProfitCents, agg.grossRevenueCents);

  const progressPct =
    agg.targetRevenueCents > 0
      ? Math.round((agg.grossRevenueCents / agg.targetRevenueCents) * 100)
      : 0;
  const metTarget = agg.grossRevenueCents >= agg.targetRevenueCents;

  // Projecao linear: receita / fracao do dia (cap inferior na receita realizada).
  const frac = agg.isPartial && agg.dayFraction > 0 ? Math.min(1, agg.dayFraction) : 1;
  const projectedRevenueCents =
    agg.isPartial && frac > 0
      ? Math.max(agg.grossRevenueCents, Math.round(agg.grossRevenueCents / frac))
      : agg.grossRevenueCents;
  const projectedMetTarget = projectedRevenueCents >= agg.targetRevenueCents;

  return {
    date: agg.date,
    grossRevenueCents: agg.grossRevenueCents,
    paymentFeesCents: agg.paymentFeesCents,
    adSpendCents: agg.adSpendCents,
    llmCostCents: agg.llmCostCents,
    netProfitCents,
    marginPct,
    paidOrders: agg.paidOrders,
    meta: {
      targetRevenueCents: agg.targetRevenueCents,
      progressPct,
      metTarget,
      projectedRevenueCents,
      projectedMetTarget,
      isPartial: agg.isPartial,
    },
  };
}

// ------------------------------------------------------------
// Helpers de janela.
// ------------------------------------------------------------
export interface DayWindow {
  /** Dia local SP YYYY-MM-DD. */
  day: string;
  startUtc: Date;
  endUtc: Date;
  /** true quando `now` cai dentro do dia (dia em curso). */
  isPartial: boolean;
  /** Fracao [0..1] do dia decorrida no instante `now`. */
  dayFraction: number;
}

/** Resolve a janela do dia (default: hoje SP) a partir do clock do contexto. */
export function resolveDayWindow(ctx: AgentContext, day?: string): DayWindow {
  const now = ctx.clock.now();
  const target = day ?? saoPauloDay(now);
  const { startUtc, endUtc } = saoPauloDayBoundsUtc(target);
  const isPartial = now.getTime() >= startUtc.getTime() && now.getTime() < endUtc.getTime();
  const dayFraction = isPartial
    ? (now.getTime() - startUtc.getTime()) / (endUtc.getTime() - startUtc.getTime())
    : 1;
  return { day: target, startUtc, endUtc, isPartial, dayFraction };
}

// ============================================================
// FinanceService
// ============================================================
export class FinanceService {
  /**
   * DRE simplificada do dia: receita bruta (orders PAID/DELIVERED por paidAt) -
   * taxas de pagamento (por order paga) - ad spend (AdInsight) - custo LLM
   * (AgentRun.costCents) = lucro liquido; margem %.
   */
  async computeDre(ctx: AgentContext, opts?: { day?: string }): Promise<DreResult> {
    const fees = feeConfigFromEnv(ctx.env);
    const win = resolveDayWindow(ctx, opts?.day);
    const { startUtc, endUtc } = win;

    // 1) Orders pagas no dia (precisamos do priceCents por order p/ as taxas).
    const orders = await ctx.prisma.order.findMany({
      where: {
        status: { in: ['PAID', 'DELIVERED'] },
        paidAt: { gte: startUtc, lt: endUtc },
      },
      select: { priceCents: true },
    });
    const grossRevenueCents = orders.reduce((acc, o) => acc + o.priceCents, 0);
    const paidOrders = orders.length;
    const paymentFeesCents = paymentFeesForOrders(
      orders.map((o) => o.priceCents),
      fees,
    );

    // 2) Ad spend do dia (AdInsight por date = dia local SP).
    const insightAgg = await ctx.prisma.adInsight.aggregate({
      _sum: { spendCents: true },
      where: { date: new Date(`${win.day}T00:00:00.000Z`) },
    });
    const adSpendCents = insightAgg._sum.spendCents ?? 0;

    // 3) Custo de LLM do dia (AgentRun.costCents no intervalo).
    const llmAgg = await ctx.prisma.agentRun.aggregate({
      _sum: { costCents: true },
      where: { startedAt: { gte: startUtc, lt: endUtc } },
    });
    const llmCostCents = llmAgg._sum.costCents ?? 0;

    const targetRevenueCents = Number(ctx.env.TARGET_DAILY_REVENUE_BRL) * 100;

    return computeDreFromAggregates({
      date: win.day,
      grossRevenueCents,
      paymentFeesCents,
      adSpendCents,
      llmCostCents,
      paidOrders,
      targetRevenueCents,
      dayFraction: win.dayFraction,
      isPartial: win.isPartial,
    });
  }

  /**
   * Contribuicao por ebook: receita e taxas atribuidas pelo ebookId da order;
   * ad spend atribuido best-effort (order.adCampaignId -> campaign.productId ->
   * product.ebookId). LLM NAO entra por ebook (custo compartilhado). Spend nao
   * mapeavel cai no bucket unattributedAdSpendCents.
   */
  async marginByEbook(ctx: AgentContext, opts?: { day?: string }): Promise<EbookBreakdownResult> {
    const fees = feeConfigFromEnv(ctx.env);
    const win = resolveDayWindow(ctx, opts?.day);
    const { startUtc, endUtc } = win;

    const orders = await ctx.prisma.order.findMany({
      where: {
        status: { in: ['PAID', 'DELIVERED'] },
        paidAt: { gte: startUtc, lt: endUtc },
      },
      select: { ebookId: true, priceCents: true },
    });

    // Spend por campanha do dia (para atribuir spend por ebook via campanha).
    const insights = await ctx.prisma.adInsight.findMany({
      where: { date: new Date(`${win.day}T00:00:00.000Z`) },
      select: { campaignId: true, spendCents: true },
    });
    const spendByCampaign = new Map<string, number>();
    for (const ins of insights) {
      spendByCampaign.set(ins.campaignId, (spendByCampaign.get(ins.campaignId) ?? 0) + ins.spendCents);
    }

    // Mapeia campanha -> ebookId (via product.ebookId), best-effort.
    const campaignToEbook = new Map<string, string | null>();
    if (spendByCampaign.size > 0) {
      const campaigns = await ctx.prisma.adCampaign.findMany({
        where: { id: { in: [...spendByCampaign.keys()] } },
        select: { id: true, productId: true },
      });
      const productIds = campaigns
        .map((c) => c.productId)
        .filter((p): p is string => typeof p === 'string');
      const products =
        productIds.length > 0
          ? await ctx.prisma.product.findMany({
              where: { id: { in: productIds } },
              select: { id: true, ebookId: true },
            })
          : [];
      const productToEbook = new Map(products.map((p) => [p.id, p.ebookId]));
      for (const c of campaigns) {
        campaignToEbook.set(c.id, c.productId ? productToEbook.get(c.productId) ?? null : null);
      }
    }

    // Acumula receita/orders/fees por ebook.
    const ebookAgg = new Map<
      string,
      { revenueCents: number; orders: number; paymentFeesCents: number }
    >();
    for (const o of orders) {
      const cur = ebookAgg.get(o.ebookId) ?? { revenueCents: 0, orders: 0, paymentFeesCents: 0 };
      cur.revenueCents += o.priceCents;
      cur.orders += 1;
      cur.paymentFeesCents += paymentFeeForOrderCents(o.priceCents, fees);
      ebookAgg.set(o.ebookId, cur);
    }

    // Atribui spend por ebook; o que nao mapear vai p/ unattributed.
    const adSpendByEbook = new Map<string, number>();
    let unattributedAdSpendCents = 0;
    for (const [campaignId, spend] of spendByCampaign) {
      const ebookId = campaignToEbook.get(campaignId) ?? null;
      if (ebookId) {
        adSpendByEbook.set(ebookId, (adSpendByEbook.get(ebookId) ?? 0) + spend);
      } else {
        unattributedAdSpendCents += spend;
      }
    }

    // Titulos dos ebooks envolvidos (receita OU spend atribuido).
    const ebookIds = new Set<string>([...ebookAgg.keys(), ...adSpendByEbook.keys()]);
    const ebookRows =
      ebookIds.size > 0
        ? await ctx.prisma.ebook.findMany({
            where: { id: { in: [...ebookIds] } },
            select: { id: true, title: true },
          })
        : [];
    const titleById = new Map(ebookRows.map((e) => [e.id, e.title]));

    const ebooks: EbookMargin[] = [...ebookIds].map((ebookId) => {
      const agg = ebookAgg.get(ebookId) ?? { revenueCents: 0, orders: 0, paymentFeesCents: 0 };
      const adSpendAttributedCents = adSpendByEbook.get(ebookId) ?? 0;
      const netProfitCents = agg.revenueCents - agg.paymentFeesCents - adSpendAttributedCents;
      return {
        ebookId,
        title: titleById.get(ebookId) ?? '(ebook removido)',
        revenueCents: agg.revenueCents,
        orders: agg.orders,
        paymentFeesCents: agg.paymentFeesCents,
        adSpendAttributedCents,
        netProfitCents,
        marginPct: marginPctOf(netProfitCents, agg.revenueCents),
      };
    });

    // Ordena por receita desc (estavel para visualizacao).
    ebooks.sort((a, b) => b.revenueCents - a.revenueCents);

    return { date: win.day, ebooks, unattributedAdSpendCents };
  }

  /**
   * Contribuicao por campanha: spend (AdInsight) vs receita das orders com
   * aquela adCampaignId; ROAS = receita/spend. Orders sem campanha (ou com
   * campanha orfã) caem no bucket organic.
   */
  async marginByCampaign(
    ctx: AgentContext,
    opts?: { day?: string },
  ): Promise<CampaignBreakdownResult> {
    const fees = feeConfigFromEnv(ctx.env);
    const win = resolveDayWindow(ctx, opts?.day);
    const { startUtc, endUtc } = win;

    const orders = await ctx.prisma.order.findMany({
      where: {
        status: { in: ['PAID', 'DELIVERED'] },
        paidAt: { gte: startUtc, lt: endUtc },
      },
      select: { adCampaignId: true, priceCents: true },
    });

    const insights = await ctx.prisma.adInsight.findMany({
      where: { date: new Date(`${win.day}T00:00:00.000Z`) },
      select: { campaignId: true, spendCents: true },
    });
    const spendByCampaign = new Map<string, number>();
    for (const ins of insights) {
      spendByCampaign.set(ins.campaignId, (spendByCampaign.get(ins.campaignId) ?? 0) + ins.spendCents);
    }

    // Receita/fees por campanha; orders sem campanha => organic.
    const revenueByCampaign = new Map<
      string,
      { revenueCents: number; paymentFeesCents: number }
    >();
    const organic = { revenueCents: 0, orders: 0 };
    for (const o of orders) {
      const fee = paymentFeeForOrderCents(o.priceCents, fees);
      if (o.adCampaignId) {
        const cur = revenueByCampaign.get(o.adCampaignId) ?? {
          revenueCents: 0,
          paymentFeesCents: 0,
        };
        cur.revenueCents += o.priceCents;
        cur.paymentFeesCents += fee;
        revenueByCampaign.set(o.adCampaignId, cur);
      } else {
        organic.revenueCents += o.priceCents;
        organic.orders += 1;
      }
    }

    // Conjunto de campanhas: as que tem spend OU receita atribuida.
    const campaignIds = new Set<string>([
      ...spendByCampaign.keys(),
      ...revenueByCampaign.keys(),
    ]);
    const campaignRows =
      campaignIds.size > 0
        ? await ctx.prisma.adCampaign.findMany({
            where: { id: { in: [...campaignIds] } },
            select: { id: true, name: true },
          })
        : [];
    const nameById = new Map(campaignRows.map((c) => [c.id, c.name]));

    const campaigns: CampaignMargin[] = [...campaignIds].map((campaignId) => {
      const spendCents = spendByCampaign.get(campaignId) ?? 0;
      const rev = revenueByCampaign.get(campaignId) ?? { revenueCents: 0, paymentFeesCents: 0 };
      const roas = spendCents > 0 ? rev.revenueCents / spendCents : null;
      const netProfitCents = rev.revenueCents - rev.paymentFeesCents - spendCents;
      return {
        campaignId,
        name: nameById.get(campaignId) ?? '(campanha removida)',
        spendCents,
        revenueCents: rev.revenueCents,
        roas,
        netProfitCents,
      };
    });

    campaigns.sort((a, b) => b.revenueCents - a.revenueCents);

    return { date: win.day, campaigns, organic };
  }

  /**
   * Progresso da meta diaria (TARGET_DAILY_REVENUE_BRL) + projecao linear
   * simples baseada na fracao do dia decorrida.
   */
  async goalProgress(
    ctx: AgentContext,
    opts?: { day?: string },
  ): Promise<{ targetCents: number; currentCents: number; pct: number; projectionCents: number }> {
    const dre = await this.computeDre(ctx, opts);
    return {
      targetCents: dre.meta.targetRevenueCents,
      currentCents: dre.grossRevenueCents,
      pct: dre.meta.progressPct,
      projectionCents: dre.meta.projectedRevenueCents,
    };
  }

  /**
   * Persiste/atualiza o consolidado diario (FinanceSnapshot). Idempotente por
   * date (upsert). Retorna a view do snapshot gravado.
   */
  async persistSnapshot(ctx: AgentContext, opts?: { day?: string }): Promise<FinanceSnapshotView> {
    const dre = await this.computeDre(ctx, opts);
    const dateOnly = new Date(`${dre.date}T00:00:00.000Z`);
    const computedAt = ctx.clock.now();

    const row = await ctx.prisma.financeSnapshot.upsert({
      where: { date: dateOnly },
      create: {
        date: dateOnly,
        grossRevenueCents: dre.grossRevenueCents,
        paymentFeesCents: dre.paymentFeesCents,
        adSpendCents: dre.adSpendCents,
        llmCostCents: dre.llmCostCents,
        netProfitCents: dre.netProfitCents,
        marginPct: dre.marginPct,
        paidOrders: dre.paidOrders,
        computedAt,
      },
      update: {
        grossRevenueCents: dre.grossRevenueCents,
        paymentFeesCents: dre.paymentFeesCents,
        adSpendCents: dre.adSpendCents,
        llmCostCents: dre.llmCostCents,
        netProfitCents: dre.netProfitCents,
        marginPct: dre.marginPct,
        paidOrders: dre.paidOrders,
        computedAt,
      },
    });

    return {
      id: row.id,
      date: dre.date,
      grossRevenueCents: row.grossRevenueCents,
      paymentFeesCents: row.paymentFeesCents,
      adSpendCents: row.adSpendCents,
      llmCostCents: row.llmCostCents,
      netProfitCents: row.netProfitCents,
      marginPct: row.marginPct,
      paidOrders: row.paidOrders,
      computedAt: row.computedAt,
    };
  }
}
