// Pipeline de LANCAMENTO de ebook — harmoniza MARKET_RESEARCH + CONTENT + EBOOK_QA.
//
// createAndLaunchEbook(ctx, opts?) executa, NESTA ordem, com DOIS GATES duros:
//   1) MarketResearch.rankAndPick(ctx) -> seleciona a oportunidade de MAIOR
//      potentialScore. GATE 1 (mercado): se nao houver oportunidade, ABORTA
//      (nenhum ebook e gerado). "SEMPRE faremos isso antes de lancar 1 ebook."
//   2) Content gera o ebook para o segmento topo (status DRAFT, vinculado a
//      Ebook.marketOpportunityId). NAO publica e NAO cria Product ainda.
//   3) EbookQA.auditEbook(ctx, ebookId) -> EbookAudit.
//      - PASS       -> segue para publicacao.
//      - NEEDS_FIX  -> runFixLoop (bounded por QA_MAX_FIX_ITERATIONS):
//                      corrige (regenera) -> reaudita; sai ao PASS ou ao
//                      esgotar as iteracoes.
//      - FAIL       -> NUNCA publica.
//   4) GATE 2 (qualidade): so PUBLICA (Ebook.status=PUBLISHED + Product ativo)
//      se o veredito final for PASS. Senao, mantem DRAFT e registra o motivo.
//
// Escrita disjunta: os SERVICOS dos setores MARKET_RESEARCH (modulo 2) e
// EBOOK_QA (modulo 3) sao de OUTROS donos e podem ainda nao existir quando este
// arquivo compila. Por isso o pipeline NAO os importa estaticamente: ele recebe
// suas capacidades como dependencias INJETAVEIS (LaunchDeps), tipadas SOMENTE
// contra os contratos da Fundacao (@ebook-empire/core). O wiring default resolve
// os servicos por import dinamico DEFENSIVO (mesmo padrao do scheduler), de modo
// que o pacote builda e roda mesmo antes dos modulos 2/3 publicarem.
//
// O proprio AgentRun do CONTENT/QA e gravado pelo ciclo de vida dos agentes/
// servicos acionados; o pipeline correlaciona tudo por ctx.cycleId.

import type {
  EbookAudit,
  EbookAuditVerdict,
  MarketOpportunityRecord,
} from '@ebook-empire/core';
import type { AgentContext } from '../base.js';

// ------------------------------------------------------------
// Specifiers INDIRETOS dos servicos dos setores (modulos 2 e 3 — outros donos).
// Mantidos em variaveis (nao literais) para que o tsc NAO os resolva
// estaticamente: assim ESTE modulo builda mesmo antes de market-research/ e
// ebook-qa/ publicarem seus barrels (escrita disjunta). dynamicImport adia a
// resolucao para runtime; o resolver trata ausencia com fallback seguro.
// ------------------------------------------------------------
const MARKET_RESEARCH_MODULE = '../sectors/market-research/index.js';
const EBOOK_QA_MODULE = '../sectors/ebook-qa/index.js';

/** import() dinamico com specifier indireto (escapa da analise estatica do tsc). */
const dynamicImport = (spec: string): Promise<unknown> =>
  import(/* @vite-ignore */ spec);

// ------------------------------------------------------------
// Contratos INJETAVEIS dos setores (tipados contra a Fundacao).
// Modulo 2 (MarketResearchService) e modulo 3 (EbookQaService) implementam
// estas formas; o pipeline so conhece estes shapes finos.
// ------------------------------------------------------------

/** Capacidade do time MARKET_RESEARCH usada pelo GATE 1. */
export interface MarketResearchCapability {
  /**
   * Rankeia oportunidades e SELECIONA a de maior potencial (marca SELECTED e
   * persiste). Retorna a oportunidade selecionada, ou null se nenhuma foi
   * encontrada (dispara o GATE 1 -> aborta o lancamento).
   */
  rankAndPick(ctx: AgentContext): Promise<MarketOpportunityRecord | null>;
}

