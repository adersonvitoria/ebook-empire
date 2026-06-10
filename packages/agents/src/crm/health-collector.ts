// CRM / Command Center — HealthCollector (dono deste arquivo).
//
// Implementa a interface HealthCollector (contracts.ts): coleta KPIs REAIS de
// cada um dos 7 setores via Prisma (reaproveitando helpers do AnalyticsAgent),
// calcula um SCORE 0-100 por setor (media ponderada de subscores) e persiste um
// SectorHealthSnapshot por setor. O STATUS NUNCA e persistido — e derivado de
// score on-read (statusFromScore em core/crm.ts).
//
// Filosofia de scoring (doc 4.x):
//  - Cada setor produz 1+ SUBSCORES 0-100. A media ponderada (SECTOR_WEIGHTS)
//    vira o score do setor.
//  - Quando um setor NAO tem volume/sinal para julgar (ex. sem campanha ativa,
//    catalogo vazio sem vendas), o subscore correspondente cai para NEUTRAL_SUBSCORE
//    (60) — nem CRITICAL nem HEALTHY — para nao gerar falso problema/alarme.
//  - Os KPIs numericos + subscores + hasSignal sao guardados em kpis (Json) do
//    snapshot, alimentando o DiagnosisEngine e o front.
//
// As funcoes de scoring sao PURAS (recebem KPIs ja agregados) -> testaveis sem DB.
// Convencao de unidade: dinheiro SEMPRE Int centavos BRL. Dominio em pt-BR.

import {
  CRM_SECTORS,
  SECTOR_WEIGHTS,
  NEUTRAL_SUBSCORE,
  statusFromScore,
  type Sector,
  type CrmSector,
  type SectorHealth,
  type Json,
  type AgentName,
} from '@ebook-empire/core';
import { saoPauloDay, saoPauloDayBoundsUtc, metaProgressSubscore } from '../analytics.js';
import type { AgentContext } from '../base.js';
import type { HealthCollector } from './contracts.js';

// ============================================================
// Helpers numericos puros de scoring
// ============================================================

/** Converte um objeto de KPIs para Json seguro (Infinity/NaN -> null). */
function toJsonRecord(obj: object): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'number') {
      out[key] = Number.isFinite(value) ? value : null;
    } else if (typeof value === 'boolean' || typeof value === 'string' || value === null) {
      out[key] = value;
    }
  }
  return out;
}

/** Garante 0..100 inteiro. */
export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Media ponderada de subscores -> score 0-100 do setor.
 * Pesos vem de SECTOR_WEIGHTS[sector]; subscores ausentes sao ignorados
 * (renormaliza pelos pesos presentes). Sem nenhum peso => 0.
 */
export function weightedScore(
  sector: Sector,
  subscores: Record<string, number>,
): number {
  const weights = SECTOR_WEIGHTS[sector];
  let acc = 0;
  let totalWeight = 0;
  for (const key of Object.keys(weights)) {
    const sub = subscores[key];
    if (sub === undefined) continue;
    const w = weights[key]!;
    acc += clampScore(sub) * w;
    totalWeight += w;
  }
  if (totalWeight === 0) return 0;
  return clampScore(acc / totalWeight);
}

// ============================================================
// Subscores por setor (PUROS — base dos testes, sem DB).
// Cada um recebe os KPIs ja agregados e devolve { subscores, kpis, hasSignal }.
// `hasSignal=false` => setor sem volume para julgar (subscores neutros).
// ============================================================

export interface SectorScore {
  /** Subscores nomeados 0-100 (chaves casam com SECTOR_WEIGHTS[sector]). */
  subscores: Record<string, number>;
  /** Ha volume suficiente para o score significar algo? */
  hasSignal: boolean;
}

// ---- CONTENT ----
export interface ContentKpis {
  /** Ebooks PUBLISHED com produto ativo (catalogo vendavel). */
  publishedWithActiveProduct: number;
  /** Ebooks presos em DRAFT/GENERATING ha muito tempo (falha de geracao). */
  stuckEbooks: number;
  /** Runs do ContentAgent no dia. */
  runsToday: number;
  /** Runs FAILED do ContentAgent no dia. */
  failedRunsToday: number;
}

export function scoreContent(k: ContentKpis): SectorScore {
  // pipeline: ter catalogo vendavel. 0 publicados = 0; >=3 = 100 (saturacao linear).
  const pipeline = clampScore((k.publishedWithActiveProduct / 3) * 100);
  // stuck: cada ebook preso derruba 25 pts.
  const stuck = clampScore(100 - k.stuckEbooks * 25);
  // op: taxa de sucesso dos runs (neutro se nao rodou).
  const op =
    k.runsToday > 0
      ? clampScore(((k.runsToday - k.failedRunsToday) / k.runsToday) * 100)
      : NEUTRAL();
  return {
    subscores: { pipeline, stuck, op },
    // Sem catalogo nenhum E sem ter rodado => sem sinal (empresa recem-criada).
    hasSignal: k.publishedWithActiveProduct > 0 || k.runsToday > 0,
  };
}

// ---- SALES ----
export interface SalesKpis {
  /** Inicios de checkout na janela. */
  checkouts: number;
  /** Pedidos pagos na janela. */
  paidOrders: number;
  /** Produtos ativos (catalogo monetizado). */
  activeProducts: number;
  /** Ebooks PUBLISHED sem nenhum produto ativo (oferta faltando). */
  publishedWithoutProduct: number;
}

