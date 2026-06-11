// Rotas do setor MARKET_RESEARCH (analise de mercado / oportunidades).
//
// Dono: MODULO Mercado. server.ts (Fundacao) ja registra este plugin por caminho
// fixo — NUNCA editar server.ts. Convencao (ver health.ts/crm.ts): default export
// async (fastify) => {}; scores 0..100 (NAO centavos); mensagens em pt-BR; rotas
// de escrita/controle protegidas por fastify.authenticate (Bearer JWT).
//
// Endpoints:
//   GET  /market/health         (Fundacao — mantido; disponibilidade)
//   GET  /market/opportunities  oportunidades rankeadas (filtro status + limit)
//   GET  /market/top            a oportunidade SELECTED de maior potencial
//   POST /market/scan   [JWT]   roda o time MARKET_RESEARCH e persiste o ranking
//
// O scheduler (dono PIPELINE) NAO injeta a MarketDataPort no bundle Ports global;
// por isso montamos aqui um AgentContext local com o MarketDataPort resolvido via
// createMarketDataAdapter (real Serper / stub por env). Reaproveita o LLMPort.

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { AgentContext, AgentEnv } from '@ebook-empire/agents';
import { MarketResearchService, systemClock } from '@ebook-empire/agents';
import {
  createLLMAdapter,
  createMarketDataAdapter,
} from '@ebook-empire/adapters';
import type { Ports } from '@ebook-empire/core';
import { marketOpportunityStatusSchema } from '@ebook-empire/core';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env, CONTENT_MODEL, PLANNING_MODEL } from '../env.js';

// ------------------------------------------------------------
// AgentEnv (subconjunto do env + constantes de modelo + campos MARKET_*).
// Os campos MARKET_* fluem via index-signature do AgentEnv (ver base.ts) e sao
// lidos pelo specialist (numEnv/strEnv).
// ------------------------------------------------------------
function buildMarketAgentEnv(): AgentEnv {
  return {
    ENABLE_AGENTS: env.ENABLE_AGENTS,
    MAX_AD_BUDGET_BRL: env.MAX_AD_BUDGET_BRL,
    TARGET_DAILY_REVENUE_BRL: env.TARGET_DAILY_REVENUE_BRL,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
    CONTENT_MODEL,
    PLANNING_MODEL,
    MARKET_DATA_PROVIDER: env.MARKET_DATA_PROVIDER,
    MARKET_SEARCH_GL: env.MARKET_SEARCH_GL,
    MARKET_SEARCH_HL: env.MARKET_SEARCH_HL,
    MARKET_RESEARCH_WINDOW_DAYS: env.MARKET_RESEARCH_WINDOW_DAYS,
    MARKET_MAX_QUERIES_PER_RUN: env.MARKET_MAX_QUERIES_PER_RUN,
  };
}

// ------------------------------------------------------------
// Ports minimos do setor: LLM (enriquecimento) + marketData (pesquisa externa).
// Os demais ports nao sao usados pelo time MARKET_RESEARCH; ficam como throwers
// para falhar claro caso algo tente usa-los por engano.
// ------------------------------------------------------------
function buildMarketPorts(): Ports {
  const notImpl = (n: string): never => {
    throw new Error(`${n} indisponivel no contexto de MARKET_RESEARCH`);
  };
  return {
    llm: createLLMAdapter({
      USE_STUBS: env.USE_STUBS,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      LLM_PROVIDER: env.LLM_PROVIDER,
      GEMINI_API_KEY: env.GEMINI_API_KEY,
      GEMINI_MODEL: env.GEMINI_MODEL,
    }),
    marketData: createMarketDataAdapter({
      USE_STUBS: env.USE_STUBS,
      MARKET_DATA_PROVIDER: env.MARKET_DATA_PROVIDER,
      SERPER_API_KEY: env.SERPER_API_KEY,
      MARKET_SEARCH_GL: env.MARKET_SEARCH_GL,
      MARKET_SEARCH_HL: env.MARKET_SEARCH_HL,
    }),
    payment: {
      createPixCharge: () => notImpl('payment'),
      getPayment: () => notImpl('payment'),
      parseWebhook: () => notImpl('payment'),
    },
    email: { send: () => notImpl('email') },
    storage: {
      putObject: () => notImpl('storage'),
      getObject: () => notImpl('storage'),
      getSignedUrl: () => notImpl('storage'),
    },
    instagram: {
      publishPost: () => notImpl('instagram'),
      uploadMedia: () => notImpl('instagram'),
      getAccountInsights: () => notImpl('instagram'),
      getPostInsights: () => notImpl('instagram'),
    },
    ads: {
      createCampaign: () => notImpl('ads'),
      updateBudget: () => notImpl('ads'),
      setStatus: () => notImpl('ads'),
      getInsights: () => notImpl('ads'),
    },
  };
}

function buildMarketContext(fastify: FastifyInstance, cycleId: string): AgentContext {
  return {
    prisma,
    ports: buildMarketPorts(),
    env: buildMarketAgentEnv(),
    log: {
      debug: (o, m) => fastify.log.debug(o as object, m),
      info: (o, m) => fastify.log.info(o as object, m),
      warn: (o, m) => fastify.log.warn(o as object, m),
      error: (o, m) => fastify.log.error(o as object, m),
    },
    clock: systemClock,
    cycleId,
  };
}

const listOpportunitiesQuerySchema = z.object({
  status: marketOpportunityStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export default async function marketRoutes(fastify: FastifyInstance): Promise<void> {
  const service = new MarketResearchService();

  // --- GET /market/health (Fundacao — mantido) ---
  fastify.get('/market/health', async (_request, reply) => {
    let opportunities = -1;
    try {
      opportunities = await prisma.marketOpportunity.count();
    } catch {
      // tabela pode nao existir em ambientes sem migracao aplicada
    }
    return reply.code(200).send({
      status: 'ok',
      sector: 'MARKET_RESEARCH',
      provider: env.USE_STUBS ? 'stub' : env.MARKET_DATA_PROVIDER,
      opportunities,
      timestamp: new Date().toISOString(),
    });
  });

  // --- GET /market/opportunities : ranking persistido ---
  fastify.get('/market/opportunities', async (request, reply) => {
    const parsed = listOpportunitiesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const ctx = buildMarketContext(fastify, randomUUID());
    const opportunities = await service.latestOpportunities(ctx, {
      limit: parsed.data.limit,
      status: parsed.data.status,
    });
    return reply.send({ total: opportunities.length, opportunities });
  });

  // --- GET /market/top : oportunidade SELECTED de maior potencial ---
  fastify.get('/market/top', async (_request, reply) => {
    const ctx = buildMarketContext(fastify, randomUUID());
    const top = await service.topOpportunity(ctx);
    if (!top) {
      return reply
        .code(404)
        .send({ error: 'not_found', message: 'Nenhuma oportunidade selecionada ainda. Rode POST /market/scan.' });
    }
    return reply.send(top);
  });

  // --- POST /market/scan [JWT] : roda a analise e persiste ---
  fastify.post(
    '/market/scan',
    { preHandler: [fastify.authenticate] },
    async (_request, reply) => {
      const cycleId = randomUUID();
      const ctx = buildMarketContext(fastify, cycleId);
      try {
        const { team, opportunities } = await service.runTeam(ctx);
        return reply.send({
          ok: true,
          cycleId,
          count: opportunities.length,
          top: opportunities[0] ?? null,
          assessment: team.assessment,
          strategy: team.strategy,
          opportunities,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err: message }, 'POST /market/scan falhou');
        return reply.code(500).send({ error: 'scan_failed', message });
      }
    },
  );
}