/** Capacidade do time EBOOK_QA usada pelo GATE 2 e pelo loop de correcao. */
export interface EbookQaCapability {
  /** Audita um ebook e retorna o EbookAudit (score/verdict deterministicos). */
  auditEbook(ctx: AgentContext, ebookId: string, iteration?: number): Promise<EbookAudit>;
  /**
   * Aplica correcoes a um ebook NEEDS_FIX (regenera capitulos/copy) com base na
   * auditoria anterior. Idempotente o suficiente para ser chamado em loop.
   * Retorna void (o efeito e persistido no Ebook); o pipeline reaudita depois.
   */
  applyFix?(ctx: AgentContext, ebookId: string, audit: EbookAudit): Promise<void>;
}

/** Capacidade de geracao de conteudo usada no passo 2 (DRAFT vinculado). */
export interface ContentGenerationCapability {
  /**
   * Gera um ebook para a oportunidade selecionada, em status DRAFT, vinculado a
   * Ebook.marketOpportunityId. NAO publica e NAO cria Product (o GATE 2 decide).
   * Retorna o id do Ebook criado, ou null se nada foi gerado.
   */
  generateDraft(
    ctx: AgentContext,
    input: ContentGenerationInput,
  ): Promise<{ ebookId: string | null; runId?: string }>;
}

export interface ContentGenerationInput {
  niche: string;
  title?: string;
  language?: string;
  marketOpportunityId: string;
}

// ------------------------------------------------------------
// Dependencias injetaveis do pipeline. Em producao, o wiring default
// (resolveLaunchDeps) preenche tudo por import dinamico defensivo. Em testes,
// injete stubs deterministicos.
// ------------------------------------------------------------
export interface LaunchDeps {
  market: MarketResearchCapability;
  qa: EbookQaCapability;
  content: ContentGenerationCapability;
  /** Publica o ebook aprovado (status PUBLISHED + Product ativo). DI -> testavel. */
  publish: (
    ctx: AgentContext,
    input: PublishInput,
  ) => Promise<{ productId: string | null }>;
}

export interface PublishInput {
  ebookId: string;
  marketOpportunityId: string;
}

// ------------------------------------------------------------
// Opcoes e resultado do pipeline.
// ------------------------------------------------------------
export interface LaunchOptions {
  /** Sobrescreve niche/title sugeridos (default: derivados da oportunidade). */
  niche?: string;
  title?: string;
  language?: string;
  /** Maximo de iteracoes de correcao no loop NEEDS_FIX (default: env.QA_MAX_FIX_ITERATIONS). */
  maxFixIterations?: number;
}

export type LaunchStage =
  | 'MARKET_GATE'
  | 'CONTENT'
  | 'QA'
  | 'FIX_LOOP'
  | 'QUALITY_GATE'
  | 'PUBLISHED';

export interface LaunchResult {
  /** Lancou (publicou) com sucesso? */
  launched: boolean;
  /** Em que estagio o pipeline parou (ou concluiu). */
  stage: LaunchStage;
  /** Motivo legivel em pt-BR (sempre presente). */
  reason: string;
  opportunityId?: string;
  ebookId?: string;
  productId?: string;
  verdict?: EbookAuditVerdict;
  score?: number;
  /** Iteracoes de correcao consumidas (0 se passou de primeira). */
  fixIterations: number;
}

