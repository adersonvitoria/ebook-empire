// Fixture de verificacao da REGRA DAS 4 LOCALIZACOES para os ActionKinds novos
// da Fase 5 (COO-Scale). Garante, programaticamente, que cada kind existe e com
// nome IDENTICO em:
//   (1) packages/core actionKindSchema (enum) — espelha o Prisma enum;
//   (2) ACTION_SPECS (catalogo) — riskTier/reversibilidade estaticos;
//   (3) executor.dispatch — roteia o kind para um lever (sem cair no default);
//   (4) levers-live (LiveRemediationLevers) — possui o metodo correspondente.
// Drift entre eles causa erro de runtime; este fixture o transforma em erro de teste.

import { actionKindSchema, type ActionKind } from '@ebook-empire/core';
import { ACTION_SPECS } from '../action-catalog.js';
import { LiveRemediationLevers } from '../levers-live.js';
import { GuardedActionExecutor, type RemediationLevers, type LeverResult } from '../executor.js';
import type { AgentContext } from '../../base.js';
import type { Json } from '@ebook-empire/core';
import type { RemediationActionRef } from '../contracts.js';

/** Os 4 ActionKinds introduzidos pela Fase 5 (COO-Scale). */
export const ACTION_KINDS_SCALE: ActionKind[] = [
  'GENERATE_MORE_EBOOKS',
  'PAUSE_LISTING',
  'BOOST_AFFILIATE_OUTREACH',
  'SEND_AFFILIATE_EMAIL',
];

/** Metodo de lever esperado por kind (LOCALIZACAO 4). */
const LEVER_METHOD: Record<string, keyof RemediationLevers> = {
  GENERATE_MORE_EBOOKS: 'generateMoreEbooks',
  PAUSE_LISTING: 'pauseListing',
  BOOST_AFFILIATE_OUTREACH: 'boostAffiliateOutreach',
  SEND_AFFILIATE_EMAIL: 'sendAffiliateEmail',
};

/**
 * Lever-espia: registra qual metodo o executor chamou (LOCALIZACAO 3). Cada
 * metodo devolve um LeverResult trivial; o que importa e QUAL foi roteado.
 */
function makeSpyLevers(): RemediationLevers & { called: string | null } {
  const ok = (): Promise<LeverResult> =>
    Promise.resolve({ beforeState: {} as Json, afterState: {} as Json });
  const state: { called: string | null } = { called: null };
  const trap = (name: string) => () => {
    state.called = name;
    return ok();
  };
  const obj = {
    get called() {
      return state.called;
    },
    retryDeliveries: trap('retryDeliveries'),
    generateEbook: trap('generateEbook'),
    generateSocialPosts: trap('generateSocialPosts'),
    regenerateLandingCopy: trap('regenerateLandingCopy'),
    recomputeKpis: trap('recomputeKpis'),
    rerunAgent: trap('rerunAgent'),
    increaseAdBudget: trap('increaseAdBudget'),
    decreaseAdBudget: trap('decreaseAdBudget'),
    pauseCampaign: trap('pauseCampaign'),
    adjustPrice: trap('adjustPrice'),
    generateMoreEbooks: trap('generateMoreEbooks'),
    pauseListing: trap('pauseListing'),
    boostAffiliateOutreach: trap('boostAffiliateOutreach'),
    sendAffiliateEmail: trap('sendAffiliateEmail'),
    revert: trap('revert'),
  };
  return obj as unknown as RemediationLevers & { called: string | null };
}

/**
 * Prisma minimo (em memoria) cobrindo a superficie que o executor toca ao aplicar
 * 1 acao LOW sem guardrails (kill switch off, cota alta, sem cooldown).
 */
function makeMinimalPrisma() {
  return {
    guardrailConfig: {
      findUnique: async () => ({
        killSwitch: false,
        maxAutoActionsPerCycle: 100,
        cooldownMinutes: 0,
        maxAdBudgetCents: null,
      }),
    },
    problem: { findUnique: async () => ({ sector: 'CONTENT' }) },
    actionExecution: { create: async () => ({ id: 'exec' }) },
    remediationAction: { update: async () => ({}) },
  } as unknown as AgentContext['prisma'];
}

function makeCtx(prisma: AgentContext['prisma']): AgentContext {
  return {
    prisma,
    ports: {} as AgentContext['ports'],
    env: {
      ENABLE_AGENTS: true,
      MAX_AD_BUDGET_BRL: 300,
      TARGET_DAILY_REVENUE_BRL: 1000,
      PUBLIC_BASE_URL: 'http://localhost:3001',
      CONTENT_MODEL: 'claude-sonnet-4-6',
      PLANNING_MODEL: 'claude-opus-4-8',
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clock: { now: () => new Date('2026-06-10T09:00:00.000Z') },
  };
}

/**
 * Verifica as 4 localizacoes. Lanca Error com mensagem clara na primeira
 * inconsistencia encontrada. Sem retorno = tudo consistente.
 */
export async function assertFourLocations(): Promise<void> {
  const enumValues = actionKindSchema.options as readonly string[];
  const levers = new LiveRemediationLevers();

  for (const kind of ACTION_KINDS_SCALE) {
    // (1) enum do core
    if (!enumValues.includes(kind)) {
      throw new Error(`LOCALIZACAO 1 (core actionKindSchema) nao contem ${kind}`);
    }
    // (2) ACTION_SPECS do catalogo
    if (!ACTION_SPECS[kind] || ACTION_SPECS[kind].kind !== kind) {
      throw new Error(`LOCALIZACAO 2 (ACTION_SPECS) nao contem ${kind}`);
    }
    // (4) metodo no LiveRemediationLevers
    const method = LEVER_METHOD[kind];
    if (!method || typeof (levers as unknown as Record<string, unknown>)[method] !== 'function') {
      throw new Error(`LOCALIZACAO 4 (levers-live) sem metodo ${method} para ${kind}`);
    }
  }

  // (3) executor.dispatch roteia cada kind para o lever certo (sem cair no
  // default que rejeita). Exercitamos o caminho publico applyWith com um
  // lever-espia e checamos QUAL metodo foi chamado.
  for (const kind of ACTION_KINDS_SCALE) {
    const spy = makeSpyLevers();
    const executor = new GuardedActionExecutor(spy);
    const ctx = makeCtx(makeMinimalPrisma());
    const ref: RemediationActionRef = {
      id: 'a',
      problemId: 'p',
      kind,
      riskTier: 'LOW', // forca caminho AUTO (HIGH iria p/ fila sem chamar lever)
      params: { kind, affiliateId: 'aff_1', productId: 'prod_1', niche: 'n', count: 1 } as Json,
      expectedEffect: '',
      status: 'PROPOSED',
      reversible: ACTION_SPECS[kind].reversible,
      dedupeKey: 'k',
    };
    const result = await executor.applyWith(ctx, ref, { triggeredBy: 'AUTO' });
    if (!result.success) {
      throw new Error(`LOCALIZACAO 3 (executor.dispatch): ${kind} nao aplicou (${result.error ?? result.blockedByGuardrail})`);
    }
    const expectedMethod = LEVER_METHOD[kind];
    if (spy.called !== expectedMethod) {
      throw new Error(
        `LOCALIZACAO 3 (executor.dispatch): ${kind} roteou para "${spy.called}" (esperado "${expectedMethod}")`,
      );
    }
  }
}

/** Re-export util p/ leitura nos testes. */
export type { AgentContext };
