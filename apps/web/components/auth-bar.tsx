'use client';

// Barra de autenticacao do topo do painel. Deslogado: campo de senha + "Entrar".
// Logado: indicador "Autenticado" + botao "Sair". As paginas permanecem
// visiveis em ambos os estados (GET publicos); o login apenas habilita as acoes.

import { useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export function AuthBar() {
  const { isAuthenticated, isHydrating, login, logout } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(password);
      setPassword('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Senha incorreta.');
      } else if (err instanceof ApiError && err.status === 503) {
        setError('Login desabilitado no servidor (ADMIN_PASSWORD nao configurado).');
      } else if (err instanceof ApiError && err.status === 0) {
        setError('API fora do ar — nao foi possivel autenticar.');
      } else {
        setError('Falha ao autenticar. Tente novamente.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 border-b border-neutral-800 bg-neutral-900/60 px-8 py-3">
      <div className="flex items-center gap-2 text-xs">
        <span
          className={`h-2 w-2 rounded-full ${
            isAuthenticated ? 'bg-emerald-500' : 'bg-neutral-600'
          }`}
        />
        <span className="text-neutral-400">
          {isHydrating
            ? 'Verificando sessao…'
            : isAuthenticated
              ? 'Autenticado — acoes habilitadas'
              : 'Modo leitura — faca login para agir'}
        </span>
      </div>

      {isAuthenticated ? (
        <button
          type="button"
          onClick={logout}
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800"
        >
          Sair
        </button>
      ) : (
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          {error ? <span className="text-xs text-red-400">{error}</span> : null}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Senha do painel"
            autoComplete="current-password"
            className="w-48 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-brand focus:outline-none"
          />
          <button
            type="submit"
            disabled={submitting || !password}
            className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-brand-fg transition-colors hover:bg-brand/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      )}
    </div>
  );
}
