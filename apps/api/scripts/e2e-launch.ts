// E2E do PIPELINE DE LANCAMENTO (MARKET_RESEARCH + CONTENT + EBOOK_QA) contra
// Postgres REAL (5433). Espelha o padrao de apps/api/scripts/e2e-crm.ts:
// buildServer + app.inject para as rotas HTTP, agentes/servicos diretos para o
// pipeline, limpando as tabelas no inicio. USE_STUBS=true (LLM/market data stub).
//
// Prova ponta a ponta, com os DOIS GATES:
//   (a) POST /market/scan rankeia e PERSISTE MarketOpportunity; GET /market/top
//       devolve a de MAIOR potentialScore (status SELECTED).
//   (b) GATE 1 (mercado): tentar lancar SEM oportunidade => recusado em MARKET_GATE
//       e NENHUM ebook e criado.
//   (c) Com oportunidade, o pipeline gera um Ebook DRAFT VINCULADO
//       (Ebook.marketOpportunityId == oportunidade selecionada).
//   (d) EbookQA: cenario NEEDS_FIX -> loop corrige -> PASS => Ebook PUBLISHED +
//       Product ativo (lancado). Cenario FAIL => NAO publica (continua DRAFT).
//   (e) Auditoria de um ebook EXISTENTE ruim retorna issues; o fix-loop relança.
//   (f) Os papeis SPECIALIST/STRATEGIST/EXECUTOR aparecem como AgentRun com
//       role+sector (observabilidade dos times).
//
// Roda com: pnpm --filter @ebook-empire/api e2e:launch
//        ou: node --import tsx scripts/e2e-launch.ts  (a partir de apps/api)

import type {
  Ports,
  PaymentPort,
  InstagramPort,
  EmailPort,
  AdsPort,
  StoragePort,
  LLMPort,
  MarketDataPort,
  LLMGenerateTextInput,
  LLMGenerateTextResult,
  LLMGenerateJsonInput,
  LLMGenerateJsonResult,
} from '@ebook-empire/core';
import {
  EbookQaService,
  FixStrategist,
  RelaunchExecutor,
  createAndLaunchEbook,
  ContentAgent,
  createDefaultPublish,
  type AgentContext,
  type AgentEnv,
  type MarketResearchCapability,
  type EbookQaCapability,
} from '@ebook-empire/agents';
import type { EbookAudit } from '@ebook-empire/core';
import { createLLMAdapter, createMarketDataAdapter } from '@ebook-empire/adapters';

import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { env, CONTENT_MODEL, PLANNING_MODEL } from '../src/env.js';

// ---- logger e clock minimos ----
const log = {
  debug: () => {},
  info: (_o: unknown, _m?: string) => {},
  warn: (_o: unknown, _m?: string) => {},
  error: (o: unknown, m?: string) => console.error('  [error]', m ?? '', o),
};
const clock = { now: () => new Date() };

// ---- ports nao usados pelo pipeline (lancam se chamados por engano) ----
const notImpl = (n: string): never => {
  throw new Error(`${n} indisponivel neste e2e`);
};
const unusedPayment: PaymentPort = {
  createPixCharge: () => notImpl('payment.createPixCharge'),
  getPayment: () => notImpl('payment.getPayment'),
  parseWebhook: () => notImpl('payment.parseWebhook'),
};
const unusedInstagram: InstagramPort = {
  publishPost: () => notImpl('instagram.publishPost'),
  uploadMedia: () => notImpl('instagram.uploadMedia'),
  getAccountInsights: () => notImpl('instagram.getAccountInsights'),
  getPostInsights: () => notImpl('instagram.getPostInsights'),
};
const unusedEmail: EmailPort = { send: () => notImpl('email.send') };
const unusedAds: AdsPort = {
  createCampaign: () => notImpl('ads.createCampaign'),
  updateBudget: () => notImpl('ads.updateBudget'),
  setStatus: () => notImpl('ads.setStatus'),
  getInsights: () => notImpl('ads.getInsights'),
};
const noopStorage: StoragePort = {
  async putObject() {},
  async getObject() {
    return Buffer.from('');
  },
  async getSignedUrl(key) {
    return `${env.PUBLIC_BASE_URL}/storage/${encodeURIComponent(key)}`;
  },
};

