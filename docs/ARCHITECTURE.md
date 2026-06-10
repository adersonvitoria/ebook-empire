# Ebook Empire — Arquitetura

> Documento mestre de arquitetura. Define o contrato unico que TODAS as areas (Fundacao, Agentes, Venda/Entrega, Marketing) devem seguir. Quando uma proposta de area divergiu de outra, este documento registra a **DECISAO FINAL** explicitamente. Em caso de duvida sobre nomes de tipos/modelos, vale o que esta aqui e o que a Fundacao gravar em `prisma/schema.prisma`, `packages/core/src/*` e `packages/agents/src/base.ts` (REGRA DE OURO).

## 1. Visao geral

Ebook Empire e uma **empresa autonoma multi-agente** que gera, vende e entrega ebooks; faz marketing no Instagram; roda trafego pago no Meta; e analisa resultados — com meta de negocio de **faturamento bruto >= R$1.000/dia**.

Principios reitores:

- **Monorepo pnpm**, Node 20, TypeScript ESM (`"type":"module"`, `moduleResolution` `Bundler` ou `NodeNext`).
- **Hexagonal / Ports & Adapters**: `packages/core` define PORTS (interfaces) e tipos; `packages/adapters` implementa cada port com uma versao **real + stub injetavel** (BR-first). Agentes e rotas dependem so dos ports.
- **Agentes dentro do processo da API** (Fastify), agendados por `setInterval` em `apps/api/src/scheduler.ts`. **Sem worker separado** (padrao do projeto `venda-mais` do usuario).
- **Dinheiro sempre em centavos** (`Int`, BRL). Nunca `Float`/`Decimal` para dinheiro. Conversao para `R$` so na UI.
- **Fonte unica de verdade por dominio**: `Order` para faturamento contabil; `AdInsight` para spend/ROAS de dashboard; `Event` para auditoria/funil granular; `AnalyticsAgent` como unico calculador de KPI.
- **Idempotencia em tudo que e disparado por webhook ou por tick**: constraints `@@unique`, transicoes de estado que nunca retrocedem, e batch-cap (`take:N`).

### Decisoes finais sobre conflitos entre as propostas

| # | Conflito entre propostas | DECISAO FINAL |
|---|---|---|
| D1 | Dinheiro: Domain usa `Int` centavos; Marketing/Viabilidade mencionam `Decimal`/reais (`dailyBudget Decimal`, `spend`, `amount`) | **Int centavos** em TODO o schema e API (`priceCents`, `amountCents`, `spendCents`, `dailyBudgetCents`, `revenueCents`). `Decimal`/reais existem apenas em texto de viabilidade. |
| D2 | `Payment.status`: Domain tem enum amplo (`PENDING, CONFIRMED, RECEIVED, OVERDUE, REFUNDED, FAILED`); Venda usa `CONFIRMED`. Asaas distingue `CONFIRMED` (autorizado) de `RECEIVED` (liquidado) | Enum completo `PaymentStatus { PENDING, CONFIRMED, RECEIVED, OVERDUE, REFUNDED, FAILED }`. **Gatilho de entrega = `CONFIRMED` OU `RECEIVED`** (para PIX, Asaas costuma enviar `RECEIVED`). |
| D3 | `DeliveryGrant`: Domain guarda `token @unique` (nanoid); Venda guarda `tokenHash` (sha256, token plano nunca persistido) | **`tokenHash @unique` (sha256)**. O token plano (>=32 bytes, base64url) so vai no email/URL. Comparacao em tempo constante. Campos: `maxDownloads` default **5**, `expiresAt` default **7 dias**, `downloadCount`, `revokedAt?`, `emailSentAt?`, `lastDownloadAt?`. |
| D4 | `Event`: Domain usa para funil/atribuicao (UTM, custo, receita); Venda usa a MESMA tabela para idempotencia de webhook (`provider`, `externalEventId`) | **Tabela `Event` unica** com os dois conjuntos de campos. Idempotencia de webhook por `@@unique([provider, externalEventId])` (ambos nullable; eventos de funil internos nao preenchem). Funil por `type EventType`. |
| D5 | `EventType`: Domain (`IMPRESSION...REFUNDED, SOCIAL_*`) vs Agentes (`EBOOK_PUBLISHED, AD_SPEND...`) | Enum **uniao** dos dois — funil + eventos operacionais internos (ver secao 3). |
| D6 | Atribuicao/`SocialPost`/`AdCampaign` nomes de enum: `SocialStatus` vs `SocialPostStatus`, `AdStatus` vs `AdCampaignStatus` | Nomes canonicos da Fundacao: **`SocialStatus`** e **`AdStatus`**. Marketing alinha a esses nomes. |
| D7 | `AdInsight`/`spend`: Marketing propoe bucket de atribuicao `source/campaign/adGroup/adId` na propria `AdInsight` | `AdInsight` e snapshot **por `(campaignId, date)`** (`@@unique`). Bucket de atribuicao fino mora em `Event` (UTMs) e em `Order` (UTMs snapshotadas). Sem duplicar colunas de bucket em `AdInsight`. |
| D8 | Reconciliacao de pagamento: webhook-first vs polling | **Webhook-first**. Polling existe so como rede de seguranca no `SalesAgent` (sweep de `Payment PENDING` antigos via `PaymentPort.getPayment`), idempotente, sem duplicar entrega. |
| D9 | Modelo financeiro: ticket R$27 isolado | **Inviavel** isolado. Estrutura oficial: ancora **R$47** + order-bump **R$27** + upsell **R$97** (AOV efetivo ~R$72). Detalhe em `VIABILITY.md`. |
| D10 | Timezone da "receita diaria" | `date_trunc` sempre em **America/Sao_Paulo**. Persistir timestamps em UTC, converter no group-by. |

