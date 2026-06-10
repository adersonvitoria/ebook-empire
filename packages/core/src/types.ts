// Tipos de dominio compartilhados. Alinhados 1:1 com prisma/schema.prisma.
// NAO inventar nomes divergentes — estes sao a fonte de verdade em TS.

// ------------------------------------------------------------
// JSON util
// ------------------------------------------------------------
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Json = JsonValue;

// ------------------------------------------------------------
// Enums (espelham os enums Postgres do schema)
// ------------------------------------------------------------
export type EbookStatus = 'DRAFT' | 'GENERATING' | 'READY' | 'PUBLISHED' | 'ARCHIVED';

export type OrderStatus =
  | 'PENDING'
  | 'AWAITING_PAYMENT'
  | 'PAID'
  | 'DELIVERED'
  | 'REFUNDED'
  | 'CANCELED'
  | 'EXPIRED';

export type PaymentStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'RECEIVED'
  | 'OVERDUE'
  | 'REFUNDED'
  | 'FAILED';

export type PaymentProvider = 'ASAAS' | 'MERCADO_PAGO' | 'HOTMART' | 'KIWIFY';

export type PaymentMethod = 'PIX' | 'BOLETO' | 'CREDIT_CARD';

export type DeliveryStatus = 'GRANTED' | 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'REVOKED';

export type SocialStatus = 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'FAILED';

export type AdStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';

export type AgentRunStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';

export type AgentName =
  | 'ORCHESTRATOR'
  | 'CONTENT'
  | 'SALES'
  | 'DELIVERY'
  | 'SOCIAL'
  | 'TRAFFIC'
  | 'ANALYTICS'
  // COO — agente do CRM / Command Center (loga seus runs como OPERATIONS).
  | 'OPERATIONS'
  // Setores novos (times): cada papel grava AgentRun.agent = agente homonimo.
  | 'MARKET_RESEARCH'
  | 'EBOOK_QA'
  // Producao autonoma — marketplace / afiliados / funil.
  | 'MARKETPLACE'
  | 'AFFILIATE'
  | 'FUNNEL';

export type EventType =
  // funil
  | 'IMPRESSION'
  | 'CLICK'
  | 'LANDING_VIEW'
  | 'CHECKOUT_STARTED'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'DELIVERED'
  | 'REFUNDED'
  // social
  | 'SOCIAL_VIEW'
  | 'SOCIAL_ENGAGEMENT'
  // operacionais internos
  | 'EBOOK_PUBLISHED'
  | 'SOCIAL_POSTED'
  | 'CAMPAIGN_CREATED'
  | 'BUDGET_REALLOCATED'
  | 'AD_SPEND'
  | 'INSIGHT_INGESTED'
  // mercado + QA
  | 'MARKET_OPPORTUNITY_RANKED'
  | 'EBOOK_AUDITED'
  | 'EBOOK_RELAUNCHED'
  // producao autonoma — marketplace / afiliados / funil
  | 'AFFILIATE_CONTACTED'
  | 'UPSELL_SENT'
  | 'UPSELL_CONVERTED';

// ------------------------------------------------------------
// Atribuicao
// ------------------------------------------------------------
export interface UtmParams {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
}

export type AdInsightStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

