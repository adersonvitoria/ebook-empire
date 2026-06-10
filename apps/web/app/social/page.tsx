'use client';

// Social — posts do Instagram agendados/publicados (SocialAgent).
// Consome GET /social. Mostra caption, hashtags, status e permalink.

import { useQuery } from '@tanstack/react-query';
import {
  api,
  ApiError,
  formatDateTime,
  type SocialPost,
  type SocialStatus,
} from '@/lib/api';

const STATUS_STYLES: Record<SocialStatus, string> = {
  DRAFT: 'bg-neutral-700/40 text-neutral-300',
  SCHEDULED: 'bg-amber-500/20 text-amber-300',
  PUBLISHED: 'bg-emerald-500/20 text-emerald-300',
  FAILED: 'bg-red-500/20 text-red-300',
};

function StatusBadge({ status }: { status: SocialStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

export default function SocialPage() {
  const socialQuery = useQuery({
    queryKey: ['social', 'list'],
    queryFn: ({ signal }) => api.listSocialPosts({ limit: 100 }, signal),
    retry: false,
  });

  const posts = socialQuery.data?.data ?? [];
  const listMissing =
    socialQuery.error instanceof ApiError && socialQuery.error.status === 404;

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Social</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Posts do Instagram gerados e agendados pelo SocialAgent.
        </p>
      </header>

      {socialQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando posts…</p>
      ) : socialQuery.isError ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          {listMissing
            ? 'Rota /social ainda nao implementada.'
            : 'Nao foi possivel carregar os posts. Verifique se a API esta no ar.'}
        </div>
      ) : posts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Nenhum post ainda.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {posts.map((post: SocialPost) => (
            <article
              key={post.id}
              className="flex flex-col rounded-xl border border-neutral-800 bg-neutral-900/50 p-5"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                  {post.platform}
                </span>
                <StatusBadge status={post.status} />
              </div>

              <p className="mb-3 whitespace-pre-wrap text-sm text-neutral-200">
                {post.caption}
              </p>

              {post.hashtags.length > 0 ? (
                <p className="mb-3 text-xs text-sky-400">
                  {post.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}
                </p>
              ) : null}

              {post.error ? (
                <p className="mb-3 rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-300">
                  {post.error}
                </p>
              ) : null}

              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-neutral-800 pt-3 text-xs text-neutral-500">
                <span>
                  {post.status === 'PUBLISHED'
                    ? `Publicado: ${formatDateTime(post.publishedAt)}`
                    : post.status === 'SCHEDULED'
                      ? `Agendado: ${formatDateTime(post.scheduledAt)}`
                      : `Criado: ${formatDateTime(post.createdAt)}`}
                </span>
                {post.permalink ? (
                  <a
                    href={post.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand-fg underline hover:text-white"
                  >
                    Ver no Instagram
                  </a>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
