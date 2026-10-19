-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "agentId" TEXT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'dm',
ADD COLUMN     "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "unmatched" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "waitingSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "authorId" TEXT,
ADD COLUMN     "delivery" TEXT,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "llmCallId" TEXT,
ADD COLUMN     "meta" JSONB;

-- AlterTable
ALTER TABLE "PlatformAccount" ADD COLUMN     "inboxMode" TEXT NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "InboundEvent" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "InboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundEvent_externalId_key" ON "InboundEvent"("externalId");

-- CreateIndex
CREATE INDEX "InboundEvent_status_createdAt_idx" ON "InboundEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_status_lastMessageAt_idx" ON "Conversation"("status", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_externalId_key" ON "Message"("externalId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

