'use client';

// Checkout PIX embutido na landing (#checkout). SEM login. Maquina de 3 estados
// ('form' | 'submitting' | 'pix') + erro inline. Reusa a rota publica POST
// /checkout (createCheckout em lib/storefront.ts) — NAO cria Order por conta
// propria. Anti-duplo-submit obrigatorio (2 cliques = 2 cobrancas).
//
// QR Code: pixQrCode e o PAYLOAD EMV (copia-e-cola), NAO data-URL de imagem.
// Geramos a imagem do QR a partir desse payload via servico de imagem (sem
// adicionar dependencia ao bundle); o codigo copia-e-cola e sempre a via
// primaria e tem botao de copiar. Nunca usamos <img src={pixQrCode}> cru.

import { useId, useState } from 'react';
import { ApiError, formatBRL } from '@/lib/api';
import {
  createCheckout,
  getUtmFromLocation,
  getVisitorId,
  type CheckoutResult,
} from '@/lib/storefront';

const ACCENT = '#c2410c';

type Stage = 'form' | 'submitting' | 'pix';

// ------------------------------------------------------------
// Validacao de CPF (digitos verificadores) — 100% client-side.
// ------------------------------------------------------------
function onlyDigits(s: string): string {
  return s.replace(/\D/g, '');
}

function maskCpf(value: string): string {
  const d = onlyDigits(value).slice(0, 11);
  const parts = [
    d.slice(0, 3),
    d.slice(3, 6),
    d.slice(6, 9),
    d.slice(9, 11),
  ].filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  let out = parts[0];
  if (parts[1]) out += `.${parts[1]}`;
  if (parts[2]) out += `.${parts[2]}`;
  if (parts[3]) out += `-${parts[3]}`;
  return out;
}

