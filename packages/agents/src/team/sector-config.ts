// REGISTRY de configuracao dos TIMES por setor (decisao: framework generico +
// setores via config). Cada SectorConfig descreve, para UM setor:
//   - sector / agentName : identidade (TeamSector + AgentName p/ o AgentRun).
//   - specialistSystem / strategistSystem : prompts de papel (pt-BR).
//   - readHealth(ctx) : fonte do KPI canonico (SectorHealth via DbHealthCollector).
//   - executorBindings : mapa capability -> funcao que ACIONA uma capacidade
//     EXISTENTE (agente concreto ou lever). NUNCA reimplementa dominio.
//
// Os 7 setores de saude (CONTENT/SALES/DELIVERY/SOCIAL/TRAFFIC/ANALYTICS/
// ORCHESTRATION) ficam aqui. Os 2 novos (MARKET_RESEARCH/EBOOK_QA) tem times
// proprios em sectors/* (config dedicada la). O SectorTeam usa este registry.
//
// Bindings ao executar um Agent concreto reusam o ciclo de vida real
// (agent.execute -> grava AgentRun proprio) e devolvem o agentRunId p/ rastreio.

import {
  DbHealthCollector,
  type SectorScore,
} from '../crm/health-collector.js';
import type {
  AgentName,
  Json,
  Sector,
  SectorHealth,
  TeamSector,
} from '@ebook-empire/core';
import type { Agent, AgentContext } from '../base.js';

// ------------------------------------------------------------
// Resultado de uma capability (binding) executada pelo Executor.
// ------------------------------------------------------------
export interface CapabilityResult {
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  /** AgentRun do Agent acionado (quando o binding e um agente concreto). */
  agentRunId?: string;
  error?: string;
}

export type CapabilityBinding = (
  ctx: AgentContext,
  params: Json,
) => Promise<CapabilityResult>;

// ------------------------------------------------------------
// Config de um setor.
// ------------------------------------------------------------
export interface SectorConfig {
  sector: TeamSector;
  /** AgentName usado nas linhas de AgentRun dos papeis (observabilidade). */
  agentName: AgentName;
  specialistSystem: string;
  strategistSystem: string;
  /** Fonte do KPI do setor (score 0-100 + kpis). */
  readHealth: (ctx: AgentContext) => Promise<{ score: number; kpis: Json }>;
  /** Capacidades acionaveis: capability -> binding (agente/lever existente). */
  executorBindings: Record<string, CapabilityBinding>;
}

// ============================================================
// Helpers de binding reaproveitaveis.
// ============================================================

/**
 * Binding que ACIONA um Agent concreto via factory (DI). O time NAO importa as
 * classes concretas diretamente (escrita disjunta) — recebe um SectorTeamDeps
 * com factories que o scheduler/teste preenche. Aqui montamos um binding que
 * resolve o agente sob demanda e roda seu ciclo de vida real.
 */
export function bindAgent(
  resolve: (ctx: AgentContext, params: Json) => Agent | null,
): CapabilityBinding {
  return async (ctx, params) => {
    const agent = resolve(ctx, params);
    if (!agent) return { status: 'SKIPPED', error: 'agente nao disponivel neste ambiente' };
    const rec = await agent.execute(ctx);
    return {
      status: rec.status === 'FAILED' ? 'FAILED' : 'SUCCESS',
      agentRunId: rec.id,
    };
  };
}

// ============================================================
// Dependencias injetaveis para montar o REGISTRY.
// O scheduler injeta factories reais; os testes injetam stubs. Mantem a escrita
// disjunta: este arquivo nao importa ContentAgent/SalesAgent/etc. diretamente.
// ============================================================
export interface SectorTeamDeps {
  /** Factory de um agente por AgentName (ex. () => new ContentAgent(...)). */
  makeAgent?: (name: AgentName, ctx: AgentContext, params: Json) => Agent | null;
  /** Leitor de saude (default: DbHealthCollector). Reuso do CRM. */
  readSectorHealth?: (ctx: AgentContext, sector: Sector) => Promise<SectorHealth>;
}

// Leitor de saude default: coleta os 7 setores e devolve o do setor pedido.
// Reusa o DbHealthCollector do CRM (fonte unica de scoring).
function defaultReadSectorHealth(deps: SectorTeamDeps) {
  const collector = new DbHealthCollector();
  return async (ctx: AgentContext, sector: Sector): Promise<SectorHealth> => {
    if (deps.readSectorHealth) return deps.readSectorHealth(ctx, sector);
    const all = await collector.collect(ctx);
    const found = all.find((h) => h.sector === sector);
    if (found) return found;
    // Sem snapshot (ambiente vazio) — neutro.
    return { sector, score: 60, status: 'WARNING', kpis: {} };
  };
}

