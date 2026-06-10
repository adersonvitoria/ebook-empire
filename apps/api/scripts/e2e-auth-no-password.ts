// Subprocesso do e2e-auth: roda num processo LIMPO com ADMIN_PASSWORD vazio
// (o env e singleton por processo, entao o caso 503 precisa de boot proprio).
// Sai 0 se POST /auth/login responde 503 login_disabled; caso contrario sai 1.
//
// Nao roda direto — e disparado por scripts/e2e-auth.ts via spawnSync.

process.env.ADMIN_PASSWORD = ''; // garante login desabilitado
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 8) {
  process.env.JWT_SECRET = 'e2e-auth-jwt-secret-0123456789abcdef';
}
process.env.USE_STUBS = process.env.USE_STUBS ?? 'true';
process.env.ENABLE_AGENTS = process.env.ENABLE_AGENTS ?? 'false';

async function main(): Promise<void> {
  const { buildServer } = await import('../src/server.js');
  const { prisma } = await import('../src/db.js');

  const app = await buildServer();
  await app.ready();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: 'qualquer-coisa' },
    });
    const body = res.json() as { error?: string };
    const ok = res.statusCode === 503 && body.error === 'login_disabled';
    console.log(
      `  [${ok ? 'PASS' : 'FAIL'}] sem ADMIN_PASSWORD: /auth/login => ${res.statusCode} ${body.error ?? ''}`,
    );
    if (!ok) process.exitCode = 1;
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('  [FAIL] subprocesso 503 abortou:', err);
  process.exit(1);
});
