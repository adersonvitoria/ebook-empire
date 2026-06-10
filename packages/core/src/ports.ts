// PORTS — interfaces dos adapters (Hexagonal / Ports & Adapters).
// Agentes e rotas dependem SOMENTE destas interfaces. As implementacoes
// (real + stub) vivem em packages/adapters/src/*. Trocar real<->stub por env.
//
// Convencao de unidade: dinheiro SEMPRE em Int centavos BRL.

import type {
  PaymentStatus,
  PaymentProvider,
  DateRange,
  Json,
} from './types.js';
import type { AlertEvent, AlertChannel, AlertSeverity } from './alerts.js';
import type { Sector } from './crm.js';

// ============================================================
// LLM
// ============================================================
export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMGenerateTextInput {
  /** Modelo: 'claude-sonnet-4-6' (conteudo) ou 'claude-opus-4-8' (planejamento). */
  model: string;
  system?: string;
  messages: LLMMessage[];
  maxTokens: number;
  temperature?: number;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  /** Custo estimado em centavos BRL, quando calculavel. */
  costCents?: number;
}

export interface LLMGenerateTextResult {
  text: string;
  usage: LLMUsage;
}

export interface LLMGenerateJsonInput<T> extends LLMGenerateTextInput {
  /** Funcao validadora/parser (tipicamente schema.parse de um Zod schema). */
  parse: (raw: unknown) => T;
}

export interface LLMGenerateJsonResult<T> {
  data: T;
  usage: LLMUsage;
}

export interface LLMPort {
  generateText(input: LLMGenerateTextInput): Promise<LLMGenerateTextResult>;
  generateJson<T>(input: LLMGenerateJsonInput<T>): Promise<LLMGenerateJsonResult<T>>;
}

// ============================================================
// MARKET DATA (pesquisa externa — Serper.dev real; stub deterministico)
// Port FINO e AGNOSTICO de provedor: o shape da Serper NUNCA vaza para ca
// (fica so no adapter server-side packages/adapters/src/market-data.ts).
// ============================================================
export interface MarketSearchInput {
  query: string;
  /** default 'br'. */
  gl?: string;
  /** default 'pt-br'. */
  hl?: string;
  /** 1..100; default 10. */
  num?: number;
}

export interface MarketOrganicResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

export interface MarketPaaItem {
  question: string;
  snippet?: string;
}

export interface MarketSearchResult {
  query: string;
  /** organic.length (proxy bruto de oferta na SERP). */
  totalOrganic: number;
  organic: MarketOrganicResult[];
  /** map de relatedSearches[].query. */
  relatedSearches: string[];
  /** perguntas reais dos usuarios (proxy de demanda latente). */
  peopleAlsoAsk: MarketPaaItem[];
  /** !!knowledgeGraph (proxy de competicao). */
  knowledgeGraphPresent: boolean;
}

export interface MarketDataPort {
  search(input: MarketSearchInput): Promise<MarketSearchResult>;
}

// ============================================================
// PAYMENT (Asaas PIX primario; trocavel por Mercado Pago)
// ============================================================
export interface PaymentCustomerInput {
  name: string;
  email: string;
  cpfCnpj?: string;
}

export interface CreatePixChargeInput {
  orderId: string;
  amountCents: number;
  customer: PaymentCustomerInput;
  description: string;
}

export interface CreatePixChargeResult {
  providerPaymentId: string;
  pixQrCode: string;
  pixCopyPaste: string;
  dueDate: Date;
}

export interface GetPaymentResult {
  status: PaymentStatus;
  paidAt?: Date | null;
}

export interface ParseWebhookResult {
  valid: boolean;
  /** Evento bruto do provedor (ex. "PAYMENT_RECEIVED"). */
  event: string;
  provider?: PaymentProvider;
  providerPaymentId?: string;
  /** ID unico do evento para idempotencia (@@unique([provider, externalEventId])). */
  externalEventId?: string;
  status?: PaymentStatus;
}

