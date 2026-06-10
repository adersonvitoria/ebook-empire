// TrafficAgent — gestao de trafego pago.
// Cria/otimiza AdCampaign para um Ebook, ajusta budget conforme ROAS e
// pausa campanhas ruins. Registra AgentRun via ciclo de vida da classe base.
//
// Convencao de unidade: dinheiro SEMPRE em Int centavos BRL.
// Regras de decisao puras vivem em funcoes exportadas (testaveis sem DB).

import { Agent, skipped } from './base.js';
import type { AgentContext, AgentRunResult } from './base.js';
import type { AgentName } from '@ebook-empire/core';

// ------------------------------------------------------------
// Parametros de otimizacao (heuristica de budget orientada a ROAS).
// ------------------------------------------------------------
export interface BudgetPolicy {
  /** ROAS abaixo do qual a campanha e pausada (gasto sem retorno). */
  pauseRoasThreshold: number;
  /** ROAS a partir do qual escalamos o budget (+step). */
  scaleUpRoasThreshold: number;
  /** ROAS abaixo do qual reduzimos o budget (mas ainda nao pausa). */
  scaleDownRoasThreshold: number;
  /** Fator de aumento por ciclo (ex. 0.2 = +20%). */
  scaleUpFactor: number;
  /** Fator de reducao por ciclo (ex. 0.3 = -30%). */
  scaleDownFactor: number;
  /** Budget diario minimo (centavos) para manter a campanha viva. */
  minDailyBudgetCents: number;
  /** Teto de budget diario por campanha (centavos) — guarda de seguranca. */
  maxDailyBudgetCents: number;
  /** Gasto minimo (centavos) antes de confiar no ROAS p/ decidir (warm-up). */
  minSpendForDecisionCents: number;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  pauseRoasThreshold: 1.0, // ROAS < 1 => queima caixa => pausa
  scaleUpRoasThreshold: 2.0, // ROAS >= 2 => escala
  scaleDownRoasThreshold: 1.5, // ROAS < 1.5 (e >= pause) => reduz
  scaleUpFactor: 0.2,
  scaleDownFactor: 0.3,
  minDailyBudgetCents: 1000, // R$10/dia
  maxDailyBudgetCents: 30000, // R$300/dia (default MAX_AD_BUDGET_BRL)
  minSpendForDecisionCents: 2000, // R$20 de warm-up
};

export type BudgetDecisionAction = 'SCALE_UP' | 'SCALE_DOWN' | 'PAUSE' | 'HOLD';

export interface BudgetDecisionInput {
  /** Budget diario atual da campanha (centavos). */
  currentDailyBudgetCents: number;
  /** Gasto acumulado na janela analisada (centavos). */
  spendCents: number;
  /** Receita atribuida na janela (centavos). */
  revenueCents: number;
}

export interface BudgetDecision {
  action: BudgetDecisionAction;
  /** Novo budget diario sugerido (centavos). Igual ao atual quando HOLD/PAUSE. */
  newDailyBudgetCents: number;
  /** ROAS calculado (undefined quando spend=0). */
  roas?: number;
  reason: string;
}

/**
 * Decide a acao de budget de UMA campanha a partir de spend/revenue.
 * Pura e deterministica — base dos testes de otimizacao.
 */
export function decideBudget(
  input: BudgetDecisionInput,
  policy: BudgetPolicy = DEFAULT_BUDGET_POLICY,
): BudgetDecision {
  const { currentDailyBudgetCents, spendCents, revenueCents } = input;
  const roas = spendCents > 0 ? revenueCents / spendCents : undefined;

  // Warm-up: sem gasto suficiente, nao mexe (evita decisao por ruido).
  if (spendCents < policy.minSpendForDecisionCents) {
    return {
      action: 'HOLD',
      newDailyBudgetCents: currentDailyBudgetCents,
      roas,
      reason: 'warm-up: gasto insuficiente para decidir',
    };
  }

  // ROAS abaixo do piso => pausa (queima caixa).
  if (roas !== undefined && roas < policy.pauseRoasThreshold) {
    return {
      action: 'PAUSE',
      newDailyBudgetCents: currentDailyBudgetCents,
      roas,
      reason: `ROAS ${roas.toFixed(2)} < ${policy.pauseRoasThreshold} — pausando`,
    };
  }

  // ROAS forte => escala (respeitando o teto).
  if (roas !== undefined && roas >= policy.scaleUpRoasThreshold) {
    const scaled = Math.round(currentDailyBudgetCents * (1 + policy.scaleUpFactor));
    const newBudget = Math.min(scaled, policy.maxDailyBudgetCents);
    return {
      action: newBudget > currentDailyBudgetCents ? 'SCALE_UP' : 'HOLD',
      newDailyBudgetCents: newBudget,
      roas,
      reason:
        newBudget > currentDailyBudgetCents
          ? `ROAS ${roas.toFixed(2)} >= ${policy.scaleUpRoasThreshold} — escalando +${Math.round(policy.scaleUpFactor * 100)}%`
          : `ROAS forte mas budget ja no teto (${policy.maxDailyBudgetCents})`,
    };
  }

  // ROAS mediano (entre pause e scaleDown) => reduz para preservar margem.
  if (roas !== undefined && roas < policy.scaleDownRoasThreshold) {
    const scaled = Math.round(currentDailyBudgetCents * (1 - policy.scaleDownFactor));
    const newBudget = Math.max(scaled, policy.minDailyBudgetCents);
    return {
      action: newBudget < currentDailyBudgetCents ? 'SCALE_DOWN' : 'HOLD',
      newDailyBudgetCents: newBudget,
      roas,
      reason:
        newBudget < currentDailyBudgetCents
          ? `ROAS ${roas.toFixed(2)} < ${policy.scaleDownRoasThreshold} — reduzindo -${Math.round(policy.scaleDownFactor * 100)}%`
          : `ROAS fraco mas budget ja no piso (${policy.minDailyBudgetCents})`,
    };
  }

  // Zona saudavel (scaleDown <= ROAS < scaleUp) => mantem.
  return {
    action: 'HOLD',
    newDailyBudgetCents: currentDailyBudgetCents,
    roas,
    reason: roas !== undefined ? `ROAS ${roas.toFixed(2)} saudavel — mantendo` : 'sem ROAS',
  };
}