## 2. Diagrama textual do monorepo

```
ebook-empire/
├── package.json                 # workspaces pnpm, scripts raiz
├── pnpm-workspace.yaml
├── tsconfig.base.json           # paths + config TS compartilhada
├── .env.example                 # todas as env (ver secao 8)
├── .gitignore
├── README.md
├── docs/
│   ├── ARCHITECTURE.md          # (este arquivo)
│   ├── VIABILITY.md
│   ├── ROADMAP.md
│   └── STATUS.md                # estado vivo do projeto
├── prisma/
│   └── schema.prisma            # FUNDACAO escreve; todos leem
├── packages/
│   ├── core/                    # PORTS + tipos + schemas Zod. SEM runtime externo.
│   │   └── src/{index,types,schemas,ports}.ts
│   ├── adapters/                # impl real + stub de cada port. BR-first.
│   │   └── src/{index,llm,payment,email,storage,instagram,ads}.ts
│   └── agents/                  # runtime de agentes
│       └── src/{index,base,orchestrator,content,sales,delivery,social,traffic,analytics}.ts
└── apps/
    ├── api/                     # Fastify 4 + Prisma 6
    │   ├── vitest.config.ts
    │   └── src/
    │       ├── env.ts           # validacao de env (Zod)
    │       ├── db.ts            # PrismaClient singleton
    │       ├── server.ts        # FUNDACAO: registra TODAS as rotas + startScheduler
    │       ├── scheduler.ts     # unico dono do setInterval
    │       ├── lib/pdf.ts       # geracao de PDF do ebook
    │       └── routes/{health,ebooks,checkout,delivery,social,ads,agents}.ts
    └── web/                     # Next.js 14 App Router (dashboard interno)
        └── app/{layout,page,ebooks,orders,social,ads,agents}/... + lib/api.ts
```

### Grafo de dependencias (quem importa quem)

```
core  ─────────────► (nada externo de runtime)
adapters ──► core (ports/tipos)  + SDKs (@anthropic-ai/sdk, nodemailer/resend, asaas http, meta http)
agents   ──► core (ports/tipos) + @prisma/client
apps/api ──► core + adapters + agents + @prisma/client + fastify
apps/web ──► (HTTP para apps/api via lib/api.ts) — NAO importa core/adapters/agents
```

Regra de ouro de escrita disjunta: **cada arquivo tem UM dono**. Agentes de implementacao so preenchem o arquivo da sua rota/agente; **nunca editam `server.ts`** (que ja importa e registra tudo por caminho fixo).

