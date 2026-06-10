// CRM / Command Center — tipos, constantes, helpers puros e schemas Zod.
// Fonte UNICA de verdade para API + web + agents. Sem dependencia de Prisma.
//
// Convencoes herdadas do projeto:
//  - Dinheiro SEMPRE Int em centavos BRL.
//  - HealthStatus e DERIVADO de score (statusFromScore) — nunca persistido.
//  - Problem.type e String (codigo da regra) validado por z.enum (extensivel).
//  - riskTier e ESTATICO por kind (ACTION_SPECS no action-catalog) — nunca do LLM.

import { z } from 'zod';

import type { Json } from './types.js';
import { agentNameSchema } from './schemas.js';

// ============================================================
// Tipos / unioes
// ============================================================

/** Os 7 setores de saude operacional. != AgentName (que tem 8, incluindo OPERATIONS). */
export type Sector =
  | 'CONTENT'
  | 'SALES'
  | 'DELIVERY'
  | 'SOCIAL'
  | 'TRAFFIC'
  | 'ANALYTICS'
  | 'ORCHESTRATION';

/**
 * Setores cobertos pelo framework de TIMES (Specialist/Strategist/Executor):
 * os 7 de saude + os 2 novos (MARKET_RESEARCH/EBOOK_QA). Mais amplo que `Sector`
 * de proposito — os 2 novos NAO entram em SECTOR_WEIGHTS/SECTORS do
 * health-collector (decisao SECTORS-TEAMS.md §6: nao quebrar o scoring dos 7).
 */
export type TeamSector = Sector | 'MARKET_RESEARCH' | 'EBOOK_QA';

/**
 * Setores OPERAVEIS pelo CRM/COO de producao autonoma: os 7 de saude + os 3
 * novos de producao (MARKETPLACE/FUNNEL/AFFILIATE). Usado por Problem.sector e
 * RemediationProposal.sector quando o problema/acao pertence a um setor novo.
 *
 * DECISAO (mesma de TeamSector, ver §6 SECTORS-TEAMS): os 3 novos NAO entram em
 * `Sector`/`SECTORS`/`SECTOR_WEIGHTS` — esses 3 arrays dirigem o LOOP de scoring
 * dos 7 setores no health-collector (e o teste exige EXATAMENTE 7 snapshots).
 * Adiciona-los ali quebraria o health-collector e seus testes (REGRA SUPREMA).
 * O Prisma enum OperationalSector JA contem os 10 (aditivo/seguro).
 */
export type CrmSector = Sector | 'MARKETPLACE' | 'FUNNEL' | 'AFFILIATE';

/** Status de saude derivado do score (nunca persistido). */
export type SectorStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL';

/** Tier de risco da acao (TIERED autonomy). */
export type RiskTier = 'LOW' | 'HIGH';

/** Ciclo de vida de um Problem. */
export type ProblemStatus =
  | 'OPEN'
  | 'DIAGNOSING'
  | 'REMEDIATING'
  | 'RESOLVED'
  | 'IGNORED';

/** Ciclo de vida de uma RemediationAction. */
export type ActionStatus =
  | 'PROPOSED'
  | 'QUEUED'
  | 'APPROVED'
  | 'REJECTED'
  | 'APPLIED'
  | 'FAILED'
  | 'ROLLED_BACK';

/** Quem disparou a execucao. */
export type ExecutionTrigger = 'AUTO' | 'HUMAN';

/** Catalogo fechado de acoes tipadas de remediacao. */
export type ActionKind =
  | 'RETRY_DELIVERIES'
  | 'GENERATE_EBOOK'
  | 'GENERATE_SOCIAL_POSTS'
  | 'REGENERATE_LANDING_COPY'
  | 'RECOMPUTE_KPIS'
  | 'RERUN_AGENT'
  | 'INCREASE_AD_BUDGET'
  | 'DECREASE_AD_BUDGET'
  | 'PAUSE_CAMPAIGN'
  | 'ADJUST_PRICE'
  // producao autonoma — marketplace / afiliados
  | 'GENERATE_MORE_EBOOKS'
  | 'PAUSE_LISTING'
  | 'BOOST_AFFILIATE_OUTREACH'
  | 'SEND_AFFILIATE_EMAIL';

