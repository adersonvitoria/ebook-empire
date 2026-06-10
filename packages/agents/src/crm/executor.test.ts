// Testes do GuardedActionExecutor (seguranca-critico) e do StaticActionCatalog.
//
// Cobre a politica TIERED + KILL SWITCH:
//  - LOW dentro dos guardrails => aplicada (lever chamado, auditoria APPLIED).
//  - HIGH => enfileirada (QUEUED), NUNCA aplicada automaticamente.
//  - HIGH com aprovacao humana => aplicada.
//  - kill switch => bloqueia tudo (inclusive HUMAN), auditoria de bloqueio.
//  - maxAutoActionsPerCycle e cooldown por (kind,setor) bloqueiam.
//  - teto financeiro (BUDGET_CAP) bloqueia INCREASE_AD_BUDGET acima do teto.
//  - rollback restaura beforeState (revert chamado, status ROLLED_BACK).

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  GuardedActionExecutor,
  type RemediationLevers,
  type LeverResult,
} from './executor.js';
import { StaticActionCatalog } from './action-catalog.js';
import type { Guardrails, Json } from '@ebook-empire/core';
import type { AgentContext } from '../base.js';
import type {
  RemediationActionRef,
  ActionExecutionRef,
  ProblemRef,
  Diagnosis,
} from './contracts.js';

// ============================================================
// Fakes
// ============================================================

interface FakeExecutionRow {
  id: string;
  actionId: string;
  success: boolean;
  beforeState: Json | null;
  afterState: Json | null;
  error: string | null;
  triggeredBy: string;
  isRollback: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  kind: string; // denormalizado p/ filtro de cooldown
  sector: string;
}

/** Prisma minimo em memoria cobrindo a superficie que o executor toca. */
function makeFakePrisma(opts: {
  guardrails: Guardrails | null;
  actions: RemediationActionRef[];
  problemSector: Record<string, string>;
}) {
  const executions: FakeExecutionRow[] = [];
  const actions = new Map(opts.actions.map((a) => [a.id, { ...a }]));

  let seq = 0;
  return {
    _executions: executions,
    _actions: actions,
    guardrailConfig: {
      findUnique: vi.fn(async () => opts.guardrails),
    },
    problem: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const sector = opts.problemSector[where.id] ?? null;
        return sector ? { sector } : null;
      }),
    },
    remediationAction: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return actions.get(where.id) ?? null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = actions.get(where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    actionExecution: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const actionId = data.actionId as string;
        const act = actions.get(actionId);
        const row: FakeExecutionRow = {
          id: `exec_${++seq}`,
          actionId,
          success: data.success as boolean,
          beforeState: (data.beforeState ?? null) as Json | null,
          afterState: (data.afterState ?? null) as Json | null,
          error: (data.error ?? null) as string | null,
          triggeredBy: data.triggeredBy as string,
          isRollback: data.isRollback as boolean,
          startedAt: data.startedAt as Date,
          finishedAt: (data.finishedAt ?? null) as Date | null,
          kind: act?.kind ?? '',
          sector: act ? opts.problemSector[act.problemId] ?? '' : '',
        };
        executions.push(row);
        return row;
      }),
      // Filtro suportado: { success, isRollback, startedAt:{gte}, action:{kind, problem:{sector}} }
      findFirst: vi.fn(async ({ where }: { where: any }) => {
        const since: Date | undefined = where?.startedAt?.gte;
        const kind: string | undefined = where?.action?.kind;
        const sector: string | undefined = where?.action?.problem?.sector;
        const hit = executions.find(
          (e) =>
            e.success === true &&
            e.isRollback === false &&
            (since ? e.startedAt >= since : true) &&
            (kind ? e.kind === kind : true) &&
            (sector ? e.sector === sector : true),
        );
        return hit ? { id: hit.id } : null;
      }),
    },
  };
}

function makeCtx(prisma: unknown, maxAdBudgetBrl = 300): AgentContext {
  const clock = { now: () => new Date('2026-06-10T12:00:00.000Z') };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    prisma: prisma as never,
    ports: {} as never,
    env: {
      ENABLE_AGENTS: true,
      MAX_AD_BUDGET_BRL: maxAdBudgetBrl,
      TARGET_DAILY_REVENUE_BRL: 1000,
      PUBLIC_BASE_URL: 'http://localhost:3001',
      CONTENT_MODEL: 'claude-sonnet-4-6',
      PLANNING_MODEL: 'claude-opus-4-8',
    },
    log,
    clock,
  };
}

