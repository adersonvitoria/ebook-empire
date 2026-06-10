# Ebook Empire — RUNBOOK operacional

> Passo a passo para subir, operar e ligar integracoes reais. Convencoes: dinheiro em `Int` centavos BRL; strings de usuario em pt-BR. Todas as variaveis sao validadas por Zod em `apps/api/src/env.ts` — env invalido **derruba a API no boot** (fail-fast).

Pre-requisitos: **Node 20+**, **pnpm 9.15+**, **PostgreSQL**.

---

## 0. Login do dashboard (agir pela tela)

> O dashboard (`apps/web`) e VISIVEL sem login — todos os `GET` de leitura sao publicos. **Para AGIR** (botoes administrativos: kill switch, aprovar/rejeitar acao HIGH, rollback, scan, gerar ebook, salvar guardrails/alertas, etc.) e preciso fazer login, porque essas rotas sao protegidas por JWT (`fastify.authenticate`). O login e single-admin (apenas o dono).

### 0.1 Habilitar o login — setar `ADMIN_PASSWORD`

A rota `POST /auth/login` so funciona se a env **`ADMIN_PASSWORD`** estiver configurada na API.

- **Em producao (Railway):** Settings → **Variables** → adicione `ADMIN_PASSWORD=<senha-forte>` e faca **redeploy** (a env e lida no boot).
- **Local:** adicione `ADMIN_PASSWORD=<senha>` ao `.env` da raiz e reinicie a API.

Comportamento da rota (`apps/api/src/routes/auth.ts`):

| Situacao | Resposta |
|---|---|
| `ADMIN_PASSWORD` **vazia/ausente** | `503 { error: 'login_disabled' }` — login desabilitado, botoes ficam inertes |
| senha **errada** | `401 { error: 'invalid_credentials' }` |
| senha **correta** | `200 { token, expiresInSec }` (JWT `{ role:'admin', sub:'admin' }`) |

A comparacao de senha e em **tempo constante** (`timingSafeEqual`); a senha nunca e logada. `GET /auth/me` (protegida) valida o Bearer e devolve `{ role, sub }`.

### 0.2 Logar na UI

1. Abra o dashboard (ex. `http://localhost:3000` em dev, ou a URL da Vercel em producao).
2. No topo ha a **barra de autenticacao** (`components/auth-bar.tsx`): em "Modo leitura — faca login para agir", digite a senha em **"Senha do painel"** e clique **Entrar**.
3. Ao autenticar, o indicador vira verde **"Autenticado — acoes habilitadas"** e os botoes de acao passam a funcionar. O token e guardado em `localStorage` (chave `ee_token`) e anexado como `Authorization: Bearer <token>` em todas as requisicoes.
4. **Sair:** clique **Sair** (limpa o token da memoria e do storage).

Mensagens de erro na barra: senha incorreta (401), "Login desabilitado no servidor (ADMIN_PASSWORD nao configurado)" (503), ou "API fora do ar" (sem rede).

### 0.3 O que cada botao de acao faz (todos exigem login)

| Pagina (web) | Botao | Rota chamada |
|---|---|---|
| `/crm/settings` | Ligar/Desligar kill switch | `POST /crm/killswitch` |
| `/crm/settings` | Salvar limites / guardrails | `POST /crm/guardrails` |
| `/crm/settings` | Rodar scan | `POST /crm/scan` |
| `/crm/approvals` | Aprovar acao HIGH | `POST /crm/actions/:id/approve` |
| `/crm/approvals` | Rejeitar acao HIGH | `POST /crm/actions/:id/reject` |
| `/crm/actions` | Reverter / rollback | `POST /crm/actions/:id/rollback` |
| `/crm/alerts` | Salvar configuracao de alertas | `PUT /alerts/settings` |
| `/crm/alerts` | Enviar alerta de teste | `POST /alerts/test` |
| `/crm/market` | Rodar analise / market scan | `POST /market/scan` |
| `/crm/quality` | Auditar ebook | `POST /quality/audit/:id` |
| `/crm/quality` | Corrigir ebook | `POST /quality/fix/:id` |
| `ebooks` | Gerar ebook | `POST /ebooks/generate` |
| `agents` | Rodar ciclo / run-cycle | `POST /agents/cycle` |
| `crm/finance` | Persistir snapshot do dia | `POST /finance/snapshot` |

Se uma acao retornar **401** (token expirou ou ausente), a UI sinaliza que e preciso logar de novo.

### 0.4 Expiracao do token

O token expira em **`AUTH_TOKEN_TTL_SEC`** segundos (default **43200 = 12 horas**; configuravel por env). Depois disso as acoes voltam a dar 401 — basta logar novamente pela barra. O JWT e assinado com o **`JWT_SECRET`** (o mesmo das demais rotas admin).

> **CORS:** para o navegador permitir as chamadas autenticadas, o `@fastify/cors` ja inclui `Authorization` em `allowedHeaders` (`['Content-Type','Authorization']`) alem da origem `CORS_ORIGIN`. Sem isso o browser bloquearia o header `Authorization` — ver `DEPLOY.md` §5.

---

## 1. Subir o banco

