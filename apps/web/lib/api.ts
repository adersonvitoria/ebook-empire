// Client tipado do dashboard. Faz fetch contra a API Fastify (NEXT_PUBLIC_API_URL,
// default http://localhost:3001). Tipos alinhados 1:1 com @ebook-empire/core
// (replicados aqui para o web nao depender do pacote core em runtime no browser).
//
// IMPORTANTE: rotas de listagem/acoes sao implementadas por OUTROS agentes.
// Se uma rota ainda nao existir (404) ou a API estiver fora do ar, as funcoes
// abaixo lancam ApiError; as pages tratam isso graciosamente (estado de erro/vazio).

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// ------------------------------------------------------------
// Tipos espelhados de core (apenas o necessario para o dashboard)
// ------------------------------------------------------------
export type EbookStatus = 'DRAFT' | 'GENERATING' | 'READY' | 'PUBLISHED' | 'ARCHIVED';

export type OrderStatus =
  | 'PENDING'
  | 'AWAITING_PAYMENT'
  | 'PAID'
  | 'DELIVERED'
  | 'REFUNDED'
  | 'CANCELED'
  | 'EXPIRED';

export type PaymentStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'RECEIVED'
  | 'OVERDUE'
  | 'REFUNDED'
  | 'FAILED';

export type SocialStatus = 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'FAILED';

export type AdStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';

export type AgentRunStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';

export type AgentName =
  | 'ORCHESTRATOR'
  | 'CONTENT'
  | 'SALES'
  | 'DELIVERY'
  | 'SOCIAL'
  | 'TRAFFIC'
  | 'ANALYTICS'
  | 'OPERATIONS';

// ------------------------------------------------------------
// CRM / Command Center — tipos espelhados de @ebook-empire/core (crm.ts).
// Replicados aqui pelo mesmo motivo dos demais: o browser nao importa core.
// ------------------------------------------------------------
export type Sector =
  | 'CONTENT'
  | 'SALES'
  | 'DELIVERY'
  | 'SOCIAL'
  | 'TRAFFIC'
  | 'ANALYTICS'
  | 'ORCHESTRATION';

export type SectorStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL';
export type RiskTier = 'LOW' | 'HIGH';
export type ProblemStatus =
  | 'OPEN'
  | 'DIAGNOSING'
  | 'REMEDIATING'
  | 'RESOLVED'
  | 'IGNORED';
export type ActionStatus =
  | 'PROPOSED'
  | 'QUEUED'
  | 'APPROVED'
  | 'REJECTED'
  | 'APPLIED'
  | 'FAILED'
  | 'ROLLED_BACK';
export type ExecutionTrigger = 'AUTO' | 'HUMAN';
export type ActionKind =
  | 'RETRY_DELIVERIES'
  | 'GENERATE_EBOOK'
  | 'GENERATE_SOCIAL_POSTS'
  | 'REGENERATE_LANDING_COPY'
  | 'RECOMPUTE_KPIS'
  | 'RERUN_AGENT'
  | 'INCREASE_AD_BUDGET'
  | 'DECREASE_AD_BUDGET'
  | 'PAUSE_CAMPAIGN'
  | 'ADJUST_PRICE';

/** Lista canonica dos 7 setores (mesma ordem de core.SECTORS). */
export const SECTORS: readonly Sector[] = [
  'CONTENT',
  'SALES',
  'DELIVERY',
  'SOCIAL',
  'TRAFFIC',
  'ANALYTICS',
  'ORCHESTRATION',
] as const;

/** Cortes de status (espelha core.HEALTH_THRESHOLDS). */
export const HEALTH_THRESHOLDS = { HEALTHY_MIN: 70, WARNING_MIN: 40 } as const;

/** Deriva status do score, caso a API nao envie (espelha core.statusFromScore). */
export function statusFromScore(score: number): SectorStatus {
  if (score >= HEALTH_THRESHOLDS.HEALTHY_MIN) return 'HEALTHY';
  if (score >= HEALTH_THRESHOLDS.WARNING_MIN) return 'WARNING';
  return 'CRITICAL';
}

