// E2E da VITRINE PUBLICA (storefront) contra Postgres REAL (5433).
// Espelha o padrao de apps/api/scripts/e2e-crm.ts: buildServer + app.inject,
// limpando as tabelas no inicio. USE_STUBS=true (LLM stub deterministico).
//
// Prova o fluxo de venda publico ponta a ponta:
//   (a) GET /storefront/featured            -> o Product PUBLISHED de MAIOR potencial;
//   (b) GET /storefront/products/:slug      -> 200 do existente, 404 de inexistente;
//   (c) POST /checkout pelo slug do featured -> 201 + pixCopyPaste (compra publica);
//   (d) POST /storefront/chat (USE_STUBS)   -> 200 { reply } (source llm);
//   (e) RATE-LIMIT: > SALES_BOT_PER_IP_PER_30MIN chamadas do mesmo IP -> 429;
//   (f) SALES_BOT_ENABLED=false (SUBPROCESSO) -> chat responde canned, sem erro.
//
// Roda com: pnpm --filter @ebook-empire/api e2e:storefront
//        ou: node --import tsx scripts/e2e-storefront.ts  (a partir de apps/api)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';

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

// Limpa as tabelas em ordem de FK segura (mesmo conjunto do e2e-crm). Apaga os
// dependentes de Ebook/MarketOpportunity antes deles.
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
  await prisma.ebookAudit.deleteMany();
  await prisma.ebook.deleteMany();
  await prisma.marketOpportunity.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.customer.deleteMany();
}

// Cria uma MarketOpportunity com potentialScore informado e devolve o id.
async function seedOpportunity(
  potentialScore: number,
  angles: string[],
): Promise<string> {
  const opp = await prisma.marketOpportunity.create({
    data: {
      segment: 'Produtividade',
      niche: 'foco e disciplina',
      demandScore: 80,
      competitionScore: 30,
      potentialScore,
      rationale: 'Oportunidade de teste e2e.',
      titleIdeas: ['Ideia 1', 'Ideia 2'] as never,
      angles: angles as never,
      evidence: ['sinal interno'] as never,
    },
  });
  return opp.id;
}

// Cria 1 Ebook PUBLISHED (ligado a uma MarketOpportunity) + Product ativo.
async function seedPublishedProduct(args: {
  potentialScore: number;
  angles: string[];
  chapters: string[];
  label: string;
}): Promise<{ ebookId: string; productSlug: string }> {
  const oppId = await seedOpportunity(args.potentialScore, args.angles);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ebook = await prisma.ebook.create({
    data: {
      title: `Ebook ${args.label}`,
      niche: 'foco e disciplina',
      slug: `ebook-${args.label}-${stamp}`,
      status: 'PUBLISHED',
      language: 'pt-BR',
      contentMarkdown: '# Conteudo',
      marketOpportunityId: oppId,
      outline: {
        title: `Ebook ${args.label}`,
        niche: 'foco e disciplina',
        subtitle: 'Do zero ao avancado',
        chapters: args.chapters.map((t, i) => ({
          title: t,
          summary: `Resumo do capitulo ${i + 1}.`,
        })),
      } as never,
    },
  });
  const productSlug = `prod-${args.label}-${stamp}`;
  await prisma.product.create({
    data: {
      ebookId: ebook.id,
      name: `Produto ${args.label}`,
      slug: productSlug,
      description: 'Descricao de venda completa e persuasiva do produto.',
      priceCents: 4700,
      active: true,
    },
  });
  return { ebookId: ebook.id, productSlug };
}

