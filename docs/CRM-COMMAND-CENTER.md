# CRM / Command Center — Operação Autônoma (COO)

> Feature de extensão do **Ebook Empire**. Documento de design reconciliado e
> autoritativo. Onde as propostas das áreas divergiram, as **Decisões finais**
> abaixo prevalecem. Toda implementação adere à STACK existente (pnpm monorepo,
> Node 20, TS ESM; Fastify 4 + Prisma 6 + Postgres + Zod na API; Next.js 14 App
> Router + Tailwind + TanStack Query no web) e à **política TIERED + KILL SWITCH**.

---

## 0. Estado implementado (verificado) — leia primeiro

> Esta seção reflete o que **de fato** roda no repositório, verificado contra o
> Postgres real em `localhost:5433` (`USE_STUBS=true`). As seções 1–13 abaixo são
> o **design**; onde a implementação divergiu, o que está aqui em §0 prevalece.

**Verificação:** `pnpm --filter @ebook-empire/api e2e:crm` → **PASSARAM: 40
FALHARAM: 0**. Unidade: agents **94** + api **15** testes verdes. `pnpm -r
typecheck` limpo nos 5 projetos.

**Funcional, provado ponta a ponta:**

- **7 setores** coletados por tick (`DbHealthCollector`, única camada que toca
  Prisma; `score*` puros) → 7 `SectorHealthSnapshot`. Status derivado on-read.
- **Diagnóstico** regras + LLM (`claude-opus-4-8`) com fallback no `catch`;
  cria/atualiza `Problem` (1 ativo por setor+type). Ex.: `DELIVERY_BACKLOG`,
  `NEGATIVE_ROAS`.
- **Ciclo autônomo LOW (requisito central — FUNCIONA)**: backlog DELIVERY →
  `RETRY_DELIVERIES` AUTO aplicada → backlog 0 + 6 grants → `Problem` **RESOLVED**
  no ciclo seguinte, com auditoria `beforeState`/`afterState`.
  > O bug de wiring (scheduler compunha o `GuardedActionExecutor` sem injetar as
  > levers, fazendo toda ação LOW virar FAILED) — chip `task_474caa2f` — **foi
  > corrigido**: o `scheduler.ts` agora faz
  > `new GuardedActionExecutor(createLiveLevers())`.
- **Fila HIGH via HTTP (fim-a-fim)**: HIGH no AUTO → bloqueada `NOT_APPROVED` →
  `QUEUED`; `POST /crm/actions/:id/approve` re-valida teto e chama
  `applyApprovedAction` → **APPLIED** (budget 5000→8000), resposta
  `200 {applied:true}`. `applyApprovedAction`/`rollbackAction` **estão expostos**
  pelo scheduler (o ciclo HTTP HIGH/rollback fecha de ponta a ponta).
- **Rollback**: `POST /crm/actions/:id/rollback` restaura o `beforeState`
  (8000→anterior), marca `ROLLED_BACK`, audita `ActionExecution(isRollback=true)`.
- **Guardrails + kill switch**: `POST /crm/killswitch` ON bloqueia tudo com
  auditoria `KILL_SWITCH`; `maxAutoActionsPerCycle`/cooldown/teto ativos;
  singleton fail-closed.
- **Scheduler**: loop FAST próprio em `FAST_TICK_MS` com guard `opsRunning`;
  `runOperationsCycle(app)` reusado por `POST /crm/scan`.

**Divergências da implementação vs. o design das §§9–10 (a implementação venceu):**

- Rollback é **`POST /crm/actions/:id/rollback`** (por `actionId`), não
  `/crm/executions/:id/rollback`.
- Atualização de guardrails é **`POST /crm/guardrails`**, não `PUT`.
- Existe **`GET /crm/health`** (ping do módulo).
- **Não** foram implementadas como rotas separadas: `GET /crm/sectors` (lista),
  `/crm/sectors/:sector/history`, `GET /crm/actions/:id`, `GET /crm/approvals`. Os
  dados equivalentes vêm de `/crm/overview`, `/crm/sectors/:sector` e
  `/crm/actions` (a fila HIGH é filtrável em `/crm/actions`).
- **Não** existe a página `app/crm/problems/[id]/page.tsx`; o detalhe vive em
  `app/crm/problems/page.tsx`. As 5 páginas reais são: `page.tsx`,
  `problems/page.tsx`, `actions/page.tsx`, `approvals/page.tsx`,
  `settings/page.tsx`.

**Pendências conhecidas (não bloqueiam o ciclo verificado):**

- Snapshots podem ser gravados **em dobro** por ciclo quando collector e
  operations-agent ambos persistem — consolidar a gravação em um ponto.
- Fluxo **100% autônomo HIGH para TRAFFIC/SALES** depende de `metadata`
  (`campaignId`/`productId`) que o diagnóstico nem sempre preenche — sem isso,
  propostas HIGH dependem de injeção. Enriquecer o diagnóstico.
- Retenção/downsample de `SectorHealthSnapshot` (~10k linhas/dia) — fora do escopo.
- `apps/web` sem testes automatizados (validado por `tsc --noEmit`); rodar
  `next build` em CI para a boundary de `Suspense`/`useSearchParams`.

---

## 1. Visão geral

O Command Center é o "centro de operações" da empresa autônoma. Um agente **COO
— `OperationsAgent`** roda no **`FAST_TICK_MS`** (default 60s, hoje declarado no
`env.ts` mas não usado) e executa, por tick, um pipeline de 5 passos:

```
FAST tick (a cada FAST_TICK_MS)
  0) RE-CHECK   reavalia Problems em REMEDIATING (snapshot-diff)  → RESOLVED/escala
  1) COLLECT    HealthCollector.collect(ctx)  → SectorHealth[7]   → 7 SectorHealthSnapshot
  2) DIAGNOSE   p/ setores com gatilho: DiagnosisEngine.diagnose  → upsert Problem
  3) PROPOSE    ActionCatalog.propose(problem,diagnosis)          → RemediationProposal[]
  4) APPLY      LOW  → ActionExecutor.apply(AUTO) (respeita guardrails)
                HIGH → cria RemediationAction QUEUED (fila de aprovação humana)
```

O **CEO (`OrchestratorAgent`)** continua no `SLOW_TICK_MS` (15 min) cuidando do
pipeline de negócio (Content → Sales → Social → Traffic → Delivery → Analytics).
O COO **não substitui** o CEO: observa a saúde dos 7 setores, diagnostica
regressões e aciona remediações usando os **mesmos agentes/adapters/DB** como
"alavancas". O COO nunca inventa caminho novo de mutação — reusa
`decideBudget`/`recommendBudget`, o ciclo de vida `AgentRun` e `ports.ads`.

