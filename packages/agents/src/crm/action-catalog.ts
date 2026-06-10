// CRM / Command Center — ActionCatalog (catalogo de acoes tipadas).
//
// Dado um Problem + Diagnosis, propoe RemediationProposal[] tipadas. O riskTier
// e propriedade ESTATICA do kind (ACTION_SPECS) — NUNCA vem do LLM/diagnostico.
// O catalogo e PURO (sem DB/ports): recebe ctx so para ler env (teto financeiro)
// e dados ja embutidos no Diagnosis/Problem.metadata.
//
// Mapa setor -> kinds (conforme doc):
//   DELIVERY      -> RETRY_DELIVERIES (LOW)
//   CONTENT       -> GENERATE_EBOOK (LOW)
//   SOCIAL        -> GENERATE_SOCIAL_POSTS (LOW)
//   ANALYTICS     -> RECOMPUTE_KPIS (LOW)
//   ORCHESTRATION -> RERUN_AGENT (LOW)
//   SALES         -> ADJUST_PRICE (HIGH) + REGENERATE_LANDING_COPY (LOW)
//   TRAFFIC       -> INCREASE_AD_BUDGET / DECREASE_AD_BUDGET / PAUSE_CAMPAIGN (HIGH)
//
// Teto financeiro (1a das 3 camadas — catalogo/executor/rota /approve): aqui o
// catalogo JAMAIS propoe INCREASE_AD_BUDGET acima de maxAdBudgetCents (clamp).

import type { Json } from '@ebook-empire/core';
import type { AgentContext } from '../base.js';
import type {
  ActionCatalog,
  ProblemRef,
  Diagnosis,
  RemediationProposal,
  ActionKind,
  RiskTier,
  Sector,
  CrmSector,
} from './contracts.js';

// ------------------------------------------------------------
// Especificacao estatica de cada kind. riskTier + reversibilidade vivem AQUI
// (fonte unica), nunca no diagnostico. reversible=true => rollback possivel.
// ------------------------------------------------------------
export interface ActionSpec {
  kind: ActionKind;
  riskTier: RiskTier;
  reversible: boolean;
  /** Setor "natural" da acao (so para anotacao; o catalogo usa o do Problem). */
  sector: Sector;
}

export const ACTION_SPECS: Record<ActionKind, ActionSpec> = {
  // --- LOW (reversiveis/internas/nao-financeiras) ---
  RETRY_DELIVERIES: { kind: 'RETRY_DELIVERIES', riskTier: 'LOW', reversible: false, sector: 'DELIVERY' },
  GENERATE_EBOOK: { kind: 'GENERATE_EBOOK', riskTier: 'LOW', reversible: false, sector: 'CONTENT' },
  GENERATE_SOCIAL_POSTS: { kind: 'GENERATE_SOCIAL_POSTS', riskTier: 'LOW', reversible: false, sector: 'SOCIAL' },
  REGENERATE_LANDING_COPY: { kind: 'REGENERATE_LANDING_COPY', riskTier: 'LOW', reversible: true, sector: 'SALES' },
  RECOMPUTE_KPIS: { kind: 'RECOMPUTE_KPIS', riskTier: 'LOW', reversible: false, sector: 'ANALYTICS' },
  RERUN_AGENT: { kind: 'RERUN_AGENT', riskTier: 'LOW', reversible: false, sector: 'ORCHESTRATION' },
  // --- HIGH (financeiras / voltadas ao cliente) -> fila de aprovacao ---
  INCREASE_AD_BUDGET: { kind: 'INCREASE_AD_BUDGET', riskTier: 'HIGH', reversible: true, sector: 'TRAFFIC' },
  DECREASE_AD_BUDGET: { kind: 'DECREASE_AD_BUDGET', riskTier: 'HIGH', reversible: true, sector: 'TRAFFIC' },
  PAUSE_CAMPAIGN: { kind: 'PAUSE_CAMPAIGN', riskTier: 'HIGH', reversible: true, sector: 'TRAFFIC' },
  ADJUST_PRICE: { kind: 'ADJUST_PRICE', riskTier: 'HIGH', reversible: true, sector: 'SALES' },
  // --- producao autonoma (COO-Scale / Fase 5) ---
  // GENERATE_MORE_EBOOKS: cria conteudo (LOW, irreversivel) — escala o catalogo.
  GENERATE_MORE_EBOOKS: { kind: 'GENERATE_MORE_EBOOKS', riskTier: 'LOW', reversible: false, sector: 'CONTENT' },
  // PAUSE_LISTING: desativa uma oferta (HIGH, voltada ao cliente; reversivel).
  PAUSE_LISTING: { kind: 'PAUSE_LISTING', riskTier: 'HIGH', reversible: true, sector: 'SALES' },
  // BOOST_AFFILIATE_OUTREACH: dispara prospeccao em lote (LOW, irreversivel).
  BOOST_AFFILIATE_OUTREACH: { kind: 'BOOST_AFFILIATE_OUTREACH', riskTier: 'LOW', reversible: false, sector: 'SALES' },
  // SEND_AFFILIATE_EMAIL: contata 1 afiliado (LOW, irreversivel).
  SEND_AFFILIATE_EMAIL: { kind: 'SEND_AFFILIATE_EMAIL', riskTier: 'LOW', reversible: false, sector: 'SALES' },
};

