// CRM / Command Center — DiagnosisEngine (dono deste arquivo).
//
// Implementa a interface DiagnosisEngine (contracts.ts). A partir de um
// SectorHealth (score + kpis com subscores), aplica REGRAS deterministicas para:
//  1) Decidir SE ha problema (so diagnostica setores nao-HEALTHY com sinal).
//  2) Eleger o ProblemType primario (regra com maior prioridade que casa).
//  3) Reunir EVIDENCIAS (KPIs que dispararam) e sugerir ActionKinds.
// Em seguida usa o LLMPort (claude-opus-4-8) para escrever a CAUSA RAIZ textual
// em pt-BR (best-effort: se o LLM falhar, cai num texto deterministico das regras
// — o negocio nunca trava por falta de LLM, mesmo padrao do orchestrator).
//
// Persistencia IDEMPOTENTE: nao cria um segundo Problem ativo
// (OPEN/DIAGNOSING/REMEDIATING) do mesmo (sector, type). Se ja existir um ativo,
// atualiza severity/rootCause/snapshot; senao cria OPEN.
//
// Dominio em pt-BR. Sem acoplamento a @prisma/client (usa ctx.prisma tipado).

import {
  HEALTH_THRESHOLDS,
  CRM_NEW_SECTORS,
  type Sector,
  type CrmSector,
  type SectorHealth,
  type Diagnosis,
  type ProblemType,
  type ProblemStatus,
  type ActionKind,
  type Json,
} from '@ebook-empire/core';
import type { AgentContext } from '../base.js';
import type { DiagnosisEngine, ProblemRef } from './contracts.js';

/** Type guard: o setor e um dos 3 NOVOS de producao (MARKETPLACE/FUNNEL/AFFILIATE)? */
function isCrmNewSector(sector: CrmSector): sector is CrmNewSector {
  return (CRM_NEW_SECTORS as readonly string[]).includes(sector);
}

// ============================================================
// Regras por setor (puras). Cada regra olha os KPIs/subscores e diz se "casa".
// A primeira regra (na ordem) que casar vira o ProblemType primario do setor.
// ============================================================

