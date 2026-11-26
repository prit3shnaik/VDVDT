-- Booth Management: D-Day turnout and family geo-tags.
-- Apply:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/010_booth_management.sql
-- Safe to re-run: CREATE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS elections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  poll_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_elections_status ON elections(status);
CREATE INDEX IF NOT EXISTS idx_elections_poll_date ON elections(poll_date);

CREATE TABLE IF NOT EXISTS booths (
  id TEXT PRIMARY KEY,
  election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  part_no INTEGER NOT NULL,
  section INTEGER,
  name TEXT,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_booths_election ON booths(election_id);
CREATE INDEX IF NOT EXISTS idx_booths_part ON booths(election_id, part_no);

CREATE TABLE IF NOT EXISTS booth_agents (
  id TEXT PRIMARY KEY,
  booth_id TEXT NOT NULL REFERENCES booths(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by TEXT REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (booth_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_booth_agents_user ON booth_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_booth_agents_booth ON booth_agents(booth_id);

CREATE TABLE IF NOT EXISTS voter_turnout (
  id TEXT PRIMARY KEY,
  election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  booth_id TEXT NOT NULL REFERENCES booths(id),
  status TEXT NOT NULL DEFAULT 'voted' CHECK (status IN ('voted', 'not_voted')),
  marked_at TEXT NOT NULL,
  marked_by TEXT NOT NULL REFERENCES users(id),
  source TEXT CHECK (source IS NULL OR source IN ('sr_no', 'epic', 'name')),
  client_event_id TEXT NOT NULL UNIQUE,
  lat REAL,
  lng REAL,
  override_note TEXT,
  overridden_by TEXT REFERENCES users(id),
  overridden_at TEXT,
  UNIQUE (election_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_turnout_election_booth ON voter_turnout(election_id, booth_id);
CREATE INDEX IF NOT EXISTS idx_turnout_election_marked ON voter_turnout(election_id, marked_at);
CREATE INDEX IF NOT EXISTS idx_turnout_voter ON voter_turnout(voter_id);
CREATE INDEX IF NOT EXISTS idx_turnout_marked_by ON voter_turnout(marked_by);

CREATE TABLE IF NOT EXISTS team_leader_users (
  id TEXT PRIMARY KEY,
  team_leader_id TEXT NOT NULL REFERENCES team_leaders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by TEXT REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (team_leader_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_leader_users_user ON team_leader_users(user_id);
CREATE INDEX IF NOT EXISTS idx_team_leader_users_leader ON team_leader_users(team_leader_id);

CREATE TABLE IF NOT EXISTS family_geotags (
  family_key TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy_m REAL,
  altitude REAL,
  tagged_at TEXT NOT NULL,
  tagged_by TEXT NOT NULL REFERENCES users(id),
  team_leader_id TEXT REFERENCES team_leaders(id),
  source TEXT NOT NULL DEFAULT 'gps' CHECK (source IN ('gps')),
  note TEXT,
  client_event_id TEXT NOT NULL UNIQUE,
  place_club_id TEXT REFERENCES place_clubs(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_family_geotags_leader ON family_geotags(team_leader_id);
CREATE INDEX IF NOT EXISTS idx_family_geotags_tagged_at ON family_geotags(tagged_at);

CREATE TABLE IF NOT EXISTS family_geotag_history (
  id TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_family_geotag_history_key ON family_geotag_history(family_key, replaced_at);