export function scoreSales(k: SalesKpis): SectorScore {
  const conversionRate = k.checkouts > 0 ? k.paidOrders / k.checkouts : undefined;
  // conversion: 0% => 0, >=30% => 100 (faixa saudavel de info-produto).
  const conversion =
    conversionRate === undefined ? NEUTRAL() : clampScore((conversionRate / 0.3) * 100);
  // catalogo: ter ofertas ativas (>=2 = 100).
  const catalogo = clampScore((k.activeProducts / 2) * 100);
  // abandono: ebooks publicados sem oferta = dinheiro na mesa.
  const abandono = clampScore(100 - k.publishedWithoutProduct * 25);
  return {
    subscores: { conversion, catalogo, abandono },
    hasSignal: k.checkouts > 0 || k.activeProducts > 0 || k.publishedWithoutProduct > 0,
  };
}

// ---- DELIVERY ----
export interface DeliveryKpis {
  /** Pedidos PAID aguardando entrega (sem grant). */
  pendingDeliveries: number;
  /** Pedidos pagos no dia (denominador do backlog). */
  paidToday: number;
  /** Runs do DeliveryAgent no dia. */
  runsToday: number;
  /** Runs FAILED do DeliveryAgent no dia. */
  failedRunsToday: number;
}

export function scoreDelivery(k: DeliveryKpis): SectorScore {
  // backlog: cada pedido preso na fila derruba forte (cliente pagou e nao recebeu).
  const backlog = clampScore(100 - k.pendingDeliveries * 20);
  const op =
    k.runsToday > 0
      ? clampScore(((k.runsToday - k.failedRunsToday) / k.runsToday) * 100)
      : NEUTRAL();
  return {
    subscores: { backlog, op },
    // So tem sinal se houve pagamento (sem vendas, entrega nao e julgavel).
    hasSignal: k.paidToday > 0 || k.pendingDeliveries > 0 || k.runsToday > 0,
  };
}

// ---- SOCIAL ----
export interface SocialKpis {
  /** Posts PUBLISHED na janela (cadencia). */
  publishedRecent: number;
  /** Posts FAILED na janela. */
  failedRecent: number;
  /** Total de posts tentados na janela (published + failed). */
  attemptedRecent: number;
  /** Soma de engajamento (likes+comments+saves) dos posts recentes. */
  engagementRecent: number;
}

export function scoreSocial(k: SocialKpis): SectorScore {
  // cadence: ter publicado (>=3 posts na janela = 100).
  const cadence = clampScore((k.publishedRecent / 3) * 100);
  // reliability: taxa de publicacao bem-sucedida (neutro se nao tentou).
  const reliability =
    k.attemptedRecent > 0
      ? clampScore((k.publishedRecent / k.attemptedRecent) * 100)
      : NEUTRAL();
  // engagement: heuristica simples (>=30 interacoes acumuladas = 100).
  const engagement =
    k.publishedRecent > 0 ? clampScore((k.engagementRecent / 30) * 100) : NEUTRAL();
  return {
    subscores: { cadence, reliability, engagement },
    hasSignal: k.attemptedRecent > 0,
  };
}

// ---- TRAFFIC ----
export interface TrafficKpis {
  /** Campanhas ACTIVE. */
  activeCampaigns: number;
  /** Spend total da janela (centavos). */
  spendCents: number;
  /** Receita atribuida a ads na janela (centavos). */
  attributedRevenueCents: number;
  /** Teto de budget diario (centavos) — MAX_AD_BUDGET_BRL*100. */
  maxAdBudgetCents: number;
}

export function scoreTraffic(k: TrafficKpis): SectorScore {
  const roas = k.spendCents > 0 ? k.attributedRevenueCents / k.spendCents : undefined;
  // roas: ROAS 1 => 50, ROAS 2 => 100, ROAS 0 => 0 (linear, capado).
  const roasScore = roas === undefined ? NEUTRAL() : clampScore((roas / 2) * 100);
  // budgetDiscipline: penaliza estourar o teto de budget na janela.
  const budgetDiscipline =
    k.maxAdBudgetCents > 0 && k.spendCents > k.maxAdBudgetCents
      ? clampScore(100 - ((k.spendCents - k.maxAdBudgetCents) / k.maxAdBudgetCents) * 100)
      : 100;
  // activity: ter ao menos uma campanha ativa.
  const activity = k.activeCampaigns > 0 ? 100 : 0;
  return {
    subscores: { roas: roasScore, budgetDiscipline, activity },
    hasSignal: k.activeCampaigns > 0 || k.spendCents > 0,
  };
}

// ---- ANALYTICS ----
export interface AnalyticsKpis {
  /** Houve evento INSIGHT_INGESTED no dia? */
  insightIngestedToday: boolean;
  /** Minutos desde a ultima ingestao de insight (Infinity se nunca). */
  minutesSinceLastInsight: number;
  /** Runs do AnalyticsAgent no dia. */
  runsToday: number;
  /** Runs FAILED do AnalyticsAgent no dia. */
  failedRunsToday: number;
  /** Receita contabil do dia (centavos) — base do subscore metaProgress. */
  revenueCentsToday: number;
  /** Meta diaria de faturamento (centavos) — TARGET_DAILY_REVENUE_BRL*100. */
  targetRevenueCents: number;
}

