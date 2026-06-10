'use client';

// Ads — campanhas e insights (TrafficAgent sobre Meta Marketing API).
// Consome GET /ads. Calcula ROAS por campanha quando a API anexa insights.

import { useQuery } from '@tanstack/react-query';
import {
  api,
  ApiError,
  formatBRL,
  formatNumber,
  formatRoas,
  type AdCampaign,
  type AdStatus,
} from '@/lib/api';

const STATUS_STYLES: Record<AdStatus, string> = {
  DRAFT: 'bg-neutral-700/40 text-neutral-300',
  ACTIVE: 'bg-emerald-500/20 text-emerald-300',
  PAUSED: 'bg-amber-500/20 text-amber-300',
  COMPLETED: 'bg-sky-500/20 text-sky-300',
  ARCHIVED: 'bg-neutral-800 text-neutral-500',
};

function StatusBadge({ status }: { status: AdStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

// Agrega insights de uma campanha em totais para exibir ROAS/CPA.
function aggregate(campaign: AdCampaign) {
  const rows = campaign.insights ?? [];
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const conversions = rows.reduce((s, r) => s + r.conversions, 0);
  const revenueCents = rows.reduce((s, r) => s + r.revenueCents, 0);
  // spend vem do agregado da campanha (totalSpendCents) quando nao ha linhas.
  const spendCents =
    rows.length > 0
      ? rows.reduce((s, r) => s + r.spendCents, 0)
      : campaign.totalSpendCents;
  const roas = spendCents > 0 ? revenueCents / spendCents : undefined;
  return { impressions, clicks, conversions, revenueCents, spendCents, roas };
}

export default function AdsPage() {
  const adsQuery = useQuery({
    queryKey: ['ads', 'list'],
    queryFn: ({ signal }) => api.listAdCampaigns({ limit: 100 }, signal),
    retry: false,
  });

  const campaigns = adsQuery.data?.data ?? [];
  const listMissing =
    adsQuery.error instanceof ApiError && adsQuery.error.status === 404;

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Ads</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Campanhas de trafego pago e seus insights (TrafficAgent).
        </p>
      </header>

      {adsQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando campanhas…</p>
      ) : adsQuery.isError ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          {listMissing
            ? 'Rota /ads ainda nao implementada.'
            : 'Nao foi possivel carregar as campanhas. Verifique se a API esta no ar.'}
        </div>
      ) : campaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Nenhuma campanha ainda.
        </div>
      ) : (
        <div className="space-y-4">
          {campaigns.map((campaign: AdCampaign) => {
            const agg = aggregate(campaign);
            return (
              <article
                key={campaign.id}
                className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5"
              >
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-white">
                      {campaign.name}
                    </h2>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {campaign.objective} · {campaign.platform}
                      {campaign.utmCampaign ? ` · utm: ${campaign.utmCampaign}` : ''}
                    </p>
                  </div>
                  <StatusBadge status={campaign.status} />
                </div>

                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                  <Metric label="Orcamento/dia" value={formatBRL(campaign.dailyBudgetCents)} />
                  <Metric label="Gasto total" value={formatBRL(agg.spendCents)} />
                  <Metric label="Impressoes" value={formatNumber(agg.impressions)} />
                  <Metric label="Cliques" value={formatNumber(agg.clicks)} />
                  <Metric label="Conversoes" value={formatNumber(agg.conversions)} />
                  <Metric label="ROAS" value={formatRoas(agg.roas)} highlight />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      <p
        className={`mt-1 text-sm font-semibold ${
          highlight ? 'text-emerald-400' : 'text-white'
        }`}
      >
        {value}
      </p>
    </div>
  );
}
