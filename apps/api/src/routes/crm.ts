// Rota /crm — CRM / Command Center (operacao autonoma / COO).
//
// Dono: MODULO ROTAS /crm. server.ts (Fundacao) ja registra este plugin por
// caminho fixo — NUNCA editar server.ts. Convencao (ver health.ts/agents.ts):
// default export async (fastify) => {}; dinheiro SEMPRE Int centavos; mensagens
// de usuario em pt-BR; rotas de escrita/controle protegidas por
// fastify.authenticate (Bearer JWT).
//
// Endpoints (doc secao 9):
//   GET  /crm/health                  (Fundacao — mantido; disponibilidade)
//   GET  /crm/overview                saude+score de todos os setores + contadores
//   GET  /crm/sectors/:sector         detalhe do setor + historico de snapshots
//   GET  /crm/problems                filtros status/sector/severity + paginacao
//   GET  /crm/problems/:id            diagnostico + acoes + execucoes
//   GET  /crm/actions                 timeline de acoes (filtros)
//   POST /crm/actions/:id/approve     [JWT] fila HIGH -> APPROVED -> aplica
//   POST /crm/actions/:id/reject      [JWT] fila HIGH -> REJECTED
//   POST /crm/actions/:id/rollback    [JWT] reverte uma acao APLICADA reversivel
//   GET  /crm/guardrails              config atual (singleton, fail-closed)
//   POST /crm/guardrails              [JWT] patch parcial da config
//   POST /crm/killswitch              [JWT] liga/desliga kill switch global
//   POST /crm/scan                    [JWT] dispara runOperationsCycle (tick FAST)
//
// O teto financeiro (newDailyBudgetCents <= teto) e validado aqui no /approve
// como TERCEIRA camada (catalogo + executor + rota) conforme doc 5.2.

import type { FastifyInstance } from 'fastify';

import {
  SECTORS,
  statusFromScore,
  listProblemsQuerySchema,
  listActionsQuerySchema,
  sectorParamsSchema,
  sectorHistoryQuerySchema,
  crmIdParamsSchema,
  updateGuardrailsBodySchema,
  setKillSwitchBodySchema,
  scanBodySchema,
  rejectActionBodySchema,
  type Sector,
} from '@ebook-empire/core';

import { prisma } from '../db.js';
import { env } from '../env.js';

// ------------------------------------------------------------
// Acesso DEFENSIVO ao scheduler (dono: modulo OperationsAgent).
// Escrita disjunta: o scheduler expoe runOperationsCycle(app, sector?) e
// applyApprovedAction(app, actionId) quando o dono do COO os adicionar.
// Importamos por nome de forma tolerante para que esta rota compile e rode
// mesmo antes do scheduler ganhar essas funcoes (fail-safe: 503 amigavel).
// ------------------------------------------------------------
type AlertNotifierLike = {
  notify: (input: {
    event: string;
    sector?: Sector;
    severity?: string;
    context?: Record<string, unknown>;
  }) => Promise<void>;
};

type SchedulerModule = {
  runOperationsCycle?: (
    app: FastifyInstance,
    sector?: Sector,
  ) => Promise<unknown>;
  applyApprovedAction?: (
    app: FastifyInstance,
    actionId: string,
  ) => Promise<{ success: boolean; error?: string; blockedByGuardrail?: string }>;
  getAlert?: (app: FastifyInstance) => Promise<AlertNotifierLike | null>;
};

async function loadScheduler(): Promise<SchedulerModule> {
  try {
    return (await import('../scheduler.js')) as SchedulerModule;
  } catch {
    return {};
  }
}

// Teto financeiro dinamico em centavos: override em GuardrailConfig.maxAdBudgetCents
// ou, na ausencia, MAX_AD_BUDGET_BRL*100. Fonte unica usada por /approve.
function budgetCapCents(maxAdBudgetCents: number | null | undefined): number {
  if (typeof maxAdBudgetCents === 'number' && maxAdBudgetCents > 0) {
    return maxAdBudgetCents;
  }
  return env.MAX_AD_BUDGET_BRL * 100;
}

