# Setor EBOOK_QA — Auditoria de Ebooks + Loop de Correcao + Pipeline de Lancamento

> Feature de extensao do **Ebook Empire**. **Documento alinhado ao codigo
> implementado.** Adere a STACK existente (pnpm monorepo, Node 20, TS ESM; Fastify 4
> + Prisma 6 + Postgres@5433 + Zod na API; Next.js 14 no web). Dinheiro **SEMPRE Int
> centavos BRL**; scores de QA sao **0..100, NAO centavos**. Strings em **pt-BR**.

Documentos irmaos: `docs/SECTORS-TEAMS.md` (framework de papeis) e
`docs/MARKET-RESEARCH.md` (GATE 1).

Cobre dois assuntos acoplados:
- **Parte A — Setor EBOOK_QA**: auditoria detalhada + loop corrigir->reauditar->relançar.
- **Parte B — Pipeline `createAndLaunchEbook`**: harmoniza MARKET_RESEARCH ->
  CONTENT -> EBOOK_QA com os **2 GATES**.

---

# PARTE A — Setor EBOOK_QA

## A.0 Resumo executivo

QA analisa o ebook em **4 eixos** e produz um `EbookAudit` (`score 0-100`,
`issues[]`, `verdict PASS|NEEDS_FIX|FAIL`, `recommendations`, `dimensionScores`).
Classes reais do time:

| Papel | Classe (real) | Arquivo | Saida |
|---|---|---|---|
| Especialista | **`EbookAuditor`** | `auditor.ts` | `{ audit: EbookAudit; tokensIn; tokensOut; costCents }` |
| Estrategista | **`FixStrategist`** | `fix-strategist.ts` | `FixPlan` (deterministico, sem LLM) |
| Executor | **`RelaunchExecutor`** | `relaunch-executor.ts` | `RelaunchResult` (aplica fix via LLMPort, muta o Ebook existente) |

**GATE 2 (obrigatorio):** um ebook so e LANCADO (status PUBLISHED + Product ativo)
apos `verdict === 'PASS'`. Existentes em `NEEDS_FIX` entram no loop bounded
(`QA_MAX_FIX_ITERATIONS`).

---

## A.1 Contrato QA (core — Fundacao)

```ts
type EbookAuditVerdict  = 'PASS' | 'NEEDS_FIX' | 'FAIL';
type EbookIssueSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKER';
type EbookIssueCategory = 'STRUCTURE' | 'CONTENT_QUALITY' | 'MARKET_FIT' | 'COMPLIANCE';

interface EbookIssue {
  category: EbookIssueCategory; severity: EbookIssueSeverity;
  chapterIndex?: number | null; title: string; detail: string; suggestion: string;
}
interface EbookAudit {
  ebookId: string; score: number; verdict: EbookAuditVerdict;
  issues: EbookIssue[]; recommendations: string[];
  dimensionScores: { structure: number; contentQuality: number; marketFit: number; compliance: number };
  marketOpportunityId?: string | null; iteration: number; model?: string; auditedAt: string;
}
// ebookAuditLlmSchema (Zod) valida a saida do LLM: { dimensionScores, issues,
// recommendations, verdictHint }. O score/verdict FINAIS sao recalculados no auditor.
```

Prisma `EbookAudit` (append-only): `score Int`, `verdict EbookAuditVerdict`,
`issues/recommendations/dimensionScores Json`, `marketOpportunityId?`,
`iteration Int @default(0)`, `agentRunId?`, `model?`, `auditedAt`. Indices em
`(ebookId, createdAt)` e `verdict`. Tambem (Fundacao): `EventType +=
EBOOK_AUDITED, EBOOK_RELAUNCHED`; `AgentName += EBOOK_QA, MARKET_RESEARCH`;
`Ebook.audits EbookAudit[]`.

Estado canonico: **`DRAFT`** = gerado/nao-lançado; **`PUBLISHED`** = lançado.

---

## A.2 `EbookAuditor` (Especialista)

`audit(ctx, ebook: AuditEbookInput, opts?: { iteration? })`:

1. **STRUCTURE deterministico** (puro, sem LLM): `analyzeStructure(markdown)` conta
   capitulos (`## `), palavras, capitulos curtos (< `MIN_CHAPTER_WORDS=120`),
   titulo `#`. `scoreStructure` penaliza: `< MIN_CHAPTERS=3` => issue **BLOCKER**;
   `< MIN_TOTAL_WORDS=800` => HIGH; capitulos rasos => MEDIUM; sem titulo => LOW.
