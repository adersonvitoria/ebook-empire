// Rota de checkout/pagamento (BR-first, fluxo PIX orientado a webhook).
// Plugin Fastify: exporta default async (fastify) => {}. NUNCA editar server.ts.
//
// Endpoints:
//   POST /checkout         -> cria Customer (se preciso), Order, Payment e
//                             cobranca PIX via PaymentPort; retorna QR/copia-e-cola.
//   POST /webhooks/asaas   -> idempotente: confirma Payment, marca Order PAID e
//                             dispara entrega (evento PAID -> DeliveryAgent).
//   GET  /orders           -> lista pedidos.
//   GET  /orders/:id       -> detalhe de um pedido (com payment/grant).
//
// Idempotencia do webhook: Event @@unique([provider, externalEventId]).

import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  checkoutBodySchema,
  paymentWebhookBodySchema,
} from '@ebook-empire/core';
import { createPaymentAdapter } from '@ebook-empire/adapters';
import { prisma } from '../db.js';
import { env } from '../env.js';

// PaymentPort unico por processo (stub mantem estado em memoria entre requests).
const payment = createPaymentAdapter({
  USE_STUBS: env.USE_STUBS,
  PAYMENT_PROVIDER: env.PAYMENT_PROVIDER,
  ASAAS_API_KEY: env.ASAAS_API_KEY,
  ASAAS_WEBHOOK_TOKEN: env.ASAAS_WEBHOOK_TOKEN,
  ASAAS_BASE_URL: env.ASAAS_BASE_URL || undefined,
});

// Exportado para testes: permite injetar um StubPaymentAdapter compartilhado.
export const _paymentPort = payment;

// Referral de afiliado: campo OPCIONAL fora do checkoutBodySchema (que descarta
// chaves desconhecidas). Lemos cru de request.body para nao alterar o schema
// nem o contrato existente. Shape aceito: { affiliateId: string, source?: string }.
interface CheckoutReferral {
  affiliateId: string;
  source?: string;
}

function parseReferral(rawBody: unknown): CheckoutReferral | null {
  if (!rawBody || typeof rawBody !== 'object') return null;
  const ref = (rawBody as { referral?: unknown }).referral;
  if (!ref || typeof ref !== 'object') return null;
  const affiliateId = (ref as { affiliateId?: unknown }).affiliateId;
  if (typeof affiliateId !== 'string' || affiliateId.length === 0) return null;
  const source = (ref as { source?: unknown }).source;
  return {
    affiliateId,
    source: typeof source === 'string' && source.length > 0 ? source : undefined,
  };
}