/** Saude de um setor + tendencia/top problema que a /crm/overview anexa. */
export interface SectorHealthView {
  sector: Sector;
  score: number;
  status: SectorStatus;
  kpis: Record<string, unknown>;
  capturedAt?: string | null;
  /** Variacao de score vs snapshot anterior (a API pode anexar). */
  trend?: number | null;
  /** Resumo do problema mais grave em aberto no setor. */
  topProblem?: {
    id: string;
    type: string;
    severity: number;
    rootCause?: string | null;
  } | null;
}

export interface CrmProblem {
  id: string;
  sector: Sector;
  type: string;
  severity: number;
  status: ProblemStatus;
  rootCause?: string | null;
  detectedAt: string;
  resolvedAt?: string | null;
}

export interface CrmAction {
  id: string;
  problemId: string;
  kind: ActionKind;
  riskTier: RiskTier;
  params: Record<string, unknown>;
  expectedEffect?: string | null;
  status: ActionStatus;
  reversible: boolean;
  createdAt: string;
  /** Relacoes que a API pode anexar. */
  sector?: Sector | null;
  execution?: CrmExecution | null;
}

export interface CrmExecution {
  id: string;
  actionId: string;
  success: boolean;
  beforeState?: unknown;
  afterState?: unknown;
  error?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  triggeredBy: ExecutionTrigger;
}

export interface CrmOverview {
  sectors: SectorHealthView[];
  counts: {
    openProblems: number;
    queuedApprovals: number;
    appliedActions?: number;
    failedActions?: number;
  };
  killSwitch: boolean;
}

export interface GuardrailConfig {
  id: string;
  killSwitch: boolean;
  maxAutoActionsPerCycle: number;
  cooldownMinutes: number;
  maxAdBudgetCents?: number | null;
  updatedAt?: string;
}

export interface Ebook {
  id: string;
  title: string;
  niche: string;
  slug: string;
  status: EbookStatus;
  language: string;
  pdfPath?: string | null;
  coverImagePath?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: string;
  customerId: string;
  productId: string;
  ebookId: string;
  status: OrderStatus;
  priceCents: number;
  currency: string;
  utmCampaign?: string | null;
  asaasPaymentId?: string | null;
  paidAt?: string | null;
  deliveredAt?: string | null;
  createdAt: string;
  // enriquecimentos opcionais (a API pode incluir relacoes)
  customerEmail?: string | null;
  paymentStatus?: PaymentStatus | null;
}

export interface SocialPost {
  id: string;
  platform: string;
  caption: string;
  hashtags: string[];
  mediaPaths: string[];
  status: SocialStatus;
  scheduledAt?: string | null;
  publishedAt?: string | null;
  permalink?: string | null;
  externalPostId?: string | null;
  attempts: number;
  error?: string | null;
  createdAt: string;
}

export interface AdInsight {
  id: string;
  campaignId: string;
  date: string;
  impressions: number;
  clicks: number;
  spendCents: number;
  conversions: number;
  revenueCents: number;
}

export interface AdCampaign {
  id: string;
  name: string;
  objective: string;
  status: AdStatus;
  platform: string;
  dailyBudgetCents?: number | null;
  totalSpendCents: number;
  utmCampaign?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  createdAt: string;
  // agregados opcionais que a API pode anexar
  insights?: AdInsight[];
}

export interface AgentRun {
  id: string;
  agent: AgentName;
  status: AgentRunStatus;
  cycleId?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costCents?: number | null;
  output?: unknown;
  metrics?: unknown;
}

// KPISnapshot do AnalyticsAgent (calculo de ROAS/CAC/meta).
export interface KPISnapshot {
  date: string;
  revenueCents: number;
  spendCents: number;
  profitCents: number;
  llmCostCents: number;
  paidOrders: number;
  roas?: number;
  roi?: number;
  cacCents?: number;
  cpaCents?: number;
  aovCents?: number;
  targetRevenueCents: number;
  metTarget: boolean;
}

