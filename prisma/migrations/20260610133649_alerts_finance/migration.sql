-- CreateEnum
CREATE TYPE "AlertEvent" AS ENUM ('KILL_SWITCH_ON', 'KILL_SWITCH_OFF', 'SECTOR_CRITICAL', 'ACTION_AUTO_FAILED', 'ACTION_HIGH_QUEUED');

-- CreateEnum
CREATE TYPE "AlertChannel" AS ENUM ('EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('SENT', 'FAILED', 'SUPPRESSED');

-- CreateTable
CREATE TABLE "AlertLog" (
    "id" TEXT NOT NULL,
    "event" "AlertEvent" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "channel" "AlertChannel" NOT NULL,
    "sector" "OperationalSector",
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "providerId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "alertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "channels" "AlertChannel"[] DEFAULT ARRAY['EMAIL']::"AlertChannel"[],
    "emailRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "whatsappRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabledEvents" "AlertEvent"[] DEFAULT ARRAY[]::"AlertEvent"[],
    "throttleMinutes" INTEGER NOT NULL DEFAULT 60,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceSnapshot" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "grossRevenueCents" INTEGER NOT NULL DEFAULT 0,
    "paymentFeesCents" INTEGER NOT NULL DEFAULT 0,
    "adSpendCents" INTEGER NOT NULL DEFAULT 0,
    "llmCostCents" INTEGER NOT NULL DEFAULT 0,
    "netProfitCents" INTEGER NOT NULL DEFAULT 0,
    "marginPct" DOUBLE PRECISION,
    "paidOrders" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlertLog_dedupeKey_createdAt_idx" ON "AlertLog"("dedupeKey", "createdAt");

-- CreateIndex
CREATE INDEX "AlertLog_event_createdAt_idx" ON "AlertLog"("event", "createdAt");

-- CreateIndex
CREATE INDEX "AlertLog_status_idx" ON "AlertLog"("status");

-- CreateIndex
CREATE INDEX "FinanceSnapshot_date_idx" ON "FinanceSnapshot"("date");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceSnapshot_date_key" ON "FinanceSnapshot"("date");
