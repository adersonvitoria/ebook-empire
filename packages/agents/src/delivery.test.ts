// Testes do DeliveryAgent: fluxo PAID -> grant -> email, idempotencia (sem
// pedidos pendentes => SKIPPED) e helpers de token (>=32 bytes, hash sha256 estavel).

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AgentContext } from './base.js';
import {
  DeliveryAgent,
  generateDeliveryToken,
  hashDeliveryToken,
} from './delivery.js';

// ------------------------------------------------------------
// Fake Prisma minimo cobrindo apenas as operacoes usadas pelo DeliveryAgent.
// Mantem estado em memoria para validar o efeito colateral do run.
// ------------------------------------------------------------
interface FakeOrder {
  id: string;
  customerId: string;
  productId: string;
  ebookId: string;
  status: string;
  priceCents: number;
  paidAt: Date | null;
  deliveredAt: Date | null;
  hasGrant: boolean;
  customer: { name: string | null; email: string };
  ebook: { title: string };
}

function makeFakePrisma(orders: FakeOrder[]) {
  const grants: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const orderUpdates: Array<Record<string, unknown>> = [];

  const prisma = {
    order: {
      findMany: vi.fn(async (args: { where: { status: string } }) => {
        // Espelha o filtro do agente: PAID e sem grant.
        return orders.filter(
          (o) => o.status === args.where.status && !o.hasGrant,
        );
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const o = orders.find((x) => x.id === args.where.id);
        if (o) {
          o.status = (args.data.status as string) ?? o.status;
          o.deliveredAt = (args.data.deliveredAt as Date) ?? o.deliveredAt;
        }
        orderUpdates.push(args.data);
        return o;
      }),
    },
    deliveryGrant: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        // Simula orderId @unique.
        if (grants.some((g) => g.orderId === args.data.orderId)) {
          throw new Error('Unique constraint failed: orderId');
        }
        const o = orders.find((x) => x.id === args.data.orderId);
        if (o) o.hasGrant = true;
        grants.push({ ...args.data });
        return { id: `grant-${grants.length}`, ...args.data };
      }),
      update: vi.fn(async (args: { where: { orderId: string }; data: Record<string, unknown> }) => {
        const g = grants.find((x) => x.orderId === args.where.orderId);
        if (g) Object.assign(g, args.data);
        return g;
      }),
    },
    event: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        events.push(args.data);
        return { id: `evt-${events.length}`, ...args.data };
      }),
    },
    // $transaction recebe array de promessas ja iniciadas.
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  return { prisma, grants, events, orderUpdates };
}

