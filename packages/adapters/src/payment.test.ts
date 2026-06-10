// Testes do adapter de pagamento — foco no StubPaymentAdapter (usado em dev/test)
// e no mapeamento de status/idempotencia do webhook.

import { describe, it, expect } from 'vitest';
import {
  StubPaymentAdapter,
  AsaasPaymentAdapter,
  mapAsaasStatus,
  createPaymentAdapter,
} from './payment.js';

describe('StubPaymentAdapter', () => {
  it('cria cobranca PIX com QR e copia-e-cola', async () => {
    const stub = new StubPaymentAdapter();
    const charge = await stub.createPixCharge({
      orderId: 'order_1',
      amountCents: 4700,
      customer: { name: 'Joao', email: 'joao@example.com' },
      description: 'Ebook teste',
    });

    expect(charge.providerPaymentId).toMatch(/^stub_pay_/);
    expect(charge.pixCopyPaste.length).toBeGreaterThan(20);
    expect(charge.pixQrCode).toContain('base64');
    expect(charge.dueDate).toBeInstanceOf(Date);
  });

  it('mantem PENDING ate ser confirmado', async () => {
    const stub = new StubPaymentAdapter();
    const charge = await stub.createPixCharge({
      orderId: 'order_2',
      amountCents: 4700,
      customer: { name: 'Maria', email: 'maria@example.com' },
      description: 'Ebook teste',
    });

    const before = await stub.getPayment(charge.providerPaymentId);
    expect(before.status).toBe('PENDING');
    expect(before.paidAt).toBeNull();

    stub.confirm(charge.providerPaymentId, 'RECEIVED');

    const after = await stub.getPayment(charge.providerPaymentId);
    expect(after.status).toBe('RECEIVED');
    expect(after.paidAt).toBeInstanceOf(Date);
  });

  it('confirm() produz webhook valido e parseavel (gatilho de entrega)', async () => {
    const stub = new StubPaymentAdapter({ webhookToken: 'tok-abc' });
    const charge = await stub.createPixCharge({
      orderId: 'order_3',
      amountCents: 9700,
      customer: { name: 'Ana', email: 'ana@example.com' },
      description: 'Ebook premium',
    });

    const hook = stub.confirm(charge.providerPaymentId, 'RECEIVED');
    const parsed = stub.parseWebhook(hook.headers, hook.body);

    expect(parsed.valid).toBe(true);
    expect(parsed.provider).toBe('ASAAS');
    expect(parsed.providerPaymentId).toBe(charge.providerPaymentId);
    expect(parsed.status).toBe('RECEIVED'); // gatilho de entrega
    expect(parsed.externalEventId).toBeTruthy();
  });

  it('confirm() gera externalEventId deterministico (idempotencia)', async () => {
    const stub = new StubPaymentAdapter({ webhookToken: 'tok-abc' });
    const charge = await stub.createPixCharge({
      orderId: 'order_4',
      amountCents: 4700,
      customer: { name: 'Bia', email: 'bia@example.com' },
      description: 'Ebook',
    });

    const a = stub.confirm(charge.providerPaymentId, 'RECEIVED');
    const b = stub.confirm(charge.providerPaymentId, 'RECEIVED');
    const pa = stub.parseWebhook(a.headers, a.body);
    const pb = stub.parseWebhook(b.headers, b.body);

    // Mesmo id => a rota detecta duplicidade pelo @@unique([provider, externalEventId]).
    expect(pa.externalEventId).toBe(pb.externalEventId);
  });

  it('rejeita webhook com token invalido', async () => {
    const stub = new StubPaymentAdapter({ webhookToken: 'tok-correto' });
    const parsed = stub.parseWebhook(
      { 'asaas-access-token': 'tok-errado' },
      { id: 'evt_x', event: 'PAYMENT_RECEIVED', payment: { id: 'p1', status: 'RECEIVED' } },
    );
    expect(parsed.valid).toBe(false);
  });
});

describe('mapAsaasStatus', () => {
  it('mapeia liquidacao para RECEIVED/CONFIRMED', () => {
    expect(mapAsaasStatus('CONFIRMED')).toBe('CONFIRMED');
    expect(mapAsaasStatus('RECEIVED')).toBe('RECEIVED');
    expect(mapAsaasStatus('RECEIVED_IN_CASH')).toBe('RECEIVED');
  });

  it('mapeia estados negativos e desconhecidos', () => {
    expect(mapAsaasStatus('OVERDUE')).toBe('OVERDUE');
    expect(mapAsaasStatus('REFUNDED')).toBe('REFUNDED');
    expect(mapAsaasStatus('QUALQUER_COISA')).toBe('PENDING');
    expect(mapAsaasStatus(undefined)).toBe('PENDING');
  });
});

describe('createPaymentAdapter (factory)', () => {
  it('retorna StubPaymentAdapter quando USE_STUBS=true', () => {
    const adapter = createPaymentAdapter({
      USE_STUBS: true,
      PAYMENT_PROVIDER: 'asaas',
      ASAAS_API_KEY: 'key',
      ASAAS_WEBHOOK_TOKEN: 'tok',
    });
    expect(adapter).toBeInstanceOf(StubPaymentAdapter);
  });

  it('cai no stub se nao houver ASAAS_API_KEY mesmo com USE_STUBS=false', () => {
    const adapter = createPaymentAdapter({
      USE_STUBS: false,
      PAYMENT_PROVIDER: 'asaas',
      ASAAS_API_KEY: '',
      ASAAS_WEBHOOK_TOKEN: 'tok',
    });
    expect(adapter).toBeInstanceOf(StubPaymentAdapter);
  });

  it('retorna AsaasPaymentAdapter (real) quando configurado', () => {
    const adapter = createPaymentAdapter({
      USE_STUBS: false,
      PAYMENT_PROVIDER: 'asaas',
      ASAAS_API_KEY: 'chave-real',
      ASAAS_WEBHOOK_TOKEN: 'tok',
    });
    expect(adapter).toBeInstanceOf(AsaasPaymentAdapter);
  });
});