// Helper: resolve um agente via deps.makeAgent (ou null se ausente).
function agentBinding(deps: SectorTeamDeps, name: AgentName): CapabilityBinding {
  return bindAgent((ctx, params) =>
    deps.makeAgent ? deps.makeAgent(name, ctx, params) : null,
  );
}

// ============================================================
// REGISTRY dos 7 setores de saude.
// ============================================================
export function buildSectorRegistry(
  deps: SectorTeamDeps = {},
): Record<Sector, SectorConfig> {
  const readHealthFor =
    (sector: Sector) =>
    async (ctx: AgentContext): Promise<{ score: number; kpis: Json }> => {
      const h = await defaultReadSectorHealth(deps)(ctx, sector);
      return { score: h.score, kpis: h.kpis };
    };

  const specSys = (label: string) =>
    `Voce e o ESPECIALISTA do setor ${label} da Ebook Empire (empresa autonoma que vende ebooks no Brasil). ` +
    `Avalie o estado tecnico do setor com base nos KPIs e no score de saude. Seja objetivo e factual. Escreva em pt-BR.`;
  const stratSys = (label: string) =>
    `Voce e o ESTRATEGISTA do setor ${label} da Ebook Empire. Converta o diagnostico do especialista e a meta ` +
    `de faturamento diaria em uma estrategia priorizada, usando APENAS as capacidades disponiveis. Escreva em pt-BR.`;

  return {
    CONTENT: {
      sector: 'CONTENT',
      agentName: 'CONTENT',
      specialistSystem: specSys('CONTEUDO (geracao de ebooks)'),
      strategistSystem: stratSys('CONTEUDO'),
      readHealth: readHealthFor('CONTENT'),
      executorBindings: { generateEbook: agentBinding(deps, 'CONTENT') },
    },
    SALES: {
      sector: 'SALES',
      agentName: 'SALES',
      specialistSystem: specSys('VENDAS (precificacao/conversao)'),
      strategistSystem: stratSys('VENDAS'),
      readHealth: readHealthFor('SALES'),
      executorBindings: { reconcileSales: agentBinding(deps, 'SALES') },
    },
    DELIVERY: {
      sector: 'DELIVERY',
      agentName: 'DELIVERY',
      specialistSystem: specSys('ENTREGA (acesso ao produto)'),
      strategistSystem: stratSys('ENTREGA'),
      readHealth: readHealthFor('DELIVERY'),
      executorBindings: { deliverPending: agentBinding(deps, 'DELIVERY') },
    },
    SOCIAL: {
      sector: 'SOCIAL',
      agentName: 'SOCIAL',
      specialistSystem: specSys('SOCIAL (alcance organico no Instagram)'),
      strategistSystem: stratSys('SOCIAL'),
      readHealth: readHealthFor('SOCIAL'),
      executorBindings: { publishSocial: agentBinding(deps, 'SOCIAL') },
    },
    TRAFFIC: {
      sector: 'TRAFFIC',
      agentName: 'TRAFFIC',
      specialistSystem: specSys('TRAFEGO PAGO (ads/ROAS)'),
      strategistSystem: stratSys('TRAFEGO PAGO'),
      readHealth: readHealthFor('TRAFFIC'),
      executorBindings: { optimizeAds: agentBinding(deps, 'TRAFFIC') },
    },
    ANALYTICS: {
      sector: 'ANALYTICS',
      agentName: 'ANALYTICS',
      specialistSystem: specSys('ANALYTICS (KPIs/atribuicao)'),
      strategistSystem: stratSys('ANALYTICS'),
      readHealth: readHealthFor('ANALYTICS'),
      executorBindings: { recomputeKpis: agentBinding(deps, 'ANALYTICS') },
    },
    ORCHESTRATION: {
      sector: 'ORCHESTRATION',
      agentName: 'ORCHESTRATOR',
      specialistSystem: specSys('ORQUESTRACAO (coordenacao do CEO)'),
      strategistSystem: stratSys('ORQUESTRACAO'),
      readHealth: readHealthFor('ORCHESTRATION'),
      executorBindings: { runCycle: agentBinding(deps, 'ORCHESTRATOR') },
    },
  };
}

// Tipo de retorno do registry (chaveado pelos 7 setores de saude).
export type SectorRegistry = Record<Sector, SectorConfig>;

// re-export para os tipos de papel (roles.ts importa SectorScore indiretamente).
export type { SectorScore };
