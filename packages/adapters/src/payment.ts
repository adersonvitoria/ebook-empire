// Adapter de pagamento (PaymentPort) — Asaas PIX como provedor primario.
// Expoe implementacao real (AsaasPaymentAdapter) + stub injetavel
// (StubPaymentAdapter) e uma factory que escolhe por env (USE_STUBS).
//
// Convencao de unidade: dinheiro SEMPRE em Int centavos BRL. O Asaas trabalha
// com reais decimais (Number) no payload, entao convertemos na borda.

import { nanoid } from 'nanoid';
import type {
  PaymentPort,
  CreatePixChargeInput,
  CreatePixChargeResult,
  GetPaymentResult,
  ParseWebhookResult,
  PaymentStatus,
} from '@ebook-empire/core';

// ------------------------------------------------------------
// Helpers de conversao centavos <-> reais (Asaas usa Number em reais).
// ------------------------------------------------------------
function centsToReais(cents: number): number {
  // Mantem 2 casas; evita erro de ponto flutuante (ex. 4699 -> 46.99).
  return Math.round(cents) / 100;
}

// ------------------------------------------------------------
// Mapeamento de status do Asaas -> PaymentStatus do dominio.
// Eventos/objeto Asaas: PENDING, CONFIRMED, RECEIVED, OVERDUE,
// REFUNDED, RECEIVED_IN_CASH, CHARGEBACK_*, etc.
// Gatilho de entrega = CONFIRMED OU RECEIVED.
// ------------------------------------------------------------
export function mapAsaasStatus(raw: string | undefined): PaymentStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'CONFIRMED':
      return 'CONFIRMED';
    case 'RECEIVED':
    case 'RECEIVED_IN_CASH':
      return 'RECEIVED';
    case 'OVERDUE':
      return 'OVERDUE';
    case 'REFUNDED':
    case 'REFUND_REQUESTED':
    case 'CHARGEBACK_REQUESTED':
    case 'CHARGEBACK_DISPUTE':
      return 'REFUNDED';
    case 'PENDING':
    case 'AWAITING_RISK_ANALYSIS':
      return 'PENDING';
    default:
      return 'PENDING';
  }
}

// Eventos de webhook Asaas que sinalizam liquidacao/confirmacao.
// PAYMENT_CONFIRMED / PAYMENT_RECEIVED disparam a entrega.
function mapAsaasEventToStatus(event: string): PaymentStatus | undefined {
  switch (event) {
    case 'PAYMENT_CONFIRMED':
      return 'CONFIRMED';
    case 'PAYMENT_RECEIVED':
      return 'RECEIVED';
    case 'PAYMENT_OVERDUE':
      return 'OVERDUE';
    case 'PAYMENT_REFUNDED':
    case 'PAYMENT_CHARGEBACK_REQUESTED':
      return 'REFUNDED';
    case 'PAYMENT_CREATED':
    case 'PAYMENT_UPDATED':
      return 'PENDING';
    default:
      return undefined;
  }
}

// ============================================================
// Config dos adapters
// ============================================================
export interface AsaasPaymentConfig {
  apiKey: string;
  webhookToken: string;
  /** Base da API Asaas. Default: producao. Sandbox: https://sandbox.asaas.com/api/v3 */
  baseUrl?: string;
  /** Dias ate o vencimento da cobranca PIX. Default 1. */
  dueInDays?: number;
  /** fetch injetavel para teste. Default: globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

// ============================================================
// AsaasPaymentAdapter — implementacao real (HTTP).
// ============================================================
export class AsaasPaymentAdapter implements PaymentPort {
  private readonly apiKey: string;
  private readonly webhookToken: string;
  private readonly baseUrl: string;
  private readonly dueInDays: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AsaasPaymentConfig) {
    this.apiKey = config.apiKey;
    this.webhookToken = config.webhookToken;
    this.baseUrl = (config.baseUrl ?? 'https://api.asaas.com/v3').replace(/\/$/, '');
    this.dueInDays = config.dueInDays ?? 1;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      access_token: this.apiKey,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Asaas ${method} ${path} falhou: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Cria/garante o cliente no Asaas e gera a cobranca PIX.
   * Retorna o QR code + copia-e-cola para o checkout.
   */
  async createPixCharge(
    input: CreatePixChargeInput,
  ): Promise<CreatePixChargeResult> {
    // 1) cria cliente (Asaas deduplica por cpfCnpj/email no painel; aqui criamos simples)
    const customer = await this.request<{ id: string }>('POST', '/customers', {
      name: input.customer.name,
      email: input.customer.email,
      cpfCnpj: input.customer.cpfCnpj,
    });

    // 2) cria a cobranca PIX
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + this.dueInDays);
    const dueDateStr = dueDate.toISOString().slice(0, 10); // YYYY-MM-DD

    const payment = await this.request<{ id: string }>('POST', '/payments', {
      customer: customer.id,
      billingType: 'PIX',
      value: centsToReais(input.amountCents),
      dueDate: dueDateStr,
      description: input.description,
      externalReference: input.orderId,
    });

    // 3) busca o QR code PIX da cobranca
    const qr = await this.request<{
      encodedImage: string;
      payload: string;
      expirationDate?: string;
    }>('GET', `/payments/${payment.id}/pixQrCode`);

