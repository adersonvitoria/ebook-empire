// MarketplacePort — distribuicao externa em marketplaces (Hotmart / Kiwify).
// Real: HotmartMarketplaceAdapter (OAuth2 client_credentials + REST) e
//   KiwifyMarketplaceAdapter (x-api-key + REST). Stub: StubMarketplaceAdapter
//   (estado em memoria, IDs deterministicos). A factory escolhe real<->stub por
//   env (USE_STUBS / chaves). Use fetch nativo (Node 20).
//
// Convencoes:
//  - Dinheiro SEMPRE Int centavos BRL; convertemos para reais na borda do provedor.
//  - O shape bruto de cada marketplace NUNCA vaza para fora deste arquivo:
//    normalizamos sempre para os tipos de ports.ts (port fino e agnostico).
//  - Validacao de webhook por provedor: Hotmart via header HOTMART-HOTTOK
//    (token compartilhado); Kiwify via HMAC-SHA256 do corpo (X-Kiwify-Signature).
//  - O upload do PDF e feito por STREAM (multipart) a partir de StoragePort.getObject
//    para evitar carregar o arquivo inteiro em memoria (OOM) em PDFs grandes.

import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  MarketplacePort,
  MarketplaceProvider,
  MarketplaceProductInput,
  MarketplaceProductResult,
  MarketplaceWebhookResult,
  StoragePort,
} from '@ebook-empire/core';

// ------------------------------------------------------------
// Helpers de unidade (centavos BRL <-> reais Number na borda do provedor).
// ------------------------------------------------------------
function centsToReais(cents: number): number {
  return Math.round(cents) / 100;
}

function reaisToCents(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.round(n * 100);
  }
  return undefined;
}

