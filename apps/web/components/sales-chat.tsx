'use client';

// Widget de chat de vendas 24/7 (flutuante) na landing. Mantem o historico
// LOCAL (useState; nao persiste) e a cada envio faz POST /storefront/chat
// ({ productSlug, messages }). Toda defesa de custo e SERVER-SIDE; o cliente
// so cuida da UX:
//   - 200 { reply, source } -> mostra a resposta (canned ou llm transparente p/ UX).
//   - 429 rate_limited (retryAfterSec) -> mensagem amigavel de aguarde, sem custo.
//   - qualquer outra falha (rede/4xx/5xx) -> mensagem amigavel; NUNCA quebra a pagina.

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import {
  sendSalesChat,
  type StorefrontChatMessage,
} from '@/lib/storefront';

const ACCENT = '#c2410c';

interface UiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function SalesChat({
  productSlug,
  productName,
}: {
  productSlug: string;
  productName: string;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>([
    {
      role: 'assistant',
      content: `Oi! Posso te ajudar com qualquer duvida sobre o ${productName}. O que voce quer saber?`,
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll para a ultima mensagem.
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, open, sending]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: UiMessage = { role: 'user', content: text.slice(0, 2000) };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setSending(true);

    // Envia apenas as ultimas ~8 mensagens validas (o servidor tambem capa);
    // o body exige a ultima como role:'user'.
    const payload: StorefrontChatMessage[] = next
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const result = await sendSalesChat({ productSlug, messages: payload });
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: result.reply },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: friendlyError(err) },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {/* Botao flutuante */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Fechar chat' : 'Abrir chat de vendas'}
        className="fixed bottom-5 right-5 z-[60] flex h-14 w-14 items-center justify-center rounded-full text-white shadow-[0_12px_30px_-8px_rgba(194,65,12,0.7)] transition-transform duration-200 hover:scale-105"
        style={{ backgroundColor: ACCENT }}
      >
        {open ? <CloseIcon /> : <ChatIcon />}
      </button>

      {/* Janela do chat */}
      {open ? (
        <div className="fixed bottom-24 right-5 z-[60] flex h-[30rem] w-[calc(100vw-2.5rem)] max-w-sm flex-col overflow-hidden rounded-2xl border border-[#e6dac6] bg-white shadow-[0_30px_60px_-20px_rgba(60,40,20,0.5)]">
          {/* header */}
          <div
            className="flex items-center gap-3 px-4 py-3 text-white"
            style={{ backgroundColor: ACCENT }}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20">
              <ChatIcon small />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-bold">Atendimento</p>
              <p className="text-xs text-white/80">Tire suas duvidas · 24/7</p>
            </div>
          </div>

          {/* mensagens */}
          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto bg-[#fbf8f2] px-4 py-4"
          >
            {messages.map((m, i) => (
              <Bubble key={i} role={m.role} content={m.content} />
            ))}
            {sending ? (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-sm bg-white px-4 py-3 shadow-sm">
                  <Typing />
                </div>
              </div>
            ) : null}
          </div>

          {/* input */}
          <form
            onSubmit={handleSend}
            className="flex items-center gap-2 border-t border-[#eadfca] bg-white p-3"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={2000}
              placeholder="Escreva sua mensagem…"
              className="min-w-0 flex-1 rounded-full border border-[#e0d4bf] bg-[#fbf8f2] px-4 py-2.5 text-sm text-[#2c2417] outline-none focus:border-[#c2410c]"
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              aria-label="Enviar"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-40"
              style={{ backgroundColor: ACCENT }}
            >
              <SendIcon />
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------
// Erros tratados como mensagem do assistente (nunca quebra a pagina).
// ------------------------------------------------------------
function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      const retry = (err as ApiError & { retryAfterSec?: number }).retryAfterSec;
      const mins =
        typeof retry === 'number' && retry > 0
          ? Math.max(1, Math.ceil(retry / 60))
          : null;
      return mins
        ? `Voce enviou muitas mensagens em pouco tempo. Aguarde cerca de ${mins} min e tente de novo — enquanto isso, e so preencher nome, email e CPF aqui ao lado para gerar o PIX.`
        : 'Voce enviou muitas mensagens em pouco tempo. Aguarde alguns minutos e tente de novo.';
    }
    if (err.status === 404) {
      return 'Nao consegui localizar este produto agora. Atualize a pagina e tente novamente.';
    }
  }
  return 'Tive um problema para responder agora. Tente de novo em instantes — ou ja garanta o seu preenchendo o formulario ao lado.';
}

// ------------------------------------------------------------
// Subcomponentes visuais.
// ------------------------------------------------------------
function Bubble({ role, content }: { role: 'user' | 'assistant'; content: string }) {
  const isUser = role === 'user';
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          isUser
            ? 'max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm text-white'
            : 'max-w-[85%] rounded-2xl rounded-bl-sm bg-white px-4 py-2.5 text-sm text-[#3a3122] shadow-sm'
        }
        style={isUser ? { backgroundColor: ACCENT } : undefined}
      >
        {content}
      </div>
    </div>
  );
}

function Typing() {
  return (
    <span className="flex gap-1" aria-label="digitando">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#c2410c]"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

function ChatIcon({ small }: { small?: boolean }) {
  const s = small ? 18 : 24;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5.5A2.5 2.5 0 016.5 3h11A2.5 2.5 0 0120 5.5v8a2.5 2.5 0 01-2.5 2.5H9l-4 4v-4H6.5A2.5 2.5 0 014 13.5v-8z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 12l16-8-5 16-3-6-8-2z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
