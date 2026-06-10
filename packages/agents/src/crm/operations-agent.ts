// OperationsAgent — o "COO" do CRM / Command Center.
//
// Roda no loop FAST do scheduler (FAST_TICK_MS). Coordena os 4 colaboradores do
// CRM (HealthCollector, DiagnosisEngine, ActionCatalog, ActionExecutor) recebidos
// por CONSTRUTOR (DI). Depende SOMENTE de ./contracts.js — nunca importa as
// implementacoes concretas (composicao concreta vive em scheduler.ts).
//
// Fluxo de um ciclo run():
//   1) coleta saude dos 7 setores (HealthCollector) e persiste 1 snapshot/setor;
//   2) para cada setor NAO-saudavel (WARNING/CRITICAL) diagnostica a causa raiz
//      (DiagnosisEngine) e faz upsert do Problem ativo (1 ativo por sector+type);
//   3) propoe acoes tipadas (ActionCatalog) e cria as RemediationAction;
//   4) roteia por tier: LOW => aplica AUTO via ActionExecutor (guardrails dentro
//      do executor); HIGH => enfileira (status QUEUED) p/ aprovacao humana;
//   5) verifica resolucao de Problems anteriores: setor voltou a HEALTHY ⇒ RESOLVED.
//
// Tolera falha POR SETOR: um setor que explode no diagnostico/proposta nao
// derruba os demais nem o ciclo. O ciclo de vida (Agent.execute) grava o AgentRun
// 'OPERATIONS' — este run() NUNCA toca a tabela AgentRun diretamente.

import { Agent } from '../base.js';
import type { AgentContext, AgentRunResult, AlertNotifyInput } from '../base.js';
import type { AgentName, Json } from '@ebook-empire/core';
import { buildDedupeKey, statusFromScore } from '@ebook-empire/core';

import type {
  HealthCollector,
  DiagnosisEngine,
  ActionCatalog,
  ActionExecutor,
  ProblemRef,
  ProblemStatus,
  RemediationActionRef,
  CrmSector,
  SectorHealth,
  Diagnosis,
  RemediationProposal,
} from './contracts.js';

// ------------------------------------------------------------
// Status de Problem considerados "ativos" (em aberto/processamento).
// ------------------------------------------------------------
const ACTIVE_PROBLEM_STATUS: ProblemStatus[] = ['OPEN', 'DIAGNOSING', 'REMEDIATING'];

// ------------------------------------------------------------
// Resumo por setor agregado no output do AgentRun (observabilidade).
// ------------------------------------------------------------
interface SectorOutcome {
  sector: CrmSector;
  score: number;
  status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  problemId?: string;
  problemType?: string;
  actionsProposed: number;
  actionsAutoApplied: number;
  actionsQueued: number;
  actionsBlocked: number;
  resolved: boolean;
  error?: string;
}

// ============================================================
// OperationsAgent
// ============================================================
export class OperationsAgent extends Agent {
  readonly name: AgentName = 'OPERATIONS';