/** Codigos de ProblemType conhecidos (validados; Problem.type fica String no DB). */
export type ProblemType =
  // DELIVERY
  | 'DELIVERY_BACKLOG'
  | 'DELIVERY_FAILURES'
  | 'EMAIL_PROVIDER_DOWN'
  // SALES
  | 'LOW_CONVERSION'
  | 'PRICE_TOO_HIGH'
  | 'CHECKOUT_DROPOFF'
  // TRAFFIC
  | 'NEGATIVE_ROAS'
  | 'CAC_ABOVE_AOV'
  | 'BUDGET_EXHAUSTED'
  | 'NO_ACTIVE_CAMPAIGNS'
  // CONTENT
  | 'EMPTY_CATALOG'
  | 'STALE_CATALOG'
  | 'EBOOK_GENERATION_FAILING'
  // SOCIAL
  | 'NO_RECENT_POSTS'
  | 'SOCIAL_PUBLISH_FAILURES'
  | 'LOW_ENGAGEMENT'
  // ANALYTICS
  | 'KPI_STALE'
  | 'INSIGHTS_NOT_INGESTED'
  // ORCHESTRATION
  | 'AGENT_REPEATEDLY_FAILING'
  | 'CYCLE_NOT_RUNNING'
  | 'REVENUE_BELOW_TARGET'
  // MARKETPLACE
  | 'DEAD_LISTING'
  | 'MISSING_COVER'
  // FUNNEL
  | 'LANDING_DROPOFF'
  | 'HIGH_CART_ABANDONMENT'
  // AFFILIATE
  | 'NO_AFFILIATE_ACTIVITY'
  | 'AFFILIATE_REVENUE_ZERO';

/** Motivos de bloqueio por guardrail no executor. */
export type GuardrailBlock =
  | 'KILL_SWITCH'
  | 'MAX_AUTO'
  | 'COOLDOWN'
  | 'BUDGET_CAP'
  | 'NOT_APPROVED';

// ------------------------------------------------------------
// Estruturas de dominio do CRM
// ------------------------------------------------------------

export interface SectorHealth {
  /**
   * Setor OPERAVEL (CrmSector = 7 de saude + 3 de producao). O loop do COO agora
   * coleta/diagnostica/remedia os 10. `Sector` (7) continua sendo o subconjunto
   * que dirige SECTOR_WEIGHTS/weightedScore — os 3 novos usam scoring local.
   */
  sector: CrmSector;
  /** 0-100. */
  score: number;
  /** Derivado de score (statusFromScore). */
  status: SectorStatus;
  /** KPIs numericos + subscores + hasSignal + gatilhos disparados. */
  kpis: Json;
}

export interface Diagnosis {
  sector: CrmSector;
  /** ProblemType (validado por problemTypeSchema). */
  type: string;
  /** 0-100 (= 100 - score na deteccao). */
  severity: number;
  status: 'OPEN' | 'DIAGNOSING' | 'REMEDIATING';
  /** Causa raiz em pt-BR. */
  rootCause: string;
  /** 0-1. */
  confidence: number;
  evidence: string[];
  suggestedActionKinds: ActionKind[];
  source: 'RULES' | 'LLM';
}

export interface RemediationProposal {
  kind: ActionKind;
  /** Estatico do catalogo, NUNCA do LLM. */
  riskTier: RiskTier;
  sector: CrmSector;
  params: Json;
  expectedEffect: string;
  reversible: boolean;
}

export interface ExecutionResult {
  success: boolean;
  beforeState: Json;
  afterState: Json;
  error?: string;
  blockedByGuardrail?: GuardrailBlock;
}

export interface Guardrails {
  killSwitch: boolean;
  maxAutoActionsPerCycle: number;
  cooldownMinutes: number;
  /** Override opcional de MAX_AD_BUDGET_BRL*100. */
  maxAdBudgetCents?: number | null;
}

// ============================================================
// Constantes de saude — fonte unica para API + web + agents
// ============================================================

/** Cortes de status. Fonte unica. */
export const HEALTH_THRESHOLDS = {
  HEALTHY_MIN: 70,
  WARNING_MIN: 40,
} as const;

/** Subscore retornado quando o setor nao tem volume para julgar (hasSignal=false). */
export const NEUTRAL_SUBSCORE = 60;

/** Pesos por subscore de cada setor (heuristica inicial — calibravel num lugar so). */
export const SECTOR_WEIGHTS: Record<Sector, Record<string, number>> = {
  CONTENT: { pipeline: 0.5, stuck: 0.2, op: 0.3 },
  SALES: { conversion: 0.45, catalogo: 0.25, abandono: 0.3 },
  DELIVERY: { backlog: 0.6, op: 0.4 },
  SOCIAL: { cadence: 0.45, reliability: 0.35, engagement: 0.2 },
  TRAFFIC: { roas: 0.55, budgetDiscipline: 0.2, activity: 0.25 },
  ANALYTICS: { frescor: 0.4, op: 0.25, dataIntegrity: 0.15, metaProgress: 0.2 },
  ORCHESTRATION: { heartbeat: 0.4, cycleSuccess: 0.35, childHealth: 0.25 },
};

