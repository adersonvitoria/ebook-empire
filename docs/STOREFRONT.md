# STOREFRONT — Vitrine pública de vendas (/oferta)

Documento de arquitetura da **vitrine pública** do Ebook Empire: a landing de conversão
`/oferta`, os endpoints públicos `/storefront/*`, o chat de vendas 24/7 (com guardrails de
custo) e o checkout PIX embutido na própria página.

> **Escopo.** A vitrine é o canal **público** (visitante → comprador). Ela não tem login,
> não usa o chrome admin e **não cria pedidos por conta própria** — o pagamento reusa a
> rota pública `POST /checkout` que já existe. Tudo aqui é *somente leitura* mais o chat.

- API (Railway): `https://ebook-empire-api.up.railway.app`
- Web (Vercel): `https://ebook-empire-web-one.vercel.app`
- Stack: `apps/api` Fastify 4 + Prisma + Zod · `apps/web` Next.js 14 App Router + Tailwind + TanStack Query
- Dinheiro: **Int centavos** (`priceCents`), formatação BRL via `formatBRL` de `apps/web/lib/api.ts`.
- Idioma: **pt-BR**.

> **Status: IMPLEMENTADO e verificado.** A API (`apps/api/src/routes/storefront.ts`) e a web
> (`apps/web/app/oferta/*` + `apps/web/components/{offer-page,offer-hero,offer-states,checkout-form,sales-chat}.tsx`
> + `apps/web/lib/storefront.ts`) estão prontas. Verificação honesta nesta entrega: build
> `core`+`agents` + `prisma:generate` + typecheck **5/5**; unit **367** (adapters 88 + agents 218
> + api 61), 0 falhas; `next build` (standalone) **20/20** com `/oferta` e `/oferta/[slug]` como
> rotas `ƒ` (dynamic); `e2e:storefront` novo **27/27** contra Postgres real; os 6 e2e existentes
> verdes (26/40/46/44/18/13, 0 falhas). Este documento descreve **o que está no código**.

---

## 0. Cópia derivada de campos reais (sem colunas de marketing)

`Product` **não** tem colunas `marketingTitle`, `marketingDescription` nem `copy` — a schema
real (`prisma/schema.prisma`) não as define. A cópia de venda é **derivada server-side** dos
campos reais (`toOfferDTO` em `storefront.ts`):

| Conceito de venda        | Campo real                                   | Observação |
|--------------------------|----------------------------------------------|------------|
| Título / headline        | `Product.name`                               | O pipeline grava `name = ebook.title` (`packages/agents/src/launch/launch-pipeline.ts`, `createDefaultPublish`). |
| Subheadline / meta       | `Product.description` (`String?`)            | Hoje gerada como `"Ebook sobre <niche>."`. Curta — serve de subheadline/`<meta>`, **não** de parágrafo longo. |
| Preço                    | `Product.priceCents` (Int) · `currency`      | Default do pipeline = `4700` (R$ 47,00). |
| O que tem dentro         | `Ebook.outline` (`Json?`)                    | Única fonte verdadeira do conteúdo (capítulos). |
| Dor → solução / ângulos  | `MarketOpportunity.angles` (`Json` string[]) | Matéria-prima dos blocos de objeção/benefício. |
| Ideias de título         | `MarketOpportunity.titleIdeas` (`Json`)      | Opcional para variações de headline. |
| Score de potencial       | `MarketOpportunity.potentialScore` (Int 0..100) | **Chave de ranqueamento do FEATURED.** |
| Capa (og:image)          | `Ebook.coverImagePath` (`String?`)           | Usar quando presente. |

**Regra suprema honesta:** se `outline`/`angles` vierem vazios, a seção degrada para texto
genérico honesto parametrizado por `niche` — **nunca** prometer capítulos/bônus/números que
não existem. Sem vendas reais, **proibido** contador de "+X alunos" ou depoimentos falsos.

### Formato de `Ebook.outline`

Valida contra `ebookOutlineSchema` (`packages/core/src/schemas.ts`):

```ts
{ title: string, niche: string, subtitle?: string, targetAudience?: string,
  chapters: [{ title: string, summary: string }]  // min 3
}
```