// ============================================================
// createAndLaunchEbook — orquestracao com os dois GATES.
// ============================================================
export async function createAndLaunchEbook(
  ctx: AgentContext,
  opts: LaunchOptions = {},
  deps?: Partial<LaunchDeps>,
): Promise<LaunchResult> {
  const resolved = await resolveLaunchDeps(ctx, deps);

  // -------- GATE 1 (mercado): rankeia e seleciona a oportunidade topo --------
  const opportunity = await resolved.market.rankAndPick(ctx);
  if (!opportunity) {
    const reason =
      'GATE de mercado: nenhuma oportunidade de mercado disponivel — ' +
      'nenhum ebook sera gerado (toda criacao parte de uma MarketOpportunity).';
    ctx.log.warn({ stage: 'MARKET_GATE' }, reason);
    return { launched: false, stage: 'MARKET_GATE', reason, fixIterations: 0 };
  }

  ctx.log.info(
    {
      opportunityId: opportunity.id,
      niche: opportunity.niche,
      potentialScore: opportunity.potentialScore,
    },
    'pipeline: oportunidade selecionada (GATE de mercado OK)',
  );

  // -------- 2) CONTENT: gera o ebook em DRAFT vinculado a oportunidade --------
  const niche = (opts.niche ?? opportunity.niche).trim();
  const title = opts.title ?? opportunity.titleIdeas?.[0];
  const { ebookId } = await resolved.content.generateDraft(ctx, {
    niche,
    title,
    language: opts.language,
    marketOpportunityId: opportunity.id,
  });

  if (!ebookId) {
    const reason = 'geracao de conteudo nao produziu um ebook (DRAFT ausente).';
    ctx.log.warn({ stage: 'CONTENT', opportunityId: opportunity.id }, reason);
    return {
      launched: false,
      stage: 'CONTENT',
      reason,
      opportunityId: opportunity.id,
      fixIterations: 0,
    };
  }

  // -------- 3) QA: audita; se NEEDS_FIX, entra no loop de correcao --------
  const maxIterations = Math.max(
    0,
    opts.maxFixIterations ?? toInt(ctx.env.QA_MAX_FIX_ITERATIONS, 2),
  );

  let audit = await resolved.qa.auditEbook(ctx, ebookId, 0);
  let fixIterations = 0;

  while (audit.verdict === 'NEEDS_FIX' && fixIterations < maxIterations) {
    if (!resolved.qa.applyFix) {
      ctx.log.warn(
        { ebookId, iteration: fixIterations },
        'QA: NEEDS_FIX mas nenhuma capacidade de correcao injetada — encerrando loop',
      );
      break;
    }
    fixIterations += 1;
    ctx.log.info(
      { ebookId, iteration: fixIterations, maxIterations },
      'pipeline: aplicando correcao (loop NEEDS_FIX)',
    );
    await resolved.qa.applyFix(ctx, ebookId, audit);
    audit = await resolved.qa.auditEbook(ctx, ebookId, fixIterations);
  }

  // -------- 4) GATE 2 (qualidade): so publica em PASS --------
  if (audit.verdict !== 'PASS') {
    const reason =
      `GATE de qualidade: ebook nao atingiu PASS (veredito=${audit.verdict}, ` +
      `score=${audit.score}, iteracoes=${fixIterations}) — mantido em DRAFT, nao lancado.`;
    ctx.log.warn(
      { stage: 'QUALITY_GATE', ebookId, verdict: audit.verdict, score: audit.score },
      reason,
    );
    return {
      launched: false,
      stage: 'QUALITY_GATE',
      reason,
      opportunityId: opportunity.id,
      ebookId,
      verdict: audit.verdict,
      score: audit.score,
      fixIterations,
    };
  }

  // PASS -> publica (status PUBLISHED + Product ativo).
  const { productId } = await resolved.publish(ctx, {
    ebookId,
    marketOpportunityId: opportunity.id,
  });

  const reason = `ebook lancado: PASS no QA (score=${audit.score}) apos ${fixIterations} correcao(oes).`;
  ctx.log.info(
    { stage: 'PUBLISHED', ebookId, productId, score: audit.score },
    'pipeline: ebook LANCADO (ambos os GATES satisfeitos)',
  );

  return {
    launched: true,
    stage: 'PUBLISHED',
    reason,
    opportunityId: opportunity.id,
    ebookId,
    productId: productId ?? undefined,
    verdict: 'PASS',
    score: audit.score,
    fixIterations,
  };
}

// ============================================================
// Wiring default (resolucao DEFENSIVA dos servicos por import dinamico).
// Igual ao scheduler: cada dependencia ausente vira um fallback seguro que
// FALHA o estagio correspondente com motivo legivel — nunca quebra o build.
// ============================================================
async function resolveLaunchDeps(
  ctx: AgentContext,
  override?: Partial<LaunchDeps>,
): Promise<LaunchDeps> {
  const market = override?.market ?? (await resolveMarketCapability(ctx));
  const qa = override?.qa ?? (await resolveQaCapability(ctx));
  const content = override?.content ?? (await resolveContentCapability(ctx));
  const publish = override?.publish ?? createDefaultPublish();
  return { market, qa, content, publish };
}

