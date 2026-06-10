// AffiliateOutreachAgent — prospeccao autonoma de afiliados (setor AFFILIATE).
//
// Fluxo de dominio (idempotente por tick, cadencia controlada por cooldown):
//  1) Seleciona Affiliates status=PROSPECT cujo lastContactedAt e null OU mais
//     velho que AFFILIATE_OUTREACH_COOLDOWN_DAYS (respeita a cadencia).
//  2) Para cada um: gera copy pt-BR personalizada via LLMPort (oferta de comissao,
//     nicho do ebook associado, potencial de ganho) -> { subject, emailBody, whatsappBody }.
//  3) Envia o email via EmailPort; se houver whatsappNumber E ports.whatsapp,
//     envia tambem a versao curta por WhatsApp (best-effort, nao derruba o email).
//  4) Cria 1 AffiliateOutreach por canal enviado (append-only).
//  5) Emite Event(AFFILIATE_CONTACTED) (payload carrega affiliateId/canais).
//  6) Atualiza Affiliate.lastContactedAt.
//
// NUNCA toca a tabela AgentRun (isso e do ciclo de vida em Agent.execute).
// Recebe ports via ctx.ports (DI -> stub em vitest). O WhatsAppPort e OPCIONAL
// (ctx.ports.whatsapp?) — wirings parciais o omitem e o agente segue so com email.

import { Agent, skipped, type AgentContext, type AgentRunResult } from './base.js';
import { z } from 'zod';
import type { AgentName } from '@ebook-empire/core';

// Quantos afiliados contatar por tick (evita rajadas / custo de LLM).
const MAX_OUTREACH_PER_TICK = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Copy gerada pelo LLM (validada por Zod). emailBody em texto simples (pt-BR);
// whatsappBody e a versao curta para WhatsApp.
const affiliateCopySchema = z.object({
  subject: z.string().min(1).max(160),
  emailBody: z.string().min(1),
  whatsappBody: z.string().min(1),
});
type AffiliateCopy = z.infer<typeof affiliateCopySchema>;

// Dado minimo de um afiliado prospeccionavel (+ nicho do ebook associado).
interface ProspectAffiliate {
  id: string;
  name: string;
  email: string;
  whatsappNumber: string | null;
  commissionPct: number;
  ebookId: string | null;
  niche: string | null;
}

export class AffiliateOutreachAgent extends Agent {
  readonly name: AgentName = 'AFFILIATE';

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const now = ctx.clock.now();
    const cooldownDays = this.cooldownDays(ctx);
    const cutoff = new Date(now.getTime() - cooldownDays * MS_PER_DAY);

    const prospects = await this.pickProspects(ctx, cutoff, MAX_OUTREACH_PER_TICK);
    if (prospects.length === 0) {
      return skipped('nenhum afiliado PROSPECT elegivel (cooldown ou inexistente)');
    }

    let contacted = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let costCents = 0;

    for (const prospect of prospects) {
      const usage = await this.contactOne(ctx, prospect, now);
      tokensIn += usage.inputTokens;
      tokensOut += usage.outputTokens;
      costCents += usage.costCents ?? 0;
      contacted += 1;
    }