`outline` é `Json?` e pode ser `null` ou de formato legado/divergente em ebooks antigos.
O parse é **defensivo** (`ebookOutlineSchema.safeParse` em `whatsInsideFrom`/`subtitleFrom`):
em falha, `whatsInside = []` e a seção cai para fallback por `niche`. O `subtitle` da oferta
vem de `outline.subtitle` (o `Ebook` **não** tem coluna `subtitle`). O DTO **nunca** vaza
`contentMarkdown` nem o registro Prisma cru — `toOfferDTO` seleciona/mapeia campo a campo.

---

## 1. Como o FEATURED é escolhido (determinístico)

Ainda não há vendas reais, então "mais vendido" é simulado por potencial de mercado:

> **FEATURED** = o `Product` com `active = true` cujo `Ebook.status = PUBLISHED`, de **maior**
> `MarketOpportunity.potentialScore`. Empate → **mais recente** (`Product.createdAt` desc,
> depois `ebook.createdAt` desc).

O Prisma não ordena de forma limpa por um escalar a dois hops de relação
(`Product → Ebook → MarketOpportunity.potentialScore`). Decisão: **buscar e ordenar em JS**.

```ts
const candidates = await prisma.product.findMany({
  where: { active: true, ebook: { status: 'PUBLISHED' } },
  include: { ebook: { include: { marketOpportunity: true } } },
  take: 50, // catálogo pequeno; mantém o sort barato
});
const featured = [...candidates].sort((a, b) => {
  const sa = a.ebook.marketOpportunity?.potentialScore ?? 0;
  const sb = b.ebook.marketOpportunity?.potentialScore ?? 0;
  if (sb !== sa) return sb - sa;                                   // 1) maior potentialScore
  if (b.createdAt.getTime() !== a.createdAt.getTime())
    return b.createdAt.getTime() - a.createdAt.getTime();         // 2) Product.createdAt desc
  return b.ebook.createdAt.getTime() - a.ebook.createdAt.getTime(); // 3) ebook.createdAt desc
})[0];
```

Sem candidato → `404 { error: 'no_featured_product' }` (a web renderiza um estado "Em breve"
de alta qualidade, **não** um erro cru). O nome da relação em `Ebook` é
`marketOpportunity` (relation `"EbookOpportunity"`) — confirmado na schema.

---

## 2. Endpoints públicos `/storefront/*`

Arquivo dono: **`apps/api/src/routes/storefront.ts`** — plugin Fastify
`export default async function storefrontRoutes(fastify) {}`, no mesmo padrão de todos os
outros arquivos de rota. **Todas as 3 rotas são PÚBLICAS**: **não** ter
`preHandler: fastify.authenticate`. CORS já libera a origem da Vercel e métodos `GET`/`POST`
(server.ts: `['GET','POST','PUT','OPTIONS']`) — **não** mexer no CORS.

Registro é trabalho da **Fundação** em `apps/api/src/server.ts`:
`await app.register(storefrontRoutes)`. **Não** adicionar rotas dentro de `server.ts`.

### DTO público comum (enxuto, sem campos admin)

Nunca expor `contentMarkdown`, ids internos de run, `rationale` completa de scraping, nem o
registro Prisma cru. Selecionar/mapear explicitamente:

```ts
type StorefrontOfferDTO = {
  product:    { slug: string; name: string; priceCents: number; currency: string; priceFormatted: string };
  ebook:      { title: string; niche: string; subtitle?: string; language: string;
                coverImagePath?: string; whatsInside: string[] /* outline.chapters[].title */ };
  copy:       { headline: string; subheadline?: string;
                painPoints: string[] /* de MarketOpportunity.angles */;
                bullets: string[]; guarantee?: string };
  opportunity:{ potentialScore: number };
};
```

`priceFormatted` é montado no servidor (`Intl.NumberFormat('pt-BR', { currency })`) para a
web não depender só do helper de browser. A cópia (`headline`, `painPoints`, `bullets`) é
**derivada server-side** dos campos reais — a landing recebe a oferta pronta para renderizar
sem ter de tocar campos admin.

### `GET /storefront/featured`

Resolve o FEATURED (seção 1) e retorna `StorefrontOfferDTO`.

- `200 StorefrontOfferDTO`
- `404 { error: 'no_featured_product' }` — nenhum Product PUBLISHED ativo.

Alimenta `/oferta`. Também serve para o chat descobrir o `slug` do featured.

### `GET /storefront/products/:slug`

