// E2E de FINANCEIRO CONSOLIDADO + ALERTAS EXTERNOS contra Postgres REAL (5433).
// Espelha apps/api/scripts/e2e-crm.ts: buildServer + app.inject + servicos diretos,
// limpando as tabelas relevantes no inicio. Injeta um StubEmail/StubWhatsApp cujo
// outbox e inspecionado diretamente.
//
// Prova:
//   FINANCE
//     - seede orders PAID + AdInsight (spend) + AgentRun (llmCost) e assert que
//       GET /finance/dre devolve gross/fees/adSpend/llm/netProfit/marginPct
//       CORRETOS (calculados a mao);
//     - by-ebook / by-campaign atribuem receita e spend corretamente;
//     - persistSnapshot e idempotente (2x mesmo dia => 1 linha, mesmos valores).
//   ALERTS
//     - POST /crm/killswitch (ON) => AlertLog SENT no canal stub (e outbox recebe);
//     - segundo toggle dentro do throttle (mesmo evento) => SUPPRESSED;
//     - forcar setor CRITICAL e rodar o ciclo do COO => alerta SECTOR_CRITICAL;
//     - POST /alerts/test [JWT] => envia pelos canais habilitados.
//
// Roda com: pnpm --filter @ebook-empire/api e2e:ops
//        ou: node --import tsx scripts/e2e-finance-alerts.ts  (a partir de apps/api)

import type { Ports, AlertMessage } from '@ebook-empire/core';
import {
  FinanceService,
  AlertService,
  saoPauloDay,
  paymentFeeForOrderCents,
  type AgentContext,
  type AgentEnv,
} from '@ebook-empire/agents';
import {
  StubEmailAdapter,
  EmailAlertChannel,
  StubWhatsAppChannel,
  CompositeNotificationAdapter,
} from '@ebook-empire/adapters';

import { buildServer } from '../src/server.js';
import * as scheduler from '../src/scheduler.js';
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

// ---- ports nao usados pelo FinanceService/AlertService ----
const notImpl = (n: string): never => {
  throw new Error(`${n} indisponivel neste e2e`);
};
const ports = new Proxy({} as Ports, {
  get(_t, prop) {
    return new Proxy(
      {},
      { get: () => () => notImpl(`ports.${String(prop)}`) },
    );
  },
});

const agentEnv: AgentEnv = {
  ENABLE_AGENTS: env.ENABLE_AGENTS,
  MAX_AD_BUDGET_BRL: env.MAX_AD_BUDGET_BRL,
  TARGET_DAILY_REVENUE_BRL: env.TARGET_DAILY_REVENUE_BRL,
  PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
  CONTENT_MODEL,
  PLANNING_MODEL,
  ASAAS_FEE_PERCENT: env.ASAAS_FEE_PERCENT,
  ASAAS_FEE_FIXED_CENTS: env.ASAAS_FEE_FIXED_CENTS,
};

const ctx: AgentContext = { prisma, ports, env: agentEnv, log, clock };

const feeConfig = {
  asaasFeePercent: Number(env.ASAAS_FEE_PERCENT),
  asaasFeeFixedCents: Number(env.ASAAS_FEE_FIXED_CENTS),
};

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

// Limpa as tabelas relevantes em ordem de FK segura.
async function cleanDb(): Promise<void> {
  await prisma.alertLog.deleteMany();
  await prisma.alertSettings.deleteMany();

  await prisma.financeSnapshot.deleteMany();

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
  // EbookAudit (FK RESTRICT -> Ebook) e MarketOpportunity (ref. por Ebook): apaga
  // os dependentes antes dos ebooks/oportunidades para nao violar a FK.
  await prisma.ebookAudit.deleteMany();
  await prisma.ebook.deleteMany();
  await prisma.marketOpportunity.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.customer.deleteMany();
}

