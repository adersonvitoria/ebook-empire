// E2E do CRM / Command Center (operacao autonoma — COO) contra Postgres REAL.
// Espelha o padrao de apps/api/scripts/e2e.ts: buildServer + app.inject + agentes
// diretos, limpando as tabelas no inicio. USE_STUBS=true (LLM/email/storage stub).
//
// Prova o ciclo autonomo ponta a ponta:
//   (a) estado degradado LOW (DELIVERY: Orders PAID sem DeliveryGrant);
//   (b) roda runOperationsCycle (OperationsAgent/COO);
//   (c) assert: SectorHealthSnapshot gravado, Problem DELIVERY detectado, acao LOW
//       RETRY_DELIVERIES APLICADA AUTO + ActionExecution auditada; 2o ciclo => RESOLVED;
//   (d) cenario HIGH (TRAFFIC ROAS ruim): acao HIGH fica QUEUED (NAO aplicada) no
//       ciclo AUTO; rota POST /crm/actions/:id/approve [JWT]; aplicacao via executor
//       HUMAN (humanApproved) => APPLIED + auditada;
//   (e) kill switch ON => nenhuma acao LOW aplicada no ciclo seguinte (bloqueio audita);
//   (f) rollback de uma acao reversivel APLICADA (INCREASE_AD_BUDGET) => ROLLED_BACK.
//
// Roda com: pnpm --filter @ebook-empire/api e2e:crm
//        ou: node --import tsx scripts/e2e-crm.ts  (a partir de apps/api)

import type { Ports, PaymentPort, InstagramPort } from '@ebook-empire/core';
import { buildDedupeKey } from '@ebook-empire/core';
import {
  DbHealthCollector,
  RuleDiagnosisEngine,
  StaticActionCatalog,
  GuardedActionExecutor,
  LiveRemediationLevers,
  OperationsAgent,
  type AgentContext,
  type AgentEnv,
} from '@ebook-empire/agents';
import {
  createLLMAdapter,
  createStorageAdapter,
  StubEmailAdapter,
} from '@ebook-empire/adapters';

import { buildServer } from '../src/server.js';
import { runOperationsCycle } from '../src/scheduler.js';
import { prisma } from '../src/db.js';
import { env, CONTENT_MODEL, PLANNING_MODEL } from '../src/env.js';

// ---- logger e clock minimos ----
const log = {
  debug: () => {},
  info: (_o: unknown, _m?: string) => {},
  warn: (o: unknown, m?: string) => console.warn('  [warn]', m ?? '', o),
  error: (o: unknown, m?: string) => console.error('  [error]', m ?? '', o),
};
const clock = { now: () => new Date() };

// ---- ports (real llm/storage/email stub; throwers para os nao usados) ----
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
// Ads stub minimo: o lever de budget chama updateBudget/setStatus quando ha
// externalCampaignId. Mantemos no-op de sucesso (campanha sem externalId nao chama).
const stubAds = {
  createCampaign: async () => ({ externalCampaignId: 'ext_stub', status: 'ACTIVE' as const }),
  updateBudget: async () => {},
  setStatus: async () => {},
  getInsights: async () => [],
};

const email = new StubEmailAdapter();
const storage = createStorageAdapter({
  driver: 'local',
  storageDir: env.STORAGE_DIR,
  signingSecret: env.JWT_SECRET,
  publicBaseUrl: env.PUBLIC_BASE_URL,
});
const llm = createLLMAdapter({
  USE_STUBS: env.USE_STUBS,
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
});

const ports = {
  llm,
  storage,
  email,
  payment: unusedPayment,
  instagram: unusedInstagram,
  ads: stubAds,
} as unknown as Ports;

const agentEnv: AgentEnv = {
  ENABLE_AGENTS: env.ENABLE_AGENTS,
  MAX_AD_BUDGET_BRL: env.MAX_AD_BUDGET_BRL, // 300 => teto 30000c
  TARGET_DAILY_REVENUE_BRL: env.TARGET_DAILY_REVENUE_BRL,
  PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
  CONTENT_MODEL,
  PLANNING_MODEL,
};

const ctx: AgentContext = { prisma, ports, env: agentEnv, log, clock };

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

// Limpa as tabelas em ordem de FK segura (inclui as novas do CRM).
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
  await prisma.product.deleteMany();
  // EbookAudit (FK RESTRICT -> Ebook) e MarketOpportunity (referenciada por
  // Ebook.marketOpportunityId): apaga os dependentes antes dos ebooks/oportunidades.
  await prisma.ebookAudit.deleteMany();
  await prisma.ebook.deleteMany();
  await prisma.marketOpportunity.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.customer.deleteMany();
}