### Princípios inegociáveis (herdados do projeto)

- **Dinheiro SEMPRE `Int` em centavos BRL.** Nunca `Float`/`Decimal`.
- **Strings de usuário em pt-BR.**
- **Timezone**: reusar `saoPauloDay` / `saoPauloDayBoundsUtc` (analytics.ts) e
  `dayBoundsSaoPaulo` (orchestrator.ts). NUNCA reimplementar offset.
- **LLM nunca é caminho único**: regras determinísticas primeiro, LLM
  (`claude-opus-4-8` via `AgentEnv.PLANNING_MODEL`) só para enriquecer; em
  `catch` cai no resultado determinístico. O negócio nunca trava por falta de
  `ANTHROPIC_API_KEY` (`USE_STUBS=true` por default).
- **DI por construtor**: `OperationsAgent` depende SOMENTE das 4 interfaces de
  `contracts.ts`; a composição concreta (`createOperationsAgent`) vive no
  `scheduler.ts`.

### Os 7 setores (≠ AgentName)

| Setor (OperationalSector) | AgentName (alavanca operacional) |
|---|---|
| CONTENT | CONTENT |
| SALES | SALES |
| DELIVERY | DELIVERY |
| SOCIAL | SOCIAL |
| TRAFFIC | TRAFFIC |
| ANALYTICS | ANALYTICS |
| ORCHESTRATION | ORCHESTRATOR |

`OPERATIONS` é **novo valor de `AgentName`** (o próprio COO loga seus runs com
`agent='OPERATIONS'`), mas **NÃO é um setor de saúde**. São 7 setores e 8
`AgentName`. Cuidado para não criar um 8º setor.

---

## 2. Modelo de saúde / score por setor (HealthCollector)

### 2.1 Decisões finais

- **Score** = soma ponderada de **subscores 0–100** (cada subscore é função
  **PURA**, sem Prisma, testável como `computeKpis`). Clamp final `0..100` com
  `Math.round`.
- **HealthStatus derivado, NUNCA persistido como coluna/enum.** O snapshot grava
  apenas `score Int` + `kpis Json`. Status (`HEALTHY`/`WARNING`/`CRITICAL`) é
  calculado on-read por `statusFromScore(score)` em `core/crm.ts`. Isso elimina
  estado redundante/inconsistente. (Reconcilia proposta 1, que cogitava cachear
  `status`, com a proposta 5 — vence a derivação pura.)
- **Cortes**: `HEALTHY >= 70`, `WARNING 40–69`, `CRITICAL < 40`. Constantes
  nomeadas `HEALTH_THRESHOLDS = { HEALTHY_MIN: 70, WARNING_MIN: 40 }` em
  `core/crm.ts` — fonte única para API + web + agents.
- **Política "sem sinal"** (`hasSignal=false`): quando o setor não tem volume
  para julgar (0 runs, 0 spend, 0 pedidos, 0 posts), o subscore correspondente
  retorna **`NEUTRAL_SUBSCORE = 60`** (WARNING-alto, nunca CRITICAL). O
  `DiagnosisEngine` **IGNORA** setores cujos subscores relevantes têm
  `hasSignal=false` — evita Problem falso em sistema ocioso recém-seedado.
- **Subscore operacional universal** `agentOpScore(counts)` (puro, compartilhado
  pelos 7 setores): `successRate = SUCCESS/(SUCCESS+FAILED)` mapeado linear
  0–100; `SKIPPED` ignorado (neutro); **penalidade fixa** se houver `AgentRun`
  `RUNNING` "stale" (idade > `2 × FAST_TICK_MS`) — trata lock órfão de `base.ts`
  como falha, não como sucesso.
- **Janela temporal dupla**: KPIs de negócio (receita/ROAS/conversão/entrega)
  usam a **janela do dia SP** (`saoPauloDay`+`saoPauloDayBoundsUtc`); KPIs
  operacionais (successRate de agentes, backlog) usam **janela curta**
  `OPS_WINDOW_MS` (default `60 * 60 * 1000`, derivável de `FAST_TICK_MS`).
- **ROAS→score** reusa os limiares de `DEFAULT_BUDGET_POLICY` (traffic.ts).
  Abaixo de `minSpendForDecisionCents` (warm-up), `roasSubscore` é NEUTRO, não
  CRITICAL — não diagnostica/pausa campanha recém-criada.
- **Cadência**: 1 ciclo por `FAST_TICK_MS`. Cada tick grava **7 linhas**
  `SectorHealthSnapshot` (`createMany`) com `capturedAt = clock.now()` e o
  `cycleId` do tick. Append-only (time-series, como `AdInsight`/`AgentRun`).
- **HealthCollector é a única camada que toca o Prisma**; o cálculo de score é
  puro. O collector agrega → monta `kpis` → chama `scoreSetorX(kpis)` puro →
  retorna `SectorHealth`.

### 2.2 Pesos e subscores por setor

Todos os pesos vivem em `SECTOR_WEIGHTS` (`core/crm.ts`). Heurísticas iniciais —
centralizadas para calibrar sem caça a literais.

| Setor | Subscores (peso) | `hasSignal=false` quando |
|---|---|---|
| **CONTENT** | `pipeline` 0.5 (≥1 PUBLISHED+produto ativo ⇒ alto; 0 publicados ⇒ CRITICAL, nada a vender) · `stuck` 0.2 (penaliza `GENERATING` travado por updatedAt) · `op` 0.3 | 0 ebooks de qualquer status |
| **SALES** | `conversion` 0.45 (PAID vs CHECKOUT_STARTED) · `catalogo` 0.25 (`produtosAtivos>0`) · `abandono` 0.3 (`1 - pendingRatio`) | 0 checkouts e 0 produtos |
| **DELIVERY** | `backlog` 0.6 (0 pendentes ⇒ 100; penalidade cresce com qtd e idade do PAID-sem-grant) · `op` 0.4 | nunca (0 backlog = saudável 100) |
| **SOCIAL** | `cadence` 0.45 (publicou no dia / sem agendado vencido) · `reliability` 0.35 (`1 - failRatio`) · `engagement` 0.2 (neutro 60 sem metrics) | 0 posts de qualquer status |
| **TRAFFIC** | `roas` 0.55 (cortes de `DEFAULT_BUDGET_POLICY`) · `budgetDiscipline` 0.2 (penaliza spend≥teto sem ROAS) · `activity` 0.25 (campanha ativa quando há catálogo) | `spendCents=0` (roas neutro) |
| **ANALYTICS** | `frescor` 0.5 (rodou hoje e recente) · `op` 0.3 · `dataIntegrity` 0.2 (sem gaps de insight) | sem runs ANALYTICS no dia |
| **ORCHESTRATION** | `heartbeat` 0.4 (loop recente) · `cycleSuccess` 0.35 · `childHealth` 0.25 (poucos filhos FAILED no último ciclo) | sem ciclos ORCHESTRATOR no dia |

