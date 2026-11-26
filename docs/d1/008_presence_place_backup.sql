-- Presence headers, place clubs, and a durable Shifted/Single parking backup.
-- Apply:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/008_presence_place_backup.sql
-- Safe to re-run: duplicate-column / already-exists errors can be ignored.
-- The Worker also applies this on demand via src/worker/lib/schema-ensure.ts.

ALTER TABLE voters ADD COLUMN presence_status TEXT;
ALTER TABLE voters ADD COLUMN presence_note TEXT;

CREATE TABLE IF NOT EXISTS place_clubs (
  id TEXT PRIMARY KEY,
  area TEXT NOT NULL,
  chawl TEXT,
  building TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS place_clubs_unique
  ON place_clubs (area, IFNULL(chawl, ''), IFNULL(building, ''));

CREATE TABLE IF NOT EXISTS family_place_clubs (
  family_head_epic TEXT PRIMARY KEY,
  place_club_id TEXT NOT NULL REFERENCES place_clubs(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS family_place_clubs_place_idx
  ON family_place_clubs (place_club_id);

CREATE TABLE IF NOT EXISTS shifted_parking_backup (
  id TEXT PRIMARY KEY,
  backed_up_at TEXT NOT NULL,
  parking_kind TEXT NOT NULL,
  leader_id TEXT NOT NULL,
  leader_notes TEXT,
  leader_created_at TEXT,
  voter_id TEXT,
  epic_no TEXT,
  voter_name TEXT,
  family_head_epic TEXT,
  ward_no INTEGER,
  part_no INTEGER,
  section INTEGER,
  parked_address TEXT,
  assignment_id TEXT,
  assigned_at TEXT,
  assigned_by TEXT,
  is_direct INTEGER,
  raw_leader_json TEXT,
  raw_voter_json TEXT
);

CREATE INDEX IF NOT EXISTS shifted_parking_backup_kind_idx
  ON shifted_parking_backup (parking_kind, leader_id);
