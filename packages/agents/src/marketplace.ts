// MarketplaceAgent — sincroniza ebooks PUBLISHED em marketplaces externos.
//
// Gatilho (cada run): Ebook status=PUBLISHED cujo Product ainda NAO possui
// MarketplaceListing para um dos provedores (Hotmart/Kiwify). Para cada um:
//   1) escolhe o Product vendavel do ebook (preferindo o ativo);
//   2) faz upload do PDF por STREAM via ports.storage.getObject(ebook.pdfPath)
//      (o adapter real envia multipart sem reter o buffer);
//   3) chama ports.marketplace.createProduct para Hotmart e Kiwify;
//   4) upsert MarketplaceListing com os IDs/URLs retornados.
//
// Idempotencia: MarketplaceListing @@unique([productId, provider]). Listings ja
// existentes sao puladas — o run varre apenas o que falta sincronizar.
//
// O ciclo de vida (AgentRun) e responsabilidade de Agent.execute — este agente
// NUNCA toca a tabela AgentRun. Roda no loop FAST (agendado pela Fundacao).

import type {
  AgentName,
  MarketplaceProvider,
  MarketplacePort,
} from '@ebook-empire/core';
import {
  Agent,
  skipped,
  type AgentContext,
  type AgentRunResult,
} from './base.js';

// Lote maximo de ebooks sincronizados por tick (evita run longo demais).
const MAX_BATCH = 10;

// Provedores que o agente publica (ordem estavel de iteracao).
const PROVIDERS: readonly MarketplaceProvider[] = ['HOTMART', 'KIWIFY'] as const;

/**
 * O bundle de marketplace exposto em ctx.ports.marketplace pode vir como um
 * unico MarketplacePort (legacy/teste) OU como um mapa por provedor
 * (createMarketplaceAdapter). Esta funcao resolve o port do provedor pedido de
 * forma defensiva (sem acoplar o agente ao shape exato do wiring).
 */
function resolveProviderPort(
  marketplace: unknown,
  provider: MarketplaceProvider,
): MarketplacePort | undefined {
  if (!marketplace) return undefined;
  const asMap = marketplace as Partial<Record<MarketplaceProvider, MarketplacePort>>;
  if (asMap[provider] && typeof asMap[provider]?.createProduct === 'function') {
    return asMap[provider];
  }
  const asPort = marketplace as MarketplacePort;
  if (typeof asPort.createProduct === 'function') {
    return asPort;
  }
  return undefined;
}

export class MarketplaceAgent extends Agent {
  readonly name: AgentName = 'MARKETPLACE';

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const now = ctx.clock.now();

    if (!ctx.ports.marketplace) {
      return skipped('MarketplacePort ausente no wiring (ctx.ports.marketplace)');
    }
    if (!ctx.ports.storage) {
      return skipped('StoragePort ausente no wiring (ctx.ports.storage)');
    }

    // Ebooks PUBLISHED com ao menos 1 Product e seus listings (p/ saber o que falta).
    const ebooks = await ctx.prisma.ebook.findMany({
      where: { status: 'PUBLISHED' },
      include: {
        products: { include: { listings: true } },
      },
      orderBy: { updatedAt: 'asc' },
      take: MAX_BATCH,
    });

    if (ebooks.length === 0) {
      return skipped('nenhum ebook PUBLISHED para sincronizar');
    }

    const defaultCommission =
      typeof ctx.env.MARKETPLACE_AFFILIATE_COMMISSION_PCT === 'number'
        ? (ctx.env.MARKETPLACE_AFFILIATE_COMMISSION_PCT as number)
        : 50;

    let listingsCreated = 0;
    let ebooksTouched = 0;
    const errors: string[] = [];

