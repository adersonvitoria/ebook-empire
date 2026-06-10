// MARKET_RESEARCH — EXECUTOR.
// Persiste as MarketOpportunity[] rankeadas (append-only) e SELECIONA a de maior
// potentialScore (status SELECTED + selectedAt). Emite o Event
// MARKET_OPPORTUNITY_RANKED. Retorna os registros persistidos (com id/status).
//
// Idempotencia/observabilidade: o ciclo de AgentRun (com role/sector) e do
// service via runRole; aqui apenas persistimos. As oportunidades sao registros
// novos a cada scan (time-series de descobertas) — nao deduplicamos por nicho de
// proposito (o ranking pode mudar entre janelas).
//
// Convencoes: scores 0..100 (NAO centavos). titleIdeas/angles/evidence sao Json
// (string[]) no Prisma. Strings de usuario em pt-BR.

import type {
  MarketOpportunity,
  MarketOpportunityRecord,
  MarketOpportunityStatus,
} from '@ebook-empire/core';
import type { PrismaClient } from '@prisma/client';
import type { AgentContext } from '../../base.js';

// Linha bruta retornada pelo Prisma (campos Json sao string[] serializados).
interface OpportunityRow {
  id: string;
  segment: string;
  niche: string;
  demandScore: number;
  competitionScore: number;
  potentialScore: number;
  rationale: string;
  titleIdeas: unknown;
  angles: unknown;
  evidence: unknown;
  status: MarketOpportunityStatus;
  generatedByRunId: string | null;
  selectedAt: Date | null;
  usedByEbookId: string | null;
  createdAt: Date;
  rankedAt: Date;
  updatedAt: Date;
}

export class MarketExecutor {
  /**
   * Persiste as oportunidades (ordenadas por potentialScore desc) e marca a
   * primeira (maior potencial) como SELECTED. Retorna os registros persistidos.
   *
   * @param generatedByRunId AgentRun do papel EXECUTOR (correlacao) — opcional.
   */
  async persist(
    ctx: AgentContext,
    opportunities: MarketOpportunity[],
    generatedByRunId?: string | null,
  ): Promise<MarketOpportunityRecord[]> {
    if (opportunities.length === 0) {
      ctx.log.info({}, 'MARKET_RESEARCH: nenhuma oportunidade para persistir');
      return [];
    }

    const now = ctx.clock.now();

    // --- FILTRO DE RECENCIA ---
    // Pula nichos que JA foram USADOS recentemente (existe MarketOpportunity
    // status=USED com updatedAt dentro da janela), evitando reselecionar o mesmo
    // nicho a cada ciclo (catalogo precisa de variedade). Janela configuravel via
    // MARKET_RESEARCH_WINDOW_DAYS (default 14 dias).
    const filtered = await this.dropRecentlyUsedNiches(ctx, opportunities, now);
    if (filtered.length === 0) {
      ctx.log.info(
        { candidates: opportunities.length },
        'MARKET_RESEARCH: todos os nichos candidatos foram usados recentemente — nada a persistir',
      );
      return [];
    }

    const ranked = [...filtered].sort(
      (a, b) => b.potentialScore - a.potentialScore,
    );

    const records: MarketOpportunityRecord[] = [];
    for (let i = 0; i < ranked.length; i += 1) {
      const opp = ranked[i]!;
      const isTop = i === 0;
      const row = (await ctx.prisma.marketOpportunity.create({
        data: {
          segment: opp.segment,
          niche: opp.niche,
          demandScore: opp.demandScore,
          competitionScore: opp.competitionScore,
          potentialScore: opp.potentialScore,
          rationale: opp.rationale,
          titleIdeas: opp.titleIdeas as unknown as never,
          angles: opp.angles as unknown as never,
          evidence: opp.evidence as unknown as never,
          status: isTop ? 'SELECTED' : 'PENDING',
          selectedAt: isTop ? now : null,
          generatedByRunId: generatedByRunId ?? null,
          rankedAt: now,
        },
      })) as OpportunityRow;
      records.push(toRecord(row));
    }

    const top = records[0]!;
    // Event de funil interno (idempotencia nao aplicavel — append-only).
    await ctx.prisma.event.create({
      data: {
        type: 'MARKET_OPPORTUNITY_RANKED',
        metadata: {
          topNiche: top.niche,
          topSegment: top.segment,
          topPotentialScore: top.potentialScore,
          count: records.length,
        } as unknown as never,
      },
    });

    ctx.log.info(
      { count: records.length, topNiche: top.niche, topPotential: top.potentialScore },
      'MARKET_RESEARCH: oportunidades persistidas e topo selecionado',
    );
    return records;
  }

  /**
   * Remove das candidatas os nichos que ja foram USADOS recentemente: existe uma
   * MarketOpportunity com status=USED cujo updatedAt > now - janela (default 14
   * dias, via MARKET_RESEARCH_WINDOW_DAYS). Comparacao case-insensitive por nicho.
   * Tolerante a falha: se a consulta lancar, NAO filtra (segue o comportamento
   * legado de persistir tudo) — o negocio nunca trava por isso.
   */
  private async dropRecentlyUsedNiches(
    ctx: AgentContext,
    opportunities: MarketOpportunity[],
    now: Date,
  ): Promise<MarketOpportunity[]> {
    const windowDays = recencyWindowDays(ctx);
    const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    let usedRows: Array<{ niche: string }>;
    try {
      usedRows = (await ctx.prisma.marketOpportunity.findMany({
        where: { status: 'USED', updatedAt: { gt: since } },
        select: { niche: true },
      })) as Array<{ niche: string }>;
    } catch (err) {
      ctx.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'MARKET_RESEARCH: filtro de recencia falhou — persistindo sem filtrar',
      );
      return opportunities;
    }

    if (usedRows.length === 0) return opportunities;

    const usedNiches = new Set(usedRows.map((r) => r.niche.trim().toLowerCase()));
    const kept = opportunities.filter(
      (o) => !usedNiches.has(o.niche.trim().toLowerCase()),
    );

    const droppedCount = opportunities.length - kept.length;
    if (droppedCount > 0) {
      ctx.log.info(
        { droppedCount, windowDays },
        'MARKET_RESEARCH: nichos usados recentemente pulados (filtro de recencia)',
      );
    }
    return kept;
  }
}

/** Janela de recencia em dias (MARKET_RESEARCH_WINDOW_DAYS), default 14. */
function recencyWindowDays(ctx: AgentContext): number {
  const v = ctx.env.MARKET_RESEARCH_WINDOW_DAYS;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 14;
}

// Converte a linha do Prisma em MarketOpportunityRecord (Json -> string[]).
function toRecord(row: OpportunityRow): MarketOpportunityRecord {
  return {
    id: row.id,
    segment: row.segment,
    niche: row.niche,
    demandScore: row.demandScore,
    competitionScore: row.competitionScore,
    potentialScore: row.potentialScore,
    rationale: row.rationale,
    titleIdeas: asStringArray(row.titleIdeas),
    angles: asStringArray(row.angles),
    evidence: asStringArray(row.evidence),
    status: row.status,
    generatedByRunId: row.generatedByRunId,
    selectedAt: row.selectedAt,
    usedByEbookId: row.usedByEbookId,
    createdAt: row.createdAt,
    rankedAt: row.rankedAt,
    updatedAt: row.updatedAt,
  };
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

// Exporta o conversor para reuso pelo service (latestOpportunities).
export { toRecord as marketOpportunityRowToRecord };
export type { OpportunityRow };

// Suprime "unused import" do PrismaClient (mantido p/ documentar o tipo do client).
export type MarketPrismaClient = PrismaClient;
