// Scheduler — UNICO dono do setInterval do processo Fastify.
// server.ts (Fundacao) importa dinamicamente startScheduler(app), gated por
// env.ENABLE_AGENTS. Aqui montamos o AgentContext (Prisma + ports + env + log
// + clock) e disparamos o ciclo do OrchestratorAgent em cadencia configuravel.
//
// Padrao do projeto venda-mais: trabalho de fundo roda DENTRO da API via
// setInterval; nao ha worker separado.
//
// Escrita disjunta: este arquivo NAO acopla a nomes concretos de fabricas de
// adapters nem a classes de agentes-filho de outros donos. Ele resolve os ports
// e os agentes-filho via import dinamico DEFENSIVO de @ebook-empire/adapters e
// @ebook-empire/agents, com fallback seguro quando algo ainda nao existe.

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

import type { AgentName, NotificationPort, Ports } from '@ebook-empire/core';
import {
  Agent,
  OrchestratorAgent,
  OperationsAgent,
  GuardedActionExecutor,
  createLiveLevers,
  systemClock,
  type AgentContext,
  type AgentEnv,
  type AgentLogger,
  type AgentRegistry,
  type AlertNotifier,
  type HealthCollector,
  type DiagnosisEngine,
  type ActionCatalog,
} from '@ebook-empire/agents';

import { env, CONTENT_MODEL, PLANNING_MODEL } from './env.js';
import { prisma } from './db.js';
import { buildEbookPdf } from './lib/pdf.js';

// ------------------------------------------------------------
// Monta o AgentEnv (subconjunto do env validado + constantes de modelo).
// ------------------------------------------------------------
export function buildAgentEnv(): AgentEnv {
  return {
    ENABLE_AGENTS: env.ENABLE_AGENTS,
    MAX_AD_BUDGET_BRL: env.MAX_AD_BUDGET_BRL,
    TARGET_DAILY_REVENUE_BRL: env.TARGET_DAILY_REVENUE_BRL,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
    CONTENT_MODEL,
    PLANNING_MODEL,
    // Mercado + QA (setores MARKET_RESEARCH / EBOOK_QA). Os services leem
    // ctx.env.MARKET_*/QA_* via a index-signature numerica/string do AgentEnv,
    // necessario para o pipeline de lancamento (GATES) rodar no loop autonomo.
    MARKET_DATA_PROVIDER: env.MARKET_DATA_PROVIDER,
    MARKET_SEARCH_GL: env.MARKET_SEARCH_GL,
    MARKET_SEARCH_HL: env.MARKET_SEARCH_HL,
    MARKET_RESEARCH_WINDOW_DAYS: env.MARKET_RESEARCH_WINDOW_DAYS,
    MARKET_MAX_QUERIES_PER_RUN: env.MARKET_MAX_QUERIES_PER_RUN,
    QA_MIN_SCORE: env.QA_MIN_SCORE,
    QA_MAX_FIX_ITERATIONS: env.QA_MAX_FIX_ITERATIONS,
    QA_FAIL_SCORE: env.QA_FAIL_SCORE,
    QA_AUDIT_STALE_HOURS: env.QA_AUDIT_STALE_HOURS,
  };
}

