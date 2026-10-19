-- CreateTable
CREATE TABLE "WecomChannel" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT,
    "audience" "Audience" NOT NULL,
    "staff" TEXT[],
    "state" TEXT NOT NULL,
    "remoteId" TEXT,
    "qrCode" TEXT,
    "url" TEXT,
    "tagId" TEXT,
    "welcomeText" TEXT,
    "groupWayId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WecomChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WecomContact" (
    "id" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "name" TEXT,
    "state" TEXT,
    "channelId" TEXT,
    "leadId" TEXT,
    "welcome" TEXT,
    "tagged" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "WecomContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupJoinWay" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "chatIds" TEXT[],
    "autoCreate" BOOLEAN NOT NULL DEFAULT true,
    "roomBaseName" TEXT,
    "roomBaseId" INTEGER,
    "state" TEXT NOT NULL,
    "remoteId" TEXT,
    "qrCode" TEXT,
    "members" JSONB,
    "checkedAt" TIMESTAMP(3),
    "fullAlertAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupJoinWay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WecomChannel_state_key" ON "WecomChannel"("state");

-- CreateIndex
CREATE INDEX "WecomContact_channelId_addedAt_idx" ON "WecomContact"("channelId", "addedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WecomContact_externalUserId_staffId_key" ON "WecomContact"("externalUserId", "staffId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupJoinWay_state_key" ON "GroupJoinWay"("state");

-- AddForeignKey
ALTER TABLE "WecomChannel" ADD CONSTRAINT "WecomChannel_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WecomChannel" ADD CONSTRAINT "WecomChannel_groupWayId_fkey" FOREIGN KEY ("groupWayId") REFERENCES "GroupJoinWay"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WecomContact" ADD CONSTRAINT "WecomContact_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "WecomChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WecomContact" ADD CONSTRAINT "WecomContact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