// Le o singleton de guardrails com fallback fail-closed (ausente => killSwitch on).
async function readGuardrails(): Promise<{
  id: string;
  killSwitch: boolean;
  maxAutoActionsPerCycle: number;
  cooldownMinutes: number;
  maxAdBudgetCents: number | null;
  updatedAt: Date | null;
}> {
  const g = await prisma.guardrailConfig.findUnique({ where: { id: 'singleton' } });
  if (g) {
    return {
      id: g.id,
      killSwitch: g.killSwitch,
      maxAutoActionsPerCycle: g.maxAutoActionsPerCycle,
      cooldownMinutes: g.cooldownMinutes,
      maxAdBudgetCents: g.maxAdBudgetCents ?? null,
      updatedAt: g.updatedAt ?? null,
    };
  }
  // Fail-closed: singleton ausente => trata como kill switch ligado.
  return {
    id: 'singleton',
    killSwitch: true,
    maxAutoActionsPerCycle: 0,
    cooldownMinutes: 30,
    maxAdBudgetCents: null,
    updatedAt: null,
  };
}

const PROBLEM_OPEN_STATUSES = ['OPEN', 'DIAGNOSING', 'REMEDIATING'] as const;

export default async function crmRoutes(fastify: FastifyInstance): Promise<void> {
  // ==========================================================
  // GET /crm/health — disponibilidade do modulo CRM (Fundacao; mantido).
  // ==========================================================
  fastify.get('/crm/health', async (_request, reply) => {
    try {
      const [openProblems, queuedActions, guardrails] = await Promise.all([
        prisma.problem.count({
          where: { status: { in: [...PROBLEM_OPEN_STATUSES] } },
        }),
        prisma.remediationAction.count({
          where: { riskTier: 'HIGH', status: 'QUEUED' },
        }),
        prisma.guardrailConfig.findUnique({ where: { id: 'singleton' } }),
      ]);

      return reply.code(200).send({
        status: 'ok',
        module: 'crm-command-center',
        killSwitch: guardrails?.killSwitch ?? true,
        openProblems,
        queuedActions,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return reply.code(503).send({
        status: 'degraded',
        module: 'crm-command-center',
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ==========================================================
  // GET /crm/overview — saude+score de todos os setores + contadores.
  // ==========================================================
  fastify.get('/crm/overview', async (_request, reply) => {
    // Ultimo snapshot por setor: pegamos os mais recentes e reduzimos por setor.
    // (Sem DISTINCT ON do Prisma; reducao em memoria sobre janela recente.)
    const recent = await prisma.sectorHealthSnapshot.findMany({
      orderBy: { capturedAt: 'desc' },
      take: 7 * 20, // folga p/ cobrir os 7 setores mesmo com varios ticks
      select: { sector: true, score: true, kpis: true, capturedAt: true },
    });

    const latestBySector = new Map<
      string,
      { sector: string; score: number; kpis: unknown; capturedAt: Date }
    >();
    for (const snap of recent) {
      if (!latestBySector.has(snap.sector)) latestBySector.set(snap.sector, snap);
    }

    const sectors = SECTORS.map((sector) => {
      const snap = latestBySector.get(sector);
      if (!snap) {
        // Setor sem snapshot ainda: status desconhecido (sem score).
        return {
          sector,
          score: null,
          status: null,
          capturedAt: null,
          kpis: null,
        };
      }
      return {
        sector,
        score: snap.score,
        status: statusFromScore(snap.score),
        capturedAt: snap.capturedAt,
        kpis: snap.kpis,
      };
    });

    // Score global = media simples dos setores com snapshot (null se nenhum).
    const scored = sectors.filter((s) => typeof s.score === 'number');
    const globalScore =
      scored.length > 0
        ? Math.round(
            scored.reduce((acc, s) => acc + (s.score as number), 0) / scored.length,
          )
        : null;

    // Contadores de problemas (por status) e acoes (por status/tier).
    const [problemsByStatus, actionsByStatus, queuedHigh] = await Promise.all([
      prisma.problem.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.remediationAction.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.remediationAction.count({
        where: { riskTier: 'HIGH', status: 'QUEUED' },
      }),
    ]);

    const problemCounts: Record<string, number> = {};
    for (const row of problemsByStatus) problemCounts[row.status] = row._count._all;
    const actionCounts: Record<string, number> = {};
    for (const row of actionsByStatus) actionCounts[row.status] = row._count._all;

    const guardrails = await readGuardrails();

    return reply.send({
      globalScore,
      globalStatus: globalScore === null ? null : statusFromScore(globalScore),
      sectors,
      problems: {
        byStatus: problemCounts,
        open:
          (problemCounts.OPEN ?? 0) +
          (problemCounts.DIAGNOSING ?? 0) +
          (problemCounts.REMEDIATING ?? 0),
      },
      actions: {
        byStatus: actionCounts,
        pendingApproval: queuedHigh, // HIGH aguardando aprovacao humana
      },
      guardrails: {
        killSwitch: guardrails.killSwitch,
        maxAutoActionsPerCycle: guardrails.maxAutoActionsPerCycle,
        cooldownMinutes: guardrails.cooldownMinutes,
        maxAdBudgetCents: guardrails.maxAdBudgetCents,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // ==========================================================
  // GET /crm/sectors/:sector — detalhe + historico de snapshots.
  // ==========================================================
  fastify.get('/crm/sectors/:sector', async (request, reply) => {
    const params = sectorParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'bad_request', issues: params.error.issues });
    }
    const query = sectorHistoryQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'bad_request', issues: query.error.issues });
    }
    const { sector } = params.data;
    const { limit, since } = query.data;

    const where = {
      sector,
      ...(since ? { capturedAt: { gte: new Date(since) } } : {}),
    };

    const [history, openProblems] = await Promise.all([
      prisma.sectorHealthSnapshot.findMany({
        where,
        orderBy: { capturedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          score: true,
          kpis: true,
          capturedAt: true,
          cycleId: true,
        },
      }),
      prisma.problem.findMany({
        where: { sector, status: { in: [...PROBLEM_OPEN_STATUSES] } },
        orderBy: { detectedAt: 'desc' },
        select: {
          id: true,
          type: true,
          severity: true,
          status: true,
          rootCause: true,
          detectedAt: true,
        },
      }),
    ]);

    const latest = history[0] ?? null;

    // Anexa o status derivado a cada snapshot do historico (nunca persistido).
    const snapshots = history.map((h) => ({
      ...h,
      status: statusFromScore(h.score),
    }));

    return reply.send({
      sector,
      current: latest
        ? { score: latest.score, status: statusFromScore(latest.score), capturedAt: latest.capturedAt }
        : null,
      openProblems,
      history: snapshots,
    });
  });

  // ==========================================================
  // GET /crm/problems — listagem filtravel + paginacao.
  // ==========================================================
  fastify.get('/crm/problems', async (request, reply) => {
    const parsed = listProblemsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { status, sector, limit, offset } = parsed.data;

    const where = {
      ...(status ? { status } : {}),
      ...(sector ? { sector } : {}),
    };

    const [problems, total] = await Promise.all([
      prisma.problem.findMany({
        where,
        orderBy: { detectedAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          sector: true,
          type: true,
          severity: true,
          status: true,
          rootCause: true,
          detectedAt: true,
          resolvedAt: true,
          _count: { select: { actions: true } },
        },
      }),
      prisma.problem.count({ where }),
    ]);

    return reply.send({
      total,
      limit,
      offset,
      problems: problems.map((p) => ({
        id: p.id,
        sector: p.sector,
        type: p.type,
        severity: p.severity,
        status: p.status,
        rootCause: p.rootCause,
        detectedAt: p.detectedAt,
        resolvedAt: p.resolvedAt,
        actionCount: p._count.actions,
      })),
    });
  });

  // ==========================================================
  // GET /crm/problems/:id — diagnostico + acoes + execucoes.
  // ==========================================================
  fastify.get('/crm/problems/:id', async (request, reply) => {
    const params = crmIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'bad_request', issues: params.error.issues });
    }

    const problem = await prisma.problem.findUnique({
      where: { id: params.data.id },
      include: {
        actions: {
          orderBy: { createdAt: 'desc' },
          include: {
            executions: { orderBy: { startedAt: 'desc' } },
          },
        },
        healthSnapshot: {
          select: { id: true, score: true, kpis: true, capturedAt: true },
        },
      },
    });

    if (!problem) {
      return reply.code(404).send({ error: 'not_found', message: 'Problema nao encontrado.' });
    }

    return reply.send({ problem });
  });

  // ==========================================================
  // GET /crm/actions — timeline de acoes (filtros).
  // ==========================================================
  fastify.get('/crm/actions', async (request, reply) => {
    const parsed = listActionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { status, riskTier, problemId, limit, offset } = parsed.data;

    const where = {
      ...(status ? { status } : {}),
      ...(riskTier ? { riskTier } : {}),
      ...(problemId ? { problemId } : {}),
    };

    const [actions, total] = await Promise.all([
      prisma.remediationAction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          problem: { select: { id: true, sector: true, type: true, status: true } },
          executions: {
            orderBy: { startedAt: 'desc' },
            take: 1,
            select: {
              id: true,
              success: true,
              triggeredBy: true,
              isRollback: true,
              error: true,
              startedAt: true,
              finishedAt: true,
            },
          },
        },
      }),
      prisma.remediationAction.count({ where }),
    ]);

    return reply.send({ total, limit, offset, actions });
  });

  // ==========================================================
  // POST /crm/actions/:id/approve — [JWT] aprova acao HIGH e dispara aplicacao.
  // Valida teto financeiro (3a camada) ANTES de aprovar.
  // ==========================================================
  fastify.post(
    '/crm/actions/:id/approve',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const params = crmIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'bad_request', issues: params.error.issues });
      }

      const action = await prisma.remediationAction.findUnique({
        where: { id: params.data.id },
      });
      if (!action) {
        return reply.code(404).send({ error: 'not_found', message: 'Acao nao encontrada.' });
      }

      // So acoes HIGH passam pela fila de aprovacao. LOW sao aplicadas pelo
      // executor automaticamente — aprova-las manualmente nao faz sentido.
      if (action.riskTier !== 'HIGH') {
        return reply.code(409).send({
          error: 'not_high_risk',
          message: 'Apenas acoes de risco HIGH exigem aprovacao humana.',
        });
      }

      // So aprova o que esta na fila aguardando decisao humana.
      if (action.status !== 'QUEUED') {
        return reply.code(409).send({
          error: 'invalid_status',
          message: `Acao em status '${action.status}' nao pode ser aprovada (esperado QUEUED).`,
        });
      }

      // --- TERCEIRA camada do teto financeiro (doc 5.2) ---
      const guardrails = await readGuardrails();
      const cap = budgetCapCents(guardrails.maxAdBudgetCents);
      if (action.kind === 'INCREASE_AD_BUDGET' || action.kind === 'DECREASE_AD_BUDGET') {
        const p = action.params as { newDailyBudgetCents?: unknown };
        const cents = typeof p?.newDailyBudgetCents === 'number' ? p.newDailyBudgetCents : NaN;
        if (!Number.isFinite(cents) || cents <= 0) {
          return reply.code(422).send({
            error: 'invalid_params',
            message: 'newDailyBudgetCents ausente ou invalido para acao de orcamento.',
          });
        }
        if (cents > cap) {
          return reply.code(422).send({
            error: 'budget_cap_exceeded',
            message: `Orcamento solicitado (R$${(cents / 100).toFixed(2)}) excede o teto de R$${(cap / 100).toFixed(2)}.`,
            capCents: cap,
            requestedCents: cents,
          });
        }
      }

      // Marca APPROVED antes de aplicar (auditavel; o executor le este status).
      await prisma.remediationAction.update({
        where: { id: action.id },
        data: { status: 'APPROVED' },
      });

      // Dispara a aplicacao via executor (composto no scheduler). Disjuncao:
      // se o scheduler ainda nao expoe applyApprovedAction, devolvemos 202
      // (aprovada; aplicacao sera feita pelo COO no proximo tick).
      const scheduler = await loadScheduler();
      if (typeof scheduler.applyApprovedAction !== 'function') {
        return reply.code(202).send({
          approved: true,
          applied: false,
          actionId: action.id,
          message: 'Acao aprovada. Aplicacao sera processada pelo COO no proximo ciclo.',
        });
      }

      try {
        const result = await scheduler.applyApprovedAction(fastify, action.id);
        if (!result.success) {
          return reply.code(200).send({
            approved: true,
            applied: false,
            actionId: action.id,
            blockedByGuardrail: result.blockedByGuardrail ?? null,
            error: result.error ?? null,
            message: 'Acao aprovada, mas a aplicacao nao concluiu (ver detalhes).',
          });
        }
        return reply.code(200).send({
          approved: true,
          applied: true,
          actionId: action.id,
          message: 'Acao aprovada e aplicada.',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err: message, actionId: action.id }, 'falha ao aplicar acao aprovada');
        return reply.code(500).send({
          error: 'apply_failed',
          approved: true,
          applied: false,
          actionId: action.id,
          message,
        });
      }
    },
  );

  // ==========================================================
  // POST /crm/actions/:id/reject — [JWT] rejeita acao HIGH na fila.
  // ==========================================================
  fastify.post(
    '/crm/actions/:id/reject',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const params = crmIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'bad_request', issues: params.error.issues });
      }
      const body = rejectActionBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
      }

      const action = await prisma.remediationAction.findUnique({
        where: { id: params.data.id },
      });
      if (!action) {
        return reply.code(404).send({ error: 'not_found', message: 'Acao nao encontrada.' });
      }
      if (action.status !== 'QUEUED') {
        return reply.code(409).send({
          error: 'invalid_status',
          message: `Acao em status '${action.status}' nao pode ser rejeitada (esperado QUEUED).`,
        });
      }

      const updated = await prisma.remediationAction.update({
        where: { id: action.id },
        data: { status: 'REJECTED' },
      });

      return reply.send({
        rejected: true,
        actionId: updated.id,
        reason: body.data.reason ?? null,
      });
    },
  );

  // ==========================================================
  // POST /crm/actions/:id/rollback — [JWT] reverte acao APLICADA reversivel.
  // ==========================================================
  fastify.post(
    '/crm/actions/:id/rollback',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const params = crmIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'bad_request', issues: params.error.issues });
      }

      const action = await prisma.remediationAction.findUnique({
        where: { id: params.data.id },
        include: {
          executions: {
            where: { isRollback: false, success: true },
            orderBy: { startedAt: 'desc' },
            take: 1,
          },
        },
      });
      if (!action) {
        return reply.code(404).send({ error: 'not_found', message: 'Acao nao encontrada.' });
      }
      if (action.status !== 'APPLIED') {
        return reply.code(409).send({
          error: 'invalid_status',
          message: `Apenas acoes APPLIED podem ser revertidas (status atual: '${action.status}').`,
        });
      }
      if (!action.reversible) {
        return reply.code(409).send({
          error: 'not_reversible',
          message: 'Esta acao nao e reversivel.',
        });
      }
      const lastExecution = action.executions[0];
      if (!lastExecution) {
        return reply.code(409).send({
          error: 'no_execution',
          message: 'Nao ha execucao bem-sucedida para reverter.',
        });
      }

      // O rollback concreto e responsabilidade do executor (scheduler). Disjuncao:
      // se ainda nao exposto, devolvemos 501 amigavel sem alterar o estado.
      const scheduler = await loadScheduler();
      const applyRollback = (scheduler as Record<string, unknown>).rollbackAction as
        | ((app: FastifyInstance, executionId: string) => Promise<{ success: boolean; error?: string }>)
        | undefined;

      if (typeof applyRollback !== 'function') {
        return reply.code(501).send({
          error: 'rollback_unavailable',
          message: 'Rollback ainda nao disponivel no executor (sera implementado pelo COO).',
          actionId: action.id,
          executionId: lastExecution.id,
        });
      }

      try {
        const result = await applyRollback(fastify, lastExecution.id);
        if (!result.success) {
          return reply.code(200).send({
            rolledBack: false,
            actionId: action.id,
            error: result.error ?? null,
          });
        }
        return reply.send({ rolledBack: true, actionId: action.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err: message, actionId: action.id }, 'falha ao reverter acao');
        return reply.code(500).send({ error: 'rollback_failed', message });
      }
    },
  );

  // ==========================================================
  // GET /crm/guardrails — config atual (fail-closed).
  // ==========================================================
  fastify.get('/crm/guardrails', async (_request, reply) => {
    const guardrails = await readGuardrails();
    return reply.send({
      ...guardrails,
      // Teto efetivo em centavos (override OU MAX_AD_BUDGET_BRL*100).
      effectiveBudgetCapCents: budgetCapCents(guardrails.maxAdBudgetCents),
    });
  });

  // ==========================================================
  // POST /crm/guardrails — [JWT] patch parcial da config (upsert singleton).
  // ==========================================================
  fastify.post(
    '/crm/guardrails',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const body = updateGuardrailsBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
      }

      const patch = body.data;
      const updated = await prisma.guardrailConfig.upsert({
        where: { id: 'singleton' },
        // Em update so aplicamos os campos enviados (patch parcial).
        update: {
          ...(patch.maxAutoActionsPerCycle !== undefined
            ? { maxAutoActionsPerCycle: patch.maxAutoActionsPerCycle }
            : {}),
          ...(patch.cooldownMinutes !== undefined
            ? { cooldownMinutes: patch.cooldownMinutes }
            : {}),
          ...(patch.maxAdBudgetCents !== undefined
            ? { maxAdBudgetCents: patch.maxAdBudgetCents }
            : {}),
        },
        // Na criacao o singleton herda defaults do schema p/ o que nao veio.
        create: {
          id: 'singleton',
          ...(patch.maxAutoActionsPerCycle !== undefined
            ? { maxAutoActionsPerCycle: patch.maxAutoActionsPerCycle }
            : {}),
          ...(patch.cooldownMinutes !== undefined
            ? { cooldownMinutes: patch.cooldownMinutes }
            : {}),
          ...(patch.maxAdBudgetCents !== undefined
            ? { maxAdBudgetCents: patch.maxAdBudgetCents }
            : {}),
        },
      });

      return reply.send({
        updated: true,
        guardrails: {
          id: updated.id,
          killSwitch: updated.killSwitch,
          maxAutoActionsPerCycle: updated.maxAutoActionsPerCycle,
          cooldownMinutes: updated.cooldownMinutes,
          maxAdBudgetCents: updated.maxAdBudgetCents ?? null,
          updatedAt: updated.updatedAt,
        },
      });
    },
  );

  // ==========================================================
  // POST /crm/killswitch — [JWT] liga/desliga o kill switch global.
  // ==========================================================
  fastify.post(
    '/crm/killswitch',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const body = setKillSwitchBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
      }

      const updated = await prisma.guardrailConfig.upsert({
        where: { id: 'singleton' },
        update: { killSwitch: body.data.enabled },
        create: { id: 'singleton', killSwitch: body.data.enabled },
      });

      // ALERTA EXTERNO (Feature 1): apos alternar o switch, dispara KILL_SWITCH_ON
      // (CRITICAL) ou KILL_SWITCH_OFF (WARNING). ON e OFF sao eventos DISTINTOS
      // (dedupeKey distinto) para nunca suprimir uma troca real de estado.
      // Best-effort: falha do alerta NUNCA altera a resposta HTTP do kill switch.
      try {
        const scheduler = await loadScheduler();
        const alert = typeof scheduler.getAlert === 'function' ? await scheduler.getAlert(fastify) : null;
        await alert?.notify({
          event: updated.killSwitch ? 'KILL_SWITCH_ON' : 'KILL_SWITCH_OFF',
          severity: updated.killSwitch ? 'CRITICAL' : 'WARNING',
          context: { killSwitch: updated.killSwitch },
        });
      } catch (err) {
        fastify.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'killswitch: falha ao disparar alerta externo (ignorada — best-effort)',
        );
      }

      return reply.send({
        killSwitch: updated.killSwitch,
        message: updated.killSwitch
          ? 'Kill switch LIGADO — nenhuma acao sera aplicada automaticamente.'
          : 'Kill switch DESLIGADO — execucao autonoma retomada.',
      });
    },
  );

  // ==========================================================
  // POST /crm/scan — [JWT] dispara um ciclo do COO (tick FAST sob demanda).
  // ==========================================================
  fastify.post(
    '/crm/scan',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const body = scanBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
      }

      const scheduler = await loadScheduler();
      if (typeof scheduler.runOperationsCycle !== 'function') {
        // Disjuncao: o COO/scheduler ainda nao expoe o ciclo. Devolve 503
        // amigavel — a rota existe e valida, mas o motor nao esta pronto.
        return reply.code(503).send({
          error: 'operations_unavailable',
          message: 'Ciclo de operacoes (COO) ainda nao disponivel no scheduler.',
        });
      }

      try {
        const result = await scheduler.runOperationsCycle(fastify, body.data.sector);
        return reply.code(202).send({ triggered: true, sector: body.data.sector ?? null, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err: message }, 'falha ao disparar scan de operacoes');
        return reply.code(500).send({ error: 'scan_failed', message });
      }
    },
  );
}

// Helper exportado p/ teste de unidade do teto financeiro (3a camada).
export const _budgetCapCents = budgetCapCents;
