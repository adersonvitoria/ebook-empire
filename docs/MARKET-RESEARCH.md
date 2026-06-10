# Setor MARKET_RESEARCH — Pesquisa de Mercado (Serper.dev real) + GATE 1

> Feature de extensao do **Ebook Empire**. **Documento alinhado ao codigo
> implementado.** Adere a STACK existente (pnpm monorepo, Node 20, TS ESM; Fastify 4
> + Prisma 6 + Postgres@5433 + Zod na API; Next.js 14 no web). Dinheiro **SEMPRE Int
> centavos BRL** — porem **scores de mercado sao 0..100, NAO centavos**. Strings de
> usuario em **pt-BR**.

Documentos irmaos: `docs/SECTORS-TEAMS.md` (framework de papeis) e
`docs/EBOOK-QA.md` (GATE 2 + pipeline `createAndLaunchEbook`).

**Decisao implementada: PESQUISA EXTERNA REAL** (Serper.dev) com
`StubMarketDataAdapter` deterministico para `USE_STUBS=true`/testes.

---

## 0. Resumo executivo

O setor descobre **quais assuntos abordar** e os organiza por **potencial de
sucesso**. O time reusa os papeis-base via `runRole` (mas tem service proprio):

- **`MarketSpecialist`** (`specialist.ts`): coleta sinais **externos**
  (`ctx.ports.marketData.search` por nicho candidato) + **internos**
  (vendas/conversao por nicho do dominio) e produz um `Assessment`.
- **`MarketStrategist`** (`strategist.ts`): rankeia deterministicamente
  (`scoreOpportunity`) em `MarketOpportunity[]` ordenado por `potentialScore` desc;
  enriquece titulos/angulos/rationale do TOP-5 via LLM (best-effort).
- **`MarketExecutor`** (`executor.ts`): persiste o lote (PENDING) e marca a #1 como
  **SELECTED**; emite `Event MARKET_OPPORTUNITY_RANKED`.

**GATE 1 (obrigatorio):** nenhum ebook nasce sem uma `MarketOpportunity` SELECTED
(a de maior `potentialScore`). Enforcado no `launch-pipeline` via
`MarketResearchService.rankAndPick(ctx)` (ver EBOOK-QA.md Parte B).

---

## 1. Contrato Serper.dev (confirmado)

Confirmado via WebSearch (fontes: serper.dev, github.com/NightTrek/Serper-search-mcp,
apitracker.io/a/serper-dev).

**Request**
```
POST https://google.serper.dev/search
Headers: X-API-KEY: <SERPER_API_KEY>  +  Content-Type: application/json
Body:    { "q": string, "gl": "br", "hl": "pt-br", "num"?: number }
```

**Response (campos opcionais podem faltar)**
```
{
  "searchParameters": { "q", ... },
  "knowledgeGraph"?: { ... },
  "organic":          [ { "title", "link", "snippet", "position" } ],
  "peopleAlsoAsk"?:   [ { "question", "snippet" } ],
  "relatedSearches"?: [ { "query" } ]
}
```

> Serper **NAO retorna volume de busca numerico** — demanda e ESTIMADA por
> riqueza de `peopleAlsoAsk` + `relatedSearches`; competicao por `organic.length` +
> presenca de `knowledgeGraph`. O shape bruto **nunca vaza** do adapter:
> `normalizeSerperResponse` o converte em `MarketSearchResult`.

---

## 2. `MarketDataPort` (core/ports.ts — Fundacao)

```ts
interface MarketSearchInput  { query: string; gl?: string; hl?: string; num?: number; }
interface MarketOrganicResult { title: string; link: string; snippet: string; position: number; }
interface MarketPaaItem       { question: string; snippet?: string; }
interface MarketSearchResult {
  query: string;
  totalOrganic: number;
  organic: MarketOrganicResult[];
  relatedSearches: string[];
  peopleAlsoAsk: MarketPaaItem[];
  knowledgeGraphPresent: boolean;
}
interface MarketDataPort { search(input: MarketSearchInput): Promise<MarketSearchResult>; }
```

