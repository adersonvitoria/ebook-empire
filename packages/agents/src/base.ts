// Classe base dos agentes (Template Method).
// Cada agente concreto estende Agent, implementa name + run(ctx).
// O ciclo de vida (criar AgentRun RUNNING -> rodar -> gravar SUCCESS/FAILED/SKIPPED
// com durationMs/tokens/cost) fica em execute() e NUNCA deixa excecao escapar.

import type { PrismaClient } from '@prisma/client';
import type {
  AgentName,
  AlertEvent,
  AlertSeverity,
  CrmSector,
  Json,
  Ports,
} from '@ebook-empire/core';

// ------------------------------------------------------------
// AlertNotifier — interface fina exposta no AgentContext (Feature 1).
// O AlertService (packages/agents/src/alerts) a implementa. NUNCA rejeita:
// engole erros de canal E de persistencia (best-effort). Call-sites que
// montam o contexto manualmente (e2e/vitest) simplesmente nao passam `alert`,
// e o optional chaining (ctx.alert?.notify) os mantem funcionando.
// ------------------------------------------------------------
export interface AlertNotifyInput {
  event: AlertEvent;
  /** Setor operavel (CrmSector = 7 de saude + 3 de producao). */
  sector?: CrmSector;
  /** Default derivado do event (DEFAULT_SEVERITY_BY_EVENT). */
  severity?: AlertSeverity;
  /** Dados para montar a mensagem pt-BR. */
  context?: Record<string, unknown>;
}

export interface AlertNotifier {
  notify(input: AlertNotifyInput): Promise<void>;
}

// ------------------------------------------------------------
// Logger minimo (compativel com pino/console).
// ------------------------------------------------------------
export interface AgentLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

// ------------------------------------------------------------
// Relogio injetavel (testabilidade — stub deterministico em vitest).
// ------------------------------------------------------------
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

// ------------------------------------------------------------
// Config relevante para os agentes (subconjunto do env validado).
// ------------------------------------------------------------
export interface AgentEnv {
  ENABLE_AGENTS: boolean;
  MAX_AD_BUDGET_BRL: number;
  TARGET_DAILY_REVENUE_BRL: number;
  PUBLIC_BASE_URL: string;
  /** Modelos LLM por funcao. */
  CONTENT_MODEL: string; // 'claude-sonnet-4-6'
  PLANNING_MODEL: string; // 'claude-opus-4-8'
  [key: string]: string | number | boolean;
}

// ------------------------------------------------------------
// Contexto injetado em todo run(). DI -> stubs em testes.
// ------------------------------------------------------------
export interface AgentContext {
  prisma: PrismaClient;
  ports: Ports;
  env: AgentEnv;
  log: AgentLogger;
  clock: Clock;
  /** ID do ciclo do orchestrator (correlaciona runs de um mesmo tick). */
  cycleId?: string;
  /**
   * Notificador de alertas externos (best-effort, OPCIONAL). Injetado pelo
   * scheduler (wiring). Ausente em testes/e2e que montam o contexto manualmente
   * — use sempre via optional chaining: `await ctx.alert?.notify(...)`.
   */
  alert?: AlertNotifier;
}

// ------------------------------------------------------------
// Resultado que run() retorna. O ciclo de vida converte em AgentRun.
// 'SKIPPED' = nada a fazer (idempotente / fora de janela / cooldown).
// Falhas devem ser LANCADAS (execute() captura e grava FAILED).
// ------------------------------------------------------------
export interface AgentRunResult {
  status: 'SUCCESS' | 'SKIPPED';
  output?: Json;
  metrics?: Json;
  /** Uso de LLM acumulado no run, se houver. */
  tokensIn?: number;
  tokensOut?: number;
  costCents?: number;
}

// Tipo de retorno do ciclo de vida (registro AgentRun persistido).
export interface AgentRunRecord {
  id: string;
  agent: AgentName;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
}