Mesmo `StorefrontOfferDTO` para um produto específico. Filtro: `slug` + `active: true` +
`ebook.status === 'PUBLISHED'` (reusa o padrão `prisma.product.findUnique({ where:{ slug }, include:{ ebook: ... } })` do checkout).

- `200 StorefrontOfferDTO`
- `404 { error: 'product_not_found' }` — slug inexistente ou inativo.

Alimenta `/oferta/[slug]`.

### `POST /storefront/chat`

Chat de vendas 24/7. **Endpoint público que chama o LLM → vetor de custo.** Detalhes e
guardrails na **seção 4**.

---

## 3. Estrutura da landing `/oferta` (apps/web)

### Roteamento e layout (sem chrome admin)

`apps/web/app/layout.tsx` (raiz, dono = Fundação) injeta a sidebar de nav admin + `<AuthBar/>`
e já renderiza `<html>`/`<body>` em **todas** as rotas. A vitrine precisa de layout público próprio.

**Implementado — fallback full-viewport (sem route group).** Não foi criado um route group
`(admin)`; em vez disso `apps/web/app/oferta/layout.tsx` é um Server Component que envolve a
landing num **container `fixed inset-0 z-50 overflow-y-auto`** cobrindo o chrome admin, com
tema próprio (`bg-[#f7f3ec]`, `text-[#2a2118]`) e **`[color-scheme:light]`** (reseta o
`color-scheme:dark` global). Um layout aninhado **não** pode renderizar `<html>`/`<body>` de
novo (o root já o faz), então este wrapper apenas sobrepõe o chrome. **Sem `Providers`/auth** —
a landing não exige login e não vaza a nav admin. Tipografia editorial própria via `next/font`
(**Fraunces** display + **Manrope** body) exposta como CSS vars `--font-display`/`--font-body`.

### Regra de build do Next (inegociável)

`page.tsx` só pode exportar **`default`** (+ `generateMetadata`/`metadata`/`dynamic`
permitidos). **Toda** UI interativa (`'use client'`, hooks) vai em `components/` próprios,
senão `next build` (standalone) quebra.

### Arquivos (escrita disjunta) — REAIS

```
apps/web/app/oferta/layout.tsx            # chrome público full-viewport (fonts + tema claro)
apps/web/app/oferta/page.tsx              # FEATURED — só default + generateMetadata + dynamic
apps/web/app/oferta/[slug]/page.tsx       # produto específico — só default + generateMetadata + dynamic
apps/web/components/offer-page.tsx        # 'use client' — orquestra hero + seções + checkout + chat
apps/web/components/offer-hero.tsx        # hero/seções da landing
apps/web/components/offer-states.tsx      # OfferComingSoon (404 "Em breve") + OfferError (retry)
apps/web/components/checkout-form.tsx     # 'use client' — máquina de 3 estados (seção 5)
apps/web/components/sales-chat.tsx        # 'use client' — widget flutuante de chat (seção 4)
apps/web/lib/storefront.ts               # client público (SEM Authorization)
```

As `page.tsx` (`/oferta` e `/oferta/[slug]`) são **Server Components** que só exportam
`default` + `generateMetadata` + `dynamic = 'force-dynamic'`; buscam o DTO no servidor e
despacham para `<OfferPage>` / `<OfferComingSoon>` (404) / `<OfferError>` (rede/5xx). Toda UI
interativa (`'use client'`, hooks) vive em `components/` — `next build` standalone passa.

### Data fetching

- `page.tsx` é **Server Component**: busca direto em `GET /storefront/featured`
  (`/oferta`) ou `/storefront/products/:slug` (`/oferta/[slug]`) com `cache: 'no-store'`
  (ou `revalidate` curto). Melhor para SEO/og-tags e evita flash.
- `checkout-form.tsx` e `sales-chat.tsx` são **client components** e usam
  `apps/web/lib/storefront.ts`.
- **`lib/storefront.ts` é separado de `lib/api.ts`.** `lib/api.ts` anexa Bearer admin via
  `authHeaders()` e carrega ~30 tipos do dashboard — a vitrine é pública e **não** envia
  `Authorization`. Reusar apenas `formatBRL` e a classe `ApiError` de `lib/api.ts`; tipos do
  storefront são espelhados à mão (mesmo padrão do projeto: o browser não importa `core`).
  Base de URL: `NEXT_PUBLIC_API_URL` (`API_BASE` em `lib/api.ts`, default `http://localhost:3001`).

