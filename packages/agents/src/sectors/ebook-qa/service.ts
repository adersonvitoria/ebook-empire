// EBOOK_QA — Service do setor (coordenador do time). Dono deste arquivo.
//
// Coordena Especialista (EbookAuditor) -> Estrategista (FixStrategist) ->
// Executor (RelaunchExecutor), persistindo EbookAudit (append-only) + AgentRun
// (agent EBOOK_QA, role SPECIALIST/EXECUTOR, sector EBOOK_QA) + Events
// (EBOOK_AUDITED / EBOOK_RELAUNCHED). Implementa os GATES do doc EBOOK-QA.md:
//   - canLaunch(ebookId): le o ULTIMO EbookAudit; so PASS libera lancamento.
//   - runFixLoop: corrige -> reaudita ate PASS ou QA_MAX_FIX_ITERATIONS.
//
// Determinismo: score/verdict vem do auditor (recalculados); o stub de LLM
// produz conteudo previsivel, entao o teste de convergencia e estavel.
//
// Convencoes: scores 0..100; strings pt-BR; dinheiro Int centavos (nao usado aqui).

import type { EbookAudit, EbookAuditVerdict } from '@ebook-empire/core';
import type { AgentContext } from '../../base.js';
import { EbookAuditor, type AuditEbookInput } from './auditor.js';
import { FixStrategist } from './fix-strategist.js';
import { RelaunchExecutor } from './relaunch-executor.js';

// ------------------------------------------------------------
// Resultado de uma auditoria (audit + id da linha persistida + uso de LLM).
// ------------------------------------------------------------
export interface AuditEbookResult {
  audit: EbookAudit;
  auditId: string;
  agentRunId: string;
}

// ------------------------------------------------------------
// Resultado do loop de correcao.
// ------------------------------------------------------------
export interface FixLoopResult {
  ebookId: string;
  finalVerdict: EbookAuditVerdict;
  iterations: number;
  /** Auditorias geradas no loop (em ordem). */
  audits: EbookAudit[];
  passed: boolean;
  relaunched: boolean;
  summary: string;
}

const MS_PER_HOUR = 60 * 60 * 1000;

// ============================================================
// EbookQaService
// ============================================================
export class EbookQaService {
  private readonly auditor: EbookAuditor;
  private readonly strategist: FixStrategist;
  private readonly executor: RelaunchExecutor;

  constructor(opts?: {
    auditor?: EbookAuditor;
    strategist?: FixStrategist;
    executor?: RelaunchExecutor;
  }) {
    this.auditor = opts?.auditor ?? new EbookAuditor();
    this.strategist = opts?.strategist ?? new FixStrategist();
    this.executor = opts?.executor ?? new RelaunchExecutor();
  }

