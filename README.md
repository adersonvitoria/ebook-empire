# Ebook Empire

Empresa autonoma multi-agente que **gera, vende e entrega ebooks** online, faz marketing no Instagram, roda trafego pago no Meta e analisa resultados. Meta de negocio: **faturamento bruto >= R$1.000/dia**.

O sistema opera como uma pequena "empresa de software": um orchestrator (CEO) le os KPIs do dia e coordena agentes especializados (conteudo, vendas, entrega, social, trafego, analytics) que rodam **dentro do processo da API** via scheduler — sem worker separado.

> Estado atual em uma frase: **nucleo funcional e coerente entre modulos, exercitado por 115 testes (stubs)**; integracoes externas reais e validacao contra Postgres real ainda pendentes. Detalhe honesto por modulo em [`docs/STATUS.md`](docs/STATUS.md).

---

## O que e

- **Geracao de conteudo**: o `ContentAgent` usa LLM (`claude-sonnet-4-6`) para produzir outline + conteudo de um ebook, renderiza PDF e cria os `Product`s vendaveis (ancora R$47 + order-bump R$27 + upsell R$97).
- **Venda (PIX, webhook-first)**: checkout cria `Order`+`Payment` e gera cobranca PIX (Asaas). O webhook confirma o pagamento de forma idempotente e dispara a entrega.
- **Entrega**: ao pagar, gera-se um `DeliveryGrant` com token de download de uso limitado (hash no banco, token plano so no email) e envia-se o email com o link.
- **Marketing**: o `SocialAgent` gera legendas/criativos e publica no Instagram; o `TrafficAgent` cria/ajusta campanhas no Meta dentro de guardrails de budget e ROAS.
- **Analytics**: o `AnalyticsAgent` e o **unico** calculador de KPI — agrega `Event`/`Order`/`Payment`/`AdInsight` e produz o `KPISnapshot` (ROAS/CAC/CPA/receita/lucro, sempre null-guarded).
- **Orchestrator (CEO)**: le o `KPISnapshot`, aplica guardrails deterministicos e so entao usa LLM (`claude-opus-4-8`) para o plano. Alterna entre **modo crescer** (faturamento < meta) e **modo sustentar/otimizar** (faturamento >= meta).
- **Dashboard interno** (Next.js): catalogo de ebooks, pedidos, posts sociais, campanhas e historico de execucoes dos agentes.

A viabilidade financeira (por que R$1.000/dia e atingivel apenas numa janela estreita de AOV/CPV/ROAS) esta em [`docs/VIABILITY.md`](docs/VIABILITY.md).

---

## Arquitetura resumida

**Hexagonal / Ports & Adapters.** `packages/core` define os PORTS (interfaces) e tipos; `packages/adapters` implementa cada port com uma versao **real + stub injetavel** (BR-first); agentes e rotas dependem so dos ports. Stubs sao deterministicos e nao fazem chamada externa — o sistema roda fim-a-fim sem nenhuma chave com `USE_STUBS=true`.

Convencoes invioláveis:

- **Dinheiro sempre em centavos** (`Int`, BRL). Conversao para `R$` so na UI.
- **Idempotencia** em tudo disparado por webhook ou tick (`@@unique`, transicoes que nunca retrocedem, `take:N`).
- **Fonte unica de verdade por dominio**: `Order` = faturamento contabil; `AdInsight` = spend/ROAS de dashboard; `Event` = funil/auditoria; `AnalyticsAgent` = unico calculador de KPI. Nunca somar as tres fontes de receita.
- **Escrita disjunta**: cada arquivo tem UM dono. Agentes de implementacao preenchem apenas seu arquivo de rota/agente; **nunca editam `apps/api/src/server.ts`**, que ja registra todas as rotas por caminho fixo e liga o scheduler.

Contrato mestre completo em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (inclui as decisoes finais D1–D10 sobre conflitos de modelagem).

---

## Layout do monorepo

```
ebook-empire/
├── package.json                 # workspaces pnpm + scripts raiz
├── pnpm-workspace.yaml
├── tsconfig.base.json           # config TS compartilhada (composite: true)
├── .env.example                 # todas as variaveis de ambiente
├── docs/
│   ├── ARCHITECTURE.md          # contrato mestre (REGRA DE OURO)
│   ├── VIABILITY.md             # modelo financeiro (meta R$1.000/dia)
│   ├── ROADMAP.md               # fases ate a operacao real
│   ├── RUNBOOK.md               # passo a passo operacional + onde plugar chaves
│   └── STATUS.md                # funcional vs stub vs pendente, por modulo
├── prisma/
│   └── schema.prisma            # 11 modelos + enums; Fundacao escreve, todos leem
├── packages/
│   ├── core/                    # PORTS + tipos + schemas Zod (sem runtime externo)
│   │   └── src/{index,types,schemas,ports}.ts
│   ├── adapters/                # impl real + stub de cada port (BR-first)
│   │   └── src/{index,llm,payment,email,storage,instagram,ads}.ts
│   └── agents/                  # runtime de agentes
│       └── src/{index,base,orchestrator,content,sales,delivery,social,traffic,analytics}.ts
└── apps/
    ├── api/                     # Fastify 4 + Prisma 6
    │   └── src/
    │       ├── env.ts           # validacao de env (Zod) — fonte unica do env
    │       ├── db.ts            # PrismaClient singleton
    │       ├── server.ts        # registra TODAS as rotas + startScheduler (NAO editar)
    │       ├── scheduler.ts     # unico dono do setInterval
    │       ├── lib/pdf.ts       # render do ebook em PDF
    │       └── routes/{health,ebooks,checkout,delivery,social,ads,agents}.ts
    └── web/                     # Next.js 14 App Router (dashboard interno)
        └── app/{layout,page,ebooks,orders,social,ads,agents}/... + lib/api.ts
```

