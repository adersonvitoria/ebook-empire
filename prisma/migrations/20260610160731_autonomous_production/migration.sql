-- CreateEnum
CREATE TYPE "AffiliateStatus" AS ENUM ('PROSPECT', 'ACTIVE', 'PAUSED', 'UNSUBSCRIBED');

-- CreateEnum
CREATE TYPE "OutreachChannel" AS ENUM ('EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('SENT', 'DELIVERED', 'REPLIED', 'BOUNCED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActionKind" ADD VALUE 'GENERATE_MORE_EBOOKS';
ALTER TYPE "ActionKind" ADD VALUE 'PAUSE_LISTING';
ALTER TYPE "ActionKind" ADD VALUE 'BOOST_AFFILIATE_OUTREACH';
ALTER TYPE "ActionKind" ADD VALUE 'SEND_AFFILIATE_EMAIL';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentName" ADD VALUE 'MARKETPLACE';
ALTER TYPE "AgentName" ADD VALUE 'AFFILIATE';
ALTER TYPE "AgentName" ADD VALUE 'FUNNEL';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'AFFILIATE_CONTACTED';
ALTER TYPE "EventType" ADD VALUE 'UPSELL_SENT';
ALTER TYPE "EventType" ADD VALUE 'UPSELL_CONVERTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OperationalSector" ADD VALUE 'MARKETPLACE';
ALTER TYPE "OperationalSector" ADD VALUE 'FUNNEL';
ALTER TYPE "OperationalSector" ADD VALUE 'AFFILIATE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentProvider" ADD VALUE 'HOTMART';
ALTER TYPE "PaymentProvider" ADD VALUE 'KIWIFY';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "externalOrderId" TEXT,
ADD COLUMN     "marketplaceProvider" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "affiliateCommissionPct" INTEGER,
ADD COLUMN     "channel" TEXT,
ADD COLUMN     "externalProductId" TEXT,
ADD COLUMN     "marketplaceUrl" TEXT;

-- CreateTable
CREATE TABLE "MarketplaceListing" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalProductId" TEXT NOT NULL,
    "marketplaceUrl" TEXT NOT NULL,
    "affiliateCommissionPct" INTEGER NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Affiliate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "whatsappNumber" TEXT,
    "hotmartAffiliateId" TEXT,
    "status" "AffiliateStatus" NOT NULL DEFAULT 'PROSPECT',
    "ebookId" TEXT,
    "commissionPct" INTEGER NOT NULL DEFAULT 30,
    "totalSalesCents" INTEGER NOT NULL DEFAULT 0,
    "lastContactedAt" TIMESTAMP(3),
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Affiliate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateOutreach" (
    "id" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "channel" "OutreachChannel" NOT NULL,
    "templateKey" TEXT NOT NULL,
    "status" "OutreachStatus" NOT NULL DEFAULT 'SENT',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agentRunId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AffiliateOutreach_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketplaceListing_provider_idx" ON "MarketplaceListing"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceListing_productId_provider_key" ON "MarketplaceListing"("productId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "Affiliate_email_key" ON "Affiliate"("email");

-- CreateIndex
CREATE INDEX "Affiliate_status_idx" ON "Affiliate"("status");

-- CreateIndex
CREATE INDEX "Affiliate_ebookId_idx" ON "Affiliate"("ebookId");

-- CreateIndex
CREATE INDEX "AffiliateOutreach_affiliateId_sentAt_idx" ON "AffiliateOutreach"("affiliateId", "sentAt");

-- CreateIndex
CREATE INDEX "AffiliateOutreach_status_idx" ON "AffiliateOutreach"("status");

-- CreateIndex
CREATE INDEX "Order_productId_idx" ON "Order"("productId");

-- CreateIndex
CREATE INDEX "Order_externalOrderId_idx" ON "Order"("externalOrderId");

-- CreateIndex
CREATE INDEX "Product_externalProductId_idx" ON "Product"("externalProductId");

-- AddForeignKey
ALTER TABLE "MarketplaceListing" ADD CONSTRAINT "MarketplaceListing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateOutreach" ADD CONSTRAINT "AffiliateOutreach_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