> **Setup local ja validado (2026-06-10):** o ambiente foi configurado e exercitado ponta a ponta nesta maquina. O `.env` ja aponta para um Postgres em `localhost:5433` (porta 5433 para nao conflitar com o PostgreSQL nativo do Windows em 5432). As migrations ja foram aplicadas. Para reproduzir do zero, use uma das opcoes abaixo.

**Opcao A — Docker (recomendado):** ja existe um `docker-compose.yml` na raiz (Postgres 16, usuario/senha `ebook`, porta 5433):

```bash
docker compose up -d            # sobe o container ebook-empire-db
```

**Opcao B — Postgres nativo:** crie um cluster dedicado na porta 5433 (foi o usado na validacao, pois o Docker nao estava disponivel):

```powershell
& "C:\Program Files\PostgreSQL\18\bin\initdb.exe" -D .pgdata -U ebook -A scram-sha-256 --pwfile=<arquivo-com-senha> -E UTF8
# adicione "port = 5433" em .pgdata\postgresql.conf
& "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe" -D .pgdata -l .pgdata\server.log start
& "C:\Program Files\PostgreSQL\18\bin\createdb.exe" -h localhost -p 5433 -U ebook ebook_empire
```

O `.env` ja contem a URL correta:

```
DATABASE_URL=postgresql://ebook:ebook@localhost:5433/ebook_empire?schema=public
```

> O `.env` da raiz e carregado automaticamente por `apps/api/src/env.ts` (via `process.loadEnvFile`, Node 22+) — nao e preciso `--env-file` no comando.

---

## 2. Instalar, gerar cliente e migrar

```bash
pnpm install
pnpm prisma:generate          # gera @prisma/client (pre-requisito de typecheck/build)
pnpm prisma:migrate           # aplica/cria as migrations (cria as tabelas)
```

> **Ordem obrigatoria**: `prisma generate` antes de `typecheck`/`build`/dev. Sem o `@prisma/client` gerado, os pacotes `agents` e `api` nao compilam.

Inspecionar dados a qualquer momento:

```bash
pnpm prisma:studio            # GUI do banco
```

---

## 3. Seedar catalogo (gerar o primeiro ebook + Products)

Nao ha script de seed dedicado — o catalogo nasce do `ContentAgent`. Duas formas:

**(a) Disparo manual de geracao (admin, requer JWT):**

```bash
curl -X POST http://localhost:3001/ebooks/generate \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "niche": "produtividade", "title": "..." }'   # campos conforme schema da rota
```

Em `USE_STUBS=true` o LLM e deterministico (sem chave). A rota injeta o `buildEbookPdf` real, entao o PDF e gerado em disco mesmo no modo stub.

**(b) Deixar o orchestrator gerar:** com `ENABLE_AGENTS=true` e faturamento abaixo da meta (modo crescer), o ciclo do CEO agenda o `ContentAgent`. Force um ciclo com `POST /agents/cycle`.

Confirme o resultado:

```bash
curl http://localhost:3001/ebooks            # deve listar o ebook + Products
```

---

## 3.1 Validacao E2E (smoke test do trilho de negocio)

Existe um teste ponta a ponta que exercita o fluxo inteiro contra o **Postgres real** em modo stub (sem nenhuma chave externa): geracao de ebook → checkout PIX → webhook Asaas (com idempotencia) → entrega (grant + email) → download do PDF (com gate de limite) → KPIs/receita.

```bash
pnpm --filter @ebook-empire/api e2e
```

Resultado esperado: `PASSARAM: 26   FALHARAM: 0`. O script limpa as tabelas, roda o fluxo e reporta cada assercao. Use-o como smoke test apos qualquer mudanca no nucleo.

> Fixes aplicados na validacao (ja no repo): (1) `apps/api/src/env.ts` carrega o `.env` da raiz automaticamente; (2) `@fastify/jwt` alinhado a `^8` (compativel com Fastify 4 — o `^9` exigia Fastify 5 e derrubava o boot); (3) guard de auto-start do `server.ts` agora usa `pathToFileURL` (o `pnpm dev` nao iniciava o listener no Windows).

---

## 4. Modo stub vs modo real

O interruptor global e `USE_STUBS`.

| `USE_STUBS` | Comportamento |
|---|---|
| `true` (default) | Todos os ports usam stubs deterministicos BR-first. **Nenhuma** chamada externa; nenhuma chave necessaria. Ideal para dev, testes e demo. |
| `false` | Os adapters tentam usar as integracoes reais — exige as chaves correspondentes preenchidas. |

Trocas mais finas (alem do `USE_STUBS` global):

- **Pagamento**: `PAYMENT_PROVIDER=asaas` (unico provider real implementado). Qualquer outro valor cai no stub. Mercado Pago tem o port generico pronto, mas sem adapter concreto ainda.
- Os adapters sao selecionados pelas factories `create<Port>Adapter` em `packages/adapters/src/*` (`createLLMAdapter`, `createPaymentAdapter`, `createEmailAdapter`, `createStorageAdapter`, `createInstagramAdapter`, `createAdsAdapter`), chamadas pelo `scheduler.ts`/rotas a partir do `env`.

Para um go-live controlado, vire `USE_STUBS=false` e ligue **um modulo de cada vez**, validando o fluxo antes do proximo (ver `ROADMAP.md`, Fase 5).

---

## 5. Onde plugar cada chave

Todas no `.env` (copie de `.env.example`). Nomes reais conforme `apps/api/src/env.ts`:

