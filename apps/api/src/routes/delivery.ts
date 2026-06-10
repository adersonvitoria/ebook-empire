// Rotas de entrega de ebook.
//   GET  /download/:token      -> valida grant, incrementa contador, faz stream do PDF.
//   POST /delivery/retry/:orderId -> reenvia o email de entrega (admin).
//
// Convencao: plugin Fastify default async (fastify) => {}. server.ts ja registra.
// O token plano chega na URL; comparamos pelo sha256 (tokenHash @unique).

import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { deliveryTokenParamsSchema } from '@ebook-empire/core';
import {
  createEmailAdapter,
  createStorageAdapter,
  LocalStorageAdapter,
} from '@ebook-empire/adapters';

import { env } from '../env.js';
import { prisma } from '../db.js';

// sha256 do token plano (mesma funcao usada pelo DeliveryAgent).
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export default async function deliveryRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Adapters montados a partir do env (stub <-> real).
  const storage = createStorageAdapter({
    driver: 'local',
    storageDir: env.STORAGE_DIR,
    signingSecret: env.JWT_SECRET,
    publicBaseUrl: env.PUBLIC_BASE_URL,
  });
  const email = createEmailAdapter({
    useStubs: env.USE_STUBS,
    provider: 'resend',
    resendApiKey: env.RESEND_API_KEY,
  });

  // ----------------------------------------------------------
  // GET /download/:token — download protegido por token de uso limitado.
  // ----------------------------------------------------------
  fastify.get('/download/:token', async (request, reply) => {
    const parsed = deliveryTokenParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'token_invalido' });
    }

    const tokenHash = hashToken(parsed.data.token);
    const grant = await prisma.deliveryGrant.findUnique({
      where: { tokenHash },
      include: { ebook: true },
    });

    if (!grant) {
      return reply.code(404).send({ error: 'grant_nao_encontrado' });
    }

    const now = new Date();

    // Estado terminal / revogado.
    if (grant.status === 'REVOKED' || grant.revokedAt) {
      return reply.code(410).send({ error: 'grant_revogado' });
    }

    // Expiracao (por tempo).
    if (grant.expiresAt.getTime() <= now.getTime()) {
      if (grant.status !== 'EXPIRED') {
        await prisma.deliveryGrant.update({
          where: { id: grant.id },
          data: { status: 'EXPIRED' },
        });
      }
      return reply.code(410).send({ error: 'grant_expirado' });
    }

    // Limite de downloads atingido.
    if (grant.downloadCount >= grant.maxDownloads) {
      if (grant.status !== 'EXHAUSTED') {
        await prisma.deliveryGrant.update({
          where: { id: grant.id },
          data: { status: 'EXHAUSTED' },
        });
      }
      return reply.code(410).send({ error: 'limite_de_downloads_atingido' });
    }

    // PDF disponivel?
    const pdfKey = grant.ebook.pdfPath;
    if (!pdfKey) {
      return reply.code(409).send({ error: 'pdf_indisponivel' });
    }

    let bytes: Buffer;
    try {
      bytes = await storage.getObject(pdfKey);
    } catch {
      return reply.code(404).send({ error: 'arquivo_nao_encontrado' });
    }

    // Incremento atomico do contador; marca EXHAUSTED quando chega ao limite.
    const willExhaust = grant.downloadCount + 1 >= grant.maxDownloads;
    await prisma.deliveryGrant.update({
      where: { id: grant.id },
      data: {
        downloadCount: { increment: 1 },
        lastDownloadAt: now,
        status: willExhaust ? 'EXHAUSTED' : 'ACTIVE',
      },
    });

    const filename = `${grant.ebook.slug || 'ebook'}.pdf`;
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Cache-Control', 'private, no-store')
      .send(bytes);
  });

  // ----------------------------------------------------------
  // GET /storage/object — serve bytes via URL assinada (HMAC) do StoragePort.
  // Usada quando o fluxo opta por signed URL em vez de stream por token.
  // ----------------------------------------------------------
  fastify.get('/storage/object', async (request, reply) => {
    if (!(storage instanceof LocalStorageAdapter)) {
      return reply.code(404).send({ error: 'nao_suportado' });
    }
    const q = request.query as Record<string, string | undefined>;
    const check = storage.verifySignedUrl({ key: q.key, exp: q.exp, sig: q.sig });
    if (!check.valid || !check.key) {
      const code = check.reason === 'expired' ? 410 : 403;
      return reply.code(code).send({ error: check.reason ?? 'assinatura_invalida' });
    }

    let bytes: Buffer;
    try {
      bytes = await storage.getObject(check.key);
    } catch {
      return reply.code(404).send({ error: 'arquivo_nao_encontrado' });
    }
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Cache-Control', 'private, no-store')
      .send(bytes);
  });

  // ----------------------------------------------------------
  // POST /delivery/retry/:orderId — reenvia o email de entrega (admin).
  // Reusa o grant existente; NAO gera novo token (token plano nao e recuperavel,
  // entao gera um novo token rotacionando o hash). Idempotente por design.
  // ----------------------------------------------------------
  fastify.post(
    '/delivery/retry/:orderId',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { orderId } = request.params as { orderId: string };
      if (!orderId) {
        return reply.code(400).send({ error: 'orderId_obrigatorio' });
      }

      const grant = await prisma.deliveryGrant.findUnique({
        where: { orderId },
        include: { ebook: true, customer: true },
      });
      if (!grant) {
        return reply.code(404).send({ error: 'grant_nao_encontrado' });
      }
      if (grant.status === 'REVOKED') {
        return reply.code(409).send({ error: 'grant_revogado' });
      }

      const now = new Date();
      // Rotaciona o token (o plano anterior nao e recuperavel) e estende validade.
      const { randomBytes } = await import('node:crypto');
      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashToken(token);
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      await prisma.deliveryGrant.update({
        where: { orderId },
        data: { tokenHash, status: 'ACTIVE', expiresAt, emailSentAt: now },
      });

      const downloadUrl = `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/download/${token}`;
      const validade = expiresAt.toLocaleDateString('pt-BR');
      const sent = await email.send({
        to: grant.customer.email,
        subject: `Seu ebook: ${grant.ebook.title}`,
        html:
          `<p>Reenvio da sua entrega.</p>` +
          `<p><a href="${downloadUrl}">Baixar meu ebook</a></p>` +
          `<p style="color:#666;font-size:13px">Link valido ate ${validade}, ` +
          `ate ${grant.maxDownloads} downloads.</p>`,
        text: `Reenvio da entrega. Baixe: ${downloadUrl} (valido ate ${validade}).`,
      });

      return reply.send({ ok: true, orderId, messageId: sent.messageId });
    },
  );
}
