// Barrel de @ebook-empire/agents.
// base.ts e a Fundacao (este arquivo). Os agentes concretos abaixo sao
// criados pelos AGENTES DE IMPLEMENTACAO e estendem a classe Agent de base.ts.
export * from './base.js';
export * from './orchestrator.js';
export * from './content.js';
export * from './sales.js';
export * from './delivery.js';
export * from './social.js';
export * from './traffic.js';
export * from './analytics.js';

// CRM / Command Center (COO). Hoje exporta apenas os contratos (Fundacao);
// os implementadores adicionam health-collector/diagnosis/action-catalog/
// executor/operations-agent ao barrel ./crm/index.js.
export * from './crm/index.js';

// Alertas externos (Feature 1) e Financeiro consolidado (Feature 2).
// A Fundacao referencia os barrels; os implementadores preenchem
// alerts/alert-service.ts e finance/finance-service.ts.
export * from './alerts/index.js';
export * from './finance/index.js';

// Times por setor (framework Specialist/Strategist/Executor) + os 2 setores novos
// (MARKET_RESEARCH / EBOOK_QA) + pipeline de lancamento. A Fundacao referencia os
// barrels; os implementadores preenchem team/*, sectors/* e launch/*.
export * from './team/index.js';
export * from './sectors/market-research/index.js';
export * from './sectors/ebook-qa/index.js';
export * from './launch/index.js';

// Agentes de tick proprio (escala / producao). MarketplaceAgent (P3) publica
// produtos em Hotmart/Kiwify e roda no loop FAST; AffiliateOutreachAgent (P4)
// dispara outreach a afiliados e roda no loop SLOW. A Fundacao/WIRING referencia
// os barrels; a P3/P4 preenchem ./marketplace.ts e ./affiliate-outreach.ts.
export * from './marketplace.js';
export * from './affiliate-outreach.js';