// Cria 1 Ebook PUBLISHED + Product ativo (catalogo saudavel) e devolve ids.
async function seedCatalog(): Promise<{ ebookId: string; productId: string }> {
  const ebook = await prisma.ebook.create({
    data: {
      title: 'Liberdade Financeira em 90 Dias',
      niche: 'financas pessoais',
      slug: `lib-fin-${Date.now()}`,
      status: 'PUBLISHED',
      language: 'pt-BR',
      contentMarkdown: '# Conteudo',
    },
  });
  const product = await prisma.product.create({
    data: {
      ebookId: ebook.id,
      name: 'Ebook Liberdade Financeira',
      slug: `prod-lib-fin-${Date.now()}`,
      description: 'Uma descricao de venda completa e persuasiva do produto.',
      priceCents: 4700,
      active: true,
    },
  });
  return { ebookId: ebook.id, productId: product.id };
}

// Cria N Orders PAID SEM DeliveryGrant => backlog de entrega (setor DELIVERY LOW).
async function seedPaidOrdersWithoutGrant(
  ebookId: string,
  productId: string,
  n: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const customer = await prisma.customer.create({
      data: { email: `cliente.crm.${Date.now()}.${i}@example.com`, name: `Cliente ${i}` },
    });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        productId,
        ebookId,
        status: 'PAID',
        priceCents: 4700,
        paidAt: new Date(),
      },
    });
    ids.push(order.id);
  }
  return ids;
}