// ============================================================
// Classe abstrata Agent
// ============================================================
export abstract class Agent {
  /** Nome canonico (enum AgentName). Cada agente concreto define o seu. */
  abstract readonly name: AgentName;

  /**
   * ID do AgentRun corrente (do ciclo de vida). Disponivel DENTRO de run() —
   * execute() o popula antes de chamar run() e o limpa ao terminar. Agentes
   * concretos podem usa-lo para correlacionar entidades criadas (ex.: gravar
   * Ebook.generatedByRunId). Fora de um run() vale null.
   */
  protected runId: string | null = null;

  /**
   * Trabalho de dominio do agente. Idempotente. Lanca em caso de erro.
   * NUNCA escreve diretamente na tabela AgentRun — isso e responsabilidade
   * do ciclo de vida (execute / logRun).
   */
  abstract run(ctx: AgentContext): Promise<AgentRunResult>;

  /**
   * Ciclo de vida completo (Template Method). Chamado pelo scheduler/orchestrator.
   * 1) cria AgentRun(RUNNING)
   * 2) executa run(ctx)
   * 3) grava SUCCESS|SKIPPED (ou FAILED se run lancar) com durationMs/tokens/cost
   * Nunca deixa excecao escapar para o scheduler.
   */
  async execute(ctx: AgentContext): Promise<AgentRunRecord> {
    const startedAt = ctx.clock.now();
    const runRow = await this.startRun(ctx, startedAt);
    // Expoe o id do AgentRun corrente para dentro de run() (correlacao de
    // entidades criadas, ex.: Ebook.generatedByRunId). Limpo no finally.
    this.runId = runRow.id;

    try {
      const result = await this.run(ctx);
      const finishedAt = ctx.clock.now();
      return await this.logRun(ctx, runRow.id, {
        status: result.status,
        startedAt,
        finishedAt,
        output: result.output,
        metrics: result.metrics,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costCents: result.costCents,
      });
    } catch (err) {
      const finishedAt = ctx.clock.now();
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ agent: this.name, err: message }, 'agente falhou');
      return await this.logRun(ctx, runRow.id, {
        status: 'FAILED',
        startedAt,
        finishedAt,
        error: message,
      });
    } finally {
      // runId so e valido durante o run() corrente.
      this.runId = null;
    }
  }

  /** Cria o marcador RUNNING (tambem serve de lock anti-reentrancia). */
  protected async startRun(
    ctx: AgentContext,
    startedAt: Date,
  ): Promise<{ id: string }> {
    const row = await ctx.prisma.agentRun.create({
      data: {
        agent: this.name,
        status: 'RUNNING',
        cycleId: ctx.cycleId ?? null,
        startedAt,
      },
      select: { id: true },
    });
    return row;
  }

  /**
   * Finaliza o AgentRun com o status terminal. UNICO ponto que escreve
   * o desfecho em AgentRun (os agentes concretos nunca tocam essa tabela).
   */
  protected async logRun(
    ctx: AgentContext,
    runId: string,
    data: {
      status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
      startedAt: Date;
      finishedAt: Date;
      output?: Json;
      metrics?: Json;
      error?: string;
      tokensIn?: number;
      tokensOut?: number;
      costCents?: number;
    },
  ): Promise<AgentRunRecord> {
    const durationMs = data.finishedAt.getTime() - data.startedAt.getTime();
    const updated = await ctx.prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: data.status,
        finishedAt: data.finishedAt,
        durationMs,
        output: (data.output ?? undefined) as never,
        metrics: (data.metrics ?? undefined) as never,
        error: data.error ?? null,
        tokensIn: data.tokensIn ?? null,
        tokensOut: data.tokensOut ?? null,
        costCents: data.costCents ?? null,
      },
      select: {
        id: true,
        agent: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        durationMs: true,
      },
    });
    return updated as AgentRunRecord;
  }
}

// Resultado helper para retornar SKIPPED de forma legivel.
export function skipped(reason: string, metrics?: Json): AgentRunResult {
  return { status: 'SKIPPED', output: { reason }, metrics };
}
