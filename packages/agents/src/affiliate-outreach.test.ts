// Testes do AffiliateOutreachAgent com StubLLM + StubEmail + StubWhatsApp (inline)
// e fake Prisma minimo. Exercita: pick PROSPECT elegivel -> gera copy -> email
// (+ whatsapp opcional) -> AffiliateOutreach -> Event(AFFILIATE_CONTACTED) ->
// lastContactedAt; cooldown -> SKIPPED; runForAffiliate (lever SEND_AFFILIATE_EMAIL).

import { describe, it, expect, vi } from 'vitest';
import type {
  EmailPort,
  EmailSendInput,
  EmailSendResult,
  LLMPort,
  LLMGenerateTextInput,
  LLMGenerateTextResult,
  LLMGenerateJsonInput,
  LLMGenerateJsonResult,
  Ports,
  WhatsAppPort,
} from '@ebook-empire/core';
import { AffiliateOutreachAgent } from './affiliate-outreach.js';
import type { AgentContext, AgentEnv, AgentLogger, Clock } from './base.js';

// ------------------------------------------------------------
// Stubs de ports (inline).
// ------------------------------------------------------------
class StubLLMAdapter implements LLMPort {
  calls = 0;
  async generateText(_input: LLMGenerateTextInput): Promise<LLMGenerateTextResult> {
    return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async generateJson<T>(input: LLMGenerateJsonInput<T>): Promise<LLMGenerateJsonResult<T>> {
    this.calls += 1;
    const raw = {
      subject: 'Seja nosso afiliado e ganhe 30% por venda',
      emailBody: 'Ola! Convidamos voce a promover nossos ebooks.\nComissao recorrente.',
      whatsappBody: 'Oi! Promova nossos ebooks e ganhe 30% por venda. Topa?',
    };
    const data = input.parse(raw);
    return { data, usage: { inputTokens: 100, outputTokens: 50, costCents: 2 } };
  }
}

class StubEmailAdapter implements EmailPort {
  readonly outbox: EmailSendInput[] = [];
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    this.outbox.push(input);
    return { messageId: `stub-email-${this.outbox.length}` };
  }
}

class StubWhatsAppAdapter implements WhatsAppPort {
  readonly outbox: Array<{ to: string; text: string }> = [];
  failNext = false;
  async sendMessage(to: string, text: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('WA indisponivel');
    }
    this.outbox.push({ to, text });
  }
}

// ------------------------------------------------------------
// Fake Prisma minimo.
// ------------------------------------------------------------
interface FakeAffiliate {
  id: string;
  name: string;
  email: string;
  whatsappNumber: string | null;
  commissionPct: number;
  ebookId: string | null;
  status: string;
  lastContactedAt: Date | null;
  createdAt: Date;
}

function makeFakePrisma(opts: {
  affiliates: FakeAffiliate[];
  ebooks?: Array<{ id: string; niche: string }>;
}) {
  const affiliates = opts.affiliates;
  const ebooks = opts.ebooks ?? [];
  const outreaches: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];

  const prisma = {
    affiliate: {
      findMany: vi.fn(async ({ where, take }: any = {}) => {
        let rows = affiliates.slice();
        if (where?.status) rows = rows.filter((a) => a.status === where.status);
        if (where?.OR) {
          const cutoff: Date | undefined = where.OR.find((o: any) => o.lastContactedAt?.lt)
            ?.lastContactedAt?.lt;
          rows = rows.filter(
            (a) =>
              a.lastContactedAt === null ||
              (cutoff ? a.lastContactedAt.getTime() < cutoff.getTime() : true),
          );
        }
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return (take ? rows.slice(0, take) : rows).map((a) => ({ ...a }));
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const a = affiliates.find((x) => x.id === where.id);
        return a ? { ...a } : null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const a = affiliates.find((x) => x.id === where.id);
        if (!a) throw new Error('not found');
        if (data.lastContactedAt !== undefined) a.lastContactedAt = data.lastContactedAt;
        return { ...a };
      }),
    },
    affiliateOutreach: {
      create: vi.fn(async ({ data }: any) => {
        outreaches.push(data);
        return { id: `out_${outreaches.length}`, ...data };
      }),
    },
    ebook: {
      findUnique: vi.fn(async ({ where }: any) => {
        const e = ebooks.find((x) => x.id === where.id);
        return e ? { niche: e.niche } : null;
      }),
    },
    event: {
      create: vi.fn(async ({ data }: any) => {
        events.push(data);
        return { id: `ev_${events.length}`, ...data };
      }),
    },
    agentRun: {
      create: vi.fn(async () => ({ id: 'run_1' })),
      update: vi.fn(async ({ data }: any) => ({
        id: 'run_1',
        agent: 'AFFILIATE',
        status: data.status,
        startedAt: new Date(),
        finishedAt: data.finishedAt ?? new Date(),
        durationMs: data.durationMs ?? 0,
      })),
    },
  };

  return { prisma, affiliates, outreaches, events };
}

