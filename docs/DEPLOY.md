# Ebook Empire — DEPLOY (runbook de producao)

> Runbook passo-a-passo para subir a **API** (`apps/api`, Fastify) em producao no
> **Railway** com banco **Neon** (Postgres serverless). Convencoes do projeto: dinheiro em
> `Int` centavos BRL; strings em pt-BR; env validado por Zod em `apps/api/src/env.ts`
> (env invalido **derruba a API no boot** — fail-fast).
>
> **Legenda de responsabilidade:**
> - **MANUAL** = voce faz no dashboard do provedor (Neon/Railway). Nao ha como automatizar.
> - **AUTOMATIZADO** = ja vem definido no repo (`railway.json` / `nixpacks.toml`) e roda sozinho no build/deploy.
>
> O loop autonomo roda **dentro do processo da API** via `setInterval` (loop SLOW do CEO + loop FAST do COO/Marketplace) — **nao ha worker separado** para provisionar. Ver `RUNBOOK.md` §6 e §9.

---

## 0. Visao geral do que e automatizado vs manual

| Item | Onde | Responsavel |
|---|---|---|
| Build (`pnpm install --frozen-lockfile` + `prisma generate` + build do `apps/api`) | `railway.json` `build.buildCommand` / `nixpacks.toml` `[phases.build]` | **AUTOMATIZADO** |
| Start (`node apps/api/dist/server.js`) | `railway.json` `deploy.startCommand` / `nixpacks.toml` `[start]` | **AUTOMATIZADO** |
| Healthcheck (`/health`, timeout 30s, restart ON_FAILURE x3) | `railway.json` `deploy` | **AUTOMATIZADO** |
| **Release Command** (`prisma migrate deploy`) | Dashboard Railway → Settings → Deploy | **MANUAL** (ver §3) |
| Criar projeto Neon + pegar `DATABASE_URL` | Dashboard Neon | **MANUAL** (ver §1) |
| Criar servico Railway apontando para o repo | Dashboard Railway | **MANUAL** (ver §2) |
| Volume persistente em `/data` + `STORAGE_DIR=/data/storage` | Dashboard Railway | **MANUAL** (ver §4) |
| Preencher todas as envs de `.env.production.example` | Dashboard Railway → Variables | **MANUAL** (ver §5) |
| Ligar canais reais (Asaas/Resend/Meta/Evolution/Hotmart/Kiwify/Serper) | Dashboard Railway + paineis dos provedores | **MANUAL** (ver §6) |

Arquivos de referencia ja no repo:
- `railway.json` — builder NIXPACKS, build/start/healthcheck.
- `nixpacks.toml` — paridade com o railway.json (Node 20, pnpm 9.15.0, build do `apps/api`).
- `.env.production.example` — todas as variaveis de producao (copie os **nomes**, preencha os **valores**).

---

## 1. Criar o banco no Neon (MANUAL)

1. Crie uma conta/projeto em <https://neon.tech> → **New Project**. Regiao recomendada: `aws-us-east-2` (ou a mais proxima do Railway).
2. Crie/anote o database `ebook_empire` (ou use o default `neondb`).
3. Em **Connection Details**, copie a connection string do tipo **Pooled connection** (recomendado para serverless) OU **Direct connection**. Garanta que ela termina com `?sslmode=require` — o Neon exige SSL.

   ```
   DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx-pooler.us-east-2.aws.neon.tech/ebook_empire?sslmode=require
   ```

   > Se usar a string **pooled**, o `migrate deploy` (§3) funciona normalmente. Caso o Neon recomende uma URL direta separada para migrations, use a direta no Release Command e a pooled em runtime.
4. Guarde essa `DATABASE_URL` — sera a env mais importante do Railway (§5).

---

## 2. Criar o servico no Railway (MANUAL)

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo** → selecione o repositorio do `ebook-empire`.
2. O Railway detecta o `railway.json`/`nixpacks.toml` na raiz e usa o builder **NIXPACKS** automaticamente. **Nao** e preciso configurar build/start manualmente — eles ja estao versionados:
   - Build: `pnpm install --frozen-lockfile && pnpm --filter @ebook-empire/api run prisma:generate && pnpm --filter @ebook-empire/api build`
   - Start: `node apps/api/dist/server.js`
   - Healthcheck: `GET /health`, timeout 30s, restart `ON_FAILURE` (max 3).
3. **Root Directory**: deixe na raiz do repo (`/`). O monorepo pnpm e instalado inteiro; o build filtra `@ebook-empire/api` (que compila `core`+`agents`+`adapters` como dependencias).
4. **NAO faca o primeiro deploy ainda** — primeiro configure o Release Command (§3), o volume (§4) e as variaveis (§5), senao a API sobe sem tabelas / sem chaves e o boot falha no Zod.

---

## 3. Configurar o RELEASE COMMAND (migrations) — MANUAL

As migrations **nao** rodam no build (o build so faz `prisma generate`). Em producao, aplique-as no **Release Command** do Railway, que roda uma vez por deploy, **antes** do start:

