# Ebook Empire — STATUS

> Estado honesto do monorepo, por modulo. Documento vivo; atualizar a cada fase. Convencoes: dinheiro em `Int` centavos BRL; strings de usuario em pt-BR; escrita disjunta (cada arquivo tem UM dono).
>
> Legenda: **FUNCIONAL** = implementado e exercitado por testes (modo stub); **STUB** = implementacao deterministica injetavel, sem chamada externa; **PENDENTE** = nao implementado / esqueleto que lanca em runtime.

## Resumo executivo

Nucleo **substancialmente completo e coerente entre modulos** — bem acima de um esqueleto. Leitura cruzada confirma alinhamento real: os 6 adapters implementam exatamente os ports de `core/ports.ts`; as factories `create<Port>Adapter` que o `scheduler.ts` chama existem todas com os nomes exatos; os agentes usam os tipos de `core` e os modelos/enums do `@prisma/client`; `server.ts` registra as 7 rotas por caminho fixo; `base.ts` grava `AgentRun` (`RUNNING`→`SUCCESS`/`FAILED`/`SKIPPED`). Modelos LLM corretos (`claude-sonnet-4-6` conteudo, `claude-opus-4-8` planejamento). Dinheiro em centavos em todo lugar. Idempotencia de webhook via `Event @@unique([provider, externalEventId])`.

**Resultados reais de verificacao**: schema Prisma valido; **207 testes unitarios passando** (vitest, zero falhas) — inclui os novos de Finance (12), Alerts (8), rota finance (9) e rota alerts (11), sem regressao no CRM. E2E contra Postgres real: `e2e` (negocio), `e2e:crm` (40/0) e `e2e:ops` (Finance + Alerts, 46/0). Tudo em `USE_STUBS=true`.

**Ainda nao feito**: validacao end-to-end contra um **Postgres real** (ambiente sem banco); nenhuma integracao externa real foi exercitada (tudo em `USE_STUBS=true`).

---

## Tabela por modulo