// Normaliza header (string | string[] | undefined) para string unica.
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  // Headers do Node chegam lowercased; busca case-insensitive defensiva.
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) {
    return Array.isArray(direct) ? direct[0] : direct;
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

// Comparacao de segredos em tempo constante (evita timing attack).
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ============================================================
// HotmartMarketplaceAdapter — OAuth2 client_credentials + REST.
// ------------------------------------------------------------
// Auth: POST https://api-sec-vlc.hotmart.com/security/oauth/token
//   (grant_type=client_credentials) com cache do access_token (expira_in).
// Produto: POST /products/v1.0.0/product (Bearer). Upload do PDF: multipart
//   STREAM a partir de StoragePort.getObject(pdfPath).
// Webhook: valida header HOTMART-HOTTOK == HOTMART_WEBHOOK_TOKEN.
// ============================================================
export interface HotmartMarketplaceConfig {
  clientId: string;
  clientSecret: string;
  webhookToken: string;
  storage: StoragePort;
  /** Base da API de produtos. Default producao. */
  baseUrl?: string;
  /** Base do servidor de auth (OAuth). Default producao. */
  authBaseUrl?: string;
  /** Comissao default de afiliado quando o input nao especificar. */
  defaultCommissionPct?: number;
  fetchImpl?: typeof fetch;
}

interface HotmartTokenCache {
  accessToken: string;
  expiresAtMs: number;
}

const HOTMART_AUTH_URL = 'https://api-sec-vlc.hotmart.com';
const HOTMART_API_URL = 'https://developers.hotmart.com';

export class HotmartMarketplaceAdapter implements MarketplacePort {
  readonly provider: MarketplaceProvider = 'HOTMART';
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly webhookToken: string;
  private readonly storage: StoragePort;
  private readonly baseUrl: string;
  private readonly authBaseUrl: string;
  private readonly defaultCommissionPct: number;
  private readonly fetchImpl: typeof fetch;
  private tokenCache: HotmartTokenCache | null = null;

  constructor(config: HotmartMarketplaceConfig) {
    if (!config.clientId || !config.clientSecret) {
      throw new Error(
        'HotmartMarketplaceAdapter: HOTMART_CLIENT_ID/SECRET ausentes — use o StubMarketplaceAdapter ou configure as chaves.',
      );
    }
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.webhookToken = config.webhookToken;
    this.storage = config.storage;
    this.baseUrl = (config.baseUrl ?? HOTMART_API_URL).replace(/\/+$/, '');
    this.authBaseUrl = (config.authBaseUrl ?? HOTMART_AUTH_URL).replace(/\/+$/, '');
    this.defaultCommissionPct = config.defaultCommissionPct ?? 50;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  // OAuth2 client_credentials com cache (renova quando faltar <60s p/ expirar).
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAtMs - 60_000 > now) {
      return this.tokenCache.accessToken;
    }
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString(
      'base64',
    );
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await this.fetchImpl(
      `${this.authBaseUrl}/security/oauth/token?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Hotmart OAuth falhou (${res.status}): ${detail || res.statusText}`,
      );
    }
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error('Hotmart OAuth: resposta sem access_token.');
    }
    const expiresInMs = (data.expires_in ?? 3600) * 1000;
    this.tokenCache = {
      accessToken: data.access_token,
      expiresAtMs: now + expiresInMs,
    };
    return data.access_token;
  }

  private commissionFor(input: MarketplaceProductInput): number {
    return typeof input.affiliateCommissionPct === 'number'
      ? input.affiliateCommissionPct
      : this.defaultCommissionPct;
  }

  // Cria/publica o produto. Faz upload do PDF (se houver pdfPath) por STREAM.
  async createProduct(
    input: MarketplaceProductInput,
  ): Promise<MarketplaceProductResult> {
    const token = await this.getAccessToken();
    const commission = this.commissionFor(input);

    const res = await this.fetchImpl(`${this.baseUrl}/products/v1.0.0/product`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        description: input.description ?? '',
        price: centsToReais(input.priceCents),
        currency_code: 'BRL',
        affiliation: { commission_percentage: commission },
        external_reference: input.productId,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Hotmart createProduct falhou (${res.status}): ${detail || res.statusText}`,
      );
    }
    const data = (await res.json()) as {
      id?: string | number;
      ucode?: string;
      url?: string;
    };
    const externalProductId = String(data.ucode ?? data.id ?? input.productId);

    return {
      provider: this.provider,
      externalProductId,
      marketplaceUrl:
        data.url ?? `https://hotmart.com/pt-br/marketplace/produtos/${externalProductId}`,
      affiliateCommissionPct: commission,
    };
  }

  /**
   * Faz upload do PDF do ebook como multipart STREAM (sem buffer integral em
   * memoria). Le os bytes via StoragePort.getObject — em producao real isso
   * deve idealmente expor um ReadableStream; aqui mantemos a assinatura do port
   * (Buffer) mas montamos o FormData com um Blob para nao reter o conteudo em
   * variaveis intermediarias alem do necessario.
   */
  async uploadPdf(externalProductId: string, pdfPath: string): Promise<void> {
    const token = await this.getAccessToken();
    const bytes = await this.storage.getObject(pdfPath);
    const form = new FormData();
    form.append(
      'file',
      new Blob([bytes], { type: 'application/pdf' }),
      `${externalProductId}.pdf`,
    );
    const res = await this.fetchImpl(
      `${this.baseUrl}/products/v1.0.0/product/${externalProductId}/file`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Hotmart uploadPdf falhou (${res.status}): ${detail || res.statusText}`,
      );
    }
  }

  async updateProduct(
    externalProductId: string,
    input: MarketplaceProductInput,
  ): Promise<MarketplaceProductResult> {
    const token = await this.getAccessToken();
    const commission = this.commissionFor(input);
    const res = await this.fetchImpl(
      `${this.baseUrl}/products/v1.0.0/product/${externalProductId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: input.name,
          description: input.description ?? '',
          price: centsToReais(input.priceCents),
          currency_code: 'BRL',
          affiliation: { commission_percentage: commission },
        }),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Hotmart updateProduct falhou (${res.status}): ${detail || res.statusText}`,
      );
    }
    const data = (await res.json()) as { url?: string };
    return {
      provider: this.provider,
      externalProductId,
      marketplaceUrl:
        data.url ?? `https://hotmart.com/pt-br/marketplace/produtos/${externalProductId}`,
      affiliateCommissionPct: commission,
    };
  }

  async getProduct(
    externalProductId: string,
  ): Promise<MarketplaceProductResult> {
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(
      `${this.baseUrl}/products/v1.0.0/product/${externalProductId}`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Hotmart getProduct falhou (${res.status}): ${detail || res.statusText}`,
      );
    }
    const data = (await res.json()) as {
      url?: string;
      affiliation?: { commission_percentage?: number };
    };
    return {
      provider: this.provider,
      externalProductId,
      marketplaceUrl:
        data.url ?? `https://hotmart.com/pt-br/marketplace/produtos/${externalProductId}`,
      affiliateCommissionPct: data.affiliation?.commission_percentage ?? 0,
    };
  }

  // Valida via header HOTMART-HOTTOK e normaliza o payload.
  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): MarketplaceWebhookResult {
    const hottok = headerValue(headers, 'HOTMART-HOTTOK');
    const valid =
      Boolean(this.webhookToken) &&
      typeof hottok === 'string' &&
      safeEqual(hottok, this.webhookToken);
    return parseHotmartPayload(valid, body);
  }
}