/**
 * Resolve a capacidade de MARKET_RESEARCH a partir do servico do modulo 2.
 * Procura uma classe/fabrica conhecida (MarketResearchService) com metodo
 * rankAndPick. Ausente -> capacidade que devolve null (dispara GATE 1).
 */
async function resolveMarketCapability(
  ctx: AgentContext,
): Promise<MarketResearchCapability> {
  try {
    // Specifier INDIRETO (variavel) de proposito: escrita disjunta. O servico do
    // setor MARKET_RESEARCH (modulo 2) e de outro dono e pode ainda nao existir
    // quando ESTE arquivo compila. Um import dinamico literal seria checado
    // estaticamente pelo tsc e quebraria nosso build; a indirecao por variavel
    // adia a resolucao para runtime (resolve quando o modulo 2 publicar).
    const mod = (await dynamicImport(MARKET_RESEARCH_MODULE)) as Record<string, unknown>;
    const Svc = mod.MarketResearchService;
    if (typeof Svc === 'function') {
      const instance = new (Svc as new () => MarketResearchCapability)();
      if (typeof instance.rankAndPick === 'function') return instance;
    }
    const factory = mod.createMarketResearchService;
    if (typeof factory === 'function') {
      const instance = (factory as () => MarketResearchCapability)();
      if (instance && typeof instance.rankAndPick === 'function') return instance;
    }
  } catch (err) {
    ctx.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'pipeline: MarketResearchService indisponivel — GATE de mercado abortara',
    );
  }
  return {
    async rankAndPick() {
      return null;
    },
  };
}

/**
 * Forma REAL do EbookQaService (modulo 3) — auditEbook devolve {audit,...} (NAO
 * EbookAudit) e NAO tem applyFix. O pipeline precisa de EbookQaCapability
 * (auditEbook -> EbookAudit + applyFix). Esta interface tipa o servico cru para
 * fazermos a PONTE em adaptQaService, sem importar o modulo 3 estaticamente.
 */
interface RawEbookQaService {
  auditEbook(
    ctx: AgentContext,
    ebookId: string,
    opts?: { iteration?: number },
  ): Promise<{ audit: EbookAudit }>;
}

/** Forma minima do FixStrategist (modulo 3): plan(audit) -> { noop, ... }. */
interface RawFixStrategist {
  plan(audit: EbookAudit): { noop: boolean } & Record<string, unknown>;
}

/** Forma minima do RelaunchExecutor (modulo 3): apply(ctx, input, plan). */
interface RawRelaunchExecutor {
  apply(ctx: AgentContext, input: unknown, plan: unknown): Promise<unknown>;
}

/**
 * Resolve a capacidade de EBOOK_QA a partir do servico do modulo 3. Ausente ->
 * fallback que reprova (NEEDS_FIX) para NUNCA publicar sem QA real.
 */
