// Rota /ads e /analytics — trafego pago + KPIs.
// Convencao de plugin Fastify: export default async (fastify) => {}.
// NUNCA editar server.ts; ele ja registra este plugin.
//
//  GET  /ads/campaigns        — lista campanhas (admin)
//  POST /ads/campaigns        — cria campanha p/ um produto (admin)
//  GET  /analytics/kpis       — KPIs do dia (receita, ROAS, CAC, progresso da meta)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { createAdsAdapter } from '@ebook-empire/adapters';
import {
  buildDestinationUrl,
  computeKpis,
  recommendBudget,
  saoPauloDay,
  saoPauloDayBoundsUtc,
} from '@ebook-empire/agents';

// Body de criacao de campanha (admin). Dinheiro em centavos.
const createCampaignBodySchema = z.object({
  productId: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  objective: z.string().min(1).max(60).default('OUTCOME_SALES'),
  dailyBudgetCents: z.coerce.number().int().positive(),
  utmCampaign: z.string().min(1).max(60).optional(),
});

const listCampaignsQuerySchema = z.object({
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const kpisQuerySchema = z.object({
  // Dia local YYYY-MM-DD (America/Sao_Paulo). Default: hoje.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export default async function adsRoutes(fastify: FastifyInstance): Promise<void> {
  // Adapter de ads escolhido por env (USE_STUBS).
  const ads = createAdsAdapter({
    useStubs: env.USE_STUBS,
    metaGraphToken: env.META_GRAPH_TOKEN,
    metaAdAccountId: env.META_AD_ACCOUNT_ID,
  });

  // --- GET /ads/campaigns (admin) ---
  fastify.get(
    '/ads/campaigns',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const q = listCampaignsQuerySchema.parse(request.query);
      const campaigns = await prisma.adCampaign.findMany({
        where: q.status ? { status: q.status } : undefined,
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        skip: q.offset,
      });
      return reply.send({ campaigns });
    },
  );

  // --- POST /ads/campaigns (admin) ---
  fastify.post(
    '/ads/campaigns',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const body = createCampaignBodySchema.parse(request.body);

      const product = await prisma.product.findUnique({
        where: { id: body.productId },
        include: { ebook: true },
      });
      if (!product) {
        return reply.code(404).send({ error: 'product_not_found' });
      }

      const dailyBudgetCents = Math.min(body.dailyBudgetCents, env.MAX_AD_BUDGET_BRL * 100);
      const utmCampaign = (body.utmCampaign ?? `eb-${product.ebook.slug}`).slice(0, 60);
      const name = (body.name ?? `Ebook — ${product.ebook.title}`).slice(0, 120);
      const destinationUrl = buildDestinationUrl(env.PUBLIC_BASE_URL, product.slug, utmCampaign);

      const result = await ads.createCampaign({
        name,
        objective: body.objective,
        dailyBudgetCents,
        targeting: { geo_locations: { countries: ['BR'] } },
        utmCampaign,
        destinationUrl,
      });
      await ads.setStatus(result.externalId, 'ACTIVE');

      const campaign = await prisma.adCampaign.create({
        data: {
          name,
          objective: body.objective,
          status: 'ACTIVE',
          platform: 'meta',
          externalCampaignId: result.externalId,
          productId: product.id,
          dailyBudgetCents,
          utmCampaign,
          targeting: { geo_locations: { countries: ['BR'] } },
          startDate: new Date(),
        },
      });

      await prisma.event.create({
        data: {
          type: 'CAMPAIGN_CREATED',
          adCampaignId: campaign.id,
          productId: product.id,
          utmCampaign,
          costCents: dailyBudgetCents,
        },
      });

      return reply.code(201).send({ campaign });
    },
  );

  // --- GET /analytics/kpis ---
  // Publica os KPIs do dia. Reusa exatamente o calculo do AnalyticsAgent.
  fastify.get('/analytics/kpis', async (request, reply) => {
    const q = kpisQuerySchema.parse(request.query);
    const day = q.date ?? saoPauloDay(new Date());
    const { startUtc, endUtc } = saoPauloDayBoundsUtc(day);
    const targetRevenueCents = env.TARGET_DAILY_REVENUE_BRL * 100;

    const revenueAgg = await prisma.order.aggregate({
      _sum: { priceCents: true },
      _count: { _all: true },
      where: {
        status: { in: ['PAID', 'DELIVERED'] },
        paidAt: { gte: startUtc, lt: endUtc },
      },
    });
    const insightAgg = await prisma.adInsight.aggregate({
      _sum: { spendCents: true, conversions: true },
      where: { date: new Date(`${day}T00:00:00.000Z`) },
    });
    const llmAgg = await prisma.agentRun.aggregate({
      _sum: { costCents: true },
      where: { startedAt: { gte: startUtc, lt: endUtc } },
    });

    const kpi = computeKpis({
      date: day,
      revenueCents: revenueAgg._sum.priceCents ?? 0,
      spendCents: insightAgg._sum.spendCents ?? 0,
      llmCostCents: llmAgg._sum.costCents ?? 0,
      paidOrders: revenueAgg._count._all,
      conversions: insightAgg._sum.conversions ?? 0,
      targetRevenueCents,
    });

    const recommendation = recommendBudget(kpi, {
      maxDailySpendCents: env.MAX_AD_BUDGET_BRL * 100,
    });

    const progressPct =
      targetRevenueCents > 0 ? Math.round((kpi.revenueCents / targetRevenueCents) * 100) : 0;

    return reply.send({ kpi, recommendation, progressPct });
  });
}
