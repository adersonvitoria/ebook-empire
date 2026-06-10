// SocialAgent — movimenta o perfil de Instagram do negocio.
//
// Fluxo de dominio (idempotente por tick):
//  1) Escolhe um Ebook PUBLISHED com produto ativo que ainda nao foi divulgado
//     recentemente (ou usa um SocialPost ja em DRAFT/SCHEDULED pendente).
//  2) Gera legenda + hashtags + ideia de criativo via LLMPort (CONTENT_MODEL).
//  3) Cria/agenda um SocialPost (status SCHEDULED).
//  4) Publica o(s) post(s) cujo scheduledAt ja venceu via InstagramPort.
//  5) Apos publicar, le insights basicos do post e grava em SocialPost.metrics.
//  6) Emite Event(SOCIAL_POSTED) para o funil interno.
//
// NUNCA toca a tabela AgentRun (isso e do ciclo de vida em Agent.execute).
// Recebe ports via ctx.ports (DI -> stub em vitest).

import { Agent, skipped, type AgentContext, type AgentRunResult } from './base.js';
import {
  socialPostContentSchema,
  type AgentName,
  type SocialPostContent,
} from '@ebook-empire/core';

// Janela de cooldown: nao gera novo post para o mesmo ebook dentro deste prazo.
const EBOOK_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
// Quantos posts publicar por tick (evita rajadas).
const MAX_PUBLISH_PER_TICK = 3;

export class SocialAgent extends Agent {
  readonly name: AgentName = 'SOCIAL';

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const { prisma, ports, env, clock, log } = ctx;
    const now = clock.now();

    let tokensIn = 0;
    let tokensOut = 0;
    let costCents = 0;
    let generated = 0;
    let published = 0;

    // ---------------------------------------------------------
    // 1) Gerar+agendar um novo post se houver ebook "frio" disponivel.
    // ---------------------------------------------------------
    const ebook = await this.pickEbookToPromote(ctx, now);
    if (ebook) {
      const content = await this.generateContent(ctx, ebook);
      tokensIn += content.usage.inputTokens;
      tokensOut += content.usage.outputTokens;
      costCents += content.usage.costCents ?? 0;

      await prisma.socialPost.create({
        data: {
          platform: 'instagram',
          caption: content.data.caption,
          hashtags: content.data.hashtags,
          // Guarda a ideia de criativo no metrics.creativePrompt ate haver imagem real.
          mediaPaths: [],
          status: 'SCHEDULED',
          scheduledAt: now, // pronto para publicar ja no proximo passo
          productId: ebook.productId,
          agentRunId: null,
          metrics: { creativePrompt: content.data.creativePrompt },
        },
      });
      generated += 1;
      log.info({ ebookId: ebook.id }, 'social: post gerado e agendado');
    }

    // ---------------------------------------------------------
    // 2) Publicar posts SCHEDULED cujo horario ja venceu.
    // ---------------------------------------------------------
    const due = await prisma.socialPost.findMany({
      where: {
        status: 'SCHEDULED',
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
      },
      orderBy: { scheduledAt: 'asc' },
      take: MAX_PUBLISH_PER_TICK,
    });

    for (const post of due) {
      try {
        const mediaUrl = this.resolveMediaUrl(env, post.mediaPaths);
        const result = await ports.instagram.publishPost({
          caption: post.caption,
          mediaUrl,
          hashtags: post.hashtags,
        });

        // Le insights basicos logo apos publicar.
        const insights = await ports.instagram
          .getPostInsights(result.externalId)
          .catch(() => null);

        await prisma.socialPost.update({
          where: { id: post.id },
          data: {
            status: 'PUBLISHED',
            publishedAt: now,
            externalPostId: result.externalId,
            permalink: result.permalink,
            attempts: { increment: 1 },
            error: null,
            metrics: mergeMetrics(post.metrics, insights) as never,
          },
        });

        // Evento operacional do funil interno (sem provider/externalEventId).
        await prisma.event.create({
          data: {
            type: 'SOCIAL_POSTED',
            productId: post.productId,
            payload: {
              socialPostId: post.id,
              externalPostId: result.externalId,
              permalink: result.permalink,
            },
          },
        });

        published += 1;
        log.info(
          { socialPostId: post.id, externalPostId: result.externalId },
          'social: post publicado',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await prisma.socialPost.update({
          where: { id: post.id },
          data: {
            status: 'FAILED',
            attempts: { increment: 1 },
            error: message,
          },
        });
        log.warn({ socialPostId: post.id, err: message }, 'social: falha ao publicar');
      }
    }

    if (generated === 0 && published === 0) {
      return skipped('nenhum ebook frio para divulgar e nenhum post vencido');
    }

    return {
      status: 'SUCCESS',
      output: { generated, published },
      metrics: { generated, published },
      tokensIn,
      tokensOut,
      costCents,
    };
  }

