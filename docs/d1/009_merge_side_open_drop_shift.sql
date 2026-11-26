-- Merge Side into Open and retire Shift.
-- Apply:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/009_merge_side_open_drop_shift.sql
-- Safe to re-run: unmatched UPDATEs are no-ops.
-- The Worker also applies this on demand via src/worker/lib/schema-ensure.ts.

UPDATE voters
SET voter_category = 'OPEN',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE voter_category = 'SIDE';

UPDATE voters
SET voter_category = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE voter_category = 'SHIFT';
