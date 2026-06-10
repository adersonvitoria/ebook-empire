// E2E de validacao contra Postgres REAL (nao mock de DB).
// Exercita o trilho de negocio ponta a ponta em modo stub (USE_STUBS=true):
//   1) ContentAgent gera Ebook + Product (LLM stub) e grava o PDF no storage local
//   2) POST /checkout  (HTTP via inject) -> cria Order + Payment + cobranca PIX
//   3) POST /webhooks/asaas (HTTP) -> Order PAID  (+ teste de idempotencia: 2x)
//   4) DeliveryAgent -> cria DeliveryGrant, envia email (stub), Order DELIVERED
//   5) GET /download/:token (HTTP) -> baixa o PDF; repete ate exaurir o limite
//   6) AnalyticsAgent -> calcula receita do dia / progresso da meta
//
// Roda com: pnpm --filter @ebook-empire/api exec tsx scripts/e2e.ts
// O token plano de download NAO e persistido (so sha256); este script o captura
// do outbox do StubEmailAdapter, exatamente como o cliente final o receberia.

import type { Ports, PaymentPort, InstagramPort, AdsPort } from '@ebook-empire/core';
import {
  ContentAgent,
  DeliveryAgent,
  AnalyticsAgent,
  type AgentContext,
  type AgentEnv,
} from '@ebook-empire/agents';
import {
  createLLMAdapter,
  createStorageAdapter,
  StubEmailAdapter,
} from '@ebook-empire/adapters';

import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { env, CONTENT_MODEL, PLANNING_MODEL } from '../src/env.js';
import { buildEbookPdf } from '../src/lib/pdf.js';

// ---- logger e clock minimos ----
const log = {
  debug: () => {},
  info: (_o: unknown, _m?: string) => {},
  warn: (o: unknown, m?: string) => console.warn('  [warn]', m ?? '', o),
  error: (o: unknown, m?: string) => console.error('  [error]', m ?? '', o),
};
const clock = { now: () => new Date() };