## 3. Modelo de dados (Prisma / PostgreSQL)

A Fundacao escreve `prisma/schema.prisma` completo. Convencoes globais:

- **IDs**: `String @id @default(cuid())`.
- **Dinheiro**: `Int` em centavos BRL; `currency String @default("BRL")`.
- **Timestamps**: `createdAt @default(now())` / `updatedAt @updatedAt` em entidades mutaveis. `Event`, `AdInsight` e `AgentRun` sao majoritariamente append-only.
- **Enums Postgres nativos** para todo status.

### Enums

```prisma
enum EbookStatus     { DRAFT GENERATING READY PUBLISHED ARCHIVED }
enum OrderStatus     { PENDING AWAITING_PAYMENT PAID DELIVERED REFUNDED CANCELED EXPIRED }
enum PaymentStatus   { PENDING CONFIRMED RECEIVED OVERDUE REFUNDED FAILED }   // alinhado ao Asaas
enum PaymentProvider { ASAAS MERCADO_PAGO }
enum PaymentMethod   { PIX BOLETO CREDIT_CARD }
enum DeliveryStatus  { GRANTED ACTIVE EXHAUSTED EXPIRED REVOKED }
enum SocialStatus    { DRAFT SCHEDULED PUBLISHED FAILED }
enum AdStatus        { DRAFT ACTIVE PAUSED COMPLETED ARCHIVED }
enum AgentRunStatus  { RUNNING SUCCESS FAILED SKIPPED }
enum AgentName       { ORCHESTRATOR CONTENT SALES DELIVERY SOCIAL TRAFFIC ANALYTICS }
enum EventType {
  // funil de aquisicao -> conversao -> entrega
  IMPRESSION CLICK LANDING_VIEW CHECKOUT_STARTED PAYMENT_PENDING PAID DELIVERED REFUNDED
  // social
  SOCIAL_VIEW SOCIAL_ENGAGEMENT
  // operacionais internos (emitidos pelos agentes)
  EBOOK_PUBLISHED SOCIAL_POSTED CAMPAIGN_CREATED BUDGET_REALLOCATED AD_SPEND INSIGHT_INGESTED
}
```

### Entidades (resumo dos campos canonicos)

