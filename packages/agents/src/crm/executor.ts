// CRM / Command Center — ActionExecutor (seguranca-critico).
//
// Aplica/reverte RemediationAction com a politica TIERED + KILL SWITCH e SEMPRE
// grava auditoria (ActionExecution com beforeState/afterState).
//
// POLITICA DE AUTONOMIA:
//  - kill switch GLOBAL ligado (ou config ausente => fail-closed) => NADA aplica.
//  - acao HIGH (financeira/voltada ao cliente) => NUNCA aplicada automaticamente;
//    vai para a fila de aprovacao (status QUEUED). So a rota /approve (HUMAN)
//    chama o executor com a acao ja APPROVED.
//  - acao LOW dentro dos guardrails (maxAutoActionsPerCycle, cooldown por
//    (kind,setor)) => aplicada acionando o lever correspondente.
//
// GUARDRAILS adicionais: teto financeiro (MAX_AD_BUDGET_BRL / maxAdBudgetCents)
// re-validado AQUI (camada 2 das 3). Toda execucao gera 1 linha de auditoria,
// inclusive quando bloqueada por guardrail (success=false, afterState=beforeState).
//
// ROLLBACK: reverte acoes reversiveis restaurando o beforeState capturado na
// auditoria original (ex: budget/preco anterior, status de campanha anterior).
//
// O executor NAO conhece classes concretas de agente: depende de RemediationLevers
// (DI por construtor). A composicao real (agentes/adapters/DB) vive no scheduler.

import type { PrismaClient } from '@prisma/client';

import type { AgentContext } from '../base.js';
import {
  buildDedupeKey,
  type ActionKind,
  type ExecutionTrigger,
  type Guardrails,
  type GuardrailBlock,
  type Json,
} from '@ebook-empire/core';
import type {
  ActionExecutor,
  RemediationActionRef,
  ActionExecutionRef,
  ExecutionResult,
  Sector,
} from './contracts.js';

// ============================================================
// LEVERS — as "alavancas" que o executor aciona. Cada uma encapsula a chamada
// ao agente/adapter/DB existente, retornando beforeState/afterState p/ auditoria
// e (quando reversivel) permitindo o rollback restaurar o beforeState.
//
// Os metodos recebem o AgentContext (prisma/ports/env/log) + params canonicos.
// A composicao concreta (LiveRemediationLevers ligando Delivery/Content/Social/
// Analytics/Traffic/Sales + adapters) vive no scheduler.ts. Nos testes usamos
// fakes deterministicos.
// ============================================================
export interface LeverResult {
  beforeState: Json;
  afterState: Json;
}

export interface RemediationLevers {
  retryDeliveries(ctx: AgentContext, p: { limit?: number; orderIds?: string[] }): Promise<LeverResult>;
  generateEbook(ctx: AgentContext, p: { niche: string; count?: number }): Promise<LeverResult>;
  generateSocialPosts(ctx: AgentContext, p: { productId?: string; count?: number }): Promise<LeverResult>;
  regenerateLandingCopy(ctx: AgentContext, p: { productId: string }): Promise<LeverResult>;
  recomputeKpis(ctx: AgentContext, p: { date?: string }): Promise<LeverResult>;
  rerunAgent(ctx: AgentContext, p: { agent: string }): Promise<LeverResult>;
  increaseAdBudget(ctx: AgentContext, p: { campaignId: string; newDailyBudgetCents: number }): Promise<LeverResult>;
  decreaseAdBudget(ctx: AgentContext, p: { campaignId: string; newDailyBudgetCents: number }): Promise<LeverResult>;
  pauseCampaign(ctx: AgentContext, p: { campaignId: string }): Promise<LeverResult>;
  adjustPrice(ctx: AgentContext, p: { productId: string; newPriceCents: number }): Promise<LeverResult>;
  // --- producao autonoma (COO-Scale / Fase 5) ---
  /** Gera N ebooks no nicho via launch pipeline (sequencial). */
  generateMoreEbooks(ctx: AgentContext, p: { niche?: string; count?: number }): Promise<LeverResult>;
  /** Desativa um Product (Product.active=false). Reversivel (beforeState.active). */
  pauseListing(ctx: AgentContext, p: { productId: string }): Promise<LeverResult>;
  /** Dispara um ciclo de prospeccao de afiliados (AffiliateOutreachAgent). */
  boostAffiliateOutreach(ctx: AgentContext, p: Record<string, never>): Promise<LeverResult>;
  /** Envia 1 email de prospeccao para 1 afiliado especifico. */
  sendAffiliateEmail(ctx: AgentContext, p: { affiliateId: string }): Promise<LeverResult>;
  /**
   * Reverte uma acao reversivel a partir do beforeState capturado na auditoria.
   * Recebe o kind + beforeState; restaura o estado anterior no provedor/DB.
   * Retorna o novo before/after (afterState = estado restaurado).
   */
  revert(ctx: AgentContext, kind: ActionKind, beforeState: Json): Promise<LeverResult>;
}

