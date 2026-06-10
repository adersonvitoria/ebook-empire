// Testes do setor EBOOK_QA (vitest + stubs). Cobrem:
//  1) audit retorna verdict por score (PASS / NEEDS_FIX / FAIL);
//  2) BLOCKER (estrutura insuficiente) => FAIL deterministico;
//  3) runFixLoop: NEEDS_FIX converge a PASS com LLM stub que melhora;
//  4) FAIL respeitado (loop nao tenta corrigir indefinidamente);
//  5) idempotencia por iteration (cada passo grava 1 EbookAudit distinto);
//  6) canLaunch: gate le o ultimo verdict (fail-closed sem auditoria).
//
// Sem DB: usamos um Prisma fake em memoria e um LLMPort stub controlavel.

import { describe, it, expect, beforeEach } from 'vitest';
import type { LLMPort } from '@ebook-empire/core';
import type { AgentContext, AgentEnv } from '../../base.js';
import {
  analyzeStructure,
  buildFinalScore,
  verdictFromScore,
} from './auditor.js';
import { FixStrategist } from './fix-strategist.js';
import { EbookQaService } from './service.js';

// ------------------------------------------------------------
// Prisma fake em memoria (apenas os metodos que o service/executor usam).
// ------------------------------------------------------------
interface FakeEbook {
  id: string;
  title: string;
  niche: string;
  status: string;
  contentMarkdown: string | null;
  outline: unknown;
  updatedAt: Date;
  marketOpportunityId: string | null;
}
interface FakeAudit {
  id: string;
  ebookId: string;
  score: number;
  verdict: string;
  iteration: number;
  auditedAt: Date;
  createdAt: Date;
  [k: string]: unknown;
}

function createFakePrisma() {
  const ebooks = new Map<string, FakeEbook>();
  const audits: FakeAudit[] = [];
  const products: { id: string; ebookId: string; active: boolean; description: string | null }[] = [];
  const runs = new Map<string, Record<string, unknown>>();
  const events: Record<string, unknown>[] = [];
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;

  return {
    _state: { ebooks, audits, products, runs, events },
    ebook: {
      findUnique: async ({ where, select }: any) => {
        const e = ebooks.get(where.id);
        if (!e) return null;
        const out: any = { ...e };
        if (select?.marketOpportunity) out.marketOpportunity = null;
        if (select?.products) out.products = products.filter((p) => p.ebookId === e.id && (!select.products.where?.active || p.active));
        return out;
      },
      findMany: async ({ select }: any) => {
        return [...ebooks.values()].map((e) => {
          const out: any = { id: e.id };
          if (select?.audits) {
            const last = audits.filter((a) => a.ebookId === e.id).sort((a, b) => +b.createdAt - +a.createdAt)[0];
            out.audits = last ? [{ auditedAt: last.auditedAt }] : [];
          }
          return out;
        });
      },
      update: async ({ where, data }: any) => {
        const e = ebooks.get(where.id)!;
        Object.assign(e, data);
        return e;
      },
    },
    ebookAudit: {
      create: async ({ data, select }: any) => {
        const row: FakeAudit = { id: id('aud'), createdAt: new Date(), ...data };
        audits.push(row);
        return select ? { id: row.id } : row;
      },
      findFirst: async ({ where, select }: any) => {
        let list = audits.filter((a) => a.ebookId === where.ebookId);
        list = list.sort((a, b) => +b.createdAt - +a.createdAt);
        const row = list[0];
        if (!row) return null;
        return select?.verdict ? { verdict: row.verdict } : row;
      },
      count: async () => audits.length,
    },
    product: {
      findFirst: async ({ where }: any) =>
        products.find((p) => p.ebookId === where.ebookId && p.active) ?? null,
      update: async ({ where, data }: any) => {
        const p = products.find((x) => x.id === where.id)!;
        Object.assign(p, data);
        return p;
      },
    },
    agentRun: {
      create: async ({ data, select }: any) => {
        const rid = id('run');
        runs.set(rid, { id: rid, ...data });
        return select ? { id: rid } : runs.get(rid);
      },
      update: async ({ where, data }: any) => {
        const r = runs.get(where.id)!;
        Object.assign(r, data);
        return r;
      },
    },
    event: {
      create: async ({ data }: any) => {
        events.push(data);
        return data;
      },
    },
  };
}