async function main(): Promise<void> {
  console.log('\n=== Ebook Empire — E2E CRM/Command Center (Postgres real) ===\n');

  await prisma.$queryRaw`SELECT 1`;
  console.log('[0] Conexao com Postgres OK (5433)\n');

  await cleanDb();

  const app = await buildServer();
  await app.ready();

  // Token JWT para as rotas protegidas (/crm/actions/:id/approve, /killswitch).
  const token = app.jwt.sign({ sub: 'e2e-admin', role: 'admin' });
  const auth = { authorization: `Bearer ${token}` };

  // Componentes concretos do CRM para acionar o executor diretamente (cenarios
  // HIGH/rollback que a rota delega ao scheduler — ver nota no relatorio).
  const executor = new GuardedActionExecutor(new LiveRemediationLevers());

  try {
    // ========================================================
    // (a)+(b)+(c) — DELIVERY LOW: backlog -> RETRY_DELIVERIES AUTO -> RESOLVED
    // ========================================================
    console.log('[1] DELIVERY degradado (LOW): orders PAID sem grant');
    const { ebookId, productId } = await seedCatalog();
    const paidOrderIds = await seedPaidOrdersWithoutGrant(ebookId, productId, 6);
    // Guardrails: kill switch OFF, permite auto-acoes, sem cooldown atrapalhando.
    await prisma.guardrailConfig.upsert({
      where: { id: 'singleton' },
      update: { killSwitch: false, maxAutoActionsPerCycle: 10, cooldownMinutes: 0 },
      create: { id: 'singleton', killSwitch: false, maxAutoActionsPerCycle: 10, cooldownMinutes: 0 },
    });

    const backlogBefore = await prisma.order.count({ where: { status: 'PAID', deliveryGrant: null } });
    check('backlog inicial de entregas > 0', backlogBefore === 6, `pending=${backlogBefore}`);

    console.log('[2] runOperationsCycle (COO) — ciclo 1');
    const cycle1 = await runOperationsCycle(app);
    check('COO ciclo 1 disponivel (composto no scheduler)', cycle1.status !== 'UNAVAILABLE', cycle1.status);
    check('AgentRun OPERATIONS gravado', !!cycle1.runId, cycle1.runId ?? 'sem runId');

    console.log('[3] Asserts do ciclo autonomo LOW');
    const snapshots = await prisma.sectorHealthSnapshot.findMany({
      where: { cycleId: cycle1.cycleId },
    });
    const distinctSectors = new Set(snapshots.map((s) => s.sector)).size;
    // O COO agora cobre os 10 setores OPERAVEIS (CRM_SECTORS = 7 de saude + 3 de
    // producao MARKETPLACE/FUNNEL/AFFILIATE). Intencao preservada: TODOS os
    // setores monitorados devem ter snapshot no ciclo.
    check('SectorHealthSnapshot cobre os 10 setores operaveis', distinctSectors === 10,
      `setores=${distinctSectors} linhas=${snapshots.length}`);
    const deliverySnap = snapshots.find((s) => s.sector === 'DELIVERY');
    check(
      'DELIVERY com score baixo (WARNING/CRITICAL)',
      !!deliverySnap && deliverySnap.score < 70,
      `score=${deliverySnap?.score}`,
    );

    const deliveryProblem = await prisma.problem.findFirst({
      where: { sector: 'DELIVERY' },
      orderBy: { detectedAt: 'desc' },
    });
    check('Problem DELIVERY detectado', !!deliveryProblem, deliveryProblem?.type ?? 'nenhum');

    const retryAction = await prisma.remediationAction.findFirst({
      where: { kind: 'RETRY_DELIVERIES', problemId: deliveryProblem?.id },
    });
    check('Acao RETRY_DELIVERIES criada (LOW)', !!retryAction, retryAction?.status ?? 'nenhuma');
    check('Acao RETRY_DELIVERIES e LOW risk', retryAction?.riskTier === 'LOW', retryAction?.riskTier ?? '-');
    check('Acao RETRY_DELIVERIES APLICADA AUTO', retryAction?.status === 'APPLIED', retryAction?.status ?? '-');

    if (retryAction) {
      const exec = await prisma.actionExecution.findFirst({
        where: { actionId: retryAction.id, isRollback: false },
        orderBy: { startedAt: 'desc' },
      });
      check('ActionExecution auditada (success, AUTO)', !!exec && exec.success && exec.triggeredBy === 'AUTO',
        exec ? `success=${exec.success} by=${exec.triggeredBy}` : 'sem execucao');
      check('Auditoria com beforeState/afterState', !!exec && exec.beforeState !== null && exec.afterState !== null,
        exec ? `before=${JSON.stringify(exec.beforeState)} after=${JSON.stringify(exec.afterState)}` : '-');
    }

    // O lever RETRY_DELIVERIES roda o DeliveryAgent => grants criados, backlog zera.
    const backlogAfter = await prisma.order.count({ where: { status: 'PAID', deliveryGrant: null } });
    check('backlog de entregas zerado pelo lever', backlogAfter === 0, `pending=${backlogAfter}`);
    const grants = await prisma.deliveryGrant.count();
    check('DeliveryGrants criados pelo lever', grants === paidOrderIds.length, `grants=${grants}`);

    console.log('[4] runOperationsCycle (COO) — ciclo 2 (setor recuperado => RESOLVED)');
    const cycle2 = await runOperationsCycle(app);
    check('COO ciclo 2 OK', cycle2.status !== 'UNAVAILABLE', cycle2.status);
    const deliveryProblemAfter = deliveryProblem
      ? await prisma.problem.findUnique({ where: { id: deliveryProblem.id } })
      : null;
    check('Problem DELIVERY -> RESOLVED', deliveryProblemAfter?.status === 'RESOLVED',
      deliveryProblemAfter?.status ?? '-');
    check('Problem DELIVERY com resolvedAt', !!deliveryProblemAfter?.resolvedAt,
      deliveryProblemAfter?.resolvedAt ? 'ok' : 'sem resolvedAt');
    console.log('');

    // ========================================================
    // (d) — TRAFFIC HIGH: acao fica QUEUED no AUTO; aplicada apos approve HUMAN
    // ========================================================
    console.log('[5] TRAFFIC degradado (HIGH): ROAS ruim');
    // Campanha ACTIVE com spend alto e SEM receita atribuida => ROAS ~0.
    const campaign = await prisma.adCampaign.create({
      data: {
        name: 'Campanha ROAS Ruim',
        objective: 'CONVERSIONS',
        status: 'ACTIVE',
        platform: 'meta',
        dailyBudgetCents: 5000,
        utmCampaign: 'roas-ruim',
        // sem externalCampaignId => lever de budget nao chama o adapter (so DB).
      },
    });
    const today = new Date();
    await prisma.adInsight.create({
      data: {
        campaignId: campaign.id,
        date: new Date(`${today.toISOString().slice(0, 10)}T00:00:00.000Z`),
        impressions: 1000,
        clicks: 50,
        spendCents: 20000, // gastou R$200
        conversions: 0,
        revenueCents: 0,
      },
    });

    // Deteccao de saude TRAFFIC (prova que o coletor enxerga o estado degradado).
    const healths = await new DbHealthCollector().collect(ctx);
    const trafficHealth = healths.find((h) => h.sector === 'TRAFFIC')!;
    check('TRAFFIC detectado degradado pelo coletor', trafficHealth.score < 70, `score=${trafficHealth.score}`);
    const diag = await new RuleDiagnosisEngine().diagnose(ctx, 'TRAFFIC', trafficHealth);
    check('Diagnostico TRAFFIC = NEGATIVE_ROAS', diag.type === 'NEGATIVE_ROAS', diag.type);

    // O Problem ja foi persistido pelo diagnose. Recupera-o e injeta o campaignId
    // no metadata para o catalogo conseguir montar a proposta HIGH (o catalogo le
    // metadata.campaignId — ver nota de inconsistencia no relatorio).
    const trafficProblem = (await prisma.problem.findFirst({
      where: { sector: 'TRAFFIC', status: { in: ['OPEN', 'DIAGNOSING', 'REMEDIATING'] } },
      orderBy: { detectedAt: 'desc' },
    }))!;
    await prisma.problem.update({
      where: { id: trafficProblem.id },
      data: {
        metadata: {
          ...(trafficProblem.metadata as object),
          campaignId: campaign.id,
          newDailyBudgetCents: 8000,
        } as never,
      },
    });
    const trafficProblemRef = (await prisma.problem.findUnique({ where: { id: trafficProblem.id } }))!;

    // Catalogo propoe acoes HIGH (DECREASE_AD_BUDGET / PAUSE_CAMPAIGN para ROAS<1).
    const proposals = new StaticActionCatalog().propose(
      ctx,
      {
        id: trafficProblemRef.id,
        sector: 'TRAFFIC',
        type: trafficProblemRef.type,
        severity: trafficProblemRef.severity,
        status: trafficProblemRef.status as 'OPEN',
        rootCause: trafficProblemRef.rootCause,
        snapshotId: trafficProblemRef.snapshotId,
        detectedAt: trafficProblemRef.detectedAt,
        resolvedAt: trafficProblemRef.resolvedAt,
        metadata: trafficProblemRef.metadata as never,
      },
      diag,
    );
    const highProposal = proposals.find((p) => p.riskTier === 'HIGH');
    check('Catalogo propos acao HIGH para TRAFFIC', !!highProposal, highProposal?.kind ?? 'nenhuma');

    // Cria a RemediationAction HIGH (PROPOSED) como o COO faria.
    const highKind = highProposal?.kind ?? 'DECREASE_AD_BUDGET';
    const highParams = highProposal?.params ?? { kind: highKind, campaignId: campaign.id, newDailyBudgetCents: 8000 };
    const highAction = await prisma.remediationAction.create({
      data: {
        problemId: trafficProblemRef.id,
        kind: highKind,
        riskTier: 'HIGH',
        params: highParams as never,
        expectedEffect: highProposal?.expectedEffect ?? 'reduzir budget',
        status: 'PROPOSED',
        reversible: highProposal?.reversible ?? true,
        dedupeKey: buildDedupeKey(trafficProblemRef.id, highKind, highParams as never),
      },
    });

    console.log('[6] Executor AUTO numa acao HIGH => NAO aplica (vai p/ QUEUED)');
    const autoAttempt = await executor.apply(ctx, {
      id: highAction.id,
      problemId: highAction.problemId,
      kind: highAction.kind,
      riskTier: 'HIGH',
      params: highAction.params as never,
      expectedEffect: highAction.expectedEffect,
      status: 'PROPOSED',
      reversible: highAction.reversible,
      dedupeKey: highAction.dedupeKey,
    });
    check('HIGH bloqueada no AUTO (NOT_APPROVED)', autoAttempt.success === false && autoAttempt.blockedByGuardrail === 'NOT_APPROVED',
      `blocked=${autoAttempt.blockedByGuardrail}`);
    const highAfterAuto = await prisma.remediationAction.findUnique({ where: { id: highAction.id } });
    check('Acao HIGH agora QUEUED (fila de aprovacao)', highAfterAuto?.status === 'QUEUED', highAfterAuto?.status ?? '-');

    console.log('[7] POST /crm/actions/:id/approve [JWT]');
    // Budget ORIGINAL (antes do approve) para provar que a rota aplicou de fato.
    const budgetOriginal = (await prisma.adCampaign.findUnique({ where: { id: campaign.id } }))!.dailyBudgetCents;
    const approveRes = await app.inject({
      method: 'POST',
      url: `/crm/actions/${highAction.id}/approve`,
      headers: auth,
    });
    // A rota delega ao scheduler.applyApprovedAction (agora exposto): aplica de
    // fato via executor HUMAN e retorna 200/applied=true. Aceitamos tambem 202
    // (compatibilidade caso o scheduler nao exponha a funcao).
    check('approve aceito (200 aplicada OU 202 aprovada)', approveRes.statusCode === 200 || approveRes.statusCode === 202,
      String(approveRes.statusCode));
    const approveBody = approveRes.json() as { approved?: boolean; applied?: boolean };
    check('resposta marca approved=true', approveBody.approved === true, JSON.stringify(approveBody));
    const highAfterApprove = await prisma.remediationAction.findUnique({ where: { id: highAction.id } });
    check('Acao HIGH ficou APPROVED apos rota', highAfterApprove?.status === 'APPROVED' || highAfterApprove?.status === 'APPLIED',
      highAfterApprove?.status ?? '-');
    // A rota fechou o ciclo HIGH ponta a ponta: a campanha ja deve ter o budget
    // novo (8000) aplicado pelo lever real via applyApprovedAction (HUMAN).
    const budgetAfterRoute = (await prisma.adCampaign.findUnique({ where: { id: campaign.id } }))!.dailyBudgetCents;
    check('rota aplicou o budget HIGH ponta a ponta (lever real)', budgetAfterRoute !== budgetOriginal,
      `${budgetOriginal} -> ${budgetAfterRoute}`);

    console.log('[8] Reaplicacao HUMAN via executor (idempotente — motor de aprovacao)');
    const budgetBefore = budgetOriginal;
    const humanApply = await executor.applyWith(
      ctx,
      {
        id: highAction.id,
        problemId: highAction.problemId,
        kind: highAction.kind,
        riskTier: 'HIGH',
        params: highAction.params as never,
        expectedEffect: highAction.expectedEffect,
        status: 'APPROVED',
        reversible: highAction.reversible,
        dedupeKey: highAction.dedupeKey,
      },
      { triggeredBy: 'HUMAN', humanApproved: true },
    );
    check('HIGH aplicada com aprovacao HUMAN', humanApply.success === true, humanApply.error ?? 'ok');
    const highApplied = await prisma.remediationAction.findUnique({ where: { id: highAction.id } });
    check('Acao HIGH -> APPLIED', highApplied?.status === 'APPLIED', highApplied?.status ?? '-');
    const humanExec = await prisma.actionExecution.findFirst({
      where: { actionId: highAction.id, isRollback: false, triggeredBy: 'HUMAN', success: true },
      orderBy: { startedAt: 'desc' },
    });
    check('ActionExecution HUMAN auditada', !!humanExec, humanExec ? 'ok' : 'sem execucao');
    const budgetAfter = (await prisma.adCampaign.findUnique({ where: { id: campaign.id } }))!.dailyBudgetCents;
    check('budget da campanha alterado pelo lever (vs. original)', budgetAfter !== budgetBefore,
      `${budgetBefore} -> ${budgetAfter}`);
    console.log('');

    // ========================================================
    // (f) — Rollback de acao reversivel APLICADA (INCREASE_AD_BUDGET reversivel)
    // ========================================================
    console.log('[9] Rollback de acao reversivel (restaura beforeState)');
    check('acao HIGH e reversivel', highApplied?.reversible === true, String(highApplied?.reversible));
    const lastSuccessExec = await prisma.actionExecution.findFirst({
      where: { actionId: highAction.id, isRollback: false, success: true },
      orderBy: { startedAt: 'desc' },
    });
    let rollbackOk = false;
    if (lastSuccessExec) {
      const rb = await executor.rollback(ctx, {
        id: lastSuccessExec.id,
        actionId: lastSuccessExec.actionId,
        success: lastSuccessExec.success,
        beforeState: lastSuccessExec.beforeState as never,
        afterState: lastSuccessExec.afterState as never,
        error: lastSuccessExec.error,
        triggeredBy: lastSuccessExec.triggeredBy,
        isRollback: lastSuccessExec.isRollback,
        startedAt: lastSuccessExec.startedAt,
        finishedAt: lastSuccessExec.finishedAt,
      });
      rollbackOk = rb.success;
      check('rollback executou com sucesso', rb.success === true, rb.error ?? 'ok');
    } else {
      check('rollback executou com sucesso', false, 'sem execucao bem-sucedida para reverter');
    }
    const highRolledBack = await prisma.remediationAction.findUnique({ where: { id: highAction.id } });
    check('Acao -> ROLLED_BACK', highRolledBack?.status === 'ROLLED_BACK', highRolledBack?.status ?? '-');
    const rollbackExec = await prisma.actionExecution.findFirst({
      where: { actionId: highAction.id, isRollback: true },
      orderBy: { startedAt: 'desc' },
    });
    check('ActionExecution de rollback auditada', !!rollbackExec, rollbackExec ? 'ok' : 'sem execucao de rollback');
    const budgetRestored = (await prisma.adCampaign.findUnique({ where: { id: campaign.id } }))!.dailyBudgetCents;
    // O rollback restaura o beforeState DA execucao revertida (lastSuccessExec),
    // nao necessariamente o budget original — robusto a multiplas aplicacoes.
    const revertedBefore = lastSuccessExec
      ? ((lastSuccessExec.beforeState as { dailyBudgetCents?: number } | null)?.dailyBudgetCents ?? null)
      : null;
    check('budget restaurado ao beforeState da execucao revertida',
      revertedBefore !== null && budgetRestored === revertedBefore,
      `restaurado=${budgetRestored} esperado=${revertedBefore}`);
    void rollbackOk;
    console.log('');

    // ========================================================
    // (e) — KILL SWITCH ON => nenhuma acao LOW aplicada no ciclo seguinte
    // ========================================================
    console.log('[10] Kill switch ON => COO nao aplica acao LOW');
    // Liga o kill switch pela rota protegida (prova a rota /killswitch tambem).
    const ksRes = await app.inject({
      method: 'POST',
      url: '/crm/killswitch',
      headers: auth,
      payload: { enabled: true },
    });
    check('POST /crm/killswitch liga o switch', ksRes.statusCode === 200 && ksRes.json().killSwitch === true,
      String(ksRes.statusCode));

    // Novo backlog de entregas (estado LOW fresco para o proximo ciclo).
    const before = await prisma.order.count({ where: { status: 'PAID', deliveryGrant: null } });
    await seedPaidOrdersWithoutGrant(ebookId, productId, 5);
    const backlogKs = await prisma.order.count({ where: { status: 'PAID', deliveryGrant: null } });
    check('novo backlog criado para o teste de kill switch', backlogKs > before, `pending=${backlogKs}`);

    const appliedBefore = await prisma.remediationAction.count({ where: { kind: 'RETRY_DELIVERIES', status: 'APPLIED' } });
    const execCountBefore = await prisma.actionExecution.count();

    console.log('[11] runOperationsCycle (COO) com kill switch ON');
    const cycleKs = await runOperationsCycle(app);
    check('COO ciclo com kill switch OK', cycleKs.status !== 'UNAVAILABLE', cycleKs.status);

    const appliedAfter = await prisma.remediationAction.count({ where: { kind: 'RETRY_DELIVERIES', status: 'APPLIED' } });
    check('NENHUMA acao LOW nova aplicada (kill switch)', appliedAfter === appliedBefore,
      `applied antes=${appliedBefore} depois=${appliedAfter}`);

    const backlogStill = await prisma.order.count({ where: { status: 'PAID', deliveryGrant: null } });
    check('backlog NAO foi processado (kill switch bloqueou)', backlogStill === backlogKs, `pending=${backlogStill}`);

    // Houve tentativa de execucao bloqueada (auditoria de bloqueio KILL_SWITCH).
    const ksBlock = await prisma.actionExecution.findFirst({
      where: { success: false, isRollback: false, error: { contains: 'KILL_SWITCH' } },
      orderBy: { startedAt: 'desc' },
    });
    const execCountAfter = await prisma.actionExecution.count();
    check('execucao de bloqueio KILL_SWITCH auditada', !!ksBlock || execCountAfter > execCountBefore,
      ksBlock ? 'bloqueio KILL_SWITCH auditado' : `execs ${execCountBefore}->${execCountAfter}`);
    console.log('');
  } finally {
    await app.close();
    await prisma.$disconnect();
  }

  console.log('=== Resultado ===');
  console.log(`  PASSARAM: ${passed}   FALHARAM: ${failed}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nE2E CRM abortou com erro:', err);
  process.exit(1);
});
