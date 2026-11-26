-- Shared app settings (admin-managed, visible to all authenticated users).
-- Apply:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/011_app_settings.sql
-- Safe to re-run: CREATE IF NOT EXISTS.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT REFERENCES users(id)
);
