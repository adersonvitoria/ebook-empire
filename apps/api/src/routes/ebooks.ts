// Rotas de ebooks (plugin Fastify). Convencao: este arquivo exporta default
// uma funcao async (fastify) => {}. O server.ts ja registra este plugin —
// NUNCA edite o server.
//
// Rotas:
//   GET  /ebooks            -> lista (filtros status/niche, paginacao)
//   GET  /ebooks/:id        -> detalhe
//   POST /ebooks/generate   -> dispara o PIPELINE DE LANCAMENTO (gera+lanca)
//
// A geracao roda via createAndLaunchEbook (modulo launch), que aplica os DOIS
// GATES: (1) mercado — exige uma MarketOpportunity selecionada; (2) qualidade —
// so publica apos PASS no QA. Os ports sao montados a partir do env (stub/real).
// Sincrono aqui (com stub e rapido; com LLM real pode levar alguns segundos).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  Ports,
  StoragePort,
  PaymentPort,
  EmailPort,
  InstagramPort,
  AdsPort,
  MarketDataPort,
} from '@ebook-empire/core';
import {
  listEbooksQuerySchema,
  generateEbookBodySchema,
} from '@ebook-empire/core';
import type { AgentEnv, AgentContext, ContentGenerationCapability } from '@ebook-empire/agents';
import { createAndLaunchEbook, ContentAgent } from '@ebook-empire/agents';
import { createLLMAdapter } from '@ebook-empire/adapters';
import { prisma } from '../db.js';
import { env, CONTENT_MODEL, PLANNING_MODEL } from '../env.js';
import { buildEbookPdf } from '../lib/pdf.js';

