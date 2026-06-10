# FINANCE — Financeiro Consolidado

> Feature 2 da extensao do CRM/Command Center do **Ebook Empire**.
> DRE simplificada por periodo, margem por ebook/campanha, progresso da meta
> diaria + projecao, e `FinanceSnapshot` (serie historica).
>
> **Convencoes do projeto** (herdadas, nao reinventadas):
> - Monorepo pnpm, Node 20, TypeScript ESM.
> - **Dinheiro SEMPRE em Int centavos BRL.** Unica excecao: `marginPct`/`roas` sao
>   razoes/percentuais (`Float?`, null-guarded), igual ao que ja existe no
>   `AnalyticsAgent`.
> - Strings de usuario em **pt-BR**.
> - **Reaproveita** `saoPauloDay` / `saoPauloDayBoundsUtc` e o estilo de KPI puro
>   (`computeKpis`) do `AnalyticsAgent` (`packages/agents/src/analytics.ts`).
> - Para typecheck limpo: `pnpm --filter @ebook-empire/agents build` ANTES do
>   typecheck de `apps/api` (consome `dist/*.d.ts`).

---

## 1. Visao geral

```
FinanceService  (packages/agents/src/finance/finance-service.ts)
  helpers PUROS (sem DB, base dos testes numericos):
    feeConfigFromEnv(env) -> FeeConfig
    paymentFeeForOrderCents(priceCents, fees)   -> centavos (1 order)
    paymentFeesForOrders(priceCentsList, fees)  -> soma (cada order arredondada)
    marginPctOf(net, gross)                     -> number | null
    computeDreFromAggregates(agg)               -> DreResult
    resolveDayWindow(ctx, day?)                 -> { day, startUtc, endUtc, isPartial, dayFraction }
  metodos CTX-BASED / STATELESS (recebem AgentContext; leem Prisma):
    computeDre(ctx, { day? })        -> DreResult + meta/projecao
    marginByEbook(ctx, { day? })     -> EbookBreakdownResult (+ bucket unattributed)
    marginByCampaign(ctx, { day? })  -> CampaignBreakdownResult (+ bucket organic)
    goalProgress(ctx, { day? })      -> { targetCents, currentCents, pct, projectionCents }
    persistSnapshot(ctx, { day? })   -> upsert FinanceSnapshot (idempotente) -> FinanceSnapshotView
```

O `FinanceService` e **stateless**: `new FinanceService()` sem argumentos; toda a
dependencia de runtime (prisma, env com `ASAAS_FEE_*`/`TARGET_DAILY_REVENUE_BRL`,
clock, log) vem pelo `AgentContext` em cada chamada — mesmo padrao dos demais
agentes. Computa **on-demand** nas rotas GET; `persistSnapshot` grava o
consolidado diario para a serie historica (upsert idempotente por `date`). O
service **nao expoe metodo de historico** — a serie e lida direto de
`FinanceSnapshot` na rota `GET /finance/snapshots`.

### Divergencia DELIBERADA vs AnalyticsAgent (documentar no header do service)
- `AnalyticsAgent.profitCents = revenue - spend - llm` — **NAO** desconta taxas
  Asaas. E um **KPI operacional**.
- `FinanceService.netProfitCents = gross - paymentFees - spend - llm` — **desconta**
  as taxas Asaas. E a **visao contabil**.

Os dois coexistem de proposito. A janela de data e o `where` das fontes
(receita, spend, LLM) sao **identicos** ao do `AnalyticsAgent` — zero divergencia
de janela.

---

## 2. Formulas exatas

Tudo Int centavos; arredondamentos com `Math.round`; razoes null-guarded.

Periodo `[startUtc, endUtc)` derivado de `saoPauloDayBoundsUtc(day)`.

### 2.1 Entradas do periodo
| Grandeza | Fonte | `where` (IDENTICO ao AnalyticsAgent) |
|---|---|---|
| `grossRevenueCents` | `SUM(Order.priceCents)` | `status IN (PAID, DELIVERED) AND paidAt in [startUtc, endUtc)` |
| `paidOrders` | `COUNT(Order)` | mesmos pedidos acima |
| `adSpendCents` | `SUM(AdInsight.spendCents)` | `date = new Date(\`${day}T00:00:00.000Z\`)` |
| `llmCostCents` | `SUM(AgentRun.costCents)` | `startedAt in [startUtc, endUtc)` |