### SEO / compartilhamento

`/oferta` e `/oferta/[slug]` exportam `generateMetadata`:
`title = product.name`, `description = product.description`,
`og:image = ebook.coverImagePath` quando presente. A vitrine será compartilhada em
WhatsApp/Instagram → metadados importam.

### Ordem das seções (funil de conversão)

1. **Hero (acima da dobra).** Eyebrow com `niche`; `H1 = headline` (promessa, de `Product.name`/
   `titleIdeas[0]`); subheadline = `Product.description`; badge **"Entrega imediata por email"**;
   CTA primário **"Comprar agora via PIX"** (âncora `#checkout`) + selo de preço
   (`formatBRL(priceCents)`). Deve caber promessa + preço + CTA na dobra. Mobile-first.
2. **Dor → solução.** 3–4 cards ("Você já tentou… / Aqui é diferente") derivados de
   `MarketOpportunity.angles`. Vazio → texto genérico honesto por `niche`.
3. **O que tem dentro do ebook.** Lista de capítulos de `outline.chapters[].title` + formato
   PDF + idioma pt-BR. Única fonte verdadeira do conteúdo.
4. **Prova honesta.** Sem vendas reais → **nada** de contadores/depoimentos falsos. Só provas
   verdadeiras: garantia, entrega automática, PIX seguro via Asaas, curadoria de IA + QA
   (transparente).
5. **Garantia.** 7 dias, direito de arrependimento (CDC art. 49). Real e honesta.
6. **Oferta / preço.** `formatBRL(priceCents)` = preço real. **Sem preço-fantasma riscado**
   (desonesto e não há campo de preço original na schema). Âncora por **valor/comparação
   real** ("menos que um lanche" / "um curso sobre isso custa muito mais"), não por número
   inventado. CTA PIX grande, com hover/disabled claros.
7. **Checkout inline (`#checkout`).** Renderiza `checkout-form.tsx` (seção 5).
8. **FAQ.** 4–6 perguntas: como recebo, é seguro, posso pedir reembolso, precisa de cartão,
   é PDF mesmo, suporte.
9. **Rodapé minimal.** Nome do projeto, contato/termos/privacidade (placeholder), **sem nav admin**.

### Estados

- **Produto ausente** (`404 no_featured_product`): tela **"Em breve"** de alta qualidade
  ("Estamos preparando algo especial"), não erro cru.
- **Carregando** (client): **skeleton** shimmer do hero (título/preço/CTA), não spinner genérico.
- **Erro** (rede / `5xx` via `ApiError`): card honesto "Não foi possível carregar a oferta
  agora" + **"Tentar novamente"** (refetch). Usar `ApiError.status` para distinguir `404`
  (em breve) de `5xx`/rede (erro).

### Design não-genérico

Paleta e tipografia **distintas do admin** (admin é dark `neutral-900`/brand). Vitrine: tema
claro/quente orientado a confiança e conversão (fundo off-white, um accent forte único do
nicho, serifa editorial no H1 + sans no corpo, muito respiro, um elemento gráfico assinatura —
ex. selo PIX/garantia). Evitar o "cartão cinza arredondado genérico" repetido. Mobile-first
(tráfego de WhatsApp/Instagram).

---

## 4. Chat de vendas 24/7 — `POST /storefront/chat` + `sales-chat.tsx`

### Fluxo

O widget flutuante (`apps/web/components/sales-chat.tsx`) mantém o histórico **local**
(`useState`/`useRef`, não persiste) e a cada envio faz `POST /storefront/chat` com
`{ productSlug, messages[] }`. A API resolve o produto, monta um system prompt **ancorado nos
fatos reais**, chama `ctx.ports.llm.generateText` com teto curto de tokens e devolve
`{ reply, source }`. **Toda defesa de custo fica no servidor** — o cliente nunca é fonte de
verdade para limites.

### Contrato

Body (Zod novo em `packages/core/src/schemas.ts`, re-exportado via `index.ts` — Fundação):

```ts
storefrontChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),     // espelha LLMMessage do core
  content: z.string().min(1).max(1000),    // teto por mensagem (anti-abuso de payload)
});
storefrontChatBodySchema = z.object({
  productSlug: z.string().min(1).max(200),
  messages: z.array(storefrontChatMessageSchema).min(1).max(20), // teto bruto; servidor capa p/ 8
  visitorId: z.string().max(120).optional(),
});
storefrontChatResultSchema = z.object({
  reply:  z.string(),
  source: z.enum(['llm', 'canned']),
});
```