// ------------------------------------------------------------
// Helpers de contexto.
// ------------------------------------------------------------
const silentLog: AgentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const fixedClock: Clock = { now: () => new Date('2026-06-10T12:00:00Z') };

const agentEnv: AgentEnv = {
  ENABLE_AGENTS: true,
  MAX_AD_BUDGET_BRL: 300,
  TARGET_DAILY_REVENUE_BRL: 1000,
  PUBLIC_BASE_URL: 'http://localhost:3001',
  CONTENT_MODEL: 'claude-sonnet-4-6',
  PLANNING_MODEL: 'claude-opus-4-8',
  AFFILIATE_OUTREACH_COOLDOWN_DAYS: 7,
};

function makeCtx(
  prisma: any,
  ports: { llm: LLMPort; email: EmailPort; whatsapp?: WhatsAppPort },
): AgentContext {
  return {
    prisma,
    ports: ports as unknown as Ports,
    env: agentEnv,
    log: silentLog,
    clock: fixedClock,
  };
}

function prospect(over: Partial<FakeAffiliate> = {}): FakeAffiliate {
  return {
    id: 'af1',
    name: 'Joao Afiliado',
    email: 'joao@afiliado.com',
    whatsappNumber: null,
    commissionPct: 30,
    ebookId: null,
    status: 'PROSPECT',
    lastContactedAt: null,
    createdAt: new Date('2026-06-01'),
    ...over,
  };
}

