// OrchestratorAgent — o "CEO" da empresa autonoma.
//
// Responsabilidade (ver docs/ARCHITECTURE.md secao "Orchestrator (CEO)"):
//  1) Le o KPISnapshot do dia (via AnalyticsAgent / leitura direta do banco).
//  2) Aplica GUARDRAILS deterministicos (teto de budget, meta de receita).
//  3) So entao consulta o LLM de planejamento ('claude-opus-4-8') para
//     priorizar acoes -> AgentPlan (validado por Zod).
//  4) Executa os agentes-filho na ORDEM CERTA, por prioridade, tolerando
//     falha individual de cada filho (um filho que lanca NAO derruba o ciclo).
//  5) NAO faz trabalho de dominio — apenas coordena.
//
// Escrita disjunta: o orchestrator NAO importa as classes concretas dos demais
// agentes (content/sales/...). Em vez disso recebe um REGISTRO injetavel
// (Map<AgentName, Agent>) — montado pelo scheduler na API e por stubs no teste.

import type { AgentName, Json } from '@ebook-empire/core';
import {
  agentPlanSchema,
  type AgentPlan,
  type AgentPlanAction,
  type KPISnapshot,
} from '@ebook-empire/core';
import {
  Agent,
  type AgentContext,
  type AgentRunResult,
  type AgentRunRecord,
} from './base.js';
import {
  createAndLaunchEbook,
  type LaunchResult,
} from './launch/index.js';

// ------------------------------------------------------------
// Registro de agentes-filho que o orchestrator pode acionar.
// O scheduler injeta os agentes reais; os testes injetam stubs.
// ------------------------------------------------------------
export type AgentRegistry = Map<AgentName, Agent>;

// Ordem CANONICA de execucao de um ciclo (pipeline do negocio):
// Content gera catalogo -> Sales precifica/reconcilia -> Social divulga ->
// Traffic escala trafego pago -> Delivery entrega -> Analytics avalia.
// O orchestrator nao se inclui nesta lista (ele e o coordenador).
export const CYCLE_ORDER: AgentName[] = [
  'CONTENT',
  'SALES',
  'SOCIAL',
  'TRAFFIC',
  'DELIVERY',
  'ANALYTICS',
];

// ------------------------------------------------------------
// Resultado da execucao de um filho dentro do ciclo (resumo).
// ------------------------------------------------------------
export interface ChildRunSummary {
  agent: AgentName;
  status: AgentRunRecord['status'];
  durationMs: number | null;
  priority: number;
  reason?: string;
  error?: string;
}

// Opcoes injetaveis (defaults sensatos; testes podem sobrescrever).
export interface OrchestratorOptions {
  /** Registro de agentes-filho. Default: vazio (ciclo vira no-op SKIPPED). */
  registry?: AgentRegistry;
  /**
   * Leitor de KPI do dia. Injetavel para teste deterministico.
   * Default: calculo direto a partir do Prisma (computeDailyKpi).
   */
  readKpi?: (ctx: AgentContext) => Promise<KPISnapshot>;
  /**
   * Criacao de catalogo via PIPELINE DE LANCAMENTO (com os dois GATES:
   * mercado + qualidade). Quando o CEO decide gerar catalogo (acao CONTENT),
   * o orchestrator NAO aciona o ContentAgent direto: ele chama esta funcao, que
   * so publica um ebook apos selecionar uma MarketOpportunity (GATE 1) e passar
   * no QA (GATE 2). Injetavel para teste; default = createAndLaunchEbook.
   */
  launchEbook?: (ctx: AgentContext) => Promise<LaunchResult>;
}

// ============================================================
// OrchestratorAgent
// ============================================================
export class OrchestratorAgent extends Agent {
  readonly name: AgentName = 'ORCHESTRATOR';

  private readonly registry: AgentRegistry;
  private readonly readKpi: (ctx: AgentContext) => Promise<KPISnapshot>;
  private readonly launchEbook: (ctx: AgentContext) => Promise<LaunchResult>;

