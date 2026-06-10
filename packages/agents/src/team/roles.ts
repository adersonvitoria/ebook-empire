// Framework de TIMES por setor — papeis base Specialist / Strategist / Executor.
//
// Cada setor opera como um TIME de 3 papeis que harmonizam rumo a meta de
// faturamento (TARGET_DAILY_REVENUE_BRL):
//   - SPECIALIST: avalia o estado do setor (SectorHealth + dominio + LLM) ->
//     Assessment (diagnostico tecnico, riscos, oportunidades, evidencias).
//   - STRATEGIST: converte Assessment + meta -> Strategy (objetivo, acoes
//     priorizadas, criterios de sucesso) alinhada aos guardrails.
//   - EXECUTOR: executa a Strategy acionando as capacidades existentes
//     (agentes/levers via cfg.executorBindings) -> ExecutionOutcome.
//
// Observabilidade: CADA execucao de papel grava um AgentRun com role + sector
// (colunas Role? / String? do schema). Como a classe base Agent.execute NAO
// preenche role/sector, os papeis aqui gerenciam o proprio ciclo de vida de
// AgentRun (runRole) — mesmo padrao de start/log de base.ts, porem com role.
//
// Tolerancia a falha (filosofia do orchestrator.buildPlan): o LLM e SEMPRE
// opcional. JSON malformado/ausente NUNCA derruba o time — cai no fallback
// deterministico (source: 'RULES'). Dominio em pt-BR. Dinheiro Int centavos.

import {
  assessmentSchema,
  strategySchema,
  statusFromScore,
  type Role,
  type TeamSector,
  type Assessment,
  type Strategy,
  type StrategyAction,
  type ExecutionOutcome,
  type ExecutedAction,
  type SectorHealth,
  type Json,
} from '@ebook-empire/core';
import type { AgentContext } from '../base.js';
import type { SectorConfig } from './sector-config.js';

// ============================================================
// runRole — ciclo de vida de um AgentRun de PAPEL (com role + sector).
// Espelha Agent.startRun/logRun de base.ts, porem grava as colunas role/sector
// para observabilidade dos times. NUNCA deixa excecao do trabalho escapar sem
// gravar FAILED; devolve o resultado do trabalho + o id do AgentRun.
// ============================================================
export interface RoleRunResult<T> {
  data: T;
  runId: string;
  tokensIn?: number;
  tokensOut?: number;
  costCents?: number;
}