// Frescor: <=6h => 100; degrada linearmente ate 24h => 0.
const ANALYTICS_FRESH_MIN = 6 * 60;
const ANALYTICS_STALE_MIN = 24 * 60;

export function scoreAnalytics(k: AnalyticsKpis): SectorScore {
  let frescor: number;
  if (k.minutesSinceLastInsight <= ANALYTICS_FRESH_MIN) {
    frescor = 100;
  } else if (k.minutesSinceLastInsight >= ANALYTICS_STALE_MIN) {
    frescor = 0;
  } else {
    const span = ANALYTICS_STALE_MIN - ANALYTICS_FRESH_MIN;
    frescor = clampScore(
      100 - ((k.minutesSinceLastInsight - ANALYTICS_FRESH_MIN) / span) * 100,
    );
  }
  const op =
    k.runsToday > 0
      ? clampScore(((k.runsToday - k.failedRunsToday) / k.runsToday) * 100)
      : NEUTRAL();
  // dataIntegrity: ingeriu insight hoje (proxy simples de pipeline de dados ok).
  const dataIntegrity = k.insightIngestedToday ? 100 : 50;
  // metaProgress: progresso da meta diaria de faturamento (COO-Scale / Fase 5).
  // = min(100, round(revenue/target*100)); sem meta => 100 (nao penaliza).
  const metaProgress = metaProgressSubscore(k.revenueCentsToday, k.targetRevenueCents);
  return {
    subscores: { frescor, op, dataIntegrity, metaProgress },
    // Analytics sempre deveria rodar; ha sinal assim que houve qualquer run/insight.
    hasSignal: k.runsToday > 0 || Number.isFinite(k.minutesSinceLastInsight),
  };
}

// ---- ORCHESTRATION ----
export interface OrchestrationKpis {
  /** Minutos desde o ultimo run do ORCHESTRATOR (Infinity se nunca). */
  minutesSinceLastCycle: number;
  /** Ciclos (runs ORCHESTRATOR) no dia. */
  cyclesToday: number;
  /** Ciclos FAILED no dia. */
  failedCyclesToday: number;
  /** Runs de agentes-filho FAILED no dia (saude geral dos filhos). */
  childFailuresToday: number;
  /** Total de runs de agentes-filho no dia. */
  childRunsToday: number;
  /** Lucro liquido do dia (FinanceSnapshot.netProfitCents de hoje; 0 se ausente). */
  netProfitCentsToday: number;
  /** Meta diaria de faturamento (centavos). */
  targetRevenueCents: number;
  /** Estamos antes do meio-dia UTC? (gatilho REVENUE_BELOW_TARGET so ate meio-dia). */
  beforeNoonUtc: boolean;
}

// Heartbeat: <=30min => 100; degrada ate 4h => 0.
const ORCH_FRESH_MIN = 30;
const ORCH_STALE_MIN = 4 * 60;

export function scoreOrchestration(k: OrchestrationKpis): SectorScore {
  let heartbeat: number;
  if (k.minutesSinceLastCycle <= ORCH_FRESH_MIN) {
    heartbeat = 100;
  } else if (k.minutesSinceLastCycle >= ORCH_STALE_MIN) {
    heartbeat = 0;
  } else {
    const span = ORCH_STALE_MIN - ORCH_FRESH_MIN;
    heartbeat = clampScore(100 - ((k.minutesSinceLastCycle - ORCH_FRESH_MIN) / span) * 100);
  }
  const cycleSuccess =
    k.cyclesToday > 0
      ? clampScore(((k.cyclesToday - k.failedCyclesToday) / k.cyclesToday) * 100)
      : NEUTRAL();
  const childHealth =
    k.childRunsToday > 0
      ? clampScore(((k.childRunsToday - k.childFailuresToday) / k.childRunsToday) * 100)
      : NEUTRAL();
  return {
    subscores: { heartbeat, cycleSuccess, childHealth },
    hasSignal: k.cyclesToday > 0 || Number.isFinite(k.minutesSinceLastCycle),
  };
}

// ============================================================
// SETORES DE PRODUCAO AUTONOMA (COO-Scale / Fase 5): MARKETPLACE / FUNNEL /
// AFFILIATE. NAO entram em SECTORS/SECTOR_WEIGHTS (decisao §6 SECTORS-TEAMS: o
// loop de scoring dos 7 e o teste de "exatamente 7 snapshots" permanecem
// intactos). Os subscores aqui sao PUROS e usam pesos LOCAIS (nao SECTOR_WEIGHTS),
// pois weightedScore so conhece os 7. crmWeightedScore faz a media local.
// ============================================================

/** Pesos locais por subscore dos 3 setores novos (media simples ponderada). */
export const CRM_SUBSCORE_WEIGHTS = {
  MARKETPLACE: { coverage: 0.4, liveness: 0.4, content: 0.2 },
  FUNNEL: { landing: 0.35, checkout: 0.35, payment: 0.3 },
  AFFILIATE: { activeRatio: 0.4, revenue: 0.4, pipeline: 0.2 },
} as const;