| Integracao | Variavel(eis) no `.env` | Para que serve | Onde e usada |
|---|---|---|---|
| **Anthropic (LLM)** | `ANTHROPIC_API_KEY` | Geracao de conteudo (`claude-sonnet-4-6`) e planejamento do CEO (`claude-opus-4-8`) | `createLLMAdapter` → `ContentAgent`, `SocialAgent`, `Orchestrator` |
| **Asaas (PIX)** | `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`, `PAYMENT_PROVIDER=asaas` | Criar cobranca PIX e validar o webhook (`asaas-access-token`) | `createPaymentAdapter` → rota `POST /checkout`, `POST /webhooks/asaas` |
| **Meta Graph (Instagram)** | `META_GRAPH_TOKEN`, `META_AD_ACCOUNT_ID` | Publicar posts e ler insights de conta/post | `createInstagramAdapter` → `SocialAgent`, rota `social.ts` |
| **Meta Ads (Marketing)** | `META_GRAPH_TOKEN`, `META_AD_ACCOUNT_ID` | Criar/ajustar campanhas, budget e insights | `createAdsAdapter` → `TrafficAgent`, rota `ads.ts` |
| **Resend (email)** | `RESEND_API_KEY` | Enviar o email de entrega com o link `/download/:token` | `createEmailAdapter` → `DeliveryAgent` |
| **Storage** | `STORAGE_DIR` (default `./storage`) | Disco local com URL assinada propria (stub). Migracao a S3 e esqueleto | `createStorageAdapter` → entrega |

Notas importantes:

- O adapter de Instagram/Ads usa **`META_AD_ACCOUNT_ID` como IG Business Account ID**. Se a integracao real exigir um IG User ID distinto do Ad Account, adicione uma var dedicada (ex. `META_IG_USER_ID`) em `env.ts` antes de ligar o live.
- O `AsaasPaymentAdapter` usa **base URL de producao por default**. Para testes de integracao reais, configure o ambiente de sandbox via env (`ASAAS_BASE_URL`) antes de ativar.
- O `ResendEmailAdapter` usa `fetch` nativo (sem dependencia extra). Para SMTP/nodemailer, e preciso adicionar a dep e um `SmtpEmailAdapter`.
- O `S3StorageAdapter` e esqueleto e **lanca em runtime** — implementar presigned URLs (`@aws-sdk/client-s3` + `s3-request-presigner`) antes de usar storage externo.

---

## 6. Variaveis de runtime / guardrails

| Variavel | Default | Efeito |
|---|---|---|
| `ENABLE_AGENTS` | `true` | Liga/desliga o scheduler inteiro |
| `FAST_TICK_MS` | `60000` | Cadencia do loop FAST do COO/Command Center (`OperationsAgent`) — coleta saude, diagnostica e remedia (ver secao 9) |
| `SLOW_TICK_MS` | `900000` | Cadencia do ciclo do orchestrator (CEO) |
| `MAX_AD_BUDGET_BRL` | `300` | Teto diario de budget de ads (guardrail do `TrafficAgent`) |
| `TARGET_DAILY_REVENUE_BRL` | `1000` | Meta de faturamento (chaveia modo crescer vs sustentar) |
| `PORT` | `3001` | Porta da API Fastify |
| `PUBLIC_BASE_URL` | `http://localhost:3001` | Base usada em links de download/email |
| `JWT_SECRET` | — (obrigatorio, >= 8 chars) | Assinatura dos tokens das rotas admin |

> Nota: rodam **dois** loops independentes no processo Fastify (sem worker separado): o ciclo SLOW do orchestrator/CEO (`SLOW_TICK_MS`) e o ciclo FAST do COO/Command Center (`FAST_TICK_MS`, guard `opsRunning` proprio). Guardrails financeiros adicionais (kill switch, teto, cooldown) vivem em `GuardrailConfig` — ver secao 9.

---

## 7. Operacao diaria

```bash
pnpm dev                                   # API (scheduler ativo se ENABLE_AGENTS=true)
pnpm dev:web                               # dashboard (porta 3000)

curl http://localhost:3001/health          # SELECT 1 no banco
curl http://localhost:3001/agents/status   # estado do scheduler + ultimo ciclo + KPIs
curl http://localhost:3001/analytics/kpis  # ROAS/CAC/CPA/receita/lucro do dia (publica)
curl http://localhost:3001/orders          # pedidos
```

Forcar um ciclo do CEO (admin): `curl -X POST http://localhost:3001/agents/cycle -H "Authorization: Bearer <TOKEN>"`.

---

## 8. Checklist de go-live (resumo — detalhe em ROADMAP Fase 5)

1. Banco real migrado; rodar `checkout → webhooks/asaas → download` ponta a ponta uma vez.
2. `USE_STUBS=false`. Ligar Asaas (sandbox primeiro), confirmar webhook idempotente e entrega automatica.
3. Email e storage reais (ou disco em volume persistente).
4. Meta em modo real (conta de anuncios + BM reserva; compliance de copy pt-BR).
5. Reserva de capital de giro R$3–5k provisionada; budget inicial R$150/dia.
6. Webhook publico configurado no painel Asaas apontando para `PUBLIC_BASE_URL/webhooks/asaas`.

---

## 9. Operar o CRM / Command Center (COO autonomo)

