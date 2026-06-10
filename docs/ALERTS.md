# ALERTS — Alertas Externos do Command Center

> Feature 1 da extensao do CRM/Command Center autonomo do **Ebook Empire**.
> Dispara notificacoes externas (EMAIL + WHATSAPP) quando eventos operacionais
> criticos acontecem, sem nunca derrubar o ciclo do COO nem a resposta HTTP.
>
> **Convencoes do projeto** (herdadas, nao reinventadas):
> - Monorepo pnpm, Node 20, TypeScript ESM.
> - Strings de usuario em **pt-BR**.
> - Dinheiro em Int centavos (irrelevante aqui — alertas nao movem dinheiro).
> - Adapters por **Ports & Adapters**: real + stub, selecionados por `USE_STUBS`.
> - Para typecheck limpo: `pnpm --filter @ebook-empire/agents build` ANTES do
>   typecheck de `apps/api` (consome `dist/*.d.ts`).

---

## 1. Visao geral (3 camadas)

```
gatilho (kill switch / COO / executor)
   |  ctx.alert?.notify({ event, sector?, severity?, context? })   <- interface fina, best-effort
   v
AlertService  (packages/agents/src/alerts/alert-service.ts)        <- UNICO dono da regra de negocio
   |  monta title/body pt-BR, le AlertSettings, dedupe/throttle, persiste AlertLog
   v
NotificationPort.send(AlertMessage)  (porta no core)
   |  CompositeNotificationAdapter faz fan-out
   +-- EmailAlertChannel    -> adapta o EmailPort existente (Resend real / StubEmail)
   +-- EvolutionWhatsAppChannel / StubWhatsApp -> Evolution API
```

Decisao-chave: **o AlertService recebe a `NotificationPort` por construtor (DI)**,
exatamente como o `GuardedActionExecutor` recebe as `RemediationLevers`. A
`NotificationPort` fica **fora do bundle `Ports`** (para nao inchar o `Ports`
injetado em todos os agentes nem quebrar os fakes de `Ports` nos testes
existentes). O wiring vive no `scheduler.ts`.

---

## 2. Gatilhos (4 eventos) — onde cada um e disparado

Todo gatilho chama `await ctx.alert?.notify(...)` **dentro de try/catch**
(best-effort). `ctx.alert` e **opcional** no `AgentContext` — call-sites que
montam o contexto manualmente (e2e, vitest) simplesmente nao passam `alert`, e o
optional chaining os mantem funcionando sem alertas.

| Evento (`AlertEvent`)  | Severidade | Onde e disparado | Condicao exata |
|---|---|---|---|
| `KILL_SWITCH_ON`       | `CRITICAL` | rota `POST /crm/killswitch` (dono do WIRING) | apos `upsert` com `killSwitch=true` |
| `KILL_SWITCH_OFF`      | `WARNING`  | rota `POST /crm/killswitch` | apos `upsert` com `killSwitch=false` |
| `SECTOR_CRITICAL`      | `CRITICAL` | `OperationsAgent` (`operations-agent.ts`) | TRANSICAO de setor para `CRITICAL` (anterior != CRITICAL, atual == CRITICAL) |
| `ACTION_AUTO_FAILED`   | `CRITICAL` | `GuardedActionExecutor.runLever()` catch (`executor.ts`) | `triggeredBy === 'AUTO'` e o lever lancou |
| `ACTION_HIGH_QUEUED`   | `WARNING`  | `GuardedActionExecutor.enqueueForApproval()` (`executor.ts`) | acao HIGH movida `PROPOSED -> QUEUED` pelo COO/AUTO |

### 2.1 Kill switch (ON/OFF distintos)
O kill switch e idempotente por estado. Para **nunca suprimir uma troca real de
estado**, ON e OFF sao eventos distintos (`KILL_SWITCH_ON` / `KILL_SWITCH_OFF`)
com `dedupeKey` distinto. O `POST /crm/killswitch` ja faz o `upsert`
(`update: { killSwitch }`); o dono do WIRING acrescenta, **apos** o upsert e em
try/catch, a chamada ao `alert.notify` do evento correspondente. Falha do
alerta **nao** altera a resposta HTTP do kill switch.

