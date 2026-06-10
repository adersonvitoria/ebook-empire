'use client';

// Financeiro consolidado (Feature 2) — DRE do dia, composicao receita-vs-custos,
// margem por ebook e por campanha (com ROAS) e medidor de progresso da meta
// diaria. Consome GET /finance/overview, /by-ebook e /by-campaign. Trata 404
// (rota aquecendo) e API fora do ar de forma graciosa.

import { useQuery } from '@tanstack/react-query';
import {
  api,
  ApiError,
  formatBRL,
  formatPct,
  formatRoas,
  type DreResult,
  type EbookBreakdownResult,
  type CampaignBreakdownResult,
} from '@/lib/api';

// ------------------------------------------------------------
// Cards de DRE (rotulo + valor monetario, com tom opcional).
// ------------------------------------------------------------
function MoneyCard({
  label,
  cents,
  tone,
  hint,
}: {
  label: string;
  cents: number;
  tone?: 'cost' | 'revenue' | 'profit-pos' | 'profit-neg';
  hint?: string;
}) {
  const color =
    tone === 'revenue'
      ? 'text-emerald-400'
      : tone === 'cost'
        ? 'text-amber-400'
        : tone === 'profit-pos'
          ? 'text-emerald-400'
          : tone === 'profit-neg'
            ? 'text-red-400'
            : 'text-white';
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${color}`}>{formatBRL(cents)}</p>
      {hint ? <p className="mt-1 text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

// ------------------------------------------------------------
// Composicao receita-vs-custos: barra empilhada (taxas + ads + LLM + lucro)
// proporcional a receita bruta. Quando ha prejuizo, mostra a barra de custos.
// ------------------------------------------------------------
function CompositionBar({ dre }: { dre: DreResult }) {
  const gross = dre.grossRevenueCents;
  const segments = [
    { label: 'Taxas', cents: dre.paymentFeesCents, cls: 'bg-rose-500' },
    { label: 'Ads', cents: dre.adSpendCents, cls: 'bg-amber-500' },
    { label: 'LLM', cents: dre.llmCostCents, cls: 'bg-sky-500' },
    {
      label: dre.netProfitCents >= 0 ? 'Lucro' : 'Prejuizo',
      cents: Math.abs(dre.netProfitCents),
      cls: dre.netProfitCents >= 0 ? 'bg-emerald-500' : 'bg-red-600',
    },
  ];
  // Base de proporcao: receita bruta (ou soma dos segmentos se receita 0).
  const total =
    gross > 0 ? gross : segments.reduce((acc, s) => acc + s.cents, 0) || 1;

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
      <p className="text-sm font-semibold text-white">Composicao da receita</p>
      <p className="mt-0.5 text-xs text-neutral-500">
        Receita bruta {formatBRL(gross)} — para onde foi o dinheiro do dia.
      </p>
      <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-neutral-800">
        {segments.map((s) => (
          <div
            key={s.label}
            className={s.cls}
            style={{ width: `${Math.max(0, (s.cents / total) * 100)}%` }}
            title={`${s.label}: ${formatBRL(s.cents)}`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-4">
        {segments.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5 text-xs text-neutral-300">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.cls}`} />
            {s.label} · {formatBRL(s.cents)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Medidor de progresso da meta diaria + projecao.
// ------------------------------------------------------------
function GoalMeter({ dre }: { dre: DreResult }) {
  const { meta } = dre;
  const pct = Math.max(0, Math.min(100, meta.progressPct));
  const barCls = meta.metTarget ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-sky-500';
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-semibold text-white">Meta diaria</p>
        <span className="text-xs text-neutral-400">
          {formatBRL(dre.grossRevenueCents)} / {formatBRL(meta.targetRevenueCents)}
        </span>
      </div>
      <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-neutral-800">
        <div className={`h-full rounded-full transition-all ${barCls}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className={meta.metTarget ? 'text-emerald-400' : 'text-neutral-400'}>
          {meta.progressPct}% da meta {meta.metTarget ? '— atingida ✓' : ''}
        </span>
        <span className="text-neutral-400">
          Projecao: {formatBRL(meta.projectedRevenueCents)}{' '}
          <span className={meta.projectedMetTarget ? 'text-emerald-400' : 'text-amber-400'}>
            ({meta.projectedMetTarget ? 'deve bater' : 'abaixo'})
          </span>
        </span>
      </div>
      {meta.isPartial ? (
        <p className="mt-2 text-xs text-neutral-500">
          Dia em curso — valores parciais; a projecao extrapola o ritmo atual.
        </p>
      ) : null}
    </div>
  );
}

function MarginPill({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-neutral-500">—</span>;
  const tone = pct >= 50 ? 'text-emerald-400' : pct >= 0 ? 'text-amber-400' : 'text-red-400';
  return <span className={tone}>{formatPct(pct)}</span>;
}

// ------------------------------------------------------------
// Tabela: margem por ebook.
// ------------------------------------------------------------
function EbookTable({ data }: { data: EbookBreakdownResult | undefined }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white">Margem por ebook</p>
        {data && data.unattributedAdSpendCents > 0 ? (
          <span className="text-xs text-neutral-500">
            Ads sem atribuicao: {formatBRL(data.unattributedAdSpendCents)}
          </span>
        ) : null}
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="py-2 pr-3 font-medium">Ebook</th>
              <th className="py-2 pr-3 text-right font-medium">Pedidos</th>
              <th className="py-2 pr-3 text-right font-medium">Receita</th>
              <th className="py-2 pr-3 text-right font-medium">Taxas</th>
              <th className="py-2 pr-3 text-right font-medium">Ads</th>
              <th className="py-2 pr-3 text-right font-medium">Lucro</th>
              <th className="py-2 text-right font-medium">Margem</th>
            </tr>
          </thead>
          <tbody>
            {(data?.ebooks ?? []).map((e) => (
              <tr key={e.ebookId} className="border-b border-neutral-800/60">
                <td className="py-2 pr-3 text-neutral-200">{e.title}</td>
                <td className="py-2 pr-3 text-right text-neutral-300">{e.orders}</td>
                <td className="py-2 pr-3 text-right text-neutral-300">{formatBRL(e.revenueCents)}</td>
                <td className="py-2 pr-3 text-right text-neutral-400">{formatBRL(e.paymentFeesCents)}</td>
                <td className="py-2 pr-3 text-right text-neutral-400">
                  {formatBRL(e.adSpendAttributedCents)}
                </td>
                <td
                  className={`py-2 pr-3 text-right ${
                    e.netProfitCents >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {formatBRL(e.netProfitCents)}
                </td>
                <td className="py-2 text-right">
                  <MarginPill pct={e.marginPct} />
                </td>
              </tr>
            ))}
            {data && data.ebooks.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-sm text-neutral-500">
                  Nenhum pedido pago atribuido a ebooks no periodo.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Tabela: margem por campanha (com ROAS) + linha de organico.
// ------------------------------------------------------------
function CampaignTable({ data }: { data: CampaignBreakdownResult | undefined }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
      <p className="text-sm font-semibold text-white">Margem por campanha</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="py-2 pr-3 font-medium">Campanha</th>
              <th className="py-2 pr-3 text-right font-medium">Spend</th>
              <th className="py-2 pr-3 text-right font-medium">Receita</th>
              <th className="py-2 pr-3 text-right font-medium">ROAS</th>
              <th className="py-2 text-right font-medium">Lucro</th>
            </tr>
          </thead>
          <tbody>
            {(data?.campaigns ?? []).map((c) => (
              <tr key={c.campaignId} className="border-b border-neutral-800/60">
                <td className="py-2 pr-3 text-neutral-200">{c.name}</td>
                <td className="py-2 pr-3 text-right text-neutral-400">{formatBRL(c.spendCents)}</td>
                <td className="py-2 pr-3 text-right text-neutral-300">{formatBRL(c.revenueCents)}</td>
                <td
                  className={`py-2 pr-3 text-right ${
                    c.roas !== null && c.roas >= 1 ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  {formatRoas(c.roas)}
                </td>
                <td
                  className={`py-2 text-right ${
                    c.netProfitCents >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {formatBRL(c.netProfitCents)}
                </td>
              </tr>
            ))}
            {data ? (
              <tr className="border-b border-neutral-800/60 text-neutral-400">
                <td className="py-2 pr-3 italic">Organico (sem campanha)</td>
                <td className="py-2 pr-3 text-right">—</td>
                <td className="py-2 pr-3 text-right">{formatBRL(data.organic.revenueCents)}</td>
                <td className="py-2 pr-3 text-right">—</td>
                <td className="py-2 text-right">{data.organic.orders} pedidos</td>
              </tr>
            ) : null}
            {data && data.campaigns.length === 0 && data.organic.orders === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 text-center text-sm text-neutral-500">
                  Nenhuma campanha ou receita no periodo.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function FinancePage() {
  const overview = useQuery({
    queryKey: ['finance', 'overview'],
    queryFn: ({ signal }) => api.financeOverview(signal),
    retry: false,
    refetchInterval: 60_000,
  });
  const byEbook = useQuery({
    queryKey: ['finance', 'by-ebook'],
    queryFn: ({ signal }) => api.financeByEbook(undefined, signal),
    retry: false,
  });
  const byCampaign = useQuery({
    queryKey: ['finance', 'by-campaign'],
    queryFn: ({ signal }) => api.financeByCampaign(undefined, signal),
    retry: false,
  });

  const dre = overview.data;
  const missing = overview.error instanceof ApiError && overview.error.status === 404;
  const offline =
    overview.isError &&
    !missing &&
    overview.error instanceof ApiError &&
    overview.error.status === 0;

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Financeiro consolidado</h1>
        <p className="mt-1 text-sm text-neutral-400">
          DRE do dia (fuso America/Sao_Paulo), margem por ebook e campanha e progresso da meta
          diaria. Visao contabil — desconta taxas de pagamento, ao contrario do KPI operacional.
        </p>
      </header>

      {overview.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando financeiro do dia…</p>
      ) : missing ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-4 text-sm text-neutral-400">
          O endpoint <code className="text-neutral-300">/finance/overview</code> ainda esta
          aquecendo. Assim que houver pedidos e custos no dia, a DRE aparece aqui.
        </div>
      ) : overview.isError ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          Nao foi possivel carregar o financeiro.{' '}
          {offline ? 'Verifique se a API esta no ar.' : null}
          <p className="mt-2 text-xs text-neutral-500">
            {overview.error instanceof Error ? overview.error.message : null}
          </p>
        </div>
      ) : dre ? (
        <div className="space-y-6">
          <p className="text-xs text-neutral-500">Dia de referencia: {dre.date}</p>

          {/* Cards de DRE */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <MoneyCard label="Receita bruta" cents={dre.grossRevenueCents} tone="revenue" />
            <MoneyCard label="Taxas de pagamento" cents={dre.paymentFeesCents} tone="cost" />
            <MoneyCard label="Custo de ads" cents={dre.adSpendCents} tone="cost" />
            <MoneyCard label="Custo de LLM" cents={dre.llmCostCents} tone="cost" />
            <MoneyCard
              label="Lucro liquido"
              cents={dre.netProfitCents}
              tone={dre.netProfitCents >= 0 ? 'profit-pos' : 'profit-neg'}
            />
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Margem liquida
              </p>
              <p className="mt-2 text-2xl font-semibold">
                <MarginPill pct={dre.marginPct} />
              </p>
              <p className="mt-1 text-xs text-neutral-500">{dre.paidOrders} pedidos pagos</p>
            </div>
          </div>

          {/* Composicao + meta */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CompositionBar dre={dre} />
            <GoalMeter dre={dre} />
          </div>

          {/* Tabelas de margem */}
          <EbookTable data={byEbook.data} />
          <CampaignTable data={byCampaign.data} />
        </div>
      ) : null}
    </div>
  );
}