/** Media ponderada local 0..100 (analoga a weightedScore, mas p/ os 3 novos). */
export function crmWeightedScore(
  weights: Record<string, number>,
  subscores: Record<string, number>,
): number {
  let acc = 0;
  let totalWeight = 0;
  for (const key of Object.keys(weights)) {
    const sub = subscores[key];
    if (sub === undefined) continue;
    const w = weights[key]!;
    acc += clampScore(sub) * w;
    totalWeight += w;
  }
  if (totalWeight === 0) return 0;
  return clampScore(acc / totalWeight);
}

// ---- MARKETPLACE ----
export interface MarketplaceKpis {
  /** Products de ebooks PUBLISHED considerados (denominador). */
  products: number;
  /** Products SEM nenhuma MarketplaceListing (nao publicados externamente). */
  productsWithoutListing: number;
  /** Products sem externalProductId (sincronizacao incompleta). */
  productsWithoutExternalId: number;
  /** Ebooks PUBLISHED sem capa (coverImagePath nulo). */
  ebooksWithoutCover: number;
  /** Listings "mortas": zero vendas atribuidas nos ultimos 30d. */
  deadListings: number;
}

export function scoreMarketplace(k: MarketplaceKpis): SectorScore {
  // coverage: fracao de products COM listing + externalProductId.
  const synced =
    k.products > 0
      ? clampScore(
          ((k.products - Math.max(k.productsWithoutListing, k.productsWithoutExternalId)) /
            k.products) *
            100,
        )
      : NEUTRAL();
  // liveness: cada listing morta (sem venda em 30d) derruba 25 pts.
  const liveness = k.products > 0 ? clampScore(100 - k.deadListings * 25) : NEUTRAL();
  // content: cada ebook sem capa derruba 20 pts (afeta conversao no marketplace).
  const content = clampScore(100 - k.ebooksWithoutCover * 20);
  return {
    subscores: { coverage: synced, liveness, content },
    hasSignal: k.products > 0,
  };
}

// ---- FUNNEL ----
export interface FunnelKpis {
  /** Eventos IMPRESSION na janela 7d. */
  impressions: number;
  /** Eventos CLICK na janela 7d. */
  clicks: number;
  /** Eventos LANDING_VIEW na janela 7d. */
  landingViews: number;
  /** Eventos CHECKOUT_STARTED na janela 7d. */
  checkoutsStarted: number;
  /** Eventos PAID na janela 7d. */
  paid: number;
}

export function scoreFunnel(k: FunnelKpis): SectorScore {
  // Taxas stage-a-stage (undefined quando sem volume no estagio anterior).
  const landingRate = k.clicks > 0 ? k.landingViews / k.clicks : undefined; // CLICK -> LANDING
  const checkoutRate =
    k.landingViews > 0 ? k.checkoutsStarted / k.landingViews : undefined; // LANDING -> CHECKOUT
  const paymentRate = k.checkoutsStarted > 0 ? k.paid / k.checkoutsStarted : undefined; // CHECKOUT -> PAID

  // landing: clicar e chegar na landing (>=70% saudavel).
  const landing = landingRate === undefined ? NEUTRAL() : clampScore((landingRate / 0.7) * 100);
  // checkout: iniciar checkout a partir da landing (>=15% saudavel).
  const checkout =
    checkoutRate === undefined ? NEUTRAL() : clampScore((checkoutRate / 0.15) * 100);
  // payment: completar o pagamento (>=40% saudavel — anti-abandono de carrinho).
  const payment = paymentRate === undefined ? NEUTRAL() : clampScore((paymentRate / 0.4) * 100);
  return {
    subscores: { landing, checkout, payment },
    hasSignal: k.impressions > 0 || k.clicks > 0 || k.landingViews > 0,
  };
}

// ---- AFFILIATE ----
export interface AffiliateKpis {
  /** Afiliados com status PROSPECT. */
  prospects: number;
  /** Afiliados com status ACTIVE. */
  active: number;
  /** Afiliados com status PAUSED. */
  paused: number;
  /** Total de afiliados (denominador). */
  total: number;
  /** Receita atribuida a afiliados na janela (centavos). */
  attributedRevenueCents: number;
}

export function scoreAffiliate(k: AffiliateKpis): SectorScore {
  // activeRatio: fracao de afiliados ATIVOS (>=30% do total = 100).
  const activeRatio =
    k.total > 0 ? clampScore((k.active / k.total / 0.3) * 100) : NEUTRAL();
  // revenue: existe receita atribuida a afiliados? (binario suavizado).
  const revenue = k.active > 0 ? (k.attributedRevenueCents > 0 ? 100 : 30) : NEUTRAL();
  // pipeline: ter PROSPECTs para prospectar (>=5 = 100).
  const pipeline = clampScore((k.prospects / 5) * 100);
  return {
    subscores: { activeRatio, revenue, pipeline },
    hasSignal: k.total > 0,
  };
}

// Subscore neutro (60) usado quando o setor nao tem volume para julgar um eixo.
function NEUTRAL(): number {
  return NEUTRAL_SUBSCORE;
}

// ============================================================
// DbHealthCollector — implementacao concreta (toca o Prisma).
// ============================================================

const MS_PER_MIN = 60 * 1000;

export class DbHealthCollector implements HealthCollector {
  /** Janela (dias) para KPIs de janela (social/traffic). */
  private readonly windowDays: number;

