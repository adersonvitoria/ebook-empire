# Times por Setor — Framework de Papeis (Specialist / Strategist / Executor)

> Feature de extensao do **Ebook Empire**. **Documento alinhado ao codigo
> implementado** (nao mais ao design original). Adere a STACK existente (pnpm
> monorepo, Node 20, TS ESM; Fastify 4 + Prisma 6 + Postgres@5433 + Zod na API;
> Next.js 14 App Router + Tailwind + TanStack Query no web). Dinheiro **SEMPRE Int
> centavos BRL**; scores de time/saude/mercado/QA sao **0..100, NAO centavos**.
> Strings de usuario em **pt-BR**.

Documentos irmaos: `docs/MARKET-RESEARCH.md` (setor MARKET_RESEARCH + GATE 1) e
`docs/EBOOK-QA.md` (setor EBOOK_QA + GATE 2 + pipeline `createAndLaunchEbook`).
Este documento descreve **so o framework generico** e os bindings dos 7 setores de
saude.

---

## 0. Resumo executivo

Cada setor opera como um **TIME de 3 papeis** que harmonizam rumo a meta diaria
(`TARGET_DAILY_REVENUE_BRL`, default R$1.000/dia):

| Papel | Classe (real) | Pergunta | Saida |
|---|---|---|---|
| **Especialista** | `Specialist` | "Como esta o setor?" | `Assessment` (diagnostico, riscos, oportunidades, evidencias) |
| **Estrategista** | `Strategist` | "O que fazer rumo a meta?" | `Strategy` (objetivo, acoes priorizadas, criterios de sucesso) |
| **Executor** | `Executor` | "Executar" | `ExecutionOutcome` (acoes executadas: SUCCESS/FAILED/SKIPPED) |

A classe **`SectorTeam`** coordena `assess -> strategize -> execute`. Um REGISTRY
config-driven — **`buildSectorRegistry(deps)`** — devolve um
`Record<Sector, SectorConfig>` com prompts, fonte de KPI e os bindings do executor
para cada um dos **7 setores de saude** (CONTENT, SALES, DELIVERY, SOCIAL,
TRAFFIC, ANALYTICS, ORCHESTRATION).

> **Decisao implementada (framework generico + setores via config):** nao ha
> classe por setor. As 3 classes genericas `Specialist`/`Strategist`/`Executor`
> recebem um `SectorConfig`; toda diferenca vive nos dados do REGISTRY.

> **Importante (escopo real):** os 2 setores novos (MARKET_RESEARCH e EBOOK_QA)
> **REUSAM** os papeis-base de `team/roles.ts` (via `runRole`), mas tem times/config
> **proprios** em `sectors/*` e **NAO entram** em `buildSectorRegistry()` (que e so
> dos 7 de saude). Ver os docs irmaos.

---

## 0.1 Setores cobertos pelo COO (loop FAST) — 10 setores

> Distinto do framework de TIMES (acima). O **COO/OperationsAgent** (loop FAST do
> Command Center) monitora a SAUDE, diagnostica e remedia. Apos fechar o loop, ele
> cobre **10 setores OPERAVEIS** (`CrmSector` em `core/crm.ts`): os 7 de saude **+
> os 3 de producao autonoma MARKETPLACE/FUNNEL/AFFILIATE**.

Tres familias de "setor" coexistem no codigo, de proposito (ver `core/crm.ts`):

| Constante (core) | Setores | Quem usa |
|---|---|---|
| `SECTORS` / `Sector` (7) | CONTENT, SALES, DELIVERY, SOCIAL, TRAFFIC, ANALYTICS, ORCHESTRATION | scoring ponderado dos 7 (`SECTOR_WEIGHTS`), `buildSectorRegistry` dos TIMES |
| `TEAM_SECTORS` / `TeamSector` (9) | os 7 + MARKET_RESEARCH + EBOOK_QA | framework de TIMES (este doc) + docs irmaos |
| `CRM_SECTORS` / `CrmSector` (10) | os 7 + MARKETPLACE + FUNNEL + AFFILIATE | **loop do COO** (collect/diagnose/remediate) + Problem/Action novos |