// ------------------------------------------------------------
// Financeiro consolidado (Feature 2) — tipos espelhados de @ebook-empire/core
// (finance.ts). Dinheiro Int centavos; marginPct/roas sao razoes (number|null).
// ------------------------------------------------------------
export interface DreMeta {
  targetRevenueCents: number;
  progressPct: number;
  metTarget: boolean;
  projectedRevenueCents: number;
  projectedMetTarget: boolean;
  isPartial: boolean;
}

export interface DreResult {
  date: string;
  grossRevenueCents: number;
  paymentFeesCents: number;
  adSpendCents: number;
  llmCostCents: number;
  netProfitCents: number;
  marginPct: number | null;
  paidOrders: number;
  meta: DreMeta;
}

export interface EbookMargin {
  ebookId: string;
  title: string;
  revenueCents: number;
  orders: number;
  paymentFeesCents: number;
  adSpendAttributedCents: number;
  netProfitCents: number;
  marginPct: number | null;
}

export interface EbookBreakdownResult {
  date: string;
  ebooks: EbookMargin[];
  unattributedAdSpendCents: number;
}

export interface CampaignMargin {
  campaignId: string;
  name: string;
  spendCents: number;
  revenueCents: number;
  roas: number | null;
  netProfitCents: number;
}

export interface CampaignBreakdownResult {
  date: string;
  campaigns: CampaignMargin[];
  organic: { revenueCents: number; orders: number };
}

export interface FinanceSnapshotView {
  id: string;
  date: string;
  grossRevenueCents: number;
  paymentFeesCents: number;
  adSpendCents: number;
  llmCostCents: number;
  netProfitCents: number;
  marginPct: number | null;
  paidOrders: number;
  computedAt: string | Date;
}

export interface FinanceHistoryResult {
  from: string;
  to: string;
  snapshots: FinanceSnapshotView[];
}

// ------------------------------------------------------------
// Alertas externos (Feature 1) — tipos espelhados de @ebook-empire/core
// (alerts.ts). Strings de usuario em pt-BR; montadas no AlertService/API.
// ------------------------------------------------------------
export type AlertEvent =
  | 'KILL_SWITCH_ON'
  | 'KILL_SWITCH_OFF'
  | 'SECTOR_CRITICAL'
  | 'ACTION_AUTO_FAILED'
  | 'ACTION_HIGH_QUEUED';

export type AlertChannel = 'EMAIL' | 'WHATSAPP';
export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertStatus = 'SENT' | 'FAILED' | 'SUPPRESSED';

export interface AlertLog {
  id: string;
  event: AlertEvent;
  severity: AlertSeverity;
  channel: AlertChannel;
  sector?: Sector | null;
  title: string;
  body: string;
  status: AlertStatus;
  dedupeKey: string;
  providerId?: string | null;
  error?: string | null;
  sentAt?: string | null;
  createdAt: string;
}

export interface AlertSettings {
  alertsEnabled: boolean;
  channels: AlertChannel[];
  emailRecipients: string[];
  whatsappRecipients: string[];
  enabledEvents: AlertEvent[];
  throttleMinutes: number;
  updatedAt?: string;
}

export interface AlertDeliveryResult {
  channel: AlertChannel;
  status: 'SENT' | 'FAILED';
  providerId?: string;
  error?: string;
}

// ------------------------------------------------------------
// TIMES por setor (framework Specialist/Strategist/Executor) — tipos espelhados
// de @ebook-empire/core (team.ts/crm.ts). Os 9 setores dos times.
// ------------------------------------------------------------
export type TeamSector = Sector | 'MARKET_RESEARCH' | 'EBOOK_QA';

/** Lista canonica dos 9 setores dos times (espelha core.TEAM_SECTORS). */
export const TEAM_SECTORS: readonly TeamSector[] = [
  ...SECTORS,
  'MARKET_RESEARCH',
  'EBOOK_QA',
] as const;

export type Role = 'SPECIALIST' | 'STRATEGIST' | 'EXECUTOR';

export interface Assessment {
  sector: TeamSector;
  healthScore: number;
  status: SectorStatus;
  findings: string[];
  risks: string[];
  opportunities: string[];
  evidence: unknown;
  confidence: number;
  source: 'RULES' | 'LLM';
}

