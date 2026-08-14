-- CreateTable
CREATE TABLE "ShadowRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "feedId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "rowsInFeed" INTEGER NOT NULL DEFAULT 0,
    "rowsMatched" INTEGER NOT NULL DEFAULT 0,
    "rowsUnmatched" INTEGER NOT NULL DEFAULT 0,
    "rowsAmbiguous" INTEGER NOT NULL DEFAULT 0,
    "rowsInvalid" INTEGER NOT NULL DEFAULT 0,
    "fieldsChanged" INTEGER NOT NULL DEFAULT 0,
    "fieldsUnchanged" INTEGER NOT NULL DEFAULT 0,
    "fieldsBlocked" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "ShadowRun_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "FeedConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShadowChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shadowRunId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "variantGid" TEXT,
    "productGid" TEXT,
    "targetField" TEXT NOT NULL,
    "currentValue" TEXT,
    "proposedValue" TEXT,
    "verdict" TEXT NOT NULL,
    "note" TEXT,
    CONSTRAINT "ShadowChange_shadowRunId_fkey" FOREIGN KEY ("shadowRunId") REFERENCES "ShadowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ShadowRun_feedId_startedAt_idx" ON "ShadowRun"("feedId", "startedAt");

-- CreateIndex
CREATE INDEX "ShadowChange_shadowRunId_verdict_idx" ON "ShadowChange"("shadowRunId", "verdict");
