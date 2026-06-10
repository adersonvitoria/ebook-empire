// Barrel de @ebook-empire/adapters.
// Re-exporta as implementacoes (real + stub) de cada port.
// IMPORTANTE: os arquivos abaixo sao criados pelos AGENTES DE IMPLEMENTACAO.
// Cada um deve exportar a fabrica/factory que escolhe real<->stub por env
// (ex. USE_STUBS / PAYMENT_PROVIDER / META_MODE / EMAIL_PROVIDER).
export * from './llm.js';
export * from './payment.js';
export * from './email.js';
export * from './storage.js';
export * from './instagram.js';
export * from './ads.js';

// NotificationPort (alertas externos — EMAIL + WHATSAPP, Feature 1).
// A Fundacao reexporta o barrel; o dono do adapter preenche notification.ts
// com createNotificationAdapter + canais EMAIL/WHATSAPP (real + stub).
export * from './notification.js';

// WhatsAppPort (envio direto 1:1 — outreach de afiliados / upsell).
// EvolutionWhatsAppAdapter (real) + StubWhatsAppAdapter (.outbox) + factory.
// O canal de ALERTAS (notification.ts) reusa o adapter daqui internamente.
export * from './whatsapp.js';

// MarketDataPort (setor MARKET_RESEARCH — Serper.dev real + stub deterministico).
// A Fundacao reexporta o barrel; o dono do modulo Mercado preenche market-data.ts
// com createMarketDataAdapter + SerperMarketDataAdapter/StubMarketDataAdapter.
export * from './market-data.js';

// MarketplacePort (setor MARKETPLACE — Hotmart + Kiwify real + stub).
// Fase 3: createMarketplaceAdapter + Hotmart/Kiwify/StubMarketplaceAdapter.
export * from './marketplace.js';
