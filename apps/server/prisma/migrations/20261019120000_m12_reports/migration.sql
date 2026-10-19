-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "insight" JSONB,
    "llmCallId" TEXT,
    "pushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Report_kind_from_key" ON "Report"("kind", "from");

