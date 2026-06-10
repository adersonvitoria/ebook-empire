# MISSION: Make ebook-empire fully autonomous and production-ready

You are tasked with transforming the ebook-empire pnpm monorepo at `C:\Users\Admin\Documents\dev\ebook-empire` into a fully autonomous, production-grade ebook business. The system must deploy to Railway + Neon, generate validated ebooks in proven niches, list them on Hotmart and Kiwify, automate affiliate outreach, and self-optimize via an enhanced COO loop. Work in parallel across phases where possible. Never break existing functionality — all 115+ passing tests must remain green.

---

## PHASE 1 — Production Deployment (Railway + Neon)

**Files to create/modify:**

1. Create `railway.json` at repo root:
```json
{"$schema":"https://railway.app/railway.schema.json","build":{"builder":"NIXPACKS","buildCommand":"pnpm install --frozen-lockfile && pnpm --filter @ebook-empire/api run prisma:generate && pnpm --filter @ebook-empire/api build"},"deploy":{"startCommand":"node apps/api/dist/server.js","healthcheckPath":"/health","healthcheckTimeout":30,"restartPolicyType":"ON_FAILURE","restartPolicyMaxRetries":3}}
```

2. Create `nixpacks.toml` at repo root:
```toml
[phases.setup]
nixPkgs = ["nodejs_20"]

[phases.install]
cmds = ["npm i -g pnpm@9.15.0", "pnpm install --frozen-lockfile"]

[phases.build]
cmds = ["pnpm --filter @ebook-empire/api run prisma:generate", "pnpm --filter @ebook-empire/api build"]

[start]
cmd = "node apps/api/dist/server.js"
```

3. Create `.env.production.example` at repo root listing all required variables from `apps/api/src/env.ts`:
```
# REQUIRED — API will crash without these
DATABASE_URL=postgresql://user:pass@ep-xxx-yyy.us-east-1.aws.neon.tech/ebook_empire?sslmode=require&connect_timeout=10
JWT_SECRET=<32+ random bytes: openssl rand -hex 32>

# REQUIRED overrides for production
NODE_ENV=production
PUBLIC_BASE_URL=https://<your-railway-service>.up.railway.app
USE_STUBS=false
STORAGE_DIR=/data/storage

# CORS (set to your Vercel frontend URL)
CORS_ORIGIN=https://<your-vercel-app>.vercel.app

# AI / LLM
ANTHROPIC_API_KEY=sk-ant-...

# Payments
ASAAS_API_KEY=$aas_...
ASAAS_WEBHOOK_TOKEN=<shared secret>

# Email
RESEND_API_KEY=re_...
ALERT_EMAIL_TO=adersonvitoria@gmail.com

# Market research
SERPER_API_KEY=<key>
MARKET_DATA_PROVIDER=serper

# Social / Ads
META_GRAPH_TOKEN=<token>
META_AD_ACCOUNT_ID=act_<id>

# WhatsApp
EVOLUTION_API_URL=https://<your-evolution-instance>
EVOLUTION_API_KEY=<key>
EVOLUTION_INSTANCE=<instance-name>

# Marketplace (Phase 3)
HOTMART_CLIENT_ID=
HOTMART_CLIENT_SECRET=
HOTMART_WEBHOOK_TOKEN=
KIWIFY_API_KEY=
KIWIFY_ACCOUNT_ID=
KIWIFY_WEBHOOK_SECRET=
MARKETPLACE_AFFILIATE_COMMISSION_PCT=50

# Affiliate outreach (Phase 4)
AFFILIATE_OUTREACH_COOLDOWN_DAYS=7
AFFILIATE_COMMISSION_DEFAULT_PCT=30
UPSELL_DELAY_HOURS=24
UPSELL_MAX_FOLLOWUPS=3

# Revenue targets
TARGET_DAILY_REVENUE_BRL=1000
WEEKLY_EBOOK_TARGET=3
MAX_AD_BUDGET_BRL=200
```

4. In `apps/api/src/server.ts`: install and register `@fastify/cors` before route plugins. Run `pnpm add @fastify/cors` in `apps/api`. Add `CORS_ORIGIN` to `apps/api/src/env.ts` as `z.string().default('http://localhost:5173')`.

5. **Railway Release Command** (set in Railway dashboard under Deploy > Release Command — runs before each deploy):
```
npx prisma migrate deploy --schema prisma/schema.prisma
```

6. **Railway Volume**: attach a volume at `/data` in Railway service settings, then set `STORAGE_DIR=/data/storage`. Without this, all generated PDFs are wiped on every redeploy.

---

