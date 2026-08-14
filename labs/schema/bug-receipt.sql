-- labs/bug-receipt — 2 entities. Applied to D1 oat-labs-bug-receipt.
CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites (grant_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, entity TEXT NOT NULL, item_id TEXT NOT NULL, owner_org TEXT NOT NULL, grantee_key TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS "jobs" ("id" TEXT PRIMARY KEY, "org_id" TEXT NOT NULL, "name" TEXT, "status" TEXT, "note" TEXT, "kind" TEXT, "created_at" INTEGER, "updated_at" INTEGER);
CREATE INDEX IF NOT EXISTS "jobs_org" ON "jobs" (org_id, id);
CREATE TABLE IF NOT EXISTS "artifacts" ("id" TEXT PRIMARY KEY, "org_id" TEXT NOT NULL, "name" TEXT, "status" TEXT, "note" TEXT, "kind" TEXT, "created_at" INTEGER, "updated_at" INTEGER);
CREATE INDEX IF NOT EXISTS "artifacts_org" ON "artifacts" (org_id, id);