Respostas:

| Status | Corpo | Quando |
|--------|-------|--------|
| `200`  | `{ reply, source: 'llm' }`    | Resposta do LLM. |
| `200`  | `{ reply, source: 'canned' }` | Degradação graciosa (desligado / teto diário / erro do LLM). **Sempre 200**, nunca derruba a UX. |
| `400`  | `{ error: 'invalid_body', issues }` | Body inválido (mesmo shape do `checkout.ts`). |
| `404`  | `{ error: 'product_not_found' }` | Slug inexistente ou `Product.active = false`. |
| `429`  | `{ error: 'rate_limited', retryAfterSec }` + header `Retry-After` | Estourou o rate-limit por IP. |

**Por que 200+canned em vez de 503 quando o LLM falha:** o objetivo é **vender**. Uma resposta
útil que empurra pro checkout converte melhor que um erro. O `429` é real (protege o IP
abusador) e o front pede para aguardar. A última mensagem **deve** ser `role: 'user'` (senão
`400`), evitando chamadas degeneradas.

### Ancoragem (NUNCA inventar)

```ts
const product = await prisma.product.findUnique({ where: { slug }, include: { ebook: true } });
// exige product && product.active
```

Contexto factual montado **só** de campos reais:

- **nome** = `product.name`
- **descrição** = `product.description ?? ebook.title`
- **preço** = `formatBRL(product.priceCents)` (ex. "R$ 47,00")
- **o que tem dentro** = títulos de `ebook.outline.chapters[]` (parse defensivo; ausente →
  `ebook.niche` + `ebook.title`, **sem** inventar nº de páginas/capítulos)
- **entrega** = "PDF por email após a confirmação do PIX" (fato: DeliveryAgent + Resend)
- **pagamento** = "PIX (Asaas), aprovação em segundos"

Campo vazio → o prompt instrui a **não** preencher com suposições.

### Adapter

```ts
// const no topo do módulo, UMA vez por processo (igual _paymentPort do checkout.ts)
const llm = createLLMAdapter({ USE_STUBS: env.USE_STUBS, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY });
// por request:
llm.generateText({
  model: CONTENT_MODEL,            // 'claude-sonnet-4-6'
  system, messages,               // system remontado a cada request (produto pode mudar)
  maxTokens: env.SALES_BOT_MAX_TOKENS,
  temperature: 0.4,
});
```

Com `USE_STUBS=true` (default de CI/teste) o `StubLLMAdapter` responde determinístico → os
~374 testes **não** tocam a rede.

### System prompt (pt-BR, ancorado + objetivo de venda + anti-invenção)

```
Você é o assistente de vendas oficial da loja. Seu único objetivo é ajudar o visitante a
decidir comprar o ebook abaixo e conduzi-lo ao checkout via PIX. Seja caloroso, direto, em
português do Brasil, com mensagens curtas (1-3 frases).

PRODUTO (a ÚNICA fonte de verdade — nunca contradiga nem vá além disto):
- Nome: {product.name}
- Sobre: {descrição}
- O que tem dentro: {capítulos/tópicos do outline}
- Preço: {R$ XX,XX} (pagamento via PIX, aprovação em segundos)
- Entrega: PDF enviado por email automaticamente após a confirmação do pagamento.

REGRAS INVIOLÁVEIS:
1. NUNCA invente fatos, números, bônus, garantias, prazos, descontos, depoimentos ou
   características que não estejam acima. Se não souber, diga que não tem essa informação e
   ofereça o que o produto realmente entrega.
2. NUNCA prometa resultados garantidos nem faça afirmações médicas/financeiras/jurídicas.
3. Não invente cupons nem altere o preço — o preço é exatamente {R$ XX,XX}.
4. Quebre objeções com honestidade (preço, confiança, "serve pra mim?") usando só os fatos
   acima, e sempre que houver intenção de compra, oriente: "é só preencher nome, email e CPF
   aqui ao lado e gerar o PIX".
5. Não peça nem armazene dados sensíveis no chat (o CPF é coletado no formulário de checkout).
6. Se perguntarem algo fora do escopo do produto, traga a conversa de volta para o ebook.
Responda sempre em no máximo ~4 frases.
```