### 2.3 KPIs gravados em `SectorHealthSnapshot.kpis` (Json plano)

Cada `kpis` carrega os números do setor **+ os subscores + `hasSignal` + os
gatilhos disparados** (ver §3.2). Exemplos por setor:

- **CONTENT**: `ebooksPublished`, `ebooksReady`, `ebooksGenerating`,
  `ebooksTravadosGenerating`, `publishedComProdutoAtivo`, `contentRunSuccessRate`.
- **SALES**: `produtosAtivos`, `pedidosCriadosDia`, `pedidosPagosDia`,
  `pendingRatio`, `aovCents`, `conversaoCheckout`.
- **DELIVERY**: `pedidosPagosNaoEntregues`, `backlogIdadeMaxMin`,
  `deliveryRunSuccessRate`, `grantsExpiredUnused`, `emailFalhasDia`.
- **SOCIAL**: `postsPublicadosDia`, `postsFailedDia`, `postsAgendadosVencidos`,
  `failRatio`, `engajamento`.
- **TRAFFIC**: `campanhasAtivas`, `spendCents`, `conversionsDia`, `roas`,
  `receitaAtribuidaDia`, `spendVsTeto`, `cpaCents`.
- **ANALYTICS**: `snapshotKpiDoDiaExiste`, `frescorUltimoRunMin`,
  `analyticsRunSuccessRate`, `dataGaps`.
- **ORCHESTRATION**: `ciclosNoDia`, `cycleSuccessRate`, `ultimoCicloIdadeMin`,
  `filhosFalhadosUltimoCiclo`, `planExecutadoVsPlanejado`.

### 2.4 API de cálculo (health-collector.ts)

```ts
// PURAS, exportadas (base dos testes do e2e.ts):
export function agentOpScore(c: { success: number; failed: number; skipped: number; maxRunningAgeMs: number }): number;
export function scoreContent(k): number;
export function scoreSales(k): number;
export function scoreDelivery(k): number;
export function scoreSocial(k): number;
export function scoreTraffic(k): number;       // reusa DEFAULT_BUDGET_POLICY
export function scoreAnalytics(k): number;
export function scoreOrchestration(k): number;

// classe (única que toca Prisma):
export class DbHealthCollector implements HealthCollector {
  async collect(ctx: AgentContext): Promise<SectorHealth[]> { /* 7 setores */ }
  // privados: collectContent/Sales/Delivery/Social/Traffic/Analytics/Orchestration(ctx, now)
}
```

Reusa de `../analytics.js`: `saoPauloDay`, `saoPauloDayBoundsUtc`, `computeKpis`.
De `../traffic.js`: `DEFAULT_BUDGET_POLICY`.

---

## 3. Motor de diagnóstico (DiagnosisEngine)

### 3.1 Arquitetura em duas camadas

`diagnose(ctx, sector, health)` roda:

1. **Regras determinísticas** (`runRules(signals)` puro) — rápidas, baratas,
   sempre produzem um `Diagnosis` válido por si só.
2. **Enriquecimento LLM** (`claude-opus-4-8`) — só refina `rootCause`,
   `confidence`, `evidence`. Espelha `orchestrator.buildPlan()`: `try`
   `ports.llm.generateJson` validando com `diagnosisSchema.parse`; `catch` ⇒
   usa o `Diagnosis` das regras como fallback. O custo do diagnose é
   contabilizado no `AgentRun` do `OperationsAgent` (`costCents`/`tokensIn/Out`).

A saída do opus é validada contra `z.enum` dos `ProblemType` e `ActionKind`
conhecidos; qualquer `type`/`kind` fora do enum cai no fallback determinístico.

### 3.2 Gatilhos de detecção (decididos no COO/collector, NÃO no diagnose)

`diagnose()` recebe o `health` com os gatilhos já anexados em `health.kpis` e não
recalcula a decisão de disparar. Três classes de gatilho:

1. **Threshold absoluto**: `CRITICAL` (score<40) dispara sempre; `WARNING`
   (40–69) dispara com cooldown maior.
2. **Queda relativa**: score caiu ≥ X pontos vs. o último `SectorHealthSnapshot`
   do mesmo setor (degradação mesmo acima de 70).
3. **Regras duras** (independem do score): `Order` PAID há >30min sem
   `DeliveryGrant`; `AgentRun` FAILED consecutivos ≥3; ROAS<1 com spend>0.

**Regra de ouro anti-falso-positivo**: setores com `hasSignal=false` nos
subscores relevantes **não** abrem Problem. Regras de volume mínimo
(`spendCents>0`, `conversions>=N`) espelham os null-guards de `computeKpis`.

### 3.3 Catálogo de ProblemType → suggestedActionKinds

| Setor | ProblemType | sugere ActionKind |
|---|---|---|
| DELIVERY | `DELIVERY_BACKLOG`, `DELIVERY_FAILURES`, `EMAIL_PROVIDER_DOWN` | `RETRY_DELIVERIES`, `RERUN_AGENT` |
| SALES | `LOW_CONVERSION`, `PRICE_TOO_HIGH`, `CHECKOUT_DROPOFF` | `REGENERATE_LANDING_COPY`, `ADJUST_PRICE` |
| TRAFFIC | `NEGATIVE_ROAS`, `CAC_ABOVE_AOV`, `BUDGET_EXHAUSTED`, `NO_ACTIVE_CAMPAIGNS` | `DECREASE_AD_BUDGET`, `PAUSE_CAMPAIGN`, `INCREASE_AD_BUDGET` |
| CONTENT | `EMPTY_CATALOG`, `STALE_CATALOG`, `EBOOK_GENERATION_FAILING` | `GENERATE_EBOOK`, `RERUN_AGENT` |
| SOCIAL | `NO_RECENT_POSTS`, `SOCIAL_PUBLISH_FAILURES`, `LOW_ENGAGEMENT` | `GENERATE_SOCIAL_POSTS`, `RERUN_AGENT` |
| ANALYTICS | `KPI_STALE`, `INSIGHTS_NOT_INGESTED` | `RECOMPUTE_KPIS`, `RERUN_AGENT` |
| ORCHESTRATION | `AGENT_REPEATEDLY_FAILING`, `CYCLE_NOT_RUNNING`, `REVENUE_BELOW_TARGET` | `RERUN_AGENT`, `RECOMPUTE_KPIS` |

