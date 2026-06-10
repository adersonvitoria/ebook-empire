// NotificationPort — alertas externos (EMAIL + WHATSAPP). Feature 1.
//
// Canais:
//  - EmailAlertChannel: adapta o EmailPort existente (createEmailAdapter).
//    Faz 1 envio por destinatario (AlertMessage.emailRecipients).
//  - EvolutionWhatsAppChannel (real): POST {EVOLUTION_API_URL}/message/sendText/{instance}
//    header `apikey`, body { number, text }. 1 envio por destinatario.
//  - StubWhatsAppChannel: grava em memoria (.outbox), inspecionavel em testes.
//
// CompositeNotificationAdapter implementa NotificationPort: faz fan-out para
// os canais habilitados em AlertMessage.channels e devolve 1 AlertDeliveryResult
// por canal (best-effort: erro de um canal vira FAILED, nao derruba os demais).
//
// createNotificationChannels(env) monta os canais ativos conforme
// USE_STUBS / WHATSAPP_PROVIDER e devolve um CompositeNotificationAdapter pronto.
//
// Ver docs/ALERTS.md secao 3. NotificationPort/AlertMessage/AlertDeliveryResult
// ja estao definidos em @ebook-empire/core (ports.ts).

import type {
  AlertChannel,
  AlertDeliveryResult,
  AlertMessage,
  EmailPort,
  NotificationPort,
} from '@ebook-empire/core';

import { createEmailAdapter } from './email.js';
import { EvolutionWhatsAppAdapter } from './whatsapp.js';

// ============================================================
// Contrato interno de um canal individual (1 canal -> 1 resultado).
// O Composite agrega os canais e expoe a NotificationPort.
// ============================================================
export interface AlertChannelAdapter {
  /** Identificador do canal (espelha AlertChannel). */
  readonly channel: AlertChannel;
  /** Entrega a mensagem; lanca em caso de falha (o Composite captura). */
  send(message: AlertMessage): Promise<{ providerId?: string }>;
}

// ============================================================
// EMAIL — adapta o EmailPort existente.
// Envia 1 email por destinatario em AlertMessage.emailRecipients.
// ============================================================
export class EmailAlertChannel implements AlertChannelAdapter {
  readonly channel = 'EMAIL' as const;
  private readonly email: EmailPort;

  constructor(email: EmailPort) {
    this.email = email;
  }

  async send(message: AlertMessage): Promise<{ providerId?: string }> {
    const recipients = message.emailRecipients ?? [];
    if (recipients.length === 0) {
      throw new Error('EmailAlertChannel: nenhum destinatario de email configurado.');
    }

    const html = renderEmailHtml(message);
    const text = `${message.title}\n\n${message.body}`;
    const ids: string[] = [];

    for (const to of recipients) {
      const res = await this.email.send({
        to,
        subject: message.title,
        html,
        text,
      });
      if (res.messageId) ids.push(res.messageId);
    }

    return { providerId: ids.join(',') || undefined };
  }
}

/** HTML simples e robusto (sem dependencia de template engine). */
function renderEmailHtml(message: AlertMessage): string {
  const escapedTitle = escapeHtml(message.title);
  const escapedBody = escapeHtml(message.body).replace(/\n/g, '<br>');
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">',
    `<h2 style="margin:0 0 12px">${escapedTitle}</h2>`,
    `<p style="margin:0;line-height:1.5">${escapedBody}</p>`,
    '<hr style="margin:16px 0;border:none;border-top:1px solid #eee">',
    '<p style="margin:0;color:#888;font-size:12px">Ebook Empire — Command Center</p>',
    '</div>',
  ].join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// WHATSAPP — Evolution API (real).
// POST {baseUrl}/message/sendText/{instance}
//   headers: { apikey, Content-Type: application/json }
//   body: { number, text }
// 1 envio por destinatario em AlertMessage.whatsappRecipients.
// ============================================================
export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  instance: string;
}

export class EvolutionWhatsAppChannel implements AlertChannelAdapter {
  readonly channel = 'WHATSAPP' as const;
  // Reaproveita o WhatsAppPort standalone (EvolutionWhatsAppAdapter): este canal
  // de ALERTAS apenas formata title/body e faz fan-out por destinatario; o
  // transporte HTTP Evolution vive no adapter extraido (whatsapp.ts).
  private readonly adapter: EvolutionWhatsAppAdapter;

  constructor(config: EvolutionConfig) {
    // O ctor do adapter valida baseUrl/apiKey/instance e lanca em pt-BR.
    this.adapter = new EvolutionWhatsAppAdapter({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      instance: config.instance,
    });
  }

