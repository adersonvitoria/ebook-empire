// Testes de integracao da rota /auth (login do painel interno single-admin).
// Cobre: POST /auth/login (senha certa => 200 + token; errada => 401; body
// invalido => 400; ADMIN_PASSWORD vazio => 503) e GET /auth/me (token valido
// => 200 com payload; sem token => 401).
//
// Segue o padrao das demais *.test.ts: env minimo via process.env ANTES do
// import do env.js. Diferente das outras, aqui registramos o @fastify/jwt real
// e o decorator authenticate (igual ao server.ts) porque precisamos assinar e
// validar tokens de verdade. O caso 503 usa um app isolado com env mockado.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import fastifyJwt from '@fastify/jwt';

// --- env minimo p/ carregar dependencias sem .env real ---
const ADMIN_PASSWORD = 'segredo-do-dono-123';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.USE_STUBS = 'true';
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.AUTH_TOKEN_TTL_SEC = '3600';

// Monta um app Fastify com jwt + decorator authenticate, espelhando o server.ts.
async function buildAuthApp(
  routeMod: { default: (f: FastifyInstance) => Promise<void> },
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: process.env.JWT_SECRET as string });
  app.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.code(401).send({ error: 'unauthorized' });
      }
    },
  );
  await app.register(routeMod.default);
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeAll(async () => {
  const routeMod = await import('./auth.js');
  app = await buildAuthApp(routeMod);
});

describe('POST /auth/login', () => {
  it('200 + token quando a senha bate com ADMIN_PASSWORD', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.expiresInSec).toBe(3600);
  });

  it('token emitido carrega o payload { role:admin, sub:admin } e e aceito por /auth/me', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: ADMIN_PASSWORD },
    });
    const { token } = login.json();
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ role: 'admin', sub: 'admin' });
  });

  it('401 quando a senha esta errada', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: 'senha-errada' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_credentials');
  });

  it('401 mesmo quando a senha errada tem tamanho diferente (sem vazar tamanho)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: 'x' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_credentials');
  });

  it('400 quando o body e invalido (password ausente/vazio)', async () => {
    const ausente = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {},
    });
    expect(ausente.statusCode).toBe(400);
    expect(ausente.json().error).toBe('bad_request');

    const vazio = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: '' },
    });
    expect(vazio.statusCode).toBe(400);
  });
});

describe('GET /auth/me', () => {
  it('401 sem token', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
  });

  it('401 com token invalido', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer nao-e-um-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/login com ADMIN_PASSWORD vazio', () => {
  it('503 login_disabled', async () => {
    // App isolado com env mockado (ADMIN_PASSWORD vazio) para nao afetar os
    // outros testes que dependem do env real carregado no topo.
    vi.resetModules();
    vi.doMock('../env.js', () => ({
      env: {
        ADMIN_PASSWORD: '',
        AUTH_TOKEN_TTL_SEC: 3600,
      },
    }));
    const isolatedRoute = await import('./auth.js');
    const isolatedApp = await buildAuthApp(isolatedRoute);

    const res = await isolatedApp.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: 'qualquer' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('login_disabled');

    await isolatedApp.close();
    vi.doUnmock('../env.js');
    vi.resetModules();
  });
});