`Problem.type` é **`String`** (código da regra), validado contra `z.enum` em
`core/crm.ts`. Mantido `String` no Prisma (não enum) para permitir novos tipos
sem migração — a validação tipada vive no engine/schema.

### 3.4 Sinais de evidência para o LLM

Fronteira com o `health-collector.ts`: `health.kpis` carrega os **KPIs
numéricos**; o engine coleta apenas os **sinais de evidência** que o collector
não precisa — os últimos N (=10) `AgentRun` do(s) agente(s) do domínio
(`status`, `error`, `durationMs`, `metrics`, `startedAt`), reusando
`@@index([agent, startedAt])`. Função pura `collectSignals(ctx, sector)`
agrega; `runRules(signals)` + `pickPrimary(hits)` são o núcleo testável.

### 3.5 Ciclo de vida do Problem

```
OPEN ──► DIAGNOSING ──► REMEDIATING ──► RESOLVED   (recuperação confirmada)
                                    └─► IGNORED     (cooldown/duplicata/supressão)
```

- **Idempotência**: no máximo **1 Problem ativo** (OPEN/DIAGNOSING/REMEDIATING)
  por **(sector, type)**. `diagnose()`/COO faz `findFirst` ativo por (sector,type)
  dentro de **transação com `SELECT … FOR UPDATE`** (Postgres não tem unique
  parcial declarativo simples); se existe, **atualiza** `rootCause`/`severity`/
  `status`; senão **cria** OPEN e move a DIAGNOSING. `detectedAt` no create;
  `resolvedAt` só no fechamento. `severity = 100 - score` no momento da detecção.
- **Verificação de remediação é assíncrona (snapshot-diff, não retorno do
  executor)**. O COO grava no Problem (em `metadata`/`snapshotId`) o score/status
  da detecção. No passo 0 do tick seguinte compara com o novo snapshot:
  - **RESOLVED** se `status` voltou a HEALTHY (score≥70) **E** `score atual ≥
    score_detecção + margem`, **sustentado por ≥1 ciclo** (configurável).
  - Se piorou/estagnou em REMEDIATING por > `maxRemediationTicks`: escala
    severidade e/ou propõe nova rodada (possivelmente ação HIGH → fila de
    aprovação).
- **Correlação ≠ causalidade**: só credita recuperação se a ação específica foi
  `APPLIED` (registrado em `ActionExecution`); mantém REMEDIATING ≥1 ciclo de
  confirmação.

### 3.6 Mitigação de custo do LLM

LLM só é chamado quando um gatilho realmente dispara (CRITICAL ou regra dura).
Cooldown de diagnóstico por (type,sector). Se nada mudou nos sinais, atualiza o
Problem existente sem re-perguntar ao opus.

---

## 4. Catálogo de ações + Executor (TIERED + Kill Switch)

### 4.1 Tier estático por kind (NUNCA vem do LLM)

`riskTier` é propriedade **estática** de cada kind no `ACTION_SPECS`
(`action-catalog.ts`) — evita que ação financeira escape para auto por bug de
heurística. O banco grava `riskTier` explicitamente em `RemediationAction` (para
override futuro), mas o catálogo é a fonte da verdade default.

### 4.2 Ações LOW (auto-aplicadas pelo executor)

| kind | params | alavanca | efeito (setor) | reversible | rollback |
|---|---|---|---|---|---|
| `RETRY_DELIVERIES` | `{orderIds?, limit?}` | `DeliveryAgent.execute(ctx)` | reentrega PAID travados (DELIVERY) | false | no-op (idempotente: `DeliveryGrant.orderId @unique`) |
| `GENERATE_EBOOK` | `{niche, count?=1}` | `ContentAgent.execute(ctx)` | reabastece catálogo (CONTENT) | false | opcional: `Ebook.status=ARCHIVED` |
| `GENERATE_SOCIAL_POSTS` | `{productId?, count?}` | `SocialAgent.execute(ctx)` | alcance orgânico (SOCIAL) | false | opcional: descartar DRAFT criados |
| `REGENERATE_LANDING_COPY` | `{productId}` | `ports.llm.generateText` → `Product.description` | sobe conversão (SALES) | **true** | restaura `Product.description` do beforeState |
| `RECOMPUTE_KPIS` | `{date?}` | `AnalyticsAgent.execute(ctx)` | recalcula KPIs stale (ANALYTICS) | false | no-op (idempotente) |
| `RERUN_AGENT` | `{agent: AgentName}` | `<Agent>.execute(ctx)` via registry | re-executa agente que falhou (qualquer setor) | false | no-op |

### 4.3 Ações HIGH (fila de aprovação humana)

| kind | params | alavanca | efeito (setor) | reversible | rollback / guardrail |
|---|---|---|---|---|---|
| `INCREASE_AD_BUDGET` | `{campaignId, newDailyBudgetCents}` | `ports.ads.updateBudget` (SET absoluto) + `AdCampaign.dailyBudgetCents` + Event `BUDGET_REALLOCATED` | escala campanha lucrativa (TRAFFIC) | **true** | re-SET do valor anterior. **Guardrail**: `newDailyBudgetCents <= teto` |
| `DECREASE_AD_BUDGET` | `{campaignId, newDailyBudgetCents}` | idem (SET menor) | corta queima ROAS<1 (TRAFFIC) | **true** | re-SET do valor anterior |
| `PAUSE_CAMPAIGN` | `{campaignId}` | `ports.ads.setStatus('PAUSED')` + `AdCampaign.status` | estanca prejuízo (TRAFFIC) | **true** | re-`setStatus(beforeState.status)` |
| `ADJUST_PRICE` | `{productId, newPriceCents}` | `Product.priceCents` (**NUNCA** `Order.priceCents`) | otimiza margem/conversão (SALES) | **true** | restaura `Product.priceCents`. **Guardrail**: `newPriceCents>0` e `>=1000c` |

> **Invariante contábil**: `Order.priceCents` é SNAPSHOT histórico (schema l.197)
> e NUNCA é reescrito. O executor recusa qualquer `params` que aponte para
> `Order`.

### 4.4 Reversibilidade

