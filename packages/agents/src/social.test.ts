// Testes do SocialAgent com StubInstagram (inline) + StubLLM (inline) + fake Prisma.
// Exercita o fluxo: pick ebook frio -> gera via LLM -> agenda -> publica -> metrics.
import { describe, it, expect, vi } from 'vitest';
import type {
  InstagramPort,
  InstagramPublishInput,
  InstagramPublishResult,
  InstagramUploadMediaInput,
  InstagramUploadMediaResult,
  InstagramAccountInsights,
  InstagramPostInsights,
  LLMPort,
  LLMGenerateTextInput,
  LLMGenerateTextResult,
  LLMGenerateJsonInput,
  LLMGenerateJsonResult,
  Ports,
} from '@ebook-empire/core';
import { SocialAgent } from './social.js';
import type { AgentContext, AgentEnv, AgentLogger, Clock } from './base.js';

// ------------------------------------------------------------
// Stub LLM — devolve um JSON valido de social post.
// ------------------------------------------------------------
class StubLLMAdapter implements LLMPort {
  calls = 0;
  async generateText(_input: LLMGenerateTextInput): Promise<LLMGenerateTextResult> {
    return { text: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
  }
  async generateJson<T>(input: LLMGenerateJsonInput<T>): Promise<LLMGenerateJsonResult<T>> {
    this.calls += 1;
    const raw = {
      caption: 'Garanta seu ebook hoje! Link na bio.',
      hashtags: ['ebook', 'infoproduto', 'pix'],
      creativePrompt: 'Capa do ebook em destaque com fundo gradiente.',
    };
    const data = input.parse(raw);
    return { data, usage: { inputTokens: 120, outputTokens: 80, costCents: 3 } };
  }
}

// ------------------------------------------------------------
// Stub Instagram — registra publicacoes em memoria.
// ------------------------------------------------------------
class StubInstagram implements InstagramPort {
  published: InstagramPublishInput[] = [];
  failNext = false;
  async publishPost(input: InstagramPublishInput): Promise<InstagramPublishResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('IG indisponivel');
    }
    this.published.push(input);
    const externalId = `ig_${this.published.length}`;
    return { externalId, permalink: `https://instagram.com/p/${externalId}` };
  }
  async uploadMedia(_i: InstagramUploadMediaInput): Promise<InstagramUploadMediaResult> {
    return { containerId: 'c1' };
  }
  async getAccountInsights(): Promise<InstagramAccountInsights> {
    return { reach: 1, impressions: 1, profileViews: 1, followers: 1 };
  }
  async getPostInsights(_id: string): Promise<InstagramPostInsights> {
    return { likes: 10, comments: 2, saves: 3, reach: 100 };
  }
}

