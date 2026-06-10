// WhatsAppPort — envio direto 1:1 de mensagem de texto (Evolution API).
//
// Distinto da NotificationPort (que faz fan-out de ALERTAS para varios canais):
// aqui e o port MINIMO usado pelo outreach de afiliados / upsell —
//   sendMessage(to, text): Promise<void>.
//
// Real:  EvolutionWhatsAppAdapter — POST {baseUrl}/message/sendText/{instance}
//        headers { apikey, Content-Type }, body { number, text }.
// Stub:  StubWhatsAppAdapter — grava em .outbox (inspecionavel em testes / modo offline).
// Factory: createWhatsAppAdapter(env) escolhe real<->stub por USE_STUBS /
//        WHATSAPP_PROVIDER + presenca das 3 envs Evolution.
//
// notification.ts (EvolutionWhatsAppChannel — canal de ALERTAS) reusa o
// EvolutionWhatsAppAdapter daqui internamente, sem mudar seu contrato publico.

import type { WhatsAppPort } from '@ebook-empire/core';

// ------------------------------------------------------------
// Config do transporte Evolution (compartilhada com o canal de alertas).
// ------------------------------------------------------------
export interface EvolutionWhatsAppConfig {
  baseUrl: string;
  apiKey: string;
  instance: string;
}

// ------------------------------------------------------------
// Real — Evolution API. Implementa WhatsAppPort (envio 1:1).
// ------------------------------------------------------------
export class EvolutionWhatsAppAdapter implements WhatsAppPort {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly instance: string;

  constructor(config: EvolutionWhatsAppConfig) {
    if (!config.baseUrl || !config.apiKey || !config.instance) {
      throw new Error(
        'EvolutionWhatsAppAdapter: EVOLUTION_API_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE sao obrigatorios.',
      );
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.instance = config.instance;
  }

  async sendMessage(to: string, text: string): Promise<void> {
    if (!to) {
      throw new Error('EvolutionWhatsAppAdapter: destinatario (to) ausente.');
    }
    const url = `${this.baseUrl}/message/sendText/${encodeURIComponent(this.instance)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ number: to, text }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Evolution falhou (${res.status}) para ${to}: ${detail || res.statusText}`,
      );
    }
  }
}

// ------------------------------------------------------------
// Stub — grava em memoria. Util para testes e modo offline.
// ------------------------------------------------------------
export interface SentWhatsAppMessage {
  to: string;
  text: string;
  sentAt: Date;
}

export class StubWhatsAppAdapter implements WhatsAppPort {
  /** Caixa de saida observavel pelos testes. */
  readonly outbox: SentWhatsAppMessage[] = [];

  async sendMessage(to: string, text: string): Promise<void> {
    this.outbox.push({ to, text, sentAt: new Date() });
  }

  /** Limpa a caixa de saida (entre testes). */
  reset(): void {
    this.outbox.length = 0;
  }
}

// ------------------------------------------------------------
// Config + factory — real <-> stub por env.
// ------------------------------------------------------------
export interface WhatsAppAdapterConfig {
  /** true => sempre StubWhatsAppAdapter, independentemente do provider. */
  useStubs: boolean;
  /** 'evolution' = WhatsApp real; 'stub' = StubWhatsAppAdapter. */
  whatsappProvider: 'evolution' | 'stub';
  evolutionApiUrl?: string;
  evolutionApiKey?: string;
  evolutionInstance?: string;
}

/**
 * Monta o WhatsAppPort apropriado.
 * Real (EvolutionWhatsAppAdapter) APENAS quando !useStubs E
 * whatsappProvider==='evolution' E as 3 envs Evolution estiverem presentes;
 * caso contrario StubWhatsAppAdapter (offline-friendly).
 */
export function createWhatsAppAdapter(config: WhatsAppAdapterConfig): WhatsAppPort {
  const wantsEvolution =
    !config.useStubs &&
    config.whatsappProvider === 'evolution' &&
    Boolean(config.evolutionApiUrl) &&
    Boolean(config.evolutionApiKey) &&
    Boolean(config.evolutionInstance);

  if (wantsEvolution) {
    return new EvolutionWhatsAppAdapter({
      baseUrl: config.evolutionApiUrl ?? '',
      apiKey: config.evolutionApiKey ?? '',
      instance: config.evolutionInstance ?? '',
    });
  }
  return new StubWhatsAppAdapter();
}