2. **LLM (`CONTENT_MODEL` = `claude-sonnet-4-6`, temp 0.2)**: `generateJson` +
   `ebookAuditLlmSchema.parse` para `contentQuality`/`marketFit`/`compliance` +
   issues. LLM ausente/falho => **`rulesFallback`** (heuristicas a partir da
   estrutura).
3. **Fusao deterministica**: `structure` final = media `(2*det + llm)/3`; demais do
   LLM. Issues = estrutura + LLM deduplicadas. `score` = media ponderada
   (`DIMENSION_WEIGHTS`: contentQuality .40, structure .25, marketFit .20,
   compliance .15; sem oportunidade o peso de marketFit e redistribuido).
4. **`verdictFromScore(score, issues, ctx)`** (puro):
   ```
   issue BLOCKER OU score < QA_FAIL_SCORE  => FAIL
   score >= QA_MIN_SCORE e sem BLOCKER     => PASS
   senao                                   => NEEDS_FIX
   ```

`AuditEbookInput` = `{ id, title, niche, contentMarkdown, outline, marketOpportunity? }`.

---

## A.3 `FixStrategist` (Estrategista) + `RelaunchExecutor` (Executor)

**`FixStrategist.plan(audit): FixPlan`** — DETERMINISTICO (sem LLM). Agrupa issues
por categoria, soma pesos de severidade (`BLOCKER 40 / HIGH 25 / MEDIUM 12 / LOW 5`)
+ reforco do gap da dimensao, e gera 1 `FixAction` por categoria, ordenadas por
prioridade desc. `verdict === 'PASS'` ou sem issues => `{ noop: true }`.

```ts
type FixActionKind = 'REGENERATE_CHAPTERS' | 'REWRITE_SALES_COPY'
                   | 'REALIGN_MARKET_FIT' | 'FIX_COMPLIANCE';
interface FixPlan { ebookId: string; actions: FixAction[]; summary: string; noop: boolean; }
```

**`RelaunchExecutor.apply(ctx, ebook: AuditEbookInput, plan: FixPlan): RelaunchResult`**
— aplica cada acao reaproveitando o **LLMPort** (`generateText`, `CONTENT_MODEL`) e
**muta o Ebook EXISTENTE** (NAO instancia o ContentAgent). Persiste o markdown
corrigido e mantem o ebook em `DRAFT` (o relançamento e do service apos o PASS).

---

## A.4 `EbookQaService` (`service.ts` — dono EBOOK_QA)

```ts
class EbookQaService {
  constructor(opts?: { auditor?; strategist?; executor? });

  // Audita 1 ebook: persiste EbookAudit + AgentRun(role=SPECIALIST,sector=EBOOK_QA) + Event EBOOK_AUDITED.
  auditEbook(ctx, ebookId, opts?: { iteration? }): Promise<{ audit: EbookAudit; auditId: string; agentRunId: string }>;

  // Loop bounded: audita -> NEEDS_FIX corrige (FixStrategist+RelaunchExecutor) -> reaudita
  // ate PASS ou QA_MAX_FIX_ITERATIONS; FAIL interrompe. Ao PASS, relança (PUBLISHED + Event EBOOK_RELAUNCHED).
  runFixLoop(ctx, ebookId): Promise<FixLoopResult>;

  // Varre ebooks (PUBLISHED/DRAFT/READY com conteudo) sem auditoria recente (QA_AUDIT_STALE_HOURS); audita cada.
  auditExisting(ctx, opts?: { limit? }): Promise<AuditEbookResult[]>;

  // GATE 2 (fail-closed): le o ULTIMO EbookAudit; so PASS libera.
  canLaunch(ctx, ebookId): Promise<{ allowed: boolean; reason: string; lastVerdict: EbookAuditVerdict | null }>;
}
function createEbookQaService(opts?): EbookQaService;   // factory (mesmo padrao)
```

`FixLoopResult` = `{ ebookId, finalVerdict, iterations, audits[], passed, relaunched, summary }`.
`QA_MAX_FIX_ITERATIONS` default **2**; cada iteracao = 1 `EbookAudit` append-only
com `iteration` crescente.

> **Atencao (contrato real vs. pipeline):** `auditEbook` devolve **`{ audit, auditId,
> agentRunId }`** (NAO `EbookAudit` cru) e **nao existe** `applyFix`. O
> `launch-pipeline` espera uma `EbookQaCapability` com `auditEbook -> EbookAudit` +
> `applyFix`. Ver A.5 (defeito de integracao conhecido).

---

## A.5 GATE 2 e defeito de integracao conhecido

`canLaunch(ctx, ebookId)` e a **regra** (ultimo audit PASS, fail-closed). O **ato**
de publicar (`Ebook.status=PUBLISHED` + Product ativo) e do pipeline (Parte B).

