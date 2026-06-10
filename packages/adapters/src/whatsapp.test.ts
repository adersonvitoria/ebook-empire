// Testes do WhatsAppPort: stub grava na outbox; factory escolhe stub quando
// useStubs=true, provider!='evolution' ou envs Evolution incompletas.

import { describe, expect, it } from 'vitest';

import {
  createWhatsAppAdapter,
  EvolutionWhatsAppAdapter,
  StubWhatsAppAdapter,
} from './whatsapp.js';

describe('StubWhatsAppAdapter', () => {
  it('grava mensagens enviadas na outbox', async () => {
    const stub = new StubWhatsAppAdapter();
    await stub.sendMessage('5511999999999', 'Ola afiliado!');
    await stub.sendMessage('5511888888888', 'Oferta de comissao.');

    expect(stub.outbox).toHaveLength(2);
    expect(stub.outbox[0]?.to).toBe('5511999999999');
    expect(stub.outbox[0]?.text).toBe('Ola afiliado!');
    expect(stub.outbox[1]?.to).toBe('5511888888888');
  });

  it('reset limpa a outbox', async () => {
    const stub = new StubWhatsAppAdapter();
    await stub.sendMessage('5511999999999', 'oi');
    stub.reset();
    expect(stub.outbox).toHaveLength(0);
  });
});

describe('EvolutionWhatsAppAdapter', () => {
  it('lanca quando faltam credenciais', () => {
    expect(
      () => new EvolutionWhatsAppAdapter({ baseUrl: '', apiKey: '', instance: '' }),
    ).toThrowError(/EVOLUTION_API_URL/);
  });
});

describe('createWhatsAppAdapter', () => {
  it('retorna stub quando useStubs=true mesmo com Evolution configurado', () => {
    const adapter = createWhatsAppAdapter({
      useStubs: true,
      whatsappProvider: 'evolution',
      evolutionApiUrl: 'https://evo.example.com',
      evolutionApiKey: 'k',
      evolutionInstance: 'i',
    });
    expect(adapter).toBeInstanceOf(StubWhatsAppAdapter);
  });

  it('retorna stub quando provider=stub', () => {
    const adapter = createWhatsAppAdapter({
      useStubs: false,
      whatsappProvider: 'stub',
    });
    expect(adapter).toBeInstanceOf(StubWhatsAppAdapter);
  });

  it('retorna stub quando envs Evolution incompletas', () => {
    const adapter = createWhatsAppAdapter({
      useStubs: false,
      whatsappProvider: 'evolution',
      evolutionApiUrl: 'https://evo.example.com',
      // sem apiKey/instance
    });
    expect(adapter).toBeInstanceOf(StubWhatsAppAdapter);
  });

  it('retorna Evolution real quando !useStubs + provider=evolution + envs completas', () => {
    const adapter = createWhatsAppAdapter({
      useStubs: false,
      whatsappProvider: 'evolution',
      evolutionApiUrl: 'https://evo.example.com',
      evolutionApiKey: 'k',
      evolutionInstance: 'i',
    });
    expect(adapter).toBeInstanceOf(EvolutionWhatsAppAdapter);
  });
});
