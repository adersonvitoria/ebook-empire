// EBOOK_QA — Executor de correcao/relançamento (RelaunchExecutor). Dono deste arquivo.
//
// Aplica um FixPlan: regenera conteudo/copy via LLM (LLMPort) e PERSISTE as
// correcoes no Ebook/Product, deixando-o pronto para reauditar. Reaproveita o
// LLMPort (mesmo modelo de conteudo do ContentAgent) — NAO instancia o
// ContentAgent (que criaria um Ebook novo); aqui mutamos o ebook EXISTENTE.
//
// Importante sobre GATES (doc EBOOK-QA.md): este executor apenas CORRIGE; quem
// decide relançar e o service (apos reauditar e dar PASS). Aqui marcamos o ebook
// como DRAFT (estado canonico nao-lançado) enquanto corrige, e emitimos o Event
// EBOOK_RELAUNCHED somente quando o service confirma o PASS.
//
// Convencoes: strings pt-BR; dinheiro Int centavos (nao tocado aqui).

import type { AgentContext } from '../../base.js';
import type { FixAction, FixPlan } from './fix-strategist.js';
import type { AuditEbookInput } from './auditor.js';

export interface RelaunchResult {
  ebookId: string;
  applied: FixActionKindResult[];
  /** Markdown resultante (persistido). */
  newMarkdown: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
}

export interface FixActionKindResult {
  kind: FixAction['kind'];
  status: 'APPLIED' | 'SKIPPED';
  detail: string;
}