Mutações de **SET absoluto** (budget via `ports.ads.updateBudget` — confirmado
SET, ports.ts l.209 + `TrafficAgent.applyDecision`; status; `Product.priceCents`)
fazem rollback re-aplicando o `beforeState`. Geradoras de conteúdo
(`GENERATE_*`, `REGENERATE_LANDING_COPY` cria, não muta escalar irreversível) e
read-mostly (`RECOMPUTE_KPIS`, `RERUN_AGENT`) são `reversible=false`.
`REGENERATE_LANDING_COPY` é a exceção LOW reversível (campo escalar
`Product.description`).

> **Invariante documentada no executor**: o rollback de budget depende de
> `updateBudget` ser SET ABSOLUTO. Se algum dia virar incremento, o rollback por
> re-set fica errado.

---

## 5. Guardrails, kill switch e fila de aprovação

### 5.1 Pipeline do executor (`apply(ctx, action)`) — curto-circuito em ordem

```
1) loadGuardrailConfig(prisma)           // singleton; se AUSENTE → falha FECHADO
                                          //   (killSwitch=true / maxAuto=0)
2) KILL SWITCH global    → bloqueia TUDO (inclusive HIGH já APPROVED)  [KILL_SWITCH]
3) HIGH && status!=APPROVED → bloqueia    [NOT_APPROVED]
4) cooldown por (kind,sector)             [COOLDOWN]
5) teto financeiro (INCREASE_AD_BUDGET)   [BUDGET_CAP]  // clamp/recusa se > teto
6) captureBefore → mutate(lever) → captureAfter → persist ActionExecution
   → update RemediationAction.status (APPLIED|FAILED)
```

### 5.2 Guardrails

- **Kill switch GLOBAL** (`GuardrailConfig.killSwitch`): quando `true`, NENHUMA
  ação auto é aplicada — **e HIGH já aprovadas TAMBÉM ficam bloqueadas** (o
  humano pode ter aprovado antes do incidente). Decisão de design confirmada;
  reversível pela rota de approve quando o kill switch voltar a `false`.
- **`maxAutoActionsPerCycle`**: o COO conta quantas **LOW** aplicou no tick e
  para ao atingir o teto. **HIGH não conta** (não aplica sozinha). **Bloqueios
  por guardrail (cooldown/budget) NÃO incrementam o contador** — setor barrado
  não consome cota de outro.
- **Cooldown por (kind, sector)** (`cooldownMinutes`): se houve `APPLIED` do
  mesmo (kind,sector) há < `cooldownMinutes`, a proposta é suprimida. Evita loop
  e a **oscilação Traffic(SLOW) vs Executor(FAST)** no mesmo dia. O COO também
  emite Event `BUDGET_REALLOCATED` (igual ao Traffic) para a janela de decisão do
  Traffic enxergar.
- **Teto financeiro**: `MAX_AD_BUDGET_BRL * 100` (default 30000c = R$300/dia),
  com override opcional `GuardrailConfig.maxAdBudgetCents`. Validado em **tripla
  camada**: catálogo, executor e rota `/approve` — um approve stale tardio não
  burla o teto.
- **Singleton fail-closed**: `GuardrailConfig` (id `'singleton'`) é criado por
  seed/`getOrCreate`. Se ausente, o executor trata como `killSwitch=true` /
  `maxAuto=0` — nunca aplica sem guardrails carregados.

### 5.3 Auditoria + rollback

- **Toda** chamada a `apply()`/`rollback()` cria **uma** linha `ActionExecution`
  (mesmo em falha ou bloqueio por guardrail), com `triggeredBy = AUTO` (tick) ou
  `HUMAN` (rota). `beforeState` capturado ANTES de qualquer mutação; `afterState`
  DEPOIS (ou = beforeState em falha). `isRollback=true` nas reversões.
- `rollback()` só existe quando `RemediationAction.reversible=true` e status
  `APPLIED`; cria nova `ActionExecution(isRollback=true)`, seta
  `RemediationAction.status=ROLLED_BACK`. Best-effort + auditado (se houve
  mudança externa entre apply e rollback, restaura o `beforeState` lido no apply
  e registra; nunca silencioso).

### 5.4 Fluxo de aprovação (HIGH)

```
PROPOSED ─(HIGH)─► QUEUED ─approve─► APPROVED ─executor─► APPLIED | FAILED
                       └─reject──► REJECTED
APPLIED ─rollback─► ROLLED_BACK     (só reversible)
```

- LOW: `PROPOSED → APPLIED|FAILED` direto pelo executor AUTO.
- `apply()` só aceita estado APPLY-ável: **LOW em PROPOSED** OU **HIGH em
  APPROVED**. HIGH em PROPOSED/QUEUED retorna
  `{success:false, blockedByGuardrail:'NOT_APPROVED'}` sem tocar no sistema.
- **Concorrência executor AUTO × approve HUMAN**: a transição usa
  `update … WHERE status = QUEUED|APPROVED` (lock otimista). Se a linha já mudou,
  a segunda escrita não afeta nada → retorna 409. `ActionExecution.startedAt`
  marca posse.

---

## 6. Reentrância (FAST × SLOW)

O scheduler hoje tem **um** flag `cycleRunning` para o CEO (SLOW). O COO precisa
de **guard próprio `opsRunning`** (dono: módulo do `OperationsAgent` no
`scheduler.ts`) para não sobrepor ticks FAST nem furar `maxAutoActionsPerCycle`/
cooldown por sobreposição. Ambos os loops são `setInterval` no processo Fastify
(sem worker separado), com `unref()` e limpeza no `onClose`.

---

## 7. Contratos de interface (`packages/agents/src/crm/contracts.ts`)

Dono: **Fundação**. Todos implementam contra ele; DI por construtor.

