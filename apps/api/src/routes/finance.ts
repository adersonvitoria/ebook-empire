// Rota /finance — Financeiro consolidado (Feature 2).
//
// Dono: MODULO ROTAS /finance. server.ts (Fundacao) ja registra este plugin —
// NUNCA editar server.ts. Convencao (ver crm.ts/health.ts): default export
// async (fastify) => {}; validacao Zod safeParse com 400 { error: 'bad_request',
// issues }; pt-BR; dinheiro SEMPRE Int centavos (excecao: marginPct/roas sao
// razoes/percentuais). Leituras SEM JWT (como GET /crm/overview); apenas a
// escrita (snapshot) exige Bearer (fastify.authenticate).
//
// Endpoints (doc FINANCE.md secao 5):
//   GET  /finance/health                          (Fundacao — mantido)
//   GET  /finance/overview                         DRE do dia + progresso da meta
//   GET  /finance/dre?date=YYYY-MM-DD              DRE do dia (default hoje SP)
//   GET  /finance/by-ebook?date=YYYY-MM-DD         contribuicao por ebook + bucket unattributed
//   GET  /finance/by-campaign?date=YYYY-MM-DD      por campanha + bucket organico
//   GET  /finance/snapshots?from=&to=              serie de FinanceSnapshot (default 30 dias)
//   POST /finance/snapshot { date? }   [JWT]       computa + upsert do dia (default hoje)
//
// O calculo concreto e responsabilidade do FinanceService (modulo 3,
// @ebook-empire/agents): metodos ctx-based (computeDre / marginByEbook /
// marginByCampaign / persistSnapshot). Esta rota valida a entrada, monta um
// AgentContext leve (prisma + env + clock + log; ports nao sao usados pelo
// service) e serializa a saida. A serie historica (snapshots) e uma leitura
// direta de FinanceSnapshot — o service nao expoe metodo de historico.

import type { FastifyInstance } from 'fastify';

import type { Ports, FinanceSnapshotView } from '@ebook-empire/core';
import {
  financeQuerySchema,
  financeHistoryQuerySchema,
  snapshotFinanceBodySchema,
} from '@ebook-empire/core';
import type { AgentContext, AgentEnv, AgentLogger } from '@ebook-empire/agents';
import { FinanceService, saoPauloDay } from '@ebook-empire/agents';

import { prisma } from '../db.js';
import { env } from '../env.js';

const systemClock = { now: () => new Date() };

// ------------------------------------------------------------
// AgentEnv para o FinanceService. Reaproveita o formato de buildAgentEnv do
// scheduler/ebooks somando as envs financeiras (o service le ASAAS_FEE_* e
// TARGET_DAILY_REVENUE_BRL via o index signature do AgentEnv). Os dois CONTENT/
// PLANNING_MODEL sao exigidos pelo tipo, mas o service nao os usa.
// ------------------------------------------------------------
function buildAgentEnv(): AgentEnv {
  return {
    ENABLE_AGENTS: env.ENABLE_AGENTS,
    MAX_AD_BUDGET_BRL: env.MAX_AD_BUDGET_BRL,
    TARGET_DAILY_REVENUE_BRL: env.TARGET_DAILY_REVENUE_BRL,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
    CONTENT_MODEL: 'claude-sonnet-4-6',
    PLANNING_MODEL: 'claude-opus-4-8',
    ASAAS_FEE_PERCENT: env.ASAAS_FEE_PERCENT,
    ASAAS_FEE_FIXED_CENTS: env.ASAAS_FEE_FIXED_CENTS,
  };
}

// Ports nao sao tocados pelo FinanceService (so le Prisma). Para satisfazer o
// tipo AgentContext sem acoplar a resolucao real de adapters, usamos um proxy
// que lanca se qualquer port for invocado por engano.
function notImplementedPorts(): Ports {
  const guard = (path: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          return () => {
            throw new Error(`Port ${path}.${String(prop)} indisponivel na rota /finance.`);
          };
        },
      },
    );
  return new Proxy({} as Ports, {
    get(_t, prop) {
      return guard(String(prop));
    },
  });
}

function buildContext(fastify: FastifyInstance): AgentContext {
  const log: AgentLogger = {
    debug: (obj, msg) => fastify.log.debug(obj as object, msg),
    info: (obj, msg) => fastify.log.info(obj as object, msg),
    warn: (obj, msg) => fastify.log.warn(obj as object, msg),
    error: (obj, msg) => fastify.log.error(obj as object, msg),
  };
  return {
    prisma,
    ports: notImplementedPorts(),
    env: buildAgentEnv(),
    log,
    clock: systemClock,
  };
}