  // ----------------------------------------------------------
  // Auditoria de UM ebook. Persiste EbookAudit + AgentRun (SPECIALIST) + Event.
  // ----------------------------------------------------------
  async auditEbook(
    ctx: AgentContext,
    ebookId: string,
    opts: { iteration?: number } = {},
  ): Promise<AuditEbookResult> {
    const input = await this.loadEbook(ctx, ebookId);
    const startedAt = ctx.clock.now();

    const run = await ctx.prisma.agentRun.create({
      data: {
        agent: 'EBOOK_QA',
        status: 'RUNNING',
        role: 'SPECIALIST',
        sector: 'EBOOK_QA',
        cycleId: ctx.cycleId ?? null,
        startedAt,
        input: { ebookId, iteration: opts.iteration ?? 0 } as unknown as never,
      },
      select: { id: true },
    });

    try {
      const { audit, tokensIn, tokensOut, costCents } = await this.auditor.audit(
        ctx,
        input,
        opts,
      );
      const auditId = await this.persistAudit(ctx, audit, run.id);

      const finishedAt = ctx.clock.now();
      await ctx.prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCESS',
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          output: { auditId, score: audit.score, verdict: audit.verdict } as unknown as never,
          metrics: { issues: audit.issues.length } as unknown as never,
          tokensIn,
          tokensOut,
          costCents,
        },
      });

      await ctx.prisma.event.create({
        data: {
          type: 'EBOOK_AUDITED',
          metadata: {
            ebookId,
            auditId,
            score: audit.score,
            verdict: audit.verdict,
            iteration: audit.iteration,
          } as unknown as never,
        },
      });

      return { audit, auditId, agentRunId: run.id };
    } catch (err) {
      const finishedAt = ctx.clock.now();
      const message = err instanceof Error ? err.message : String(err);
      await ctx.prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          error: message,
        },
      });
      throw err;
    }
  }

  // ----------------------------------------------------------
  // Loop de correcao: audita -> se NEEDS_FIX, corrige -> reaudita, ate PASS ou
  // limite (QA_MAX_FIX_ITERATIONS). FAIL (BLOCKER/score muito baixo) interrompe
  // o loop (nao adianta corrigir incrementalmente um ebook reprovado).
  // ----------------------------------------------------------
  async runFixLoop(ctx: AgentContext, ebookId: string): Promise<FixLoopResult> {
    const maxIterations = numEnv(ctx, 'QA_MAX_FIX_ITERATIONS', 2);
    const audits: EbookAudit[] = [];

    // Auditoria inicial (iteration 0).
    let { audit } = await this.auditEbook(ctx, ebookId, { iteration: 0 });
    audits.push(audit);

    let relaunched = false;
    let iteration = 0;

    while (
      audit.verdict === 'NEEDS_FIX' &&
      iteration < maxIterations
    ) {
      iteration += 1;
      const input = await this.loadEbook(ctx, ebookId);
      const plan = this.strategist.plan(audit);
      if (plan.noop) break;

      await this.executor.apply(ctx, input, plan);

      // Reauditoria com iteration crescente (idempotencia por iteration).
      const next = await this.auditEbook(ctx, ebookId, { iteration });
      audit = next.audit;
      audits.push(audit);
    }

    const passed = audit.verdict === 'PASS';

    // GATE 2: so relança (publica + Product ativo) quando PASS.
    if (passed) {
      relaunched = await this.relaunch(ctx, ebookId);
    }

    const summary = passed
      ? `Ebook aprovado apos ${iteration} iteracao(oes) de correcao.`
      : audit.verdict === 'FAIL'
        ? `Ebook reprovado (FAIL) — correcao automatica nao aplicavel.`
        : `Limite de ${maxIterations} iteracoes atingido sem PASS (verdict ${audit.verdict}).`;

    ctx.log.info({ ebookId, verdict: audit.verdict, iteration, passed, relaunched }, 'fix loop concluido');

    return {
      ebookId,
      finalVerdict: audit.verdict,
      iterations: iteration,
      audits,
      passed,
      relaunched,
      summary,
    };
  }

  // ----------------------------------------------------------
  // Varre ebooks que precisam de auditoria (novos sem audit OU audit antiga) e
  // os audita. NAO entra no loop de correcao automaticamente — apenas detecta o
  // estado; o COO/pipeline decide corrigir. Retorna os resultados.
  // ----------------------------------------------------------
  async auditExisting(
    ctx: AgentContext,
    opts: { limit?: number } = {},
  ): Promise<AuditEbookResult[]> {
    const limit = opts.limit ?? 20;
    const staleHours = numEnv(ctx, 'QA_AUDIT_STALE_HOURS', 168);
    const staleCutoff = new Date(ctx.clock.now().getTime() - staleHours * MS_PER_HOUR);

    // Ebooks com conteudo (PUBLISHED ou DRAFT) cuja ultima auditoria nao existe
    // ou e mais antiga que o cutoff.
    const candidates = await ctx.prisma.ebook.findMany({
      where: {
        status: { in: ['PUBLISHED', 'DRAFT', 'READY'] },
        contentMarkdown: { not: null },
      },
      select: {
        id: true,
        audits: { orderBy: { createdAt: 'desc' }, take: 1, select: { auditedAt: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit * 3,
    });

    const toAudit = candidates
      .filter((e) => {
        const last = e.audits[0];
        return !last || last.auditedAt < staleCutoff;
      })
      .slice(0, limit);

    const results: AuditEbookResult[] = [];
    for (const e of toAudit) {
      results.push(await this.auditEbook(ctx, e.id, { iteration: 0 }));
    }
    return results;
  }

  // ----------------------------------------------------------
  // GATE de lancamento (GATE 2): le o ULTIMO EbookAudit; so PASS libera. Sem
  // auditoria => bloqueado (fail-closed). Usado pelo launch-pipeline/Orchestrator.
  // ----------------------------------------------------------
  async canLaunch(
    ctx: AgentContext,
    ebookId: string,
  ): Promise<{ allowed: boolean; reason: string; lastVerdict: EbookAuditVerdict | null }> {
    const last = await ctx.prisma.ebookAudit.findFirst({
      where: { ebookId },
      orderBy: { createdAt: 'desc' },
      select: { verdict: true },
    });
    if (!last) {
      return { allowed: false, reason: 'Ebook ainda nao auditado pelo QA.', lastVerdict: null };
    }
    const verdict = last.verdict as EbookAuditVerdict;
    return {
      allowed: verdict === 'PASS',
      reason:
        verdict === 'PASS'
          ? 'Aprovado no QA.'
          : `Bloqueado: ultima auditoria com verdict ${verdict}.`,
      lastVerdict: verdict,
    };
  }

  // ----------------------------------------------------------
  // Relança um ebook aprovado: PUBLISHED + garante Product ativo. Emite
  // Event EBOOK_RELAUNCHED. Idempotente (PUBLISHED -> PUBLISHED e ok).
  // ----------------------------------------------------------
  private async relaunch(ctx: AgentContext, ebookId: string): Promise<boolean> {
    const ebook = await ctx.prisma.ebook.findUnique({
      where: { id: ebookId },
      select: { id: true, status: true, products: { where: { active: true }, select: { id: true } } },
    });
    if (!ebook) return false;

    await ctx.prisma.ebook.update({
      where: { id: ebookId },
      data: { status: 'PUBLISHED' },
    });

    await ctx.prisma.event.create({
      data: {
        type: 'EBOOK_RELAUNCHED',
        metadata: { ebookId, hadActiveProduct: ebook.products.length > 0 } as unknown as never,
      },
    });
    return true;
  }

  // ----------------------------------------------------------
  // Carrega o ebook + oportunidade-alvo no shape do auditor.
  // ----------------------------------------------------------
  private async loadEbook(ctx: AgentContext, ebookId: string): Promise<AuditEbookInput> {
    const ebook = await ctx.prisma.ebook.findUnique({
      where: { id: ebookId },
      select: {
        id: true,
        title: true,
        niche: true,
        contentMarkdown: true,
        outline: true,
        marketOpportunity: {
          select: { id: true, segment: true, niche: true, angles: true },
        },
      },
    });
    if (!ebook) {
      throw new Error(`Ebook ${ebookId} nao encontrado para auditoria.`);
    }
    return {
      id: ebook.id,
      title: ebook.title,
      niche: ebook.niche,
      contentMarkdown: ebook.contentMarkdown,
      outline: ebook.outline,
      marketOpportunity: ebook.marketOpportunity
        ? {
            id: ebook.marketOpportunity.id,
            segment: ebook.marketOpportunity.segment,
            niche: ebook.marketOpportunity.niche,
            angles: toStringArray(ebook.marketOpportunity.angles),
          }
        : null,
    };
  }

  // ----------------------------------------------------------
  // Persiste o EbookAudit (append-only). iteration garante idempotencia logica
  // (cada passo do loop grava 1 linha distinta).
  // ----------------------------------------------------------
  private async persistAudit(
    ctx: AgentContext,
    audit: EbookAudit,
    agentRunId: string,
  ): Promise<string> {
    const row = await ctx.prisma.ebookAudit.create({
      data: {
        ebookId: audit.ebookId,
        score: audit.score,
        verdict: audit.verdict,
        issues: audit.issues as unknown as never,
        recommendations: audit.recommendations as unknown as never,
        dimensionScores: audit.dimensionScores as unknown as never,
        marketOpportunityId: audit.marketOpportunityId ?? null,
        iteration: audit.iteration,
        agentRunId,
        model: audit.model ?? null,
        auditedAt: new Date(audit.auditedAt),
      },
      select: { id: true },
    });
    return row.id;
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function numEnv(ctx: AgentContext, key: string, fallback: number): number {
  const v = ctx.env[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}
