// ContentAgent — pipeline de geracao de ebook.
//
// Fluxo de dominio (pt-BR):
//   1) gerar/normalizar nicho + tema
//   2) gerar OUTLINE estruturado (titulo, subtitulo, publico, capitulos) via LLM
//   3) gerar o CORPO de cada capitulo via LLM
//   4) gerar TITULO/DESCRICAO de venda (copy) + PROMPT de capa
//   5) montar o PDF (builder injetavel) e persistir via StoragePort
//   6) criar Ebook (status PUBLISHED) + Product no banco
//   7) emitir Event EBOOK_PUBLISHED
//
// O ciclo de vida (AgentRun) e responsabilidade de Agent.execute — este agente
// NUNCA toca a tabela AgentRun e recebe os ports via ctx.ports (DI -> stub).

import {
  Agent,
  type AgentContext,
  type AgentRunResult,
  skipped,
} from './base.js';
import {
  ebookOutlineSchema,
  type AgentName,
  type EbookOutline,
  type Json,
} from '@ebook-empire/core';

// ------------------------------------------------------------
// Entrada do PDF que o agente sabe montar (desacoplado do pdfkit).
// O apps/api injeta buildEbookPdf (lib/pdf.ts) como pdfBuilder; nos testes
// um stub trivial gera um Buffer deterministico.
// ------------------------------------------------------------
export interface ContentPdfChapter {
  title: string;
  body: string;
}

export interface ContentPdfInput {
  title: string;
  subtitle?: string;
  niche?: string;
  author?: string;
  chapters: ContentPdfChapter[];
}

export type EbookPdfBuilder = (input: ContentPdfInput) => Promise<Buffer>;

// Builder de fallback (sem pdfkit) — produz um "PDF textual" simples.
// Usado quando nenhum builder e injetado (ex. testes unitarios do agente).
const fallbackPdfBuilder: EbookPdfBuilder = async (input) => {
  const lines: string[] = [];
  lines.push(input.title);
  if (input.subtitle) lines.push(input.subtitle);
  lines.push('');
  input.chapters.forEach((c, i) => {
    lines.push(`Capitulo ${i + 1}: ${c.title}`);
    lines.push(c.body);
    lines.push('');
  });
  return Buffer.from(lines.join('\n'), 'utf-8');
};

// ------------------------------------------------------------
// Parametros aceitos no run (vindos da rota POST /ebooks/generate ou
// do orchestrator via params do plano).
// ------------------------------------------------------------
export interface ContentAgentParams {
  niche?: string;
  title?: string;
  language?: string;
  /**
   * GATE de mercado (pipeline de lancamento): id da MarketOpportunity que
   * originou o ebook. Quando presente, e gravado em Ebook.marketOpportunityId
   * (rastreabilidade do GATE 1). Opcional para compat com a geracao avulsa.
   */
  marketOpportunityId?: string;
  /**
   * Controla o GATE de qualidade. Default true (compat: publica direto +
   * cria Product, como antes). Quando false (pipeline de lancamento), o agente
   * cria o Ebook em status DRAFT e NAO cria Product — a publicacao fica a cargo
   * do GATE 2 (so apos PASS no QA).
   */
  publish?: boolean;
}

// Copy de venda gerada pelo LLM.
interface SalesCopy {
  marketingTitle: string;
  marketingDescription: string;
  coverPrompt: string;
}

// ------------------------------------------------------------
// Utilitarios
// ------------------------------------------------------------
const DEFAULT_PRICE_CENTS = 4700; // ancora R$47,00 (Int centavos BRL).

/** Limite de meta description para SEO (caracteres). */
export const META_DESCRIPTION_MAX = 160;

/**
 * Clampa uma descricao de venda ao limite de meta description (SEO). Normaliza
 * espacos, e se exceder o limite corta no ultimo espaco antes do teto e adiciona
 * reticencias (sem cortar palavra ao meio quando possivel).
 */
