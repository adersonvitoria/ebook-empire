// MARKET_RESEARCH — ESPECIALISTA.
// Coleta SINAIS de mercado para um conjunto de nichos candidatos:
//   - EXTERNOS: via MarketDataPort (Serper.dev real / stub) — organic (oferta),
//     peopleAlsoAsk + relatedSearches (demanda latente), knowledgeGraph (competicao).
//   - INTERNOS: via Prisma — receita/pedidos por nicho na janela (sinal real de
//     que o nicho ja converte na nossa loja). Reusa a janela saoPauloDay.
//
// Produz NicheSignal[] (sinais brutos por nicho) + um Assessment do setor
// MARKET_RESEARCH (diagnostico tecnico em pt-BR), compativel com o contrato da
// Fundacao (core/team.ts). O LLM e OPCIONAL: usado apenas para enriquecer o
// texto do Assessment; o ranking quantitativo e DETERMINISTICO (strategist.ts).
//
// Convencoes: scores 0..100 (NAO centavos); dinheiro interno Int centavos.

import type {
  Assessment,
  Json,
  MarketDataPort,
  MarketSearchResult,
} from '@ebook-empire/core';
import { statusFromScore } from '@ebook-empire/core';
import type { AgentContext } from '../../base.js';
import { saoPauloDay, saoPauloDayBoundsUtc } from '../../analytics.js';

// ------------------------------------------------------------
// Nicho candidato (segmento macro + nicho especifico + queries de pesquisa).
// ------------------------------------------------------------
export interface NicheCandidate {
  segment: string;
  niche: string;
  /** Queries de busca para sondar a SERP (1+; a 1a e a principal). */
  queries: string[];
}

// ------------------------------------------------------------
// Sinais coletados por nicho (externos + internos).
// ------------------------------------------------------------
export interface NicheSignal {
  segment: string;
  niche: string;
  /** Resultados de busca por query (externos). */
  searches: MarketSearchResult[];
  external: {
    /** Soma de perguntas (peopleAlsoAsk) — proxy de demanda latente. */
    paaCount: number;
    /** Soma de buscas relacionadas — proxy de amplitude de demanda. */
    relatedCount: number;
    /** Soma de resultados organicos — proxy de oferta/competicao. */
    organicCount: number;
    /** Quantas queries tiveram knowledgeGraph (competicao por marca forte). */
    knowledgeGraphHits: number;
    /** Numero de queries efetivamente consultadas. */
    queriesRun: number;
  };
  internal: {
    /** Receita do nicho na janela (centavos). */
    revenueCents: number;
    /** Pedidos pagos do nicho na janela. */
    paidOrders: number;
    /** Ebooks PUBLISHED no nicho (saturacao do catalogo proprio). */
    publishedEbooks: number;
  };
}

// ------------------------------------------------------------
// Catalogo default de nichos candidatos (Brasil, info-produto).
// Editavel num lugar so; o service pode sobrescrever via construtor.
// ------------------------------------------------------------
export const DEFAULT_NICHE_CANDIDATES: readonly NicheCandidate[] = [
  {
    segment: 'Financas Pessoais',
    niche: 'Investir do zero',
    queries: ['como investir do zero', 'investimentos para iniciantes'],
  },
  {
    segment: 'Financas Pessoais',
    niche: 'Sair das dividas',
    queries: ['como sair das dividas', 'quitar dividas rapido'],
  },
  {
    segment: 'Produtividade',
    niche: 'Gestao de tempo',
    queries: ['como organizar o tempo', 'tecnicas de produtividade'],
  },
  {
    segment: 'Emagrecimento',
    niche: 'Receitas low carb',
    queries: ['receitas low carb', 'cardapio low carb para emagrecer'],
  },
  {
    segment: 'Marketing Digital',
    niche: 'Trafego pago para iniciantes',
    queries: ['como comecar com trafego pago', 'anuncios no instagram para vender'],
  },
  {
    segment: 'Desenvolvimento Pessoal',
    niche: 'Inteligencia emocional',
    queries: ['como controlar a ansiedade', 'inteligencia emocional no trabalho'],
  },
  {
    segment: 'Carreira',
    niche: 'Trabalhar como freelancer',
    queries: ['como ser freelancer', 'ganhar dinheiro como freelancer'],
  },
  {
    segment: 'Tecnologia',
    niche: 'Usar IA no dia a dia',
    queries: ['como usar inteligencia artificial', 'ferramentas de IA para produtividade'],
  },
  // ----------------------------------------------------------
  // Expansao de cobertura (FASE 2): Saude, Financas, Relacionamentos.
  // Cada nicho traz 2 queries Serper; ao menos 1 ciente de marketplace
  // (sufixo "hotmart"/"kiwify") para sondar a oferta de info-produto la.
  // ----------------------------------------------------------
  // --- Saude ---
  {
    segment: 'Saude',
    niche: 'Emagrecimento feminino',
    queries: ['ebook emagrecimento feminino hotmart', 'como emagrecer apos os 40'],
  },
  {
    segment: 'Saude',
    niche: 'Ansiedade e estresse',
    queries: ['ebook ansiedade kiwify', 'como controlar a ansiedade sem remedio'],
  },
  {
    segment: 'Saude',
    niche: 'Qualidade do sono',
    queries: ['ebook como dormir melhor hotmart', 'tecnicas para dormir rapido'],
  },
  // --- Financas ---
  {
    segment: 'Financas',
    niche: 'Investimentos para iniciantes',
    queries: ['ebook investimentos para iniciantes hotmart', 'como comecar a investir do zero'],
  },
  {
    segment: 'Financas',
    niche: 'Renda extra online',
    queries: ['ebook renda extra online kiwify', 'como ganhar dinheiro na internet'],
  },
  {
    segment: 'Financas',
    niche: 'Sair das dividas',
    queries: ['ebook sair das dividas hotmart', 'como quitar dividas rapido'],
  },
  // --- Relacionamentos ---
  {
    segment: 'Relacionamentos',
    niche: 'Comunicacao no casal',
    queries: ['ebook comunicacao no casamento hotmart', 'como melhorar a comunicacao no relacionamento'],
  },
  {
    segment: 'Relacionamentos',
    niche: 'Autoestima feminina',
    queries: ['ebook autoestima feminina kiwify', 'como aumentar a autoestima'],
  },
  {
    segment: 'Relacionamentos',
    niche: 'Autoconhecimento',
    queries: ['ebook autoconhecimento hotmart', 'jornada de autoconhecimento como comecar'],
  },
] as const;

