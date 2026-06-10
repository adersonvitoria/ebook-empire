// Setor EBOOK_QA — contratos de dominio (auditoria de ebook + veredito).
// Fonte UNICA de verdade para API + web + agents. Sem dependencia de Prisma.
//
// score e verdict sao DETERMINISTICOS (recalculados no auditor; o LLM devolve
// dimensionScores/issues/recommendations + um hint, nunca o veredito final).
// Strings de usuario em pt-BR.

// ------------------------------------------------------------
// Veredito (espelha o enum EbookAuditVerdict do Prisma).
// ------------------------------------------------------------
export type EbookAuditVerdict = 'PASS' | 'NEEDS_FIX' | 'FAIL';

export type EbookIssueSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKER';

export type EbookIssueCategory =
  | 'STRUCTURE'
  | 'CONTENT_QUALITY'
  | 'MARKET_FIT'
  | 'COMPLIANCE';

// ------------------------------------------------------------
// EbookIssue — problema pontual encontrado na auditoria.
// ------------------------------------------------------------
export interface EbookIssue {
  category: EbookIssueCategory;
  severity: EbookIssueSeverity;
  /** null = ebook-wide. */
  chapterIndex?: number | null;
  title: string;
  detail: string;
  suggestion: string;
}

// ------------------------------------------------------------
// Subscores por eixo (0..100).
// ------------------------------------------------------------
export interface EbookDimensionScores {
  structure: number;
  contentQuality: number;
  marketFit: number;
  compliance: number;
}

// ------------------------------------------------------------
// EbookAudit — resultado da auditoria de um ebook.
// ------------------------------------------------------------
export interface EbookAudit {
  ebookId: string;
  /** 0..100 (final, deterministico). */
  score: number;
  /** Final, deterministico. */
  verdict: EbookAuditVerdict;
  issues: EbookIssue[];
  recommendations: string[];
  dimensionScores: EbookDimensionScores;
  /** Oportunidade-alvo (eixo MARKET_FIT). */
  marketOpportunityId?: string | null;
  /** 0 na 1a auditoria; cresce no loop de correcao. */
  iteration: number;
  model?: string;
  /** ISO. */
  auditedAt: string;
}