export function clampMetaDescription(text: string, max = META_DESCRIPTION_MAX): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  const slice = normalized.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[\s.,;:!-]+$/, '')}…`;
}

/** Gera um slug url-safe a partir de um texto (sem acentos). */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ============================================================
// ContentAgent
// ============================================================
export class ContentAgent extends Agent {
  readonly name: AgentName = 'CONTENT';

  /**
   * ID do Ebook criado no ultimo run bem-sucedido. Como a classe base nao
   * expoe o id do AgentRun para dentro de run(), o chamador (rota) pode usar
   * esta propriedade apos execute() para vincular generatedByRunId, se quiser.
   */
  lastEbookId: string | null = null;
  lastProductId: string | null = null;

  constructor(
    /** Builder de PDF injetado (apps/api injeta o real baseado em pdfkit). */
    private readonly pdfBuilder: EbookPdfBuilder = fallbackPdfBuilder,
    /** Parametros do pedido de geracao. */
    private readonly params: ContentAgentParams = {},
  ) {
    super();
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const niche = (this.params.niche ?? '').trim();
    if (!niche) {
      // Sem nicho nao ha o que gerar — SKIPPED idempotente.
      return skipped('niche ausente — nada a gerar');
    }

    const language = this.params.language ?? 'pt-BR';
    const model = ctx.env.CONTENT_MODEL;
    let tokensIn = 0;
    let tokensOut = 0;
    let costCents = 0;

    // --- 1+2) OUTLINE estruturado ---
    const outlineRes = await ctx.ports.llm.generateJson<EbookOutline>({
      model,
      maxTokens: 2000,
      temperature: 0.7,
      system:
        'Voce e um produtor de infoprodutos brasileiro especialista em ebooks que vendem. Escreva em pt-BR.',
      messages: [
        {
          role: 'user',
          content: this.buildOutlinePrompt(niche, this.params.title),
        },
      ],
      parse: (raw) => ebookOutlineSchema.parse(raw),
    });
    tokensIn += outlineRes.usage.inputTokens;
    tokensOut += outlineRes.usage.outputTokens;
    costCents += outlineRes.usage.costCents ?? 0;
    const outline = outlineRes.data;

    // --- 3) CORPO de cada capitulo ---
    const chapters: ContentPdfChapter[] = [];
    for (const chapter of outline.chapters) {
      const bodyRes = await ctx.ports.llm.generateText({
        model,
        maxTokens: 2000,
        temperature: 0.7,
        system:
          'Voce escreve capitulos de ebook em pt-BR, com tom didatico, exemplos praticos e paragrafos curtos.',
        messages: [
          {
            role: 'user',
            content: this.buildChapterPrompt(outline.title, chapter.title, chapter.summary),
          },
        ],
      });
      tokensIn += bodyRes.usage.inputTokens;
      tokensOut += bodyRes.usage.outputTokens;
      costCents += bodyRes.usage.costCents ?? 0;
      chapters.push({ title: chapter.title, body: bodyRes.text });
    }

    // --- 4) COPY de venda + prompt de capa ---
    const copy = await this.generateSalesCopy(ctx, outline, model, (u) => {
      tokensIn += u.inputTokens;
      tokensOut += u.outputTokens;
      costCents += u.costCents ?? 0;
    });

    // --- montar markdown do conteudo (persistido em Ebook.contentMarkdown) ---
    const contentMarkdown = this.buildMarkdown(outline, chapters);

    // --- 5) montar PDF + persistir via StoragePort ---
    const pdfKey = `ebooks/${slugify(outline.title)}-${Date.now()}.pdf`;
    const pdfBytes = await this.pdfBuilder({
      title: outline.title,
      subtitle: outline.subtitle,
      niche: outline.niche,
      author: 'Ebook Empire',
      chapters,
    });
    await ctx.ports.storage.putObject(pdfKey, pdfBytes);

    // --- 6) criar Ebook (+ Product, se publish) no banco ---
    // GATE de qualidade: por padrao (publish !== false) o agente publica direto
    // e cria o Product (geracao avulsa). No pipeline de lancamento (publish:false)
    // o ebook nasce DRAFT, sem Product — a publicacao fica a cargo do GATE 2.
    const shouldPublish = this.params.publish !== false;
    const ebookSlug = await this.uniqueSlug(ctx, slugify(outline.title));
    const ebook = await ctx.prisma.ebook.create({
      data: {
        title: copy.marketingTitle || outline.title,
        niche: outline.niche,
        slug: ebookSlug,
        status: shouldPublish ? 'PUBLISHED' : 'DRAFT',
        outline: outline as unknown as never,
        contentMarkdown,
        pdfPath: pdfKey,
        language,
        // GATE de mercado: vincula a oportunidade que originou o ebook (quando
        // veio do pipeline de lancamento). Rastreabilidade do GATE 1.
        ...(this.params.marketOpportunityId
          ? { marketOpportunityId: this.params.marketOpportunityId }
          : {}),
        // correlaciona com o AgentRun corrente: a classe base expoe this.runId
        // durante run() (preenchido por execute()). Em geracao avulsa via run()
        // direto (sem execute) vale null — relacao opcional no schema.
        generatedByRunId: this.runId,
      },
      select: { id: true, title: true, slug: true, niche: true },
    });
    this.lastEbookId = ebook.id;

    let product: { id: string; slug: string; priceCents: number } | null = null;
    if (shouldPublish) {
      const productSlug = await this.uniqueProductSlug(ctx, `${ebookSlug}-oferta`);
      product = await ctx.prisma.product.create({
        data: {
          ebookId: ebook.id,
          name: copy.marketingTitle || outline.title,
          slug: productSlug,
          description: copy.marketingDescription,
          priceCents: DEFAULT_PRICE_CENTS,
          currency: 'BRL',
          active: true,
        },
        select: { id: true, slug: true, priceCents: true },
      });
      this.lastProductId = product.id;

      // --- 7) Event EBOOK_PUBLISHED (funil interno; idempotencia nao aplicavel) ---
      await ctx.prisma.event.create({
        data: {
          type: 'EBOOK_PUBLISHED',
          productId: product.id,
          metadata: {
            ebookId: ebook.id,
            ebookSlug: ebook.slug,
            niche: ebook.niche,
          } as unknown as never,
        },
      });

      ctx.log.info(
        { ebookId: ebook.id, productId: product.id, niche: ebook.niche },
        'ContentAgent publicou novo ebook',
      );
    } else {
      ctx.log.info(
        { ebookId: ebook.id, niche: ebook.niche },
        'ContentAgent gerou ebook em DRAFT (aguardando GATE de qualidade)',
      );
    }

    const output: Json = {
      ebookId: ebook.id,
      ebookSlug: ebook.slug,
      productId: product?.id ?? null,
      productSlug: product?.slug ?? null,
      priceCents: product?.priceCents ?? null,
      published: shouldPublish,
      marketOpportunityId: this.params.marketOpportunityId ?? null,
      chapters: chapters.length,
      coverPrompt: copy.coverPrompt,
      pdfPath: pdfKey,
    };

    return {
      status: 'SUCCESS',
      output,
      metrics: { chapters: chapters.length },
      tokensIn,
      tokensOut,
      costCents,
    };
  }

  // ----------------------------------------------------------
  // COPY de venda + prompt de capa (geracao estruturada via texto).
  // ----------------------------------------------------------
  private async generateSalesCopy(
    ctx: AgentContext,
    outline: EbookOutline,
    model: string,
    accumulate: (usage: { inputTokens: number; outputTokens: number; costCents?: number }) => void,
  ): Promise<SalesCopy> {
    const res = await ctx.ports.llm.generateText({
      model,
      maxTokens: 800,
      temperature: 0.8,
      system:
        'Voce e um copywriter de resposta direta brasileiro com dominio de SEO. ' +
        'Escreva copy persuasiva, honesta e otimizada para busca em pt-BR. Pense na ' +
        'INTENCAO DE BUSCA do publico (o que ele digitaria no Google/marketplace para ' +
        'resolver a dor) e use essa keyword-alvo de forma natural no titulo e na descricao.',
      messages: [
        {
          role: 'user',
          content: `Crie a copy de venda OTIMIZADA PARA SEO do ebook "${outline.title}" (nicho: ${outline.niche}).
