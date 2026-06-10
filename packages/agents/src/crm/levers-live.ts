// CRM / Command Center — LiveRemediationLevers.
//
// Composicao CONCRETA das alavancas que o GuardedActionExecutor aciona. Liga
// cada ActionKind ao agente/adapter/DB existente, capturando beforeState/
// afterState para auditoria e habilitando o rollback (revert) das reversiveis.
//
// O EXECUTOR depende so da interface RemediationLevers (executor.ts). Esta
// composicao concreta e oferecida para o scheduler.ts (dono do COO) wirear no
// createOperationsAgent. Mantemos aqui (e nao no scheduler) para reaproveitar os
// agentes-alavanca exportados pelo proprio pacote @ebook-empire/agents.
//
// Convencao: dinheiro SEMPRE Int centavos BRL. Strings de dominio em pt-BR.

import type { AgentName, Json } from '@ebook-empire/core';
import type { ActionKind } from './contracts.js';
import type { AgentContext } from '../base.js';
import type { LeverResult, RemediationLevers } from './executor.js';

import { DeliveryAgent } from '../delivery.js';
import { ContentAgent } from '../content.js';
import { SocialAgent } from '../social.js';
import { AnalyticsAgent } from '../analytics.js';
import { SalesAgent } from '../sales.js';
import { AffiliateOutreachAgent } from '../affiliate-outreach.js';
import { createAndLaunchEbook } from '../launch/launch-pipeline.js';

// Mapa AgentName -> classe concreta (para RERUN_AGENT). OPERATIONS/ORCHESTRATOR
// nao sao reexecutaveis por aqui (o COO nao se reroda nem reroda o CEO).
const RERUNNABLE: Partial<Record<AgentName, () => { execute(ctx: AgentContext): Promise<unknown> }>> = {
  CONTENT: () => new ContentAgent(),
  SALES: () => new SalesAgent(),
  DELIVERY: () => new DeliveryAgent(),
  SOCIAL: () => new SocialAgent(),
  ANALYTICS: () => new AnalyticsAgent(),
  // TRAFFIC tem construtor com opts opcionais; instanciado on-demand abaixo.
};

/**
 * Implementacao concreta das alavancas usando os agentes-alavanca + ports + DB.
 * Cada metodo retorna before/after JSON para a auditoria do executor.
 */
export class LiveRemediationLevers implements RemediationLevers {
  async retryDeliveries(ctx: AgentContext, p: { limit?: number; orderIds?: string[] }): Promise<LeverResult> {
    const before = await this.deliveryBacklog(ctx);
    // O DeliveryAgent ja e idempotente e processa pedidos PAID sem grant.
    await new DeliveryAgent().execute(ctx);
    const after = await this.deliveryBacklog(ctx);
    return {
      beforeState: { backlog: before, limit: p.limit ?? null } as Json,
      afterState: { backlog: after } as Json,
    };
  }

  async generateEbook(ctx: AgentContext, p: { niche: string; count?: number }): Promise<LeverResult> {
    const before = await ctx.prisma.ebook.count();
    const agent = new ContentAgent(undefined, { niche: p.niche });
    await agent.execute(ctx);
    const after = await ctx.prisma.ebook.count();
    return {
      beforeState: { ebookCount: before, niche: p.niche } as Json,
      afterState: { ebookCount: after, newEbookId: agent.lastEbookId } as Json,
    };
  }

  async generateSocialPosts(ctx: AgentContext, p: { productId?: string; count?: number }): Promise<LeverResult> {
    const where = p.productId ? { productId: p.productId } : {};
    const before = await ctx.prisma.socialPost.count({ where });
    await new SocialAgent().execute(ctx);
    const after = await ctx.prisma.socialPost.count({ where });
    return {
      beforeState: { socialPosts: before, productId: p.productId ?? null } as Json,
      afterState: { socialPosts: after } as Json,
    };
  }