Nada de PII do visitante entra no system. O servidor **não** confia em mensagens `assistant`
do body como fato (o system tem precedência).

### Guardrails de custo (CRÍTICO)

Estado **em memória, por processo** (módulo-level, sobrevive entre requests como `_paymentPort`).
Limitação aceita: hoje **1 instância** no Railway; com `>1` instância cada uma tem seu teto →
gasto = N × limite. Migração futura para store compartilhado (Redis) se escalar.

| # | Guardrail | Implementação | Default |
|---|-----------|---------------|---------|
| A | **Rate-limit por IP** | Token bucket `Map<ip, {tokens, updatedAt}>`. Capacidade `RL_CAPACITY`, refil linear ao longo de `RL_WINDOW_MS`. Cada POST consome 1 token; sem token → `429` + `Retry-After = ceil(tempo até 1 token)`. IP de `request.ip`. Sweep leve descarta buckets cheios e velhos. | 15 msgs / 30 min |
| B | **Teto diário global** | Contador `{ dayKey: 'YYYY-MM-DD' (UTC), count }` vs `env.SALES_BOT_DAILY_LIMIT`. `count >= limite` → **não** chama o LLM, responde `200 { source: 'canned' }`. Vira o dia (UTC) → zera. **Só incrementa em chamada REAL ao LLM** (canned por rate-limit/disabled não gasta cota). É o teto duro de crédito Anthropic. | 300/dia |
| C | **Histórico capado** | `messages.slice(-8)` antes de mandar ao LLM, independente do body trazer até 20. Limita tokens de entrada e prompt-injection acumulada. | 8 mensagens |
| D | **maxOutputTokens curto** | `maxTokens = env.SALES_BOT_MAX_TOKENS`; `temperature 0.4`. | 600 tokens |
| E | **Kill switch** | `env.SALES_BOT_ENABLED = false` → nunca chama o LLM, sempre `200 canned`. Mata o gasto sem deploy. | `true` |
| F | **Degradação graciosa** | `generateText` em `try/catch`. Qualquer erro (timeout, 429 Anthropic, chave ausente) → log **sem** conteúdo da conversa (só `{ err }`) e `200 { source: 'canned' }`. | — |

**Ordem dos checks ANTES de qualquer chamada ao LLM:** (1) `SALES_BOT_ENABLED` false → canned;
(2) teto diário atingido → canned; (3) bucket por IP vazio → `429` + mensagem canned.

**Privacidade:** **NUNCA** logar `content` das mensagens (PII). Logs só `{ err, productSlug }`
(opcionalmente ip-hash). Garantir que o `catch` não serialize `request.body`.

### Resposta canned (única string pt-BR, ancorada, sem inventar)

```
No momento nosso atendente automático está indisponível, mas posso adiantar: o {product.name}
sai por {R$ XX,XX}, com pagamento via PIX (aprovação em segundos) e entrega do PDF no seu email
logo após o pagamento. Para garantir o seu, é só preencher nome, email e CPF aqui ao lado e
gerar o PIX.
```

