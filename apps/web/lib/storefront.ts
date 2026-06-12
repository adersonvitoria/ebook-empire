// Client PUBLICO da vitrine (/oferta). Diferente de lib/api.ts: NUNCA envia
// Authorization (as rotas /storefront/* e POST /checkout sao publicas). Reusa
// apenas API_BASE, ApiError e formatBRL de lib/api.ts; os tipos do storefront
// sao espelhados a mao aqui (mesmo padrao do projeto: o browser nao importa core).
//
// Tipos espelham 1:1 os schemas de packages/core/src/schemas.ts:
//   storefrontFeaturedSchema, salesChatBodySchema, salesChatResultSchema.

import { API_BASE, ApiError } from '@/lib/api';

// ------------------------------------------------------------
// Tipos espelhados de @ebook-empire/core (storefront).
// ------------------------------------------------------------
export interface StorefrontProduct {
  slug: string;
  name: string;
  priceCents: number;
  currency: string;
  priceFormatted: string;
}

export interface StorefrontFeatured {
  product: StorefrontProduct;
  ebook: {
    title: string;
    niche: string;
    subtitle?: string;
    language: string;
    coverImagePath?: string;
    whatsInside: string[];
  };
  copy: {
    headline: string;
    subheadline?: string;
    painPoints: string[];
    bullets: string[];
    guarantee?: string;
  };
  opportunity: {
    potentialScore: number;
  };
}

export type ChatRole = 'user' | 'assistant';

export interface StorefrontChatMessage {
  role: ChatRole;
  content: string;
}

export interface SalesChatResult {
  reply: string;
  source: 'llm' | 'canned';
}

// ------------------------------------------------------------
// Checkout (shape REAL de checkoutBodySchema / resposta de checkout.ts).
// ------------------------------------------------------------
export interface CheckoutCustomer {
  name: string;
  email: string;
  /** Apenas digitos; a API nao valida — validacao de CPF e 100% client-side. */
  cpfCnpj?: string;
}

export interface CheckoutUtm {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
}

export interface CheckoutBody {
  productSlug: string;
  customer: CheckoutCustomer;
  visitorId?: string;
  utm?: CheckoutUtm;
}

export interface CheckoutResult {
  orderId: string;
  status: string;
  amountCents: number;
  currency: string;
  /** Payload EMV (mesmo conteudo do copia-e-cola) — NAO e data-URL de imagem. */
  pixQrCode: string;
  pixCopyPaste: string;
  /** ISO. */
  dueDate: string;
}

// ------------------------------------------------------------
// fetch publico: monta URL contra API_BASE, sem Authorization, lanca ApiError
// (mesmo padrao do request() de lib/api.ts, mas sem o Bearer admin).
// ------------------------------------------------------------
function publicUrl(path: string): string {
  return new URL(
    path.replace(/^\//, ''),
    `${API_BASE.replace(/\/$/, '')}/`,
  ).toString();
}

async function publicRequest<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { method = 'GET', body, signal } = init;
  let res: Response;
  try {
    res = await fetch(publicUrl(path), {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'falha de rede';
    throw new ApiError(`Nao foi possivel conectar a API: ${message}`, 0);
  }

  if (!res.ok) {
    let detail = res.statusText;
    let retryAfterSec: number | undefined;
    try {
      const data = (await res.json()) as {
        error?: string;
        message?: string;
        retryAfterSec?: number;
      };
      detail = data.error ?? data.message ?? detail;
      retryAfterSec = data.retryAfterSec;
    } catch {
      // sem corpo JSON — mantem statusText
    }
    const apiErr = new ApiError(detail || `HTTP ${res.status}`, res.status);
    // anexa retryAfterSec quando a API o envia (429 do chat)
    if (retryAfterSec !== undefined) {
      (apiErr as ApiError & { retryAfterSec?: number }).retryAfterSec = retryAfterSec;
    }
    throw apiErr;
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ------------------------------------------------------------
// Endpoints publicos.
// ------------------------------------------------------------

/** GET /storefront/featured — oferta do produto FEATURED (404 no_featured_product). */
export function getFeatured(signal?: AbortSignal): Promise<StorefrontFeatured> {
  return publicRequest<StorefrontFeatured>('/storefront/featured', { signal });
}

/** GET /storefront/products/:slug — oferta de um produto (404 product_not_found). */
export function getProductOffer(
  slug: string,
  signal?: AbortSignal,
): Promise<StorefrontFeatured> {
  return publicRequest<StorefrontFeatured>(
    `/storefront/products/${encodeURIComponent(slug)}`,
    { signal },
  );
}

/**
 * POST /storefront/chat — chat de vendas 24/7. Sempre 200 ({reply, source})
 * salvo 429 (rate_limited, com retryAfterSec) e 400/404. O front trata 429 com
 * mensagem amigavel e nunca quebra a pagina se a API falhar.
 */
export function sendSalesChat(
  body: { productSlug: string; messages: StorefrontChatMessage[] },
  signal?: AbortSignal,
): Promise<SalesChatResult> {
  return publicRequest<SalesChatResult>('/storefront/chat', {
    method: 'POST',
    body,
    signal,
  });
}

/**
 * POST /checkout (publica, ja existe). Cria Order+Payment+cobranca PIX.
 * 201 -> CheckoutResult; 404 product_not_found; 400 invalid_body; 502
 * payment_provider_error. So inclui cpfCnpj/visitorId/utm quando presentes.
 */
export function createCheckout(
  body: CheckoutBody,
  signal?: AbortSignal,
): Promise<CheckoutResult> {
  return publicRequest<CheckoutResult>('/checkout', {
    method: 'POST',
    body,
    signal,
  });
}

// ------------------------------------------------------------
// Helpers de atribuicao (client-only): visitorId persistente + utm da query.
// ------------------------------------------------------------
const VISITOR_STORAGE_KEY = 'ee_visitor';

/** Le/gera o visitorId (UUID em localStorage). Server-safe (retorna undefined). */
export function getVisitorId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    let id = window.localStorage.getItem(VISITOR_STORAGE_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `v_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(VISITOR_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return undefined;
  }
}

/** Captura utm_* da query string atual (client-only). undefined se nenhum. */
export function getUtmFromLocation(): CheckoutUtm | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  const utm: CheckoutUtm = {};
  const map: Array<[keyof CheckoutUtm, string]> = [
    ['utmSource', 'utm_source'],
    ['utmMedium', 'utm_medium'],
    ['utmCampaign', 'utm_campaign'],
    ['utmContent', 'utm_content'],
    ['utmTerm', 'utm_term'],
  ];
  let any = false;
  for (const [key, qs] of map) {
    const v = params.get(qs);
    if (v) {
      utm[key] = v;
      any = true;
    }
  }
  return any ? utm : undefined;
}