/** Lista canonica dos 7 setores (ordem estavel p/ iteracao). */
export const SECTORS: readonly Sector[] = [
  'CONTENT',
  'SALES',
  'DELIVERY',
  'SOCIAL',
  'TRAFFIC',
  'ANALYTICS',
  'ORCHESTRATION',
] as const;

/** Lista canonica dos 9 setores dos TIMES (7 de saude + MARKET_RESEARCH + EBOOK_QA). */
export const TEAM_SECTORS: readonly TeamSector[] = [
  ...SECTORS,
  'MARKET_RESEARCH',
  'EBOOK_QA',
] as const;

/** Os 3 setores NOVOS de producao autonoma (operaveis pelo CRM, fora do scoring dos 7). */
export const CRM_NEW_SECTORS = ['MARKETPLACE', 'FUNNEL', 'AFFILIATE'] as const;

/** Lista canonica dos 10 setores OPERAVEIS pelo CRM (7 de saude + 3 de producao). */
export const CRM_SECTORS: readonly CrmSector[] = [
  ...SECTORS,
  ...CRM_NEW_SECTORS,
] as const;

/**
 * Pesos AGREGADOS de importancia por setor de producao (0..100, somam 100).
 * NB: distinto de SECTOR_WEIGHTS (que sao pesos de SUBSCORE internos de cada um
 * dos 7 setores de saude, nao um mapa global). Aqui ficam os pesos relativos dos
 * 10 setores operaveis para priorizacao do COO de producao. Soma = 100.
 *   originais 7 reescalados (de 100 p/ 70): CONTENT 16, SALES 16, DELIVERY 9,
 *   SOCIAL 9, TRAFFIC 9, ANALYTICS 6, ORCHESTRATION 5 -> 70
 *   novos 3: MARKETPLACE 12, FUNNEL 10, AFFILIATE 8 -> 30
 */
export const PRODUCTION_SECTOR_WEIGHTS: Record<CrmSector, number> = {
  CONTENT: 16,
  SALES: 16,
  DELIVERY: 9,
  SOCIAL: 9,
  TRAFFIC: 9,
  ANALYTICS: 6,
  ORCHESTRATION: 5,
  MARKETPLACE: 12,
  FUNNEL: 10,
  AFFILIATE: 8,
};

// ============================================================
// Helpers puros
// ============================================================

/** Deriva o status de saude a partir do score. Fonte unica (nunca persistido). */
export function statusFromScore(score: number): SectorStatus {
  if (score >= HEALTH_THRESHOLDS.HEALTHY_MIN) return 'HEALTHY';
  if (score >= HEALTH_THRESHOLDS.WARNING_MIN) return 'WARNING';
  return 'CRITICAL';
}

/**
 * Canonicaliza params de uma acao de forma DETERMINISTICA para gerar dedupeKey.
 * Ordena chaves recursivamente; arredonda valores de centavos para Int.
 * Params com ordem instavel NAO podem gerar dedupeKeys divergentes.
 */
export function canonicalizeParams(params: Json): string {
  const canon = (value: Json): Json => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canon);
    const out: Record<string, Json> = {};
    const obj = value as Record<string, Json>;
    for (const key of Object.keys(obj).sort()) {
      let v: Json = obj[key] ?? null;
      // Campos de centavos: arredonda para Int para nao divergir por float.
      if (typeof v === 'number' && /Cents$/.test(key)) v = Math.round(v);
      out[key] = canon(v);
    }
    return out;
  };
  return JSON.stringify(canon(params));
}

/**
 * Chave de dedupe de uma RemediationAction = hash do (problemId+kind+paramsCanon).
 * Determinismo garantido por canonicalizeParams. Hash estavel (djb2) sem dep externa.
 */
export function buildDedupeKey(
  problemId: string,
  kind: ActionKind,
  params: Json,
): string {
  const seed = `${problemId}|${kind}|${canonicalizeParams(params)}`;
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  return `${problemId}:${kind}:${h.toString(36)}`;
}

// ============================================================
// Schemas Zod (z.enum espelhando as unioes acima)
// ============================================================

export const sectorSchema = z.enum([
  'CONTENT',
  'SALES',
  'DELIVERY',
  'SOCIAL',
  'TRAFFIC',
  'ANALYTICS',
  'ORCHESTRATION',
]);