Grafo de dependencias: `core` (nada de runtime externo) ← `adapters`/`agents` ← `apps/api`. O `apps/web` so fala HTTP com a API (nao importa pacotes internos).

### Rotas da API (estado atual)

| Arquivo | Endpoints |
|---|---|
| `health.ts` | `GET /health` (faz `SELECT 1` no banco) |
| `ebooks.ts` | `GET /ebooks`, `POST /ebooks/generate` (admin) |
| `checkout.ts` | `POST /checkout`, `POST /webhooks/asaas`, `GET /orders` |
| `delivery.ts` | `GET /download/:token`, `GET /storage/object`, `POST /delivery/retry/:orderId` (admin) |
| `social.ts` | `GET /social/posts`, `POST /social/posts`, `POST /social/posts/:id/publish` |
| `ads.ts` | `GET /ads/campaigns`, `POST /ads/campaigns`, `GET /analytics/kpis` |
| `agents.ts` | `GET /agents/runs`, `GET /agents/status`, `POST /agents/cycle` (admin) |

---

## Como rodar localmente

Pre-requisitos: **Node 20+**, **pnpm 9.15+**, **PostgreSQL** acessivel.

```bash
# 1. Dependencias
pnpm install

# 2. Configuracao
cp .env.example .env
#   Por padrao .env ja vem com USE_STUBS=true — roda fim-a-fim sem nenhuma chave externa.
#   Ajuste apenas DATABASE_URL para o seu Postgres e JWT_SECRET (>= 8 chars).

# 3. Prisma (obrigatorio apos clone ou mudanca de schema)
pnpm prisma:generate          # gera @prisma/client (pre-requisito do typecheck/build)
pnpm prisma:migrate           # cria as tabelas no banco

# 4. API (Fastify) — porta 3001 por padrao
pnpm dev

# 5. Dashboard (Next.js) — porta 3000, em outro terminal
pnpm dev:web
```

> `prisma generate` e **pre-requisito** de `pnpm typecheck`/`pnpm build`: sem o `@prisma/client` gerado, os pacotes `agents` e `api` falham por falta de tipos. O cliente nao e versionado (gera-se pos-clone).

Verificacao:

```bash
pnpm -r test                  # Vitest em core/adapters/agents/api (115 testes com stubs)
curl http://localhost:3001/health
```

### Disparar um ciclo do orchestrator

Com `ENABLE_AGENTS=true`, o scheduler ja roda o ciclo lento (`SLOW_TICK_MS`, default 15 min) automaticamente. Para forcar um ciclo na hora:

```bash
# Rota protegida por JWT (fastify.authenticate)
curl -X POST http://localhost:3001/agents/cycle -H "Authorization: Bearer <TOKEN>"

# Observabilidade (publicas):
curl http://localhost:3001/agents/status      # estado do scheduler + ultimo ciclo + KPIs do dia
curl http://localhost:3001/agents/runs        # historico de AgentRun
```

Passo a passo operacional completo (subir banco, seed, stub vs real, onde plugar cada chave) em [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

## Modelo de operacao autonoma

1. O **scheduler** (`apps/api/src/scheduler.ts`) e o unico dono do `setInterval`, ligado por `ENABLE_AGENTS`. Roda dois ritmos: tick rapido (agentes reativos idempotentes) e tick lento (`orchestrator.runCycle`).
2. O **AnalyticsAgent** calcula o `KPISnapshot` do dia (receita, ROAS, CAC, CPA, lucro) — fonte unica de KPI.
3. O **Orchestrator (CEO)** le esse snapshot, aplica **guardrails deterministicos** (que sempre vencem o LLM: nunca escalar budget abaixo do ROAS minimo; nunca entregar sem pagamento confirmado; teto `MAX_AD_BUDGET_BRL`) e so entao usa o LLM de planejamento (`claude-opus-4-8`) para os trade-offs ambiguos, produzindo um `AgentPlan` validado por Zod.
4. Conforme o plano, os agentes-filho atuam: `Content` gera novos ebooks, `Social` publica criativos, `Traffic` ajusta campanhas, `Sales` reconcilia pagamentos, `Delivery` emite grants e emails.
5. Cada execucao grava um `AgentRun` (`RUNNING` → `SUCCESS`/`FAILED`/`SKIPPED`) com duracao, tokens e custo — observavel no dashboard e em `GET /agents/runs`.

Funcao objetivo: `faturamento_dia < meta` → **modo crescer**; `faturamento_dia >= meta` → **modo sustentar/otimizar**. O caminho operacional ate R$1.000/dia (ligar pagamento real → trafego pago → escalar ROAS) esta em [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Regra de ouro (para todo implementador)

Antes de codar qualquer agente/rota/adapter, **leia** `prisma/schema.prisma`, `packages/core/src/{types,schemas,ports}.ts` e `packages/agents/src/base.ts` ja gravados pela Fundacao e alinhe nomes exatos de tipos/modelos/enums. **Nao invente tipos divergentes nem modelos paralelos. Nunca edite `apps/api/src/server.ts`.**