  async regenerateLandingCopy(ctx: AgentContext, p: { productId: string }): Promise<LeverResult> {
    const prod = await ctx.prisma.product.findUnique({
      where: { id: p.productId },
      select: { id: true, description: true },
    });
    const before: Json = { productId: p.productId, description: prod?.description ?? null };
    // SalesAgent regenera copy quando a descricao esta curta; forcamos limpando-a
    // para disparar a regeneracao no run, preservando o estado anterior no before.
    await ctx.prisma.product.update({ where: { id: p.productId }, data: { description: '' } });
    await new SalesAgent().execute(ctx);
    const updated = await ctx.prisma.product.findUnique({
      where: { id: p.productId },
      select: { description: true },
    });
    return {
      beforeState: before,
      afterState: { productId: p.productId, description: updated?.description ?? null } as Json,
    };
  }

  async recomputeKpis(ctx: AgentContext, _p: { date?: string }): Promise<LeverResult> {
    await new AnalyticsAgent().execute(ctx);
    return { beforeState: {}, afterState: { recomputed: true } as Json };
  }

  async rerunAgent(ctx: AgentContext, p: { agent: string }): Promise<LeverResult> {
    const name = p.agent as AgentName;
    const factory = RERUNNABLE[name];
    if (!factory) {
      throw new Error(`agente nao reexecutavel: ${p.agent}`);
    }
    await factory().execute(ctx);
    return { beforeState: { agent: p.agent } as Json, afterState: { reran: p.agent } as Json };
  }

  async increaseAdBudget(ctx: AgentContext, p: { campaignId: string; newDailyBudgetCents: number }): Promise<LeverResult> {
    return this.setBudget(ctx, p.campaignId, p.newDailyBudgetCents);
  }

  async decreaseAdBudget(ctx: AgentContext, p: { campaignId: string; newDailyBudgetCents: number }): Promise<LeverResult> {
    return this.setBudget(ctx, p.campaignId, p.newDailyBudgetCents);
  }

  async pauseCampaign(ctx: AgentContext, p: { campaignId: string }): Promise<LeverResult> {
    const camp = await ctx.prisma.adCampaign.findUnique({
      where: { id: p.campaignId },
      select: { id: true, status: true, externalCampaignId: true },
    });
    if (!camp) throw new Error(`campanha nao encontrada: ${p.campaignId}`);
    const before: Json = { campaignId: camp.id, status: camp.status, externalCampaignId: camp.externalCampaignId };
    if (camp.externalCampaignId) await ctx.ports.ads.setStatus(camp.externalCampaignId, 'PAUSED');
    await ctx.prisma.adCampaign.update({ where: { id: camp.id }, data: { status: 'PAUSED' } });
    return { beforeState: before, afterState: { campaignId: camp.id, status: 'PAUSED' } as Json };
  }

  async adjustPrice(ctx: AgentContext, p: { productId: string; newPriceCents: number }): Promise<LeverResult> {
    const prod = await ctx.prisma.product.findUnique({
      where: { id: p.productId },
      select: { id: true, priceCents: true },
    });
    if (!prod) throw new Error(`produto nao encontrado: ${p.productId}`);
    const before: Json = { productId: prod.id, priceCents: prod.priceCents };
    await ctx.prisma.product.update({ where: { id: prod.id }, data: { priceCents: p.newPriceCents } });
    return { beforeState: before, afterState: { productId: prod.id, priceCents: p.newPriceCents } as Json };
  }

  // ----------------------------------------------------------
  // Producao autonoma (COO-Scale / Fase 5)
  // ----------------------------------------------------------

