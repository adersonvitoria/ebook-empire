// MarketDataPort — pesquisa de mercado externa (setor MARKET_RESEARCH).
// Real: SerperMarketDataAdapter (Serper.dev Google Search API via fetch nativo).
// Stub: StubMarketDataAdapter (deterministico, sinais plausiveis para o Brasil).
// A factory escolhe real<->stub por env (MARKET_DATA_PROVIDER / USE_STUBS).
//
// Contrato da Serper.dev (confirmado via WebSearch — fontes:
//   https://serper.dev/ , https://github.com/NightTrek/Serper-search-mcp ,
//   apitracker.io/a/serper-dev):
//   - POST https://google.serper.dev/search
//   - Header: X-API-KEY: <chave>  +  Content-Type: application/json
//   - Body JSON: { q, gl, hl, num? }   (gl='br', hl='pt-br' para o Brasil)
//   - Resposta JSON:
//       searchParameters: { q, gl, hl, ... }
//       knowledgeGraph?:  { title, type, website, description, attributes }
//       organic:          [{ title, link, snippet, position, ... }]
//       peopleAlsoAsk?:   [{ question, snippet, title, link }]
//       relatedSearches?: [{ query }]
//
// O shape bruto da Serper NUNCA vaza para fora deste arquivo: normalizamos para
// MarketSearchResult (ports.ts) — port fino e agnostico de provedor.
//
// Convencoes: scores aqui sao 0..100 (NAO centavos). Strings de log em pt-BR.

import type {
  MarketDataPort,
  MarketSearchInput,
  MarketSearchResult,
  MarketOrganicResult,
  MarketPaaItem,
} from '@ebook-empire/core';

// ------------------------------------------------------------
// Config do adapter (subconjunto do env validado).
// ------------------------------------------------------------
export interface MarketDataAdapterEnv {
  /** true => StubMarketDataAdapter (modo offline/teste). */
  USE_STUBS: boolean;
  /** 'serper' (real) | 'stub'. USE_STUBS=true forca stub mesmo com a chave setada. */
  MARKET_DATA_PROVIDER: 'serper' | 'stub';
  SERPER_API_KEY: string;
  /** default 'br'. */
  MARKET_SEARCH_GL?: string;
  /** default 'pt-br'. */
  MARKET_SEARCH_HL?: string;
}

const SERPER_SEARCH_URL = 'https://google.serper.dev/search';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_GL = 'br';
const DEFAULT_HL = 'pt-br';

// ============================================================
// Shapes BRUTOS da Serper (privados — nao exportados).
// ============================================================
interface SerperOrganicRaw {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

interface SerperPaaRaw {
  question?: string;
  snippet?: string;
  title?: string;
  link?: string;
}

interface SerperRelatedRaw {
  query?: string;
}

interface SerperSearchRaw {
  searchParameters?: { q?: string };
  knowledgeGraph?: Record<string, unknown>;
  organic?: SerperOrganicRaw[];
  peopleAlsoAsk?: SerperPaaRaw[];
  relatedSearches?: SerperRelatedRaw[];
}

// ============================================================
// Normalizacao Serper -> MarketSearchResult (agnostico de provedor).
// Exportada para teste direto do parser (sem rede).
// ============================================================
export function normalizeSerperResponse(
  query: string,
  raw: SerperSearchRaw,
): MarketSearchResult {
  const organic: MarketOrganicResult[] = (raw.organic ?? [])
    .map((o, i) => ({
      title: (o.title ?? '').trim(),
      link: (o.link ?? '').trim(),
      snippet: (o.snippet ?? '').trim(),
      position: typeof o.position === 'number' ? o.position : i + 1,
    }))
    .filter((o) => o.title.length > 0 || o.link.length > 0);

  const peopleAlsoAsk: MarketPaaItem[] = (raw.peopleAlsoAsk ?? [])
    .map((p) => ({
      question: (p.question ?? '').trim(),
      snippet: p.snippet ? p.snippet.trim() : undefined,
    }))
    .filter((p) => p.question.length > 0);

  const relatedSearches: string[] = (raw.relatedSearches ?? [])
    .map((r) => (r.query ?? '').trim())
    .filter((q) => q.length > 0);

  return {
    query: raw.searchParameters?.q ?? query,
    totalOrganic: organic.length,
    organic,
    relatedSearches,
    peopleAlsoAsk,
    knowledgeGraphPresent:
      !!raw.knowledgeGraph && Object.keys(raw.knowledgeGraph).length > 0,
  };
}

// ============================================================
// Real — Serper.dev Google Search API.
// ============================================================
export class SerperMarketDataAdapter implements MarketDataPort {
  private readonly apiKey: string;
  private readonly gl: string;
  private readonly hl: string;
  private readonly timeoutMs: number;

