/*
  Warnings:

  - Added the required column `updatedAt` to the `ScheduleItem` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ReviewLog" ADD COLUMN     "versionId" TEXT;

-- AlterTable
ALTER TABLE "ScheduleItem" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "failedReason" TEXT,
ADD COLUMN     "remind24At" TIMESTAMP(3),
ADD COLUMN     "remind7dAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "PostMetric" (
    "id" TEXT NOT NULL,
    "scheduleItemId" TEXT NOT NULL,
    "checkpoint" TEXT NOT NULL,
    "reads" INTEGER NOT NULL,
    "likes" INTEGER NOT NULL,
    "saves" INTEGER NOT NULL,
    "comments" INTEGER NOT NULL,
    "userId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostMetric_scheduleItemId_checkpoint_key" ON "PostMetric"("scheduleItemId", "checkpoint");

-- AddForeignKey
ALTER TABLE "PostMetric" ADD CONSTRAINT "PostMetric_scheduleItemId_fkey" FOREIGN KEY ("scheduleItemId") REFERENCES "ScheduleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