Montada com os **mesmos fatos reais** (nome + preço) → nada inventado no fallback. No caso
`429`, o **front** mostra mensagem própria ("Você enviou muitas mensagens; aguarde alguns
minutos"), **sem** custo de LLM.

### Env (`apps/api/src/env.ts`) — IMPLEMENTADO

Os 4 envs do bot existem com defaults stub-friendly (boot/Zod não quebram sem configurá-los):

```ts
SALES_BOT_ENABLED:          boolish.default('true'),                       // kill switch
SALES_BOT_DAILY_LIMIT:      z.coerce.number().int().positive().default(300), // teto diário global
SALES_BOT_PER_IP_PER_30MIN: z.coerce.number().int().positive().default(15),  // cap do token bucket
SALES_BOT_MAX_TOKENS:       z.coerce.number().int().positive().default(600),  // maxTokens de saída
```

Reusa `ANTHROPIC_API_KEY` / `USE_STUBS` / `CONTENT_MODEL` (`'claude-sonnet-4-6'`) já existentes
— sem novo wiring de LLM. `RL_WINDOW_MS` (janela de refil do bucket) é **fixo em 30 min** no
código (não é env).

### `request.ip` atrás do proxy (limitação aceita)

Atrás do proxy do Railway, `request.ip` pode resolver para o IP do proxy → o rate-limit por IP
vira ~global. **`trustProxy` NÃO está habilitado** no Fastify hoje (seria tarefa da Fundação em
`server.ts`). Mesmo assim o **teto diário global (B)** já limita o gasto — crédito não vaza. Se
ligar o rate-limit por IP de verdade for necessário, habilitar `trustProxy` separadamente.

### Estado por-instância (limitação de escala)

Os guardrails são **estado em memória por processo** (module-level, igual `_paymentPort` do
checkout). Hoje há **1 instância** no Railway. Com `>1` instância cada uma tem seu próprio teto
→ gasto = N × limite. Migrar para store compartilhado (ex. Redis) se escalar horizontalmente.

---

## 5. Checkout PIX na própria página (`checkout-form.tsx`)

Embutido na landing (`#checkout`), mobile-first, **sem login**. **Não** há rota `/checkout`
separada na web — tudo em `/oferta` e `/oferta/[slug]`. Reusa a rota pública
`POST /checkout` **sem alterações** — o storefront **não** cria Order/Payment.

### Máquina de 3 estados

`'form' | 'submitting' | 'pix'` (+ erro inline reaproveitando o estado de origem).

### Client público

`apps/web/lib/storefront.ts` expõe `createCheckout(body): Promise<CheckoutResult>` — fetch
direto contra `API_BASE` **SEM `Authorization`** (rota pública). Não reusar `request()` de
`lib/api.ts` (anexa Bearer admin); reusar só o padrão (montar URL, lançar `ApiError` com
`.status`) e a classe `ApiError`. Tipos `CheckoutResult`/`CheckoutCustomer` espelhados localmente.

### Body (shape REAL de `checkoutBodySchema`)

```ts
{ productSlug, customer: { name, email, cpfCnpj? }, visitorId?, utm? }
```

- `cpfCnpj` é **opcional** no schema (`.optional()`, `max(20)`) e a API **não** valida dígitos
  — validação de CPF é 100% do cliente. **Só** enviar `cpfCnpj` no body quando preenchido;
  enviar **sem máscara** (só dígitos) para caber no `max(20)`.
- **Decisão de negócio:** recomendado **exigir** CPF (reduz recusa do Asaas/antifraude), mas
  alinhar com o dono. Se exigido, bloquear submit quando vazio **ou** inválido.
- Capturar `visitorId` (UUID em `localStorage`, chave `ee_visitor`) e `utm_*` da query string
  para atribuição — alinhado ao evento `CHECKOUT_STARTED` que a rota grava.

### Validação client-side (pt-BR, antes do POST)

Nome obrigatório (`>=1`, trim); email com validação de formato (`type="email"`, `autoComplete`);
CPF com máscara `000.000.000-00`, `inputmode="numeric"` e validação de dígitos verificadores.
Alvos de toque `>=44px`, labels associadas.

### Resposta de sucesso (`201`, shape REAL de `checkout.ts`)

```ts
{ orderId, status, amountCents, currency, pixQrCode, pixCopyPaste, dueDate /* ISO */ }
```

### Estado PIX

- **`pixQrCode` é o payload EMV** (mesmo conteúdo do copia-e-cola), **não** um data-URL de
  imagem. **Implementado:** a imagem do QR é gerada a partir desse payload via o serviço
  externo **`api.qrserver.com`** (`<img>` apontando para a URL do gerador) — **sem** nova
  dependência no bundle. **Nunca** `<img src={pixQrCode}>` cru (quebraria o QR). Se preferir
  gerar localmente, adicionar uma lib (`qrcode`/`react-qr-code`) — decisão de dono (exige
  `npm install`).
- O **copia-e-cola** (`pixCopyPaste`) é a **via primária**: botão **"Copiar código PIX"** via
  `navigator.clipboard` (com fallback e feedback "Copiado!").
- Mostrar valor (`formatBRL(amountCents)`) e validade (`dueDate`).
- Instrução pós-pagamento (sem login): "1) Abra o app do seu banco 2) Pague o PIX (QR ou
  copia-e-cola) 3) **Em instantes** você recebe o ebook no email `<email informado>`". Reforçar
  "confira o spam". **Não** prometer entrega instantânea no segundo (depende do webhook Asaas
  → Order PAID → DeliveryAgent no próximo tick).

### Tratamento de erro (por `ApiError.status`, pt-BR)