// ------------------------------------------------------------
// Entidades de dominio (formato "plano" — datas como Date)
// Estruturas espelham os modelos Prisma. Use o tipo do @prisma/client
// quando estiver dentro de uma query; estes servem para borda/API/agentes.
// ------------------------------------------------------------
export interface Customer {
  id: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  asaasCustomerId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Ebook {
  id: string;
  title: string;
  niche: string;
  slug: string;
  status: EbookStatus;
  outline?: Json | null;
  contentMarkdown?: string | null;
  pdfPath?: string | null;
  coverImagePath?: string | null;
  language: string;
  generatedByRunId?: string | null;
  /** Oportunidade de mercado que originou o ebook (GATE 1). */
  marketOpportunityId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Product {
  id: string;
  ebookId: string;
  name: string;
  slug: string;
  description?: string | null;
  priceCents: number;
  currency: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Order extends UtmParams {
  id: string;
  customerId: string;
  productId: string;
  ebookId: string;
  status: OrderStatus;
  priceCents: number;
  currency: string;
  visitorId?: string | null;
  adCampaignId?: string | null;
  asaasPaymentId?: string | null;
  paidAt?: Date | null;
  deliveredAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Payment {
  id: string;
  orderId: string;
  provider: PaymentProvider;
  method: PaymentMethod;
  providerPaymentId: string;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  pixQrCode?: string | null;
  pixCopyPaste?: string | null;
  dueDate?: Date | null;
  paidAt?: Date | null;
  raw?: Json | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryGrant {
  id: string;
  orderId: string;
  ebookId: string;
  customerId: string;
  tokenHash: string;
  status: DeliveryStatus;
  maxDownloads: number;
  downloadCount: number;
  expiresAt: Date;
  revokedAt?: Date | null;
  emailSentAt?: Date | null;
  lastDownloadAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SocialPost {
  id: string;
  agentRunId?: string | null;
  platform: string;
  caption: string;
  mediaPaths: string[];
  hashtags: string[];
  status: SocialStatus;
  scheduledAt?: Date | null;
  publishedAt?: Date | null;
  externalPostId?: string | null;
  permalink?: string | null;
  productId?: string | null;
  attempts: number;
  metrics?: Json | null;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdCampaign {
  id: string;
  name: string;
  objective: string;
  status: AdStatus;
  platform: string;
  externalCampaignId?: string | null;
  productId?: string | null;
  dailyBudgetCents?: number | null;
  totalSpendCents: number;
  utmCampaign?: string | null;
  targeting?: Json | null;
  startDate?: Date | null;
  endDate?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdInsight {
  id: string;
  campaignId: string;
  date: Date;
  impressions: number;
  clicks: number;
  spendCents: number;
  conversions: number;
  revenueCents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentRun {
  id: string;
  agent: AgentName;
  status: AgentRunStatus;
  cycleId?: string | null;
  /** Papel do time (SPECIALIST/STRATEGIST/EXECUTOR) — null em runs diretos. */
  role?: 'SPECIALIST' | 'STRATEGIST' | 'EXECUTOR' | null;
  /** Setor do time (TeamSector) — null em runs diretos. */
  sector?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;
  durationMs?: number | null;
  input?: Json | null;
  output?: Json | null;
  metrics?: Json | null;
  error?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costCents?: number | null;
  createdAt: Date;
}

export interface DomainEvent extends UtmParams {
  id: string;
  type: EventType;
  occurredAt: Date;
  visitorId?: string | null;
  customerId?: string | null;
  productId?: string | null;
  orderId?: string | null;
  adCampaignId?: string | null;
  paymentId?: string | null;
  provider?: string | null;
  externalEventId?: string | null;
  costCents?: number | null;
  revenueCents?: number | null;
  payload?: Json | null;
  metadata?: Json | null;
  processedAt?: Date | null;
  createdAt: Date;
}

// ------------------------------------------------------------
// KPI / Analytics (calculado exclusivamente pelo AnalyticsAgent)
// Valores null-guarded: undefined/null quando indefinido (ex. ROAS com spend=0).
// ------------------------------------------------------------
export interface KPISnapshot {
  /** Dia de referencia (America/Sao_Paulo) no formato YYYY-MM-DD. */
  date: string;
  /** Faturamento contabil do dia (Order.priceCents onde status=PAID). */
  revenueCents: number;
  /** Spend total de ads do dia (AdInsight). */
  spendCents: number;
  /** Lucro = revenueCents - spendCents - custo de LLM. */
  profitCents: number;
  /** Custo de LLM dos agentes no dia (AgentRun.costCents). */
  llmCostCents: number;
  /** Numero de pedidos pagos. */
  paidOrders: number;
  /** ROAS = revenue / spend (undefined se spend=0). */
  roas?: number;
  /** ROI = (revenue - spend) / spend (undefined se spend=0). */
  roi?: number;
  /** CAC = spend / paidOrders (undefined se paidOrders=0 ou spend=0). */
  cacCents?: number;
  /** CPA = spend / conversions (undefined se conversions=0 ou spend=0). */
  cpaCents?: number;
  /** Ticket medio = revenue / paidOrders (undefined se paidOrders=0). */
  aovCents?: number;
  /** Meta diaria de faturamento em centavos. */
  targetRevenueCents: number;
  /** Atingiu a meta do dia? */
  metTarget: boolean;
  /**
   * Progresso da meta como subscore 0..100 (= min(100, round(revenue/target*100))).
   * Aditivo/opcional — alimenta o health score do setor ANALYTICS (Fase 5 / COO-Scale).
   */
  metaProgress?: number;
}

// Range de datas para insights/relatorios (ISO YYYY-MM-DD).
export interface DateRange {
  since: string;
  until: string;
}