// ============================================================
// MarketSpecialist
// ============================================================
export class MarketSpecialist {
  constructor(
    private readonly candidates: readonly NicheCandidate[] = DEFAULT_NICHE_CANDIDATES,
  ) {}

  /**
   * Coleta sinais externos + internos para cada nicho candidato. Respeita o teto
   * de queries por run (ctx.env.MARKET_MAX_QUERIES_PER_RUN). Tolerante a falha
   * por query (uma busca que falha nao derruba a coleta — vira sinal vazio).
   */
  async collectSignals(ctx: AgentContext): Promise<NicheSignal[]> {
    const marketData = this.requireMarketData(ctx);
    const maxQueries = numEnv(ctx, 'MARKET_MAX_QUERIES_PER_RUN', 10);
    const windowDays = numEnv(ctx, 'MARKET_RESEARCH_WINDOW_DAYS', 14);
    const gl = strEnv(ctx, 'MARKET_SEARCH_GL', 'br');
    const hl = strEnv(ctx, 'MARKET_SEARCH_HL', 'pt-br');

    const now = ctx.clock.now();
    const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    let queriesUsed = 0;
    const signals: NicheSignal[] = [];

    for (const candidate of this.candidates) {
      const searches: MarketSearchResult[] = [];
      for (const query of candidate.queries) {
        if (queriesUsed >= maxQueries) break;
        queriesUsed += 1;
        try {
          const result = await marketData.search({ query, gl, hl });
          searches.push(result);
        } catch (err) {
          ctx.log.warn(
            {
              niche: candidate.niche,
              query,
              err: err instanceof Error ? err.message : String(err),
            },
            'MARKET_RESEARCH: busca externa falhou — seguindo sem este sinal',
          );
        }
      }

      const external = aggregateExternal(searches);
      const internal = await this.collectInternal(ctx, candidate.niche, windowStart);
      signals.push({
        segment: candidate.segment,
        niche: candidate.niche,
        searches,
        external,
        internal,
      });

      if (queriesUsed >= maxQueries) {
        ctx.log.info(
          { maxQueries },
          'MARKET_RESEARCH: teto de queries atingido — encerrando coleta',
        );
        break;
      }
    }

    return signals;
  }

  /** Sinais internos por nicho: receita/pedidos na janela + catalogo publicado. */
  private async collectInternal(
    ctx: AgentContext,
    niche: string,
    windowStart: Date,
  ): Promise<NicheSignal['internal']> {
    const [revenueAgg, publishedEbooks] = await Promise.all([
      ctx.prisma.order.aggregate({
        _sum: { priceCents: true },
        _count: { _all: true },
        where: {
          status: { in: ['PAID', 'DELIVERED'] },
          paidAt: { gte: windowStart },
          ebook: { niche },
        },
      }),
      ctx.prisma.ebook.count({ where: { status: 'PUBLISHED', niche } }),
    ]);
    return {
      revenueCents: revenueAgg._sum.priceCents ?? 0,
      paidOrders: revenueAgg._count._all,
      publishedEbooks,
    };
  }

