import type { D1Database } from '@cloudflare/workers-types'

let votersSchemaReady: Promise<void> | null = null

async function existingColumns(db: D1Database, table: string): Promise<Set<string>> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
  return new Set((results ?? []).map((row) => row.name))
}

async function addMissingColumns(
  db: D1Database,
  table: string,
  columns: Array<{ name: string; ddl: string }>,
): Promise<void> {
  const present = await existingColumns(db, table)
  for (const column of columns) {
    if (present.has(column.name)) continue
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column.ddl}`).run()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!/duplicate column name/i.test(message)) throw err
    }
  }
}

async function dropRetiredColumns(
  db: D1Database,
  table: string,
  columns: string[],
): Promise<void> {
  const present = await existingColumns(db, table)
  for (const column of columns) {
    if (!present.has(column)) continue
    try {
      await db.prepare(`ALTER TABLE ${table} DROP COLUMN ${column}`).run()
    } catch {
      try {
        await db.prepare(`UPDATE ${table} SET ${column} = NULL`).run()
      } catch {
        // Column may already be gone or not writable.
      }
    }
  }
}

async function migrateRetiredVoterCategories(db: D1Database): Promise<void> {
  await db.prepare(`
    UPDATE voters
    SET voter_category = 'OPEN',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE voter_category = 'SIDE'
  `).run()
  await db.prepare(`
    UPDATE voters
    SET voter_category = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE voter_category = 'SHIFT'
  `).run()
}

const VOTER_CATEGORY_VALUES = "'HOME', 'OPEN', 'AWAY', 'BJP', 'CONGRESS', 'MN_DISCUSSION', 'AWAY_DISCUSSION'"

const VOTER_COPY_COLUMNS = [
  'id', 'epic_no', 'name', 'relative_name', 'relative_relation', 'section_name',
  'ward_no', 'part_no', 'section', 'sr_no_roll', 'house_no', 'age', 'date_of_birth',
  'contact_no_1', 'contact_no_2', 'gender', 'religion', 'state', 'voter_category',
  'family_head_epic', 'family_label', 'family_color', 'row_color', 'photo_url',
  'display_order', 'parked_address', 'created_at', 'updated_at', 'updated_by',
  'presence_status', 'presence_note', 'is_active', 'disabled_at', 'disabled_reason',
]

// SQLite cannot widen a CHECK constraint in place, so voters is rebuilt: rows
// are snapshotted (rowid preserved so the voters_fts index stays aligned), the
// old table is dropped, and a new one with the expanded CHECK is repopulated.
async function ensureVoterCategoryAllowsDiscussion(db: D1Database): Promise<void> {
  const table = await db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'voters'`)
    .first<{ sql: string | null }>()
  if (!table?.sql || /MN_DISCUSSION/.test(table.sql)) return

  const expandedSql = table.sql.replace(
    /voter_category\s+IN\s*\([^)]*\)/i,
    `voter_category IN (${VOTER_CATEGORY_VALUES})`,
  )
  if (expandedSql === table.sql) return

  const { results: dependents } = await db
    .prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = 'voters' AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .all<{ sql: string }>()

  const columns = await existingColumns(db, 'voters')
  const copyColumns = VOTER_COPY_COLUMNS.filter((name) => columns.has(name)).join(', ')

  await db.batch([
    db.prepare('PRAGMA defer_foreign_keys = ON'),
    db.prepare('DROP TABLE IF EXISTS voters_backup'),
    db.prepare('CREATE TABLE voters_backup AS SELECT rowid AS __rowid, * FROM voters'),
    db.prepare('DROP TABLE voters'),
    db.prepare(expandedSql),
    db.prepare(`INSERT INTO voters (rowid, ${copyColumns}) SELECT __rowid, ${copyColumns} FROM voters_backup`),
    db.prepare('DROP TABLE voters_backup'),
    ...(dependents ?? []).map((row) => db.prepare(row.sql)),
  ])
}

interface LegacyLandlordEpicRow {
  epic: string
}

interface LandlordVoterRow {
  id: string
  name: string
  house_no: string | null
  ward_no: number | null
  part_no: number | null
  section: number | null
}

const TENANT_LINKS_DDL = `
  CREATE TABLE tenant_links (
    id TEXT PRIMARY KEY,
    landlord_id TEXT NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
    tenant_epic TEXT NOT NULL UNIQUE,
    room_no TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_by TEXT REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`