  constructor(
    private readonly collector: HealthCollector,
    private readonly diagnosis: DiagnosisEngine,
    private readonly catalog: ActionCatalog,
    private readonly executor: ActionExecutor,
  ) {
    super();
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const { log } = ctx;

    // Marca o INICIO do ciclo ANTES da coleta: usado para a deteccao de transicao
    // para CRITICAL (compara o status atual contra o ultimo snapshot ESTRITAMENTE
    // anterior a este instante — evita ler o snapshot do proprio ciclo). Ver
    // ALERTS.md secao 2.2.
    const cycleStart = ctx.clock.now();
    const priorStatusBySector = await this.loadPriorStatuses(ctx, cycleStart);

    // 1) Coleta a saude dos setores. Se a coleta inteira falha, deixamos o erro
    //    escapar (run() deve lancar -> ciclo de vida grava FAILED).
    //    O HealthCollector e o UNICO dono da persistencia do SectorHealthSnapshot
    //    (1/setor por cycleId). Aqui apenas recuperamos os ids para linkar Problems.
    const healths = await this.collector.collect(ctx);

    // Mapeia sector -> snapshotId dos snapshots que o collector ja gravou neste
    // ciclo (NAO grava de novo — evita a dupla escrita por ciclo).
    const snapshotBySector = await this.loadSnapshotIds(ctx);

    const outcomes: SectorOutcome[] = [];
    // Contador de auto-acoes aplicadas no ciclo (apenas observabilidade aqui — o
    // teto duro de maxAutoActionsPerCycle e aplicado DENTRO do executor/guardrails).
    let totalAutoApplied = 0;
    let totalQueued = 0;

    // 2..4) Processa cada setor de forma isolada (tolerante a falha por setor).
    for (const health of healths) {
      const outcome: SectorOutcome = {
        sector: health.sector,
        score: health.score,
        status: statusFromScore(health.score),
        actionsProposed: 0,
        actionsAutoApplied: 0,
        actionsQueued: 0,
        actionsBlocked: 0,
        resolved: false,
      };

      try {
        const status = statusFromScore(health.score);

        // ALERTA: transicao para CRITICAL (anterior != CRITICAL && atual == CRITICAL).
        // Best-effort: dedupe/throttle (event+setor) feito no AlertService; aqui so
        // disparamos na borda de subida para nao notificar a cada tick. Falha do
        // alerta NUNCA derruba o ciclo (try/catch interno + optional chaining).
        const prior = priorStatusBySector.get(health.sector);
        if (status === 'CRITICAL' && prior !== 'CRITICAL') {
          await this.notifySafe(ctx, {
            event: 'SECTOR_CRITICAL',
            sector: health.sector,
            context: {
              score: health.score,
              previousStatus: prior ?? 'UNKNOWN',
            },
          });
        }

        if (status === 'HEALTHY') {
          // 5) Setor saudavel: resolve quaisquer Problems ativos dele.
          const resolvedCount = await this.resolveActiveProblems(ctx, health.sector);
          outcome.resolved = resolvedCount > 0;
        } else {
          // Setor degradado (WARNING/CRITICAL): diagnostica + remedia.
          const snapshotId = snapshotBySector.get(health.sector) ?? null;
          const r = await this.handleDegradedSector(ctx, health, snapshotId);
          outcome.problemId = r.problemId;
          outcome.problemType = r.problemType;
          outcome.actionsProposed = r.proposed;
          outcome.actionsAutoApplied = r.autoApplied;
          outcome.actionsQueued = r.queued;
          outcome.actionsBlocked = r.blocked;
          totalAutoApplied += r.autoApplied;
          totalQueued += r.queued;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        outcome.error = message;
        log.error(
          { sector: health.sector, err: message },
          'COO: falha ao processar setor (isolado, ciclo continua)',
        );
      }

      outcomes.push(outcome);
    }

    log.info(
      { totalAutoApplied, totalQueued, sectors: outcomes.length },
      'COO: ciclo de operacoes concluido',
    );

    return {
      status: 'SUCCESS',
      output: { sectors: outcomes } as unknown as Json,
      metrics: {
        sectorsEvaluated: outcomes.length,
        autoApplied: totalAutoApplied,
        queued: totalQueued,
        critical: outcomes.filter((o) => o.status === 'CRITICAL').length,
        warning: outcomes.filter((o) => o.status === 'WARNING').length,
      } as unknown as Json,
    };
  }

  // ----------------------------------------------------------
  // Recupera o sector -> snapshotId dos snapshots que o HealthCollector ja
  // persistiu neste ciclo (correlacao por cycleId). NAO grava snapshots — esse
  // e responsabilidade UNICA do collector. Best-effort: sem cycleId ou sem
  // linhas, retorna mapa vazio (Problems ficam sem snapshotId, mas o ciclo segue).
  // ----------------------------------------------------------
  private async loadSnapshotIds(
    ctx: AgentContext,
  ): Promise<Map<CrmSector, string>> {
    const byId = new Map<CrmSector, string>();
    const cycleId = ctx.cycleId ?? null;
    if (!cycleId) return byId;
    try {
      const rows = await ctx.prisma.sectorHealthSnapshot.findMany({
        where: { cycleId },
        orderBy: { capturedAt: 'desc' },
        select: { id: true, sector: true },
      });
      // Mantem o mais recente por setor (orderBy desc => primeiro vence).
      for (const row of rows) {
        if (!byId.has(row.sector as CrmSector)) byId.set(row.sector as CrmSector, row.id);
      }
    } catch (err) {
      ctx.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'COO: falha ao recuperar snapshotIds do ciclo (segue sem snapshotId)',
      );
    }
    return byId;
  }