  constructor(opts?: { windowDays?: number }) {
    this.windowDays = opts?.windowDays ?? 3;
  }

  /**
   * Coleta a saude dos 10 setores OPERAVEIS (CRM_SECTORS = 7 de saude + 3 de
   * producao MARKETPLACE/FUNNEL/AFFILIATE), persiste 1 SectorHealthSnapshot por
   * setor (mesmo cycleId) e devolve os SectorHealth (score + status derivado +
   * kpis). Idempotente: cada chamada e um snapshot append-only (time-series).
   *
   * Os 7 de saude usam SECTOR_WEIGHTS/weightedScore; os 3 de producao usam
   * pesos LOCAIS (CRM_SUBSCORE_WEIGHTS) via finalizeCrm — o loop do COO agora
   * monitora/diagnostica/remedia os 10.
   */
  async collect(ctx: AgentContext): Promise<SectorHealth[]> {
    const now = ctx.clock.now();
    const day = saoPauloDay(now);
    const { startUtc, endUtc } = saoPauloDayBoundsUtc(day);
    const windowStart = new Date(now.getTime() - this.windowDays * 24 * 60 * MS_PER_MIN);

    // Coleta KPIs por setor em paralelo (7 de saude + 3 de producao).
    const [
      contentKpis,
      salesKpis,
      deliveryKpis,
      socialKpis,
      trafficKpis,
      analyticsKpis,
      orchestrationKpis,
      marketplaceKpis,
      funnelKpis,
      affiliateKpis,
    ] = await Promise.all([
      this.collectContent(ctx, startUtc, endUtc),
      this.collectSales(ctx, windowStart),
      this.collectDelivery(ctx, startUtc, endUtc),
      this.collectSocial(ctx, windowStart),
      this.collectTraffic(ctx, windowStart),
      this.collectAnalytics(ctx, startUtc, endUtc, now),
      this.collectOrchestration(ctx, startUtc, endUtc, now),
      this.collectMarketplace(ctx),
      this.collectFunnel(ctx),
      this.collectAffiliate(ctx),
    ]);

    const scored: Record<CrmSector, { score: number; kpis: Json }> = {
      CONTENT: this.finalize('CONTENT', scoreContent(contentKpis), contentKpis),
      SALES: this.finalize('SALES', scoreSales(salesKpis), salesKpis),
      DELIVERY: this.finalize('DELIVERY', scoreDelivery(deliveryKpis), deliveryKpis),
      SOCIAL: this.finalize('SOCIAL', scoreSocial(socialKpis), socialKpis),
      TRAFFIC: this.finalize('TRAFFIC', scoreTraffic(trafficKpis), trafficKpis),
      ANALYTICS: this.finalize('ANALYTICS', scoreAnalytics(analyticsKpis), analyticsKpis),
      ORCHESTRATION: this.finalize(
        'ORCHESTRATION',
        scoreOrchestration(orchestrationKpis),
        orchestrationKpis,
      ),
      // Setores de producao: scoring com pesos LOCAIS (CRM_SUBSCORE_WEIGHTS).
      MARKETPLACE: this.finalizeCrm(
        'MARKETPLACE',
        scoreMarketplace(marketplaceKpis),
        marketplaceKpis,
      ),
      FUNNEL: this.finalizeCrm('FUNNEL', scoreFunnel(funnelKpis), funnelKpis),
      AFFILIATE: this.finalizeCrm('AFFILIATE', scoreAffiliate(affiliateKpis), affiliateKpis),
    };

    const results: SectorHealth[] = [];
    for (const sector of CRM_SECTORS) {
      const { score, kpis } = scored[sector];
      // Persiste o snapshot (status NUNCA persistido — derivado on-read).
      await ctx.prisma.sectorHealthSnapshot.create({
        data: {
          sector,
          score,
          kpis: kpis as never,
          capturedAt: now,
          cycleId: ctx.cycleId ?? null,
        },
      });
      results.push({ sector, score, status: statusFromScore(score), kpis });
    }

    ctx.log.info(
      { health: results.map((r) => ({ s: r.sector, score: r.score, st: r.status })) },
      'saude dos setores coletada',
    );
    return results;
  }

  /** Combina score + subscores + KPIs num kpis Json estavel para o snapshot. */
  private finalize(
    sector: Sector,
    sectorScore: SectorScore,
    rawKpis: object,
  ): { score: number; kpis: Json } {
    const score = sectorScore.hasSignal
      ? weightedScore(sector, sectorScore.subscores)
      : NEUTRAL_SUBSCORE;
    // Sanitiza para Json: Infinity/NaN viram null (Prisma Json nao aceita).
    const kpis: Json = {
      ...toJsonRecord(rawKpis),
      subscores: sectorScore.subscores as unknown as Json,
      hasSignal: sectorScore.hasSignal,
    };
    return { score, kpis };
  }