/** Teto de budget diario (centavos) efetivo: override > MAX_AD_BUDGET_BRL*100. */
export function resolveMaxAdBudgetCents(
  env: AgentContext['env'],
  override?: number | null,
): number {
  if (typeof override === 'number' && override > 0) return override;
  return env.MAX_AD_BUDGET_BRL * 100;
}

// ------------------------------------------------------------
// Helpers para ler campos do Problem.metadata de forma segura. O diagnostico/
// health-collector embute ali campos de contexto (campaignId, productId, niche,
// currentDailyBudgetCents, ...). Tudo opcional — o catalogo degrada com defaults.
// ------------------------------------------------------------
function meta(problem: ProblemRef): Record<string, Json> {
  const m = problem.metadata;
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    return m as Record<string, Json>;
  }
  return {};
}

function num(v: Json | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: Json | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ------------------------------------------------------------
// Implementacao concreta.
// ------------------------------------------------------------
export class StaticActionCatalog implements ActionCatalog {
  propose(
    ctx: AgentContext,
    problem: ProblemRef,
    diagnosis: Diagnosis,
  ): RemediationProposal[] {
    const m = meta(problem);
    const proposals: RemediationProposal[] = [];

    // Conjunto de kinds candidatos: prioriza o que o diagnostico sugeriu, mas
    // sempre filtrado/ancorado pelo setor (kinds fora do setor sao descartados).
    const candidateKinds = this.kindsForSector(problem.sector, diagnosis);

    for (const kind of candidateKinds) {
      const built = this.buildProposal(ctx, kind, problem, m);
      if (built) proposals.push(built);
    }

    return proposals;
  }

  /**
   * Kinds validos para o setor. Intersecta sugestoes do diagnostico com o mapa
   * estatico; se o diagnostico nao sugeriu nada valido, usa o default do setor.
   */
  private kindsForSector(sector: CrmSector, diagnosis: Diagnosis): ActionKind[] {
    const allowed = SECTOR_KINDS[sector] ?? [];
    const suggested = diagnosis.suggestedActionKinds.filter((k) => allowed.includes(k));
    const ordered = suggested.length > 0 ? suggested : allowed;
    // Dedupe preservando ordem.
    return [...new Set(ordered)];
  }

  /** Monta a proposta tipada para um kind, ou null se faltar dado obrigatorio. */
  private buildProposal(
    ctx: AgentContext,
    kind: ActionKind,
    problem: ProblemRef,
    m: Record<string, Json>,
  ): RemediationProposal | null {
    const spec = ACTION_SPECS[kind];
    const base = { riskTier: spec.riskTier, sector: problem.sector, reversible: spec.reversible };

    switch (kind) {
      case 'RETRY_DELIVERIES': {
        const limit = num(m.limit) ?? 25;
        return {
          ...base,
          kind,
          params: { kind, limit } as Json,
          expectedEffect: `Reprocessar ate ${limit} entregas pendentes/falhas e zerar o backlog.`,
        };
      }
      case 'GENERATE_EBOOK': {
        const niche = str(m.niche);
        if (!niche) return null; // sem nicho nao da para gerar
        return {
          ...base,
          kind,
          params: { kind, niche, count: 1 } as Json,
          expectedEffect: `Gerar 1 novo ebook no nicho "${niche}" para repor o catalogo.`,
        };
      }
      case 'GENERATE_SOCIAL_POSTS': {
        const productId = str(m.productId);
        const count = num(m.count) ?? 1;
        return {
          ...base,
          kind,
          params: { kind, ...(productId ? { productId } : {}), count } as Json,
          expectedEffect: `Gerar e agendar ${count} post(s) social para retomar a cadencia.`,
        };
      }
      case 'REGENERATE_LANDING_COPY': {
        const productId = str(m.productId);
        if (!productId) return null;
        return {
          ...base,
          kind,
          params: { kind, productId } as Json,
          expectedEffect: 'Regenerar a copy da landing para tentar elevar a conversao.',
        };
      }
      case 'RECOMPUTE_KPIS': {
        const date = str(m.date);
        return {
          ...base,
          kind,
          params: { kind, ...(date ? { date } : {}) } as Json,
          expectedEffect: 'Recalcular os KPIs do dia para refrescar a base analitica.',
        };
      }
      case 'RERUN_AGENT': {
        const agent = str(m.agent);
        if (!agent) return null;
        return {
          ...base,
          kind,
          params: { kind, agent } as Json,
          expectedEffect: `Reexecutar o agente ${agent} que vinha falhando.`,
        };
      }
      case 'ADJUST_PRICE': {
        const productId = str(m.productId);
        const newPriceCents = num(m.newPriceCents);
        if (!productId || newPriceCents === undefined) return null;
        const clamped = Math.max(1000, Math.round(newPriceCents));
        return {
          ...base,
          kind,
          params: { kind, productId, newPriceCents: clamped } as Json,
          expectedEffect: `Ajustar o preco do produto para R$${(clamped / 100).toFixed(2)} buscando equilibrar conversao e ticket.`,
        };
      }
      case 'INCREASE_AD_BUDGET': {
        const campaignId = str(m.campaignId);
        const wanted = num(m.newDailyBudgetCents);
        if (!campaignId || wanted === undefined) return null;
        // CAMADA 1 do teto: clampa ao maximo permitido (override > env).
        const cap = resolveMaxAdBudgetCents(ctx.env, num(m.maxAdBudgetCents) ?? null);
        const newDailyBudgetCents = Math.min(Math.max(1, Math.round(wanted)), cap);
        return {
          ...base,
          kind,
          params: { kind, campaignId, newDailyBudgetCents } as Json,
          expectedEffect: `Aumentar o budget diario da campanha para ${newDailyBudgetCents}c (teto ${cap}c) e escalar receita.`,
        };
      }
      case 'DECREASE_AD_BUDGET': {
        const campaignId = str(m.campaignId);
        const wanted = num(m.newDailyBudgetCents);
        if (!campaignId || wanted === undefined) return null;
        const newDailyBudgetCents = Math.max(1, Math.round(wanted));
        return {
          ...base,
          kind,
          params: { kind, campaignId, newDailyBudgetCents } as Json,
          expectedEffect: `Reduzir o budget diario da campanha para ${newDailyBudgetCents}c e estancar prejuizo.`,
        };
      }
      case 'PAUSE_CAMPAIGN': {
        const campaignId = str(m.campaignId);
        if (!campaignId) return null;
        return {
          ...base,
          kind,
          params: { kind, campaignId } as Json,
          expectedEffect: 'Pausar a campanha com ROAS abaixo de 1 para interromper a queima de caixa.',
        };
      }
      // --- producao autonoma (COO-Scale / Fase 5) ---
      case 'GENERATE_MORE_EBOOKS': {
        // niche e count sao OPCIONAIS no schema: sem nicho o pipeline escolhe a
        // oportunidade topo. count vem do diagnostico (nicheVelocity) — default 1.
        const niche = str(m.niche);
        const count = num(m.count) ?? 1;
        return {
          ...base,
          kind,
          params: { kind, ...(niche ? { niche } : {}), count } as Json,
          expectedEffect: niche
            ? `Gerar ${count} ebook(s) no nicho "${niche}" para escalar o catalogo rumo a meta.`
            : `Gerar ${count} ebook(s) na melhor oportunidade de mercado para escalar o catalogo.`,
        };
      }
      case 'PAUSE_LISTING': {
        const productId = str(m.productId);
        if (!productId) return null;
        // provider e obrigatorio no schema; default 'hotmart' se o contexto omitir.
        const provider = str(m.provider) ?? 'hotmart';
        return {
          ...base,
          kind,
          params: { kind, productId, provider } as Json,
          expectedEffect: 'Pausar a oferta "morta" (sem vendas) para parar de exibir um listing improdutivo.',
        };
      }
      case 'BOOST_AFFILIATE_OUTREACH': {
        // Sem params obrigatorios; ebookId/limit opcionais quando o contexto os tem.
        const ebookId = str(m.ebookId);
        const limit = num(m.limit);
        return {
          ...base,
          kind,
          params: {
            kind,
            ...(ebookId ? { ebookId } : {}),
            ...(limit !== undefined ? { limit } : {}),
          } as Json,
          expectedEffect: 'Disparar um ciclo de prospeccao em lote de afiliados para ativar a rede.',
        };
      }
      case 'SEND_AFFILIATE_EMAIL': {
        const affiliateId = str(m.affiliateId);
        if (!affiliateId) return null;
        // templateKey e obrigatorio no schema; default 'reativacao' se omitido.
        const templateKey = str(m.templateKey) ?? 'reativacao';
        return {
          ...base,
          kind,
          params: { kind, affiliateId, templateKey } as Json,
          expectedEffect: 'Enviar um email de prospeccao/reativacao para um afiliado especifico.',
        };
      }
      default:
        return null;
    }
  }
}

// Mapa setor -> kinds permitidos (ordem = prioridade default quando o
// diagnostico nao sugere nada valido). Cobre os 10 setores operaveis (CrmSector).
const SECTOR_KINDS: Record<CrmSector, ActionKind[]> = {
  DELIVERY: ['RETRY_DELIVERIES'],
  CONTENT: ['GENERATE_EBOOK', 'GENERATE_MORE_EBOOKS'],
  SOCIAL: ['GENERATE_SOCIAL_POSTS'],
  ANALYTICS: ['RECOMPUTE_KPIS'],
  // ORCHESTRATION inclui GENERATE_MORE_EBOOKS p/ REVENUE_BELOW_TARGET (COO-Scale).
  ORCHESTRATION: ['RERUN_AGENT', 'GENERATE_MORE_EBOOKS'],
  SALES: ['REGENERATE_LANDING_COPY', 'ADJUST_PRICE'],
  TRAFFIC: ['DECREASE_AD_BUDGET', 'PAUSE_CAMPAIGN', 'INCREASE_AD_BUDGET'],
  // --- producao autonoma (COO-Scale / Fase 5) ---
  MARKETPLACE: ['PAUSE_LISTING', 'GENERATE_MORE_EBOOKS'],
  FUNNEL: ['REGENERATE_LANDING_COPY'],
  AFFILIATE: ['BOOST_AFFILIATE_OUTREACH', 'SEND_AFFILIATE_EMAIL'],
};
