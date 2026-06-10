'use client';

// Contexto de autenticacao do painel interno (single-admin / dono).
// Fonte da verdade do token: persiste em localStorage (chave ee_token) e mantem
// o store do lib/api.ts sincronizado via setAuthToken(), de modo que TODAS as
// requisicoes (request() interno e os fetch diretos de market/quality) anexem
// Authorization: Bearer <token>.
//
// As pages continuam VISIVEIS sem login (os GET sao publicos); apenas os botoes
// de acao exigem login. A UI le isAuthenticated para habilitar/desabilitar e
// pedir login quando preciso.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  ApiError,
  readStoredToken,
  setAuthToken,
} from '@/lib/api';

interface AuthContextValue {
  token: string | null;
  isAuthenticated: boolean;
  /** true ate a hidratacao do token do localStorage terminar (evita flicker). */
  isHydrating: boolean;
  /**
   * Faz login com a senha do dono. Lanca ApiError em falha (401 senha invalida,
   * 503 login desabilitado) para a UI exibir a mensagem adequada.
   */
  login: (password: string) => Promise<void>;
  /** Limpa o token (memoria + storage). */
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [isHydrating, setIsHydrating] = useState(true);

  // Hidrata o token do localStorage no mount e sincroniza o store do lib/api.
  useEffect(() => {
    const stored = readStoredToken();
    if (stored) {
      setAuthToken(stored);
      setToken(stored);
    }
    setIsHydrating(false);
  }, []);

  const login = useCallback(async (password: string) => {
    // Nao logar a senha em nenhum ponto.
    const { token: newToken } = await api.login(password);
    setAuthToken(newToken);
    setToken(newToken);
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    setToken(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      isAuthenticated: token !== null,
      isHydrating,
      login,
      logout,
    }),
    [token, isHydrating, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth deve ser usado dentro de <AuthProvider>.');
  }
  return ctx;
}

/**
 * Helper para a UI: dado um erro de mutacao, devolve true se foi 401
 * (precisa logar / sessao expirou). As pages usam para pedir login.
 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