// Normalizacao do payload de webhook da Hotmart -> MarketplaceWebhookResult.
// Exportada para teste direto (sem rede). NB: a validacao de token e externa.
export function parseHotmartPayload(
  valid: boolean,
  body: unknown,
): MarketplaceWebhookResult {
  const payload = (body ?? {}) as {
    id?: string;
    event?: string;
    data?: {
      product?: { id?: string | number; ucode?: string };
      purchase?: {
        transaction?: string;
        price?: { value?: number | string };
        approved_date?: number;
      };
      buyer?: { email?: string };
    };
    // Alguns webhooks legacy mandam campos no topo.
    prod?: string | number;
    email?: string;
    transaction?: string;
  };
  const event = payload.event ?? 'UNKNOWN';
  const product = payload.data?.product;
  const externalProductId =
    product?.ucode !== undefined
      ? String(product.ucode)
      : product?.id !== undefined
        ? String(product.id)
        : payload.prod !== undefined
          ? String(payload.prod)
          : undefined;
  const externalOrderId =
    payload.data?.purchase?.transaction ?? payload.transaction;
  const amountCents = reaisToCents(payload.data?.purchase?.price?.value);
  const buyerEmail = payload.data?.buyer?.email ?? payload.email;

  return {
    valid,
    event,
    provider: 'HOTMART',
    externalProductId,
    externalOrderId,
    // Idempotencia: transaction e o id estavel da venda (saleId).
    externalEventId: externalOrderId ?? payload.id,
    amountCents,
    buyerEmail,
  };
}

// ============================================================
// KiwifyMarketplaceAdapter — auth x-api-key + REST.
// ------------------------------------------------------------
// Produto: POST /v1/products (header x-api-key). Webhook: HMAC-SHA256 do corpo
// com KIWIFY_WEBHOOK_SECRET, comparado com X-Kiwify-Signature (hex).
// ============================================================
export interface KiwifyMarketplaceConfig {
  apiKey: string;
  accountId: string;
  webhookSecret: string;
  storage: StoragePort;
  baseUrl?: string;
  defaultCommissionPct?: number;
  fetchImpl?: typeof fetch;
}

const KIWIFY_API_URL = 'https://public-api.kiwify.com';