/** Os 9 setores dos times (espelha TeamSector). Usado por rotas/web dos times. */
export const teamSectorSchema = z.enum([
  'CONTENT',
  'SALES',
  'DELIVERY',
  'SOCIAL',
  'TRAFFIC',
  'ANALYTICS',
  'ORCHESTRATION',
  'MARKET_RESEARCH',
  'EBOOK_QA',
]);

/** Os 10 setores operaveis pelo CRM (espelha CrmSector). Usado por Problem/Action novos. */
export const crmSectorSchema = z.enum([
  'CONTENT',
  'SALES',
  'DELIVERY',
  'SOCIAL',
  'TRAFFIC',
  'ANALYTICS',
  'ORCHESTRATION',
  'MARKETPLACE',
  'FUNNEL',
  'AFFILIATE',
]);

export const sectorStatusSchema = z.enum(['HEALTHY', 'WARNING', 'CRITICAL']);
export const riskTierSchema = z.enum(['LOW', 'HIGH']);
export const problemStatusSchema = z.enum([
  'OPEN',
  'DIAGNOSING',
  'REMEDIATING',
  'RESOLVED',
  'IGNORED',
]);
export const actionStatusSchema = z.enum([
  'PROPOSED',
  'QUEUED',
  'APPROVED',
  'REJECTED',
  'APPLIED',
  'FAILED',
  'ROLLED_BACK',
]);
export const executionTriggerSchema = z.enum(['AUTO', 'HUMAN']);

export const actionKindSchema = z.enum([
  'RETRY_DELIVERIES',
  'GENERATE_EBOOK',
  'GENERATE_SOCIAL_POSTS',
  'REGENERATE_LANDING_COPY',
  'RECOMPUTE_KPIS',
  'RERUN_AGENT',
  'INCREASE_AD_BUDGET',
  'DECREASE_AD_BUDGET',
  'PAUSE_CAMPAIGN',
  'ADJUST_PRICE',
  'GENERATE_MORE_EBOOKS',
  'PAUSE_LISTING',
  'BOOST_AFFILIATE_OUTREACH',
  'SEND_AFFILIATE_EMAIL',
]);

export const problemTypeSchema = z.enum([
  'DELIVERY_BACKLOG',
  'DELIVERY_FAILURES',
  'EMAIL_PROVIDER_DOWN',
  'LOW_CONVERSION',
  'PRICE_TOO_HIGH',
  'CHECKOUT_DROPOFF',
  'NEGATIVE_ROAS',
  'CAC_ABOVE_AOV',
  'BUDGET_EXHAUSTED',
  'NO_ACTIVE_CAMPAIGNS',
  'EMPTY_CATALOG',
  'STALE_CATALOG',
  'EBOOK_GENERATION_FAILING',
  'NO_RECENT_POSTS',
  'SOCIAL_PUBLISH_FAILURES',
  'LOW_ENGAGEMENT',
  'KPI_STALE',
  'INSIGHTS_NOT_INGESTED',
  'AGENT_REPEATEDLY_FAILING',
  'CYCLE_NOT_RUNNING',
  'REVENUE_BELOW_TARGET',
  'DEAD_LISTING',
  'MISSING_COVER',
  'LANDING_DROPOFF',
  'HIGH_CART_ABANDONMENT',
  'NO_AFFILIATE_ACTIVITY',
  'AFFILIATE_REVENUE_ZERO',
]);

// ------------------------------------------------------------
// SectorHealth / Diagnosis (saidas validaveis — inclusive output do LLM)
// ------------------------------------------------------------
const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(jsonSchema),
  ]),
);

export const sectorHealthSchema = z.object({
  // crmSectorSchema (10): o loop do COO cobre os 7 de saude + 3 de producao.
  sector: crmSectorSchema,
  score: z.number().int().min(0).max(100),
  status: sectorStatusSchema,
  kpis: jsonSchema,
});

export const diagnosisSchema = z.object({
  sector: crmSectorSchema,
  type: problemTypeSchema,
  severity: z.number().int().min(0).max(100),
  status: z.enum(['OPEN', 'DIAGNOSING', 'REMEDIATING']),
  rootCause: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  suggestedActionKinds: z.array(actionKindSchema),
  source: z.enum(['RULES', 'LLM']),
});

// ============================================================
// Params tipados por kind (discriminated union)
// Teto financeiro validado em TRIPLA camada: catalogo + executor + rota /approve.
// ============================================================
const campaignIdSchema = z.string().min(1);
const productIdSchema = z.string().min(1);