/** Levers fake: cada metodo registra a chamada e retorna before/after fixos. */
function makeFakeLevers(): RemediationLevers & { calls: string[] } {
  const calls: string[] = [];
  const r = (before: Json, after: Json): Promise<LeverResult> =>
    Promise.resolve({ beforeState: before, afterState: after });
  return {
    calls,
    retryDeliveries: vi.fn((_c, _p) => { calls.push('retryDeliveries'); return r({ backlog: 5 }, { backlog: 0 }); }),
    generateEbook: vi.fn((_c, _p) => { calls.push('generateEbook'); return r({ ebookCount: 0 }, { ebookCount: 1 }); }),
    generateSocialPosts: vi.fn((_c, _p) => { calls.push('generateSocialPosts'); return r({ posts: 0 }, { posts: 1 }); }),
    regenerateLandingCopy: vi.fn((_c, _p) => { calls.push('regenerateLandingCopy'); return r({ description: 'velha' }, { description: 'nova' }); }),
    recomputeKpis: vi.fn((_c, _p) => { calls.push('recomputeKpis'); return r({}, { recomputed: true }); }),
    rerunAgent: vi.fn((_c, _p) => { calls.push('rerunAgent'); return r({}, { reran: 'CONTENT' }); }),
    increaseAdBudget: vi.fn((_c, p) => { calls.push('increaseAdBudget'); return r({ campaignId: p.campaignId, dailyBudgetCents: 1000 }, { campaignId: p.campaignId, dailyBudgetCents: p.newDailyBudgetCents }); }),
    decreaseAdBudget: vi.fn((_c, p) => { calls.push('decreaseAdBudget'); return r({ campaignId: p.campaignId, dailyBudgetCents: 5000 }, { campaignId: p.campaignId, dailyBudgetCents: p.newDailyBudgetCents }); }),
    pauseCampaign: vi.fn((_c, p) => { calls.push('pauseCampaign'); return r({ campaignId: p.campaignId, status: 'ACTIVE' }, { campaignId: p.campaignId, status: 'PAUSED' }); }),
    adjustPrice: vi.fn((_c, p) => { calls.push('adjustPrice'); return r({ productId: p.productId, priceCents: 4700 }, { productId: p.productId, priceCents: p.newPriceCents }); }),
    // --- producao autonoma (COO-Scale / Fase 5) ---
    generateMoreEbooks: vi.fn((_c, p) => { calls.push('generateMoreEbooks'); return r({ publishedEbooks: 0, niche: p.niche ?? null }, { publishedEbooks: 1, launched: [] }); }),
    pauseListing: vi.fn((_c, p) => { calls.push('pauseListing'); return r({ productId: p.productId, active: true }, { productId: p.productId, active: false }); }),
    boostAffiliateOutreach: vi.fn((_c, _p) => { calls.push('boostAffiliateOutreach'); return r({ prospects: 3 }, { prospectsAfter: 3, boosted: true }); }),
    sendAffiliateEmail: vi.fn((_c, p) => { calls.push('sendAffiliateEmail'); return r({ affiliateId: p.affiliateId }, { affiliateId: p.affiliateId, contacted: true }); }),
    revert: vi.fn((_c, _kind, before) => { calls.push('revert'); return r(before, { reverted: true }); }),
  };
}

const DEFAULT_GUARDRAILS: Guardrails = {
  killSwitch: false,
  maxAutoActionsPerCycle: 5,
  cooldownMinutes: 30,
  maxAdBudgetCents: null,
};

function lowAction(over: Partial<RemediationActionRef> = {}): RemediationActionRef {
  return {
    id: 'act_low',
    problemId: 'prob_delivery',
    kind: 'RETRY_DELIVERIES',
    riskTier: 'LOW',
    params: { kind: 'RETRY_DELIVERIES', limit: 25 } as Json,
    expectedEffect: 'zerar backlog',
    status: 'PROPOSED',
    reversible: false,
    dedupeKey: 'prob_delivery:RETRY_DELIVERIES:abc',
    appliedAt: null,
    ...over,
  };
}