`marketData?: MarketDataPort` e **OPCIONAL** no bundle `Ports` (mesmo padrao de
`ctx.alert?`). O `MarketSpecialist.requireMarketData(ctx)` exige presenca e **falha
claro** (pt-BR) se ausente — o GATE 1 entao aborta o lancamento.

---

## 3. Adapter (`packages/adapters/src/market-data.ts` — dono Mercado)

Reexportado por `packages/adapters/src/index.ts`.

- **`SerperMarketDataAdapter implements MarketDataPort`** —
  `constructor({ apiKey, gl?, hl?, timeoutMs? })`. Lanca se `apiKey` vazio
  (mensagem pt-BR). `search()`: `fetch` nativo `POST https://google.serper.dev/search`,
  headers `X-API-KEY` + `Content-Type: application/json`, body `{ q, gl, hl, num? }`;
  `AbortController` com timeout default **12000ms**; `!res.ok` => lanca com status.
- **`StubMarketDataAdapter implements MarketDataPort`** — deterministico (hash FNV
  + Mulberry32 a partir da `query`): `organic` 5-10, PAA 2-5, related 3-6,
  `knowledgeGraphPresent` ~40%. Mesma query => mesma saida.
- **`normalizeSerperResponse(query, raw)`** — parser defensivo exportado p/ teste.
- **Factory:**
  ```ts
  createMarketDataAdapter(env: {
    USE_STUBS: boolean;
    MARKET_DATA_PROVIDER: 'serper'|'stub';
    SERPER_API_KEY: string;
    MARKET_SEARCH_GL?: string;
    MARKET_SEARCH_HL?: string;
  }): MarketDataPort
  ```
  `USE_STUBS===true` **OU** `provider!=='serper'` **OU** `SERPER_API_KEY` vazio =>
  `StubMarketDataAdapter`; senao `SerperMarketDataAdapter`.

Testes: `packages/adapters/src/market-data.test.ts`.

---

## 4. Scoring (puro, no `strategist.ts`)

Funcoes puras exportadas (0..100, sem `Math.random`):
- `demandScoreOf(signal)`, `competitionScoreOf(signal)` (MAIOR = pior),
  `potentialScoreOf(...)`, `scoreOpportunity(signal): MarketOpportunity`.

O ranking deterministico (`signals.map(scoreOpportunity).sort(potentialScore desc)`)
**nunca** depende do LLM; o LLM so enriquece `titleIdeas`/`angles`/`rationale` do
TOP-5 (e e instruido a **nao** alterar os scores).

---

## 5. `MarketOpportunity` — tipo e persistencia

```ts
interface MarketOpportunity {
  segment: string; niche: string;
  demandScore: number; competitionScore: number; potentialScore: number;
  rationale: string; titleIdeas: string[]; angles: string[]; evidence: string[];
}
// MarketOpportunityRecord = MarketOpportunity + { id, status, generatedByRunId,
//   selectedAt, usedByEbookId, createdAt, rankedAt, updatedAt }
```

Prisma `MarketOpportunity` (Fundacao): scores `Int`, `status MarketOpportunityStatus`
(`PENDING | SELECTED | USED | DISCARDED`, default PENDING), `generatedByRunId?`,
`selectedAt?`, `usedByEbookId?`, `rankedAt`, indices em `status`/`potentialScore`/
`niche`. **`Ebook.marketOpportunityId String?`** liga o ebook lancado a oportunidade
(base do GATE / auditavel).

---

## 6. `MarketResearchService` (`service.ts` — dono Mercado)

