// Teste de integracao do fluxo checkout -> webhook -> Order PAID.
// Usa StubPaymentAdapter (USE_STUBS=true por env de teste) e um Prisma fake
// em memoria. Cobre o caminho feliz + idempotencia do webhook.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// --- env minimo para carregar env.ts sem .env real ---
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.USE_STUBS = 'true';
process.env.ASAAS_WEBHOOK_TOKEN = 'stub-webhook-token';

// ------------------------------------------------------------
// Prisma fake em memoria (apenas os modelos/metodos usados pela rota).
// ------------------------------------------------------------
let seq = 0;
const id = (p: string) => `${p}_${++seq}`;

interface Store {
  customers: any[];
  products: any[];
  orders: any[];
  payments: any[];
  events: any[];
}
let store: Store;

// Simula a colisao @@unique([provider, externalEventId]) do Event.
class P2002Error extends Error {
  code = 'P2002';
  constructor() {
    super('Unique constraint failed');
    this.name = 'PrismaClientKnownRequestError';
  }
}

const prismaMock = {
  product: {
    findUnique: async ({ where }: any) => {
      const p = store.products.find((x) => x.slug === where.slug);
      if (!p) return null;
      return { ...p, ebook: store.products.length ? p._ebook : null };
    },
  },
  customer: {
    upsert: async ({ where, create, update }: any) => {
      let c = store.customers.find((x) => x.email === where.email);
      if (c) {
        Object.assign(c, update);
        return c;
      }
      c = { id: id('cust'), ...create };
      store.customers.push(c);
      return c;
    },
  },
  order: {
    create: async ({ data }: any) => {
      const o = { id: id('order'), paidAt: null, asaasPaymentId: null, ...data };
      store.orders.push(o);
      return o;
    },
    update: async ({ where, data }: any) => {
      const o = store.orders.find((x) => x.id === where.id);
      Object.assign(o, data);
      return o;
    },
    findUnique: async ({ where }: any) =>
      store.orders.find((x) => x.id === where.id) ?? null,
    findMany: async () => store.orders,
    count: async () => store.orders.length,
  },
  payment: {
    create: async ({ data }: any) => {
      const p = { id: id('pay'), paidAt: null, ...data };
      store.payments.push(p);
      return p;
    },
    update: async ({ where, data }: any) => {
      const p = store.payments.find((x) => x.id === where.id);
      Object.assign(p, data);
      return p;
    },
    findFirst: async ({ where, include }: any) => {
      const p = store.payments.find(
        (x) =>
          x.provider === where.provider &&
          x.providerPaymentId === where.providerPaymentId,
      );
      if (!p) return null;
      if (include?.order) {
        return { ...p, order: store.orders.find((o) => o.id === p.orderId) };
      }
      return p;
    },
  },
  event: {
    create: async ({ data }: any) => {
      if (data.provider && data.externalEventId) {
        const dup = store.events.find(
          (e) =>
            e.provider === data.provider &&
            e.externalEventId === data.externalEventId,
        );
        if (dup) throw new P2002Error();
      }
      const e = { id: id('evt'), ...data };
      store.events.push(e);
      return e;
    },
  },
};

// Mock dos modulos importados pela rota.
vi.mock('../db.js', () => ({ prisma: prismaMock }));
vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: P2002Error },
}));
// O barrel @ebook-empire/adapters aponta para ./dist (nao buildado no teste);
// resolvemos via o fonte do adapter de pagamento diretamente.
vi.mock('@ebook-empire/adapters', async () => {
  const mod = await import('../../../../packages/adapters/src/payment.js');
  return { createPaymentAdapter: mod.createPaymentAdapter };
});

let app: FastifyInstance;
let stubPayment: any;

beforeAll(async () => {
  const routeMod = await import('./checkout.js');
  stubPayment = (routeMod as any)._paymentPort;
  app = Fastify();
  await app.register(routeMod.default);
  await app.ready();
});

beforeEach(() => {
  seq = 0;
  const ebook = { id: 'ebook_1', title: 'Ebook Teste', slug: 'ebook-teste' };
  store = {
    customers: [],
    products: [
      {
        id: 'prod_1',
        ebookId: 'ebook_1',
        name: 'Ebook Teste',
        slug: 'ebook-teste-oferta',
        priceCents: 4700,
        currency: 'BRL',
        active: true,
        _ebook: ebook,
      },
    ],
    orders: [],
    payments: [],
    events: [],
  };
});

describe('POST /checkout -> POST /webhooks/asaas', () => {
  it('cria Order AWAITING_PAYMENT e cobranca PIX', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: {
        productSlug: 'ebook-teste-oferta',
        customer: { name: 'Joao', email: 'joao@example.com' },
        utm: { utmSource: 'instagram', utmCampaign: 'lancamento' },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('AWAITING_PAYMENT');
    expect(body.amountCents).toBe(4700);
    expect(body.pixCopyPaste).toBeTruthy();
    expect(body.pixQrCode).toBeTruthy();

    // Order e Payment persistidos; evento CHECKOUT_STARTED emitido.
    expect(store.orders).toHaveLength(1);
    expect(store.payments).toHaveLength(1);
    expect(store.events.some((e) => e.type === 'CHECKOUT_STARTED')).toBe(true);
  });

  it('webhook confirmado marca Order PAID e emite evento PAID', async () => {
    const checkout = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: {
        productSlug: 'ebook-teste-oferta',
        customer: { name: 'Maria', email: 'maria@example.com' },
      },
    });
    const { orderId } = checkout.json();
    const providerPaymentId = store.payments[0].providerPaymentId;

    // Gera webhook valido via stub.
    const hook = stubPayment.confirm(providerPaymentId, 'RECEIVED');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/asaas',
      headers: hook.headers,
      payload: hook.body,
    });

    expect(res.statusCode).toBe(200);
    const order = store.orders.find((o) => o.id === orderId);
    expect(order.status).toBe('PAID');
    expect(order.paidAt).toBeInstanceOf(Date);
    expect(store.payments[0].status).toBe('RECEIVED');
    expect(store.events.some((e) => e.type === 'PAID')).toBe(true);
  });

  it('webhook duplicado e idempotente (nao reprocessa)', async () => {
    await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: {
        productSlug: 'ebook-teste-oferta',
        customer: { name: 'Ana', email: 'ana@example.com' },
      },
    });
    const providerPaymentId = store.payments[0].providerPaymentId;
    const hook = stubPayment.confirm(providerPaymentId, 'RECEIVED');

    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/asaas',
      headers: hook.headers,
      payload: hook.body,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/asaas',
      headers: hook.headers,
      payload: hook.body,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().idempotent).toBe(true);

    // Apenas UM evento PAID, mesmo com dois webhooks.
    const paidEvents = store.events.filter((e) => e.type === 'PAID');
    expect(paidEvents).toHaveLength(1);
  });

  it('rejeita webhook com token invalido', async () => {
    await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: {
        productSlug: 'ebook-teste-oferta',
        customer: { name: 'Bia', email: 'bia@example.com' },
      },
    });
    const providerPaymentId = store.payments[0].providerPaymentId;
    const hook = stubPayment.confirm(providerPaymentId, 'RECEIVED');

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/asaas',
      headers: { 'asaas-access-token': 'token-errado' },
      payload: hook.body,
    });

    expect(res.statusCode).toBe(401);
  });

  it('404 para produto inexistente', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: {
        productSlug: 'nao-existe',
        customer: { name: 'X', email: 'x@example.com' },
      },
    });
    expect(res.statusCode).toBe(404);
  });
});
