// Testes da FUNDACAO de producao autonoma (fases 3-5) no core.
// Cobrem: novos ActionKinds, novos ProblemTypes, setores novos (CrmSector),
// schema de params dos novos kinds, e o invariante de NAO regressao dos 7
// setores de saude (SECTORS/SECTOR_WEIGHTS intactos => health-collector verde).

import { describe, it, expect } from 'vitest';

import {
  actionKindSchema,
  problemTypeSchema,
  crmSectorSchema,
  sectorSchema,
  remediationParamsSchema,
  SECTORS,
  SECTOR_WEIGHTS,
  CRM_SECTORS,
  CRM_NEW_SECTORS,
  PRODUCTION_SECTOR_WEIGHTS,
  buildDedupeKey,
  type ActionKind,
  type CrmSector,
} from './crm.js';
import { paymentProviderSchema, agentNameSchema, eventTypeSchema } from './schemas.js';

describe('novos ActionKinds (LOCALIZACAO 2 da regra das 4)', () => {
  const novos: ActionKind[] = [
    'GENERATE_MORE_EBOOKS',
    'PAUSE_LISTING',
    'BOOST_AFFILIATE_OUTREACH',
    'SEND_AFFILIATE_EMAIL',
  ];

  it('aceita os 4 novos kinds no actionKindSchema', () => {
    for (const k of novos) {
      expect(actionKindSchema.parse(k)).toBe(k);
    }
  });

  it('mantem os kinds originais (nao-regressao)', () => {
    expect(actionKindSchema.parse('RETRY_DELIVERIES')).toBe('RETRY_DELIVERIES');
    expect(actionKindSchema.parse('ADJUST_PRICE')).toBe('ADJUST_PRICE');
  });

  it('rejeita kind inexistente', () => {
    expect(actionKindSchema.safeParse('DELETE_EVERYTHING').success).toBe(false);
  });
});

describe('params tipados dos novos kinds (remediationParamsSchema)', () => {
  it('GENERATE_MORE_EBOOKS aceita niche/count opcionais', () => {
    expect(remediationParamsSchema.parse({ kind: 'GENERATE_MORE_EBOOKS' })).toMatchObject({
      kind: 'GENERATE_MORE_EBOOKS',
    });
    expect(
      remediationParamsSchema.parse({ kind: 'GENERATE_MORE_EBOOKS', niche: 'Financas', count: 3 }),
    ).toMatchObject({ niche: 'Financas', count: 3 });
  });

  it('PAUSE_LISTING exige productId + provider', () => {
    expect(
      remediationParamsSchema.parse({ kind: 'PAUSE_LISTING', productId: 'p1', provider: 'HOTMART' }),
    ).toMatchObject({ productId: 'p1', provider: 'HOTMART' });
    expect(remediationParamsSchema.safeParse({ kind: 'PAUSE_LISTING' }).success).toBe(false);
  });

  it('BOOST_AFFILIATE_OUTREACH aceita ebookId/limit opcionais', () => {
    expect(remediationParamsSchema.parse({ kind: 'BOOST_AFFILIATE_OUTREACH' })).toMatchObject({
      kind: 'BOOST_AFFILIATE_OUTREACH',
    });
  });

  it('SEND_AFFILIATE_EMAIL exige affiliateId + templateKey', () => {
    expect(
      remediationParamsSchema.parse({
        kind: 'SEND_AFFILIATE_EMAIL',
        affiliateId: 'a1',
        templateKey: 'convite_v1',
      }),
    ).toMatchObject({ affiliateId: 'a1', templateKey: 'convite_v1' });
    expect(
      remediationParamsSchema.safeParse({ kind: 'SEND_AFFILIATE_EMAIL', affiliateId: 'a1' }).success,
    ).toBe(false);
  });

  it('buildDedupeKey continua deterministico para os novos kinds', () => {
    const a = buildDedupeKey('prob1', 'SEND_AFFILIATE_EMAIL', { affiliateId: 'a1', templateKey: 't' });
    const b = buildDedupeKey('prob1', 'SEND_AFFILIATE_EMAIL', { templateKey: 't', affiliateId: 'a1' });
    expect(a).toBe(b);
  });
});