> **DEFEITO CONHECIDO (a corrigir antes de B/C/D em producao):** o wiring default do
> pipeline (`resolveQaCapability`) usa o `EbookQaService` cru via uma ponte
> (`adaptQaService`) — mas o `auditEbook` do service devolve `{ audit }` (nao
> `EbookAudit`) e o service nao expoe `applyFix`. A ponte `adaptQaService` desempacota
> `{ audit }` e reconstroi `applyFix` via `FixStrategist`+`RelaunchExecutor`; **porem
> nenhum teste exercita o wiring default real** — os testes unitarios do pipeline e o
> `e2e-launch` INJETAM um `qa` fabricado (`qaCapabilityFrom`) que casa a interface. Ou
> seja: o pipeline gated funciona quando recebe uma capability conforme, mas o
> **caminho de producao atual (rota `/ebooks/generate` + Orchestrator/COO) pode nunca
> publicar** se a ponte divergir. Recomendacao: alinhar `EbookQaService`/
> `resolveQaCapability` e adicionar um teste do wiring default real.

---

## A.6 Rotas (`apps/api/src/routes/quality.ts`)

| Metodo | Rota | Uso |
|---|---|---|
| GET | `/quality/health` | count de auditorias |
| GET | `/quality/audits` | lista `EbookAudit` (`?verdict&ebookId&limit&offset`) |
| GET | `/quality/ebooks/:id/audit` | ultima auditoria + `gate` (canLaunch) |
| POST | `/quality/audit/:ebookId` **[JWT]** | audita 1 ebook (201 `{ auditId, agentRunId, audit }`) |
| POST | `/quality/fix/:ebookId` **[JWT]** | roda `runFixLoop` (200 `FixLoopResult`) |

> `lib/api.ts` (web) ainda nao expoe metodos `/quality`; a page `/crm/quality` faz
> fetch direto contra `API_BASE`.

---

## A.7 Envs (Fundacao)

```ts
QA_MIN_SCORE:          z.coerce.number().int().min(0).max(100).default(70),   // minimo p/ PASS
QA_MAX_FIX_ITERATIONS: z.coerce.number().int().min(0).default(2),             // teto do loop
QA_FAIL_SCORE:         z.coerce.number().int().min(0).default(40),            // abaixo => FAIL
QA_AUDIT_STALE_HOURS:  z.coerce.number().int().min(1).default(168),           // reauditoria periodica
```
> `QA_MIN_SCORE` real **= 70** (o default no codigo). Auditor usa `CONTENT_MODEL`;
> service le os `QA_*` via `ctx.env`.

---

# PARTE B — Pipeline `createAndLaunchEbook` (dono PIPELINE)

## B.0 Visao geral

Funcao orquestradora (NAO Agent) em `packages/agents/src/launch/launch-pipeline.ts`.
Recebe `AgentContext` + `deps` opcionais (DI) e impoe os **2 GATES**.

```ts
async function createAndLaunchEbook(
  ctx: AgentContext, opts?: LaunchOptions, deps?: Partial<LaunchDeps>,
): Promise<LaunchResult>;

interface LaunchOptions { niche?; title?; language?; maxFixIterations?; }
type LaunchStage = 'MARKET_GATE'|'CONTENT'|'QA'|'FIX_LOOP'|'QUALITY_GATE'|'PUBLISHED';
interface LaunchResult {
  launched: boolean; stage: LaunchStage; reason: string;
  opportunityId?; ebookId?; productId?; verdict?: EbookAuditVerdict; score?; fixIterations: number;
}
interface LaunchDeps {
  market:  { rankAndPick(ctx): Promise<MarketOpportunityRecord | null> };
  qa:      { auditEbook(ctx, ebookId, iteration?): Promise<EbookAudit>; applyFix?(ctx, ebookId, audit): Promise<void> };
  content: { generateDraft(ctx, input): Promise<{ ebookId: string | null; runId? }> };
  publish: (ctx, input) => Promise<{ productId: string | null }>;
}
```

## B.1 Fluxo (os 2 GATES)

1. **GATE 1 (mercado)** — `market.rankAndPick(ctx)`. `null` => para em `MARKET_GATE`,
   `launched:false`, **nenhum ebook criado**.
2. **CONTENT** — `content.generateDraft({ niche, title, language, marketOpportunityId })`
   gera o ebook em `DRAFT` vinculado (`publish:false`). Sem `ebookId` => para em `CONTENT`.
3. **QA** — `qa.auditEbook(ctx, ebookId, 0)`. Enquanto `verdict==='NEEDS_FIX'` e
   `fixIterations < maxIterations` (`opts.maxFixIterations ?? QA_MAX_FIX_ITERATIONS`):
   se houver `qa.applyFix`, corrige e reaudita; senao encerra o loop.