async function resolveQaCapability(ctx: AgentContext): Promise<EbookQaCapability> {
  try {
    const mod = (await dynamicImport(EBOOK_QA_MODULE)) as Record<string, unknown>;
    const Svc = mod.EbookQaService;
    if (typeof Svc === 'function') {
      const instance = new (Svc as new () => RawEbookQaService)();
      if (typeof instance.auditEbook === 'function') return adaptQaService(instance, mod);
    }
    const factory = mod.createEbookQaService;
    if (typeof factory === 'function') {
      const instance = (factory as () => RawEbookQaService)();
      if (instance && typeof instance.auditEbook === 'function') {
        return adaptQaService(instance, mod);
      }
    }
  } catch (err) {
    ctx.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'pipeline: EbookQaService indisponivel — GATE de qualidade reprovara por seguranca',
    );
  }
  return {
    async auditEbook(_ctx, ebookId) {
      // Sem QA real, NUNCA aprova: devolve NEEDS_FIX/FAIL para barrar o GATE 2.
      return {
        ebookId,
        score: 0,
        verdict: 'FAIL',
        issues: [
          {
            category: 'COMPLIANCE',
            severity: 'BLOCKER',
            chapterIndex: null,
            title: 'QA indisponivel',
            detail: 'O servico de QA (EBOOK_QA) ainda nao esta disponivel neste ambiente.',
            suggestion: 'Publique o modulo EBOOK_QA antes de lancar ebooks.',
          },
        ],
        recommendations: ['Aguardar a publicacao do servico EBOOK_QA.'],
        dimensionScores: { structure: 0, contentQuality: 0, marketFit: 0, compliance: 0 },
        iteration: 0,
        auditedAt: ctx.clock.now().toISOString(),
      };
    },
  };
}

/**
 * PONTE: adapta o EbookQaService REAL (modulo 3) ao contrato EbookQaCapability
 * que o pipeline consome. Necessaria porque o servico expoe
 * auditEbook(ctx, ebookId, {iteration}) => Promise<{audit,...}> (NAO EbookAudit)
 * e NAO tem applyFix. Sem esta ponte o pipeline lia audit.verdict === undefined e
 * jamais publicava. A correcao espelha o runFixLoop interno do service: a
 * correcao usa FixStrategist.plan + RelaunchExecutor.apply (ambos do mesmo barrel
 * dinamicamente importado), de modo que o loop NEEDS_FIX converge a PASS.
 */
function adaptQaService(
  service: RawEbookQaService,
  mod: Record<string, unknown>,
): EbookQaCapability {
  const StrategistCtor = mod.FixStrategist as (new () => RawFixStrategist) | undefined;
  const ExecutorCtor = mod.RelaunchExecutor as (new () => RawRelaunchExecutor) | undefined;
  const strategist = typeof StrategistCtor === 'function' ? new StrategistCtor() : undefined;
  const executor = typeof ExecutorCtor === 'function' ? new ExecutorCtor() : undefined;

  const capability: EbookQaCapability = {
    async auditEbook(ctx, ebookId, iteration): Promise<EbookAudit> {
      const { audit } = await service.auditEbook(ctx, ebookId, { iteration });
      return audit;
    },
  };

  // applyFix so existe quando o strategist E o executor estao disponiveis. Caso
  // contrario, o pipeline encerra o loop NEEDS_FIX sem corrigir (fail-safe).
  if (strategist && executor) {
    capability.applyFix = async (ctx, ebookId, audit) => {
      const ebook = await ctx.prisma.ebook.findUnique({
        where: { id: ebookId },
        select: {
          id: true,
          title: true,
          niche: true,
          contentMarkdown: true,
          outline: true,
          marketOpportunity: { select: { id: true, segment: true, niche: true, angles: true } },
        },
      });
      if (!ebook) return;
      const plan = strategist.plan(audit);
      if (plan.noop) return;
      const opp = ebook.marketOpportunity;
      await executor.apply(
        ctx,
        {
          id: ebook.id,
          title: ebook.title,
          niche: ebook.niche,
          contentMarkdown: ebook.contentMarkdown,
          outline: ebook.outline,
          marketOpportunity: opp
            ? {
                id: opp.id,
                segment: opp.segment,
                niche: opp.niche,
                angles: Array.isArray(opp.angles)
                  ? (opp.angles as unknown[]).filter(
                      (v): v is string => typeof v === 'string',
                    )
                  : [],
              }
            : null,
        },
        plan,
      );
    };
  }

  return capability;
}

/**
 * Resolve a capacidade de geracao de conteudo (ContentAgent do modulo PIPELINE,
 * dono deste arquivo). Usa o ContentAgent em modo DRAFT (publish:false) com a
 * oportunidade vinculada. Resolvido por import dinamico para evitar ciclo de
 * import com content.ts (ambos pertencem a este modulo).
 */