  constructor(opts: OrchestratorOptions = {}) {
    super();
    this.registry = opts.registry ?? new Map();
    this.readKpi = opts.readKpi ?? computeDailyKpi;
    // Default: pipeline de lancamento com GATES (mercado + qualidade).
    this.launchEbook = opts.launchEbook ?? ((ctx) => createAndLaunchEbook(ctx));
  }

  /**
   * Executa um ciclo completo de coordenacao.
   * 1) snapshot de KPI -> 2) guardrails -> 3) plano (LLM opus) ->
   * 4) executa filhos por prioridade, tolerando falhas individuais.
   * O proprio AgentRun do ORCHESTRATOR e gravado pelo ciclo de vida (execute()).
   */
  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const kpi = await this.readKpi(ctx);

    // --- Guardrails deterministicos (antes do LLM) ---
    const guardrails = computeGuardrails(kpi, ctx);
    // Budget semanal de catalogo: se ainda nao batemos a meta de ebooks da
    // semana ISO corrente, forca a geracao de conteudo independente das KPIs de
    // receita (a empresa precisa alimentar o catalogo continuamente).
    await applyWeeklyEbookBudget(ctx, guardrails);

    // --- Planejamento via LLM 'claude-opus-4-8' (com fallback deterministico) ---
    const { plan, tokensIn, tokensOut, costCents } = await this.buildPlan(
      ctx,
      kpi,
      guardrails,
    );

    // Acoes ordenadas por prioridade desc; filtra agentes inexistentes/desconhecidos.
    const actions = [...plan.actions]
      .filter((a) => a.agent !== 'ORCHESTRATOR')
      .sort((a, b) => b.priority - a.priority);

    const children: ChildRunSummary[] = [];
    const launches: LaunchResult[] = [];