// ------------------------------------------------------------
// LLM stub controlavel: devolve dimensionScores fixos (mutaveis entre chamadas
// para simular melhora apos correcao).
// ------------------------------------------------------------
function createControllableLlm(scoreQueue: number[]): LLMPort {
  let calls = 0;
  return {
    async generateText() {
      // O executor usa generateText para regenerar conteudo — devolve um corpo
      // longo o bastante para o subscore de estrutura nao reprovar.
      const longChapter = Array(150).fill('palavra').join(' ');
      const text = `# Ebook Corrigido\n\n## Capitulo 1\n${longChapter}\n\n## Capitulo 2\n${longChapter}\n\n## Capitulo 3\n${longChapter}\n`;
      return { text, usage: { inputTokens: 10, outputTokens: 50, costCents: 1 } };
    },
    async generateJson<T>(input: any): Promise<{ data: T; usage: any }> {
      // Pega o proximo score da fila (ou o ultimo). Usado pelo auditor.
      const q = scoreQueue[Math.min(calls, scoreQueue.length - 1)] ?? 70;
      calls += 1;
      const raw = {
        dimensionScores: { structure: q, contentQuality: q, marketFit: q, compliance: q },
        issues:
          q < 70
            ? [
                {
                  category: 'CONTENT_QUALITY',
                  severity: q < 40 ? 'BLOCKER' : 'MEDIUM',
                  chapterIndex: null,
                  title: 'Qualidade abaixo do ideal',
                  detail: 'Conteudo precisa de mais profundidade.',
                  suggestion: 'Aprofundar capitulos.',
                },
              ]
            : [],
        recommendations: ['Revisar.'],
        verdictHint: q >= 70 ? 'PASS' : 'NEEDS_FIX',
      };
      return { data: input.parse(raw) as T, usage: { inputTokens: 20, outputTokens: 30, costCents: 2 } };
    },
  };
}

function buildCtx(prisma: any, llm: LLMPort): AgentContext {
  const env: AgentEnv = {
    ENABLE_AGENTS: true,
    MAX_AD_BUDGET_BRL: 300,
    TARGET_DAILY_REVENUE_BRL: 1000,
    PUBLIC_BASE_URL: 'http://localhost:3001',
    CONTENT_MODEL: 'claude-sonnet-4-6',
    PLANNING_MODEL: 'claude-opus-4-8',
    QA_MIN_SCORE: 70,
    QA_MAX_FIX_ITERATIONS: 2,
    QA_FAIL_SCORE: 40,
    QA_AUDIT_STALE_HOURS: 168,
  };
  return {
    prisma,
    ports: { llm } as any,
    env,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clock: { now: () => new Date() },
  };
}

const RICH_MARKDOWN = (() => {
  // 150 palavras por capitulo => acima de MIN_CHAPTER_WORDS (120) e total > 800.
  const long = Array(150).fill('conteudo').join(' ');
  return `# Titulo\n\n## Cap 1\n${long}\n\n## Cap 2\n${long}\n\n## Cap 3\n${long}\n`;
})();

function seedEbook(prisma: any, markdown: string | null): string {
  const eid = 'ebk_1';
  prisma._state.ebooks.set(eid, {
    id: eid,
    title: 'Guia de Teste',
    niche: 'produtividade',
    status: 'DRAFT',
    contentMarkdown: markdown,
    outline: null,
    updatedAt: new Date(),
    marketOpportunityId: null,
  });
  prisma._state.products.push({ id: 'prd_1', ebookId: eid, active: true, description: 'desc' });
  return eid;
}