**Decisao (§6 desta pagina, reafirmada):** os 3 setores de producao **NAO** entram
em `Sector`/`SECTORS`/`SECTOR_WEIGHTS` — esses 3 arrays dirigem o LOOP de scoring
ponderado dos 7 de saude no `health-collector`. Os 3 novos usam **scoring local**
(`CRM_SUBSCORE_WEIGHTS` em `health-collector.ts`, via `crmWeightedScore`), entao
adiciona-los ali quebraria o scoring dos 7 (REGRA SUPREMA). O enum Prisma
`OperationalSector` ja contem os 10 (aditivo/seguro). A priorizacao relativa entre
os 10 vive em `PRODUCTION_SECTOR_WEIGHTS` (soma 100).

### Cobertura no loop do COO (fechada)

- **`health-collector.collect()`** retorna os **10** `SectorHealth` por tick (7 via
  os coletores de saude; MARKETPLACE/FUNNEL/AFFILIATE via
  `collectMarketplace/collectFunnel/collectAffiliate` + `finalizeCrm`). Grava 10
  `SectorHealthSnapshot` por ciclo.
- **Diagnostico**: os 7 via `SECTOR_RULES`/`runRules`; os 3 de producao via
  `CRM_SECTOR_RULES`/`runCrmRules` (em `crm/diagnosis.ts`). `gatherActionContext`
  popula `Problem.metadata` (productId/provider/affiliateId/niche/count) tambem para
  os setores novos, de modo que o catalogo monte acoes com params obrigatorios.
- **Remediacao**: `action-catalog.buildProposal()` tem cases para os kinds dos
  setores novos, entao o COO **propoe esses ActionKinds autonomamente** no loop.

### ActionKinds por setor (loop do COO)

`SECTOR_KINDS` (em `crm/action-catalog.ts`) — ordem = prioridade default quando o
diagnostico nao sugere nada valido. `riskTier` e ESTATICO em `ACTION_SPECS`:

| Setor | ProblemTypes | ActionKinds (tier) |
|---|---|---|
| CONTENT | EMPTY_CATALOG, STALE_CATALOG, EBOOK_GENERATION_FAILING | `GENERATE_EBOOK` (LOW), `GENERATE_MORE_EBOOKS` (LOW) |
| SALES | CHECKOUT_DROPOFF, LOW_CONVERSION | `REGENERATE_LANDING_COPY` (LOW), `ADJUST_PRICE` (HIGH) |
| DELIVERY | DELIVERY_FAILURES, DELIVERY_BACKLOG | `RETRY_DELIVERIES` (LOW) |
| SOCIAL | SOCIAL_PUBLISH_FAILURES, NO_RECENT_POSTS, LOW_ENGAGEMENT | `GENERATE_SOCIAL_POSTS` (LOW) |
| TRAFFIC | NO_ACTIVE_CAMPAIGNS, NEGATIVE_ROAS, BUDGET_EXHAUSTED | `DECREASE_AD_BUDGET`, `PAUSE_CAMPAIGN`, `INCREASE_AD_BUDGET` (todos HIGH) |
| ANALYTICS | KPI_STALE, INSIGHTS_NOT_INGESTED | `RECOMPUTE_KPIS` (LOW) |
| ORCHESTRATION | REVENUE_BELOW_TARGET, CYCLE_NOT_RUNNING, AGENT_REPEATEDLY_FAILING | `RERUN_AGENT` (LOW), `GENERATE_MORE_EBOOKS` (LOW) |
| **MARKETPLACE** | MISSING_COVER, DEAD_LISTING | `PAUSE_LISTING` (**HIGH**, reversivel), `GENERATE_MORE_EBOOKS` (LOW) |
| **FUNNEL** | HIGH_CART_ABANDONMENT, LANDING_DROPOFF | `REGENERATE_LANDING_COPY` (LOW) |
| **AFFILIATE** | AFFILIATE_REVENUE_ZERO, NO_AFFILIATE_ACTIVITY | `BOOST_AFFILIATE_OUTREACH` (LOW), `SEND_AFFILIATE_EMAIL` (LOW) |

