/*
  Warnings:

  - Added the required column `updatedAt` to the `Draft` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Topic` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DraftStatus" ADD VALUE 'GENERATING';
ALTER TYPE "DraftStatus" ADD VALUE 'GENERATE_FAILED';

-- AlterEnum
ALTER TYPE "TopicStatus" ADD VALUE 'PROPOSED';

-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "error" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "DraftVersion" ADD COLUMN     "imageTips" TEXT[],
ADD COLUMN     "llmCallId" TEXT,
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "Topic" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "TopicCategory" (
    "id" TEXT NOT NULL,
    "audience" "Audience" NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TopicCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "userId" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "messages" JSONB NOT NULL,
    "output" TEXT,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMilli" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TopicCategory_audience_name_key" ON "TopicCategory"("audience", "name");

-- CreateIndex
CREATE INDEX "LlmCall_createdAt_idx" ON "LlmCall"("createdAt");

-- CreateIndex
CREATE INDEX "LlmCall_refType_refId_idx" ON "LlmCall"("refType", "refId");

-- CreateIndex
CREATE INDEX "Topic_weekOf_idx" ON "Topic"("weekOf");

-- CreateIndex
CREATE INDEX "Topic_status_idx" ON "Topic"("status");