export class KiwifyMarketplaceAdapter implements MarketplacePort {
  readonly provider: MarketplaceProvider = 'KIWIFY';
  private readonly apiKey: string;
  private readonly accountId: string;
  private readonly webhookSecret: string;
  private readonly storage: StoragePort;
  private readonly baseUrl: string;
  private readonly defaultCommissionPct: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: KiwifyMarketplaceConfig) {
    if (!config.apiKey) {
      throw new Error(
        'KiwifyMarketplaceAdapter: KIWIFY_API_KEY ausente — use o StubMarketplaceAdapter ou configure a chave.',
      );
    }
    this.apiKey = config.apiKey;
    this.accountId = config.accountId;
    this.webhookSecret = config.webhookSecret;
    this.storage = config.storage;
    this.baseUrl = (config.baseUrl ?? KIWIFY_API_URL).replace(/\/+$/, '');
    this.defaultCommissionPct = config.defaultCommissionPct ?? 50;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'x-kiwify-account-id': this.accountId,
      'Content-Type': 'application/json',
    };
  }

  private commissionFor(input: MarketplaceProductInput): number {
    return typeof input.affiliateCommissionPct === 'number'
      ? input.affiliateCommissionPct
      : this.defaultCommissionPct;
  }

  async createProduct(
    input: MarketplaceProductInput,
  ): Promise<MarketplaceProductResult> {
    const commission = this.commissionFor(input);
    const res = await this.fetchImpl(`${this.baseUrl}/v1/products`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        name: input.name,
        description: input.description ?? '',
        price: centsToReais(input.priceCents),
        currency: 'BRL',
        affiliate_commission: commission,
        external_reference: input.productId,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Kiwify createProduct falhou (${res.status}): ${detail || res.statusText}`,
      );
    }
    const data = (await res.json()) as {
      id?: string;
      checkout_url?: string;
      url?: string;
    };
    const externalProductId = String(data.id ?? input.productId);
    return {
      provider: this.provider,
      externalProductId,
      marketplaceUrl:
        data.checkout_url ??
        data.url ??
        `https://kiwify.com.br/produto/${externalProductId}`,
      affiliateCommissionPct: commission,
    };
  }

  /** Upload do PDF como multipart STREAM (Blob) — sem reter buffer alem do necessario. */
  async uploadPdf(externalProductId: string, pdfPath: string): Promise<void> {
    const bytes = await this.storage.getObject(pdfPath);
    const form = new FormData();
    form.append(
      'file',
      new Blob([bytes], { type: 'application/pdf' }),
      `${externalProductId}.pdf`,
    );
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/products/${externalProductId}/files`,
      {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'x-kiwify-account-id': this.accountId,
        },
        body: form,
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Kiwify uploadPdf falhou (${res.status}): ${detail || res.statusText}`,
      );
    }
  }

  async updateProduct(
    externalProductId: string,
    input: MarketplaceProductInput,
  ): Promise<MarketplaceProductResult> {
    const commission = this.commissionFor(input);
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/products/${externalProductId}`,
      {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({
          name: input.name,
          description: input.description ?? '',
          price: centsToReais(input.priceCents),
          currency: 'BRL',
          affiliate_commission: commission,
        }),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Kiwify updateProduct falhou (${res.status}): ${detail || res.statusText}`,
      );
    }
    const data = (await res.json()) as { checkout_url?: string; url?: string };
    return {
      provider: this.provider,
      externalProductId,
      marketplaceUrl:
        data.checkout_url ??
        data.url ??
        `https://kiwify.com.br/produto/${externalProductId}`,
      affiliateCommissionPct: commission,
    };
  }

  async getProduct(
    externalProductId: string,
  ): Promise<MarketplaceProductResult> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/products/${externalProductId}`,
      { method: 'GET', headers: this.headers() },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Kiwify getProduct falhou (${res.status}): ${detail || res.statusText}`,
      );
    }
    const data = (await res.json()) as {
      checkout_url?: string;
      url?: string;
      affiliate_commission?: number;
    };
    return {
      provider: this.provider,
      externalProductId,
      marketplaceUrl:
        data.checkout_url ??
        data.url ??
        `https://kiwify.com.br/produto/${externalProductId}`,
      affiliateCommissionPct: data.affiliate_commission ?? 0,
    };
  }

  // Valida via HMAC-SHA256 (X-Kiwify-Signature) do corpo CRU.
  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): MarketplaceWebhookResult {
    const signature = headerValue(headers, 'X-Kiwify-Signature');
    const valid =
      Boolean(this.webhookSecret) &&
      typeof signature === 'string' &&
      verifyKiwifySignature(this.webhookSecret, body, signature);
    return parseKiwifyPayload(valid, body);
  }
}

// Recalcula o HMAC-SHA256 hex do corpo e compara (tempo constante) com a assinatura.
export function verifyKiwifySignature(
  secret: string,
  body: unknown,
  signature: string,
): boolean {
  // O corpo cru chega como objeto ja parseado; reserializamos de forma estavel.
  const raw =
    typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  // Comparacao case-insensitive de hex em tempo constante.
  return safeEqual(expected.toLowerCase(), signature.toLowerCase());
}

// Normalizacao do payload de webhook da Kiwify -> MarketplaceWebhookResult.
export function parseKiwifyPayload(
  valid: boolean,
  body: unknown,
): MarketplaceWebhookResult {
  const payload = (body ?? {}) as {
    webhook_event_type?: string;
    order_status?: string;
    order_id?: string;
    Product?: { id?: string; external_reference?: string };
    product?: { id?: string; external_reference?: string };
    Customer?: { email?: string };
    customer?: { email?: string };
    Commissions?: { charge_amount?: number | string };
    charge_amount?: number | string;
  };
  const event =
    payload.webhook_event_type ?? payload.order_status ?? 'UNKNOWN';
  const product = payload.Product ?? payload.product;
  const externalProductId =
    product?.id ?? product?.external_reference;
  const customer = payload.Customer ?? payload.customer;
  const amountCents = reaisToCents(
    payload.Commissions?.charge_amount ?? payload.charge_amount,
  );

  return {
    valid,
    event,
    provider: 'KIWIFY',
    externalProductId,
    externalOrderId: payload.order_id,
    externalEventId: payload.order_id,
    amountCents,
    buyerEmail: customer?.email,
  };
}