// ============================================================
// Subconjunto da config de guardrails que o executor le. Carregado fail-closed:
// na AUSENCIA da config (singleton nao existe / erro) tratamos killSwitch=true.
// ============================================================
type GuardrailRow = {
  killSwitch: boolean;
  maxAutoActionsPerCycle: number;
  cooldownMinutes: number;
  maxAdBudgetCents: number | null;
};

/** Le a config singleton com fail-closed (ausente/erro => killSwitch ligado). */
export async function loadGuardrails(prisma: PrismaClient): Promise<Guardrails> {
  try {
    const row: GuardrailRow | null = await prisma.guardrailConfig.findUnique({
      where: { id: 'singleton' },
    });
    if (!row) {
      return { killSwitch: true, maxAutoActionsPerCycle: 0, cooldownMinutes: 30, maxAdBudgetCents: null };
    }
    return {
      killSwitch: row.killSwitch,
      maxAutoActionsPerCycle: row.maxAutoActionsPerCycle,
      cooldownMinutes: row.cooldownMinutes,
      maxAdBudgetCents: row.maxAdBudgetCents,
    };
  } catch {
    // Fail-closed: qualquer erro de leitura => nao aplica nada automaticamente.
    return { killSwitch: true, maxAutoActionsPerCycle: 0, cooldownMinutes: 30, maxAdBudgetCents: null };
  }
}

// ============================================================
// Opcoes injetaveis no apply() — contexto de um ciclo (AUTO) ou rota (HUMAN).
// ============================================================
export interface ApplyOptions {
  /** AUTO (tick do COO) ou HUMAN (rota /approve). Default AUTO. */
  triggeredBy?: ExecutionTrigger;
  /**
   * Guardrails ja carregados pelo COO (evita reler a cada acao no mesmo tick).
   * Se ausente, o executor carrega via loadGuardrails (fail-closed).
   */
  guardrails?: Guardrails;
  /** Acoes AUTO ja aplicadas neste ciclo (para maxAutoActionsPerCycle). */
  autoAppliedThisCycle?: number;
  /**
   * HUMAN aprovou explicitamente esta acao HIGH (rota /approve). Sem isso,
   * acoes HIGH NUNCA sao aplicadas. Ignorado para LOW.
   */
  humanApproved?: boolean;
}

// ============================================================
// GuardedActionExecutor
// ============================================================
export class GuardedActionExecutor implements ActionExecutor {
  constructor(private readonly levers: RemediationLevers) {}

  // ----------------------------------------------------------
  // apply — porta de entrada da execucao com guardrails.
  // ----------------------------------------------------------
  async apply(ctx: AgentContext, action: RemediationActionRef): Promise<ExecutionResult> {
    // apply() do contrato e a forma "simples" (AUTO, sem cota explicita). O COO
    // e a rota /approve usam applyWith() para passar guardrails/cota/humanApproved.
    return this.applyWith(ctx, action, { triggeredBy: 'AUTO' });
  }

  /**
   * Variante com opcoes explicitas (usada pelo COO e pela rota /approve).
   * E a implementacao real; apply() apenas delega com defaults AUTO.
   */
  async applyWith(
    ctx: AgentContext,
    action: RemediationActionRef,
    opts: ApplyOptions = {},
  ): Promise<ExecutionResult> {
    const triggeredBy: ExecutionTrigger = opts.triggeredBy ?? 'AUTO';
    const guardrails = opts.guardrails ?? (await loadGuardrails(ctx.prisma));

    // 1) KILL SWITCH global: bloqueia TUDO (mesmo HUMAN aprovado).
    if (guardrails.killSwitch) {
      return this.block(ctx, action, triggeredBy, 'KILL_SWITCH');
    }

    // 2) TIERED: acao HIGH so aplica com aprovacao humana explicita.
    if (action.riskTier === 'HIGH') {
      if (!(triggeredBy === 'HUMAN' && opts.humanApproved)) {
        // Enfileira (idempotente: PROPOSED/APPROVED -> QUEUED) sem auditoria de
        // execucao (nao houve tentativa de mutacao). Retorna bloqueio NOT_APPROVED.
        await this.enqueueForApproval(ctx, action);
        return {
          success: false,
          beforeState: {},
          afterState: {},
          blockedByGuardrail: 'NOT_APPROVED',
        };
      }
    }

    // 3) Guardrails de volume (so para AUTO; HUMAN aprovado nao consome cota).
    if (triggeredBy === 'AUTO') {
      const max = guardrails.maxAutoActionsPerCycle;
      if ((opts.autoAppliedThisCycle ?? 0) >= max) {
        return this.block(ctx, action, triggeredBy, 'MAX_AUTO');
      }
      const onCooldown = await this.isOnCooldown(ctx, action, guardrails.cooldownMinutes);
      if (onCooldown) {
        return this.block(ctx, action, triggeredBy, 'COOLDOWN');
      }
    }

    // 4) Teto financeiro (camada 2): re-valida budget de aumento de ads.
    if (action.kind === 'INCREASE_AD_BUDGET') {
      const cap = this.maxAdBudgetCents(ctx, guardrails);
      const wanted = readBudgetCents(action.params);
      if (wanted === undefined || wanted > cap) {
        return this.block(ctx, action, triggeredBy, 'BUDGET_CAP');
      }
    }

    // 5) Executa o lever, capturando before/after e gravando auditoria SEMPRE.
    return this.runLever(ctx, action, triggeredBy);
  }

