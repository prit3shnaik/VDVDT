import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireWorkspace, wardFilter, type AuthedVars } from '../middleware/auth'
import { logActivity } from './activity-logs'
import { ensureVotersSchema } from '../lib/schema-ensure'
import { activeVoterSql } from '../lib/voter-active'
import {
  canWrite,
  landlordWardClause,
  likePattern,
  loadLandlordsByIds,
  loadScopedLandlord,
  loadTenantCounts,
  loadVotersByEpics,
  normalizeEpic,
  numericParam,
  optionalText,
  queryVoterCandidates,
  tenantWardClause,
  type LandlordWithVoter,
  type Profile,
  type VoterRow,
} from '../lib/tenant-landlords'

export const tenants = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

const MAX_LIST = 500
const MAX_SEARCH = 20

interface TenantLinkRow {
  id: string
  landlord_id: string
  tenant_epic: string
  room_no: string | null
  notes: string | null
  created_at: string
  created_by: string | null
  updated_at: string
}

const EMPTY_COUNTS = { landlords: 0, tenants: 0, unlinked: 0, onRoll: 0, offRoll: 0 }

async function loadScopedTenantVoter(db: Env['DB'], profile: Profile, epic: string): Promise<VoterRow | null> {
  const { clause, params } = wardFilter(profile)
  return db
    .prepare(`SELECT * FROM voters WHERE epic_no = ? AND COALESCE(is_active, 1) = 1 AND ${clause}`)
    .bind(epic, ...params)
    .first<VoterRow>()
}

async function loadLink(db: Env['DB'], id: string, workspaceId: string): Promise<TenantLinkRow | null> {
  return db.prepare('SELECT * FROM tenant_links WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).first<TenantLinkRow>()
}

tenants.get('/api/tenants', requireUser, requireWorkspace, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  const url = new URL(c.req.url)
  const q = (url.searchParams.get('q') ?? '').trim()
  const ward = numericParam(url.searchParams.get('ward_no'))
  const part = numericParam(url.searchParams.get('part_no'))
  const section = numericParam(url.searchParams.get('section'))
  const house = (url.searchParams.get('house_no') ?? '').trim()
  const landlordId = (url.searchParams.get('landlord_id') ?? '').trim()
  const kind = (url.searchParams.get('kind') ?? 'all').toLowerCase()
  const unlinked = url.searchParams.get('unlinked') === '1'
  const assignableTo = (url.searchParams.get('assignable_to') ?? '').trim()
  const limit = Math.min(Number(url.searchParams.get('limit') ?? MAX_LIST) || MAX_LIST, MAX_LIST)

  if (assignableTo) {
    const landlord = await loadScopedLandlord(c.env.DB, profile, assignableTo)
    if (!landlord) return c.json({ error: 'Landlord not found in your wards.' }, 404)
    const voters = await queryVoterCandidates(c.env.DB, profile, {
      excludeVoterId: landlord.voter_id,
      excludeTenants: true,
      excludeLandlords: true,
      q,
      ward,
      part,
      section,
      house,
      limit: Math.min(limit, MAX_SEARCH),
    })
    return c.json({ links: [], voters, counts: EMPTY_COUNTS })
  }

  if (unlinked) {
    const voters = await queryVoterCandidates(c.env.DB, profile, {
      excludeTenants: true,
      excludeLandlords: false,
      q,
      ward,
      part,
      section,
      house,
      limit,
    })
    const counts = await loadTenantCounts(c.env.DB, profile)
    return c.json({ links: [], voters, counts })
  }

  const tenantWard = tenantWardClause(profile, 'te')
  const landlordWard = landlordWardClause(profile)
  const conditions = [activeVoterSql('te'), tenantWard.clause, landlordWard.clause]
  const params: unknown[] = [...tenantWard.params, ...landlordWard.params]

  if (landlordId) {
    conditions.push('t.landlord_id = ?')
    params.push(landlordId)
  }
  if (kind === 'on_roll') conditions.push('l.voter_id IS NOT NULL')
  else if (kind === 'off_roll') conditions.push('l.voter_id IS NULL')

  if (ward != null) {
    conditions.push('COALESCE(v.ward_no, l.ward_no) = ?')
    params.push(ward)
  }
  if (part != null) {
    conditions.push('COALESCE(v.part_no, l.part_no) = ?')
    params.push(part)
  }
  if (section != null) {
    conditions.push('COALESCE(v.section, l.section) = ?')
    params.push(section)
  }
  if (house) {
    conditions.push('COALESCE(v.house_no, l.house_no) = ?')
    params.push(house)
  }
  for (const token of q.split(/\s+/).filter(Boolean)) {
    const like = likePattern(token)
    conditions.push('(l.display_name LIKE ? OR l.house_no LIKE ? OR l.contact LIKE ? OR v.name LIKE ? OR v.epic_no LIKE ? OR v.house_no LIKE ? OR te.name LIKE ? OR te.epic_no LIKE ? OR t.room_no LIKE ? OR te.relative_name LIKE ?)')
    params.push(like, like, like, like, like, like, like, like, like, like)
  }

  const { results } = await c.env.DB
    .prepare(`
      SELECT t.* FROM tenant_links t
      JOIN landlords l ON l.id = t.landlord_id AND l.workspace_id = t.workspace_id
      LEFT JOIN voters v ON v.id = l.voter_id AND v.workspace_id = l.workspace_id
      JOIN voters te ON te.epic_no = t.tenant_epic AND te.workspace_id = t.workspace_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY l.display_name COLLATE NOCASE ASC, te.name COLLATE NOCASE ASC
      LIMIT ?
    `)
    .bind(...params, limit)
    .all<TenantLinkRow>()

  const rows = results ?? []
  const landlordMap = await loadLandlordsByIds(c.env.DB, rows.map((row) => row.landlord_id), c.get('workspace')!.id)
  const tenantMap = await loadVotersByEpics(c.env.DB, rows.map((row) => row.tenant_epic), c.get('workspace')!.id)
  const links: Array<TenantLinkRow & { landlord: LandlordWithVoter; tenant: VoterRow }> = []
  for (const row of rows) {
    const landlord = landlordMap.get(row.landlord_id)
    const tenant = tenantMap.get(row.tenant_epic)
    if (landlord && tenant) links.push({ ...row, landlord, tenant })
  }

  const counts = await loadTenantCounts(c.env.DB, profile)
  return c.json({ links, voters: [], counts })
})