export const remediationParamsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('RETRY_DELIVERIES'),
    orderIds: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  z.object({
    kind: z.literal('GENERATE_EBOOK'),
    niche: z.string().min(2).max(120),
    count: z.number().int().min(1).max(5).optional(),
  }),
  z.object({
    kind: z.literal('GENERATE_SOCIAL_POSTS'),
    productId: productIdSchema.optional(),
    count: z.number().int().min(1).max(10).optional(),
  }),
  z.object({
    kind: z.literal('REGENERATE_LANDING_COPY'),
    productId: productIdSchema,
  }),
  z.object({
    kind: z.literal('RECOMPUTE_KPIS'),
    date: z.string().optional(), // YYYY-MM-DD
  }),
  z.object({
    kind: z.literal('RERUN_AGENT'),
    agent: agentNameSchema,
  }),
  z.object({
    kind: z.literal('INCREASE_AD_BUDGET'),
    campaignId: campaignIdSchema,
    newDailyBudgetCents: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('DECREASE_AD_BUDGET'),
    campaignId: campaignIdSchema,
    newDailyBudgetCents: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('PAUSE_CAMPAIGN'),
    campaignId: campaignIdSchema,
  }),
  z.object({
    kind: z.literal('ADJUST_PRICE'),
    productId: productIdSchema,
    // Guardrail de catalogo: preco > 0 e >= R$10,00 (1000 centavos).
    newPriceCents: z.number().int().min(1000),
  }),
  // --- producao autonoma — marketplace / afiliados ---
  z.object({
    kind: z.literal('GENERATE_MORE_EBOOKS'),
    niche: z.string().min(2).max(120).optional(),
    count: z.number().int().min(1).max(10).optional(),
  }),
  z.object({
    kind: z.literal('PAUSE_LISTING'),
    productId: productIdSchema,
    provider: z.string().min(1),
  }),
  z.object({
    kind: z.literal('BOOST_AFFILIATE_OUTREACH'),
    ebookId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal('SEND_AFFILIATE_EMAIL'),
    affiliateId: z.string().min(1),
    templateKey: z.string().min(1),
  }),
]);
export type RemediationParams = z.infer<typeof remediationParamsSchema>;

// ============================================================
// Schemas de bodies das rotas /crm
// ============================================================

export const guardrailConfigSchema = z.object({
  id: z.string().default('singleton'),
  killSwitch: z.boolean(),
  maxAutoActionsPerCycle: z.number().int().min(0),
  cooldownMinutes: z.number().int().min(0),
  maxAdBudgetCents: z.number().int().positive().nullable().optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});
export type GuardrailConfigInput = z.infer<typeof guardrailConfigSchema>;

/** PUT /crm/guardrails — patch parcial. */
export const updateGuardrailsBodySchema = z
  .object({
    maxAutoActionsPerCycle: z.number().int().min(0).max(100).optional(),
    cooldownMinutes: z.number().int().min(0).max(1440).optional(),
    maxAdBudgetCents: z.number().int().positive().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: 'Informe ao menos um campo para atualizar.',
  });
export type UpdateGuardrailsBody = z.infer<typeof updateGuardrailsBodySchema>;

/** POST /crm/killswitch. */
export const setKillSwitchBodySchema = z.object({
  enabled: z.boolean(),
});
export type SetKillSwitchBody = z.infer<typeof setKillSwitchBodySchema>;

/** POST /crm/scan. */
export const scanBodySchema = z
  .object({
    sector: sectorSchema.optional(),
  })
  .default({});
export type ScanBody = z.infer<typeof scanBodySchema>;

/** POST /crm/actions/:id/reject. */
export const rejectActionBodySchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .default({});
export type RejectActionBody = z.infer<typeof rejectActionBodySchema>;

// --- Querystrings de listagem ---
export const listProblemsQuerySchema = z.object({
  status: problemStatusSchema.optional(),
  sector: sectorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListProblemsQuery = z.infer<typeof listProblemsQuerySchema>;

export const listActionsQuerySchema = z.object({
  status: actionStatusSchema.optional(),
  riskTier: riskTierSchema.optional(),
  problemId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListActionsQuery = z.infer<typeof listActionsQuerySchema>;

export const sectorParamsSchema = z.object({
  sector: sectorSchema,
});
export type SectorParams = z.infer<typeof sectorParamsSchema>;

export const sectorHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(30),
  since: z.string().datetime().optional(),
});
export type SectorHistoryQuery = z.infer<typeof sectorHistoryQuerySchema>;

export const crmIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type CrmIdParams = z.infer<typeof crmIdParamsSchema>;