async function main(): Promise<void> {
  console.log('\n=== Ebook Empire — E2E Storefront (vitrine publica, Postgres real) ===\n');

  await prisma.$queryRaw`SELECT 1`;
  console.log('[0] Conexao com Postgres OK (5433)\n');

  await cleanDb();

  const app = await buildServer();
  await app.ready();

  try {
    // ========================================================
    // Seed: dois produtos PUBLISHED — um de ALTO potencial (featured esperado)
    // e um de potencial MENOR (nao deve ser o featured).
    // ========================================================
    console.log('[1] Seed de catalogo (featured = maior potentialScore)');
    const high = await seedPublishedProduct({
      potentialScore: 92,
      angles: ['Voce procrastina e perde prazos.', 'Falta um metodo simples de foco.'],
      chapters: ['Por que voce trava', 'O metodo dos 3 blocos', 'Habitos que sustentam'],
      label: 'alto',
    });
    const low = await seedPublishedProduct({
      potentialScore: 41,
      angles: ['Dificuldade de comecar.'],
      chapters: ['Primeiros passos', 'Mantendo o ritmo', 'Revisao semanal'],
      label: 'baixo',
    });
    check('2 produtos PUBLISHED ativos semeados', !!high.productSlug && !!low.productSlug,
      `featured=${high.productSlug} outro=${low.productSlug}`);

    // ========================================================
    // (a) GET /storefront/featured -> o de MAIOR potencial
    // ========================================================
    console.log('[2] (a) GET /storefront/featured');
    const featuredRes = await app.inject({ method: 'GET', url: '/storefront/featured' });
    check('featured -> 200', featuredRes.statusCode === 200, String(featuredRes.statusCode));
    const featured = featuredRes.json();
    check('featured e o produto de MAIOR potencial', featured?.product?.slug === high.productSlug,
      `slug=${featured?.product?.slug}`);
    check('featured expoe potentialScore correto', featured?.opportunity?.potentialScore === 92,
      `score=${featured?.opportunity?.potentialScore}`);
    check('featured deriva whatsInside dos capitulos reais',
      Array.isArray(featured?.ebook?.whatsInside) && featured.ebook.whatsInside.length === 3,
      `whatsInside=${JSON.stringify(featured?.ebook?.whatsInside)}`);
    check('featured deriva painPoints dos angles reais',
      Array.isArray(featured?.copy?.painPoints) &&
        featured.copy.painPoints.includes('Voce procrastina e perde prazos.'),
      `painPoints=${JSON.stringify(featured?.copy?.painPoints)}`);
    check('featured tem priceFormatted pt-BR', typeof featured?.product?.priceFormatted === 'string' &&
      featured.product.priceFormatted.includes('47,00'), featured?.product?.priceFormatted);
    // NUNCA vazar campos admin/conteudo.
    check('featured NAO vaza contentMarkdown', featured?.ebook?.contentMarkdown === undefined,
      'sem contentMarkdown no DTO');

    // ========================================================
    // (b) GET /storefront/products/:slug -> 200 do existente, 404 de inexistente
    // ========================================================
    console.log('[3] (b) GET /storefront/products/:slug');
    const bySlugRes = await app.inject({
      method: 'GET',
      url: `/storefront/products/${low.productSlug}`,
    });
    check('produto existente -> 200', bySlugRes.statusCode === 200, String(bySlugRes.statusCode));
    check('DTO traz o slug pedido', bySlugRes.json()?.product?.slug === low.productSlug,
      bySlugRes.json()?.product?.slug);

    const missingRes = await app.inject({
      method: 'GET',
      url: '/storefront/products/slug-que-nao-existe',
    });
    check('produto inexistente -> 404', missingRes.statusCode === 404, String(missingRes.statusCode));
    check('404 com error=product_not_found', missingRes.json()?.error === 'product_not_found',
      missingRes.json()?.error);

    // ========================================================
    // (c) POST /checkout pelo slug do featured -> 201 + pixCopyPaste
    // ========================================================
    console.log('[4] (c) POST /checkout (fluxo de compra publico) pelo slug do featured');
    const checkoutRes = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: {
        productSlug: high.productSlug,
        customer: {
          name: 'Comprador Teste',
          email: `comprador.${Date.now()}@example.com`,
          cpfCnpj: '24971563792',
        },
        utm: { utmSource: 'oferta', utmMedium: 'organico' },
        visitorId: 'visitor-e2e-storefront',
      },
    });
    check('checkout -> 201', checkoutRes.statusCode === 201, String(checkoutRes.statusCode));
    const checkout = checkoutRes.json();
    check('checkout retorna orderId', typeof checkout?.orderId === 'string' && checkout.orderId.length > 0,
      checkout?.orderId);
    check('checkout retorna pixCopyPaste', typeof checkout?.pixCopyPaste === 'string' &&
      checkout.pixCopyPaste.length > 0, checkout?.pixCopyPaste ? 'presente' : 'ausente');
    check('checkout retorna status AWAITING_PAYMENT', checkout?.status === 'AWAITING_PAYMENT',
      checkout?.status);
    // Persistiu Order + Payment de fato.
    const orderRow = checkout?.orderId
      ? await prisma.order.findUnique({ where: { id: checkout.orderId }, include: { payment: true } })
      : null;
    check('Order persistida com Payment PIX', !!orderRow && !!orderRow.payment &&
      orderRow.payment.method === 'PIX', orderRow?.payment ? 'ok' : 'sem payment');

    // ========================================================
    // (d) POST /storefront/chat (USE_STUBS) -> 200 { reply }
    // ========================================================
    console.log('[5] (d) POST /storefront/chat (USE_STUBS -> stub LLM)');
    check('ambiente em USE_STUBS=true (chat usa stub LLM)', env.USE_STUBS === true, String(env.USE_STUBS));
    const chatRes = await app.inject({
      method: 'POST',
      url: '/storefront/chat',
      payload: {
        productSlug: high.productSlug,
        messages: [{ role: 'user', content: 'Quanto custa e o que vem dentro?' }],
      },
    });
    check('chat -> 200', chatRes.statusCode === 200, String(chatRes.statusCode));
    const chat = chatRes.json();
    check('chat retorna reply nao-vazio', typeof chat?.reply === 'string' && chat.reply.length > 0,
      `len=${typeof chat?.reply === 'string' ? chat.reply.length : 'n/a'}`);
    check('chat source=llm sob USE_STUBS', chat?.source === 'llm', chat?.source);

    // ========================================================
    // (e) RATE-LIMIT: > SALES_BOT_PER_IP_PER_30MIN chamadas do mesmo IP -> 429
    // ========================================================
    console.log('[6] (e) RATE-LIMIT por IP (token bucket)');
    const cap = env.SALES_BOT_PER_IP_PER_30MIN;
    console.log(`     capacidade por IP = ${cap}; disparando ${cap + 5} chamadas do mesmo IP`);
    const rlPayload = {
      productSlug: high.productSlug,
      messages: [{ role: 'user', content: 'ola, tudo bem?' }],
    };
    // O bucket ja consumiu 1 token no passo (d) (mesmo IP local). Disparamos
    // capacidade+folga; ao esgotar deve aparecer pelo menos um 429.
    let got429 = false;
    let retryAfterHeaderSeen = false;
    let okCount = 0;
    for (let i = 0; i < cap + 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/storefront/chat',
        payload: rlPayload,
        // remoteAddress fixa o IP do bucket (mesmo IP em todas as chamadas).
        remoteAddress: '203.0.113.7',
      });
      if (r.statusCode === 200) okCount += 1;
      if (r.statusCode === 429) {
        got429 = true;
        if (r.headers['retry-after']) retryAfterHeaderSeen = true;
        check('429 com error=rate_limited', r.json()?.error === 'rate_limited', r.json()?.error);
        check('429 com retryAfterSec > 0', (r.json()?.retryAfterSec ?? 0) > 0,
          String(r.json()?.retryAfterSec));
        break;
      }
    }
    check('rate-limit dispara 429 ao estourar a capacidade do IP', got429, `oks antes do 429=${okCount}`);
    check('429 inclui header Retry-After', retryAfterHeaderSeen, retryAfterHeaderSeen ? 'ok' : 'ausente');

    // ========================================================
    // (f) SALES_BOT_ENABLED=false (SUBPROCESSO) -> chat responde canned
    // Re-executa este mesmo script com STOREFRONT_CANNED_CHILD=1 e o env desligado.
    // ========================================================
    console.log('[7] (f) SALES_BOT_ENABLED=false (subprocesso) -> canned, sem erro');
    const selfPath = fileURLToPath(import.meta.url);
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', selfPath],
      {
        env: {
          ...process.env,
          STOREFRONT_CANNED_CHILD: '1',
          SALES_BOT_ENABLED: 'false',
          USE_STUBS: 'true',
        },
        encoding: 'utf-8',
      },
    );
    const childOut = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    check('subprocesso (kill switch) terminou com sucesso', child.status === 0,
      `exit=${child.status}`);
    check('subprocesso confirmou resposta canned sem chamar LLM',
      childOut.includes('CANNED_OK'), childOut.includes('CANNED_OK') ? 'CANNED_OK' : childOut.slice(-400));
  } finally {
    await app.close();
    await prisma.$disconnect();
  }

  console.log('\n=== Resultado ===');
  console.log(`  PASSARAM: ${passed}   FALHARAM: ${failed}\n`);
  if (failed > 0) process.exit(1);
}