- **Customer** `{ id, email @unique, name?, phone?, asaasCustomerId?, createdAt, updatedAt }` — rel: `orders[]`, `events[]`, `deliveryGrants[]`.
- **Ebook** `{ id, title, niche, slug @unique, status EbookStatus, outline Json?, contentMarkdown @db.Text?, pdfPath?, coverImagePath?, language @default("pt-BR"), generatedByRunId?, createdAt, updatedAt }` — rel: `products[]`, `deliveryGrants[]`.
- **Product** (oferta vendavel sobre o Ebook) `{ id, ebookId, name, slug @unique, description?, priceCents Int, currency @default("BRL"), active @default(true), createdAt, updatedAt }` — rel: `ebook`, `orders[]`, `events[]`. Permite multiplos precos/bundles sobre o mesmo conteudo (ancora/bump/upsell).
- **Order** `{ id, customerId, productId, ebookId (denormalizado p/ entrega), status OrderStatus, priceCents Int (SNAPSHOT do Product no momento da compra), currency, utmSource?/utmMedium?/utmCampaign?/utmContent?/utmTerm?, visitorId?, adCampaignId?, asaasPaymentId?, paidAt?, deliveredAt?, createdAt, updatedAt }` — rel: `customer`, `product`, `payment?`, `deliveryGrant?`, `events[]`.
- **Payment** (1:1 logico com Order, tabela propria orientada a webhook) `{ id, orderId @unique, provider PaymentProvider, method PaymentMethod, providerPaymentId, status PaymentStatus, amountCents Int, pixQrCode?, pixCopyPaste?, dueDate?, paidAt?, raw Json, createdAt, updatedAt }` — `@@unique([provider, providerPaymentId])`.
- **DeliveryGrant** (token de download de uso limitado) `{ id, orderId @unique, ebookId, customerId, tokenHash @unique, status DeliveryStatus, maxDownloads @default(5), downloadCount @default(0), expiresAt, revokedAt?, emailSentAt?, lastDownloadAt?, createdAt, updatedAt }`. `signedUrl` NUNCA persistida — gerada on-demand pelo `StoragePort`.
- **SocialPost** `{ id, agentRunId?, platform @default("instagram"), caption @db.Text, mediaPaths String[], hashtags String[], status SocialStatus, scheduledAt?, publishedAt?, externalPostId?, permalink?, productId?, attempts @default(0), metrics Json?, error?, createdAt, updatedAt }`.
- **AdCampaign** `{ id, name, objective, status AdStatus, platform @default("meta"), externalCampaignId?, productId?, dailyBudgetCents Int?, totalSpendCents Int @default(0), utmCampaign? (chave de atribuicao), targeting Json?, startDate?, endDate?, createdAt, updatedAt }` — rel: `insights[]`, `events[]`.
- **AdInsight** (snapshot diario, time-series) `{ id, campaignId, date @db.Date, impressions @default(0), clicks @default(0), spendCents @default(0), conversions @default(0), revenueCents @default(0), createdAt, updatedAt }` — `@@unique([campaignId, date])` (upsert idempotente pelo TrafficAgent).
- **AgentRun** (log universal) `{ id, agent AgentName, status AgentRunStatus, cycleId?, startedAt, finishedAt?, durationMs?, input Json?, output Json?, metrics Json?, error?, tokensIn?, tokensOut?, costCents?, createdAt }` — rel: `ebooks[]` (geracao), `socialPosts[]`.
- **Event** (append-only; funil + idempotencia de webhook) `{ id, type EventType, occurredAt @default(now()), visitorId?, customerId?, productId?, orderId?, adCampaignId?, paymentId?, utmSource?/utmMedium?/utmCampaign?/utmContent?/utmTerm?, provider?, externalEventId?, costCents Int?, revenueCents Int?, payload Json?, metadata Json?, processedAt?, createdAt }`.

### Indices para KPIs

```prisma
@@index([occurredAt, type])      // Event — funil diario
@@index([adCampaignId])          // Event — atribuicao por campanha
@@index([visitorId])             // Event — costura pre/pos conversao
@@unique([provider, externalEventId]) // Event — idempotencia webhook
// Order(status, createdAt) ; Order(paidAt) ; Payment(paidAt) ; AdInsight(date)
```

### Fontes unicas de verdade (evita dupla contagem — risco mapeado)

| KPI | Fonte autoritativa | Derivados/aproximados |
|---|---|---|
| Faturamento contabil | `Order.priceCents` onde `status=PAID` | `Event(PAID).revenueCents`, `AdInsight.revenueCents` |
| Spend / ROAS de dashboard | `AdInsight` (snapshot) | `Event(costCents)` granular |
| Funil / atribuicao auditavel | `Event` | — |
| Custo de LLM dos agentes | `AgentRun.costCents / tokensIn / tokensOut` | — |

Regra: **nunca somar as tres fontes de receita**. `Order` e contabil; `Event`/`AdInsight` sao para KPI de funil/ads.

## 4. Camada de agentes (`packages/agents`)

### Classe base — Template Method

`packages/agents/src/base.ts` (FUNDACAO):

```ts
abstract class Agent {
  abstract readonly name: AgentName;
  abstract run(ctx: AgentContext): Promise<AgentRunResult>;
  // concreto: cria AgentRun(RUNNING) -> chama run() -> grava SUCCESS|FAILED|SKIPPED
  // com durationMs/tokens/cost; NUNCA deixa excecao escapar para o scheduler.
  async execute(ctx: AgentContext): Promise<AgentRun> { /* ciclo de vida */ }
}
```

Tipos (em `packages/core/src/types.ts`, re-exportados pela base):

```ts
type AgentRunResult = { status: 'SUCCESS' | 'SKIPPED'; output?: Json; metrics?: Json };
type AgentContext = {
  prisma; env; log; clock;
  ports: { llm: LLMPort; payment: PaymentPort; email: EmailPort;
           storage: StoragePort; instagram: InstagramPort; ads: AdsPort };
};
```

