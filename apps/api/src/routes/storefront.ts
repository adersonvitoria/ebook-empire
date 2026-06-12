// Rotas da VITRINE PUBLICA (storefront). Plugin Fastify: exporta default
// async (fastify) => {}. NUNCA editar server.ts para adicionar rotas — o
// registro ja existe la (Fundacao).
//
// TODAS as rotas aqui sao PUBLICAS (sem preHandler: fastify.authenticate).
// Endpoints:
//   GET  /storefront/health          -> healthcheck publico da vitrine.
//   GET  /storefront/featured        -> StorefrontFeatured do produto FEATURED.
//   GET  /storefront/products/:slug  -> StorefrontFeatured de um produto.
//   POST /storefront/chat            -> chat de vendas 24/7 (com guardrails de custo).
//
// A copy de venda e DERIVADA server-side dos campos REAIS (Product/Ebook/
// MarketOpportunity). NUNCA expor contentMarkdown nem campos admin — select/map
// explicito. Ver docs/STOREFRONT.md.

import type { FastifyInstance } from 'fastify';
import {
  salesChatBodySchema,
  ebookOutlineSchema,
  type StorefrontFeatured,
  type StorefrontChatMessage,
} from '@ebook-empire/core';
import { createLLMAdapter } from '@ebook-empire/adapters';
import { prisma } from '../db.js';
import { env, CONTENT_MODEL } from '../env.js';

// ------------------------------------------------------------
// LLM adapter — UMA instancia por processo (igual _paymentPort do checkout.ts).
// Sob USE_STUBS=true (default CI/teste) usa o StubLLMAdapter deterministico.
// ------------------------------------------------------------
const llm = createLLMAdapter({
  USE_STUBS: env.USE_STUBS,
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
});

// Exportado para testes: permite injetar/inspecionar o adapter compartilhado.
export const _llmPort = llm;

// ------------------------------------------------------------
// Guardrails de custo — estado em memoria, por processo (module-level).
// Limitacao aceita: 1 instancia no Railway hoje; com >1 cada uma tem seu teto.
// ------------------------------------------------------------

// (A) Rate-limit por IP: token bucket. Capacidade vem do env; janela fixa 30min.
const RL_WINDOW_MS = 30 * 60 * 1000;
const RL_CAPACITY = env.SALES_BOT_PER_IP_PER_30MIN;
const RL_REFILL_PER_MS = RL_CAPACITY / RL_WINDOW_MS;

interface Bucket {
  tokens: number;
  updatedAt: number;
}
const buckets = new Map<string, Bucket>();
let lastSweepAt = 0;

/**
 * Consome 1 token do bucket do IP. Retorna { ok:true } se havia token, ou
 * { ok:false, retryAfterSec } com o tempo ate o proximo token disponivel.
 */
function takeToken(ip: string, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
  // Sweep leve: descarta buckets cheios e velhos (no maximo 1x/min).
  if (now - lastSweepAt > 60_000) {
    lastSweepAt = now;
    for (const [key, b] of buckets) {
      const refilled = Math.min(RL_CAPACITY, b.tokens + (now - b.updatedAt) * RL_REFILL_PER_MS);
      if (refilled >= RL_CAPACITY && now - b.updatedAt > RL_WINDOW_MS) {
        buckets.delete(key);
      }
    }
  }

  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RL_CAPACITY, updatedAt: now };
    buckets.set(ip, bucket);
  } else {
    // Refil linear desde a ultima atualizacao.
    bucket.tokens = Math.min(RL_CAPACITY, bucket.tokens + (now - bucket.updatedAt) * RL_REFILL_PER_MS);
    bucket.updatedAt = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true };
  }
  // Tempo ate ter 1 token inteiro.
  const deficit = 1 - bucket.tokens;
  const retryAfterSec = Math.max(1, Math.ceil(deficit / RL_REFILL_PER_MS / 1000));
  return { ok: false, retryAfterSec };
}

// (B) Teto diario global de chamadas REAIS ao LLM (UTC).
const dailyCounter = { dayKey: '', count: 0 };

function dayKeyUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/** true => ainda ha cota diaria; false => teto atingido (responder canned). */
function dailyBudgetAvailable(now: number): boolean {
  const key = dayKeyUtc(now);
  if (dailyCounter.dayKey !== key) {
    dailyCounter.dayKey = key;
    dailyCounter.count = 0;
  }
  return dailyCounter.count < env.SALES_BOT_DAILY_LIMIT;
}

