// FINANCEIRO CONSOLIDADO — tipos, DTOs e schemas Zod (Feature 2).
// Fonte UNICA de verdade para API + web + agents. Sem dependencia de Prisma.
//
// Convencoes herdadas:
//  - Dinheiro SEMPRE Int centavos BRL. Unica excecao: marginPct / roas sao
//    razoes/percentuais (number | null), igual ao AnalyticsAgent.
//  - Strings de usuario em pt-BR.

import { z } from 'zod';

// ============================================================
// DRE simplificada do periodo (default: dia, janela saoPauloDay)
// ============================================================

/** Meta diaria + projecao do dia. */
export interface DreMeta {
  targetRevenueCents: number;
  /** Inteiro arredondado (grossRevenue / target * 100). */
  progressPct: number;
  metTarget: boolean;
  projectedRevenueCents: number;
  projectedMetTarget: boolean;
  /** true quando o dia ainda esta em curso (hoje SP). */
  isPartial: boolean;
}

/** Resultado da DRE do periodo (dia). */
export interface DreResult {
  /** Dia local SP YYYY-MM-DD. */
  date: string;
  grossRevenueCents: number;
  paymentFeesCents: number;
  adSpendCents: number;
  llmCostCents: number;
  /** gross - fees - adSpend - llm. */
  netProfitCents: number;
  /** % liquida (2 casas) ou null se receita 0. */
  marginPct: number | null;
  paidOrders: number;
  meta: DreMeta;
}

// ============================================================
// Contribuicao por ebook
// ============================================================
export interface EbookMargin {
  ebookId: string;
  title: string;
  revenueCents: number;
  orders: number;
  paymentFeesCents: number;
  /** best-effort (Order.adCampaignId -> AdCampaign.productId -> Product.ebookId); 0 se nao mapeavel. */
  adSpendAttributedCents: number;
  /** revenue - fees - adSpendAttributed (LLM NAO entra por ebook). */
  netProfitCents: number;
  marginPct: number | null;
}

export interface EbookBreakdownResult {
  date: string;
  ebooks: EbookMargin[];
  /** ad spend nao atribuivel a nenhum ebook. */
  unattributedAdSpendCents: number;
}

// ============================================================
// Contribuicao por campanha
// ============================================================
export interface CampaignMargin {
  campaignId: string;
  name: string;
  spendCents: number;
  revenueCents: number;
  /** revenue / spend, null se spend 0 (mesmo null-guard do computeKpis.roas). */
  roas: number | null;
  /** revenue - fees(orders da campanha) - spend. */
  netProfitCents: number;
}

export interface CampaignBreakdownResult {
  date: string;
  campaigns: CampaignMargin[];
  /** receita organica (orders sem campanha / campanha orfã). */
  organic: { revenueCents: number; orders: number };
}

// ============================================================
// FinanceSnapshot (DTO espelhado do modelo Prisma)
// ============================================================
export interface FinanceSnapshotView {
  id: string;
  /** Dia local SP YYYY-MM-DD. */
  date: string;
  grossRevenueCents: number;
  paymentFeesCents: number;
  adSpendCents: number;
  llmCostCents: number;
  netProfitCents: number;
  marginPct: number | null;
  paidOrders: number;
  computedAt: string | Date;
}

// ============================================================
// Schemas das rotas /finance (dono: apps/api/src/routes/finance.ts)
// ============================================================

const dayStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD.');

/** GET /finance/dre | /by-ebook | /by-campaign — ?date=YYYY-MM-DD (default hoje SP). */
export const financeQuerySchema = z.object({
  date: dayStringSchema.optional(),
});
export type FinanceQuery = z.infer<typeof financeQuerySchema>;

/** GET /finance/history — janela de dias (default ultimos 30). */
export const financeHistoryQuerySchema = z.object({
  from: dayStringSchema.optional(),
  to: dayStringSchema.optional(),
});
export type FinanceHistoryQuery = z.infer<typeof financeHistoryQuerySchema>;

/** POST /finance/snapshot — forca computar + upsert de um dia (default hoje). */
export const snapshotFinanceBodySchema = z
  .object({
    date: dayStringSchema.optional(),
  })
  .default({});
export type SnapshotFinanceBody = z.infer<typeof snapshotFinanceBodySchema>;