### 2.2 Setor CRITICAL — disparo SO na transicao
O `SECTOR_CRITICAL` deve disparar **uma vez na transicao** para CRITICAL, nao a
cada tick. Deteccao no `OperationsAgent`:

- Para cada setor, comparar `statusFromScore(scoreAtual)` contra o status do
  **ultimo snapshot estritamente anterior ao inicio do ciclo** do mesmo setor
  (`@@index([sector, capturedAt])` ja existe).
- Se `anterior != CRITICAL` e `atual == CRITICAL` => `notify(SECTOR_CRITICAL)`.

> **Risco conhecido (mitigado):** ha nota de BUG de dupla escrita de
> `SectorHealthSnapshot` (ver `apps/api/scripts/e2e-crm.ts` ~linha 239). Se a
> deteccao ler o snapshot do **proprio ciclo** como "anterior", pode nunca
> disparar ou disparar 2x. Por isso a comparacao usa `capturedAt` **estritamente
> anterior ao inicio do ciclo**. O `dedupeKey + throttle` e a segunda barreira.

### 2.3 AUTO-failed e HIGH-queued ficam no executor
Esses dois ficam **dentro do `GuardedActionExecutor`** porque e o unico ponto
que conhece o desfecho real. Cuidado de acoplamento de ordem:

- `ACTION_AUTO_FAILED` so quando `triggeredBy === 'AUTO'` (acao automatica falhou).
  **Nunca** em falha `HUMAN` (rota `/approve`) — senao alerta indevido.
- `ACTION_HIGH_QUEUED` so quando o COO/AUTO enfileira (`PROPOSED -> QUEUED`).
  **Nunca** quando a rota `/approve` manipula status.

O `OperationsAgent` NAO cabeia esses dois (evita dupla notificacao).

---

## 3. Canais

### 3.1 EMAIL — reaproveita o `EmailPort` existente
`EmailAlertChannel` **NAO reimplementa SMTP**. Recebe o `EmailPort` ja resolvido
no scheduler (`createEmailAdapter`) e monta:

- `subject = title`
- `html = body` (pequeno wrapper HTML pt-BR)
- `text = body`

Em `USE_STUBS=true`, `createEmailAdapter` ja devolve o `StubEmailAdapter`, entao
o canal EMAIL fica coberto automaticamente pelo stub de email (inspecionavel via
`StubEmailAdapter.outbox`).

### 3.2 WHATSAPP — Evolution API
Real (`EvolutionWhatsAppChannel`): `fetch` nativo (sem dependencia nova).

```
POST {EVOLUTION_API_URL}/message/sendText/{EVOLUTION_INSTANCE}
Headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' }
Body:    { number, text }
```

- **1 POST por destinatario** (mais simples e observavel). O resultado do canal
  agrega: `status = FAILED` se qualquer destinatario falhar; detalhes
  por-destinatario podem ir em `meta`.

Stub (`StubWhatsApp`): grava `{ number, text, sentAt }` num array `outbox` em
memoria, espelhando o `StubEmailAdapter`. Contrato estavel para testes,
independente da versao real da Evolution API.

> **Risco conhecido:** o nome do campo (`number` vs `phone`) e o formato do
> numero (E.164 sem `+`, eventual sufixo `@s.whatsapp.net`) variam por versao da
> Evolution API. Confirmar contra a instancia real antes de tratar como
> definitivo; o `StubWhatsApp` mantem o contrato dos testes estavel.

### 3.3 Factory / Composite (implementado)
`packages/adapters/src/notification.ts` expoe duas factories equivalentes
(`createNotificationChannels` devolve o `CompositeNotificationAdapter` concreto;
`createNotificationAdapter` e o alias que devolve a `NotificationPort`):

```ts
createNotificationChannels(config: {
  useStubs: boolean;
  whatsappProvider: 'evolution' | 'stub';
  emailProvider?: 'resend';
  resendApiKey?: string;
  fromEmail?: string;
  evolutionApiUrl?: string;
  evolutionApiKey?: string;
  evolutionInstance?: string;
}): CompositeNotificationAdapter
```