```ts
class MarketResearchService {
  constructor(opts?: { candidates?: readonly NicheCandidate[] });

  // Roda assess->strategize->execute; cada papel grava AgentRun(role+sector=MARKET_RESEARCH).
  runTeam(ctx): Promise<{ team: TeamRunResult; opportunities: MarketOpportunityRecord[] }>;

  // GATE 1: roda runTeam e devolve a oportunidade #1 (SELECTED), ou null.
  rankAndPick(ctx): Promise<MarketOpportunityRecord | null>;

  // Para a rota GET /market/opportunities (ordena rankedAt desc, potentialScore desc).
  latestOpportunities(ctx, opts?: { limit?; status? }): Promise<MarketOpportunityRecord[]>;

  // GET /market/top — a SELECTED de maior potencial.
  topOpportunity(ctx): Promise<MarketOpportunityRecord | null>;
}
function createMarketResearchService(opts?): MarketResearchService;
```

> Estes nomes (`MarketResearchService` / `createMarketResearchService` com
> `rankAndPick`) sao exatamente os que o wiring default do `launch-pipeline` procura
> por import dinamico em `sectors/market-research/index.js`.

Nichos candidatos default: **`DEFAULT_NICHE_CANDIDATES`** (8 nichos BR em
`specialist.ts`), sobrescrivivel via `new MarketResearchService({ candidates })`.
`MARKET_MAX_QUERIES_PER_RUN` teta o nº de chamadas Serper por rodada. Custo Serper
**nao entra** em `llmCostCents`.

---

## 7. Rotas (`apps/api/src/routes/market.ts`)

Registrada por caminho fixo em `server.ts`.

| Metodo | Rota | Uso |
|---|---|---|
| GET | `/market/health` | disponibilidade + provider + count de oportunidades |
| GET | `/market/opportunities` | ranking persistido (`?status&limit`, limit 1..200 default 50) |
| GET | `/market/top` | a oportunidade SELECTED de maior potencial (404 se nenhuma) |
| POST | `/market/scan` **[JWT]** | roda o time e persiste; devolve `{ ok, cycleId, count, top, assessment, strategy, opportunities }` |

A rota monta um **`AgentContext` local** com `createMarketDataAdapter` +
`createLLMAdapter` (demais ports sao throwers) — o scheduler NAO injeta `marketData`
no bundle Ports global. Se o PIPELINE quiser rodar o time pelo scheduler, precisa
adicionar `marketData` em `resolvePorts`.

---

## 8. Envs (`apps/api/src/env.ts` — Fundacao)

```ts
MARKET_DATA_PROVIDER:        z.enum(['serper','stub']).default('stub'),
SERPER_API_KEY:              z.string().optional().default(''),
MARKET_SEARCH_GL:            z.string().default('br'),
MARKET_SEARCH_HL:            z.string().default('pt-br'),
MARKET_RESEARCH_WINDOW_DAYS: z.coerce.number().int().positive().default(14),
MARKET_MAX_QUERIES_PER_RUN:  z.coerce.number().int().min(1).default(10),
```
`USE_STUBS=true` (default) **forca o stub** mesmo com `SERPER_API_KEY` setada.
Para Serper real: `USE_STUBS=false` + `MARKET_DATA_PROVIDER=serper` +
`SERPER_API_KEY=<chave>`.

---

## 9. GATE 1 (pre-lancamento)

O `launch-pipeline` chama `rankAndPick(ctx)` **PRIMEIRO**: `null` => encerra em
`MARKET_GATE` e **NAO** gera ebook. A oportunidade escolhida vira `niche`/`title`
do Content e fica gravada em `Ebook.marketOpportunityId`. *"SEMPRE faremos isso
antes de lancar 1 ebook."*

---

## 10. Testes

`packages/agents/src/sectors/market-research/service.test.ts` +
`packages/adapters/src/market-data.test.ts` (vitest, stubs): stub deterministico;
scoring puro; ranking estavel `potentialScore desc`; `rankAndPick` seleciona a #1
(SELECTED); parse defensivo de payloads Serper parciais; degradacao sem
`ctx.ports.marketData`.