export interface StrategyAction {
  capability: string;
  priority: number;
  params: unknown;
  reason: string;
}

export interface Strategy {
  sector: TeamSector;
  objective: string;
  mode: 'GROW' | 'SUSTAIN';
  actions: StrategyAction[];
  successCriteria: string[];
  rationale: string;
}

export interface ExecutedAction {
  capability: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  agentRunId?: string;
  error?: string;
}

export interface ExecutionOutcome {
  sector: TeamSector;
  executed: ExecutedAction[];
  succeeded: number;
  failed: number;
  skipped: number;
  summary: string;
}

/** AgentRun enriquecido com role/sector/output (papeis dos times). */
export interface TeamRun {
  id: string;
  agent: string;
  role?: Role | null;
  sector?: TeamSector | null;
  status: AgentRunStatus;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  output?: unknown;
}

/** Resumo do ultimo ciclo de um time (montado no cliente a partir dos runs). */
export interface TeamSectorView {
  sector: TeamSector;
  assessment?: Assessment | null;
  strategy?: Strategy | null;
  outcome?: ExecutionOutcome | null;
  lastRunAt?: string | null;
}

// ------------------------------------------------------------
// Erro de API com status para as pages distinguirem 404 (rota ausente)
// de falha de rede / 5xx.
// ------------------------------------------------------------
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  // permite passar querystring como objeto
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(path.replace(/^\//, ''), `${API_BASE.replace(/\/$/, '')}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal } = options;
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    // Falha de rede (API fora do ar) — normaliza para ApiError(0).
    const message = err instanceof Error ? err.message : 'falha de rede';
    throw new ApiError(`Nao foi possivel conectar a API: ${message}`, 0);
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = (await res.json()) as { error?: string; message?: string };
      detail = data.error ?? data.message ?? detail;
    } catch {
      // resposta sem corpo JSON — mantem statusText
    }
    throw new ApiError(detail || `HTTP ${res.status}`, res.status);
  }

  // 204 No Content
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// ------------------------------------------------------------
// Endpoints. Aceitam shape de envelope { data, total } OU array puro,
// normalizando para um formato unico de lista.
// ------------------------------------------------------------
export interface ListResult<T> {
  data: T[];
  total?: number;
}

function asList<T>(raw: unknown): ListResult<T> {
  if (Array.isArray(raw)) return { data: raw as T[] };
  if (raw && typeof raw === 'object' && 'data' in raw) {
    const env = raw as { data: T[]; total?: number };
    return { data: Array.isArray(env.data) ? env.data : [], total: env.total };
  }
  return { data: [] };
}