// ------------------------------------------------------------
// Resolucao do bundle de Ports a partir de @ebook-empire/adapters.
// Import DINAMICO (escrita disjunta / build paralelo): nao acoplamos a
// compilacao deste arquivo aos arquivos dos donos dos adapters. Cada fabrica
// recebe o config/env derivado do env JA validado (env.ts). Alterna real<->stub
// por USE_STUBS (lido por cada adapter).
// ------------------------------------------------------------
async function resolvePorts(): Promise<Ports> {
  const adapters = (await import('@ebook-empire/adapters')) as Record<string, unknown>;

  const need = (name: string): ((arg: unknown) => unknown) => {
    const fn = adapters[name];
    if (typeof fn !== 'function') {
      throw new Error(`adapter factory ausente: '${name}' nao exportado por @ebook-empire/adapters`);
    }
    return fn as (arg: unknown) => unknown;
  };

  const ports = {
    llm: need('createLLMAdapter')({
      USE_STUBS: env.USE_STUBS,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    }),
    payment: need('createPaymentAdapter')({
      USE_STUBS: env.USE_STUBS,
      PAYMENT_PROVIDER: env.PAYMENT_PROVIDER,
      ASAAS_API_KEY: env.ASAAS_API_KEY,
      ASAAS_WEBHOOK_TOKEN: env.ASAAS_WEBHOOK_TOKEN,
    }),
    email: need('createEmailAdapter')({
      useStubs: env.USE_STUBS,
      provider: env.RESEND_API_KEY ? 'resend' : undefined,
      resendApiKey: env.RESEND_API_KEY,
    }),
    storage: need('createStorageAdapter')({
      driver: 'local',
      storageDir: env.STORAGE_DIR,
      signingSecret: env.JWT_SECRET,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    }),
    instagram: need('createInstagramAdapter')({
      USE_STUBS: env.USE_STUBS,
      META_GRAPH_TOKEN: env.META_GRAPH_TOKEN,
      META_AD_ACCOUNT_ID: env.META_AD_ACCOUNT_ID,
    }),
    ads: need('createAdsAdapter')({
      useStubs: env.USE_STUBS,
      metaGraphToken: env.META_GRAPH_TOKEN,
      metaAdAccountId: env.META_AD_ACCOUNT_ID,
    }),
  } as Ports;

  // MarketDataPort (setor MARKET_RESEARCH — modulo 2). OPCIONAL no bundle Ports:
  // resolvido DEFENSIVAMENTE (o adapter pode ainda nao existir — escrita disjunta).
  // Ausente => o GATE de mercado do pipeline de lancamento aborta com motivo claro.
  const makeMarketData = adapters.createMarketDataAdapter;
  if (typeof makeMarketData === 'function') {
    try {
      ports.marketData = (makeMarketData as (cfg: unknown) => Ports['marketData'])({
        USE_STUBS: env.USE_STUBS,
        MARKET_DATA_PROVIDER: env.MARKET_DATA_PROVIDER,
        SERPER_API_KEY: env.SERPER_API_KEY,
        MARKET_SEARCH_GL: env.MARKET_SEARCH_GL,
        MARKET_SEARCH_HL: env.MARKET_SEARCH_HL,
      });
    } catch {
      // segue sem marketData — GATE de mercado tratara a ausencia.
    }
  }

  // MarketplacePort (Hotmart/Kiwify — Fase 3). DEFENSIVO. O factory devolve um
  // MAPA por provedor (Record<provider, MarketplacePort>); o MarketplaceAgent
  // (resolveProviderPort) consome tanto o mapa quanto uma porta unica, lendo
  // ctx.ports.marketplace como unknown — por isso o cast para o tipo (mais
  // estreito) de Ports. Sem isso o MarketplaceAgent roda mas faz SKIP (sem porta).
  const makeMarketplace = adapters.createMarketplaceAdapter;
  if (typeof makeMarketplace === 'function') {
    try {
      ports.marketplace = (
        makeMarketplace as (cfg: unknown, storage: unknown) => unknown
      )(
        {
          USE_STUBS: env.USE_STUBS,
          HOTMART_CLIENT_ID: env.HOTMART_CLIENT_ID,
          HOTMART_CLIENT_SECRET: env.HOTMART_CLIENT_SECRET,
          HOTMART_WEBHOOK_TOKEN: env.HOTMART_WEBHOOK_TOKEN,
          KIWIFY_API_KEY: env.KIWIFY_API_KEY,
          KIWIFY_ACCOUNT_ID: env.KIWIFY_ACCOUNT_ID,
          KIWIFY_WEBHOOK_SECRET: env.KIWIFY_WEBHOOK_SECRET,
          MARKETPLACE_AFFILIATE_COMMISSION_PCT: env.MARKETPLACE_AFFILIATE_COMMISSION_PCT,
        },
        ports.storage,
      ) as Ports['marketplace'];
    } catch {
      // segue sem marketplace — MarketplaceAgent faz SKIP com motivo.
    }
  }

  // WhatsAppPort (afiliados — Fase 4). DEFENSIVO. Ausente => AffiliateOutreachAgent
  // contata apenas por email (degrada via ctx.ports.whatsapp?).
  const makeWhatsApp = adapters.createWhatsAppAdapter;
  if (typeof makeWhatsApp === 'function') {
    try {
      ports.whatsapp = (makeWhatsApp as (cfg: unknown) => Ports['whatsapp'])({
        useStubs: env.USE_STUBS,
        whatsappProvider: env.WHATSAPP_PROVIDER,
        evolutionApiUrl: env.EVOLUTION_API_URL,
        evolutionApiKey: env.EVOLUTION_API_KEY,
        evolutionInstance: env.EVOLUTION_INSTANCE,
      });
    } catch {
      // segue sem whatsapp — outreach de afiliado so por email.
    }
  }

  return ports;
}