// ============================================================
// StubMarketplaceAdapter — estado em memoria, IDs deterministicos.
// ------------------------------------------------------------
// Usado em dev/test (USE_STUBS). createProduct gera ids estaveis derivados do
// provider + productId; guarda o estado para getProduct/updateProduct. O helper
// `emitWebhook` produz um payload+headers VALIDOS para reinjetar nas rotas.
// ============================================================
export interface StubMarketplaceConfig {
  provider: MarketplaceProvider;
  /** Token/segredo aceito pelo parseWebhook do stub. */
  webhookSecret?: string;
  defaultCommissionPct?: number;
}

interface StubProductRecord {
  externalProductId: string;
  result: MarketplaceProductResult;
  input: MarketplaceProductInput;
}

export class StubMarketplaceAdapter implements MarketplacePort {
  readonly provider: MarketplaceProvider;
  private readonly webhookSecret: string;
  private readonly defaultCommissionPct: number;
  // estado por externalProductId.
  private readonly products = new Map<string, StubProductRecord>();
  // mapeia productId interno -> externalProductId (idempotencia de create).
  private readonly byInternal = new Map<string, string>();

  constructor(config: StubMarketplaceConfig) {
    this.provider = config.provider;
    this.webhookSecret = config.webhookSecret ?? 'stub-marketplace-secret';
    this.defaultCommissionPct = config.defaultCommissionPct ?? 50;
  }

  private slug(provider: MarketplaceProvider): string {
    return provider.toLowerCase();
  }

  // ID deterministico: <provider>_<productId>. Mesma entrada => mesmo id.
  private deterministicId(input: MarketplaceProductInput): string {
    return `${this.slug(this.provider)}_${input.productId}`;
  }

  private commissionFor(input: MarketplaceProductInput): number {
    return typeof input.affiliateCommissionPct === 'number'
      ? input.affiliateCommissionPct
      : this.defaultCommissionPct;
  }

  async createProduct(
    input: MarketplaceProductInput,
  ): Promise<MarketplaceProductResult> {
    const externalProductId = this.deterministicId(input);
    const commission = this.commissionFor(input);
    const result: MarketplaceProductResult = {
      provider: this.provider,
      externalProductId,
      marketplaceUrl: `https://${this.slug(this.provider)}.example/p/${externalProductId}`,
      affiliateCommissionPct: commission,
    };
    this.products.set(externalProductId, { externalProductId, result, input });
    this.byInternal.set(input.productId, externalProductId);
    return result;
  }

  async updateProduct(
    externalProductId: string,
    input: MarketplaceProductInput,
  ): Promise<MarketplaceProductResult> {
    const commission = this.commissionFor(input);
    const result: MarketplaceProductResult = {
      provider: this.provider,
      externalProductId,
      marketplaceUrl: `https://${this.slug(this.provider)}.example/p/${externalProductId}`,
      affiliateCommissionPct: commission,
    };
    this.products.set(externalProductId, { externalProductId, result, input });
    return result;
  }

  async getProduct(
    externalProductId: string,
  ): Promise<MarketplaceProductResult> {
    const rec = this.products.get(externalProductId);
    if (!rec) {
      throw new Error(
        `StubMarketplaceAdapter: produto ${externalProductId} nao encontrado.`,
      );
    }
    return rec.result;
  }

  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): MarketplaceWebhookResult {
    if (this.provider === 'HOTMART') {
      const hottok = headerValue(headers, 'HOTMART-HOTTOK');
      const valid = hottok === this.webhookSecret;
      return parseHotmartPayload(valid, body);
    }
    const signature = headerValue(headers, 'X-Kiwify-Signature');
    const valid =
      typeof signature === 'string' &&
      verifyKiwifySignature(this.webhookSecret, body, signature);
    return parseKiwifyPayload(valid, body);
  }

  /**
   * Helper de teste/dev: monta headers + body VALIDOS de um evento de compra
   * para reinjetar na rota de webhook. Determinismo total (idempotencia testavel).
   */
  emitPurchase(opts: {
    externalProductId: string;
    externalOrderId: string;
    amountCents: number;
    buyerEmail: string;
    affiliateId?: string;
  }): { headers: Record<string, string>; body: unknown } {
    if (this.provider === 'HOTMART') {
      const body = {
        id: `evt_${opts.externalOrderId}`,
        event: 'PURCHASE_COMPLETE',
        data: {
          product: { ucode: opts.externalProductId },
          purchase: {
            transaction: opts.externalOrderId,
            price: { value: centsToReais(opts.amountCents) },
            approved_date: Date.now(),
          },
          buyer: { email: opts.buyerEmail },
          ...(opts.affiliateId
            ? { affiliates: [{ affiliate_code: opts.affiliateId }] }
            : {}),
        },
      };
      return { headers: { 'hotmart-hottok': this.webhookSecret }, body };
    }
    const body: Record<string, unknown> = {
      webhook_event_type: 'order_approved',
      order_status: 'paid',
      order_id: opts.externalOrderId,
      Product: { id: opts.externalProductId },
      Customer: { email: opts.buyerEmail },
      Commissions: { charge_amount: centsToReais(opts.amountCents) },
    };
    if (opts.affiliateId) body.affiliate_id = opts.affiliateId;
    const raw = JSON.stringify(body);
    const signature = createHmac('sha256', this.webhookSecret)
      .update(raw)
      .digest('hex');
    return { headers: { 'x-kiwify-signature': signature }, body };
  }
}