export const api = {
  health(signal?: AbortSignal) {
    return request<{ status: string; db: string; service: string }>('/health', {
      signal,
    });
  },

  // --- KPIs / Overview ---
  // O AnalyticsAgent expoe o snapshot do dia em /agents/kpi (ou similar);
  // se ausente, a page calcula um resumo aproximado a partir de orders.
  async kpis(signal?: AbortSignal): Promise<KPISnapshot> {
    return request<KPISnapshot>('/agents/kpi', { signal });
  },

  // --- Ebooks ---
  async listEbooks(
    params: { status?: EbookStatus; niche?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<ListResult<Ebook>> {
    const raw = await request<unknown>('/ebooks', { query: params, signal });
    return asList<Ebook>(raw);
  },

  generateEbook(body: { niche: string; title?: string; language?: string }) {
    return request<Ebook>('/ebooks/generate', { method: 'POST', body });
  },

  // --- Orders ---
  async listOrders(
    params: { status?: OrderStatus; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<ListResult<Order>> {
    const raw = await request<unknown>('/orders', { query: params, signal });
    return asList<Order>(raw);
  },

  // --- Social ---
  async listSocialPosts(
    params: { status?: SocialStatus; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<ListResult<SocialPost>> {
    const raw = await request<unknown>('/social', { query: params, signal });
    return asList<SocialPost>(raw);
  },

  // --- Ads ---
  async listAdCampaigns(
    params: { status?: AdStatus; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<ListResult<AdCampaign>> {
    const raw = await request<unknown>('/ads', { query: params, signal });
    return asList<AdCampaign>(raw);
  },

  // --- Agents ---
  async listAgentRuns(
    params: {
      agent?: AgentName;
      status?: AgentRunStatus;
      limit?: number;
      offset?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<ListResult<AgentRun>> {
    const raw = await request<unknown>('/agents/runs', { query: params, signal });
    return asList<AgentRun>(raw);
  },

  // --- Times por setor ---
  // Reusa GET /agents/runs (historico de AgentRun). Cada execucao de papel
  // (Specialist/Strategist/Executor) grava um AgentRun com role+sector+output.
  // A page filtra/monta o ultimo Assessment/Strategy/ExecutionOutcome por setor.
  // Se a rota ainda nao expoe role/sector/output, os campos vem undefined e a
  // page degrada com gracia (mostra apenas o que houver).
  async teamRuns(
    params: { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ListResult<TeamRun>> {
    const raw = await request<unknown>('/agents/runs', {
      query: { limit: params.limit ?? 200 },
      signal,
    });
    // A rota responde { runs, total } OU array; normaliza para data[].
    if (raw && typeof raw === 'object' && 'runs' in raw) {
      const env = raw as { runs: TeamRun[]; total?: number };
      return { data: Array.isArray(env.runs) ? env.runs : [], total: env.total };
    }
    return asList<TeamRun>(raw);
  },

  // Dispara um ciclo do orchestrator (CEO). Rota administrativa.
  runCycle() {
    return request<{ cycleId?: string; ok?: boolean }>('/agents/run-cycle', {
      method: 'POST',
      body: {},
    });
  },

  // ----------------------------------------------------------
  // CRM / Command Center. Rotas implementadas pelo dono de /crm em apps/api.
  // Enquanto aquecem, podem responder 404 — as pages tratam graciosamente.
  // ----------------------------------------------------------
  crmOverview(signal?: AbortSignal): Promise<CrmOverview> {
    return request<CrmOverview>('/crm/overview', { signal });
  },

  async crmSectorHistory(
    sector: Sector,
    params: { limit?: number; since?: string } = {},
    signal?: AbortSignal,
  ): Promise<ListResult<SectorHealthView>> {
    const raw = await request<unknown>(`/crm/sectors/${sector}`, {
      query: params,
      signal,
    });
    return asList<SectorHealthView>(raw);
  },

  async crmListProblems(
    params: {
      status?: ProblemStatus;
      sector?: Sector;
      limit?: number;
      offset?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<ListResult<CrmProblem>> {
    const raw = await request<unknown>('/crm/problems', { query: params, signal });
    return asList<CrmProblem>(raw);
  },

  async crmListActions(
    params: {
      status?: ActionStatus;
      riskTier?: RiskTier;
      problemId?: string;
      limit?: number;
      offset?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<ListResult<CrmAction>> {
    const raw = await request<unknown>('/crm/actions', { query: params, signal });
    return asList<CrmAction>(raw);
  },

  // Fila de aprovacao = acoes HIGH risk aguardando decisao humana (QUEUED).
  async crmListApprovals(
    signal?: AbortSignal,
  ): Promise<ListResult<CrmAction>> {
    const raw = await request<unknown>('/crm/approvals', { signal });
    return asList<CrmAction>(raw);
  },

  crmApproveAction(id: string) {
    return request<CrmAction>(`/crm/actions/${id}/approve`, {
      method: 'POST',
      body: {},
    });
  },

  crmRejectAction(id: string, reason?: string) {
    return request<CrmAction>(`/crm/actions/${id}/reject`, {
      method: 'POST',
      body: { reason },
    });
  },

  crmRollback(executionId: string) {
    return request<CrmExecution>(`/crm/executions/${executionId}/rollback`, {
      method: 'POST',
      body: {},
    });
  },

  crmGuardrails(signal?: AbortSignal): Promise<GuardrailConfig> {
    return request<GuardrailConfig>('/crm/guardrails', { signal });
  },

  crmUpdateGuardrails(body: {
    maxAutoActionsPerCycle?: number;
    cooldownMinutes?: number;
    maxAdBudgetCents?: number | null;
  }) {
    return request<GuardrailConfig>('/crm/guardrails', { method: 'PUT', body });
  },

  crmSetKillSwitch(enabled: boolean) {
    return request<GuardrailConfig>('/crm/killswitch', {
      method: 'POST',
      body: { enabled },
    });
  },

  crmScan(sector?: Sector) {
    return request<{ ok?: boolean; problems?: number }>('/crm/scan', {
      method: 'POST',
      body: sector ? { sector } : {},
    });
  },

  // ----------------------------------------------------------
  // Financeiro consolidado (Feature 2). Rotas em apps/api/src/routes/finance.ts.
  // Leituras sem JWT; snapshot exige Bearer (nao usado pela page interna).
  // ----------------------------------------------------------
  financeOverview(signal?: AbortSignal): Promise<DreResult> {
    return request<DreResult>('/finance/overview', { signal });
  },

  financeDre(date?: string, signal?: AbortSignal): Promise<DreResult> {
    return request<DreResult>('/finance/dre', { query: { date }, signal });
  },

  financeByEbook(date?: string, signal?: AbortSignal): Promise<EbookBreakdownResult> {
    return request<EbookBreakdownResult>('/finance/by-ebook', { query: { date }, signal });
  },

  financeByCampaign(date?: string, signal?: AbortSignal): Promise<CampaignBreakdownResult> {
    return request<CampaignBreakdownResult>('/finance/by-campaign', {
      query: { date },
      signal,
    });
  },

  financeSnapshots(
    params: { from?: string; to?: string } = {},
    signal?: AbortSignal,
  ): Promise<FinanceHistoryResult> {
    return request<FinanceHistoryResult>('/finance/snapshots', { query: params, signal });
  },

  financeSnapshot(date?: string): Promise<{ computed: boolean; snapshot: FinanceSnapshotView }> {
    return request<{ computed: boolean; snapshot: FinanceSnapshotView }>('/finance/snapshot', {
      method: 'POST',
      body: { date },
    });
  },

  // ----------------------------------------------------------
  // Alertas externos (Feature 1). Rotas em apps/api/src/routes/alerts.ts.
  // Leituras sem JWT; settings/test exigem Bearer (nao usado pela page interna).
  // ----------------------------------------------------------
  async listAlerts(
    params: {
      event?: AlertEvent;
      channel?: AlertChannel;
      status?: AlertStatus;
      limit?: number;
      offset?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<ListResult<AlertLog>> {
    const raw = await request<unknown>('/alerts', { query: params, signal });
    return asList<AlertLog>(raw);
  },

  getAlertSettings(signal?: AbortSignal): Promise<AlertSettings> {
    return request<AlertSettings>('/alerts/settings', { signal });
  },

  updateAlertSettings(body: Partial<AlertSettings>): Promise<{ updated: boolean; settings: AlertSettings }> {
    return request<{ updated: boolean; settings: AlertSettings }>('/alerts/settings', {
      method: 'PUT',
      body,
    });
  },

  testAlert(sector?: Sector): Promise<{
    tested: boolean;
    sector: Sector | null;
    channels: AlertChannel[];
    results: AlertDeliveryResult[];
  }> {
    return request<{
      tested: boolean;
      sector: Sector | null;
      channels: AlertChannel[];
      results: AlertDeliveryResult[];
    }>('/alerts/test', { method: 'POST', body: sector ? { sector } : {} });
  },
};

// ------------------------------------------------------------
// Helpers de formatacao pt-BR (centavos BRL, datas, percentuais).
// ------------------------------------------------------------
export function formatBRL(cents: number | null | undefined): string {
  const value = (cents ?? 0) / 100;
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR');
}

export function formatNumber(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('pt-BR');
}

export function formatRoas(roas: number | null | undefined): string {
  if (roas === null || roas === undefined) return '—';
  return `${roas.toFixed(2)}x`;
}

export function formatPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return '—';
  return `${pct.toFixed(1)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
