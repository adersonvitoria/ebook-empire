// Composicao da landing de conversao a partir de um StorefrontFeatured ja
// resolvido (server-side). Server Component puro: orquestra as secoes estaticas
// (offer-hero) + insere os componentes 'use client' (checkout-form, sales-chat)
// nos pontos certos do funil. Reusado por /oferta (featured) e /oferta/[slug].

import type { StorefrontFeatured } from '@/lib/storefront';
import {
  OfferHero,
  OfferPain,
  OfferInside,
  OfferProof,
  OfferFaq,
  OfferFooter,
} from '@/components/offer-hero';
import { CheckoutForm } from '@/components/checkout-form';
import { SalesChat } from '@/components/sales-chat';

const ACCENT = '#c2410c';

export function OfferPage({ offer }: { offer: StorefrontFeatured }) {
  return (
    <div className="min-h-full">
      <OfferHero offer={offer} />
      <OfferPain offer={offer} />
      <OfferInside offer={offer} />
      <OfferProof offer={offer} />

      {/* Oferta / preco + checkout inline (#checkout) */}
      <section id="checkout" className="scroll-mt-6 bg-[#f7f3ec] py-20">
        <div className="mx-auto grid max-w-6xl items-start gap-12 px-5 sm:px-8 lg:grid-cols-[1fr_0.95fr]">
          <div>
            <span
              className="text-xs font-semibold uppercase tracking-[0.22em]"
              style={{ color: ACCENT }}
            >
              A oferta
            </span>
            <h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-[#241c12] sm:text-4xl">
              {offer.product.name}
            </h2>
            <p className="mt-4 max-w-md text-lg leading-relaxed text-[#5b4f3e]">
              Acesso imediato por{' '}
              <span className="font-bold text-[#241c12]">
                {offer.product.priceFormatted}
              </span>
              . Menos do que voce gasta em um almoco — e fica com voce para
              sempre.
            </p>

            <ul className="mt-8 space-y-3">
              {[
                'Pagamento unico via PIX, aprovacao em segundos',
                'PDF entregue automaticamente no seu email',
                '7 dias de garantia — risco zero',
              ].map((item) => (
                <li key={item} className="flex items-center gap-3 text-[15px] text-[#4f4434]">
                  <span
                    className="flex h-5 w-5 items-center justify-center rounded-full text-white"
                    style={{ backgroundColor: ACCENT }}
                    aria-hidden="true"
                  >
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none">
                      <path
                        d="M4 10.5l4 4 8-9"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <CheckoutForm
            productSlug={offer.product.slug}
            priceCents={offer.product.priceCents}
          />
        </div>
      </section>

      <OfferFaq offer={offer} />
      <OfferFooter />

      {/* Chat de vendas 24/7 (flutuante, client) ancorado no produto */}
      <SalesChat
        productSlug={offer.product.slug}
        productName={offer.product.name}
      />
    </div>
  );
}