    for (const action of actions) {
      // CONTENT (criacao de catalogo) passa pelo PIPELINE DE LANCAMENTO com os
      // dois GATES — o CEO nunca gera ebook "cru" sem mercado + QA.
      if (action.agent === 'CONTENT') {
        try {
          const launch = await this.launchEbook({ ...ctx, cycleId: ctx.cycleId });
          launches.push(launch);
          children.push({
            agent: 'CONTENT',
            status: launch.launched ? 'SUCCESS' : 'SKIPPED',
            durationMs: 0,
            priority: action.priority,
            reason: launch.reason,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.log.error(
            { agent: 'CONTENT', err: message },
            'pipeline de lancamento falhou — ciclo continua',
          );
          children.push({
            agent: 'CONTENT',
            status: 'FAILED',
            durationMs: null,
            priority: action.priority,
            reason: action.reason,
            error: message,
          });
        }
        continue;
      }

      const child = this.registry.get(action.agent);
      if (!child) {
        // Filho nao registrado neste ambiente — registra como SKIPPED logico.
        children.push({
          agent: action.agent,
          status: 'SKIPPED',
          durationMs: 0,
          priority: action.priority,
          reason: 'agente nao registrado',
        });
        continue;
      }

      // Propaga o cycleId para correlacionar os AgentRun do mesmo tick e
      // injeta os params do plano como input do filho (via ctx.env? nao —
      // os filhos leem o proprio dominio; params ficam no output do ciclo).
      const childCtx: AgentContext = { ...ctx, cycleId: ctx.cycleId };

      try {
        // child.execute() NUNCA lanca (o ciclo de vida captura e grava FAILED),
        // mas defendemos mesmo assim para nao derrubar o ciclo do CEO.
        const rec = await child.execute(childCtx);
        children.push({
          agent: action.agent,
          status: rec.status,
          durationMs: rec.durationMs,
          priority: action.priority,
          reason: action.reason,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.error(
          { agent: action.agent, err: message },
          'filho falhou de forma inesperada — ciclo continua',
        );
        children.push({
          agent: action.agent,
          status: 'FAILED',
          durationMs: null,
          priority: action.priority,
          reason: action.reason,
          error: message,
        });
      }
    }

    const succeeded = children.filter(
      (c) => c.status === 'SUCCESS' || c.status === 'SKIPPED',
    ).length;

    const output: Json = {
      mode: plan.mode,
      rationale: plan.rationale,
      kpi: kpi as unknown as Json,
      guardrails: guardrails as unknown as Json,
      children: children as unknown as Json,
      launches: launches as unknown as Json,
    };

    const metrics: Json = {
      planned: actions.length,
      executed: children.length,
      succeeded,
      failed: children.filter((c) => c.status === 'FAILED').length,
      revenueCents: kpi.revenueCents,
      spendCents: kpi.spendCents,
      metTarget: kpi.metTarget,
    };

    return {
      status: 'SUCCESS',
      output,
      metrics,
      tokensIn,
      tokensOut,
      costCents,
    };
  }

  /**
   * Constroi o AgentPlan. Tenta o LLM de planejamento (opus); se a chave de API
   * estiver ausente ou o LLM falhar, cai para um plano deterministico baseado
   * nos guardrails (o negocio nunca trava por falta de LLM).
   */
  private async buildPlan(
    ctx: AgentContext,
    kpi: KPISnapshot,
    guardrails: Guardrails,
  ): Promise<{
    plan: AgentPlan;
    tokensIn?: number;
    tokensOut?: number;
    costCents?: number;
  }> {
    const fallback = deterministicPlan(guardrails);

    try {
      const system = buildPlannerSystemPrompt();
      const userMsg = buildPlannerUserPrompt(kpi, guardrails);

      const { data, usage } = await ctx.ports.llm.generateJson<AgentPlan>({
        model: ctx.env.PLANNING_MODEL, // 'claude-opus-4-8'
        system,
        messages: [{ role: 'user', content: userMsg }],
        maxTokens: 1500,
        temperature: 0.2,
        parse: (raw) => agentPlanSchema.parse(raw),
      });

      // Garante que toda a pipeline esteja contemplada: agentes ausentes no
      // plano do LLM entram com prioridade baixa (mantem o negocio rodando).
      const merged = mergeWithPipeline(data, guardrails);

      return {
        plan: merged,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costCents: usage.costCents,
      };
    } catch (err) {
      ctx.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'planejamento LLM indisponivel — usando plano deterministico',
      );
      return { plan: fallback };
    }
  }
}

// ============================================================
// Guardrails deterministicos
// ============================================================
export interface Guardrails {
  /** Modo de operacao sugerido pelos KPIs. */
  mode: 'GROW' | 'SUSTAIN';
  /** Teto de budget diario de ads (centavos) — derivado de MAX_AD_BUDGET_BRL. */
  maxAdBudgetCents: number;
  /** Pode escalar trafego? (ROAS saudavel e abaixo do teto). */
  canScaleAds: boolean;
  /** Precisa de mais catalogo? (poucos produtos ativos / sem receita). */
  needsContent: boolean;
  /** Atingiu a meta diaria? */
  metTarget: boolean;
  /** ROAS atual (undefined se spend=0). */
  roas?: number;
}

const ROAS_SCALE_THRESHOLD = 1.5; // so escala ads com ROAS >= 1.5

export function computeGuardrails(kpi: KPISnapshot, ctx: AgentContext): Guardrails {
  const maxAdBudgetCents = Math.round(ctx.env.MAX_AD_BUDGET_BRL * 100);
  const roas = kpi.roas;

  // Escala trafego apenas se ROAS saudavel E ainda ha folga sob o teto de budget.
  const underBudgetCap = kpi.spendCents < maxAdBudgetCents;
  const canScaleAds = underBudgetCap && (roas === undefined || roas >= ROAS_SCALE_THRESHOLD);

  // Precisa de mais conteudo quando nao ha receita (catalogo provavelmente vazio/fraco).
  const needsContent = kpi.revenueCents === 0 || kpi.paidOrders === 0;

  const mode: Guardrails['mode'] = kpi.metTarget ? 'SUSTAIN' : 'GROW';

  return {
    mode,
    maxAdBudgetCents,
    canScaleAds,
    needsContent,
    metTarget: kpi.metTarget,
    roas,
  };
}

/**
 * Budget semanal de catalogo (guardrail deterministico, async pois consulta o
 * banco). Conta AgentRun de CONTENT com status SUCCESS na SEMANA ISO corrente
 * (segunda 00:00 BRT ate a proxima segunda). Se a contagem for MENOR que
 * env.WEEKLY_EBOOK_TARGET, MUTA guardrails.needsContent = true, forcando a
 * geracao de catalogo mesmo que as KPIs de receita estejam saudaveis.
 *
 * Tolerante a falha: se a consulta lancar (ex.: banco indisponivel), apenas
 * loga e mantem o guardrail como estava (o negocio nunca trava por isso).
 *
 * @returns a contagem de ebooks da semana e o alvo (para observabilidade/teste).
 */
export async function applyWeeklyEbookBudget(
  ctx: AgentContext,
  guardrails: Guardrails,
): Promise<{ weekEbooks: number; target: number; forced: boolean }> {
  const target = weeklyEbookTarget(ctx);
  const { start, end } = isoWeekBoundsSaoPaulo(ctx.clock.now());

  try {
    const weekEbooks = await ctx.prisma.agentRun.count({
      where: {
        agent: 'CONTENT',
        status: 'SUCCESS',
        startedAt: { gte: start, lt: end },
      },
    });
    const forced = weekEbooks < target;
    if (forced && !guardrails.needsContent) {
      guardrails.needsContent = true;
      ctx.log.info(
        { weekEbooks, target },
        'guardrail: abaixo do budget semanal de ebooks — forcando geracao de catalogo',
      );
    }
    return { weekEbooks, target, forced };
  } catch (err) {
    ctx.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'guardrail: contagem de ebooks da semana falhou — mantendo needsContent',
    );
    return { weekEbooks: 0, target, forced: false };
  }
}

/** Le WEEKLY_EBOOK_TARGET do env (index-signature do AgentEnv), default 3. */
function weeklyEbookTarget(ctx: AgentContext): number {
  const v = ctx.env.WEEKLY_EBOOK_TARGET;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 1) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return 3;
}