| Modulo | Estado | Exige chave real? | Observacao |
|---|---|---|---|
| **Schema Prisma** (11 modelos + enums) | FUNCIONAL | nao | `prisma validate` ok. Migrations ainda nao rodadas contra Postgres real. |
| **packages/core** (tipos, schemas Zod, ports) | FUNCIONAL | nao | Sem testes proprios (`--passWithNoTests`). Contratos consumidos por todos. |
| **LLM adapter** (`llm.ts`) | FUNCIONAL (stub) + real | `ANTHROPIC_API_KEY` p/ real | `AnthropicLLMAdapter` + `StubLLMAdapter` implementam `LLMPort`. Real nao exercitado por testes. |
| **ContentAgent + rota `/ebooks`** | FUNCIONAL | so p/ LLM real | Gera outline+conteudo, cria `Ebook`+3 `Product`, PDF em disco (injetado via DI na rota). `coverImagePath` fica `null` (so `coverPrompt`; imagem real depende de futuro adapter de imagem). |
| **Pagamento** (`payment.ts`, checkout, `POST /webhooks/asaas`) | FUNCIONAL (stub) + Asaas real | `ASAAS_API_KEY`/`ASAAS_WEBHOOK_TOKEN` p/ real | `AsaasPaymentAdapter` + stub. Webhook idempotente (`@@unique[provider, externalEventId]`). Base URL Asaas = producao por default (configurar sandbox via env). Mercado Pago: port pronto, **sem** adapter. |
| **Entrega** (`email.ts`, `storage.ts`, `DeliveryAgent`, `/download/:token`) | FUNCIONAL (stub) + email real | `RESEND_API_KEY` p/ email real | `ResendEmailAdapter` (fetch nativo) + stub; storage local em disco com URL assinada propria + stub. Token de uso limitado (hash sha256, rotacao via `POST /delivery/retry`). `S3StorageAdapter` = **PENDENTE** (esqueleto que lanca). |
| **Social / Instagram** (`instagram.ts`, `SocialAgent`, `/social`) | FUNCIONAL (stub) | `META_GRAPH_TOKEN`/`META_AD_ACCOUNT_ID` p/ real | `MetaInstagramAdapter` + stub. Usa `META_AD_ACCOUNT_ID` como IG Business Account ID (sem var IG dedicada). Criativo real (imagem) usa placeholder ate ter geracao de imagem. |
| **Trafego** (`ads.ts`, `TrafficAgent`, `/ads`) | FUNCIONAL (stub) | `META_GRAPH_TOKEN`/`META_AD_ACCOUNT_ID` p/ real | `MetaMarketingAdsAdapter` + stub. Guardrails: `updateBudget` SET absoluto, teto `MAX_AD_BUDGET_BRL`, janela minima de amostragem, kill-switch. Atribuicao por `Order.adCampaignId` depende do checkout gravar `adCampaignId` a partir do `utmCampaign`. |
| **Analytics** (`analytics.ts`, `GET /analytics/kpis`) | FUNCIONAL | nao | Unico calculador de KPI (ROAS/CAC/CPA null-guarded). `/analytics/kpis` e **publica** (sem auth) — avaliar se deve exigir auth. Day-bounds assume UTC-3 fixo (Brasil sem horario de verao). |
| **Orchestrator / Runtime (CEO)** (`orchestrator.ts`, `base.ts`, `scheduler.ts`, `/agents`) | FUNCIONAL | so p/ LLM real | `runCycle` com guardrails deterministicos antes do LLM. Scheduler injeta o PDF builder real so no `ContentAgent`. Cadencia: `SLOW_TICK_MS` (CEO) + `FAST_TICK_MS` (COO/Command Center — agora **consumido** pelo loop FAST). |
| **apps/web** (Dashboard Next.js 14) | FUNCIONAL (UI) | nao | Overview, ebooks, orders, social, ads, agents. **Sem runner de testes** (sem vitest no `apps/web`). Consome rotas REST da API; algumas colunas dependem de enriquecimentos opcionais (email do cliente em `/orders`, insights agregados em `/ads`). |
| **CRM / Command Center** (`packages/agents/src/crm`, `routes/crm.ts`, `app/crm/*`, COO no scheduler) | FUNCIONAL | so p/ LLM real | Ciclo autonomo fim-a-fim **verificado contra Postgres real** (ver secao abaixo). **10 setores** monitorados (7 de saude + MARKETPLACE/FUNNEL/AFFILIATE) com score/status; diagnostico regras+LLM; catalogo LOW/HIGH; executor com guardrails+kill switch+rollback; fila de aprovacao HIGH via HTTP. |
| **Alertas externos** (Feature 1: `adapters/notification.ts`, `agents/alerts/*`, `routes/alerts.ts`, `app/crm/alerts`) | FUNCIONAL (stub) + email/WhatsApp real | `RESEND_API_KEY` (email) / `EVOLUTION_*` (WhatsApp) p/ real | 4 gatilhos (kill switch ON/OFF, setor CRITICAL na transicao, acao AUTO falha, HIGH enfileirada); EMAIL (EmailPort) + WHATSAPP (Evolution real / stub); dedupe/throttle por `dedupeKey`; `AlertLog`/`AlertSettings` (fail-OPEN). Best-effort: nunca derruba o ciclo do COO. Verificado contra Postgres real. |
| **Financeiro consolidado** (Feature 2: `agents/finance/*`, `routes/finance.ts`, `app/crm/finance`) | FUNCIONAL | nao (taxas via env) | DRE diaria (janela SP): receita - taxas Asaas - ad spend - LLM = lucro; margem %; contribuicao por ebook e por campanha (ROAS); meta diaria + projecao; `FinanceSnapshot` (serie historica, upsert idempotente). `FinanceService` stateless ctx-based. Verificado contra Postgres real. |
| **Times por setor** (`packages/agents/src/team/*`, `app/crm/teams`) | FUNCIONAL (stub) | so p/ LLM real | Framework `Specialist`/`Strategist`/`Executor` + `SectorTeam` + `buildSectorRegistry()` (7 setores de saude). Cada papel grava `AgentRun(role+sector)`. **PENDENTE:** o scheduler/Orchestrator ainda nao injeta `SectorTeamDeps.makeAgent` nem coordena os times (bindings retornam SKIPPED sem `makeAgent`); `GET /agents/runs` ainda nao expoe `role/sector/output`, entao `/crm/teams` mostra setores vazios (degrada com gracia). |
| **Mercado** (`adapters/market-data.ts`, `sectors/market-research/*`, `routes/market.ts`, `app/crm/market`) | FUNCIONAL (stub) + Serper real | **`SERPER_API_KEY`** p/ Serper real | `MarketResearchService` (time externo Serper + interno por nicho) -> `MarketOpportunity[]` rankeada por `potentialScore`, persistida; #1 = SELECTED. `StubMarketDataAdapter` deterministico; `SerperMarketDataAdapter` (real, fetch nativo). Rotas `/market/{health,opportunities,top,scan}`. **GATE 1** (rankAndPick antes de gerar ebook). |
| **QA / Auditoria de ebooks** (`sectors/ebook-qa/*`, `routes/quality.ts`, `app/crm/quality`) | FUNCIONAL (stub) | so p/ LLM real | `EbookAuditor`+`FixStrategist`+`RelaunchExecutor`+`EbookQaService`: STRUCTURE deterministico + 3 eixos via LLM; score/verdict DETERMINISTICOS; loop bounded corrigir->reauditar->relançar. Rotas `/quality/{health,audits,ebooks/:id/audit,audit/:id,fix/:id}`. **GATE 2** (`canLaunch` = ultimo audit PASS). **DEFEITO:** wiring default do pipeline pode nao publicar (contrato `auditEbook`/`applyFix` divergente — ver `EBOOK-QA.md` A.5). |
| **Pipeline de lancamento** (`launch/launch-pipeline.ts`) | FUNCIONAL (logica provada) | so p/ LLM/Serper real | `createAndLaunchEbook` com os 2 GATES (mercado + qualidade). Logica provada ponta a ponta no `e2e-launch` (44/44) com adapter-ponte. **PENDENTE:** caminho de producao (rota/Orchestrator) depende da correcao do contrato QA (A.5); scheduler/Orchestrator nao criam ebooks pelo pipeline ainda. |

