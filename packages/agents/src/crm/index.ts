// Barrel do modulo CRM / Command Center (@ebook-empire/agents -> ./crm).
//
// contracts.ts (Fundacao) ja existe e e a base de DI. Os demais arquivos sao
// criados pelos AGENTES DE IMPLEMENTACAO (cada um dono do seu arquivo). Os
// re-exports abaixo ficam COMENTADOS ate o respectivo arquivo existir — assim a
// Fundacao compila sozinha. Cada implementador DESCOMENTA a sua linha ao criar
// o arquivo (mesma filosofia do stub de rotas em server.ts/routes/crm.ts).

export * from './contracts.js';

// --- Implementadores: descomente ao criar o respectivo arquivo ---
export * from './health-collector.js';      // DbHealthCollector + scoreSetorX/weightedScore puros
export * from './diagnosis.js';              // RuleDiagnosisEngine + runRules/SECTOR_RULES
export * from './action-catalog.js';      // ACTION_SPECS + StaticActionCatalog
export * from './executor.js';            // GuardedActionExecutor (kill switch/cooldown/teto/auditoria/rollback)
export * from './levers-live.js';         // LiveRemediationLevers + createLiveLevers (composicao concreta)
export * from './operations-agent.js';       // OperationsAgent (COO) — DI das 4 interfaces
