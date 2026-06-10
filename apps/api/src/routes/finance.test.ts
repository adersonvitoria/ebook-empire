// Testes de integracao das rotas /finance (Financeiro consolidado, Feature 2).
// Cobre: GET /finance/overview (DRE do dia), GET /finance/dre?date,
// GET /finance/by-ebook, GET /finance/by-campaign, GET /finance/snapshots
// (janela default + explicita, lida direto da tabela) e POST /finance/snapshot.
//
// Segue o padrao de crm.test.ts: env minimo, decorator authenticate no-op e
// vi.mock dos modulos que a rota importa. O FinanceService (modulo 3,
// @ebook-empire/agents) e substituido por um FAKE ctx-based — a rota nao
// depende do build real do service, apenas dos seus contratos (core). O
// historico (snapshots) e leitura direta de prisma.financeSnapshot, entao o
// Prisma fake implementa esse findMany.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// --- env minimo p/ carregar env.ts sem .env real ---
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.USE_STUBS = 'true';

const FIXED_DAY = '2026-06-10';

// ------------------------------------------------------------
// Fake ctx-based do FinanceService (espelha a API real do modulo 3):
//   computeDre(ctx, { day? }), marginByEbook(ctx, { day? }),
//   marginByCampaign(ctx, { day? }), persistSnapshot(ctx, { day? }).
// Registra os `day` recebidos para asserts de roteamento.
// ------------------------------------------------------------
const calls = {
  computeDre: [] as (string | undefined)[],
  marginByEbook: [] as (string | undefined)[],
  marginByCampaign: [] as (string | undefined)[],
  persistSnapshot: [] as (string | undefined)[],
};

function makeDre(date: string) {
  return {
    date,
    grossRevenueCents: 250_00,
    paymentFeesCents: 2_96,
    adSpendCents: 100_00,
    llmCostCents: 5_00,
    netProfitCents: 142_04,
    marginPct: 56.82,
    paidOrders: 5,
    meta: {
      targetRevenueCents: 1000_00,
      progressPct: 25,
      metTarget: false,
      projectedRevenueCents: 600_00,
      projectedMetTarget: false,
      isPartial: true,
    },
  };
}

class FakeFinanceService {
  async computeDre(_ctx: unknown, opts?: { day?: string }) {
    calls.computeDre.push(opts?.day);
    return makeDre(opts?.day ?? FIXED_DAY);
  }

  async marginByEbook(_ctx: unknown, opts?: { day?: string }) {
    calls.marginByEbook.push(opts?.day);
    return {
      date: opts?.day ?? FIXED_DAY,
      ebooks: [
        {
          ebookId: 'ebk_1',
          title: 'Receitas Fit',
          revenueCents: 150_00,
          orders: 3,
          paymentFeesCents: 1_77,
          adSpendAttributedCents: 60_00,
          netProfitCents: 88_23,
          marginPct: 58.82,
        },
      ],
      unattributedAdSpendCents: 40_00,
    };
  }

  async marginByCampaign(_ctx: unknown, opts?: { day?: string }) {
    calls.marginByCampaign.push(opts?.day);
    return {
      date: opts?.day ?? FIXED_DAY,
      campaigns: [
        {
          campaignId: 'camp_1',
          name: 'PIX Junho',
          spendCents: 100_00,
          revenueCents: 200_00,
          roas: 2,
          netProfitCents: 97_64,
        },
      ],
      organic: { revenueCents: 50_00, orders: 1 },
    };
  }

  async persistSnapshot(_ctx: unknown, opts?: { day?: string }) {
    calls.persistSnapshot.push(opts?.day);
    const day = opts?.day ?? FIXED_DAY;
    return {
      id: 'snap_today',
      date: day,
      grossRevenueCents: 250_00,
      paymentFeesCents: 2_96,
      adSpendCents: 100_00,
      llmCostCents: 5_00,
      netProfitCents: 142_04,
      marginPct: 56.82,
      paidOrders: 5,
      computedAt: new Date('2026-06-10T12:00:00.000Z').toISOString(),
    };
  }
}

// Mock do barrel @ebook-empire/agents: a rota importa FinanceService + saoPauloDay.
vi.mock('@ebook-empire/agents', () => ({
  FinanceService: FakeFinanceService,
  saoPauloDay: () => FIXED_DAY,
}));

// Prisma fake: a rota /finance/snapshots le financeSnapshot.findMany direto.
let snapshotRows: any[];
const prismaMock = {
  financeSnapshot: {
    findMany: async ({ where }: any = {}) => {
      let rows = [...snapshotRows];
      if (where?.date?.gte) {
        const gte = new Date(where.date.gte).getTime();
        rows = rows.filter((r) => new Date(r.date).getTime() >= gte);
      }
      if (where?.date?.lte) {
        const lte = new Date(where.date.lte).getTime();
        rows = rows.filter((r) => new Date(r.date).getTime() <= lte);
      }
      rows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      return rows;
    },
  },
};
vi.mock('../db.js', () => ({ prisma: prismaMock }));

