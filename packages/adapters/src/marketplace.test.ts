// Testes do MarketplacePort (Hotmart + Kiwify) com StubMarketplaceAdapter +
// StubStorage. Cobre IDs deterministicos, parse/validacao de webhook por
// provedor, e os adapters reais via fetch mockado (OAuth Hotmart + create,
// Kiwify create + HMAC). Sem rede/DB real.

import { describe, it, expect, vi } from 'vitest';

import type { StoragePort, MarketplaceProductInput } from '@ebook-empire/core';
import {
  StubMarketplaceAdapter,
  HotmartMarketplaceAdapter,
  KiwifyMarketplaceAdapter,
  createMarketplaceAdapter,
  parseHotmartPayload,
  parseKiwifyPayload,
  verifyKiwifySignature,
} from './marketplace.js';

// StoragePort stub: getObject devolve um Buffer deterministico (PDF fake).
class StubStorage implements StoragePort {
  public readonly objects = new Map<string, Buffer>();
  async putObject(key: string, bytes: Buffer): Promise<void> {
    this.objects.set(key, bytes);
  }
  async getObject(key: string): Promise<Buffer> {
    return this.objects.get(key) ?? Buffer.from(`pdf:${key}`, 'utf-8');
  }
  async getSignedUrl(key: string): Promise<string> {
    return `https://stub/${key}`;
  }
}

const baseInput: MarketplaceProductInput = {
  productId: 'prod_1',
  name: 'Ebook X',
  description: 'desc',
  priceCents: 4700,
  affiliateCommissionPct: 50,
};

describe('StubMarketplaceAdapter', () => {
  it('cria produto com id deterministico por provider+productId', async () => {
    const hot = new StubMarketplaceAdapter({ provider: 'HOTMART' });
    const a = await hot.createProduct(baseInput);
    const b = await hot.createProduct(baseInput);
    expect(a.externalProductId).toBe('hotmart_prod_1');
    expect(b.externalProductId).toBe(a.externalProductId);
    expect(a.provider).toBe('HOTMART');
    expect(a.affiliateCommissionPct).toBe(50);
  });

  it('getProduct recupera o estado e updateProduct sobrescreve', async () => {
    const kiwi = new StubMarketplaceAdapter({ provider: 'KIWIFY' });
    const created = await kiwi.createProduct(baseInput);
    const got = await kiwi.getProduct(created.externalProductId);
    expect(got.externalProductId).toBe('kiwify_prod_1');
    const updated = await kiwi.updateProduct(created.externalProductId, {
      ...baseInput,
      affiliateCommissionPct: 70,
    });
    expect(updated.affiliateCommissionPct).toBe(70);
  });

  it('getProduct lanca para produto inexistente', async () => {
    const hot = new StubMarketplaceAdapter({ provider: 'HOTMART' });
    await expect(hot.getProduct('nao_existe')).rejects.toThrow(/nao encontrado/);
  });

  it('emitPurchase Hotmart gera webhook valido e parseavel', () => {
    const hot = new StubMarketplaceAdapter({
      provider: 'HOTMART',
      webhookSecret: 'secret-h',
    });
    const hook = hot.emitPurchase({
      externalProductId: 'hotmart_prod_1',
      externalOrderId: 'ORD-1',
      amountCents: 4700,
      buyerEmail: 'b@ex.com',
    });
    const parsed = hot.parseWebhook(hook.headers, hook.body);
    expect(parsed.valid).toBe(true);
    expect(parsed.provider).toBe('HOTMART');
    expect(parsed.externalProductId).toBe('hotmart_prod_1');
    expect(parsed.externalOrderId).toBe('ORD-1');
    expect(parsed.externalEventId).toBe('ORD-1');
    expect(parsed.amountCents).toBe(4700);
    expect(parsed.buyerEmail).toBe('b@ex.com');
  });

  it('emitPurchase Kiwify gera assinatura HMAC valida', () => {
    const kiwi = new StubMarketplaceAdapter({
      provider: 'KIWIFY',
      webhookSecret: 'secret-k',
    });
    const hook = kiwi.emitPurchase({
      externalProductId: 'kiwify_prod_1',
      externalOrderId: 'KORD-1',
      amountCents: 3700,
      buyerEmail: 'k@ex.com',
    });
    const parsed = kiwi.parseWebhook(hook.headers, hook.body);
    expect(parsed.valid).toBe(true);
    expect(parsed.provider).toBe('KIWIFY');
    expect(parsed.externalOrderId).toBe('KORD-1');
    expect(parsed.amountCents).toBe(3700);
  });

  it('rejeita webhook com token/assinatura invalidos', () => {
    const hot = new StubMarketplaceAdapter({ provider: 'HOTMART', webhookSecret: 's' });
    expect(
      hot.parseWebhook({ 'hotmart-hottok': 'errado' }, { event: 'PURCHASE_COMPLETE' }).valid,
    ).toBe(false);
    const kiwi = new StubMarketplaceAdapter({ provider: 'KIWIFY', webhookSecret: 's' });
    expect(
      kiwi.parseWebhook({ 'x-kiwify-signature': 'deadbeef' }, { order_id: 'x' }).valid,
    ).toBe(false);
  });
});

