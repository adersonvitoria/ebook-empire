// Testes do LLM adapter — foco no StubLLMAdapter (deterministico) e helpers.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  StubLLMAdapter,
  AnthropicLLMAdapter,
  createLLMAdapter,
  estimateCostCents,
  extractJson,
} from './llm.js';

describe('estimateCostCents', () => {
  it('retorna Int >= 0 em centavos', () => {
    const c = estimateCostCents('claude-sonnet-4-6', 1000, 1000);
    expect(Number.isInteger(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(0);
  });
  it('opus custa mais que sonnet para o mesmo uso', () => {
    const sonnet = estimateCostCents('claude-sonnet-4-6', 10_000, 10_000);
    const opus = estimateCostCents('claude-opus-4-8', 10_000, 10_000);
    expect(opus).toBeGreaterThan(sonnet);
  });
});

describe('extractJson', () => {
  it('faz parse de JSON puro', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('faz parse de JSON em cerca markdown', () => {
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it('recorta JSON cercado por texto', () => {
    expect(extractJson('lixo antes {"a":3} lixo depois')).toEqual({ a: 3 });
  });
  it('lanca em texto sem JSON', () => {
    expect(() => extractJson('sem json aqui')).toThrow();
  });
});

describe('StubLLMAdapter', () => {
  const stub = new StubLLMAdapter();

  it('generateText retorna texto + usage com tokens > 0', async () => {
    const res = await stub.generateText({
      model: 'claude-sonnet-4-6',
      maxTokens: 500,
      messages: [{ role: 'user', content: 'escreva algo sobre vendas' }],
    });
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
  });

  it('generateJson valida pelo parser e e deterministico', async () => {
    const schema = z.object({
      title: z.string(),
      niche: z.string(),
      chapters: z.array(z.object({ title: z.string(), summary: z.string() })).min(3),
    });
    const input = {
      model: 'claude-sonnet-4-6',
      maxTokens: 1000,
      messages: [{ role: 'user' as const, content: 'nicho: Culinaria Fit' }],
      parse: (raw: unknown) => schema.parse(raw),
    };
    const a = await stub.generateJson(input);
    const b = await stub.generateJson(input);
    expect(a.data).toEqual(b.data); // deterministico
    expect(a.data.niche).toBe('Culinaria Fit');
    expect(a.data.chapters.length).toBeGreaterThanOrEqual(3);
  });
});

describe('createLLMAdapter', () => {
  it('retorna stub quando USE_STUBS=true', () => {
    const a = createLLMAdapter({ USE_STUBS: true, ANTHROPIC_API_KEY: 'sk-x' });
    expect(a).toBeInstanceOf(StubLLMAdapter);
  });
  it('retorna stub quando sem ANTHROPIC_API_KEY mesmo com USE_STUBS=false', () => {
    const a = createLLMAdapter({ USE_STUBS: false, ANTHROPIC_API_KEY: '' });
    expect(a).toBeInstanceOf(StubLLMAdapter);
  });
  it('retorna AnthropicLLMAdapter quando real + chave presente', () => {
    const a = createLLMAdapter({ USE_STUBS: false, ANTHROPIC_API_KEY: 'sk-test' });
    expect(a).toBeInstanceOf(AnthropicLLMAdapter);
  });
});
