// Rota de health-check. EXEMPLO CANONICO da convencao de plugin Fastify:
// cada arquivo src/routes/X.ts exporta default uma funcao async (fastify) => {}.
// O server.ts ja registra este plugin por caminho fixo — nao edite o server.

import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

export default async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', async (_request, reply) => {
    let db: 'ok' | 'down' = 'ok';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }

    const status = db === 'ok' ? 200 : 503;
    return reply.code(status).send({
      status: db === 'ok' ? 'ok' : 'degraded',
      service: 'ebook-empire-api',
      db,
      timestamp: new Date().toISOString(),
    });
  });
}