async function ensureLandlordTables(db: D1Database): Promise<void> {
  await db.prepare(`
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
    )
  `).run()
  await db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS landlords_voter_idx
      ON landlords (voter_id) WHERE voter_id IS NOT NULL
  `).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS landlords_display_name_idx ON landlords (display_name)`).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS landlords_house_idx ON landlords (house_no)`).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS landlords_ward_idx ON landlords (ward_no)`).run()

  const columns = await existingColumns(db, 'tenant_links')
  if (columns.size === 0) {
    await db.prepare(TENANT_LINKS_DDL).run()
    await db.prepare(`CREATE INDEX IF NOT EXISTS tenant_links_landlord_idx ON tenant_links (landlord_id)`).run()
    return
  }
  if (!columns.has('landlord_epic')) {
    await db.prepare(`CREATE INDEX IF NOT EXISTS tenant_links_landlord_idx ON tenant_links (landlord_id)`).run()
    return
  }

  if (!columns.has('landlord_id')) {
    try {
      await db.prepare('ALTER TABLE tenant_links ADD COLUMN landlord_id TEXT').run()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!/duplicate column name/i.test(message)) throw err
    }
  }

  const { results: epics } = await db.prepare(`
    SELECT DISTINCT landlord_epic AS epic
    FROM tenant_links
    WHERE landlord_epic IS NOT NULL AND TRIM(landlord_epic) <> ''
  `).all<LegacyLandlordEpicRow>()

  const skipped: string[] = []
  for (const row of epics ?? []) {
    const voter = await db.prepare(`
      SELECT id, name, house_no, ward_no, part_no, section
      FROM voters
      WHERE epic_no = ?
    `).bind(row.epic).first<LandlordVoterRow>()
    if (!voter) {
      skipped.push(row.epic)
      continue
    }

    let landlord = await db.prepare('SELECT id FROM landlords WHERE voter_id = ?').bind(voter.id).first<{ id: string }>()
    if (!landlord) {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      await db.prepare(`
        INSERT INTO landlords (id, voter_id, display_name, house_no, ward_no, part_no, section, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        voter.id,
        voter.name,
        voter.house_no,
        voter.ward_no,
        voter.part_no,
        voter.section,
        now,
        now,
      ).run()
      landlord = { id }
    }
    await db.prepare('UPDATE tenant_links SET landlord_id = ? WHERE landlord_epic = ?').bind(landlord.id, row.epic).run()
  }

  if (skipped.length) {
    console.warn(`tenant_links migration skipped landlord EPICs with no voter: ${skipped.join(', ')}`)
  }

  try {
    await db.batch([
      db.prepare('DROP INDEX IF EXISTS tenant_links_landlord_idx'),
      db.prepare('ALTER TABLE tenant_links RENAME TO tenant_links_old'),
      db.prepare(TENANT_LINKS_DDL),
      db.prepare(`
        INSERT INTO tenant_links (id, landlord_id, tenant_epic, room_no, notes, created_at, created_by, updated_at)
        SELECT id, landlord_id, tenant_epic, room_no, notes, created_at, created_by, updated_at
        FROM tenant_links_old
        WHERE landlord_id IS NOT NULL
      `),
      db.prepare('DROP TABLE tenant_links_old'),
      db.prepare(`CREATE INDEX IF NOT EXISTS tenant_links_landlord_idx ON tenant_links (landlord_id)`),
    ])
  } catch (err) {
    const after = await existingColumns(db, 'tenant_links')
    if (after.has('landlord_epic')) {
      await db.prepare('DROP TABLE IF EXISTS tenant_links_old').run().catch(() => {})
      throw err
    }
    await db.prepare(`CREATE INDEX IF NOT EXISTS tenant_links_landlord_idx ON tenant_links (landlord_id)`).run()
  }
}

async function ensurePlaceAndBackupTables(db: D1Database): Promise<void> {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS place_clubs (
      id TEXT PRIMARY KEY,
      area TEXT NOT NULL,
      chawl TEXT,
      building TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      created_by TEXT REFERENCES users(id)
    )
  `).run()
  await db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS place_clubs_unique
      ON place_clubs (area, IFNULL(chawl, ''), IFNULL(building, ''))
  `).run()
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS family_place_clubs (
      family_head_epic TEXT PRIMARY KEY,
      place_club_id TEXT NOT NULL REFERENCES place_clubs(id) ON DELETE CASCADE,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `).run()
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS family_place_clubs_place_idx
      ON family_place_clubs (place_club_id)
  `).run()
  await ensureLandlordTables(db)
  await db.prepare(`
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
    )
  `).run()
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS shifted_parking_backup_kind_idx
      ON shifted_parking_backup (parking_kind, leader_id)
  `).run()
}

function familyGeotagsTableDdl(table: string): string {
  return `
    CREATE TABLE ${table} (
      family_key TEXT PRIMARY KEY,
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
      client_event_id TEXT NOT NULL UNIQUE,
      place_club_id TEXT REFERENCES place_clubs(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `
}

