-- Additive voter fields for special Team Leader parking buckets.
-- UI Shifted (__OFFICE__) uses parked_address.
-- rental_owner / rental_address / rental_part_no are retired and dropped by schema-ensure.
-- voters.part_no remains the electoral/voting part.
-- Apply:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/006_rented_voter_fields.sql

ALTER TABLE voters ADD COLUMN parked_address TEXT;
ALTER TABLE voters ADD COLUMN rental_owner TEXT;
ALTER TABLE voters ADD COLUMN rental_address TEXT;
ALTER TABLE voters ADD COLUMN rental_part_no INTEGER;

INSERT OR IGNORE INTO team_leaders (id, voter_id, part_no, section, notes)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-' ||
       substr('89ab', abs(random()) % 4 + 1, 1) ||
       substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       NULL, NULL, NULL, '__RENTED__'
WHERE NOT EXISTS (SELECT 1 FROM team_leaders WHERE notes = '__RENTED__');