---

## CRM / Command Center (COO autonomo)

> Extensao "Command Center": um agente COO (`OperationsAgent`) observa a saude dos **10 setores** (os 7 de saude + os 3 de producao autonoma MARKETPLACE/FUNNEL/AFFILIATE), diagnostica regressoes e remedia usando os agentes existentes como alavancas, sob politica **TIERED + KILL SWITCH**. Veja o design completo em `CRM-COMMAND-CENTER.md`.

**Verificacao real (Postgres `localhost:5433`, `USE_STUBS=true`):** `pnpm --filter @ebook-empire/api e2e:crm` -> **PASSARAM: 40   FALHARAM: 0**. Unidade: agents **94 testes** + api **15 testes** verdes. `pnpm -r typecheck` limpo nos 5 projetos.

### Funcional (provado ponta a ponta)

- **Coleta de saude (10 setores)**: cada tick do COO grava **10 linhas** `SectorHealthSnapshot` (score 0-100; status `HEALTHY>=70`/`WARNING 40-69`/`CRITICAL<40` derivado on-read). `DbHealthCollector.collect()` cobre os 7 de saude (CONTENT/SALES/DELIVERY/SOCIAL/TRAFFIC/ANALYTICS/ORCHESTRATION) **+ MARKETPLACE/FUNNEL/AFFILIATE** (via `collectMarketplace/collectFunnel/collectAffiliate`, com pesos de subscore locais `CRM_SUBSCORE_WEIGHTS`). `DbHealthCollector` e a unica camada que toca Prisma; os `score*` sao funcoes puras. Os 3 novos NAO entram em `SECTORS`/`SECTOR_WEIGHTS` (que dirigem o scoring dos 7) — usam scoring local, decisao documentada em `SECTORS-TEAMS.md` §6.
- **Diagnostico**: regras deterministicas primeiro + enriquecimento LLM (`claude-opus-4-8`) com fallback no `catch`. Cria/atualiza `Problem` (1 ativo por setor+type). Os 7 de saude via `SECTOR_RULES`/`runRules`; os 3 de producao via `CRM_SECTOR_RULES`/`runCrmRules` (MARKETPLACE -> `MISSING_COVER`/`DEAD_LISTING`; FUNNEL -> `HIGH_CART_ABANDONMENT`/`LANDING_DROPOFF`; AFFILIATE -> `AFFILIATE_REVENUE_ZERO`/`NO_AFFILIATE_ACTIVITY`). `gatherActionContext` popula `Problem.metadata` (productId/provider/affiliateId/niche/count) para os setores novos tambem. No e2e: DELIVERY backlog -> `DELIVERY_BACKLOG`; TRAFFIC ROAS ruim -> `NEGATIVE_ROAS`; prova do loop nos novos demonstra `DEAD_LISTING` -> `PAUSE_LISTING` (QUEUED/HIGH) e `BOOST_AFFILIATE_OUTREACH` (AUTO/LOW).
- **Ciclo autonomo LOW (requisito central)**: o COO aplica acoes LOW automaticamente. Provado: backlog DELIVERY 6 -> `RETRY_DELIVERIES` AUTO -> backlog 0 + 6 `DeliveryGrant` criados -> `Problem` -> **RESOLVED** no ciclo seguinte. Auditoria com `beforeState`/`afterState`. (O bug de wiring do executor/levers no scheduler — chip task_474caa2f — foi corrigido: `new GuardedActionExecutor(createLiveLevers())`.)
- **Fila de aprovacao HIGH via HTTP (fim-a-fim)**: HIGH no AUTO e bloqueada (`NOT_APPROVED`) e vai para `QUEUED`; `POST /crm/actions/:id/approve` re-valida teto e chama `applyApprovedAction` -> **APPLIED** (budget 5000 -> 8000), resposta `200 {applied:true}`. `applyApprovedAction`/`rollbackAction` **estao expostos** pelo scheduler.
- **Rollback**: `POST /crm/actions/:id/rollback` em acao reversivel restaura o `beforeState` (8000 -> valor anterior), marca `ROLLED_BACK`, audita nova `ActionExecution(isRollback=true)`.
- **Guardrails + kill switch**: `POST /crm/killswitch` ligando bloqueia TODAS as acoes auto com auditoria `KILL_SWITCH`; `maxAutoActionsPerCycle`/cooldown/teto financeiro (`MAX_AD_BUDGET_BRL`) ativos. Singleton `GuardrailConfig` fail-closed.
- **API `/crm`**: `GET /crm/health`, `/crm/overview`, `/crm/sectors/:sector`, `/crm/problems`, `/crm/problems/:id`, `/crm/actions`, `/crm/guardrails`; `POST /crm/actions/:id/{approve,reject,rollback}`, `/crm/guardrails`, `/crm/killswitch`, `/crm/scan`.
- **Web `/crm`**: `page.tsx` (overview), `problems/`, `actions/`, `approvals/`, `settings/` (Next.js 14, TanStack Query, degradacao graciosa em 404).
- **Scheduler**: loop FAST proprio em `FAST_TICK_MS` com guard `opsRunning` separado do `cycleRunning` do CEO; `runOperationsCycle(app)` reusado por `POST /crm/scan`.

