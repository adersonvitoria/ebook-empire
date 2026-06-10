// MARKET_RESEARCH — ESTRATEGISTA.
// Converte os NicheSignal[] do especialista em MarketOpportunity[] RANKEADAS por
// potentialScore (chave de ordenacao). O ranking quantitativo e DETERMINISTICO
// (scoreOpportunity, puro/testavel); o LLM e OPCIONAL e so enriquece titleIdeas/
// angles/rationale (com fallback deterministico se faltar/JSON invalido).
//
// Heuristica de scores (todos 0..100):
//   demandScore       — proxy de demanda: peopleAlsoAsk + relatedSearches +
//                       sinal interno (receita/pedidos do nicho ja convertem).
//   competitionScore  — proxy de competicao (MAIOR = pior): muitos organicos +
//                       presenca de knowledgeGraph (marca forte na SERP).
//   potentialScore    — combina demanda alta x competicao baixa, com BONUS para
//                       nichos "abertos" (sem catalogo proprio = espaco livre).
//
// Convencoes: scores 0..100 (NAO centavos). Strings de usuario em pt-BR.

import type {
  Json,
  MarketOpportunity,
  Strategy,
  StrategyAction,
} from '@ebook-empire/core';
import { marketOpportunityBatchSchema } from '@ebook-empire/core';
import type { AgentContext } from '../../base.js';
import type { NicheSignal } from './specialist.js';

// ============================================================
// Scoring DETERMINISTICO (puro — base dos testes, sem rede/DB).
// ============================================================

/** Satura linearmente x em [0, cap] para 0..100. */
function saturate(x: number, cap: number): number {
  if (cap <= 0) return 0;
  return clamp100((x / cap) * 100);
}

function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** demandScore 0..100 a partir dos sinais (externos + internos). */
export function demandScoreOf(signal: NicheSignal): number {
  // Demanda externa: perguntas reais (peso forte) + buscas relacionadas.
  const externalDemand =
    saturate(signal.external.paaCount, 8) * 0.6 +
    saturate(signal.external.relatedCount, 12) * 0.4;
  // Demanda interna comprovada: o nicho ja vende na nossa loja (sinal de ouro).
  const internalDemand =
    signal.internal.paidOrders > 0
      ? saturate(signal.internal.paidOrders, 10)
      : 0;
  // Mistura: se ha venda interna, ela puxa o score pra cima.
  const mixed = externalDemand * 0.7 + internalDemand * 0.3;
  return clamp100(mixed);
}

/** competitionScore 0..100 (MAIOR = pior) a partir da SERP. */
export function competitionScoreOf(signal: NicheSignal): number {
  const queriesRun = Math.max(1, signal.external.queriesRun);
  // Densidade media de organicos por query (mais resultados = mais oferta).
  const avgOrganic = signal.external.organicCount / queriesRun;
  const organicPressure = saturate(avgOrganic, 10); // ~10 organicos/SERP = saturado
  // KnowledgeGraph indica marca/entidade dominante -> competicao alta.
  const kgPressure = saturate(signal.external.knowledgeGraphHits, queriesRun);
  return clamp100(organicPressure * 0.7 + kgPressure * 0.3);
}

/**
 * potentialScore 0..100: demanda alta x competicao baixa, com bonus de "espaco
 * livre" quando ainda nao temos catalogo proprio no nicho.
 */
export function potentialScoreOf(
  demandScore: number,
  competitionScore: number,
  signal: NicheSignal,
): number {
  // Base: demanda descontada pela competicao (competicao reduz ate 50%).
  const base = demandScore * (1 - (competitionScore / 100) * 0.5);
  // Bonus de espaco livre: +10 se nao ha ebook publicado nosso no nicho.
  const openBonus = signal.internal.publishedEbooks === 0 ? 10 : 0;
  return clamp100(base + openBonus);
}

/** Constroi a MarketOpportunity DETERMINISTICA de um nicho (sem LLM). */
export function scoreOpportunity(signal: NicheSignal): MarketOpportunity {
  const demandScore = demandScoreOf(signal);
  const competitionScore = competitionScoreOf(signal);
  const potentialScore = potentialScoreOf(demandScore, competitionScore, signal);

  const evidence: string[] = [];
  // Perguntas reais dos usuarios (PAA) sao a melhor evidencia de demanda.
  for (const s of signal.searches) {
    for (const paa of s.peopleAlsoAsk.slice(0, 3)) {
      evidence.push(`PAA: ${paa.question}`);
    }
    for (const rel of s.relatedSearches.slice(0, 3)) {
      evidence.push(`Relacionada: ${rel}`);
    }
  }
  if (signal.internal.paidOrders > 0) {
    evidence.push(
      `Interno: ${signal.internal.paidOrders} pedido(s) pago(s) no nicho na janela.`,
    );
  }
  if (signal.external.knowledgeGraphHits > 0) {
    evidence.push(
      `Competicao: ${signal.external.knowledgeGraphHits} query(ies) com knowledgeGraph.`,
    );
  }

  return {
    segment: signal.segment,
    niche: signal.niche,
    demandScore,
    competitionScore,
    potentialScore,
    rationale: buildRationale(signal, demandScore, competitionScore, potentialScore),
    titleIdeas: defaultTitleIdeas(signal.niche),
    angles: defaultAngles(signal.niche),
    evidence: dedupe(evidence).slice(0, 12),
  };
}

function buildRationale(
  signal: NicheSignal,
  demand: number,
  competition: number,
  potential: number,
): string {
  const open = signal.internal.publishedEbooks === 0 ? ' Sem catalogo proprio (espaco livre).' : '';
  return (
    `Nicho "${signal.niche}" (${signal.segment}): demanda ${demand}/100, ` +
    `competicao ${competition}/100, potencial ${potential}/100.${open}`
  );
}

