// StoragePort — armazenamento de objetos (PDFs dos ebooks) + URL assinada efemera.
// Real (default local): LocalStorageAdapter grava em disco sob .storage e gera
//   URL assinada via HMAC (expiracao curta, ~5min) — nunca path adivinhavel.
// Interface pronta para S3 (S3StorageAdapter — esqueleto a preencher quando migrar).
// Factory escolhe por env.
//
// Convencao: a URL assinada aponta para a rota interna de download da API
// (PUBLIC_BASE_URL + /storage/object), carregando key + exp + sig. A rota
// valida a assinatura via verifySignedUrl antes de servir os bytes.

import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { StoragePort } from '@ebook-empire/core';

// ------------------------------------------------------------
// Resultado da verificacao de uma URL assinada (uso na rota de download).
// ------------------------------------------------------------
export interface SignedUrlVerification {
  valid: boolean;
  key?: string;
  /** Motivo da falha (expired | bad-signature | malformed). */
  reason?: 'expired' | 'bad-signature' | 'malformed';
}

// Sanitiza a key para impedir path traversal ("../"). Mantem apenas
// caracteres seguros de path relativo.
function safeKey(key: string): string {
  const cleaned = key.replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0')) {
    throw new Error(`Storage key invalida: ${JSON.stringify(key)}`);
  }
  return cleaned;
}

// ------------------------------------------------------------
// LocalStorageAdapter — disco local + HMAC signed URL.
// ------------------------------------------------------------
export class LocalStorageAdapter implements StoragePort {
  private readonly baseDir: string;
  private readonly signingSecret: string;
  private readonly publicBaseUrl: string;

  constructor(opts: {
    baseDir: string;
    signingSecret: string;
    publicBaseUrl: string;
  }) {
    this.baseDir = resolve(opts.baseDir);
    this.signingSecret = opts.signingSecret;
    this.publicBaseUrl = opts.publicBaseUrl.replace(/\/+$/, '');
  }

  private pathFor(key: string): string {
    return join(this.baseDir, safeKey(key));
  }

  async putObject(key: string, bytes: Buffer): Promise<void> {
    const filePath = this.pathFor(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
  }

  async getObject(key: string): Promise<Buffer> {
    const filePath = this.pathFor(key);
    return readFile(filePath);
  }

  // Assina "key.exp" com HMAC-SHA256 (base64url). A URL nunca expoe o path
  // do disco e so e valida ate exp (epoch segundos).
  private sign(key: string, exp: number): string {
    return createHmac('sha256', this.signingSecret)
      .update(`${key}.${exp}`)
      .digest('base64url');
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    const safe = safeKey(key);
    const exp = Math.floor(Date.now() / 1000) + Math.max(1, ttlSeconds);
    const sig = this.sign(safe, exp);
    const params = new URLSearchParams({ key: safe, exp: String(exp), sig });
    return `${this.publicBaseUrl}/storage/object?${params.toString()}`;
  }

  /**
   * Valida os parametros de uma URL assinada (chamada pela rota de download).
   * Comparacao de assinatura em tempo constante.
   */
  verifySignedUrl(params: {
    key?: string;
    exp?: string;
    sig?: string;
  }): SignedUrlVerification {
    const { key, exp, sig } = params;
    if (!key || !exp || !sig) {
      return { valid: false, reason: 'malformed' };
    }
    const expNum = Number(exp);
    if (!Number.isFinite(expNum)) {
      return { valid: false, reason: 'malformed' };
    }
    if (Math.floor(Date.now() / 1000) > expNum) {
      return { valid: false, reason: 'expired' };
    }

    let safe: string;
    try {
      safe = safeKey(key);
    } catch {
      return { valid: false, reason: 'malformed' };
    }

    const expected = this.sign(safe, expNum);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: 'bad-signature' };
    }
    return { valid: true, key: safe };
  }
}

// ------------------------------------------------------------
// S3StorageAdapter — esqueleto pronto para producao (presigned URLs nativas).
// Implementacao concreta fica para a migracao S3; lanca por ora para evitar
// uso acidental em runtime real. A interface ja casa com StoragePort.
// ------------------------------------------------------------
export interface S3StorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
}

export class S3StorageAdapter implements StoragePort {
  constructor(private readonly config: S3StorageConfig) {}

  private notImplemented(): never {
    throw new Error(
      `S3StorageAdapter ainda nao implementado (bucket=${this.config.bucket}). ` +
        'Use LocalStorageAdapter ate migrar para S3.',
    );
  }

  async putObject(_key: string, _bytes: Buffer): Promise<void> {
    this.notImplemented();
  }

  async getObject(_key: string): Promise<Buffer> {
    this.notImplemented();
  }

  async getSignedUrl(_key: string, _ttlSeconds: number): Promise<string> {
    this.notImplemented();
  }
}

// ------------------------------------------------------------
// Config + factory.
// ------------------------------------------------------------
export interface StorageAdapterConfig {
  /** 'local' (disco) ou 's3' (futuro). */
  driver?: 'local' | 's3';
  /** Diretorio base para o driver local. */
  storageDir: string;
  /** Segredo para assinar URLs (reusa JWT_SECRET). */
  signingSecret: string;
  /** Base publica da API (para montar a URL assinada). */
  publicBaseUrl: string;
  /** Config S3 quando driver='s3'. */
  s3?: S3StorageConfig;
}

export function createStorageAdapter(config: StorageAdapterConfig): StoragePort {
  if (config.driver === 's3') {
    if (!config.s3) {
      throw new Error('createStorageAdapter: driver=s3 requer config.s3.');
    }
    return new S3StorageAdapter(config.s3);
  }
  return new LocalStorageAdapter({
    baseDir: config.storageDir,
    signingSecret: config.signingSecret,
    publicBaseUrl: config.publicBaseUrl,
  });
}