// ============================================================
// Funcoes puras
// ============================================================
describe('auditor — funcoes puras', () => {
  it('analyzeStructure conta capitulos e palavras', () => {
    const s = analyzeStructure(RICH_MARKDOWN);
    expect(s.chapterCount).toBe(3);
    expect(s.hasTitleHeading).toBe(true);
    expect(s.shortChapters).toBe(0);
  });

  it('verdictFromScore: BLOCKER => FAIL independente do score', () => {
    const ctx = buildCtx(createFakePrisma(), createControllableLlm([90]));
    const v = verdictFromScore(95, [
      { category: 'STRUCTURE', severity: 'BLOCKER', chapterIndex: null, title: 't', detail: 'd', suggestion: 's' },
    ], ctx);
    expect(v).toBe('FAIL');
  });

  it('verdictFromScore: faixas PASS/NEEDS_FIX/FAIL', () => {
    const ctx = buildCtx(createFakePrisma(), createControllableLlm([90]));
    expect(verdictFromScore(85, [], ctx)).toBe('PASS');
    expect(verdictFromScore(55, [], ctx)).toBe('NEEDS_FIX');
    expect(verdictFromScore(30, [], ctx)).toBe('FAIL');
  });

  it('buildFinalScore redistribui peso sem oportunidade', () => {
    const d = { structure: 80, contentQuality: 80, marketFit: 0, compliance: 80 };
    // sem oportunidade, marketFit=0 nao deve derrubar (peso redistribuido).
    expect(buildFinalScore(d, false)).toBe(80);
    // com oportunidade, marketFit=0 derruba.
    expect(buildFinalScore(d, true)).toBeLessThan(80);
  });
});

// ============================================================
// Service — auditEbook
// ============================================================
describe('EbookQaService.auditEbook', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = createFakePrisma();
  });

  it('ebook bom => PASS e persiste EbookAudit + AgentRun + Event', async () => {
    const eid = seedEbook(prisma, RICH_MARKDOWN);
    const ctx = buildCtx(prisma, createControllableLlm([90]));
    const svc = new EbookQaService();
    const { audit, auditId } = await svc.auditEbook(ctx, eid);
    expect(audit.verdict).toBe('PASS');
    expect(audit.score).toBeGreaterThanOrEqual(70);
    expect(auditId).toBeTruthy();
    expect(prisma._state.audits).toHaveLength(1);
    expect(prisma._state.events.some((e: any) => e.type === 'EBOOK_AUDITED')).toBe(true);
    const run = [...prisma._state.runs.values()][0] as any;
    expect(run.agent).toBe('EBOOK_QA');
    expect(run.role).toBe('SPECIALIST');
    expect(run.sector).toBe('EBOOK_QA');
    expect(run.status).toBe('SUCCESS');
  });

  it('ebook mediano (score 55) => NEEDS_FIX', async () => {
    const eid = seedEbook(prisma, RICH_MARKDOWN);
    const ctx = buildCtx(prisma, createControllableLlm([55]));
    const { audit } = await new EbookQaService().auditEbook(ctx, eid);
    expect(audit.verdict).toBe('NEEDS_FIX');
  });

  it('estrutura insuficiente (1 capitulo) => FAIL por BLOCKER', async () => {
    const eid = seedEbook(prisma, '# T\n\n## Unico\nmuito curto');
    // LLM diz 90, mas o BLOCKER de estrutura deterministico reprova.
    const ctx = buildCtx(prisma, createControllableLlm([90]));
    const { audit } = await new EbookQaService().auditEbook(ctx, eid);
    expect(audit.verdict).toBe('FAIL');
    expect(audit.issues.some((i) => i.severity === 'BLOCKER')).toBe(true);
  });
});

// ============================================================
// Service — runFixLoop
// ============================================================
describe('EbookQaService.runFixLoop', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = createFakePrisma();
  });

  it('NEEDS_FIX converge a PASS (LLM melhora apos correcao) e relança', async () => {
    const eid = seedEbook(prisma, RICH_MARKDOWN);
    // 1a auditoria 55 (NEEDS_FIX) -> apos corrigir, reauditoria 90 (PASS).
    const ctx = buildCtx(prisma, createControllableLlm([55, 90]));
    const result = await new EbookQaService().runFixLoop(ctx, eid);
    expect(result.passed).toBe(true);
    expect(result.finalVerdict).toBe('PASS');
    expect(result.iterations).toBe(1);
    expect(result.relaunched).toBe(true);
    // idempotencia por iteration: 2 auditorias (iter 0 e 1), iterations distintas.
    expect(result.audits.map((a) => a.iteration)).toEqual([0, 1]);
    expect(prisma._state.ebooks.get(eid).status).toBe('PUBLISHED');
    expect(prisma._state.events.some((e: any) => e.type === 'EBOOK_RELAUNCHED')).toBe(true);
  });

  it('NEEDS_FIX persistente => para no limite sem PASS e nao relança', async () => {
    const eid = seedEbook(prisma, RICH_MARKDOWN);
    // sempre 55 => nunca passa; QA_MAX_FIX_ITERATIONS=2.
    const ctx = buildCtx(prisma, createControllableLlm([55]));
    const result = await new EbookQaService().runFixLoop(ctx, eid);
    expect(result.passed).toBe(false);
    expect(result.finalVerdict).toBe('NEEDS_FIX');
    expect(result.iterations).toBe(2);
    expect(result.relaunched).toBe(false);
    // iteration 0,1,2 => 3 auditorias.
    expect(result.audits.map((a) => a.iteration)).toEqual([0, 1, 2]);
  });

  it('FAIL respeitado: loop nao tenta corrigir', async () => {
    const eid = seedEbook(prisma, RICH_MARKDOWN);
    const ctx = buildCtx(prisma, createControllableLlm([20]));
    const result = await new EbookQaService().runFixLoop(ctx, eid);
    expect(result.finalVerdict).toBe('FAIL');
    expect(result.iterations).toBe(0);
    expect(result.passed).toBe(false);
  });
});

