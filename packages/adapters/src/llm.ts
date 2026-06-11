// Adapter do LLMPort. Implementacao real sobre @anthropic-ai/sdk
// (model 'claude-sonnet-4-6' para geracao de conteudo) + stub deterministico
// para testes. A factory escolhe real<->stub via env USE_STUBS.
//
// Convencao de unidade: custo SEMPRE em Int centavos BRL.

import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMPort,
  LLMGenerateTextInput,
  LLMGenerateTextResult,
  LLMGenerateJsonInput,
  LLMGenerateJsonResult,
  LLMUsage,
} from '@ebook-empire/core';

// ------------------------------------------------------------
// Precos aproximados (USD por 1M tokens) -> convertidos para centavos BRL.
// Usados apenas para estimativa de custo (AgentRun.costCents). Nao e cobranca.
// ------------------------------------------------------------
const USD_TO_BRL = 5.5; // cambio aproximado; ajustavel por env futuramente.

interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

// Tabela conservadora; modelos desconhecidos caem no default.
const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-4-6': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  'claude-opus-4-8': { inputPerMTokUsd: 15, outputPerMTokUsd: 75 },
};

const DEFAULT_PRICE: ModelPrice = { inputPerMTokUsd: 3, outputPerMTokUsd: 15 };

/** Estima custo em centavos BRL a partir do uso de tokens. */
export function estimateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = MODEL_PRICES[model] ?? DEFAULT_PRICE;
  const usd =
    (inputTokens / 1_000_000) * price.inputPerMTokUsd +
    (outputTokens / 1_000_000) * price.outputPerMTokUsd;
  return Math.round(usd * USD_TO_BRL * 100);
}