let app: FastifyInstance;

beforeAll(async () => {
  const routeMod = await import('./finance.js');
  app = Fastify();
  // Simula o decorator de auth criado em server.ts (no-op autoriza tudo).
  app.decorate('authenticate', async () => {});
  await app.register(routeMod.default);
  await app.ready();
});

beforeEach(() => {
  calls.computeDre = [];
  calls.marginByEbook = [];
  calls.marginByCampaign = [];
  calls.persistSnapshot = [];
  snapshotRows = [
    {
      id: 'snap_1',
      date: new Date('2026-06-10T00:00:00.000Z'),
      grossRevenueCents: 250_00,
      paymentFeesCents: 2_96,
      adSpendCents: 100_00,
      llmCostCents: 5_00,
      netProfitCents: 142_04,
      marginPct: 56.82,
      paidOrders: 5,
      computedAt: new Date('2026-06-10T12:00:00.000Z'),
    },
    {
      id: 'snap_old',
      date: new Date('2026-04-01T00:00:00.000Z'), // fora da janela default de 30 dias
      grossRevenueCents: 10_00,
      paymentFeesCents: 0,
      adSpendCents: 0,
      llmCostCents: 0,
      netProfitCents: 10_00,
      marginPct: 100,
      paidOrders: 1,
      computedAt: new Date('2026-04-01T12:00:00.000Z'),
    },
  ];
});

describe('GET /finance/overview', () => {
  it('retorna a DRE do dia (hoje SP) com meta e progresso', async () => {
    const res = await app.inject({ method: 'GET', url: '/finance/overview' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.date).toBe(FIXED_DAY);
    expect(body.grossRevenueCents).toBe(250_00);
    expect(body.netProfitCents).toBe(142_04);
    expect(body.marginPct).toBeCloseTo(56.82);
    expect(body.meta.targetRevenueCents).toBe(1000_00);
    expect(body.meta.metTarget).toBe(false);
    expect(body.meta.isPartial).toBe(true);

    // overview = DRE de hoje, sem day explicito.
    expect(calls.computeDre).toEqual([undefined]);
  });
});

describe('GET /finance/dre', () => {
  it('aceita ?date= e repassa ao service como opts.day', async () => {
    const res = await app.inject({ method: 'GET', url: '/finance/dre?date=2026-05-01' });
    expect(res.statusCode).toBe(200);
    expect(res.json().date).toBe('2026-05-01');
    expect(calls.computeDre).toEqual(['2026-05-01']);
  });

  it('rejeita date malformada (400 bad_request)', async () => {
    const res = await app.inject({ method: 'GET', url: '/finance/dre?date=01-05-2026' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
    // Nao chega a chamar o service quando a validacao falha.
    expect(calls.computeDre).toEqual([]);
  });
});

describe('GET /finance/by-ebook', () => {
  it('retorna margem por ebook + bucket unattributed', async () => {
    const res = await app.inject({ method: 'GET', url: '/finance/by-ebook' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.ebooks).toHaveLength(1);
    expect(body.ebooks[0].ebookId).toBe('ebk_1');
    expect(body.ebooks[0].netProfitCents).toBe(88_23);
    expect(body.unattributedAdSpendCents).toBe(40_00);
    expect(calls.marginByEbook).toEqual([undefined]);
  });
});

describe('GET /finance/by-campaign', () => {
  it('retorna margem/ROAS por campanha + organico', async () => {
    const res = await app.inject({ method: 'GET', url: '/finance/by-campaign?date=2026-06-10' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.campaigns[0].roas).toBe(2);
    expect(body.organic.revenueCents).toBe(50_00);
    expect(calls.marginByCampaign).toEqual(['2026-06-10']);
  });
});

describe('GET /finance/snapshots', () => {
  it('usa janela default de 30 dias terminando hoje SP e filtra fora dela', async () => {
    const res = await app.inject({ method: 'GET', url: '/finance/snapshots' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.to).toBe(FIXED_DAY); // hoje SP
    expect(body.from).toBe('2026-05-12'); // 30 dias inclusivos (10/06 - 29 dias)
    // snap_old (01/04) cai fora da janela; resta apenas snap_1.
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0].id).toBe('snap_1');
    expect(body.snapshots[0].date).toBe('2026-06-10');
  });

  it('respeita from/to explicitos', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/finance/snapshots?from=2026-03-01&to=2026-04-30',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.from).toBe('2026-03-01');
    expect(body.to).toBe('2026-04-30');
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0].id).toBe('snap_old');
  });
});

describe('POST /finance/snapshot', () => {
  it('computa + upsert do dia informado', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/finance/snapshot',
      payload: { date: '2026-06-09' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.computed).toBe(true);
    expect(body.snapshot.date).toBe('2026-06-09');
    expect(calls.persistSnapshot).toEqual(['2026-06-09']);
  });

  it('default = hoje SP quando body vazio', async () => {
    const res = await app.inject({ method: 'POST', url: '/finance/snapshot', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(calls.persistSnapshot).toEqual([FIXED_DAY]);
  });
});
