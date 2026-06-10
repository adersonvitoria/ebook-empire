'use client';

// Sub-navegacao do modulo CRM, compartilhada entre as pages do Command Center.
// Mora em arquivo proprio (NAO em page.tsx) porque o Next.js App Router so
// permite exports especificos num page.tsx — exportar um componente de la
// quebra o build ("not a valid Page export field").

import Link from 'next/link';

export function CrmTabs({ active }: { active: string }) {
  const tabs = [
    { href: '/crm', label: 'Visao geral' },
    { href: '/crm/problems', label: 'Problemas' },
    { href: '/crm/actions', label: 'Acoes' },
    { href: '/crm/approvals', label: 'Aprovacoes' },
    { href: '/crm/settings', label: 'Guardrails' },
  ];
  return (
    <nav className="mb-6 flex flex-wrap gap-1 border-b border-neutral-800">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
            t.href === active
              ? 'border-brand text-white'
              : 'border-transparent text-neutral-400 hover:text-neutral-200'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