// ------------------------------------------------------------
// Resolucao DEFENSIVA do registro de agentes-filho a partir de
// @ebook-empire/agents. Para cada AgentName procura uma classe concreta
// (ex. ContentAgent) com construtor sem argumentos obrigatorios. Agentes
// ainda nao implementados sao simplesmente omitidos do registro (o
// orchestrator os trata como SKIPPED).
// ------------------------------------------------------------
// OPERATIONS (COO) NAO e um agente-filho do orchestrator: tem factory propria
// (createOperationsAgent) e roda no loop FAST. Por isso fica fora deste registro.
// MARKETPLACE e AFFILIATE tambem rodam por tick proprio (FAST/SLOW, abaixo);
// FUNNEL e apenas setor (sem agente despachado). Todos excluidos do registro
// de agentes-filho do orchestrator (CYCLE_ORDER inalterado).
const CHILD_CLASS_NAMES: Record<
  Exclude<
    AgentName,
    | 'ORCHESTRATOR'
    | 'OPERATIONS'
    | 'MARKET_RESEARCH'
    | 'EBOOK_QA'
    | 'MARKETPLACE'
    | 'AFFILIATE'
    | 'FUNNEL'
  >,
  string
> = {
  CONTENT: 'ContentAgent',
  SALES: 'SalesAgent',
  DELIVERY: 'DeliveryAgent',
  SOCIAL: 'SocialAgent',
  TRAFFIC: 'TrafficAgent',
  ANALYTICS: 'AnalyticsAgent',
};

async function resolveRegistry(app: FastifyInstance): Promise<AgentRegistry> {
  const mod = (await import('@ebook-empire/agents')) as Record<string, unknown>;
  const registry: AgentRegistry = new Map();

  for (const [agentName, className] of Object.entries(CHILD_CLASS_NAMES)) {
    const Ctor = mod[className];
    if (typeof Ctor !== 'function') {
      app.log.warn(
        { agent: agentName, className },
        'agente-filho ainda nao implementado — sera tratado como SKIPPED',
      );
      continue;
    }
    try {
      // ContentAgent aceita um builder de PDF injetavel — passamos o real
      // (lib/pdf.ts) para gerar PDFs de verdade. Os demais usam ctor vazio.
      const instance =
        agentName === 'CONTENT'
          ? new (Ctor as new (pdf: typeof buildEbookPdf) => unknown)(buildEbookPdf)
          : new (Ctor as new () => unknown)();
      if (instance instanceof Agent) {
        registry.set(agentName as AgentName, instance);
      }
    } catch (err) {
      app.log.warn(
        { agent: agentName, err: err instanceof Error ? err.message : String(err) },
        'falha ao instanciar agente-filho — omitido do registro',
      );
    }
  }

  return registry;
}

// ------------------------------------------------------------
// Resolucao DEFENSIVA do AlertService (Feature 1 — alertas externos).
//
// Escrita disjunta: o AlertService e dono do MODULO 1 (packages/agents/src/
// alerts/alert-service.ts). Resolvemos por import dinamico tolerante para que o
// scheduler compile e rode mesmo antes do AlertService existir (fallback: COO e
// rotas rodam sem alertas — ctx.alert fica undefined e o optional chaining cobre).
//
// Reaproveita o EmailPort JA resolvido em resolvePorts (config 3.3 do ALERTS.md)
// e monta a NotificationPort via createNotificationChannels (adapters), alternando
// real<->stub por USE_STUBS / WHATSAPP_PROVIDER.
// ------------------------------------------------------------
let alertSingleton: AlertNotifier | null = null;
let alertResolved = false;
// NotificationPort crua (fan-out direto de canais) — usada pela rota POST
// /alerts/test, que precisa do resultado POR CANAL (o AlertService.notify devolve
// void). Resolvida junto com o AlertService no mesmo passo (mesmas envs/stubs).
let notificationSingleton: NotificationPort | null = null;

