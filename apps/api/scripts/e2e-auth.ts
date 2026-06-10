// E2E de autenticacao do painel interno (single-admin) contra Postgres REAL.
// Espelha o padrao dos demais e2e (apps/api/scripts/e2e-crm.ts): buildServer +
// app.inject, limpando o singleton de guardrails no inicio. USE_STUBS=true.
//
// IMPORTANTE: env.ts carrega o ADMIN_PASSWORD no PRIMEIRO import (singleton).
// Por isso definimos process.env.ADMIN_PASSWORD ANTES de importar o server/env
// (import dinamico dentro de main). O caso "sem ADMIN_PASSWORD => 503" nao pode
// reusar o mesmo processo (env ja resolvido), entao roda num subprocesso tsx
// limpo com ADMIN_PASSWORD vazio.
//
// Prova:
//   (a) POST /auth/login senha ERRADA            => 401
//   (b) POST /auth/login senha CERTA             => 200 + { token }
//   (c) GET /auth/me com Bearer                  => 200 ; sem token => 401
//   (d) POST /crm/killswitch SEM token           => 401
//       POST /crm/killswitch COM token           => 200 e o kill switch ALTERNA
//   (e) sem ADMIN_PASSWORD (subprocesso)         => /auth/login 503
//
// Roda com: pnpm --filter @ebook-empire/api e2e:auth
//        ou: node --import tsx scripts/e2e-auth.ts  (a partir de apps/api)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Senha de teste DEFINIDA antes de qualquer import que resolva o env.
const TEST_ADMIN_PASSWORD = 'senha-de-teste-e2e-auth-123';
process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
// Garante segredo JWT valido (>=8 chars) mesmo se o .env nao tiver sido carregado.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 8) {
  process.env.JWT_SECRET = 'e2e-auth-jwt-secret-0123456789abcdef';
}
process.env.USE_STUBS = process.env.USE_STUBS ?? 'true';
process.env.ENABLE_AGENTS = process.env.ENABLE_AGENTS ?? 'false';

// ---- asserts ----
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('\n=== Ebook Empire — E2E Auth (painel single-admin, Postgres real) ===\n');

  // Imports dinamicos: o env so e resolvido AGORA, com ADMIN_PASSWORD ja setado.
  const { buildServer } = await import('../src/server.js');
  const { prisma } = await import('../src/db.js');

  await prisma.$queryRaw`SELECT 1`;
  console.log('[0] Conexao com Postgres OK (5433)\n');

  // Estado conhecido do kill switch: deixa OFF (false) antes de testar a alternancia.
  await prisma.guardrailConfig.upsert({
    where: { id: 'singleton' },
    update: { killSwitch: false },
    create: { id: 'singleton', killSwitch: false },
  });

  const app = await buildServer();
  await app.ready();

  try {
    // ========================================================
    // (a) login com senha ERRADA => 401
    // ========================================================
    console.log('[1] POST /auth/login senha ERRADA');
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: 'senha-totalmente-errada' },
    });
    check('login senha errada => 401', wrong.statusCode === 401, String(wrong.statusCode));
    check('corpo marca invalid_credentials', wrong.json()?.error === 'invalid_credentials',
      JSON.stringify(wrong.json()));

    // ========================================================
    // (b) login com senha CERTA => 200 + token
    // ========================================================
    console.log('[2] POST /auth/login senha CERTA');
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: TEST_ADMIN_PASSWORD },
    });
    check('login senha certa => 200', ok.statusCode === 200, String(ok.statusCode));
    const loginBody = ok.json() as { token?: string; expiresInSec?: number };
    const token = loginBody.token ?? '';
    check('resposta traz token (string nao-vazia)', typeof token === 'string' && token.length > 0,
      token ? 'token presente' : 'sem token');
    check('resposta traz expiresInSec > 0',
      typeof loginBody.expiresInSec === 'number' && loginBody.expiresInSec > 0,
      String(loginBody.expiresInSec));

    const auth = { authorization: `Bearer ${token}` };

    // ========================================================
    // (c) GET /auth/me com Bearer => 200 ; sem token => 401
    // ========================================================
    console.log('[3] GET /auth/me');
    const meOk = await app.inject({ method: 'GET', url: '/auth/me', headers: auth });
    check('/auth/me com Bearer => 200', meOk.statusCode === 200, String(meOk.statusCode));
    const meBody = meOk.json() as { role?: string; sub?: string };
    check('/auth/me devolve role=admin', meBody.role === 'admin', JSON.stringify(meBody));

    const meNoToken = await app.inject({ method: 'GET', url: '/auth/me' });
    check('/auth/me sem token => 401', meNoToken.statusCode === 401, String(meNoToken.statusCode));

    // ========================================================
    // (d) POST /crm/killswitch — sem token 401 ; com token 200 e ALTERNA
    // ========================================================
    console.log('[4] POST /crm/killswitch (rota protegida real)');
    const ksNoToken = await app.inject({
      method: 'POST',
      url: '/crm/killswitch',
      payload: { enabled: true },
    });
    check('killswitch SEM token => 401', ksNoToken.statusCode === 401, String(ksNoToken.statusCode));

    // Le o estado atual e envia o OPOSTO para provar que a rota alterna de fato.
    const before = (await prisma.guardrailConfig.findUnique({ where: { id: 'singleton' } }))!.killSwitch;
    const ksOn = await app.inject({
      method: 'POST',
      url: '/crm/killswitch',
      headers: auth,
      payload: { enabled: !before },
    });
    check('killswitch COM token => 200', ksOn.statusCode === 200, String(ksOn.statusCode));
    const ksBody = ksOn.json() as { killSwitch?: boolean };
    check('resposta reflete o novo estado (alternou)', ksBody.killSwitch === !before,
      `${before} -> ${ksBody.killSwitch}`);
    const afterDb = (await prisma.guardrailConfig.findUnique({ where: { id: 'singleton' } }))!.killSwitch;
    check('kill switch persistido no DB (alternou)', afterDb === !before, `db=${afterDb}`);

    // Restaura para OFF (estado neutro para os outros e2e).
    await app.inject({
      method: 'POST',
      url: '/crm/killswitch',
      headers: auth,
      payload: { enabled: false },
    });
    console.log('');
  } finally {
    await app.close();
    await prisma.$disconnect();
  }

  // ========================================================
  // (e) sem ADMIN_PASSWORD => /auth/login 503 (subprocesso limpo)
  // ========================================================
  console.log('[5] Sem ADMIN_PASSWORD => /auth/login 503 (subprocesso)');
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve(here, 'e2e-auth-no-password.ts')],
    {
      cwd: resolve(here, '..'),
      env: {
        ...process.env,
        ADMIN_PASSWORD: '', // login desabilitado
        JWT_SECRET: process.env.JWT_SECRET,
        USE_STUBS: 'true',
        ENABLE_AGENTS: 'false',
      },
      encoding: 'utf8',
    },
  );
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.status !== 0 && child.stderr) process.stderr.write(child.stderr);
  check('subprocesso sem ADMIN_PASSWORD: /auth/login => 503', child.status === 0,
    `exit=${child.status}`);
  console.log('');

  console.log('=== Resultado ===');
  console.log(`  PASSARAM: ${passed}   FALHARAM: ${failed}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nE2E Auth abortou com erro:', err);
  process.exit(1);
});