  // ----------------------------------------------------------
  // Carrega, por setor, o STATUS do ultimo SectorHealthSnapshot ESTRITAMENTE
  // anterior ao inicio deste ciclo (capturedAt < cycleStart). Base para detectar a
  // TRANSICAO para CRITICAL (alerta dispara so na borda de subida). Best-effort:
  // qualquer erro retorna mapa vazio (trata todos como "sem estado anterior", o que
  // pode disparar 1 alerta inicial — o dedupe/throttle do AlertService limita).
  // ----------------------------------------------------------
  private async loadPriorStatuses(
    ctx: AgentContext,
    cycleStart: Date,
  ): Promise<Map<CrmSector, 'HEALTHY' | 'WARNING' | 'CRITICAL'>> {
    const byStatus = new Map<CrmSector, 'HEALTHY' | 'WARNING' | 'CRITICAL'>();
    try {
      const rows = await ctx.prisma.sectorHealthSnapshot.findMany({
        where: { capturedAt: { lt: cycleStart } },
        orderBy: { capturedAt: 'desc' },
        select: { sector: true, score: true },
      });
      // orderBy desc => o primeiro de cada setor e o mais recente anterior ao ciclo.
      for (const row of rows) {
        const sector = row.sector as CrmSector;
        if (!byStatus.has(sector)) byStatus.set(sector, statusFromScore(row.score));
      }
    } catch (err) {
      ctx.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'COO: falha ao recuperar status anteriores (deteccao de transicao degradada)',
      );
    }
    return byStatus;
  }

  // ----------------------------------------------------------
  // Dispara um alerta externo de forma TOTALMENTE best-effort. ctx.alert e
  // opcional (ausente em e2e/vitest que montam o contexto manualmente) e o
  // AlertService ja nunca rejeita; ainda assim guardamos com try/catch para que
  // NENHUMA falha de notificacao derrube o ciclo do COO.
  // ----------------------------------------------------------
  private async notifySafe(ctx: AgentContext, input: AlertNotifyInput): Promise<void> {
    try {
      await ctx.alert?.notify(input);
    } catch (err) {
      ctx.log.warn(
        { event: input.event, sector: input.sector, err: err instanceof Error ? err.message : String(err) },
        'COO: falha ao disparar alerta externo (ignorada — best-effort)',
      );
    }
  }

  // ----------------------------------------------------------
  // Trata um setor degradado: diagnostica, faz upsert do Problem ativo, propoe
  // acoes e roteia por tier. Retorna contadores para o resumo do ciclo.
  // ----------------------------------------------------------
  private async handleDegradedSector(
    ctx: AgentContext,
    health: SectorHealth,
    snapshotId: string | null,
  ): Promise<{
    problemId: string;
    problemType: string;
    proposed: number;
    autoApplied: number;
    queued: number;
    blocked: number;
  }> {
    // 2) Diagnostico (regras + LLM). severity = 100 - score (clamp 0..100).
    const diagnosis = await this.diagnosis.diagnose(ctx, health.sector, health);

    const problem = await this.upsertActiveProblem(ctx, health, diagnosis, snapshotId);

    // 3) Propoe acoes tipadas (riskTier estatico do catalogo).
    const proposals = this.catalog.propose(ctx, problem, diagnosis);

    let autoApplied = 0;
    let queued = 0;
    let blocked = 0;
    let anyApplyAttempt = false;

    for (const proposal of proposals) {
      // Cria (ou recupera) a RemediationAction com dedupeKey deterministica.
      const action = await this.ensureAction(ctx, problem.id, proposal);
      if (!action) continue; // ja existia uma acao identica nao-terminal: pula.

      if (proposal.riskTier === 'HIGH') {
        // 4b) HIGH risk => fila de aprovacao humana (NUNCA aplicada automaticamente).
        await ctx.prisma.remediationAction.update({
          where: { id: action.id },
          data: { status: 'QUEUED' },
        });
        queued += 1;
        // ALERTA: acao HIGH enfileirada para aprovacao (PROPOSED -> QUEUED).
        await this.notifySafe(ctx, {
          event: 'ACTION_HIGH_QUEUED',
          sector: health.sector,
          context: {
            actionId: action.id,
            kind: proposal.kind,
            expectedEffect: proposal.expectedEffect,
            problemId: problem.id,
          },
        });
      } else {
        // 4a) LOW risk => aplica AUTO. O executor aplica guardrails (kill switch,
        // maxAuto, cooldown, teto) e auditoria; aqui so contabilizamos o desfecho.
        anyApplyAttempt = true;
        const result = await this.executor.apply(ctx, {
          ...action,
          // garante o status atual lido (PROPOSED) — o executor decide a transicao.
          status: 'PROPOSED',
        });
        if (result.blockedByGuardrail) {
          blocked += 1;
          ctx.log.info(
            { actionId: action.id, kind: proposal.kind, guardrail: result.blockedByGuardrail },
            'COO: acao LOW bloqueada por guardrail',
          );
        } else if (result.success) {
          autoApplied += 1;
        } else {
          // Falha de aplicacao: o executor ja gravou ActionExecution + status FAILED.
          ctx.log.warn(
            { actionId: action.id, kind: proposal.kind, err: result.error },
            'COO: acao LOW falhou na aplicacao',
          );
          // ALERTA: acao AUTO (LOW, tick do COO) falhou na aplicacao real. NAO
          // disparamos em bloqueio por guardrail (acima) — so em falha de execucao.
          await this.notifySafe(ctx, {
            event: 'ACTION_AUTO_FAILED',
            sector: health.sector,
            context: {
              actionId: action.id,
              kind: proposal.kind,
              error: result.error ?? 'erro desconhecido',
              problemId: problem.id,
            },
          });
        }
      }
    }

    // Atualiza o status do Problem conforme o que aconteceu.
    await this.advanceProblemStatus(ctx, problem.id, {
      anyApplyAttempt,
      autoApplied,
      queued,
    });

    return {
      problemId: problem.id,
      problemType: diagnosis.type,
      proposed: proposals.length,
      autoApplied,
      queued,
      blocked,
    };
  }

  // ----------------------------------------------------------
  // Upsert do Problem ativo: garante NO MAXIMO 1 Problem ativo por (sector,type).
  // Se ja existe um ativo do mesmo type, reusa (atualiza severity/rootCause).
  // ----------------------------------------------------------
  private async upsertActiveProblem(
    ctx: AgentContext,
    health: SectorHealth,
    diagnosis: Diagnosis,
    snapshotId: string | null,
  ): Promise<ProblemRef> {
    const severity = clamp(100 - Math.round(health.score), 0, 100);

    const existing = await ctx.prisma.problem.findFirst({
      where: {
        sector: health.sector,
        type: diagnosis.type,
        status: { in: ACTIVE_PROBLEM_STATUS },
      },
      orderBy: { detectedAt: 'desc' },
    });

    // O DiagnosisEngine ja persistiu o Problem com o CONTEXTO DE ACAO no metadata
    // (campaignId/productId/affiliateId/provider/niche/... via gatherActionContext)
    // — dados que o ActionCatalog precisa para montar acoes que exigem params
    // (PAUSE_LISTING, SEND_AFFILIATE_EMAIL, ADJUST_PRICE, INCREASE_AD_BUDGET...).
    // Aqui PRESERVAMOS esse metadata, apenas SOBREPONDO os campos de observabilidade
    // do ciclo. Substitui-lo por completo apagaria o contexto e o catalogo nao
    // proporia essas acoes no fluxo 100% autonomo.
    const cycleMeta = {
      score: health.score,
      status: statusFromScore(health.score),
      confidence: diagnosis.confidence,
      source: diagnosis.source,
    };

    if (existing) {
      const existingMeta =
        existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
          ? (existing.metadata as Record<string, unknown>)
          : {};
      const updated = await ctx.prisma.problem.update({
        where: { id: existing.id },
        data: {
          severity,
          rootCause: diagnosis.rootCause,
          snapshotId: snapshotId ?? existing.snapshotId,
          metadata: { ...existingMeta, ...cycleMeta } as never,
        },
      });
      return toProblemRef(updated);
    }

    const created = await ctx.prisma.problem.create({
      data: {
        sector: health.sector,
        type: diagnosis.type,
        severity,
        status: 'OPEN',
        rootCause: diagnosis.rootCause,
        snapshotId,
        metadata: cycleMeta as never,
      },
    });
    return toProblemRef(created);
  }

  // ----------------------------------------------------------
  // Cria a RemediationAction (dedupeKey deterministica). Retorna null se ja
  // existe uma acao identica em estado NAO-terminal (evita duplicar trabalho).
  // ----------------------------------------------------------
  private async ensureAction(
    ctx: AgentContext,
    problemId: string,
    proposal: RemediationProposal,
  ): Promise<RemediationActionRef | null> {
    const dedupeKey = buildDedupeKey(problemId, proposal.kind, proposal.params);

    const existing = await ctx.prisma.remediationAction.findUnique({
      where: { dedupeKey },
    });
    if (existing) {
      // Se ja foi aplicada/enfileirada/rejeitada/falhou, nao reabrimos aqui.
      // Apenas reabrimos para reproposta se estava num estado terminal de falha?
      // Decisao conservadora: nao reprocessa — o COO so atua em acoes novas.
      return null;
    }

    const created = await ctx.prisma.remediationAction.create({
      data: {
        problemId,
        kind: proposal.kind,
        riskTier: proposal.riskTier,
        params: proposal.params as never,
        expectedEffect: proposal.expectedEffect,
        status: 'PROPOSED',
        reversible: proposal.reversible,
        dedupeKey,
      },
    });
    return toActionRef(created);
  }

  // ----------------------------------------------------------
  // Avanca o status do Problem conforme o desfecho das acoes:
  //  - alguma acao auto-aplicada => REMEDIATING (em remediacao);
  //  - apenas acoes enfileiradas (HIGH) => REMEDIATING (aguardando aprovacao);
  //  - nada proposto/aplicado => DIAGNOSING (diagnosticado, sem alavanca ainda).
  // ----------------------------------------------------------
  private async advanceProblemStatus(
    ctx: AgentContext,
    problemId: string,
    info: { anyApplyAttempt: boolean; autoApplied: number; queued: number },
  ): Promise<void> {
    let status: 'DIAGNOSING' | 'REMEDIATING';
    if (info.autoApplied > 0 || info.queued > 0 || info.anyApplyAttempt) {
      status = 'REMEDIATING';
    } else {
      status = 'DIAGNOSING';
    }
    await ctx.prisma.problem.update({
      where: { id: problemId },
      data: { status },
    });
  }

  // ----------------------------------------------------------
  // 5) Resolucao: setor voltou a HEALTHY => marca todos os Problems ativos dele
  // como RESOLVED (com resolvedAt). Retorna quantos foram resolvidos.
  // ----------------------------------------------------------
  private async resolveActiveProblems(
    ctx: AgentContext,
    sector: CrmSector,
  ): Promise<number> {
    const now = ctx.clock.now();
    const res = await ctx.prisma.problem.updateMany({
      where: {
        sector,
        status: { in: ACTIVE_PROBLEM_STATUS },
      },
      data: { status: 'RESOLVED', resolvedAt: now },
    });
    if (res.count > 0) {
      ctx.log.info({ sector, count: res.count }, 'COO: setor recuperado — problems resolvidos');
    }
    return res.count;
  }
}

