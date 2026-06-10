// Adapter de Instagram (InstagramPort).
// Implementa a publicacao sobre a Meta Graph API (container de media -> publish)
// e a leitura de insights basicos de conta/post. Tambem oferece um stub em
// memoria para testes e desenvolvimento local (USE_STUBS).
//
// Convencao: a factory `createInstagramAdapter(env)` escolhe real<->stub por
// env (USE_STUBS). Real exige META_GRAPH_TOKEN + um IG Business Account ID.

import type {
  InstagramPort,
  InstagramPublishInput,
  InstagramPublishResult,
  InstagramUploadMediaInput,
  InstagramUploadMediaResult,
  InstagramAccountInsights,
  InstagramPostInsights,
  DateRange,
} from '@ebook-empire/core';
import { nanoid } from 'nanoid';

// ------------------------------------------------------------
// Config minima lida do env (subconjunto relevante).
// ------------------------------------------------------------
export interface InstagramAdapterEnv {
  USE_STUBS: boolean;
  META_GRAPH_TOKEN: string;
  /** ID da conta IG Business (mapeado de META_AD_ACCOUNT_ID/IG account). */
  META_AD_ACCOUNT_ID: string;
}

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

// ============================================================
// Implementacao REAL sobre Meta Graph API
// ============================================================
export class MetaInstagramAdapter implements InstagramPort {
  private readonly token: string;
  private readonly igUserId: string;

  constructor(opts: { token: string; igUserId: string }) {
    this.token = opts.token;
    this.igUserId = opts.igUserId;
  }

  // Cria o container de media (etapa 1 do fluxo de publicacao da Graph API).
  async uploadMedia(
    input: InstagramUploadMediaInput,
  ): Promise<InstagramUploadMediaResult> {
    const containerId = await this.createContainer(input.imageUrl);
    return { containerId };
  }

  // Publica um post: cria container com legenda+hashtags e publica.
  async publishPost(
    input: InstagramPublishInput,
  ): Promise<InstagramPublishResult> {
    const caption = composeCaption(input.caption, input.hashtags);
    const containerId = await this.createContainer(input.mediaUrl, caption);

    // Etapa 2: publicar o container.
    const publishUrl = `${GRAPH_BASE}/${this.igUserId}/media_publish`;
    const published = await this.post<{ id: string }>(publishUrl, {
      creation_id: containerId,
    });

    const externalId = published.id;
    const permalink = await this.fetchPermalink(externalId);
    return { externalId, permalink };
  }

  async getAccountInsights(_range: DateRange): Promise<InstagramAccountInsights> {
    // metricas de conta: reach/impressions/profile_views via Insights API.
    const url =
      `${GRAPH_BASE}/${this.igUserId}/insights` +
      `?metric=reach,impressions,profile_views&period=day`;
    const res = await this.get<{ data: GraphInsightMetric[] }>(url);
    const followers = await this.fetchFollowers();
    return {
      reach: readMetric(res.data, 'reach'),
      impressions: readMetric(res.data, 'impressions'),
      profileViews: readMetric(res.data, 'profile_views'),
      followers,
    };
  }

  async getPostInsights(externalId: string): Promise<InstagramPostInsights> {
    const url =
      `${GRAPH_BASE}/${externalId}/insights` +
      `?metric=likes,comments,saved,reach`;
    const res = await this.get<{ data: GraphInsightMetric[] }>(url);
    return {
      likes: readMetric(res.data, 'likes'),
      comments: readMetric(res.data, 'comments'),
      saves: readMetric(res.data, 'saved'),
      reach: readMetric(res.data, 'reach'),
    };
  }

  // ---- helpers HTTP ----

  private async createContainer(
    imageUrl: string,
    caption?: string,
  ): Promise<string> {
    const url = `${GRAPH_BASE}/${this.igUserId}/media`;
    const body: Record<string, string> = { image_url: imageUrl };
    if (caption) body.caption = caption;
    const res = await this.post<{ id: string }>(url, body);
    return res.id;
  }

  private async fetchPermalink(mediaId: string): Promise<string> {
    try {
      const url = `${GRAPH_BASE}/${mediaId}?fields=permalink`;
      const res = await this.get<{ permalink?: string }>(url);
      return res.permalink ?? `https://instagram.com/p/${mediaId}`;
    } catch {
      return `https://instagram.com/p/${mediaId}`;
    }
  }