Publico: ${outline.targetAudience ?? 'geral'}.
Primeiro, identifique a KEYWORD-ALVO (o termo de busca em pt-BR que esse publico usaria para encontrar a solucao — ex.: "como ${outline.niche.toLowerCase()}").
Responda em 3 blocos separados por linhas, NESTA ordem:
TITULO: <titulo de venda chamativo, ate 120 caracteres, contendo a KEYWORD-ALVO de preferencia no inicio>
DESCRICAO: <descricao persuasiva e escaneavel, no MAXIMO 160 caracteres (limite de meta description), incluindo a keyword-alvo e alinhada a intencao de busca>
CAPA: <um prompt visual em ingles para gerar a imagem de capa>`,
        },
      ],
    });
    accumulate(res.usage);

    return this.parseSalesCopy(res.text, outline);
  }

  /** Parser tolerante da copy textual (com fallback determinístico). */
  parseSalesCopy(text: string, outline: EbookOutline): SalesCopy {
    const pick = (label: string): string | undefined => {
      const re = new RegExp(`${label}\\s*[:\\-]\\s*(.+)`, 'i');
      const m = text.match(re);
      return m?.[1]?.trim();
    };
    const rawDescription =
      pick('DESCRICAO') ??
      `Aprenda tudo sobre ${outline.niche} neste ebook pratico e direto ao ponto.`;
    return {
      marketingTitle: pick('TITULO') ?? outline.title,
      // SEO: a meta description efetiva fica <= 160 chars (limite de SERP).
      // Hard-clamp como rede de seguranca caso o LLM extrapole.
      marketingDescription: clampMetaDescription(rawDescription),
      coverPrompt:
        pick('CAPA') ??
        `Modern minimalist ebook cover about ${outline.niche}, professional, high contrast`,
    };
  }

  // ----------------------------------------------------------
  // Prompts
  // ----------------------------------------------------------
  private buildOutlinePrompt(niche: string, title?: string): string {
    const titleHint = title ? `O titulo desejado e "${title}". ` : '';
    return `Crie o outline de um ebook vendavel no nicho: ${niche}.