  // ----------------------------------------------------------
  // rollback — reverte uma execucao reversivel restaurando beforeState.
  // ----------------------------------------------------------
  async rollback(ctx: AgentContext, execution: ActionExecutionRef): Promise<ExecutionResult> {
    // Carrega a acao para saber kind/reversibilidade.
    const action = await this.loadActionRef(ctx.prisma, execution.actionId);
    if (!action) {
      return { success: false, beforeState: {}, afterState: {}, error: 'acao nao encontrada' };
    }
    if (!action.reversible) {
      return {
        success: false,
        beforeState: execution.beforeState ?? {},
        afterState: execution.afterState ?? {},
        error: 'acao nao e reversivel',
      };
    }
    if (!execution.success) {
      return {
        success: false,
        beforeState: execution.beforeState ?? {},
        afterState: execution.afterState ?? {},
        error: 'execucao original nao foi bem-sucedida — nada a reverter',
      };
    }

    const startedAt = ctx.clock.now();
    const beforeState = execution.beforeState ?? {};
    try {
      // O lever restaura o estado anterior (campaign/price/copy).
      const res = await this.levers.revert(ctx, action.kind, beforeState);
      const finishedAt = ctx.clock.now();
      await this.audit(ctx, {
        actionId: action.id,
        success: true,
        beforeState: res.beforeState,
        afterState: res.afterState,
        triggeredBy: 'HUMAN',
        isRollback: true,
        startedAt,
        finishedAt,
      });
      await this.setStatus(ctx.prisma, action.id, 'ROLLED_BACK');
      return { success: true, beforeState: res.beforeState, afterState: res.afterState };
    } catch (err) {
      const finishedAt = ctx.clock.now();
      const message = err instanceof Error ? err.message : String(err);
      await this.audit(ctx, {
        actionId: action.id,
        success: false,
        beforeState,
        afterState: beforeState,
        error: message,
        triggeredBy: 'HUMAN',
        isRollback: true,
        startedAt,
        finishedAt,
      });
      return { success: false, beforeState, afterState: beforeState, error: message };
    }
  }

  // ==========================================================
  // Internos
  // ==========================================================

  /** Executa o lever do kind, audita e atualiza o status da acao. */
  private async runLever(
    ctx: AgentContext,
    action: RemediationActionRef,
    triggeredBy: ExecutionTrigger,
  ): Promise<ExecutionResult> {
    const startedAt = ctx.clock.now();
    try {
      const res = await this.dispatch(ctx, action);
      const finishedAt = ctx.clock.now();
      await this.audit(ctx, {
        actionId: action.id,
        success: true,
        beforeState: res.beforeState,
        afterState: res.afterState,
        triggeredBy,
        isRollback: false,
        startedAt,
        finishedAt,
      });
      await this.setStatus(ctx.prisma, action.id, 'APPLIED', finishedAt);
      ctx.log.info(
        { actionId: action.id, kind: action.kind, triggeredBy },
        'remediacao aplicada',
      );
      return { success: true, beforeState: res.beforeState, afterState: res.afterState };
    } catch (err) {
      const finishedAt = ctx.clock.now();
      const message = err instanceof Error ? err.message : String(err);
      await this.audit(ctx, {
        actionId: action.id,
        success: false,
        beforeState: {},
        afterState: {},
        error: message,
        triggeredBy,
        isRollback: false,
        startedAt,
        finishedAt,
      });
      await this.setStatus(ctx.prisma, action.id, 'FAILED');
      ctx.log.warn(
        { actionId: action.id, kind: action.kind, err: message },
        'remediacao falhou',
      );
      return { success: false, beforeState: {}, afterState: {}, error: message };
    }
  }