/**
 * Resolve (uma unica vez) o AlertService como AlertNotifier. Monta a
 * NotificationPort (createNotificationChannels) e injeta prisma/clock/log.
 * Retorna null se o AlertService ainda nao foi publicado pelo MODULO 1.
 */
async function resolveAlert(app: FastifyInstance): Promise<AlertNotifier | null> {
  if (alertResolved) return alertSingleton;
  alertResolved = true;

  const log: AgentLogger = makeLogger(app);

  try {
    const adapters = (await import('@ebook-empire/adapters')) as Record<string, unknown>;
    const makeChannels = adapters.createNotificationChannels;
    if (typeof makeChannels !== 'function') {
      app.log.warn('alertas: createNotificationChannels ausente — alertas desabilitados');
      return null;
    }

    const notification = (makeChannels as (cfg: unknown) => NotificationPort)({
      useStubs: env.USE_STUBS,
      whatsappProvider: env.WHATSAPP_PROVIDER,
      emailProvider: env.RESEND_API_KEY ? 'resend' : undefined,
      resendApiKey: env.RESEND_API_KEY,
      evolutionApiUrl: env.EVOLUTION_API_URL,
      evolutionApiKey: env.EVOLUTION_API_KEY,
      evolutionInstance: env.EVOLUTION_INSTANCE,
    });
    notificationSingleton = notification;

    const mod = (await import('@ebook-empire/agents')) as Record<string, unknown>;
    const AlertServiceCtor = mod.AlertService;
    if (typeof AlertServiceCtor !== 'function') {
      app.log.warn('alertas: AlertService ainda nao publicado (MODULO 1) — alertas desabilitados');
      return null;
    }

    // AlertService({ prisma, notifier, log, clock? }) — ver AlertServiceDeps.
    alertSingleton = new (AlertServiceCtor as new (deps: {
      prisma: typeof prisma;
      notifier: NotificationPort;
      log: AgentLogger;
      clock?: typeof systemClock;
    }) => AlertNotifier)({ prisma, notifier: notification, log, clock: systemClock });

    app.log.info({ useStubs: env.USE_STUBS, whatsapp: env.WHATSAPP_PROVIDER }, 'alertas: AlertService composto');
    return alertSingleton;
  } catch (err) {
    app.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'alertas: falha ao compor AlertService — seguindo sem alertas',
    );
    return null;
  }
}

/** Logger AgentLogger derivado do logger do Fastify. */
function makeLogger(app: FastifyInstance): AgentLogger {
  return {
    debug: (obj, msg) => app.log.debug(obj as object, msg),
    info: (obj, msg) => app.log.info(obj as object, msg),
    warn: (obj, msg) => app.log.warn(obj as object, msg),
    error: (obj, msg) => app.log.error(obj as object, msg),
  };
}

// ------------------------------------------------------------
// Monta um AgentContext novo para cada ciclo (cycleId unico por tick).
// O alert (AlertNotifier) e OPCIONAL: injetado quando o MODULO 1 ja publicou o
// AlertService; ausente caso contrario (optional chaining nos gatilhos cobre).
// ------------------------------------------------------------
export function buildOrchestratorContext(
  app: FastifyInstance,
  ports: Ports,
  cycleId: string,
  alert?: AlertNotifier | null,
): AgentContext {
  const log: AgentLogger = makeLogger(app);

  return {
    prisma,
    ports,
    env: buildAgentEnv(),
    log,
    clock: systemClock,
    cycleId,
    ...(alert ? { alert } : {}),
  };
}

// ------------------------------------------------------------
// Singletons do scheduler (ports + orchestrator vivem o processo todo).
// ------------------------------------------------------------
let portsSingleton: Ports | null = null;
let orchestratorSingleton: OrchestratorAgent | null = null;

async function getOrchestrator(app: FastifyInstance): Promise<{
  ports: Ports;
  orchestrator: OrchestratorAgent;
}> {
  if (!portsSingleton) portsSingleton = await resolvePorts();
  if (!orchestratorSingleton) {
    const registry = await resolveRegistry(app);
    orchestratorSingleton = new OrchestratorAgent({ registry });
  }
  return { ports: portsSingleton, orchestrator: orchestratorSingleton };
}