/**
 * Limites da semana ISO corrente em America/Sao_Paulo (UTC-3, sem DST). A semana
 * ISO comeca na SEGUNDA-feira 00:00 (local) e termina na proxima segunda 00:00.
 * Mesma convencao determinista (offset fixo) usada em dayBoundsSaoPaulo.
 */
export function isoWeekBoundsSaoPaulo(now: Date): { start: Date; end: Date } {
  const OFFSET_MS = 3 * 60 * 60 * 1000; // BRT = UTC-3
  const local = new Date(now.getTime() - OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  // getUTCDay: 0=domingo..6=sabado. Dias desde a ultima segunda.
  const dow = local.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7; // segunda=0, domingo=6
  const startLocalMidnight = Date.UTC(y, m, d - daysSinceMonday, 0, 0, 0);
  const start = new Date(startLocalMidnight + OFFSET_MS);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start, end };
}

// ============================================================
// Planos (LLM + fallback deterministico)
// ============================================================

// Prioridades base por agente na pipeline. O LLM pode reordenar; o fallback usa
// estas + ajustes por guardrail.
const BASE_PRIORITY: Record<AgentName, number> = {
  ORCHESTRATOR: 0,
  CONTENT: 50,
  SALES: 70,
  SOCIAL: 40,
  TRAFFIC: 60,
  DELIVERY: 90, // entrega tem prioridade alta (cliente pagou)
  ANALYTICS: 30,
  // OPERATIONS (COO) NAO e planejado pelo CEO — roda no loop FAST proprio.
  // Prioridade 0 (a pipeline do orchestrator nunca o seleciona).
  OPERATIONS: 0,
  // MARKET_RESEARCH / EBOOK_QA nao sao filhos do ciclo do CEO: rodam DENTRO do
  // pipeline de lancamento (acionado pela acao CONTENT). Prioridade 0 — o
  // orchestrator nunca os seleciona diretamente.
  MARKET_RESEARCH: 0,
  EBOOK_QA: 0,
  // Setores de producao autonoma (marketplace/afiliados/funil): NAO sao filhos
  // do ciclo do CEO — operados pelo COO de producao. Prioridade 0 (nunca
  // selecionados diretamente pela pipeline do orchestrator).
  MARKETPLACE: 0,
  AFFILIATE: 0,
  FUNNEL: 0,
};