const stubLlm = createLLMAdapter({
  USE_STUBS: env.USE_STUBS,
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
});
const marketData: MarketDataPort = createMarketDataAdapter({
  USE_STUBS: env.USE_STUBS,
  MARKET_DATA_PROVIDER: env.MARKET_DATA_PROVIDER,
  SERPER_API_KEY: env.SERPER_API_KEY,
  MARKET_SEARCH_GL: env.MARKET_SEARCH_GL,
  MARKET_SEARCH_HL: env.MARKET_SEARCH_HL,
});

function buildAgentEnv(): AgentEnv {
  return {
    ENABLE_AGENTS: env.ENABLE_AGENTS,
    MAX_AD_BUDGET_BRL: env.MAX_AD_BUDGET_BRL,
    TARGET_DAILY_REVENUE_BRL: env.TARGET_DAILY_REVENUE_BRL,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
    CONTENT_MODEL,
    PLANNING_MODEL,
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

function buildPorts(llm: LLMPort): Ports {
  return {
    llm,
    storage: noopStorage,
    payment: unusedPayment,
    email: unusedEmail,
    instagram: unusedInstagram,
    ads: unusedAds,
    marketData,
  };
}

function buildCtx(llm: LLMPort = stubLlm, cycleId?: string): AgentContext {
  return {
    prisma,
    ports: buildPorts(llm),
    env: buildAgentEnv(),
    log,
    clock,
    cycleId,
  };
}

// ------------------------------------------------------------
// Adaptador EbookQaService -> EbookQaCapability (forma exigida pelo launch-pipeline).
//
// NOTA: o wiring de PRODUCAO (launch-pipeline.resolveQaCapability/adaptQaService) ja
// faz exatamente esta ponte (auditEbook -> .audit + applyFix via FixStrategist/
// RelaunchExecutor). O cenario [4] abaixo NAO injeta qa, exercitando esse caminho
// real e provando que producao publica. Este helper permanece apenas para o cenario
// FAIL, onde injetamos qa para controlar o veredito de forma deterministica.
// ------------------------------------------------------------
function qaCapabilityFrom(service: EbookQaService): EbookQaCapability {
  const strategist = new FixStrategist();
  const executor = new RelaunchExecutor();
  return {
    async auditEbook(ctx, ebookId, iteration): Promise<EbookAudit> {
      const { audit } = await service.auditEbook(ctx, ebookId, { iteration });
      return audit;
    },
    async applyFix(ctx, ebookId, audit) {
      const ebook = await ctx.prisma.ebook.findUnique({
        where: { id: ebookId },
        select: {
          id: true,
          title: true,
          niche: true,
          contentMarkdown: true,
          outline: true,
          marketOpportunity: { select: { id: true, segment: true, niche: true, angles: true } },
        },
      });
      if (!ebook) return;
      const plan = strategist.plan(audit);
      if (plan.noop) return;
      await executor.apply(
        ctx,
        {
          id: ebook.id,
          title: ebook.title,
          niche: ebook.niche,
          contentMarkdown: ebook.contentMarkdown,
          outline: ebook.outline,
          marketOpportunity: ebook.marketOpportunity
            ? {
                id: ebook.marketOpportunity.id,
                segment: ebook.marketOpportunity.segment,
                niche: ebook.marketOpportunity.niche,
                angles: Array.isArray(ebook.marketOpportunity.angles)
                  ? (ebook.marketOpportunity.angles as unknown[]).filter(
                      (v): v is string => typeof v === 'string',
                    )
                  : [],
              }
            : null,
        },
        plan,
      );
    },
  };
}

// ------------------------------------------------------------
// LLM stub DETERMINISTICO que "melhora" o conteudo apos correcao. Mesma tecnica
// do unit test ebook-qa.test.ts (LLMPort stub controlavel): o auditor recalcula
// score/verdict deterministicamente a partir de dimensionScores; generateText
// devolve markdown com 3 capitulos longos (>= MIN_CHAPTER_WORDS), de modo que a
// reauditoria pos-correcao atinja PASS. Sem rede, 100% deterministico.
// ------------------------------------------------------------
function controllableLlm(scoreQueue: number[]): LLMPort {
  let auditCalls = 0;
  return {
    async generateText(_input: LLMGenerateTextInput): Promise<LLMGenerateTextResult> {
      const longChapter = Array(160).fill('palavra').join(' ');
      const text =
        `# Ebook Corrigido\n\n## Capitulo 1\n${longChapter}\n\n` +
        `## Capitulo 2\n${longChapter}\n\n## Capitulo 3\n${longChapter}\n`;
      return { text, usage: { inputTokens: 10, outputTokens: 50, costCents: 1 } };
    },
    async generateJson<T>(input: LLMGenerateJsonInput<T>): Promise<LLMGenerateJsonResult<T>> {
      // Este stub serve DOIS formatos via o mesmo metodo (igual o StubLLMAdapter):
      //  - ebookOutlineSchema (ContentAgent): { title, niche, subtitle, ... chapters[] }
      //  - ebookAuditLlmSchema (EbookAuditor): { dimensionScores, issues, ... }
      // Tentamos cada candidato contra o parser fornecido e usamos o 1o que validar.
      // So consumimos a fila de scores quando o candidato de AUDITORIA e o que casa
      // (assim a contagem de auditorias controla a convergencia NEEDS_FIX->PASS).
      const outlineCandidate = {
        title: 'Guia Definitivo de Teste',
        niche: 'produtividade',
        subtitle: 'Do zero ao avancado',
        targetAudience: 'Iniciantes e intermediarios',
        chapters: [
          { title: 'Fundamentos', summary: 'Conceitos essenciais e base teorica.' },
          { title: 'Pratica', summary: 'Passo a passo pratico com exemplos reais.' },
          { title: 'Avancado', summary: 'Tecnicas avancadas e erros a evitar.' },
        ],
      };
      // Tenta primeiro como OUTLINE (ContentAgent). Se nao casar, e auditoria.
      try {
        const data = input.parse(outlineCandidate);
        return { data, usage: { inputTokens: 20, outputTokens: 30, costCents: 2 } };
      } catch {
        // segue para o candidato de auditoria abaixo
      }
      const q = scoreQueue[Math.min(auditCalls, scoreQueue.length - 1)] ?? 70;
      auditCalls += 1;
      const auditRaw = {
        dimensionScores: { structure: q, contentQuality: q, marketFit: q, compliance: q },
        issues:
          q < 70
            ? [
                {
                  category: 'CONTENT_QUALITY',
                  severity: q < 40 ? 'BLOCKER' : 'MEDIUM',
                  chapterIndex: null,
                  title: 'Qualidade abaixo do ideal',
                  detail: 'Conteudo precisa de mais profundidade.',
                  suggestion: 'Aprofundar capitulos.',
                },
              ]
            : [],
        recommendations: ['Revisar.'],
        verdictHint: q >= 70 ? 'PASS' : 'NEEDS_FIX',
      };
      return {
        data: input.parse(auditRaw),
        usage: { inputTokens: 20, outputTokens: 30, costCents: 2 },
      };
    },
  };
}

// ---- asserts ----
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
  }
}