  /**
   * Variante de finalize para os 3 setores de producao (MARKETPLACE/FUNNEL/
   * AFFILIATE): usa os pesos LOCAIS (CRM_SUBSCORE_WEIGHTS) via crmWeightedScore,
   * pois weightedScore/SECTOR_WEIGHTS so conhecem os 7 de saude. Mesmo shape de
   * kpis Json (subscores + hasSignal) que finalize.
   */
  private finalizeCrm(
    sector: keyof typeof CRM_SUBSCORE_WEIGHTS,
    sectorScore: SectorScore,
    rawKpis: object,
  ): { score: number; kpis: Json } {
    const score = sectorScore.hasSignal
      ? crmWeightedScore(CRM_SUBSCORE_WEIGHTS[sector], sectorScore.subscores)
      : NEUTRAL_SUBSCORE;
    const kpis: Json = {
      ...toJsonRecord(rawKpis),
      subscores: sectorScore.subscores as unknown as Json,
      hasSignal: sectorScore.hasSignal,
    };
    return { score, kpis };
  }

  // ----------------------------------------------------------
  // Coletores por setor (queries Prisma).
  // ----------------------------------------------------------

  private async collectContent(
    ctx: AgentContext,
    startUtc: Date,
    endUtc: Date,
  ): Promise<ContentKpis> {
    const stuckCutoff = new Date(ctx.clock.now().getTime() - 60 * MS_PER_MIN); // 1h preso
    const [publishedWithActiveProduct, stuckEbooks, runsToday, failedRunsToday] =
      await Promise.all([
        ctx.prisma.ebook.count({
          where: { status: 'PUBLISHED', products: { some: { active: true } } },
        }),
        ctx.prisma.ebook.count({
          where: {
            status: { in: ['DRAFT', 'GENERATING'] },
            updatedAt: { lt: stuckCutoff },
          },
        }),
        ctx.prisma.agentRun.count({
          where: { agent: 'CONTENT', startedAt: { gte: startUtc, lt: endUtc } },
        }),
        ctx.prisma.agentRun.count({
          where: {
            agent: 'CONTENT',
            status: 'FAILED',
            startedAt: { gte: startUtc, lt: endUtc },
          },
        }),
      ]);
    return { publishedWithActiveProduct, stuckEbooks, runsToday, failedRunsToday };
  }

  private async collectSales(ctx: AgentContext, windowStart: Date): Promise<SalesKpis> {
    const [checkouts, paidOrders, activeProducts, published] = await Promise.all([
      ctx.prisma.event.count({
        where: { type: 'CHECKOUT_STARTED', occurredAt: { gte: windowStart } },
      }),
      ctx.prisma.order.count({
        where: { status: { in: ['PAID', 'DELIVERED'] }, createdAt: { gte: windowStart } },
      }),
      ctx.prisma.product.count({ where: { active: true } }),
      ctx.prisma.ebook.findMany({
        where: { status: 'PUBLISHED' },
        select: { products: { where: { active: true }, select: { id: true }, take: 1 } },
      }),
    ]);
    const publishedWithoutProduct = published.filter((e) => e.products.length === 0).length;
    return { checkouts, paidOrders, activeProducts, publishedWithoutProduct };
  }

  private async collectDelivery(
    ctx: AgentContext,
    startUtc: Date,
    endUtc: Date,
  ): Promise<DeliveryKpis> {
    const [pendingDeliveries, paidToday, runsToday, failedRunsToday] = await Promise.all([
      ctx.prisma.order.count({ where: { status: 'PAID', deliveryGrant: null } }),
      ctx.prisma.order.count({
        where: {
          status: { in: ['PAID', 'DELIVERED'] },
          paidAt: { gte: startUtc, lt: endUtc },
        },
      }),
      ctx.prisma.agentRun.count({
        where: { agent: 'DELIVERY', startedAt: { gte: startUtc, lt: endUtc } },
      }),
      ctx.prisma.agentRun.count({
        where: {
          agent: 'DELIVERY',
          status: 'FAILED',
          startedAt: { gte: startUtc, lt: endUtc },
        },
      }),
    ]);
    return { pendingDeliveries, paidToday, runsToday, failedRunsToday };
  }

  private async collectSocial(ctx: AgentContext, windowStart: Date): Promise<SocialKpis> {
    const [publishedRecent, failedRecent, recentPosts] = await Promise.all([
      ctx.prisma.socialPost.count({
        where: { status: 'PUBLISHED', publishedAt: { gte: windowStart } },
      }),
      ctx.prisma.socialPost.count({
        where: { status: 'FAILED', updatedAt: { gte: windowStart } },
      }),
      ctx.prisma.socialPost.findMany({
        where: { status: 'PUBLISHED', publishedAt: { gte: windowStart } },
        select: { metrics: true },
      }),
    ]);
    const engagementRecent = recentPosts.reduce((sum, p) => {
      const m = (p.metrics ?? {}) as Record<string, unknown>;
      const likes = typeof m.likes === 'number' ? m.likes : 0;
      const comments = typeof m.comments === 'number' ? m.comments : 0;
      const saves = typeof m.saves === 'number' ? m.saves : 0;
      return sum + likes + comments + saves;
    }, 0);
    return {
      publishedRecent,
      failedRecent,
      attemptedRecent: publishedRecent + failedRecent,
      engagementRecent,
    };
  }