- **EMAIL sempre presente**: a factory chama `createEmailAdapter` internamente
  (Resend real quando `!useStubs` + provider/key; senao `StubEmailAdapter`) e
  embrulha num `EmailAlertChannel`. Nao recebe o `EmailPort` por fora — o
  scheduler passa as envs e a factory resolve o canal de email sozinha.
- **WhatsApp**: `EvolutionWhatsAppChannel` apenas quando `!useStubs` **e**
  `whatsappProvider === 'evolution'` **e** as 3 envs Evolution
  (`EVOLUTION_API_URL` / `EVOLUTION_API_KEY` / `EVOLUTION_INSTANCE`) estiverem
  presentes; caso contrario `StubWhatsAppChannel`.
- O `CompositeNotificationAdapter.send(AlertMessage)` faz fan-out **so para os
  canais presentes em `AlertMessage.channels`** e devolve **1
  `AlertDeliveryResult` por canal**: `{ channel, status: 'SENT' | 'FAILED',
  providerId?, error? }` (best-effort: erro de um canal vira `FAILED` e nao
  derruba os demais).

---

## 4. AlertService — regra de negocio (UNICO dono)

Construtor por **objeto de dependencias** (DI), em
`packages/agents/src/alerts/alert-service.ts`:

```ts
new AlertService({
  prisma: PrismaClient;
  notifier: NotificationPort;   // CompositeNotificationAdapter resolvido no scheduler
  log: AgentLogger;
  clock?: Clock;                // injetavel; default systemClock
})
```

Implementa a interface fina exposta no `AgentContext.alert` (`AlertNotifier` em
`base.ts`):

```ts
interface AlertNotifier {
  // NUNCA rejeita: engole erros de canal E de persistencia.
  notify(input: {
    event: AlertEvent;
    sector?: Sector;
    severity?: AlertSeverity;          // default derivado do event (DEFAULT_SEVERITY_BY_EVENT)
    context?: Record<string, unknown>; // dados p/ montar a mensagem pt-BR
  }): Promise<void>;
}
```

Fluxo de `notify` (implementado em `notifyInner`, embrulhado por `notify` que
captura tudo):

1. **Settings** (secao 6): le `AlertSettings` (fail-OPEN — se a leitura falhar
   ou nao existir, usa `DEFAULT_ALERT_SETTINGS`). Se `alertsEnabled=false`, sai.
   Se `enabledEvents` for nao-vazio e nao incluir o evento, sai. Se nao houver
   canais habilitados, sai.
2. **Severidade + montagem pt-BR**: `severity = input.severity ??
   DEFAULT_SEVERITY_BY_EVENT[event]`; `dedupeKey = buildAlertDedupeKey(event,
   sector)`; `title`/`body` montados por `renderMessage(event, severity, sector,
   context)` (puro, determinista, em portugues).
3. **Dedupe/throttle** (secao 5): se `throttleMinutes > 0` e houver `AlertLog`
   `SENT` recente do mesmo `dedupeKey`, persiste 1 `AlertLog` `status=SUPPRESSED`
   e **nao envia**.
4. **Envio**: chama `notifier.send(AlertMessage)` (fan-out por canal). Se o
   `send` lancar (nunca deveria — Composite e best-effort), cada canal pedido
   vira `FAILED`.
5. **Persistencia best-effort**: grava **1 `AlertLog` por canal** retornado
   (`SENT`/`FAILED`, com `providerId`/`error`/`sentAt`). Erro de persistencia e
   engolido (`safeCreateLog`).

### REGRA DE OURO do best-effort
`AlertService.notify` **nunca rejeita**. Um `throw` nao tratado no `notify`
dentro do `runLever`/`applyWith` derrubaria o ciclo do COO. Toda a cadeia e
best-effort:
- gatilho: `try { await ctx.alert?.notify(...) } catch { /* log */ }`;
- AlertService: engole erro de canal e de persistencia.

---

## 5. Dedupe / Throttle

`dedupeKey = ${event}:${sector ?? 'GLOBAL'}` (ex.: `SECTOR_CRITICAL:DELIVERY`,
`KILL_SWITCH_ON:GLOBAL`).