### 2.2 Taxas de pagamento (Asaas PIX) — POR TRANSACAO
O fixo incide **uma vez por pagamento**; somar so no total subestimaria a parcela
fixa. Logo o calculo e **por order**:

```
feeCents(order)  = Math.round(order.priceCents * ASAAS_FEE_PERCENT / 100) + ASAAS_FEE_FIXED_CENTS
paymentFeesCents = SUM( feeCents(order) )  sobre os paidOrders
```

Helpers **puros** (testaveis sem DB), espelhando o estilo de `computeKpis`:
```ts
paymentFeeForOrderCents(priceCents: number, fees: FeeConfig): number      // 1 order
paymentFeesForOrders(priceCentsList: number[], fees: FeeConfig): number   // soma por order
```
`FeeConfig = { asaasFeePercent; asaasFeeFixedCents }`, resolvido de
`feeConfigFromEnv(ctx.env)` (defaults `0.99` / `49`).

### 2.3 DRE / lucro
```
netProfitCents = grossRevenueCents - paymentFeesCents - adSpendCents - llmCostCents
marginPct = grossRevenueCents > 0
  ? Math.round((netProfitCents / grossRevenueCents) * 10000) / 100   // % liquida, 2 casas
  : null                                                             // null se receita 0
```
Helper puro: `marginPctOf(netProfitCents, grossRevenueCents)`. O nucleo da DRE
(`computeDreFromAggregates`) e puro/determinista — base dos testes numericos.

### 2.4 Meta diaria (reusa `TARGET_DAILY_REVENUE_BRL`)
```
targetRevenueCents = TARGET_DAILY_REVENUE_BRL * 100
progressPct = targetRevenueCents > 0 ? Math.round((grossRevenueCents / targetRevenueCents) * 100) : 0
metTarget   = grossRevenueCents >= targetRevenueCents
```

### 2.5 Projecao (so para o dia corrente)
```
dayFraction = (now - startUtc) / (endUtc - startUtc)    // [0..1], so quando isPartial
frac        = min(1, dayFraction)
projectedRevenueCents = isPartial && frac > 0
  ? max(grossRevenueCents, Math.round(grossRevenueCents / frac))   // cap inferior na receita realizada
  : grossRevenueCents
projectedMetTarget = projectedRevenueCents >= targetRevenueCents
isPartial          = now in [startUtc, endUtc)        // o dia (geralmente hoje SP) ainda em curso
```
Para dias passados (fechados): `projectedRevenueCents = grossRevenueCents`,
`isPartial = false`, `dayFraction = 1`. A janela e o flag `isPartial` saem de
`resolveDayWindow(ctx, day?)`.

### 2.6 Atribuicao por ebook (`groupBy Order.ebookId` nos paidOrders)
Por ebook:
```
revenueCents   = SUM(priceCents)
orders         = COUNT
paymentFeesCents = SUM( feeCents(order) ) dos orders do ebook
adSpendAttributedCents = ad spend rastreavel (ver abaixo) — best-effort, senao 0
netProfitCents = revenueCents - paymentFeesCents - adSpendAttributedCents      // LLM NAO entra (so no consolidado)
marginPct      = revenueCents > 0 ? round(net/revenue * 10000)/100 : null
```
- **LLM nao e atribuivel a ebook** de forma confiavel => fica apenas no
  consolidado.
- **Ad spend por ebook e best-effort**, so quando rastreavel via
  `Order.adCampaignId -> AdCampaign.productId -> Product.ebookId`. Quando nao
  mapeavel, `adSpendAttributedCents = 0` e o restante vai para o bucket
  `unattributedAdSpendCents` do consolidado. A fonte **primaria** de spend por
  unidade e a **campanha** (secao 2.7).