/** Acesso seguro a um campo numerico do bag de kpis. */
function num(kpis: Record<string, unknown>, key: string): number {
  const v = kpis[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Acesso seguro a um subscore. */
function sub(kpis: Record<string, unknown>, key: string): number {
  const s = kpis.subscores;
  if (s && typeof s === 'object' && !Array.isArray(s)) {
    const v = (s as Record<string, unknown>)[key];
    if (typeof v === 'number') return v;
  }
  return 100;
}

export interface RuleHit {
  type: ProblemType;
  evidence: string[];
  suggestedActionKinds: ActionKind[];
}

export type SectorRule = (kpis: Record<string, unknown>) => RuleHit | null;

// As regras estao em ordem de PRIORIDADE (a primeira que casa vence).
export const SECTOR_RULES: Record<Sector, SectorRule[]> = {
  CONTENT: [
    (k) =>
      num(k, 'failedRunsToday') > 0 && num(k, 'failedRunsToday') >= num(k, 'runsToday')
        ? {
            type: 'EBOOK_GENERATION_FAILING',
            evidence: [`runs de conteudo falhando hoje: ${num(k, 'failedRunsToday')}/${num(k, 'runsToday')}`],
            suggestedActionKinds: ['RERUN_AGENT', 'GENERATE_EBOOK'],
          }
        : null,
    (k) =>
      num(k, 'publishedWithActiveProduct') === 0
        ? {
            type: 'EMPTY_CATALOG',
            evidence: ['nenhum ebook PUBLISHED com produto ativo'],
            suggestedActionKinds: ['GENERATE_EBOOK'],
          }
        : null,
    (k) =>
      num(k, 'stuckEbooks') > 0
        ? {
            type: 'STALE_CATALOG',
            evidence: [`${num(k, 'stuckEbooks')} ebook(s) presos em DRAFT/GENERATING`],
            suggestedActionKinds: ['RERUN_AGENT', 'GENERATE_EBOOK'],
          }
        : null,
  ],
  SALES: [
    (k) =>
      num(k, 'publishedWithoutProduct') > 0
        ? {
            type: 'CHECKOUT_DROPOFF',
            evidence: [`${num(k, 'publishedWithoutProduct')} ebook(s) publicados sem oferta ativa`],
            suggestedActionKinds: ['REGENERATE_LANDING_COPY'],
          }
        : null,
    (k) =>
      sub(k, 'conversion') < 50 && num(k, 'checkouts') > 0
        ? {
            type: 'LOW_CONVERSION',
            evidence: [
              `conversao baixa (subscore ${sub(k, 'conversion')}) — ${num(k, 'paidOrders')} pagos / ${num(k, 'checkouts')} checkouts`,
            ],
            suggestedActionKinds: ['REGENERATE_LANDING_COPY', 'ADJUST_PRICE'],
          }
        : null,
  ],
  DELIVERY: [
    (k) =>
      num(k, 'failedRunsToday') > 0
        ? {
            type: 'DELIVERY_FAILURES',
            evidence: [`entregas falhando hoje: ${num(k, 'failedRunsToday')} run(s) FAILED`],
            suggestedActionKinds: ['RETRY_DELIVERIES', 'RERUN_AGENT'],
          }
        : null,
    (k) =>
      num(k, 'pendingDeliveries') > 0
        ? {
            type: 'DELIVERY_BACKLOG',
            evidence: [`${num(k, 'pendingDeliveries')} pedido(s) pago(s) aguardando entrega`],
            suggestedActionKinds: ['RETRY_DELIVERIES'],
          }
        : null,
  ],
  SOCIAL: [
    (k) =>
      sub(k, 'reliability') < 50 && num(k, 'attemptedRecent') > 0
        ? {
            type: 'SOCIAL_PUBLISH_FAILURES',
            evidence: [`falhas de publicacao: ${num(k, 'failedRecent')}/${num(k, 'attemptedRecent')}`],
            suggestedActionKinds: ['GENERATE_SOCIAL_POSTS', 'RERUN_AGENT'],
          }
        : null,
    (k) =>
      num(k, 'publishedRecent') === 0
        ? {
            type: 'NO_RECENT_POSTS',
            evidence: ['nenhum post publicado na janela'],
            suggestedActionKinds: ['GENERATE_SOCIAL_POSTS'],
          }
        : null,
    (k) =>
      sub(k, 'engagement') < 40
        ? {
            type: 'LOW_ENGAGEMENT',
            evidence: [`engajamento baixo (subscore ${sub(k, 'engagement')})`],
            suggestedActionKinds: ['GENERATE_SOCIAL_POSTS'],
          }
        : null,
  ],
  TRAFFIC: [
    (k) =>
      num(k, 'activeCampaigns') === 0
        ? {
            type: 'NO_ACTIVE_CAMPAIGNS',
            evidence: ['nenhuma campanha ACTIVE'],
            suggestedActionKinds: ['RERUN_AGENT'],
          }
        : null,
    (k) =>
      num(k, 'spendCents') > 0 && num(k, 'attributedRevenueCents') < num(k, 'spendCents')
        ? {
            type: 'NEGATIVE_ROAS',
            evidence: [
              `ROAS < 1 — spend ${num(k, 'spendCents')}c vs receita ${num(k, 'attributedRevenueCents')}c`,
            ],
            suggestedActionKinds: ['DECREASE_AD_BUDGET', 'PAUSE_CAMPAIGN'],
          }
        : null,
    (k) =>
      num(k, 'maxAdBudgetCents') > 0 && num(k, 'spendCents') > num(k, 'maxAdBudgetCents')
        ? {
            type: 'BUDGET_EXHAUSTED',
            evidence: [
              `spend ${num(k, 'spendCents')}c acima do teto ${num(k, 'maxAdBudgetCents')}c`,
            ],
            suggestedActionKinds: ['DECREASE_AD_BUDGET', 'PAUSE_CAMPAIGN'],
          }
        : null,
  ],
  ANALYTICS: [
    (k) =>
      sub(k, 'frescor') < 50
        ? {
            type: 'KPI_STALE',
            evidence: [`KPIs desatualizados (subscore frescor ${sub(k, 'frescor')})`],
            suggestedActionKinds: ['RECOMPUTE_KPIS', 'RERUN_AGENT'],
          }
        : null,
    (k) =>
      k.insightIngestedToday === false
        ? {
            type: 'INSIGHTS_NOT_INGESTED',
            evidence: ['nenhum insight ingerido hoje'],
            suggestedActionKinds: ['RECOMPUTE_KPIS', 'RERUN_AGENT'],
          }
        : null,
  ],
  ORCHESTRATION: [
    // REVENUE_BELOW_TARGET (COO-Scale): lucro liquido de hoje abaixo de metade da
    // meta ATE meio-dia UTC => ainda da tempo de virar o dia gerando mais ebooks.
    (k) =>
      k.beforeNoonUtc === true &&
      num(k, 'targetRevenueCents') > 0 &&
      num(k, 'netProfitCentsToday') < num(k, 'targetRevenueCents') * 0.5
        ? {
            type: 'REVENUE_BELOW_TARGET',
            evidence: [
              `lucro de hoje ${num(k, 'netProfitCentsToday')}c < 50% da meta ${num(k, 'targetRevenueCents')}c (antes do meio-dia UTC)`,
            ],
            suggestedActionKinds: ['GENERATE_MORE_EBOOKS'],
          }
        : null,
    (k) =>
      sub(k, 'heartbeat') < 50
        ? {
            type: 'CYCLE_NOT_RUNNING',
            evidence: [`ciclo do orchestrator parado (subscore heartbeat ${sub(k, 'heartbeat')})`],
            suggestedActionKinds: ['RERUN_AGENT'],
          }
        : null,
    (k) =>
      sub(k, 'childHealth') < 50 && num(k, 'childRunsToday') > 0
        ? {
            type: 'AGENT_REPEATEDLY_FAILING',
            evidence: [
              `filhos falhando: ${num(k, 'childFailuresToday')}/${num(k, 'childRunsToday')} runs`,
            ],
            suggestedActionKinds: ['RERUN_AGENT'],
          }
        : null,
  ],
};

/**
 * Eleve a regra primaria de um setor (primeira que casa) a partir dos kpis.
 * Pura — base dos testes do motor de regras.
 */
export function runRules(sector: Sector, kpis: Record<string, unknown>): RuleHit | null {
  for (const rule of SECTOR_RULES[sector]) {
    const hit = rule(kpis);
    if (hit) return hit;
  }
  return null;
}

// ============================================================
// Regras dos setores NOVOS de producao autonoma (COO-Scale / Fase 5):
// MARKETPLACE / FUNNEL / AFFILIATE. Mantidas SEPARADAS de SECTOR_RULES (que e
// Record<Sector,...> e dirige o loop dos 7 no operations-agent) para NAO mexer
// no scoring/diagnostico dos 7 setores de saude. O COO de producao consome
// runCrmRules para esses 3. Subscores casam com os de health-collector.
// ============================================================
export type CrmNewSector = 'MARKETPLACE' | 'FUNNEL' | 'AFFILIATE';

export const CRM_SECTOR_RULES: Record<CrmNewSector, SectorRule[]> = {
  MARKETPLACE: [
    (k) =>
      sub(k, 'content') < 60
        ? {
            type: 'MISSING_COVER',
            evidence: [`capas faltando em listings (subscore content ${sub(k, 'content')})`],
            suggestedActionKinds: ['GENERATE_MORE_EBOOKS'],
          }
        : null,
    (k) =>
      sub(k, 'liveness') < 50 || num(k, 'deadListings') > 0
        ? {
            type: 'DEAD_LISTING',
            evidence: [`${num(k, 'deadListings')} listing(s) sem venda em 30d`],
            suggestedActionKinds: ['PAUSE_LISTING', 'BOOST_AFFILIATE_OUTREACH'],
          }
        : null,
  ],
  FUNNEL: [
    (k) =>
      sub(k, 'payment') < 50 && num(k, 'checkoutsStarted') > 0
        ? {
            type: 'HIGH_CART_ABANDONMENT',
            evidence: [
              `abandono de carrinho alto (subscore payment ${sub(k, 'payment')}) — ${num(k, 'paid')} pagos / ${num(k, 'checkoutsStarted')} checkouts`,
            ],
            suggestedActionKinds: ['REGENERATE_LANDING_COPY'],
          }
        : null,
    (k) =>
      sub(k, 'checkout') < 50 || sub(k, 'landing') < 50
        ? {
            type: 'LANDING_DROPOFF',
            evidence: [
              `queda no funil de landing (landing ${sub(k, 'landing')}, checkout ${sub(k, 'checkout')})`,
            ],
            suggestedActionKinds: ['REGENERATE_LANDING_COPY'],
          }
        : null,
  ],
  AFFILIATE: [
    (k) =>
      sub(k, 'revenue') < 50 && num(k, 'active') > 0
        ? {
            type: 'AFFILIATE_REVENUE_ZERO',
            evidence: [`afiliados ativos sem receita atribuida (subscore revenue ${sub(k, 'revenue')})`],
            suggestedActionKinds: ['BOOST_AFFILIATE_OUTREACH', 'SEND_AFFILIATE_EMAIL'],
          }
        : null,
    (k) =>
      sub(k, 'activeRatio') < 50 || num(k, 'active') === 0
        ? {
            type: 'NO_AFFILIATE_ACTIVITY',
            evidence: [
              `poucos/nenhum afiliado ativo (ativos ${num(k, 'active')}/${num(k, 'total')})`,
            ],
            suggestedActionKinds: ['BOOST_AFFILIATE_OUTREACH'],
          }
        : null,
  ],
};

/**
 * Eleve a regra primaria de um dos 3 setores NOVOS (MARKETPLACE/FUNNEL/AFFILIATE).
 * Pura — base dos testes. Analoga a runRules, mas para os setores de producao.
 */
export function runCrmRules(
  sector: CrmNewSector,
  kpis: Record<string, unknown>,
): RuleHit | null {
  for (const rule of CRM_SECTOR_RULES[sector]) {
    const hit = rule(kpis);
    if (hit) return hit;
  }
  return null;
}

// ============================================================
// RuleDiagnosisEngine — implementacao concreta.
// ============================================================

export class RuleDiagnosisEngine implements DiagnosisEngine {
  /**
   * Diagnostica um setor a partir do seu SectorHealth.
   * - Setor HEALTHY (score >= 70) ou sem sinal => Diagnosis "RESOLVED-like" sem
   *   problema persistido (status OPEN, type generico, confidence baixa) e
   *   resolve qualquer Problem ativo daquele setor (auto-cura).
   * - Setor WARNING/CRITICAL => elege ProblemType, enriquece com LLM e persiste
   *   o Problem (idempotente).
   */
  async diagnose(
    ctx: AgentContext,
    sector: CrmSector,
    health: SectorHealth,
  ): Promise<Diagnosis> {
    const kpis = (health.kpis ?? {}) as Record<string, unknown>;
    const hasSignal = kpis.hasSignal !== false;
    const healthy = health.score >= HEALTH_THRESHOLDS.HEALTHY_MIN;

    // Caminho feliz: setor saudavel (ou sem sinal) => sem problema. Auto-cura.
    if (healthy || !hasSignal) {
      await this.resolveActiveProblems(ctx, sector);
      return {
        sector,
        type: 'KPI_STALE', // placeholder valido; nao persistido (confidence/status nao geram acao)
        severity: 100 - health.score,
        status: 'OPEN',
        rootCause: hasSignal
          ? `Setor ${sector} saudavel (score ${health.score}).`
          : `Setor ${sector} sem volume suficiente para avaliar.`,
        confidence: 0,
        evidence: [],
        suggestedActionKinds: [],
        source: 'RULES',
      };
    }

    // Setor degradado: elege a regra primaria. Os 7 de saude via runRules; os 3
    // de producao (MARKETPLACE/FUNNEL/AFFILIATE) via runCrmRules.
    const hit = isCrmNewSector(sector)
      ? runCrmRules(sector, kpis)
      : runRules(sector, kpis);
    const severity = 100 - health.score;

    // Resolve identificadores de contexto (campaignId/productId/budget atual) que
    // o ActionCatalog precisa para montar acoes HIGH (TRAFFIC/SALES) sozinho.
    // Sem isto, o catalogo retornaria null no fluxo 100% autonomo.
    const actionContext = await this.gatherActionContext(ctx, sector, health);

    // Nenhuma regra casou apesar de score baixo: diagnostico generico por score.
    if (!hit) {
      const fallback: Diagnosis = {
        sector,
        type: this.genericTypeFor(sector),
        severity,
        status: 'OPEN',
        rootCause: `Setor ${sector} com score ${health.score} (abaixo do saudavel), sem regra especifica disparada.`,
        confidence: 0.4,
        evidence: [`score=${health.score}`],
        suggestedActionKinds: ['RERUN_AGENT'],
        source: 'RULES',
      };
      await this.upsertProblem(ctx, sector, fallback, health, actionContext);
      return fallback;
    }

    // Enriquecimento de causa raiz via LLM (best-effort).
    const rootCause = await this.explainRootCause(ctx, sector, health, hit);

    const diagnosis: Diagnosis = {
      sector,
      type: hit.type,
      severity,
      status: 'OPEN',
      rootCause: rootCause.text,
      confidence: rootCause.source === 'LLM' ? 0.85 : 0.6,
      evidence: hit.evidence,
      suggestedActionKinds: hit.suggestedActionKinds,
      source: rootCause.source,
    };

    await this.upsertProblem(ctx, sector, diagnosis, health, actionContext);
    return diagnosis;
  }

  // ----------------------------------------------------------
  // Causa raiz textual via LLM de planejamento (claude-opus-4-8).
  // ----------------------------------------------------------
  private async explainRootCause(
    ctx: AgentContext,
    sector: CrmSector,
    health: SectorHealth,
    hit: RuleHit,
  ): Promise<{ text: string; source: 'RULES' | 'LLM' }> {
    const fallback = `Setor ${sector}: ${hit.type}. ${hit.evidence.join('; ')}.`;
    try {
      const system =
        'Voce e o COO autonomo da "Ebook Empire". Explique, em portugues (pt-BR), ' +
        'a CAUSA RAIZ provavel de um problema operacional em 1 a 3 frases curtas e ' +
        'objetivas. Seja concreto, sem floreio e sem inventar numeros. Responda ' +
        'apenas o texto da causa raiz, sem rotulos.';
      const userMsg = JSON.stringify(
        {
          setor: sector,
          score: health.score,
          tipoDeProblema: hit.type,
          evidencias: hit.evidence,
          kpis: health.kpis,
        },
        null,
        2,
      );
      const { text, usage } = await ctx.ports.llm.generateText({
        model: ctx.env.PLANNING_MODEL, // 'claude-opus-4-8'
        system,
        messages: [{ role: 'user', content: userMsg }],
        maxTokens: 300,
        temperature: 0.2,
      });
      const clean = text.trim();
      if (!clean) return { text: fallback, source: 'RULES' };
      ctx.log.debug({ sector, tokens: usage }, 'causa raiz enriquecida por LLM');
      return { text: clean.slice(0, 1000), source: 'LLM' };
    } catch (err) {
      ctx.log.warn(
        { sector, err: err instanceof Error ? err.message : String(err) },
        'LLM indisponivel para causa raiz — usando texto deterministico',
      );
      return { text: fallback, source: 'RULES' };
    }
  }

  // ----------------------------------------------------------
  // Persistencia idempotente do Problem (1 ativo por sector,type).
  // ----------------------------------------------------------
  private async upsertProblem(
    ctx: AgentContext,
    sector: CrmSector,
    diagnosis: Diagnosis,
    health: SectorHealth,
    actionContext: Record<string, Json> = {},
  ): Promise<ProblemRef> {
    const ACTIVE: ProblemStatus[] = ['OPEN', 'DIAGNOSING', 'REMEDIATING'];

    // Guard transacional: procura um Problem ativo do mesmo (sector,type).
    const existing = await ctx.prisma.problem.findFirst({
      where: { sector, type: diagnosis.type, status: { in: ACTIVE } },
      orderBy: { detectedAt: 'desc' },
    });

    const metadata = {
      detectedScore: health.score,
      detectedStatus: health.status,
      evidence: diagnosis.evidence,
      suggestedActionKinds: diagnosis.suggestedActionKinds,
      diagnosisSource: diagnosis.source,
      // Identificadores de contexto p/ o ActionCatalog (campaignId/productId/budget).
      ...actionContext,
    };

    if (existing) {
      // Atualiza o problema vigente (nao duplica).
      const updated = await ctx.prisma.problem.update({
        where: { id: existing.id },
        data: {
          severity: diagnosis.severity,
          rootCause: diagnosis.rootCause,
          snapshotId: null,
          metadata: metadata as never,
        },
      });
      ctx.log.info({ problemId: updated.id, sector, type: diagnosis.type }, 'problema atualizado');
      return updated as unknown as ProblemRef;
    }

    const created = await ctx.prisma.problem.create({
      data: {
        sector,
        type: diagnosis.type,
        severity: diagnosis.severity,
        status: 'OPEN',
        rootCause: diagnosis.rootCause,
        metadata: metadata as never,
      },
    });
    ctx.log.info({ problemId: created.id, sector, type: diagnosis.type }, 'novo problema detectado');
    return created as unknown as ProblemRef;
  }

  /** Auto-cura: resolve Problems ativos de um setor que voltou ao saudavel. */
  private async resolveActiveProblems(ctx: AgentContext, sector: CrmSector): Promise<void> {
    const ACTIVE: ProblemStatus[] = ['OPEN', 'DIAGNOSING', 'REMEDIATING'];
    const result = await ctx.prisma.problem.updateMany({
      where: { sector, status: { in: ACTIVE } },
      data: { status: 'RESOLVED', resolvedAt: ctx.clock.now() },
    });
    if (result.count > 0) {
      ctx.log.info({ sector, resolved: result.count }, 'problemas do setor resolvidos (auto-cura)');
    }
  }

  // ----------------------------------------------------------
  // Reune os identificadores de contexto que o ActionCatalog precisa para montar
  // acoes HIGH (TRAFFIC: campaignId + newDailyBudgetCents; SALES: productId +
  // newPriceCents) SEM intervencao humana. Best-effort: qualquer falha => {} (o
  // catalogo apenas nao propoe a acao que dependia do dado).
  // ----------------------------------------------------------
  private async gatherActionContext(
    ctx: AgentContext,
    sector: CrmSector,
    health: SectorHealth,
  ): Promise<Record<string, Json>> {
    try {
      if (sector === 'TRAFFIC') {
        return await this.gatherTrafficContext(ctx);
      }
      if (sector === 'SALES') {
        return await this.gatherSalesContext(ctx);
      }
      if (sector === 'CONTENT') {
        return await this.gatherContentContext(ctx);
      }
      // --- producao autonoma (COO-Scale / Fase 5) ---
      if (sector === 'MARKETPLACE') {
        return await this.gatherMarketplaceContext(ctx);
      }
      if (sector === 'FUNNEL') {
        return await this.gatherFunnelContext(ctx);
      }
      if (sector === 'AFFILIATE') {
        return await this.gatherAffiliateContext(ctx);
      }
    } catch (err) {
      ctx.log.warn(
        { sector, err: err instanceof Error ? err.message : String(err) },
        'diagnostico: falha ao reunir contexto de acao (catalogo pode nao propor)',
      );
    }
    void health;
    return {};
  }

  /**
   * TRAFFIC: elege a campanha ACTIVE com maior gasto recente (pior queima de caixa)
   * e propoe reduzir o budget diario pela metade (DECREASE_AD_BUDGET) ou pausar.
   */
  private async gatherTrafficContext(ctx: AgentContext): Promise<Record<string, Json>> {
    const campaign = await ctx.prisma.adCampaign.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { dailyBudgetCents: 'desc' },
      select: { id: true, dailyBudgetCents: true },
    });
    if (!campaign) return {};
    // Reduz para metade do budget atual (minimo 1c) como remediacao default p/ ROAS<1.
    const current = campaign.dailyBudgetCents ?? 0;
    const newDailyBudgetCents = Math.max(1, Math.floor(current / 2));
    return {
      campaignId: campaign.id,
      currentDailyBudgetCents: current,
      newDailyBudgetCents,
    };
  }

  /**
   * SALES: elege um produto ativo (o mais recente) para que o catalogo possa
   * propor REGENERATE_LANDING_COPY e/ou ADJUST_PRICE (preco -10%, clampado).
   */
  private async gatherSalesContext(ctx: AgentContext): Promise<Record<string, Json>> {
    const product = await ctx.prisma.product.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, priceCents: true },
    });
    if (!product) return {};
    const current = product.priceCents ?? 0;
    // Pequena reducao de preco (-10%) como ponto de partida para o ajuste.
    const newPriceCents = current > 0 ? Math.round(current * 0.9) : current;
    return {
      productId: product.id,
      currentPriceCents: current,
      newPriceCents,
    };
  }

  /**
   * CONTENT: elege a MarketOpportunity PENDING de MAIOR potentialScore e expoe o
   * nicho dela em metadata.niche (o catalogo precisa do nicho p/ GENERATE_EBOOK).
   * Tambem mede a VELOCIDADE do nicho (orders nos ultimos 7d cujo Product->Ebook
   * pertence ao nicho) e poe em metadata.count: nichos quentes pedem MAIS ebooks.
   * Sem oportunidade PENDING => {} (catalogo nao propoe GENERATE_EBOOK).
   */
  private async gatherContentContext(ctx: AgentContext): Promise<Record<string, Json>> {
    const opp = await ctx.prisma.marketOpportunity.findFirst({
      where: { status: 'PENDING' },
      orderBy: { potentialScore: 'desc' },
      select: { id: true, niche: true, potentialScore: true },
    });
    if (!opp) return {};

    // Velocidade do nicho: pedidos pagos nos ultimos 7d cujo Product->Ebook esta
    // no mesmo nicho (Order.productId -> Product.ebookId -> Ebook.niche).
    const now = ctx.clock.now();
    const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    let velocity = 0;
    try {
      velocity = await ctx.prisma.order.count({
        where: {
          status: { in: ['PAID', 'DELIVERED'] },
          paidAt: { gte: windowStart },
          product: { ebook: { niche: opp.niche } },
        },
      });
    } catch {
      velocity = 0;
    }

    // count = quantos ebooks gerar: 1 base + 1 por venda recente no nicho (cap 5).
    const count = Math.max(1, Math.min(5, 1 + velocity));
    return {
      opportunityId: opp.id,
      niche: opp.niche,
      potentialScore: opp.potentialScore,
      nicheVelocity7d: velocity,
      count,
    };
  }

  /**
   * MARKETPLACE: elege um Product de uma listing "morta" (ativo, ebook PUBLISHED,
   * sem venda atribuida em 30d) para PAUSE_LISTING; expoe tambem provider (default
   * 'hotmart' — o lever/schema exige) e o nicho/count para o caminho MISSING_COVER
   * -> GENERATE_MORE_EBOOKS. Best-effort: sem produto => {}.
   */
  private async gatherMarketplaceContext(ctx: AgentContext): Promise<Record<string, Json>> {
    const now = ctx.clock.now();
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    // Product ativo (ebook PUBLISHED) sem venda atribuida em 30d => candidato a pausa.
    const product = await ctx.prisma.product.findFirst({
      where: {
        active: true,
        ebook: { status: 'PUBLISHED' },
        orders: { none: { status: { in: ['PAID', 'DELIVERED'] }, paidAt: { gte: since30d } } },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, ebook: { select: { niche: true } } },
    });
    if (!product) return {};
    return {
      productId: product.id,
      provider: 'hotmart',
      ...(product.ebook?.niche ? { niche: product.ebook.niche, count: 1 } : {}),
    };
  }

  /**
   * FUNNEL: elege um produto ativo (o mais recente) para REGENERATE_LANDING_COPY
   * (recuperar landing/checkout). Best-effort: sem produto => {}.
   */
  private async gatherFunnelContext(ctx: AgentContext): Promise<Record<string, Json>> {
    const product = await ctx.prisma.product.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!product) return {};
    return { productId: product.id };
  }

  /**
   * AFFILIATE: elege 1 afiliado para SEND_AFFILIATE_EMAIL — prioriza um ATIVO sem
   * receita (reativar), senao um PROSPECT (prospectar). Expoe affiliateId +
   * templateKey (o schema de SEND_AFFILIATE_EMAIL exige templateKey).
   * Best-effort: sem afiliado => {} (sobra BOOST_AFFILIATE_OUTREACH sem params).
   */
  private async gatherAffiliateContext(ctx: AgentContext): Promise<Record<string, Json>> {
    const active = await ctx.prisma.affiliate.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const chosen =
      active ??
      (await ctx.prisma.affiliate.findFirst({
        where: { status: 'PROSPECT' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }));
    if (!chosen) return {};
    return { affiliateId: chosen.id, templateKey: 'reativacao' };
  }

  /** Tipo generico por setor quando nenhuma regra especifica casa. */
  private genericTypeFor(sector: CrmSector): ProblemType {
    const map: Record<CrmSector, ProblemType> = {
      CONTENT: 'STALE_CATALOG',
      SALES: 'LOW_CONVERSION',
      DELIVERY: 'DELIVERY_BACKLOG',
      SOCIAL: 'LOW_ENGAGEMENT',
      TRAFFIC: 'NEGATIVE_ROAS',
      ANALYTICS: 'KPI_STALE',
      ORCHESTRATION: 'CYCLE_NOT_RUNNING',
      MARKETPLACE: 'DEAD_LISTING',
      FUNNEL: 'LANDING_DROPOFF',
      AFFILIATE: 'NO_AFFILIATE_ACTIVITY',
    };
    return map[sector];
  }
}
