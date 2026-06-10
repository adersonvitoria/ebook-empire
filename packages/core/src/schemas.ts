// Schemas Zod — validacao de input/output de rotas e agentes.
// Espelham os tipos de types.ts. Use estes schemas nas rotas Fastify
// (body/query) e nos agentes (saida do LLM via generateJson).

import { z } from 'zod';

// ------------------------------------------------------------
// Enums (z.enum espelhando os enums do schema/types)
// ------------------------------------------------------------
export const ebookStatusSchema = z.enum([
  'DRAFT',
  'GENERATING',
  'READY',
  'PUBLISHED',
  'ARCHIVED',
]);

export const orderStatusSchema = z.enum([
  'PENDING',
  'AWAITING_PAYMENT',
  'PAID',
  'DELIVERED',
  'REFUNDED',
  'CANCELED',
  'EXPIRED',
]);

export const paymentStatusSchema = z.enum([
  'PENDING',
  'CONFIRMED',
  'RECEIVED',
  'OVERDUE',
  'REFUNDED',
  'FAILED',
]);

export const paymentProviderSchema = z.enum([
  'ASAAS',
  'MERCADO_PAGO',
  'HOTMART',
  'KIWIFY',
]);
export const paymentMethodSchema = z.enum(['PIX', 'BOLETO', 'CREDIT_CARD']);

export const deliveryStatusSchema = z.enum([
  'GRANTED',
  'ACTIVE',
  'EXHAUSTED',
  'EXPIRED',
  'REVOKED',
]);

export const socialStatusSchema = z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'FAILED']);

export const adStatusSchema = z.enum([
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'ARCHIVED',
]);

export const agentRunStatusSchema = z.enum(['RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED']);

export const agentNameSchema = z.enum([
  'ORCHESTRATOR',
  'CONTENT',
  'SALES',
  'DELIVERY',
  'SOCIAL',
  'TRAFFIC',
  'ANALYTICS',
  'OPERATIONS',
  'MARKET_RESEARCH',
  'EBOOK_QA',
  'MARKETPLACE',
  'AFFILIATE',
  'FUNNEL',
]);

export const eventTypeSchema = z.enum([
  'IMPRESSION',
  'CLICK',
  'LANDING_VIEW',
  'CHECKOUT_STARTED',
  'PAYMENT_PENDING',
  'PAID',
  'DELIVERED',
  'REFUNDED',
  'SOCIAL_VIEW',
  'SOCIAL_ENGAGEMENT',
  'EBOOK_PUBLISHED',
  'SOCIAL_POSTED',
  'CAMPAIGN_CREATED',
  'BUDGET_REALLOCATED',
  'AD_SPEND',
  'INSIGHT_INGESTED',
  'MARKET_OPPORTUNITY_RANKED',
  'EBOOK_AUDITED',
  'EBOOK_RELAUNCHED',
  'AFFILIATE_CONTACTED',
  'UPSELL_SENT',
  'UPSELL_CONVERTED',
]);

// ------------------------------------------------------------
// Atribuicao (UTMs)
// ------------------------------------------------------------
export const utmParamsSchema = z.object({
  utmSource: z.string().max(255).optional(),
  utmMedium: z.string().max(255).optional(),
  utmCampaign: z.string().max(255).optional(),
  utmContent: z.string().max(255).optional(),
  utmTerm: z.string().max(255).optional(),
});
export type UtmParamsInput = z.infer<typeof utmParamsSchema>;

// ============================================================
// ROTAS — inputs/outputs
// ============================================================