### 2.7 Atribuicao por campanha
```
spend por campanha   = SUM(AdInsight.spendCents) WHERE date=day GROUP BY campaignId
revenue por campanha = SUM(Order.priceCents) dos paidOrders WHERE adCampaignId = campaign.id
roas                 = spend > 0 ? revenue / spend : null         // mesmo null-guard do computeKpis.roas
netProfit            = revenue - paymentFees(orders da campanha) - spend
```
- Orders **sem** `adCampaignId` => receita **organica** (bucket `sem_campanha`).
- Spend de campanha **sem orders** aparece com `revenue=0` (queima).
- **Reconciliacao:** `SUM(revenue por campanha) + organico == grossRevenueCents`.
  Orders com `adCampaignId` apontando para campanha inexistente (FK opcional)
  caem no bucket organico para nao sumir receita.

---

## 3. FinanceSnapshot (dono: Fundacao — `prisma/schema.prisma`)

Aditivo, nao quebra nada. `marginPct` e `Float?` (razao/percentual, nao dinheiro)
— consistente com `roas`/`roi`. Upsert idempotente por `@@unique([date])` (mesmo
padrao de `AdInsight @@unique([campaignId, date])`).

```prisma
model FinanceSnapshot {
  id                String   @id @default(cuid())
  date              DateTime @db.Date           // dia local SP, mesma convencao de AdInsight.date
  grossRevenueCents Int      @default(0)
  paymentFeesCents  Int      @default(0)
  adSpendCents      Int      @default(0)
  llmCostCents      Int      @default(0)
  netProfitCents    Int      @default(0)
  marginPct         Float?                       // null se receita 0
  paidOrders        Int      @default(0)
  computedAt        DateTime @default(now())
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([date])                               // 1 consolidado por dia; upsert idempotente
  @@index([date])
}
```

> `snapshotDay` sobre o dia corrente grava um consolidado **parcial**; o upsert
> subsequente (mesmo `@@unique date`) corrige ao fechar o dia. **Sempre upsert,
> nunca create duplicado.**

---

## 4. FinanceService — interface (implementada)

CTX-based e **stateless** (nenhum estado/dependencia no construtor):

```ts
class FinanceService {
  constructor();   // sem argumentos

  computeDre(ctx: AgentContext, opts?: { day?: string }): Promise<DreResult>;
  marginByEbook(ctx: AgentContext, opts?: { day?: string }): Promise<EbookBreakdownResult>;
  marginByCampaign(ctx: AgentContext, opts?: { day?: string }): Promise<CampaignBreakdownResult>;
  goalProgress(ctx: AgentContext, opts?: { day?: string }):
    Promise<{ targetCents: number; currentCents: number; pct: number; projectionCents: number }>;
  persistSnapshot(ctx: AgentContext, opts?: { day?: string }): Promise<FinanceSnapshotView>;
}

// Config de taxas + helpers PUROS (exportados do mesmo modulo, sem DB):
interface FeeConfig { asaasFeePercent: number; asaasFeeFixedCents: number; }
feeConfigFromEnv(env): FeeConfig;                                  // defaults 0.99 / 49
paymentFeeForOrderCents(priceCents: number, fees: FeeConfig): number;
paymentFeesForOrders(priceCentsList: number[], fees: FeeConfig): number;
marginPctOf(netCents: number, grossCents: number): number | null;
computeDreFromAggregates(agg: DreAggregates): DreResult;
resolveDayWindow(ctx: AgentContext, day?: string): DayWindow;     // { day, startUtc, endUtc, isPartial, dayFraction }
```

O `ctx.env` precisa conter `ASAAS_FEE_PERCENT`, `ASAAS_FEE_FIXED_CENTS` e
`TARGET_DAILY_REVENUE_BRL` (a rota `/finance` os injeta via `buildAgentEnv`).
`goalProgress` deriva os numeros de `computeDre(...).meta`.

REUSO: importa `saoPauloDay` / `saoPauloDayBoundsUtc` de `'../analytics.js'`
(ja exportados). **Nao** reescreve a janela de data. Barrel `finance/index.ts`
reexporta o service; `agents/index.ts` (Fundacao) reexporta `finance`.

