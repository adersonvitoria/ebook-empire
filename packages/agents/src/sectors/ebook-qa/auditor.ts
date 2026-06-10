// EBOOK_QA — Especialista (Auditor). Dono deste arquivo.
//
// Audita UM ebook e produz um EbookAudit. O LLM avalia qualidade/fit e devolve
// dimensionScores + issues + recommendations + um verdictHint; o auditor NUNCA
// confia no veredito do LLM: score e verdict FINAIS sao recalculados
// DETERMINISTICAMENTE aqui (igual o doc EBOOK-QA.md A.5). Se o LLM falhar/estiver
// ausente, cai num auditor de regras (estrutura + heuristicas) — o gate de QA
// nunca trava por falta de LLM, mas tambem nunca passa um ebook fraco.
//
// O ciclo de vida (AgentRun) NAO e responsabilidade deste arquivo — o service
// loga o AgentRun (role SPECIALIST / sector EBOOK_QA). Aqui so ha calculo + LLM.
//
// Convencoes: scores 0..100 (NAO centavos). Strings de usuario em pt-BR.

import {
  ebookAuditLlmSchema,
  type EbookAudit,
  type EbookAuditLlmOutput,
  type EbookAuditVerdict,
  type EbookDimensionScores,
  type EbookIssue,
} from '@ebook-empire/core';
import type { AgentContext } from '../../base.js';

// ------------------------------------------------------------
// Snapshot do ebook que o auditor sabe analisar (desacoplado do Prisma — o
// service carrega e monta isto; os testes passam um objeto literal).
// ------------------------------------------------------------
export interface AuditEbookInput {
  id: string;
  title: string;
  niche: string;
  /** Markdown completo (persistido em Ebook.contentMarkdown). */
  contentMarkdown: string | null;
  /** Outline estruturado (Ebook.outline), se houver. */
  outline: unknown;
  /** Oportunidade-alvo (eixo MARKET_FIT), se houver. */
  marketOpportunity?: {
    id: string;
    segment: string;
    niche: string;
    angles: string[];
  } | null;
}

// ------------------------------------------------------------
// Pesos do score final (somam 1). MARKET_FIT pesa quando ha oportunidade-alvo;
// sem alvo, o peso de MARKET_FIT e redistribuido (neutro 70, ver buildFinalScore).
// ------------------------------------------------------------
const DIMENSION_WEIGHTS = {
  structure: 0.25,
  contentQuality: 0.4,
  marketFit: 0.2,
  compliance: 0.15,
} as const;

/** Garante inteiro 0..100. (interno — nao reexportado pelo barrel p/ evitar
 * colisao com o clampScore do crm/health-collector). */
function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ------------------------------------------------------------
// Estrutura do conteudo extraida deterministicamente do markdown/outline.
// Base do subscore STRUCTURE e de issues de estrutura (sem depender do LLM).
// ------------------------------------------------------------
export interface EbookStructure {
  chapterCount: number;
  totalWords: number;
  shortChapters: number; // capitulos com corpo muito curto (< MIN_CHAPTER_WORDS)
  hasTitleHeading: boolean;
}

const MIN_CHAPTERS = 3;
const MIN_CHAPTER_WORDS = 120;
const MIN_TOTAL_WORDS = 800;

