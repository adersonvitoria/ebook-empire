-- CreateEnum
CREATE TYPE "OperationalSector" AS ENUM ('CONTENT', 'SALES', 'DELIVERY', 'SOCIAL', 'TRAFFIC', 'ANALYTICS', 'ORCHESTRATION');

-- CreateEnum
CREATE TYPE "ProblemStatus" AS ENUM ('OPEN', 'DIAGNOSING', 'REMEDIATING', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "RiskTier" AS ENUM ('LOW', 'HIGH');

-- CreateEnum
CREATE TYPE "ActionKind" AS ENUM ('RETRY_DELIVERIES', 'GENERATE_EBOOK', 'GENERATE_SOCIAL_POSTS', 'REGENERATE_LANDING_COPY', 'RECOMPUTE_KPIS', 'RERUN_AGENT', 'INCREASE_AD_BUDGET', 'DECREASE_AD_BUDGET', 'PAUSE_CAMPAIGN', 'ADJUST_PRICE');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('PROPOSED', 'QUEUED', 'APPROVED', 'REJECTED', 'APPLIED', 'FAILED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ExecutionTrigger" AS ENUM ('AUTO', 'HUMAN');

-- NOTE: ALTER TYPE "AgentName" ADD VALUE 'OPERATIONS' vive em migration separada
-- (20260610122720_crm_agentname_operations_enum) para nao misturar ADD VALUE de
-- enum com criacao de tabelas na mesma transacao (decisao do doc, secao 8.4).

-- CreateTable
CREATE TABLE "SectorHealthSnapshot" (
    "id" TEXT NOT NULL,
    "sector" "OperationalSector" NOT NULL,
    "score" INTEGER NOT NULL,
    "kpis" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cycleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SectorHealthSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Problem" (
    "id" TEXT NOT NULL,
    "sector" "OperationalSector" NOT NULL,
    "type" TEXT NOT NULL,
    "severity" INTEGER NOT NULL,
    "status" "ProblemStatus" NOT NULL DEFAULT 'OPEN',
    "rootCause" TEXT,
    "snapshotId" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Problem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemediationAction" (
    "id" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "kind" "ActionKind" NOT NULL,
    "riskTier" "RiskTier" NOT NULL,
    "params" JSONB NOT NULL,
    "expectedEffect" TEXT NOT NULL,
    "status" "ActionStatus" NOT NULL DEFAULT 'PROPOSED',
    "reversible" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemediationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionExecution" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "beforeState" JSONB,
    "afterState" JSONB,
    "error" TEXT,
    "triggeredBy" "ExecutionTrigger" NOT NULL,
    "isRollback" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardrailConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "maxAutoActionsPerCycle" INTEGER NOT NULL DEFAULT 5,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 30,
    "maxAdBudgetCents" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardrailConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SectorHealthSnapshot_sector_capturedAt_idx" ON "SectorHealthSnapshot"("sector", "capturedAt");

-- CreateIndex
CREATE INDEX "SectorHealthSnapshot_cycleId_idx" ON "SectorHealthSnapshot"("cycleId");

-- CreateIndex
CREATE INDEX "Problem_sector_status_idx" ON "Problem"("sector", "status");

-- CreateIndex
CREATE INDEX "Problem_status_detectedAt_idx" ON "Problem"("status", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RemediationAction_dedupeKey_key" ON "RemediationAction"("dedupeKey");

-- CreateIndex
CREATE INDEX "RemediationAction_status_riskTier_idx" ON "RemediationAction"("status", "riskTier");

-- CreateIndex
CREATE INDEX "RemediationAction_problemId_idx" ON "RemediationAction"("problemId");

-- CreateIndex
CREATE INDEX "ActionExecution_actionId_startedAt_idx" ON "ActionExecution"("actionId", "startedAt");

-- CreateIndex
CREATE INDEX "ActionExecution_triggeredBy_idx" ON "ActionExecution"("triggeredBy");

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "SectorHealthSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemediationAction" ADD CONSTRAINT "RemediationAction_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionExecution" ADD CONSTRAINT "ActionExecution_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "RemediationAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