/** Incrementa o contador diario (chamado SO em chamada real ao LLM). */
function recordLlmCall(now: number): void {
  const key = dayKeyUtc(now);
  if (dailyCounter.dayKey !== key) {
    dailyCounter.dayKey = key;
    dailyCounter.count = 0;
  }
  dailyCounter.count += 1;
}

// Reset de estado para testes (nao usado em producao).
export function _resetStorefrontGuards(): void {
  buckets.clear();
  lastSweepAt = 0;
  dailyCounter.dayKey = '';
  dailyCounter.count = 0;
}

// ------------------------------------------------------------
// Helpers de derivacao da copy (campos REAIS -> DTO publico).
// ------------------------------------------------------------

function formatPrice(priceCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: currency || 'BRL',
    }).format(priceCents / 100);
  } catch {
    // currency invalida — fallback honesto em reais.
    return `R$ ${(priceCents / 100).toFixed(2).replace('.', ',')}`;
  }
}

/** Le um Json string[] de forma defensiva (angles/titleIdeas). */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/**
 * Extrai os titulos dos capitulos de Ebook.outline (Json?), com parse defensivo.
 * Em falha (null / formato legado) retorna [] — fallback por niche acontece a parte.
 * NUNCA inventa capitulos.
 */
function whatsInsideFrom(outline: unknown): string[] {
  const parsed = ebookOutlineSchema.safeParse(outline);
  if (!parsed.success) return [];
  return parsed.data.chapters.map((c) => c.title).filter((t) => t.trim().length > 0);
}

/** Subtitle real vem do outline (Ebook nao tem coluna subtitle). */
function subtitleFrom(outline: unknown): string | undefined {
  const parsed = ebookOutlineSchema.safeParse(outline);
  if (!parsed.success) return undefined;
  const s = parsed.data.subtitle;
  return s && s.trim().length > 0 ? s : undefined;
}

// Registro Prisma cru (com include) que alimenta o DTO. Tipado fraco de
// proposito — o map abaixo seleciona campos explicitamente.
interface ProductWithEbook {
  slug: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  ebook: {
    title: string;
    niche: string;
    language: string;
    outline: unknown;
    coverImagePath: string | null;
    marketOpportunity: {
      potentialScore: number;
      angles: unknown;
    } | null;
  };
}

/**
 * Monta o StorefrontFeatured (DTO publico) a partir do registro REAL. Toda a
 * copy e derivada de campos reais; campos vazios degradam para texto generico
 * honesto por niche — NUNCA inventa numeros/bonus/depoimentos.
 */
function toOfferDTO(p: ProductWithEbook): StorefrontFeatured {
  const niche = p.ebook.niche;
  const angles = asStringArray(p.ebook.marketOpportunity?.angles);
  const whatsInside = whatsInsideFrom(p.ebook.outline);
  const subtitle = subtitleFrom(p.ebook.outline);

  // painPoints: dor->solucao. De angles; fallback honesto por niche.
  const painPoints =
    angles.length > 0
      ? angles.slice(0, 4)
      : [
          `Voce ja tentou aprender ${niche} sozinho e se perdeu no meio do caminho.`,
          `Falta um material direto ao ponto, em portugues, que mostre o que importa.`,
          `Aqui e diferente: um guia organizado para voce avancar com clareza.`,
        ];

  // bullets: beneficios/o-que-leva. De whatsInside; fallback honesto por niche.
  const bullets =
    whatsInside.length > 0
      ? whatsInside.slice(0, 8)
      : [
          `Conteudo focado em ${niche}, do basico ao aplicavel.`,
          `Formato PDF para ler no celular ou no computador.`,
          `Material em portugues, organizado para consulta rapida.`,
        ];

  const headline = p.name;
  const subheadline =
    p.description && p.description.trim().length > 0 ? p.description : undefined;

  return {
    product: {
      slug: p.slug,
      name: p.name,
      priceCents: p.priceCents,
      currency: p.currency,
      priceFormatted: formatPrice(p.priceCents, p.currency),
    },
    ebook: {
      title: p.ebook.title,
      niche,
      ...(subtitle ? { subtitle } : {}),
      language: p.ebook.language,
      ...(p.ebook.coverImagePath ? { coverImagePath: p.ebook.coverImagePath } : {}),
      whatsInside,
    },
    copy: {
      headline,
      ...(subheadline ? { subheadline } : {}),
      painPoints,
      bullets,
      guarantee:
        'Garantia de 7 dias: se nao for para voce, e so pedir o reembolso (direito de arrependimento, CDC art. 49).',
    },
    opportunity: {
      potentialScore: p.ebook.marketOpportunity?.potentialScore ?? 0,
    },
  };
}