/** Extrai o primeiro bloco JSON de um texto (tolerante a cercas markdown). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Remove cercas ```json ... ``` se existirem.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  // Tenta parse direto; se falhar, recorta do primeiro { ate o ultimo }.
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('Resposta do LLM nao contem JSON valido.');
  }
}

// ============================================================
// Adapter REAL (Anthropic)
// ============================================================
export class AnthropicLLMAdapter implements LLMPort {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY ausente — use o StubLLMAdapter ou configure a chave.',
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  async generateText(input: LLMGenerateTextInput): Promise<LLMGenerateTextResult> {
    const response = await this.client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      system: input.system,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    // Concatena apenas os blocos de texto.
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const usage = this.toUsage(input.model, response.usage);
    return { text, usage };
  }

  async generateJson<T>(
    input: LLMGenerateJsonInput<T>,
  ): Promise<LLMGenerateJsonResult<T>> {
    // Reforca a instrucao de JSON puro no system.
    const system = [
      input.system,
      'Responda EXCLUSIVAMENTE com um objeto JSON valido, sem texto extra, sem cercas markdown.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const { text, usage } = await this.generateText({ ...input, system });
    const raw = extractJson(text);
    const data = input.parse(raw);
    return { data, usage };
  }

  private toUsage(
    model: string,
    usage: { input_tokens: number; output_tokens: number },
  ): LLMUsage {
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      costCents: estimateCostCents(model, inputTokens, outputTokens),
    };
  }
}

// ============================================================
// Adapter REAL (Google Gemini) — camada gratuita (gemini-2.0-flash)
// ============================================================
// REST direto (sem SDK): POST {base}/models/{model}:generateContent?key=KEY.
// Roles do Gemini: 'user' | 'model' (mapeia 'assistant' -> 'model'). JSON via
// generationConfig.responseMimeType. O id de modelo vindo dos agentes (claude-*)
// e IGNORADO — o adapter usa sempre o seu modelo Gemini configurado.
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class GeminiLLMAdapter implements LLMPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, model?: string, fetchImpl?: typeof fetch) {
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY ausente — use o StubLLMAdapter ou configure a chave.');
    }
    this.apiKey = apiKey;
    this.model = model && model.trim() ? model.trim() : DEFAULT_GEMINI_MODEL;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private async call(
    input: LLMGenerateTextInput,
    jsonMode: boolean,
  ): Promise<LLMGenerateTextResult> {
    const contents = input.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: input.temperature ?? 0.7,
        maxOutputTokens: input.maxTokens,
        ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    };
    if (input.system) {
      body.systemInstruction = { parts: [{ text: input.system }] };
    }

    const url = `${GEMINI_BASE_URL}/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 500)}`);
    }
    const data = (await res.json()) as GeminiResponse;
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');

    const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    // Camada gratuita do Gemini => custo 0.
    const usage: LLMUsage = { inputTokens, outputTokens, costCents: 0 };
    return { text, usage };
  }

  async generateText(input: LLMGenerateTextInput): Promise<LLMGenerateTextResult> {
    return this.call(input, false);
  }

  async generateJson<T>(
    input: LLMGenerateJsonInput<T>,
  ): Promise<LLMGenerateJsonResult<T>> {
    const system = [
      input.system,
      'Responda EXCLUSIVAMENTE com um objeto JSON valido, sem texto extra, sem cercas markdown.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const { text, usage } = await this.call({ ...input, system }, true);
    const raw = extractJson(text);
    const data = input.parse(raw);
    return { data, usage };
  }
}

// ============================================================
// Adapter STUB (deterministico — testes e modo offline)
// ============================================================
// Gera texto/JSON previsiveis sem chamada de rede. O JSON e derivado do
// prompt para que o ContentAgent produza um outline valido contra
// ebookOutlineSchema sem depender da Anthropic.
export class StubLLMAdapter implements LLMPort {
  /** Numero ~deterministico de tokens estimado a partir do tamanho do texto. */
  private estTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private usageFor(model: string, inText: string, outText: string): LLMUsage {
    const inputTokens = this.estTokens(inText);
    const outputTokens = this.estTokens(outText);
    return {
      inputTokens,
      outputTokens,
      costCents: estimateCostCents(model, inputTokens, outputTokens),
    };
  }

  async generateText(input: LLMGenerateTextInput): Promise<LLMGenerateTextResult> {
    const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUser?.content ?? '';
    // Texto deterministico que ecoa o pedido (util para capitulos/descricoes).
    const text = `# Conteudo gerado (stub)\n\n${prompt.slice(0, 400)}\n\nEste e um paragrafo de exemplo deterministico produzido pelo StubLLMAdapter para fins de teste.`;
    const inText = (input.system ?? '') + prompt;
    return { text, usage: this.usageFor(input.model, inText, text) };
  }

  async generateJson<T>(
    input: LLMGenerateJsonInput<T>,
  ): Promise<LLMGenerateJsonResult<T>> {
    const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUser?.content ?? '';

    // Heuristica: deriva um "niche" do prompt para tornar o stub previsivel.
    const niche = this.extractNiche(prompt);

    // Estrutura compativel com ebookOutlineSchema (>=3 capitulos).
    const stubObject = {
      title: `Guia Definitivo de ${niche}`,
      niche,
      subtitle: `Como dominar ${niche} do zero ao avancado`,
      targetAudience: `Iniciantes e intermediarios interessados em ${niche}`,
      chapters: [
        {
          title: `Fundamentos de ${niche}`,
          summary: `Conceitos essenciais e a base teorica de ${niche}.`,
        },
        {
          title: `Aplicando ${niche} na pratica`,
          summary: `Passo a passo pratico com exemplos reais de ${niche}.`,
        },
        {
          title: `Estrategias avancadas de ${niche}`,
          summary: `Tecnicas avancadas e erros comuns a evitar em ${niche}.`,
        },
      ],
    };

    // O stub e deterministico mas precisa servir multiplos formatos de saida
    // (outline de ebook, post social, plano do orchestrator). Tentamos cada
    // candidato contra o parser fornecido e usamos o PRIMEIRO que validar.
    // Cada schema tem um campo obrigatorio unico (chapters / caption / mode),
    // ausente nos demais, entao nao ha colisao de formato.
    const candidates: unknown[] = [
      stubObject,
      // socialPostContentSchema: { caption, hashtags, creativePrompt }
      {
        caption:
          `Descubra como dominar ${niche} de uma vez por todas! ` +
          `Nosso guia definitivo leva voce do zero ao avancado. ` +
          `Garanta o seu agora via PIX — link na bio. 🚀`,
        hashtags: [
          niche.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'ebook',
          'ebook',
          'infoproduto',
          'empreendedorismo',
        ],
        creativePrompt: `Capa moderna e chamativa sobre ${niche}, tipografia forte e cores vibrantes.`,
      },
      // agentPlanSchema: { mode, rationale, actions } (plano valido e conservador)
      {
        mode: 'GROW',
        rationale: `Plano stub deterministico para ${niche}: priorizar catalogo e divulgacao.`,
        actions: [],
      },
    ];

    const inText = (input.system ?? '') + prompt;
    let data: T | undefined;
    let outText = '';
    let lastErr: unknown;
    for (const candidate of candidates) {
      try {
        data = input.parse(candidate);
        outText = JSON.stringify(candidate);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    // Nenhum formato conhecido casou — propaga o erro do parser (comportamento original).
    if (data === undefined) throw lastErr;
    return { data, usage: this.usageFor(input.model, inText, outText) };
  }

  private extractNiche(prompt: string): string {
    // Procura por "nicho: X" ou "niche: X" no prompt; senao usa um default.
    const match = prompt.match(/nich[eo]\s*[:\-]\s*([^\n.,;]{2,60})/i);
    const raw = match?.[1]?.trim();
    return raw && raw.length > 0 ? raw : 'Produtividade';
  }
}

// ============================================================
// Factory — escolhe real<->stub por env.
// ============================================================
export interface LLMAdapterEnv {
  USE_STUBS: boolean;
  /** Provedor real: 'gemini' (gratis) ou 'anthropic'. Default 'anthropic'. */
  LLM_PROVIDER?: 'anthropic' | 'gemini';
  ANTHROPIC_API_KEY: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

/**
 * Cria o LLMPort apropriado (degrada com seguranca — nunca derruba o boot):
 * - USE_STUBS=true -> StubLLMAdapter.
 * - LLM_PROVIDER='gemini' + GEMINI_API_KEY -> GeminiLLMAdapter (camada gratuita).
 * - senao, com ANTHROPIC_API_KEY -> AnthropicLLMAdapter.
 * - sem chave nenhuma -> StubLLMAdapter.
 */
export function createLLMAdapter(env: LLMAdapterEnv): LLMPort {
  if (env.USE_STUBS) return new StubLLMAdapter();
  const provider = env.LLM_PROVIDER ?? 'anthropic';
  if (provider === 'gemini' && env.GEMINI_API_KEY) {
    return new GeminiLLMAdapter(env.GEMINI_API_KEY, env.GEMINI_MODEL);
  }
  if (env.ANTHROPIC_API_KEY) {
    return new AnthropicLLMAdapter(env.ANTHROPIC_API_KEY);
  }
  return new StubLLMAdapter();
}
