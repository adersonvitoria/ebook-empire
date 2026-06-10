// E2E do COO nos SETORES NOVOS de producao (MARKETPLACE / FUNNEL / AFFILIATE)
// contra Postgres REAL. Espelha o padrao de e2e-crm.ts: roda o ciclo real do
// OperationsAgent via runOperationsCycle (scheduler) e prova que o loop do COO
// agora MONITORA / DIAGNOSTICA / REMEDIA os 3 setores novos — fechando as 2
// lacunas: (1) health-collector.collect() cobre os 10 setores; (2) o catalogo
// PROPOE autonomamente os ActionKinds novos.
//
// Cenarios degradados criados com kill switch OFF (auto-acao habilitada):
//   - AFFILIATE: 1 afiliado ACTIVE sem receita atribuida => AFFILIATE_REVENUE_ZERO
//     => catalogo propoe BOOST_AFFILIATE_OUTREACH/SEND_AFFILIATE_EMAIL (LOW) =>
//     aplicada AUTO (roteamento por tier LOW respeitando guardrails).
//   - MARKETPLACE: Product ativo (ebook PUBLISHED) com listing porem SEM venda em
//     30d => DEAD_LISTING => catalogo propoe PAUSE_LISTING (HIGH) => fica QUEUED
//     (NAO aplicada no AUTO; roteamento por tier HIGH).
//
// Roda com: node --import tsx scripts/e2e-coo-sectors.ts  (a partir de apps/api)

import { buildServer } from '../src/server.js';
import { runOperationsCycle } from '../src/scheduler.js';
import { prisma } from '../src/db.js';

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

// Limpa as tabelas em ordem de FK segura (inclui CRM + afiliados + listings).
async function cleanDb(): Promise<void> {
  await prisma.actionExecution.deleteMany();
  await prisma.remediationAction.deleteMany();
  await prisma.problem.deleteMany();
  await prisma.sectorHealthSnapshot.deleteMany();
  await prisma.guardrailConfig.deleteMany();

  await prisma.affiliateOutreach.deleteMany();
  await prisma.affiliate.deleteMany();
  await prisma.marketplaceListing.deleteMany();

  await prisma.event.deleteMany();
  await prisma.deliveryGrant.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.order.deleteMany();
  await prisma.adInsight.deleteMany();
  await prisma.adCampaign.deleteMany();
  await prisma.socialPost.deleteMany();
  await prisma.product.deleteMany();
  await prisma.ebookAudit.deleteMany();
  await prisma.ebook.deleteMany();
  await prisma.marketOpportunity.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.customer.deleteMany();
}