export default async function financeRoutes(fastify: FastifyInstance): Promise<void> {
  const service = new FinanceService();
  const ctx = buildContext(fastify);

  // ==========================================================
  // GET /finance/health — disponibilidade do modulo (Fundacao; mantido).
  // ==========================================================
  fastify.get('/finance/health', async (_request, reply) => {
    return reply.code(200).send({ status: 'ok', module: 'finance' });
  });

  // ==========================================================
  // GET /finance/overview — DRE do dia (hoje SP) + progresso da meta.
  // Atalho de conveniencia da home financeira: e a DRE de hoje, sem query.
  // ==========================================================
  fastify.get('/finance/overview', async (_request, reply) => {
    const dre = await service.computeDre(ctx);
    return reply.send(dre);
  });

  // ==========================================================
  // GET /finance/dre?date= — DRE do periodo (dia; default hoje SP).
  // ==========================================================
  fastify.get('/finance/dre', async (request, reply) => {
    const parsed = financeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const dre = await service.computeDre(ctx, { day: parsed.data.date });
    return reply.send(dre);
  });

  // ==========================================================
  // GET /finance/by-ebook?date= — contribuicao por ebook + bucket unattributed.
  // ==========================================================
  fastify.get('/finance/by-ebook', async (request, reply) => {
    const parsed = financeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const result = await service.marginByEbook(ctx, { day: parsed.data.date });
    return reply.send(result);
  });

  // ==========================================================
  // GET /finance/by-campaign?date= — por campanha + bucket organico (sem_campanha).
  // ==========================================================
  fastify.get('/finance/by-campaign', async (request, reply) => {
    const parsed = financeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const result = await service.marginByCampaign(ctx, { day: parsed.data.date });
    return reply.send(result);
  });

  // ==========================================================
  // GET /finance/snapshots?from=&to= — serie historica de FinanceSnapshot.
  // Default: ultimos 30 dias (inclusive hoje SP). Leitura direta da tabela
  // (o FinanceService nao expoe metodo de historico).
  // ==========================================================
  fastify.get('/finance/snapshots', async (request, reply) => {
    const parsed = financeHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }

    const to = parsed.data.to ?? saoPauloDay(systemClock.now());
    const from = parsed.data.from ?? defaultFromDay(to, 30);

    const rows = await prisma.financeSnapshot.findMany({
      where: {
        date: {
          gte: new Date(`${from}T00:00:00.000Z`),
          lte: new Date(`${to}T00:00:00.000Z`),
        },
      },
      orderBy: { date: 'asc' },
    });

    const snapshots: FinanceSnapshotView[] = rows.map((r) => ({
      id: r.id,
      date: r.date.toISOString().slice(0, 10),
      grossRevenueCents: r.grossRevenueCents,
      paymentFeesCents: r.paymentFeesCents,
      adSpendCents: r.adSpendCents,
      llmCostCents: r.llmCostCents,
      netProfitCents: r.netProfitCents,
      marginPct: r.marginPct,
      paidOrders: r.paidOrders,
      computedAt: r.computedAt,
    }));

    return reply.send({ from, to, snapshots });
  });

  // ==========================================================
  // POST /finance/snapshot — [JWT] computa + upsert do consolidado de um dia.
  // Idempotente (upsert por @@unique([date])). Default: hoje SP.
  // ==========================================================
  fastify.post(
    '/finance/snapshot',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const body = snapshotFinanceBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
      }

      const day = body.data.date ?? saoPauloDay(systemClock.now());
      const snapshot = await service.persistSnapshot(ctx, { day });
      return reply.send({ computed: true, snapshot });
    },
  );
}

// ------------------------------------------------------------
// Helper: dia (YYYY-MM-DD) N dias antes de `to`, inclusivo (janela de N dias).
// Puro e local (sem dependencia de timezone — opera sobre a data calendarica).
// ------------------------------------------------------------
function defaultFromDay(to: string, windowDays: number): string {
  const base = new Date(`${to}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() - (windowDays - 1));
  return base.toISOString().slice(0, 10);
}

// Exportado p/ teste de unidade da janela default.
export const _defaultFromDay = defaultFromDay;