> **Nota de contrato:** este service substituiu a interface
> `getDailyDre/getEbookBreakdown/.../snapshotDay/getHistory` com construtor
> `(prisma, env, clock)` que aparecia em rascunhos anteriores. O contrato REAL e
> o ctx-based acima. A rota `/finance` monta um `AgentContext` leve (prisma + env
> + clock + log; `ports` e um proxy que lanca se tocado, pois o service so le
> Prisma) e chama esses metodos.

---

## 5. Endpoints `/finance` (dono: `apps/api/src/routes/finance.ts`)

Padrao identico a `crm.ts`: `default export async (fastify) => {}`; validacao Zod
`safeParse` com `400 { error: 'bad_request', issues }`; pt-BR; dinheiro Int
centavos. Registrado por `server.ts` (Fundacao). Schemas Zod novos no core
(`financeQuerySchema` etc).

**Leituras sem JWT** (como `GET /crm/overview`); apenas a escrita (`snapshot`)
exige Bearer.

| Metodo | Rota | Auth | Retorno |
|---|---|---|---|
| GET  | `/finance/health` | — | ping do modulo (`{ status: 'ok', module: 'finance' }`) |
| GET  | `/finance/overview` | — | atalho da home: DRE de hoje SP (sem query) — mesmo shape de `/finance/dre` |
| GET  | `/finance/dre?date=YYYY-MM-DD` | — | DRE do dia (default hoje SP) |
| GET  | `/finance/by-ebook?date=YYYY-MM-DD` | — | contribuicao por ebook + bucket `unattributedAdSpendCents` |
| GET  | `/finance/by-campaign?date=YYYY-MM-DD` | — | por campanha (ROAS) + bucket `organic` (sem campanha) |
| GET  | `/finance/snapshots?from=YYYY-MM-DD&to=YYYY-MM-DD` | — | serie de `FinanceSnapshot` (default ultimos 30 dias); retorna `{ from, to, snapshots }` |
| POST | `/finance/snapshot` `{ date? }` | JWT | forca computar + upsert do dia (default hoje); retorna `{ computed: true, snapshot }` |

> `GET /finance/snapshots` e uma **leitura direta** de `FinanceSnapshot` na
> propria rota (o `FinanceService` nao expoe `getHistory`). Default: janela de 30
> dias terminando hoje SP.

### Shapes
```jsonc
// GET /finance/dre
{
  "date": "2026-06-10",
  "grossRevenueCents": 0, "paymentFeesCents": 0, "adSpendCents": 0,
  "llmCostCents": 0, "netProfitCents": 0, "marginPct": null, "paidOrders": 0,
  "meta": {
    "targetRevenueCents": 100000, "progressPct": 0, "metTarget": false,
    "projectedRevenueCents": 0, "projectedMetTarget": false, "isPartial": true
  }
}

// GET /finance/by-ebook
{
  "date": "2026-06-10",
  "ebooks": [{
    "ebookId": "…", "title": "…",
    "revenueCents": 0, "orders": 0, "paymentFeesCents": 0,
    "adSpendAttributedCents": 0, "netProfitCents": 0, "marginPct": null
  }],
  "unattributedAdSpendCents": 0
}

// GET /finance/by-campaign
{
  "date": "2026-06-10",
  "campaigns": [{
    "campaignId": "…", "name": "…",
    "spendCents": 0, "revenueCents": 0, "roas": null, "netProfitCents": 0
  }],
  "organic": { "revenueCents": 0, "orders": 0 }
}

// POST /finance/snapshot
{ "computed": true, "snapshot": { /* FinanceSnapshotView */ } }
```

Cliente web (`apps/web/lib/api.ts`, dono web): `financeDre`, `financeByEbook`,
`financeByCampaign`, `financeHistory`, `financeSnapshot` + tipos espelhados
(`DreResult`, `EbookContribution`, `CampaignContribution`, `FinanceSnapshotView`).
Reusa `formatBRL` / `formatRoas` / `formatDate`.