  async send(message: AlertMessage): Promise<{ providerId?: string }> {
    const recipients = message.whatsappRecipients ?? [];
    if (recipients.length === 0) {
      throw new Error('EvolutionWhatsAppChannel: nenhum destinatario de WhatsApp configurado.');
    }

    const text = `*${message.title}*\n\n${message.body}`;
    for (const number of recipients) {
      await this.adapter.sendMessage(number, text);
    }

    return {};
  }
}

// ============================================================
// WHATSAPP — Stub (memoria). Util para testes e modo offline.
// ============================================================
export interface SentWhatsApp {
  recipients: string[];
  title: string;
  body: string;
  text: string;
  sentAt: Date;
}

export class StubWhatsAppChannel implements AlertChannelAdapter {
  readonly channel = 'WHATSAPP' as const;
  /** Caixa de saida observavel pelos testes. */
  readonly outbox: SentWhatsApp[] = [];
  private counter = 0;

  async send(message: AlertMessage): Promise<{ providerId?: string }> {
    this.counter += 1;
    const text = `*${message.title}*\n\n${message.body}`;
    this.outbox.push({
      recipients: [...(message.whatsappRecipients ?? [])],
      title: message.title,
      body: message.body,
      text,
      sentAt: new Date(),
    });
    return { providerId: `stub-wa-${this.counter}` };
  }

  /** Limpa a caixa de saida (entre testes). */
  reset(): void {
    this.outbox.length = 0;
    this.counter = 0;
  }
}

// ============================================================
// Composite — implementa NotificationPort (fan-out best-effort).
// So dispara um canal se ele estiver presente em AlertMessage.channels.
// ============================================================
export class CompositeNotificationAdapter implements NotificationPort {
  private readonly channels: AlertChannelAdapter[];

  constructor(channels: AlertChannelAdapter[]) {
    this.channels = channels;
  }

  async send(input: AlertMessage): Promise<AlertDeliveryResult[]> {
    const wanted = new Set(input.channels);
    const targets = this.channels.filter((c) => wanted.has(c.channel));

    const results = await Promise.all(
      targets.map(async (c): Promise<AlertDeliveryResult> => {
        try {
          const { providerId } = await c.send(input);
          return { channel: c.channel, status: 'SENT', providerId };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { channel: c.channel, status: 'FAILED', error };
        }
      }),
    );

    return results;
  }
}

// ============================================================
// Config + factory — escolhe real<->stub por env.
// ============================================================
export interface NotificationAdapterConfig {
  /** true => usa stubs (email stub + whatsapp stub) independentemente do provider. */
  useStubs: boolean;
  /** 'evolution' = WhatsApp real; 'stub' = StubWhatsAppChannel. */
  whatsappProvider: 'evolution' | 'stub';
  /** Provedor de email real quando !useStubs. */
  emailProvider?: 'resend';
  resendApiKey?: string;
  fromEmail?: string;
  evolutionApiUrl?: string;
  evolutionApiKey?: string;
  evolutionInstance?: string;
}

/**
 * Monta os canais ativos e devolve um CompositeNotificationAdapter pronto.
 *
 * Regras de selecao:
 *  - EMAIL: sempre presente (StubEmailAdapter quando useStubs, Resend caso contrario);
 *    createEmailAdapter ja cai para stub se a key/provider faltarem.
 *  - WHATSAPP: EvolutionWhatsAppChannel apenas quando !useStubs E
 *    whatsappProvider==='evolution' E as 3 envs Evolution estiverem presentes;
 *    caso contrario StubWhatsAppChannel.
 */
export function createNotificationChannels(
  config: NotificationAdapterConfig,
): CompositeNotificationAdapter {
  const channels: AlertChannelAdapter[] = [];

  // EMAIL — reaproveita o EmailPort existente.
  const email = createEmailAdapter({
    useStubs: config.useStubs,
    provider: config.emailProvider,
    resendApiKey: config.resendApiKey,
    fromEmail: config.fromEmail,
  });
  channels.push(new EmailAlertChannel(email));

  // WHATSAPP — real apenas com env completa; senao stub.
  const wantsEvolution =
    !config.useStubs &&
    config.whatsappProvider === 'evolution' &&
    Boolean(config.evolutionApiUrl) &&
    Boolean(config.evolutionApiKey) &&
    Boolean(config.evolutionInstance);

  if (wantsEvolution) {
    channels.push(
      new EvolutionWhatsAppChannel({
        baseUrl: config.evolutionApiUrl ?? '',
        apiKey: config.evolutionApiKey ?? '',
        instance: config.evolutionInstance ?? '',
      }),
    );
  } else {
    channels.push(new StubWhatsAppChannel());
  }

  return new CompositeNotificationAdapter(channels);
}

/**
 * Alias de conveniencia alinhado ao restante dos adapters (create<Port>Adapter).
 * Devolve a NotificationPort pronta.
 */
export function createNotificationAdapter(
  config: NotificationAdapterConfig,
): NotificationPort {
  return createNotificationChannels(config);
}