// ------------------------------------------------------------
// Resolucao DEFENSIVA do MarketDataPort (setor MARKET_RESEARCH — modulo 2).
// Escrita disjunta: o adapter (createMarketDataAdapter) e de outro dono e pode
// nao existir quando este arquivo compila. Import dinamico tolerante (mesmo
// padrao do scheduler): ausente -> marketData fica undefined e o GATE de mercado
// do pipeline aborta com motivo claro (sem oportunidade -> 422).
// ------------------------------------------------------------
async function resolveMarketData(): Promise<MarketDataPort | undefined> {
  try {
    const adapters = (await import('@ebook-empire/adapters')) as Record<string, unknown>;
    const factory = adapters.createMarketDataAdapter;
    if (typeof factory !== 'function') return undefined;
    return (factory as (cfg: unknown) => MarketDataPort)({
      USE_STUBS: env.USE_STUBS,
      MARKET_DATA_PROVIDER: env.MARKET_DATA_PROVIDER,
      SERPER_API_KEY: env.SERPER_API_KEY,
      MARKET_SEARCH_GL: env.MARKET_SEARCH_GL,
      MARKET_SEARCH_HL: env.MARKET_SEARCH_HL,
    });
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------
// StoragePort minimo em disco local (dono real: delivery/storage.ts).
// Inline aqui para que a geracao de ebook funcione de forma autocontida,
// sem acoplar este modulo aos demais ports ainda em construcao.
// ------------------------------------------------------------
function createLocalStorage(baseDir: string): StoragePort {
  const resolveKey = (key: string) => path.join(baseDir, key);
  return {
    async putObject(key, bytes) {
      const full = resolveKey(key);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, bytes);
    },
    async getObject(key) {
      return fs.readFile(resolveKey(key));
    },
    async getSignedUrl(key, ttlSeconds) {
      // Stub: URL local com expiracao informativa (substituida pelo adapter real).
      const exp = Date.now() + ttlSeconds * 1000;
      return `${env.PUBLIC_BASE_URL}/storage/${encodeURIComponent(key)}?exp=${exp}`;
    },
  };
}

// Ports nao utilizados pelo ContentAgent — lancam se invocados por engano.
function notImplemented(name: string): never {
  throw new Error(`${name} indisponivel neste contexto (apenas geracao de conteudo).`);
}

const unusedPayment: PaymentPort = {
  createPixCharge: () => notImplemented('PaymentPort.createPixCharge'),
  getPayment: () => notImplemented('PaymentPort.getPayment'),
  parseWebhook: () => notImplemented('PaymentPort.parseWebhook'),
};
const unusedEmail: EmailPort = { send: () => notImplemented('EmailPort.send') };
const unusedInstagram: InstagramPort = {
  publishPost: () => notImplemented('InstagramPort.publishPost'),
  uploadMedia: () => notImplemented('InstagramPort.uploadMedia'),
  getAccountInsights: () => notImplemented('InstagramPort.getAccountInsights'),
  getPostInsights: () => notImplemented('InstagramPort.getPostInsights'),
};
const unusedAds: AdsPort = {
  createCampaign: () => notImplemented('AdsPort.createCampaign'),
  updateBudget: () => notImplemented('AdsPort.updateBudget'),
  setStatus: () => notImplemented('AdsPort.setStatus'),
  getInsights: () => notImplemented('AdsPort.getInsights'),
};

function buildAgentEnv(): AgentEnv {
  return {
    ENABLE_AGENTS: env.ENABLE_AGENTS,
    MAX_AD_BUDGET_BRL: env.MAX_AD_BUDGET_BRL,
    TARGET_DAILY_REVENUE_BRL: env.TARGET_DAILY_REVENUE_BRL,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
    CONTENT_MODEL,
    PLANNING_MODEL,
    // Mercado + QA (setores MARKET_RESEARCH / EBOOK_QA) — os services leem
    // ctx.env.MARKET_*/QA_* via a index-signature do AgentEnv.
    MARKET_DATA_PROVIDER: env.MARKET_DATA_PROVIDER,
    MARKET_SEARCH_GL: env.MARKET_SEARCH_GL,
    MARKET_SEARCH_HL: env.MARKET_SEARCH_HL,
    MARKET_RESEARCH_WINDOW_DAYS: env.MARKET_RESEARCH_WINDOW_DAYS,
    MARKET_MAX_QUERIES_PER_RUN: env.MARKET_MAX_QUERIES_PER_RUN,
    QA_MIN_SCORE: env.QA_MIN_SCORE,
    QA_MAX_FIX_ITERATIONS: env.QA_MAX_FIX_ITERATIONS,
    QA_FAIL_SCORE: env.QA_FAIL_SCORE,
    QA_AUDIT_STALE_HOURS: env.QA_AUDIT_STALE_HOURS,
  };
}

// ------------------------------------------------------------
// Capacidade de geracao de conteudo para o pipeline, usando o builder de PDF
// REAL (lib/pdf.ts). Gera em DRAFT (publish:false) — o GATE 2 publica.
// ------------------------------------------------------------
function buildContentCapability(): ContentGenerationCapability {
  return {
    async generateDraft(ctx, input) {
      const agent = new ContentAgent(buildEbookPdf, {
        niche: input.niche,
        title: input.title,
        language: input.language,
        marketOpportunityId: input.marketOpportunityId,
        publish: false,
      });
      const rec = await agent.execute(ctx);
      return { ebookId: agent.lastEbookId, runId: rec.id };
    },
  };
}

export default async function ebooksRoutes(fastify: FastifyInstance): Promise<void> {
  // --- GET /ebooks ---
  fastify.get('/ebooks', async (request, reply) => {
    const parsed = listEbooksQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { status, niche, limit, offset } = parsed.data;

    const where = {
      ...(status ? { status } : {}),
      ...(niche ? { niche } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.ebook.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          title: true,
          niche: true,
          slug: true,
          status: true,
          pdfPath: true,
          language: true,
          createdAt: true,
          products: {
            where: { active: true },
            select: { id: true, slug: true, priceCents: true, name: true },
          },
        },
      }),
      prisma.ebook.count({ where }),
    ]);

    return reply.send({ items, total, limit, offset });
  });

  // --- GET /ebooks/:id ---
  fastify.get<{ Params: { id: string } }>('/ebooks/:id', async (request, reply) => {
    const { id } = request.params;
    const ebook = await prisma.ebook.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        niche: true,
        slug: true,
        status: true,
        outline: true,
        contentMarkdown: true,
        pdfPath: true,
        coverImagePath: true,
        language: true,
        createdAt: true,
        updatedAt: true,
        products: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            priceCents: true,
            active: true,
          },
        },
      },
    });

    if (!ebook) {
      return reply.code(404).send({ error: 'ebook_not_found' });
    }
    return reply.send(ebook);
  });

  // --- POST /ebooks/generate (admin) ---
  // Dispara o PIPELINE DE LANCAMENTO (GATES mercado + qualidade), NAO o
  // ContentAgent cru: 201 se lancado (PUBLISHED + Product), 422 se nao ha
  // oportunidade de mercado (GATE 1), 202 se reprovado no QA (mantido DRAFT).
  // Protegido por JWT (decorator do server.ts).
  fastify.post(
    '/ebooks/generate',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const parsed = generateEbookBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const { niche, title, language } = parsed.data;

      // Monta ports (stub/real por env) + MarketDataPort (defensivo) e contexto.
      const llm = createLLMAdapter({
        USE_STUBS: env.USE_STUBS,
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      });
      const marketData = await resolveMarketData();
      const ports: Ports = {
        llm,
        storage: createLocalStorage(env.STORAGE_DIR),
        payment: unusedPayment,
        email: unusedEmail,
        instagram: unusedInstagram,
        ads: unusedAds,
        ...(marketData ? { marketData } : {}),
      };

      const ctx: AgentContext = {
        prisma,
        ports,
        env: buildAgentEnv(),
        log: fastify.log,
        clock: { now: () => new Date() },
      };

      // PIPELINE DE LANCAMENTO com os dois GATES (mercado + qualidade). niche/title
      // do body sao sugestoes; o GATE 1 SELECIONA a oportunidade de maior potencial
      // (e exige que exista uma — senao 422). Injeta a capacidade de conteudo com o
      // builder de PDF real; market/qa sao resolvidos pelo wiring default do pipeline.
      const result = await createAndLaunchEbook(
        ctx,
        { niche, title, language },
        { content: buildContentCapability() },
      );

      // GATE de mercado: sem oportunidade selecionada -> 422 (nada e gerado).
      if (!result.launched && result.stage === 'MARKET_GATE') {
        return reply.code(422).send({
          error: 'no_market_opportunity',
          message: result.reason,
          stage: result.stage,
        });
      }

      // GATE de qualidade reprovou (ou conteudo falhou): ebook fica DRAFT.
      if (!result.launched) {
        const ebook = result.ebookId
          ? await prisma.ebook.findUnique({
              where: { id: result.ebookId },
              select: { id: true, title: true, slug: true, niche: true, status: true },
            })
          : null;
        return reply.code(202).send({
          launched: false,
          stage: result.stage,
          reason: result.reason,
          verdict: result.verdict,
          score: result.score,
          ebook,
        });
      }

      // Lancado: PUBLISHED + Product ativo.
      const ebook = result.ebookId
        ? await prisma.ebook.findUnique({
            where: { id: result.ebookId },
            select: { id: true, title: true, slug: true, niche: true, status: true },
          })
        : null;

      return reply.code(201).send({
        launched: true,
        stage: result.stage,
        reason: result.reason,
        opportunityId: result.opportunityId,
        productId: result.productId,
        verdict: result.verdict,
        score: result.score,
        fixIterations: result.fixIterations,
        ebook,
      });
    },
  );
}