${titleHint}Defina titulo, subtitulo, publico-alvo e ao menos 3 capitulos (cada um com titulo e um resumo de uma frase).
Responda em JSON com as chaves: title, niche, subtitle, targetAudience, chapters (array de {title, summary}).`;
  }

  private buildChapterPrompt(
    ebookTitle: string,
    chapterTitle: string,
    summary: string,
  ): string {
    return `Escreva o conteudo completo do capitulo "${chapterTitle}" do ebook "${ebookTitle}".
Resumo do capitulo: ${summary}
Use de 4 a 8 paragrafos, com exemplos praticos. Nao repita o titulo do capitulo no corpo.`;
  }

  private buildMarkdown(outline: EbookOutline, chapters: ContentPdfChapter[]): string {
    const parts: string[] = [];
    parts.push(`# ${outline.title}`);
    if (outline.subtitle) parts.push(`_${outline.subtitle}_`);
    parts.push('');
    chapters.forEach((c, i) => {
      parts.push(`## ${i + 1}. ${c.title}`);
      parts.push('');
      parts.push(c.body);
      parts.push('');
    });
    return parts.join('\n');
  }

  // ----------------------------------------------------------
  // Garante slug unico (Ebook.slug @unique / Product.slug @unique).
  // ----------------------------------------------------------
  private async uniqueSlug(ctx: AgentContext, base: string): Promise<string> {
    const safeBase = base || 'ebook';
    let slug = safeBase;
    let n = 1;
    // Loop curto e idempotente; em pratica raramente colide.
    while (await ctx.prisma.ebook.findUnique({ where: { slug }, select: { id: true } })) {
      n += 1;
      slug = `${safeBase}-${n}`;
    }
    return slug;
  }

  private async uniqueProductSlug(ctx: AgentContext, base: string): Promise<string> {
    const safeBase = base || 'oferta';
    let slug = safeBase;
    let n = 1;
    while (await ctx.prisma.product.findUnique({ where: { slug }, select: { id: true } })) {
      n += 1;
      slug = `${safeBase}-${n}`;
    }
    return slug;
  }
}
