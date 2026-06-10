// EmailPort — entrega de email transacional.
// Real: ResendEmailAdapter (HTTP API do Resend via fetch nativo, sem dep extra).
// Stub: StubEmailAdapter grava emails enviados em memoria (inspecionavel em testes).
// Factory escolhe real<->stub por env (USE_STUBS / EMAIL_PROVIDER).

import type { EmailPort, EmailSendInput, EmailSendResult } from '@ebook-empire/core';

// ------------------------------------------------------------
// Config minima do adapter de email (subconjunto do env validado).
// ------------------------------------------------------------
export interface EmailAdapterConfig {
  /** true => usa stub em memoria. */
  useStubs: boolean;
  /** Provedor real quando useStubs=false. */
  provider?: 'resend';
  /** API key do Resend. */
  resendApiKey?: string;
  /** Remetente padrao (ex. "Ebook Empire <no-reply@ebookempire.com.br>"). */
  fromEmail?: string;
}

const DEFAULT_FROM = 'Ebook Empire <no-reply@ebookempire.com.br>';

// ------------------------------------------------------------
// Real — Resend (https://resend.com/docs/api-reference/emails/send-email)
// Usa fetch nativo do Node 20; nao adiciona dependencia.
// ------------------------------------------------------------
export class ResendEmailAdapter implements EmailPort {
  private readonly apiKey: string;
  private readonly from: string;

  constructor(apiKey: string, fromEmail: string = DEFAULT_FROM) {
    if (!apiKey) {
      throw new Error('ResendEmailAdapter: RESEND_API_KEY ausente.');
    }
    this.apiKey = apiKey;
    this.from = fromEmail;
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Resend falhou (${res.status}): ${detail || res.statusText}`,
      );
    }

    const data = (await res.json()) as { id?: string };
    return { messageId: data.id ?? '' };
  }
}

// ------------------------------------------------------------
// Stub — grava em memoria. Util para testes e modo offline.
// ------------------------------------------------------------
export interface SentEmail extends EmailSendInput {
  messageId: string;
  sentAt: Date;
}

export class StubEmailAdapter implements EmailPort {
  /** Caixa de saida observavel pelos testes. */
  readonly outbox: SentEmail[] = [];
  private counter = 0;

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    this.counter += 1;
    const messageId = `stub-email-${this.counter}`;
    this.outbox.push({ ...input, messageId, sentAt: new Date() });
    return { messageId };
  }

  /** Limpa a caixa de saida (entre testes). */
  reset(): void {
    this.outbox.length = 0;
    this.counter = 0;
  }
}

// ------------------------------------------------------------
// Factory — real <-> stub por env.
// ------------------------------------------------------------
export function createEmailAdapter(config: EmailAdapterConfig): EmailPort {
  if (config.useStubs || config.provider !== 'resend') {
    return new StubEmailAdapter();
  }
  return new ResendEmailAdapter(config.resendApiKey ?? '', config.fromEmail);
}