---

## 6. Persistencia automatica do snapshot (wiring)

`persistSnapshot(ctx, { day })` e idempotente (upsert por `@@unique date`).
Recomendado dispara-lo no **SLOW_TICK** do scheduler ao fim de cada tick lento —
barato e mantem a serie atualizada **sem criar agente novo**. A rota `POST
/finance/snapshot` (JWT) cobre o on-demand e e o caminho exercitado pelos testes.

---

## 7. Envs (dono: Fundacao — `env.ts`, `.env.example`, `.env`)

| Env | Zod / default | Uso |
|---|---|---|
| `ASAAS_FEE_PERCENT` | `z.coerce.number().min(0).default(0.99)` | % Asaas PIX por transacao |
| `ASAAS_FEE_FIXED_CENTS` | `z.coerce.number().int().min(0).default(49)` | fixo R$0,49 por transacao PIX |
| `TARGET_DAILY_REVENUE_BRL` | **JA EXISTE** (default 1000) | reaproveitado para a meta diaria |

> **Defaults de taxa (0,99% + R$0,49) sao placeholders plausiveis** para PIX
> Asaas — **confirmar com a operacao** antes de tratar o lucro como contabil.
> Sao configuraveis por env e nao sao segredos (podem ir no `.env.example`).

---

## 8. Riscos / decisoes documentadas

- **Janela de spend em UTC, nao SP.** O `AnalyticsAgent` filtra `AdInsight.date`
  com `new Date(\`${day}T00:00:00.000Z\`)` (meia-noite **UTC**), enquanto receita
  e LLM usam a janela SP `[startUtc, endUtc)`. Decisao: **replicar identico** para
  consistencia com o Analytics; documentar a aproximacao (leve desalinhamento
  spend-UTC vs receita-SP).
- **Atribuicao por ebook e best-effort** (`Order.adCampaignId -> AdCampaign.productId
  -> Product.ebookId`); muitos campos podem ser nulos => grande bucket
  `unattributed`. Nunca falhar a rota por isso.
- **`marginPct` como `Float`** quebra levemente "dinheiro sempre Int", mas e
  razao/percentual (mesmo caso de `roas`/`roi`) — aceitavel. Garantir que nenhum
  **valor monetario** use Float.
- **Snapshot parcial do dia corrente** corrigido por upsert ao fechar o dia —
  sempre upsert, nunca create.
- **Reconciliacao de receita:** `SUM(revenue por campanha) + organico ==
  grossRevenueCents`; orders com `adCampaignId` orfao caem no bucket organico.
- **Build do pacote agents** antes do typecheck de `apps/api`
  (`pnpm --filter @ebook-empire/agents build`).

---

## 9. Testes (implementado)

**Unit (vitest)** — `packages/agents/src/finance/finance-service.test.ts`
(12 testes), todos sobre os helpers puros: `paymentFeeForOrderCents` /
`paymentFeesForOrders` (o fixo incide por transacao), `marginPctOf` (null em
receita 0), `computeDreFromAggregates` (netProfit/margem/meta/projecao) e
`resolveDayWindow` (fracao do dia, `isPartial`). Mais 9 testes da rota
`/finance` (validacao + shapes).

**E2E contra Postgres real** — `apps/api/scripts/e2e-finance-alerts.ts`
(compartilhado com Alerts):

```bash
pnpm --filter @ebook-empire/api e2e:ops
```

Semeia Orders PAID/DELIVERED + AdInsight + AgentRun e valida, com numeros
conferidos a mao: DRE (receita / taxas Asaas por order / adSpend / llm /
netProfit / margem), atribuicao `by-ebook` (via campanha -> product -> ebook,
mais o bucket unattributed), `by-campaign` (ROAS + bucket organico, com
reconciliacao de receita) e `persistSnapshot` idempotente (upsert no mesmo
`date`). Resultado atual: **46/0** (em conjunto com as assercoes de Alerts).

> Lembrar: `pnpm --filter @ebook-empire/agents build` antes do typecheck de
> `apps/api` (consome `dist/*.d.ts`).