describe('AffiliateOutreachAgent', () => {
  it('contata PROSPECT novo: email + outreach + evento + lastContactedAt', async () => {
    const { prisma, affiliates, outreaches, events } = makeFakePrisma({
      affiliates: [prospect({ ebookId: 'eb1' })],
      ebooks: [{ id: 'eb1', niche: 'financas pessoais' }],
    });
    const llm = new StubLLMAdapter();
    const email = new StubEmailAdapter();

    const result = await new AffiliateOutreachAgent().run(makeCtx(prisma, { llm, email }));

    expect(result.status).toBe('SUCCESS');
    expect((result.output as any).contacted).toBe(1);
    expect(llm.calls).toBe(1);
    expect(email.outbox).toHaveLength(1);
    expect(email.outbox[0]?.to).toBe('joao@afiliado.com');
    expect(email.outbox[0]?.subject).toContain('afiliado');

    // 1 outreach EMAIL.
    expect(outreaches).toHaveLength(1);
    expect((outreaches[0] as any).channel).toBe('EMAIL');

    // Evento AFFILIATE_CONTACTED com affiliateId no payload.
    const ev = events.find((e) => (e as any).type === 'AFFILIATE_CONTACTED') as any;
    expect(ev).toBeTruthy();
    expect(ev.payload.affiliateId).toBe('af1');
    expect(ev.payload.channels).toEqual(['EMAIL']);
    expect(ev.payload.niche).toBe('financas pessoais');

    // lastContactedAt atualizado.
    expect(affiliates[0]?.lastContactedAt?.toISOString()).toBe('2026-06-10T12:00:00.000Z');
  });

  it('envia tambem por WhatsApp quando ha numero + port', async () => {
    const { prisma, outreaches, events } = makeFakePrisma({
      affiliates: [prospect({ whatsappNumber: '5511999999999' })],
    });
    const llm = new StubLLMAdapter();
    const email = new StubEmailAdapter();
    const whatsapp = new StubWhatsAppAdapter();

    const result = await new AffiliateOutreachAgent().run(
      makeCtx(prisma, { llm, email, whatsapp }),
    );

    expect(result.status).toBe('SUCCESS');
    expect(whatsapp.outbox).toHaveLength(1);
    expect(whatsapp.outbox[0]?.to).toBe('5511999999999');
    // 2 outreaches: EMAIL + WHATSAPP.
    expect(outreaches.map((o) => (o as any).channel)).toEqual(['EMAIL', 'WHATSAPP']);
    const ev = events.find((e) => (e as any).type === 'AFFILIATE_CONTACTED') as any;
    expect(ev.payload.channels).toEqual(['EMAIL', 'WHATSAPP']);
  });

  it('falha de WhatsApp nao derruba o email (outreach WHATSAPP=FAILED)', async () => {
    const { prisma, outreaches } = makeFakePrisma({
      affiliates: [prospect({ whatsappNumber: '5511999999999' })],
    });
    const llm = new StubLLMAdapter();
    const email = new StubEmailAdapter();
    const whatsapp = new StubWhatsAppAdapter();
    whatsapp.failNext = true;

    const result = await new AffiliateOutreachAgent().run(
      makeCtx(prisma, { llm, email, whatsapp }),
    );

    expect(result.status).toBe('SUCCESS');
    expect(email.outbox).toHaveLength(1);
    expect(whatsapp.outbox).toHaveLength(0);
    const wa = outreaches.find((o) => (o as any).channel === 'WHATSAPP') as any;
    expect(wa.status).toBe('FAILED');
  });

  it('ignora WhatsApp quando o port nao foi injetado (so email)', async () => {
    const { prisma, outreaches } = makeFakePrisma({
      affiliates: [prospect({ whatsappNumber: '5511999999999' })],
    });
    const llm = new StubLLMAdapter();
    const email = new StubEmailAdapter();

    const result = await new AffiliateOutreachAgent().run(makeCtx(prisma, { llm, email }));

    expect(result.status).toBe('SUCCESS');
    expect(outreaches.map((o) => (o as any).channel)).toEqual(['EMAIL']);
  });

  it('SKIPPED quando nao ha PROSPECT elegivel (cooldown)', async () => {
    // lastContactedAt recente (2 dias atras < 7 de cooldown).
    const recent = new Date('2026-06-08T12:00:00Z');
    const { prisma } = makeFakePrisma({
      affiliates: [prospect({ lastContactedAt: recent })],
    });
    const llm = new StubLLMAdapter();
    const email = new StubEmailAdapter();

    const result = await new AffiliateOutreachAgent().run(makeCtx(prisma, { llm, email }));

    expect(result.status).toBe('SKIPPED');
    expect(llm.calls).toBe(0);
    expect(email.outbox).toHaveLength(0);
  });

  it('runForAffiliate contata um afiliado especifico (lever SEND_AFFILIATE_EMAIL)', async () => {
    const { prisma, affiliates, events } = makeFakePrisma({
      affiliates: [prospect({ id: 'afX', email: 'x@y.com' })],
    });
    const llm = new StubLLMAdapter();
    const email = new StubEmailAdapter();

    const ok = await new AffiliateOutreachAgent().runForAffiliate(
      makeCtx(prisma, { llm, email }),
      'afX',
    );

    expect(ok).toBe(true);
    expect(email.outbox[0]?.to).toBe('x@y.com');
    expect(events.some((e) => (e as any).type === 'AFFILIATE_CONTACTED')).toBe(true);
    expect(affiliates[0]?.lastContactedAt).not.toBeNull();
  });

  it('runForAffiliate devolve false para afiliado inexistente/unsubscribed', async () => {
    const { prisma } = makeFakePrisma({
      affiliates: [prospect({ id: 'afU', status: 'UNSUBSCRIBED' })],
    });
    const llm = new StubLLMAdapter();
    const email = new StubEmailAdapter();
    const agent = new AffiliateOutreachAgent();
    const ctx = makeCtx(prisma, { llm, email });

    expect(await agent.runForAffiliate(ctx, 'missing')).toBe(false);
    expect(await agent.runForAffiliate(ctx, 'afU')).toBe(false);
    expect(email.outbox).toHaveLength(0);
  });
});
