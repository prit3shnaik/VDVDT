-- ===========================================================================
-- 001_schema.sql — Campaign data plane (DB binding), SaaS baseline
--
-- Apply after 000_platform.sql has been applied to the platform database:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/001_schema.sql
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/002_fts_triggers.sql
--
-- Every business table carries org_id AND workspace_id. The Worker injects both
-- from the session; a query without a workspace filter is a security bug.
--
-- `orgs` and `workspaces` below are a minimal mirror of the platform database.
-- D1 has static bindings and SQLite cannot cross-database foreign keys, so the
-- campaign database keeps a local registry to make REFERENCES checks real.
-- The platform database remains the source of truth; the Worker syncs these
-- rows on workspace create/rename/delete.
--
-- Naming: "org" = paying customer, "workspace" = constituency. "tenant" in this
-- schema is the rental-tenants module only (tenant_links), never a SaaS customer.
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Registry mirrors (kept in sync from the platform database)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  dataset_version INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (org_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(org_id);

-- Denormalised reference to platform users. Identity and roles live in the
-- platform database; this mirror exists so campaign foreign keys stay valid.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  full_name TEXT,
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ---------------------------------------------------------------------------
-- Voters (core roll). EPIC is unique per workspace, never globally: two
-- constituencies can legitimately share an EPIC format/value.
-- voter_category and presence_status are free-form codes validated by the
-- Worker against workspace_categories / workspace_settings.presence_options.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voters (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  epic_no TEXT NOT NULL,
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
  voter_category TEXT,
  family_head_epic TEXT,
  family_label TEXT,
  family_color TEXT,
  row_color TEXT,
  photo_url TEXT,
  display_order INTEGER,
  parked_address TEXT,
  presence_status TEXT,
  presence_note TEXT,
  is_active INTEGER DEFAULT 1,
  disabled_at TEXT,
  disabled_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_voters_workspace_epic ON voters(workspace_id, epic_no);
CREATE INDEX IF NOT EXISTS idx_voters_workspace_part ON voters(workspace_id, part_no);
CREATE INDEX IF NOT EXISTS idx_voters_workspace_section ON voters(workspace_id, section);
CREATE INDEX IF NOT EXISTS idx_voters_workspace_ward ON voters(workspace_id, ward_no);
CREATE INDEX IF NOT EXISTS idx_voters_workspace_family ON voters(workspace_id, family_head_epic);
CREATE INDEX IF NOT EXISTS idx_voters_workspace_category ON voters(workspace_id, voter_category);
CREATE INDEX IF NOT EXISTS idx_voters_workspace_presence ON voters(workspace_id, presence_status);
CREATE INDEX IF NOT EXISTS idx_voters_workspace_active ON voters(workspace_id, is_active);
CREATE INDEX IF NOT EXISTS idx_voters_workspace_dob ON voters(workspace_id, date_of_birth);
CREATE INDEX IF NOT EXISTS idx_voters_workspace_updated ON voters(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_voters_workspace_name ON voters(workspace_id, name);
CREATE INDEX IF NOT EXISTS idx_voters_workspace_part_section_sr ON voters(workspace_id, part_no, section, sr_no_roll);

-- ---------------------------------------------------------------------------
-- Activity / imports / custom fields (workspace-scoped)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_id TEXT,
  details TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_workspace ON activity_logs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_actor ON activity_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_target ON activity_logs(target_table, target_id);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_import_batches_workspace ON import_batches(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
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
  updated_by TEXT REFERENCES users(id),
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_custom_fields_workspace ON custom_fields(workspace_id, position);

CREATE TABLE IF NOT EXISTS custom_field_values (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (voter_id, field_id)
);

CREATE INDEX IF NOT EXISTS idx_cfv_workspace_voter ON custom_field_values(workspace_id, voter_id);
CREATE INDEX IF NOT EXISTS idx_cfv_field ON custom_field_values(field_id);

CREATE TABLE IF NOT EXISTS saved_filter_presets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  filters TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workspace_id, owner_id, name)
);

CREATE TABLE IF NOT EXISTS family_merge_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  merged_family_key TEXT NOT NULL,
  into_family_key TEXT NOT NULL,
  merged_voter_ids TEXT NOT NULL,
  details TEXT,
  merged_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_family_merge_workspace ON family_merge_events(workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Groups (part-wise / booth-wise / custom)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_groups_workspace ON groups(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_groups_parent ON groups(parent_group_id);
CREATE INDEX IF NOT EXISTS idx_groups_part_no ON groups(part_no);

CREATE TABLE IF NOT EXISTS group_members (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  added_by TEXT REFERENCES users(id),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (group_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_workspace_voter ON group_members(workspace_id, voter_id);

-- ---------------------------------------------------------------------------
-- Team leaders. Special buckets (office / shifted / rented) are per workspace
-- and identified by bucket_code, not by a global sentinel notes value.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_leaders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  voter_id TEXT,
  display_name TEXT,
  part_no INTEGER,
  section INTEGER,
  notes TEXT,
  bucket_code TEXT,
  assistant_voter_id TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_team_leaders_workspace ON team_leaders(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_leaders_notes ON team_leaders(workspace_id, notes);
CREATE INDEX IF NOT EXISTS idx_team_leaders_part_no ON team_leaders(workspace_id, part_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_leaders_ws_bucket
  ON team_leaders(workspace_id, bucket_code) WHERE bucket_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_leaders_ws_voter
  ON team_leaders(workspace_id, voter_id) WHERE voter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS team_leader_assignments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_leader_id TEXT NOT NULL REFERENCES team_leaders(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  assigned_by TEXT REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  is_direct INTEGER,
  UNIQUE (workspace_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_tla_workspace_leader ON team_leader_assignments(workspace_id, team_leader_id);
CREATE INDEX IF NOT EXISTS idx_tla_voter ON team_leader_assignments(voter_id);

CREATE TABLE IF NOT EXISTS team_leader_users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_leader_id TEXT NOT NULL REFERENCES team_leaders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by TEXT REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workspace_id, team_leader_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_leader_users_user ON team_leader_users(user_id);
CREATE INDEX IF NOT EXISTS idx_team_leader_users_leader ON team_leader_users(team_leader_id);

-- ---------------------------------------------------------------------------
-- Meetings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT,
  meeting_date TEXT NOT NULL,
  location TEXT,
  part_no INTEGER,
  notes TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_meetings_workspace_date ON meetings(workspace_id, meeting_date DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_part_no ON meetings(workspace_id, part_no);

CREATE TABLE IF NOT EXISTS meeting_invitees (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  attendance_status TEXT NOT NULL DEFAULT 'pending',
  call_note TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (meeting_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_invitees_workspace_meeting ON meeting_invitees(workspace_id, meeting_id);
CREATE INDEX IF NOT EXISTS idx_invitees_voter ON meeting_invitees(voter_id);
CREATE INDEX IF NOT EXISTS idx_invitees_status ON meeting_invitees(attendance_status);

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_job_records_workspace_voter ON job_records(workspace_id, voter_id);
CREATE INDEX IF NOT EXISTS idx_job_records_status ON job_records(workspace_id, status);

-- ---------------------------------------------------------------------------
-- Dashboard stats: one row per workspace (was a global singleton id = 1).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_stats (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id),
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

-- ---------------------------------------------------------------------------
-- Places / geotags (Field module)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS place_clubs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  area TEXT NOT NULL,
  chawl TEXT,
  building TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS place_clubs_workspace_unique
  ON place_clubs (workspace_id, area, IFNULL(chawl, ''), IFNULL(building, ''));
CREATE INDEX IF NOT EXISTS idx_place_clubs_workspace ON place_clubs(workspace_id);

CREATE TABLE IF NOT EXISTS family_place_clubs (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  family_head_epic TEXT NOT NULL,
  place_club_id TEXT NOT NULL REFERENCES place_clubs(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, family_head_epic)
);

CREATE INDEX IF NOT EXISTS family_place_clubs_place_idx
  ON family_place_clubs (place_club_id);

CREATE TABLE IF NOT EXISTS family_geotags (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  family_key TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy_m REAL,
  altitude REAL,
  tagged_at TEXT NOT NULL,
  tagged_by TEXT NOT NULL REFERENCES users(id),
  team_leader_id TEXT REFERENCES team_leaders(id),
  source TEXT NOT NULL DEFAULT 'gps' CHECK (source IN ('gps', 'manual')),
  note TEXT,
  address TEXT,
  client_event_id TEXT NOT NULL,
  place_club_id TEXT REFERENCES place_clubs(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, family_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_family_geotags_ws_client_event
  ON family_geotags(workspace_id, client_event_id);
CREATE INDEX IF NOT EXISTS idx_family_geotags_leader ON family_geotags(workspace_id, team_leader_id);
CREATE INDEX IF NOT EXISTS idx_family_geotags_tagged_at ON family_geotags(workspace_id, tagged_at);

CREATE TABLE IF NOT EXISTS family_geotag_history (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  family_key TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy_m REAL,
  altitude REAL,
  tagged_at TEXT NOT NULL,
  tagged_by TEXT,
  team_leader_id TEXT,
  source TEXT,
  note TEXT,
  client_event_id TEXT,
  place_club_id TEXT,
  replaced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_family_geotag_history_key
  ON family_geotag_history(workspace_id, family_key, replaced_at);

CREATE TABLE IF NOT EXISTS shifted_parking_backup (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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
  ON shifted_parking_backup (workspace_id, parking_kind, leader_id);

-- ---------------------------------------------------------------------------
-- Rental tenants module (NOT SaaS tenancy). A landlord can be off-roll.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS landlords (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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

CREATE UNIQUE INDEX IF NOT EXISTS landlords_workspace_voter_idx
  ON landlords (workspace_id, voter_id) WHERE voter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS landlords_display_name_idx ON landlords (workspace_id, display_name);
CREATE INDEX IF NOT EXISTS landlords_house_idx ON landlords (workspace_id, house_no);

CREATE TABLE IF NOT EXISTS tenant_links (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  landlord_id TEXT NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  tenant_epic TEXT NOT NULL,
  room_no TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workspace_id, tenant_epic)
);

CREATE INDEX IF NOT EXISTS tenant_links_landlord_idx ON tenant_links(workspace_id, landlord_id);

-- ---------------------------------------------------------------------------
-- Booth / poll day
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS elections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  poll_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_elections_workspace ON elections(workspace_id, poll_date DESC);
CREATE INDEX IF NOT EXISTS idx_elections_status ON elections(workspace_id, status);

CREATE TABLE IF NOT EXISTS booths (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  part_no INTEGER NOT NULL,
  section INTEGER,
  name TEXT,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_booths_election ON booths(workspace_id, election_id);
CREATE INDEX IF NOT EXISTS idx_booths_part ON booths(election_id, part_no);

CREATE TABLE IF NOT EXISTS booth_agents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  booth_id TEXT NOT NULL REFERENCES booths(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by TEXT REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (booth_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_booth_agents_user ON booth_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_booth_agents_workspace ON booth_agents(workspace_id, booth_id);

CREATE TABLE IF NOT EXISTS voter_turnout (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  booth_id TEXT NOT NULL REFERENCES booths(id),
  status TEXT NOT NULL DEFAULT 'voted' CHECK (status IN ('voted', 'not_voted')),
  marked_at TEXT NOT NULL,
  marked_by TEXT NOT NULL REFERENCES users(id),
  source TEXT CHECK (source IS NULL OR source IN ('sr_no', 'epic', 'name')),
  client_event_id TEXT NOT NULL,
  lat REAL,
  lng REAL,
  override_note TEXT,
  overridden_by TEXT REFERENCES users(id),
  overridden_at TEXT,
  UNIQUE (workspace_id, election_id, voter_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_turnout_ws_client_event
  ON voter_turnout(workspace_id, client_event_id);
CREATE INDEX IF NOT EXISTS idx_turnout_election_booth ON voter_turnout(workspace_id, election_id, booth_id);
CREATE INDEX IF NOT EXISTS idx_turnout_election_marked ON voter_turnout(workspace_id, election_id, marked_at);
CREATE INDEX IF NOT EXISTS idx_turnout_voter ON voter_turnout(voter_id);
CREATE INDEX IF NOT EXISTS idx_turnout_marked_by ON voter_turnout(marked_by);

-- ---------------------------------------------------------------------------
-- Dataset change stamps, per workspace. Clients cache one workspace's roll at
-- a time; the stamp turns a full revalidation into a single row read.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dataset_version (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, table_name)
);

-- ---------------------------------------------------------------------------
-- Workspace-scoped settings (campaign side). Branding/presence/categories live
-- in the platform workspace_settings/workspace_categories tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT REFERENCES users(id),
  PRIMARY KEY (workspace_id, key)
);