  private async collectTraffic(
    ctx: AgentContext,
    windowStart: Date,
  ): Promise<TrafficKpis> {
    const sinceDateOnly = new Date(`${saoPauloDay(windowStart)}T00:00:00.000Z`);
    const [activeCampaigns, insightAgg, attributed] = await Promise.all([
      ctx.prisma.adCampaign.count({ where: { status: 'ACTIVE' } }),
      ctx.prisma.adInsight.aggregate({
        _sum: { spendCents: true },
        where: { date: { gte: sinceDateOnly } },
      }),
      ctx.prisma.order.aggregate({
        _sum: { priceCents: true },
        where: {
          status: { in: ['PAID', 'DELIVERED'] },
          adCampaignId: { not: null },
          paidAt: { gte: windowStart },
        },
      }),
    ]);
    return {
      activeCampaigns,
      spendCents: insightAgg._sum.spendCents ?? 0,
      attributedRevenueCents: attributed._sum.priceCents ?? 0,
      maxAdBudgetCents: Math.round(ctx.env.MAX_AD_BUDGET_BRL * 100),
    };
  }

  private async collectAnalytics(
    ctx: AgentContext,
    startUtc: Date,
    endUtc: Date,
    now: Date,
  ): Promise<AnalyticsKpis> {
    const [lastInsight, insightToday, runsToday, failedRunsToday, revenueAgg] =
      await Promise.all([
        ctx.prisma.event.findFirst({
          where: { type: 'INSIGHT_INGESTED' },
          orderBy: { occurredAt: 'desc' },
          select: { occurredAt: true },
        }),
        ctx.prisma.event.count({
          where: { type: 'INSIGHT_INGESTED', occurredAt: { gte: startUtc, lt: endUtc } },
        }),
        ctx.prisma.agentRun.count({
          where: { agent: 'ANALYTICS', startedAt: { gte: startUtc, lt: endUtc } },
        }),
        ctx.prisma.agentRun.count({
          where: {
            agent: 'ANALYTICS',
            status: 'FAILED',
            startedAt: { gte: startUtc, lt: endUtc },
          },
        }),
        // Receita do dia (paidAt no dia local) — base do subscore metaProgress.
        ctx.prisma.order.aggregate({
          _sum: { priceCents: true },
          where: {
            status: { in: ['PAID', 'DELIVERED'] },
            paidAt: { gte: startUtc, lt: endUtc },
          },
        }),
      ]);
    const minutesSinceLastInsight = lastInsight
      ? (now.getTime() - lastInsight.occurredAt.getTime()) / MS_PER_MIN
      : Infinity;
    return {
      insightIngestedToday: insightToday > 0,
      minutesSinceLastInsight,
      runsToday,
      failedRunsToday,
      revenueCentsToday: revenueAgg._sum.priceCents ?? 0,
      targetRevenueCents: Math.round(ctx.env.TARGET_DAILY_REVENUE_BRL * 100),
    };
  }