  /**
   * Produz o Assessment do setor MARKET_RESEARCH (diagnostico tecnico). Deriva um
   * "healthScore" sintetico a partir da riqueza dos sinais (ha demanda mapeada?
   * ha nichos sem catalogo proprio = oportunidade?) e tenta enriquecer o texto
   * via LLM. JSON malformado/ausente => fallback deterministico (source RULES).
   */
  async assess(ctx: AgentContext, signals: NicheSignal[]): Promise<Assessment> {
    const score = syntheticHealthScore(signals);
    const evidence = buildEvidence(signals);
    const fallback = this.fallbackAssessment(score, signals, evidence);
    ctx.log.debug({ sector: 'MARKET_RESEARCH', score }, 'assessment de mercado');
    return fallback;
  }

  private fallbackAssessment(
    score: number,
    signals: NicheSignal[],
    evidence: Json,
  ): Assessment {
    const withDemand = signals.filter((s) => s.external.paaCount + s.external.relatedCount > 0);
    const openNiches = signals.filter((s) => s.internal.publishedEbooks === 0);
    return {
      sector: 'MARKET_RESEARCH',
      healthScore: score,
      status: statusFromScore(score),
      findings: [
        `Foram sondados ${signals.length} nichos candidatos.`,
        `${withDemand.length} nichos apresentam sinais de demanda (perguntas/buscas relacionadas).`,
      ],
      risks:
        withDemand.length === 0
          ? ['Sinais de demanda externos ausentes — pesquisa pode estar usando stub/sem chave Serper.']
          : [],
      opportunities: openNiches.map(
        (s) => `Nicho "${s.niche}" (${s.segment}) ainda sem catalogo proprio — espaco para lancar.`,
      ),
      evidence,
      confidence: 0.6,
      source: 'RULES',
    };
  }

  private requireMarketData(ctx: AgentContext): MarketDataPort {
    const port = ctx.ports.marketData;
    if (!port) {
      throw new Error(
        'MARKET_RESEARCH: MarketDataPort ausente em ctx.ports.marketData — ' +
          'configure createMarketDataAdapter no wiring (scheduler/rota).',
      );
    }
    return port;
  }
}

// ============================================================
// Agregacoes/ scoring puro (testavel sem DB).
// ============================================================

/** Agrega os sinais externos de varias buscas de um mesmo nicho. */
export function aggregateExternal(searches: MarketSearchResult[]): NicheSignal['external'] {
  let paaCount = 0;
  let relatedCount = 0;
  let organicCount = 0;
  let knowledgeGraphHits = 0;
  for (const s of searches) {
    paaCount += s.peopleAlsoAsk.length;
    relatedCount += s.relatedSearches.length;
    organicCount += s.totalOrganic;
    if (s.knowledgeGraphPresent) knowledgeGraphHits += 1;
  }
  return {
    paaCount,
    relatedCount,
    organicCount,
    knowledgeGraphHits,
    queriesRun: searches.length,
  };
}

/**
 * Health sintetico do setor MARKET_RESEARCH (0..100): quanto melhor mapeamos a
 * demanda e quanto mais nichos "abertos" (sem catalogo proprio) com demanda,
 * maior o score. Sem nenhum sinal externo => baixo (50) — a pesquisa nao ajudou.
 */
export function syntheticHealthScore(signals: NicheSignal[]): number {
  if (signals.length === 0) return 50;
  const totalDemand = signals.reduce(
    (acc, s) => acc + s.external.paaCount + s.external.relatedCount,
    0,
  );
  if (totalDemand === 0) return 50;
  // Fracao de nichos com demanda mapeada.
  const withDemand = signals.filter(
    (s) => s.external.paaCount + s.external.relatedCount > 0,
  ).length;
  const coverage = withDemand / signals.length; // 0..1
  return clamp100(Math.round(50 + coverage * 50));
}

function buildEvidence(signals: NicheSignal[]): Json {
  return {
    nichesScanned: signals.length,
    perNiche: signals.map((s) => ({
      segment: s.segment,
      niche: s.niche,
      paaCount: s.external.paaCount,
      relatedCount: s.external.relatedCount,
      organicCount: s.external.organicCount,
      knowledgeGraphHits: s.external.knowledgeGraphHits,
      revenueCents: s.internal.revenueCents,
      paidOrders: s.internal.paidOrders,
      publishedEbooks: s.internal.publishedEbooks,
    })),
  } as Json;
}

function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ------------------------------------------------------------
// Leitura tolerante do AgentEnv (campos numericos/strings de MARKET_*).
// AgentEnv tem index-signature [key]: string|number|boolean (ver base.ts).
// ------------------------------------------------------------
function numEnv(ctx: AgentContext, key: string, fallback: number): number {
  const v = ctx.env[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function strEnv(ctx: AgentContext, key: string, fallback: string): string {
  const v = ctx.env[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

// Re-exporta a janela usada (coesao com o resto do setor).
export { saoPauloDay, saoPauloDayBoundsUtc };