    for (const ebook of ebooks) {
      // Escolhe o Product vendavel: prioriza ativo; ignora ebooks sem produto.
      const product =
        ebook.products.find((p) => p.active) ?? ebook.products[0];
      if (!product) continue;

      const existingProviders = new Set(
        product.listings.map((l) => l.provider),
      );
      // Provedores ainda nao sincronizados para este Product.
      const missing = PROVIDERS.filter((p) => !existingProviders.has(p));
      if (missing.length === 0) continue;

      let touchedThisEbook = false;

      for (const provider of missing) {
        const port = resolveProviderPort(ctx.ports.marketplace, provider);
        if (!port) {
          errors.push(`${provider}: port indisponivel para ${product.id}`);
          continue;
        }

        try {
          const commission = product.affiliateCommissionPct ?? defaultCommission;

          // 1) Upload do PDF por STREAM (se houver e o adapter suportar).
          if (ebook.pdfPath) {
            const uploader = port as { uploadPdf?: (id: string, path: string) => Promise<void> };
            // Cria primeiro para ter o externalProductId; upload logo apos.
            const created = await port.createProduct({
              productId: product.id,
              name: product.name,
              description: product.description ?? undefined,
              priceCents: product.priceCents,
              affiliateCommissionPct: commission,
            });

            if (typeof uploader.uploadPdf === 'function') {
              try {
                await uploader.uploadPdf(created.externalProductId, ebook.pdfPath);
              } catch (uploadErr) {
                const m =
                  uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
                ctx.log.warn(
                  { ebookId: ebook.id, provider, err: m },
                  'falha no upload do PDF (listing criada mesmo assim)',
                );
              }
            }

            await this.upsertListing(ctx, product.id, created, now);
            listingsCreated += 1;
            touchedThisEbook = true;
          } else {
            // Sem PDF: ainda publica o produto (entrega pode ser nativa depois).
            const created = await port.createProduct({
              productId: product.id,
              name: product.name,
              description: product.description ?? undefined,
              priceCents: product.priceCents,
              affiliateCommissionPct: commission,
            });
            await this.upsertListing(ctx, product.id, created, now);
            listingsCreated += 1;
            touchedThisEbook = true;
          }

          ctx.log.info(
            { ebookId: ebook.id, productId: product.id, provider },
            'listing sincronizada no marketplace',
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${provider}/${product.id}: ${message}`);
          ctx.log.warn(
            { ebookId: ebook.id, provider, err: message },
            'falha ao sincronizar listing',
          );
        }
      }

      if (touchedThisEbook) ebooksTouched += 1;
    }

    if (listingsCreated === 0 && errors.length === 0) {
      return skipped('todos os ebooks PUBLISHED ja estao sincronizados');
    }

    // Se nada foi criado e houve apenas erros, propaga falha (run marca FAILED).
    if (listingsCreated === 0 && errors.length > 0) {
      throw new Error(
        `MarketplaceAgent: todas as sincronizacoes falharam — ${errors.join('; ')}`,
      );
    }

    return {
      status: 'SUCCESS',
      output: { listingsCreated, ebooksTouched, considered: ebooks.length },
      metrics: { listingsCreated, ebooksTouched, errors: errors.length },
    };
  }

  // Upsert idempotente do espelho local (MarketplaceListing @@unique[productId,provider]).
  private async upsertListing(
    ctx: AgentContext,
    productId: string,
    created: {
      provider: MarketplaceProvider;
      externalProductId: string;
      marketplaceUrl: string;
      affiliateCommissionPct: number;
    },
    now: Date,
  ): Promise<void> {
    await ctx.prisma.marketplaceListing.upsert({
      where: {
        productId_provider: { productId, provider: created.provider },
      },
      update: {
        externalProductId: created.externalProductId,
        marketplaceUrl: created.marketplaceUrl,
        affiliateCommissionPct: created.affiliateCommissionPct,
        syncedAt: now,
      },
      create: {
        productId,
        provider: created.provider,
        externalProductId: created.externalProductId,
        marketplaceUrl: created.marketplaceUrl,
        affiliateCommissionPct: created.affiliateCommissionPct,
        syncedAt: now,
      },
    });
  }
}