Agentes concretos **nunca** tocam a tabela `AgentRun` diretamente nem instanciam adapters — recebem ports via `AgentContext` (DI -> stub injetavel em testes vitest).

### Agentes

| Agente | Arquivo | Modelo LLM | Responsabilidade | Idempotencia / cooldown |
|---|---|---|---|---|
| **Orchestrator (CEO)** | `orchestrator.ts` | `claude-opus-4-8` | Le `KPISnapshot` do dia, aplica guardrails deterministicos, e so entao chama LLM de planejamento -> `AgentPlan` (validado por Zod). NAO faz trabalho de dominio. `runCycle(ctx)` executa agentes-filho por prioridade. | Cadencia ~15min (SLOW_TICK). Respeita cooldown de cada filho lendo ultimo `AgentRun.finishedAt`. |
| **Content** | `content.ts` | `claude-sonnet-4-6` | Decide nicho/tema, gera outline+conteudo, cria `Ebook`+`Product` (DRAFT->PUBLISHED), gera PDF (`lib/pdf.ts`), emite `EBOOK_PUBLISHED`. | Max N ebooks/dia (env). Checagem de duplicidade de nicho antes de publicar. |
| **Sales** | `sales.ts` | — | Reconcilia `Order`/`Payment` pos-webhook (sweep de `PENDING` antigos). Ajusta precos/ofertas conforme plano do CEO. Emite eventos de funil. | Idempotente por status; transicao nunca retrocede. |
| **Delivery** | `delivery.ts` | — | Busca `Order PAID` (Payment `CONFIRMED`/`RECEIVED`) sem `DeliveryGrant` ativo (`take:N`), gera token, cria grant, envia email com `/delivery/:token`, emite `DELIVERED`. Reprocessa grants sem `emailSentAt`. | Grant unico por Order (`@unique`). |
| **Social** | `social.ts` | `claude-sonnet-4-6` | Gera legenda+hashtags+prompt de criativo (Zod), agenda/publica via `InstagramPort`, registra `SocialPost`. Drena fila `SCHEDULED & scheduledAt<=now`. | Idempotente por `externalPostId`+status. Janela de cadencia ~60min. |
| **Traffic** | `traffic.ts` | — | Le `AdInsight`, calcula ROAS, e dentro de guardrails (teto de budget, ROAS minimo) escala/reduz/pausa `AdCampaign` via `AdsPort`. `destinationUrl` SEMPRE com UTMs. Emite `AD_SPEND`. | `AdsPort.updateBudget` = SET absoluto (nao incremento). |
| **Analytics** | `analytics.ts` | — | **UNICO** calculador de KPI: agrega `Event`+`Order`+`Payment`+`AdInsight`, produz `KPISnapshot` (ROAS/CAC/CPA/receita/lucro) usando formula null-guarded. | Append-only; sem efeitos colaterais externos. |

### Funcao objetivo do Orchestrator (meta R$1.000/dia)

- `faturamento_dia >= meta` -> **modo sustentar/otimizar** (foco Analytics + Traffic-otimizacao).
- `faturamento_dia < meta` -> **modo crescer** (Content novo + Social + escalar Traffic dentro do guardrail de ROAS).

Guardrails deterministicos **sempre vencem o LLM**: nunca escalar budget se ROAS < limite; nunca entregar sem Payment `CONFIRMED`/`RECEIVED`; teto diario de budget via env (`MAX_AD_BUDGET_BRL`). Cheap-first: regras baratas resolvem a maioria; LLM (`opus-4-8`) so para trade-offs ambiguos.

### Scheduler (`apps/api/src/scheduler.ts`)

Unico dono do `setInterval`. `server.ts` chama `startScheduler(app)`. Gated por `env.ENABLE_AGENTS`.

- **FAST_TICK ~60s**: agentes reativos idempotentes (Delivery, Sales-reconciliacao, ingest de Event, drenar fila Social).
- **SLOW_TICK ~15min**: `orchestrator.runCycle(ctx)` (planejamento/decisao).
- Cada tick: lock em memoria por agente (`Map<AgentName, boolean>` / `isRunning`) + `AgentRun` em `RUNNING` como marcador, para evitar reentrancia em ticks sobrepostos. Lotes limitados (`take:N`). Erros capturados por tick (`.catch`).

