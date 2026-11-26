-- House-centric landlord -> tenant links.
-- A tenant belongs to exactly one landlord (one house/room). Both sides are
-- active voters; the API rejects a voter that would be both landlord and tenant.
-- Apply:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/013_tenant_links.sql
-- Run the whole file as one batch. The Cloudflare dashboard SQL console runs
-- only the statement under the cursor; select all statements first, or the
-- CREATE INDEX will run without the CREATE TABLE and fail with
-- "no such table: main.tenant_links".
-- Superseded by 014_landlords.sql, which adds the landlords table and moves
-- tenant_links to landlord_id. Apply 013, then 014.
-- Safe to re-run: CREATE IF NOT EXISTS.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenant_links (
  id TEXT PRIMARY KEY,
  landlord_epic TEXT NOT NULL,
  tenant_epic TEXT NOT NULL UNIQUE,
  room_no TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS tenant_links_landlord_idx ON tenant_links (landlord_epic);