function highBudgetAction(over: Partial<RemediationActionRef> = {}): RemediationActionRef {
  return {
    id: 'act_high',
    problemId: 'prob_traffic',
    kind: 'INCREASE_AD_BUDGET',
    riskTier: 'HIGH',
    params: { kind: 'INCREASE_AD_BUDGET', campaignId: 'camp_1', newDailyBudgetCents: 5000 } as Json,
    expectedEffect: 'escalar receita',
    status: 'PROPOSED',
    reversible: true,
    dedupeKey: 'prob_traffic:INCREASE_AD_BUDGET:xyz',
    appliedAt: null,
    ...over,
  };
}

// ============================================================
// Executor
// ============================================================
describe('GuardedActionExecutor.applyWith', () => {
  let levers: ReturnType<typeof makeFakeLevers>;

  beforeEach(() => {
    levers = makeFakeLevers();
  });

  it('aplica acao LOW dentro dos guardrails (lever chamado, status APPLIED, auditoria success)', async () => {
    const action = lowAction();
    const prisma = makeFakePrisma({
      guardrails: DEFAULT_GUARDRAILS,
      actions: [action],
      problemSector: { prob_delivery: 'DELIVERY' },
    });
    const ctx = makeCtx(prisma);
    const exec = new GuardedActionExecutor(levers);

    const res = await exec.applyWith(ctx, action, { triggeredBy: 'AUTO', autoAppliedThisCycle: 0 });

    expect(res.success).toBe(true);
    expect(res.blockedByGuardrail).toBeUndefined();
    expect(levers.calls).toContain('retryDeliveries');
    expect(prisma._actions.get('act_low')?.status).toBe('APPLIED');
    expect(prisma._executions).toHaveLength(1);
    expect(prisma._executions[0]).toMatchObject({ success: true, isRollback: false, triggeredBy: 'AUTO' });
  });

  it('NAO aplica acao HIGH automaticamente — enfileira (QUEUED) e retorna NOT_APPROVED', async () => {
    const action = highBudgetAction();
    const prisma = makeFakePrisma({
      guardrails: DEFAULT_GUARDRAILS,
      actions: [action],
      problemSector: { prob_traffic: 'TRAFFIC' },
    });
    const ctx = makeCtx(prisma);
    const exec = new GuardedActionExecutor(levers);

    const res = await exec.applyWith(ctx, action, { triggeredBy: 'AUTO' });

    expect(res.success).toBe(false);
    expect(res.blockedByGuardrail).toBe('NOT_APPROVED');
    expect(levers.calls).not.toContain('increaseAdBudget');
    expect(prisma._actions.get('act_high')?.status).toBe('QUEUED');
    // Sem auditoria de execucao (nao houve tentativa de mutacao).
    expect(prisma._executions).toHaveLength(0);
  });

  it('aplica acao HIGH quando aprovada por humano (triggeredBy HUMAN + humanApproved)', async () => {
    const action = highBudgetAction({ status: 'APPROVED' });
    const prisma = makeFakePrisma({
      guardrails: DEFAULT_GUARDRAILS,
      actions: [action],
      problemSector: { prob_traffic: 'TRAFFIC' },
    });
    const ctx = makeCtx(prisma);
    const exec = new GuardedActionExecutor(levers);

    const res = await exec.applyWith(ctx, action, { triggeredBy: 'HUMAN', humanApproved: true });

    expect(res.success).toBe(true);
    expect(levers.calls).toContain('increaseAdBudget');
    expect(prisma._actions.get('act_high')?.status).toBe('APPLIED');
  });

  it('kill switch bloqueia TUDO — inclusive HIGH aprovada por humano', async () => {
    const action = highBudgetAction({ status: 'APPROVED' });
    const prisma = makeFakePrisma({
      guardrails: { ...DEFAULT_GUARDRAILS, killSwitch: true },
      actions: [action],
      problemSector: { prob_traffic: 'TRAFFIC' },
    });
    const ctx = makeCtx(prisma);
    const exec = new GuardedActionExecutor(levers);

    const res = await exec.applyWith(ctx, action, { triggeredBy: 'HUMAN', humanApproved: true });

    expect(res.success).toBe(false);
    expect(res.blockedByGuardrail).toBe('KILL_SWITCH');
    expect(levers.calls).toHaveLength(0);
    expect(prisma._executions[0]).toMatchObject({ success: false });
  });

  it('fail-closed: config de guardrails ausente => trata como kill switch ligado', async () => {
    const action = lowAction();
    const prisma = makeFakePrisma({
      guardrails: null,
      actions: [action],
      problemSector: { prob_delivery: 'DELIVERY' },
    });
    const ctx = makeCtx(prisma);
    const exec = new GuardedActionExecutor(levers);

    const res = await exec.applyWith(ctx, action, { triggeredBy: 'AUTO' });

    expect(res.success).toBe(false);
    expect(res.blockedByGuardrail).toBe('KILL_SWITCH');
    expect(levers.calls).toHaveLength(0);
  });

  it('maxAutoActionsPerCycle bloqueia quando a cota do ciclo ja foi atingida (MAX_AUTO)', async () => {
    const action = lowAction();
    const prisma = makeFakePrisma({
      guardrails: { ...DEFAULT_GUARDRAILS, maxAutoActionsPerCycle: 2 },
      actions: [action],
      problemSector: { prob_delivery: 'DELIVERY' },
    });
    const ctx = makeCtx(prisma);
    const exec = new GuardedActionExecutor(levers);

    const res = await exec.applyWith(ctx, action, { triggeredBy: 'AUTO', autoAppliedThisCycle: 2 });

    expect(res.success).toBe(false);
    expect(res.blockedByGuardrail).toBe('MAX_AUTO');
    expect(levers.calls).toHaveLength(0);
  });

  it('cooldown por (kind,setor): bloqueia se houve execucao bem-sucedida recente do mesmo kind/setor', async () => {
    const action = lowAction();
    const prisma = makeFakePrisma({
      guardrails: { ...DEFAULT_GUARDRAILS, cooldownMinutes: 30 },
      actions: [action],
      problemSector: { prob_delivery: 'DELIVERY' },
    });
    const ctx = makeCtx(prisma);
    const exec = new GuardedActionExecutor(levers);

    // 1a aplicacao: sucesso.
    const first = await exec.applyWith(ctx, action, { triggeredBy: 'AUTO', autoAppliedThisCycle: 0 });
    expect(first.success).toBe(true);

    // 2a aplicacao (mesmo kind/setor, dentro da janela): bloqueada por COOLDOWN.
    const second = await exec.applyWith(ctx, action, { triggeredBy: 'AUTO', autoAppliedThisCycle: 1 });
    expect(second.success).toBe(false);
    expect(second.blockedByGuardrail).toBe('COOLDOWN');
    // Lever chamado so 1 vez.
    expect(levers.calls.filter((c) => c === 'retryDeliveries')).toHaveLength(1);
  });

  it('teto financeiro: INCREASE_AD_BUDGET acima do teto e bloqueado (BUDGET_CAP)', async () => {
    // teto = MAX_AD_BUDGET_BRL(300)*100 = 30000c; pedimos 50000c.
    const action = highBudgetAction({
      status: 'APPROVED',
      params: { kind: 'INCREASE_AD_BUDGET', campaignId: 'camp_1', newDailyBudgetCents: 50000 } as Json,
    });
    const prisma = makeFakePrisma({
      guardrails: DEFAULT_GUARDRAILS,
      actions: [action],
      problemSector: { prob_traffic: 'TRAFFIC' },
    });
    const ctx = makeCtx(prisma, 300);
    const exec = new GuardedActionExecutor(levers);

    const res = await exec.applyWith(ctx, action, { triggeredBy: 'HUMAN', humanApproved: true });

    expect(res.success).toBe(false);
    expect(res.blockedByGuardrail).toBe('BUDGET_CAP');
    expect(levers.calls).not.toContain('increaseAdBudget');
  });

  it('teto financeiro respeita override maxAdBudgetCents da config', async () => {
    // override permite 60000c; pedimos 50000c => passa.
    const action = highBudgetAction({
      status: 'APPROVED',
      params: { kind: 'INCREASE_AD_BUDGET', campaignId: 'camp_1', newDailyBudgetCents: 50000 } as Json,
    });
    const prisma = makeFakePrisma({
      guardrails: { ...DEFAULT_GUARDRAILS, maxAdBudgetCents: 60000 },
      actions: [action],
      problemSector: { prob_traffic: 'TRAFFIC' },
    });
    const ctx = makeCtx(prisma, 300);
    const exec = new GuardedActionExecutor(levers);

    const res = await exec.applyWith(ctx, action, { triggeredBy: 'HUMAN', humanApproved: true });

    expect(res.success).toBe(true);
    expect(levers.calls).toContain('increaseAdBudget');
  });

  it('persiste auditoria com beforeState/afterState retornados pelo lever', async () => {
    const action = lowAction();
    const prisma = makeFakePrisma({
      guardrails: DEFAULT_GUARDRAILS,
      actions: [action],
      problemSector: { prob_delivery: 'DELIVERY' },
    });
    const ctx = makeCtx(prisma);
    const exec = new GuardedActionExecutor(levers);

    await exec.applyWith(ctx, action, { triggeredBy: 'AUTO' });

    const audit = prisma._executions[0];
    expect(audit?.beforeState).toEqual({ backlog: 5 });
    expect(audit?.afterState).toEqual({ backlog: 0 });
  });

  it('lever que lanca => auditoria success=false e status FAILED', async () => {
    const action = lowAction();
    levers.retryDeliveries = vi.fn(async () => { throw new Error('falha simulada'); });
    const prisma = makeFakePrisma({
      guardrails: DEFAULT_GUARDRAILS,
      actions: [action],
      problemSector: { prob_delivery: 'DELIVERY' },
    });
    const ctx = makeCtx(prisma);
    const exec = new GuardedActionExecutor(levers);

    const res = await exec.applyWith(ctx, action, { triggeredBy: 'AUTO' });

    expect(res.success).toBe(false);
    expect(res.error).toContain('falha simulada');
    expect(prisma._actions.get('act_low')?.status).toBe('FAILED');
    expect(prisma._executions[0]).toMatchObject({ success: false, error: expect.stringContaining('falha simulada') });
  });
});