**Risco aceito (MVP)**: `setInterval` nao sobrevive a multiplas instancias. Mitigacao: rodar instancia unica + idempotencia por status. Futuro: Postgres advisory lock por agente/tick.

## 5. Fluxo de venda e entrega (PIX Asaas, webhook-first)

Logica de negocio em **services** (`checkout.service`, `webhook.service`, `delivery.service`); rotas finas seguem o plugin Fastify default export e **nao editam `server.ts`**.

```
[web checkout] ──POST /checkout──► cria/reusa Customer + Order(PENDING) + Payment(PENDING)
                                   PaymentPort.createPixCharge(Asaas)
                                   ◄── { providerPaymentId, pixQrCode, pixCopyPaste, dueDate }
                                   emite Event(CHECKOUT_STARTED)

[Asaas] ──POST /checkout/webhook──► valida header asaas-access-token (senao 401)
                                    insert Event(provider, externalEventId)  // @@unique = idempotente
                                    se PAYMENT_CONFIRMED/RECEIVED:
                                      prisma.$transaction:
                                        Payment.status -> CONFIRMED/RECEIVED
                                        Order.status   -> PAID (nunca retrocede)
                                        cria DeliveryGrant (token opaco, hash no banco)
                                        emite Event(PAID, revenueCents)
                                    APOS commit: EmailPort.send(link /delivery/:token) + set emailSentAt
                                    responde 200 (aceito ou duplicado) | 500 so em erro transitorio

[cliente] ──GET /delivery/:token──► hash-compare token (404 se invalido)
                                    valida status ACTIVE + expiresAt>now + downloadCount<maxDownloads
                                       (410 se expirado/limite/revogado)
                                    update atomico condicional: where downloadCount < maxDownloads
                                    StoragePort.getSignedUrl(key, ttl=5min)
                                    302 -> signed URL ; emite Event(DELIVERED) ; lastDownloadAt
```

Pontos criticos (riscos mapeados):

- **Idempotencia em 2 camadas**: `@@unique([provider, externalEventId])` no `Event` + transicoes guardadas que nunca retrocedem. Webhook fora de ordem (`RECEIVED` apos `CONFIRMED`) e duplicado nao recriam grant nem reenviam email.
- **Token**: segredo opaco (>=32 bytes base64url) so no email/URL; banco guarda `tokenHash` (sha256), comparacao em tempo constante.
- **Email apos commit**: efeito externo nunca dentro da `$transaction`. Se falhar, `Order` fica `PAID` mas nao `DELIVERED`; `DeliveryGrant.emailSentAt = null` faz o **DeliveryAgent** reenviar no proximo tick. O link do email aponta para `/delivery/:token` (estavel), **nunca** para a signed URL (efemera).
- **Reconciliacao**: `SalesAgent` varre `Payment PENDING` antigos via `PaymentPort.getPayment` (rede de seguranca), mesma logica idempotente — sem duplicar entrega.
- **CPF/CNPJ** opcional no checkout; falha de criacao de cobranca faz rollback (nao deixa Order/Payment inconsistente).

### Ports envolvidos (`packages/core/src/ports.ts`)

```ts
interface PaymentPort {
  createPixCharge(input: { orderId; amountCents; customer: { name; email; cpfCnpj? }; description }):
    Promise<{ providerPaymentId; pixQrCode; pixCopyPaste; dueDate }>;
  getPayment(providerPaymentId): Promise<{ status: PaymentStatus; paidAt? }>;
  parseWebhook(headers, body): { valid: boolean; event: string; providerPaymentId?; externalEventId?; status?: PaymentStatus };
}
interface EmailPort   { send(input: { to; subject; html; text? }): Promise<{ messageId }>; }
interface StoragePort { putObject(key, bytes): Promise<void>; getSignedUrl(key, ttlSeconds): Promise<string>; }
interface LLMPort     { generateText(input): Promise<...>; generateJson<T>(input, schema): Promise<T>; }
```

