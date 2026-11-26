-- Historical: per-voter free-text description. Retired; schema-ensure drops voters.description.
-- Apply:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/007_voter_description.sql
-- Safe to re-run: duplicate-column errors can be ignored.

ALTER TABLE voters ADD COLUMN description TEXT;