> O Command Center e a operacao autonoma: o agente COO (`OperationsAgent`) roda no loop FAST (`FAST_TICK_MS`, default 60s), coleta a saude dos 7 setores (CONTENT, SALES, DELIVERY, SOCIAL, TRAFFIC, ANALYTICS, ORCHESTRATION), diagnostica regressoes e remedia. Acoes **LOW** (reversiveis/internas) sao aplicadas automaticamente; acoes **HIGH** (financeiras/cliente) vao para uma fila de aprovacao humana. Design completo em `docs/CRM-COMMAND-CENTER.md`. Strings em pt-BR; dinheiro em `Int` centavos.

### 9.1 Smoke test E2E do CRM (Postgres real, modo stub)

```bash
pnpm --filter @ebook-empire/api e2e:crm
```

Resultado esperado: `PASSARAM: 40   FALHARAM: 0`. Exercita ponta a ponta: coleta dos 7 setores (7 `SectorHealthSnapshot`/ciclo) -> backlog DELIVERY -> `DELIVERY_BACKLOG` -> `RETRY_DELIVERIES` AUTO aplicada -> `Problem` RESOLVED no ciclo seguinte -> proposta HIGH (`DECREASE_AD_BUDGET`) QUEUED -> aprovacao HUMAN -> APPLIED -> rollback -> kill switch bloqueando tudo com auditoria. Use como smoke test apos qualquer mudanca no Command Center.

### 9.2 Abrir o Command Center (web)

Com a API e o web no ar (`pnpm dev` + `pnpm dev:web`), abra `http://localhost:3000/crm`. Abas internas:

- **Overview** (`/crm`): grid dos 7 setores com score/status, problema principal e contagem de acoes pendentes; banner vermelho quando o kill switch esta ativo.
- **Problemas** (`/crm/problems`): feed de `Problem` (filtros por status/setor) com diagnostico e acoes.
- **Acoes** (`/crm/actions`): timeline de `RemediationAction` + `ActionExecution` (before/after auditados).
- **Aprovacoes** (`/crm/approvals`): fila HIGH (`QUEUED`) com botoes Aprovar/Rejeitar.
- **Configuracoes** (`/crm/settings`): kill switch, `maxAutoActionsPerCycle`, cooldown, teto de budget.

A UI degrada graciosamente: se as rotas `/crm` retornarem 404, mostra "ainda nao implementada" em vez de quebrar.

### 9.3 Disparar um scan manual (sem esperar o tick FAST)

`POST /crm/scan` dispara um ciclo do COO na hora (mesma `runOperationsCycle` do loop FAST). Body opcional `{ "sector": "DELIVERY" }`.

```bash
curl -X POST http://localhost:3001/crm/scan \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Inspecione o resultado: `GET /crm/overview` (saude + contagens + kill switch) ou `GET /crm/problems` / `GET /crm/actions`.

### 9.4 Aprovar / rejeitar acoes HIGH

Acoes HIGH (`INCREASE_AD_BUDGET`, `DECREASE_AD_BUDGET`, `PAUSE_CAMPAIGN`, `ADJUST_PRICE`) nunca sao aplicadas sozinhas — ficam `QUEUED`. Liste-as em `GET /crm/approvals` (ou aba Aprovacoes).

```bash
# Aprovar (re-valida teto financeiro e aplica via executor; 200 {applied:true} ao concluir)
curl -X POST http://localhost:3001/crm/actions/<ACTION_ID>/approve \
  -H "Authorization: Bearer <TOKEN>"

# Rejeitar (move para REJECTED; nao toca no sistema)
curl -X POST http://localhost:3001/crm/actions/<ACTION_ID>/reject \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{ "reason": "fora do orcamento do mes" }'
```

O approve re-valida o teto (`MAX_AD_BUDGET_BRL`/`GuardrailConfig.maxAdBudgetCents`) como terceira camada — uma aprovacao tardia nao burla o teto (422 `budget_cap_exceeded`). Concorrencia AUTO x HUMAN: se a acao ja saiu de `QUEUED`, retorna 409.

### 9.5 Reverter uma acao aplicada (rollback)

Acoes reversiveis (budget/preco/status — SET absoluto) podem ser revertidas, restaurando o `beforeState` auditado:

```bash
curl -X POST http://localhost:3001/crm/actions/<ACTION_ID>/rollback \
  -H "Authorization: Bearer <TOKEN>"
```

Exige a acao `reversible=true` e em `APPLIED` (senao 409). Gera nova `ActionExecution(isRollback=true)` e marca a acao `ROLLED_BACK`. (Acoes LOW geradoras de conteudo — `GENERATE_EBOOK`/`RETRY_DELIVERIES`/etc — sao `reversible=false`; rollback e no-op idempotente.)

### 9.6 Ligar / desligar o kill switch (parada de emergencia)

Quando ligado, **NENHUMA** acao automatica e aplicada — inclusive HIGH ja aprovadas (fail-safe). Cada bloqueio gera auditoria `KILL_SWITCH`.

```bash
# Ligar (pausa toda a autonomia)
curl -X POST http://localhost:3001/crm/killswitch \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{ "enabled": true }'