Antes de enviar, o AlertService busca o ultimo `AlertLog` com **o mesmo
`dedupeKey` e `status=SENT`** dentro de `[now - throttleMinutes, now]`
(`@@index([dedupeKey, createdAt])`). Se existir:
- persiste `AlertLog` com `status=SUPPRESSED` (1 linha, para auditoria) e **nao envia**.

`throttleMinutes` vem de `AlertSettings` (default 60; fallback de boot
`ALERT_THROTTLE_MINUTES`).

**Kill switch usa eventos ON/OFF distintos** justamente para que o throttle
nunca suprima uma troca real de estado (alternar liga/desliga sempre notifica).

---

## 6. AlertSettings (singleton) — fail-OPEN

Singleton `id='singleton'` (mesmo padrao de `GuardrailConfig`), mas **fail-OPEN**
ao contrario do guardrail (alertas sao observabilidade, nao acao perigosa —
melhor alertar demais que de menos):

- **Ausente** => defaults com `alertsEnabled=true`, `channels=[EMAIL]`,
  destinatarios vindos das envs de boot (`ALERT_EMAIL_TO` / `ALERT_WHATSAPP_TO`),
  `enabledEvents=[]` (vazio = todos), `throttleMinutes=ALERT_THROTTLE_MINUTES`.
- O kill-switch global de alertas no boot e `ALERTS_ENABLED` (antes de existir
  registro em `AlertSettings`).

Prioridade de leitura: **AlertSettings do DB tem prioridade**; as envs sao apenas
fallback de boot (estilo Asaas-like).

Campos: `alertsEnabled`, `channels` (`AlertChannel[]`), `emailRecipients`
(`String[]`), `whatsappRecipients` (`String[]`), `enabledEvents`
(`AlertEvent[]`), `throttleMinutes`, `updatedAt`.

---

## 7. Modelos Prisma (dono: Fundacao — `prisma/schema.prisma`)

Aditivos; nao quebram nada existente. `OperationalSector` ja existe no schema.

```prisma
enum AlertEvent {
  KILL_SWITCH_ON
  KILL_SWITCH_OFF
  SECTOR_CRITICAL
  ACTION_AUTO_FAILED
  ACTION_HIGH_QUEUED
}

enum AlertChannel { EMAIL  WHATSAPP }

enum AlertSeverity { INFO  WARNING  CRITICAL }

enum AlertStatus { SENT  FAILED  SUPPRESSED }

/// Append-only. 1 linha por (alerta, canal); SUPPRESSED gera 1 linha.
model AlertLog {
  id         String            @id @default(cuid())
  event      AlertEvent
  severity   AlertSeverity
  channel    AlertChannel
  sector     OperationalSector?
  title      String
  body       String            @db.Text
  status     AlertStatus
  dedupeKey  String
  providerId String?
  error      String?
  sentAt     DateTime?
  createdAt  DateTime          @default(now())

  @@index([dedupeKey, createdAt]) // dedupe/throttle
  @@index([event, createdAt])
  @@index([status])
}

/// Singleton id='singleton'. Fail-OPEN (ver secao 6).
model AlertSettings {
  id                 String         @id @default("singleton")
  alertsEnabled      Boolean        @default(true)
  channels           AlertChannel[] @default([EMAIL])
  emailRecipients    String[]       @default([])
  whatsappRecipients String[]       @default([])
  enabledEvents      AlertEvent[]   @default([]) // vazio = todos
  throttleMinutes    Int            @default(60)
  updatedAt          DateTime       @updatedAt
}
```

> **Persistencia — decisao:** **1 `AlertLog` por canal disparado**. Permite ver
> que EMAIL foi `SENT` mas WHATSAPP `FAILED` no mesmo evento. `SUPPRESSED` gera 1
> linha (channel = primeiro canal habilitado, como sentinela) registrando que o
> evento foi suprimido.

---

## 8. Tipos no core (dono: Fundacao — `packages/core/src/*`)

- `ports.ts`: `NotificationPort.send(input: AlertMessage): Promise<AlertDeliveryResult[]>`.
  - `AlertMessage = { event, severity, sector?, title, body, dedupeKey, channels, emailRecipients, whatsappRecipients, meta? }`
  - `AlertDeliveryResult = { channel: AlertChannel; status: 'SENT' | 'FAILED'; providerId?: string; error?: string }`
  - **NAO** entra no bundle `Ports` (ver secao 1).