```ts
import type { AgentContext } from '../base.js';
import type { Json } from '@ebook-empire/core';

export type Sector =
  | 'CONTENT' | 'SALES' | 'DELIVERY' | 'SOCIAL'
  | 'TRAFFIC' | 'ANALYTICS' | 'ORCHESTRATION';

export type HealthStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL';
export type RiskTier = 'LOW' | 'HIGH';

export type ActionKind =
  | 'RETRY_DELIVERIES' | 'GENERATE_EBOOK' | 'GENERATE_SOCIAL_POSTS'
  | 'REGENERATE_LANDING_COPY' | 'RECOMPUTE_KPIS' | 'RERUN_AGENT'
  | 'INCREASE_AD_BUDGET' | 'DECREASE_AD_BUDGET' | 'PAUSE_CAMPAIGN' | 'ADJUST_PRICE';

export interface SectorHealth {
  sector: Sector;
  score: number;          // 0-100
  status: HealthStatus;   // derivado de score (statusFromScore)
  kpis: Json;             // KPIs + subscores + hasSignal + gatilhos
}

export interface Diagnosis {
  sector: Sector;
  type: string;           // ProblemType (validado por z.enum em core/crm.ts)
  severity: number;       // 0-100 (= 100 - score na detecção)
  status: 'OPEN' | 'DIAGNOSING' | 'REMEDIATING';
  rootCause: string;      // pt-BR
  confidence: number;     // 0-1
  evidence: string[];
  suggestedActionKinds: ActionKind[];
  source: 'RULES' | 'LLM';
}

export interface RemediationProposal {
  kind: ActionKind;
  riskTier: RiskTier;     // estático do catálogo, NUNCA do LLM
  sector: Sector;
  params: Json;
  expectedEffect: string;
  reversible: boolean;
}

export interface ExecutionResult {
  success: boolean;
  beforeState: Json;
  afterState: Json;
  error?: string;
  blockedByGuardrail?: 'KILL_SWITCH' | 'MAX_AUTO' | 'COOLDOWN' | 'BUDGET_CAP' | 'NOT_APPROVED';
}

export interface HealthCollector {
  collect(ctx: AgentContext): Promise<SectorHealth[]>;   // os 7 setores
}
export interface DiagnosisEngine {
  diagnose(ctx: AgentContext, sector: Sector, health: SectorHealth): Promise<Diagnosis>;
}
export interface ActionCatalog {
  propose(ctx: AgentContext, problem: ProblemRef, diagnosis: Diagnosis): RemediationProposal[];
}
export interface ActionExecutor {
  apply(ctx: AgentContext, action: RemediationActionRef): Promise<ExecutionResult>;
  rollback(ctx: AgentContext, execution: ActionExecutionRef): Promise<ExecutionResult>;
}
```

`OperationsAgent` (operations-agent.ts) recebe as **4 instâncias por
construtor**; a factory `createOperationsAgent(...)` vive no `scheduler.ts` e é
disparada também por `POST /crm/scan`.

---

## 8. Modelo de dados (Prisma) — dono: Fundação

Aditivo, sem quebrar modelos atuais. Enums novos + 5 modelos + `OPERATIONS` no
`AgentName`.

### 8.1 Enums novos

```prisma
enum OperationalSector { CONTENT SALES DELIVERY SOCIAL TRAFFIC ANALYTICS ORCHESTRATION }
enum ProblemStatus     { OPEN DIAGNOSING REMEDIATING RESOLVED IGNORED }
enum RiskTier          { LOW HIGH }
enum ActionKind {
  RETRY_DELIVERIES GENERATE_EBOOK GENERATE_SOCIAL_POSTS
  REGENERATE_LANDING_COPY RECOMPUTE_KPIS RERUN_AGENT
  INCREASE_AD_BUDGET DECREASE_AD_BUDGET PAUSE_CAMPAIGN ADJUST_PRICE
}
enum ActionStatus      { PROPOSED QUEUED APPROVED REJECTED APPLIED FAILED ROLLED_BACK }
enum ExecutionTrigger  { AUTO HUMAN }

// editar enum existente:
enum AgentName { ORCHESTRATOR CONTENT SALES DELIVERY SOCIAL TRAFFIC ANALYTICS OPERATIONS }
```

> **HealthStatus NÃO é enum Prisma** — derivado de `score` on-read.
> `Problem.type` é `String` (não enum) para extensibilidade; validado por Zod.

### 8.2 Modelos

```prisma
model SectorHealthSnapshot {
  id         String            @id @default(cuid())
  sector     OperationalSector
  score      Int                                 // 0-100; status derivado on-read
  kpis       Json
  capturedAt DateTime          @default(now())
  cycleId    String?                             // tick FAST que o gerou
  createdAt  DateTime          @default(now())

  problems   Problem[]         @relation("ProblemSnapshot")

  @@index([sector, capturedAt])                  // tendência / snapshot-diff
  @@index([cycleId])
}
// DECISÃO: NÃO usar @@unique([sector, capturedAt]). capturedAt=clock.now() do
// tick + cycleId já evitam duplicata; a unique colidiria com /crm/scan manual no
// mesmo segundo do tick. Idempotência do snapshot vem do guard opsRunning/cycleId.

model Problem {
  id          String        @id @default(cuid())
  sector      OperationalSector
  type        String                              // código da regra (z.enum em core)
  severity    Int                                 // 0-100 (= 100 - score na detecção)
  status      ProblemStatus @default(OPEN)
  rootCause   String?       @db.Text              // DiagnosisEngine (regras/LLM)
  snapshotId  String?                             // snapshot que disparou
  detectedAt  DateTime      @default(now())
  resolvedAt  DateTime?
  metadata    Json?                               // score/status de detecção p/ snapshot-diff
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  healthSnapshot SectorHealthSnapshot? @relation("ProblemSnapshot", fields: [snapshotId], references: [id])
  actions        RemediationAction[]

  @@index([sector, status])                       // + guard transacional (1 ativo/setor,type)
  @@index([status, detectedAt])
}

model RemediationAction {
  id            String       @id @default(cuid())
  problemId     String
  kind          ActionKind
  riskTier      RiskTier
  params        Json
  expectedEffect String      @db.Text
  status        ActionStatus @default(PROPOSED)
  reversible    Boolean      @default(false)
  dedupeKey     String       @unique              // hash(problemId+kind+paramsCanonicos)
  appliedAt     DateTime?
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt

  problem    Problem          @relation(fields: [problemId], references: [id], onDelete: Cascade)
  executions ActionExecution[]

  @@index([status, riskTier])
  @@index([problemId])
}

model ActionExecution {
  id          String           @id @default(cuid())
  actionId    String
  success     Boolean
  beforeState Json?
  afterState  Json?
  error       String?          @db.Text
  triggeredBy ExecutionTrigger
  isRollback  Boolean          @default(false)
  startedAt   DateTime         @default(now())
  finishedAt  DateTime?
  createdAt   DateTime         @default(now())

  action RemediationAction @relation(fields: [actionId], references: [id], onDelete: Cascade)

  @@index([actionId, startedAt])
  @@index([triggeredBy])
}

model GuardrailConfig {
  id                    String   @id @default("singleton")
  killSwitch            Boolean  @default(false)
  maxAutoActionsPerCycle Int     @default(5)
  cooldownMinutes       Int      @default(30)
  maxAdBudgetCents      Int?                       // override de MAX_AD_BUDGET_BRL*100
  updatedAt             DateTime @updatedAt
}
```

### 8.3 Idempotência (3 camadas)