// ------------------------------------------------------------
// Janela de insights padrao para decisao (ultimos N dias).
// ------------------------------------------------------------
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function lookbackRange(now: Date, days: number): { since: string; until: string } {
  const until = isoDay(now);
  const since = isoDay(new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000));
  return { since, until };
}

// ============================================================
// TrafficAgent
// ============================================================
export class TrafficAgent extends Agent {
  readonly name: AgentName = 'TRAFFIC';

  /** Janela (dias) de insights usada para decidir budget. */
  private readonly lookbackDays: number;
  private readonly policy: BudgetPolicy;

  constructor(opts?: { lookbackDays?: number; policy?: Partial<BudgetPolicy> }) {
    super();
    this.lookbackDays = opts?.lookbackDays ?? 3;
    this.policy = { ...DEFAULT_BUDGET_POLICY, ...(opts?.policy ?? {}) };
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const { prisma, ports, env, log, clock } = ctx;

    // Teto de budget vem do env (MAX_AD_BUDGET_BRL em reais -> centavos).
    const maxDailyBudgetCents = env.MAX_AD_BUDGET_BRL * 100;
    const policy: BudgetPolicy = { ...this.policy, maxDailyBudgetCents };

    // 1) Garante pelo menos uma campanha ativa por Ebook PUBLISHED sem campanha.
    const created = await this.ensureCampaignsForPublishedEbooks(ctx, policy);

    // 2) Otimiza budget das campanhas ACTIVE com base nos insights da janela.
    const active = await prisma.adCampaign.findMany({
      where: { status: 'ACTIVE', platform: 'meta' },
    });

    if (active.length === 0 && created === 0) {
      return skipped('nenhuma campanha ativa e nenhum ebook elegivel');
    }

    const range = lookbackRange(clock.now(), this.lookbackDays);
    const decisions: Array<{
      campaignId: string;
      action: BudgetDecisionAction;
      roas?: number;
      newDailyBudgetCents: number;
    }> = [];

    for (const camp of active) {
      if (!camp.externalCampaignId) continue;

      // Puxa insights frescos do provedor e faz upsert do snapshot diario.
      const rows = await ports.ads.getInsights(camp.externalCampaignId, range);
      let windowSpendCents = 0;
      for (const row of rows) {
        windowSpendCents += row.spendCents;
        await prisma.adInsight.upsert({
          where: { campaignId_date: { campaignId: camp.id, date: new Date(`${row.date}T00:00:00.000Z`) } },
          create: {
            campaignId: camp.id,
            date: new Date(`${row.date}T00:00:00.000Z`),
            impressions: row.impressions,
            clicks: row.clicks,
            spendCents: row.spendCents,
            conversions: row.conversions,
          },
          update: {
            impressions: row.impressions,
            clicks: row.clicks,
            spendCents: row.spendCents,
            conversions: row.conversions,
          },
        });
      }

      // Receita atribuida na janela (pedidos PAID com adCampaignId = camp.id).
      const revenueAgg = await prisma.order.aggregate({
        _sum: { priceCents: true },
        where: {
          adCampaignId: camp.id,
          status: { in: ['PAID', 'DELIVERED'] },
          paidAt: {
            gte: new Date(`${range.since}T00:00:00.000Z`),
            lte: new Date(`${range.until}T23:59:59.999Z`),
          },
        },
      });
      const windowRevenueCents = revenueAgg._sum.priceCents ?? 0;

      const decision = decideBudget(
        {
          currentDailyBudgetCents: camp.dailyBudgetCents ?? policy.minDailyBudgetCents,
          spendCents: windowSpendCents,
          revenueCents: windowRevenueCents,
        },
        policy,
      );

      // Aplica a decisao no provedor + persiste no banco.
      await this.applyDecision(ctx, camp.id, camp.externalCampaignId, camp.utmCampaign, decision);
      log.info(
        { campaignId: camp.id, action: decision.action, roas: decision.roas },
        'decisao de budget',
      );
      decisions.push({
        campaignId: camp.id,
        action: decision.action,
        roas: decision.roas,
        newDailyBudgetCents: decision.newDailyBudgetCents,
      });
    }

    return {
      status: 'SUCCESS',
      output: { created, optimized: decisions.length } as never,
      metrics: { decisions } as never,
    };
  }

