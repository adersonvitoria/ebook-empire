// Testes do MarketDataPort (Serper real com fetch mockado + Stub deterministico).
// Sem rede real: o SerperMarketDataAdapter usa fetch nativo, que mockamos.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SerperMarketDataAdapter,
  StubMarketDataAdapter,
  createMarketDataAdapter,
  normalizeSerperResponse,
} from './market-data.js';

// Resposta bruta da Serper conforme contrato confirmado (organic/peopleAlsoAsk/
// relatedSearches/knowledgeGraph/searchParameters).
const SERPER_RAW = {
  searchParameters: { q: 'como investir do zero', gl: 'br', hl: 'pt-br' },
  knowledgeGraph: { title: 'Investimento', type: 'Conceito' },
  organic: [
    { title: 'Como investir', link: 'https://a.com.br', snippet: 'guia', position: 1 },
    { title: 'Investir 2026', link: 'https://b.com.br', snippet: 'dicas', position: 2 },
  ],
  peopleAlsoAsk: [
    { question: 'Como comecar a investir?', snippet: 'Comece pequeno.' },
    { question: 'Qual o melhor investimento?', snippet: 'Depende do perfil.' },
  ],
  relatedSearches: [{ query: 'investir em renda fixa' }, { query: 'investir na bolsa' }],
};

describe('normalizeSerperResponse', () => {
  it('normaliza o shape bruto da Serper para MarketSearchResult', () => {
    const r = normalizeSerperResponse('como investir do zero', SERPER_RAW);
    expect(r.query).toBe('como investir do zero');
    expect(r.totalOrganic).toBe(2);
    expect(r.organic[0]!).toMatchObject({ title: 'Como investir', position: 1 });
    expect(r.peopleAlsoAsk).toHaveLength(2);
    expect(r.peopleAlsoAsk[0]!.question).toBe('Como comecar a investir?');
    expect(r.relatedSearches).toEqual(['investir em renda fixa', 'investir na bolsa']);
    expect(r.knowledgeGraphPresent).toBe(true);
  });

  it('tolera campos ausentes (sem knowledgeGraph/paa/related)', () => {
    const r = normalizeSerperResponse('nicho vazio', { organic: [] });
    expect(r.totalOrganic).toBe(0);
    expect(r.peopleAlsoAsk).toEqual([]);
    expect(r.relatedSearches).toEqual([]);
    expect(r.knowledgeGraphPresent).toBe(false);
  });
});

describe('SerperMarketDataAdapter (fetch mockado)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('faz POST com X-API-KEY + body {q,gl,hl} e normaliza a resposta', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => SERPER_RAW,
      text: async () => '',
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const adapter = new SerperMarketDataAdapter({ apiKey: 'k-123', gl: 'br', hl: 'pt-br' });
    const result = await adapter.search({ query: 'como investir do zero', num: 10 });

    // Verifica a requisicao (contrato confirmado).
    const [url, init] = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(url).toBe('https://google.serper.dev/search');
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe('POST');
    const headers = reqInit.headers as Record<string, string>;
    expect(headers['X-API-KEY']).toBe('k-123');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(reqInit.body as string);
    expect(body).toMatchObject({ q: 'como investir do zero', gl: 'br', hl: 'pt-br', num: 10 });

    // Verifica a normalizacao.
    expect(result.totalOrganic).toBe(2);
    expect(result.peopleAlsoAsk).toHaveLength(2);
    expect(result.knowledgeGraphPresent).toBe(true);
  });

  it('lanca erro claro quando a Serper responde nao-2xx', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({}),
      text: async () => 'chave invalida',
    })) as unknown as typeof fetch;

    const adapter = new SerperMarketDataAdapter({ apiKey: 'bad' });
    await expect(adapter.search({ query: 'x' })).rejects.toThrow(/Serper\.dev falhou \(403\)/);
  });

  it('exige SERPER_API_KEY no construtor', () => {
    expect(() => new SerperMarketDataAdapter({ apiKey: '' })).toThrow(/SERPER_API_KEY ausente/);
  });
});

describe('StubMarketDataAdapter (deterministico)', () => {
  it('retorna sinais plausiveis e estaveis para a mesma query', async () => {
    const a = new StubMarketDataAdapter();
    const r1 = await a.search({ query: 'gestao de tempo' });
    const r2 = await a.search({ query: 'gestao de tempo' });
    expect(r1).toEqual(r2); // deterministico
    expect(r1.organic.length).toBeGreaterThanOrEqual(5);
    expect(r1.peopleAlsoAsk.length).toBeGreaterThanOrEqual(2);
    expect(r1.relatedSearches.length).toBeGreaterThanOrEqual(3);
  });

  it('queries diferentes produzem sinais diferentes', async () => {
    const a = new StubMarketDataAdapter();
    const r1 = await a.search({ query: 'nicho-a' });
    const r2 = await a.search({ query: 'nicho-b-totalmente-diferente' });
    expect(r1.organic.length === r2.organic.length && r1.peopleAlsoAsk.length === r2.peopleAlsoAsk.length).not.toBe(
      true,
    );
  });
});

describe('createMarketDataAdapter (factory por env)', () => {
  it('USE_STUBS=true => StubMarketDataAdapter mesmo com chave/serper', () => {
    const a = createMarketDataAdapter({
      USE_STUBS: true,
      MARKET_DATA_PROVIDER: 'serper',
      SERPER_API_KEY: 'k',
    });
    expect(a).toBeInstanceOf(StubMarketDataAdapter);
  });

  it('provider=stub => StubMarketDataAdapter', () => {
    const a = createMarketDataAdapter({
      USE_STUBS: false,
      MARKET_DATA_PROVIDER: 'stub',
      SERPER_API_KEY: 'k',
    });
    expect(a).toBeInstanceOf(StubMarketDataAdapter);
  });

  it('serper sem chave => cai no stub (fail-safe)', () => {
    const a = createMarketDataAdapter({
      USE_STUBS: false,
      MARKET_DATA_PROVIDER: 'serper',
      SERPER_API_KEY: '',
    });
    expect(a).toBeInstanceOf(StubMarketDataAdapter);
  });

  it('serper + chave + USE_STUBS=false => SerperMarketDataAdapter', () => {
    const a = createMarketDataAdapter({
      USE_STUBS: false,
      MARKET_DATA_PROVIDER: 'serper',
      SERPER_API_KEY: 'k-real',
    });
    expect(a).toBeInstanceOf(SerperMarketDataAdapter);
  });
});