1. **Snapshot**: `cycleId` + guard `opsRunning` (sem `@@unique` — ver acima).
2. **RemediationAction**: `dedupeKey @unique` = hash de
   `problemId + kind + paramsCanônicos`. Canonicalização **determinística**
   (ordenar chaves, arredondar centavos) vive em `core/crm.ts`
   (`canonicalizeParams`) — params com ordem instável NÃO geram dedupeKeys
   divergentes.
3. **Rotas POST financeiras** (`approve`, `scan`): header opcional
   `Idempotency-Key` reaproveitado como lock/dedupe.

### 8.4 Migração do enum AgentName (risco operacional)

`ALTER TYPE "AgentName" ADD VALUE 'OPERATIONS'` **não roda dentro de transação**
em Postgres em algumas versões. A Fundação adiciona o valor em **migration
separada** (sem bloco de transação) para não falhar; os 5 modelos + demais enums
vão em outra migration.

### 8.5 Volume / retenção

7 linhas / 60s ≈ **10k linhas/dia** em `SectorHealthSnapshot`. `@@index([sector,
capturedAt])` cobre as consultas. Retenção/agregação (downsample) fica fora deste
escopo — sinalizado para a Fundação.

---

## 9. Contrato de API REST `/crm` (`apps/api/src/routes/crm.ts`)

Plugin Fastify (`export default async (fastify) => {}`), registrado pela Fundação
em `server.ts` (que cria um **stub** de `crm.ts` só para compilar). Money sempre
`Int` centavos; mensagens pt-BR. Rotas de escrita usam `app.authenticate`
(Bearer JWT). `Idempotency-Key` opcional nas POST financeiras.

> **NOTA (implementação real):** a tabela abaixo era o design. As rotas que de
> fato existem estão listadas em **§0** — em especial: rollback é
> `POST /crm/actions/:id/rollback`, guardrails é `POST /crm/guardrails` (não PUT),
> e `GET /crm/sectors`/`/crm/sectors/:sector/history`/`GET /crm/actions/:id`/
> `GET /crm/approvals` não viraram rotas separadas. Onde divergir, vale §0.

| Método | Rota | Descrição |
|---|---|---|
| GET | `/crm/overview` | `{ generatedAt, sectors: SectorHealthView[], openProblems, queuedActions, killSwitch, guardrails, dayKpi }` (reusa `computeDailyKpi`) |
| GET | `/crm/sectors` | `ListResult<SectorHealthView>` — último snapshot por setor |
| GET | `/crm/sectors/:sector` | setor + `history: SectorHealthSnapshot[]` (`?limit&since`) + `openProblem?` |
| GET | `/crm/sectors/:sector/history?limit=30` | série temporal para sparkline |
| GET | `/crm/problems?status&sector&limit&offset` | `ListResult<Problem>` (feed; actions resumidas) |
| GET | `/crm/problems/:id` | `Problem & { diagnosis, actions: RemediationAction[], executions: ActionExecution[] }` |
| GET | `/crm/actions?status&riskTier&problemId&limit&offset` | `ListResult<RemediationAction & { execution? }>` (timeline) |
| GET | `/crm/actions/:id` | ação + histórico de executions |
| GET | `/crm/approvals` | `ListResult<RemediationAction>` filtrado `riskTier=HIGH, status=QUEUED` |
| POST | `/crm/actions/:id/approve` | QUEUED→APPROVED, chama `ActionExecutor.apply` (HUMAN); valida killSwitch+teto; retorna `{action, execution}`. Lock otimista (409 se já saiu de QUEUED) |
| POST | `/crm/actions/:id/reject` | body `{reason?}` → REJECTED. Idempotente (rejeitar já-rejeitada = 200 no-op) |
| POST | `/crm/executions/:id/rollback` | exige `reversible && status=APPLIED`; `ActionExecutor.rollback` (HUMAN); 409 se não reversível |
| GET | `/crm/guardrails` | `GuardrailConfig` (getOrCreate singleton) |
| PUT | `/crm/guardrails` | body parcial `{maxAutoActionsPerCycle?, cooldownMinutes?, maxAdBudgetCents?}` (Zod) → upsert |
| POST | `/crm/killswitch` | body `{enabled:boolean}` → liga/desliga global. Idempotente |
| POST | `/crm/scan` | body `{sector?}` → dispara `HealthCollector.collect` + diagnose (setores abaixo do threshold) + propose, via `createOperationsAgent`. Retorna `{scanned, newProblems, proposedActions, autoApplied}` |
| GET | `/agents/kpi` | **reuso** — `KPISnapshot` na barra de meta do overview |

Schemas de validação (Zod) novos em `packages/core/src/crm.ts` (dono Fundação):
`sectorSchema`, `healthStatusSchema`, `sectorHealthSchema`, `diagnosisSchema`,
`problemTypeSchema` (`z.enum`), `actionKindSchema`, `riskTierSchema`,
`remediationParamsSchema` (discriminated union por kind, ex.
`INCREASE_AD_BUDGET ⇒ {campaignId, newDailyBudgetCents: int <= teto}`;
`ADJUST_PRICE ⇒ {productId, newPriceCents: int}`), `guardrailConfigSchema`,
`canonicalizeParams`, `statusFromScore`, `HEALTH_THRESHOLDS`, `SECTOR_WEIGHTS`,
`NEUTRAL_SUBSCORE`. Exportados pelo barrel `core/src/index.ts`.

---

## 10. UI / Frontend — área `/crm` (Next.js 14 App Router)

