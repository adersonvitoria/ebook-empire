// Rotas do setor EBOOK_QA (auditoria de ebooks / loop de correcao). Dono: EBOOK_QA.
//
// Rotas:
//   GET  /quality/health                 -> healthcheck (count de audits)
//   GET  /quality/audits                 -> lista EbookAudit (filtros verdict/ebookId)
//   GET  /quality/ebooks/:id/audit       -> ultima auditoria de um ebook + gate canLaunch
//   POST /quality/audit/:ebookId  [JWT]  -> audita um ebook (EbookQaService.auditEbook)
//   POST /quality/fix/:ebookId    [JWT]  -> roda o loop corrigir->reauditar->relançar
//
// Convencao de plugin Fastify: default async (fastify) => {}. server.ts ja registra.
// Ports montados por env (stub/real), igual routes/ebooks.ts.

import type { FastifyInstance } from 'fastify';
import type {
  Ports,
  StoragePort,
  PaymentPort,
  EmailPort,
  InstagramPort,
  AdsPort,
} from '@ebook-empire/core';
import type { AgentContext, AgentEnv } from '@ebook-empire/agents';
import { EbookQaService } from '@ebook-empire/agents';
import { createLLMAdapter } from '@ebook-empire/adapters';
import { prisma } from '../db.js';
import { env, CONTENT_MODEL, PLANNING_MODEL } from '../env.js';

// Ports nao usados pelo QA — lancam se chamados por engano.
function notImpl(name: string): never {
  throw new Error(`${name} indisponivel no contexto de QA.`);
}
const unusedPayment: PaymentPort = {
  createPixCharge: () => notImpl('PaymentPort.createPixCharge'),
  getPayment: () => notImpl('PaymentPort.getPayment'),
  parseWebhook: () => notImpl('PaymentPort.parseWebhook'),
};
const unusedEmail: EmailPort = { send: () => notImpl('EmailPort.send') };
const unusedInstagram: InstagramPort = {
  publishPost: () => notImpl('InstagramPort.publishPost'),
  uploadMedia: () => notImpl('InstagramPort.uploadMedia'),
  getAccountInsights: () => notImpl('InstagramPort.getAccountInsights'),
  getPostInsights: () => notImpl('InstagramPort.getPostInsights'),
};
const unusedAds: AdsPort = {
  createCampaign: () => notImpl('AdsPort.createCampaign'),
  updateBudget: () => notImpl('AdsPort.updateBudget'),
  setStatus: () => notImpl('AdsPort.setStatus'),
  getInsights: () => notImpl('AdsPort.getInsights'),
};
// QA nao escreve PDFs; storage no-op suficiente (o executor so muta markdown/DB).
const noopStorage: StoragePort = {
  async putObject() {},
  async getObject() {
    return Buffer.from('');
  },
  async getSignedUrl(key) {
    return `${env.PUBLIC_BASE_URL}/storage/${encodeURIComponent(key)}`;
  },
};

function buildAgentEnv(): AgentEnv {
  return {
    ENABLE_AGENTS: env.ENABLE_AGENTS,
    MAX_AD_BUDGET_BRL: env.MAX_AD_BUDGET_BRL,
    TARGET_DAILY_REVENUE_BRL: env.TARGET_DAILY_REVENUE_BRL,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
    CONTENT_MODEL,
    PLANNING_MODEL,
    // QA_* numericos lidos pelo auditor/service via ctx.env.
    QA_MIN_SCORE: env.QA_MIN_SCORE,
    QA_MAX_FIX_ITERATIONS: env.QA_MAX_FIX_ITERATIONS,
    QA_FAIL_SCORE: env.QA_FAIL_SCORE,
    QA_AUDIT_STALE_HOURS: env.QA_AUDIT_STALE_HOURS,
  };
}