  private async fetchFollowers(): Promise<number> {
    try {
      const url = `${GRAPH_BASE}/${this.igUserId}?fields=followers_count`;
      const res = await this.get<{ followers_count?: number }>(url);
      return res.followers_count ?? 0;
    } catch {
      return 0;
    }
  }

  private async get<T>(url: string): Promise<T> {
    const sep = url.includes('?') ? '&' : '?';
    const full = `${url}${sep}access_token=${encodeURIComponent(this.token)}`;
    const res = await fetch(full);
    return this.handle<T>(res);
  }

  private async post<T>(url: string, body: Record<string, string>): Promise<T> {
    const params = new URLSearchParams({ ...body, access_token: this.token });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    return this.handle<T>(res);
  }

  private async handle<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg =
        (json as { error?: { message?: string } })?.error?.message ??
        `Meta Graph API ${res.status}`;
      throw new Error(`InstagramAdapter: ${msg}`);
    }
    return json as T;
  }
}

interface GraphInsightMetric {
  name: string;
  values?: Array<{ value?: number }>;
}

function readMetric(data: GraphInsightMetric[], name: string): number {
  const m = data.find((d) => d.name === name);
  return m?.values?.[0]?.value ?? 0;
}

// Junta legenda + hashtags numa unica string (limite pratico ~2200 chars).
export function composeCaption(caption: string, hashtags?: string[]): string {
  if (!hashtags || hashtags.length === 0) return caption;
  const tags = hashtags
    .map((h) => (h.startsWith('#') ? h : `#${h}`))
    .join(' ');
  return `${caption}\n\n${tags}`.slice(0, 2200);
}

// ============================================================
// STUB em memoria (testes / dev local)
// ============================================================
export interface StubInstagramRecord {
  externalId: string;
  caption: string;
  mediaUrl: string;
  hashtags: string[];
  permalink: string;
  publishedAt: Date;
}

export class StubInstagramAdapter implements InstagramPort {
  // Registro publico para assercoes em teste.
  readonly published: StubInstagramRecord[] = [];
  readonly containers: Array<{ id: string; imageUrl: string }> = [];

  async uploadMedia(
    input: InstagramUploadMediaInput,
  ): Promise<InstagramUploadMediaResult> {
    const containerId = `ig_container_${nanoid(10)}`;
    this.containers.push({ id: containerId, imageUrl: input.imageUrl });
    return { containerId };
  }

  async publishPost(
    input: InstagramPublishInput,
  ): Promise<InstagramPublishResult> {
    const externalId = `ig_${nanoid(12)}`;
    const permalink = `https://instagram.com/p/${externalId}`;
    this.published.push({
      externalId,
      caption: input.caption,
      mediaUrl: input.mediaUrl,
      hashtags: input.hashtags ?? [],
      permalink,
      publishedAt: new Date(),
    });
    return { externalId, permalink };
  }

  async getAccountInsights(
    _range: DateRange,
  ): Promise<InstagramAccountInsights> {
    // Numeros deterministicos plausiveis para dev.
    const posts = this.published.length;
    return {
      reach: 1200 + posts * 80,
      impressions: 1800 + posts * 120,
      profileViews: 60 + posts * 4,
      followers: 500 + posts * 3,
    };
  }

  async getPostInsights(externalId: string): Promise<InstagramPostInsights> {
    // Deriva metricas estaveis a partir do id (sem aleatoriedade) para testes.
    const seed = hashSeed(externalId);
    return {
      likes: 20 + (seed % 80),
      comments: 1 + (seed % 12),
      saves: 2 + (seed % 25),
      reach: 300 + (seed % 700),
    };
  }
}

// Hash deterministico simples (FNV-1a 32-bit) -> seed estavel.
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h);
}

// ============================================================
// Factory — escolhe real<->stub por env.
// ============================================================
export function createInstagramAdapter(
  env: InstagramAdapterEnv,
): InstagramPort {
  if (env.USE_STUBS || !env.META_GRAPH_TOKEN) {
    return new StubInstagramAdapter();
  }
  return new MetaInstagramAdapter({
    token: env.META_GRAPH_TOKEN,
    igUserId: env.META_AD_ACCOUNT_ID,
  });
}
