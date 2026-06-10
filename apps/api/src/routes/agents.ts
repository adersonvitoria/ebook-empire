// Rota /agents — observabilidade e controle do runtime de agentes (o "CEO").
//  - GET  /agents/runs    : historico de AgentRun (filtravel por agente/status).
//  - GET  /agents/status  : visao geral do scheduler + ultimo ciclo + KPIs do dia.
//  - POST /agents/cycle   : dispara manualmente um ciclo do orchestrator.
//
// Convencao (ver health.ts): default export async (fastify) => {}; NUNCA editar
// server.ts. Rotas de escrita/controle sao protegidas por fastify.authenticate.

import type { FastifyInstance } from 'fastify';
import { listAgentRunsQuerySchema } from '@ebook-empire/core';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { runOneCycle } from '../scheduler.js';

export default async function agentsRoutes(fastify: FastifyInstance): Promise<void> {
  // --- GET /agents/runs : historico de execucoes ---
  fastify.get('/agents/runs', async (request, reply) => {
    const parsed = listAgentRunsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { agent, status, limit, offset } = parsed.data;

    const where = {
      ...(agent ? { agent } : {}),
      ...(status ? { status } : {}),
    };

    const [runs, total] = await Promise.all([
      prisma.agentRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          agent: true,
          status: true,
          cycleId: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          error: true,
          tokensIn: true,
          tokensOut: true,
          costCents: true,
          metrics: true,
        },
      }),
      prisma.agentRun.count({ where }),
    ]);

    return reply.send({ total, limit, offset, runs });
  });

  // --- GET /agents/status : visao geral do runtime ---
  fastify.get('/agents/status', async (_request, reply) => {
    // Ultimo ciclo do orchestrator.
    const lastCycle = await prisma.agentRun.findFirst({
      where: { agent: 'ORCHESTRATOR' },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        status: true,
        cycleId: true,
        startedAt: true,
        finishedAt: true,
        durationMs: true,
        metrics: true,
      },
    });

    // Contagem de runs por status (todos os agentes).
    const grouped = await prisma.agentRun.groupBy({
      by: ['agent', 'status'],
      _count: { _all: true },
    });

    const byAgent: Record<string, Record<string, number>> = {};
    for (const row of grouped) {
      const a = byAgent[row.agent] ?? {};
      a[row.status] = row._count._all;
      byAgent[row.agent] = a;
    }

    return reply.send({
      enabled: env.ENABLE_AGENTS,
      useStubs: env.USE_STUBS,
      slowTickMs: env.SLOW_TICK_MS,
      targetDailyRevenueBRL: env.TARGET_DAILY_REVENUE_BRL,
      maxAdBudgetBRL: env.MAX_AD_BUDGET_BRL,
      lastCycle,
      runsByAgent: byAgent,
    });
  });

  // --- POST /agents/cycle : disparo manual de um ciclo (protegido) ---
  fastify.post(
    '/agents/cycle',
    { preHandler: fastify.authenticate },
    async (_request, reply) => {
      try {
        const result = await runOneCycle(fastify);
        return reply.code(202).send({ triggered: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err: message }, 'falha ao disparar ciclo manual');
        return reply.code(500).send({ error: 'cycle_failed', message });
      }
    },
  );
}
