// EBOOK_QA — Estrategista de correcao (FixStrategist). Dono deste arquivo.
//
// Converte o EbookAudit (issues + dimensionScores) num PLANO DE CORRECAO
// priorizado e DETERMINISTICO: o que regenerar e por que. Sem LLM aqui — o plano
// e derivado das issues/scores (rapido, testavel, idempotente). O executor
// (relaunch-executor.ts) consome este plano para acionar o ContentAgent/LLM.
//
// Convencoes: scores 0..100. Strings de usuario em pt-BR.

import type { EbookAudit, EbookIssue, EbookIssueCategory } from '@ebook-empire/core';

// ------------------------------------------------------------
// Acao de correcao priorizada.
// ------------------------------------------------------------
export type FixActionKind =
  /** Regenerar o corpo dos capitulos (conteudo raso/curto/qualidade baixa). */
  | 'REGENERATE_CHAPTERS'
  /** Reescrever a copy de venda (title/description do Product). */
  | 'REWRITE_SALES_COPY'
  /** Reposicionar para o segmento/angulos da oportunidade (market fit). */
  | 'REALIGN_MARKET_FIT'
  /** Remover/ajustar trechos problematicos (compliance). */
  | 'FIX_COMPLIANCE';

export interface FixAction {
  kind: FixActionKind;
  /** 0..100; maior = aplicar primeiro. */
  priority: number;
  /** Issues que motivaram a acao. */
  reason: string;
  /** Categorias-alvo (para o executor saber o que mexer). */
  categories: EbookIssueCategory[];
}

export interface FixPlan {
  ebookId: string;
  /** Acoes ordenadas por prioridade desc. */
  actions: FixAction[];
  /** Resumo pt-BR do plano. */
  summary: string;
  /** True se nao ha nada a corrigir (audit ja em PASS). */
  noop: boolean;
}

// Severidade -> peso de prioridade.
const SEVERITY_WEIGHT: Record<EbookIssue['severity'], number> = {
  BLOCKER: 40,
  HIGH: 25,
  MEDIUM: 12,
  LOW: 5,
};

// ============================================================
// FixStrategist — o "Estrategista" do time EBOOK_QA.
// ============================================================
export class FixStrategist {
  /**
   * Monta o plano de correcao a partir do audit. Determinismo total: agrupa
   * issues por categoria, soma pesos de severidade e gera 1 FixAction por
   * categoria com issue. Quem ja esta em PASS recebe um plano noop.
   */
  plan(audit: EbookAudit): FixPlan {
    if (audit.verdict === 'PASS' || audit.issues.length === 0) {
      return {
        ebookId: audit.ebookId,
        actions: [],
        summary: 'Nenhuma correcao necessaria (auditoria aprovada).',
        noop: true,
      };
    }

    // Pontua cada categoria pela soma de pesos de severidade das suas issues.
    const byCategory = new Map<EbookIssueCategory, { score: number; issues: EbookIssue[] }>();
    for (const issue of audit.issues) {
      const entry = byCategory.get(issue.category) ?? { score: 0, issues: [] };
      entry.score += SEVERITY_WEIGHT[issue.severity];
      entry.issues.push(issue);
      byCategory.set(issue.category, entry);
    }

    const actions: FixAction[] = [];
    for (const [category, entry] of byCategory) {
      const kind = ACTION_FOR_CATEGORY[category];
      // Reforco do score baixo da dimensao (quanto pior, maior a prioridade).
      const dimGap = 100 - dimScoreFor(audit, category);
      const priority = clampPriority(entry.score + Math.round(dimGap * 0.4));
      actions.push({
        kind,
        priority,
        reason: summarizeIssues(entry.issues),
        categories: [category],
      });
    }

    actions.sort((a, b) => b.priority - a.priority);

    return {
      ebookId: audit.ebookId,
      actions,
      summary: `Plano de correcao com ${actions.length} acao(oes): ${actions
        .map((a) => a.kind)
        .join(', ')}.`,
      noop: false,
    };
  }
}

const ACTION_FOR_CATEGORY: Record<EbookIssueCategory, FixActionKind> = {
  STRUCTURE: 'REGENERATE_CHAPTERS',
  CONTENT_QUALITY: 'REGENERATE_CHAPTERS',
  MARKET_FIT: 'REALIGN_MARKET_FIT',
  COMPLIANCE: 'FIX_COMPLIANCE',
};

function dimScoreFor(audit: EbookAudit, category: EbookIssueCategory): number {
  switch (category) {
    case 'STRUCTURE':
      return audit.dimensionScores.structure;
    case 'CONTENT_QUALITY':
      return audit.dimensionScores.contentQuality;
    case 'MARKET_FIT':
      return audit.dimensionScores.marketFit;
    case 'COMPLIANCE':
      return audit.dimensionScores.compliance;
  }
}

function summarizeIssues(issues: EbookIssue[]): string {
  return issues.map((i) => `[${i.severity}] ${i.title}`).join('; ');
}

function clampPriority(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