// ------------------------------------------------------------
// COMPOSICAO DO OperationsAgent (COO) — factory que monta as 4 implementacoes
// concretas do CRM e injeta no OperationsAgent (DI por construtor).
//
// As classes concretas (DbHealthCollector / RuleDiagnosisEngine /
// StaticActionCatalog / GuardedActionExecutor) sao de OUTROS donos. Resolvemos
// DEFENSIVAMENTE via import dinamico (escrita disjunta / build paralelo): se
// alguma ainda nao existe, o COO simplesmente nao e agendado (sem quebrar o
// loop do orchestrator). Os nomes esperados sao convencao do modulo CRM.
// ------------------------------------------------------------
// O executor (GuardedActionExecutor) NAO tem ctor vazio: exige RemediationLevers.
// Por isso e composto explicitamente abaixo (new GuardedActionExecutor(createLiveLevers())),
// fora do helper generico build<T>() que so serve para ctors sem argumentos.
const CRM_CLASS_NAMES = {
  collector: 'DbHealthCollector',
  diagnosis: 'RuleDiagnosisEngine',
  catalog: 'StaticActionCatalog',
} as const;

let operationsSingleton: OperationsAgent | null = null;
let operationsResolved = false; // ja tentamos resolver (evita reimportar a cada tick)
// Mesmo GuardedActionExecutor usado pelo COO — reaproveitado pelas rotas HTTP
// /approve (applyApprovedAction) e /rollback (rollbackAction) para fechar o
// ciclo HIGH ponta a ponta (HUMAN). Composto em createOperationsAgent.
let executorSingleton: GuardedActionExecutor | null = null;

/**
 * Compoe o OperationsAgent com as implementacoes concretas do CRM. Retorna null
 * (uma unica vez logando warn) se alguma dependencia ainda nao foi implementada.
 */
export async function createOperationsAgent(
  app: FastifyInstance,
): Promise<OperationsAgent | null> {
  const mod = (await import('@ebook-empire/agents')) as Record<string, unknown>;

  // Cada implementacao concreta usa ctor sem argumentos obrigatorios (toda
  // dependencia de runtime — prisma/ports/env — vem pelo AgentContext em cada
  // chamada). Se o ctor exigir args, ajustar aqui no dono do scheduler.
  const build = <T>(key: keyof typeof CRM_CLASS_NAMES): T | null => {
    const Ctor = mod[CRM_CLASS_NAMES[key]];
    if (typeof Ctor !== 'function') return null;
    try {
      return new (Ctor as new () => T)();
    } catch (err) {
      app.log.warn(
        { className: CRM_CLASS_NAMES[key], err: err instanceof Error ? err.message : String(err) },
        'COO: falha ao instanciar dependencia do CRM',
      );
      return null;
    }
  };

  const collector = build<HealthCollector>('collector');
  const diagnosis = build<DiagnosisEngine>('diagnosis');
  const catalog = build<ActionCatalog>('catalog');

  // Executor: composto explicitamente com as alavancas concretas (LiveRemediationLevers)
  // que ligam Delivery/Content/Social/Analytics/Sales/Traffic + adapters + DB. SEM as
  // levers, this.levers fica undefined e TODA acao LOW lanca no runtime.
  let executor: GuardedActionExecutor | null = null;
  try {
    executor = new GuardedActionExecutor(createLiveLevers());
  } catch (err) {
    app.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'COO: falha ao compor GuardedActionExecutor com levers',
    );
  }

  if (!collector || !diagnosis || !catalog || !executor) {
    app.log.warn(
      {
        collector: !!collector,
        diagnosis: !!diagnosis,
        catalog: !!catalog,
        executor: !!executor,
      },
      'COO: dependencias do CRM ainda incompletas — OperationsAgent nao sera agendado',
    );
    return null;
  }

  // Guarda o executor para reuso pelas rotas HTTP (applyApprovedAction/rollbackAction).
  executorSingleton = executor;
  return new OperationsAgent(collector, diagnosis, catalog, executor);
}

/** Garante que o executor (e o COO) ja foram compostos; retorna o executor ou null. */
async function getExecutor(app: FastifyInstance): Promise<GuardedActionExecutor | null> {
  await getOperationsAgent(app); // popula executorSingleton via createOperationsAgent
  return executorSingleton;
}

