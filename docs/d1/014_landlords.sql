-- Off-roll landlords: a house owner can exist without being on the voter roll.
-- Mirrors team_leaders: voter_id optional, display_name required.
-- Migrates tenant_links.landlord_epic (from 013) to tenant_links.landlord_id.
-- Apply after 013:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/014_landlords.sql
-- Run the whole file as one batch. The Cloudflare dashboard SQL console runs
-- only the statement under the cursor; select all statements first.
-- Apply once: the ALTER COLUMN and table rebuild are not idempotent.


PRAGMA foreign_keys = OFF;


CREATE TABLE IF NOT EXISTS landlords (
  id TEXT PRIMARY KEY,
  voter_id TEXT REFERENCES voters(id),
  display_name TEXT NOT NULL,
  house_no TEXT,
  contact TEXT,
  ward_no INTEGER,
  part_no INTEGER,
  section INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


CREATE UNIQUE INDEX IF NOT EXISTS landlords_voter_idx
  ON landlords (voter_id) WHERE voter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS landlords_display_name_idx ON landlords (display_name);
CREATE INDEX IF NOT EXISTS landlords_house_idx ON landlords (house_no);
CREATE INDEX IF NOT EXISTS landlords_ward_idx ON landlords (ward_no);


-- One landlord per distinct old landlord EPIC that still resolves to a voter.
-- Rows whose EPIC has no voter are left behind and skipped by the copy below.
INSERT INTO landlords (id, voter_id, display_name, house_no, ward_no, part_no, section, created_at, updated_at)
SELECT
  'landlord-' || lower(hex(randomblob(12))),
  v.id,
  v.name,
  v.house_no,
  v.ward_no,
  v.part_no,
  v.section,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT DISTINCT landlord_epic
  FROM tenant_links
  WHERE landlord_epic IS NOT NULL AND TRIM(landlord_epic) <> ''
) e
JOIN voters v ON v.epic_no = e.landlord_epic
WHERE NOT EXISTS (SELECT 1 FROM landlords l WHERE l.voter_id = v.id)
GROUP BY v.id;


ALTER TABLE tenant_links ADD COLUMN landlord_id TEXT;


UPDATE tenant_links
SET landlord_id = (
  SELECT l.id
  FROM landlords l
  JOIN voters v ON v.id = l.voter_id
  WHERE v.epic_no = tenant_links.landlord_epic
)
WHERE landlord_id IS NULL;


ALTER TABLE tenant_links RENAME TO tenant_links_old;


CREATE TABLE tenant_links (
  id TEXT PRIMARY KEY,
  landlord_id TEXT NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  tenant_epic TEXT NOT NULL UNIQUE,
  room_no TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


INSERT INTO tenant_links (id, landlord_id, tenant_epic, room_no, notes, created_at, created_by, updated_at)
SELECT id, landlord_id, tenant_epic, room_no, notes, created_at, created_by, updated_at
FROM tenant_links_old
WHERE landlord_id IS NOT NULL;


DROP TABLE tenant_links_old;


CREATE INDEX IF NOT EXISTS tenant_links_landlord_idx ON tenant_links (landlord_id);


PRAGMA foreign_keys = ON;
