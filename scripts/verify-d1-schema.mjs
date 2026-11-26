#!/usr/bin/env node

/**
 * D1 schema + tenancy isolation tests.
 *
 * Executes the real SQL files against an in-process SQLite database (node:sqlite,
 * the same SQLite engine D1 uses) and asserts the SaaS invariants:
 *
 *   - both schema files execute on a fresh database
 *   - no Postgres-only syntax is present
 *   - two workspaces may share an EPIC
 *   - every business table is workspace-scoped
 *   - FTS search cannot cross a workspace boundary
 *   - dashboard_stats and special leaders are per workspace
 *   - foreign keys are enforced
 *
 * Usage: node scripts/verify-d1-schema.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const d1 = join(here, '..', 'docs', 'd1')
const read = (file) => readFileSync(join(d1, file), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -> ${detail}` : ''}`)
  if (!ok) failures++
}

function openDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

function seedTenants(db) {
  db.exec(`
    INSERT INTO orgs (id, name) VALUES ('org-a', 'Org A'), ('org-b', 'Org B');
    INSERT INTO workspaces (id, org_id, name, slug) VALUES
      ('ws-a', 'org-a', 'North Seat', 'north'),
      ('ws-b', 'org-b', 'South Seat', 'south');
  `)
}

function insertVoter(db, id, org, ws, epic, name) {
  db.prepare(`
    INSERT INTO voters (id, org_id, workspace_id, epic_no, name, part_no)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(id, org, ws, epic, name)
}

// ---------------------------------------------------------------------------
// 1. Schema executes
// ---------------------------------------------------------------------------
const platform = openDb()
try {
  platform.exec(read('000_platform.sql'))
  check('000_platform.sql executes', true)
} catch (err) {
  check('000_platform.sql executes', false, err.message)
}

const campaign = openDb()
try {
  campaign.exec(read('001_schema.sql'))
  campaign.exec(read('002_fts_triggers.sql'))
  check('001_schema.sql + 002_fts_triggers.sql execute', true)
} catch (err) {
  check('001_schema.sql + 002_fts_triggers.sql execute', false, err.message)
}

// ---------------------------------------------------------------------------
// 2. No Postgres-only syntax
// ---------------------------------------------------------------------------
const postgresTokens = [
  /\bUUID\b(?!\s*\()/,
  /\bJSONB\b/i,
  /\bTIMESTAMPTZ\b/i,
  /\bgen_random_uuid\s*\(/i,
  /\bNOW\s*\(\s*\)/i,
  /\bBOOLEAN\b/i,
  /\bSERIAL\b/i,
  /\bILIKE\b/i,
]
for (const file of ['000_platform.sql', '001_schema.sql', '002_fts_triggers.sql']) {
  const sql = read(file).replace(/--[^\n]*/g, '')
  const hit = postgresTokens.find((re) => re.test(sql))
  check(`${file} has no Postgres-only syntax`, !hit, hit ? String(hit) : '')
}

// ---------------------------------------------------------------------------
// 3. Every business table is workspace-scoped
// ---------------------------------------------------------------------------
const businessTables = [
  'voters', 'activity_logs', 'import_batches', 'custom_fields', 'custom_field_values',
  'saved_filter_presets', 'family_merge_events', 'groups', 'group_members',
  'team_leaders', 'team_leader_assignments', 'team_leader_users', 'meetings',
  'meeting_invitees', 'job_records', 'place_clubs', 'family_place_clubs',
  'family_geotags', 'family_geotag_history', 'shifted_parking_backup',
  'landlords', 'tenant_links', 'elections', 'booths', 'booth_agents',
  'voter_turnout', 'app_settings',
]
for (const table of businessTables) {
  const cols = campaign.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  check(`${table} has org_id + workspace_id`, cols.includes('org_id') && cols.includes('workspace_id'))
}

// ---------------------------------------------------------------------------
// 4. No global EPIC unique; two workspaces can share an EPIC
// ---------------------------------------------------------------------------
seedTenants(campaign)
let sharedEpicOk = true
try {
  insertVoter(campaign, 'v-a', 'org-a', 'ws-a', 'ABC123', 'Alice')
  insertVoter(campaign, 'v-b', 'org-b', 'ws-b', 'ABC123', 'Bob')
} catch (err) {
  sharedEpicOk = false
  console.log('  shared EPIC insert failed:', err.message)
}
check('same EPIC allowed in two workspaces', sharedEpicOk)

let duplicateBlocked = false
try {
  insertVoter(campaign, 'v-a2', 'org-a', 'ws-a', 'ABC123', 'Alice 2')
} catch {
  duplicateBlocked = true
}
check('duplicate EPIC blocked inside one workspace', duplicateBlocked)

