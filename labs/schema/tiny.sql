-- labs/tiny — 1 entities. Applied to D1 oat-labs-tiny.
CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites (grant_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, entity TEXT NOT NULL, item_id TEXT NOT NULL, owner_org TEXT NOT NULL, grantee_key TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS "articles" ("id" TEXT PRIMARY KEY, "org_id" TEXT NOT NULL, "title" TEXT, "slug" TEXT, "status" TEXT, "body" TEXT, "position" INTEGER, "kind" TEXT, "created_at" INTEGER, "updated_at" INTEGER, "deleted_at" INTEGER);
CREATE INDEX IF NOT EXISTS "articles_org" ON "articles" (org_id, deleted_at, id);