// ---- limpeza (ordem FK segura) ----
async function cleanDb(): Promise<void> {
  await prisma.actionExecution.deleteMany();
  await prisma.remediationAction.deleteMany();
  await prisma.problem.deleteMany();
  await prisma.sectorHealthSnapshot.deleteMany();
  await prisma.guardrailConfig.deleteMany();
  await prisma.event.deleteMany();
  await prisma.deliveryGrant.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.order.deleteMany();
  await prisma.adInsight.deleteMany();
  await prisma.adCampaign.deleteMany();
  await prisma.socialPost.deleteMany();
  await prisma.ebookAudit.deleteMany();
  await prisma.product.deleteMany();
  // Ebook -> MarketOpportunity (FK). Apaga ebooks antes das oportunidades.
  await prisma.ebook.deleteMany();
  await prisma.marketOpportunity.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.customer.deleteMany();
}

// Cria um ebook DRAFT/PUBLISHED com markdown arbitrario (para auditoria direta).
async function seedEbook(opts: {
  markdown: string;
  status?: 'DRAFT' | 'PUBLISHED' | 'READY';
  marketOpportunityId?: string;
  title?: string;
  niche?: string;
}): Promise<string> {
  const ebook = await prisma.ebook.create({
    data: {
      title: opts.title ?? 'Ebook de Teste',
      niche: opts.niche ?? 'produtividade',
      slug: `ebk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: opts.status ?? 'DRAFT',
      language: 'pt-BR',
      contentMarkdown: opts.markdown,
      ...(opts.marketOpportunityId
        ? { marketOpportunityId: opts.marketOpportunityId }
        : {}),
    },
    select: { id: true },
  });
  return ebook.id;
}

// Cria uma MarketOpportunity SELECTED diretamente (isola o LLM do time de
// mercado nos cenarios de pipeline que focam CONTENT+QA). Devolve um record
// minimo + uma MarketResearchCapability que o devolve (GATE 1 satisfeito).
async function seedSelectedOpportunity(): Promise<{
  id: string;
  capability: MarketResearchCapability;
}> {
  const row = await prisma.marketOpportunity.create({
    data: {
      segment: 'Financas Pessoais',
      niche: 'investir do zero',
      demandScore: 80,
      competitionScore: 30,
      potentialScore: 88,
      rationale: 'Alta demanda e concorrencia moderada (seed e2e).',
      titleIdeas: ['Investir do Zero em 30 Dias'] as unknown as never,
      angles: ['comece com pouco', 'sem jargao'] as unknown as never,
      evidence: ['seed-e2e'] as unknown as never,
      status: 'SELECTED',
      selectedAt: new Date(),
    },
    select: {
      id: true,
      segment: true,
      niche: true,
      demandScore: true,
      competitionScore: true,
      potentialScore: true,
      rationale: true,
      status: true,
      createdAt: true,
      rankedAt: true,
    },
  });
  const capability: MarketResearchCapability = {
    async rankAndPick() {
      return {
        id: row.id,
        segment: row.segment,
        niche: row.niche,
        demandScore: row.demandScore,
        competitionScore: row.competitionScore,
        potentialScore: row.potentialScore,
        rationale: row.rationale,
        titleIdeas: ['Investir do Zero em 30 Dias'],
        angles: ['comece com pouco', 'sem jargao'],
        evidence: ['seed-e2e'],
        status: 'SELECTED',
        generatedByRunId: null,
        selectedAt: row.createdAt,
        usedByEbookId: null,
        createdAt: row.createdAt,
        rankedAt: row.rankedAt,
        updatedAt: row.createdAt,
      };
    },
  };
  return { id: row.id, capability };
}

// Markdown de um ebook BOM (3 capitulos longos) — passa a estrutura deterministica.
function richMarkdown(): string {
  const long = Array(160).fill('conteudo').join(' ');
  return `# Titulo\n\n## Cap 1\n${long}\n\n## Cap 2\n${long}\n\n## Cap 3\n${long}\n`;
}

// Markdown RUIM (1 capitulo curto) — gera BLOCKER de estrutura => FAIL.
function badMarkdown(): string {
  return '# T\n\n## Unico capitulo\nmuito curto e raso, sem profundidade alguma.';
}

async function main(): Promise<void> {
  console.log('\n=== Ebook Empire — E2E PIPELINE DE LANCAMENTO (Postgres real) ===\n');

  await prisma.$queryRaw`SELECT 1`;
  console.log('[0] Conexao com Postgres OK (5433)\n');

  await cleanDb();

  const app = await buildServer();
  await app.ready();
  const token = app.jwt.sign({ sub: 'e2e-admin', role: 'admin' });
  const auth = { authorization: `Bearer ${token}` };

  try {
    // ============================================================
    // [1] (a) POST /market/scan -> rankeia + persiste; GET /market/top -> topo
    // ============================================================
    console.log('[1] MARKET_RESEARCH — scan + top (HTTP, MarketDataPort stub)');
    const scanRes = await app.inject({
      method: 'POST',
      url: '/market/scan',
      headers: auth,
    });
    check('POST /market/scan -> 200', scanRes.statusCode === 200, `status=${scanRes.statusCode}`);
    const scanBody = scanRes.json() as {
      ok: boolean;
      count: number;
      top: { id: string; potentialScore: number } | null;
      opportunities: { id: string; potentialScore: number }[];
    };
    check('scan persistiu oportunidades (count > 0)', scanBody.count > 0, `count=${scanBody.count}`);
    check('scan retornou top', !!scanBody.top, scanBody.top ? `topId=${scanBody.top.id}` : 'sem top');

    // ordenacao desc por potentialScore
    const ordered = scanBody.opportunities.every(
      (o, i, arr) => i === 0 || arr[i - 1]!.potentialScore >= o.potentialScore,
    );
    check('oportunidades ordenadas por potentialScore desc', ordered);

    const persisted = await prisma.marketOpportunity.count();
    check('MarketOpportunity persistida no banco', persisted > 0, `rows=${persisted}`);

    const topRes = await app.inject({ method: 'GET', url: '/market/top' });
    check('GET /market/top -> 200', topRes.statusCode === 200, `status=${topRes.statusCode}`);
    const top = topRes.json() as { id: string; potentialScore: number; status: string };
    check('top tem status SELECTED', top.status === 'SELECTED', `status=${top.status}`);
    check(
      'top == oportunidade de maior potentialScore',
      top.id === scanBody.top?.id,
      `topId=${top.id}`,
    );
    // confere que e mesmo o maximo no banco
    const maxRow = await prisma.marketOpportunity.findFirst({
      orderBy: { potentialScore: 'desc' },
      select: { id: true, potentialScore: true },
    });
    check(
      'top.potentialScore == MAX(potentialScore) no banco',
      top.potentialScore === maxRow?.potentialScore,
      `top=${top.potentialScore} max=${maxRow?.potentialScore}`,
    );

    // ============================================================
    // [2] (f) papeis SPECIALIST/STRATEGIST/EXECUTOR como AgentRun (MARKET_RESEARCH)
    // ============================================================
    console.log('\n[2] Observabilidade — AgentRun com role+sector (MARKET_RESEARCH)');
    const marketRuns = await prisma.agentRun.findMany({
      where: { sector: 'MARKET_RESEARCH' },
      select: { role: true, status: true },
    });
    const roles = new Set(marketRuns.map((r) => r.role));
    check('AgentRun SPECIALIST (MARKET_RESEARCH)', roles.has('SPECIALIST'));
    check('AgentRun STRATEGIST (MARKET_RESEARCH)', roles.has('STRATEGIST'));
    check('AgentRun EXECUTOR (MARKET_RESEARCH)', roles.has('EXECUTOR'));
    check(
      'todos os runs de MARKET_RESEARCH SUCCESS',
      marketRuns.length > 0 && marketRuns.every((r) => r.status === 'SUCCESS'),
      `runs=${marketRuns.length}`,
    );

    // ============================================================
    // [3] (b) GATE 1 (mercado): lancar SEM oportunidade -> recusado, sem ebook
    // ============================================================
    console.log('\n[3] GATE 1 (mercado) — sem oportunidade nada e gerado');
    const ebooksBefore = await prisma.ebook.count();
    // Injeta uma capacidade de mercado que NAO encontra oportunidade (null) para
    // exercer o GATE 1 de forma deterministica.
    const emptyMarket: MarketResearchCapability = {
      async rankAndPick() {
        return null;
      },
    };
    const gateResult = await createAndLaunchEbook(buildCtx(), {}, { market: emptyMarket });
    check('pipeline parou em MARKET_GATE', gateResult.stage === 'MARKET_GATE', `stage=${gateResult.stage}`);
    check('pipeline NAO lancou (sem oportunidade)', gateResult.launched === false);
    const ebooksAfter = await prisma.ebook.count();
    check(
      'NENHUM ebook criado no GATE 1',
      ebooksAfter === ebooksBefore,
      `antes=${ebooksBefore} depois=${ebooksAfter}`,
    );

    // ============================================================
    // [4] (c)+(d) Pipeline com oportunidade + QA NEEDS_FIX -> loop -> PASS -> lanca
    // ============================================================
    console.log('\n[4] Pipeline GATED: oportunidade -> conteudo -> QA(NEEDS_FIX->PASS) -> PUBLISHED');
    // LLM controlavel: 1a auditoria 55 (NEEDS_FIX) -> apos correcao, 90 (PASS).
    // generateText devolve 3 capitulos longos (estrutura aprovada na reauditoria).
    const improvingLlm = controllableLlm([55, 90]);
    const ctxLaunch = buildCtx(improvingLlm, 'cycle-launch-pass');
    // Oportunidade SELECTED semeada (GATE 1 satisfeito); isola o LLM do time de
    // mercado para focar o cenario em CONTENT + QA (o time de mercado ja foi
    // provado nos passos [1]/[2] via HTTP /market/scan com o stub real).
    const seededPass = await seedSelectedOpportunity();
    // WIRING DE PRODUCAO: NAO injetamos qa aqui de proposito — o pipeline resolve
    // o EbookQaService real via resolveQaCapability/adaptQaService (caminho usado
    // por /ebooks/generate e pelo Orchestrator). Prova que producao publica.
    const launch = await createAndLaunchEbook(
      ctxLaunch,
      {},
      {
        market: seededPass.capability,
        // Geracao DRAFT vinculada a oportunidade, usando o ContentAgent real
        // (com o improvingLlm), publish:false. Espelha buildContentCapability().
        content: {
          async generateDraft(c, input) {
            const agent = new ContentAgent(undefined, {
              niche: input.niche,
              title: input.title,
              language: input.language,
              marketOpportunityId: input.marketOpportunityId,
              publish: false,
            });
            const rec = await agent.execute(c);
            return { ebookId: agent.lastEbookId, runId: rec.id };
          },
        },
        publish: createDefaultPublish(),
      },
    );

    check('pipeline LANCOU (launched=true)', launch.launched === true, `stage=${launch.stage}`);
    check('estagio final PUBLISHED', launch.stage === 'PUBLISHED', `stage=${launch.stage}`);
    check('verdict final PASS', launch.verdict === 'PASS', `verdict=${launch.verdict}`);
    check('houve >=1 iteracao de correcao', launch.fixIterations >= 1, `iter=${launch.fixIterations}`);
    check(
      'oportunidade vinculada == oportunidade do GATE 1 (seed)',
      launch.opportunityId === seededPass.id,
      `opp=${launch.opportunityId}`,
    );
    check('Product criado (productId presente)', !!launch.productId);

    const launchedEbook = launch.ebookId
      ? await prisma.ebook.findUnique({
          where: { id: launch.ebookId },
          select: { status: true, marketOpportunityId: true },
        })
      : null;
    check('Ebook.status == PUBLISHED', launchedEbook?.status === 'PUBLISHED', `status=${launchedEbook?.status}`);
    check(
      'Ebook.marketOpportunityId vinculado a oportunidade do GATE 1',
      launchedEbook?.marketOpportunityId === launch.opportunityId,
      `ebookOpp=${launchedEbook?.marketOpportunityId} gate=${launch.opportunityId}`,
    );
    if (launch.ebookId) {
      const prod = await prisma.product.findFirst({
        where: { ebookId: launch.ebookId, active: true },
        select: { id: true, active: true },
      });
      check('Product ativo existe para o ebook lancado', !!prod && prod.active === true);
      // EbookQA gravou >=2 auditorias (iter 0 NEEDS_FIX + iter 1 PASS).
      const audits = await prisma.ebookAudit.findMany({
        where: { ebookId: launch.ebookId },
        orderBy: { iteration: 'asc' },
        select: { verdict: true, iteration: true },
      });
      check('>=2 EbookAudit (loop de correcao)', audits.length >= 2, `audits=${audits.length}`);
      check(
        'ultima auditoria PASS',
        audits[audits.length - 1]?.verdict === 'PASS',
        `verdicts=${audits.map((a) => a.verdict).join(',')}`,
      );
      // (f) AgentRun do QA com role SPECIALIST + sector EBOOK_QA
      const qaRuns = await prisma.agentRun.findMany({
        where: { sector: 'EBOOK_QA', role: 'SPECIALIST' },
        select: { id: true },
      });
      check('AgentRun SPECIALIST (EBOOK_QA) gravado', qaRuns.length >= 2, `runs=${qaRuns.length}`);
    }

    // ============================================================
    // [5] (d) Cenario FAIL -> NAO publica (continua DRAFT)
    // ============================================================
    console.log('\n[5] GATE 2 (qualidade): conteudo FAIL nao e publicado');
    // LLM que sempre reprova com BLOCKER (score 20) -> verdict FAIL. O ContentAgent
    // gera DRAFT; o QA reprova; o pipeline NAO publica.
    const failLlm = controllableLlm([20]);
    const ctxFail = buildCtx(failLlm, 'cycle-launch-fail');
    const seededFail = await seedSelectedOpportunity();
    const failLaunch = await createAndLaunchEbook(
      ctxFail,
      {},
      {
        market: seededFail.capability,
        qa: qaCapabilityFrom(new EbookQaService()),
        content: {
          async generateDraft(c, input) {
            const agent = new ContentAgent(undefined, {
              niche: input.niche,
              title: input.title,
              marketOpportunityId: input.marketOpportunityId,
              publish: false,
            });
            const rec = await agent.execute(c);
            return { ebookId: agent.lastEbookId, runId: rec.id };
          },
        },
        publish: createDefaultPublish(),
      },
    );
    check('FAIL: pipeline NAO lancou', failLaunch.launched === false, `stage=${failLaunch.stage}`);
    check('FAIL: parou em QUALITY_GATE', failLaunch.stage === 'QUALITY_GATE', `stage=${failLaunch.stage}`);
    check('FAIL: verdict == FAIL', failLaunch.verdict === 'FAIL', `verdict=${failLaunch.verdict}`);
    if (failLaunch.ebookId) {
      const failEbook = await prisma.ebook.findUnique({
        where: { id: failLaunch.ebookId },
        select: { status: true },
      });
      check('FAIL: ebook permanece DRAFT (nao publicado)', failEbook?.status === 'DRAFT', `status=${failEbook?.status}`);
      const failProd = await prisma.product.findFirst({
        where: { ebookId: failLaunch.ebookId },
        select: { id: true },
      });
      check('FAIL: nenhum Product criado', failProd === null);
    }

    // ============================================================
    // [6] (e) Auditoria de ebook EXISTENTE ruim -> issues; fix-loop relança
    // ============================================================
    console.log('\n[6] EBOOK_QA — auditar ebook existente ruim + fix loop (HTTP + servico)');
    // Ebook existente RUIM (1 capitulo curto -> BLOCKER de estrutura).
    const badEbookId = await seedEbook({ markdown: badMarkdown(), status: 'PUBLISHED' });
    const auditRes = await app.inject({
      method: 'POST',
      url: `/quality/audit/${badEbookId}`,
      headers: auth,
    });
    check('POST /quality/audit/:id -> 201', auditRes.statusCode === 201, `status=${auditRes.statusCode}`);
    const auditBody = auditRes.json() as {
      audit: { verdict: string; issues: { severity: string }[] };
    };
    check('auditoria do ebook ruim retorna issues', auditBody.audit.issues.length > 0, `issues=${auditBody.audit.issues.length}`);
    check('ebook ruim => verdict FAIL (BLOCKER de estrutura)', auditBody.audit.verdict === 'FAIL', `verdict=${auditBody.audit.verdict}`);

    // canLaunch fail-closed: ultima auditoria FAIL => bloqueado.
    const gateRes = await app.inject({ method: 'GET', url: `/quality/ebooks/${badEbookId}/audit` });
    const gateBody = gateRes.json() as { gate: { allowed: boolean; lastVerdict: string | null } };
    check('GATE 2 bloqueia ebook FAIL (canLaunch.allowed=false)', gateBody.gate.allowed === false);

    // Agora um ebook NEEDS_FIX existente -> fix loop converge a PASS e relança.
    // Markdown rico (estrutura ok) + LLM controlavel 55->90 via servico direto.
    const fixEbookId = await seedEbook({ markdown: richMarkdown(), status: 'DRAFT' });
    const fixLoop = await new EbookQaService().runFixLoop(
      buildCtx(controllableLlm([55, 90]), 'cycle-fixloop'),
      fixEbookId,
    );
    check('fix loop: passou (PASS)', fixLoop.passed === true, `verdict=${fixLoop.finalVerdict}`);
    check('fix loop: relançou', fixLoop.relaunched === true);
    check('fix loop: >=1 iteracao', fixLoop.iterations >= 1, `iter=${fixLoop.iterations}`);
    const relaunched = await prisma.ebook.findUnique({
      where: { id: fixEbookId },
      select: { status: true },
    });
    check('fix loop: ebook relançado PUBLISHED', relaunched?.status === 'PUBLISHED', `status=${relaunched?.status}`);
    const relaunchEvent = await prisma.event.findFirst({ where: { type: 'EBOOK_RELAUNCHED' } });
    check('fix loop: Event EBOOK_RELAUNCHED emitido', !!relaunchEvent);

    // (f) consolidacao: papeis EBOOK_QA presentes
    const qaAllRuns = await prisma.agentRun.findMany({
      where: { sector: 'EBOOK_QA' },
      select: { role: true },
    });
    check('AgentRun(s) sector=EBOOK_QA presentes', qaAllRuns.length > 0, `runs=${qaAllRuns.length}`);
    check('todos com role SPECIALIST (auditoria)', qaAllRuns.every((r) => r.role === 'SPECIALIST'));
  } finally {
    await app.close();
  }

  console.log('\n=== Resultado ===');
  console.log(`  PASSARAM: ${passed}   FALHARAM: ${failed}`);
  await prisma.$disconnect();
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('e2e-launch FALHOU com excecao:', err);
  process.exitCode = 1;
  void prisma.$disconnect();
});