1. Railway → seu servico → **Settings** → **Deploy** → **Custom Release Command**.
2. Cole **exatamente**:

   ```
   npx prisma migrate deploy --schema prisma/schema.prisma
   ```

> **NUNCA** use `prisma migrate dev` em producao — ele tenta criar/alterar migrations e pode reescrever o historico. Em producao e sempre `migrate deploy` (apenas aplica migrations ja commitadas). Esta e uma regra dura do projeto.

O `migrate deploy` usa a `DATABASE_URL` do ambiente (a do Neon, §1).

---

## 4. Anexar VOLUME persistente em `/data` (MANUAL)

A entrega de ebooks usa **storage local em disco** (`createStorageAdapter({ driver: 'local' })`) com URL assinada propria. O filesystem do container do Railway e efemero — sem volume, PDFs gerados somem a cada deploy. (O `S3StorageAdapter` ainda e esqueleto e lanca em runtime — ver `STATUS.md`.)

1. Railway → seu servico → **Settings** → **Volumes** → **New Volume**.
2. **Mount path**: `/data`.
3. Adicione a variavel de ambiente:

   ```
   STORAGE_DIR=/data/storage
   ```

   O adapter cria o subdiretorio `storage` dentro do volume. O `signingSecret` das URLs assinadas reusa o `JWT_SECRET`.

---

## 5. Preencher as variaveis de ambiente (MANUAL)

Railway → seu servico → **Variables**. Copie os **nomes** de `.env.production.example` e preencha os **valores**. NUNCA commite valores reais.

**Obrigatorias para o boot (Zod fail-fast):**

| Variavel | Valor |
|---|---|
| `DATABASE_URL` | a string do Neon do §1 (com `?sslmode=require`) |
| `JWT_SECRET` | segredo aleatorio forte (>= 32 chars recomendado) |
| `NODE_ENV` | `production` |
| `USE_STUBS` | `false` (ver §6 antes de virar) |
| `STORAGE_DIR` | `/data/storage` (§4) |
| `PUBLIC_BASE_URL` | URL publica da API (ex. `https://<servico>.up.railway.app`) — usada nos links de download/email/webhooks |
| `CORS_ORIGIN` | origem do frontend autorizada (ex. `https://app.seu-dominio.com`) |

> **PORT**: o Railway injeta `PORT` automaticamente; a API ja escuta nele (default 3001 em dev). Nao e preciso setar manualmente.

**Chaves de integracao (vazias = aquele canal fica em stub / desligado):**