  /**
   * GENERATE_MORE_EBOOKS: gera N ebooks via launch pipeline (createAndLaunchEbook),
   * SEQUENCIALMENTE — cada lancamento respeita os dois GATES (mercado + QA). Se um
   * niche e informado, ele e passado como override; senao o pipeline escolhe a
   * oportunidade topo. NAO reversivel (criacao de conteudo).
   */
  async generateMoreEbooks(
    ctx: AgentContext,
    p: { niche?: string; count?: number },
  ): Promise<LeverResult> {
    const count = Math.max(1, Math.min(10, p.count ?? 1));
    const before = await ctx.prisma.ebook.count({ where: { status: 'PUBLISHED' } });
    const launched: string[] = [];
    const stages: string[] = [];
    for (let i = 0; i < count; i++) {
      try {
        const result = await createAndLaunchEbook(ctx, p.niche ? { niche: p.niche } : {});
        stages.push(result.stage);
        if (result.launched && result.ebookId) launched.push(result.ebookId);
      } catch (err) {
        // Best-effort: uma falha de lancamento (ex. wiring de mercado ausente) NAO
        // derruba o lever — registra e segue para a proxima tentativa.
        stages.push('ERROR');
        ctx.log.warn(
          { iteration: i, err: err instanceof Error ? err.message : String(err) },
          'generateMoreEbooks: lancamento falhou (segue)',
        );
      }
    }
    const after = await ctx.prisma.ebook.count({ where: { status: 'PUBLISHED' } });
    return {
      beforeState: { publishedEbooks: before, niche: p.niche ?? null, requested: count } as Json,
      afterState: { publishedEbooks: after, launched, stages } as Json,
    };
  }

  /**
   * PAUSE_LISTING: desativa um Product (Product.active=false). Reversivel — o
   * beforeState guarda active=true para o revert religar a oferta.
   */
  async pauseListing(ctx: AgentContext, p: { productId: string }): Promise<LeverResult> {
    const prod = await ctx.prisma.product.findUnique({
      where: { id: p.productId },
      select: { id: true, active: true },
    });
    if (!prod) throw new Error(`produto nao encontrado: ${p.productId}`);
    const before: Json = { productId: prod.id, active: prod.active };
    await ctx.prisma.product.update({ where: { id: prod.id }, data: { active: false } });
    return { beforeState: before, afterState: { productId: prod.id, active: false } as Json };
  }

  /**
   * BOOST_AFFILIATE_OUTREACH: dispara um ciclo do AffiliateOutreachAgent (contata
   * ate o lote de PROSPECTs elegiveis). NAO reversivel (envio de mensagens).
   */
  async boostAffiliateOutreach(
    ctx: AgentContext,
    _p: Record<string, never>,
  ): Promise<LeverResult> {
    const before = await ctx.prisma.affiliate.count({ where: { status: 'PROSPECT' } });
    await new AffiliateOutreachAgent().execute(ctx);
    const after = await ctx.prisma.affiliate.count({ where: { status: 'PROSPECT' } });
    return {
      beforeState: { prospects: before } as Json,
      afterState: { prospectsAfter: after, boosted: true } as Json,
    };
  }

  /**
   * SEND_AFFILIATE_EMAIL: contata UM afiliado especifico via AffiliateOutreachAgent
   * (runForAffiliate). NAO reversivel.
   */
  async sendAffiliateEmail(
    ctx: AgentContext,
    p: { affiliateId: string },
  ): Promise<LeverResult> {
    if (!p.affiliateId) throw new Error('affiliateId ausente para SEND_AFFILIATE_EMAIL');
    const contacted = await new AffiliateOutreachAgent().runForAffiliate(ctx, p.affiliateId);
    return {
      beforeState: { affiliateId: p.affiliateId } as Json,
      afterState: { affiliateId: p.affiliateId, contacted } as Json,
    };
  }

