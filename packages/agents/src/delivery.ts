// DeliveryAgent — entrega do ebook apos pagamento confirmado.
//
// Gatilho: Order com status PAID que ainda NAO possui DeliveryGrant.
// Para cada um:
//   1) gera token plano (>=32 bytes base64url) e grava SOMENTE o sha256 (tokenHash).
//   2) cria DeliveryGrant (maxDownloads=5, expiresAt=+7 dias).
//   3) envia email com link assinado (PUBLIC_BASE_URL/download/:token).
//   4) marca Order como DELIVERED e emite Event DELIVERED.
//
// Idempotencia: o relacionamento Order 1:1 DeliveryGrant (orderId @unique) garante
// que um pedido nunca recebe dois grants; pedidos ja com grant sao ignorados.
// O token plano so existe no email/URL — nunca persistido.

import { createHash, randomBytes } from 'node:crypto';

import type { AgentName } from '@ebook-empire/core';
import {
  Agent,
  skipped,
  type AgentContext,
  type AgentRunResult,
} from './base.js';

// Lote maximo de pedidos processados por tick (evita run longo demais).
const MAX_BATCH = 25;
// Validade do grant: 7 dias.
const GRANT_TTL_DAYS = 7;
// Limite de downloads por grant.
const MAX_DOWNLOADS = 5;

// Gera token plano forte (32 bytes -> base64url, ~43 chars).
export function generateDeliveryToken(): string {
  return randomBytes(32).toString('base64url');
}

// sha256 do token plano (o unico valor persistido).
export function hashDeliveryToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Monta o link de download a partir da base publica.
function buildDownloadUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/download/${token}`;
}

// Corpo do email de entrega (pt-BR).
function buildDeliveryEmail(opts: {
  customerName?: string | null;
  ebookTitle: string;
  downloadUrl: string;
  expiresAt: Date;
  maxDownloads: number;
}): { subject: string; html: string; text: string } {
  const saudacao = opts.customerName ? `Ola, ${opts.customerName}!` : 'Ola!';
  const validade = opts.expiresAt.toLocaleDateString('pt-BR');
  const subject = `Seu ebook chegou: ${opts.ebookTitle}`;
  const text =
    `${saudacao}\n\n` +
    `Obrigado pela sua compra! Seu ebook "${opts.ebookTitle}" esta pronto.\n\n` +
    `Baixe aqui: ${opts.downloadUrl}\n\n` +
    `Este link permite ate ${opts.maxDownloads} downloads e expira em ${validade}.\n\n` +
    `Equipe Ebook Empire.`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">` +
    `<h2>${saudacao}</h2>` +
    `<p>Obrigado pela sua compra! Seu ebook <strong>${opts.ebookTitle}</strong> esta pronto.</p>` +
    `<p><a href="${opts.downloadUrl}" ` +
    `style="display:inline-block;padding:12px 20px;background:#111;color:#fff;` +
    `text-decoration:none;border-radius:6px">Baixar meu ebook</a></p>` +
    `<p style="color:#666;font-size:13px">Este link permite ate ${opts.maxDownloads} ` +
    `downloads e expira em ${validade}.</p>` +
    `<p style="color:#999;font-size:12px">Equipe Ebook Empire.</p>` +
    `</div>`;
  return { subject, html, text };
}

export class DeliveryAgent extends Agent {
  readonly name: AgentName = 'DELIVERY';

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const now = ctx.clock.now();

    // Pedidos PAID sem grant ainda (deliveryGrant null => 1:1 ainda nao criado).
    // Pula pedidos de marketplace (Hotmart/Kiwify): esses provedores entregam o
    // produto nativamente, entao NAO geramos DeliveryGrant/email para eles.
    const pendingOrders = await ctx.prisma.order.findMany({
      where: { status: 'PAID', deliveryGrant: null, marketplaceProvider: null },
      include: { customer: true, ebook: true },
      orderBy: { paidAt: 'asc' },
      take: MAX_BATCH,
    });

    if (pendingOrders.length === 0) {
      return skipped('nenhum pedido PAID aguardando entrega');
    }

    let delivered = 0;
    const errors: string[] = [];

    for (const order of pendingOrders) {
      try {
        const token = generateDeliveryToken();
        const tokenHash = hashDeliveryToken(token);
        const expiresAt = new Date(
          now.getTime() + GRANT_TTL_DAYS * 24 * 60 * 60 * 1000,
        );

        // Cria o grant. orderId @unique => corrida concorrente falha aqui (P2002),
        // preservando idempotencia.
        await ctx.prisma.deliveryGrant.create({
          data: {
            orderId: order.id,
            ebookId: order.ebookId,
            customerId: order.customerId,
            tokenHash,
            status: 'GRANTED',
            maxDownloads: MAX_DOWNLOADS,
            expiresAt,
          },
        });

        // Envia email com link plano (token nunca persistido).
        const downloadUrl = buildDownloadUrl(ctx.env.PUBLIC_BASE_URL, token);
        const mail = buildDeliveryEmail({
          customerName: order.customer.name,
          ebookTitle: order.ebook.title,
          downloadUrl,
          expiresAt,
          maxDownloads: MAX_DOWNLOADS,
        });

        const sent = await ctx.ports.email.send({
          to: order.customer.email,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });

        // Marca envio + ativa grant + conclui pedido + evento de funil.
        await ctx.prisma.$transaction([
          ctx.prisma.deliveryGrant.update({
            where: { orderId: order.id },
            data: { status: 'ACTIVE', emailSentAt: now },
          }),
          ctx.prisma.order.update({
            where: { id: order.id },
            data: { status: 'DELIVERED', deliveredAt: now },
          }),
          ctx.prisma.event.create({
            data: {
              type: 'DELIVERED',
              occurredAt: now,
              customerId: order.customerId,
              productId: order.productId,
              orderId: order.id,
              revenueCents: order.priceCents,
              metadata: { messageId: sent.messageId },
            },
          }),
        ]);

        delivered += 1;
        ctx.log.info(
          { orderId: order.id, ebookId: order.ebookId },
          'ebook entregue',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`order ${order.id}: ${message}`);
        ctx.log.warn({ orderId: order.id, err: message }, 'falha na entrega');
      }
    }

    // Se nada foi entregue e houve erro, propaga falha (run marca FAILED).
    if (delivered === 0 && errors.length > 0) {
      throw new Error(`DeliveryAgent: todas as entregas falharam — ${errors.join('; ')}`);
    }

    return {
      status: 'SUCCESS',
      output: { delivered, considered: pendingOrders.length },
      metrics: { delivered, errors: errors.length },
    };
  }
}