Os 4 ActionKinds de producao (`GENERATE_MORE_EBOOKS`, `PAUSE_LISTING`,
`BOOST_AFFILIATE_OUTREACH`, `SEND_AFFILIATE_EMAIL`) + o reuso de
`REGENERATE_LANDING_COPY` para FUNNEL fecham a remediacao dos 3 setores novos.
Detalhe de verificacao em `STATUS.md` (secao "COO-Scale").

---

## 1. Arquivos (donos)

| Arquivo | Conteudo |
|---|---|
| `packages/agents/src/team/roles.ts` | classes `Specialist` / `Strategist` / `Executor` + helper `runRole()` + `normalizeAssessment`/`normalizeStrategy` + tipo `TeamHealth` |
| `packages/agents/src/team/sector-config.ts` | `SectorConfig`, `CapabilityBinding`, `CapabilityResult`, `SectorTeamDeps`, helpers `bindAgent`, **`buildSectorRegistry(deps?)`**, tipo `SectorRegistry` |
| `packages/agents/src/team/sector-team.ts` | classe `SectorTeam` + `TeamRunSummary` + factory `makeSectorTeam(cfg)` |
| `packages/agents/src/team/index.ts` | barrel (`roles`/`sector-config`/`sector-team`) |
| `packages/core/src/team.ts` (Fundacao) | tipos `Role`, `TeamSector`, `Assessment`, `Strategy`, `StrategyAction`, `ExecutedAction`, `ExecutionOutcome`, `TeamRunResult` |
| `packages/core/src/schemas.ts` (Fundacao) | `assessmentSchema`, `strategySchema` (Zod, validam saida do LLM) + `statusFromScore` |
| `packages/agents/src/base.ts` (Fundacao) | `AgentContext` (`prisma/ports/env/log/clock/cycleId/alert?`) |

> **Build:** `apps/api` consome `packages/agents/dist/*.d.ts`. Buildar
> `@ebook-empire/core` e depois `@ebook-empire/agents`
> (`pnpm --filter @ebook-empire/agents build`) **antes** do typecheck/uso na API.

---

## 2. Contrato de dados (core/team.ts)

`Assessment` e `Strategy` sao **saidas de LLM** e ganham Zod em `schemas.ts`
(mesmo padrao de `ebookOutlineSchema`/`agentPlanSchema`).

```ts
export type Role = 'SPECIALIST' | 'STRATEGIST' | 'EXECUTOR';

export interface Assessment {
  sector: TeamSector;             // 9 valores (7 saude + MARKET_RESEARCH + EBOOK_QA)
  healthScore: number;            // 0..100
  status: SectorStatus;           // HEALTHY | WARNING | CRITICAL (statusFromScore)
  findings: string[];             // pt-BR
  risks: string[];
  opportunities: string[];
  evidence: Json;                 // KPIs/sinais usados
  confidence: number;             // 0..1
  source: 'RULES' | 'LLM';        // RULES = fallback deterministico
}

export interface StrategyAction {
  capability: string;             // chave de cfg.executorBindings
  priority: number;               // 0..100
  params: Json;
  reason: string;
}

export interface Strategy {
  sector: TeamSector;
  objective: string;              // alinhado a TARGET_DAILY_REVENUE_BRL
  mode: 'GROW' | 'SUSTAIN';
  actions: StrategyAction[];
  successCriteria: string[];
  rationale: string;
}

export interface ExecutedAction {
  capability: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  agentRunId?: string;            // id do AgentRun do Agent acionado
  error?: string;
}

export interface ExecutionOutcome {
  sector: TeamSector;
  executed: ExecutedAction[];
  succeeded: number;
  failed: number;
  skipped: number;
  summary: string;
}

export interface TeamRunResult {
  sector: TeamSector;
  assessment: Assessment;
  strategy: Strategy;
  outcome: ExecutionOutcome;
}
```

JSON malformado do LLM **nunca** derruba o time: `assessmentSchema.parse` /
`strategySchema.parse` rodam dentro de `try/catch -> fallback deterministico`
(`source:'RULES'`), igual ao `orchestrator.buildPlan`.

---

## 3. As 3 classes genericas (roles.ts)

