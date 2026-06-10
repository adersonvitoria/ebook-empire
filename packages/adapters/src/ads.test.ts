// Testes do StubAdsAdapter — numeros simulados realistas e deterministicos.

import { describe, it, expect } from 'vitest';
import {
  StubAdsAdapter,
  createAdsAdapter,
  enumerateDays,
  MetaAdsAdapter,
} from './ads.js';
import type { CreateAdCampaignInput } from '@ebook-empire/core';

const baseInput: CreateAdCampaignInput = {
  name: 'Teste',
  objective: 'OUTCOME_SALES',
  dailyBudgetCents: 5000, // R$50/dia
  targeting: { geo_locations: { countries: ['BR'] } },
  utmCampaign: 'eb-teste',
  destinationUrl: 'http://localhost:3001/p/teste?utm_campaign=eb-teste',
};

describe('enumerateDays', () => {
  it('enumera dias inclusivos', () => {
    expect(enumerateDays('2026-06-01', '2026-06-03')).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ]);
  });

  it('retorna unico dia quando since=until', () => {
    expect(enumerateDays('2026-06-10', '2026-06-10')).toEqual(['2026-06-10']);
  });

  it('retorna vazio quando since > until', () => {
    expect(enumerateDays('2026-06-10', '2026-06-01')).toEqual([]);
  });
});

describe('StubAdsAdapter', () => {
  it('cria campanha e a guarda como PAUSED', async () => {
    const ads = new StubAdsAdapter();
    const { externalId } = await ads.createCampaign(baseInput);
    expect(externalId).toMatch(/^stub-camp-/);
    expect(ads.campaigns).toHaveLength(1);
    expect(ads.campaigns[0]!.status).toBe('PAUSED');
  });

  it('updateBudget faz SET absoluto (idempotente)', async () => {
    const ads = new StubAdsAdapter();
    const { externalId } = await ads.createCampaign(baseInput);
    await ads.updateBudget(externalId, 9000);
    await ads.updateBudget(externalId, 9000);
    expect(ads.campaigns[0]!.dailyBudgetCents).toBe(9000);
  });

  it('setStatus altera o status da campanha', async () => {
    const ads = new StubAdsAdapter();
    const { externalId } = await ads.createCampaign(baseInput);
    await ads.setStatus(externalId, 'ACTIVE');
    expect(ads.campaigns[0]!.status).toBe('ACTIVE');
  });

  it('insights sao deterministicos por (externalId+date+seed)', async () => {
    const a = new StubAdsAdapter(42);
    const b = new StubAdsAdapter(42);
    const { externalId: ea } = await a.createCampaign(baseInput);
    const { externalId: eb } = await b.createCampaign(baseInput);
    // externalId difere (nanoid), mas a forma e a mesma seed -> testamos estabilidade
    // de UMA mesma instancia entre chamadas.
    const r1 = await a.getInsights(ea, { since: '2026-06-01', until: '2026-06-03' });
    const r2 = await a.getInsights(ea, { since: '2026-06-01', until: '2026-06-03' });
    expect(r1).toEqual(r2);
    expect(eb).not.toEqual(ea); // sanidade: ids unicos
  });

  it('insights tem numeros realistas (CPM/CTR/CR BR)', async () => {
    const ads = new StubAdsAdapter(7);
    const { externalId } = await ads.createCampaign(baseInput);
    const rows = await ads.getInsights(externalId, { since: '2026-06-01', until: '2026-06-05' });

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      // spend entre 70% e 100% do budget diario (5000c).
      expect(row.spendCents).toBeGreaterThanOrEqual(Math.round(5000 * 0.7));
      expect(row.spendCents).toBeLessThanOrEqual(5000);
      // CPM R$15-35 => para R$50, impressoes na ordem de 1.4k-3.3k.
      expect(row.impressions).toBeGreaterThan(1000);
      expect(row.impressions).toBeLessThan(4000);
      // CTR 1%-2.5% => clicks ~ 1%-2.5% das impressoes.
      const ctr = row.clicks / row.impressions;
      expect(ctr).toBeGreaterThanOrEqual(0.008);
      expect(ctr).toBeLessThanOrEqual(0.03);
      // conversoes <= clicks.
      expect(row.conversions).toBeLessThanOrEqual(row.clicks);
      expect(row.conversions).toBeGreaterThanOrEqual(0);
    }
  });

  it('spend escala com o budget configurado', async () => {
    const ads = new StubAdsAdapter(3);
    const { externalId } = await ads.createCampaign({ ...baseInput, dailyBudgetCents: 20000 });
    const rows = await ads.getInsights(externalId, { since: '2026-06-01', until: '2026-06-01' });
    expect(rows[0]!.spendCents).toBeGreaterThan(10000);
  });
});

describe('createAdsAdapter factory', () => {
  it('retorna StubAdsAdapter quando useStubs=true', () => {
    const ads = createAdsAdapter({ useStubs: true });
    expect(ads).toBeInstanceOf(StubAdsAdapter);
  });

  it('retorna MetaAdsAdapter quando useStubs=false e credenciais presentes', () => {
    const ads = createAdsAdapter({
      useStubs: false,
      metaGraphToken: 'tok',
      metaAdAccountId: '123',
    });
    expect(ads).toBeInstanceOf(MetaAdsAdapter);
  });

  it('degrada para StubAdsAdapter quando useStubs=false mas falta o token', () => {
    // Contrato atual (commit dba0eca): a factory NAO derruba o boot quando o
    // canal Ads ainda nao tem credencial — degrada para o stub em vez de lancar.
    const ads = createAdsAdapter({ useStubs: false, metaAdAccountId: '123' });
    expect(ads).toBeInstanceOf(StubAdsAdapter);
  });

  it('MetaAdsAdapter (ctor direto) lanca sem token', () => {
    // O invariante de "token obrigatorio" continua valendo no ctor do adapter real.
    expect(() => new MetaAdsAdapter('', '123')).toThrow();
  });
});
