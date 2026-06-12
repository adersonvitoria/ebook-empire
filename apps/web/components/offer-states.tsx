// Estados de borda da landing (sem oferta / erro). Server Components de alta
// qualidade (nao erro cru). O botao "Tentar novamente" precisa de interatividade
// minima -> client component dedicado (RetryButton). Render por page.tsx quando
// a busca server-side de /storefront/featured ou /products/:slug falha.

import { PixSeal } from '@/components/offer-hero';
import { RetryButton } from '@/components/retry-button';

const ACCENT = '#c2410c';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-5 py-20">
      <div className="w-full max-w-md text-center">{children}</div>
    </div>
  );
}

/** 404 no_featured_product / product_not_found -> "Em breve" (nao erro cru). */
export function OfferComingSoon({ specific = false }: { specific?: boolean }) {
  return (
    <Shell>
      <PixSeal className="mx-auto h-14 w-14" />
      <h1 className="mt-6 font-[family-name:var(--font-display)] text-3xl font-bold text-[#241c12]">
        {specific ? 'Oferta indisponivel' : 'Em breve'}
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-[#5b4f3e]">
        {specific
          ? 'Este produto nao esta disponivel no momento. Volte em instantes — estamos sempre lancando novidades.'
          : 'Estamos preparando algo especial para voce. Nossa proxima oferta esta quase pronta — volte logo.'}
      </p>
      <a
        href="/oferta"
        className="mt-8 inline-flex items-center justify-center rounded-full px-6 py-3 text-sm font-bold text-white transition-transform hover:-translate-y-0.5"
        style={{ backgroundColor: ACCENT }}
      >
        Ver a oferta em destaque
      </a>
    </Shell>
  );
}

/** Erro de rede / 5xx -> card honesto + retry. */
export function OfferError() {
  return (
    <Shell>
      <span
        className="mx-auto flex h-14 w-14 items-center justify-center rounded-full text-white"
        style={{ backgroundColor: ACCENT }}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none">
          <path
            d="M12 8v5M12 16.5h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <h1 className="mt-6 font-[family-name:var(--font-display)] text-3xl font-bold text-[#241c12]">
        Nao foi possivel carregar a oferta agora
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-[#5b4f3e]">
        Tivemos um problema temporario ao buscar a oferta. Verifique sua conexao
        e tente novamente.
      </p>
      <div className="mt-8">
        <RetryButton />
      </div>
    </Shell>
  );
}