export interface PaymentPort {
  createPixCharge(input: CreatePixChargeInput): Promise<CreatePixChargeResult>;
  getPayment(providerPaymentId: string): Promise<GetPaymentResult>;
  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): ParseWebhookResult;
}

// ============================================================
// EMAIL (entrega)
// ============================================================
export interface EmailSendInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailSendResult {
  messageId: string;
}

export interface EmailPort {
  send(input: EmailSendInput): Promise<EmailSendResult>;
}

// ============================================================
// STORAGE (download via URL assinada; stub local em disco)
// ============================================================
export interface StoragePort {
  /** Grava o objeto (ex. PDF do ebook) sob uma key opaca. */
  putObject(key: string, bytes: Buffer): Promise<void>;
  /** Recupera os bytes de um objeto (uso interno). */
  getObject(key: string): Promise<Buffer>;
  /** Gera URL assinada efemera (ttlSeconds). Nunca path adivinhavel. */
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
}

// ============================================================
// INSTAGRAM (Meta Graph API; stub)
// ============================================================
export interface InstagramPublishInput {
  caption: string;
  mediaUrl: string;
  hashtags?: string[];
}

export interface InstagramPublishResult {
  externalId: string;
  permalink: string;
}

export interface InstagramUploadMediaInput {
  imageUrl: string;
}

export interface InstagramUploadMediaResult {
  containerId: string;
}

export interface InstagramAccountInsights {
  reach: number;
  impressions: number;
  profileViews: number;
  followers: number;
}

export interface InstagramPostInsights {
  likes: number;
  comments: number;
  saves: number;
  reach: number;
}

export interface InstagramPort {
  publishPost(input: InstagramPublishInput): Promise<InstagramPublishResult>;
  uploadMedia(input: InstagramUploadMediaInput): Promise<InstagramUploadMediaResult>;
  getAccountInsights(range: DateRange): Promise<InstagramAccountInsights>;
  getPostInsights(externalId: string): Promise<InstagramPostInsights>;
}

// ============================================================
// ADS (Meta Marketing API; stub)
// ============================================================
export type AdsCampaignStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

export interface CreateAdCampaignInput {
  name: string;
  objective: string;
  dailyBudgetCents: number;
  targeting: Json;
  utmCampaign: string;
  /** URL de destino SEMPRE com UTMs injetadas. */
  destinationUrl: string;
}

export interface CreateAdCampaignResult {
  externalId: string;
}

export interface AdsInsightRow {
  /** Data ISO YYYY-MM-DD. */
  date: string;
  impressions: number;
  clicks: number;
  spendCents: number;
  conversions: number;
}

export interface AdsPort {
  createCampaign(input: CreateAdCampaignInput): Promise<CreateAdCampaignResult>;
  /** SET absoluto do budget diario (idempotente — nao incrementa). */
  updateBudget(externalId: string, dailyBudgetCents: number): Promise<void>;
  setStatus(externalId: string, status: AdsCampaignStatus): Promise<void>;
  getInsights(externalId: string, range: DateRange): Promise<AdsInsightRow[]>;
}

// ============================================================
// NOTIFICATION (alertas externos — EMAIL + WHATSAPP)
// Fica FORA do bundle Ports (ver docs/ALERTS.md secao 1): injetada por
// construtor no AlertService, nao em todos os agentes.
// ============================================================

/** Mensagem ja montada (title/body pt-BR) entregue a NotificationPort. */
export interface AlertMessage {
  event: AlertEvent;
  severity: AlertSeverity;
  sector?: Sector | null;
  title: string;
  body: string;
  dedupeKey: string;
  /** Canais a disparar (subconjunto de AlertSettings.channels). */
  channels: AlertChannel[];
  emailRecipients: string[];
  whatsappRecipients: string[];
  meta?: Json;
}

/** Resultado por canal do fan-out (1 por canal disparado). */
export interface AlertDeliveryResult {
  channel: AlertChannel;
  status: 'SENT' | 'FAILED';
  providerId?: string;
  error?: string;
}

export interface NotificationPort {
  /** Faz fan-out para os canais habilitados; devolve 1 resultado por canal. */
  send(input: AlertMessage): Promise<AlertDeliveryResult[]>;
}

