-- CreateTable
CREATE TABLE "FieldMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "feedId" TEXT NOT NULL,
    "sourceColumn" TEXT NOT NULL,
    "targetField" TEXT NOT NULL,
    "owner" TEXT NOT NULL DEFAULT 'supplier',
    "dataType" TEXT NOT NULL DEFAULT 'string',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FieldMapping_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "FeedConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FieldMapping_feedId_idx" ON "FieldMapping"("feedId");

-- CreateIndex
CREATE UNIQUE INDEX "FieldMapping_feedId_targetField_key" ON "FieldMapping"("feedId", "targetField");