  /** Roteia o kind para o lever correspondente, lendo params canonicos. */
  private dispatch(ctx: AgentContext, action: RemediationActionRef): Promise<LeverResult> {
    const p = (action.params && typeof action.params === 'object' && !Array.isArray(action.params)
      ? (action.params as Record<string, Json>)
      : {}) as Record<string, Json>;

    switch (action.kind) {
      case 'RETRY_DELIVERIES':
        return this.levers.retryDeliveries(ctx, {
          limit: numOrUndef(p.limit),
          orderIds: strArrOrUndef(p.orderIds),
        });
      case 'GENERATE_EBOOK':
        return this.levers.generateEbook(ctx, {
          niche: String(p.niche ?? ''),
          count: numOrUndef(p.count),
        });
      case 'GENERATE_SOCIAL_POSTS':
        return this.levers.generateSocialPosts(ctx, {
          productId: strOrUndef(p.productId),
          count: numOrUndef(p.count),
        });
      case 'REGENERATE_LANDING_COPY':
        return this.levers.regenerateLandingCopy(ctx, { productId: String(p.productId ?? '') });
      case 'RECOMPUTE_KPIS':
        return this.levers.recomputeKpis(ctx, { date: strOrUndef(p.date) });
      case 'RERUN_AGENT':
        return this.levers.rerunAgent(ctx, { agent: String(p.agent ?? '') });
      case 'INCREASE_AD_BUDGET':
        return this.levers.increaseAdBudget(ctx, {
          campaignId: String(p.campaignId ?? ''),
          newDailyBudgetCents: Number(p.newDailyBudgetCents ?? 0),
        });
      case 'DECREASE_AD_BUDGET':
        return this.levers.decreaseAdBudget(ctx, {
          campaignId: String(p.campaignId ?? ''),
          newDailyBudgetCents: Number(p.newDailyBudgetCents ?? 0),
        });
      case 'PAUSE_CAMPAIGN':
        return this.levers.pauseCampaign(ctx, { campaignId: String(p.campaignId ?? '') });
      case 'ADJUST_PRICE':
        return this.levers.adjustPrice(ctx, {
          productId: String(p.productId ?? ''),
          newPriceCents: Number(p.newPriceCents ?? 0),
        });
      // --- producao autonoma (COO-Scale / Fase 5) ---
      case 'GENERATE_MORE_EBOOKS':
        return this.levers.generateMoreEbooks(ctx, {
          niche: strOrUndef(p.niche),
          count: numOrUndef(p.count),
        });
      case 'PAUSE_LISTING':
        return this.levers.pauseListing(ctx, { productId: String(p.productId ?? '') });
      case 'BOOST_AFFILIATE_OUTREACH':
        return this.levers.boostAffiliateOutreach(ctx, {} as Record<string, never>);
      case 'SEND_AFFILIATE_EMAIL':
        return this.levers.sendAffiliateEmail(ctx, {
          affiliateId: String(p.affiliateId ?? ''),
        });
      default:
        return Promise.reject(new Error(`kind nao suportado pelo executor: ${action.kind}`));
    }
  }

  /** Grava 1 linha de auditoria (sempre, ate em bloqueio/falha). */
  private async audit(
    ctx: AgentContext,
    data: {
      actionId: string;
      success: boolean;
      beforeState: Json;
      afterState: Json;
      error?: string;
      triggeredBy: ExecutionTrigger;
      isRollback: boolean;
      startedAt: Date;
      finishedAt: Date;
    },
  ): Promise<void> {
    await ctx.prisma.actionExecution.create({
      data: {
        actionId: data.actionId,
        success: data.success,
        beforeState: (data.beforeState ?? undefined) as never,
        afterState: (data.afterState ?? undefined) as never,
        error: data.error ?? null,
        triggeredBy: data.triggeredBy,
        isRollback: data.isRollback,
        startedAt: data.startedAt,
        finishedAt: data.finishedAt,
      },
    });
  }

  /** Atualiza o status da RemediationAction (e appliedAt em APPLIED). */
  private async setStatus(
    prisma: PrismaClient,
    actionId: string,
    status: 'APPLIED' | 'FAILED' | 'ROLLED_BACK' | 'QUEUED',
    appliedAt?: Date,
  ): Promise<void> {
    await prisma.remediationAction.update({
      where: { id: actionId },
      data: {
        status,
        ...(status === 'APPLIED' ? { appliedAt: appliedAt ?? new Date() } : {}),
      },
    });
  }

