'use client';

// Ebooks — lista os ebooks e permite disparar geracao de um novo (ContentAgent)
// via POST /ebooks/generate. Trata 404 (rota ainda nao implementada) e erros de rede.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  formatDateTime,
  type Ebook,
  type EbookStatus,
} from '@/lib/api';

const STATUS_STYLES: Record<EbookStatus, string> = {
  DRAFT: 'bg-neutral-700/40 text-neutral-300',
  GENERATING: 'bg-amber-500/20 text-amber-300',
  READY: 'bg-sky-500/20 text-sky-300',
  PUBLISHED: 'bg-emerald-500/20 text-emerald-300',
  ARCHIVED: 'bg-neutral-800 text-neutral-500',
};

function StatusBadge({ status }: { status: EbookStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

export default function EbooksPage() {
  const queryClient = useQueryClient();
  const [niche, setNiche] = useState('');
  const [title, setTitle] = useState('');

  const ebooksQuery = useQuery({
    queryKey: ['ebooks', 'list'],
    queryFn: ({ signal }) => api.listEbooks({ limit: 100 }, signal),
    retry: false,
  });

  const generateMutation = useMutation({
    mutationFn: (input: { niche: string; title?: string }) =>
      api.generateEbook(input),
    onSuccess: () => {
      setNiche('');
      setTitle('');
      void queryClient.invalidateQueries({ queryKey: ['ebooks'] });
    },
  });

  const ebooks = ebooksQuery.data?.data ?? [];
  const listMissing =
    ebooksQuery.error instanceof ApiError && ebooksQuery.error.status === 404;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (niche.trim().length < 2) return;
    generateMutation.mutate({
      niche: niche.trim(),
      title: title.trim() || undefined,
    });
  }

  return (
    <div>
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Ebooks</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Catalogo gerado pelo ContentAgent.
          </p>
        </div>
      </header>

      {/* Formulario de geracao */}
      <form
        onSubmit={handleSubmit}
        className="mb-8 rounded-xl border border-neutral-800 bg-neutral-900/50 p-5"
      >
        <p className="mb-3 text-sm font-medium text-white">Gerar novo ebook</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="Nicho (ex.: financas pessoais)"
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand focus:outline-none"
          />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Titulo (opcional)"
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand focus:outline-none"
          />
          <button
            type="submit"
            disabled={generateMutation.isPending || niche.trim().length < 2}
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-fg transition-colors hover:bg-brand/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generateMutation.isPending ? 'Gerando…' : 'Gerar ebook'}
          </button>
        </div>
        {generateMutation.isError ? (
          <p className="mt-3 text-xs text-red-400">
            {generateMutation.error instanceof ApiError &&
            generateMutation.error.status === 404
              ? 'Rota /ebooks/generate ainda nao implementada.'
              : `Falha ao gerar: ${
                  generateMutation.error instanceof Error
                    ? generateMutation.error.message
                    : 'erro desconhecido'
                }`}
          </p>
        ) : null}
        {generateMutation.isSuccess ? (
          <p className="mt-3 text-xs text-emerald-400">
            Geracao iniciada. O ebook aparecera na lista quando concluir.
          </p>
        ) : null}
      </form>

      {/* Lista */}
      {ebooksQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando ebooks…</p>
      ) : ebooksQuery.isError ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          {listMissing
            ? 'Rota /ebooks ainda nao implementada.'
            : 'Nao foi possivel carregar os ebooks. Verifique se a API esta no ar.'}
        </div>
      ) : ebooks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Nenhum ebook ainda. Gere o primeiro acima.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900/80 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">Titulo</th>
                <th className="px-4 py-3 font-medium">Nicho</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">PDF</th>
                <th className="px-4 py-3 font-medium">Criado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {ebooks.map((ebook: Ebook) => (
                <tr key={ebook.id} className="hover:bg-neutral-900/40">
                  <td className="px-4 py-3 font-medium text-white">{ebook.title}</td>
                  <td className="px-4 py-3 text-neutral-300">{ebook.niche}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={ebook.status} />
                  </td>
                  <td className="px-4 py-3 text-neutral-400">
                    {ebook.pdfPath ? 'Sim' : '—'}
                  </td>
                  <td className="px-4 py-3 text-neutral-400">
                    {formatDateTime(ebook.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
