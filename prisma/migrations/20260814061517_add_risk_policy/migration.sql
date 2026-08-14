-- CreateTable
CREATE TABLE "RiskPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "feedId" TEXT NOT NULL,
    "priceChangePercent" INTEGER NOT NULL DEFAULT 20,
    "inventoryDropPercent" INTEGER NOT NULL DEFAULT 90,
    "flagZeroInventory" BOOLEAN NOT NULL DEFAULT true,
    "blockRunAbovePercent" INTEGER NOT NULL DEFAULT 30,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RiskPolicy_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "FeedConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShadowChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shadowRunId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "variantGid" TEXT,
    "productGid" TEXT,
    "targetField" TEXT NOT NULL,
    "currentValue" TEXT,
    "proposedValue" TEXT,
    "verdict" TEXT NOT NULL,
    "risk" TEXT NOT NULL DEFAULT 'safe',
    "riskReason" TEXT,
    "appliedAt" DATETIME,
    "note" TEXT,
    CONSTRAINT "ShadowChange_shadowRunId_fkey" FOREIGN KEY ("shadowRunId") REFERENCES "ShadowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ShadowChange" ("currentValue", "id", "note", "productGid", "proposedValue", "shadowRunId", "sku", "targetField", "variantGid", "verdict") SELECT "currentValue", "id", "note", "productGid", "proposedValue", "shadowRunId", "sku", "targetField", "variantGid", "verdict" FROM "ShadowChange";
DROP TABLE "ShadowChange";
ALTER TABLE "new_ShadowChange" RENAME TO "ShadowChange";
CREATE INDEX "ShadowChange_shadowRunId_verdict_idx" ON "ShadowChange"("shadowRunId", "verdict");
CREATE INDEX "ShadowChange_shadowRunId_risk_idx" ON "ShadowChange"("shadowRunId", "risk");
CREATE TABLE "new_ShadowRun" (
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
    "fieldsSafe" INTEGER NOT NULL DEFAULT 0,
    "fieldsReview" INTEGER NOT NULL DEFAULT 0,
    "fieldsHigh" INTEGER NOT NULL DEFAULT 0,
    "runBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockReason" TEXT,
    "appliedAt" DATETIME,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "applyError" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "ShadowRun_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "FeedConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ShadowRun" ("error", "feedId", "fieldsBlocked", "fieldsChanged", "fieldsUnchanged", "finishedAt", "id", "rowsAmbiguous", "rowsInFeed", "rowsInvalid", "rowsMatched", "rowsUnmatched", "shop", "startedAt", "status") SELECT "error", "feedId", "fieldsBlocked", "fieldsChanged", "fieldsUnchanged", "finishedAt", "id", "rowsAmbiguous", "rowsInFeed", "rowsInvalid", "rowsMatched", "rowsUnmatched", "shop", "startedAt", "status" FROM "ShadowRun";
DROP TABLE "ShadowRun";
ALTER TABLE "new_ShadowRun" RENAME TO "ShadowRun";
CREATE INDEX "ShadowRun_feedId_startedAt_idx" ON "ShadowRun"("feedId", "startedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "RiskPolicy_feedId_key" ON "RiskPolicy"("feedId");