describe('parsers de webhook (sem validacao)', () => {
  it('parseHotmartPayload normaliza ucode/transaction/price', () => {
    const r = parseHotmartPayload(true, {
      id: 'evt1',
      event: 'PURCHASE_COMPLETE',
      data: {
        product: { ucode: 'UC-9' },
        purchase: { transaction: 'TX-9', price: { value: 47 } },
        buyer: { email: 'a@b.com' },
      },
    });
    expect(r.externalProductId).toBe('UC-9');
    expect(r.externalOrderId).toBe('TX-9');
    expect(r.amountCents).toBe(4700);
    expect(r.buyerEmail).toBe('a@b.com');
  });

  it('parseKiwifyPayload normaliza Product/order_id/charge_amount', () => {
    const r = parseKiwifyPayload(true, {
      webhook_event_type: 'order_approved',
      order_id: 'KO-1',
      Product: { id: 'KP-1' },
      Customer: { email: 'c@d.com' },
      Commissions: { charge_amount: 37 },
    });
    expect(r.externalProductId).toBe('KP-1');
    expect(r.externalOrderId).toBe('KO-1');
    expect(r.amountCents).toBe(3700);
    expect(r.buyerEmail).toBe('c@d.com');
  });

  it('verifyKiwifySignature confere o HMAC do corpo', () => {
    const body = { order_id: 'X', a: 1 };
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', 'sk').update(JSON.stringify(body)).digest('hex');
    expect(verifyKiwifySignature('sk', body, sig)).toBe(true);
    expect(verifyKiwifySignature('sk', body, 'ffff')).toBe(false);
  });
});

describe('HotmartMarketplaceAdapter (real, fetch mockado)', () => {
  it('faz OAuth + createProduct e normaliza o resultado', async () => {
    const storage = new StubStorage();
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/security/oauth/token')) {
        return new Response(
          JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (String(url).includes('/products/v1.0.0/product')) {
        return new Response(
          JSON.stringify({ ucode: 'UC-1', url: 'https://hotmart/p/UC-1' }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const adapter = new HotmartMarketplaceAdapter({
      clientId: 'id',
      clientSecret: 'sec',
      webhookToken: 'wt',
      storage,
      fetchImpl,
    });
    const result = await adapter.createProduct(baseInput);
    expect(result.externalProductId).toBe('UC-1');
    expect(result.marketplaceUrl).toContain('UC-1');
    // token cacheado: createProduct chama OAuth uma vez.
    const oauthCalls = (fetchImpl as any).mock.calls.filter((c: any[]) =>
      String(c[0]).includes('oauth'),
    );
    expect(oauthCalls.length).toBe(1);
  });

  it('uploadPdf le bytes do storage e envia multipart', async () => {
    const storage = new StubStorage();
    await storage.putObject('ebooks/x.pdf', Buffer.from('PDFDATA'));
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('oauth')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new HotmartMarketplaceAdapter({
      clientId: 'id',
      clientSecret: 'sec',
      webhookToken: 'wt',
      storage,
      fetchImpl,
    });
    await adapter.uploadPdf('UC-1', 'ebooks/x.pdf');
    const uploadCall = (fetchImpl as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes('/file'),
    );
    expect(uploadCall).toBeTruthy();
    expect(uploadCall[1].body).toBeInstanceOf(FormData);
  });
});

describe('KiwifyMarketplaceAdapter (real, fetch mockado)', () => {
  it('createProduct usa x-api-key e normaliza checkout_url', async () => {
    const storage = new StubStorage();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: 'KP-1', checkout_url: 'https://kiwify/c/KP-1' }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const adapter = new KiwifyMarketplaceAdapter({
      apiKey: 'k',
      accountId: 'acc',
      webhookSecret: 'ws',
      storage,
      fetchImpl,
    });
    const result = await adapter.createProduct(baseInput);
    expect(result.externalProductId).toBe('KP-1');
    expect(result.marketplaceUrl).toContain('KP-1');
    const headers = (fetchImpl as any).mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('k');
  });
});

describe('createMarketplaceAdapter (factory gated por USE_STUBS)', () => {
  it('USE_STUBS=true devolve stubs para ambos provedores', async () => {
    const storage = new StubStorage();
    const bundle = createMarketplaceAdapter(
      {
        USE_STUBS: true,
        HOTMART_CLIENT_ID: 'id',
        HOTMART_CLIENT_SECRET: 'sec',
        HOTMART_WEBHOOK_TOKEN: 'wt',
        KIWIFY_API_KEY: 'k',
        KIWIFY_ACCOUNT_ID: 'acc',
        KIWIFY_WEBHOOK_SECRET: 'ws',
      },
      storage,
    );
    expect(bundle.HOTMART).toBeInstanceOf(StubMarketplaceAdapter);
    expect(bundle.KIWIFY).toBeInstanceOf(StubMarketplaceAdapter);
  });

  it('USE_STUBS=false com chaves devolve adapters reais', async () => {
    const storage = new StubStorage();
    const bundle = createMarketplaceAdapter(
      {
        USE_STUBS: false,
        HOTMART_CLIENT_ID: 'id',
        HOTMART_CLIENT_SECRET: 'sec',
        HOTMART_WEBHOOK_TOKEN: 'wt',
        KIWIFY_API_KEY: 'k',
        KIWIFY_ACCOUNT_ID: 'acc',
        KIWIFY_WEBHOOK_SECRET: 'ws',
      },
      storage,
    );
    expect(bundle.HOTMART).toBeInstanceOf(HotmartMarketplaceAdapter);
    expect(bundle.KIWIFY).toBeInstanceOf(KiwifyMarketplaceAdapter);
  });
});