async function getOperationsAgent(app: FastifyInstance): Promise<OperationsAgent | null> {
  if (!operationsResolved) {
    operationsSingleton = await createOperationsAgent(app);
    operationsResolved = true;
  }
  return operationsSingleton;
}

// ------------------------------------------------------------
// Agentes de tick proprio (NAO sao filhos do orchestrator / nao entram no
// CYCLE_ORDER do CEO): MarketplaceAgent roda no loop FAST (junto do COO/Delivery),
// AffiliateOutreachAgent roda no loop SLOW. Resolvidos DEFENSIVAMENTE por nome de
// classe via import dinamico de @ebook-empire/agents (escrita disjunta / build
// paralelo): se a classe ainda nao existe (P3/P4), o agente e omitido e o tick
// segue sem ele — sem quebrar o loop. Cada um tem ctor sem argumentos
// obrigatorios (dependencias de runtime vem pelo AgentContext).
// ------------------------------------------------------------
const MARKETPLACE_CLASS_NAME = 'MarketplaceAgent';
const AFFILIATE_CLASS_NAME = 'AffiliateOutreachAgent';

let marketplaceSingleton: Agent | null = null;
let marketplaceResolved = false;
let affiliateSingleton: Agent | null = null;
let affiliateResolved = false;

async function resolveTickAgent(
  app: FastifyInstance,
  className: string,
): Promise<Agent | null> {
  const mod = (await import('@ebook-empire/agents')) as Record<string, unknown>;
  const Ctor = mod[className];
  if (typeof Ctor !== 'function') {
    app.log.warn(
      { className },
      'agente de tick proprio ainda nao implementado — sera omitido do loop',
    );
    return null;
  }
  try {
    const instance = new (Ctor as new () => unknown)();
    return instance instanceof Agent ? instance : null;
  } catch (err) {
    app.log.warn(
      { className, err: err instanceof Error ? err.message : String(err) },
      'falha ao instanciar agente de tick proprio — omitido',
    );
    return null;
  }
}

async function getMarketplaceAgent(app: FastifyInstance): Promise<Agent | null> {
  if (!marketplaceResolved) {
    marketplaceSingleton = await resolveTickAgent(app, MARKETPLACE_CLASS_NAME);
    marketplaceResolved = true;
  }
  return marketplaceSingleton;
}

async function getAffiliateAgent(app: FastifyInstance): Promise<Agent | null> {
  if (!affiliateResolved) {
    affiliateSingleton = await resolveTickAgent(app, AFFILIATE_CLASS_NAME);
    affiliateResolved = true;
  }
  return affiliateSingleton;
}

/**
 * Dispara um unico ciclo de um agente de tick proprio (MarketplaceAgent /
 * AffiliateOutreachAgent). Monta o AgentContext reaproveitando ports/alert do
 * scheduler. Tolerante a ausencia (loga e segue). execute() nunca lanca.
 */
async function runTickAgent(app: FastifyInstance, agent: Agent | null): Promise<void> {
  if (!agent) return;
  if (!portsSingleton) portsSingleton = await resolvePorts();
  const alert = await resolveAlert(app);
  const ctx = buildOrchestratorContext(app, portsSingleton, randomUUID(), alert);
  await agent.execute(ctx); // nunca lanca
}

// Guarda anti-reentrancia SEPARADA do orchestrator: o tick FAST (COO) e o tick
// SLOW (CEO) rodam independentes e nao devem bloquear um ao outro.
let opsRunning = false;

/**
 * Dispara um unico ciclo do OperationsAgent (COO). Exposto para a rota
 * POST /crm/scan (disparo manual) e usado pelo loop FAST do setInterval.
 * Retorna o id do AgentRun do ciclo, ou status 'UNAVAILABLE' se o COO ainda
 * nao pode ser composto (dependencias do CRM incompletas).
 */