async function ensureGeotagSourceAllowsManual(db: D1Database): Promise<void> {
  const row = await db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'family_geotags'`)
    .first<{ sql: string | null }>()
  if (!row?.sql || !/CHECK\s*\(\s*source\s+IN\s*\(\s*'gps'\s*\)\s*\)/i.test(row.sql)) return

  await db.batch([
    db.prepare('DROP INDEX IF EXISTS idx_family_geotags_leader'),
    db.prepare('DROP INDEX IF EXISTS idx_family_geotags_tagged_at'),
    db.prepare(familyGeotagsTableDdl('family_geotags_new')),
    db.prepare(
      `INSERT INTO family_geotags_new
        (family_key, lat, lng, accuracy_m, altitude, tagged_at, tagged_by, team_leader_id, source, note, address, client_event_id, place_club_id, updated_at)
       SELECT family_key, lat, lng, accuracy_m, altitude, tagged_at, tagged_by, team_leader_id, source, note, address, client_event_id, place_club_id, updated_at
       FROM family_geotags`,
    ),
    db.prepare('DROP TABLE family_geotags'),
    db.prepare('ALTER TABLE family_geotags_new RENAME TO family_geotags'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_family_geotags_leader ON family_geotags(team_leader_id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_family_geotags_tagged_at ON family_geotags(tagged_at)'),
  ])
}

async function ensureBoothManagementTables(db: D1Database): Promise<void> {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS elections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      poll_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_elections_status ON elections(status)`).run()
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS booths (
      id TEXT PRIMARY KEY,
      election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
      part_no INTEGER NOT NULL,
      section INTEGER,
      name TEXT,
      location TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_booths_election ON booths(election_id)`).run()
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS booth_agents (
      id TEXT PRIMARY KEY,
      booth_id TEXT NOT NULL REFERENCES booths(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_by TEXT REFERENCES users(id),
      assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (booth_id, user_id)
    )
  `).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_booth_agents_user ON booth_agents(user_id)`).run()
  await db.prepare(`
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
    )
  `).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_turnout_election_booth ON voter_turnout(election_id, booth_id)`).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_turnout_election_marked ON voter_turnout(election_id, marked_at)`).run()
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS team_leader_users (
      id TEXT PRIMARY KEY,
      team_leader_id TEXT NOT NULL REFERENCES team_leaders(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_by TEXT REFERENCES users(id),
      assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (team_leader_id, user_id)
    )
  `).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_team_leader_users_user ON team_leader_users(user_id)`).run()
  await db.prepare(familyGeotagsTableDdl('IF NOT EXISTS family_geotags')).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_family_geotags_leader ON family_geotags(team_leader_id)`).run()
  await db.prepare(`
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
      address TEXT,
      client_event_id TEXT,
      place_club_id TEXT,
      replaced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_family_geotag_history_key ON family_geotag_history(family_key, replaced_at)`).run()
  await addMissingColumns(db, 'family_geotags', [{ name: 'address', ddl: 'address TEXT' }])
  await addMissingColumns(db, 'family_geotag_history', [{ name: 'address', ddl: 'address TEXT' }])
  await ensureGeotagSourceAllowsManual(db)
}

let boothSchemaReady: Promise<void> | null = null

export function ensureBoothSchema(db: D1Database): Promise<void> {
  if (!boothSchemaReady) {
    boothSchemaReady = (async () => {
      await ensurePlaceAndBackupTables(db)
      await ensureBoothManagementTables(db)
    })().catch((err) => {
      boothSchemaReady = null
      throw err
    })
  }
  return boothSchemaReady
}

export function ensureVotersSchema(db: D1Database): Promise<void> {
  if (!votersSchemaReady) {
    votersSchemaReady = (async () => {
      await dropRetiredColumns(db, 'voters', [
        'rental_owner',
        'rental_address',
        'rental_part_no',
        'description',
      ])
      await addMissingColumns(db, 'voters', [
        { name: 'parked_address', ddl: 'parked_address TEXT' },
        { name: 'presence_status', ddl: 'presence_status TEXT' },
        { name: 'presence_note', ddl: 'presence_note TEXT' },
        { name: 'is_active', ddl: 'is_active INTEGER DEFAULT 1' },
        { name: 'disabled_at', ddl: 'disabled_at TEXT' },
        { name: 'disabled_reason', ddl: 'disabled_reason TEXT' },
      ])
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_voters_is_active ON voters(is_active)').run()
      await ensureVoterCategoryAllowsDiscussion(db)
      await addMissingColumns(db, 'team_leaders', [
        { name: 'display_name', ddl: 'display_name TEXT' },
      ])
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_by TEXT REFERENCES users(id)
        )
      `).run()
      await ensurePlaceAndBackupTables(db)
      await ensureBoothManagementTables(db)
      await migrateRetiredVoterCategories(db)
    })().catch((err) => {
      votersSchemaReady = null
      throw err
    })
  }
  return votersSchemaReady
}