// --- /auth ---
// Login do painel interno (single-admin). So o password; o backend compara
// com env.ADMIN_PASSWORD em tempo constante e emite um JWT via fastify.jwt.sign.
export const loginBodySchema = z.object({
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

// --- /ebooks ---
export const listEbooksQuerySchema = z.object({
  status: ebookStatusSchema.optional(),
  niche: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListEbooksQuery = z.infer<typeof listEbooksQuerySchema>;

export const ebookSlugParamsSchema = z.object({
  slug: z.string().min(1),
});
export type EbookSlugParams = z.infer<typeof ebookSlugParamsSchema>;

export const generateEbookBodySchema = z.object({
  niche: z.string().min(2).max(120),
  title: z.string().min(2).max(200).optional(),
  language: z.string().default('pt-BR'),
});
export type GenerateEbookBody = z.infer<typeof generateEbookBodySchema>;

// --- /checkout ---
export const checkoutBodySchema = z.object({
  productSlug: z.string().min(1),
  customer: z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    phone: z.string().max(40).optional(),
    cpfCnpj: z.string().max(20).optional(),
  }),
  visitorId: z.string().max(120).optional(),
  utm: utmParamsSchema.optional(),
});
export type CheckoutBody = z.infer<typeof checkoutBodySchema>;

export const checkoutResultSchema = z.object({
  orderId: z.string(),
  status: orderStatusSchema,
  amountCents: z.number().int(),
  currency: z.string(),
  pixQrCode: z.string(),
  pixCopyPaste: z.string(),
  dueDate: z.string(), // ISO
});
export type CheckoutResult = z.infer<typeof checkoutResultSchema>;

// Webhook do provedor de pagamento (payload bruto — validado pelo PaymentPort).
export const paymentWebhookBodySchema = z.record(z.unknown());
export type PaymentWebhookBody = z.infer<typeof paymentWebhookBodySchema>;

// --- /delivery/:token ---
export const deliveryTokenParamsSchema = z.object({
  token: z.string().min(16),
});
export type DeliveryTokenParams = z.infer<typeof deliveryTokenParamsSchema>;

// --- /social ---
export const listSocialPostsQuerySchema = z.object({
  status: socialStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListSocialPostsQuery = z.infer<typeof listSocialPostsQuerySchema>;

export const generateSocialPostBodySchema = z.object({
  productId: z.string().optional(),
  theme: z.string().max(280).optional(),
  scheduledAt: z.string().datetime().optional(),
});
export type GenerateSocialPostBody = z.infer<typeof generateSocialPostBodySchema>;

export const socialPostIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type SocialPostIdParams = z.infer<typeof socialPostIdParamsSchema>;

// Saida estruturada do LLM para gerar um post social.
export const socialPostContentSchema = z.object({
  caption: z.string().min(1).max(2200),
  hashtags: z.array(z.string()).max(30),
  creativePrompt: z.string().min(1),
});
export type SocialPostContent = z.infer<typeof socialPostContentSchema>;

// --- /ads ---
export const adCampaignIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type AdCampaignIdParams = z.infer<typeof adCampaignIdParamsSchema>;

export const optimizeAdsBodySchema = z.object({
  campaignId: z.string().optional(),
  dryRun: z.boolean().default(false),
});
export type OptimizeAdsBody = z.infer<typeof optimizeAdsBodySchema>;

// --- /agents ---
export const listAgentRunsQuerySchema = z.object({
  agent: agentNameSchema.optional(),
  status: agentRunStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAgentRunsQuery = z.infer<typeof listAgentRunsQuerySchema>;

export const runAgentParamsSchema = z.object({
  name: agentNameSchema,
});
export type RunAgentParams = z.infer<typeof runAgentParamsSchema>;

// ============================================================
// AGENTES — saidas estruturadas (validadas via LLMPort.generateJson)
// ============================================================

// Outline de ebook gerado pelo ContentAgent.
export const ebookOutlineSchema = z.object({
  title: z.string().min(1),
  niche: z.string().min(1),
  subtitle: z.string().optional(),
  targetAudience: z.string().optional(),
  chapters: z
    .array(
      z.object({
        title: z.string().min(1),
        summary: z.string().min(1),
      }),
    )
    .min(3),
});
export type EbookOutline = z.infer<typeof ebookOutlineSchema>;

// Plano de acao do Orchestrator (CEO). Validado por Zod antes de executar.
export const agentPlanActionSchema = z.object({
  agent: agentNameSchema,
  priority: z.number().int().min(0).max(100),
  reason: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});
export type AgentPlanAction = z.infer<typeof agentPlanActionSchema>;

export const agentPlanSchema = z.object({
  mode: z.enum(['GROW', 'SUSTAIN']),
  rationale: z.string().min(1),
  actions: z.array(agentPlanActionSchema),
});
export type AgentPlan = z.infer<typeof agentPlanSchema>;

// ------------------------------------------------------------
// KPISnapshot (saida do AnalyticsAgent)
// ------------------------------------------------------------
export const kpiSnapshotSchema = z.object({
  date: z.string(),
  revenueCents: z.number().int(),
  spendCents: z.number().int(),
  profitCents: z.number().int(),
  llmCostCents: z.number().int(),
  paidOrders: z.number().int(),
  roas: z.number().optional(),
  roi: z.number().optional(),
  cacCents: z.number().int().optional(),
  cpaCents: z.number().int().optional(),
  aovCents: z.number().int().optional(),
  targetRevenueCents: z.number().int(),
  metTarget: z.boolean(),
  // Subscore 0..100 do progresso da meta (aditivo/opcional — Fase 5 / COO-Scale).
  metaProgress: z.number().int().min(0).max(100).optional(),
});
export type KPISnapshotOutput = z.infer<typeof kpiSnapshotSchema>;

// ============================================================
// TIMES POR SETOR — Role / Assessment / Strategy (saidas de LLM)
// Espelham core/team.ts. Validam o JSON do opus dentro de try/catch -> fallback
// (igual orchestrator.buildPlan): JSON malformado NUNCA derruba o time.
// ============================================================

// JSON recursivo local (mesmo padrao de crm.ts; sem dep externa).
const teamJsonSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(teamJsonSchema),
    z.record(teamJsonSchema),
  ]),
);

export const roleSchema = z.enum(['SPECIALIST', 'STRATEGIST', 'EXECUTOR']);

// Os 9 setores dos times (espelha teamSectorSchema de crm.ts; redeclarado aqui
// para evitar import circular entre schemas.ts e crm.ts).
const teamSectorEnum = z.enum([
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

export const assessmentSchema = z.object({
  sector: teamSectorEnum,
  healthScore: z.number().int().min(0).max(100),
  status: z.enum(['HEALTHY', 'WARNING', 'CRITICAL']),
  findings: z.array(z.string()),
  risks: z.array(z.string()),
  opportunities: z.array(z.string()),
  evidence: teamJsonSchema,
  confidence: z.number().min(0).max(1),
  source: z.enum(['RULES', 'LLM']),
});
export type AssessmentOutput = z.infer<typeof assessmentSchema>;

export const strategyActionSchema = z.object({
  capability: z.string().min(1),
  priority: z.number().int().min(0).max(100),
  params: teamJsonSchema,
  reason: z.string().min(1),
});
export type StrategyActionOutput = z.infer<typeof strategyActionSchema>;

export const strategySchema = z.object({
  sector: teamSectorEnum,
  objective: z.string().min(1),
  mode: z.enum(['GROW', 'SUSTAIN']),
  actions: z.array(strategyActionSchema),
  successCriteria: z.array(z.string()),
  rationale: z.string().min(1),
});
export type StrategyOutput = z.infer<typeof strategySchema>;

// ============================================================
// MARKET_RESEARCH — MarketOpportunity (saida estruturada do estrategista)
// ============================================================
export const marketOpportunityStatusSchema = z.enum([
  'PENDING',
  'SELECTED',
  'USED',
  'DISCARDED',
]);

export const marketOpportunitySchema = z.object({
  segment: z.string().min(1),
  niche: z.string().min(1),
  demandScore: z.number().int().min(0).max(100),
  competitionScore: z.number().int().min(0).max(100),
  potentialScore: z.number().int().min(0).max(100),
  rationale: z.string().min(1),
  titleIdeas: z.array(z.string()),
  angles: z.array(z.string()),
  evidence: z.array(z.string()),
});
export type MarketOpportunityOutput = z.infer<typeof marketOpportunitySchema>;

// Lote rankeado (saida do LLM estrategista quando enriquecido por opus).
export const marketOpportunityBatchSchema = z.object({
  opportunities: z.array(marketOpportunitySchema),
});
export type MarketOpportunityBatchOutput = z.infer<
  typeof marketOpportunityBatchSchema
>;

// ============================================================
// EBOOK_QA — EbookAudit (saida estruturada do auditor LLM)
// score/verdict FINAIS sao recalculados deterministicamente no auditor; o LLM
// devolve dimensionScores/issues/recommendations + um hint de veredito.
// ============================================================
export const ebookAuditVerdictSchema = z.enum(['PASS', 'NEEDS_FIX', 'FAIL']);
export const ebookIssueSeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'BLOCKER']);
export const ebookIssueCategorySchema = z.enum([
  'STRUCTURE',
  'CONTENT_QUALITY',
  'MARKET_FIT',
  'COMPLIANCE',
]);

export const ebookIssueSchema = z.object({
  category: ebookIssueCategorySchema,
  severity: ebookIssueSeveritySchema,
  chapterIndex: z.number().int().min(0).nullable().optional(),
  title: z.string().min(1),
  detail: z.string().min(1),
  suggestion: z.string().min(1),
});
export type EbookIssueOutput = z.infer<typeof ebookIssueSchema>;

export const ebookDimensionScoresSchema = z.object({
  structure: z.number().int().min(0).max(100),
  contentQuality: z.number().int().min(0).max(100),
  marketFit: z.number().int().min(0).max(100),
  compliance: z.number().int().min(0).max(100),
});

// Saida do LLM auditor (sem score/verdict finais — recalculados no auditor).
export const ebookAuditLlmSchema = z.object({
  dimensionScores: ebookDimensionScoresSchema,
  issues: z.array(ebookIssueSchema),
  recommendations: z.array(z.string()),
  /** Hint do LLM; o auditor recalcula o veredito final deterministicamente. */
  verdictHint: ebookAuditVerdictSchema.optional(),
});
export type EbookAuditLlmOutput = z.infer<typeof ebookAuditLlmSchema>;

// EbookAudit completo (DTO persistivel; espelha core/quality.ts).
export const ebookAuditSchema = z.object({
  ebookId: z.string().min(1),
  score: z.number().int().min(0).max(100),
  verdict: ebookAuditVerdictSchema,
  issues: z.array(ebookIssueSchema),
  recommendations: z.array(z.string()),
  dimensionScores: ebookDimensionScoresSchema,
  marketOpportunityId: z.string().nullable().optional(),
  iteration: z.number().int().min(0),
  model: z.string().optional(),
  auditedAt: z.string(),
});
export type EbookAuditOutput = z.infer<typeof ebookAuditSchema>;
