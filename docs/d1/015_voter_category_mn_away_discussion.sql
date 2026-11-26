-- Adds MN Discussion / Away Discussion to voters.voter_category.
-- SQLite cannot ALTER a CHECK constraint, so voters is rebuilt: rows are
-- snapshotted into voters_backup (rowid preserved so the voters_fts index
-- stays aligned), the old table is dropped, and a new voters table with the
-- expanded CHECK is created and repopulated.
-- Apply after 014:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/015_voter_category_mn_away_discussion.sql
-- Run the whole file as one batch. The Cloudflare dashboard SQL console runs
-- only the statement under the cursor; select all statements first, or the
-- deferred foreign keys are committed before voters is recreated.
-- Apply once: the table rebuild is not idempotent.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE voters_backup AS SELECT rowid AS __rowid, * FROM voters;

DROP TABLE voters;

CREATE TABLE voters (
  id TEXT PRIMARY KEY,
  epic_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  relative_name TEXT,
  relative_relation TEXT,
  section_name TEXT,
  ward_no INTEGER,
  part_no INTEGER,
  section INTEGER,
  sr_no_roll INTEGER,
  house_no TEXT,
  age INTEGER,
  date_of_birth TEXT,
  contact_no_1 TEXT,
  contact_no_2 TEXT,
  gender TEXT CHECK (gender IS NULL OR gender IN ('MALE', 'FEMALE', 'OTHER')),
  religion TEXT,
  state TEXT,
  voter_category TEXT CHECK (
    voter_category IS NULL OR
    voter_category IN ('HOME', 'OPEN', 'AWAY', 'BJP', 'CONGRESS', 'MN_DISCUSSION', 'AWAY_DISCUSSION')
  ),
  family_head_epic TEXT,
  family_label TEXT,
  family_color TEXT,
  row_color TEXT,
  photo_url TEXT,
  display_order INTEGER,
  parked_address TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT REFERENCES users(id),
  presence_status TEXT,
  presence_note TEXT,
  is_active INTEGER DEFAULT 1,
  disabled_at TEXT,
  disabled_reason TEXT
);

INSERT INTO voters (
  rowid, id, epic_no, name, relative_name, relative_relation, section_name, ward_no,
  part_no, section, sr_no_roll, house_no, age, date_of_birth, contact_no_1,
  contact_no_2, gender, religion, state, voter_category, family_head_epic,
  family_label, family_color, row_color, photo_url, display_order, parked_address,
  created_at, updated_at, updated_by, presence_status, presence_note, is_active,
  disabled_at, disabled_reason
)
SELECT
  __rowid, id, epic_no, name, relative_name, relative_relation, section_name, ward_no,
  part_no, section, sr_no_roll, house_no, age, date_of_birth, contact_no_1,
  contact_no_2, gender, religion, state, voter_category, family_head_epic,
  family_label, family_color, row_color, photo_url, display_order, parked_address,
  created_at, updated_at, updated_by, presence_status, presence_note, is_active,
  disabled_at, disabled_reason
FROM voters_backup;

DROP TABLE voters_backup;

CREATE INDEX IF NOT EXISTS idx_voters_epic_no ON voters(epic_no);
CREATE INDEX IF NOT EXISTS idx_voters_part_no ON voters(part_no);
CREATE INDEX IF NOT EXISTS idx_voters_section ON voters(section);
CREATE INDEX IF NOT EXISTS idx_voters_ward_no ON voters(ward_no);
CREATE INDEX IF NOT EXISTS idx_voters_family_head_epic ON voters(family_head_epic);
CREATE INDEX IF NOT EXISTS idx_voters_family_label ON voters(family_label);
CREATE INDEX IF NOT EXISTS idx_voters_voter_category ON voters(voter_category);
CREATE INDEX IF NOT EXISTS idx_voters_row_color ON voters(row_color);
CREATE INDEX IF NOT EXISTS idx_voters_dob ON voters(date_of_birth);
CREATE INDEX IF NOT EXISTS idx_voters_updated_at ON voters(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_voters_name ON voters(name);
CREATE INDEX IF NOT EXISTS idx_voters_part_section_sr ON voters(part_no, section, sr_no_roll);
CREATE INDEX IF NOT EXISTS idx_voters_is_active ON voters(is_active);

CREATE TRIGGER IF NOT EXISTS voters_fts_ai AFTER INSERT ON voters BEGIN
  INSERT INTO voters_fts(rowid, name, epic_no, contact_no_1, relative_name, house_no)
  VALUES (new.rowid, new.name, new.epic_no, new.contact_no_1, new.relative_name, new.house_no);
END;

CREATE TRIGGER IF NOT EXISTS voters_fts_ad AFTER DELETE ON voters BEGIN
  INSERT INTO voters_fts(voters_fts, rowid, name, epic_no, contact_no_1, relative_name, house_no)
  VALUES ('delete', old.rowid, old.name, old.epic_no, old.contact_no_1, old.relative_name, old.house_no);
END;

CREATE TRIGGER IF NOT EXISTS voters_fts_au AFTER UPDATE ON voters BEGIN
  INSERT INTO voters_fts(voters_fts, rowid, name, epic_no, contact_no_1, relative_name, house_no)
  VALUES ('delete', old.rowid, old.name, old.epic_no, old.contact_no_1, old.relative_name, old.house_no);
  INSERT INTO voters_fts(rowid, name, epic_no, contact_no_1, relative_name, house_no)
  VALUES (new.rowid, new.name, new.epic_no, new.contact_no_1, new.relative_name, new.house_no);
END;

CREATE TRIGGER IF NOT EXISTS voters_version_ai AFTER INSERT ON voters BEGIN
  INSERT INTO dataset_version (table_name, version, row_count, updated_at)
  VALUES ('voters', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(table_name) DO UPDATE SET
    version = dataset_version.version + 1,
    row_count = dataset_version.row_count + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER IF NOT EXISTS voters_version_au AFTER UPDATE ON voters BEGIN
  UPDATE dataset_version
  SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE table_name = 'voters';
END;

CREATE TRIGGER IF NOT EXISTS voters_version_ad AFTER DELETE ON voters BEGIN
  UPDATE dataset_version
  SET version = version + 1,
      row_count = MAX(row_count - 1, 0),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE table_name = 'voters';
END;
