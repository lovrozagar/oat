CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  body TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS articles_org ON articles (org_id, deleted_at, id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT,
  kind TEXT NOT NULL DEFAULT 'note',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS comments_article ON comments (org_id, article_id, id);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  record TEXT NOT NULL
);
