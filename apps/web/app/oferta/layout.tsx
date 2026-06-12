// Layout PUBLICO da vitrine (/oferta e /oferta/[slug]). Server Component.
//
// Contexto de roteamento: o layout RAIZ (app/layout.tsx, dono = Fundacao) injeta
// o chrome admin (sidebar de nav + AuthBar) em TODAS as rotas e ja renderiza
// <html>/<body>. Um layout aninhado NAO pode renderizar <html>/<body> de novo,
// entao este wrapper cobre o chrome admin com um container full-viewport fixo
// (fallback documentado em docs/STOREFRONT.md secao 3): a landing publica fica
// por cima, sem vazar a nav admin e SEM exigir login (nada de Providers/Auth).
//
// Tipografia editorial (distinta do admin dark): serifa de display + sans de
// corpo via next/font (build-time, sem <link> em <head> aninhado). As CSS vars
// --font-display / --font-body sao consumidas pelas classes utilitarias da
// landing (ver classes font-[var(--font-...)] nos componentes).

import type { ReactNode } from 'react';
import { Fraunces, Manrope } from 'next/font/google';

// Serifa editorial com personalidade para H1/headline.
const display = Fraunces({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '900'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-display',
});

// Sans limpa e legivel para corpo/UI.
const body = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-body',
});

export default function OfertaLayout({ children }: { children: ReactNode }) {
  return (
    // Container full-viewport por cima do chrome admin (sem padding herdado do
    // <main> admin). Tema claro/quente proprio da vitrine — distinto do admin dark.
    // As CSS vars de fonte ficam no wrapper; os componentes da landing definem
    // cores/secoes. color-scheme:light reseta o color-scheme:dark global.
    <div
      className={`${display.variable} ${body.variable} fixed inset-0 z-50 overflow-y-auto bg-[#f7f3ec] font-[family-name:var(--font-body)] text-[#2a2118] [color-scheme:light]`}
    >
      {children}
    </div>
  );
}
