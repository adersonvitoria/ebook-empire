// Setor MARKET_RESEARCH — contratos de dominio (oportunidade de mercado + scores).
// Fonte UNICA de verdade para API + web + agents. Sem dependencia de Prisma.
//
// IMPORTANTE: os scores sao 0..100, NAO centavos — nunca use formatBRL neles.
// O shape do provedor externo (Serper) NAO vaza para ca: o MarketDataPort
// (ports.ts) e fino e agnostico de provedor. Strings de usuario em pt-BR.

// ------------------------------------------------------------
// Estado de uma oportunidade (espelha o enum MarketOpportunityStatus do Prisma).
// ------------------------------------------------------------
export type MarketOpportunityStatus = 'PENDING' | 'SELECTED' | 'USED' | 'DISCARDED';

// ------------------------------------------------------------
// MarketOpportunity (DTO de dominio — saida rankeada do time MARKET_RESEARCH).
// ------------------------------------------------------------
export interface MarketOpportunity {
  /** Macro (ex. "Financas Pessoais"). */
  segment: string;
  /** Especifico (ex. "Investir do zero"). */
  niche: string;
  /** 0..100. */
  demandScore: number;
  /** 0..100 (MAIOR = pior). */
  competitionScore: number;
  /** 0..100 (chave de ordenacao). */
  potentialScore: number;
  /** pt-BR: por que tem potencial (cita sinais). */
  rationale: string;
  titleIdeas: string[];
  angles: string[];
  /** PAA/relatedSearches/sinais internos usados. */
  evidence: string[];
}

/** MarketOpportunity ja persistida (com identidade + estado). */
export interface MarketOpportunityRecord extends MarketOpportunity {
  id: string;
  status: MarketOpportunityStatus;
  generatedByRunId?: string | null;
  selectedAt?: Date | null;
  usedByEbookId?: string | null;
  createdAt: Date;
  rankedAt: Date;
  updatedAt: Date;
}
