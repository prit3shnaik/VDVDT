import { Hono } from 'hono'
import type { Env } from '../env'
import { platformDb } from '../env'
import { requireUser, requireWorkspace, type AuthedVars } from '../middleware/auth'
import {
  TABLE_POLICIES,
  decodeRow,
  encodeRow,
  satisfies,
  scopeClause,
  type TablePolicy,
} from '../lib/rest-policy'
import {
  RestQueryError,
  assertIdentifier,
  parseFilters,
  parseOrder,
  parseRange,
  parseSelect,
} from '../lib/rest-query'
import { ensureVotersSchema } from '../lib/schema-ensure'
import { ACTIVE_VOTER_SQL } from '../lib/voter-active'
import { assertCategoryCode, assertPresenceCode, WorkspaceConfigError } from '../lib/workspace-config'

export const rest = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

const MAX_ROWS = 20000
const MAX_D1_BINDS = 98

function resolvePolicy(table: string): TablePolicy {
  const policy = TABLE_POLICIES[table]
  // Allowlist: anything not explicitly listed is invisible through the shim.
  if (!policy) throw new RestQueryError(`Unknown or forbidden table: ${table}`)
  // Defense in depth: every campaign table must be workspace-scoped.
  if (policy.workspaceScope !== 'required') {
    throw new RestQueryError(`Table is not workspace-scoped: ${table}`)
  }
  return policy
}

function combine(parts: Array<{ clause: string; params: unknown[] }>) {
  const active = parts.filter((p) => p.clause)
  return {
    where: active.length ? `WHERE ${active.map((p) => p.clause).join(' AND ')}` : '',
    params: active.flatMap((p) => p.params),
  }
}

/** Adapts a parsed filter Condition to the shape combine() expects. */
function asClause(condition: { sql: string; params: unknown[] }) {
  return { clause: condition.sql, params: condition.params }
}

/** PostgREST returns a bare object (not an array) for single-row requests. */
function wantsSingle(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const accept = c.req.header('accept') ?? ''
  return accept.includes('application/vnd.pgrst.object+json')
}

function prefers(header: string | undefined, token: string): boolean {
  return (header ?? '').includes(token)
}

function guardColumns(policy: TablePolicy, row: Record<string, unknown>): void {
  for (const column of Object.keys(row)) {
    assertIdentifier(column)
    // Ownership columns are server-owned, never client-writable.
    if (column === 'org_id' || column === 'workspace_id') {
      throw new RestQueryError(`Column is not writable: ${column}`)
    }
    if (policy.immutableColumns?.includes(column)) {
      throw new RestQueryError(`Column is not writable: ${column}`)
    }
  }
}

async function validateVoterConfig(
  c: { env: Env; get: (key: 'profile') => AuthedVars['profile'] },
  row: Record<string, unknown>,
): Promise<void> {
  const profile = c.get('profile')
  if (!profile.workspace_id) return
  const platform = platformDb(c.env)
  if (row.voter_category !== undefined) {
    await assertCategoryCode(platform, profile.workspace_id, row.voter_category)
  }
  if (row.presence_status !== undefined) {
    await assertPresenceCode(platform, profile.workspace_id, row.presence_status)
  }
}