Reusa 100% o padrão do dashboard: dark `neutral-800/900` + `brand`, `'use
client'` + TanStack Query com `refetchInterval`, mapas `Record<Status,string>`
no estilo `STATUS_STYLES`, `formatBRL`/`formatDateTime`, e **degradação graciosa
via `ApiError.status === 404`** (rota CRM ainda não implementada ⇒ card "ainda
não implementada", nunca crash).

### 10.1 Navegação e rotas

- `apps/web/app/layout.tsx` (dono do módulo web): adicionar
  `{ href: '/crm', label: 'Command Center' }` ao `NAV_ITEMS`.
- Subnav interna (tabs) dentro de `/crm`: Overview / Problemas / Ações /
  Aprovações / Guardrails.

| Rota | Conteúdo | refetch |
|---|---|---|
| `app/crm/page.tsx` | **Overview**: grid de 7 cards de setor (score 0-100, cor por status, sparkline SVG inline da tendência, top problema, contagem de ações pendentes) + banner kill switch + KPI bar (`api.kpis()`) | 15s |
| `app/crm/problems/page.tsx` | feed de Problems (filtros status/sector) | 15s |
| `app/crm/problems/[id]/page.tsx` | detalhe: diagnóstico + ações propostas/aplicadas + executions (before/after Json colapsável) | 20s |
| `app/crm/actions/page.tsx` | timeline global de RemediationAction + ActionExecution | 20s |
| `app/crm/approvals/page.tsx` | fila HIGH (QUEUED) com Aprovar/Rejeitar (mutations otimistas) | 10s |
| `app/crm/settings/page.tsx` | GuardrailConfig (kill switch, maxAuto, cooldown) | sem polling |

### 10.2 Cliente tipado

`api.crm.*` adicionado ao `lib/api.ts` (dono web), com tipos CRM replicados no
topo (como `EbookStatus` etc.): `listSectorHealth`, `getSectorHistory`,
`listProblems`, `getProblem`, `listActions`, `listApprovals`, `approveAction`,
`rejectAction`, `rollbackExecution`, `getGuardrails`, `updateGuardrails`,
`setKillSwitch`, `scan`.

### 10.3 Mapas de cor (cobrir TODOS os enums; fallback `neutral-700`)

- `SECTOR_STATUS_STYLES`: HEALTHY `emerald` / WARNING `amber` / CRITICAL `red`.
- `PROBLEM_STATUS_STYLES`: OPEN/DIAGNOSING/REMEDIATING/RESOLVED/IGNORED.
- `ACTION_STATUS_STYLES`: PROPOSED/QUEUED/APPROVED/REJECTED/APPLIED/FAILED/ROLLED_BACK.
- `RISK_STYLES`: LOW `emerald-soft` / HIGH `amber-strong`.

### 10.4 Estados e riscos de UI (cobrir explicitamente)

- loading · erro de rede (status 0) · rota ausente (404) · vazio · kill switch
  ativo (banner vermelho fixo em todas as `/crm`: "AUTONOMIA PAUSADA — nenhuma
  ação automática será aplicada", link para settings) · mutation pending/otimista
  · mutation error.
- **Corrida AUTO × HUMAN**: ação pode sair de QUEUED entre fetch e clique →
  tratar 409 e `invalidateQueries(['crm','approvals'])` no `onSettled`.
- **Json arbitrário** (`params`, `before/afterState`): pretty-print colapsável,
  sem assumir shape; `formatBRL` **só** em campos de centavos
  (`*BudgetCents`/`*PriceCents`), não cegamente.
- **Confirmação destrutiva**: toggle do kill switch e Rollback exigem confirmação
  (dialog/duplo clique).
- **Sparkline**: se history vier vazio ou com 1 ponto, esconder (sem artefato);
  SVG inline, sem nova dependência de chart.

---

## 11. Convenção de arquivos (escrita disjunta — um dono por arquivo)

**Novos**
- `packages/agents/src/crm/contracts.ts` *(Fundação)*
- `packages/agents/src/crm/{health-collector,diagnosis,action-catalog,executor,operations-agent,index}.ts`
- `packages/core/src/crm.ts` *(Fundação)*
- `apps/api/src/routes/crm.ts`
- `apps/web/app/crm/{page,problems/page,problems/[id]/page,actions/page,approvals/page,settings/page}.tsx`

**Editados por dono único**
- `prisma/schema.prisma` *(Fundação: 5 modelos + enums + OPERATIONS + 2 migrations)*
- `packages/core/src/{index.ts, schemas.ts}` *(Fundação: + `OPERATIONS` em `agentNameSchema`; reexport de `crm.ts`)*
- `apps/api/src/server.ts` *(Fundação: registra `crmRoutes`; cria stub de `crm.ts`)*
- `apps/api/src/scheduler.ts` *(dono do OperationsAgent: `createOperationsAgent` + tick FAST + guard `opsRunning`)*
- `packages/agents/src/index.ts` *(barrel: export do `./crm/index.js`)*
- `apps/web/app/layout.tsx` + `apps/web/lib/api.ts` *(dono web: nav + `api.crm.*`)*

---

## 12. Testes (padrão `apps/api/scripts/e2e.ts` + vitest)

- **Puros (vitest)**: `agentOpScore`, `scoreSetorX`, `statusFromScore`,
  `runRules`/`pickPrimary` (DiagnosisEngine), `canonicalizeParams`,
  `remediationParamsSchema`, e a máquina de estados do executor com `LLMPort`
  stub determinístico (sem `ANTHROPIC_API_KEY`).
- **E2E (Postgres real, `USE_STUBS=true`)**: seed → `OperationsAgent` tick →
  verifica 7 `SectorHealthSnapshot`; força backlog DELIVERY (Order PAID sem
  grant) → `DELIVERY_BACKLOG` Problem → `RETRY_DELIVERIES` AUTO aplicada →
  Problem RESOLVED no tick seguinte; cria proposta HIGH → fica QUEUED →
  `/approve` → APPLIED; `rollback` de `INCREASE_AD_BUDGET` re-SETa budget
  anterior; kill switch ON bloqueia tudo (inclusive HIGH aprovada).

---

## 13. Resumo das decisões finais (onde as áreas divergiram)

1. **HealthStatus**: derivado de `score`, NUNCA persistido (nem em snapshot, nem
   cacheado em Problem). `statusFromScore` em `core/crm.ts`.
2. **Snapshot sem `@@unique`**: usa `cycleId` + guard `opsRunning`; só
   `@@index([sector, capturedAt])`. Evita colisão com `/crm/scan` manual.
3. **`Problem.type` = `String`** (não enum Prisma), validado por `z.enum` —
   extensível sem migração.
4. **`PLANNING_MODEL`** vem de `AgentEnv.PLANNING_MODEL` (const em `env.ts`,
   `'claude-opus-4-8'`), não de variável de ambiente.
5. **`riskTier` estático** no `ACTION_SPECS`; gravado em RemediationAction só
   para override futuro. NUNCA do LLM.
6. **Kill switch bloqueia HIGH já aprovadas** enquanto ligado (fail-safe).
7. **Singleton fail-closed**: `GuardrailConfig` ausente ⇒ trata como
   `killSwitch=true`.
8. **Reentrância**: guard `opsRunning` separado do `cycleRunning` do CEO.
9. **Migração enum AgentName** em migration própria sem transação.
10. **`maxAutoActionsPerCycle`** conta só LOW aplicadas; bloqueios por guardrail
    não incrementam.
11. **Fronteira collector/engine**: `health.kpis` carrega KPIs numéricos; o
    engine coleta só sinais de evidência (`AgentRun.error` recentes) p/ o LLM.
