// SectorTeam — coordenador de um TIME de setor.
//
// Orquestra o trio de papeis de forma TOLERANTE A FALHA:
//   assess (Specialist) -> strategize (Strategist) -> execute (Executor)
// Cada papel grava seu proprio AgentRun (role+sector) via runRole. Se um papel
// LANCA, o time degrada com gracia: usa um fallback minimo para o proximo papel
// quando possivel, e marca o que faltou no resultado. NUNCA derruba o chamador
// (o Orchestrator/CEO coordena varios times — um time com erro nao para os outros).
//
// Dominio em pt-BR. O resultado (TeamRunResult) e consumido pela API/web.

import {
  statusFromScore,
  type TeamSector,
  type Assessment,
  type Strategy,
  type ExecutionOutcome,
  type TeamRunResult,
} from '@ebook-empire/core';
import type { AgentContext } from '../base.js';
import type { SectorConfig } from './sector-config.js';
import { Specialist, Strategist, Executor } from './roles.js';

export interface TeamRunSummary extends TeamRunResult {
  /** Papeis que falharam (degradacao graciosa). */
  failedRoles: ('SPECIALIST' | 'STRATEGIST' | 'EXECUTOR')[];
  /** AgentRun ids por papel (observabilidade). */
  runIds: { specialist?: string; strategist?: string; executor?: string };
}

export class SectorTeam {
  readonly sector: TeamSector;
  private readonly specialist: Specialist;
  private readonly strategist: Strategist;
  private readonly executor: Executor;

  constructor(cfg: SectorConfig) {
    this.sector = cfg.sector;
    this.specialist = new Specialist(cfg);
    this.strategist = new Strategist(cfg);
    this.executor = new Executor(cfg);
  }

  /**
   * Roda o ciclo completo do time. Tolerante a falha em qualquer etapa.
   */
  async run(ctx: AgentContext): Promise<TeamRunSummary> {
    const failedRoles: TeamRunSummary['failedRoles'] = [];
    const runIds: TeamRunSummary['runIds'] = {};

    // --- 1) ASSESS ---
    let assessment: Assessment;
    try {
      const res = await this.specialist.assess(ctx);
      assessment = res.data;
      runIds.specialist = res.runId;
    } catch (err) {
      failedRoles.push('SPECIALIST');
      ctx.log.warn(
        { sector: this.sector, err: err instanceof Error ? err.message : String(err) },
        'especialista falhou — assessment minimo',
      );
      assessment = this.minimalAssessment();
    }

    // --- 2) STRATEGIZE ---
    let strategy: Strategy;
    try {
      const res = await this.strategist.strategize(ctx, assessment);
      strategy = res.data;
      runIds.strategist = res.runId;
    } catch (err) {
      failedRoles.push('STRATEGIST');
      ctx.log.warn(
        { sector: this.sector, err: err instanceof Error ? err.message : String(err) },
        'estrategista falhou — estrategia vazia (sem acoes)',
      );
      strategy = this.emptyStrategy(assessment);
    }

    // --- 3) EXECUTE ---
    let outcome: ExecutionOutcome;
    try {
      const res = await this.executor.execute(ctx, strategy);
      outcome = res.data;
      runIds.executor = res.runId;
    } catch (err) {
      failedRoles.push('EXECUTOR');
      ctx.log.warn(
        { sector: this.sector, err: err instanceof Error ? err.message : String(err) },
        'executor falhou — outcome vazio',
      );
      outcome = this.emptyOutcome();
    }

    ctx.log.info(
      {
        sector: this.sector,
        status: assessment.status,
        mode: strategy.mode,
        executed: outcome.executed.length,
        failedRoles,
      },
      'time de setor concluiu o ciclo',
    );

    return { sector: this.sector, assessment, strategy, outcome, failedRoles, runIds };
  }

  // --- Fallbacks de degradacao graciosa ---
  private minimalAssessment(): Assessment {
    return {
      sector: this.sector,
      healthScore: 0,
      status: statusFromScore(0),
      findings: [`Nao foi possivel avaliar o setor ${this.sector} (falha do especialista).`],
      risks: ['Setor sem diagnostico neste ciclo.'],
      opportunities: [],
      evidence: {},
      confidence: 0,
      source: 'RULES',
    };
  }

  private emptyStrategy(assessment: Assessment): Strategy {
    return {
      sector: this.sector,
      objective: `Recuperar a observabilidade do setor ${this.sector}.`,
      mode: assessment.status === 'HEALTHY' ? 'SUSTAIN' : 'GROW',
      actions: [],
      successCriteria: [],
      rationale: 'Estrategia vazia (falha do estrategista).',
    };
  }

  private emptyOutcome(): ExecutionOutcome {
    return {
      sector: this.sector,
      executed: [],
      succeeded: 0,
      failed: 0,
      skipped: 0,
      summary: `Nenhuma acao executada no setor ${this.sector} (falha do executor).`,
    };
  }
}

// ------------------------------------------------------------
// Factory de conveniencia: monta o SectorTeam de um setor a partir de um
// registry. Usado pelo Orchestrator/scheduler para coordenar varios times.
// ------------------------------------------------------------
export function makeSectorTeam(cfg: SectorConfig): SectorTeam {
  return new SectorTeam(cfg);
}