rest.all('/rest/v1/:table', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  const table = c.req.param('table') ?? ''
  const method = c.req.method
  const url = new URL(c.req.url)

  try {
    assertIdentifier(table)
    if (
      table === 'voters' ||
      table === 'team_leaders' ||
      table === 'place_clubs' ||
      table === 'family_place_clubs' ||
      table === 'shifted_parking_backup'
    ) {
      await ensureVotersSchema(c.env.DB)
    }
    const policy = resolvePolicy(table)

    const needed = method === 'GET' || method === 'HEAD' ? policy.read : policy.write
    if (needed === 'deny') {
      return c.json({ message: 'Table is read-only' }, 403)
    }
    if (!satisfies(profile, needed)) {
      return c.json({ message: 'Forbidden' }, 403)
    }

    // SECURITY: workspace predicate first, then ward ACL, then client filters.
    const scope = scopeClause(profile, policy)
    const filters = parseFilters(url.searchParams)
    const preferHeader = c.req.header('prefer')
    const includeInactive = url.searchParams.get('is_active') != null
    const activeOnly =
      table === 'voters' && !includeInactive
        ? { clause: ACTIVE_VOTER_SQL, params: [] as unknown[] }
        : { clause: '', params: [] as unknown[] }

    // ---------- READ ----------
    if (method === 'GET' || method === 'HEAD') {
      const columns = parseSelect(url.searchParams.get('select'))
      const { where, params } = combine([asClause(filters), scope, activeOnly])
      const order = parseOrder(url.searchParams.get('order'))
      const { limit, offset } = parseRange(c.req.header('range') ?? null, url.searchParams, MAX_ROWS)

      if (params.length + 2 > MAX_D1_BINDS) {
        throw new RestQueryError(
          `Too many bound parameters (${params.length + 2}). Split IN() filters into chunks of 80 or fewer.`,
        )
      }

      const sql = `SELECT ${columns} FROM ${table} ${where}${order ? ` ORDER BY ${order}` : ''} LIMIT ? OFFSET ?`
      const { results } = await c.env.DB.prepare(sql)
        .bind(...params, limit, offset)
        .all()

      const rows = (results ?? []).map((row) => decodeRow(policy, row as Record<string, unknown>))
      if (wantsSingle(c)) {
        if (rows.length === 0) return c.json(null)
        return c.json(rows[0])
      }

      // supabase-js reads the total from Content-Range for .count queries.
      return c.json(rows, 200, {
        'Content-Range': `${offset}-${offset + rows.length - 1}/*`,
      })
    }

    // ---------- INSERT / UPSERT ----------
    if (method === 'POST') {
      const body = await c.req.json<Record<string, unknown> | Record<string, unknown>[]>()
      const incoming = Array.isArray(body) ? body : [body]
      if (incoming.length === 0) return c.json([], 201)

      for (const row of incoming) {
        guardColumns(policy, row)
        if (table === 'voters') await validateVoterConfig(c, row)
      }
      const rows = incoming.map((row) => {
        const encoded = encodeRow(policy, row)
        if (policy.autoId !== false && (encoded.id == null || encoded.id === '')) encoded.id = crypto.randomUUID()
        // Server-owned ownership columns, injected from the session.
        encoded.org_id = workspace.org_id
        encoded.workspace_id = workspace.id
        return encoded
      })

      const onConflict = url.searchParams.get('on_conflict')
      const merge = prefers(preferHeader, 'resolution=merge-duplicates')
      const wantRepresentation = prefers(preferHeader, 'return=representation')

      const statements = rows.map((row) => {
        const columns = Object.keys(row)
        if (columns.length === 0) throw new RestQueryError('Cannot insert an empty row')
        const placeholders = columns.map(() => '?').join(',')
        let sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`

        if (merge) {
          const conflictColumns = (onConflict ?? 'id')
            .split(',')
            .map((col) => assertIdentifier(col.trim()))
          const updatable = columns.filter(
            (col) => !conflictColumns.includes(col) && col !== 'org_id' && col !== 'workspace_id',
          )
          sql += updatable.length
            ? ` ON CONFLICT(${conflictColumns.join(',')}) DO UPDATE SET ${updatable
                .map((col) => `${col} = excluded.${col}`)
                .join(', ')}`
            : ` ON CONFLICT(${conflictColumns.join(',')}) DO NOTHING`
        }

        if (wantRepresentation) sql += ' RETURNING *'

        return c.env.DB.prepare(sql).bind(...columns.map((col) => row[col] ?? null))
      })

      const batchResults = await c.env.DB.batch(statements)

      if (!wantRepresentation) return c.body(null, 201)

      const returned = batchResults.flatMap((result) =>
        ((result.results ?? []) as Record<string, unknown>[]).map((row) => decodeRow(policy, row)),
      )
      const payload = returned.length ? returned : rows.map((row) => decodeRow(policy, row))
      if (wantsSingle(c)) return c.json(payload[0] ?? null, 201)
      return c.json(Array.isArray(body) ? payload : payload[0] ?? null, 201)
    }

    // ---------- UPDATE ----------
    if (method === 'PATCH') {
      const incoming = await c.req.json<Record<string, unknown>>()
      guardColumns(policy, incoming)
      if (table === 'voters') await validateVoterConfig(c, incoming)
      const row = encodeRow(policy, incoming)

      const columns = Object.keys(row)
      if (columns.length === 0) return c.json([], 200)

      // An unfiltered UPDATE would rewrite the whole table; refuse it.
      if (!filters.sql) {
        return c.json({ message: 'PATCH requires a filter' }, 400)
      }

      if (table === 'voters' && row.epic_no !== undefined) {
        const epic = String(row.epic_no ?? '').trim()
        if (!epic) return c.json({ message: 'EPIC number is required.' }, 400)
        row.epic_no = epic
        const conflict = await c.env.DB.prepare(
          `SELECT id FROM voters
           WHERE workspace_id = ? AND epic_no = ?${filters.sql ? ` AND NOT (${filters.sql})` : ''}
           LIMIT 1`,
        )
          .bind(workspace.id, epic, ...filters.params)
          .first()
        if (conflict) {
          return c.json({ message: `EPIC number ${epic} already belongs to another voter in this workspace.` }, 409)
        }
      }

      const { where, params } = combine([asClause(filters), scope])
      if (columns.length + params.length > MAX_D1_BINDS) {
        throw new RestQueryError(
          `Too many bound parameters (${columns.length + params.length}). Split IN() filters into chunks of 80 or fewer.`,
        )
      }
      const wantRepresentation = prefers(preferHeader, 'return=representation')
      const sql = `UPDATE ${table} SET ${columns.map((col) => `${col} = ?`).join(', ')} ${where}${wantRepresentation ? ' RETURNING *' : ''}`

      const result = await c.env.DB.prepare(sql)
        .bind(...columns.map((col) => row[col] ?? null), ...params)
        .all()

      if (!wantRepresentation) return c.body(null, 204)
      const payload = ((result.results ?? []) as Record<string, unknown>[]).map((item) => decodeRow(policy, item))
      if (wantsSingle(c)) {
        return payload[0] ? c.json(payload[0], 200) : c.json({ message: 'No rows updated' }, 404)
      }
      return c.json(payload, 200)
    }

    // ---------- DELETE ----------
    if (method === 'DELETE') {
      // An unfiltered DELETE would empty the table; refuse it.
      if (!filters.sql) {
        return c.json({ message: 'DELETE requires a filter' }, 400)
      }

      const { where, params } = combine([asClause(filters), scope])
      if (params.length > MAX_D1_BINDS) {
        throw new RestQueryError(
          `Too many bound parameters (${params.length}). Split IN() filters into chunks of 80 or fewer.`,
        )
      }
      await c.env.DB.prepare(`DELETE FROM ${table} ${where}`).bind(...params).run()

      return c.body(null, 204)
    }

    return c.json({ message: 'Method not allowed' }, 405)
  } catch (err) {
    if (err instanceof RestQueryError || err instanceof WorkspaceConfigError) {
      return c.json({ message: err.message }, 400)
    }
    const detail = err instanceof Error ? err.message : String(err)
    if (
      table === 'voters' &&
      detail.includes('UNIQUE constraint failed: voters.workspace_id, voters.epic_no')
    ) {
      return c.json({ message: 'That EPIC number already belongs to another voter in this workspace.' }, 409)
    }
    console.error(`[rest] ${method} ${table} failed`, err)
    return c.json({ message: detail || 'Query failed' }, 500)
  }
})

/** Only the specific RPCs the app relies on are exposed. */
rest.post('/rest/v1/rpc/:fn', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  const fn = c.req.param('fn')

  if (fn === 'refresh_dashboard_stats') {
    if (!satisfies(profile, 'admin')) {
      return c.json({ message: 'Forbidden' }, 403)
    }
    const { refreshDashboardStats } = await import('../lib/dashboard-stats')
    await refreshDashboardStats(c.env.DB, workspace.id, workspace.org_id)
    return c.json(null)
  }

  return c.json({ message: `Unknown function: ${fn}` }, 400)
})
