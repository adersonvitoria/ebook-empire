'use client';

// Botao "Tentar novamente" do estado de erro da landing. Client minimo: recarrega
// a rota (re-executa o fetch server-side de /storefront/featured ou /products/:slug).

const ACCENT = '#c2410c';

export function RetryButton() {
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="inline-flex items-center justify-center rounded-full px-6 py-3 text-sm font-bold text-white transition-transform hover:-translate-y-0.5"
      style={{ backgroundColor: ACCENT }}
    >
      Tentar novamente
    </button>
  );
}