describe('novos ProblemTypes', () => {
  const novos = [
    'DEAD_LISTING',
    'MISSING_COVER',
    'LANDING_DROPOFF',
    'HIGH_CART_ABANDONMENT',
    'NO_AFFILIATE_ACTIVITY',
    'AFFILIATE_REVENUE_ZERO',
  ];
  it('aceita os 6 novos tipos', () => {
    for (const t of novos) expect(problemTypeSchema.parse(t)).toBe(t);
  });
  it('mantem os tipos originais', () => {
    expect(problemTypeSchema.parse('DELIVERY_BACKLOG')).toBe('DELIVERY_BACKLOG');
  });
});

describe('setores de producao (CrmSector) sem regredir os 7 de saude', () => {
  it('crmSectorSchema aceita os 3 novos setores', () => {
    for (const s of ['MARKETPLACE', 'FUNNEL', 'AFFILIATE']) {
      expect(crmSectorSchema.parse(s)).toBe(s);
    }
  });

  it('sectorSchema (saude) NAO aceita os novos setores (loop dos 7 intacto)', () => {
    expect(sectorSchema.safeParse('MARKETPLACE').success).toBe(false);
    expect(sectorSchema.safeParse('FUNNEL').success).toBe(false);
    expect(sectorSchema.safeParse('AFFILIATE').success).toBe(false);
  });

  it('SECTORS e SECTOR_WEIGHTS permanecem com exatamente 7 setores', () => {
    expect(SECTORS).toHaveLength(7);
    expect(Object.keys(SECTOR_WEIGHTS)).toHaveLength(7);
  });

  it('CRM_SECTORS = 7 de saude + 3 novos = 10', () => {
    expect(CRM_SECTORS).toHaveLength(10);
    expect(CRM_NEW_SECTORS).toEqual(['MARKETPLACE', 'FUNNEL', 'AFFILIATE']);
  });

  it('PRODUCTION_SECTOR_WEIGHTS cobre os 10 setores e soma 100', () => {
    const keys = Object.keys(PRODUCTION_SECTOR_WEIGHTS) as CrmSector[];
    expect(keys).toHaveLength(10);
    const total = keys.reduce((acc, k) => acc + PRODUCTION_SECTOR_WEIGHTS[k], 0);
    expect(total).toBe(100);
    expect(PRODUCTION_SECTOR_WEIGHTS.MARKETPLACE).toBe(12);
    expect(PRODUCTION_SECTOR_WEIGHTS.FUNNEL).toBe(10);
    expect(PRODUCTION_SECTOR_WEIGHTS.AFFILIATE).toBe(8);
  });
});

describe('enums de schema estendidos (espelham Prisma)', () => {
  it('paymentProviderSchema aceita HOTMART e KIWIFY', () => {
    expect(paymentProviderSchema.parse('HOTMART')).toBe('HOTMART');
    expect(paymentProviderSchema.parse('KIWIFY')).toBe('KIWIFY');
    expect(paymentProviderSchema.parse('ASAAS')).toBe('ASAAS');
  });

  it('agentNameSchema aceita MARKETPLACE/AFFILIATE/FUNNEL', () => {
    expect(agentNameSchema.parse('MARKETPLACE')).toBe('MARKETPLACE');
    expect(agentNameSchema.parse('AFFILIATE')).toBe('AFFILIATE');
    expect(agentNameSchema.parse('FUNNEL')).toBe('FUNNEL');
  });

  it('eventTypeSchema aceita AFFILIATE_CONTACTED/UPSELL_SENT/UPSELL_CONVERTED', () => {
    expect(eventTypeSchema.parse('AFFILIATE_CONTACTED')).toBe('AFFILIATE_CONTACTED');
    expect(eventTypeSchema.parse('UPSELL_SENT')).toBe('UPSELL_SENT');
    expect(eventTypeSchema.parse('UPSELL_CONVERTED')).toBe('UPSELL_CONVERTED');
  });
});