function isValidCpf(raw: string): boolean {
  const cpf = onlyDigits(raw);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // todos iguais
  const calc = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += Number(cpf[i]) * (len + 1 - i);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ------------------------------------------------------------
// QR a partir do payload EMV (sem dependencia no bundle).
// ------------------------------------------------------------
function qrImageUrl(emvPayload: string): string {
  const data = encodeURIComponent(emvPayload);
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=0&data=${data}`;
}

export function CheckoutForm({
  productSlug,
  priceCents,
}: {
  productSlug: string;
  priceCents: number;
}) {
  const formId = useId();
  const [stage, setStage] = useState<Stage>('form');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [cpf, setCpf] = useState('');
  const [touched, setTouched] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pix, setPix] = useState<CheckoutResult | null>(null);
  const [copied, setCopied] = useState(false);

  const nameOk = name.trim().length >= 1;
  const emailOk = isValidEmail(email);
  const cpfOk = isValidCpf(cpf);
  const formOk = nameOk && emailOk && cpfOk;
  const submitting = stage === 'submitting';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!formOk || submitting) return; // anti-duplo-submit + validacao
    setErrorMsg(null);
    setStage('submitting');
    try {
      const result = await createCheckout({
        productSlug,
        customer: {
          name: name.trim(),
          email: email.trim(),
          cpfCnpj: onlyDigits(cpf), // so digitos; so quando preenchido (sempre aqui)
        },
        visitorId: getVisitorId(),
        utm: getUtmFromLocation(),
      });
      setPix(result);
      setStage('pix');
    } catch (err) {
      setStage('form'); // mantem os dados do form para retry
      setErrorMsg(messageForError(err));
    }
  }

  async function handleCopy() {
    if (!pix) return;
    try {
      await navigator.clipboard.writeText(pix.pixCopyPaste);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard indisponivel — o usuario pode selecionar manualmente o texto
      setCopied(false);
    }
  }

  // ----------------------------------------------------------
  // Estado PIX: QR + copia-e-cola + instrucoes pos-pagamento.
  // ----------------------------------------------------------
  if (stage === 'pix' && pix) {
    return (
      <div className="rounded-3xl border border-[#e6dac6] bg-white p-6 shadow-[0_20px_50px_-25px_rgba(60,40,20,0.4)] sm:p-8">
        <div className="text-center">
          <span
            className="inline-block rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider text-white"
            style={{ backgroundColor: ACCENT }}
          >
            PIX gerado
          </span>
          <h3 className="mt-4 font-[family-name:var(--font-display)] text-2xl font-bold text-[#241c12]">
            Pague {formatBRL(pix.amountCents)} via PIX
          </h3>
        </div>

        <div className="mt-6 flex justify-center">
          <div className="rounded-2xl border border-[#ece1cd] bg-[#fbf8f2] p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrImageUrl(pix.pixQrCode)}
              alt="QR Code do PIX para pagamento"
              width={240}
              height={240}
              className="h-60 w-60"
            />
          </div>
        </div>

        <div className="mt-6">
          <label className="text-xs font-semibold uppercase tracking-wider text-[#8a7a63]">
            Codigo copia-e-cola
          </label>
          <div className="mt-2 flex gap-2">
            <input
              readOnly
              value={pix.pixCopyPaste}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 truncate rounded-xl border border-[#e6dac6] bg-[#fbf8f2] px-3 py-3 font-mono text-xs text-[#4f4434]"
            />
            <button
              type="button"
              onClick={handleCopy}
              className="shrink-0 rounded-xl px-4 py-3 text-sm font-bold text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: ACCENT }}
            >
              {copied ? 'Copiado!' : 'Copiar'}
            </button>
          </div>
        </div>

        <ol className="mt-6 space-y-3 text-[15px] text-[#4f4434]">
          <li className="flex gap-3">
            <StepNum n={1} /> Abra o app do seu banco e escolha pagar via PIX.
          </li>
          <li className="flex gap-3">
            <StepNum n={2} /> Leia o QR Code ou cole o codigo copia-e-cola.
          </li>
          <li className="flex gap-3">
            <StepNum n={3} /> Em instantes voce recebe o ebook no email{' '}
            <span className="font-semibold text-[#2c2417]">{email.trim()}</span>.
          </li>
        </ol>

        <p className="mt-5 rounded-xl bg-[#fbf3e9] px-4 py-3 text-sm text-[#7a5a32]">
          Confira a caixa de <strong>spam/promocoes</strong> se nao encontrar o
          email. A entrega acontece logo apos a confirmacao do pagamento.
        </p>

        {pix.dueDate ? (
          <p className="mt-4 text-center text-xs text-[#a8987c]">
            Este PIX expira em {formatDue(pix.dueDate)}.
          </p>
        ) : null}
      </div>
    );
  }

  // ----------------------------------------------------------
  // Estado form / submitting.
  // ----------------------------------------------------------
  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="rounded-3xl border border-[#e6dac6] bg-white p-6 shadow-[0_20px_50px_-25px_rgba(60,40,20,0.4)] sm:p-8"
    >
      <h3 className="font-[family-name:var(--font-display)] text-2xl font-bold text-[#241c12]">
        Garanta o seu agora
      </h3>
      <p className="mt-1 text-sm text-[#7a6c56]">
        Preencha os dados e gere o PIX. Entrega imediata por email.
      </p>

      <div className="mt-6 space-y-4">
        <Field
          id={`${formId}-name`}
          label="Nome completo"
          invalid={touched && !nameOk}
          error="Informe seu nome."
        >
          <input
            id={`${formId}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            placeholder="Como devemos te chamar"
            className="w-full rounded-xl border border-[#e0d4bf] bg-[#fbf8f2] px-4 py-3 text-[15px] text-[#2c2417] outline-none transition-colors focus:border-[#c2410c]"
          />
        </Field>

        <Field
          id={`${formId}-email`}
          label="Email (onde voce recebe o ebook)"
          invalid={touched && !emailOk}
          error="Informe um email valido."
        >
          <input
            id={`${formId}-email`}
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="voce@email.com"
            className="w-full rounded-xl border border-[#e0d4bf] bg-[#fbf8f2] px-4 py-3 text-[15px] text-[#2c2417] outline-none transition-colors focus:border-[#c2410c]"
          />
        </Field>

        <Field
          id={`${formId}-cpf`}
          label="CPF"
          invalid={touched && !cpfOk}
          error="Informe um CPF valido."
        >
          <input
            id={`${formId}-cpf`}
            inputMode="numeric"
            value={cpf}
            onChange={(e) => setCpf(maskCpf(e.target.value))}
            autoComplete="off"
            placeholder="000.000.000-00"
            className="w-full rounded-xl border border-[#e0d4bf] bg-[#fbf8f2] px-4 py-3 text-[15px] text-[#2c2417] outline-none transition-colors focus:border-[#c2410c]"
          />
        </Field>
      </div>

      {errorMsg ? (
        <p className="mt-4 rounded-xl bg-[#fdecec] px-4 py-3 text-sm text-[#a32626]">
          {errorMsg}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting}
        className="mt-6 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full text-base font-bold text-white shadow-[0_12px_28px_-10px_rgba(194,65,12,0.7)] transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-70"
        style={{ backgroundColor: ACCENT }}
      >
        {submitting ? (
          <>
            <Spinner /> Gerando PIX…
          </>
        ) : (
          <>Comprar agora · {formatBRL(priceCents)}</>
        )}
      </button>

      <p className="mt-4 text-center text-xs text-[#a8987c]">
        Pagamento unico via PIX. Seus dados sao usados apenas para emitir a
        cobranca e enviar o ebook.
      </p>
    </form>
  );
}

// ------------------------------------------------------------
// Mensagens de erro por ApiError.status (pt-BR).
// ------------------------------------------------------------
function messageForError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 404:
        return 'Este produto nao esta mais disponivel.';
      case 502:
        return 'Nao foi possivel gerar o PIX agora. Tente novamente em instantes.';
      case 400:
        return 'Revise os campos e tente novamente.';
      case 0:
        return 'Falha de conexao. Verifique sua internet e tente de novo.';
      default:
        return 'Algo deu errado ao gerar o PIX. Tente novamente.';
    }
  }
  return 'Algo deu errado ao gerar o PIX. Tente novamente.';
}

function formatDue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ------------------------------------------------------------
// Subcomponentes de UI.
// ------------------------------------------------------------
function Field({
  id,
  label,
  invalid,
  error,
  children,
}: {
  id: string;
  label: string;
  invalid: boolean;
  error: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block text-sm font-medium text-[#5b4f3e]"
      >
        {label}
      </label>
      {children}
      {invalid ? <p className="mt-1 text-xs text-[#a32626]">{error}</p> : null}
    </div>
  );
}

function StepNum({ n }: { n: number }) {
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
      style={{ backgroundColor: ACCENT }}
    >
      {n}
    </span>
  );
}

function Spinner() {
  return (
    <span
      className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
      aria-hidden="true"
    />
  );
}