## PHASE 2 — Validated Ebook Generation (run in parallel with Phase 1)

**Files to modify:**

1. `packages/agents/src/sectors/market-research/specialist.ts` — Extend `DEFAULT_NICHE_CANDIDATES` with 9 new entries:
   - **Saúde**: `emagrecimento feminino`, `ansiedade e estresse`, `qualidade do sono`
   - **Finanças**: `investimentos para iniciantes`, `renda extra online`, `sair das dívidas`
   - **Relacionamentos**: `comunicação no casal`, `autoestima feminina`, `autoconhecimento`
   - Each entry must include `segment`, `niche`, and 2 Serper `queries` with at least one Hotmart-aware query (e.g. `"ebook emagrecimento hotmart"`, `"ebook ansiedade kiwify"`).

2. `packages/agents/src/content.ts` — Enhance the copy-generation prompt with explicit SEO instructions: use target keyword in `marketingTitle`, keep `marketingDescription` under 160 chars, include search-intent phrasing (pt-BR). Fix the `generatedByRunId` null gap: expose `this.runId` (check `packages/agents/src/base.ts`) and pass it to the `Ebook` create call.

3. `apps/api/src/env.ts` — Add:
   ```typescript
   WEEKLY_EBOOK_TARGET: z.coerce.number().int().min(1).default(3),
   ```

4. `packages/agents/src/orchestrator.ts` — In the deterministic guardrails block, add a weekly ebook budget check: query `AgentRun` for successful `CONTENT` runs in the current ISO week; if count < `env.WEEKLY_EBOOK_TARGET`, force `needsContent = true` regardless of revenue KPIs.

5. `packages/agents/src/sectors/market-research/executor.ts` — Add a recency filter: skip `MarketOpportunity` niches where a `USED` opportunity exists with `updatedAt > now - 14 days` to prevent the same niche from being re-selected every cycle.

6. `packages/agents/src/crm/diagnosis.ts` — Add `gatherContentContext()` branch in `gatherActionContext()` that queries the best available `MarketOpportunity` (status=`PENDING`, highest score) and populates `metadata.niche` on the CONTENT problem. Without this, `GENERATE_EBOOK` auto-remediation is silently a no-op.

---

## PHASE 3 — Marketplace Integration (Hotmart + Kiwify)

**Schema migration** (`prisma/schema.prisma`):
- Add `HOTMART` and `KIWIFY` to `PaymentProvider` enum.
- Add `MARKETPLACE` to `AgentName` enum.
- Add to `Product` model: `channel String?`, `externalProductId String?`, `marketplaceUrl String?`, `affiliateCommissionPct Int?`, plus `@@index([externalProductId])`.
- Add to `Order` model: `externalOrderId String?`, `marketplaceProvider String?`, `productId String?` (FK to Product), plus `@@index([externalOrderId])`, `@@index([productId])`.
- Add `MarketplaceListing` model: `{ id, productId (FK), provider String, externalProductId String, marketplaceUrl String, affiliateCommissionPct Int, syncedAt DateTime, @@unique([productId, provider]) }` — supports multi-marketplace per product.
- Run `pnpm --filter @ebook-empire/api run prisma:migrate` after changes.

**Core port** (`packages/core/src/ports.ts`):
- Define `MarketplacePort` interface: `createProduct`, `updateProduct`, `getProduct`, `parseWebhook`.
- Add `marketplace?: MarketplacePort` to the `Ports` bundle.

**Adapter** (`packages/adapters/src/marketplace.ts`):
- Implement `HotmartMarketplaceAdapter`: OAuth2 client_credentials via `https://api-sec-vlc.hotmart.com/security/oauth/token` (cache token), product creation at `POST /products/v1.0.0/product`, PDF upload as multipart stream (stream from `StoragePort.getObject` to avoid OOM), webhook validation via `HOTMART-HOTTOK` header.
- Implement `KiwifyMarketplaceAdapter`: `x-api-key` auth, `POST /v1/products`, HMAC-SHA256 webhook via `X-Kiwify-Signature`.
- Implement `StubMarketplaceAdapter` with in-memory state and deterministic IDs.
- Export `createMarketplaceAdapter` factory gated by `USE_STUBS`. Re-export from `packages/adapters/src/index.ts`.