- `alerts.ts` (novo) ou `crm.ts`: enums `AlertEvent/AlertChannel/AlertSeverity/AlertStatus`
  como `z.enum`, tipos `AlertSettings` e `AlertLog`, e os schemas Zod das rotas
  (`updateAlertSettingsBodySchema`, `listAlertsQuerySchema`, `testAlertBodySchema`).
- `base.ts` (agents): `AgentContext.alert?: AlertNotifier` (opcional).
- Barrels: `core/index.ts`, `adapters/index.ts` (reexporta `./notification`),
  `agents/index.ts` (reexporta `alerts`).

---

## 9. Wiring (implementado)

No `scheduler.ts` (`resolveAlert` / `getAlert` / `getNotification`):
1. `resolveAlert(app)` resolve UMA vez (memoizado em `alertSingleton` +
   `alertResolved`) e e tolerante: import dinamico de `@ebook-empire/adapters` e
   `@ebook-empire/agents`; se `createNotificationChannels` ou `AlertService`
   ainda nao existirem, retorna `null` e o sistema segue sem alertas.
2. Monta a `NotificationPort` via `createNotificationChannels({ useStubs:
   env.USE_STUBS, whatsappProvider: env.WHATSAPP_PROVIDER, emailProvider:
   env.RESEND_API_KEY ? 'resend' : undefined, resendApiKey, evolutionApiUrl,
   evolutionApiKey, evolutionInstance })` e a guarda tambem em
   `notificationSingleton` (usada crua pela rota `POST /alerts/test`).
3. Instancia `new AlertService({ prisma, notifier: notification, log, clock:
   systemClock })`.
4. `runOperationsCycle` chama `resolveAlert(app)` e injeta o resultado em
   `buildOrchestratorContext(app, ports, cycleId, alert)` => `ctx.alert` chega ao
   COO. `getAlert(app)` expoe o mesmo singleton para a rota
   `POST /crm/killswitch`; `getNotification(app)` expoe a `NotificationPort` crua
   para `POST /alerts/test`.

No `routes/crm.ts`: apos o `upsert` do `POST /crm/killswitch`, em try/catch,
carrega o scheduler defensivamente e chama
`alert?.notify({ event: updated.killSwitch ? 'KILL_SWITCH_ON' : 'KILL_SWITCH_OFF', severity: updated.killSwitch ? 'CRITICAL' : 'WARNING', context: { killSwitch } })`.
Falha do alerta nunca altera a resposta HTTP.

No `executor.ts`:
- catch de `runLever` quando `triggeredBy === 'AUTO'` => `ctx.alert?.notify({ event: 'ACTION_AUTO_FAILED', sector, context })`.
- `enqueueForApproval` (`PROPOSED -> QUEUED`) => `ctx.alert?.notify({ event: 'ACTION_HIGH_QUEUED', sector, context })`.
Ambos guardados por try/catch; a severidade vem do default por evento.

No `operations-agent.ts`: deteccao de transicao para CRITICAL (secao 2.2) via
`loadPriorStatuses` (status do snapshot anterior ao inicio do ciclo) e disparo
via helper `notifySafe` => `ctx.alert?.notify({ event: 'SECTOR_CRITICAL', sector, context: { score, problemType?, rootCause? } })`.

---

## 10. Rotas HTTP (dono: `apps/api/src/routes/alerts.ts`)

Padrao identico a `crm.ts`: `default export async (fastify) => {}`; validacao Zod
`safeParse` com `400 { error: 'bad_request', issues }`; pt-BR; escrita protegida
por `fastify.authenticate` (Bearer JWT). Registrada por `server.ts` (Fundacao).