function buildCtx(fastify: FastifyInstance): AgentContext {
  const llm = createLLMAdapter({
    USE_STUBS: env.USE_STUBS,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    LLM_PROVIDER: env.LLM_PROVIDER,
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    GEMINI_MODEL: env.GEMINI_MODEL,
  });
  const ports: Ports = {
    llm,
    storage: noopStorage,
    payment: unusedPayment,
    email: unusedEmail,
    instagram: unusedInstagram,
    ads: unusedAds,
  };
  return {
    prisma,
    ports,
    env: buildAgentEnv(),
    log: fastify.log,
    clock: { now: () => new Date() },
  };
}

export default async function qualityRoutes(fastify: FastifyInstance): Promise<void> {
  // --- GET /quality/health ---
  fastify.get('/quality/health', async (_request, reply) => {
    let audits = -1;
    try {
      audits = await prisma.ebookAudit.count();
    } catch {
      // tabela pode nao existir em ambientes sem migracao aplicada
    }
    return reply.code(200).send({
      status: 'ok',
      sector: 'EBOOK_QA',
      audits,
      timestamp: new Date().toISOString(),
    });
  });

  // --- GET /quality/audits ---
  // Filtros: verdict (PASS|NEEDS_FIX|FAIL), ebookId, limit/offset.
  fastify.get<{
    Querystring: { verdict?: string; ebookId?: string; limit?: string; offset?: string };
  }>('/quality/audits', async (request, reply) => {
    const { verdict, ebookId } = request.query;
    const limit = Math.min(Number(request.query.limit ?? 50) || 50, 200);
    const offset = Number(request.query.offset ?? 0) || 0;

    const where: Record<string, unknown> = {};
    if (verdict === 'PASS' || verdict === 'NEEDS_FIX' || verdict === 'FAIL') {
      where.verdict = verdict;
    }
    if (ebookId) where.ebookId = ebookId;

    const [items, total] = await Promise.all([
      prisma.ebookAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { ebook: { select: { id: true, title: true, niche: true, status: true } } },
      }),
      prisma.ebookAudit.count({ where }),
    ]);

    return reply.send({ items, total, limit, offset });
  });

  // --- GET /quality/ebooks/:id/audit ---
  // Ultima auditoria de um ebook + decisao do gate de lancamento.
  fastify.get<{ Params: { id: string } }>(
    '/quality/ebooks/:id/audit',
    async (request, reply) => {
      const { id } = request.params;
      const ebook = await prisma.ebook.findUnique({
        where: { id },
        select: { id: true, title: true, niche: true, status: true },
      });
      if (!ebook) return reply.code(404).send({ error: 'ebook_not_found' });

      const last = await prisma.ebookAudit.findFirst({
        where: { ebookId: id },
        orderBy: { createdAt: 'desc' },
      });
      const gate = await new EbookQaService().canLaunch(buildCtx(fastify), id);

      return reply.send({ ebook, lastAudit: last, gate });
    },
  );

  // --- POST /quality/audit/:ebookId [JWT] ---
  fastify.post<{ Params: { ebookId: string } }>(
    '/quality/audit/:ebookId',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { ebookId } = request.params;
      const exists = await prisma.ebook.findUnique({
        where: { id: ebookId },
        select: { id: true },
      });
      if (!exists) return reply.code(404).send({ error: 'ebook_not_found' });

      try {
        const { audit, auditId, agentRunId } = await new EbookQaService().auditEbook(
          buildCtx(fastify),
          ebookId,
        );
        return reply.code(201).send({ auditId, agentRunId, audit });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: 'audit_failed', detail: message });
      }
    },
  );

  // --- POST /quality/fix/:ebookId [JWT] ---
  // Roda o loop corrigir->reauditar->relançar (bounded por QA_MAX_FIX_ITERATIONS).
  fastify.post<{ Params: { ebookId: string } }>(
    '/quality/fix/:ebookId',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { ebookId } = request.params;
      const exists = await prisma.ebook.findUnique({
        where: { id: ebookId },
        select: { id: true },
      });
      if (!exists) return reply.code(404).send({ error: 'ebook_not_found' });

      try {
        const result = await new EbookQaService().runFixLoop(buildCtx(fastify), ebookId);
        return reply.code(200).send(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: 'fix_failed', detail: message });
      }
    },
  );
}
