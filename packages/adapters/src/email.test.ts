// Testes do EmailPort: stub grava na outbox; factory escolhe stub quando
// useStubs=true e quando provider nao e 'resend'.

import { describe, expect, it } from 'vitest';

import { createEmailAdapter, StubEmailAdapter } from './email.js';

describe('StubEmailAdapter', () => {
  it('grava emails enviados na outbox e retorna messageId', async () => {
    const stub = new StubEmailAdapter();
    const r1 = await stub.send({ to: 'a@b.com', subject: 'oi', html: '<p>oi</p>' });
    const r2 = await stub.send({ to: 'c@d.com', subject: 'ola', html: '<p>ola</p>' });

    expect(r1.messageId).toBe('stub-email-1');
    expect(r2.messageId).toBe('stub-email-2');
    expect(stub.outbox).toHaveLength(2);
    expect(stub.outbox[0]?.to).toBe('a@b.com');
    expect(stub.outbox[1]?.subject).toBe('ola');
  });

  it('reset limpa a outbox', async () => {
    const stub = new StubEmailAdapter();
    await stub.send({ to: 'a@b.com', subject: 's', html: 'h' });
    stub.reset();
    expect(stub.outbox).toHaveLength(0);
  });
});

describe('createEmailAdapter', () => {
  it('retorna stub quando useStubs=true', () => {
    const e = createEmailAdapter({ useStubs: true, provider: 'resend', resendApiKey: 'k' });
    expect(e).toBeInstanceOf(StubEmailAdapter);
  });

  it('retorna stub quando provider nao e resend', () => {
    const e = createEmailAdapter({ useStubs: false });
    expect(e).toBeInstanceOf(StubEmailAdapter);
  });
});
