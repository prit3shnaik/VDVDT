-- Soft-disable for voters removed from the electoral roll.
-- Disabled rows keep EPIC, family, team-leader assignments, groups, and photos.
-- Apply:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/012_voter_is_active.sql
-- Safe to re-run: ADD COLUMN is ignored if the column already exists.

PRAGMA foreign_keys = ON;

ALTER TABLE voters ADD COLUMN is_active INTEGER DEFAULT 1;
ALTER TABLE voters ADD COLUMN disabled_at TEXT;
ALTER TABLE voters ADD COLUMN disabled_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_voters_is_active ON voters(is_active);