  // ----------------------------------------------------------
  // revert — restaura o beforeState das acoes reversiveis.
  // ----------------------------------------------------------
  async revert(ctx: AgentContext, kind: ActionKind, beforeState: Json): Promise<LeverResult> {
    const b = (beforeState && typeof beforeState === 'object' && !Array.isArray(beforeState)
      ? (beforeState as Record<string, Json>)
      : {}) as Record<string, Json>;

    switch (kind) {
      case 'INCREASE_AD_BUDGET':
      case 'DECREASE_AD_BUDGET': {
        const campaignId = String(b.campaignId ?? '');
        const prevBudget = typeof b.dailyBudgetCents === 'number' ? b.dailyBudgetCents : null;
        const res = await this.setBudget(ctx, campaignId, prevBudget);
        return res;
      }
      case 'PAUSE_CAMPAIGN': {
        const campaignId = String(b.campaignId ?? '');
        const prevStatus = String(b.status ?? 'ACTIVE');
        const camp = await ctx.prisma.adCampaign.findUnique({
          where: { id: campaignId },
          select: { externalCampaignId: true },
        });
        if (camp?.externalCampaignId && (prevStatus === 'ACTIVE' || prevStatus === 'PAUSED' || prevStatus === 'ARCHIVED')) {
          await ctx.ports.ads.setStatus(camp.externalCampaignId, prevStatus as 'ACTIVE' | 'PAUSED' | 'ARCHIVED');
        }
        await ctx.prisma.adCampaign.update({ where: { id: campaignId }, data: { status: prevStatus as never } });
        return { beforeState, afterState: { campaignId, status: prevStatus } as Json };
      }
      case 'ADJUST_PRICE': {
        const productId = String(b.productId ?? '');
        const prevPrice = typeof b.priceCents === 'number' ? b.priceCents : null;
        if (prevPrice === null) throw new Error('beforeState sem priceCents — rollback impossivel');
        await ctx.prisma.product.update({ where: { id: productId }, data: { priceCents: prevPrice } });
        return { beforeState, afterState: { productId, priceCents: prevPrice } as Json };
      }
      case 'REGENERATE_LANDING_COPY': {
        const productId = String(b.productId ?? '');
        const prevDesc = typeof b.description === 'string' ? b.description : null;
        await ctx.prisma.product.update({ where: { id: productId }, data: { description: prevDesc } });
        return { beforeState, afterState: { productId, description: prevDesc } as Json };
      }
      case 'PAUSE_LISTING': {
        const productId = String(b.productId ?? '');
        // beforeState guarda o active anterior (true) — religa a oferta.
        const prevActive = typeof b.active === 'boolean' ? b.active : true;
        await ctx.prisma.product.update({ where: { id: productId }, data: { active: prevActive } });
        return { beforeState, afterState: { productId, active: prevActive } as Json };
      }
      default:
        throw new Error(`kind nao reversivel: ${kind}`);
    }
  }

  // ----------------------------------------------------------
  // Internos
  // ----------------------------------------------------------
  private async setBudget(
    ctx: AgentContext,
    campaignId: string,
    newDailyBudgetCents: number | null,
  ): Promise<LeverResult> {
    const camp = await ctx.prisma.adCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, dailyBudgetCents: true, status: true, externalCampaignId: true },
    });
    if (!camp) throw new Error(`campanha nao encontrada: ${campaignId}`);
    const before: Json = {
      campaignId: camp.id,
      dailyBudgetCents: camp.dailyBudgetCents,
      status: camp.status,
    };
    if (newDailyBudgetCents !== null) {
      if (camp.externalCampaignId) await ctx.ports.ads.updateBudget(camp.externalCampaignId, newDailyBudgetCents);
      await ctx.prisma.adCampaign.update({
        where: { id: camp.id },
        data: { dailyBudgetCents: newDailyBudgetCents },
      });
    }
    return {
      beforeState: before,
      afterState: { campaignId: camp.id, dailyBudgetCents: newDailyBudgetCents } as Json,
    };
  }

  private async deliveryBacklog(ctx: AgentContext): Promise<number> {
    return ctx.prisma.order.count({ where: { status: 'PAID', deliveryGrant: null } });
  }
}

/** Factory de conveniencia para o scheduler.ts. */
export function createLiveLevers(): RemediationLevers {
  return new LiveRemediationLevers();
}
