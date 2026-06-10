// Webhook Kiwify — Fase 3 (marketplace).
//   POST /webhooks/kiwify
// Mesmo padrao do webhook Hotmart, com validacao HMAC-SHA256 (X-Kiwify-Signature)
// feita dentro de MarketplacePort.parseWebhook (KIWIFY).
// Fluxo:
//   1) valida assinatura via parseWebhook (KIWIFY).
//   2) parseia o evento (paid/order_approved vs refunded/chargeback).
//   3) acha o Product via MarketplaceListing.externalProductId (provider KIWIFY).
//   4) upsert Customer por email.
//   5) cria Order(status=PAID, marketplaceProvider='KIWIFY') + Payment(KIWIFY) —
//      NAO cria DeliveryGrant (Kiwify entrega nativamente).
//   6) grava Event idempotente (provider='KIWIFY', externalEventId=order_id).
// UTM: referral => utmSource='kiwify', utmMedium='afiliado', utmContent=affiliateId.
//
// Contrato preservado: 200 { received, provider:'KIWIFY' } no caminho feliz
// (cobre webhooks.test.ts).

import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { createKiwifyAdapter, createStorageAdapter } from '@ebook-empire/adapters';

import { prisma } from '../../db.js';
import { env } from '../../env.js';

const storage = createStorageAdapter({
  driver: 'local',
  storageDir: env.STORAGE_DIR,
  signingSecret: env.JWT_SECRET,
  publicBaseUrl: env.PUBLIC_BASE_URL,
});

// MarketplacePort (Kiwify) unico por processo (stub mantem estado em memoria).
const kiwify = createKiwifyAdapter(
  {
    USE_STUBS: env.USE_STUBS,
    HOTMART_CLIENT_ID: env.HOTMART_CLIENT_ID,
    HOTMART_CLIENT_SECRET: env.HOTMART_CLIENT_SECRET,
    HOTMART_WEBHOOK_TOKEN: env.HOTMART_WEBHOOK_TOKEN,
    KIWIFY_API_KEY: env.KIWIFY_API_KEY,
    KIWIFY_ACCOUNT_ID: env.KIWIFY_ACCOUNT_ID,
    KIWIFY_WEBHOOK_SECRET: env.KIWIFY_WEBHOOK_SECRET,
    MARKETPLACE_AFFILIATE_COMMISSION_PCT:
      env.MARKETPLACE_AFFILIATE_COMMISSION_PCT,
  },
  storage,
);

// Exportado para testes (injecao do stub compartilhado).
export const _kiwifyPort = kiwify;

// Eventos/status da Kiwify que sinalizam compra paga.
function isPaidEvent(event: string): boolean {
  const e = event.toLowerCase();
  return e === 'paid' || e === 'order_approved' || e === 'approved';
}
function isRefundEvent(event: string): boolean {
  const e = event.toLowerCase();
  return (
    e === 'refunded' ||
    e === 'order_refunded' ||
    e === 'chargedback' ||
    e === 'chargeback'
  );
}

// Extrai affiliateId do payload bruto (referral).
function extractAffiliateId(body: unknown): string | undefined {
  const p = (body ?? {}) as { affiliate_id?: string; Affiliate?: { id?: string } };
  const id = p.affiliate_id ?? p.Affiliate?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export default async function kiwifyWebhookRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post('/webhooks/kiwify', async (request, reply) => {
    const result = kiwify.parseWebhook(request.headers, request.body);
    if (!result.valid) {
      return reply.code(401).send({ error: 'invalid_webhook_signature' });
    }

    const paid = isPaidEvent(result.event);
    const refund = isRefundEvent(result.event);

    if (!paid && !refund) {
      return reply.code(200).send({ received: true, provider: 'KIWIFY', ignored: result.event });
    }

    if (!result.externalProductId || !result.externalEventId) {
      return reply.code(200).send({ received: true, provider: 'KIWIFY', ignored: 'incomplete_payload' });
    }

    const listing = await prisma.marketplaceListing.findFirst({
      where: { provider: 'KIWIFY', externalProductId: result.externalProductId },
      include: { product: true },
    });
    if (!listing) {
      return reply.code(200).send({ received: true, provider: 'KIWIFY', ignored: 'unknown_product' });
    }
    const product = listing.product;

    // ---- REFUND ----
    if (refund) {
      const order = await prisma.order.findFirst({
        where: {
          marketplaceProvider: 'KIWIFY',
          externalOrderId: result.externalOrderId ?? undefined,
        },
      });
      try {
        await prisma.event.create({
          data: {
            type: 'REFUNDED',
            provider: 'KIWIFY',
            externalEventId: result.externalEventId,
            productId: product.id,
            orderId: order?.id ?? null,
            customerId: order?.customerId ?? null,
            payload: (request.body ?? {}) as Prisma.InputJsonValue,
            processedAt: new Date(),
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return reply.code(200).send({ received: true, provider: 'KIWIFY', idempotent: true });
        }
        throw err;
      }
      if (order && order.status !== 'REFUNDED') {
        await prisma.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
      }
      return reply.code(200).send({ received: true, provider: 'KIWIFY', refunded: true });
    }

    // ---- PAID ----
    const buyerEmail = result.buyerEmail ?? `unknown+${result.externalEventId}@kiwify.local`;
    const amountCents = result.amountCents ?? product.priceCents;
    const affiliateId = extractAffiliateId(request.body);

    const customer = await prisma.customer.upsert({
      where: { email: buyerEmail },
      update: {},
      create: { email: buyerEmail },
    });

    let order = await prisma.order.findFirst({
      where: { marketplaceProvider: 'KIWIFY', externalOrderId: result.externalOrderId ?? undefined },
    });

    if (!order) {
      order = await prisma.order.create({
        data: {
          customerId: customer.id,
          productId: product.id,
          ebookId: product.ebookId,
          status: 'PAID',
          priceCents: amountCents,
          currency: product.currency,
          paidAt: new Date(),
          marketplaceProvider: 'KIWIFY',
          externalOrderId: result.externalOrderId ?? null,
          utmSource: affiliateId ? 'kiwify' : null,
          utmMedium: affiliateId ? 'afiliado' : null,
          utmContent: affiliateId ?? null,
        },
      });
    }

    const paymentRow = await prisma.payment.findFirst({ where: { orderId: order.id } });
    if (!paymentRow) {
      await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: 'KIWIFY',
          method: 'CREDIT_CARD',
          providerPaymentId: result.externalOrderId ?? result.externalEventId,
          status: 'RECEIVED',
          amountCents,
          currency: product.currency,
          paidAt: new Date(),
          raw: (request.body ?? {}) as Prisma.InputJsonValue,
        },
      });
    }

    try {
      await prisma.event.create({
        data: {
          type: 'PAID',
          provider: 'KIWIFY',
          externalEventId: result.externalEventId,
          customerId: customer.id,
          productId: product.id,
          orderId: order.id,
          revenueCents: amountCents,
          utmSource: affiliateId ? 'kiwify' : null,
          utmMedium: affiliateId ? 'afiliado' : null,
          utmContent: affiliateId ?? null,
          payload: (request.body ?? {}) as Prisma.InputJsonValue,
          processedAt: new Date(),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(200).send({ received: true, provider: 'KIWIFY', idempotent: true });
      }
      throw err;
    }

    return reply.code(200).send({ received: true, provider: 'KIWIFY', orderId: order.id });
  });
}
