// MARKET_RESEARCH — SERVICE (coordenador do time).
// Orquestra o ciclo do time: SPECIALIST (coleta sinais + assess) -> STRATEGIST
// (rankeia -> MarketOpportunity[] + strategy) -> EXECUTOR (persiste + seleciona).
// Cada papel grava um AgentRun com role+sector (runRole de team/roles.ts) para
// observabilidade dos times. Devolve a oportunidade de MAIOR potencial.
//
// Implementa MarketResearchCapability (launch/launch-pipeline.ts) — GATE 1:
//   rankAndPick(ctx) -> MarketOpportunityRecord | null.
// Expoe tambem latestOpportunities(ctx) para a rota GET /market/opportunities.
//
// Tolerancia a falha: o LLM e sempre opcional (fallback deterministico). Sem
// MarketDataPort em ctx.ports, o specialist lanca claro (pt-BR) — o gate aborta.
//
// Convencoes: scores 0..100 (NAO centavos). Strings de usuario em pt-BR.

import type {
  Assessment,
  Json,
  MarketOpportunity,
  MarketOpportunityRecord,
  Strategy,
  TeamRunResult,
} from '@ebook-empire/core';
import type { AgentContext } from '../../base.js';
import { runRole } from '../../team/roles.js';
import {
  MarketSpecialist,
  type NicheCandidate,
  type NicheSignal,
} from './specialist.js';
import { MarketStrategist } from './strategist.js';
import { MarketExecutor, marketOpportunityRowToRecord } from './executor.js';

// Linha do Prisma para latestOpportunities (mesmo shape do executor).
interface OpportunityRowLite {
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
  status: 'PENDING' | 'SELECTED' | 'USED' | 'DISCARDED';
  generatedByRunId: string | null;
  selectedAt: Date | null;
  usedByEbookId: string | null;
  createdAt: Date;
  rankedAt: Date;
  updatedAt: Date;
}

export class MarketResearchService {
  private readonly specialist: MarketSpecialist;
  private readonly strategist: MarketStrategist;
  private readonly executor: MarketExecutor;

  constructor(opts?: { candidates?: readonly NicheCandidate[] }) {
    this.specialist = new MarketSpecialist(opts?.candidates);
    this.strategist = new MarketStrategist();
    this.executor = new MarketExecutor();
  }

  /**
   * Roda o time completo e retorna o resultado estruturado (assessment/strategy/
   * outcome) + as oportunidades persistidas. Usado por rankAndPick e pela rota
   * POST /market/scan.
   */
  async runTeam(ctx: AgentContext): Promise<{
    team: TeamRunResult;
    opportunities: MarketOpportunityRecord[];
  }> {
    // --- SPECIALIST: coleta sinais + assessment ---
    const specialistRun = await runRole<{
      signals: NicheSignal[];
      assessment: Assessment;
    }>(ctx, {
      role: 'SPECIALIST',
      sector: 'MARKET_RESEARCH',
      agentName: 'MARKET_RESEARCH',
      work: async () => {
        const signals = await this.specialist.collectSignals(ctx);
        const assessment = await this.specialist.assess(ctx, signals);
        return {
          data: { signals, assessment },
          output: assessment as unknown as Json,
          metrics: { nichesScanned: signals.length } as Json,
        };
      },
    });
    const { signals, assessment } = specialistRun.data;

    // --- STRATEGIST: rankeia -> MarketOpportunity[] + strategy ---
    const strategistRun = await runRole<{
      opportunities: MarketOpportunity[];
      strategy: Strategy;
    }>(ctx, {
      role: 'STRATEGIST',
      sector: 'MARKET_RESEARCH',
      agentName: 'MARKET_RESEARCH',
      work: async () => {
        const ranked = await this.strategist.rank(ctx, signals);
        const strategy = this.strategist.buildStrategy(ctx, ranked.opportunities);
        return {
          data: { opportunities: ranked.opportunities, strategy },
          output: strategy as unknown as Json,
          metrics: { ranked: ranked.opportunities.length } as Json,
          tokensIn: ranked.tokensIn,
          tokensOut: ranked.tokensOut,
          costCents: ranked.costCents,
        };
      },
    });
    const { opportunities, strategy } = strategistRun.data;

    // --- EXECUTOR: persiste + seleciona o topo ---
    const executorRun = await runRole<MarketOpportunityRecord[]>(ctx, {
      role: 'EXECUTOR',
      sector: 'MARKET_RESEARCH',
      agentName: 'MARKET_RESEARCH',
      work: async () => {
        const records = await this.executor.persist(ctx, opportunities);
        return {
          data: records,
          output: { persisted: records.length, topId: records[0]?.id ?? null } as Json,
          metrics: { persisted: records.length } as Json,
        };
      },
    });
    const records = executorRun.data;

    const outcome: TeamRunResult['outcome'] = {
      sector: 'MARKET_RESEARCH',
      executed: [
        {
          capability: 'persistOpportunities',
          status: records.length > 0 ? 'SUCCESS' : 'SKIPPED',
          agentRunId: executorRun.runId,
        },
      ],
      succeeded: records.length > 0 ? 1 : 0,
      failed: 0,
      skipped: records.length > 0 ? 0 : 1,
      summary:
        records.length > 0
          ? `Persistidas ${records.length} oportunidades; topo "${records[0]!.niche}".`
          : 'Nenhuma oportunidade encontrada nesta rodada.',
    };

    const team: TeamRunResult = {
      sector: 'MARKET_RESEARCH',
      assessment,
      strategy,
      outcome,
    };
    return { team, opportunities: records };
  }

  /**
   * GATE 1: rankeia e SELECIONA a oportunidade de maior potencial (ja marcada
   * SELECTED pelo executor). Retorna a oportunidade topo, ou null se nenhuma foi
   * encontrada (dispara o GATE 1 -> aborta o lancamento no pipeline).
   */
  async rankAndPick(ctx: AgentContext): Promise<MarketOpportunityRecord | null> {
    const { opportunities } = await this.runTeam(ctx);
    return opportunities[0] ?? null;
  }

  /**
   * Ultimas oportunidades persistidas (para a rota GET /market/opportunities),
   * ordenadas por potentialScore desc dentro do lote mais recente por rankedAt.
   */
  async latestOpportunities(
    ctx: AgentContext,
    opts?: { limit?: number; status?: 'PENDING' | 'SELECTED' | 'USED' | 'DISCARDED' },
  ): Promise<MarketOpportunityRecord[]> {
    const limit = opts?.limit ?? 50;
    const rows = (await ctx.prisma.marketOpportunity.findMany({
      where: opts?.status ? { status: opts.status } : undefined,
      orderBy: [{ rankedAt: 'desc' }, { potentialScore: 'desc' }],
      take: limit,
    })) as OpportunityRowLite[];
    return rows.map((r) => marketOpportunityRowToRecord(r));
  }

  /** A oportunidade de maior potencial ja SELECIONADA (GET /market/top). */
  async topOpportunity(ctx: AgentContext): Promise<MarketOpportunityRecord | null> {
    const row = (await ctx.prisma.marketOpportunity.findFirst({
      where: { status: 'SELECTED' },
      orderBy: [{ rankedAt: 'desc' }, { potentialScore: 'desc' }],
    })) as OpportunityRowLite | null;
    return row ? marketOpportunityRowToRecord(row) : null;
  }
}

/** Factory (mesmo padrao dos adapters). O launch-pipeline aceita ambos. */
export function createMarketResearchService(opts?: {
  candidates?: readonly NicheCandidate[];
}): MarketResearchService {
  return new MarketResearchService(opts);
}