// ---------------------------------------------------------------------------
// 5. FTS search is workspace-scoped
// ---------------------------------------------------------------------------
const ftsA = campaign.prepare(`
  SELECT v.id FROM voters v JOIN voters_fts f ON f.rowid = v.rowid
  WHERE voters_fts MATCH ? AND v.workspace_id = ?
`).all('Alice', 'ws-a')
const ftsCross = campaign.prepare(`
  SELECT v.id FROM voters v JOIN voters_fts f ON f.rowid = v.rowid
  WHERE voters_fts MATCH ? AND v.workspace_id = ?
`).all('Alice', 'ws-b')
check('FTS returns the matching workspace row', ftsA.length === 1 && ftsA[0].id === 'v-a')
check('FTS does not leak across workspaces', ftsCross.length === 0)

// ---------------------------------------------------------------------------
// 6. dashboard_stats is per workspace
// ---------------------------------------------------------------------------
campaign.exec(`
  INSERT INTO dashboard_stats (workspace_id, org_id, total_voters) VALUES ('ws-a', 'org-a', 1);
  INSERT INTO dashboard_stats (workspace_id, org_id, total_voters) VALUES ('ws-b', 'org-b', 1);
`)
const statsCount = campaign.prepare('SELECT COUNT(*) AS c FROM dashboard_stats').get().c
check('dashboard_stats holds one row per workspace', statsCount === 2, `count ${statsCount}`)

// ---------------------------------------------------------------------------
// 7. Special leaders are per workspace
// ---------------------------------------------------------------------------
campaign.exec(`
  INSERT INTO team_leaders (id, org_id, workspace_id, notes, bucket_code)
  VALUES ('tl-a', 'org-a', 'ws-a', '__OFFICE__', '__OFFICE__');
  INSERT INTO team_leaders (id, org_id, workspace_id, notes, bucket_code)
  VALUES ('tl-b', 'org-b', 'ws-b', '__OFFICE__', '__OFFICE__');
`)
const buckets = campaign.prepare(`
  SELECT COUNT(*) AS c FROM team_leaders WHERE bucket_code = '__OFFICE__'
`).get().c
check('__OFFICE__ bucket exists once per workspace', buckets === 2, `count ${buckets}`)

let duplicateBucketBlocked = false
try {
  campaign.exec(`
    INSERT INTO team_leaders (id, org_id, workspace_id, notes, bucket_code)
    VALUES ('tl-a2', 'org-a', 'ws-a', '__OFFICE__', '__OFFICE__');
  `)
} catch {
  duplicateBucketBlocked = true
}
check('duplicate special bucket blocked in one workspace', duplicateBucketBlocked)

// ---------------------------------------------------------------------------
// 8. Foreign keys are enforced
// ---------------------------------------------------------------------------
let fkBlocked = false
try {
  insertVoter(campaign, 'v-orphan', 'org-a', 'ws-missing', 'ZZZ999', 'Orphan')
} catch {
  fkBlocked = true
}
check('voter cannot reference a missing workspace', fkBlocked)

// ---------------------------------------------------------------------------
// 9. dataset_version is per workspace
// ---------------------------------------------------------------------------
const versions = campaign.prepare('SELECT workspace_id, version, row_count FROM dataset_version ORDER BY workspace_id').all()
check('dataset_version has one row per workspace', versions.length === 2, JSON.stringify(versions))
check('dataset_version counts are workspace-local',
  versions.find((v) => v.workspace_id === 'ws-a')?.row_count === 1 &&
  versions.find((v) => v.workspace_id === 'ws-b')?.row_count === 1)

// ---------------------------------------------------------------------------
// 10. Platform tenancy tables and role constraints
// ---------------------------------------------------------------------------
const platformTables = ['orgs', 'workspaces', 'org_members', 'workspace_members', 'workspace_settings', 'workspace_categories', 'plans', 'subscriptions', 'invoices', 'invites', 'users']
for (const table of platformTables) {
  const exists = platform.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table)
  check(`platform table ${table} exists`, Boolean(exists))
}
platform.exec(`
  INSERT INTO orgs (id, name, slug) VALUES ('o1', 'One', 'one');
  INSERT INTO workspaces (id, org_id, name, slug) VALUES ('w1', 'o1', 'Seat', 'seat');
  INSERT INTO users (id, auth_user_id, email) VALUES ('u1', 'auth1', 'a@example.com');
  INSERT INTO workspace_members (id, org_id, workspace_id, user_id, role) VALUES ('m1', 'o1', 'w1', 'u1', 'incharge');
`)
let badRoleBlocked = false
try {
  platform.exec(`INSERT INTO workspace_members (id, org_id, workspace_id, user_id, role) VALUES ('m2', 'o1', 'w1', 'u1', 'admin')`)
} catch {
  badRoleBlocked = true
}
check('workspace role CHECK rejects legacy admin role', badRoleBlocked)

console.log('')
if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('All D1 schema + tenancy isolation checks passed.')