function defaultTitleIdeas(niche: string): string[] {
  return [
    `Guia Definitivo de ${niche}`,
    `${niche} do Zero ao Avancado`,
    `Domine ${niche} em 7 Passos`,
  ];
}

function defaultAngles(niche: string): string[] {
  return [
    `Resultado rapido para iniciantes em ${niche}`,
    `Erros comuns que travam quem comeca em ${niche}`,
    `Metodo passo a passo de ${niche}`,
  ];
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.filter((x) => x.trim().length > 0)));
}

// ============================================================
// MarketStrategist — rankeia + (opcional) enriquece via LLM.
// ============================================================
export class MarketStrategist {
  /**
   * Rankeia os sinais em MarketOpportunity[] ordenadas por potentialScore desc.
   * Tenta enriquecer titleIdeas/angles/rationale do TOP-N via LLM (best-effort);
   * o ranking em si NUNCA depende do LLM.
   */
  async rank(
    ctx: AgentContext,
    signals: NicheSignal[],
  ): Promise<{
    opportunities: MarketOpportunity[];
    tokensIn: number;
    tokensOut: number;
    costCents: number;
  }> {
    // 1) ranking deterministico.
    const ranked = signals
      .map((s) => scoreOpportunity(s))
      .sort((a, b) => b.potentialScore - a.potentialScore);

    // 2) enriquecimento opcional via LLM (so o topo, p/ economizar tokens).
    let tokensIn = 0;
    let tokensOut = 0;
    let costCents = 0;
    const enriched = await this.tryEnrich(ctx, ranked, (u) => {
      tokensIn += u.inputTokens;
      tokensOut += u.outputTokens;
      costCents += u.costCents ?? 0;
    });

    return { opportunities: enriched, tokensIn, tokensOut, costCents };
  }

  private async tryEnrich(
    ctx: AgentContext,
    ranked: MarketOpportunity[],
    accumulate: (u: { inputTokens: number; outputTokens: number; costCents?: number }) => void,
  ): Promise<MarketOpportunity[]> {
    if (ranked.length === 0) return ranked;
    const topN = ranked.slice(0, Math.min(5, ranked.length));

    try {
      const { data, usage } = await ctx.ports.llm.generateJson({
        model: ctx.env.PLANNING_MODEL,
        system:
          'Voce e o ESTRATEGISTA de MERCADO da Ebook Empire (info-produtos no Brasil). ' +
          'Para cada nicho ja rankeado, gere titulos e angulos de venda fortes em pt-BR. ' +
          'NAO altere os scores numericos — eles ja foram calculados.',
        messages: [
          { role: 'user', content: this.buildEnrichPrompt(topN) },
        ],
        maxTokens: 1500,
        temperature: 0.6,
        parse: (raw) => marketOpportunityBatchSchema.parse(raw),
      });
      accumulate(usage);

      // Mescla: mantem os scores deterministicos; usa titleIdeas/angles/rationale
      // do LLM quando casam o nicho (por nome). Os demais ficam como estavam.
      const byNiche = new Map(data.opportunities.map((o) => [o.niche, o]));
      return ranked.map((det) => {
        const llm = byNiche.get(det.niche);
        if (!llm) return det;
        return {
          ...det,
          titleIdeas: llm.titleIdeas.length > 0 ? llm.titleIdeas : det.titleIdeas,
          angles: llm.angles.length > 0 ? llm.angles : det.angles,
          rationale: llm.rationale && llm.rationale.length > 0 ? llm.rationale : det.rationale,
        };
      });
    } catch (err) {
      ctx.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'MARKET_RESEARCH: LLM do estrategista indisponivel — usando ranking deterministico',
      );
      return ranked;
    }
  }

  private buildEnrichPrompt(top: MarketOpportunity[]): string {
    const list = top
      .map(
        (o) =>
          `- segment: "${o.segment}", niche: "${o.niche}" (demanda ${o.demandScore}, competicao ${o.competitionScore}, potencial ${o.potentialScore})`,
      )
      .join('\n');
    return [
      'Nichos rankeados (NAO mude os scores):',
      list,
      '',
      'Responda APENAS JSON no formato { "opportunities": MarketOpportunity[] }, onde cada item tem:',
      '{ "segment", "niche", "demandScore", "competitionScore", "potentialScore", "rationale",',
      '  "titleIdeas": string[] (3-5 titulos de ebook vendaveis), "angles": string[] (3-5 angulos de copy),',
      '  "evidence": string[] }. Mantenha os scores identicos aos fornecidos.',
    ].join('\n');
  }

  /**
   * Strategy (contrato da Fundacao) derivada do ranking — para observabilidade
   * do papel STRATEGIST. A acao "persistOpportunities" e a unica capability do
   * executor deste setor.
   */
  buildStrategy(ctx: AgentContext, opportunities: MarketOpportunity[]): Strategy {
    const top = opportunities[0];
    const actions: StrategyAction[] = [
      {
        capability: 'persistOpportunities',
        priority: 90,
        params: { count: opportunities.length } as Json,
        reason: 'Persistir as oportunidades rankeadas e selecionar a de maior potencial.',
      },
    ];
    return {
      sector: 'MARKET_RESEARCH',
      objective: `Selecionar nichos de maior potencial rumo a meta de R$${ctx.env.TARGET_DAILY_REVENUE_BRL}/dia.`,
      mode: 'GROW',
      actions,
      successCriteria: [
        top
          ? `Oportunidade topo: "${top.niche}" (potencial ${top.potentialScore}/100).`
          : 'Nenhuma oportunidade encontrada nesta rodada.',
      ],
      rationale:
        'Toda criacao de ebook parte de uma oportunidade de mercado selecionada (GATE 1).',
    };
  }
}