Adapters (`packages/adapters/src/*`): `payment.ts` = Asaas real + stub; `email.ts` = nodemailer/Resend + stub; `storage.ts` = disco local com signed URL propria (token+expiracao, nunca path adivinhavel) + stub; `llm.ts` = `@anthropic-ai/sdk` (`new Anthropic({apiKey}).messages.create({model, max_tokens, messages})`). Troca real<->stub por env.

## 6. Marketing e trafego

Tres agentes (Social, Traffic, Analytics) + rotas `social.ts`, `ads.ts`, `agents.ts`.

### Atribuicao

- **Chave canonica**: `AdCampaign.utmCampaign == Order.utmCampaign == Event.utmCampaign`.
- `visitorId` (cookie anonimo na landing) + UTMs costuram `Event` pre-conversao a `Order`/`Customer` pos-conversao. Quando `CHECKOUT_STARTED -> PAID`, o `visitorId`/UTM do `Order` liga retroativamente os events anteriores.
- `TrafficAgent` e `SocialAgent` **sempre** geram `destinationUrl` com `utm_source/medium/campaign/content/term`. Fallback: bucket generico explicito quando UTM ausente (last-touch). Modelo e last/first-touch — **multi-touch nao suportado**; CAC/ROAS sao aproximados (documentado como risco).

### Loop de otimizacao de budget (TrafficAgent + AnalyticsAgent)

1. `AnalyticsAgent` ingere insights (`AdsPort.getInsights`) -> upsert `AdInsight([campaignId, date])` -> casa spend com receita real de `Order PAID` por `utmCampaign`.
2. Calcula KPIs **null-guarded** (formula canonica de `venda-mais`):
   - `ROAS = revenueCents / spendCents` (null se spend=0)
   - `ROI  = (revenueCents - spendCents) / spendCents`
   - `CAC  = spendCents / sales` (so quando sales>0 e spend>0)
   - `CPA  = spendCents / conversions` (so quando conversions>0 e spend>0)
3. `TrafficAgent` decide com **guardrails**:
   - Nao age antes de **janela minima de amostragem** (>= gasto X OU >= N cliques) — evita ruido.
   - `ROAS >= meta (~2,0)` por **2 ciclos** -> escalar budget passo limitado (ex. +20%, respeitando `MAX_AD_BUDGET_BRL`).
   - `ROAS < 0,5` com receita>0, ou gasto sem venda apos a janela -> reduzir/pausar.
   - Passo maximo por ciclo + teto/piso de budget -> sem oscilacao.
   - `AdsPort.updateBudget` = **SET absoluto** (idempotente; reexecucao nao multiplica gasto).
   - **Kill-switch**: `setStatus(PAUSED)` em todas se ultrapassar teto global.
4. **AnalyticsAgent e a unica fonte de verdade de KPI** — Social/Traffic so emitem acoes e gravam `Event`/`AdInsight`.

### Ports de marketing (`packages/core/src/ports.ts`)

```ts
interface InstagramPort {
  publishPost(input: { caption; mediaUrl; hashtags? }): Promise<{ externalId; permalink }>;
  uploadMedia(input: { imageUrl }): Promise<{ containerId }>;
  getAccountInsights(range): Promise<{ reach; impressions; profileViews; followers }>;
  getPostInsights(externalId): Promise<{ likes; comments; saves; reach }>;
}
interface AdsPort {
  createCampaign(input: { name; objective; dailyBudgetCents; targeting; utmCampaign; destinationUrl }): Promise<{ externalId }>;
  updateBudget(externalId, dailyBudgetCents): Promise<void>;   // SET absoluto
  setStatus(externalId, status: 'ACTIVE'|'PAUSED'|'ARCHIVED'): Promise<void>;
  getInsights(externalId, range): Promise<Array<{ date; impressions; clicks; spendCents; conversions }>>;
}
```

Adapters: `instagram.ts` = `MetaGraphInstagramAdapter` (live) + `StubInstagramAdapter` (deterministico BR-first); `ads.ts` = `MetaMarketingAdsAdapter` + `StubAdsAdapter`. Troca por env `META_MODE=stub|live`.