// ============================================================
// MARKETPLACE (distribuicao externa — Hotmart / Kiwify; stub)
// Port FINO e AGNOSTICO de provedor: o shape de cada marketplace NUNCA vaza
// para ca (fica no adapter server-side). Dinheiro SEMPRE Int centavos BRL.
// ============================================================

/** Provedor de marketplace externo (espelha PaymentProvider HOTMART/KIWIFY). */
export type MarketplaceProvider = 'HOTMART' | 'KIWIFY';

export interface MarketplaceProductInput {
  /** Product.id interno (rastreabilidade). */
  productId: string;
  name: string;
  description?: string;
  priceCents: number;
  /** Comissao de afiliado 0..100. */
  affiliateCommissionPct: number;
}

export interface MarketplaceProductResult {
  provider: MarketplaceProvider;
  /** Id do produto no provedor (Product.externalProductId / Listing.externalProductId). */
  externalProductId: string;
  marketplaceUrl: string;
  affiliateCommissionPct: number;
}

export interface MarketplaceWebhookResult {
  valid: boolean;
  /** Evento bruto do provedor (ex. "PURCHASE_APPROVED"). */
  event: string;
  provider?: MarketplaceProvider;
  /** Id do produto no provedor (casa com externalProductId). */
  externalProductId?: string;
  /** Id do pedido no provedor (casa com Order.externalOrderId). */
  externalOrderId?: string;
  /** Id unico do evento para idempotencia (@@unique([provider, externalEventId])). */
  externalEventId?: string;
  /** Valor da venda em centavos BRL, quando presente. */
  amountCents?: number;
  /** E-mail do comprador, quando presente. */
  buyerEmail?: string;
}

export interface MarketplacePort {
  /** Cria/publica o produto no marketplace; devolve ids/URL externos. */
  createProduct(input: MarketplaceProductInput): Promise<MarketplaceProductResult>;
  /** Atualiza um produto ja publicado (idempotente pelo externalProductId). */
  updateProduct(
    externalProductId: string,
    input: MarketplaceProductInput,
  ): Promise<MarketplaceProductResult>;
  /** Lê o estado atual do produto no marketplace. */
  getProduct(externalProductId: string): Promise<MarketplaceProductResult>;
  /** Valida + parseia um webhook do marketplace (idempotencia via externalEventId). */
  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): MarketplaceWebhookResult;
}

// ============================================================
// WHATSAPP (envio direto — Evolution API; stub)
// Port MINIMO p/ outreach de afiliados / upsell. Distinto da NotificationPort
// (que faz fan-out de ALERTAS): aqui e envio 1:1 de mensagem de texto.
// ============================================================
export interface WhatsAppPort {
  /** Envia uma mensagem de texto para um numero (E.164 ou JID do provedor). */
  sendMessage(to: string, text: string): Promise<void>;
}

// ============================================================
// Bundle de ports injetado no AgentContext e nas rotas.
// ============================================================
export interface Ports {
  llm: LLMPort;
  payment: PaymentPort;
  email: EmailPort;
  storage: StoragePort;
  instagram: InstagramPort;
  ads: AdsPort;
  /**
   * Pesquisa de mercado (setor MARKET_RESEARCH). OPCIONAL — mesmo padrao de
   * `ctx.alert?`: wirings parciais (teste/e2e que montam Ports parcial) podem
   * omitir. O service do setor exige presenca e falha claro (pt-BR) se ausente.
   */
  marketData?: MarketDataPort;
  /**
   * Distribuicao em marketplace externo (setor MARKETPLACE). OPCIONAL — mesmo
   * padrao de `marketData?`: wirings parciais (teste/e2e) podem omitir. O service
   * do setor exige presenca e falha claro (pt-BR) se ausente.
   */
  marketplace?: MarketplacePort;
  /**
   * Envio direto de WhatsApp (setor AFFILIATE / upsell). OPCIONAL — wirings
   * parciais podem omitir; o service do setor exige presenca quando usado.
   */
  whatsapp?: WhatsAppPort;
}
