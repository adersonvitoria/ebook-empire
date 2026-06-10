// ALERTAS EXTERNOS — tipos, unioes, schemas Zod e DTOs (Feature 1).
// Fonte UNICA de verdade para API + web + agents. Sem dependencia de Prisma.
//
// Convencoes herdadas:
//  - Strings de usuario em pt-BR (montadas no AlertService).
//  - Enums espelham prisma/schema.prisma 1:1.
//  - A NotificationPort fica em ports.ts (FORA do bundle Ports).

import { z } from 'zod';

import type { Sector } from './crm.js';
import { sectorSchema } from './crm.js';

// ============================================================
// Unioes (espelham os enums Postgres)
// ============================================================

/** Eventos que disparam alerta externo. */
export type AlertEvent =
  | 'KILL_SWITCH_ON'
  | 'KILL_SWITCH_OFF'
  | 'SECTOR_CRITICAL'
  | 'ACTION_AUTO_FAILED'
  | 'ACTION_HIGH_QUEUED';

/** Canais de entrega de alerta. */
export type AlertChannel = 'EMAIL' | 'WHATSAPP';

/** Severidade do alerta. */
export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/** Desfecho de uma linha de AlertLog. */
export type AlertStatus = 'SENT' | 'FAILED' | 'SUPPRESSED';

// ============================================================
// Schemas Zod (z.enum espelhando as unioes acima)
// ============================================================

export const alertEventSchema = z.enum([
  'KILL_SWITCH_ON',
  'KILL_SWITCH_OFF',
  'SECTOR_CRITICAL',
  'ACTION_AUTO_FAILED',
  'ACTION_HIGH_QUEUED',
]);

export const alertChannelSchema = z.enum(['EMAIL', 'WHATSAPP']);
export const alertSeveritySchema = z.enum(['INFO', 'WARNING', 'CRITICAL']);
export const alertStatusSchema = z.enum(['SENT', 'FAILED', 'SUPPRESSED']);

// ============================================================
// Severidade default derivada do evento (ver docs/ALERTS.md secao 2)
// ============================================================
export const DEFAULT_SEVERITY_BY_EVENT: Record<AlertEvent, AlertSeverity> = {
  KILL_SWITCH_ON: 'CRITICAL',
  KILL_SWITCH_OFF: 'WARNING',
  SECTOR_CRITICAL: 'CRITICAL',
  ACTION_AUTO_FAILED: 'CRITICAL',
  ACTION_HIGH_QUEUED: 'WARNING',
} as const;

/** dedupeKey = `${event}:${sector ?? 'GLOBAL'}`. Fonte unica. */
export function buildAlertDedupeKey(event: AlertEvent, sector?: Sector | null): string {
  return `${event}:${sector ?? 'GLOBAL'}`;
}

// ============================================================
// DTOs de dominio (formato "plano" para borda/API/web)
// ============================================================

/** Configuracao de alertas (singleton). Fail-OPEN. */
export interface AlertSettings {
  alertsEnabled: boolean;
  channels: AlertChannel[];
  emailRecipients: string[];
  whatsappRecipients: string[];
  /** vazio = todos os eventos habilitados. */
  enabledEvents: AlertEvent[];
  throttleMinutes: number;
  updatedAt?: string | Date;
}

/** Linha de auditoria de alerta (1 por canal disparado; SUPPRESSED = 1 linha). */
export interface AlertLog {
  id: string;
  event: AlertEvent;
  severity: AlertSeverity;
  channel: AlertChannel;
  sector?: Sector | null;
  title: string;
  body: string;
  status: AlertStatus;
  dedupeKey: string;
  providerId?: string | null;
  error?: string | null;
  sentAt?: string | Date | null;
  createdAt: string | Date;
}

// ============================================================
// Schemas das rotas /alerts (dono: apps/api/src/routes/alerts.ts)
// ============================================================

/** PUT /alerts/settings — patch parcial. */
export const updateAlertSettingsBodySchema = z
  .object({
    alertsEnabled: z.boolean().optional(),
    channels: z.array(alertChannelSchema).optional(),
    emailRecipients: z.array(z.string()).optional(),
    whatsappRecipients: z.array(z.string()).optional(),
    enabledEvents: z.array(alertEventSchema).optional(),
    throttleMinutes: z.number().int().min(0).max(1440).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: 'Informe ao menos um campo para atualizar.',
  });
export type UpdateAlertSettingsBody = z.infer<typeof updateAlertSettingsBodySchema>;

/** GET /alerts — listagem paginada com filtros. */
export const listAlertsQuerySchema = z.object({
  event: alertEventSchema.optional(),
  channel: alertChannelSchema.optional(),
  status: alertStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;

/** POST /alerts/test — dispara um alerta de teste pelos canais habilitados. */
export const testAlertBodySchema = z
  .object({
    sector: sectorSchema.optional(),
  })
  .default({});
export type TestAlertBody = z.infer<typeof testAlertBodySchema>;
