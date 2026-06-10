// Testes das rotas de webhook de marketplace (Fase 3 — Hotmart + Kiwify).
// Usa StubMarketplaceAdapter (USE_STUBS=true por env) + Prisma fake em memoria.
// Cobre: assinatura/token invalido (401), compra valida (Order PAID + Payment +
// Event, SEM DeliveryGrant), idempotencia (Event @@unique[provider,externalEventId]),
// atribuicao UTM de afiliado, e o contrato 200 { received, provider }.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// --- env minimo para carregar env.ts sem .env real ---
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.USE_STUBS = 'true';

// ------------------------------------------------------------
// Prisma fake em memoria (apenas os modelos/metodos usados pelas rotas).
// ------------------------------------------------------------
let seq = 0;
const id = (p: string) => `${p}_${++seq}`;

interface Store {
  customers: any[];
  products: any[];
  listings: any[];
  orders: any[];
  payments: any[];
  events: any[];
  grants: any[];
}
let store: Store;

class P2002Error extends Error {
  code = 'P2002';
  constructor() {
    super('Unique constraint failed');
    this.name = 'PrismaClientKnownRequestError';
  }
}

const prismaMock = {
  marketplaceListing: {
    findFirst: async ({ where, include }: any) => {
      const l = store.listings.find(
        (x) =>
          x.provider === where.provider &&
          x.externalProductId === where.externalProductId,
      );
      if (!l) return null;
      if (include?.product) {
        return { ...l, product: store.products.find((p) => p.id === l.productId) };
      }
      return l;
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
      const o = { id: id('order'), ...data };
      store.orders.push(o);
      return o;
    },
    update: async ({ where, data }: any) => {
      const o = store.orders.find((x) => x.id === where.id);
      Object.assign(o, data);
      return o;
    },
    findFirst: async ({ where }: any) =>
      store.orders.find(
        (x) =>
          x.marketplaceProvider === where.marketplaceProvider &&
          x.externalOrderId === where.externalOrderId,
      ) ?? null,
  },
  payment: {
    create: async ({ data }: any) => {
      const p = { id: id('pay'), ...data };
      store.payments.push(p);
      return p;
    },
    findFirst: async ({ where }: any) =>
      store.payments.find((x) => x.orderId === where.orderId) ?? null,
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

// Mocks dos modulos importados pelas rotas.
vi.mock('../../db.js', () => ({ prisma: prismaMock }));
vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: P2002Error },
}));
// O barrel @ebook-empire/adapters aponta para ./dist; resolvemos via os fontes.
vi.mock('@ebook-empire/adapters', async () => {
  const mkt = await import('../../../../../packages/adapters/src/marketplace.js');
  const st = await import('../../../../../packages/adapters/src/storage.js');
  return {
    createHotmartAdapter: mkt.createHotmartAdapter,
    createKiwifyAdapter: mkt.createKiwifyAdapter,
    createStorageAdapter: st.createStorageAdapter,
  };
});

let app: FastifyInstance;
let hotmartStub: any;
let kiwifyStub: any;

beforeAll(async () => {
  const hotmartMod = await import('./hotmart.js');
  const kiwifyMod = await import('./kiwify.js');
  hotmartStub = (hotmartMod as any)._hotmartPort;
  kiwifyStub = (kiwifyMod as any)._kiwifyPort;
  app = Fastify();
  await app.register(hotmartMod.default);
  await app.register(kiwifyMod.default);
  await app.ready();
});

beforeEach(() => {
  seq = 0;
  store = {
    customers: [],
    products: [
      {
        id: 'prod_h',
        ebookId: 'ebook_h',
        name: 'Ebook Hotmart',
        description: 'desc',
        priceCents: 4700,
        currency: 'BRL',
      },
      {
        id: 'prod_k',
        ebookId: 'ebook_k',
        name: 'Ebook Kiwify',
        description: 'desc',
        priceCents: 3700,
        currency: 'BRL',
      },
    ],
    listings: [
      {
        id: 'list_h',
        productId: 'prod_h',
        provider: 'HOTMART',
        externalProductId: 'hotmart_prod_h',
      },
      {
        id: 'list_k',
        productId: 'prod_k',
        provider: 'KIWIFY',
        externalProductId: 'kiwify_prod_k',
      },
    ],
    orders: [],
    payments: [],
    events: [],
    grants: [],
  };
});

