// /oferta — landing de conversao do produto FEATURED (maior potentialScore).
// Server Component: busca GET /storefront/featured no servidor (SEO/og-tags, sem
// flash) e despacha para OfferPage / OfferComingSoon / OfferError. So exporta
// default + generateMetadata + dynamic (regra de build do Next standalone).

import type { Metadata } from 'next';
import { ApiError } from '@/lib/api';
import { getFeatured, type StorefrontFeatured } from '@/lib/storefront';
import { OfferPage } from '@/components/offer-page';
import { OfferComingSoon, OfferError } from '@/components/offer-states';

// A oferta muda conforme o pipeline publica produtos — sempre fresca.
export const dynamic = 'force-dynamic';

async function loadFeatured(): Promise<
  | { kind: 'ok'; offer: StorefrontFeatured }
  | { kind: 'coming-soon' }
  | { kind: 'error' }
> {
  try {
    const offer = await getFeatured();
    return { kind: 'ok', offer };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return { kind: 'coming-soon' };
    }
    return { kind: 'error' };
  }
}

export async function generateMetadata(): Promise<Metadata> {
  try {
    const offer = await getFeatured();
    const title = offer.product.name;
    const description =
      offer.copy.subheadline ?? `${offer.ebook.title} — ebook em PDF, entrega por email via PIX.`;
    return {
      title,
      description,
      openGraph: {
        title,
        description,
        type: 'website',
        images: offer.ebook.coverImagePath
          ? [{ url: offer.ebook.coverImagePath }]
          : undefined,
      },
    };
  } catch {
    return {
      title: 'Oferta em destaque',
      description: 'Ebooks praticos com entrega imediata por email via PIX.',
    };
  }
}

export default async function OfertaPage() {
  const result = await loadFeatured();
  if (result.kind === 'ok') return <OfferPage offer={result.offer} />;
  if (result.kind === 'coming-soon') return <OfferComingSoon />;
  return <OfferError />;
}