function makeCtx(prisma: unknown, email: { send: ReturnType<typeof vi.fn> }): AgentContext {
  const fixedNow = new Date('2026-06-10T12:00:00.000Z');
  return {
    prisma: prisma as AgentContext['prisma'],
    ports: {
      email: email as unknown,
    } as unknown as AgentContext['ports'],
    env: {
      ENABLE_AGENTS: true,
      MAX_AD_BUDGET_BRL: 300,
      TARGET_DAILY_REVENUE_BRL: 1000,
      PUBLIC_BASE_URL: 'http://localhost:3001',
      CONTENT_MODEL: 'claude-sonnet-4-6',
      PLANNING_MODEL: 'claude-opus-4-8',
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clock: { now: () => fixedNow },
  };
}

describe('helpers de token', () => {
  it('gera token base64url com >=32 bytes de entropia', () => {
    const t = generateDeliveryToken();
    // 32 bytes em base64url => ~43 chars; o schema exige min 16.
    expect(t.length).toBeGreaterThanOrEqual(43);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hash e sha256 hex estavel do token plano', () => {
    const t = 'token-plano-fixo';
    expect(hashDeliveryToken(t)).toBe(
      createHash('sha256').update(t).digest('hex'),
    );
  });

  it('tokens sucessivos sao distintos', () => {
    expect(generateDeliveryToken()).not.toBe(generateDeliveryToken());
  });
});

describe('DeliveryAgent.run', () => {
  function makeOrder(id: string): FakeOrder {
    return {
      id,
      customerId: `cust-${id}`,
      productId: `prod-${id}`,
      ebookId: `ebook-${id}`,
      status: 'PAID',
      priceCents: 4700,
      paidAt: new Date('2026-06-10T10:00:00.000Z'),
      deliveredAt: null,
      hasGrant: false,
      customer: { name: 'Maria', email: `maria-${id}@ex.com` },
      ebook: { title: `Ebook ${id}` },
    };
  }

  it('cria grant, envia email e marca pedido como DELIVERED', async () => {
    const order = makeOrder('1');
    const { prisma, grants, events } = makeFakePrisma([order]);
    const email = { send: vi.fn(async () => ({ messageId: 'msg-1' })) };
    const ctx = makeCtx(prisma, email);

    const agent = new DeliveryAgent();
    const result = await agent.run(ctx);

    expect(result.status).toBe('SUCCESS');
    expect((result.output as { delivered: number }).delivered).toBe(1);

    // Grant criado com hash (token plano nunca persistido) e parametros corretos.
    expect(grants).toHaveLength(1);
    const grant = grants[0]!;
    expect(typeof grant.tokenHash).toBe('string');
    expect((grant.tokenHash as string).length).toBe(64); // sha256 hex
    expect(grant.maxDownloads).toBe(5);
    expect(grant.status).toBe('ACTIVE'); // atualizado apos envio
    expect(grant.emailSentAt).toBeInstanceOf(Date);
    // expiresAt ~ +7 dias.
    const exp = grant.expiresAt as Date;
    expect(exp.getTime()).toBe(
      new Date('2026-06-10T12:00:00.000Z').getTime() + 7 * 24 * 3600 * 1000,
    );

    // Email enviado com link contendo o token plano.
    expect(email.send).toHaveBeenCalledOnce();
    const mail = (email.send.mock.calls[0] as unknown[])[0] as { to: string; html: string };
    expect(mail.to).toBe('maria-1@ex.com');
    expect(mail.html).toContain('http://localhost:3001/download/');

    // Pedido virou DELIVERED e evento de funil emitido.
    expect(order.status).toBe('DELIVERED');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('DELIVERED');
    expect(events[0]!.revenueCents).toBe(4700);
  });

  it('filtra pedidos de marketplace (marketplaceProvider: null no where)', async () => {
    const order = makeOrder('mkt');
    const { prisma } = makeFakePrisma([order]);
    const email = { send: vi.fn(async () => ({ messageId: 'm' })) };
    const ctx = makeCtx(prisma, email);

    await new DeliveryAgent().run(ctx);

    // O agente NUNCA entrega pedidos Hotmart/Kiwify (entrega nativa): a query
    // exige marketplaceProvider: null.
    const findManyArgs = (
      prisma.order.findMany as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(findManyArgs.where.marketplaceProvider).toBeNull();
  });

  it('e idempotente: sem pedidos PAID pendentes retorna SKIPPED', async () => {
    const { prisma } = makeFakePrisma([]);
    const email = { send: vi.fn() };
    const ctx = makeCtx(prisma, email);

    const result = await new DeliveryAgent().run(ctx);
    expect(result.status).toBe('SKIPPED');
    expect(email.send).not.toHaveBeenCalled();
  });

  it('nao reprocessa pedido que ja possui grant (segundo run pula)', async () => {
    const order = makeOrder('2');
    const { prisma } = makeFakePrisma([order]);
    const email = { send: vi.fn(async () => ({ messageId: 'm' })) };
    const ctx = makeCtx(prisma, email);
    const agent = new DeliveryAgent();

    await agent.run(ctx); // entrega
    email.send.mockClear();
    const second = await agent.run(ctx); // nada a fazer

    expect(second.status).toBe('SKIPPED');
    expect(email.send).not.toHaveBeenCalled();
  });

  it('propaga falha quando todas as entregas falham', async () => {
    const order = makeOrder('3');
    const { prisma } = makeFakePrisma([order]);
    const email = {
      send: vi.fn(async () => {
        throw new Error('SMTP fora do ar');
      }),
    };
    const ctx = makeCtx(prisma, email);

    await expect(new DeliveryAgent().run(ctx)).rejects.toThrow(/falharam/);
  });
});