  // ---------------------------------------------------------
  // Seleciona um Ebook PUBLISHED com Product ativo que nao foi divulgado
  // nas ultimas 6h (cooldown), priorizando o mais antigo sem divulgacao.
  // ---------------------------------------------------------
  private async pickEbookToPromote(
    ctx: AgentContext,
    now: Date,
  ): Promise<{ id: string; title: string; niche: string; productId: string } | null> {
    const { prisma } = ctx;
    const cutoff = new Date(now.getTime() - EBOOK_COOLDOWN_MS);

    const candidates = await prisma.ebook.findMany({
      where: {
        status: 'PUBLISHED',
        products: { some: { active: true } },
      },
      select: {
        id: true,
        title: true,
        niche: true,
        products: {
          where: { active: true },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    for (const c of candidates) {
      const product = c.products[0];
      if (!product) continue;

      // cooldown: existe post recente para este produto?
      const recent = await prisma.socialPost.findFirst({
        where: {
          productId: product.id,
          createdAt: { gte: cutoff },
        },
        select: { id: true },
      });
      if (recent) continue;

      return { id: c.id, title: c.title, niche: c.niche, productId: product.id };
    }
    return null;
  }

  // ---------------------------------------------------------
  // Gera legenda + hashtags + ideia de criativo via LLM (JSON validado por Zod).
  // ---------------------------------------------------------
  private async generateContent(
    ctx: AgentContext,
    ebook: { title: string; niche: string },
  ): Promise<{ data: SocialPostContent; usage: { inputTokens: number; outputTokens: number; costCents?: number } }> {
    const { ports, env } = ctx;
    const system =
      'Voce e um social media especialista em Instagram para infoprodutos no Brasil. ' +
      'Escreva em portugues (pt-BR), tom proximo e persuasivo, com 1 CTA claro. ' +
      'Responda SOMENTE com JSON valido no formato ' +
      '{"caption": string, "hashtags": string[], "creativePrompt": string}. ' +
      'A caption deve ter ate 2200 caracteres; hashtags sem o "#" e no maximo 15; ' +
      'creativePrompt descreve a ideia visual do criativo (imagem) em uma frase.';

    const userMsg =
      `Crie um post de Instagram para divulgar o ebook "${ebook.title}" ` +
      `do nicho "${ebook.niche}". Objetivo: gerar cliques para a pagina de venda e vendas via PIX.`;

    const result = await ports.llm.generateJson<SocialPostContent>({
      model: env.CONTENT_MODEL,
      system,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 1024,
      temperature: 0.8,
      parse: (raw) => socialPostContentSchema.parse(raw),
    });

    return { data: result.data, usage: result.usage };
  }

  // ---------------------------------------------------------
  // Resolve a URL de media para o IG. Se nao houver criativo gerado,
  // usa um placeholder publico sob PUBLIC_BASE_URL (stub aceita qualquer URL).
  // ---------------------------------------------------------
  private resolveMediaUrl(
    env: AgentContext['env'],
    mediaPaths: string[],
  ): string {
    const first = mediaPaths[0];
    if (first && /^https?:\/\//.test(first)) return first;
    const base = String(env.PUBLIC_BASE_URL).replace(/\/$/, '');
    if (first) return `${base}/${first.replace(/^\//, '')}`;
    return `${base}/static/social-placeholder.png`;
  }
}

// Mescla metrics existente (ex. creativePrompt) com os insights do post.
function mergeMetrics(
  existing: unknown,
  insights: { likes: number; comments: number; saves: number; reach: number } | null,
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  if (!insights) return base;
  return { ...base, ...insights };
}