### Divergencias vs. design doc (implementacao prevaleceu)

- **Rollback e `POST /crm/actions/:id/rollback`** (por actionId), nao `/crm/executions/:id/rollback`.
- **Guardrails update e `POST /crm/guardrails`** (nao `PUT`).
- A rota `GET /crm/sectors` (lista), `/crm/sectors/:sector/history`, `/crm/actions/:id` e `/crm/approvals` do design **nao** foram implementadas como rotas separadas (overview/sectors/actions cobrem os dados).
- **Sem pagina `app/crm/problems/[id]/page.tsx`** — o detalhe de problema fica em `problems/page.tsx`.

### Pendente / a evoluir

- [ ] **Snapshots em dobro por ciclo** quando o collector e o operations-agent ambos persistem (observar volume; consolidar a gravacao em um unico ponto).
- [x] **Fluxo 100% autonomo para kinds com params obrigatorios (TRAFFIC/SALES/MARKETPLACE/AFFILIATE)**: `gatherActionContext` no diagnostico popula `Problem.metadata` (campaignId/productId/provider/affiliateId/...) e o `OperationsAgent` agora **preserva** esse metadata ao propor (merge — antes apagava), entao o COO monta PAUSE_LISTING/SEND_AFFILIATE_EMAIL/ADJUST_PRICE/INCREASE_AD_BUDGET sozinho. Provado na prova do loop (18/0).
- [ ] **Retencao/downsample** de `SectorHealthSnapshot` (~14k linhas/dia a 60s, agora 10 setores/tick) — fora do escopo atual.
- [ ] **Sem testes automatizados no `apps/web`** (validacao por `tsc --noEmit`); rodar `next build` em CI para a boundary de `Suspense`/`useSearchParams`.

---

## Alertas externos (Feature 1)

> Detalhe completo em `docs/ALERTS.md`. Notificacao externa de eventos operacionais criticos do Command Center, sem nunca derrubar o ciclo do COO nem a resposta HTTP (best-effort em toda a cadeia).

**Verificacao real** (Postgres `localhost:5433`, `USE_STUBS=true`): `pnpm --filter @ebook-empire/api e2e:ops` -> **46/0** (em conjunto com Finance). Unit `alert-service.test.ts`: 8 testes verdes.

### Funcional (stub — provado)
- **4 gatilhos** wired: `KILL_SWITCH_ON`/`KILL_SWITCH_OFF` (rota `POST /crm/killswitch`), `SECTOR_CRITICAL` (transicao para CRITICAL detectada pelo `OperationsAgent` via `loadPriorStatuses`), `ACTION_AUTO_FAILED` e `ACTION_HIGH_QUEUED` (no `GuardedActionExecutor`).
- **Dedupe/throttle** por `dedupeKey = event:sector|GLOBAL` dentro de `throttleMinutes`: repeticao na janela vira `AlertLog` `SUPPRESSED` sem disparar canal. Kill switch usa eventos ON/OFF distintos para nunca suprimir troca real de estado.
- **Persistencia**: 1 `AlertLog` por canal disparado (`SENT`/`FAILED`); `SUPPRESSED` gera 1 linha. `AlertSettings` singleton **fail-OPEN** (ausente => alertas ligados, canal EMAIL, destinatarios das envs de boot).
- **Rotas** `/alerts`: `GET /alerts/health`, `GET /alerts` (paginada), `GET/PUT/POST /alerts/settings`, `POST /alerts/test` (bypassa throttle, dispara por-canal). **Web** `/crm/alerts` (feed + settings + teste).

### Canais
- **EMAIL** — FUNCIONAL via `EmailPort` (`StubEmailAdapter` em stub; `ResendEmailAdapter` com `RESEND_API_KEY`).
- **WHATSAPP** — `StubWhatsAppChannel` (memoria) por default; `EvolutionWhatsAppChannel` (real) so com `USE_STUBS=false` + `WHATSAPP_PROVIDER=evolution` + as 3 envs `EVOLUTION_*`.

### Pendente / a confirmar
- [ ] **Contrato real da Evolution API** (campo `number` vs `phone`, formato E.164 / sufixo `@s.whatsapp.net`) — confirmar contra a instancia antes de `WHATSAPP_PROVIDER=evolution` em producao. O stub mantem o contrato dos testes estavel.

---

## Financeiro consolidado (Feature 2)

> Detalhe completo em `docs/FINANCE.md`. DRE simplificada por dia (janela America/Sao_Paulo), margem por ebook/campanha, meta diaria + projecao, e `FinanceSnapshot` (serie historica).

