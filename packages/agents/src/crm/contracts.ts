// CRM / Command Center — CONTRATOS DE INTERFACE (dono: Fundacao).
// Todos os implementadores (health-collector, diagnosis, action-catalog,
// executor, operations-agent) dependem SOMENTE deste arquivo. DI por construtor.
//
// Os tipos de dominio (Sector, Diagnosis, RemediationProposal, ExecutionResult,
// ActionKind, RiskTier, ...) sao reexportados de @ebook-empire/core (crm.ts) —
// fonte unica de verdade. Aqui ficam apenas as 4 INTERFACES + os REFs (formato
// de linha do banco que as interfaces recebem/retornam).

import type { AgentContext } from '../base.js';
import type {
  CrmSector,
  RiskTier,
  ActionKind,
  ProblemStatus,
  ActionStatus,
  ExecutionTrigger,
  SectorHealth,
  Diagnosis,
  RemediationProposal,
  ExecutionResult,
  Json,
} from '@ebook-empire/core';

// Reexporta os tipos de dominio do core para os implementadores importarem
// tudo de um lugar so (`from './contracts.js'`), mantendo o core como fonte.
export type {
  Sector,
  CrmSector,
  SectorStatus,
  RiskTier,
  ActionKind,
  ProblemStatus,
  ActionStatus,
  ExecutionTrigger,
  SectorHealth,
  Diagnosis,
  RemediationProposal,
  ExecutionResult,
} from '@ebook-empire/core';

// ============================================================
// REFs — formato minimo de linha do banco que as interfaces manipulam.
// Espelham os modelos Prisma (Sem acoplar a @prisma/client p/ manter o pacote
// agents desacoplado do client gerado). Campos opcionais quando nullable no DB.
// ============================================================

/** Linha de Problem (subconjunto usado pelo ActionCatalog/COO). */
export interface ProblemRef {
  id: string;
  sector: CrmSector;
  /** Codigo da regra (ProblemType validado por z.enum em core). */
  type: string;
  severity: number;
  status: ProblemStatus;
  rootCause?: string | null;
  snapshotId?: string | null;
  detectedAt: Date;
  resolvedAt?: Date | null;
  metadata?: Json | null;
}

/** Linha de RemediationAction (entrada do ActionExecutor.apply). */
export interface RemediationActionRef {
  id: string;
  problemId: string;
  kind: ActionKind;
  riskTier: RiskTier;
  params: Json;
  expectedEffect: string;
  status: ActionStatus;
  reversible: boolean;
  dedupeKey: string;
  appliedAt?: Date | null;
}

/** Linha de ActionExecution (entrada do ActionExecutor.rollback). */
export interface ActionExecutionRef {
  id: string;
  actionId: string;
  success: boolean;
  beforeState?: Json | null;
  afterState?: Json | null;
  error?: string | null;
  triggeredBy: ExecutionTrigger;
  isRollback: boolean;
  startedAt: Date;
  finishedAt?: Date | null;
}

// ============================================================
// As 4 INTERFACES (assinaturas conforme CONTRATO DE INTERFACES do doc).
// O OperationsAgent recebe instancias concretas destas por construtor;
// a composicao concreta (createOperationsAgent) vive no scheduler.ts.
// ============================================================

/** Coleta a saude dos 10 setores operaveis (7 de saude + 3 de producao). */
export interface HealthCollector {
  collect(ctx: AgentContext): Promise<SectorHealth[]>;
}

/** Diagnostica a causa raiz de um setor (regras + enriquecimento LLM). */
export interface DiagnosisEngine {
  diagnose(
    ctx: AgentContext,
    sector: CrmSector,
    health: SectorHealth,
  ): Promise<Diagnosis>;
}

/** Propoe remediacoes tipadas para um Problem/Diagnosis. riskTier estatico. */
export interface ActionCatalog {
  propose(
    ctx: AgentContext,
    problem: ProblemRef,
    diagnosis: Diagnosis,
  ): RemediationProposal[];
}

/** Aplica/reverte acoes no sistema com guardrails + auditoria. */
export interface ActionExecutor {
  apply(
    ctx: AgentContext,
    action: RemediationActionRef,
  ): Promise<ExecutionResult>;
  rollback(
    ctx: AgentContext,
    execution: ActionExecutionRef,
  ): Promise<ExecutionResult>;
}