export async function runRole<T>(
  ctx: AgentContext,
  opts: {
    role: Role;
    sector: TeamSector;
    /** Nome do AgentRun (MARKET_RESEARCH/EBOOK_QA usam o proprio; os 7 reusam ORCHESTRATOR? nao — ver agentName). */
    agentName: Parameters<typeof buildAgentRunData>[0]['agent'];
    /** Trabalho do papel; devolve dados + uso de LLM + output persistivel. */
    work: () => Promise<{
      data: T;
      output?: Json;
      metrics?: Json;
      tokensIn?: number;
      tokensOut?: number;
      costCents?: number;
    }>;
  },
): Promise<RoleRunResult<T>> {
  const startedAt = ctx.clock.now();
  const row = await ctx.prisma.agentRun.create({
    data: buildAgentRunData({
      agent: opts.agentName,
      role: opts.role,
      sector: opts.sector,
      status: 'RUNNING',
      cycleId: ctx.cycleId ?? null,
      startedAt,
    }),
    select: { id: true },
  });

  try {
    const res = await opts.work();
    const finishedAt = ctx.clock.now();
    await ctx.prisma.agentRun.update({
      where: { id: row.id },
      data: {
        status: 'SUCCESS',
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        output: (res.output ?? undefined) as never,
        metrics: (res.metrics ?? undefined) as never,
        tokensIn: res.tokensIn ?? null,
        tokensOut: res.tokensOut ?? null,
        costCents: res.costCents ?? null,
      },
    });
    return {
      data: res.data,
      runId: row.id,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      costCents: res.costCents,
    };
  } catch (err) {
    const finishedAt = ctx.clock.now();
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error({ role: opts.role, sector: opts.sector, err: message }, 'papel falhou');
    await ctx.prisma.agentRun.update({
      where: { id: row.id },
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

// Monta o data do AgentRun.create com role/sector. Isolado para tipar `agent`.
function buildAgentRunData(input: {
  agent: import('@ebook-empire/core').AgentName;
  role: Role;
  sector: TeamSector;
  status: 'RUNNING';
  cycleId: string | null;
  startedAt: Date;
}) {
  return {
    agent: input.agent,
    role: input.role,
    sector: input.sector,
    status: input.status,
    cycleId: input.cycleId,
    startedAt: input.startedAt,
  };
}

// ============================================================
// SPECIALIST — produz o Assessment do setor.
// ============================================================
export class Specialist {
  constructor(private readonly cfg: SectorConfig) {}

  /**
   * Avalia o setor. Le SectorHealth (KPI canonico) via cfg.readHealth e tenta
   * enriquecer com LLM (findings/risks/opportunities em pt-BR). Se o LLM faltar
   * ou o JSON nao validar, cai no fallback deterministico baseado no score.
   */
  async assess(ctx: AgentContext): Promise<RoleRunResult<Assessment>> {
    return runRole<Assessment>(ctx, {
      role: 'SPECIALIST',
      sector: this.cfg.sector,
      agentName: this.cfg.agentName,
      work: async () => {
        const health = await this.cfg.readHealth(ctx);
        const fallback = this.fallbackAssessment(health);

        try {
          const { data, usage } = await ctx.ports.llm.generateJson<Assessment>({
            model: ctx.env.PLANNING_MODEL,
            system: this.cfg.specialistSystem,
            messages: [
              { role: 'user', content: this.buildPrompt(ctx, health) },
            ],
            maxTokens: 1200,
            temperature: 0.3,
            parse: (raw) =>
              normalizeAssessment(assessmentSchema.parse(raw) as Assessment, health),
          });
          return {
            data,
            output: data as unknown as Json,
            tokensIn: usage.inputTokens,
            tokensOut: usage.outputTokens,
            costCents: usage.costCents,
          };
        } catch (err) {
          ctx.log.warn(
            { sector: this.cfg.sector, err: err instanceof Error ? err.message : String(err) },
            'LLM do especialista indisponivel — assessment deterministico',
          );
          return { data: fallback, output: fallback as unknown as Json };
        }
      },
    });
  }

  private fallbackAssessment(health: SectorHealth | TeamHealth): Assessment {
    const status = statusFromScore(health.score);
    const findings =
      status === 'HEALTHY'
        ? [`Setor ${this.cfg.sector} saudavel (score ${health.score}).`]
        : [`Setor ${this.cfg.sector} com score ${health.score} (${status}).`];
    return {
      sector: this.cfg.sector,
      healthScore: health.score,
      status,
      findings,
      risks:
        status === 'CRITICAL'
          ? [`Score critico pode comprometer a meta de faturamento diaria.`]
          : [],
      opportunities:
        status !== 'HEALTHY'
          ? [`Atuar nas alavancas do setor ${this.cfg.sector} para recuperar o score.`]
          : [`Sustentar o desempenho e buscar ganhos marginais.`],
      evidence: (health.kpis ?? {}) as Json,
      confidence: 0.5,
      source: 'RULES',
    };
  }

  private buildPrompt(ctx: AgentContext, health: SectorHealth | TeamHealth): string {
    return [
      `Setor: ${this.cfg.sector}. Meta de negocio: faturar >= R$${ctx.env.TARGET_DAILY_REVENUE_BRL}/dia (Ebook Empire, Brasil).`,
      `Score de saude atual (0-100): ${health.score}.`,
      `KPIs/sinais do setor (JSON): ${JSON.stringify(health.kpis ?? {})}.`,
      '',
      'Produza um diagnostico tecnico do setor em pt-BR. Responda APENAS JSON no formato Assessment:',
      '{ "sector": "<setor>", "healthScore": 0-100, "status": "HEALTHY"|"WARNING"|"CRITICAL",',
      '  "findings": string[], "risks": string[], "opportunities": string[],',
      '  "evidence": object, "confidence": 0..1, "source": "LLM" }',
    ].join('\n');
  }
}

// ============================================================
// STRATEGIST — produz a Strategy do setor a partir do Assessment + meta.
// ============================================================
export class Strategist {
  constructor(private readonly cfg: SectorConfig) {}

  async strategize(
    ctx: AgentContext,
    assessment: Assessment,
  ): Promise<RoleRunResult<Strategy>> {
    return runRole<Strategy>(ctx, {
      role: 'STRATEGIST',
      sector: this.cfg.sector,
      agentName: this.cfg.agentName,
      work: async () => {
        const fallback = this.fallbackStrategy(assessment);

        try {
          const { data, usage } = await ctx.ports.llm.generateJson<Strategy>({
            model: ctx.env.PLANNING_MODEL,
            system: this.cfg.strategistSystem,
            messages: [
              { role: 'user', content: this.buildPrompt(ctx, assessment) },
            ],
            maxTokens: 1200,
            temperature: 0.3,
            parse: (raw) =>
              normalizeStrategy(strategySchema.parse(raw) as Strategy, this.cfg),
          });
          // Garante que toda acao use uma capability conhecida do binding.
          const cleaned = this.filterKnownCapabilities(data, fallback);
          return {
            data: cleaned,
            output: cleaned as unknown as Json,
            tokensIn: usage.inputTokens,
            tokensOut: usage.outputTokens,
            costCents: usage.costCents,
          };
        } catch (err) {
          ctx.log.warn(
            { sector: this.cfg.sector, err: err instanceof Error ? err.message : String(err) },
            'LLM do estrategista indisponivel — strategy deterministica',
          );
          return { data: fallback, output: fallback as unknown as Json };
        }
      },
    });
  }

  /** Strategy deterministica: aciona TODAS as capabilities do binding com prioridade base. */
  private fallbackStrategy(assessment: Assessment): Strategy {
    const capabilities = Object.keys(this.cfg.executorBindings);
    const mode: Strategy['mode'] = assessment.status === 'HEALTHY' ? 'SUSTAIN' : 'GROW';
    const actions: StrategyAction[] = capabilities.map((capability) => ({
      capability,
      priority: assessment.status === 'CRITICAL' ? 80 : assessment.status === 'WARNING' ? 60 : 40,
      params: {},
      reason: `Acionar ${capability} para mover o setor ${this.cfg.sector} rumo a meta.`,
    }));
    return {
      sector: this.cfg.sector,
      objective: `Elevar a saude do setor ${this.cfg.sector} e contribuir para a meta diaria.`,
      mode,
      actions,
      successCriteria: [`Score do setor ${this.cfg.sector} >= 70 no proximo ciclo.`],
      rationale:
        assessment.status === 'HEALTHY'
          ? 'Setor saudavel — sustentar e otimizar.'
          : 'Setor abaixo do ideal — priorizar alavancas existentes.',
    };
  }

  /** Descarta acoes com capability fora do binding; se sobrar zero, usa o fallback. */
  private filterKnownCapabilities(strategy: Strategy, fallback: Strategy): Strategy {
    const known = new Set(Object.keys(this.cfg.executorBindings));
    const actions = strategy.actions.filter((a) => known.has(a.capability));
    if (actions.length === 0) return fallback;
    return { ...strategy, actions };
  }

  private buildPrompt(ctx: AgentContext, assessment: Assessment): string {
    const targetBRL = ctx.env.TARGET_DAILY_REVENUE_BRL;
    const capabilities = Object.keys(this.cfg.executorBindings);
    return [
      `Setor: ${this.cfg.sector}. Meta de negocio: faturar >= R$${targetBRL}/dia.`,
      `Diagnostico do especialista (Assessment JSON): ${JSON.stringify(assessment)}.`,
      `Capacidades disponiveis (use APENAS estas em "capability"): ${capabilities.join(', ')}.`,
      '',
      'Monte uma estrategia priorizada em pt-BR alinhada a meta. Responda APENAS JSON no formato Strategy:',
      '{ "sector": "<setor>", "objective": string, "mode": "GROW"|"SUSTAIN",',
      '  "actions": [{ "capability": <uma das capacidades>, "priority": 0-100, "params": object, "reason": string }],',
      '  "successCriteria": string[], "rationale": string }',
    ].join('\n');
  }
}

// ============================================================
// EXECUTOR — executa a Strategy acionando as capabilities (bindings).
// ============================================================
export class Executor {
  constructor(private readonly cfg: SectorConfig) {}

  async execute(
    ctx: AgentContext,
    strategy: Strategy,
  ): Promise<RoleRunResult<ExecutionOutcome>> {
    return runRole<ExecutionOutcome>(ctx, {
      role: 'EXECUTOR',
      sector: this.cfg.sector,
      agentName: this.cfg.agentName,
      work: async () => {
        // Acoes ordenadas por prioridade desc; tolera falha individual.
        const actions = [...strategy.actions].sort((a, b) => b.priority - a.priority);
        const executed: ExecutedAction[] = [];

        for (const action of actions) {
          const binding = this.cfg.executorBindings[action.capability];
          if (!binding) {
            executed.push({
              capability: action.capability,
              status: 'SKIPPED',
              error: 'capability sem binding',
            });
            continue;
          }
          try {
            const result = await binding(ctx, action.params);
            executed.push({
              capability: action.capability,
              status: result.status,
              agentRunId: result.agentRunId,
              error: result.error,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ctx.log.error(
              { sector: this.cfg.sector, capability: action.capability, err: message },
              'capability falhou — outcome continua',
            );
            executed.push({ capability: action.capability, status: 'FAILED', error: message });
          }
        }

        const succeeded = executed.filter((e) => e.status === 'SUCCESS').length;
        const failed = executed.filter((e) => e.status === 'FAILED').length;
        const skipped = executed.filter((e) => e.status === 'SKIPPED').length;
        const outcome: ExecutionOutcome = {
          sector: this.cfg.sector,
          executed,
          succeeded,
          failed,
          skipped,
          summary: `Executadas ${executed.length} acoes no setor ${this.cfg.sector}: ${succeeded} ok, ${failed} falha, ${skipped} puladas.`,
        };
        return { data: outcome, output: outcome as unknown as Json, metrics: { succeeded, failed, skipped } };
      },
    });
  }
}

// ============================================================
// Helpers de normalizacao (forcam consistencia score/status/sector).
// ============================================================

/** SectorHealth dos 7 OU "health sintetico" dos 2 novos (mesmo shape relevante). */
export interface TeamHealth {
  score: number;
  kpis: Json;
}

/** Forca o sector/status corretos no Assessment vindo do LLM (nao confiar cegamente). */
export function normalizeAssessment(
  a: Assessment,
  health: SectorHealth | TeamHealth,
): Assessment {
  const healthScore = health.score;
  return {
    ...a,
    healthScore,
    status: statusFromScore(healthScore),
    // mantem evidence do LLM se houver; senao usa os KPIs reais.
    evidence:
      a.evidence && typeof a.evidence === 'object'
        ? a.evidence
        : ((health.kpis ?? {}) as Json),
    source: 'LLM',
  };
}

/** Forca o sector correto e remove campos divergentes na Strategy do LLM. */
export function normalizeStrategy(s: Strategy, cfg: SectorConfig): Strategy {
  return { ...s, sector: cfg.sector };
}