  private async collectOrchestration(
    ctx: AgentContext,
    startUtc: Date,
    endUtc: Date,
    now: Date,
  ): Promise<OrchestrationKpis> {
    const childAgents: AgentName[] = [
      'CONTENT',
      'SALES',
      'SOCIAL',
      'TRAFFIC',
      'DELIVERY',
      'ANALYTICS',
    ];
    const financeDay = new Date(`${saoPauloDay(now)}T00:00:00.000Z`);
    const [
      lastCycle,
      cyclesToday,
      failedCyclesToday,
      childRunsToday,
      childFailuresToday,
      finance,
    ] = await Promise.all([
      ctx.prisma.agentRun.findFirst({
        where: { agent: 'ORCHESTRATOR' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
      ctx.prisma.agentRun.count({
        where: { agent: 'ORCHESTRATOR', startedAt: { gte: startUtc, lt: endUtc } },
      }),
      ctx.prisma.agentRun.count({
        where: {
          agent: 'ORCHESTRATOR',
          status: 'FAILED',
          startedAt: { gte: startUtc, lt: endUtc },
        },
      }),
      ctx.prisma.agentRun.count({
        where: { agent: { in: childAgents }, startedAt: { gte: startUtc, lt: endUtc } },
      }),
      ctx.prisma.agentRun.count({
        where: {
          agent: { in: childAgents },
          status: 'FAILED',
          startedAt: { gte: startUtc, lt: endUtc },
        },
      }),
      // Consolidado financeiro do dia (1/dia; pode ainda nao existir cedo).
      // Best-effort: ausencia do modelo/erro => sem dado de receita (nao quebra a
      // coleta dos 7 setores nem testes que mockam um subconjunto do Prisma).
      this.financeNetProfit(ctx, financeDay),
    ]);
    const minutesSinceLastCycle = lastCycle
      ? (now.getTime() - lastCycle.startedAt.getTime()) / MS_PER_MIN
      : Infinity;
    return {
      minutesSinceLastCycle,
      cyclesToday,
      failedCyclesToday,
      childFailuresToday,
      childRunsToday,
      netProfitCentsToday: finance,
      targetRevenueCents: Math.round(ctx.env.TARGET_DAILY_REVENUE_BRL * 100),
      beforeNoonUtc: now.getUTCHours() < 12,
    };
  }

  /** Lucro liquido do dia (best-effort): ausencia/erro => 0. */
  private async financeNetProfit(ctx: AgentContext, day: Date): Promise<number> {
    try {
      const row = await ctx.prisma.financeSnapshot?.findUnique({
        where: { date: day },
        select: { netProfitCents: true },
      });
      return row?.netProfitCents ?? 0;
    } catch {
      return 0;
    }
  }

  // ==========================================================
  // COLETORES DE PRODUCAO AUTONOMA (COO-Scale / Fase 5).
  // Setores MARKETPLACE / FUNNEL / AFFILIATE — NAO entram no loop dos 7. Sao
  // publicos para que o COO de producao (modulo de orquestracao) os consuma e
  // diagnostique via DiagnosisEngine (CRM_SECTOR_RULES). Mesmas convencoes:
  // dinheiro Int centavos, queries Prisma defensivas, subscores via funcoes puras.
  // ==========================================================

  /**
   * MARKETPLACE: estado da distribuicao externa dos Products de ebooks PUBLISHED.
   * - sem MarketplaceListing => nao publicado externamente;
   * - sem externalProductId => sincronizacao incompleta;
   * - sem coverImagePath no ebook => capa faltando (afeta conversao);
   * - zero vendas atribuidas em 30d (Order do product) => listing "morta".
   */
  async collectMarketplace(ctx: AgentContext): Promise<MarketplaceKpis> {
    const now = ctx.clock.now();
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * MS_PER_MIN);

    const products = await ctx.prisma.product.findMany({
      where: { active: true, ebook: { status: 'PUBLISHED' } },
      select: {
        id: true,
        externalProductId: true,
        listings: { select: { id: true }, take: 1 },
        ebook: { select: { coverImagePath: true } },
        orders: {
          where: { status: { in: ['PAID', 'DELIVERED'] }, paidAt: { gte: since30d } },
          select: { id: true },
          take: 1,
        },
      },
    });

    let productsWithoutListing = 0;
    let productsWithoutExternalId = 0;
    let ebooksWithoutCover = 0;
    let deadListings = 0;

    for (const p of products) {
      const hasListing = p.listings.length > 0;
      if (!hasListing) productsWithoutListing += 1;
      if (!p.externalProductId) productsWithoutExternalId += 1;
      if (!p.ebook?.coverImagePath) ebooksWithoutCover += 1;
      // listing morta: ja publicada (tem listing) mas sem venda atribuida em 30d.
      if (hasListing && p.orders.length === 0) deadListings += 1;
    }

    return {
      products: products.length,
      productsWithoutListing,
      productsWithoutExternalId,
      ebooksWithoutCover,
      deadListings,
    };
  }

  /**
   * FUNNEL: contagens de Event por estagio na janela 7d + taxas stage-a-stage
   * (IMPRESSION -> CLICK -> LANDING_VIEW -> CHECKOUT_STARTED -> PAID).
   */
  async collectFunnel(ctx: AgentContext): Promise<FunnelKpis> {
    const now = ctx.clock.now();
    const windowStart = new Date(now.getTime() - 7 * 24 * 60 * MS_PER_MIN);
    const countEvent = (type: string): Promise<number> =>
      ctx.prisma.event.count({
        where: { type: type as never, occurredAt: { gte: windowStart } },
      });

    const [impressions, clicks, landingViews, checkoutsStarted, paid] = await Promise.all([
      countEvent('IMPRESSION'),
      countEvent('CLICK'),
      countEvent('LANDING_VIEW'),
      countEvent('CHECKOUT_STARTED'),
      countEvent('PAID'),
    ]);

    return { impressions, clicks, landingViews, checkoutsStarted, paid };
  }

  /**
   * AFFILIATE: contagens de Affiliate por status + receita atribuida a afiliados
   * na janela (Order.utmSource IN (hotmart,kiwify) AND utmMedium='afiliado').
   */
  async collectAffiliate(ctx: AgentContext, windowDays = 30): Promise<AffiliateKpis> {
    const now = ctx.clock.now();
    const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * MS_PER_MIN);

    const [prospects, active, paused, total, revenueAgg] = await Promise.all([
      ctx.prisma.affiliate.count({ where: { status: 'PROSPECT' } }),
      ctx.prisma.affiliate.count({ where: { status: 'ACTIVE' } }),
      ctx.prisma.affiliate.count({ where: { status: 'PAUSED' } }),
      ctx.prisma.affiliate.count(),
      ctx.prisma.order.aggregate({
        _sum: { priceCents: true },
        where: {
          status: { in: ['PAID', 'DELIVERED'] },
          paidAt: { gte: windowStart },
          utmSource: { in: ['hotmart', 'kiwify'] },
          utmMedium: 'afiliado',
        },
      }),
    ]);

    return {
      prospects,
      active,
      paused,
      total,
      attributedRevenueCents: revenueAgg._sum.priceCents ?? 0,
    };
  }

  /**
   * Subscore EXTRA de CONTENT (COO-Scale): existe oportunidade de mercado PENDING
   * de alto potencial (potentialScore > 70) esperando virar ebook? Quanto mais
   * oportunidades quentes paradas, MAIOR a pressao para gerar conteudo (sinal de
   * que ha demanda nao atendida). Retorna { pendingHighScore, count }.
   */
  async collectContentOpportunitySignal(
    ctx: AgentContext,
  ): Promise<{ pendingHighScore: number; count: number }> {
    const count = await ctx.prisma.marketOpportunity.count({
      where: { status: 'PENDING', potentialScore: { gt: 70 } },
    });
    return { pendingHighScore: count, count };
  }
}