// ---- ports: real (llm/storage/email) + throwers para os nao usados ----
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
const unusedAds: AdsPort = {
  createCampaign: () => notImpl('ads.createCampaign'),
  updateBudget: () => notImpl('ads.updateBudget'),
  setStatus: () => notImpl('ads.setStatus'),
  getInsights: () => notImpl('ads.getInsights'),
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

const ports: Ports = {
  llm,
  storage,
  email,
  payment: unusedPayment,
  instagram: unusedInstagram,
  ads: unusedAds,
};

const agentEnv: AgentEnv = {
  ENABLE_AGENTS: env.ENABLE_AGENTS,
  MAX_AD_BUDGET_BRL: env.MAX_AD_BUDGET_BRL,
  TARGET_DAILY_REVENUE_BRL: env.TARGET_DAILY_REVENUE_BRL,
  PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
  CONTENT_MODEL,
  PLANNING_MODEL,
};

const ctx: AgentContext = { prisma, ports, env: agentEnv, log, clock };

// ---- helpers de asserts ----
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

async function cleanDb(): Promise<void> {
  // Ordem segura de FK.
  await prisma.event.deleteMany();
  await prisma.deliveryGrant.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.order.deleteMany();
  await prisma.adInsight.deleteMany();
  await prisma.adCampaign.deleteMany();
  await prisma.socialPost.deleteMany();
  await prisma.product.deleteMany();
  // EbookAudit tem FK RESTRICT para Ebook; MarketOpportunity e referenciada por
  // Ebook.marketOpportunityId. Apaga os dependentes ANTES dos ebooks/oportunidades
  // (setores MARKET_RESEARCH/EBOOK_QA podem ter deixado linhas de execucoes anteriores).
  await prisma.ebookAudit.deleteMany();
  await prisma.ebook.deleteMany();
  await prisma.marketOpportunity.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.customer.deleteMany();
}

async function main(): Promise<void> {
  console.log('\n=== Ebook Empire — E2E contra Postgres real ===\n');

  // Sanidade de conexao.
  await prisma.$queryRaw`SELECT 1`;
  console.log('[0] Conexao com Postgres OK\n');

  await cleanDb();

  const app = await buildServer();
  await app.ready();

  try {
    // ---- 1) Geracao de ebook ----
    console.log('[1] ContentAgent — geracao de ebook (LLM stub)');
    const content = new ContentAgent(buildEbookPdf, {
      niche: 'financas pessoais',
      title: 'Liberdade Financeira em 90 Dias',
      language: 'pt-BR',
    });
    const contentRun = await content.execute(ctx);
    check('ContentAgent SUCCESS', contentRun.status === 'SUCCESS', contentRun.status);

    const product = await prisma.product.findFirst({
      where: { active: true },
      include: { ebook: true },
      orderBy: { createdAt: 'desc' },
    });
    check('Product criado e ativo', !!product, product?.slug ?? 'nenhum');
    check('Ebook com PDF gerado', !!product?.ebook.pdfPath, product?.ebook.pdfPath ?? 'sem pdfPath');
    if (!product) throw new Error('sem produto — abortando');
    console.log(
      `    ebook="${product.ebook.title}" preco=R$${(product.priceCents / 100).toFixed(2)}\n`,
    );

    // ---- 2) Checkout ----
    console.log('[2] POST /checkout (HTTP)');
    const checkoutRes = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: {
        productSlug: product.slug,
        customer: {
          name: 'Cliente Teste',
          email: 'cliente.teste@example.com',
          cpfCnpj: '12345678909',
        },
        utm: { utmSource: 'instagram', utmMedium: 'cpc', utmCampaign: 'e2e' },
        visitorId: 'visitor-e2e-1',
      },
    });
    check('checkout 201', checkoutRes.statusCode === 201, String(checkoutRes.statusCode));
    const checkoutBody = checkoutRes.json() as {
      orderId: string;
      status: string;
      pixCopyPaste?: string;
    };
    check('order AWAITING_PAYMENT', checkoutBody.status === 'AWAITING_PAYMENT', checkoutBody.status);
    check('PIX copia-e-cola presente', !!checkoutBody.pixCopyPaste);

    const paymentRow = await prisma.payment.findFirst({ where: { orderId: checkoutBody.orderId } });
    check('Payment PENDING no banco', paymentRow?.status === 'PENDING', paymentRow?.status ?? 'nenhum');
    const providerPaymentId = paymentRow!.providerPaymentId!;
    console.log(`    orderId=${checkoutBody.orderId} pix=${providerPaymentId}\n`);

    // ---- 3) Webhook Asaas (pagamento confirmado) + idempotencia ----
    console.log('[3] POST /webhooks/asaas (HTTP) + idempotencia');
    const webhookPayload = {
      id: `evt_${providerPaymentId}_PAYMENT_RECEIVED`,
      event: 'PAYMENT_RECEIVED',
      payment: { id: providerPaymentId, status: 'RECEIVED' },
    };
    const webhookHeaders = { 'asaas-access-token': 'stub-webhook-token' };

    const wh1 = await app.inject({
      method: 'POST',
      url: '/webhooks/asaas',
      headers: webhookHeaders,
      payload: webhookPayload,
    });
    check('webhook 200', wh1.statusCode === 200, String(wh1.statusCode));

    const orderAfter = await prisma.order.findUnique({ where: { id: checkoutBody.orderId } });
    check('Order PAID apos webhook', orderAfter?.status === 'PAID', orderAfter?.status ?? 'nenhum');

    const wh2 = await app.inject({
      method: 'POST',
      url: '/webhooks/asaas',
      headers: webhookHeaders,
      payload: webhookPayload,
    });
    const wh2Body = wh2.json() as { idempotent?: boolean };
    check('webhook reenviado e idempotente', wh2.statusCode === 200 && wh2Body.idempotent === true);

    const paidEvents = await prisma.event.count({ where: { type: 'PAID', orderId: checkoutBody.orderId } });
    check('apenas 1 Event PAID (sem duplicar)', paidEvents === 1, `eventos=${paidEvents}`);

    const wh401 = await app.inject({
      method: 'POST',
      url: '/webhooks/asaas',
      headers: { 'asaas-access-token': 'token-errado' },
      payload: webhookPayload,
    });
    check('webhook com token invalido -> 401', wh401.statusCode === 401, String(wh401.statusCode));
    console.log('');

    // ---- 4) Entrega ----
    console.log('[4] DeliveryAgent — grant + email');
    const deliveryRun = await new DeliveryAgent().execute(ctx);
    check('DeliveryAgent SUCCESS', deliveryRun.status === 'SUCCESS', deliveryRun.status);

    const orderDelivered = await prisma.order.findUnique({ where: { id: checkoutBody.orderId } });
    check('Order DELIVERED', orderDelivered?.status === 'DELIVERED', orderDelivered?.status ?? 'nenhum');

    const grant = await prisma.deliveryGrant.findUnique({ where: { orderId: checkoutBody.orderId } });
    check('DeliveryGrant criado', !!grant, grant?.status ?? 'nenhum');

    check('email enviado ao cliente', email.outbox.length === 1, `outbox=${email.outbox.length}`);
    const sentEmail = email.outbox[0];
    const tokenMatch = sentEmail?.text?.match(/\/download\/([^\s)]+)/);
    const token = tokenMatch?.[1] ?? '';
    check('link de download presente no email', !!token, token ? token.slice(0, 12) + '...' : 'ausente');
    console.log('');

    // ---- 5) Download ----
    console.log('[5] GET /download/:token (HTTP)');
    const dl = await app.inject({ method: 'GET', url: `/download/${token}` });
    check('download 200', dl.statusCode === 200, String(dl.statusCode));
    check('content-type PDF', dl.headers['content-type'] === 'application/pdf', String(dl.headers['content-type']));
    const pdfBytes = dl.rawPayload;
    check('PDF tem bytes (%PDF)', pdfBytes.length > 100 && pdfBytes.subarray(0, 4).toString() === '%PDF', `${pdfBytes.length} bytes`);

    const grantAfter1 = await prisma.deliveryGrant.findUnique({ where: { orderId: checkoutBody.orderId } });
    check('contador de download incrementou', grantAfter1?.downloadCount === 1, `count=${grantAfter1?.downloadCount}`);

    // Exaure o limite (maxDownloads=5) para provar o gate.
    const maxDownloads = grant!.maxDownloads;
    for (let i = grantAfter1!.downloadCount; i < maxDownloads; i++) {
      await app.inject({ method: 'GET', url: `/download/${token}` });
    }
    const dlOver = await app.inject({ method: 'GET', url: `/download/${token}` });
    check('download alem do limite -> 410', dlOver.statusCode === 410, String(dlOver.statusCode));

    const dlBad = await app.inject({ method: 'GET', url: '/download/token-inexistente' });
    check('token invalido -> 404', dlBad.statusCode === 404, String(dlBad.statusCode));
    console.log('');

    // ---- 6) Analytics ----
    console.log('[6] AnalyticsAgent — KPIs / receita');
    const analyticsResult = await new AnalyticsAgent().run(ctx);
    check('AnalyticsAgent SUCCESS', analyticsResult.status === 'SUCCESS', analyticsResult.status);
    const out = (analyticsResult.output ?? {}) as Record<string, unknown>;
    console.log('    KPI snapshot:', JSON.stringify(out));
    const revenueCents = await prisma.order.aggregate({
      _sum: { priceCents: true },
      where: { status: { in: ['PAID', 'DELIVERED'] } },
    });
    check('receita reconhecida > 0', (revenueCents._sum.priceCents ?? 0) > 0, `R$${((revenueCents._sum.priceCents ?? 0) / 100).toFixed(2)}`);

    const agentRuns = await prisma.agentRun.count();
    check('AgentRun registrados', agentRuns >= 2, `runs=${agentRuns}`);
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
  console.error('\nE2E abortou com erro:', err);
  process.exit(1);
});