# Desligar (retoma a autonomia)
curl -X POST http://localhost:3001/crm/killswitch \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{ "enabled": false }'
```

Tambem disponivel pela aba Configuracoes (com confirmacao destrutiva). Ajuste outros guardrails via `POST /crm/guardrails` (body parcial: `{ maxAutoActionsPerCycle?, cooldownMinutes?, maxAdBudgetCents? }`); leia o estado atual em `GET /crm/guardrails`.

> **Singleton fail-closed**: se `GuardrailConfig` estiver ausente, o executor trata como `killSwitch=true` / `maxAuto=0` — nunca aplica sem guardrails carregados. O `getOrCreate` o cria na primeira leitura.

### 9.7 Endpoints `/crm` (referencia rapida)

| Metodo | Rota | Uso |
|---|---|---|
| GET | `/crm/health` | ping do modulo CRM |
| GET | `/crm/overview` | saude dos 7 setores + contagens + kill switch + KPI do dia |
| GET | `/crm/sectors/:sector` | setor + historico de snapshots + problema aberto |
| GET | `/crm/problems` | feed de Problems (`?status&sector&limit&offset`) |
| GET | `/crm/problems/:id` | problema + diagnostico + acoes + executions |
| GET | `/crm/actions` | timeline de RemediationAction + execution |
| POST | `/crm/actions/:id/approve` | [JWT] aprova HIGH e aplica (re-valida teto) |
| POST | `/crm/actions/:id/reject` | [JWT] rejeita HIGH |
| POST | `/crm/actions/:id/rollback` | [JWT] reverte acao reversivel aplicada |
| GET | `/crm/guardrails` | le GuardrailConfig (singleton) |
| POST | `/crm/guardrails` | [JWT] atualiza guardrails (body parcial) |
| POST | `/crm/killswitch` | [JWT] liga/desliga kill switch global |
| POST | `/crm/scan` | [JWT] dispara um ciclo do COO na hora (`runOperationsCycle`) |

---

## 10. Operar Financeiro e Alertas (Features 1 e 2)

> Detalhe completo: `docs/FINANCE.md` e `docs/ALERTS.md`. Ambos sao extensoes do Command Center: dinheiro em `Int` centavos, strings em pt-BR.

### 10.1 Smoke test E2E (Postgres real, modo stub)

Um unico script cobre Financeiro + Alertas ponta a ponta contra o Postgres real, sem nenhuma chave externa:

```bash
pnpm --filter @ebook-empire/api e2e:ops
```

Resultado esperado: `PASSARAM: 46   FALHARAM: 0`. Prova DRE com numeros conferidos a mao (receita / taxas Asaas / adSpend / LLM / lucro / margem), atribuicao por ebook e por campanha (ROAS, buckets unattributed/organico), `FinanceSnapshot` idempotente; e do lado de alertas: kill switch ON -> `AlertLog` SENT, 2o toggle no throttle -> SUPPRESSED, setor CRITICAL detectado pelo ciclo real do COO -> `SECTOR_CRITICAL`, e `POST /alerts/test`.

### 10.2 Abrir as paginas (web)

Com `pnpm dev` + `pnpm dev:web` no ar (links de nav ja no `layout.tsx`):

- **Financeiro** — `http://localhost:3000/crm/finance`: DRE do dia, progresso da meta + projecao, contribuicao por ebook e por campanha, serie de snapshots.
- **Alertas** — `http://localhost:3000/crm/alerts`: feed de `AlertLog` (filtros), `AlertSettings` (canais/destinatarios/eventos/throttle) e botao de teste de canais.

### 10.3 Financeiro — endpoints e taxas

```bash
curl http://localhost:3001/finance/overview                 # DRE de hoje SP + meta
curl "http://localhost:3001/finance/dre?date=2026-06-10"
curl "http://localhost:3001/finance/by-ebook?date=2026-06-10"
curl "http://localhost:3001/finance/by-campaign?date=2026-06-10"
curl "http://localhost:3001/finance/snapshots?from=2026-05-12&to=2026-06-10"   # serie (default 30d)

# Persistir/atualizar o consolidado do dia (idempotente; default hoje)
curl -X POST http://localhost:3001/finance/snapshot \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d '{}'
```

As **taxas de pagamento** (Asaas PIX) sao configuraveis por env e entram no lucro liquido:

| Variavel | Default | Efeito |
|---|---|---|
| `ASAAS_FEE_PERCENT` | `0.99` | % por transacao paga (0,99 = 0,99%) |
| `ASAAS_FEE_FIXED_CENTS` | `49` | fixo por transacao paga (R$0,49) |
| `TARGET_DAILY_REVENUE_BRL` | `1000` | reaproveitado como meta diaria |

> Os defaults de taxa sao **placeholders plausiveis** — confirme com a operacao Asaas antes de tratar o lucro como contabil definitivo. A serie historica e alimentada pela rota `POST /finance/snapshot` (idempotente por dia); rode-a no fechamento ou pelo SLOW_TICK.

### 10.4 Alertas — configurar canais e destinatarios

`AlertSettings` (singleton no DB) tem prioridade; as envs sao apenas fallback de boot. Configure pela aba Alertas ou via API:

