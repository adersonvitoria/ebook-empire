-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SPECIALIST', 'STRATEGIST', 'EXECUTOR');

-- CreateEnum
CREATE TYPE "MarketOpportunityStatus" AS ENUM ('PENDING', 'SELECTED', 'USED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "EbookAuditVerdict" AS ENUM ('PASS', 'NEEDS_FIX', 'FAIL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentName" ADD VALUE 'MARKET_RESEARCH';
ALTER TYPE "AgentName" ADD VALUE 'EBOOK_QA';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'MARKET_OPPORTUNITY_RANKED';
ALTER TYPE "EventType" ADD VALUE 'EBOOK_AUDITED';
ALTER TYPE "EventType" ADD VALUE 'EBOOK_RELAUNCHED';

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "role" "Role",
ADD COLUMN     "sector" TEXT;

-- AlterTable
ALTER TABLE "Ebook" ADD COLUMN     "marketOpportunityId" TEXT;

-- CreateTable
CREATE TABLE "MarketOpportunity" (
    "id" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "demandScore" INTEGER NOT NULL,
    "competitionScore" INTEGER NOT NULL,
    "potentialScore" INTEGER NOT NULL,
    "rationale" TEXT NOT NULL,
    "titleIdeas" JSONB NOT NULL,
    "angles" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "MarketOpportunityStatus" NOT NULL DEFAULT 'PENDING',
    "generatedByRunId" TEXT,
    "selectedAt" TIMESTAMP(3),
    "usedByEbookId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rankedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbookAudit" (
    "id" TEXT NOT NULL,
    "ebookId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "verdict" "EbookAuditVerdict" NOT NULL,
    "issues" JSONB NOT NULL,
    "recommendations" JSONB NOT NULL,
    "dimensionScores" JSONB NOT NULL,
    "marketOpportunityId" TEXT,
    "iteration" INTEGER NOT NULL DEFAULT 0,
    "agentRunId" TEXT,
    "model" TEXT,
    "auditedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EbookAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketOpportunity_status_idx" ON "MarketOpportunity"("status");

-- CreateIndex
CREATE INDEX "MarketOpportunity_potentialScore_idx" ON "MarketOpportunity"("potentialScore");

-- CreateIndex
CREATE INDEX "MarketOpportunity_niche_idx" ON "MarketOpportunity"("niche");

-- CreateIndex
CREATE INDEX "EbookAudit_ebookId_createdAt_idx" ON "EbookAudit"("ebookId", "createdAt");

-- CreateIndex
CREATE INDEX "EbookAudit_verdict_idx" ON "EbookAudit"("verdict");

-- CreateIndex
CREATE INDEX "AgentRun_sector_role_idx" ON "AgentRun"("sector", "role");

-- CreateIndex
CREATE INDEX "Ebook_marketOpportunityId_idx" ON "Ebook"("marketOpportunityId");

-- AddForeignKey
ALTER TABLE "Ebook" ADD CONSTRAINT "Ebook_marketOpportunityId_fkey" FOREIGN KEY ("marketOpportunityId") REFERENCES "MarketOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketOpportunity" ADD CONSTRAINT "MarketOpportunity_generatedByRunId_fkey" FOREIGN KEY ("generatedByRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbookAudit" ADD CONSTRAINT "EbookAudit_ebookId_fkey" FOREIGN KEY ("ebookId") REFERENCES "Ebook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbookAudit" ADD CONSTRAINT "EbookAudit_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
