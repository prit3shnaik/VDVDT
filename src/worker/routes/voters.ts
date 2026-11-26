import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireWorkspace, wardFilter, type AuthedVars } from '../middleware/auth'
import { assertCategoryCode, assertPresenceCode } from '../lib/workspace-config'
import { logActivity } from './activity-logs'
import { refreshDashboardStats } from '../lib/dashboard-stats'
import { ensureVotersSchema } from '../lib/schema-ensure'
import {
  BULK_DELETE_MAX_EPICS,
  executeBulkDelete,
  parseEpicList,
  planBulkDelete,
  previewPayload,
} from '../lib/bulk-delete-voters'
import {
  BULK_DISABLE_MAX_EPICS,
  disablePreviewPayload,
  executeBulkDisable,
  executeBulkEnable,
  planBulkDisable,
  planBulkEnable,
} from '../lib/bulk-disable-voters'
import { ACTIVE_VOTER_SQL, activeVoterSql, inactiveVoterSql } from '../lib/voter-active'

export const voters = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

const MAX_LIMIT = 500

function canWrite(profile: AuthedVars['profile']): boolean {
  return profile.role === 'admin' || profile.role === 'sub-admin' || profile.can_edit
}

async function epicTaken(db: Env['DB'], epic: string, workspaceId: string, excludeId?: string): Promise<boolean> {
  const row = excludeId
    ? await db.prepare('SELECT id FROM voters WHERE workspace_id = ? AND epic_no = ? AND id <> ? LIMIT 1').bind(workspaceId, epic, excludeId).first()
    : await db.prepare('SELECT id FROM voters WHERE workspace_id = ? AND epic_no = ? LIMIT 1').bind(workspaceId, epic).first()
  return Boolean(row)
}

/**
 * Change stamp for the voters table, maintained by triggers (docs/d1/005_dataset_version.sql).
 * Clients cache the full roll locally and call this to decide whether a refetch is
 * needed, turning a ~16k-row revalidation into a single row read.
 */
voters.get('/api/voters/version', requireUser, requireWorkspace, async (c) => {
  const workspace = c.get('workspace')!
  const row = await c.env.DB.prepare(
    "SELECT version, row_count, updated_at FROM dataset_version WHERE workspace_id = ? AND table_name = 'voters'"
  ).bind(workspace.id).first<{ version: number; row_count: number; updated_at: string }>()

  return c.json(
    { version: row?.version ?? 0, rowCount: row?.row_count ?? 0, updatedAt: row?.updated_at ?? null },
    200,
    { 'Cache-Control': 'no-store' }
  )
})