**Verificacao real** (Postgres `localhost:5433`, `USE_STUBS=true`): `pnpm --filter @ebook-empire/api e2e:ops` -> **46/0**. Unit `finance-service.test.ts`: 12 testes verdes + 9 da rota.

### Funcional (provado)
- **DRE**: `netProfitCents = grossRevenue - paymentFees(Asaas) - adSpend - llmCost`; `marginPct` null-guarded. Receita = Orders `PAID`/`DELIVERED` por `paidAt`; spend = `AdInsight.spendCents`; LLM = `AgentRun.costCents`. Taxas Asaas **por transacao** (`ASAAS_FEE_PERCENT` + `ASAAS_FEE_FIXED_CENTS`).
- **Por ebook**: receita/fees pelo `Order.ebookId`; ad spend atribuido best-effort via `adCampaignId -> AdCampaign.productId -> Product.ebookId`; nao mapeavel vai p/ `unattributedAdSpendCents`. LLM nao entra por ebook.
- **Por campanha**: spend vs receita por `adCampaignId`, `roas = receita/spend` (null-guard); orders sem campanha caem no bucket `organic`.
- **Meta + projecao**: `TARGET_DAILY_REVENUE_BRL`; projecao linear pela fracao do dia decorrida (cap inferior na receita realizada).
- **Snapshot**: `persistSnapshot` faz upsert idempotente por `@@unique([date])`. Rota `POST /finance/snapshot` (JWT) on-demand; serie via `GET /finance/snapshots` (leitura direta).
- **Rotas** `/finance`: `health`, `overview`, `dre`, `by-ebook`, `by-campaign`, `snapshots`, `POST snapshot`. **Web** `/crm/finance`.

### Decisoes / divergencias documentadas
- `FinanceService.netProfit` **desconta** taxas Asaas (visao contabil) — divergencia DELIBERADA do `AnalyticsAgent.profitCents` (KPI operacional, sem taxas). Janela e `where` das fontes sao identicos ao Analytics.
- Spend filtrado por `AdInsight.date` em **meia-noite UTC** (igual ao Analytics), enquanto receita/LLM usam a janela SP — leve desalinhamento documentado.
- `FinanceService` e **stateless ctx-based** (`new FinanceService()`, metodos `computeDre/marginByEbook/marginByCampaign/goalProgress/persistSnapshot(ctx, { day? })`). Nao expoe `getHistory` — a rota le `FinanceSnapshot` direto.

### Pendente / a confirmar
- [ ] **Defaults de taxa (0,99% + R$0,49) sao placeholders** plausiveis para PIX Asaas — confirmar com a operacao antes de tratar o lucro como contabil definitivo.
- [ ] **Wiring opcional do snapshot no SLOW_TICK** (hoje a serie e alimentada pela rota `POST /finance/snapshot`; `persistSnapshot` ja e idempotente para o tick).

---

## Times / Mercado / QA / Pipeline (extensao)

> Detalhe completo: `docs/SECTORS-TEAMS.md`, `docs/MARKET-RESEARCH.md`, `docs/EBOOK-QA.md`. Convencoes: scores 0..100 (NAO centavos); strings pt-BR; cada papel = 1 `AgentRun(role+sector)`.

**Verificacao real** (Postgres `localhost:5433`, `USE_STUBS=true`): `pnpm --filter @ebook-empire/api e2e:launch` -> **44/44**. Builds de `core`+`agents` limpos, `pnpm -r typecheck` verde nos 5 projetos, **255 testes unitarios** verdes, e os 3 e2e de regressao (CRM 40, ops 46, negocio 26) verdes contra Postgres real.

### Times (framework de papeis) — FUNCIONAL (stub)
- `Specialist`/`Strategist`/`Executor` + `SectorTeam` + `buildSectorRegistry(deps)` (7 setores de saude) implementados e testados (`team/sector-team.test.ts`). LLM `PLANNING_MODEL` com fallback `RULES`; tolerancia a falha de papel.
- **PENDENTE (dono PIPELINE):** scheduler/Orchestrator nao injetam `SectorTeamDeps.makeAgent` nem coordenam os `SectorTeam` (bindings = SKIPPED sem `makeAgent`).
- **PENDENTE (dono rota Agentes/API):** `GET /agents/runs` nao expoe `role/sector/output` nem filtra por `sector`; `/crm/teams` mostra setores vazios (degrada com gracia).

### Mercado (MARKET_RESEARCH) — FUNCIONAL (stub) + Serper real
- Time, scoring puro, persistencia, rotas e GATE 1 (`rankAndPick`) implementados e testados.
- **Exige chave** para sair do stub: **`SERPER_API_KEY`** (+ `USE_STUBS=false` + `MARKET_DATA_PROVIDER=serper`). Sem isso, `StubMarketDataAdapter` deterministico.
- **PENDENTE:** scheduler nao injeta `marketData` no bundle Ports global (a rota `/market` monta o port localmente).

