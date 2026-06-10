// Rota de autenticacao do painel interno (single-admin).
// Plugin Fastify (default async (fastify) => {}) registrado por caminho fixo no
// server.ts — NAO editar o server. As demais rotas administrativas continuam
// protegidas pelo decorator fastify.authenticate; aqui so emitimos/validamos o token.
//
//   POST /auth/login  -> { password }. Compara contra env.ADMIN_PASSWORD em tempo
//                        constante (timingSafeEqual). ADMIN_PASSWORD vazio => 503
//                        login_disabled; senha errada => 401 invalid_credentials;
//                        sucesso => { token, expiresInSec } via fastify.jwt.sign.
//   GET  /auth/me     -> protegido por fastify.authenticate; devolve { role, sub }.
//
// NUNCA logar a senha nem o token.

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { loginBodySchema } from '@ebook-empire/core';

import { env } from '../env.js';

// Comparacao de senha em tempo constante, resistente a vazamento de tamanho.
// Se os tamanhos diferem, ainda executamos um timingSafeEqual "dummy" (contra o
// proprio buffer recebido) para gastar tempo comparavel e retornamos false.
function passwordMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Dummy compare para nao vazar diferenca de tamanho via timing.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // --- POST /auth/login ---
  fastify.post('/auth/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request' });
    }

    // Login desabilitado quando nenhuma senha foi configurada.
    if (env.ADMIN_PASSWORD === '') {
      return reply.code(503).send({ error: 'login_disabled' });
    }

    if (!passwordMatches(parsed.data.password, env.ADMIN_PASSWORD)) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const token = fastify.jwt.sign(
      { role: 'admin', sub: 'admin' },
      { expiresIn: env.AUTH_TOKEN_TTL_SEC },
    );

    return reply.code(200).send({ token, expiresInSec: env.AUTH_TOKEN_TTL_SEC });
  });

  // --- GET /auth/me ---
  // Valida o Bearer (o decorator responde 401 em falha) e devolve o payload.
  fastify.get('/auth/me', { preHandler: fastify.authenticate }, async (request) => {
    const user = request.user as { role?: string; sub?: string };
    return { role: user.role, sub: user.sub };
  });
}