async function main(): Promise<void> {
  console.log('\n=== Ebook Empire — E2E Finance + Alerts (Postgres real) ===\n');

  await prisma.$queryRaw`SELECT 1`;
  console.log('[0] Conexao com Postgres OK (5433)\n');

  await cleanDb();

  const app = await buildServer();
  await app.ready();

  const token = app.jwt.sign({ sub: 'e2e-admin', role: 'admin' });
  const auth = { authorization: `Bearer ${token}` };

  const today = saoPauloDay(clock.now());
  // Instante seguro dentro do dia SP atual (12:00 BRT = 15:00 UTC).
  const paidAtToday = new Date(`${today}T15:00:00.000Z`);
  const insightDate = new Date(`${today}T00:00:00.000Z`);

  const finance = new FinanceService();

  try {
    // ========================================================
    // FINANCE — seed determinístico e DRE calculada a mao.
    // ========================================================
    console.log('[1] FINANCE: seed orders PAID + AdInsight + AgentRun');

    // 2 ebooks + 1 product cada.
    const ebookA = await prisma.ebook.create({
      data: { title: 'Ebook A', niche: 'fin', slug: `ea-${Date.now()}`, status: 'PUBLISHED', language: 'pt-BR' },
    });
    const ebookB = await prisma.ebook.create({
      data: { title: 'Ebook B', niche: 'fit', slug: `eb-${Date.now()}`, status: 'PUBLISHED', language: 'pt-BR' },
    });
    const prodA = await prisma.product.create({
      data: { ebookId: ebookA.id, name: 'Prod A', slug: `pa-${Date.now()}`, priceCents: 5000, active: true },
    });
    const prodB = await prisma.product.create({
      data: { ebookId: ebookB.id, name: 'Prod B', slug: `pb-${Date.now()}`, priceCents: 10000, active: true },
    });

    // Campanha ligada ao produto A (para atribuir spend ao ebook A).
    const campA = await prisma.adCampaign.create({
      data: { name: 'Camp A', objective: 'CONVERSIONS', status: 'ACTIVE', platform: 'meta', productId: prodA.id, utmCampaign: 'camp-a' },
    });

    const cust = async (i: number) =>
      prisma.customer.create({ data: { email: `fin.${Date.now()}.${i}@example.com`, name: `C${i}` } });

    // Orders:
    //  - 2x Ebook A @5000 atribuidas a campA (PAID)
    //  - 1x Ebook B @10000 SEM campanha (organic, DELIVERED)
    const c0 = await cust(0);
    const c1 = await cust(1);
    const c2 = await cust(2);
    await prisma.order.create({
      data: { customerId: c0.id, productId: prodA.id, ebookId: ebookA.id, status: 'PAID', priceCents: 5000, paidAt: paidAtToday, adCampaignId: campA.id },
    });
    await prisma.order.create({
      data: { customerId: c1.id, productId: prodA.id, ebookId: ebookA.id, status: 'PAID', priceCents: 5000, paidAt: paidAtToday, adCampaignId: campA.id },
    });
    await prisma.order.create({
      data: { customerId: c2.id, productId: prodB.id, ebookId: ebookB.id, status: 'DELIVERED', priceCents: 10000, paidAt: paidAtToday },
    });
    // Order PENDING (NAO deve entrar na DRE).
    const c3 = await cust(3);
    await prisma.order.create({
      data: { customerId: c3.id, productId: prodB.id, ebookId: ebookB.id, status: 'PENDING', priceCents: 10000 },
    });

    // AdInsight: spend 3000c na campA hoje.
    await prisma.adInsight.create({
      data: { campaignId: campA.id, date: insightDate, impressions: 500, clicks: 30, spendCents: 3000, conversions: 2, revenueCents: 10000 },
    });

    // AgentRun com costCents hoje (LLM): 100c + 50c = 150c.
    await prisma.agentRun.create({ data: { agent: 'CONTENT', status: 'SUCCESS', startedAt: paidAtToday, costCents: 100 } });
    await prisma.agentRun.create({ data: { agent: 'TRAFFIC', status: 'SUCCESS', startedAt: paidAtToday, costCents: 50 } });
    // AgentRun de 2 dias atras (FORA da janela de hoje — NAO deve entrar no llm de hoje).
    await prisma.agentRun.create({
      data: { agent: 'ANALYTICS', status: 'SUCCESS', startedAt: new Date(paidAtToday.getTime() - 2 * 24 * 3600_000), costCents: 999 },
    });

    // ---- Calculo a mao ----
    const gross = 5000 + 5000 + 10000; // 20000
    const fees =
      paymentFeeForOrderCents(5000, feeConfig) * 2 + paymentFeeForOrderCents(10000, feeConfig);
    const adSpend = 3000;
    const llm = 150;
    const net = gross - fees - adSpend - llm;
    const expectedMargin = Math.round((net / gross) * 10000) / 100;
    console.log(
      `  (a mao) gross=${gross} fees=${fees} adSpend=${adSpend} llm=${llm} net=${net} margin=${expectedMargin}%`,
    );

    console.log('[2] GET /finance/dre?date=hoje');
    const dreRes = await app.inject({ method: 'GET', url: `/finance/dre?date=${today}` });
    check('GET /finance/dre 200', dreRes.statusCode === 200, String(dreRes.statusCode));
    const dre = dreRes.json() as {
      grossRevenueCents: number;
      paymentFeesCents: number;
      adSpendCents: number;
      llmCostCents: number;
      netProfitCents: number;
      marginPct: number;
      paidOrders: number;
    };
    check('DRE grossRevenue correto', dre.grossRevenueCents === gross, `got=${dre.grossRevenueCents} exp=${gross}`);
    check('DRE paymentFees correto', dre.paymentFeesCents === fees, `got=${dre.paymentFeesCents} exp=${fees}`);
    check('DRE adSpend correto', dre.adSpendCents === adSpend, `got=${dre.adSpendCents} exp=${adSpend}`);
    check('DRE llmCost correto', dre.llmCostCents === llm, `got=${dre.llmCostCents} exp=${llm}`);
    check('DRE netProfit correto', dre.netProfitCents === net, `got=${dre.netProfitCents} exp=${net}`);
    check('DRE marginPct correto', dre.marginPct === expectedMargin, `got=${dre.marginPct} exp=${expectedMargin}`);
    check('DRE paidOrders=3 (PENDING excluido)', dre.paidOrders === 3, `got=${dre.paidOrders}`);

    console.log('[3] GET /finance/by-ebook?date=hoje');
    const byEbookRes = await app.inject({ method: 'GET', url: `/finance/by-ebook?date=${today}` });
    check('GET /finance/by-ebook 200', byEbookRes.statusCode === 200, String(byEbookRes.statusCode));
    const byEbook = byEbookRes.json() as {
      ebooks: Array<{ ebookId: string; revenueCents: number; orders: number; adSpendAttributedCents: number; netProfitCents: number }>;
      unattributedAdSpendCents: number;
    };
    const eA = byEbook.ebooks.find((e) => e.ebookId === ebookA.id);
    const eB = byEbook.ebooks.find((e) => e.ebookId === ebookB.id);
    check('by-ebook A receita=10000 (2x5000)', eA?.revenueCents === 10000, `got=${eA?.revenueCents}`);
    check('by-ebook A orders=2', eA?.orders === 2, `got=${eA?.orders}`);
    check('by-ebook A spend atribuido=3000 (via campanha->produto)', eA?.adSpendAttributedCents === 3000, `got=${eA?.adSpendAttributedCents}`);
    check('by-ebook B receita=10000', eB?.revenueCents === 10000, `got=${eB?.revenueCents}`);
    check('by-ebook B spend atribuido=0', eB?.adSpendAttributedCents === 0, `got=${eB?.adSpendAttributedCents}`);
    check('by-ebook unattributedAdSpend=0 (todo spend mapeado)', byEbook.unattributedAdSpendCents === 0, `got=${byEbook.unattributedAdSpendCents}`);
    // netProfit ebook A = 10000 - fees(2x5000) - 3000
    const eAfees = paymentFeeForOrderCents(5000, feeConfig) * 2;
    const eAnet = 10000 - eAfees - 3000;
    check('by-ebook A netProfit correto', eA?.netProfitCents === eAnet, `got=${eA?.netProfitCents} exp=${eAnet}`);

    console.log('[4] GET /finance/by-campaign?date=hoje');
    const byCampRes = await app.inject({ method: 'GET', url: `/finance/by-campaign?date=${today}` });
    check('GET /finance/by-campaign 200', byCampRes.statusCode === 200, String(byCampRes.statusCode));
    const byCamp = byCampRes.json() as {
      campaigns: Array<{ campaignId: string; spendCents: number; revenueCents: number; roas: number | null; netProfitCents: number }>;
      organic: { revenueCents: number; orders: number };
    };
    const cmpA = byCamp.campaigns.find((c) => c.campaignId === campA.id);
    check('by-campaign A spend=3000', cmpA?.spendCents === 3000, `got=${cmpA?.spendCents}`);
    check('by-campaign A receita=10000', cmpA?.revenueCents === 10000, `got=${cmpA?.revenueCents}`);
    check('by-campaign A roas=10000/3000', cmpA?.roas === 10000 / 3000, `got=${cmpA?.roas}`);
    check('by-campaign organic receita=10000 (ebook B sem campanha)', byCamp.organic.revenueCents === 10000, `got=${byCamp.organic.revenueCents}`);
    check('by-campaign organic orders=1', byCamp.organic.orders === 1, `got=${byCamp.organic.orders}`);

    console.log('[5] POST /finance/snapshot [JWT] x2 — idempotente');
    const snap1Res = await app.inject({ method: 'POST', url: '/finance/snapshot', headers: auth, payload: { date: today } });
    check('POST /finance/snapshot 200', snap1Res.statusCode === 200, String(snap1Res.statusCode));
    const snap1 = (snap1Res.json() as { snapshot: { id: string; netProfitCents: number } }).snapshot;
    check('snapshot netProfit correto', snap1.netProfitCents === net, `got=${snap1.netProfitCents} exp=${net}`);
    const snap2Res = await app.inject({ method: 'POST', url: '/finance/snapshot', headers: auth, payload: { date: today } });
    const snap2 = (snap2Res.json() as { snapshot: { id: string; netProfitCents: number } }).snapshot;
    const snapCount = await prisma.financeSnapshot.count({ where: { date: insightDate } });
    check('persistSnapshot idempotente (1 linha p/ o dia)', snapCount === 1, `linhas=${snapCount}`);
    check('persistSnapshot reusa o mesmo id (upsert)', snap1.id === snap2.id, `${snap1.id} vs ${snap2.id}`);
    check('snapshot direto via service tambem idempotente', (await finance.persistSnapshot(ctx, { day: today })).id === snap1.id);
    console.log('');

    // ========================================================
    // ALERTS — outbox inspecionavel + route/COO via AlertLog.
    // ========================================================
    console.log('[6] ALERTS: AlertService direto com StubEmail/StubWhatsApp (outbox)');
    // Habilita AMBOS os canais e destinatarios em AlertSettings (singleton).
    await prisma.alertSettings.upsert({
      where: { id: 'singleton' },
      update: {
        alertsEnabled: true,
        channels: { set: ['EMAIL', 'WHATSAPP'] },
        emailRecipients: { set: ['ops@example.com'] },
        whatsappRecipients: { set: ['5511999999999'] },
        enabledEvents: { set: [] },
        throttleMinutes: 60,
      },
      create: {
        id: 'singleton',
        alertsEnabled: true,
        channels: ['EMAIL', 'WHATSAPP'],
        emailRecipients: ['ops@example.com'],
        whatsappRecipients: ['5511999999999'],
        enabledEvents: [],
        throttleMinutes: 60,
      },
    });

    const stubEmail = new StubEmailAdapter();
    const stubWa = new StubWhatsAppChannel();
    const notifier = new CompositeNotificationAdapter([new EmailAlertChannel(stubEmail), stubWa]);
    const alertService = new AlertService({ prisma, notifier, log, clock });

    // Dispara SECTOR_CRITICAL pelo service direto -> outbox de ambos canais.
    await alertService.notify({ event: 'SECTOR_CRITICAL', sector: 'DELIVERY', context: { score: 10 } });
    check('outbox EMAIL recebeu (1 destinatario)', stubEmail.outbox.length === 1, `n=${stubEmail.outbox.length}`);
    check('outbox WHATSAPP recebeu', stubWa.outbox.length === 1, `n=${stubWa.outbox.length}`);
    check('email enviado para destinatario configurado', stubEmail.outbox[0]?.to === 'ops@example.com', stubEmail.outbox[0]?.to ?? '-');
    check('whatsapp para o numero configurado', stubWa.outbox[0]?.recipients[0] === '5511999999999', stubWa.outbox[0]?.recipients[0] ?? '-');
    check('corpo pt-BR menciona CRITICO', /CRITICO/i.test(stubWa.outbox[0]?.body ?? ''), stubWa.outbox[0]?.title ?? '-');

    // AlertLog: 1 SENT por canal.
    const sentLogs = await prisma.alertLog.findMany({ where: { event: 'SECTOR_CRITICAL', status: 'SENT' } });
    check('2 AlertLog SENT (EMAIL+WHATSAPP)', sentLogs.length === 2, `n=${sentLogs.length}`);

    // Segundo disparo IGUAL dentro do throttle => SUPPRESSED (1 linha sentinela).
    await alertService.notify({ event: 'SECTOR_CRITICAL', sector: 'DELIVERY', context: { score: 10 } });
    check('outbox EMAIL NAO cresceu (throttle)', stubEmail.outbox.length === 1, `n=${stubEmail.outbox.length}`);
    const suppressed = await prisma.alertLog.count({ where: { event: 'SECTOR_CRITICAL', status: 'SUPPRESSED' } });
    check('AlertLog SUPPRESSED gravado (dedupe/throttle)', suppressed === 1, `n=${suppressed}`);
    console.log('');

    console.log('[7] POST /crm/killswitch ON => AlertLog SENT (canal EMAIL via wiring real)');
    // O wiring real (scheduler.getAlert) usa USE_STUBS=true => canais stub internos.
    // Settings ja foram resetadas para channels=[EMAIL] abaixo para isolar o teste
    // de throttle do killswitch (evento distinto KILL_SWITCH_ON).
    await prisma.alertSettings.update({
      where: { id: 'singleton' },
      data: { channels: { set: ['EMAIL'] }, throttleMinutes: 60 },
    });
    const ks1 = await app.inject({ method: 'POST', url: '/crm/killswitch', headers: auth, payload: { enabled: true } });
    check('killswitch ON 200', ks1.statusCode === 200 && ks1.json().killSwitch === true, String(ks1.statusCode));
    // O alerta e best-effort/async dentro da rota (await), ja persistiu ao retornar.
    const ksOnSent = await prisma.alertLog.findFirst({ where: { event: 'KILL_SWITCH_ON', status: 'SENT' } });
    check('AlertLog KILL_SWITCH_ON SENT', !!ksOnSent, ksOnSent ? `channel=${ksOnSent.channel}` : 'nenhum');

    console.log('[8] Segundo killswitch ON dentro do throttle => SUPPRESSED');
    // Desliga e liga de novo NAO repetiria o mesmo evento (ON vs OFF distintos).
    // Para provar o throttle do MESMO evento, ligamos novamente sem desligar:
    // o killswitch ja esta ON; um novo POST enabled:true reemite KILL_SWITCH_ON.
    const ks2 = await app.inject({ method: 'POST', url: '/crm/killswitch', headers: auth, payload: { enabled: true } });
    check('segundo killswitch ON 200', ks2.statusCode === 200, String(ks2.statusCode));
    const ksOnSuppressed = await prisma.alertLog.count({ where: { event: 'KILL_SWITCH_ON', status: 'SUPPRESSED' } });
    check('segundo KILL_SWITCH_ON SUPPRESSED (throttle)', ksOnSuppressed >= 1, `n=${ksOnSuppressed}`);
    // Desliga o killswitch para nao bloquear o ciclo do COO no proximo passo.
    await app.inject({ method: 'POST', url: '/crm/killswitch', headers: auth, payload: { enabled: false } });
    await prisma.guardrailConfig.upsert({
      where: { id: 'singleton' },
      update: { killSwitch: false, maxAutoActionsPerCycle: 10, cooldownMinutes: 0 },
      create: { id: 'singleton', killSwitch: false, maxAutoActionsPerCycle: 10, cooldownMinutes: 0 },
    });
    console.log('');

    console.log('[9] Setor CRITICAL via ciclo do COO => alerta SECTOR_CRITICAL disparado');
    // Limpa logs de setor para isolar a deteccao deste ciclo.
    await prisma.alertLog.deleteMany({ where: { event: 'SECTOR_CRITICAL' } });
    // Campanha com ROAS pessimo e spend alto => TRAFFIC tende a CRITICAL.
    const critCampaign = await prisma.adCampaign.create({
      data: { name: 'Camp Critica', objective: 'CONVERSIONS', status: 'ACTIVE', platform: 'meta', dailyBudgetCents: 50000, utmCampaign: 'crit' },
    });
    await prisma.adInsight.create({
      data: { campaignId: critCampaign.id, date: insightDate, impressions: 5000, clicks: 200, spendCents: 80000, conversions: 0, revenueCents: 0 },
    });
    // Reseta settings para EMAIL e throttle 0 para nao suprimir o alerta de setor.
    await prisma.alertSettings.update({
      where: { id: 'singleton' },
      data: { channels: { set: ['EMAIL'] }, throttleMinutes: 0 },
    });

    const cycle1 = await runOperationsCycle(app);
    check('COO ciclo disponivel', cycle1.status !== 'UNAVAILABLE', cycle1.status);
    // Verifica se algum setor ficou CRITICAL neste ciclo (score<40).
    const critSnaps = await prisma.sectorHealthSnapshot.findMany({
      where: { cycleId: cycle1.cycleId, score: { lt: 40 } },
      select: { sector: true, score: true },
    });
    const sectorCritLog = await prisma.alertLog.findFirst({ where: { event: 'SECTOR_CRITICAL' } });
    if (critSnaps.length > 0) {
      check('setor CRITICAL detectado no ciclo', true, critSnaps.map((s) => `${s.sector}=${s.score}`).join(','));
      check('alerta SECTOR_CRITICAL disparado pelo COO', !!sectorCritLog,
        sectorCritLog ? `sector=${sectorCritLog.sector} status=${sectorCritLog.status}` : 'nenhum AlertLog');
    } else {
      // Sem CRITICAL natural, prova o gatilho diretamente pelo AlertService (mesma borda).
      check('setor CRITICAL detectado no ciclo', false, 'nenhum setor <40 — usando prova direta do gatilho');
      const alert = await scheduler.getAlert(app);
      await alert?.notify({ event: 'SECTOR_CRITICAL', sector: 'TRAFFIC', context: { score: 20 } });
      const direct = await prisma.alertLog.findFirst({ where: { event: 'SECTOR_CRITICAL' } });
      check('alerta SECTOR_CRITICAL disparado (gatilho direto via wiring)', !!direct,
        direct ? `status=${direct.status}` : 'nenhum');
    }
    console.log('');

    console.log('[10] POST /alerts/test [JWT] => envia pelos canais habilitados');
    const testRes = await app.inject({ method: 'POST', url: '/alerts/test', headers: auth, payload: {} });
    check('POST /alerts/test 200 (algum canal SENT)', testRes.statusCode === 200, String(testRes.statusCode));
    const testBody = testRes.json() as { tested: boolean; results: Array<{ channel: string; status: string }> };
    check('alerts/test marca tested=true', testBody.tested === true, JSON.stringify(testBody.results));
    check('alerts/test enviou pelo menos 1 canal SENT', testBody.results.some((r) => r.status === 'SENT'),
      testBody.results.map((r) => `${r.channel}:${r.status}`).join(','));
    const testLog = await prisma.alertLog.findFirst({ where: { dedupeKey: { startsWith: 'TEST:' } } });
    check('AlertLog do teste persistido', !!testLog, testLog ? `status=${testLog.status}` : 'nenhum');
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
  console.error('\nE2E Finance/Alerts abortou com erro:', err);
  process.exit(1);
});