// ------------------------------------------------------------
// Fake Prisma minimo cobrindo o que SocialAgent + Agent.execute usam.
// ------------------------------------------------------------
interface FakeSocialPost {
  id: string;
  platform: string;
  caption: string;
  hashtags: string[];
  mediaPaths: string[];
  status: string;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  externalPostId: string | null;
  permalink: string | null;
  productId: string | null;
  agentRunId: string | null;
  attempts: number;
  metrics: unknown;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakePrisma(opts: {
  ebooks: Array<{ id: string; title: string; niche: string; productId: string; createdAt: Date }>;
  existingPosts?: FakeSocialPost[];
}) {
  let seq = 0;
  const socialPosts: FakeSocialPost[] = opts.existingPosts ?? [];
  const events: Array<Record<string, unknown>> = [];
  const agentRuns: Array<Record<string, unknown>> = [];

  const applyIncrement = (current: number, val: unknown): number =>
    val && typeof val === 'object' && 'increment' in (val as object)
      ? current + ((val as { increment: number }).increment)
      : (val as number);

  const prisma = {
    ebook: {
      findMany: vi.fn(async () =>
        opts.ebooks
          .slice()
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((e) => ({
            id: e.id,
            title: e.title,
            niche: e.niche,
            products: [{ id: e.productId }],
          })),
      ),
    },
    socialPost: {
      findFirst: vi.fn(async ({ where }: any) => {
        const cutoff: Date | undefined = where?.createdAt?.gte;
        return (
          socialPosts.find(
            (p) =>
              p.productId === where?.productId &&
              (!cutoff || p.createdAt.getTime() >= cutoff.getTime()),
          ) ?? null
        );
      }),
      findMany: vi.fn(async ({ where, take }: any = {}) => {
        let rows = socialPosts.slice();
        if (where?.status) rows = rows.filter((p) => p.status === where.status);
        if (where?.OR) {
          const now: Date | undefined = where.OR.find((o: any) => o.scheduledAt?.lte)?.scheduledAt
            ?.lte;
          rows = rows.filter(
            (p) => p.scheduledAt === null || (now ? p.scheduledAt.getTime() <= now.getTime() : true),
          );
        }
        rows.sort(
          (a, b) => (a.scheduledAt?.getTime() ?? 0) - (b.scheduledAt?.getTime() ?? 0),
        );
        return take ? rows.slice(0, take) : rows;
      }),
      create: vi.fn(async ({ data }: any) => {
        seq += 1;
        const now = new Date();
        const row: FakeSocialPost = {
          id: `sp_${seq}`,
          platform: data.platform ?? 'instagram',
          caption: data.caption,
          hashtags: data.hashtags ?? [],
          mediaPaths: data.mediaPaths ?? [],
          status: data.status ?? 'DRAFT',
          scheduledAt: data.scheduledAt ?? null,
          publishedAt: data.publishedAt ?? null,
          externalPostId: data.externalPostId ?? null,
          permalink: data.permalink ?? null,
          productId: data.productId ?? null,
          agentRunId: data.agentRunId ?? null,
          attempts: data.attempts ?? 0,
          metrics: data.metrics ?? null,
          error: data.error ?? null,
          createdAt: now,
          updatedAt: now,
        };
        socialPosts.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = socialPosts.find((p) => p.id === where.id);
        if (!row) throw new Error('not found');
        if (data.status !== undefined) row.status = data.status;
        if (data.publishedAt !== undefined) row.publishedAt = data.publishedAt;
        if (data.externalPostId !== undefined) row.externalPostId = data.externalPostId;
        if (data.permalink !== undefined) row.permalink = data.permalink;
        if (data.error !== undefined) row.error = data.error;
        if (data.metrics !== undefined) row.metrics = data.metrics;
        if (data.attempts !== undefined) row.attempts = applyIncrement(row.attempts, data.attempts);
        row.updatedAt = new Date();
        return row;
      }),
    },
    event: {
      create: vi.fn(async ({ data }: any) => {
        events.push(data);
        return { id: `ev_${events.length}`, ...data };
      }),
    },
    agentRun: {
      create: vi.fn(async ({ data }: any) => {
        agentRuns.push(data);
        return { id: `run_${agentRuns.length}` };
      }),
      update: vi.fn(async ({ data }: any) => ({
        id: 'run_1',
        agent: 'SOCIAL',
        status: data.status,
        startedAt: new Date(),
        finishedAt: data.finishedAt ?? new Date(),
        durationMs: data.durationMs ?? 0,
      })),
    },
  };

  return { prisma, socialPosts, events, agentRuns };
}

// ------------------------------------------------------------
// Helpers de contexto.
// ------------------------------------------------------------
const silentLog: AgentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const fixedClock: Clock = { now: () => new Date('2026-06-10T12:00:00Z') };

const agentEnv: AgentEnv = {
  ENABLE_AGENTS: true,
  MAX_AD_BUDGET_BRL: 300,
  TARGET_DAILY_REVENUE_BRL: 1000,
  PUBLIC_BASE_URL: 'http://localhost:3001',
  CONTENT_MODEL: 'claude-sonnet-4-6',
  PLANNING_MODEL: 'claude-opus-4-8',
};

function makeCtx(prisma: any, ig: InstagramPort, llm: LLMPort): AgentContext {
  const ports = { instagram: ig, llm } as unknown as Ports;
  return { prisma, ports, env: agentEnv, log: silentLog, clock: fixedClock };
}

describe('SocialAgent', () => {
  it('gera, agenda e publica um post para um ebook frio', async () => {
    const { prisma, socialPosts, events } = makeFakePrisma({
      ebooks: [
        { id: 'eb1', title: 'Renda Extra', niche: 'financas', productId: 'pr1', createdAt: new Date('2026-06-01') },
      ],
    });
    const ig = new StubInstagram();
    const llm = new StubLLMAdapter();

    const result = await new SocialAgent().run(makeCtx(prisma, ig, llm));

    expect(result.status).toBe('SUCCESS');
    expect((result.output as any).generated).toBe(1);
    expect((result.output as any).published).toBe(1);
    expect(llm.calls).toBe(1);
    expect(ig.published).toHaveLength(1);

    // Post persistido como PUBLISHED com metrics dos insights.
    const post = socialPosts[0]!;
    expect(post.status).toBe('PUBLISHED');
    expect(post.externalPostId).toBe('ig_1');
    expect((post.metrics as any).likes).toBe(10);
    // creativePrompt preservado no metrics.
    expect((post.metrics as any).creativePrompt).toContain('Capa do ebook');

    // Evento de funil emitido.
    expect(events.some((e) => e.type === 'SOCIAL_POSTED')).toBe(true);
  });

  it('faz SKIPPED quando o ebook esta em cooldown (post recente existe)', async () => {
    const recent: FakeSocialPost = {
      id: 'sp_old',
      platform: 'instagram',
      caption: 'antigo',
      hashtags: [],
      mediaPaths: [],
      status: 'PUBLISHED',
      scheduledAt: null,
      publishedAt: new Date('2026-06-10T10:00:00Z'),
      externalPostId: 'ig_old',
      permalink: null,
      productId: 'pr1',
      agentRunId: null,
      attempts: 1,
      metrics: null,
      error: null,
      createdAt: new Date('2026-06-10T10:00:00Z'), // dentro das ultimas 6h
      updatedAt: new Date('2026-06-10T10:00:00Z'),
    };
    const { prisma } = makeFakePrisma({
      ebooks: [
        { id: 'eb1', title: 'Renda Extra', niche: 'financas', productId: 'pr1', createdAt: new Date('2026-06-01') },
      ],
      existingPosts: [recent],
    });
    const ig = new StubInstagram();
    const llm = new StubLLMAdapter();

    const result = await new SocialAgent().run(makeCtx(prisma, ig, llm));

    expect(result.status).toBe('SKIPPED');
    expect(llm.calls).toBe(0);
    expect(ig.published).toHaveLength(0);
  });

  it('marca FAILED no post quando a publicacao no IG falha (sem lancar)', async () => {
    const { prisma, socialPosts } = makeFakePrisma({
      ebooks: [
        { id: 'eb1', title: 'Renda Extra', niche: 'financas', productId: 'pr1', createdAt: new Date('2026-06-01') },
      ],
    });
    const ig = new StubInstagram();
    ig.failNext = true;
    const llm = new StubLLMAdapter();

    const result = await new SocialAgent().run(makeCtx(prisma, ig, llm));

    // Gerou o post, mas a publicacao falhou -> ainda SUCCESS (generated=1) e post FAILED.
    expect(result.status).toBe('SUCCESS');
    expect((result.output as any).published).toBe(0);
    expect(socialPosts[0]!.status).toBe('FAILED');
    expect(socialPosts[0]!.error).toContain('IG indisponivel');
  });

  it('execute() grava AgentRun e nunca deixa excecao escapar', async () => {
    const { prisma, agentRuns } = makeFakePrisma({
      ebooks: [
        { id: 'eb1', title: 'X', niche: 'y', productId: 'pr1', createdAt: new Date('2026-06-01') },
      ],
    });
    const ig = new StubInstagram();
    const llm = new StubLLMAdapter();

    const record = await new SocialAgent().execute(makeCtx(prisma, ig, llm));

    expect(record.status).toBe('SUCCESS');
    expect(agentRuns).toHaveLength(1);
    expect((agentRuns[0] as any).agent).toBe('SOCIAL');
  });
});