```bash
# Ler settings atuais (defaults fail-OPEN se ausente)
curl http://localhost:3001/alerts/settings

# Patch parcial (JWT): ligar EMAIL + WHATSAPP, definir destinatarios, throttle 30 min
curl -X PUT http://localhost:3001/alerts/settings \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{ "alertsEnabled": true, "channels": ["EMAIL","WHATSAPP"],
        "emailRecipients": ["adersonvitoria@gmail.com"],
        "whatsappRecipients": ["5599999999999"],
        "enabledEvents": [], "throttleMinutes": 30 }'

# Disparar um teste pelos canais habilitados (bypassa throttle)
curl -X POST http://localhost:3001/alerts/test \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d '{}'

# Listar o historico de alertas (filtros opcionais event/channel/status)
curl "http://localhost:3001/alerts?status=SENT&limit=20"
```

`enabledEvents: []` significa **todos** os eventos. Eventos: `KILL_SWITCH_ON`, `KILL_SWITCH_OFF`, `SECTOR_CRITICAL`, `ACTION_AUTO_FAILED`, `ACTION_HIGH_QUEUED`.

### 10.5 Ligar os canais reais

Por default tudo e stub (`USE_STUBS=true`). Para envio real:

| Canal | Envs (no `.env`) | Notas |
|---|---|---|
| **EMAIL** | `RESEND_API_KEY` (+ `USE_STUBS=false`) | reaproveita o `EmailPort`/`ResendEmailAdapter` da entrega |
| **WHATSAPP** | `WHATSAPP_PROVIDER=evolution` + `EVOLUTION_API_URL` + `EVOLUTION_API_KEY` + `EVOLUTION_INSTANCE` (+ `USE_STUBS=false`) | `POST {URL}/message/sendText/{instance}` com header `apikey`, body `{ number, text }` |

Outras envs de alerta: `ALERTS_ENABLED` (kill-switch global de boot), `ALERT_EMAIL_TO` / `ALERT_WHATSAPP_TO` (destinatarios fallback se `AlertSettings` ausente), `ALERT_THROTTLE_MINUTES` (default 60).

> **Atencao:** com `USE_STUBS=false` o `POST /alerts/test` dispara envios **reais**. Confirme o contrato da sua instancia Evolution (campo `number` vs `phone`, formato E.164 / sufixo `@s.whatsapp.net`) antes de habilitar WhatsApp em producao.

---

## 11. Operar Times / Mercado / QA / Pipeline de lancamento

> Extensao que organiza cada setor como um TIME (Especialista/Estrategista/Executor), adiciona o setor de Analise de Mercado (MARKET_RESEARCH) com pesquisa externa real (Serper.dev) e o setor de QA de ebooks (EBOOK_QA), e introduz o pipeline `createAndLaunchEbook` com **2 GATES**. Detalhe: `docs/SECTORS-TEAMS.md`, `docs/MARKET-RESEARCH.md`, `docs/EBOOK-QA.md`. Scores 0..100 (NAO centavos); strings pt-BR.

### 11.1 Smoke test E2E do pipeline (Postgres real, modo stub)

```bash
pnpm --filter @ebook-empire/api e2e:launch
```

Resultado esperado: `PASSARAM: 44   FALHARAM: 0`. Exercita ponta a ponta, com os dois GATES, contra Postgres real (MarketDataPort + LLM stub): `POST /market/scan` rankeia/persiste e `GET /market/top` devolve a #1 (SELECTED); GATE 1 (sem oportunidade nada e gerado); geracao DRAFT vinculada; loop de QA `NEEDS_FIX -> PASS` (publica) e `FAIL` (nao publica); auditoria de ebook existente + fix-loop relançando; e os `AgentRun(role+sector)` dos times.

> O `e2e-launch` usa um adapter-ponte (`qaCapabilityFrom`) para casar o contrato do `EbookQaService` ao do pipeline — ha um defeito de integracao documentado em `EBOOK-QA.md` A.5 a corrigir antes de confiar no caminho de producao automatico.

### 11.2 Analise de Mercado — rodar um scan e ver o ranking

Pre-requisito para gerar/lancar ebooks: ter uma `MarketOpportunity` SELECTED.

```bash
# Rodar a analise (roda o time MARKET_RESEARCH e persiste o ranking)
curl -X POST http://localhost:3001/market/scan \
  -H "Authorization: Bearer <TOKEN>"

# Ver as oportunidades rankeadas (filtros opcionais status/limit)
curl "http://localhost:3001/market/opportunities?limit=50"

# Ver a oportunidade de maior potencial ja selecionada
curl http://localhost:3001/market/top

# Disponibilidade + provider (stub|serper) + contagem
curl http://localhost:3001/market/health
```

**Env do Serper (pesquisa externa real):** por default tudo e stub (`USE_STUBS=true`). Para ligar o Serper.dev real, no `.env`:

```
USE_STUBS=false
MARKET_DATA_PROVIDER=serper
SERPER_API_KEY=<sua-chave-serper>
# opcionais (defaults): MARKET_SEARCH_GL=br  MARKET_SEARCH_HL=pt-br
# tetos:                MARKET_MAX_QUERIES_PER_RUN=10  MARKET_RESEARCH_WINDOW_DAYS=14
```

`USE_STUBS=true` **forca o stub** mesmo com `SERPER_API_KEY` setada. Custo Serper NAO entra em `llmCostCents`.

### 11.3 Auditar e corrigir ebooks (QA)