export async function runOperationsCycle(app: FastifyInstance): Promise<{
  cycleId: string;
  runId?: string;
  status: string;
}> {
  const ops = await getOperationsAgent(app);
  const cycleId = randomUUID();
  if (!ops) {
    return { cycleId, status: 'UNAVAILABLE' };
  }

  if (!portsSingleton) portsSingleton = await resolvePorts();
  // Injeta o AlertNotifier no contexto do COO: e o agente que detecta transicao
  // para CRITICAL, falha de acao AUTO e enfileiramento HIGH (gatilhos Feature 1).
  const alert = await resolveAlert(app);
  const ctx = buildOrchestratorContext(app, portsSingleton, cycleId, alert);

  app.log.info({ cycleId }, 'COO: iniciando ciclo de operacoes');
  const record = await ops.execute(ctx); // nunca lanca
  app.log.info({ cycleId, status: record.status }, 'COO: ciclo de operacoes concluido');

  return { cycleId, runId: record.id, status: record.status };
}

// ------------------------------------------------------------
// APLICACAO HUMANA de uma acao HIGH ja APPROVED (rota POST /crm/actions/:id/approve).
// Reusa o MESMO GuardedActionExecutor do COO chamando applyWith(triggeredBy=HUMAN,
// humanApproved=true). Fecha o ciclo HIGH ponta a ponta via HTTP (200/APPLIED em vez
// de 202). A rota ja validou riskTier=HIGH, status e teto financeiro.
// ------------------------------------------------------------
export async function applyApprovedAction(
  app: FastifyInstance,
  actionId: string,
): Promise<{ success: boolean; error?: string; blockedByGuardrail?: string }> {
  const executor = await getExecutor(app);
  if (!executor) {
    return { success: false, error: 'executor do CRM indisponivel (dependencias incompletas)' };
  }

  const row = await prisma.remediationAction.findUnique({ where: { id: actionId } });
  if (!row) {
    return { success: false, error: 'acao nao encontrada' };
  }

  if (!portsSingleton) portsSingleton = await resolvePorts();
  const ctx = buildOrchestratorContext(app, portsSingleton, randomUUID());

  const result = await executor.applyWith(
    ctx,
    {
      id: row.id,
      problemId: row.problemId,
      kind: row.kind,
      riskTier: row.riskTier,
      params: row.params as never,
      expectedEffect: row.expectedEffect,
      status: row.status,
      reversible: row.reversible,
      dedupeKey: row.dedupeKey,
      appliedAt: row.appliedAt,
    },
    { triggeredBy: 'HUMAN', humanApproved: true },
  );

  return {
    success: result.success,
    error: result.error,
    blockedByGuardrail: result.blockedByGuardrail,
  };
}

// ------------------------------------------------------------
// ROLLBACK de uma acao reversivel APLICADA (rota POST /crm/actions/:id/rollback).
// Recebe o id da ActionExecution bem-sucedida a reverter e delega ao executor,
// que restaura o beforeState e audita o rollback (triggeredBy=HUMAN, isRollback=true).
// ------------------------------------------------------------
export async function rollbackAction(
  app: FastifyInstance,
  executionId: string,
): Promise<{ success: boolean; error?: string }> {
  const executor = await getExecutor(app);
  if (!executor) {
    return { success: false, error: 'executor do CRM indisponivel (dependencias incompletas)' };
  }

  const exec = await prisma.actionExecution.findUnique({ where: { id: executionId } });
  if (!exec) {
    return { success: false, error: 'execucao nao encontrada' };
  }

  if (!portsSingleton) portsSingleton = await resolvePorts();
  const ctx = buildOrchestratorContext(app, portsSingleton, randomUUID());

  const result = await executor.rollback(ctx, {
    id: exec.id,
    actionId: exec.actionId,
    success: exec.success,
    beforeState: exec.beforeState as never,
    afterState: exec.afterState as never,
    error: exec.error,
    triggeredBy: exec.triggeredBy,
    isRollback: exec.isRollback,
    startedAt: exec.startedAt,
    finishedAt: exec.finishedAt,
  });

  return { success: result.success, error: result.error };
}

// ------------------------------------------------------------
// Exposicao do AlertNotifier para a rota POST /crm/killswitch (dono do WIRING).
// A rota dispara KILL_SWITCH_ON/OFF via este notificador apos o upsert do switch.
// Resolve o mesmo singleton usado pelo COO (idempotente). Pode ser null se o
// AlertService ainda nao foi publicado (MODULO 1) — a rota trata com optional.
// ------------------------------------------------------------
export async function getAlert(app: FastifyInstance): Promise<AlertNotifier | null> {
  return resolveAlert(app);
}

