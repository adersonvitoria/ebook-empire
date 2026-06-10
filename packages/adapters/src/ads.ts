// AdsPort — trafego pago sobre a Meta Marketing API.
// Real: MetaAdsAdapter (Graph/Marketing API via fetch nativo do Node 20).
// Stub: StubAdsAdapter com numeros simulados realistas (CPM/CPC BR).
// Factory escolhe real<->stub por env (USE_STUBS).
//
// Convencao de unidade: dinheiro SEMPRE em Int centavos BRL.

import { nanoid } from 'nanoid';
import type {
  AdsPort,
  AdsCampaignStatus,
  AdsInsightRow,
  CreateAdCampaignInput,
  CreateAdCampaignResult,
  DateRange,
} from '@ebook-empire/core';

// ------------------------------------------------------------
// Config minima do adapter de ads (subconjunto do env validado).
// ------------------------------------------------------------
export interface AdsAdapterConfig {
  /** true => usa stub deterministico/simulado. */
  useStubs: boolean;
  /** Token da Graph/Marketing API (META_GRAPH_TOKEN). */
  metaGraphToken?: string;
  /** ID da conta de anuncios (act_XXXX) — META_AD_ACCOUNT_ID. */
  metaAdAccountId?: string;
  /** Versao da Graph API. */
  graphApiVersion?: string;
  /** Semente opcional para tornar o stub deterministico em testes. */
  stubSeed?: number;
}

const DEFAULT_GRAPH_VERSION = 'v21.0';

// ============================================================
// Real — Meta Marketing API
// ------------------------------------------------------------
// Fluxo: cria Campaign -> AdSet (com daily_budget) -> Ad. Esta implementacao
// cria a Campaign e o AdSet (onde mora o budget e os insights agregam) e
// guarda o adSetId no externalId composto "campaignId:adSetId" para que
// updateBudget/setStatus/getInsights saibam em qual node operar.
// ============================================================
export class MetaAdsAdapter implements AdsPort {
  private readonly token: string;
  private readonly accountId: string;
  private readonly version: string;

  constructor(token: string, accountId: string, version: string = DEFAULT_GRAPH_VERSION) {
    if (!token) throw new Error('MetaAdsAdapter: META_GRAPH_TOKEN ausente.');
    if (!accountId) throw new Error('MetaAdsAdapter: META_AD_ACCOUNT_ID ausente.');
    this.token = token;
    // Normaliza para o prefixo act_ exigido pela Marketing API.
    this.accountId = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
    this.version = version;
  }

  private base(path: string): string {
    return `https://graph.facebook.com/${this.version}/${path}`;
  }

