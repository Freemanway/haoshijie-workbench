-- AlterTable
ALTER TABLE "Address" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "editedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "followRemindedAt" TIMESTAMP(3),
ADD COLUMN     "lastFollowAt" TIMESTAMP(3),
ADD COLUMN     "staleRemindedAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "LeadSource" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "platform" "Platform",
    "platformUserId" TEXT,
    "accountName" TEXT,
    "postUrl" TEXT,
    "conversationId" TEXT,
    "channelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadSource_platform_platformUserId_idx" ON "LeadSource"("platform", "platformUserId");

-- CreateIndex
CREATE INDEX "LeadSource_leadId_idx" ON "LeadSource"("leadId");

-- CreateIndex
CREATE INDEX "Lead_audience_status_createdAt_idx" ON "Lead"("audience", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "LeadSource" ADD CONSTRAINT "LeadSource_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