**Webhook routes**:
- `apps/api/src/routes/webhooks/hotmart.ts`: `POST /webhooks/hotmart` — validate `HOTMART-HOTTOK`, parse `PURCHASE_COMPLETE`/`PURCHASE_REFUNDED`, upsert `Customer`, find `Product` via `MarketplaceListing.externalProductId`, create `Order` (status=`PAID`), `Payment` (provider=`HOTMART`), idempotent `Event(provider='HOTMART', externalEventId=saleId)`. Do NOT create `DeliveryGrant` for marketplace orders (Hotmart delivers natively via CDN) — add `marketplaceProvider` check in `DeliveryAgent` to skip these orders.
- `apps/api/src/routes/webhooks/kiwify.ts`: same pattern with HMAC-SHA256 validation.
- Register both in `apps/api/src/server.ts` following the existing plugin registration pattern.

**Agent** (`packages/agents/src/marketplace.ts`): `MarketplaceAgent` extends `Agent` (AgentName=`MARKETPLACE`). Each run: find `Ebook` records with status=`PUBLISHED` that have no `MarketplaceListing` row; for each, stream PDF via `ports.storage.getObject(ebook.pdfPath)`; call `ports.marketplace.createProduct` for each provider (Hotmart + Kiwify); upsert `MarketplaceListing` with returned IDs; log `AgentRun`. Register in `apps/api/src/scheduler.ts` FAST tick alongside `DeliveryAgent`.

---

## PHASE 4 — Affiliate Outreach Automation

**Schema additions** (`prisma/schema.prisma`):
```prisma
model Affiliate {
  id               String          @id @default(cuid())
  name             String
  email            String          @unique
  whatsappNumber   String?
  hotmartAffiliateId String?
  status           AffiliateStatus @default(PROSPECT)
  ebookId          String?
  commissionPct    Int             @default(30)
  totalSalesCents  Int             @default(0)
  lastContactedAt  DateTime?
  tags             String[]
  createdAt        DateTime        @default(now())
  updatedAt        DateTime        @updatedAt
}

model AffiliateOutreach {
  id          String          @id @default(cuid())
  affiliateId String
  channel     OutreachChannel
  templateKey String
  status      OutreachStatus  @default(SENT)
  sentAt      DateTime        @default(now())
  agentRunId  String?
  payload     Json?
}

enum AffiliateStatus { PROSPECT ACTIVE PAUSED UNSUBSCRIBED }
enum OutreachChannel { EMAIL WHATSAPP }
enum OutreachStatus  { SENT DELIVERED REPLIED BOUNCED FAILED }
```
- Add `AFFILIATE` and `FUNNEL` to `AgentName` enum.
- Add `AFFILIATE_CONTACTED`, `UPSELL_SENT`, `UPSELL_CONVERTED` to `EventType` enum.

**WhatsApp port** (`packages/core/src/ports.ts`): Add `WhatsAppPort` interface: `sendMessage(to: string, text: string): Promise<void>`. Add `whatsapp?: WhatsAppPort` to `Ports` bundle.

**WhatsApp adapter** (`packages/adapters/src/whatsapp.ts`): Extract `EvolutionWhatsAppAdapter` from `packages/adapters/src/notification.ts` into a standalone injectable `WhatsAppPort`. `StubWhatsAppAdapter` stores messages in an `outbox` array for tests. Export `createWhatsAppAdapter` factory.

**Agent** (`packages/agents/src/affiliate-outreach.ts`): `AffiliateOutreachAgent` extends `Agent`. Each run: find `Affiliate` rows where `status=PROSPECT` and `lastContactedAt` is null or older than `AFFILIATE_OUTREACH_COOLDOWN_DAYS`; generate personalized pt-BR outreach copy via `LLMPort` (commission offer, product niche, earnings potential); send via `EmailPort`; optionally send WhatsApp if `whatsappNumber` present; create `AffiliateOutreach` record; emit `AFFILIATE_CONTACTED` Event; update `lastContactedAt`. Register in scheduler SLOW tick.

**UTM convention**: in checkout route and Hotmart/Kiwify webhooks, when an order has a referral, set `utmSource='hotmart'` or `utmSource='kiwify'`, `utmMedium='afiliado'`, `utmContent=affiliateId` so per-affiliate revenue is attributable.

---

## PHASE 5 — Autonomous Scale Loop (COO Enhancement)

**Schema additions** (`prisma/schema.prisma`):
- Add to `OperationalSector` enum: `MARKETPLACE`, `FUNNEL`, `AFFILIATE`.
- Add to `ActionKind` enum: `GENERATE_MORE_EBOOKS`, `PAUSE_LISTING`, `BOOST_AFFILIATE_OUTREACH`, `SEND_AFFILIATE_EMAIL`.