async function main(): Promise<void> {
  console.log('\n=== Ebook Empire — E2E COO setores novos (MARKETPLACE/FUNNEL/AFFILIATE) ===\n');

  await prisma.$queryRaw`SELECT 1`;
  console.log('[0] Conexao com Postgres OK (5433)\n');

  await cleanDb();

  const app = await buildServer();
  await app.ready();

  try {
    // ========================================================
    // SEED — cenario degradado em DOIS setores novos
    // ========================================================
    console.log('[1] Seed: MARKETPLACE (dead listing) + AFFILIATE (ativo sem receita)');

    // N Ebooks PUBLISHED + Products ativos COM listing externa + capa + externalId,
    // porem SEM nenhuma venda atribuida em 30d => listings "mortas". O subscore
    // liveness cai 25 pts por listing morta; coverage/content ficam 100 (capa e
    // externalId presentes). Sao precisas >=4 listings mortas para o score
    // ponderado (coverage .4 + liveness .4 + content .2) cair abaixo de 70 e o
    // setor sair de HEALTHY -> diagnostico DEAD_LISTING.
    const DEAD = 4;
    let firstProductId = '';
    for (let i = 0; i < DEAD; i++) {
      const ebook = await prisma.ebook.create({
        data: {
          title: `Marketing Digital do Zero #${i}`,
          niche: 'marketing digital',
          slug: `mkt-zero-${Date.now()}-${i}`,
          status: 'PUBLISHED',
          language: 'pt-BR',
          contentMarkdown: '# Conteudo',
          coverImagePath: 'covers/mkt.png', // tem capa => isola o problema em liveness
        },
      });
      const product = await prisma.product.create({
        data: {
          ebookId: ebook.id,
          name: `Ebook Marketing Digital #${i}`,
          slug: `prod-mkt-${Date.now()}-${i}`,
          description: 'Descricao de venda completa e persuasiva do produto de marketing.',
          priceCents: 3900,
          active: true,
          externalProductId: `ext_mkt_${i}`,
        },
      });
      await prisma.marketplaceListing.create({
        data: {
          productId: product.id,
          provider: 'hotmart',
          externalProductId: `ext_mkt_${i}`,
          marketplaceUrl: `https://hotmart.com/pt-br/marketplace/produtos/ext_mkt_${i}`,
          affiliateCommissionPct: 40,
          syncedAt: new Date(),
        },
      });
      if (i === 0) firstProductId = product.id;
    }
    const ebook = await prisma.ebook.findFirst({ where: { niche: 'marketing digital' } });
    const product = { id: firstProductId };

    // AFFILIATE: 1 afiliado ACTIVE. Nenhum Order com utmMedium='afiliado' =>
    // receita atribuida = 0 => AFFILIATE_REVENUE_ZERO.
    const affiliate = await prisma.affiliate.create({
      data: {
        name: 'Afiliado Teste',
        email: `afiliado.${Date.now()}@example.com`,
        status: 'ACTIVE',
        ebookId: ebook?.id ?? null,
        commissionPct: 30,
      },
    });

    // Guardrails: kill switch OFF, auto-acoes habilitadas, sem cooldown.
    await prisma.guardrailConfig.upsert({
      where: { id: 'singleton' },
      update: { killSwitch: false, maxAutoActionsPerCycle: 20, cooldownMinutes: 0 },
      create: { id: 'singleton', killSwitch: false, maxAutoActionsPerCycle: 20, cooldownMinutes: 0 },
    });

    // ========================================================
    // RODA O CICLO REAL DO COO (OperationsAgent via scheduler)
    // ========================================================
    console.log('[2] runOperationsCycle (COO) — ciclo real ponta a ponta');
    const cycle = await runOperationsCycle(app);
    check('COO disponivel (composto no scheduler)', cycle.status !== 'UNAVAILABLE', cycle.status);
    check('AgentRun OPERATIONS gravado', !!cycle.runId, cycle.runId ?? 'sem runId');

    // ========================================================
    // ASSERT 1 — SectorHealthSnapshot dos 10 setores (3 novos inclusos)
    // ========================================================
    console.log('[3] Snapshots dos 10 setores operaveis (3 novos monitorados)');
    const snaps = await prisma.sectorHealthSnapshot.findMany({ where: { cycleId: cycle.cycleId } });
    const sectors = new Set(snaps.map((s) => s.sector));
    check('SectorHealthSnapshot cobre os 10 setores', sectors.size === 10, `setores=${sectors.size}`);
    for (const novo of ['MARKETPLACE', 'FUNNEL', 'AFFILIATE'] as const) {
      check(`snapshot do setor novo ${novo} gravado`, sectors.has(novo), novo);
    }
    const mktSnap = snaps.find((s) => s.sector === 'MARKETPLACE');
    const affSnap = snaps.find((s) => s.sector === 'AFFILIATE');
    check('MARKETPLACE degradado (score < 70)', !!mktSnap && mktSnap.score < 70, `score=${mktSnap?.score}`);
    check('AFFILIATE degradado (score < 70)', !!affSnap && affSnap.score < 70, `score=${affSnap?.score}`);

    // ========================================================
    // ASSERT 2 — Problems do ProblemType esperado nos setores novos
    // ========================================================
    console.log('[4] Problem detectado por setor novo (ProblemType esperado)');
    const mktProblem = await prisma.problem.findFirst({
      where: { sector: 'MARKETPLACE', status: { in: ['OPEN', 'DIAGNOSING', 'REMEDIATING'] } },
      orderBy: { detectedAt: 'desc' },
    });
    check('Problem MARKETPLACE = DEAD_LISTING', mktProblem?.type === 'DEAD_LISTING', mktProblem?.type ?? 'nenhum');

    const affProblem = await prisma.problem.findFirst({
      where: { sector: 'AFFILIATE', status: { in: ['OPEN', 'DIAGNOSING', 'REMEDIATING'] } },
      orderBy: { detectedAt: 'desc' },
    });
    check('Problem AFFILIATE = AFFILIATE_REVENUE_ZERO', affProblem?.type === 'AFFILIATE_REVENUE_ZERO',
      affProblem?.type ?? 'nenhum');

    // ========================================================
    // ASSERT 3 — Catalogo PROPOS os ActionKinds NOVOS + roteamento por tier
    // ========================================================
    console.log('[5] Catalogo propos ActionKinds novos (roteados por tier)');

    // MARKETPLACE -> PAUSE_LISTING (HIGH) => criada e roteada para QUEUED no AUTO.
    const pauseListing = mktProblem
      ? await prisma.remediationAction.findFirst({
          where: { kind: 'PAUSE_LISTING', problemId: mktProblem.id },
        })
      : null;
    check('Acao PAUSE_LISTING proposta (MARKETPLACE)', !!pauseListing, pauseListing?.kind ?? 'nenhuma');
    check('PAUSE_LISTING e HIGH risk', pauseListing?.riskTier === 'HIGH', pauseListing?.riskTier ?? '-');
    check('PAUSE_LISTING roteada para QUEUED (HIGH, nao auto-aplicada)',
      pauseListing?.status === 'QUEUED', pauseListing?.status ?? '-');
    // Guardrail respeitado: produto NAO foi desativado automaticamente (HIGH).
    const prodAfter = await prisma.product.findUnique({ where: { id: product.id }, select: { active: true } });
    check('produto continua ATIVO (HIGH nao aplicada no AUTO)', prodAfter?.active === true, `active=${prodAfter?.active}`);

    // AFFILIATE -> BOOST_AFFILIATE_OUTREACH (LOW) => aplicada AUTO.
    const boost = affProblem
      ? await prisma.remediationAction.findFirst({
          where: { kind: 'BOOST_AFFILIATE_OUTREACH', problemId: affProblem.id },
        })
      : null;
    check('Acao BOOST_AFFILIATE_OUTREACH proposta (AFFILIATE)', !!boost, boost?.kind ?? 'nenhuma');
    check('BOOST_AFFILIATE_OUTREACH e LOW risk', boost?.riskTier === 'LOW', boost?.riskTier ?? '-');
    check('BOOST_AFFILIATE_OUTREACH APLICADA AUTO (LOW)', boost?.status === 'APPLIED', boost?.status ?? '-');

    if (boost) {
      const exec = await prisma.actionExecution.findFirst({
        where: { actionId: boost.id, isRollback: false },
        orderBy: { startedAt: 'desc' },
      });
      check('ActionExecution AUTO auditada (success)',
        !!exec && exec.success && exec.triggeredBy === 'AUTO',
        exec ? `success=${exec.success} by=${exec.triggeredBy}` : 'sem execucao');
    }

    void affiliate;
    console.log('');
  } finally {
    // Limpa os dados deste cenario para nao poluir a DB compartilhada (o e2e.ts
    // mais antigo nao conhece MarketplaceListing e quebraria no deleteMany de
    // Product por FK RESTRICT). Deixa a base limpa para os demais e2e.
    await prisma.marketplaceListing.deleteMany();
    await prisma.affiliateOutreach.deleteMany();
    await prisma.affiliate.deleteMany();
    await app.close();
    await prisma.$disconnect();
  }

  console.log('=== Resultado ===');
  console.log(`  PASSARAM: ${passed}   FALHARAM: ${failed}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nE2E COO setores novos abortou com erro:', err);
  process.exit(1);
});
