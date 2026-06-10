# Ebook Empire — Roadmap (ate operacao real)

> Fases de construcao e operacao. Cada fase tem entregaveis, dono(s) por arquivo (escrita disjunta) e criterio de aceite. A **Fase 0 (Fundacao) e bloqueante** para todas as outras — ela grava os contratos que todos leem (REGRA DE OURO).

## Princípios de execucao

- Escrita disjunta: cada arquivo tem UM dono. Ninguem edita `server.ts` (Fundacao ja registra rotas + scheduler).
- Stubs primeiro: todos os ports comecam como stub injetavel (`META_MODE=stub`, `EMAIL_PROVIDER=stub`, storage local). Real e plugado depois sem mexer nos agentes.
- Idempotencia desde o dia 1 em webhook e ticks.
- Tudo em centavos (`Int`), pt-BR nas strings de usuario.

---

## Fase 0 — Fundacao (BLOQUEANTE)

**Objetivo**: gravar o esqueleto e os contratos que todas as outras areas leem.

Entregaveis (dono = Fundacao):
- Raiz: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.env.example`, `.gitignore`, `README.md`.
- `prisma/schema.prisma` COMPLETO (11 modelos + enums da secao 3 da ARCHITECTURE).
- `packages/core/src/{index,types,schemas,ports}.ts` — tipos (`AgentContext`, `AgentRunResult`, `KPISnapshot`, `AgentPlan`, `AgentTask`), schemas Zod, e os 6 ports.
- `packages/{core,adapters,agents}/{package.json,tsconfig.json}`.
- `packages/agents/src/base.ts` — `abstract class Agent` (Template Method com ciclo de vida de `AgentRun`).
- `apps/api/src/{env.ts,db.ts,server.ts,scheduler.ts}` — `server.ts` importa e registra TODAS as rotas por caminho fixo e chama `startScheduler(app)`; `scheduler.ts` define os ticks (esqueleto).
- `apps/api/src/routes/health.ts` + stubs vazios das demais rotas (default export plugin).
- `apps/web/` scaffold Next.js 14 + `lib/api.ts`.
- `docs/STATUS.md` inicial.

Criterio de aceite: `pnpm install` ok; `npx prisma generate` ok; `pnpm -r typecheck` passa; `GET /health` responde; scheduler liga/desliga por `ENABLE_AGENTS` sem rodar agente nenhum ainda.

---

## Fase 1 — Conteudo e catalogo

**Objetivo**: gerar e publicar um ebook real e expo-lo como produto vendavel.

Entregaveis:
- `packages/adapters/src/llm.ts` (Anthropic real + stub) — `claude-sonnet-4-6` p/ conteudo.
- `packages/agents/src/content.ts` — gera outline+conteudo, cria `Ebook`+`Product` (DRAFT->PUBLISHED), emite `EBOOK_PUBLISHED`. Cooldown N ebooks/dia + checagem de duplicidade de nicho.
- `apps/api/src/lib/pdf.ts` — render do `contentMarkdown` em PDF (`pdfPath`).
- `apps/api/src/routes/ebooks.ts` — listar/detalhar catalogo; trigger admin de geracao.
- `apps/web/app/ebooks/page.tsx` — lista no dashboard.

Criterio de aceite: 1 ebook gerado, PDF em disco, 3 `Product` criados (ancora R$47, bump R$27, upsell R$97), visivel no dashboard. Revisao editorial minima antes de `PUBLISHED`.

---

## Fase 2 — Venda e entrega (PIX Asaas, webhook-first)

**Objetivo**: fluxo completo checkout -> pagamento -> entrega, idempotente.

Entregaveis:
- `packages/adapters/src/payment.ts` (Asaas real + stub), `email.ts` (nodemailer/Resend + stub), `storage.ts` (disco local + signed URL propria).
- `apps/api/src/routes/checkout.ts` (`POST /checkout`, `POST /checkout/webhook`) + services `checkout.service`, `webhook.service`.
- `apps/api/src/routes/delivery.ts` (`GET /delivery/:token`) + `delivery.service`.
- `packages/agents/src/sales.ts` (reconciliacao de Payment PENDING antigos) e `delivery.ts` (emite grant + email; reprocessa grants sem `emailSentAt`).
- `apps/web/app/orders/page.tsx`.

Criterio de aceite (com stubs): checkout cria Order(PENDING)+Payment(PENDING) e devolve qrCode/copia-e-cola; webhook `CONFIRMED/RECEIVED` transiciona Order->PAID em `$transaction`, cria DeliveryGrant unico e envia email; `GET /delivery/:token` valida hash+expiracao+contador e responde 302 p/ signed URL; webhook duplicado/fora de ordem nao duplica entrega (idempotencia `@@unique([provider, externalEventId])`); download atomico nao ultrapassa `maxDownloads`.

---

## Fase 3 — Agentes autonomos e orquestracao

**Objetivo**: loop autonomo dentro do processo Fastify.

Entregaveis:
- `packages/agents/src/orchestrator.ts` (`claude-opus-4-8`) — coleta `KPISnapshot`, guardrails deterministicos, plano Zod, `runCycle`.
- `packages/agents/src/analytics.ts` — unico calculador de KPI (ROAS/CAC/CPA null-guarded).
- `packages/agents/src/index.ts` — barrel + `createAgentRegistry(ctx)`.
- `apps/api/src/scheduler.ts` — preenche FAST_TICK (~60s reativos) + SLOW_TICK (~15min orchestrator), lock anti-reentrancia, `take:N`.
- `apps/api/src/routes/agents.ts` (`GET /agents/runs`, `POST /agents/:name/run`).
- `apps/web/app/agents/page.tsx`.

Criterio de aceite: ticks rodam gated por `ENABLE_AGENTS`; cada run grava `AgentRun` (SUCCESS/FAILED/SKIPPED) com duracao/tokens/custo; orchestrator alterna modo crescer/sustentar conforme faturamento vs meta; guardrails vencem o LLM; reentrancia impedida.

---

## Fase 4 — Marketing e trafego (stub -> live)

**Objetivo**: social + ads + otimizacao de budget.

Entregaveis:
- `packages/adapters/src/instagram.ts` (Meta Graph + stub) e `ads.ts` (Meta Marketing + stub).
- `packages/agents/src/social.ts` (gera copy/criativo, agenda/publica, fila SCHEDULED) e `traffic.ts` (cria/ajusta campanhas, UTMs sempre, guardrails de budget).
- `apps/api/src/routes/social.ts` e `ads.ts`.
- `apps/web/app/social/page.tsx` e `app/ads/page.tsx`.

Criterio de aceite (stub): SocialAgent drena fila de posts idempotentemente; TrafficAgent escala/pausa por ROAS com janela minima de amostragem, passo limitado, teto `MAX_AD_BUDGET_BRL`, `updateBudget` SET absoluto, kill-switch funcional; AnalyticsAgent casa spend (`AdInsight`) com receita (`Order PAID`) por `utmCampaign`.

---

## Fase 5 — Go-live controlado (real)

**Objetivo**: trocar stubs por integracoes reais, instancia unica.

Entregaveis:
- Asaas real (chave + `ASAAS_WEBHOOK_TOKEN`), webhook publico configurado.
- Email real (Resend/SMTP), storage real (ou disco em volume persistente).
- `META_MODE=live` com conta de anuncios + BM reserva; compliance de copy pt-BR.
- Reserva de capital de giro R$3–5k provisionada.
- Budget inicial R$150/dia (Semana 1 da rampa de `VIABILITY.md`).

Criterio de aceite: primeira venda real entregue automaticamente; webhook real idempotente; dashboard mostrando KPIs reais; nenhum gasto de ads acima do teto.

---

## Fase 6 — Escala ate R$1.000/dia

**Objetivo**: atingir e sustentar a meta de faturamento bruto.

Acoes:
- Rampa de budget 4 semanas (R$150 -> R$350 -> R$600 -> R$1.000/dia).
- Esteira continua de novos ebooks (ContentAgent) para combater saturacao de nicho.
- Producao continua de criativos (SocialAgent) para manter CPV <= R$1,00.
- Monitorar reembolso (alvo < 10%) e ROAS (alvo ~2,0x).
- Orchestrator em modo sustentar/otimizar quando faturamento >= meta.

Criterio de aceite: faturamento bruto **>= R$1.000/dia** sustentado por >= 7 dias com ROAS >= 1,8x e lucro liquido positivo (~R$280–530/dia).

---

## Hardening / pos-MVP (continuo)

- **Multi-instancia**: trocar lock em memoria por Postgres advisory lock por agente/tick.
- **Crescimento de `Event`**: rollup periodico + particionamento por data.
- **Reconciliacao AdInsight x Event**: job que detecta drift.
- **Mercado Pago**: segundo `PaymentProvider` via `PaymentPort` (sem mexer nos agentes).
- **Gate de qualidade de conteudo** mais forte (anti-duplicacao semantica).
- **Observabilidade**: custo de LLM agregado por dia via `AgentRun`.

---

## Caminho operacional ate R$1.000/dia (a partir do estado atual)

> O nucleo ja esta FUNCIONAL em modo stub (ver `STATUS.md`). A sequencia abaixo e o que falta para transformar o sistema testado em **receita real**, sem reescrever agentes — so trocando stubs por integracoes reais e abrindo budget gradualmente.

1. **Provar o trilho contabil (banco real).** Rodar `prisma migrate` e exercitar `checkout → webhooks/asaas → download` ponta a ponta uma vez. Criterio: 1 Order chega a `PAID`/`DELIVERED` com `DeliveryGrant` unico e email enviado.
2. **Ligar pagamento real (Asaas).** `USE_STUBS=false`, `PAYMENT_PROVIDER=asaas`, chaves + `ASAAS_WEBHOOK_TOKEN`; webhook publico apontando para `PUBLIC_BASE_URL/webhooks/asaas` (sandbox primeiro). Criterio: primeira **venda real** entregue automaticamente, webhook idempotente. **Receita > 0 antes de gastar em ads.**
3. **Ligar entrega real.** Email (Resend) + storage (disco em volume persistente ou S3). Criterio: cliente recebe link e baixa dentro do limite/expiracao.
4. **Ligar trafego pago (Meta) com budget minimo.** Conta de anuncios + BM reserva, compliance de copy pt-BR. Budget **R$150/dia** (Semana 1 da rampa de `VIABILITY.md`), teto `MAX_AD_BUDGET_BRL`. Foco: achar criativo com **CPV <= R$1,00**. Reserva de capital de giro **R$3–5k** provisionada antes deste passo.
5. **Estabilizar ROAS.** `TrafficAgent` so escala apos janela minima de amostragem e **ROAS >= ~1,8–2,0x por 2 ciclos**; `AnalyticsAgent` casa spend (`AdInsight`) com receita (`Order PAID`) por `utmCampaign`. Manter AOV ~R$72 (ancora R$47 + bump R$27 + upsell R$97). Criterio: ROAS >= 1,8x estavel.
6. **Escalar ROAS ate a meta.** Rampa de budget 4 semanas (R$150 → R$350 → R$600 → R$1.000/dia), passo limitado (+~20%/ciclo). Esteira continua de **novos ebooks** (ContentAgent) e **criativos** (SocialAgent) para combater saturacao e segurar o CPV. Orchestrator em modo sustentar quando faturamento >= meta. Criterio: **>= R$1.000/dia bruto sustentado por >= 7 dias** com ROAS >= 1,8x e lucro liquido positivo (~R$280–530/dia).

Risco dominante (de `VIABILITY.md`): o **CPV/CAC e o unico fator decisivo**. CPV ~R$1,50 leva todos os cenarios a break-even/prejuizo — por isso a producao continua de criativos e inegociavel. As taxas de pagamento **nao** sao o fator decisivo.

## Dependencias entre fases

```
Fase 0 (Fundacao) ──► todas
Fase 1 (Conteudo) ──► Fase 2 (precisa de Product) ; Fase 4 (Social promove Product)
Fase 2 (Venda)    ──► Fase 3 (Analytics precisa de Order/Payment) ; Fase 5
Fase 3 (Agentes)  ──► Fase 4 (orchestrator agenda Social/Traffic)
Fase 4            ──► Fase 5 ──► Fase 6
```