| Status | Mensagem | Ação |
|--------|----------|------|
| `404 product_not_found` | "Este produto não está mais disponível." | Ocultar/desabilitar CTA. |
| `502 payment_provider_error` | "Não foi possível gerar o PIX agora. Tente novamente em instantes." | Manter dados do form, permitir retry. |
| `400 invalid_body` | Mensagem genérica de revisão dos campos. | Raro (validamos antes). |
| `0` (rede/API fora) | "Falha de conexão. Verifique sua internet e tente de novo." | Retry. |

Erros **não** limpam o formulário.

### Anti-duplo-submit

Dois cliques rápidos criam **2 Orders + 2 cobranças PIX**. **Obrigatório**: desabilitar o CTA
durante `'submitting'` ("Gerando PIX…" + spinner) e só reabilitar em erro. Idempotência de
clique via flag de estado.

### Poll de status (opcional, com cautela)

`GET /orders/:id` existe e retorna `{ order: { status, deliveryGrant{...} } }`. **Decisão
recomendada: NÃO fazer poll** — confiar 100% na entrega por email (webhook). `/orders` está no
mesmo arquivo das rotas admin → **verificar se exige JWT** antes de usar; se usado, limitar a
2–3 tentativas com backoff e parar após ~2–3 min.

### Privacidade

**Não** logar email/CPF no console do cliente nem em telemetria (guardrail "nunca logar
conteúdo sensível").

---

## 6. Convenção de arquivos (escrita disjunta)

**Novos (entregues)**
- `apps/api/src/routes/storefront.ts` — `health` + `featured` + `products/:slug` + `chat`.
- `apps/api/src/routes/storefront.test.ts` + `apps/api/scripts/e2e-storefront.ts` (script `e2e:storefront`).
- `apps/web/app/oferta/{layout.tsx, page.tsx, [slug]/page.tsx}`.
- `apps/web/components/{offer-page.tsx, offer-hero.tsx, offer-states.tsx, checkout-form.tsx, sales-chat.tsx}`.
- `apps/web/lib/storefront.ts` — client público (sem Authorization).

**Editados por dono único (Fundação)**
- `packages/core/src/{schemas.ts, index.ts}` — Zod do chat (`salesChatBodySchema`) + DTOs storefront.
- `apps/api/src/env.ts` — `SALES_BOT_ENABLED/DAILY_LIMIT/PER_IP_PER_30MIN/MAX_TOKENS`.
- `apps/api/src/server.ts` — `await app.register(storefrontRoutes)` (linha ~88). **`trustProxy`
  NÃO foi habilitado** e **não** foi criado route group `(admin)` — a vitrine usa o wrapper
  full-viewport de `oferta/layout.tsx` (seção 3).

**Não muda:** `prisma/schema.prisma` (reusa `Product`/`Order` — nenhuma migração nova).

---

## 7. Regra suprema — não quebrar nada (verificado)

- Unit **367** + 6 e2e existentes (`e2e`, `e2e:crm`, `e2e:ops`/finance-alerts, `e2e:launch`,
  coo-sectors, `e2e:auth`) **verdes**, 0 falhas. Chat determinístico sob `USE_STUBS=true` (os
  testes não tocam a rede).
- Typecheck **5/5**. **Buildar `packages/core` + `packages/agents` antes** do typecheck de
  `apps/api` (consome `dist/*.d.ts`).
- Novo `e2e:storefront` (`apps/api/scripts/e2e-storefront.ts`) **27/27** contra Postgres real:
  featured-por-potencial, `products/:slug` 200/404, checkout 201 + `pixCopyPaste`, chat 200
  stub, rate-limit 429 (15 OKs → 429 com `Retry-After`) e kill-switch canned (em subprocesso).
- `next build` do web **passa** (20/20): `page.tsx` só exporta `default` + `generateMetadata` +
  `dynamic`; toda UI interativa em `components/` próprios; `/oferta` e `/oferta/[slug]` como `ƒ`.
- DTOs públicos **nunca** vazam `contentMarkdown` nem campos internos — `select`/mapeamento
  explícito (`toOfferDTO`).
- Honestidade: sem números/promessas/depoimentos inventados; cópia derivada só dos campos reais;
  o chat é ancorado nos mesmos fatos e degrada para canned em qualquer falha do LLM.

> **Nota:** `apps/web` não tem runner de testes unitários (validação = `next build`, conforme
> convenção do projeto). Nenhum teste de web foi adicionado.
