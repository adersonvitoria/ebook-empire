// /oferta/[slug] — mesma landing de conversao para um produto especifico.
// Server Component: busca GET /storefront/products/:slug no servidor e despacha
// para OfferPage / OfferComingSoon(specific) / OfferError. So exporta default +
// generateMetadata + dynamic (regra de build do Next standalone).

import type { Metadata } from 'next';
import { ApiError } from '@/lib/api';
import { getProductOffer, type StorefrontFeatured } from '@/lib/storefront';
import { OfferPage } from '@/components/offer-page';
import { OfferComingSoon, OfferError } from '@/components/offer-states';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { slug: string };
}

async function loadOffer(
  slug: string,
): Promise<
  | { kind: 'ok'; offer: StorefrontFeatured }
  | { kind: 'not-found' }
  | { kind: 'error' }
> {
  try {
    const offer = await getProductOffer(slug);
    return { kind: 'ok', offer };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return { kind: 'not-found' };
    }
    return { kind: 'error' };
  }
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  try {
    const offer = await getProductOffer(params.slug);
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
      title: 'Oferta',
      description: 'Ebooks praticos com entrega imediata por email via PIX.',
    };
  }
}

export default async function OfertaSlugPage({ params }: PageProps) {
  const result = await loadOffer(params.slug);
  if (result.kind === 'ok') return <OfferPage offer={result.offer} />;
  if (result.kind === 'not-found') return <OfferComingSoon specific />;
  return <OfferError />;
}