// ============================================================
// Helpers puros
// ============================================================
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Converte uma linha Prisma de Problem no ProblemRef do contrato. */
function toProblemRef(row: {
  id: string;
  sector: string;
  type: string;
  severity: number;
  status: string;
  rootCause: string | null;
  snapshotId: string | null;
  detectedAt: Date;
  resolvedAt: Date | null;
  metadata: unknown;
}): ProblemRef {
  return {
    id: row.id,
    sector: row.sector as CrmSector,
    type: row.type,
    severity: row.severity,
    status: row.status as ProblemRef['status'],
    rootCause: row.rootCause,
    snapshotId: row.snapshotId,
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt,
    metadata: (row.metadata ?? null) as Json,
  };
}

/** Converte uma linha Prisma de RemediationAction no RemediationActionRef. */
function toActionRef(row: {
  id: string;
  problemId: string;
  kind: string;
  riskTier: string;
  params: unknown;
  expectedEffect: string;
  status: string;
  reversible: boolean;
  dedupeKey: string;
  appliedAt: Date | null;
}): RemediationActionRef {
  return {
    id: row.id,
    problemId: row.problemId,
    kind: row.kind as RemediationActionRef['kind'],
    riskTier: row.riskTier as RemediationActionRef['riskTier'],
    params: (row.params ?? {}) as Json,
    expectedEffect: row.expectedEffect,
    status: row.status as RemediationActionRef['status'],
    reversible: row.reversible,
    dedupeKey: row.dedupeKey,
    appliedAt: row.appliedAt,
  };
}
