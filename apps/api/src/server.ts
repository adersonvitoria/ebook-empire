// FUNDACAO — bootstrap da API Fastify.
// Registra @fastify/jwt e IMPORTA+REGISTRA por caminho fixo TODAS as rotas.
// Os arquivos de rota (exceto health) sao criados pelos agentes de implementacao;
// os imports/registros abaixo JA existem. NUNCA editar este arquivo para
// adicionar rotas novas — cada rota tem seu proprio arquivo e dono.

import { pathToFileURL } from 'node:url';

import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';

// Tipagem do decorator de autenticacao e do payload JWT.
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

import { env } from './env.js';
import { prisma } from './db.js';

// Rotas (plugins Fastify; cada arquivo exporta default async (fastify) => {}).
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import ebooksRoutes from './routes/ebooks.js';
import checkoutRoutes from './routes/checkout.js';
import deliveryRoutes from './routes/delivery.js';
import socialRoutes from './routes/social.js';
import adsRoutes from './routes/ads.js';
import agentsRoutes from './routes/agents.js';
import crmRoutes from './routes/crm.js';
import alertsRoutes from './routes/alerts.js';
import financeRoutes from './routes/finance.js';
import marketRoutes from './routes/market.js';
import qualityRoutes from './routes/quality.js';
import hotmartWebhookRoutes from './routes/webhooks/hotmart.js';
import kiwifyWebhookRoutes from './routes/webhooks/kiwify.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'development' ? 'debug' : 'info',
    },
  });

  // --- CORS (origem do frontend autorizada via env.CORS_ORIGIN) ---
  // Registrado ANTES dos plugins de rota para cobrir todas as rotas.
  await app.register(fastifyCors, {
    origin: env.CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // --- Auth (Bearer JWT) ---
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
  });

  // Decorator de guarda reutilizavel para rotas administrativas/internas.
  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // --- Registro de TODAS as rotas por caminho fixo ---
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(ebooksRoutes);
  await app.register(checkoutRoutes);
  await app.register(deliveryRoutes);
  await app.register(socialRoutes);
  await app.register(adsRoutes);
  await app.register(agentsRoutes);
  await app.register(crmRoutes);
  await app.register(alertsRoutes);
  await app.register(financeRoutes);
  await app.register(marketRoutes);
  await app.register(qualityRoutes);
  await app.register(hotmartWebhookRoutes);
  await app.register(kiwifyWebhookRoutes);

  // Fecha o Prisma no shutdown do servidor.
  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  return app;
}

async function start(): Promise<void> {
  const app = await buildServer();

  // O scheduler (unico dono do setInterval) e criado por outro agente em
  // ./scheduler.ts e exporta startScheduler(app). Importado dinamicamente
  // para nao quebrar o boot enquanto o arquivo nao existir, e gated por env.
  if (env.ENABLE_AGENTS) {
    try {
      const mod = (await import('./scheduler.js')) as {
        startScheduler?: (app: FastifyInstance) => void;
      };
      mod.startScheduler?.(app);
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'scheduler ainda nao disponivel — seguindo sem agentes',
      );
    }
  }

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`Ebook Empire API ouvindo em ${env.PUBLIC_BASE_URL}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Auto-start quando executado diretamente (nao em import de teste).
// Usa pathToFileURL para comparar de forma robusta em Windows e POSIX
// (drive letter, barras invertidas e file:/// nao batem com template literal).
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void start();
}