/** Plano deterministico: roda a pipeline inteira com prioridades guardrail-aware. */
export function deterministicPlan(g: Guardrails): AgentPlan {
  const actions: AgentPlanAction[] = CYCLE_ORDER.map((agent) => {
    let priority = BASE_PRIORITY[agent];
    let reason = 'execucao padrao da pipeline';

    if (agent === 'CONTENT' && g.needsContent) {
      priority = 95;
      reason = 'sem receita/catalogo — priorizar geracao de ebook';
    }
    if (agent === 'TRAFFIC') {
      if (g.canScaleAds && g.mode === 'GROW') {
        priority = 85;
        reason = 'ROAS saudavel e folga de budget — escalar trafego';
      } else {
        priority = 25;
        reason = g.metTarget
          ? 'meta atingida — manter/segurar trafego'
          : 'ROAS baixo ou teto de budget — nao escalar';
      }
    }
    if (agent === 'SOCIAL' && g.mode === 'GROW') {
      priority = 55;
      reason = 'modo GROW — aumentar alcance organico';
    }

    return { agent, priority, reason };
  });

  return {
    mode: g.mode,
    rationale: g.metTarget
      ? 'Meta diaria atingida: sustentar receita e entregar pendencias.'
      : 'Abaixo da meta: priorizar catalogo, alcance e trafego dentro dos guardrails.',
    actions,
  };
}

/**
 * Funde o plano do LLM com a pipeline completa: qualquer agente da pipeline
 * ausente no plano do LLM entra com prioridade baixa (15) para o negocio
 * nunca deixar de entregar/analisar. Tambem reaplica o teto de TRAFFIC quando
 * os guardrails proibem escalar.
 */
export function mergeWithPipeline(plan: AgentPlan, g: Guardrails): AgentPlan {
  const byAgent = new Map<AgentName, AgentPlanAction>(
    plan.actions.map((a) => [a.agent, a] as const),
  );

  for (const agent of CYCLE_ORDER) {
    if (!byAgent.has(agent)) {
      byAgent.set(agent, {
        agent,
        priority: 15,
        reason: 'incluido pela pipeline (ausente no plano do LLM)',
      });
    }
  }

  // Guardrail duro: se nao pode escalar ads, rebaixa TRAFFIC mesmo que o LLM peca.
  if (!g.canScaleAds) {
    const traffic = byAgent.get('TRAFFIC');
    if (traffic && traffic.priority > 30) {
      byAgent.set('TRAFFIC', {
        ...traffic,
        priority: 25,
        reason: 'guardrail: ROAS baixo ou teto de budget — nao escalar',
      });
    }
  }

  return {
    mode: plan.mode,
    rationale: plan.rationale,
    actions: [...byAgent.values()],
  };
}

// ------------------------------------------------------------
// Prompts do planejador (LLM opus). Dominio em pt-BR.
// ------------------------------------------------------------
function buildPlannerSystemPrompt(): string {
  return [
    'Voce e o CEO autonomo da "Ebook Empire", uma empresa que gera, vende e',
    'entrega ebooks online no Brasil. Meta de negocio: faturar >= R$1.000/dia.',
    'Sua tarefa e PRIORIZAR quais agentes acionar neste ciclo, com base nos KPIs',
    'e nos guardrails deterministicos ja calculados (que voce DEVE respeitar).',
    '',
    'Agentes disponiveis: CONTENT (gera ebooks), SALES (precifica/reconcilia),',
    'SOCIAL (divulga no Instagram), TRAFFIC (trafego pago), DELIVERY (entrega ao',
    'cliente), ANALYTICS (calcula KPIs). Voce (ORCHESTRATOR) nao se inclui.',
    '',
    'Regras rigidas:',
    '- Se canScaleAds=false, NAO de prioridade alta a TRAFFIC.',
    '- DELIVERY sempre deve rodar (cliente pagou e precisa receber).',
    '- Responda APENAS JSON valido no formato AgentPlan: ',
    '  { "mode": "GROW"|"SUSTAIN", "rationale": string,',
    '    "actions": [{ "agent": AgentName, "priority": 0-100, "reason": string }] }.',
  ].join('\n');
}

