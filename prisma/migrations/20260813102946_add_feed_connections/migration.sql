-- CreateTable
CREATE TABLE "FeedConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'csv',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFetchedAt" DATETIME,
    "lastRowCount" INTEGER,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FeedRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "feedId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "rowCount" INTEGER,
    "columnNames" TEXT,
    "bytes" INTEGER,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "FeedRun_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "FeedConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FeedConnection_shop_idx" ON "FeedConnection"("shop");

-- CreateIndex
CREATE INDEX "FeedRun_feedId_startedAt_idx" ON "FeedRun"("feedId", "startedAt");
