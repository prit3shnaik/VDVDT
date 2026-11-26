-- Cloudflare D1 schema for VoterData Management
-- Converted from Supabase Postgres (see supabase/migrations and live tables used by the app).
-- Apply:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/001_schema.sql
-- Then:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/002_fts_triggers.sql

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- App profile (not Better Auth's user table)
-- allowed_wards is JSON text, e.g. [1,2,3]
-- booleans are INTEGER 0/1
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  auth_user_id TEXT NOT NULL UNIQUE,
  full_name TEXT,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'sub-admin', 'user')),
  allowed_wards TEXT NOT NULL DEFAULT '[]',
  can_edit INTEGER NOT NULL DEFAULT 0,
  password_reset_required INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ---------------------------------------------------------------------------
-- Voters (core roll)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voters (
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
  updated_by TEXT REFERENCES users(id)
);

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

-- ---------------------------------------------------------------------------
-- Activity / import / custom fields
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_id TEXT,
  details TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_actor ON activity_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_target ON activity_logs(target_table, target_id);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  storage_path TEXT,
  imported_by TEXT REFERENCES users(id),
  total_rows INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_report TEXT,
  success_report TEXT,
  photo_match_report TEXT,
  duplicate_preview TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'awaiting_confirmation', 'completed', 'failed', 'cancelled')
  ),
  progress_phase TEXT NOT NULL DEFAULT 'queued',
  progress_percent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_import_batches_created_at ON import_batches(created_at DESC);

CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (
    field_type IN ('text', 'textarea', 'number', 'date', 'dropdown', 'multiselect', 'checkbox', 'radio')
  ),
  options TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  show_in_card INTEGER NOT NULL DEFAULT 0,
  allow_custom_note INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS custom_field_values (
  id TEXT PRIMARY KEY,
  voter_id TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (voter_id, field_id)
);

CREATE INDEX IF NOT EXISTS idx_cfv_voter ON custom_field_values(voter_id);
CREATE INDEX IF NOT EXISTS idx_cfv_field ON custom_field_values(field_id);

CREATE TABLE IF NOT EXISTS saved_filter_presets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  filters TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (owner_id, name)
);

CREATE TABLE IF NOT EXISTS family_merge_events (
  id TEXT PRIMARY KEY,
  merged_family_key TEXT NOT NULL,
  into_family_key TEXT NOT NULL,
  merged_voter_ids TEXT NOT NULL,
  details TEXT,
  merged_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_family_merge_events_created_at ON family_merge_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_family_merge_events_into_key ON family_merge_events(into_family_key);

-- ---------------------------------------------------------------------------
-- Groups (schema reconstructed from src/lib/types.ts; dump live Postgres to confirm)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_type TEXT NOT NULL CHECK (group_type IN ('part_wise', 'booth_wise', 'custom')),
  part_no INTEGER,
  description TEXT,
  created_by TEXT REFERENCES users(id),
  parent_group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  exclusive_subgroups INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_groups_parent ON groups(parent_group_id);
CREATE INDEX IF NOT EXISTS idx_groups_part_no ON groups(part_no);

CREATE TABLE IF NOT EXISTS group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  added_by TEXT REFERENCES users(id),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (group_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_voter ON group_members(voter_id);

-- ---------------------------------------------------------------------------
-- Team leaders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_leaders (
  id TEXT PRIMARY KEY,
  voter_id TEXT UNIQUE,
  display_name TEXT,
  part_no INTEGER,
  section INTEGER,
  notes TEXT,
  assistant_voter_id TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_team_leaders_notes ON team_leaders(notes);
CREATE INDEX IF NOT EXISTS idx_team_leaders_part_no ON team_leaders(part_no);

CREATE TABLE IF NOT EXISTS team_leader_assignments (
  id TEXT PRIMARY KEY,
  team_leader_id TEXT NOT NULL REFERENCES team_leaders(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  assigned_by TEXT REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  is_direct INTEGER,
  UNIQUE (voter_id)
);

CREATE INDEX IF NOT EXISTS idx_tla_leader ON team_leader_assignments(team_leader_id);
CREATE INDEX IF NOT EXISTS idx_tla_voter ON team_leader_assignments(voter_id);

-- ---------------------------------------------------------------------------
-- Meetings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  title TEXT,
  meeting_date TEXT NOT NULL,
  location TEXT,
  part_no INTEGER,
  notes TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(meeting_date);
CREATE INDEX IF NOT EXISTS idx_meetings_part_no ON meetings(part_no);

CREATE TABLE IF NOT EXISTS meeting_invitees (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  attendance_status TEXT NOT NULL DEFAULT 'pending',
  call_note TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (meeting_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_invitees_meeting ON meeting_invitees(meeting_id);
CREATE INDEX IF NOT EXISTS idx_invitees_voter ON meeting_invitees(voter_id);
CREATE INDEX IF NOT EXISTS idx_invitees_status ON meeting_invitees(attendance_status);

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_records (
  id TEXT PRIMARY KEY,
  voter_id TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN ('applied_govt', 'applied_private', 'appointed_govt', 'appointed_private', 'pending')
  ),
  department_name TEXT,
  note TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_job_records_voter ON job_records(voter_id);
CREATE INDEX IF NOT EXISTS idx_job_records_status ON job_records(status);

-- ---------------------------------------------------------------------------
-- Dashboard stats (replaces Postgres materialized view)
-- Singleton row id = 1. Refresh from Worker after imports / bulk writes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_voters INTEGER NOT NULL DEFAULT 0,
  male_count INTEGER NOT NULL DEFAULT 0,
  female_count INTEGER NOT NULL DEFAULT 0,
  other_count INTEGER NOT NULL DEFAULT 0,
  avg_age REAL NOT NULL DEFAULT 0,
  religion_breakdown TEXT NOT NULL DEFAULT '{}',
  part_breakdown TEXT NOT NULL DEFAULT '{}',
  age_band_breakdown TEXT NOT NULL DEFAULT '{}',
  birthday_month_breakdown TEXT NOT NULL DEFAULT '{}',
  refreshed_at TEXT
);

INSERT OR IGNORE INTO dashboard_stats (id) VALUES (1);

-- Sentinel team-leader rows used by special parking buckets.
-- Skip these INSERTs if you are importing existing team_leaders rows that already
-- contain notes = '__OFFICE__' / '__SHIFTED__' / '__RENTED__'.
INSERT OR IGNORE INTO team_leaders (id, voter_id, part_no, section, notes)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-' ||
       substr('89ab', abs(random()) % 4 + 1, 1) ||
       substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       NULL, NULL, NULL, '__OFFICE__'
WHERE NOT EXISTS (SELECT 1 FROM team_leaders WHERE notes = '__OFFICE__');

INSERT OR IGNORE INTO team_leaders (id, voter_id, part_no, section, notes)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-' ||
       substr('89ab', abs(random()) % 4 + 1, 1) ||
       substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       NULL, NULL, NULL, '__SHIFTED__'
WHERE NOT EXISTS (SELECT 1 FROM team_leaders WHERE notes = '__SHIFTED__');

INSERT OR IGNORE INTO team_leaders (id, voter_id, part_no, section, notes)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-' ||
       substr('89ab', abs(random()) % 4 + 1, 1) ||
       substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       NULL, NULL, NULL, '__RENTED__'
WHERE NOT EXISTS (SELECT 1 FROM team_leaders WHERE notes = '__RENTED__');