  /** Enfileira acao HIGH para aprovacao humana (idempotente). */
  private async enqueueForApproval(ctx: AgentContext, action: RemediationActionRef): Promise<void> {
    // So move para QUEUED se ainda nao estiver aprovada/aplicada/rejeitada.
    if (action.status === 'PROPOSED') {
      await this.setStatus(ctx.prisma, action.id, 'QUEUED');
      ctx.log.info({ actionId: action.id, kind: action.kind }, 'acao HIGH enfileirada para aprovacao');
    }
  }

  /** Grava auditoria de bloqueio por guardrail (success=false, after=before). */
  private async block(
    ctx: AgentContext,
    action: RemediationActionRef,
    triggeredBy: ExecutionTrigger,
    reason: GuardrailBlock,
  ): Promise<ExecutionResult> {
    const at = ctx.clock.now();
    await this.audit(ctx, {
      actionId: action.id,
      success: false,
      beforeState: {},
      afterState: {},
      error: `bloqueado por guardrail: ${reason}`,
      triggeredBy,
      isRollback: false,
      startedAt: at,
      finishedAt: at,
    });
    ctx.log.warn({ actionId: action.id, kind: action.kind, reason }, 'remediacao bloqueada por guardrail');
    return { success: false, beforeState: {}, afterState: {}, blockedByGuardrail: reason };
  }

  /**
   * Cooldown por (kind, setor): existe execucao bem-sucedida do MESMO kind para
   * o MESMO setor dentro da janela? O setor vem do Problem da acao.
   */
  private async isOnCooldown(
    ctx: AgentContext,
    action: RemediationActionRef,
    cooldownMinutes: number,
  ): Promise<boolean> {
    if (cooldownMinutes <= 0) return false;
    const sector = await this.sectorOf(ctx.prisma, action.problemId);
    if (!sector) return false;
    const since = new Date(ctx.clock.now().getTime() - cooldownMinutes * 60 * 1000);

    // Existe execucao bem-sucedida (nao-rollback) do MESMO kind para o MESMO
    // setor dentro da janela? Se sim, esta em cooldown.
    const recent = await ctx.prisma.actionExecution.findFirst({
      where: {
        success: true,
        isRollback: false,
        startedAt: { gte: since },
        action: { kind: action.kind as ActionKind, problem: { sector } },
      },
      select: { id: true },
    });
    return Boolean(recent);
  }

  private async sectorOf(prisma: PrismaClient, problemId: string): Promise<Sector | null> {
    const row = await prisma.problem.findUnique({
      where: { id: problemId },
      select: { sector: true },
    });
    return (row?.sector as Sector | undefined) ?? null;
  }

  /** Teto efetivo (centavos): override da config > env.MAX_AD_BUDGET_BRL*100. */
  private maxAdBudgetCents(ctx: AgentContext, guardrails: Guardrails): number {
    if (typeof guardrails.maxAdBudgetCents === 'number' && guardrails.maxAdBudgetCents > 0) {
      return guardrails.maxAdBudgetCents;
    }
    return ctx.env.MAX_AD_BUDGET_BRL * 100;
  }

  /** Recarrega a RemediationAction como Ref (para rollback). */
  private async loadActionRef(
    prisma: PrismaClient,
    actionId: string,
  ): Promise<RemediationActionRef | null> {
    const row = await prisma.remediationAction.findUnique({ where: { id: actionId } });
    if (!row) return null;
    return {
      id: row.id,
      problemId: row.problemId,
      kind: row.kind as ActionKind,
      riskTier: row.riskTier,
      params: row.params as Json,
      expectedEffect: row.expectedEffect,
      status: row.status,
      reversible: row.reversible,
      dedupeKey: row.dedupeKey,
      appliedAt: row.appliedAt,
    };
  }
}

// ============================================================
// Helper publico: gera a dedupeKey de uma proposta (reexporta a regra do core
// para o COO/rotas criarem RemediationAction com a mesma chave do executor).
// ============================================================
export function dedupeKeyFor(problemId: string, kind: ActionKind, params: Json): string {
  return buildDedupeKey(problemId, kind, params);
}

// ------------------------------------------------------------
// utils de leitura de params (Json -> tipos estreitos)
// ------------------------------------------------------------
function numOrUndef(v: Json | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function strOrUndef(v: Json | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function strArrOrUndef(v: Json | undefined): string[] | undefined {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}
function readBudgetCents(params: Json): number | undefined {
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    return numOrUndef((params as Record<string, Json>).newDailyBudgetCents);
  }
  return undefined;
}