Todas recebem um `SectorConfig` no construtor e envelopam o trabalho em
`runRole()`, que cria/atualiza um **`AgentRun` com `role` + `sector`** (RUNNING ->
SUCCESS/FAILED, `durationMs`, `output`, `metrics`, `tokensIn/Out`, `costCents`).

```ts
class Specialist {
  constructor(cfg: SectorConfig);
  assess(ctx: AgentContext): Promise<RoleRunResult<Assessment>>;
}
class Strategist {
  constructor(cfg: SectorConfig);
  strategize(ctx: AgentContext, assessment: Assessment): Promise<RoleRunResult<Strategy>>;
}
class Executor {
  constructor(cfg: SectorConfig);
  execute(ctx: AgentContext, strategy: Strategy): Promise<RoleRunResult<ExecutionOutcome>>;
}

interface RoleRunResult<T> { data: T; runId: string; tokensIn?; tokensOut?; costCents?; }
```

### 3.1 `Specialist.assess`
1. Le o KPI canonico via **`cfg.readHealth(ctx)`** (`{ score, kpis }`).
2. Monta o fallback deterministico (`fallbackAssessment` a partir do score/status).
3. Tenta enriquecer com LLM **`PLANNING_MODEL`** (`claude-opus-4-8`),
   `generateJson` validando com `assessmentSchema.parse` + `normalizeAssessment`
   (forca `healthScore`/`status`/`source:'LLM'`). LLM ausente/parse falho => cai no
   fallback (`source:'RULES'`).

### 3.2 `Strategist.strategize`
1. Recebe o `Assessment`; monta `fallbackStrategy` (aciona **todas** as
   capabilities do binding com prioridade base; `mode = status==='HEALTHY' ?
   'SUSTAIN' : 'GROW'`).
2. Tenta LLM `PLANNING_MODEL` (`generateJson` + `strategySchema.parse` +
   `normalizeStrategy`). Depois **`filterKnownCapabilities`**: descarta acoes cuja
   `capability` nao esta no binding; se sobrar zero, usa o fallback.

### 3.3 `Executor.execute`
- Ordena `strategy.actions` por `priority` desc; tolera falha individual.
- Para cada acao resolve `cfg.executorBindings[action.capability]`:
  - binding ausente => `ExecutedAction { status:'SKIPPED', error:'capability sem binding' }`;
  - binding lanca => `status:'FAILED'` (o outcome continua);
  - sucesso => `status` do `CapabilityResult` (`SUCCESS`/`FAILED`/`SKIPPED`) +
    `agentRunId`.
- Agrega `succeeded`/`failed`/`skipped` + `summary` pt-BR.

---

## 4. REGISTRY e bindings (sector-config.ts)

```ts
interface SectorConfig {
  sector: TeamSector;
  agentName: AgentName;                  // grava no AgentRun.agent dos papeis
  specialistSystem: string;              // prompt pt-BR
  strategistSystem: string;              // prompt pt-BR
  readHealth: (ctx) => Promise<{ score: number; kpis: Json }>;
  executorBindings: Record<string, CapabilityBinding>;
}

type CapabilityBinding = (ctx: AgentContext, params: Json) => Promise<CapabilityResult>;
interface CapabilityResult { status: 'SUCCESS'|'FAILED'|'SKIPPED'; agentRunId?: string; error?: string; }
```

Os bindings dos 7 setores usam o helper **`bindAgent(resolve)`** (via
`agentBinding(deps, name)`), que resolve um `Agent` concreto por
`deps.makeAgent(name, ctx, params)` e roda **`agent.execute(ctx)`** (que ja grava o
proprio `AgentRun` e nunca lanca) — devolvendo o `agentRunId`. **`makeAgent`
ausente => `SKIPPED`** ("agente nao disponivel neste ambiente").

`buildSectorRegistry(deps?)` (default `deps = {}`):

| Setor | `agentName` | capability default |
|---|---|---|
| CONTENT | CONTENT | `generateEbook` |
| SALES | SALES | `reconcileSales` |
| DELIVERY | DELIVERY | `deliverPending` |
| SOCIAL | SOCIAL | `publishSocial` |
| TRAFFIC | TRAFFIC | `optimizeAds` |
| ANALYTICS | ANALYTICS | `recomputeKpis` |
| ORCHESTRATION | ORCHESTRATOR | `runCycle` |