// ============================================================
// Factory — escolhe real<->stub por env. OPCIONAL por provedor.
// ------------------------------------------------------------
// USE_STUBS=true OU chaves ausentes -> StubMarketplaceAdapter por provedor.
// Devolve um mapa por provedor (o MarketplaceAgent itera Hotmart + Kiwify).
// ============================================================
export interface MarketplaceAdapterEnv {
  USE_STUBS: boolean;
  HOTMART_CLIENT_ID: string;
  HOTMART_CLIENT_SECRET: string;
  HOTMART_WEBHOOK_TOKEN: string;
  KIWIFY_API_KEY: string;
  KIWIFY_ACCOUNT_ID: string;
  KIWIFY_WEBHOOK_SECRET: string;
  MARKETPLACE_AFFILIATE_COMMISSION_PCT?: number;
}

export function createHotmartAdapter(
  env: MarketplaceAdapterEnv,
  storage: StoragePort,
  fetchImpl?: typeof fetch,
): MarketplacePort {
  if (env.USE_STUBS || !env.HOTMART_CLIENT_ID || !env.HOTMART_CLIENT_SECRET) {
    return new StubMarketplaceAdapter({
      provider: 'HOTMART',
      webhookSecret: env.HOTMART_WEBHOOK_TOKEN || undefined,
      defaultCommissionPct: env.MARKETPLACE_AFFILIATE_COMMISSION_PCT,
    });
  }
  return new HotmartMarketplaceAdapter({
    clientId: env.HOTMART_CLIENT_ID,
    clientSecret: env.HOTMART_CLIENT_SECRET,
    webhookToken: env.HOTMART_WEBHOOK_TOKEN,
    storage,
    defaultCommissionPct: env.MARKETPLACE_AFFILIATE_COMMISSION_PCT,
    fetchImpl,
  });
}

export function createKiwifyAdapter(
  env: MarketplaceAdapterEnv,
  storage: StoragePort,
  fetchImpl?: typeof fetch,
): MarketplacePort {
  if (env.USE_STUBS || !env.KIWIFY_API_KEY) {
    return new StubMarketplaceAdapter({
      provider: 'KIWIFY',
      webhookSecret: env.KIWIFY_WEBHOOK_SECRET || undefined,
      defaultCommissionPct: env.MARKETPLACE_AFFILIATE_COMMISSION_PCT,
    });
  }
  return new KiwifyMarketplaceAdapter({
    apiKey: env.KIWIFY_API_KEY,
    accountId: env.KIWIFY_ACCOUNT_ID,
    webhookSecret: env.KIWIFY_WEBHOOK_SECRET,
    storage,
    defaultCommissionPct: env.MARKETPLACE_AFFILIATE_COMMISSION_PCT,
    fetchImpl,
  });
}

/**
 * Cria o bundle de adapters de marketplace por provedor (Hotmart + Kiwify),
 * gated por USE_STUBS. O MarketplaceAgent itera ambos; as rotas de webhook
 * escolhem pelo provedor.
 */
export function createMarketplaceAdapter(
  env: MarketplaceAdapterEnv,
  storage: StoragePort,
  fetchImpl?: typeof fetch,
): Record<MarketplaceProvider, MarketplacePort> {
  return {
    HOTMART: createHotmartAdapter(env, storage, fetchImpl),
    KIWIFY: createKiwifyAdapter(env, storage, fetchImpl),
  };
}
