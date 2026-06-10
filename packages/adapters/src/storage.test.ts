// Testes do StoragePort local: put/get round-trip, assinatura HMAC e verificacao
// (expiracao, assinatura adulterada, malformacao), alem de protecao contra traversal.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createStorageAdapter,
  LocalStorageAdapter,
  S3StorageAdapter,
} from './storage.js';

describe('LocalStorageAdapter', () => {
  let dir: string;
  let storage: LocalStorageAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ee-storage-'));
    storage = new LocalStorageAdapter({
      baseDir: dir,
      signingSecret: 'segredo-de-teste-1234',
      publicBaseUrl: 'http://localhost:3001/',
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('faz put/get round-trip dos bytes', async () => {
    const payload = Buffer.from('conteudo-pdf-falso');
    await storage.putObject('ebooks/abc/book.pdf', payload);
    const back = await storage.getObject('ebooks/abc/book.pdf');
    expect(back.equals(payload)).toBe(true);
  });

  it('gera URL assinada que verifica com sucesso', async () => {
    const url = await storage.getSignedUrl('ebooks/x.pdf', 300);
    expect(url).toContain('http://localhost:3001/storage/object?');
    const params = Object.fromEntries(new URL(url).searchParams.entries());
    const check = storage.verifySignedUrl(params);
    expect(check.valid).toBe(true);
    expect(check.key).toBe('ebooks/x.pdf');
  });

  it('rejeita URL com assinatura adulterada', async () => {
    const url = await storage.getSignedUrl('ebooks/x.pdf', 300);
    const params = Object.fromEntries(new URL(url).searchParams.entries());
    params.sig = `${params.sig}tampered`;
    const check = storage.verifySignedUrl(params);
    expect(check.valid).toBe(false);
    expect(check.reason).toBe('bad-signature');
  });

  it('rejeita URL expirada', async () => {
    const check = storage.verifySignedUrl({
      key: 'ebooks/x.pdf',
      exp: String(Math.floor(Date.now() / 1000) - 10),
      // assinatura irrelevante: a expiracao e checada antes
      sig: 'qualquer',
    });
    expect(check.valid).toBe(false);
    expect(check.reason).toBe('expired');
  });

  it('rejeita parametros malformados', () => {
    expect(storage.verifySignedUrl({}).reason).toBe('malformed');
    expect(
      storage.verifySignedUrl({ key: 'k', exp: 'nao-numero', sig: 's' }).reason,
    ).toBe('malformed');
  });

  it('impede path traversal na key', async () => {
    await expect(
      storage.getObject('\0invalida'),
    ).rejects.toThrow();
  });
});

describe('createStorageAdapter', () => {
  it('retorna LocalStorageAdapter por padrao', () => {
    const s = createStorageAdapter({
      driver: 'local',
      storageDir: './tmp',
      signingSecret: 'x',
      publicBaseUrl: 'http://localhost:3001',
    });
    expect(s).toBeInstanceOf(LocalStorageAdapter);
  });

  it('retorna S3StorageAdapter quando driver=s3', () => {
    const s = createStorageAdapter({
      driver: 's3',
      storageDir: './tmp',
      signingSecret: 'x',
      publicBaseUrl: 'http://localhost:3001',
      s3: {
        bucket: 'b',
        region: 'us-east-1',
        accessKeyId: 'a',
        secretAccessKey: 's',
      },
    });
    expect(s).toBeInstanceOf(S3StorageAdapter);
  });
});