/**
 * Exposicao da NotificationPort crua para a rota POST /alerts/test, que precisa
 * do resultado POR CANAL (SENT/FAILED). Garante a resolucao (mesmo passo do
 * AlertService) e devolve o fan-out de canais (ou null se os adapters de
 * notificacao ainda nao estao disponiveis).
 */
export async function getNotification(app: FastifyInstance): Promise<NotificationPort | null> {
  await resolveAlert(app);
  return notificationSingleton;
}

// Guarda anti-reentrancia: nao sobrepoe ciclos se um tick demorar mais que o intervalo.
let cycleRunning = false;

/**
 * Dispara um unico ciclo do orchestrator. Exposto para a rota
 * POST /agents/cycle (disparo manual) e usado pelo loop do setInterval.
 * Retorna o id do AgentRun do ciclo (ORCHESTRATOR).
 */
export async function runOneCycle(app: FastifyInstance): Promise<{
  cycleId: string;
  runId: string;
  status: string;
}> {
  const { ports, orchestrator } = await getOrchestrator(app);
  const cycleId = randomUUID();
  const ctx = buildOrchestratorContext(app, ports, cycleId);

  app.log.info({ cycleId }, 'orchestrator: iniciando ciclo');
  const record = await orchestrator.execute(ctx); // nunca lanca
  app.log.info({ cycleId, status: record.status }, 'orchestrator: ciclo concluido');

  return { cycleId, runId: record.id, status: record.status };
}

/**
 * Inicia o loop autonomo. Chamado por server.ts no boot (gated por ENABLE_AGENTS).
 * Cadencia = env.SLOW_TICK_MS (planejamento/decisao do CEO).
 * Registra o handle no app para limpeza no onClose.
 */
export function startScheduler(app: FastifyInstance): void {
  if (!env.ENABLE_AGENTS) {
    app.log.info('scheduler desabilitado (ENABLE_AGENTS=false)');
    return;
  }

  const intervalMs = env.SLOW_TICK_MS;
  app.log.info(
    { intervalMs, useStubs: env.USE_STUBS },
    'scheduler: iniciando loop autonomo do orchestrator',
  );

  const tick = async (): Promise<void> => {
    if (cycleRunning) {
      app.log.warn('scheduler: ciclo anterior ainda em execucao — pulando tick');
      return;
    }
    cycleRunning = true;
    try {
      await runOneCycle(app);
      // AffiliateOutreachAgent roda na cadencia SLOW (tick proprio, fora do
      // CYCLE_ORDER do orchestrator). Tolerante a ausencia (P4).
      await runTickAgent(app, await getAffiliateAgent(app));
    } catch (err) {
      // execute() nao lanca, mas defendemos o loop de qualquer erro de infra.
      app.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'scheduler: erro inesperado no tick',
      );
    } finally {
      cycleRunning = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  // Nao segura o event loop no shutdown.
  if (typeof handle.unref === 'function') handle.unref();

  // ------------------------------------------------------------
  // Loop FAST (COO) — cadencia = env.FAST_TICK_MS. Roda o OperationsAgent
  // independente do loop SLOW do orchestrator (guard opsRunning proprio).
  // ------------------------------------------------------------
  const fastIntervalMs = env.FAST_TICK_MS;
  app.log.info(
    { fastIntervalMs },
    'scheduler: iniciando loop FAST do OperationsAgent (COO)',
  );

  const fastTick = async (): Promise<void> => {
    if (opsRunning) {
      app.log.warn('scheduler: ciclo COO anterior ainda em execucao — pulando tick FAST');
      return;
    }
    opsRunning = true;
    try {
      await runOperationsCycle(app);
      // MarketplaceAgent roda na cadencia FAST (tick proprio, junto do COO/Delivery,
      // fora do CYCLE_ORDER do orchestrator). Tolerante a ausencia (P3).
      await runTickAgent(app, await getMarketplaceAgent(app));
    } catch (err) {
      app.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'scheduler: erro inesperado no tick FAST (COO)',
      );
    } finally {
      opsRunning = false;
    }
  };

  const fastHandle = setInterval(() => {
    void fastTick();
  }, fastIntervalMs);
  if (typeof fastHandle.unref === 'function') fastHandle.unref();

  // Limpeza no shutdown do Fastify.
  app.addHook('onClose', async () => {
    clearInterval(handle);
    clearInterval(fastHandle);
  });
}