    return {
      status: 'SUCCESS',
      output: { contacted },
      metrics: { contacted },
      tokensIn,
      tokensOut,
      costCents,
    };
  }

  // ---------------------------------------------------------
  // Contata UM afiliado especifico (usado pelo lever SEND_AFFILIATE_EMAIL).
  // Carrega o afiliado por id, exige status que permita contato e dispara o
  // mesmo fluxo (copy -> email/whatsapp -> outreach -> evento -> lastContactedAt).
  // Retorna se contatou de fato (false = afiliado inexistente/unsubscribed).
  // ---------------------------------------------------------
  async runForAffiliate(ctx: AgentContext, affiliateId: string): Promise<boolean> {
    const now = ctx.clock.now();
    const row = await ctx.prisma.affiliate.findUnique({
      where: { id: affiliateId },
      select: {
        id: true,
        name: true,
        email: true,
        whatsappNumber: true,
        commissionPct: true,
        ebookId: true,
        status: true,
      },
    });
    if (!row || row.status === 'UNSUBSCRIBED') return false;

    const prospect: ProspectAffiliate = {
      id: row.id,
      name: row.name,
      email: row.email,
      whatsappNumber: row.whatsappNumber,
      commissionPct: row.commissionPct,
      ebookId: row.ebookId,
      niche: await this.resolveNiche(ctx, row.ebookId),
    };
    await this.contactOne(ctx, prospect, now);
    return true;
  }

  // ---------------------------------------------------------
  // Seleciona PROSPECTs elegiveis (lastContactedAt null ou < cutoff).
  // ---------------------------------------------------------
  private async pickProspects(
    ctx: AgentContext,
    cutoff: Date,
    limit: number,
  ): Promise<ProspectAffiliate[]> {
    const rows = await ctx.prisma.affiliate.findMany({
      where: {
        status: 'PROSPECT',
        OR: [{ lastContactedAt: null }, { lastContactedAt: { lt: cutoff } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        id: true,
        name: true,
        email: true,
        whatsappNumber: true,
        commissionPct: true,
        ebookId: true,
      },
    });

    const prospects: ProspectAffiliate[] = [];
    for (const r of rows) {
      prospects.push({
        id: r.id,
        name: r.name,
        email: r.email,
        whatsappNumber: r.whatsappNumber,
        commissionPct: r.commissionPct,
        ebookId: r.ebookId,
        niche: await this.resolveNiche(ctx, r.ebookId),
      });
    }
    return prospects;
  }

  // ---------------------------------------------------------
  // Executa o contato de um afiliado: gera copy, envia, registra, emite evento,
  // atualiza lastContactedAt. Retorna o uso de LLM do passo.
  // ---------------------------------------------------------
  private async contactOne(
    ctx: AgentContext,
    prospect: ProspectAffiliate,
    now: Date,
  ): Promise<{ inputTokens: number; outputTokens: number; costCents?: number }> {
    const { prisma, ports, log } = ctx;

    const { copy, usage } = await this.generateCopy(ctx, prospect);
    const channels: string[] = [];

    // EMAIL — canal primario (obrigatorio).
    const html = renderEmailHtml(copy.emailBody);
    await ports.email.send({
      to: prospect.email,
      subject: copy.subject,
      html,
      text: copy.emailBody,
    });
    await prisma.affiliateOutreach.create({
      data: {
        affiliateId: prospect.id,
        channel: 'EMAIL',
        templateKey: 'affiliate_outreach_intro',
        status: 'SENT',
        payload: { subject: copy.subject, niche: prospect.niche },
      },
    });
    channels.push('EMAIL');

    // WHATSAPP — opcional (so com numero E port disponivel). Best-effort.
    if (prospect.whatsappNumber && ports.whatsapp) {
      try {
        await ports.whatsapp.sendMessage(prospect.whatsappNumber, copy.whatsappBody);
        await prisma.affiliateOutreach.create({
          data: {
            affiliateId: prospect.id,
            channel: 'WHATSAPP',
            templateKey: 'affiliate_outreach_intro',
            status: 'SENT',
            payload: { niche: prospect.niche },
          },
        });
        channels.push('WHATSAPP');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await prisma.affiliateOutreach.create({
          data: {
            affiliateId: prospect.id,
            channel: 'WHATSAPP',
            templateKey: 'affiliate_outreach_intro',
            status: 'FAILED',
            payload: { error: message },
          },
        });
        log.warn(
          { affiliateId: prospect.id, err: message },
          'affiliate: falha ao enviar WhatsApp (email ja enviado)',
        );
      }
    }

    // Evento de funil interno (sem provider/externalEventId).
    await prisma.event.create({
      data: {
        type: 'AFFILIATE_CONTACTED',
        productId: null,
        payload: {
          affiliateId: prospect.id,
          channels,
          niche: prospect.niche,
          commissionPct: prospect.commissionPct,
        },
      },
    });

    // Atualiza a cadencia.
    await prisma.affiliate.update({
      where: { id: prospect.id },
      data: { lastContactedAt: now },
    });

    log.info(
      { affiliateId: prospect.id, channels },
      'affiliate: prospeccao enviada',
    );

    return usage;
  }

  // ---------------------------------------------------------
  // Gera a copy de prospeccao via LLM (JSON validado por Zod).
  // ---------------------------------------------------------
  private async generateCopy(
    ctx: AgentContext,
    prospect: ProspectAffiliate,
  ): Promise<{
    copy: AffiliateCopy;
    usage: { inputTokens: number; outputTokens: number; costCents?: number };
  }> {
    const { ports, env } = ctx;
    const niche = prospect.niche ?? 'infoprodutos digitais';

    const system =
      'Voce e um gerente de afiliados de uma editora de ebooks no Brasil. ' +
      'Escreva em portugues (pt-BR), tom profissional e caloroso, com 1 CTA claro ' +
      'para o afiliado entrar no programa. Destaque: a comissao oferecida, o nicho ' +
      'do produto e o potencial de ganho. Responda SOMENTE com JSON valido no formato ' +
      '{"subject": string, "emailBody": string, "whatsappBody": string}. ' +
      'subject ate 160 caracteres; emailBody em texto simples (pode usar quebras de ' +
      'linha); whatsappBody e uma versao curta (ate ~400 caracteres) para WhatsApp.';

    const userMsg =
      `Convide o afiliado "${prospect.name}" para promover nossos ebooks do nicho ` +
      `"${niche}". Comissao por venda: ${prospect.commissionPct}%. ` +
      'Personalize com o nome e mostre o potencial de ganho recorrente.';

    const result = await ports.llm.generateJson<AffiliateCopy>({
      model: env.CONTENT_MODEL,
      system,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 1024,
      temperature: 0.7,
      parse: (raw) => affiliateCopySchema.parse(raw),
    });

    return { copy: result.data, usage: result.usage };
  }

  // ---------------------------------------------------------
  // Resolve o nicho do ebook associado ao afiliado (se houver).
  // ---------------------------------------------------------
  private async resolveNiche(
    ctx: AgentContext,
    ebookId: string | null,
  ): Promise<string | null> {
    if (!ebookId) return null;
    const ebook = await ctx.prisma.ebook.findUnique({
      where: { id: ebookId },
      select: { niche: true },
    });
    return ebook?.niche ?? null;
  }

  private cooldownDays(ctx: AgentContext): number {
    const raw = ctx.env.AFFILIATE_OUTREACH_COOLDOWN_DAYS;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 7;
  }
}

// HTML simples (sem template engine), a partir do corpo em texto.
function renderEmailHtml(body: string): string {
  const escaped = escapeHtml(body).replace(/\n/g, '<br>');
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">',
    `<p style="margin:0;line-height:1.5">${escaped}</p>`,
    '<hr style="margin:16px 0;border:none;border-top:1px solid #eee">',
    '<p style="margin:0;color:#888;font-size:12px">Ebook Empire — Programa de Afiliados</p>',
    '</div>',
  ].join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
