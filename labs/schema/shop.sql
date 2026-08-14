-- labs/shop — 5 entities. Applied to D1 oat-labs-shop.
CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites (grant_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, entity TEXT NOT NULL, item_id TEXT NOT NULL, owner_org TEXT NOT NULL, grantee_key TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS "stores" ("id" TEXT PRIMARY KEY, "org_id" TEXT NOT NULL, "name" TEXT, "status" TEXT, "position" INTEGER, "note" TEXT, "kind" TEXT, "product_count" INTEGER, "order_count" INTEGER, "created_at" INTEGER, "updated_at" INTEGER, "deleted_at" INTEGER);
CREATE INDEX IF NOT EXISTS "stores_org" ON "stores" (org_id, deleted_at, id);
CREATE TABLE IF NOT EXISTS "products" ("id" TEXT PRIMARY KEY, "org_id" TEXT NOT NULL, "store_id" TEXT, "name" TEXT, "status" TEXT, "price" REAL, "position" INTEGER, "note" TEXT, "kind" TEXT, "review_count" INTEGER, "created_at" INTEGER, "updated_at" INTEGER);
CREATE INDEX IF NOT EXISTS "products_org" ON "products" (org_id, id);
CREATE TABLE IF NOT EXISTS "customers" ("id" TEXT PRIMARY KEY, "org_id" TEXT NOT NULL, "name" TEXT, "email" TEXT, "status" TEXT, "note" TEXT, "kind" TEXT, "created_at" INTEGER, "updated_at" INTEGER);
CREATE INDEX IF NOT EXISTS "customers_org" ON "customers" (org_id, id);
CREATE TABLE IF NOT EXISTS "orders" ("id" TEXT PRIMARY KEY, "org_id" TEXT NOT NULL, "store_id" TEXT, "name" TEXT, "status" TEXT, "total" REAL, "note" TEXT, "kind" TEXT, "created_at" INTEGER, "updated_at" INTEGER);
CREATE INDEX IF NOT EXISTS "orders_org" ON "orders" (org_id, id);
CREATE TABLE IF NOT EXISTS "reviews" ("id" TEXT PRIMARY KEY, "org_id" TEXT NOT NULL, "product_id" TEXT, "name" TEXT, "rating" INTEGER, "note" TEXT, "kind" TEXT, "created_at" INTEGER, "updated_at" INTEGER);
CREATE INDEX IF NOT EXISTS "reviews_org" ON "reviews" (org_id, id);
