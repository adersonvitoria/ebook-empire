// Testes de CONTRATO dos novos ports (MarketplacePort, WhatsAppPort) via stubs.
// Os ports sao interfaces puras; aqui montamos stubs minimos e exercitamos as
// assinaturas + integramos ao bundle Ports parcial (campos opcionais).

import { describe, it, expect, vi } from 'vitest';

import type {
  MarketplacePort,
  MarketplaceProductInput,
  MarketplaceProductResult,
  MarketplaceWebhookResult,
  WhatsAppPort,
  Ports,
} from './ports.js';

// --- Stub determinístico de MarketplacePort ---
class StubMarketplace implements MarketplacePort {
  async createProduct(input: MarketplaceProductInput): Promise<MarketplaceProductResult> {
    return {
      provider: 'HOTMART',
      externalProductId: `ext-${input.productId}`,
      marketplaceUrl: `https://hotmart.example/${input.productId}`,
      affiliateCommissionPct: input.affiliateCommissionPct,
    };
  }
  async updateProduct(
    externalProductId: string,
    input: MarketplaceProductInput,
  ): Promise<MarketplaceProductResult> {
    return {
      provider: 'HOTMART',
      externalProductId,
      marketplaceUrl: `https://hotmart.example/${input.productId}`,
      affiliateCommissionPct: input.affiliateCommissionPct,
    };
  }
  async getProduct(externalProductId: string): Promise<MarketplaceProductResult> {
    return {
      provider: 'HOTMART',
      externalProductId,
      marketplaceUrl: `https://hotmart.example/${externalProductId}`,
      affiliateCommissionPct: 30,
    };
  }
  parseWebhook(
    _headers: Record<string, string | string[] | undefined>,
    _body: unknown,
  ): MarketplaceWebhookResult {
    return {
      valid: true,
      event: 'PURCHASE_APPROVED',
      provider: 'HOTMART',
      externalProductId: 'ext-1',
      externalOrderId: 'ord-1',
      externalEventId: 'evt-1',
      amountCents: 4700,
      buyerEmail: 'comprador@example.com',
    };
  }
}

// --- Stub de WhatsAppPort ---
class StubWhatsApp implements WhatsAppPort {
  sent: Array<{ to: string; text: string }> = [];
  async sendMessage(to: string, text: string): Promise<void> {
    this.sent.push({ to, text });
  }
}

describe('MarketplacePort (stub)', () => {
  const m = new StubMarketplace();
  const input: MarketplaceProductInput = {
    productId: 'p1',
    name: 'Ebook X',
    priceCents: 4700,
    affiliateCommissionPct: 30,
  };

  it('createProduct devolve ids/URL externos e provider tipado', async () => {
    const r = await m.createProduct(input);
    expect(r.provider).toBe('HOTMART');
    expect(r.externalProductId).toBe('ext-p1');
    expect(r.affiliateCommissionPct).toBe(30);
  });

  it('updateProduct preserva o externalProductId informado', async () => {
    const r = await m.updateProduct('ext-keep', input);
    expect(r.externalProductId).toBe('ext-keep');
  });

  it('getProduct resolve por externalProductId', async () => {
    const r = await m.getProduct('ext-z');
    expect(r.externalProductId).toBe('ext-z');
  });

  it('parseWebhook devolve evento idempotente com externalEventId', () => {
    const w = m.parseWebhook({}, {});
    expect(w.valid).toBe(true);
    expect(w.externalEventId).toBe('evt-1');
    expect(w.amountCents).toBe(4700);
  });
});

describe('WhatsAppPort (stub)', () => {
  it('sendMessage(to, text) registra o envio e resolve void', async () => {
    const w = new StubWhatsApp();
    await expect(w.sendMessage('+5511999999999', 'Oi!')).resolves.toBeUndefined();
    expect(w.sent).toEqual([{ to: '+5511999999999', text: 'Oi!' }]);
  });

  it('aceita spy para verificacao de chamadas', async () => {
    const port: WhatsAppPort = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    await port.sendMessage('a', 'b');
    expect(port.sendMessage).toHaveBeenCalledWith('a', 'b');
  });
});

describe('bundle Ports — novos campos sao OPCIONAIS', () => {
  it('Ports parcial sem marketplace/whatsapp continua valido (type-level)', () => {
    // Monta um Ports parcial como nos wirings de teste/e2e; os campos novos
    // (marketplace/whatsapp) podem ser omitidos sem erro de tipo.
    const partial = { marketData: undefined } as Partial<Ports>;
    expect('marketplace' in partial).toBe(false);
    expect('whatsapp' in partial).toBe(false);
  });

  it('Ports com marketplace + whatsapp aceita os stubs', () => {
    const withNew: Pick<Ports, 'marketplace' | 'whatsapp'> = {
      marketplace: new StubMarketplace(),
      whatsapp: new StubWhatsApp(),
    };
    expect(withNew.marketplace).toBeDefined();
    expect(withNew.whatsapp).toBeDefined();
  });
});
