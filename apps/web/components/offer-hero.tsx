// Secoes ESTATICAS da landing de conversao (/oferta). Server Components puros:
// recebem o StorefrontFeatured (derivado server-side dos campos REAIS) e apenas
// renderizam. Toda UI interativa (checkout, chat) vive em arquivos 'use client'
// proprios (checkout-form.tsx, sales-chat.tsx) — esta regra mantem o `next build`
// (standalone) verde.
//
// Estilo: editorial warm-luxe (papel off-white, accent terracota/ambar, serifa
// de display Fraunces no headline + sans Manrope no corpo, selo PIX assinatura).
// Honestidade (docs/STOREFRONT.md §0): nada de contadores/depoimentos inventados;
// preco real, sem preco-fantasma riscado; copy 100% derivada dos campos reais.

import type { StorefrontFeatured } from '@/lib/storefront';

const ACCENT = '#c2410c'; // terracota queimado — accent unico da vitrine

// ------------------------------------------------------------
// Selo PIX assinatura (SVG inline) — elemento grafico de marca, reaproveitavel.
// ------------------------------------------------------------
function PixSeal({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden="true"
      className={className}
      fill="none"
    >
      <rect
        x="6"
        y="6"
        width="36"
        height="36"
        rx="10"
        transform="rotate(45 24 24)"
        stroke={ACCENT}
        strokeWidth="2"
      />
      <path
        d="M24 14l4.5 4.5a4 4 0 005.66 0L36 16.66M24 34l-4.5-4.5a4 4 0 00-5.66 0L12 31.34M14 24l4.5-4.5a4 4 0 000-5.66M34 24l-4.5 4.5a4 4 0 000 5.66"
        stroke={ACCENT}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ------------------------------------------------------------
// HERO (acima da dobra): eyebrow(niche) + H1 headline + subheadline + badge de
// entrega + CTA PIX (ancora #checkout) + selo de preco.
// ------------------------------------------------------------
export function OfferHero({ offer }: { offer: StorefrontFeatured }) {
  const { copy, ebook, product } = offer;
  return (
    <header className="relative overflow-hidden">
      {/* atmosfera de fundo: gradiente quente + textura sutil de grade */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(120% 90% at 80% -10%, rgba(194,65,12,0.10), transparent 55%), radial-gradient(80% 60% at 0% 10%, rgba(180,140,80,0.10), transparent 60%)',
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.04]"
        style={{
          backgroundImage:
            'linear-gradient(#2a2118 1px, transparent 1px), linear-gradient(90deg, #2a2118 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />

      <div className="mx-auto grid max-w-6xl gap-12 px-5 pb-16 pt-12 sm:px-8 sm:pt-20 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:gap-16">
        {/* coluna de copy */}
        <div>
          <span
            className="inline-flex items-center gap-2 rounded-full border border-[#e2d6c2] bg-white/60 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[#8a6a3a] backdrop-blur"
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: ACCENT }}
            />
            {ebook.niche}
          </span>

          <h1 className="mt-6 font-[family-name:var(--font-display)] text-4xl font-black leading-[1.04] tracking-[-0.02em] text-[#241c12] sm:text-5xl lg:text-6xl">
            {copy.headline}
          </h1>

          {copy.subheadline ? (
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-[#5b4f3e]">
              {copy.subheadline}
            </p>
          ) : null}

          <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center">
            <a
              href="#checkout"
              className="group inline-flex items-center justify-center gap-2 rounded-full px-7 py-4 text-base font-bold text-white shadow-[0_10px_30px_-8px_rgba(194,65,12,0.6)] transition-transform duration-200 hover:-translate-y-0.5"
              style={{ backgroundColor: ACCENT }}
            >
              Comprar agora via PIX
              <span className="transition-transform duration-200 group-hover:translate-x-1">
                →
              </span>
            </a>
            <div className="flex items-baseline gap-2">
              <span className="font-[family-name:var(--font-display)] text-3xl font-bold text-[#241c12]">
                {product.priceFormatted}
              </span>
              <span className="text-sm text-[#8a7a63]">pagamento unico</span>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-[#6b5d48]">
            <span className="inline-flex items-center gap-2">
              <DotIcon /> Entrega imediata por email
            </span>
            <span className="inline-flex items-center gap-2">
              <DotIcon /> PIX seguro via Asaas
            </span>
            <span className="inline-flex items-center gap-2">
              <DotIcon /> Formato PDF · pt-BR
            </span>
          </div>
        </div>

        {/* coluna do "objeto" — capa estilizada ou capa real */}
        <div className="relative mx-auto w-full max-w-sm">
          <div
            className="absolute -inset-4 -z-10 rounded-[2rem] opacity-60 blur-2xl"
            style={{
              background:
                'conic-gradient(from 140deg, rgba(194,65,12,0.25), rgba(180,140,80,0.18), rgba(194,65,12,0.25))',
            }}
            aria-hidden="true"
          />
          <div className="relative aspect-[3/4] overflow-hidden rounded-2xl border border-[#e7dcc7] bg-gradient-to-br from-[#fffdf8] to-[#f0e6d4] shadow-[0_30px_60px_-20px_rgba(60,40,20,0.35)]">
            {ebook.coverImagePath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={ebook.coverImagePath}
                alt={`Capa do ebook ${ebook.title}`}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full flex-col justify-between p-7">
                <span className="text-xs font-semibold uppercase tracking-[0.2em] text-[#a88a5a]">
                  Ebook · {ebook.language?.toLowerCase() === 'pt-br' ? 'pt-BR' : ebook.language}
                </span>
                <div>
                  <PixSeal className="mb-5 h-10 w-10" />
                  <h2 className="font-[family-name:var(--font-display)] text-2xl font-bold leading-tight text-[#2a2014]">
                    {ebook.title}
                  </h2>
                  {ebook.subtitle ? (
                    <p className="mt-3 text-sm text-[#6b5b44]">{ebook.subtitle}</p>
                  ) : null}
                </div>
                <span className="text-xs font-medium uppercase tracking-wider text-[#b6a07c]">
                  {ebook.niche}
                </span>
              </div>
            )}
          </div>
          <div className="absolute -bottom-4 -right-3 flex items-center gap-2 rounded-full border border-[#e7dcc7] bg-white px-4 py-2 text-sm font-bold text-[#241c12] shadow-lg">
            <PixSeal className="h-5 w-5" />
            {product.priceFormatted}
          </div>
        </div>
      </div>
    </header>
  );
}

function DotIcon() {
  return (
    <span
      aria-hidden="true"
      className="h-1.5 w-1.5 rounded-full"
      style={{ backgroundColor: ACCENT }}
    />
  );
}

// ------------------------------------------------------------
// DOR -> SOLUCAO: cards derivados de copy.painPoints (de MarketOpportunity.angles;
// fallback honesto montado server-side). Sem painPoints, a secao nao renderiza.
// ------------------------------------------------------------
export function OfferPain({ offer }: { offer: StorefrontFeatured }) {
  const points = offer.copy.painPoints;
  if (!points.length) return null;
  return (
    <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
      <SectionLabel>Soa familiar?</SectionLabel>
      <h2 className="mt-3 max-w-2xl font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-[#241c12] sm:text-4xl">
        Voce ja tentou de tudo — aqui o caminho e outro.
      </h2>
      <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {points.slice(0, 6).map((p, i) => (
          <div
            key={i}
            className="group relative rounded-2xl border border-[#ece1cd] bg-white/70 p-6 transition-colors hover:border-[#dcb98e]"
          >
            <span
              className="font-[family-name:var(--font-display)] text-2xl font-bold italic"
              style={{ color: ACCENT }}
            >
              {String(i + 1).padStart(2, '0')}
            </span>
            <p className="mt-3 leading-relaxed text-[#4f4434]">{p}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------
// O QUE TEM DENTRO: capitulos de ebook.whatsInside (outline.chapters[].title).
// Vazio -> fallback honesto por niche (sem inventar numero de capitulos).
// ------------------------------------------------------------
export function OfferInside({ offer }: { offer: StorefrontFeatured }) {
  const { whatsInside, niche } = offer.ebook;
  const bullets = offer.copy.bullets;
  return (
    <section className="relative overflow-hidden bg-[#241c12] py-20 text-[#f3ece0]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 20% 30%, rgba(255,180,120,0.5), transparent 40%), radial-gradient(circle at 85% 70%, rgba(200,120,60,0.4), transparent 45%)',
        }}
      />
      <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
        <span className="text-xs font-semibold uppercase tracking-[0.22em] text-[#e09a5e]">
          O que tem dentro
        </span>
        <h2 className="mt-3 max-w-2xl font-[family-name:var(--font-display)] text-3xl font-bold leading-tight sm:text-4xl">
          Tudo o que voce recebe, em um unico PDF.
        </h2>

        {whatsInside.length ? (
          <ol className="mt-10 grid gap-x-10 gap-y-4 sm:grid-cols-2">
            {whatsInside.map((title, i) => (
              <li
                key={i}
                className="flex items-start gap-4 border-b border-white/10 pb-4"
              >
                <span
                  className="mt-0.5 font-[family-name:var(--font-display)] text-lg font-bold"
                  style={{ color: '#e09a5e' }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="text-[15px] leading-relaxed text-[#e7ddcd]">
                  {title}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-8 max-w-2xl text-lg leading-relaxed text-[#d7cbb6]">
            Um guia pratico e direto ao ponto sobre{' '}
            <span className="font-semibold text-white">{niche}</span>, escrito
            para voce aplicar do primeiro capitulo. Conteudo curado e revisado,
            sem enrolacao.
          </p>
        )}

        {bullets.length ? (
          <div className="mt-12 flex flex-wrap gap-3">
            {bullets.slice(0, 6).map((b, i) => (
              <span
                key={i}
                className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm text-[#ece3d3]"
              >
                {b}
              </span>
            ))}
          </div>
        ) : null}

        <p className="mt-12 text-sm text-[#b9ac96]">
          Formato PDF · idioma{' '}
          {offer.ebook.language?.toLowerCase() === 'pt-br'
            ? 'portugues (pt-BR)'
            : offer.ebook.language}{' '}
          · leia no celular, tablet ou computador.
        </p>
      </div>
    </section>
  );
}

// ------------------------------------------------------------
// PROVA HONESTA + GARANTIA: somente provas verdadeiras (sem numeros inventados).
// ------------------------------------------------------------
export function OfferProof({ offer }: { offer: StorefrontFeatured }) {
  const guarantee =
    offer.copy.guarantee ??
    'Garantia de 7 dias: se nao for para voce, devolvemos 100% do valor (direito de arrependimento, CDC art. 49).';
  const items = [
    {
      title: 'Entrega automatica',
      body: 'Assim que o PIX e confirmado, o PDF cai no seu email — sem espera, sem suporte manual.',
    },
    {
      title: 'Pagamento seguro',
      body: 'PIX processado via Asaas, com aprovacao em segundos. Voce paga pelo app do seu banco.',
    },
    {
      title: 'Conteudo curado + revisado',
      body: 'Material produzido com curadoria de IA e etapa de revisao (QA) antes de ir ao ar.',
    },
  ];
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
      <div className="grid gap-12 lg:grid-cols-[1fr_0.9fr] lg:items-center">
        <div>
          <SectionLabel>Por que confiar</SectionLabel>
          <h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-[#241c12] sm:text-4xl">
            Transparencia, do clique a entrega.
          </h2>
          <div className="mt-8 space-y-5">
            {items.map((it) => (
              <div key={it.title} className="flex gap-4">
                <CheckMark />
                <div>
                  <h3 className="font-semibold text-[#2c2417]">{it.title}</h3>
                  <p className="mt-1 text-[15px] leading-relaxed text-[#5b4f3e]">
                    {it.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* cartao de garantia assinatura */}
        <div className="relative rounded-3xl border-2 border-dashed border-[#dcb98e] bg-white/70 p-8 text-center">
          <PixSeal className="mx-auto h-12 w-12" />
          <p className="mt-4 font-[family-name:var(--font-display)] text-2xl font-bold text-[#241c12]">
            7 dias de garantia
          </p>
          <p className="mt-3 text-[15px] leading-relaxed text-[#5b4f3e]">
            {guarantee}
          </p>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------
// FAQ (estatico, honesto). 6 perguntas.
// ------------------------------------------------------------
export function OfferFaq({ offer }: { offer: StorefrontFeatured }) {
  const faqs = [
    {
      q: 'Como eu recebo o ebook?',
      a: `Apos a confirmacao do PIX, o PDF e enviado automaticamente para o email que voce informar no checkout. Em instantes ele chega — confira tambem a caixa de spam.`,
    },
    {
      q: 'O pagamento e seguro?',
      a: 'Sim. O PIX e gerado e processado via Asaas. Voce paga pelo app do seu proprio banco, lendo o QR Code ou colando o codigo copia-e-cola.',
    },
    {
      q: 'Preciso de cartao de credito?',
      a: 'Nao. O pagamento e 100% via PIX, com aprovacao em segundos.',
    },
    {
      q: 'E mesmo um PDF?',
      a: `Sim. ${offer.ebook.title} e entregue em PDF, para ler no celular, tablet ou computador.`,
    },
    {
      q: 'Posso pedir reembolso?',
      a: 'Pode. Voce tem 7 dias de garantia (direito de arrependimento, CDC art. 49). Se nao for para voce, devolvemos o valor.',
    },
    {
      q: 'Como falo com o suporte?',
      a: 'Use o chat aqui na pagina para tirar duvidas antes da compra. Apos a compra, responda ao email de entrega que falamos com voce.',
    },
  ];
  return (
    <section className="mx-auto max-w-3xl px-5 py-20 sm:px-8">
      <SectionLabel>Perguntas frequentes</SectionLabel>
      <h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-[#241c12] sm:text-4xl">
        Tudo o que voce quer saber antes de comprar.
      </h2>
      <div className="mt-10 divide-y divide-[#e6dac6]">
        {faqs.map((f) => (
          <details key={f.q} className="group py-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-[#2c2417]">
              {f.q}
              <span
                className="text-xl leading-none transition-transform duration-200 group-open:rotate-45"
                style={{ color: ACCENT }}
                aria-hidden="true"
              >
                +
              </span>
            </summary>
            <p className="mt-3 text-[15px] leading-relaxed text-[#5b4f3e]">
              {f.a}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------
// RODAPE minimal publico (sem nav admin).
// ------------------------------------------------------------
export function OfferFooter() {
  return (
    <footer className="border-t border-[#e6dac6] bg-[#f1eadd] px-5 py-10 text-sm text-[#8a7a63] sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 sm:flex-row">
        <div className="flex items-center gap-2 font-semibold text-[#5b4f3e]">
          <PixSeal className="h-5 w-5" />
          Ebook Empire
        </div>
        <p className="text-xs">
          Pagamento via PIX (Asaas) · Entrega digital por email · Garantia de 7
          dias (CDC art. 49).
        </p>
      </div>
    </footer>
  );
}

// ------------------------------------------------------------
// Auxiliares visuais compartilhados.
// ------------------------------------------------------------
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-xs font-semibold uppercase tracking-[0.22em]"
      style={{ color: ACCENT }}
    >
      {children}
    </span>
  );
}

function CheckMark() {
  return (
    <span
      className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white"
      style={{ backgroundColor: ACCENT }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
        <path
          d="M4 10.5l4 4 8-9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export { PixSeal };