// ============================================================
// rollback
// ============================================================
describe('GuardedActionExecutor.rollback', () => {
  it('reverte acao reversivel restaurando beforeState (revert chamado, status ROLLED_BACK)', async () => {
    const levers = makeFakeLevers();
    const action = highBudgetAction({ id: 'act_rb', reversible: true, status: 'APPLIED' });
    const prisma = makeFakePrisma({
      guardrails: DEFAULT_GUARDRAILS,
      actions: [action],
      problemSector: { prob_traffic: 'TRAFFIC' },
    });
    const ctx = makeCtx(prisma);
    const exec = new GuardedActionExecutor(levers);

    const beforeState: Json = { campaignId: 'camp_1', dailyBudgetCents: 1000, status: 'ACTIVE' };
    const execution: ActionExecutionRef = {
      id: 'exec_orig',
      actionId: 'act_rb',
      success: true,
      beforeState,
      afterState: { campaignId: 'camp_1', dailyBudgetCents: 5000 } as Json,
      error: null,
      triggeredBy: 'HUMAN',
      isRollback: false,
      startedAt: new Date('2026-06-10T11:00:00.000Z'),
      finishedAt: new Date('2026-06-10T11:00:01.000Z'),
    };

    const res = await exec.rollback(ctx, execution);

    expect(res.success).toBe(true);
    expect(levers.revert).toHaveBeenCalledWith(ctx, 'INCREASE_AD_BUDGET', beforeState);
    expect(prisma._actions.get('act_rb')?.status).toBe('ROLLED_BACK');
    // Auditoria de rollback (isRollback=true).
    const lastExec = prisma._executions[prisma._executions.length - 1];
    expect(lastExec).toMatchObject({ isRollback: true, success: true });
  });

  it('recusa rollback de acao nao-reversivel', async () => {
    const levers = makeFakeLevers();
    const action = lowAction({ id: 'act_nr', reversible: false, status: 'APPLIED' });
    const prisma = makeFakePrisma({
      guardrails: DEFAULT_GUARDRAILS,
      actions: [action],
      problemSector: { prob_delivery: 'DELIVERY' },
    });
    const ctx = makeCtx(prisma);
    const exec = new GuardedActionExecutor(levers);

    const execution: ActionExecutionRef = {
      id: 'exec_x',
      actionId: 'act_nr',
      success: true,
      beforeState: {},
      afterState: {},
      error: null,
      triggeredBy: 'AUTO',
      isRollback: false,
      startedAt: new Date(),
      finishedAt: new Date(),
    };

    const res = await exec.rollback(ctx, execution);
    expect(res.success).toBe(false);
    expect(res.error).toContain('nao e reversivel');
    expect(levers.revert).not.toHaveBeenCalled();
  });
});