// --------------------------------------------------------
// Modo SUBPROCESSO (f): roda com SALES_BOT_ENABLED=false e prova que o chat
// devolve { source: 'canned' } com 200 (degradacao graciosa, sem chamar LLM).
// Nao toca o banco alem da leitura do produto; reusa o catalogo ja semeado pelo
// processo-pai (mesmo DB). Imprime CANNED_OK no sucesso.
// --------------------------------------------------------
async function cannedChild(): Promise<void> {
  // Sanidade: o env do filho realmente desligou o bot.
  if (env.SALES_BOT_ENABLED !== false) {
    console.error('CANNED_FAIL: SALES_BOT_ENABLED nao e false no subprocesso');
    process.exit(1);
  }
  const product = await prisma.product.findFirst({
    where: { active: true, ebook: { status: 'PUBLISHED' } },
    orderBy: { createdAt: 'desc' },
  });
  if (!product) {
    console.error('CANNED_FAIL: nenhum produto PUBLISHED ativo para o teste canned');
    process.exit(1);
  }
  const app = await buildServer();
  await app.ready();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/storefront/chat',
      payload: {
        productSlug: product.slug,
        messages: [{ role: 'user', content: 'oi, me ajuda a decidir?' }],
      },
    });
    const body = res.json();
    if (res.statusCode === 200 && body?.source === 'canned' && typeof body.reply === 'string' && body.reply.length > 0) {
      console.log('CANNED_OK');
      process.exit(0);
    }
    console.error(`CANNED_FAIL: status=${res.statusCode} source=${body?.source}`);
    process.exit(1);
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
}

if (process.env.STOREFRONT_CANNED_CHILD === '1') {
  cannedChild().catch((err) => {
    console.error('CANNED_FAIL (excecao):', err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error('\nE2E Storefront abortou com erro:', err);
    process.exit(1);
  });
}