  private async post(path: string, body: Record<string, string>): Promise<unknown> {
    const params = new URLSearchParams({ ...body, access_token: this.token });
    const res = await fetch(this.base(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Meta Ads falhou (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  }

  private async get(path: string, query: Record<string, string>): Promise<unknown> {
    const params = new URLSearchParams({ ...query, access_token: this.token });
    const res = await fetch(`${this.base(path)}?${params.toString()}`, { method: 'GET' });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Meta Ads falhou (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  }

  async createCampaign(input: CreateAdCampaignInput): Promise<CreateAdCampaignResult> {
    // 1) Campaign (objetivo de conversao/vendas).
    const campaign = (await this.post(`${this.accountId}/campaigns`, {
      name: input.name,
      objective: input.objective,
      status: 'PAUSED',
      special_ad_categories: '[]',
    })) as { id: string };

    // 2) AdSet — node que carrega daily_budget e onde os insights agregam.
    const adSet = (await this.post(`${this.accountId}/adsets`, {
      name: `${input.name} — adset`,
      campaign_id: campaign.id,
      daily_budget: String(input.dailyBudgetCents), // Meta usa a menor unidade da moeda (centavos).
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify(input.targeting ?? {}),
      status: 'PAUSED',
    })) as { id: string };

    // externalId composto: "campaignId:adSetId".
    return { externalId: `${campaign.id}:${adSet.id}` };
  }

  private splitIds(externalId: string): { campaignId: string; adSetId: string } {
    const [campaignId, adSetId] = externalId.split(':');
    return { campaignId: campaignId ?? externalId, adSetId: adSetId ?? externalId };
  }

  async updateBudget(externalId: string, dailyBudgetCents: number): Promise<void> {
    // SET absoluto no AdSet — idempotente, nao incrementa.
    const { adSetId } = this.splitIds(externalId);
    await this.post(adSetId, { daily_budget: String(dailyBudgetCents) });
  }

  async setStatus(externalId: string, status: AdsCampaignStatus): Promise<void> {
    // Aplica o status na Campaign (propaga aos AdSets/Ads).
    const { campaignId } = this.splitIds(externalId);
    await this.post(campaignId, { status });
  }

  async getInsights(externalId: string, range: DateRange): Promise<AdsInsightRow[]> {
    const { campaignId } = this.splitIds(externalId);
    const data = (await this.get(`${campaignId}/insights`, {
      time_range: JSON.stringify({ since: range.since, until: range.until }),
      time_increment: '1',
      fields: 'impressions,clicks,spend,actions',
    })) as { data?: MetaInsightRaw[] };

    return (data.data ?? []).map((row) => ({
      date: row.date_start,
      impressions: toInt(row.impressions),
      clicks: toInt(row.clicks),
      spendCents: brlToCents(row.spend),
      conversions: extractConversions(row.actions),
    }));
  }
}

interface MetaInsightRaw {
  date_start: string;
  impressions?: string;
  clicks?: string;
  spend?: string;
  actions?: Array<{ action_type: string; value: string }>;
}

function toInt(v: string | undefined): number {
  const n = Number.parseInt(v ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}

// "spend" vem em unidade BRL com casas decimais (ex. "12.34"). Converte p/ centavos.
function brlToCents(v: string | undefined): number {
  const n = Number.parseFloat(v ?? '0');
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function extractConversions(
  actions: Array<{ action_type: string; value: string }> | undefined,
): number {
  if (!actions) return 0;
  // Conta compras/conversoes offsite (ajuste por configuracao do pixel).
  const relevant = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'];
  return actions
    .filter((a) => relevant.includes(a.action_type))
    .reduce((sum, a) => sum + toInt(a.value), 0);
}

// ============================================================
// Stub — numeros simulados realistas (mercado BR).
// ------------------------------------------------------------
// Premissas BR (faixas tipicas de trafego frio de ebook/infoproduto):
//  - CPM ~ R$15 a R$35 (1500-3500 centavos por mil impressoes)
//  - CTR ~ 1.0% a 2.5%
//  - CR (clique -> compra) ~ 1.5% a 4%
// O stub e deterministico por (externalId + date) para testes estaveis.
// ============================================================
export class StubAdsAdapter implements AdsPort {
  /** Campanhas criadas (inspecionavel em testes). */
  readonly campaigns: Array<{
    externalId: string;
    input: CreateAdCampaignInput;
    dailyBudgetCents: number;
    status: AdsCampaignStatus;
  }> = [];

  private readonly seed: number;

  constructor(seed = 1) {
    this.seed = seed;
  }

  async createCampaign(input: CreateAdCampaignInput): Promise<CreateAdCampaignResult> {
    const externalId = `stub-camp-${nanoid(8)}`;
    this.campaigns.push({
      externalId,
      input,
      dailyBudgetCents: input.dailyBudgetCents,
      status: 'PAUSED',
    });
    return { externalId };
  }

  async updateBudget(externalId: string, dailyBudgetCents: number): Promise<void> {
    const camp = this.campaigns.find((c) => c.externalId === externalId);
    if (camp) camp.dailyBudgetCents = dailyBudgetCents;
  }

  async setStatus(externalId: string, status: AdsCampaignStatus): Promise<void> {
    const camp = this.campaigns.find((c) => c.externalId === externalId);
    if (camp) camp.status = status;
  }

  async getInsights(externalId: string, range: DateRange): Promise<AdsInsightRow[]> {
    const camp = this.campaigns.find((c) => c.externalId === externalId);
    // Budget diario base — define a escala de spend simulado.
    const dailyBudgetCents = camp?.dailyBudgetCents ?? 5000;
    const days = enumerateDays(range.since, range.until);
    return days.map((date) => this.simulateDay(externalId, date, dailyBudgetCents));
  }

  /** Gera um dia deterministico de insight a partir de (externalId+date+seed). */
  private simulateDay(externalId: string, date: string, dailyBudgetCents: number): AdsInsightRow {
    const rnd = makeRng(hashStr(`${externalId}|${date}|${this.seed}`));

    // CPM entre R$15 e R$35.
    const cpmCents = 1500 + Math.floor(rnd() * 2000);
    // Gasta entre 70% e 100% do budget diario.
    const spendCents = Math.round(dailyBudgetCents * (0.7 + rnd() * 0.3));
    // impressions = spend / CPM * 1000.
    const impressions = Math.max(1, Math.round((spendCents / cpmCents) * 1000));
    // CTR entre 1.0% e 2.5%.
    const ctr = 0.01 + rnd() * 0.015;
    const clicks = Math.max(0, Math.round(impressions * ctr));
    // CR (clique -> compra) entre 1.5% e 4%.
    const cr = 0.015 + rnd() * 0.025;
    const conversions = Math.max(0, Math.round(clicks * cr));

    return { date, impressions, clicks, spendCents, conversions };
  }
}

// ------------------------------------------------------------
// Helpers deterministicos do stub.
// ------------------------------------------------------------
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Mulberry32 — PRNG deterministico simples.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Enumera datas ISO (YYYY-MM-DD) inclusivas entre since e until (UTC). */
export function enumerateDays(since: string, until: string): string[] {
  const out: string[] = [];
  const start = new Date(`${since}T00:00:00.000Z`);
  const end = new Date(`${until}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return out;
  }
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ============================================================
// Factory — real <-> stub por env.
// ============================================================
export function createAdsAdapter(config: AdsAdapterConfig): AdsPort {
  if (config.useStubs) {
    return new StubAdsAdapter(config.stubSeed ?? 1);
  }
  return new MetaAdsAdapter(
    config.metaGraphToken ?? '',
    config.metaAdAccountId ?? '',
    config.graphApiVersion,
  );
}