describe('POST /webhooks/hotmart', () => {
  it('responde 200 com provider HOTMART numa compra valida e cria Order PAID', async () => {
    const hook = hotmartStub.emitPurchase({
      externalProductId: 'hotmart_prod_h',
      externalOrderId: 'HP-001',
      amountCents: 4700,
      buyerEmail: 'comprador@ex.com',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/hotmart',
      headers: hook.headers,
      payload: hook.body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, provider: 'HOTMART' });

    const order = store.orders[0];
    expect(order.status).toBe('PAID');
    expect(order.marketplaceProvider).toBe('HOTMART');
    expect(order.externalOrderId).toBe('HP-001');
    expect(store.payments[0].provider).toBe('HOTMART');
    expect(store.events.some((e) => e.type === 'PAID')).toBe(true);
    // NAO cria DeliveryGrant (Hotmart entrega nativamente).
    expect(store.grants).toHaveLength(0);
  });

  it('rejeita 401 quando o HOTMART-HOTTOK e invalido', async () => {
    const hook = hotmartStub.emitPurchase({
      externalProductId: 'hotmart_prod_h',
      externalOrderId: 'HP-002',
      amountCents: 4700,
      buyerEmail: 'x@ex.com',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/hotmart',
      headers: { 'hotmart-hottok': 'token-errado' },
      payload: hook.body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('e idempotente: webhook repetido nao duplica Event PAID', async () => {
    const hook = hotmartStub.emitPurchase({
      externalProductId: 'hotmart_prod_h',
      externalOrderId: 'HP-003',
      amountCents: 4700,
      buyerEmail: 'dup@ex.com',
    });
    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/hotmart',
      headers: hook.headers,
      payload: hook.body,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/hotmart',
      headers: hook.headers,
      payload: hook.body,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().idempotent).toBe(true);
    expect(store.events.filter((e) => e.type === 'PAID')).toHaveLength(1);
  });

  it('grava UTM de afiliado quando ha referral', async () => {
    const hook = hotmartStub.emitPurchase({
      externalProductId: 'hotmart_prod_h',
      externalOrderId: 'HP-004',
      amountCents: 4700,
      buyerEmail: 'ref@ex.com',
      affiliateId: 'AFF-123',
    });
    await app.inject({
      method: 'POST',
      url: '/webhooks/hotmart',
      headers: hook.headers,
      payload: hook.body,
    });
    const order = store.orders[0];
    expect(order.utmSource).toBe('hotmart');
    expect(order.utmMedium).toBe('afiliado');
    expect(order.utmContent).toBe('AFF-123');
  });

  it('aceita 200 ignorando produto desconhecido', async () => {
    const hook = hotmartStub.emitPurchase({
      externalProductId: 'inexistente',
      externalOrderId: 'HP-005',
      amountCents: 4700,
      buyerEmail: 'y@ex.com',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/hotmart',
      headers: hook.headers,
      payload: hook.body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe('unknown_product');
    expect(store.orders).toHaveLength(0);
  });
});

describe('POST /webhooks/kiwify', () => {
  it('responde 200 com provider KIWIFY numa compra valida e cria Order PAID', async () => {
    const hook = kiwifyStub.emitPurchase({
      externalProductId: 'kiwify_prod_k',
      externalOrderId: 'KP-001',
      amountCents: 3700,
      buyerEmail: 'comprador@ex.com',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/kiwify',
      headers: hook.headers,
      payload: hook.body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, provider: 'KIWIFY' });

    const order = store.orders[0];
    expect(order.status).toBe('PAID');
    expect(order.marketplaceProvider).toBe('KIWIFY');
    expect(store.payments[0].provider).toBe('KIWIFY');
    expect(store.events.some((e) => e.type === 'PAID')).toBe(true);
    expect(store.grants).toHaveLength(0);
  });

  it('rejeita 401 quando a assinatura HMAC e invalida', async () => {
    const hook = kiwifyStub.emitPurchase({
      externalProductId: 'kiwify_prod_k',
      externalOrderId: 'KP-002',
      amountCents: 3700,
      buyerEmail: 'x@ex.com',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/kiwify',
      headers: { 'x-kiwify-signature': 'deadbeef' },
      payload: hook.body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('e idempotente: webhook repetido nao duplica Event PAID', async () => {
    const hook = kiwifyStub.emitPurchase({
      externalProductId: 'kiwify_prod_k',
      externalOrderId: 'KP-003',
      amountCents: 3700,
      buyerEmail: 'dup@ex.com',
    });
    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/kiwify',
      headers: hook.headers,
      payload: hook.body,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/kiwify',
      headers: hook.headers,
      payload: hook.body,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().idempotent).toBe(true);
    expect(store.events.filter((e) => e.type === 'PAID')).toHaveLength(1);
  });
});