### QA (EBOOK_QA) — FUNCIONAL (stub)
- Auditor (STRUCTURE deterministico + 3 eixos LLM), FixStrategist deterministico, RelaunchExecutor, service (auditEbook/runFixLoop/auditExisting/canLaunch) e rotas implementados e testados.
- **DEFEITO de integracao conhecido (ver `EBOOK-QA.md` A.5):** `auditEbook` devolve `{ audit, ... }` (nao `EbookAudit`) e nao existe `applyFix`; o wiring default do pipeline depende de uma ponte (`adaptQaService`) que nenhum teste exercita — o caminho de producao pode nunca publicar. Corrigir `resolveQaCapability`/`EbookQaService` e adicionar teste do wiring default.

### Pipeline de lancamento — FUNCIONAL (logica) / PENDENTE (producao)
- `createAndLaunchEbook` com os 2 GATES: logica provada ponta a ponta no `e2e-launch` (44/44) com adapter-ponte `qaCapabilityFrom`. Os testes unitarios injetam `qa`/`content` conformes.
- **PENDENTE:** caminho de producao (rota `/ebooks/generate` + Orchestrator/COO) depende da correcao do A.5; coordenacao pelo scheduler ainda nao wired.

---

## Producao / Deploy (Railway + Neon)

> Runbook passo-a-passo em `docs/DEPLOY.md`. Resumo de estado: a infra de build/deploy esta **versionada e valida**; o que falta e **MANUAL no dashboard** (criar Neon, criar servico, setar Release Command/volume/envs).

**Verificacao real**: `railway.json` parseia OK; `nixpacks.toml` e `.env.production.example` existem; o build target do nixpacks (`apps/api/dist/server.js`) e produzido pelo build do `apps/api`. `pnpm install --frozen-lockfile` instala limpo (a pipeline usa `--frozen-lockfile`).

| Item | Estado | Observacao |
|---|---|---|
| `railway.json` (NIXPACKS, build/start/healthcheck `/health`) | FUNCIONAL | build = `pnpm install --frozen-lockfile && prisma:generate && build` do `@ebook-empire/api`; start = `node apps/api/dist/server.js`; restart `ON_FAILURE` x3. |
| `nixpacks.toml` | FUNCIONAL | Node 20 + pnpm 9.15.0; paridade com railway.json. |
| `.env.production.example` | FUNCIONAL | todas as envs de producao (nomes); `USE_STUBS=false`, `STORAGE_DIR=/data/storage`. |
| Release Command (migrations) | **MANUAL/PENDENTE** | setar no dashboard = `npx prisma migrate deploy --schema prisma/schema.prisma`. NUNCA `migrate dev`. |
| Volume `/data` + `STORAGE_DIR` | **MANUAL/PENDENTE** | storage de entrega e disco local; sem volume os PDFs somem entre deploys (S3 ainda e esqueleto). |
| `@fastify/cors` | FUNCIONAL | fixado em `^8.5.0` (compativel com Fastify 4). O `^11` introduzido antes derrubava o boot (`FST_ERR_PLUGIN_VERSION_MISMATCH`); corrigido + lockfile atualizado + `--frozen-lockfile` revalidado. |

**Pendente (manual)**: provisionar Neon + Railway, ligar canais reais um a um, apontar webhooks para `PUBLIC_BASE_URL/webhooks/{asaas,hotmart,kiwify}`. Ver `DEPLOY.md` §6.

---

## Marketplace (Hotmart + Kiwify) — FASE 3

> Detalhe operacional em `docs/RUNBOOK.md` §12. Sincroniza ebooks PUBLISHED em marketplaces externos e ingere vendas via webhook idempotente.

**Verificacao**: webhooks cobertos por `apps/api/src/routes/webhooks/webhooks.test.ts`; agente por `packages/agents/src/marketplace.test.ts`. Typecheck limpo nos 5 projetos; e2e de regressao verdes.

| Componente | Estado | Exige chave real? |
|---|---|---|
| **Webhooks** `POST /webhooks/hotmart` (HOTTOK) e `POST /webhooks/kiwify` (HMAC `X-Kiwify-Signature`) | FUNCIONAL (stub) + real | `HOTMART_WEBHOOK_TOKEN` / `KIWIFY_WEBHOOK_SECRET` p/ validar assinatura real |
| Fluxo de compra: valida assinatura → acha `Product` por `MarketplaceListing.externalProductId` → upsert `Customer` → `Order(PAID, marketplaceProvider)` + `Payment` → `Event` idempotente (`@@unique[provider, externalEventId]`). NAO cria `DeliveryGrant` (entrega nativa do marketplace). | FUNCIONAL | — |
| Refund/chargeback → `Order` REFUNDED + `Event(REFUNDED)` idempotente | FUNCIONAL | — |
| Atribuicao de afiliado: `affiliate_code`/`affiliate_id` do payload → `utmSource=hotmart\|kiwify`, `utmMedium=afiliado`, `utmContent=affiliateId` | FUNCIONAL | — |
| **MarketplaceAgent** (loop FAST): publica Products de ebooks PUBLISHED sem listing | FUNCIONAL (stub) | `HOTMART_*` / `KIWIFY_*` p/ real |
| Adapters reais Hotmart (`/products/v1.0.0/product`, upload `/file`) e Kiwify (`/v1/products`) | **STUB-validado / real best-effort** | URLs/payloads baseados na doc publica — **revalidar em homologacao** antes de `USE_STUBS=false` |

