// SalesAgent — dono da monetizacao da oferta.
// Responsabilidades:
//   1) Garante que cada Ebook PUBLISHED tenha um Product ativo (cria oferta-ancora).
//   2) Ajusta preco com base na conversao recente (heuristica simples + guard-rails).
//   3) Gera/atualiza a copy da landing page via LLM (claude-sonnet-4-6).
//   4) Registra metricas de conversao no output do AgentRun.
//
// Contrato (base.ts): estende Agent, implementa name + run(ctx). NUNCA toca
// a tabela AgentRun nem instancia adapters — recebe ports via ctx.ports.
// Retorna SUCCESS/SKIPPED; lanca em falha. Helper skipped() disponivel.

import type { AgentName } from '@ebook-empire/core';
import { Agent, skipped } from './base.js';
import type { AgentContext, AgentRunResult } from './base.js';

// Guard-rails de preco (centavos BRL). Mantem a oferta dentro de uma faixa sa.
const MIN_PRICE_CENTS = 1900; // R$19
const MAX_PRICE_CENTS = 19700; // R$197
const DEFAULT_PRICE_CENTS = 4700; // R$47 (ancora classica de info-produto)
const PRICE_STEP_CENTS = 1000; // passo de ajuste R$10

// Janela de analise de conversao (dias).
const CONVERSION_WINDOW_DAYS = 7;
// Minimo de inicios de checkout para confiar na taxa antes de mexer no preco.
const MIN_CHECKOUTS_FOR_PRICING = 10;
// Faixas-alvo de conversao checkout->pago.
const CONVERSION_HIGH = 0.4; // acima disso, ha espaco para subir preco
const CONVERSION_LOW = 0.1; // abaixo disso, reduz preco

function clampPrice(cents: number): number {
  return Math.max(MIN_PRICE_CENTS, Math.min(MAX_PRICE_CENTS, Math.round(cents)));
}

function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacriticos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export class SalesAgent extends Agent {
  readonly name: AgentName = 'SALES';

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const { prisma, ports, log } = ctx;

    // 1) Ebooks publicados que ainda nao tem Product ativo -> cria oferta-ancora.
    const publishedEbooks = await prisma.ebook.findMany({
      where: { status: 'PUBLISHED' },
      include: { products: true },
    });

    if (publishedEbooks.length === 0) {
      return skipped('nenhum ebook publicado para monetizar');
    }

    let createdProducts = 0;
    let priceAdjustments = 0;
    let copyUpdates = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let costCents = 0;

    for (const ebook of publishedEbooks) {
      const activeProduct = ebook.products.find((p) => p.active);

      // ---- 1a) cria oferta-ancora se nao existir ----
      if (!activeProduct) {
        const baseSlug = slugify(ebook.slug || ebook.title) || `oferta-${ebook.id.slice(0, 8)}`;
        const slug = `${baseSlug}-oferta`;
        await prisma.product.create({
          data: {
            ebookId: ebook.id,
            name: `${ebook.title} (Ebook)`,
            slug,
            description: `Acesso imediato ao ebook "${ebook.title}".`,
            priceCents: DEFAULT_PRICE_CENTS,
            currency: 'BRL',
            active: true,
          },
        });
        createdProducts += 1;
        log.info({ ebookId: ebook.id, slug }, 'oferta-ancora criada');
        continue; // sem historico de conversao ainda; ajusta no proximo ciclo
      }

      // ---- 1b) analisa conversao recente e ajusta preco ----
      const since = new Date(
        ctx.clock.now().getTime() - CONVERSION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );

      const [checkouts, paidOrders] = await Promise.all([
        prisma.event.count({
          where: {
            type: 'CHECKOUT_STARTED',
            productId: activeProduct.id,
            occurredAt: { gte: since },
          },
        }),
        prisma.order.count({
          where: {
            productId: activeProduct.id,
            status: { in: ['PAID', 'DELIVERED'] },
            createdAt: { gte: since },
          },
        }),
      ]);

      const conversion = checkouts > 0 ? paidOrders / checkouts : 0;

      let newPrice = activeProduct.priceCents;
      if (checkouts >= MIN_CHECKOUTS_FOR_PRICING) {
        if (conversion >= CONVERSION_HIGH) {
          // demanda alta -> testa subir preco
          newPrice = clampPrice(activeProduct.priceCents + PRICE_STEP_CENTS);
        } else if (conversion < CONVERSION_LOW) {
          // demanda baixa -> reduz preco
          newPrice = clampPrice(activeProduct.priceCents - PRICE_STEP_CENTS);
        }
      }

      if (newPrice !== activeProduct.priceCents) {
        await prisma.product.update({
          where: { id: activeProduct.id },
          data: { priceCents: newPrice },
        });
        priceAdjustments += 1;
        log.info(
          {
            productId: activeProduct.id,
            from: activeProduct.priceCents,
            to: newPrice,
            conversion,
          },
          'preco ajustado por conversao',
        );
      }

      // ---- 1c) gera copy da landing via LLM (best-effort) ----
      // So gera copy quando o produto ainda nao tem descricao rica
      // (heuristica: descricao curta) para economizar tokens.
      const needsCopy =
        !activeProduct.description || activeProduct.description.length < 80;
      if (needsCopy && ctx.env.CONTENT_MODEL) {
        try {
          const result = await ports.llm.generateText({
            model: ctx.env.CONTENT_MODEL,
            maxTokens: 600,
            temperature: 0.8,
            system:
              'Voce e um copywriter de resposta direta BR. Escreva copy de landing ' +
              'page persuasiva, honesta e em pt-BR para um ebook digital. ' +
              'Sem emojis. Foque em beneficio e transformacao.',
            messages: [
              {
                role: 'user',
                content:
                  `Ebook: "${ebook.title}" (nicho: ${ebook.niche}). ` +
                  `Preco: R$${(newPrice / 100).toFixed(2)}. ` +
                  'Escreva uma descricao de venda de 2 a 3 paragrafos curtos.',
              },
            ],
          });
          const copy = result.text.trim();
          if (copy) {
            await prisma.product.update({
              where: { id: activeProduct.id },
              data: { description: copy.slice(0, 2000) },
            });
            copyUpdates += 1;
          }
          tokensIn += result.usage.inputTokens;
          tokensOut += result.usage.outputTokens;
          costCents += result.usage.costCents ?? 0;
        } catch (err) {
          // Copy e best-effort: falha de LLM nao derruba o run inteiro.
          log.warn(
            {
              productId: activeProduct.id,
              err: err instanceof Error ? err.message : String(err),
            },
            'falha ao gerar copy da landing (ignorado)',
          );
        }
      }
    }

    // Nada mudou -> SKIPPED (idempotente).
    if (createdProducts === 0 && priceAdjustments === 0 && copyUpdates === 0) {
      return skipped('nenhuma acao de vendas necessaria neste ciclo', {
        ebooks: publishedEbooks.length,
      });
    }

    return {
      status: 'SUCCESS',
      output: {
        createdProducts,
        priceAdjustments,
        copyUpdates,
      },
      metrics: {
        ebooksAvaliados: publishedEbooks.length,
      },
      tokensIn: tokensIn || undefined,
      tokensOut: tokensOut || undefined,
      costCents: costCents || undefined,
    };
  }
}