async function resolveContentCapability(
  ctx: AgentContext,
): Promise<ContentGenerationCapability> {
  try {
    const mod = (await import('../content.js')) as Record<string, unknown>;
    const Ctor = mod.ContentAgent as
      | (new (pdf?: unknown, params?: unknown) => unknown)
      | undefined;
    if (typeof Ctor === 'function') {
      return {
        async generateDraft(c, input) {
          // ContentAgent(pdfBuilder?, params): em DRAFT (publish:false) o agente
          // NAO publica nem cria Product; o GATE 2 decide. Builder default
          // (fallback textual) — a rota injeta o real quando aciona o pipeline.
          const agent = new (Ctor as new (
            pdf: undefined,
            params: {
              niche: string;
              title?: string;
              language?: string;
              marketOpportunityId: string;
              publish: boolean;
            },
          ) => { execute(ctx: AgentContext): Promise<{ id: string; status: string }>; lastEbookId: string | null })(
            undefined,
            {
              niche: input.niche,
              title: input.title,
              language: input.language,
              marketOpportunityId: input.marketOpportunityId,
              publish: false,
            },
          );
          const rec = await agent.execute(c);
          return { ebookId: agent.lastEbookId, runId: rec.id };
        },
      };
    }
  } catch (err) {
    ctx.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'pipeline: ContentAgent indisponivel para geracao DRAFT',
    );
  }
  return {
    async generateDraft() {
      return { ebookId: null };
    },
  };
}

/**
 * Publicacao default (GATE 2 -> aprovado): vira o Ebook para PUBLISHED e cria um
 * Product ativo (ancora R$47). Idempotente: se ja existe Product ativo, reusa.
 */
const PUBLISH_DEFAULT_PRICE_CENTS = 4700; // R$47,00 (Int centavos BRL).

export function createDefaultPublish(): LaunchDeps['publish'] {
  return async (ctx, input) => {
    const ebook = await ctx.prisma.ebook.findUnique({
      where: { id: input.ebookId },
      select: { id: true, title: true, niche: true, slug: true, status: true },
    });
    if (!ebook) {
      ctx.log.warn({ ebookId: input.ebookId }, 'publish: ebook nao encontrado');
      return { productId: null };
    }

    await ctx.prisma.ebook.update({
      where: { id: input.ebookId },
      data: { status: 'PUBLISHED' },
    });

    // Reusa Product ativo existente (idempotencia) ou cria o de ancora.
    const existing = await ctx.prisma.product.findFirst({
      where: { ebookId: input.ebookId, active: true },
      select: { id: true },
    });
    let productId = existing?.id ?? null;

    if (!productId) {
      const baseSlug = `${(ebook.slug as string) || 'ebook'}-oferta`;
      const productSlug = await uniqueProductSlug(ctx, baseSlug);
      const product = await ctx.prisma.product.create({
        data: {
          ebookId: input.ebookId,
          name: (ebook.title as string) || 'Ebook',
          slug: productSlug,
          description: `Ebook sobre ${(ebook.niche as string) ?? 'o tema'}.`,
          priceCents: PUBLISH_DEFAULT_PRICE_CENTS,
          currency: 'BRL',
          active: true,
        },
        select: { id: true },
      });
      productId = product.id;
    }

    await ctx.prisma.event.create({
      data: {
        type: 'EBOOK_PUBLISHED',
        productId,
        metadata: {
          ebookId: input.ebookId,
          marketOpportunityId: input.marketOpportunityId,
          via: 'launch-pipeline',
        } as unknown as never,
      },
    });

    return { productId };
  };
}

async function uniqueProductSlug(ctx: AgentContext, base: string): Promise<string> {
  const safeBase = base || 'oferta';
  let slug = safeBase;
  let n = 1;
  while (
    await ctx.prisma.product.findUnique({ where: { slug }, select: { id: true } })
  ) {
    n += 1;
    slug = `${safeBase}-${n}`;
  }
  return slug;
}

// ------------------------------------------------------------
// Helper: coerce env numerico (AgentEnv carrega number|string|boolean).
// ------------------------------------------------------------
function toInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
