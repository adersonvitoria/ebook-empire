// Layout raiz do dashboard interno. Server Component que monta a navegacao
// lateral e envolve as pages nos Providers (TanStack Query).
// As pages (Overview/Ebooks/Orders/Social/Ads/Agents) sao criadas por
// outros agentes; este layout apenas as enquadra.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';
import { Providers } from './providers';
import { AuthBar } from '@/components/auth-bar';

export const metadata: Metadata = {
  title: 'Ebook Empire — Painel',
  description: 'Dashboard interno da empresa autonoma multi-agente.',
};

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/', label: 'Overview' },
  { href: '/ebooks', label: 'Ebooks' },
  { href: '/orders', label: 'Orders' },
  { href: '/social', label: 'Social' },
  { href: '/ads', label: 'Ads' },
  { href: '/agents', label: 'Agents' },
  { href: '/crm', label: 'CRM' },
  { href: '/crm/teams', label: 'Times' },
  { href: '/crm/market', label: 'Mercado' },
  { href: '/crm/quality', label: 'Qualidade' },
  { href: '/crm/finance', label: 'Financeiro' },
  { href: '/crm/alerts', label: 'Alertas' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <Providers>
          <div className="flex min-h-screen">
            <aside className="w-60 shrink-0 border-r border-neutral-800 bg-neutral-900/60 p-4">
              <div className="mb-8 px-2">
                <span className="text-lg font-semibold tracking-tight text-brand-fg">
                  Ebook Empire
                </span>
                <p className="mt-1 text-xs text-neutral-500">Painel interno</p>
              </div>
              <nav className="space-y-1">
                {NAV_ITEMS.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="block rounded-md px-3 py-2 text-sm text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-white"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </aside>

            <div className="flex flex-1 flex-col">
              <AuthBar />
              <main className="flex-1 p-8">{children}</main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