// ------------------------------------------------------------
// Chat de vendas — system prompt ancorado + canned (degradacao graciosa).
// ------------------------------------------------------------

interface ChatProductContext {
  name: string;
  description: string;
  priceFormatted: string;
  whatsInside: string[];
  niche: string;
  title: string;
}

function buildChatContext(p: {
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  ebook: { title: string; niche: string; outline: unknown };
}): ChatProductContext {
  return {
    name: p.name,
    description:
      p.description && p.description.trim().length > 0 ? p.description : p.ebook.title,
    priceFormatted: formatPrice(p.priceCents, p.currency),
    whatsInside: whatsInsideFrom(p.ebook.outline),
    niche: p.ebook.niche,
    title: p.ebook.title,
  };
}

function buildSystemPrompt(ctx: ChatProductContext): string {
  const inside =
    ctx.whatsInside.length > 0
      ? ctx.whatsInside.map((t) => `  - ${t}`).join('\n')
      : `  - (conteudo sobre ${ctx.niche}; nao invente numero de capitulos ou paginas)`;

  return [
    'Voce e o assistente de vendas oficial da loja. Seu unico objetivo e ajudar o',
    'visitante a decidir comprar o ebook abaixo e conduzi-lo ao checkout via PIX. Seja',
    'caloroso, direto, em portugues do Brasil, com mensagens curtas (1-3 frases).',
    '',
    'PRODUTO (a UNICA fonte de verdade — nunca contradiga nem va alem disto):',
    `- Nome: ${ctx.name}`,
    `- Sobre: ${ctx.description}`,
    '- O que tem dentro:',
    inside,
    `- Preco: ${ctx.priceFormatted} (pagamento via PIX, aprovacao em segundos)`,
    '- Entrega: PDF enviado por email automaticamente apos a confirmacao do pagamento.',
    '',
    'REGRAS INVIOLAVEIS:',
    '1. NUNCA invente fatos, numeros, bonus, garantias, prazos, descontos, depoimentos ou',
    '   caracteristicas que nao estejam acima. Se nao souber, diga que nao tem essa',
    '   informacao e ofereca o que o produto realmente entrega.',
    '2. NUNCA prometa resultados garantidos nem faca afirmacoes medicas/financeiras/juridicas.',
    `3. Nao invente cupons nem altere o preco — o preco e exatamente ${ctx.priceFormatted}.`,
    '4. Quebre objecoes com honestidade usando so os fatos acima, e sempre que houver',
    '   intencao de compra, oriente: "e so preencher nome, email e CPF aqui ao lado e gerar o PIX".',
    '5. Nao peca nem armazene dados sensiveis no chat (o CPF e coletado no formulario de checkout).',
    '6. Se perguntarem algo fora do escopo do produto, traga a conversa de volta para o ebook.',
    'Responda sempre em no maximo ~4 frases.',
  ].join('\n');
}

/** Resposta canned ancorada nos fatos reais (nada inventado). */
function cannedReply(ctx: ChatProductContext): string {
  return (
    `No momento nosso atendente automatico esta indisponivel, mas posso adiantar: o ` +
    `${ctx.name} sai por ${ctx.priceFormatted}, com pagamento via PIX (aprovacao em ` +
    `segundos) e entrega do PDF no seu email logo apos o pagamento. Para garantir o seu, ` +
    `e so preencher nome, email e CPF aqui ao lado e gerar o PIX.`
  );
}