  /** Cria campanhas DRAFT->ACTIVE para Ebooks PUBLISHED ainda sem campanha. */
  private async ensureCampaignsForPublishedEbooks(
    ctx: AgentContext,
    policy: BudgetPolicy,
  ): Promise<number> {
    const { prisma, ports, env } = ctx;

    // Ebooks publicados com produto ativo e sem campanha vinculada ao produto.
    const ebooks = await prisma.ebook.findMany({
      where: { status: 'PUBLISHED' },
      include: { products: { where: { active: true }, take: 1 } },
      take: 5,
    });

    let created = 0;
    for (const ebook of ebooks) {
      const product = ebook.products[0];
      if (!product) continue;

      const existing = await prisma.adCampaign.findFirst({
        where: { productId: product.id, status: { in: ['DRAFT', 'ACTIVE', 'PAUSED'] } },
      });
      if (existing) continue;

      const utmCampaign = `eb-${ebook.slug}`.slice(0, 60);
      const dailyBudgetCents = Math.min(policy.minDailyBudgetCents * 2, policy.maxDailyBudgetCents);
      const destinationUrl = buildDestinationUrl(env.PUBLIC_BASE_URL, product.slug, utmCampaign);

      const result = await ports.ads.createCampaign({
        name: `Ebook — ${ebook.title}`.slice(0, 120),
        objective: 'OUTCOME_SALES',
        dailyBudgetCents,
        targeting: { geo_locations: { countries: ['BR'] } },
        utmCampaign,
        destinationUrl,
      });

      // Ativa imediatamente (stub/real) e persiste ACTIVE.
      await ports.ads.setStatus(result.externalId, 'ACTIVE');

      const camp = await prisma.adCampaign.create({
        data: {
          name: `Ebook — ${ebook.title}`.slice(0, 120),
          objective: 'OUTCOME_SALES',
          status: 'ACTIVE',
          platform: 'meta',
          externalCampaignId: result.externalId,
          productId: product.id,
          dailyBudgetCents,
          utmCampaign,
          targeting: { geo_locations: { countries: ['BR'] } },
          startDate: ctx.clock.now(),
        },
        select: { id: true },
      });

      await prisma.event.create({
        data: {
          type: 'CAMPAIGN_CREATED',
          adCampaignId: camp.id,
          productId: product.id,
          utmCampaign,
          costCents: dailyBudgetCents,
        },
      });

      created += 1;
    }
    return created;
  }

  /** Aplica a decisao no provedor de ads e persiste o novo estado. */
  private async applyDecision(
    ctx: AgentContext,
    campaignId: string,
    externalId: string,
    utmCampaign: string | null,
    decision: BudgetDecision,
  ): Promise<void> {
    const { prisma, ports } = ctx;

    if (decision.action === 'PAUSE') {
      await ports.ads.setStatus(externalId, 'PAUSED');
      await prisma.adCampaign.update({
        where: { id: campaignId },
        data: { status: 'PAUSED' },
      });
      return;
    }

    if (decision.action === 'SCALE_UP' || decision.action === 'SCALE_DOWN') {
      await ports.ads.updateBudget(externalId, decision.newDailyBudgetCents);
      await prisma.adCampaign.update({
        where: { id: campaignId },
        data: { dailyBudgetCents: decision.newDailyBudgetCents },
      });
      await prisma.event.create({
        data: {
          type: 'BUDGET_REALLOCATED',
          adCampaignId: campaignId,
          utmCampaign: utmCampaign ?? undefined,
          costCents: decision.newDailyBudgetCents,
          metadata: { action: decision.action, roas: decision.roas ?? null } as never,
        },
      });
    }
    // HOLD => nada a fazer.
  }
}

/** Monta a URL de destino do anuncio com UTMs injetadas. */
export function buildDestinationUrl(
  baseUrl: string,
  productSlug: string,
  utmCampaign: string,
): string {
  const url = new URL(`/p/${productSlug}`, baseUrl);
  url.searchParams.set('utm_source', 'meta');
  url.searchParams.set('utm_medium', 'paid');
  url.searchParams.set('utm_campaign', utmCampaign);
  return url.toString();
}