`ANTHROPIC_API_KEY`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`, `RESEND_API_KEY`,
`SERPER_API_KEY`, `META_GRAPH_TOKEN`, `META_AD_ACCOUNT_ID`,
`EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`,
`HOTMART_CLIENT_ID`, `HOTMART_CLIENT_SECRET`, `HOTMART_WEBHOOK_TOKEN`,
`KIWIFY_API_KEY`, `KIWIFY_ACCOUNT_ID`, `KIWIFY_WEBHOOK_SECRET`.

**Parametros operacionais (tem default sensato em `.env.production.example`):**

`MARKETPLACE_AFFILIATE_COMMISSION_PCT=50`, `AFFILIATE_OUTREACH_COOLDOWN_DAYS=7`,
`AFFILIATE_COMMISSION_DEFAULT_PCT=30`, `UPSELL_DELAY_HOURS=24`, `UPSELL_MAX_FOLLOWUPS=3`,
`TARGET_DAILY_REVENUE_BRL=1000`, `WEEKLY_EBOOK_TARGET=3`, `MAX_AD_BUDGET_BRL=200`,
`ALERT_EMAIL_TO=...`.

> Para WhatsApp real, alem das 3 `EVOLUTION_*` voce precisa de `WHATSAPP_PROVIDER=evolution` (default `stub`).
> Para Serper real: `MARKET_DATA_PROVIDER=serper` (+ `SERPER_API_KEY` + `USE_STUBS=false`).
> Para Asaas real: `PAYMENT_PROVIDER=asaas`.

---

## 6. Ligar os canais reais UM A UM (MANUAL)

Estrategia de go-live segura: suba primeiro com `USE_STUBS=false` mas com as chaves
**vazias** (cada port degrada para stub / no-op), depois ligue um canal, faça um deploy,
verifique, e so entao ligue o proximo. Ordem sugerida:

1. **Banco + boot**: deploy inicial, confirme `/health` (§7) e que o Release Command aplicou as migrations.
2. **Anthropic** (`ANTHROPIC_API_KEY`): geracao de conteudo e planejamento do CEO com LLM real.
3. **Asaas** (`ASAAS_API_KEY` + `ASAAS_WEBHOOK_TOKEN` + `PAYMENT_PROVIDER=asaas`): cobranca PIX. Comece em sandbox (`ASAAS_BASE_URL` se aplicavel — o adapter usa producao por default). No painel Asaas, configure o webhook para `PUBLIC_BASE_URL/webhooks/asaas`.
4. **Resend** (`RESEND_API_KEY`): email de entrega **e** alertas por email.
5. **Meta** (`META_GRAPH_TOKEN` + `META_AD_ACCOUNT_ID`): Instagram + Ads.
6. **Evolution / WhatsApp** (`WHATSAPP_PROVIDER=evolution` + 3 `EVOLUTION_*`): alertas + outreach de afiliados por WhatsApp. **Confirme o contrato da sua instancia** (campo `number` vs `phone`, E.164 / sufixo `@s.whatsapp.net`) antes de virar — ver `RUNBOOK.md` §10.5. O `ports.whatsapp` JA e injetado no scheduler (`resolvePorts`), entao o AffiliateOutreachAgent usa WhatsApp quando `WHATSAPP_PROVIDER=evolution` + chaves preenchidas; sem isso, degrada para email.
7. **Serper** (`SERPER_API_KEY` + `MARKET_DATA_PROVIDER=serper`): pesquisa de mercado externa real.
8. **Hotmart** (`HOTMART_CLIENT_ID` + `HOTMART_CLIENT_SECRET` + `HOTMART_WEBHOOK_TOKEN`): no painel Hotmart, aponte o webhook (HOTTOK) para `PUBLIC_BASE_URL/webhooks/hotmart`. **Revalide os endpoints/payloads reais da Hotmart em homologacao** — os caminhos `/products/v1.0.0/product` e upload `/file` sao best-effort baseados na doc publica.
9. **Kiwify** (`KIWIFY_API_KEY` + `KIWIFY_ACCOUNT_ID` + `KIWIFY_WEBHOOK_SECRET`): no painel Kiwify, aponte o webhook (assinatura HMAC `X-Kiwify-Signature`) para `PUBLIC_BASE_URL/webhooks/kiwify`. Mesma ressalva de homologacao da Hotmart.

> **MarketplaceAgent**: o `ports.marketplace` JA e injetado no scheduler (`resolvePorts`), entao ele publica listings no loop FAST quando as chaves Hotmart/Kiwify estao preenchidas. Os **webhooks** Hotmart/Kiwify tambem funcionam independentemente (resolvem o adapter localmente em cada rota).

---

## 7. Verificar a saude (MANUAL/automatizado)

Apos cada deploy:

```bash
curl https://<sua-api>/health
# 200 { "status": "ok", "service": "ebook-empire-api", "db": "ok", "timestamp": "..." }
```

- `db: "ok"` confirma que a API alcanca o Neon (`SELECT 1`). `db: "down"` => 503 (a connection string / SSL / migrations estao erradas).
- O Railway tambem usa `/health` como healthcheck nativo (definido no `railway.json`): se falhar no boot, reinicia ate 3x.

Outros checks uteis (ver `RUNBOOK.md`):

```bash
curl https://<sua-api>/agents/status        # estado do scheduler + ultimo ciclo + KPIs
curl https://<sua-api>/analytics/kpis        # ROAS/CAC/CPA/receita/lucro do dia (publica)
```

---

## 8. Estado do wiring autonomo (FEITO) e ressalvas reais

O wiring de ports no scheduler (`apps/api/src/scheduler.ts`, `resolvePorts`) ja esta COMPLETO:

- **`ports.marketplace`** injetado (`createMarketplaceAdapter(env, ports.storage)`) — o `MarketplaceAgent` publica listings Hotmart/Kiwify no loop FAST quando as chaves estao preenchidas.
- **`ports.whatsapp`** injetado (`createWhatsAppAdapter({ useStubs, whatsappProvider, evolution* })`) — o `AffiliateOutreachAgent` usa WhatsApp quando `WHATSAPP_PROVIDER=evolution`.
- O loop do COO cobre os **10 setores** e propoe/aplica os ActionKinds novos (provado em `scripts/e2e-coo-sectors.ts`).

**Ressalvas reais antes de confiar 100% em producao:**
- **Hotmart/Kiwify adapters sao best-effort**: os endpoints/payloads (`/products/v1.0.0/product` + upload `/file`; `/v1/products`) seguem a doc publica — REVALIDE em homologacao com chaves reais antes de tratar a publicacao de listings como confiavel.
- **WhatsApp Evolution**: confirme o contrato de numero da sua instancia (E.164 / `@s.whatsapp.net`) antes de virar.
- **Asaas**: o adapter usa base URL de producao por default — comece em sandbox.

---

## 9. Checklist final de go-live

- [ ] Neon criado, `DATABASE_URL` com `sslmode=require` copiada.
- [ ] Servico Railway criado a partir do repo (NIXPACKS auto-detectado).
- [ ] Release Command = `npx prisma migrate deploy --schema prisma/schema.prisma`.
- [ ] Volume `/data` anexado + `STORAGE_DIR=/data/storage`.
- [ ] Envs obrigatorias preenchidas (`DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=production`, `USE_STUBS=false`, `PUBLIC_BASE_URL`, `CORS_ORIGIN`).
- [ ] Deploy inicial OK + `/health` => `db: ok`.
- [ ] Canais reais ligados um a um, com webhooks apontados para `PUBLIC_BASE_URL/webhooks/{asaas,hotmart,kiwify}`.
- [ ] Hotmart/Kiwify revalidados em homologacao antes de confiar na publicacao de listings.