**Wiring (scheduler)**: `resolvePorts` **injeta** `ctx.ports.marketplace` via `createMarketplaceAdapter` (scheduler.ts ~L143), entao o `MarketplaceAgent` publica listings no loop FAST (degrada graciosamente se o adapter nao resolver). Os webhooks NAO dependem desse wiring (resolvem o adapter localmente).

---

## Afiliados (FASE 4)

> Detalhe operacional em `docs/RUNBOOK.md` §13.

**Verificacao**: `packages/agents/src/affiliate-outreach.test.ts`; checkout em `apps/api/src/routes/checkout.test.ts`. Typecheck limpo; e2e de regressao verdes.

| Componente | Estado | Exige chave real? |
|---|---|---|
| **AffiliateOutreachAgent** (loop SLOW): seleciona `Affiliate` PROSPECT fora do cooldown → gera copy pt-BR via LLM → envia **email** (EmailPort) → `AffiliateOutreach` por canal + `Event(AFFILIATE_CONTACTED)` + atualiza `lastContactedAt` | FUNCIONAL (stub) | `RESEND_API_KEY` p/ email real; `ANTHROPIC_API_KEY` p/ copy LLM real |
| Canal **WhatsApp** do outreach (versao curta via `ctx.ports.whatsapp?`) | FUNCIONAL no agente / **degrada** | `EVOLUTION_*` + `WHATSAPP_PROVIDER=evolution` |
| **UTM de afiliado no checkout** (`POST /checkout`): le `referral.affiliateId` (+ `source?`) cru do body → `utmSource` (default `afiliado`), `utmMedium=afiliado`, `utmContent=affiliateId`, propagado ao `Event(PAID)` | FUNCIONAL | — |

**Wiring (scheduler)**: `resolvePorts` **popula** `ctx.ports.whatsapp` via `createWhatsAppAdapter` (scheduler.ts ~L168), entao o `AffiliateOutreachAgent` pode contatar por WhatsApp alem de email (degrada graciosamente se o port nao resolver). Em stub, usa o canal de memoria.

**Nota de contrato**: `referral` e lido **fora** do `checkoutBodySchema` (que descarta unknowns). Para torna-lo oficial, estender o schema em `packages/core/src/schemas.ts`.

---

## COO-Scale (setores de producao + ActionKinds) — LIGADO AO LOOP

> Extensao do Command Center: o COO agora **monitora, diagnostica e remedia** tambem os 3 setores de producao autonoma (MARKETPLACE/FUNNEL/AFFILIATE) e escala via novas alavancas. Os ActionKinds sao consistentes nas **4 localizacoes** exigidas (schema enum / core `crm.ts` / executor switch + ACTION_SPECS / `levers-live.ts`).

**Estado**: o loop do COO foi **fechado fim-a-fim** — `health-collector.collect()` cobre os 10 setores e `action-catalog.buildProposal()` tem os cases dos kinds de producao, entao o COO **propoe esses ActionKinds autonomamente** (antes nunca eram propostos no loop). `SECTOR_KINDS` mapeia: MARKETPLACE -> `PAUSE_LISTING`/`GENERATE_MORE_EBOOKS`; FUNNEL -> `REGENERATE_LANDING_COPY`; AFFILIATE -> `BOOST_AFFILIATE_OUTREACH`/`SEND_AFFILIATE_EMAIL`; CONTENT/ORCHESTRATION tambem ganham `GENERATE_MORE_EBOOKS` (REVENUE_BELOW_TARGET).

**Verificacao**: os ActionKinds existem em `prisma/schema.prisma` (enum `ActionKind`), `packages/core/src/crm.ts` (union TS + `actionKindSchema` z.enum + `remediationParamsSchema`), `packages/agents/src/crm/executor.ts` (cases do switch + ACTION_SPECS) e `packages/agents/src/crm/levers-live.ts` (metodos). Verificacao honesta contra Postgres real (`localhost:5433`), tudo re-rodado: **typecheck 5/5 verde**; **374 testes unitarios verdes**; os **4 e2e originais 156/0** (e2e 26, e2e-crm 40, e2e-finance-alerts 46, e2e-launch 44); **prova do loop do COO nos setores novos 18/0**. Drift corrigido durante a prova: o `OperationsAgent` apagava o `metadata` de contexto que o catalogo precisa para montar kinds com params obrigatorios — corrigido com um merge de metadata em `operations-agent.ts` (mudanca minima), apos o que a prova passou a demonstrar `PAUSE_LISTING` proposta e roteada para `QUEUED` (HIGH) e `BOOST_AFFILIATE_OUTREACH` aplicada AUTO (LOW).

