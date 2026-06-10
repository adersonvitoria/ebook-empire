// Framework de TIMES por setor — contratos de dominio (Specialist / Strategist /
// Executor). Fonte UNICA de verdade para API + web + agents. Sem dependencia de
// Prisma. Espelha o estilo de KPISnapshot/AgentPlan.
//
// Convencoes herdadas do projeto:
//  - Dinheiro SEMPRE Int em centavos BRL (scores aqui sao 0..100, NAO centavos).
//  - Strings de usuario em pt-BR.
//  - Assessment/Strategy sao SAIDAS de LLM => ganham Zod em schemas.ts; um JSON
//    malformado do opus NUNCA derruba o time (cai no fallback deterministico).

import type { Json } from './types.js';
import type { TeamSector, SectorStatus } from './crm.js';
import type { EbookAudit } from './quality.js';

// ------------------------------------------------------------
// Papel dentro de um time de setor (espelha o enum Role do Prisma).
// ------------------------------------------------------------
export type Role = 'SPECIALIST' | 'STRATEGIST' | 'EXECUTOR';

// ------------------------------------------------------------
// Assessment (saida do Specialist) — diagnostico tecnico do setor.
// ------------------------------------------------------------
export interface Assessment {
  sector: TeamSector; // Sector estendido (9 valores — ver core/crm.ts)
  /** 0..100 (reusa o score do SectorHealth). */
  healthScore: number;
  /** Derivado de score (statusFromScore). */
  status: SectorStatus;
  /** Diagnostico tecnico (pt-BR). */
  findings: string[];
  risks: string[];
  opportunities: string[];
  /** KPIs/subscores/sinais brutos usados. */
  evidence: Json;
  /** 0..1. */
  confidence: number;
  /** RULES = fallback deterministico (LLM ausente/falhou). */
  source: 'RULES' | 'LLM';
}

// ------------------------------------------------------------
// Strategy (saida do Strategist) — plano priorizado rumo a meta.
// ------------------------------------------------------------
export interface StrategyAction {
  /** Chave do binding (cfg.executorBindings). */
  capability: string;
  /** 0..100. */
  priority: number;
  params: Json;
  reason: string;
}

export interface Strategy {
  sector: TeamSector;
  /** Alinhado a TARGET_DAILY_REVENUE_BRL. */
  objective: string;
  /** Mesma regra de computeGuardrails (metTarget ? SUSTAIN : GROW). */
  mode: 'GROW' | 'SUSTAIN';
  actions: StrategyAction[];
  successCriteria: string[];
  rationale: string;
}

// ------------------------------------------------------------
// ExecutionOutcome (saida do Executor) — desfecho das acoes acionadas.
// ------------------------------------------------------------
export interface ExecutedAction {
  capability: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  /** Id do AgentRun do Agent acionado (binding AGENT). */
  agentRunId?: string;
  error?: string;
}

export interface ExecutionOutcome {
  sector: TeamSector;
  executed: ExecutedAction[];
  succeeded: number;
  failed: number;
  skipped: number;
  summary: string;
}

// ------------------------------------------------------------
// Resultado completo de um ciclo de time (assess -> strategize -> execute).
// ------------------------------------------------------------
export interface TeamRunResult {
  sector: TeamSector;
  assessment: Assessment;
  strategy: Strategy;
  outcome: ExecutionOutcome;
}

// ------------------------------------------------------------
// Re-exporta o contrato de QA por coesao (o doc EBOOK-QA.md permite QA em
// core/team.ts OU core/quality.ts; mantemos em quality.ts e reexportamos aqui).
// ------------------------------------------------------------
export type { EbookAudit };