`readHealth` default reusa o **`DbHealthCollector`** do CRM (mesma fonte de scoring
dos 7 setores); sem snapshot, retorna neutro `score:60`.

```ts
interface SectorTeamDeps {
  makeAgent?: (name: AgentName, ctx, params: Json) => Agent | null;
  readSectorHealth?: (ctx, sector: Sector) => Promise<SectorHealth>;
}
```

> **Estado atual do wiring:** `buildSectorRegistry()` **sem `deps.makeAgent`** roda
> assess/strategize normalmente, mas os bindings retornam `SKIPPED` (agente nao
> disponivel). O scheduler/Orchestrator (dono PIPELINE) ainda **nao** injeta
> `SectorTeamDeps.makeAgent` com os agentes reais nem coordena os `SectorTeam`. Ver
> §6.

---

## 5. `SectorTeam` (coordenador tolerante a falha)

```ts
class SectorTeam {
  readonly sector: TeamSector;
  constructor(cfg: SectorConfig);
  run(ctx: AgentContext): Promise<TeamRunSummary>;
}
interface TeamRunSummary extends TeamRunResult {
  failedRoles: ('SPECIALIST'|'STRATEGIST'|'EXECUTOR')[];
  runIds: { specialist?: string; strategist?: string; executor?: string };
}
function makeSectorTeam(cfg: SectorConfig): SectorTeam;
```

`run()` executa `assess -> strategize -> execute` em sequencia. Cada etapa e um
`AgentRun(role+sector)` proprio (via `runRole`). **Tolerancia a falha de papel** —
um papel que lanca NUNCA derruba o chamador:
- Specialist falha => `minimalAssessment` (`healthScore:0`, `source:'RULES'`).
- Strategist falha => `emptyStrategy` (sem acoes).
- Executor falha => `emptyOutcome` (zero acoes).
O papel que falhou entra em `failedRoles`; `run()` resolve normalmente.

---

## 6. Coordenacao pelo Orchestrator/CEO (dono: PIPELINE) — PENDENTE

> Estas edicoes pertencem ao modulo **PIPELINE** (`orchestrator.ts`/`scheduler.ts`),
> nao ao modulo Times.

Hoje o CEO coordena os agentes-filho diretamente; **ainda nao** coordena os
`SectorTeam` nem injeta `SectorTeamDeps.makeAgent` com os agentes reais. Para
plugar:
1. `scheduler.ts` resolve os agentes reais e monta `deps.makeAgent`.
2. `buildSectorRegistry(deps)` -> `makeSectorTeam(cfg)` por setor priorizado.
3. `team.run(childCtx)` propagando `cycleId`, tolerando falha individual.

O **COO/OperationsAgent permanece intocado** no loop FAST (saude + remediacao),
complementar ao CEO+Times (proativo, rumo a meta).

---

## 7. Observabilidade

- Cada papel = 1 `AgentRun` com `agent` (homonimo do setor), `role`
  (SPECIALIST/STRATEGIST/EXECUTOR), `sector` e `output`/`metrics`, correlacionado
  por `cycleId`.
- A pagina **`/crm/teams`** consome `GET /agents/runs` (via `api.teamRuns`) e
  agrupa por setor, degradando com gracia.

> **Limitacao conhecida (dona: rota de Agentes/API, fora deste escopo):** a rota
> `GET /agents/runs` ainda **nao** seleciona `role`/`sector`/`output` nem filtra por
> `sector`. Enquanto isso, `/crm/teams` mostra os setores vazios. Para popular
> Assessment/Strategy/ExecutionOutcome reais, o dono da rota precisa adicionar
> `role`/`sector`/`output` ao `select` (ou expor uma rota `/agents/teams`).

---

## 8. Testes

`packages/agents/src/team/sector-team.test.ts` (vitest, stubs): caminho feliz
`assess->strategize->execute`; fallback de cada papel (LLM indisponivel =>
`source:'RULES'`); tolerancia a falha; binding ausente => `SKIPPED`; gravacao de
`AgentRun(role+sector)`.
