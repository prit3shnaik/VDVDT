import type { D1Database } from '@cloudflare/workers-types'

/**
 * Narrow, idempotent column guard.
 *
 * The SaaS baseline lives in docs/d1/001_schema.sql. Schema changes that need a
 * table rebuild (CHECK changes, column type changes) belong in an explicit
 * numbered migration, never in a per-request path. This helper only adds the
 * handful of optional columns that older deployments may lack.
 */

let votersSchemaReady: Promise<void> | null = null

async function existingColumns(db: D1Database, table: string): Promise<Set<string>> {
  try {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
    return new Set((results ?? []).map((row) => row.name))
  } catch {
    return new Set()
  }
}

async function addMissingColumns(
  db: D1Database,
  table: string,
  columns: Array<{ name: string; ddl: string }>,
): Promise<void> {
  const present = await existingColumns(db, table)
  if (present.size === 0) return // table not created yet; migrations own creation
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

export function ensureVotersSchema(db: D1Database): Promise<void> {
  if (!votersSchemaReady) {
    votersSchemaReady = (async () => {
      await addMissingColumns(db, 'voters', [
        { name: 'parked_address', ddl: 'parked_address TEXT' },
        { name: 'presence_status', ddl: 'presence_status TEXT' },
        { name: 'presence_note', ddl: 'presence_note TEXT' },
        { name: 'is_active', ddl: 'is_active INTEGER DEFAULT 1' },
        { name: 'disabled_at', ddl: 'disabled_at TEXT' },
        { name: 'disabled_reason', ddl: 'disabled_reason TEXT' },
      ])
      await addMissingColumns(db, 'team_leaders', [
        { name: 'display_name', ddl: 'display_name TEXT' },
        { name: 'bucket_code', ddl: 'bucket_code TEXT' },
      ])
    })().catch((err) => {
      votersSchemaReady = null
      throw err
    })
  }
  return votersSchemaReady
}

/** Compatibility alias: booth tables are part of the SaaS baseline. */
export function ensureBoothSchema(db: D1Database): Promise<void> {
  return ensureVotersSchema(db)
}