| Metodo | Rota | Auth | Descricao |
|---|---|---|---|
| GET  | `/alerts/health` | — | ping do modulo (`{ status: 'ok', module: 'alerts' }`) |
| GET  | `/alerts` | — | lista `AlertLog` paginada (`createdAt desc`); filtros `event`/`channel`/`status`, `limit`/`offset`; retorna `{ total, limit, offset, data }` |
| GET  | `/alerts/settings` | — | retorna `AlertSettings`; se ausente, defaults fail-OPEN com destinatarios das envs de boot (`ALERT_EMAIL_TO`/`ALERT_WHATSAPP_TO`) |
| PUT  | `/alerts/settings` | JWT | patch parcial (upsert do singleton): `alertsEnabled`, `channels`, `emailRecipients`, `whatsappRecipients`, `enabledEvents`, `throttleMinutes` |
| POST | `/alerts/settings` | JWT | alias de `PUT` (mesma semantica de patch) |
| POST | `/alerts/test` | JWT | dispara alerta de teste por todos os canais habilitados; persiste 1 `AlertLog` por canal e retorna `results` por-canal |

`POST /alerts/test` **bypassa o dedupe/throttle** (usa `dedupeKey` unico
`TEST:<timestamp>`) e chama a `NotificationPort` crua via
`scheduler.getNotification(app)` (precisa do resultado por-canal). Respostas:
`409 alerts_disabled` (alertsEnabled=false), `409 no_channels` (sem canais),
`503 notification_unavailable` (AlertService ainda nao composto), `200` se algum
canal enviou, `502` se todos falharam.

> `POST /alerts/test` dispara canais **reais** quando `USE_STUBS=false`. A UI deve
> deixar claro que um envio real ocorrera.

Cliente web (`apps/web/lib/api.ts`, dono web): `listAlerts`, `getAlertSettings`,
`updateAlertSettings`, `testAlert` + tipos espelhados `AlertLog`/`AlertSettings`.

---

## 11. Envs (dono: Fundacao — `env.ts`, `.env.example`, `.env`)

Todas com defaults stub-friendly (Evolution vazio => stub). Validadas via Zod em
`env.ts`.

| Env | Tipo / default | Uso |
|---|---|---|
| `EVOLUTION_API_URL` | string opcional, default `''` | base da Evolution API; vazio + `USE_STUBS` => `StubWhatsApp` |
| `EVOLUTION_API_KEY` | string opcional, default `''` | header `apikey` |
| `EVOLUTION_INSTANCE` | string opcional, default `''` | nome da instancia no path `/message/sendText/{instance}` |
| `ALERT_EMAIL_TO` | string opcional, default `''` | destinatario(s) default de email se settings vazio (pode reusar o userEmail) |
| `ALERT_WHATSAPP_TO` | string opcional, default `''` | numero(s) default de WhatsApp se settings vazio |
| `ALERTS_ENABLED` | boolish, default `'true'` | kill-switch global de alertas no boot, antes de existir `AlertSettings` |
| `ALERT_THROTTLE_MINUTES` | `z.coerce.number()`, default `60` | janela default de throttle quando `AlertSettings` ausente |

`AlertSettings` do DB tem prioridade; envs sao fallback de boot.

---

## 12. Testes (implementado)

**Unit (vitest)** — `packages/agents/src/alerts/alert-service.test.ts` (8 testes):
render pt-BR por evento, dedupe/throttle (SENT -> SUPPRESSED na janela),
fail-open de settings, persistencia 1-linha-por-canal e a garantia best-effort
(notify nunca rejeita mesmo com canal/persistencia falhando).

**E2E contra Postgres real** — `apps/api/scripts/e2e-finance-alerts.ts`
(compartilhado com Finance), rodado por:

```bash
pnpm --filter @ebook-empire/api e2e:ops
```

Prova ponta a ponta (`StubEmailAdapter.outbox` + `StubWhatsAppChannel.outbox`):
`KILL_SWITCH_ON` via `POST /crm/killswitch` -> `AlertLog` SENT; 2o toggle dentro
do throttle -> SUPPRESSED; setor TRAFFIC em CRITICAL detectado pelo ciclo real do
COO -> `SECTOR_CRITICAL`; `POST /alerts/test` enviando pelos canais. Resultado
atual: **46/0** (em conjunto com as assercoes de Finance).

Lembrar: `pnpm --filter @ebook-empire/agents build` antes do typecheck de
`apps/api` (consome `dist/*.d.ts`).
