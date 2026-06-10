// Testes do StubInstagramAdapter + factory + composeCaption.
import { describe, it, expect } from 'vitest';
import {
  StubInstagramAdapter,
  MetaInstagramAdapter,
  createInstagramAdapter,
  composeCaption,
} from './instagram.js';

describe('composeCaption', () => {
  it('retorna a caption sem alteracao quando nao ha hashtags', () => {
    expect(composeCaption('Ola mundo')).toBe('Ola mundo');
    expect(composeCaption('Ola mundo', [])).toBe('Ola mundo');
  });

  it('anexa hashtags normalizando o prefixo #', () => {
    const out = composeCaption('Texto', ['ebook', '#vendas']);
    expect(out).toBe('Texto\n\n#ebook #vendas');
  });

  it('respeita o limite de 2200 caracteres', () => {
    const longCaption = 'a'.repeat(2300);
    const out = composeCaption(longCaption, ['x']);
    expect(out.length).toBe(2200);
  });
});

describe('StubInstagramAdapter', () => {
  it('uploadMedia registra um container e devolve um id', async () => {
    const ig = new StubInstagramAdapter();
    const res = await ig.uploadMedia({ imageUrl: 'https://x/y.png' });
    expect(res.containerId).toMatch(/^ig_container_/);
    expect(ig.containers).toHaveLength(1);
    expect(ig.containers[0]!.imageUrl).toBe('https://x/y.png');
  });

  it('publishPost registra o post em memoria com permalink', async () => {
    const ig = new StubInstagramAdapter();
    const res = await ig.publishPost({
      caption: 'Compre meu ebook',
      mediaUrl: 'https://x/cover.png',
      hashtags: ['ebook', 'pix'],
    });
    expect(res.externalId).toMatch(/^ig_/);
    expect(res.permalink).toContain(res.externalId);
    expect(ig.published).toHaveLength(1);
    expect(ig.published[0]!.caption).toBe('Compre meu ebook');
    expect(ig.published[0]!.hashtags).toEqual(['ebook', 'pix']);
  });

  it('getPostInsights e deterministico para o mesmo id', async () => {
    const ig = new StubInstagramAdapter();
    const a = await ig.getPostInsights('ig_abc123');
    const b = await ig.getPostInsights('ig_abc123');
    expect(a).toEqual(b);
    expect(a.likes).toBeGreaterThanOrEqual(0);
    expect(a.reach).toBeGreaterThanOrEqual(0);
  });

  it('getAccountInsights cresce com o numero de posts publicados', async () => {
    const ig = new StubInstagramAdapter();
    const before = await ig.getAccountInsights({ since: '2026-01-01', until: '2026-01-02' });
    await ig.publishPost({ caption: 'p', mediaUrl: 'https://x/p.png' });
    const after = await ig.getAccountInsights({ since: '2026-01-01', until: '2026-01-02' });
    expect(after.reach).toBeGreaterThan(before.reach);
    expect(after.followers).toBeGreaterThan(before.followers);
  });
});

describe('createInstagramAdapter (factory)', () => {
  it('USE_STUBS=true -> StubInstagramAdapter', () => {
    const ig = createInstagramAdapter({
      USE_STUBS: true,
      META_GRAPH_TOKEN: 'tok',
      META_AD_ACCOUNT_ID: 'acc',
    });
    expect(ig).toBeInstanceOf(StubInstagramAdapter);
  });

  it('sem token -> cai para stub mesmo com USE_STUBS=false', () => {
    const ig = createInstagramAdapter({
      USE_STUBS: false,
      META_GRAPH_TOKEN: '',
      META_AD_ACCOUNT_ID: '',
    });
    expect(ig).toBeInstanceOf(StubInstagramAdapter);
  });

  it('USE_STUBS=false com token -> MetaInstagramAdapter real', () => {
    const ig = createInstagramAdapter({
      USE_STUBS: false,
      META_GRAPH_TOKEN: 'real-token',
      META_AD_ACCOUNT_ID: '178414000000000',
    });
    expect(ig).toBeInstanceOf(MetaInstagramAdapter);
  });
});