```bash
# Auditar 1 ebook (cria EbookAudit + AgentRun + Event EBOOK_AUDITED)
curl -X POST http://localhost:3001/quality/audit/<EBOOK_ID> \
  -H "Authorization: Bearer <TOKEN>"

# Loop corrigir -> reauditar -> relançar (bounded por QA_MAX_FIX_ITERATIONS)
curl -X POST http://localhost:3001/quality/fix/<EBOOK_ID> \
  -H "Authorization: Bearer <TOKEN>"

# Ultima auditoria + decisao do gate (canLaunch)
curl http://localhost:3001/quality/ebooks/<EBOOK_ID>/audit

# Lista de auditorias (filtros verdict/ebookId/limit/offset)
curl "http://localhost:3001/quality/audits?verdict=FAIL&limit=20"
```

Veredito determinismo: `BLOCKER` ou `score < QA_FAIL_SCORE` (40) => FAIL; `score >= QA_MIN_SCORE` (70) sem BLOCKER => PASS; senao NEEDS_FIX. So PASS libera o lancamento.

### 11.4 Os 2 GATES antes de lancar um ebook

O pipeline `createAndLaunchEbook` e o unico caminho legitimo para nascer um ebook vendavel, e impoe:

1. **GATE 1 (mercado):** `MarketResearchService.rankAndPick(ctx)` PRIMEIRO. Sem `MarketOpportunity` SELECTED, **nada e gerado** (para em `MARKET_GATE`). Garanta um `POST /market/scan` antes.
2. **GATE 2 (qualidade):** o ebook DRAFT gerado e auditado; so com `verdict === 'PASS'` o pipeline publica (status PUBLISHED + Product ativo). NEEDS_FIX entra no loop bounded; FAIL/esgotar => permanece DRAFT, nao publica.

### 11.5 Abrir os paineis (web)

Com `pnpm dev` + `pnpm dev:web` no ar (links de nav ja no `layout.tsx`: Times / Mercado / Qualidade):

- **Times** — `http://localhost:3000/crm/teams`: ultimo ciclo por setor (consome `GET /agents/runs` via `api.teamRuns`). Mostra setores vazios enquanto a rota nao expoe `role/sector/output` (ver `SECTORS-TEAMS.md` §7).
- **Mercado** — `http://localhost:3000/crm/market`: board de oportunidades rankeadas por potencial; botao "rodar analise" dispara `POST /market/scan`.
- **Qualidade** — `http://localhost:3000/crm/quality`: lista de `EbookAudit` (score/verdict/dimensoes), com auditar/corrigir.

---

## 12. Operar Marketplace (Hotmart + Kiwify) — FASE 3

> O `MarketplaceAgent` roda no loop **FAST** (`FAST_TICK_MS`, junto do COO): para cada `Ebook` PUBLISHED cujo `Product` ainda nao tem `MarketplaceListing` em um provedor, faz upload do PDF e cria o produto via `MarketplacePort.createProduct`, fazendo upsert da listing (`@@unique[productId, provider]`). Vendas chegam pelos **webhooks** Hotmart/Kiwify. Detalhe de estado em `docs/STATUS.md` (secao Marketplace). Dinheiro em `Int` centavos; strings pt-BR.

### 12.1 Os webhooks `/webhooks/{hotmart,kiwify}`

Ambos seguem o mesmo fluxo idempotente e respondem **200** no caminho feliz:

1. Valida a assinatura via `MarketplacePort.parseWebhook` — Hotmart por header **HOTTOK** (`HOTMART_WEBHOOK_TOKEN`); Kiwify por **HMAC-SHA256** no header `X-Kiwify-Signature` (`KIWIFY_WEBHOOK_SECRET`). Invalido => **401**.
2. Acha o `Product` via `MarketplaceListing.externalProductId` para o provedor. Desconhecido => 200 `ignored:'unknown_product'` (evita retry infinito no provedor).
3. **Pago** (`PURCHASE_COMPLETE`/`PURCHASE_APPROVED` na Hotmart; `paid`/`order_approved` na Kiwify): upsert `Customer` por email → `Order(status=PAID, marketplaceProvider)` + `Payment(provider)` → `Event(PAID)` idempotente. **NAO** cria `DeliveryGrant` (o marketplace entrega nativamente).
4. **Refund/chargeback**: `Order` → REFUNDED + `Event(REFUNDED)` idempotente.
5. **Idempotencia**: `Event @@unique([provider, externalEventId])` — reentrega responde 200 sem reaplicar efeitos.

**Atribuicao de afiliado**: quando o payload traz `affiliate_code` (Hotmart) / `affiliate_id` (Kiwify), o pedido grava `utmSource=hotmart|kiwify`, `utmMedium=afiliado`, `utmContent=<affiliateId>` (propagado ao `Event(PAID)`).

Configure no painel do provedor o webhook apontando para:

```
PUBLIC_BASE_URL/webhooks/hotmart      # header HOTMART-HOTTOK
PUBLIC_BASE_URL/webhooks/kiwify       # header X-Kiwify-Signature (HMAC)
```

Teste local (modo stub, assinatura do stub aceita qualquer header valido conforme o stub):

```bash
curl -X POST http://localhost:3001/webhooks/hotmart \
  -H "Content-Type: application/json" -H "X-HOTMART-HOTTOK: <token>" \
  -d '{ "event": "PURCHASE_COMPLETE", "data": { ... } }'
# 200 { received: true, provider: "HOTMART", orderId: "..." }
```