// ============================================================
// Service — canLaunch (GATE 2)
// ============================================================
describe('EbookQaService.canLaunch', () => {
  it('sem auditoria => bloqueado (fail-closed)', async () => {
    const prisma = createFakePrisma();
    const eid = seedEbook(prisma, RICH_MARKDOWN);
    const ctx = buildCtx(prisma, createControllableLlm([90]));
    const gate = await new EbookQaService().canLaunch(ctx, eid);
    expect(gate.allowed).toBe(false);
    expect(gate.lastVerdict).toBeNull();
  });

  it('ultima auditoria PASS => liberado', async () => {
    const prisma = createFakePrisma();
    const eid = seedEbook(prisma, RICH_MARKDOWN);
    const ctx = buildCtx(prisma, createControllableLlm([90]));
    const svc = new EbookQaService();
    await svc.auditEbook(ctx, eid);
    const gate = await svc.canLaunch(ctx, eid);
    expect(gate.allowed).toBe(true);
    expect(gate.lastVerdict).toBe('PASS');
  });

  it('ultima auditoria NEEDS_FIX => bloqueado', async () => {
    const prisma = createFakePrisma();
    const eid = seedEbook(prisma, RICH_MARKDOWN);
    const ctx = buildCtx(prisma, createControllableLlm([55]));
    const svc = new EbookQaService();
    await svc.auditEbook(ctx, eid);
    const gate = await svc.canLaunch(ctx, eid);
    expect(gate.allowed).toBe(false);
    expect(gate.lastVerdict).toBe('NEEDS_FIX');
  });
});

// ============================================================
// FixStrategist
// ============================================================
describe('FixStrategist', () => {
  it('PASS => plano noop', () => {
    const plan = new FixStrategist().plan({
      ebookId: 'e1',
      score: 90,
      verdict: 'PASS',
      issues: [],
      recommendations: [],
      dimensionScores: { structure: 90, contentQuality: 90, marketFit: 90, compliance: 90 },
      iteration: 0,
      auditedAt: new Date().toISOString(),
    });
    expect(plan.noop).toBe(true);
    expect(plan.actions).toHaveLength(0);
  });

  it('issues geram acoes priorizadas por severidade', () => {
    const plan = new FixStrategist().plan({
      ebookId: 'e1',
      score: 50,
      verdict: 'NEEDS_FIX',
      issues: [
        { category: 'CONTENT_QUALITY', severity: 'HIGH', chapterIndex: null, title: 'a', detail: 'd', suggestion: 's' },
        { category: 'COMPLIANCE', severity: 'LOW', chapterIndex: null, title: 'b', detail: 'd', suggestion: 's' },
      ],
      recommendations: [],
      dimensionScores: { structure: 80, contentQuality: 40, marketFit: 70, compliance: 90 },
      iteration: 0,
      auditedAt: new Date().toISOString(),
    });
    expect(plan.noop).toBe(false);
    expect(plan.actions[0]?.kind).toBe('REGENERATE_CHAPTERS'); // CONTENT_QUALITY HIGH primeiro
    expect(plan.actions.length).toBe(2);
  });
});