  constructor(opts: {
    apiKey: string;
    gl?: string;
    hl?: string;
    timeoutMs?: number;
  }) {
    if (!opts.apiKey) {
      throw new Error(
        'SerperMarketDataAdapter: SERPER_API_KEY ausente — use o StubMarketDataAdapter ou configure a chave.',
      );
    }
    this.apiKey = opts.apiKey;
    this.gl = opts.gl ?? DEFAULT_GL;
    this.hl = opts.hl ?? DEFAULT_HL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(input: MarketSearchInput): Promise<MarketSearchResult> {
    const body: Record<string, unknown> = {
      q: input.query,
      gl: input.gl ?? this.gl,
      hl: input.hl ?? this.hl,
    };
    if (typeof input.num === 'number') body.num = input.num;

    // Timeout via AbortController (fetch nativo do Node 20).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(SERPER_SEARCH_URL, {
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Serper.dev falhou (rede/timeout): ${message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Serper.dev falhou (${res.status}): ${detail || res.statusText}`,
      );
    }

    const raw = (await res.json()) as SerperSearchRaw;
    return normalizeSerperResponse(input.query, raw);
  }
}

// ============================================================
// Stub — deterministico (sinais plausiveis BR, sem rede).
// ------------------------------------------------------------
// Deriva sinais a partir de um hash da query: numero de organic (oferta),
// presenca de knowledgeGraph (competicao) e perguntas/relacionadas (demanda).
// Mesma query => sempre o mesmo resultado (testes estaveis).
// ============================================================
export class StubMarketDataAdapter implements MarketDataPort {
  async search(input: MarketSearchInput): Promise<MarketSearchResult> {
    const q = input.query.trim();
    const seed = hashStr(q || 'mercado');
    const rnd = makeRng(seed);

    // organic: entre 5 e 10 resultados (proxy de oferta/competicao).
    const organicCount = 5 + Math.floor(rnd() * 6);
    const organic: MarketOrganicResult[] = Array.from(
      { length: organicCount },
      (_unused, i) => ({
        title: `${capitalize(q)} — resultado ${i + 1}`,
        link: `https://exemplo${i + 1}.com.br/${slugifyStub(q)}`,
        snippet: `Conteudo sobre ${q} (resultado simulado ${i + 1}).`,
        position: i + 1,
      }),
    );

    // peopleAlsoAsk: entre 2 e 5 perguntas (proxy de demanda latente).
    const paaCount = 2 + Math.floor(rnd() * 4);
    const paaTemplates = [
      `Como comecar com ${q}?`,
      `Quanto custa ${q}?`,
      `${capitalize(q)} vale a pena?`,
      `Quais os erros comuns em ${q}?`,
      `Como ganhar dinheiro com ${q}?`,
      `${capitalize(q)} para iniciantes: por onde comecar?`,
    ];
    const peopleAlsoAsk: MarketPaaItem[] = paaTemplates
      .slice(0, paaCount)
      .map((question) => ({
        question,
        snippet: `Resposta curta simulada para "${question}".`,
      }));

    // relatedSearches: entre 3 e 6 buscas relacionadas.
    const relCount = 3 + Math.floor(rnd() * 4);
    const relTemplates = [
      `${q} passo a passo`,
      `${q} do zero`,
      `${q} avancado`,
      `curso de ${q}`,
      `${q} pdf`,
      `${q} gratis`,
      `${q} para iniciantes`,
    ];
    const relatedSearches = relTemplates.slice(0, relCount);

    // knowledgeGraph presente ~40% das queries (proxy de marca/competicao forte).
    const knowledgeGraphPresent = rnd() < 0.4;

    return {
      query: q,
      totalOrganic: organic.length,
      organic,
      relatedSearches,
      peopleAlsoAsk,
      knowledgeGraphPresent,
    };
  }
}

// ============================================================
// Factory — real <-> stub por env.
// ------------------------------------------------------------
// USE_STUBS=true OU MARKET_DATA_PROVIDER!='serper' OU sem SERPER_API_KEY -> stub.
// caso contrario -> SerperMarketDataAdapter.
// ============================================================
export function createMarketDataAdapter(env: MarketDataAdapterEnv): MarketDataPort {
  if (env.USE_STUBS || env.MARKET_DATA_PROVIDER !== 'serper' || !env.SERPER_API_KEY) {
    return new StubMarketDataAdapter();
  }
  return new SerperMarketDataAdapter({
    apiKey: env.SERPER_API_KEY,
    gl: env.MARKET_SEARCH_GL,
    hl: env.MARKET_SEARCH_HL,
  });
}

// ------------------------------------------------------------
// Helpers deterministicos do stub.
// ------------------------------------------------------------
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Mulberry32 — PRNG deterministico simples.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function slugifyStub(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'mercado';
}