| ActionKind | Tier | Reversivel? | Setor(es) | Alavanca |
|---|---|---|---|---|
| `GENERATE_MORE_EBOOKS` | LOW | nao | CONTENT, ORCHESTRATION, MARKETPLACE | gera N ebooks via `createAndLaunchEbook` (respeita os 2 GATES por lancamento) |
| `PAUSE_LISTING` | **HIGH** | **sim** | MARKETPLACE | `Product.active=false` (revert religa a oferta); HIGH => fila de aprovacao |
| `BOOST_AFFILIATE_OUTREACH` | LOW | nao | AFFILIATE | dispara um ciclo do `AffiliateOutreachAgent` (lote de PROSPECTs) |
| `SEND_AFFILIATE_EMAIL` | LOW | nao | AFFILIATE | contata 1 afiliado via `AffiliateOutreachAgent.runForAffiliate(ctx, affiliateId)` |
| `REGENERATE_LANDING_COPY` | LOW | sim | SALES, FUNNEL | regenera a copy da landing (agora tambem proposta para FUNNEL) |

---

## O que exige chave real (para sair do stub)

| Chave | Habilita |
|---|---|
| `ANTHROPIC_API_KEY` | Geracao de conteudo e planejamento do CEO com LLM real (+ copy de outreach de afiliados) |
| `ASAAS_API_KEY` + `ASAAS_WEBHOOK_TOKEN` | Cobranca PIX e validacao de webhook reais |
| `META_GRAPH_TOKEN` + `META_AD_ACCOUNT_ID` | Publicacao no Instagram e campanhas de ads reais |
| `RESEND_API_KEY` | Envio real do email de entrega, dos alertas por email **e do outreach de afiliados** |
| `EVOLUTION_API_URL` + `EVOLUTION_API_KEY` + `EVOLUTION_INSTANCE` (+ `WHATSAPP_PROVIDER=evolution`) | Alertas por WhatsApp **e WhatsApp de outreach de afiliados** (este ultimo depende do wiring de `ports.whatsapp`) via Evolution API |
| **`SERPER_API_KEY`** (+ `USE_STUBS=false` + `MARKET_DATA_PROVIDER=serper`) | Pesquisa de mercado externa real (Serper.dev Google Search) no setor MARKET_RESEARCH |
| `HOTMART_CLIENT_ID` + `HOTMART_CLIENT_SECRET` + `HOTMART_WEBHOOK_TOKEN` | Publicacao de produtos e webhook de vendas na Hotmart |
| `KIWIFY_API_KEY` + `KIWIFY_ACCOUNT_ID` + `KIWIFY_WEBHOOK_SECRET` | Publicacao de produtos e webhook de vendas na Kiwify |

Sem nenhuma delas, com `USE_STUBS=true`, o sistema roda fim-a-fim deterministicamente.

---

## Pendencias conhecidas (ordenadas)

- [ ] **Validacao end-to-end com Postgres real**: rodar `prisma migrate` e exercitar `checkout → webhooks/asaas → download` contra banco de verdade.
- [ ] **Plugar adapters reais** um a um (Asaas sandbox → Resend → Meta), trocando `USE_STUBS=false` e validando cada modulo.
- [ ] **`S3StorageAdapter`**: implementar presigned URLs nativas (hoje lanca em runtime). Disco local funciona.
- [ ] **Geracao de imagem de capa/criativo**: hoje so prompt textual; social usa placeholder.
- [x] **`FAST_TICK_MS`**: agora consumido por um tick proprio (loop FAST do COO/Command Center). Ver secao "CRM / Command Center".
- [ ] **`adCampaignId` no Order**: garantir que o checkout grave a atribuicao a partir do `utmCampaign` para o ROAS por campanha fechar.
- [ ] **Decisao de produto**: `/analytics/kpis` publica? rotacao de token em `/delivery/retry` e o comportamento desejado?
- [ ] **Mercado Pago**: implementar segundo `PaymentProvider` via `PaymentPort` (sem mexer nos agentes).
- [x] **Wiring de `ports.marketplace` e `ports.whatsapp` no scheduler** (`resolvePorts`): FEITO — habilita o `MarketplaceAgent` a publicar listings (FAST) e o `AffiliateOutreachAgent` a enviar WhatsApp (SLOW). Ambos degradam graciosamente se o adapter nao resolver.
- [ ] **Revalidar adapters Hotmart/Kiwify em homologacao** (endpoints/payloads best-effort) antes de `USE_STUBS=false`.
- [ ] **Provisionamento de producao** (manual no dashboard): Neon + Railway + Release Command + volume — ver `docs/DEPLOY.md`.

## Nota sobre build/typecheck

Durante a implementacao houve relatos de `TS6306` em `pnpm -r typecheck` por falta de `composite: true` nos projetos referenciados. O `tsconfig.base.json` atual **ja inclui `composite: true`** e os tsconfigs dos pacotes o estendem — confirmar com `pnpm prisma:generate && pnpm -r typecheck` apos clone (lembrar que `prisma generate` e pre-requisito).
