// Webhook Hotmart — Fase 3 (marketplace).
//   POST /webhooks/hotmart
// Fluxo:
//   1) valida o header HOTMART-HOTTOK via MarketplacePort.parseWebhook (HOTMART).
//   2) parseia o evento (PURCHASE_COMPLETE / PURCHASE_REFUNDED).
//   3) acha o Product via MarketplaceListing.externalProductId (provider HOTMART).
//   4) upsert Customer por email.
//   5) cria Order(status=PAID, marketplaceProvider='HOTMART') + Payment(HOTMART) —
//      NAO cria DeliveryGrant (Hotmart entrega nativamente).
//   6) grava Event idempotente (provider='HOTMART', externalEventId=saleId).
// UTM: quando houver referral/afiliado set utmSource='hotmart', utmMedium='afiliado',
//   utmContent=affiliateId.
//
// Idempotencia: Event @@unique([provider, externalEventId]) — reentrega responde
// 200 sem reaplicar efeitos. Contrato preservado: responde 200 { received,provider }
// no caminho feliz (cobre webhooks.test.ts).

import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { createHotmartAdapter, createStorageAdapter } from '@ebook-empire/adapters';

import { prisma } from '../../db.js';
import { env } from '../../env.js';

// StoragePort necessario apenas para o adapter real (uploadPdf); no webhook nao
// fazemos upload, mas a factory exige o port. Reusa o mesmo padrao das rotas.
const storage = createStorageAdapter({
  driver: 'local',
  storageDir: env.STORAGE_DIR,
  signingSecret: env.JWT_SECRET,
  publicBaseUrl: env.PUBLIC_BASE_URL,
});

// MarketplacePort (Hotmart) unico por processo (stub mantem estado em memoria).
const hotmart = createHotmartAdapter(
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
export const _hotmartPort = hotmart;

// Eventos da Hotmart que sinalizam compra liquidada.
const PAID_EVENTS = new Set([
  'PURCHASE_COMPLETE',
  'PURCHASE_APPROVED',
  'PURCHASE_PROTEST', // ainda pago; ajuste futuro se necessario
]);
const REFUND_EVENTS = new Set([
  'PURCHASE_REFUNDED',
  'PURCHASE_CHARGEBACK',
  'PURCHASE_CANCELED',
]);

// Extrai o affiliateId do payload bruto (quando houver referral).
function extractAffiliateId(body: unknown): string | undefined {
  const p = (body ?? {}) as {
    data?: { affiliates?: Array<{ affiliate_code?: string }> };
  };
  const code = p.data?.affiliates?.[0]?.affiliate_code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

export default async function hotmartWebhookRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post('/webhooks/hotmart', async (request, reply) => {
    const result = hotmart.parseWebhook(request.headers, request.body);
    if (!result.valid) {
      return reply.code(401).send({ error: 'invalid_webhook_token' });
    }

    const isPaid = PAID_EVENTS.has(result.event);
    const isRefund = REFUND_EVENTS.has(result.event);

    // Eventos que nao mexem em pedido: aceita 200 (nada a fazer).
    if (!isPaid && !isRefund) {
      return reply.code(200).send({ received: true, provider: 'HOTMART', ignored: result.event });
    }

    if (!result.externalProductId || !result.externalEventId) {
      return reply.code(200).send({ received: true, provider: 'HOTMART', ignored: 'incomplete_payload' });
    }

    // Acha o Product via MarketplaceListing.externalProductId (provider HOTMART).
    const listing = await prisma.marketplaceListing.findFirst({
      where: { provider: 'HOTMART', externalProductId: result.externalProductId },
      include: { product: true },
    });
    if (!listing) {
      // Produto desconhecido — aceita para nao gerar retry infinito na Hotmart.
      return reply.code(200).send({ received: true, provider: 'HOTMART', ignored: 'unknown_product' });
    }
    const product = listing.product;

    // ---- REFUND ----
    if (isRefund) {
      const order = await prisma.order.findFirst({
        where: {
          marketplaceProvider: 'HOTMART',
          externalOrderId: result.externalOrderId ?? undefined,
        },
      });
      try {
        await prisma.event.create({
          data: {
            type: 'REFUNDED',
            provider: 'HOTMART',
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
          return reply.code(200).send({ received: true, provider: 'HOTMART', idempotent: true });
        }
        throw err;
      }
      if (order && order.status !== 'REFUNDED') {
        await prisma.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
      }
      return reply.code(200).send({ received: true, provider: 'HOTMART', refunded: true });
    }

    // ---- PAID ----
    const buyerEmail = result.buyerEmail ?? `unknown+${result.externalEventId}@hotmart.local`;
    const amountCents = result.amountCents ?? product.priceCents;
    const affiliateId = extractAffiliateId(request.body);

    // Upsert Customer por email.
    const customer = await prisma.customer.upsert({
      where: { email: buyerEmail },
      update: {},
      create: { email: buyerEmail },
    });

    // Idempotencia primeiro: tenta gravar o Event autoritativo. Colisao no
    // @@unique([provider, externalEventId]) => ja processado => 200 sem efeitos.
    let order = await prisma.order.findFirst({
      where: { marketplaceProvider: 'HOTMART', externalOrderId: result.externalOrderId ?? undefined },
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
          marketplaceProvider: 'HOTMART',
          externalOrderId: result.externalOrderId ?? null,
          // Atribuicao de afiliado (referral).
          utmSource: affiliateId ? 'hotmart' : null,
          utmMedium: affiliateId ? 'afiliado' : null,
          utmContent: affiliateId ?? null,
        },
      });
    }

    // Payment (provider HOTMART). @@unique([provider, providerPaymentId]).
    const paymentRow = await prisma.payment.findFirst({ where: { orderId: order.id } });
    if (!paymentRow) {
      await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: 'HOTMART',
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
          provider: 'HOTMART',
          externalEventId: result.externalEventId,
          customerId: customer.id,
          productId: product.id,
          orderId: order.id,
          revenueCents: amountCents,
          utmSource: affiliateId ? 'hotmart' : null,
          utmMedium: affiliateId ? 'afiliado' : null,
          utmContent: affiliateId ?? null,
          payload: (request.body ?? {}) as Prisma.InputJsonValue,
          processedAt: new Date(),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(200).send({ received: true, provider: 'HOTMART', idempotent: true });
      }
      throw err;
    }

    return reply.code(200).send({ received: true, provider: 'HOTMART', orderId: order.id });
  });
}