> Nota de unidade: a `AdsPort` usa `dailyBudgetCents`/`spendCents` (Int centavos) para alinhar com D1 — **nao** `Decimal`/reais como em rascunhos de marketing.

## 7. Rotas da API (convencao critica)

Cada `src/routes/X.ts` exporta `default async (fastify) => {}`. `server.ts` (Fundacao) ja registra TODAS por caminho fixo. Implementadores so preenchem o proprio arquivo.

| Arquivo | Endpoints |
|---|---|
| `health.ts` | `GET /health` |
| `ebooks.ts` | `GET /ebooks`, `GET /ebooks/:slug`, (admin) gerar/publicar |
| `checkout.ts` | `POST /checkout`, `POST /checkout/webhook` |
| `delivery.ts` | `GET /delivery/:token` |
| `social.ts` | `GET /social/posts`, `POST /social/posts/generate`, `POST /social/posts/:id/publish` |
| `ads.ts` | `GET /ads/campaigns`, `GET /ads/campaigns/:id/insights`, `POST /ads/optimize` |
| `agents.ts` | `GET /agents/runs`, `POST /agents/:name/run` |

Validacao de body/query por Zod (`packages/core/src/schemas.ts`).

## 8. Configuracao (env)

`.env.example` (validado em `apps/api/src/env.ts` via Zod):

```
DATABASE_URL=postgresql://...
NODE_ENV=development
PORT=3001
ANTHROPIC_API_KEY=
ENABLE_AGENTS=true
FAST_TICK_MS=60000
SLOW_TICK_MS=900000
MAX_AD_BUDGET_BRL=300            # teto diario de budget de ads (guardrail)
TARGET_DAILY_REVENUE_BRL=1000    # meta de faturamento
ASAAS_API_KEY=
ASAAS_WEBHOOK_TOKEN=             # validacao do header asaas-access-token
PAYMENT_PROVIDER=asaas
META_MODE=stub                   # stub|live para Instagram + Ads
META_ACCESS_TOKEN=
EMAIL_PROVIDER=stub              # stub|resend|smtp
STORAGE_DIR=./storage            # stub local em disco
APP_BASE_URL=http://localhost:3001
```

## 9. Riscos transversais e mitigacoes

| Risco | Mitigacao |
|---|---|
| Atribuicao imperfeita (cookie/UTM quebram) | Documentar CAC/ROAS como aproximados; sempre injetar UTMs; fallback por janela temporal; bucket generico explicito. |
| Dupla contagem de receita | `Order` = fonte unica contabil; `Event`/`AdInsight` derivados. Nunca somar as tres. |
| Consistencia Order<->Payment<->Grant | `prisma.$transaction` atomica + idempotencia por `providerPaymentId`/`externalEventId`. |
| Gasto de ads descontrolado | `updateBudget` SET absoluto, teto `MAX_AD_BUDGET_BRL`, ROAS minimo, kill-switch, lock anti-reentrancia. |
| Entrega sem pagamento confirmado | Grant so apos Payment `CONFIRMED`/`RECEIVED`; token de uso limitado + expiracao. |
| Custo/latencia de LLM | Cheap-first (guardrails antes do LLM); medir tokens em `AgentRun.metrics`. |
| Timezone na receita diaria | `date_trunc` em America/Sao_Paulo; armazenar UTC. |
| Crescimento da tabela `Event` | Rollup periodico para `AdInsight`; considerar particionamento por data no futuro. |
| Qualidade de conteudo LLM | Gate de qualidade + checagem de duplicidade de nicho antes de publicar; revisao editorial minima. |
| Multiplas instancias da API | MVP instancia unica + idempotencia; futuro advisory lock. |

## 10. REGRA DE OURO (para todo implementador)

Antes de codar qualquer agente/rota/adapter: **ler** `prisma/schema.prisma`, `packages/core/src/{types,schemas,ports}.ts` e `packages/agents/src/base.ts` ja gravados pela Fundacao e alinhar nomes exatos de tipos/modelos/enums. **Nao inventar tipos divergentes nem modelos paralelos.** Nao editar `server.ts`.