### 12.2 Ligar Hotmart/Kiwify reais

| Provedor | Envs (no `.env`) | Notas |
|---|---|---|
| **Hotmart** | `HOTMART_CLIENT_ID`, `HOTMART_CLIENT_SECRET`, `HOTMART_WEBHOOK_TOKEN` (+ `USE_STUBS=false`) | endpoints reais (`/products/v1.0.0/product`, upload `/file`) sao **best-effort** — revalidar em homologacao |
| **Kiwify** | `KIWIFY_API_KEY`, `KIWIFY_ACCOUNT_ID`, `KIWIFY_WEBHOOK_SECRET` (+ `USE_STUBS=false`) | endpoint `/v1/products`; mesma ressalva |

Comissao de afiliado nos marketplaces: `MARKETPLACE_AFFILIATE_COMMISSION_PCT` (default 50).

> **Wiring pendente**: o `MarketplaceAgent` so **publica** quando `ctx.ports.marketplace` esta populado no scheduler (`resolvePorts`). Hoje esse port nao e injetado, entao o agente roda mas degrada (resolve o provedor defensivamente). Os **webhooks funcionam independentemente** (resolvem o adapter localmente). Wiring alvo: `ports.marketplace = createMarketplaceAdapter(env, storage)`.

---

## 13. Operar Afiliados (FASE 4)

> O `AffiliateOutreachAgent` roda no loop **SLOW** (`SLOW_TICK_MS`, tick proprio fora do CYCLE_ORDER do CEO): seleciona `Affiliate` status=PROSPECT cujo `lastContactedAt` e null ou mais velho que `AFFILIATE_OUTREACH_COOLDOWN_DAYS` (default 7), gera copy pt-BR via LLM, envia email (e WhatsApp se houver port), cria `AffiliateOutreach` por canal, emite `Event(AFFILIATE_CONTACTED)` e atualiza `lastContactedAt`. Strings pt-BR.

### 13.1 Atribuicao de afiliado no checkout

O `POST /checkout` aceita um campo **opcional** `referral` no body (fora do `checkoutBodySchema`, lido cru):

```bash
curl -X POST http://localhost:3001/checkout \
  -H "Content-Type: application/json" \
  -d '{ "productId": "...", "customer": { ... },
        "referral": { "affiliateId": "afi_123", "source": "instagram" } }'
```

Quando presente, o pedido grava `utmSource=<source ou "afiliado">`, `utmMedium=afiliado`, `utmContent=<affiliateId>`, propagado ao `Event(PAID)` na confirmacao do pagamento — fechando a atribuicao de receita por afiliado.

### 13.2 Ligar canais reais do outreach

| Canal | Envs | Notas |
|---|---|---|
| **Email** | `RESEND_API_KEY` (+ `USE_STUBS=false`) | sempre disponivel; reusa o `EmailPort`/`ResendEmailAdapter` |
| **WhatsApp** | `WHATSAPP_PROVIDER=evolution` + `EVOLUTION_*` (+ `USE_STUBS=false`) | so dispara se `ctx.ports.whatsapp` estiver injetado **e** o afiliado tiver `whatsappNumber` |

Parametros: `AFFILIATE_OUTREACH_COOLDOWN_DAYS` (default 7), `AFFILIATE_COMMISSION_DEFAULT_PCT` (default 30).

> **Wiring pendente**: `ctx.ports.whatsapp` **nao** e populado no scheduler hoje — o agente contata **so por email** (WhatsApp degrada via `ctx.ports.whatsapp?`). Wiring alvo: `ports.whatsapp = createWhatsAppAdapter({ useStubs, whatsappProvider, evolutionApiUrl/Key/Instance })` em `resolvePorts`.

---

## 14. Novos ActionKinds do COO (COO-Scale)

> O COO (`OperationsAgent`) ganhou 4 alavancas de escala alem das de remediacao. Todas sao **LOW** (aplicadas automaticamente no loop FAST, sob guardrails/kill switch). Consistentes nas 4 localizacoes (schema/core/executor/levers).

| ActionKind | Reversivel? | O que faz | Params |
|---|---|---|---|
| `GENERATE_MORE_EBOOKS` | nao | gera N ebooks via `createAndLaunchEbook` (cada um respeita os 2 GATES: mercado + QA) | `{ niche?, count? }` (count 1..10) |
| `PAUSE_LISTING` | **sim** | desativa um `Product` (`active=false`); rollback religa a oferta | `{ productId }` |
| `BOOST_AFFILIATE_OUTREACH` | nao | dispara um ciclo do `AffiliateOutreachAgent` (contata o lote de PROSPECTs elegiveis) | — |
| `SEND_AFFILIATE_EMAIL` | nao | contata 1 afiliado especifico (`runForAffiliate`) | `{ affiliateId }` |

Como qualquer acao do COO: aparecem em `GET /crm/actions`, sao auditadas com `beforeState`/`afterState`, respeitam `maxAutoActionsPerCycle`/cooldown/kill switch, e `PAUSE_LISTING` pode ser revertida via `POST /crm/actions/:id/rollback` (as demais sao `reversible=false` — rollback no-op idempotente). Ver §9 para a operacao do Command Center.