// List/search voters. Ward ACL applied server-side; the SPA no longer pulls the whole table.
voters.get('/api/voters', requireUser, requireWorkspace, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  const url = new URL(c.req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, MAX_LIMIT)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
  const q = url.searchParams.get('q')?.trim()
  const ward = url.searchParams.get('ward')
  const part = url.searchParams.get('part')

  const includeInactive = url.searchParams.get('include_inactive') === '1'
  const plainScope = wardFilter(profile)
  const aliasedScope = wardFilter(profile, 'v')

  let sql: string
  let params: unknown[]
  if (q) {
    // FTS5 prefix match; quote to keep user input from being parsed as MATCH syntax.
    const matchQuery = `"${q.replaceAll('"', '""')}"*`
    const conditions = [aliasedScope.clause]
    params = [...aliasedScope.params]
    if (!includeInactive) conditions.push('v.is_active IS NOT 0')
    if (ward) {
      conditions.push('v.ward_no = ?')
      params.push(Number(ward))
    }
    if (part) {
      conditions.push('v.part_no = ?')
      params.push(Number(part))
    }
    sql = `SELECT v.* FROM voters v JOIN voters_fts f ON f.rowid = v.rowid
           WHERE voters_fts MATCH ? AND ${conditions.join(' AND ')}
           ORDER BY v.updated_at DESC LIMIT ? OFFSET ?`
    params.unshift(matchQuery)
  } else {
    const conditions = [plainScope.clause]
    params = [...plainScope.params]
    if (!includeInactive) conditions.push(ACTIVE_VOTER_SQL)
    if (ward) {
      conditions.push('ward_no = ?')
      params.push(Number(ward))
    }
    if (part) {
      conditions.push('part_no = ?')
      params.push(Number(part))
    }
    sql = `SELECT * FROM voters WHERE ${conditions.join(' AND ')}
           ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  }
  params.push(limit, offset)

  const { results } = await c.env.DB.prepare(sql).bind(...params).all()
  return c.json({ voters: results })
})

voters.get('/api/voters/disabled', requireUser, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  const url = new URL(c.req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 2000) || 2000, 5000)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
  const q = url.searchParams.get('q')?.trim()
  const part = url.searchParams.get('part')

  const { clause: wardClause, params: wardParams } = wardFilter(profile)
  const conditions = [inactiveVoterSql('v'), wardClause.replaceAll('ward_no', 'v.ward_no')]
  const params: unknown[] = [...wardParams]

  if (part) {
    conditions.push('v.part_no = ?')
    params.push(Number(part))
  }
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`
    conditions.push('(v.name LIKE ? OR v.epic_no LIKE ? OR v.family_head_epic LIKE ? OR v.relative_name LIKE ? OR v.family_label LIKE ?)')
    params.push(like, like, like, like, like)
  }

  const where = conditions.join(' AND ')
  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM voters v WHERE ${where}`)
    .bind(...params)
    .first<{ c: number }>()

  const sql = `SELECT
      v.id,
      v.epic_no,
      v.name,
      v.relative_name,
      v.relative_relation,
      v.ward_no,
      v.part_no,
      v.section,
      v.section_name,
      v.house_no,
      v.age,
      v.gender,
      v.photo_url,
      v.family_head_epic,
      v.family_label,
      v.disabled_at,
      v.disabled_reason,
      COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no) AS family_key,
      fh.name AS family_head_name,
      COALESCE(fam.family_size, 1) AS family_size,
      a.team_leader_id,
      tl.notes AS team_leader_notes,
      tl.display_name AS team_leader_display_name,
      tl.part_no AS team_leader_part_no,
      lv.name AS team_leader_voter_name,
      lv.epic_no AS team_leader_epic_no
    FROM voters v
    LEFT JOIN team_leader_assignments a ON a.voter_id = v.id
    LEFT JOIN team_leaders tl ON tl.id = a.team_leader_id
    LEFT JOIN voters lv ON lv.id = tl.voter_id
    LEFT JOIN voters fh ON fh.epic_no = COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no)
    LEFT JOIN (
      SELECT COALESCE(NULLIF(TRIM(family_head_epic), ''), epic_no) AS family_key, COUNT(*) AS family_size
      FROM voters
      GROUP BY 1
    ) fam ON fam.family_key = COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no)
    WHERE ${where}
    ORDER BY v.disabled_at DESC, v.name ASC
    LIMIT ? OFFSET ?`

  const { results } = await c.env.DB.prepare(sql).bind(...params, limit, offset).all()
  return c.json({ voters: results ?? [], total: countRow?.c ?? 0 })
})

voters.get('/api/voters/missing-photos', requireUser, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  const url = new URL(c.req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 2000) || 2000, 5000)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
  const q = url.searchParams.get('q')?.trim()
  const part = url.searchParams.get('part')

  const today = new Date()
  const defaultTo = today.toISOString().slice(0, 10)
  const defaultFromDate = new Date(today)
  defaultFromDate.setUTCDate(defaultFromDate.getUTCDate() - 6)
  const defaultFrom = defaultFromDate.toISOString().slice(0, 10)
  const isoDate = (value: string | null, fallback: string) =>
    value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback
  let from = isoDate(url.searchParams.get('from'), defaultFrom)
  let to = isoDate(url.searchParams.get('to'), defaultTo)
  if (from > to) {
    const swapped = from
    from = to
    to = swapped
  }

  const { clause: wardClause, params: wardParams } = wardFilter(profile)
  const conditions = [
    activeVoterSql('v'),
    "(v.photo_url IS NULL OR TRIM(v.photo_url) = '')",
    'date(v.created_at) BETWEEN ? AND ?',
    wardClause.replaceAll('ward_no', 'v.ward_no'),
  ]
  const params: unknown[] = [from, to, ...wardParams]

  if (part) {
    conditions.push('v.part_no = ?')
    params.push(Number(part))
  }
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`
    conditions.push('(v.name LIKE ? OR v.epic_no LIKE ? OR v.family_head_epic LIKE ? OR v.relative_name LIKE ? OR v.family_label LIKE ?)')
    params.push(like, like, like, like, like)
  }

  const where = conditions.join(' AND ')
  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM voters v WHERE ${where}`)
    .bind(...params)
    .first<{ c: number }>()

  const sql = `SELECT
      v.id,
      v.epic_no,
      v.name,
      v.relative_name,
      v.relative_relation,
      v.ward_no,
      v.part_no,
      v.section,
      v.section_name,
      v.house_no,
      v.age,
      v.gender,
      v.photo_url,
      v.family_head_epic,
      v.family_label,
      v.created_at,
      COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no) AS family_key,
      fh.name AS family_head_name,
      COALESCE(fam.family_size, 1) AS family_size,
      a.team_leader_id,
      tl.notes AS team_leader_notes,
      tl.display_name AS team_leader_display_name,
      tl.part_no AS team_leader_part_no,
      lv.name AS team_leader_voter_name,
      lv.epic_no AS team_leader_epic_no
    FROM voters v
    LEFT JOIN team_leader_assignments a ON a.voter_id = v.id
    LEFT JOIN team_leaders tl ON tl.id = a.team_leader_id
    LEFT JOIN voters lv ON lv.id = tl.voter_id
    LEFT JOIN voters fh ON fh.epic_no = COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no)
    LEFT JOIN (
      SELECT COALESCE(NULLIF(TRIM(family_head_epic), ''), epic_no) AS family_key, COUNT(*) AS family_size
      FROM voters
      GROUP BY 1
    ) fam ON fam.family_key = COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no)
    WHERE ${where}
    ORDER BY v.created_at DESC, v.name ASC
    LIMIT ? OFFSET ?`

  const { results } = await c.env.DB.prepare(sql).bind(...params, limit, offset).all()
  return c.json({ voters: results ?? [], total: countRow?.c ?? 0 })
})

voters.get('/api/voters/:id', requireUser, async (c) => {
  const profile = c.get('profile')
  const { clause, params } = wardFilter(profile)
  const row = await c.env.DB.prepare(`SELECT * FROM voters WHERE id = ? AND ${clause}`)
    .bind(c.req.param('id'), ...params)
    .first()
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ voter: row })
})

const WRITABLE_COLUMNS = [
  'epic_no', 'name', 'relative_name', 'relative_relation', 'section_name', 'ward_no', 'part_no',
  'section', 'sr_no_roll', 'house_no', 'age', 'date_of_birth', 'contact_no_1', 'contact_no_2',
  'gender', 'religion', 'state', 'voter_category', 'family_head_epic', 'family_label',
  'family_color', 'row_color', 'photo_url', 'display_order',
  'parked_address',
  'presence_status', 'presence_note', 'is_active', 'disabled_at', 'disabled_reason',
] as const

voters.post('/api/voters', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<Record<string, unknown>>()
  if (!body.epic_no || !body.name) return c.json({ error: 'epic_no and name are required' }, 400)

  const epic = String(body.epic_no).trim()
  if (!epic) return c.json({ error: 'epic_no and name are required' }, 400)
  if (await epicTaken(c.env.DB, epic, workspace.id)) {
    return c.json({ error: `EPIC number ${epic} already belongs to another voter in this workspace.` }, 409)
  }
  body.epic_no = epic
  await assertCategoryCode(c.env.PLATFORM_DB ?? c.env.DB, workspace.id, body.voter_category)
  await assertPresenceCode(c.env.PLATFORM_DB ?? c.env.DB, workspace.id, body.presence_status)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const cols = ['id', 'org_id', 'workspace_id', ...WRITABLE_COLUMNS, 'created_at', 'updated_at', 'updated_by']
  const values = [id, workspace.org_id, workspace.id, ...WRITABLE_COLUMNS.map((col) => body[col] ?? null), now, now, profile.id]
  const placeholders = cols.map(() => '?').join(',')

  try {
    await c.env.DB.prepare(`INSERT INTO voters (${cols.join(',')}) VALUES (${placeholders})`)
      .bind(...values)
      .run()
  } catch (err) {
    if (String(err).includes('UNIQUE constraint failed: voters.workspace_id, voters.epic_no')) {
      return c.json({ error: `EPIC number ${epic} already belongs to another voter.` }, 409)
    }
    throw err
  }

  return c.json({ id }, 201)
})

voters.patch('/api/voters/:id', requireUser, async (c) => {
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const { clause, params: wardParams } = wardFilter(profile)
  const existing = await c.env.DB.prepare(`SELECT id FROM voters WHERE id = ? AND ${clause}`)
    .bind(c.req.param('id'), ...wardParams)
    .first()
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<Record<string, unknown>>()
  const updates = WRITABLE_COLUMNS.filter((col) => col in body)
  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400)

  if (updates.includes('epic_no')) {
    const epic = String(body.epic_no ?? '').trim()
    if (!epic) return c.json({ error: 'epic_no is required' }, 400)
    if (await epicTaken(c.env.DB, epic, c.get('workspace')!.id, c.req.param('id'))) {
      return c.json({ error: `EPIC number ${epic} already belongs to another voter.` }, 409)
    }
    body.epic_no = epic
  }

  const now = new Date().toISOString()
  const setClause = [...updates.map((col) => `${col} = ?`), 'updated_at = ?', 'updated_by = ?'].join(', ')
  const values = [...updates.map((col) => body[col] ?? null), now, profile.id, c.req.param('id')]

  try {
    await c.env.DB.prepare(`UPDATE voters SET ${setClause} WHERE id = ?`).bind(...values).run()
  } catch (err) {
    if (String(err).includes('UNIQUE constraint failed: voters.workspace_id, voters.epic_no')) {
      return c.json({ error: 'That EPIC number already belongs to another voter.' }, 409)
    }
    throw err
  }
  return c.json({ ok: true })
})

voters.post('/api/voters/bulk-delete/preview', requireUser, async (c) => {
  const profile = c.get('profile')
  if (profile.role !== 'admin' && profile.role !== 'sub-admin') return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{ epics?: unknown }>().catch(() => ({ epics: [] as unknown[] }))
  const epics = parseEpicList(body.epics)
  if (!epics.length) return c.json({ error: 'Paste at least one EPIC number.' }, 400)
  if (epics.length > BULK_DELETE_MAX_EPICS) {
    return c.json({ error: `At most ${BULK_DELETE_MAX_EPICS} EPICs per request.` }, 400)
  }

  await ensureVotersSchema(c.env.DB)
  const plan = await planBulkDelete(c.env.DB, epics, wardFilter(profile))
  return c.json(previewPayload(plan))
})

voters.post('/api/voters/bulk-delete', requireUser, async (c) => {
  const profile = c.get('profile')
  if (profile.role !== 'admin' && profile.role !== 'sub-admin') return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{ epics?: unknown }>().catch(() => ({ epics: [] as unknown[] }))
  const epics = parseEpicList(body.epics)
  if (!epics.length) return c.json({ error: 'Paste at least one EPIC number.' }, 400)
  if (epics.length > BULK_DELETE_MAX_EPICS) {
    return c.json({ error: `At most ${BULK_DELETE_MAX_EPICS} EPICs per request.` }, 400)
  }

  await ensureVotersSchema(c.env.DB)
  const plan = await planBulkDelete(c.env.DB, epics, wardFilter(profile))
  if (!plan.deleteCount) return c.json({ error: 'None of those EPICs were found.' }, 404)

  await executeBulkDelete(c.env.DB, c.env.PHOTOS, plan)
  await refreshDashboardStats(c.env.DB, profile.workspace_id!, profile.org_id!)
  await logActivity(c.env, c.get('workspace'), profile.id, 'bulk_delete_epics', 'voters', null, {
    requested: plan.requested,
    deleted: plan.deleteCount,
    wholeFamilies: plan.wholeFamilies,
    memberOnly: plan.memberOnly,
    headRewrites: plan.headRewrites,
    epics: plan.deleteVoters.map((row) => row.epic_no),
    notFound: plan.notFound,
  })

  return c.json(previewPayload(plan))
})

voters.post('/api/voters/bulk-disable/preview', requireUser, async (c) => {
  const profile = c.get('profile')
  if (profile.role !== 'admin' && profile.role !== 'sub-admin') return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{ epics?: unknown }>().catch(() => ({ epics: [] as unknown[] }))
  const epics = parseEpicList(body.epics)
  if (!epics.length) return c.json({ error: 'Paste at least one EPIC number.' }, 400)
  if (epics.length > BULK_DISABLE_MAX_EPICS) {
    return c.json({ error: `At most ${BULK_DISABLE_MAX_EPICS} EPICs per request.` }, 400)
  }

  await ensureVotersSchema(c.env.DB)
  const plan = await planBulkDisable(c.env.DB, epics, wardFilter(profile))
  return c.json(disablePreviewPayload(plan, 'disable'))
})

voters.post('/api/voters/bulk-disable', requireUser, async (c) => {
  const profile = c.get('profile')
  if (profile.role !== 'admin' && profile.role !== 'sub-admin') return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{ epics?: unknown; reason?: unknown }>().catch(() => ({ epics: [] as unknown[], reason: undefined as unknown }))
  const epics = parseEpicList(body.epics)
  if (!epics.length) return c.json({ error: 'Paste at least one EPIC number.' }, 400)
  if (epics.length > BULK_DISABLE_MAX_EPICS) {
    return c.json({ error: `At most ${BULK_DISABLE_MAX_EPICS} EPICs per request.` }, 400)
  }

  await ensureVotersSchema(c.env.DB)
  const plan = await planBulkDisable(c.env.DB, epics, wardFilter(profile))
  if (!plan.toChange.length) return c.json({ error: 'None of those EPICs are active.' }, 404)

  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : 'Removed from electoral roll'
  await executeBulkDisable(c.env.DB, plan.toChange.map((row) => row.id), reason, profile.id)
  await refreshDashboardStats(c.env.DB, profile.workspace_id!, profile.org_id!)
  await logActivity(c.env, c.get('workspace'), profile.id, 'bulk_disable_epics', 'voters', null, {
    requested: plan.requested,
    disabled: plan.toChange.length,
    alreadyDisabled: plan.alreadyDisabled.length,
    epics: plan.toChange.map((row) => row.epic_no),
    notFound: plan.notFound,
    reason,
  })

  return c.json(disablePreviewPayload(plan, 'disable'))
})

voters.post('/api/voters/bulk-enable/preview', requireUser, async (c) => {
  const profile = c.get('profile')
  if (profile.role !== 'admin' && profile.role !== 'sub-admin') return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{ epics?: unknown }>().catch(() => ({ epics: [] as unknown[] }))
  const epics = parseEpicList(body.epics)
  if (!epics.length) return c.json({ error: 'Paste at least one EPIC number.' }, 400)
  if (epics.length > BULK_DISABLE_MAX_EPICS) {
    return c.json({ error: `At most ${BULK_DISABLE_MAX_EPICS} EPICs per request.` }, 400)
  }

  await ensureVotersSchema(c.env.DB)
  const plan = await planBulkEnable(c.env.DB, epics, wardFilter(profile))
  return c.json(disablePreviewPayload(plan, 'enable'))
})

voters.post('/api/voters/bulk-enable', requireUser, async (c) => {
  const profile = c.get('profile')
  if (profile.role !== 'admin' && profile.role !== 'sub-admin') return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{ epics?: unknown }>().catch(() => ({ epics: [] as unknown[] }))
  const epics = parseEpicList(body.epics)
  if (!epics.length) return c.json({ error: 'Paste at least one EPIC number.' }, 400)
  if (epics.length > BULK_DISABLE_MAX_EPICS) {
    return c.json({ error: `At most ${BULK_DISABLE_MAX_EPICS} EPICs per request.` }, 400)
  }

  await ensureVotersSchema(c.env.DB)
  const plan = await planBulkEnable(c.env.DB, epics, wardFilter(profile))
  if (!plan.toChange.length) return c.json({ error: 'None of those EPICs are disabled.' }, 404)

  await executeBulkEnable(c.env.DB, plan.toChange.map((row) => row.id), profile.id)
  await refreshDashboardStats(c.env.DB, profile.workspace_id!, profile.org_id!)
  await logActivity(c.env, c.get('workspace'), profile.id, 'bulk_enable_epics', 'voters', null, {
    requested: plan.requested,
    enabled: plan.toChange.length,
    alreadyActive: plan.alreadyDisabled.length,
    epics: plan.toChange.map((row) => row.epic_no),
    notFound: plan.notFound,
  })

  return c.json(disablePreviewPayload(plan, 'enable'))
})

// Admin-only: bulk delete by part (used for corrections), not a full-table wipe endpoint.
voters.delete('/api/voters', requireUser, async (c) => {
  const profile = c.get('profile')
  if (profile.role !== 'admin' && profile.role !== 'sub-admin') return c.json({ error: 'Forbidden' }, 403)

  const url = new URL(c.req.url)
  const part = url.searchParams.get('part')
  if (!part) return c.json({ error: 'part query param is required' }, 400)

  const workspace = c.get('workspace')!
  const result = await c.env.DB.prepare('DELETE FROM voters WHERE workspace_id = ? AND part_no = ?')
    .bind(workspace.id, Number(part))
    .run()
  return c.json({ deleted: result.meta.changes })
})