**`packages/core/src/crm.ts`**:
- Add new sectors to `SECTORS` array and `SECTOR_WEIGHTS` map (MARKETPLACE: 12, FUNNEL: 10, AFFILIATE: 8 — adjust to keep sum=100).
- Add new `ProblemType` values: `MARKETPLACE` sector → `DEAD_LISTING`, `MISSING_COVER`; `FUNNEL` sector → `LANDING_DROPOFF`, `HIGH_CART_ABANDONMENT`; `AFFILIATE` sector → `NO_AFFILIATE_ACTIVITY`, `AFFILIATE_REVENUE_ZERO`.
- Add new `ActionKind` entries to `actionKindSchema` and `ACTION_SPECS` with correct `riskTier` (GENERATE_MORE_EBOOKS=LOW, PAUSE_LISTING=LOW reversible, BOOST_AFFILIATE_OUTREACH=LOW, SEND_AFFILIATE_EMAIL=LOW).

**`packages/agents/src/crm/health-collector.ts`**:
- Add `collectMarketplace()`: queries `Product` for listings with zero sales in 30 days, missing `externalProductId`, missing `coverImagePath`. Scores 0-100.
- Add `collectFunnel()`: queries `Event` counts for IMPRESSION, CLICK, LANDING_VIEW, CHECKOUT_STARTED, PAID in rolling 7-day window; computes stage-to-stage conversion rates.
- Add `collectAffiliate()`: queries `Affiliate` counts by status, revenue attributed via `utmSource IN ('hotmart','kiwify')` AND `utmMedium='afiliado'`.
- Add `collectContent()` niche subscore: count `MarketOpportunity` where `status=PENDING` and `potentialScore > 70`.

**`packages/agents/src/crm/diagnosis.ts`**:
- Add rules for MARKETPLACE, FUNNEL, AFFILIATE sectors.
- Fix `gatherContentContext()`: query `MarketOpportunity` for highest-scoring `PENDING` opportunity; populate `metadata.niche` and `metadata.count` (derived from niche velocity: orders in last 7 days for that niche — use `Order.productId → Product.ebookId → Ebook.niche` join after productId FK is added).
- Add `REVENUE_BELOW_TARGET` rule in ORCHESTRATION: fires when `FinanceSnapshot.netProfitCents` for today < `targetRevenueCents * 0.5` by noon UTC; triggers `GENERATE_MORE_EBOOKS`.

**`packages/agents/src/crm/levers-live.ts`**:
- Add `generateMoreEbooks(ctx, { niche, count })`: calls `ContentAgent` N times sequentially via the launch pipeline.
- Add `pauseListing(ctx, { productId })`: sets `Product.active = false`; stores `beforeState = { active: true }`; reversible.
- Add `boostAffiliateOutreach(ctx, {})`: calls `AffiliateOutreachAgent.execute(ctx)`.
- Add `sendAffiliateEmail(ctx, { affiliateId })`: calls `AffiliateOutreachAgent` for a single affiliate.
- Wire all four into the `dispatch()` switch and `revert()` method.

**`packages/agents/src/analytics.ts`**:
- Add `metaProgress` subscore to `KPISnapshot`: `Math.min(100, Math.round(revenueCents / targetRevenueCents * 100))`. Expose in the ANALYTICS sector health score.

---

## VERIFICATION

After all changes, run in this exact sequence:

```bash
# 1. Regenerate Prisma client after all schema changes
pnpm --filter @ebook-empire/api run prisma:generate

# 2. TypeScript — zero errors across all packages
pnpm -r typecheck

# 3. All tests — 115+ existing must pass; new stub tests must also pass
pnpm test

# 4. CRM end-to-end against real Postgres
pnpm --filter @ebook-empire/api e2e:crm

# 5. Validate config files
node -e "JSON.parse(require('fs').readFileSync('railway.json','utf8')); console.log('railway.json OK')"
```

**Hard rules:**
- Never use `prisma migrate dev` in production paths — only `prisma migrate deploy`.
- Never commit `.env` files with real secrets.
- Never modify existing comment blocks in `apps/api/src/server.ts` — only add `fastifyCors` registration and the two new webhook plugin imports following the existing `await app.register(import('./routes/...'))` pattern exactly.
- Every new agent must export from `packages/agents/src/index.ts` and be registered in `apps/api/src/scheduler.ts` CHILD_CLASS_NAMES before the orchestrator can dispatch it.
- Every new `ActionKind` must be added to ALL FOUR locations simultaneously: `schema.prisma` enum, `packages/core/src/crm.ts` actionKindSchema + ACTION_SPECS + SECTOR_KINDS, `packages/agents/src/crm/executor.ts` dispatch switch, `packages/agents/src/crm/levers-live.ts` method. Drift between these causes runtime errors.