tenants.post('/api/tenants', requireUser, requireWorkspace, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const landlordId = (typeof body.landlord_id === 'string' ? body.landlord_id.trim() : '')
  const tenantEpic = normalizeEpic(body.tenant_epic)
  if (!landlordId || !tenantEpic) {
    return c.json({ error: 'Landlord and tenant EPIC are required.' }, 400)
  }

  const landlord = await loadScopedLandlord(c.env.DB, profile, landlordId)
  if (!landlord) return c.json({ error: 'Landlord not found in your wards.' }, 400)
  const tenant = await loadScopedTenantVoter(c.env.DB, profile, tenantEpic)
  if (!tenant) return c.json({ error: 'Tenant not found in your wards.' }, 400)
  if (landlord.voter_id && landlord.voter_id === tenant.id) {
    return c.json({ error: 'A voter cannot be their own tenant.' }, 400)
  }

  const workspace = c.get('workspace')!
  const tenantAsLandlord = await c.env.DB
    .prepare('SELECT 1 FROM landlords WHERE workspace_id = ? AND voter_id = ?')
    .bind(workspace.id, tenant.id)
    .first()
  if (tenantAsLandlord) {
    return c.json({ error: 'This voter is already a landlord. A voter cannot be both landlord and tenant.' }, 409)
  }

  const existing = await c.env.DB
    .prepare('SELECT 1 FROM tenant_links WHERE workspace_id = ? AND tenant_epic = ?')
    .bind(workspace.id, tenantEpic)
    .first()
  if (existing) return c.json({ error: 'This voter is already a tenant.' }, 409)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  try {
    await c.env.DB
      .prepare(`
        INSERT INTO tenant_links (id, org_id, workspace_id, landlord_id, tenant_epic, room_no, notes, created_at, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        workspace.org_id,
        workspace.id,
        landlordId,
        tenantEpic,
        optionalText(body.room_no),
        optionalText(body.notes),
        now,
        profile.id,
        now,
      )
      .run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/unique/i.test(message)) return c.json({ error: 'This voter is already a tenant.' }, 409)
    throw err
  }

  await logActivity(c.env, c.get('workspace'), profile.id, 'tenant_link_add', 'tenant_links', id, {
    landlord_id: landlordId,
    tenant_epic: tenantEpic,
  })

  const link = await c.env.DB.prepare('SELECT * FROM tenant_links WHERE workspace_id = ? AND id = ?').bind(workspace.id, id).first<TenantLinkRow>()
  return c.json({ link }, 201)
})

tenants.patch('/api/tenants/:id', requireUser, requireWorkspace, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const id = c.req.param('id') ?? ''
  const link = await loadLink(c.env.DB, id, c.get('workspace')!.id)
  if (!link) return c.json({ error: 'Not found' }, 404)

  const currentLandlord = await loadScopedLandlord(c.env.DB, profile, link.landlord_id)
  const tenant = await loadScopedTenantVoter(c.env.DB, profile, link.tenant_epic)
  if (!currentLandlord || !tenant) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const updates: string[] = []
  const values: unknown[] = []
  let moved = false

  if ('landlord_id' in body) {
    const nextLandlordId = typeof body.landlord_id === 'string' ? body.landlord_id.trim() : ''
    if (!nextLandlordId) return c.json({ error: 'Landlord is required.' }, 400)
    if (nextLandlordId !== link.landlord_id) {
      const nextLandlord = await loadScopedLandlord(c.env.DB, profile, nextLandlordId)
      if (!nextLandlord) return c.json({ error: 'Landlord not found in your wards.' }, 400)
      if (nextLandlord.voter_id && nextLandlord.voter_id === tenant.id) {
        return c.json({ error: 'A voter cannot be their own tenant.' }, 400)
      }
      updates.push('landlord_id = ?')
      values.push(nextLandlordId)
      moved = true
    }
  }

  if ('room_no' in body) {
    updates.push('room_no = ?')
    values.push(optionalText(body.room_no))
  }
  if ('notes' in body) {
    updates.push('notes = ?')
    values.push(optionalText(body.notes))
  }

  if (!updates.length) return c.json({ error: 'No fields to update.' }, 400)

  updates.push('updated_at = ?')
  values.push(new Date().toISOString())
  await c.env.DB.prepare(`UPDATE tenant_links SET ${updates.join(', ')} WHERE workspace_id = ? AND id = ?`).bind(...values, c.get('workspace')!.id, id).run()

  await logActivity(
    c.env,
    c.get('workspace'),
    profile.id,
    moved ? 'tenant_link_move' : 'tenant_link_update',
    'tenant_links',
    id,
    {
      landlord_id: link.landlord_id,
      tenant_epic: link.tenant_epic,
      ...(moved ? { moved_to: typeof body.landlord_id === 'string' ? body.landlord_id.trim() : null } : {}),
    },
  )

  return c.json({ ok: true })
})

tenants.delete('/api/tenants/:id', requireUser, requireWorkspace, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const id = c.req.param('id') ?? ''
  const link = await loadLink(c.env.DB, id, c.get('workspace')!.id)
  if (!link) return c.json({ error: 'Not found' }, 404)

  const landlord = await loadScopedLandlord(c.env.DB, profile, link.landlord_id)
  const tenant = await loadScopedTenantVoter(c.env.DB, profile, link.tenant_epic)
  if (!landlord || !tenant) return c.json({ error: 'Not found' }, 404)

  await c.env.DB.prepare('DELETE FROM tenant_links WHERE workspace_id = ? AND id = ?').bind(c.get('workspace')!.id, id).run()
  await logActivity(c.env, c.get('workspace'), profile.id, 'tenant_link_remove', 'tenant_links', id, {
    landlord_id: link.landlord_id,
    tenant_epic: link.tenant_epic,
  })

  return c.body(null, 204)
})
