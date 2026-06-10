// Rotas de social (Instagram). Plugin Fastify — registrado por caminho fixo
// no server.ts. NAO editar server.ts.
//
// Endpoints:
//   GET  /social/posts            -> lista SocialPost (filtro status/limit/offset)
//   POST /social/posts            -> gera+agenda um post (roda 1 tick do SocialAgent)
//   POST /social/posts/:id/publish-> publica um SocialPost especifico via InstagramPort
//
// As rotas de escrita rodam logica de dominio reutilizando o SocialAgent e os
// adapters (factory real<->stub por env). A leitura vai direto ao Prisma.

import type { FastifyInstance } from 'fastify';
import {
  listSocialPostsQuerySchema,
  generateSocialPostBodySchema,
  socialPostIdParamsSchema,
  type Ports,
} from '@ebook-empire/core';
import {
  SocialAgent,
  type AgentContext,
  type AgentEnv,
  systemClock,
} from '@ebook-empire/agents';
import {
  createLLMAdapter,
  createInstagramAdapter,
} from '@ebook-empire/adapters';
import { prisma } from '../db.js';
import { env, CONTENT_MODEL, PLANNING_MODEL } from '../env.js';

// Monta o subconjunto de env esperado pelos agentes (AgentEnv).
function buildAgentEnv(): AgentEnv {
  return {
    ENABLE_AGENTS: env.ENABLE_AGENTS,
    MAX_AD_BUDGET_BRL: env.MAX_AD_BUDGET_BRL,
    TARGET_DAILY_REVENUE_BRL: env.TARGET_DAILY_REVENUE_BRL,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
    CONTENT_MODEL,
    PLANNING_MODEL,
  };
}

// Bundle de ports necessario para o modulo social (llm + instagram).
// Os demais ports nao sao usados aqui; construimos so o que precisamos.
function buildSocialPorts(): Pick<Ports, 'llm' | 'instagram'> {
  const llm = createLLMAdapter({
    USE_STUBS: env.USE_STUBS,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  });
  const instagram = createInstagramAdapter({
    USE_STUBS: env.USE_STUBS,
    META_GRAPH_TOKEN: env.META_GRAPH_TOKEN,
    META_AD_ACCOUNT_ID: env.META_AD_ACCOUNT_ID,
  });
  return { llm, instagram };
}

export default async function socialRoutes(fastify: FastifyInstance): Promise<void> {
  // --- GET /social/posts (admin) ---
  fastify.get(
    '/social/posts',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const query = listSocialPostsQuerySchema.parse(request.query);
      const where = query.status ? { status: query.status } : {};
      const [items, total] = await Promise.all([
        prisma.socialPost.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: query.limit,
          skip: query.offset,
        }),
        prisma.socialPost.count({ where }),
      ]);
      return reply.send({ items, total, limit: query.limit, offset: query.offset });
    },
  );

  // --- POST /social/posts (admin) -> gera+agenda via SocialAgent ---
  fastify.post(
    '/social/posts',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      // Body opcional (productId/theme/scheduledAt) — validado, mas o tick do
      // agente decide o ebook frio. Mantemos a validacao para contrato estavel.
      generateSocialPostBodySchema.parse(request.body ?? {});

      const ports = buildSocialPorts() as Ports;
      const ctx: AgentContext = {
        prisma,
        ports,
        env: buildAgentEnv(),
        log: fastify.log,
        clock: systemClock,
      };

      const agent = new SocialAgent();
      const record = await agent.execute(ctx);

      // Retorna o run + os posts mais recentes para feedback imediato no dashboard.
      const recent = await prisma.socialPost.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      return reply.code(202).send({ run: record, recent });
    },
  );

  // --- POST /social/posts/:id/publish (admin) -> publica um post especifico ---
  fastify.post(
    '/social/posts/:id/publish',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = socialPostIdParamsSchema.parse(request.params);
      const post = await prisma.socialPost.findUnique({ where: { id } });
      if (!post) {
        return reply.code(404).send({ error: 'social_post_nao_encontrado' });
      }
      if (post.status === 'PUBLISHED') {
        return reply.code(409).send({ error: 'post_ja_publicado', post });
      }

      const { instagram } = buildSocialPorts();
      const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
      const first = post.mediaPaths[0];
      const mediaUrl =
        first && /^https?:\/\//.test(first)
          ? first
          : first
            ? `${base}/${first.replace(/^\//, '')}`
            : `${base}/static/social-placeholder.png`;

      try {
        const result = await instagram.publishPost({
          caption: post.caption,
          mediaUrl,
          hashtags: post.hashtags,
        });
        const insights = await instagram
          .getPostInsights(result.externalId)
          .catch(() => null);

        const existing =
          post.metrics && typeof post.metrics === 'object' && !Array.isArray(post.metrics)
            ? (post.metrics as Record<string, unknown>)
            : {};
        const metrics = insights ? { ...existing, ...insights } : existing;

        const updated = await prisma.socialPost.update({
          where: { id: post.id },
          data: {
            status: 'PUBLISHED',
            publishedAt: new Date(),
            externalPostId: result.externalId,
            permalink: result.permalink,
            attempts: { increment: 1 },
            error: null,
            metrics: metrics as never,
          },
        });

        await prisma.event.create({
          data: {
            type: 'SOCIAL_POSTED',
            productId: post.productId,
            payload: {
              socialPostId: post.id,
              externalPostId: result.externalId,
              permalink: result.permalink,
            },
          },
        });

        return reply.send({ post: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const updated = await prisma.socialPost.update({
          where: { id: post.id },
          data: {
            status: 'FAILED',
            attempts: { increment: 1 },
            error: message,
          },
        });
        return reply.code(502).send({ error: 'falha_ao_publicar', message, post: updated });
      }
    },
  );
}
