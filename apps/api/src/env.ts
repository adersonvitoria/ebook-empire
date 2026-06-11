// Validacao e carregamento das variaveis de ambiente via Zod.
// Fonte unica de verdade do env para toda a API. Importar { env } daqui.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

// Carrega o .env da raiz do monorepo antes de validar (Node 22+ loadEnvFile).
// Duravel para server, testes e scripts — sem depender de --env-file no comando.
function loadDotenv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(here, '../.env'), // apps/api/.env
    resolve(here, '../../../.env'), // raiz do monorepo
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        process.loadEnvFile(path);
      } catch {
        // ignora: variavel ja pode estar no ambiente
      }
    }
  }
}

loadDotenv();

const boolish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  // Banco
  DATABASE_URL: z.string().url(),

  // Runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3001'),
  // CORS — origem do frontend autorizada (Web Next.js / Vite). Default dev local.
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Auth
  JWT_SECRET: z.string().min(8),
  // Senha do painel interno (single-admin). Vazio => login desabilitado (503).
  ADMIN_PASSWORD: z.string().optional().default(''),
  // TTL do token de login (segundos). Default 43200 = 12h.
  AUTH_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(43_200),

  // Agentes / scheduler
  ENABLE_AGENTS: boolish.default('true'),
  FAST_TICK_MS: z.coerce.number().int().positive().default(60_000),
  SLOW_TICK_MS: z.coerce.number().int().positive().default(900_000),
  MAX_AD_BUDGET_BRL: z.coerce.number().int().positive().default(300),
  TARGET_DAILY_REVENUE_BRL: z.coerce.number().int().positive().default(1000),
  WEEKLY_EBOOK_TARGET: z.coerce.number().int().min(1).default(3),

  // LLM — provedor: 'gemini' (camada gratuita) ou 'anthropic'. Default anthropic.
  LLM_PROVIDER: z.enum(['anthropic', 'gemini']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),

  // Mercado (setor MARKET_RESEARCH — Serper.dev real; stub deterministico).
  // USE_STUBS=true (default) forca o stub mesmo com SERPER_API_KEY setada.
  MARKET_DATA_PROVIDER: z.enum(['serper', 'stub']).default('stub'),
  SERPER_API_KEY: z.string().optional().default(''),
  MARKET_SEARCH_GL: z.string().default('br'),
  MARKET_SEARCH_HL: z.string().default('pt-br'),
  MARKET_RESEARCH_WINDOW_DAYS: z.coerce.number().int().positive().default(14),
  MARKET_MAX_QUERIES_PER_RUN: z.coerce.number().int().min(1).default(10),

  // QA / auditoria de ebooks (setor EBOOK_QA).
  QA_MIN_SCORE: z.coerce.number().int().min(0).max(100).default(70),
  QA_MAX_FIX_ITERATIONS: z.coerce.number().int().min(0).default(2),
  QA_FAIL_SCORE: z.coerce.number().int().min(0).default(40),
  QA_AUDIT_STALE_HOURS: z.coerce.number().int().min(1).default(168),

  // Pagamento
  PAYMENT_PROVIDER: z.enum(['asaas', 'mercado_pago']).default('asaas'),
  ASAAS_API_KEY: z.string().optional().default(''),
  ASAAS_WEBHOOK_TOKEN: z.string().optional().default(''),
  // Base da API Asaas. Vazio => producao (https://api.asaas.com/v3).
  // Sandbox: https://sandbox.asaas.com/api/v3 (confirme no painel sandbox do Asaas).
  ASAAS_BASE_URL: z.string().optional().default(''),

  // Meta (Instagram + Ads)
  META_GRAPH_TOKEN: z.string().optional().default(''),
  META_AD_ACCOUNT_ID: z.string().optional().default(''),

  // Email
  RESEND_API_KEY: z.string().optional().default(''),

  // Alertas externos (Feature 1) — defaults stub-friendly (Evolution vazio => stub).
  ALERTS_ENABLED: boolish.default('true'),
  ALERT_EMAIL_TO: z.string().optional().default(''),
  ALERT_WHATSAPP_TO: z.string().optional().default(''),
  ALERT_THROTTLE_MINUTES: z.coerce.number().int().min(0).default(60),
  WHATSAPP_PROVIDER: z.enum(['evolution', 'stub']).default('stub'),
  EVOLUTION_API_URL: z.string().optional().default(''),
  EVOLUTION_API_KEY: z.string().optional().default(''),
  EVOLUTION_INSTANCE: z.string().optional().default(''),

  // Financeiro consolidado (Feature 2) — taxas Asaas PIX por transacao (placeholders).
  ASAAS_FEE_PERCENT: z.coerce.number().min(0).default(0.99),
  ASAAS_FEE_FIXED_CENTS: z.coerce.number().int().min(0).default(49),

  // Marketplaces — Hotmart (OAuth + webhook).
  HOTMART_CLIENT_ID: z.string().optional().default(''),
  HOTMART_CLIENT_SECRET: z.string().optional().default(''),
  HOTMART_WEBHOOK_TOKEN: z.string().optional().default(''),

  // Marketplaces — Kiwify (API + webhook).
  KIWIFY_API_KEY: z.string().optional().default(''),
  KIWIFY_ACCOUNT_ID: z.string().optional().default(''),
  KIWIFY_WEBHOOK_SECRET: z.string().optional().default(''),

  // Afiliados / marketplace — comissoes e cadencia de outreach.
  MARKETPLACE_AFFILIATE_COMMISSION_PCT: z.coerce.number().int().default(50),
  AFFILIATE_OUTREACH_COOLDOWN_DAYS: z.coerce.number().int().default(7),
  AFFILIATE_COMMISSION_DEFAULT_PCT: z.coerce.number().int().default(30),

  // Upsell (follow-ups pos-venda).
  UPSELL_DELAY_HOURS: z.coerce.number().int().default(24),
  UPSELL_MAX_FOLLOWUPS: z.coerce.number().int().default(3),

  // Stubs / storage
  USE_STUBS: boolish.default('true'),
  STORAGE_DIR: z.string().default('./storage'),
});

export type Env = z.infer<typeof envSchema>;

// Modelos LLM fixos por funcao (ver ARCHITECTURE.md secao 4).
export const CONTENT_MODEL = 'claude-sonnet-4-6';
export const PLANNING_MODEL = 'claude-opus-4-8';

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Falha rapido: nao subir a API com env invalido.
    throw new Error(`Variaveis de ambiente invalidas:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();