function buildPlannerUserPrompt(kpi: KPISnapshot, g: Guardrails): string {
  return JSON.stringify(
    {
      kpi: {
        date: kpi.date,
        revenueCents: kpi.revenueCents,
        spendCents: kpi.spendCents,
        profitCents: kpi.profitCents,
        paidOrders: kpi.paidOrders,
        roas: kpi.roas ?? null,
        targetRevenueCents: kpi.targetRevenueCents,
        metTarget: kpi.metTarget,
      },
      guardrails: g,
      instrucao:
        'Priorize as acoes deste ciclo respeitando os guardrails. Retorne AgentPlan JSON.',
    },
    null,
    2,
  );
}

// ============================================================
// Calculo de KPI do dia (default do readKpi)
// ============================================================
// Espelha KPISnapshot de @ebook-empire/core. Calculo simples e deterministico
// direto do Prisma; o AnalyticsAgent (outro arquivo) pode ter calculo mais rico,
// mas o orchestrator nao depende dele para tomar decisao.
export async function computeDailyKpi(ctx: AgentContext): Promise<KPISnapshot> {
  const now = ctx.clock.now();
  const { start, end, dateStr } = dayBoundsSaoPaulo(now);

  // Receita contabil: Orders pagas/entregues no dia (status PAID ou DELIVERED).
  const paidOrders = await ctx.prisma.order.findMany({
    where: {
      status: { in: ['PAID', 'DELIVERED'] },
      paidAt: { gte: start, lt: end },
    },
    select: { priceCents: true },
  });
  const revenueCents = paidOrders.reduce((sum, o) => sum + o.priceCents, 0);
  const paidCount = paidOrders.length;

  // Spend de ads do dia (AdInsight).
  const insights = await ctx.prisma.adInsight.findMany({
    where: { date: { gte: start, lt: end } },
    select: { spendCents: true, conversions: true },
  });
  const spendCents = insights.reduce((sum, i) => sum + i.spendCents, 0);
  const conversions = insights.reduce((sum, i) => sum + i.conversions, 0);

  // Custo de LLM dos agentes no dia (AgentRun.costCents).
  const runs = await ctx.prisma.agentRun.findMany({
    where: { startedAt: { gte: start, lt: end } },
    select: { costCents: true },
  });
  const llmCostCents = runs.reduce((sum, r) => sum + (r.costCents ?? 0), 0);

  const targetRevenueCents = Math.round(ctx.env.TARGET_DAILY_REVENUE_BRL * 100);
  const profitCents = revenueCents - spendCents - llmCostCents;

  const roas = spendCents > 0 ? revenueCents / spendCents : undefined;
  const roi = spendCents > 0 ? (revenueCents - spendCents) / spendCents : undefined;
  const cacCents =
    paidCount > 0 && spendCents > 0 ? Math.round(spendCents / paidCount) : undefined;
  const cpaCents =
    conversions > 0 && spendCents > 0 ? Math.round(spendCents / conversions) : undefined;
  const aovCents = paidCount > 0 ? Math.round(revenueCents / paidCount) : undefined;

  return {
    date: dateStr,
    revenueCents,
    spendCents,
    profitCents,
    llmCostCents,
    paidOrders: paidCount,
    roas,
    roi,
    cacCents,
    cpaCents,
    aovCents,
    targetRevenueCents,
    metTarget: revenueCents >= targetRevenueCents,
  };
}

// Limites do dia em America/Sao_Paulo (UTC-3, sem DST desde 2019).
// Conversao simples e deterministica (sem dependencia externa de timezone).
function dayBoundsSaoPaulo(now: Date): { start: Date; end: Date; dateStr: string } {
  const OFFSET_MS = 3 * 60 * 60 * 1000; // BRT = UTC-3
  const local = new Date(now.getTime() - OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  // Meia-noite local em BRT, convertida de volta para UTC.
  const startUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) + OFFSET_MS);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { start: startUtc, end: endUtc, dateStr };
}