4. **GATE 2 (qualidade)** — `verdict !== 'PASS'` => para em `QUALITY_GATE`, ebook
   permanece `DRAFT`, `launched:false`. **PASS** => `publish(ctx, { ebookId,
   marketOpportunityId })` (PUBLISHED + Product ativo ancora R$47 = 4700 centavos +
   `Event EBOOK_PUBLISHED`) => `stage:'PUBLISHED'`, `launched:true`.

## B.2 Wiring default (resolucao defensiva por import dinamico)

`resolveLaunchDeps` (igual ao scheduler) resolve cada dependencia ausente com
fallback seguro que **falha o estagio** (nunca quebra o build):
- `resolveMarketCapability` — importa `MarketResearchService`/
  `createMarketResearchService` de `sectors/market-research/index.js`; ausente =>
  `rankAndPick` devolve `null` (GATE 1 aborta).
- `resolveQaCapability` — importa `EbookQaService`/`createEbookQaService` (+
  `FixStrategist`/`RelaunchExecutor`) e faz a ponte `adaptQaService`; ausente =>
  capability que devolve `FAIL` (GATE 2 reprova por seguranca — nunca publica). **Ver
  defeito conhecido em A.5.**
- `resolveContentCapability` — importa `ContentAgent` (`content.js`) em modo
  `publish:false`.
- `createDefaultPublish()` — publica + cria/reusa Product ativo (idempotente) +
  `Event EBOOK_PUBLISHED`.

> Modulos 2/3 DEVEM exportar exatamente esses nomes nos barrels para o wiring
> default funcionar. `createMarketDataAdapter` deve existir em
> `adapters/market-data.ts` (scheduler e rota o resolvem defensivamente).

## B.3 Onde no codigo / pendencias do PIPELINE

| Arquivo | Dono | Estado |
|---|---|---|
| `launch/launch-pipeline.ts` + `index.ts` | PIPELINE | implementado |
| `content.ts` (modo DRAFT, `marketOpportunityId`, `publish:false`) | PIPELINE | usado pelo pipeline |
| `orchestrator.ts` / `scheduler.ts` (coordenar times + criar ebooks pelo pipeline) | PIPELINE | parcial — ver SECTORS-TEAMS.md §6 |
| `routes/ebooks.ts` (`/ebooks/generate` delega ao pipeline) | PIPELINE | ver STATUS.md |

---

## C. Testes

- `packages/agents/src/sectors/ebook-qa/ebook-qa.test.ts` (vitest): checks
  STRUCTURE/COMPLIANCE puros (0/1 capitulo => BLOCKER => FAIL sem LLM),
  `verdictFromScore` nos limiares, loop NEEDS_FIX->PASS converge e para ao esgotar,
  `canLaunch` fail-closed.
- `packages/agents/src/launch/launch-pipeline.test.ts`: GATE 1 bloqueia (`rankAndPick
  -> null`, nenhum ebook); GATE 2 bloqueia (QA nunca PASS, ebook DRAFT sem Product);
  loop respeita `maxFixIterations`; PASS lança (Product + `EBOOK_PUBLISHED`); FAIL
  encerra. **Os testes injetam `qa`/`content` conformes** (ver A.5).
- E2E real: `apps/api/scripts/e2e-launch.ts` (`pnpm --filter @ebook-empire/api
  e2e:launch`) — Postgres real, MarketDataPort+LLM stub; usa um adapter-ponte
  `qaCapabilityFrom` para provar a LOGICA do pipeline ponta a ponta (44/44).

---

## D. Decisoes finais (resumo)

1. `createAndLaunchEbook` = funcao orquestradora (AgentContext + deps), nao Agent.
2. ContentAgent gera `Ebook(DRAFT)` sem Product (`publish:false`); publicacao so no
   passo final (PASS) — GATE 2 estrutural.
3. GATE 1 (mercado) e GATE 2 (qualidade) sao early-returns; `Ebook.marketOpportunityId`
   + `EbookAudit` persistido materializam a evidencia.
4. Score/verdict de QA DETERMINISTICOS no auditor; LLM nao decide PASS/FAIL.
5. `canLaunch` num lugar so (ultimo audit PASS), fail-closed.
6. Loop bounded por `QA_MAX_FIX_ITERATIONS`; FAIL/esgotar => permanece DRAFT.
7. EBOOK_QA fora de `SECTOR_WEIGHTS`; reporta via `EbookAudit`.
8. **Defeito de integracao em A.5 deve ser corrigido** antes de considerar o caminho
   de producao concluido.