// ============================================================
// StaticActionCatalog
// ============================================================
describe('StaticActionCatalog.propose', () => {
  const catalog = new StaticActionCatalog();
  const ctx = makeCtx(makeFakePrisma({ guardrails: DEFAULT_GUARDRAILS, actions: [], problemSector: {} }), 300);

  function problem(over: Partial<ProblemRef>): ProblemRef {
    return {
      id: 'p1',
      sector: 'DELIVERY',
      type: 'DELIVERY_BACKLOG',
      severity: 80,
      status: 'OPEN',
      detectedAt: new Date(),
      metadata: null,
      ...over,
    };
  }
  function diag(over: Partial<Diagnosis>): Diagnosis {
    return {
      sector: 'DELIVERY',
      type: 'DELIVERY_BACKLOG',
      severity: 80,
      status: 'OPEN',
      rootCause: 'backlog alto',
      confidence: 0.8,
      evidence: [],
      suggestedActionKinds: [],
      source: 'RULES',
      ...over,
    };
  }

  it('DELIVERY propoe RETRY_DELIVERIES (LOW)', () => {
    const props = catalog.propose(ctx, problem({ sector: 'DELIVERY' }), diag({ sector: 'DELIVERY' }));
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ kind: 'RETRY_DELIVERIES', riskTier: 'LOW' });
  });

  it('TRAFFIC propoe acoes HIGH (INCREASE/DECREASE/PAUSE) com riskTier HIGH', () => {
    const props = catalog.propose(
      ctx,
      problem({ sector: 'TRAFFIC', type: 'NEGATIVE_ROAS', metadata: { campaignId: 'c1', newDailyBudgetCents: 2000 } as Json }),
      diag({ sector: 'TRAFFIC', type: 'NEGATIVE_ROAS', suggestedActionKinds: ['PAUSE_CAMPAIGN', 'DECREASE_AD_BUDGET'] }),
    );
    expect(props.length).toBeGreaterThanOrEqual(1);
    for (const p of props) expect(p.riskTier).toBe('HIGH');
    expect(props.map((p) => p.kind)).toContain('PAUSE_CAMPAIGN');
  });

  it('SALES propoe ADJUST_PRICE (HIGH) + REGENERATE_LANDING_COPY (LOW)', () => {
    const props = catalog.propose(
      ctx,
      problem({ sector: 'SALES', type: 'LOW_CONVERSION', metadata: { productId: 'prod_1', newPriceCents: 3700 } as Json }),
      diag({ sector: 'SALES', type: 'LOW_CONVERSION', suggestedActionKinds: ['ADJUST_PRICE', 'REGENERATE_LANDING_COPY'] }),
    );
    const byKind = Object.fromEntries(props.map((p) => [p.kind, p]));
    expect(byKind.ADJUST_PRICE?.riskTier).toBe('HIGH');
    expect(byKind.REGENERATE_LANDING_COPY?.riskTier).toBe('LOW');
  });

  it('INCREASE_AD_BUDGET e clampado ao teto financeiro (camada 1 do catalogo)', () => {
    // teto = 30000c; pedimos 99999c => deve sair clampado em 30000c.
    const props = catalog.propose(
      ctx,
      problem({ sector: 'TRAFFIC', type: 'REVENUE_BELOW_TARGET', metadata: { campaignId: 'c1', newDailyBudgetCents: 99999 } as Json }),
      diag({ sector: 'TRAFFIC', type: 'REVENUE_BELOW_TARGET', suggestedActionKinds: ['INCREASE_AD_BUDGET'] }),
    );
    const inc = props.find((p) => p.kind === 'INCREASE_AD_BUDGET');
    expect(inc).toBeDefined();
    const params = inc!.params as Record<string, Json>;
    expect(params.newDailyBudgetCents).toBe(30000);
  });

  it('omite proposta quando faltam dados obrigatorios (ex: ADJUST_PRICE sem productId)', () => {
    const props = catalog.propose(
      ctx,
      problem({ sector: 'SALES', type: 'LOW_CONVERSION', metadata: {} as Json }),
      diag({ sector: 'SALES', type: 'LOW_CONVERSION', suggestedActionKinds: ['ADJUST_PRICE'] }),
    );
    // ADJUST_PRICE omitida (sem productId/newPriceCents); cai no default do setor
    // que inclui REGENERATE_LANDING_COPY, tambem sem productId => tambem omitida.
    expect(props.find((p) => p.kind === 'ADJUST_PRICE')).toBeUndefined();
  });
});