    return {
      providerPaymentId: payment.id,
      pixQrCode: qr.encodedImage,
      pixCopyPaste: qr.payload,
      dueDate,
    };
  }

  async getPayment(providerPaymentId: string): Promise<GetPaymentResult> {
    const payment = await this.request<{
      status: string;
      paymentDate?: string | null;
      clientPaymentDate?: string | null;
    }>('GET', `/payments/${providerPaymentId}`);

    const paidRaw = payment.paymentDate ?? payment.clientPaymentDate ?? null;
    return {
      status: mapAsaasStatus(payment.status),
      paidAt: paidRaw ? new Date(paidRaw) : null,
    };
  }

  /**
   * Valida e interpreta o webhook do Asaas.
   * Seguranca: o Asaas envia o token configurado no header `asaas-access-token`.
   * Comparamos com ASAAS_WEBHOOK_TOKEN.
   */
  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): ParseWebhookResult {
    const tokenHeader = headers['asaas-access-token'];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const valid = Boolean(this.webhookToken) && token === this.webhookToken;

    const payload = (body ?? {}) as {
      id?: string;
      event?: string;
      payment?: { id?: string; status?: string };
    };
    const event = payload.event ?? 'UNKNOWN';
    const status = mapAsaasEventToStatus(event) ?? mapAsaasStatus(payload.payment?.status);

    return {
      valid,
      event,
      provider: 'ASAAS',
      providerPaymentId: payload.payment?.id,
      // id do evento Asaas para idempotencia (@@unique([provider, externalEventId]))
      externalEventId: payload.id,
      status,
    };
  }
}

// ============================================================
// StubPaymentAdapter — PIX fake, confirmavel em memoria (dev/test).
// ============================================================
export interface StubChargeRecord {
  providerPaymentId: string;
  orderId: string;
  amountCents: number;
  status: PaymentStatus;
  paidAt: Date | null;
  pixCopyPaste: string;
}

export class StubPaymentAdapter implements PaymentPort {
  // Estado em memoria das cobrancas geradas (permite confirmar no teste).
  private readonly charges = new Map<string, StubChargeRecord>();
  private readonly webhookToken: string;

  constructor(config?: { webhookToken?: string }) {
    this.webhookToken = config?.webhookToken ?? 'stub-webhook-token';
  }

  async createPixCharge(
    input: CreatePixChargeInput,
  ): Promise<CreatePixChargeResult> {
    const providerPaymentId = `stub_pay_${nanoid(12)}`;
    const pixCopyPaste = `00020126STUBPIX${nanoid(20)}5204000053039865802BR`;
    const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

    this.charges.set(providerPaymentId, {
      providerPaymentId,
      orderId: input.orderId,
      amountCents: input.amountCents,
      status: 'PENDING',
      paidAt: null,
      pixCopyPaste,
    });

    return {
      providerPaymentId,
      // "QR code" fake: data URI base64 de placeholder.
      pixQrCode: `data:image/png;base64,STUBQR${Buffer.from(providerPaymentId).toString('base64')}`,
      pixCopyPaste,
      dueDate,
    };
  }

  async getPayment(providerPaymentId: string): Promise<GetPaymentResult> {
    const charge = this.charges.get(providerPaymentId);
    if (!charge) return { status: 'PENDING', paidAt: null };
    return { status: charge.status, paidAt: charge.paidAt };
  }

  /**
   * Helper de teste/dev: marca uma cobranca como liquidada e devolve um
   * payload de webhook valido (formato Asaas) para reinjetar na rota.
   */
  confirm(
    providerPaymentId: string,
    status: 'CONFIRMED' | 'RECEIVED' = 'RECEIVED',
  ): { headers: Record<string, string>; body: unknown } {
    const charge = this.charges.get(providerPaymentId);
    if (charge) {
      charge.status = status;
      charge.paidAt = new Date();
    }
    const event = status === 'RECEIVED' ? 'PAYMENT_RECEIVED' : 'PAYMENT_CONFIRMED';
    return {
      headers: { 'asaas-access-token': this.webhookToken },
      body: {
        // id deterministico por (pagamento,evento) -> idempotencia testavel
        id: `evt_${providerPaymentId}_${event}`,
        event,
        payment: { id: providerPaymentId, status },
      },
    };
  }

  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): ParseWebhookResult {
    const tokenHeader = headers['asaas-access-token'];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const valid = token === this.webhookToken;

    const payload = (body ?? {}) as {
      id?: string;
      event?: string;
      payment?: { id?: string; status?: string };
    };
    const event = payload.event ?? 'UNKNOWN';
    const status = mapAsaasEventToStatus(event) ?? mapAsaasStatus(payload.payment?.status);

    return {
      valid,
      event,
      provider: 'ASAAS',
      providerPaymentId: payload.payment?.id,
      externalEventId: payload.id,
      status,
    };
  }
}

// ============================================================
// Factory — escolhe real<->stub por env.
// ============================================================
export interface PaymentAdapterEnv {
  USE_STUBS: boolean;
  PAYMENT_PROVIDER: 'asaas' | 'mercado_pago';
  ASAAS_API_KEY: string;
  ASAAS_WEBHOOK_TOKEN: string;
  ASAAS_BASE_URL?: string;
}

export function createPaymentAdapter(
  env: PaymentAdapterEnv,
  fetchImpl?: typeof fetch,
): PaymentPort {
  // Stub se USE_STUBS, sem chave configurada, ou provider ainda nao suportado.
  if (env.USE_STUBS || !env.ASAAS_API_KEY || env.PAYMENT_PROVIDER !== 'asaas') {
    return new StubPaymentAdapter({ webhookToken: env.ASAAS_WEBHOOK_TOKEN || undefined });
  }
  return new AsaasPaymentAdapter({
    apiKey: env.ASAAS_API_KEY,
    webhookToken: env.ASAAS_WEBHOOK_TOKEN,
    baseUrl: env.ASAAS_BASE_URL,
    fetchImpl,
  });
}