// ============================================================
// RelaunchExecutor — o "Executor" do time EBOOK_QA.
// ============================================================
export class RelaunchExecutor {
  /**
   * Aplica o FixPlan ao ebook EXISTENTE. Cada acao reaproveita o LLM para
   * regenerar a parte afetada e persiste no banco. Idempotente o suficiente:
   * roda sobre o estado atual do ebook e sempre deixa um markdown valido.
   */
  async apply(
    ctx: AgentContext,
    ebook: AuditEbookInput,
    plan: FixPlan,
  ): Promise<RelaunchResult> {
    let tokensIn = 0;
    let tokensOut = 0;
    let costCents = 0;
    const applied: FixActionKindResult[] = [];
    let markdown = ebook.contentMarkdown ?? `# ${ebook.title}\n`;
    const model = ctx.env.CONTENT_MODEL as string;

    for (const action of plan.actions) {
      if (action.kind === 'REGENERATE_CHAPTERS') {
        try {
          const res = await ctx.ports.llm.generateText({
            model,
            maxTokens: 3000,
            temperature: 0.7,
            system:
              'Voce reescreve e aprofunda ebooks em pt-BR, com tom didatico, ' +
              'exemplos praticos e paragrafos curtos. Devolva markdown completo.',
            messages: [
              {
                role: 'user',
                content: buildRegeneratePrompt(ebook, markdown, action.reason),
              },
            ],
          });
          tokensIn += res.usage.inputTokens;
          tokensOut += res.usage.outputTokens;
          costCents += res.usage.costCents ?? 0;
          markdown = ensureMarkdown(res.text, ebook.title);
          applied.push({
            kind: action.kind,
            status: 'APPLIED',
            detail: 'Capitulos regenerados/aprofundados via LLM.',
          });
        } catch (err) {
          applied.push({
            kind: action.kind,
            status: 'SKIPPED',
            detail: `Falha ao regenerar: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else if (action.kind === 'REWRITE_SALES_COPY') {
        const out = await this.rewriteSalesCopy(ctx, ebook, model);
        tokensIn += out.tokensIn;
        tokensOut += out.tokensOut;
        costCents += out.costCents;
        applied.push({
          kind: action.kind,
          status: out.applied ? 'APPLIED' : 'SKIPPED',
          detail: out.detail,
        });
      } else if (action.kind === 'REALIGN_MARKET_FIT') {
        try {
          const res = await ctx.ports.llm.generateText({
            model,
            maxTokens: 3000,
            temperature: 0.6,
            system:
              'Voce reposiciona ebooks em pt-BR para um segmento de mercado especifico, ' +
              'reforçando os angulos de venda. Devolva markdown completo do ebook.',
            messages: [
              { role: 'user', content: buildRealignPrompt(ebook, markdown) },
            ],
          });
          tokensIn += res.usage.inputTokens;
          tokensOut += res.usage.outputTokens;
          costCents += res.usage.costCents ?? 0;
          markdown = ensureMarkdown(res.text, ebook.title);
          applied.push({
            kind: action.kind,
            status: 'APPLIED',
            detail: 'Conteudo realinhado a oportunidade de mercado alvo.',
          });
        } catch (err) {
          applied.push({
            kind: action.kind,
            status: 'SKIPPED',
            detail: `Falha ao realinhar: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else if (action.kind === 'FIX_COMPLIANCE') {
        try {
          const res = await ctx.ports.llm.generateText({
            model,
            maxTokens: 3000,
            temperature: 0.3,
            system:
              'Voce revisa ebooks em pt-BR removendo promessas enganosas, garantias ' +
              'irreais e conteudo problematico, preservando o valor. Devolva markdown completo.',
            messages: [
              { role: 'user', content: buildCompliancePrompt(ebook, markdown, action.reason) },
            ],
          });
          tokensIn += res.usage.inputTokens;
          tokensOut += res.usage.outputTokens;
          costCents += res.usage.costCents ?? 0;
          markdown = ensureMarkdown(res.text, ebook.title);
          applied.push({
            kind: action.kind,
            status: 'APPLIED',
            detail: 'Trechos de compliance ajustados.',
          });
        } catch (err) {
          applied.push({
            kind: action.kind,
            status: 'SKIPPED',
            detail: `Falha de compliance: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    // Persiste o markdown corrigido. Mantem o ebook em DRAFT (nao-lançado) ate o
    // service reauditar e dar PASS (o gate de lancamento e do service/pipeline).
    await ctx.prisma.ebook.update({
      where: { id: ebook.id },
      data: { contentMarkdown: markdown, status: 'DRAFT' },
    });

    ctx.log.info(
      { ebookId: ebook.id, applied: applied.map((a) => `${a.kind}:${a.status}`) },
      'correcoes aplicadas ao ebook',
    );

    return { ebookId: ebook.id, applied, newMarkdown: markdown, tokensIn, tokensOut, costCents };
  }

  /** Reescreve a copy de venda do Product ativo (se houver). */
  private async rewriteSalesCopy(
    ctx: AgentContext,
    ebook: AuditEbookInput,
    model: string,
  ): Promise<{ applied: boolean; detail: string; tokensIn: number; tokensOut: number; costCents: number }> {
    const product = await ctx.prisma.product.findFirst({
      where: { ebookId: ebook.id, active: true },
      select: { id: true },
    });
    if (!product) {
      return { applied: false, detail: 'Sem Product ativo para reescrever copy.', tokensIn: 0, tokensOut: 0, costCents: 0 };
    }
    try {
      const res = await ctx.ports.llm.generateText({
        model,
        maxTokens: 600,
        temperature: 0.8,
        system: 'Voce e copywriter de resposta direta brasileiro. Copy persuasiva e honesta em pt-BR.',
        messages: [
          {
            role: 'user',
            content: `Reescreva a descricao de venda do ebook "${ebook.title}" (nicho: ${ebook.niche}). ` +
              `Responda apenas com um paragrafo persuasivo de 2 a 4 frases.`,
          },
        ],
      });
      const description = res.text.trim().slice(0, 1000);
      await ctx.prisma.product.update({
        where: { id: product.id },
        data: { description },
      });
      return {
        applied: true,
        detail: 'Copy de venda reescrita.',
        tokensIn: res.usage.inputTokens,
        tokensOut: res.usage.outputTokens,
        costCents: res.usage.costCents ?? 0,
      };
    } catch (err) {
      return {
        applied: false,
        detail: `Falha ao reescrever copy: ${err instanceof Error ? err.message : String(err)}`,
        tokensIn: 0,
        tokensOut: 0,
        costCents: 0,
      };
    }
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/** Garante que o markdown tenha ao menos um titulo de nivel 1. */
function ensureMarkdown(text: string, title: string): string {
  const trimmed = text.trim();
  if (!trimmed) return `# ${title}\n`;
  if (!/^\s*#\s+\S/m.test(trimmed)) {
    return `# ${title}\n\n${trimmed}`;
  }
  return trimmed;
}

function buildRegeneratePrompt(ebook: AuditEbookInput, markdown: string, reason: string): string {
  return [
    `Reescreva e APROFUNDE o ebook "${ebook.title}" (nicho: ${ebook.niche}).`,
    `Problemas a corrigir: ${reason}.`,
    'Mantenha a estrutura em capitulos (## Titulo do capitulo), com pelo menos 3 capitulos,',
    'cada um com varios paragrafos, exemplos praticos e passo a passo. Devolva o markdown completo.',
    '',
    'Conteudo atual (referencia):',
    markdown.slice(0, 5000),
  ].join('\n');
}

function buildRealignPrompt(ebook: AuditEbookInput, markdown: string): string {
  const opp = ebook.marketOpportunity;
  return [
    `Reposicione o ebook "${ebook.title}" para o segmento "${opp?.segment ?? ebook.niche}".`,
    opp ? `Angulos de venda a reforçar: ${opp.angles.join('; ')}.` : '',
    'Reescreva o conteudo mantendo a estrutura em capitulos (## ...). Devolva o markdown completo.',
    '',
    'Conteudo atual:',
    markdown.slice(0, 5000),
  ].join('\n');
}

function buildCompliancePrompt(ebook: AuditEbookInput, markdown: string, reason: string): string {
  return [
    `Revise o ebook "${ebook.title}" para compliance. Problemas: ${reason}.`,
    'Remova promessas enganosas, garantias irreais e conteudo problematico, preservando o valor.',
    'Mantenha a estrutura em capitulos (## ...). Devolva o markdown completo.',
    '',
    'Conteudo atual:',
    markdown.slice(0, 5000),
  ].join('\n');
}
