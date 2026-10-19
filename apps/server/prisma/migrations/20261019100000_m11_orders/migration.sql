-- AlterTable
ALTER TABLE "Address" ADD COLUMN     "matchHash" TEXT,
ADD COLUMN     "phoneHash" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "dealCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dealTool" TEXT,
ADD COLUMN     "orderCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "wonAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "addressEnc" TEXT,
ADD COLUMN     "attrAccount" TEXT,
ADD COLUMN     "attrPlatform" "Platform",
ADD COLUMN     "attrPostUrl" TEXT,
ADD COLUMN     "attrTopicId" TEXT,
ADD COLUMN     "audience" "Audience" NOT NULL DEFAULT 'C',
ADD COLUMN     "buyerNick" TEXT,
ADD COLUMN     "cancelled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "contractNo" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "importId" TEXT,
ADD COLUMN     "isRepeat" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "matchedAt" TIMESTAMP(3),
ADD COLUMN     "note" TEXT,
ADD COLUMN     "phoneEnc" TEXT,
ADD COLUMN     "product" TEXT,
ADD COLUMN     "province" TEXT,
ADD COLUMN     "quantity" INTEGER,
ADD COLUMN     "quoteCents" INTEGER,
ADD COLUMN     "rawStatus" TEXT,
ADD COLUMN     "receiverEnc" TEXT;

-- CreateTable
CREATE TABLE "OrderImport" (
    "id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "created" INTEGER NOT NULL,
    "duplicated" INTEGER NOT NULL,
    "matched" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "errors" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Address_phoneHash_idx" ON "Address"("phoneHash");

-- CreateIndex
CREATE INDEX "Address_matchHash_idx" ON "Address"("matchHash");

-- CreateIndex
CREATE INDEX "Order_phoneHash_idx" ON "Order"("phoneHash");

-- CreateIndex
CREATE INDEX "Order_receiverHash_idx" ON "Order"("receiverHash");

-- CreateIndex
CREATE INDEX "Order_leadId_idx" ON "Order"("leadId");

-- CreateIndex
CREATE INDEX "Order_orderedAt_idx" ON "Order"("orderedAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_importId_fkey" FOREIGN KEY ("importId") REFERENCES "OrderImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