export default async function checkoutRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // --------------------------------------------------------
  // POST /checkout
  // --------------------------------------------------------
  fastify.post('/checkout', async (request, reply) => {
    const parsed = checkoutBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        issues: parsed.error.issues,
      });
    }
    const body = parsed.data;

    // 1) Produto ativo pelo slug.
    const product = await prisma.product.findUnique({
      where: { slug: body.productSlug },
      include: { ebook: true },
    });
    if (!product || !product.active) {
      return reply.code(404).send({ error: 'product_not_found' });
    }

    // 2) Customer: upsert por email (chave unica).
    const customer = await prisma.customer.upsert({
      where: { email: body.customer.email },
      update: {
        name: body.customer.name,
        phone: body.customer.phone ?? undefined,
      },
      create: {
        email: body.customer.email,
        name: body.customer.name,
        phone: body.customer.phone ?? null,
      },
    });

    // 3) Order (snapshot de preco + atribuicao UTM).
    // Convencao de afiliado: quando o pedido carrega `referral` (campo opcional
    // FORA do checkoutBodySchema — lido cru de request.body, idempotencia/flow
    // intactos), aplicamos a atribuicao de afiliado:
    //   utmSource  = origem do referral (default 'afiliado')
    //   utmMedium  = 'afiliado'
    //   utmContent = affiliateId
    // O UTM explicito no body SEMPRE tem precedencia (so preenchemos os campos
    // que o cliente nao informou), preservando o e2e/atribuicao existentes.
    const utm = { ...(body.utm ?? {}) };
    const referral = parseReferral(request.body);
    if (referral) {
      if (utm.utmSource === undefined) utm.utmSource = referral.source ?? 'afiliado';
      if (utm.utmMedium === undefined) utm.utmMedium = 'afiliado';
      if (utm.utmContent === undefined) utm.utmContent = referral.affiliateId;
    }
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        productId: product.id,
        ebookId: product.ebookId,
        status: 'AWAITING_PAYMENT',
        priceCents: product.priceCents,
        currency: product.currency,
        visitorId: body.visitorId ?? null,
        utmSource: utm.utmSource ?? null,
        utmMedium: utm.utmMedium ?? null,
        utmCampaign: utm.utmCampaign ?? null,
        utmContent: utm.utmContent ?? null,
        utmTerm: utm.utmTerm ?? null,
      },
    });

    // 4) Cobranca PIX via PaymentPort.
    let charge;
    try {
      charge = await payment.createPixCharge({
        orderId: order.id,
        amountCents: order.priceCents,
        customer: {
          name: body.customer.name,
          email: body.customer.email,
          cpfCnpj: body.customer.cpfCnpj,
        },
        description: `${product.name} — ${product.ebook.title}`,
      });
    } catch (err) {
      request.log.error(
        { err: err instanceof Error ? err.message : String(err), orderId: order.id },
        'falha ao criar cobranca PIX',
      );
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'PENDING' },
      });
      return reply.code(502).send({ error: 'payment_provider_error' });
    }

    // 5) Persiste Payment (1:1 com Order).
    await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: 'ASAAS',
        method: 'PIX',
        providerPaymentId: charge.providerPaymentId,
        status: 'PENDING',
        amountCents: order.priceCents,
        currency: order.currency,
        pixQrCode: charge.pixQrCode,
        pixCopyPaste: charge.pixCopyPaste,
        dueDate: charge.dueDate,
      },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { asaasPaymentId: charge.providerPaymentId },
    });

    // 6) Evento de funil CHECKOUT_STARTED (atribuicao).
    await prisma.event.create({
      data: {
        type: 'CHECKOUT_STARTED',
        visitorId: body.visitorId ?? null,
        customerId: customer.id,
        productId: product.id,
        orderId: order.id,
        utmSource: utm.utmSource ?? null,
        utmMedium: utm.utmMedium ?? null,
        utmCampaign: utm.utmCampaign ?? null,
        utmContent: utm.utmContent ?? null,
        utmTerm: utm.utmTerm ?? null,
      },
    });

    return reply.code(201).send({
      orderId: order.id,
      status: order.status,
      amountCents: order.priceCents,
      currency: order.currency,
      pixQrCode: charge.pixQrCode,
      pixCopyPaste: charge.pixCopyPaste,
      dueDate: charge.dueDate.toISOString(),
    });
  });

  // --------------------------------------------------------
  // POST /webhooks/asaas  (idempotente)
  // --------------------------------------------------------
  fastify.post('/webhooks/asaas', async (request, reply) => {
    // Valida formato bruto minimo (objeto JSON arbitrario).
    const parsedBody = paymentWebhookBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }

    const result = payment.parseWebhook(request.headers, request.body);
    if (!result.valid) {
      return reply.code(401).send({ error: 'invalid_webhook_token' });
    }

    // Localiza o Payment pelo providerPaymentId.
    if (!result.providerPaymentId) {
      return reply.code(200).send({ ok: true, ignored: 'no_payment_id' });
    }
    const paymentRow = await prisma.payment.findFirst({
      where: { provider: 'ASAAS', providerPaymentId: result.providerPaymentId },
      include: { order: true },
    });
    if (!paymentRow) {
      // Webhook de um pagamento desconhecido — aceita para nao reentregar.
      return reply.code(200).send({ ok: true, ignored: 'unknown_payment' });
    }

    const status = result.status ?? 'PENDING';
    // Gatilho de entrega = CONFIRMED OU RECEIVED.
    const isPaid = status === 'CONFIRMED' || status === 'RECEIVED';

    // Idempotencia: grava UM Event de funil autoritativo carregando provider +
    // externalEventId. Colisao no @@unique([provider, externalEventId]) =>
    // webhook ja processado => responde 200 sem reaplicar efeitos colaterais.
    if (result.externalEventId) {
      try {
        await prisma.event.create({
          data: {
            type:
              status === 'REFUNDED'
                ? 'REFUNDED'
                : isPaid
                  ? 'PAID'
                  : 'PAYMENT_PENDING',
            provider: result.provider ?? 'ASAAS',
            externalEventId: result.externalEventId,
            customerId: paymentRow.order.customerId,
            productId: paymentRow.order.productId,
            orderId: paymentRow.orderId,
            paymentId: paymentRow.id,
            adCampaignId: paymentRow.order.adCampaignId,
            revenueCents: isPaid ? paymentRow.amountCents : null,
            utmSource: paymentRow.order.utmSource,
            utmMedium: paymentRow.order.utmMedium,
            utmCampaign: paymentRow.order.utmCampaign,
            utmContent: paymentRow.order.utmContent,
            utmTerm: paymentRow.order.utmTerm,
            payload: (request.body ?? {}) as Prisma.InputJsonValue,
            processedAt: new Date(),
          },
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          return reply.code(200).send({ ok: true, idempotent: true });
        }
        throw err;
      }
    }

    await prisma.payment.update({
      where: { id: paymentRow.id },
      data: {
        status,
        paidAt: isPaid ? new Date() : paymentRow.paidAt,
        raw: (request.body ?? {}) as Prisma.InputJsonValue,
      },
    });

    if (
      isPaid &&
      paymentRow.order.status !== 'PAID' &&
      paymentRow.order.status !== 'DELIVERED'
    ) {
      // Marca Order PAID. A entrega efetiva (DeliveryGrant + email) e feita
      // pelo DeliveryAgent, que varre Orders PAID sem grant no proximo tick.
      await prisma.order.update({
        where: { id: paymentRow.orderId },
        data: { status: 'PAID', paidAt: new Date() },
      });
    }

    if (status === 'REFUNDED' && paymentRow.order.status !== 'REFUNDED') {
      await prisma.order.update({
        where: { id: paymentRow.orderId },
        data: { status: 'REFUNDED' },
      });
    }

    return reply.code(200).send({ ok: true });
  });

  // --------------------------------------------------------
  // GET /orders
  // --------------------------------------------------------
  fastify.get('/orders', async (_request, reply) => {
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        customer: { select: { email: true, name: true } },
        product: { select: { name: true, slug: true } },
        payment: { select: { status: true, providerPaymentId: true } },
      },
    });
    return reply.send({ orders });
  });

  // --------------------------------------------------------
  // GET /orders/:id
  // --------------------------------------------------------
  fastify.get<{ Params: { id: string } }>('/orders/:id', async (request, reply) => {
    const order = await prisma.order.findUnique({
      where: { id: request.params.id },
      include: {
        customer: true,
        product: true,
        ebook: { select: { id: true, title: true, slug: true } },
        payment: true,
        deliveryGrant: {
          select: {
            id: true,
            status: true,
            downloadCount: true,
            maxDownloads: true,
            expiresAt: true,
            emailSentAt: true,
          },
        },
      },
    });
    if (!order) {
      return reply.code(404).send({ error: 'order_not_found' });
    }
    return reply.send({ order });
  });
}