/** Analisa a estrutura do markdown (## capitulos) de forma pura. */
export function analyzeStructure(markdown: string | null): EbookStructure {
  const text = markdown ?? '';
  const hasTitleHeading = /^\s*#\s+\S/m.test(text);
  // Capitulos = blocos iniciados por "## " (nivel 2). Split mantem o cabecalho.
  const parts = text.split(/^##\s+/m).slice(1);
  const chapterCount = parts.length;
  let shortChapters = 0;
  let totalWords = countWords(text);
  for (const part of parts) {
    // Remove a primeira linha (titulo do capitulo) para medir o corpo.
    const body = part.split('\n').slice(1).join('\n');
    if (countWords(body) < MIN_CHAPTER_WORDS) shortChapters += 1;
  }
  return { chapterCount, totalWords, shortChapters, hasTitleHeading };
}

function countWords(text: string): number {
  const cleaned = text.replace(/[#*_`>-]/g, ' ').trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

/** Subscore STRUCTURE deterministico (0..100) + issues de estrutura. */
export function scoreStructure(s: EbookStructure): {
  score: number;
  issues: EbookIssue[];
} {
  const issues: EbookIssue[] = [];
  let score = 100;

  if (s.chapterCount < MIN_CHAPTERS) {
    score -= 40;
    issues.push({
      category: 'STRUCTURE',
      severity: 'BLOCKER',
      chapterIndex: null,
      title: 'Poucos capitulos',
      detail: `O ebook tem ${s.chapterCount} capitulo(s); o minimo aceitavel e ${MIN_CHAPTERS}.`,
      suggestion: `Gerar ao menos ${MIN_CHAPTERS} capitulos com corpo completo.`,
    });
  }
  if (s.totalWords < MIN_TOTAL_WORDS) {
    score -= 25;
    issues.push({
      category: 'STRUCTURE',
      severity: 'HIGH',
      chapterIndex: null,
      title: 'Conteudo muito curto',
      detail: `Total de ~${s.totalWords} palavras; esperado >= ${MIN_TOTAL_WORDS}.`,
      suggestion: 'Expandir os capitulos com exemplos praticos e passo a passo.',
    });
  }
  if (s.shortChapters > 0) {
    score -= s.shortChapters * 10;
    issues.push({
      category: 'STRUCTURE',
      severity: 'MEDIUM',
      chapterIndex: null,
      title: 'Capitulos rasos',
      detail: `${s.shortChapters} capitulo(s) com menos de ${MIN_CHAPTER_WORDS} palavras.`,
      suggestion: 'Aprofundar os capitulos curtos com mais desenvolvimento.',
    });
  }
  if (!s.hasTitleHeading) {
    score -= 5;
    issues.push({
      category: 'STRUCTURE',
      severity: 'LOW',
      chapterIndex: null,
      title: 'Sem titulo principal',
      detail: 'O markdown nao tem um cabecalho de titulo (# ...).',
      suggestion: 'Incluir o titulo do ebook como cabecalho de nivel 1.',
    });
  }
  return { score: clampScore(score), issues };
}

// ============================================================
// EbookAuditor — o "Especialista" do time EBOOK_QA.
// ============================================================
export class EbookAuditor {
  /**
   * Audita um ebook. Combina:
   *  - STRUCTURE: deterministico (analyzeStructure/scoreStructure).
   *  - CONTENT_QUALITY / MARKET_FIT / COMPLIANCE: LLM (com fallback de regras).
   * O score/verdict FINAIS sao recalculados deterministicamente (buildFinalScore
   * + verdictFromScore) — o verdictHint do LLM e apenas informativo.
   */
  async audit(
    ctx: AgentContext,
    ebook: AuditEbookInput,
    opts: { iteration?: number } = {},
  ): Promise<{
    audit: EbookAudit;
    tokensIn: number;
    tokensOut: number;
    costCents: number;
  }> {
    const iteration = opts.iteration ?? 0;
    const structure = analyzeStructure(ebook.contentMarkdown);
    const structResult = scoreStructure(structure);

    let tokensIn = 0;
    let tokensOut = 0;
    let costCents = 0;
    let model: string | undefined;

    // --- Dimensoes de qualidade/fit/compliance via LLM (com fallback) ---
    let llm: EbookAuditLlmOutput;
    let source: 'LLM' | 'RULES' = 'RULES';
    try {
      model = ctx.env.CONTENT_MODEL as string;
      const res = await ctx.ports.llm.generateJson<EbookAuditLlmOutput>({
        model,
        maxTokens: 1500,
        temperature: 0.2,
        system: buildAuditorSystemPrompt(),
        messages: [{ role: 'user', content: buildAuditorUserPrompt(ebook, structure) }],
        parse: (raw) => ebookAuditLlmSchema.parse(raw),
      });
      llm = res.data;
      tokensIn += res.usage.inputTokens;
      tokensOut += res.usage.outputTokens;
      costCents += res.usage.costCents ?? 0;
      source = 'LLM';
    } catch (err) {
      ctx.log.warn(
        { ebookId: ebook.id, err: err instanceof Error ? err.message : String(err) },
        'auditor LLM indisponivel — usando auditoria por regras',
      );
      llm = this.rulesFallback(ebook, structure);
    }

    // STRUCTURE final = media do deterministico com o do LLM (deterministico manda).
    const dimensionScores: EbookDimensionScores = {
      structure: clampScore((structResult.score * 2 + llm.dimensionScores.structure) / 3),
      contentQuality: clampScore(llm.dimensionScores.contentQuality),
      marketFit: clampScore(llm.dimensionScores.marketFit),
      compliance: clampScore(llm.dimensionScores.compliance),
    };

    // Issues = estrutura deterministica + issues do LLM (deduplicadas por titulo).
    const issues = dedupeIssues([...structResult.issues, ...llm.issues]);

    const hasOpportunity = !!ebook.marketOpportunity;
    const score = buildFinalScore(dimensionScores, hasOpportunity);
    const verdict = verdictFromScore(score, issues, ctx);

    const audit: EbookAudit = {
      ebookId: ebook.id,
      score,
      verdict,
      issues,
      recommendations: llm.recommendations,
      dimensionScores,
      marketOpportunityId: ebook.marketOpportunity?.id ?? null,
      iteration,
      model: source === 'LLM' ? model : undefined,
      auditedAt: ctx.clock.now().toISOString(),
    };

    ctx.log.info(
      { ebookId: ebook.id, score, verdict, iteration, source },
      'ebook auditado',
    );

    return { audit, tokensIn, tokensOut, costCents };
  }

  /**
   * Auditoria 100% por regras (sem LLM). Usada como fallback. Heuristicas
   * conservadoras a partir da estrutura: conteudo curto/raso => qualidade baixa.
   */
  private rulesFallback(
    ebook: AuditEbookInput,
    structure: EbookStructure,
  ): EbookAuditLlmOutput {
    const lengthOk = structure.totalWords >= MIN_TOTAL_WORDS;
    const depthOk = structure.shortChapters === 0 && structure.chapterCount >= MIN_CHAPTERS;
    const contentQuality = clampScore(
      (lengthOk ? 60 : 35) + (depthOk ? 25 : 0) + (structure.chapterCount >= 4 ? 10 : 0),
    );
    // Sem LLM nao avaliamos fit semantico — neutro alto se ha alvo, neutro se nao.
    const marketFit = ebook.marketOpportunity ? 65 : 70;
    const compliance = 80; // sem sinais de violacao detectaveis por regra simples.
    const issues: EbookIssue[] = [];
    if (!lengthOk) {
      issues.push({
        category: 'CONTENT_QUALITY',
        severity: 'HIGH',
        chapterIndex: null,
        title: 'Profundidade insuficiente (regras)',
        detail: 'Auditoria por regras: volume de conteudo abaixo do esperado.',
        suggestion: 'Regenerar capitulos com mais desenvolvimento e exemplos.',
      });
    }
    return {
      dimensionScores: {
        structure: depthOk ? 80 : 50,
        contentQuality,
        marketFit,
        compliance,
      },
      issues,
      recommendations: lengthOk
        ? ['Revisar clareza e adicionar chamadas para acao no fechamento.']
        : ['Expandir o conteudo antes de relançar.'],
    };
  }
}

// ------------------------------------------------------------
// Score final deterministico (media ponderada das 4 dimensoes). Sem
// oportunidade-alvo, o peso de MARKET_FIT e redistribuido proporcionalmente.
// ------------------------------------------------------------
export function buildFinalScore(
  d: EbookDimensionScores,
  hasOpportunity: boolean,
): number {
  const w = { ...DIMENSION_WEIGHTS };
  if (!hasOpportunity) {
    // redistribui o peso de marketFit entre os outros 3 (mantem soma 1).
    const redist = w.marketFit / 3;
    return clampScore(
      d.structure * (w.structure + redist) +
        d.contentQuality * (w.contentQuality + redist) +
        d.compliance * (w.compliance + redist),
    );
  }
  return clampScore(
    d.structure * w.structure +
      d.contentQuality * w.contentQuality +
      d.marketFit * w.marketFit +
      d.compliance * w.compliance,
  );
}

// ------------------------------------------------------------
// Veredito DETERMINISTICO:
//  - Qualquer issue BLOCKER => FAIL (independe do score).
//  - score < QA_FAIL_SCORE => FAIL.
//  - score >= QA_MIN_SCORE  => PASS.
//  - caso contrario         => NEEDS_FIX (entra no loop de correcao).
// ------------------------------------------------------------
export function verdictFromScore(
  score: number,
  issues: EbookIssue[],
  ctx: AgentContext,
): EbookAuditVerdict {
  const minScore = numEnv(ctx, 'QA_MIN_SCORE', 70);
  const failScore = numEnv(ctx, 'QA_FAIL_SCORE', 40);
  const hasBlocker = issues.some((i) => i.severity === 'BLOCKER');
  if (hasBlocker || score < failScore) return 'FAIL';
  if (score >= minScore) return 'PASS';
  return 'NEEDS_FIX';
}

function numEnv(ctx: AgentContext, key: string, fallback: number): number {
  const v = ctx.env[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Remove issues duplicadas (mesma categoria+titulo). */
function dedupeIssues(issues: EbookIssue[]): EbookIssue[] {
  const seen = new Set<string>();
  const out: EbookIssue[] = [];
  for (const i of issues) {
    const key = `${i.category}::${i.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

// ------------------------------------------------------------
// Prompts (pt-BR). O LLM avalia qualidade/fit/compliance e devolve JSON.
// ------------------------------------------------------------
function buildAuditorSystemPrompt(): string {
  return [
    'Voce e um auditor editorial brasileiro, rigoroso e honesto, especialista em',
    'ebooks/infoprodutos que vendem. Avalie um ebook em 4 eixos (0..100):',
    '- structure: organizacao, capitulos, encadeamento.',
    '- contentQuality: profundidade, clareza, exemplos praticos, originalidade.',
    '- marketFit: aderencia ao segmento/angulos da oportunidade de mercado alvo.',
    '- compliance: ausencia de promessas enganosas, plagio aparente, conteudo proibido.',
    '',
    'Liste issues objetivas (category, severity LOW|MEDIUM|HIGH|BLOCKER, title, detail,',
    'suggestion; chapterIndex opcional). Use BLOCKER apenas para defeito grave que',
    'IMPEDE o lancamento. Seja exigente: ebook generico/raso NAO deve passar.',
    '',
    'Responda APENAS JSON: { "dimensionScores": { "structure": n, "contentQuality": n,',
    '"marketFit": n, "compliance": n }, "issues": [...], "recommendations": [string],',
    '"verdictHint": "PASS"|"NEEDS_FIX"|"FAIL" }.',
  ].join('\n');
}

function buildAuditorUserPrompt(ebook: AuditEbookInput, structure: EbookStructure): string {
  const opp = ebook.marketOpportunity;
  const excerpt = (ebook.contentMarkdown ?? '').slice(0, 6000);
  return JSON.stringify(
    {
      titulo: ebook.title,
      nicho: ebook.niche,
      estrutura: structure,
      oportunidadeAlvo: opp
        ? { segmento: opp.segment, nicho: opp.niche, angulos: opp.angles }
        : null,
      conteudoMarkdown: excerpt,
      instrucao:
        'Audite este ebook nos 4 eixos. Se houver oportunidade-alvo, avalie marketFit ' +
        'contra ela. Retorne o JSON do formato especificado.',
    },
    null,
    2,
  );
}