export default async function storefrontRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // --------------------------------------------------------
  // Health publico da vitrine.
  // --------------------------------------------------------
  fastify.get('/storefront/health', async (_request, reply) => {
    return reply.send({ status: 'ok', service: 'storefront' });
  });

  // --------------------------------------------------------
  // GET /storefront/featured
  // FEATURED = Product active=true, ebook.status=PUBLISHED, de MAIOR
  // MarketOpportunity.potentialScore (empate -> Product.createdAt desc, depois
  // ebook.createdAt desc). Ordenacao em JS (relacao a 2 hops). Sem candidato -> 404.
  // --------------------------------------------------------
  fastify.get('/storefront/featured', async (_request, reply) => {
    const candidates = await prisma.product.findMany({
      where: { active: true, ebook: { status: 'PUBLISHED' } },
      include: { ebook: { include: { marketOpportunity: true } } },
      take: 50,
    });

    if (candidates.length === 0) {
      return reply.code(404).send({ error: 'no_featured_product' });
    }

    const featured = [...candidates].sort((a, b) => {
      const sa = a.ebook.marketOpportunity?.potentialScore ?? 0;
      const sb = b.ebook.marketOpportunity?.potentialScore ?? 0;
      if (sb !== sa) return sb - sa;
      const ca = a.createdAt.getTime();
      const cb = b.createdAt.getTime();
      if (cb !== ca) return cb - ca;
      return b.ebook.createdAt.getTime() - a.ebook.createdAt.getTime();
    })[0];

    return reply.send(toOfferDTO(featured as unknown as ProductWithEbook));
  });

  // --------------------------------------------------------
  // GET /storefront/products/:slug
  // Detalhe publico de um produto PUBLISHED ativo. 404 se inexistente/inativo.
  // --------------------------------------------------------
  fastify.get<{ Params: { slug: string } }>(
    '/storefront/products/:slug',
    async (request, reply) => {
      const product = await prisma.product.findUnique({
        where: { slug: request.params.slug },
        include: { ebook: { include: { marketOpportunity: true } } },
      });

      if (
        !product ||
        !product.active ||
        product.ebook.status !== 'PUBLISHED'
      ) {
        return reply.code(404).send({ error: 'product_not_found' });
      }

      return reply.send(toOfferDTO(product as unknown as ProductWithEbook));
    },
  );

  // --------------------------------------------------------
  // POST /storefront/chat — chat de vendas 24/7 (guardrails de custo).
  //
  // Ordem dos checks ANTES de chamar o LLM:
  //   (1) SALES_BOT_ENABLED=false        -> 200 canned
  //   (2) teto diario global atingido    -> 200 canned
  //   (3) bucket por IP vazio            -> 429 + Retry-After
  // Depois: resolve produto (404 se inexistente/inativo), monta system ancorado,
  // chama o LLM em try/catch -> erro = log {err,productSlug} (SEM content) + canned.
  // --------------------------------------------------------
  fastify.post('/storefront/chat', async (request, reply) => {
    const parsed = salesChatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const body = parsed.data;

    // A ultima mensagem deve ser do usuario (evita chamadas degeneradas).
    // O schema garante min(1), mas o TS nao estreita o acesso por indice.
    const last = body.messages[body.messages.length - 1];
    if (!last || last.role !== 'user') {
      return reply.code(400).send({ error: 'invalid_body', issues: [] });
    }

    // Resolve o produto (ancoragem). Slug inexistente/inativo -> 404.
    const product = await prisma.product.findUnique({
      where: { slug: body.productSlug },
      include: { ebook: true },
    });
    if (!product || !product.active) {
      return reply.code(404).send({ error: 'product_not_found' });
    }
    const ctx = buildChatContext(product);

    const now = Date.now();

    // (1) Kill switch -> canned, sem LLM.
    if (!env.SALES_BOT_ENABLED) {
      return reply.send({ reply: cannedReply(ctx), source: 'canned' as const });
    }

    // (2) Teto diario global -> canned, sem LLM.
    if (!dailyBudgetAvailable(now)) {
      return reply.send({ reply: cannedReply(ctx), source: 'canned' as const });
    }

    // (3) Rate-limit por IP (token bucket) -> 429 (front mostra msg propria).
    const rl = takeToken(request.ip, now);
    if (!rl.ok) {
      reply.header('Retry-After', String(rl.retryAfterSec));
      return reply
        .code(429)
        .send({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec });
    }

    // Historico capado para as ultimas 8 mensagens (guardrail C).
    const history: StorefrontChatMessage[] = body.messages.slice(-8);
    const system = buildSystemPrompt(ctx);

    try {
      // Conta como chamada REAL ao LLM (cota diaria) ANTES de chamar.
      recordLlmCall(now);
      const result = await llm.generateText({
        model: CONTENT_MODEL,
        system,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        maxTokens: env.SALES_BOT_MAX_TOKENS,
        temperature: 0.4,
      });
      const text = result.text.trim();
      if (!text) {
        return reply.send({ reply: cannedReply(ctx), source: 'canned' as const });
      }
      return reply.send({ reply: text, source: 'llm' as const });
    } catch (err) {
      // Degradacao graciosa. Log SEM conteudo das mensagens (PII).
      request.log.error(
        { err: err instanceof Error ? err.message : String(err), productSlug: body.productSlug },
        'falha no chat de vendas (LLM) — respondendo canned',
      );
      return reply.send({ reply: cannedReply(ctx), source: 'canned' as const });
    }
  });
}
