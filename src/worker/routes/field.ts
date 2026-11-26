import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../env'
import { requireUser, requireAdmin, requireWorkspace, wardFilter, type AuthedVars } from '../middleware/auth'
import { ensureBoothSchema } from '../lib/schema-ensure'
import { logActivity } from './activity-logs'
import { activeVoterSql } from '../lib/voter-active'

export const field = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

function isAdmin(profile: AuthedVars['profile']): boolean {
  return profile.role === 'admin' || profile.role === 'sub-admin'
}

const geotagSchema = z.object({
  event_id: z.string().min(1),
  family_key: z.string().trim().optional(),
  voter_id: z.string().min(1).optional(),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  accuracy_m: z.number().nullable().optional(),
  altitude: z.number().nullable().optional(),
  address: z.string().trim().nullable().optional(),
  source: z.enum(['gps', 'manual']).optional(),
  note: z.string().trim().nullable().optional(),
  force: z.boolean().optional(),
})

const leaderAssignSchema = z.object({
  team_leader_id: z.string().min(1),
  user_id: z.string().min(1),
})

type LeaderLink = { team_leader_id: string; display_name: string | null; part_no: number | null; section: number | null }

async function loadLeaderLinks(db: Env['DB'], userId: string, workspaceId: string): Promise<LeaderLink[]> {
  const { results } = await db
    .prepare(
      `SELECT tlu.team_leader_id, COALESCE(tl.display_name, v.name) AS display_name, tl.part_no, tl.section
       FROM team_leader_users tlu
       JOIN team_leaders tl ON tl.id = tlu.team_leader_id
       LEFT JOIN voters v ON v.id = tl.voter_id
       WHERE tlu.user_id = ? AND tlu.workspace_id = ?`,
    )
    .bind(userId, workspaceId)
    .all<LeaderLink>()
  return results ?? []
}

function familyKeyOf(voter: { family_head_epic: string | null; epic_no: string }): string {
  const head = (voter.family_head_epic ?? '').trim()
  return head || voter.epic_no.trim()
}

async function resolveFamilyKey(
  db: Env['DB'],
  profile: AuthedVars['profile'],
  voterId?: string,
  familyKey?: string,
): Promise<{ family_key: string; voter_id: string; ward_no: number | null; part_no: number | null } | null> {
  const { clause, params } = wardFilter(profile)
  if (voterId) {
    const row = await db
      .prepare(
        `SELECT id, family_head_epic, epic_no, ward_no, part_no FROM voters WHERE id = ? AND ${clause} AND ${activeVoterSql()}`,
      )
      .bind(voterId, ...params)
      .first<{ id: string; family_head_epic: string | null; epic_no: string; ward_no: number | null; part_no: number | null }>()
    if (!row) return null
    return { family_key: familyKeyOf(row), voter_id: row.id, ward_no: row.ward_no, part_no: row.part_no }
  }
  if (familyKey) {
    const key = familyKey.trim()
    const row = await db
      .prepare(
        `SELECT id, family_head_epic, epic_no, ward_no, part_no FROM voters
         WHERE (epic_no = ? OR family_head_epic = ?) AND ${clause} AND ${activeVoterSql()}
         LIMIT 1`,
      )
      .bind(key, key, ...params)
      .first<{ id: string; family_head_epic: string | null; epic_no: string; ward_no: number | null; part_no: number | null }>()
    if (!row) return null
    return { family_key: familyKeyOf(row), voter_id: row.id, ward_no: row.ward_no, part_no: row.part_no }
  }
  return null
}

async function familyAssignedToLeaders(
  db: Env['DB'],
  familyKey: string,
  leaderIds: string[],
  workspaceId: string,
): Promise<string | null> {
  if (leaderIds.length === 0) return null
  const placeholders = leaderIds.map(() => '?').join(',')
  const row = await db
    .prepare(
      `SELECT a.team_leader_id
       FROM team_leader_assignments a
       JOIN voters v ON v.id = a.voter_id
       WHERE a.workspace_id = ? AND a.team_leader_id IN (${placeholders})
         AND COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no) = ?
       LIMIT 1`,
    )
    .bind(workspaceId, ...leaderIds, familyKey)
    .first<{ team_leader_id: string }>()
  return row?.team_leader_id ?? null
}

field.get('/api/field/me', requireUser, requireWorkspace, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  if (isAdmin(profile)) {
    return c.json({ admin: true, leaders: [] as LeaderLink[] })
  }
  const leaders = await loadLeaderLinks(c.env.DB, profile.id, c.get('workspace')!.id)
  return c.json({ admin: false, leaders })
})

field.post('/api/field/leaders', requireUser, requireWorkspace, requireAdmin, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  const parsed = leaderAssignSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
  const leader = await c.env.DB.prepare('SELECT id FROM team_leaders WHERE workspace_id = ? AND id = ?')
    .bind(workspace.id, parsed.data.team_leader_id)
    .first()
  if (!leader) return c.json({ error: 'Team leader not found' }, 404)
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(parsed.data.user_id).first()
  if (!user) return c.json({ error: 'User not found' }, 404)
  const id = crypto.randomUUID()
  try {
    await c.env.DB.prepare(
      `INSERT INTO team_leader_users (id, org_id, workspace_id, team_leader_id, user_id, assigned_by, assigned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, workspace.org_id, workspace.id, parsed.data.team_leader_id, parsed.data.user_id, profile.id, new Date().toISOString())
      .run()
  } catch {
    return c.json({ error: 'Already assigned' }, 409)
  }
  await logActivity(c.env, c.get('workspace'), profile.id, 'field_leader_assign', 'team_leader_users', id, parsed.data)
  return c.json({ id }, 201)
})

field.get('/api/field/leaders', requireUser, requireWorkspace, requireAdmin, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const { results } = await c.env.DB.prepare(
    `SELECT tlu.*, u.full_name, u.email, COALESCE(tl.display_name, v.name) AS leader_name
     FROM team_leader_users tlu
     JOIN users u ON u.id = tlu.user_id
     JOIN team_leaders tl ON tl.id = tlu.team_leader_id
     LEFT JOIN voters v ON v.id = tl.voter_id
     WHERE tlu.workspace_id = ?
     ORDER BY u.full_name`,
  ).bind(c.get('workspace')!.id).all()
  return c.json({ links: results ?? [] })
})

field.delete('/api/field/leaders/:id', requireUser, requireWorkspace, requireAdmin, async (c) => {
  await ensureBoothSchema(c.env.DB)
  await c.env.DB.prepare('DELETE FROM team_leader_users WHERE workspace_id = ? AND id = ?')
    .bind(c.get('workspace')!.id, c.req.param('id'))
    .run()
  return c.json({ success: true })
})

field.get('/api/field/scope', requireUser, requireWorkspace, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const { clause, params: wardParams } = wardFilter(profile)
  const voterClause = `${clause.replaceAll('ward_no', 'v.ward_no')} AND ${activeVoterSql('v')}`

  if (isAdmin(profile)) {
    const leaderId = c.req.query('team_leader_id')
    if (leaderId) {
      const { results } = await c.env.DB.prepare(
        `SELECT a.voter_id FROM team_leader_assignments a
         JOIN voters v ON v.id = a.voter_id
         WHERE a.workspace_id = ? AND a.team_leader_id = ? AND ${voterClause}`,
      )
        .bind(c.get('workspace')!.id, leaderId, ...wardParams)
        .all<{ voter_id: string }>()
      return c.json({
        admin: true,
        team_leader_ids: [leaderId],
        assigned_voter_ids: (results ?? []).map((r) => r.voter_id),
      })
    }
    return c.json({ admin: true, team_leader_ids: [] as string[], assigned_voter_ids: [] as string[] })
  }

  const leaders = await loadLeaderLinks(c.env.DB, profile.id, c.get('workspace')!.id)
  const ids = leaders.map((l) => l.team_leader_id)
  if (ids.length === 0) {
    return c.json({ admin: false, leaders, team_leader_ids: [], assigned_voter_ids: [] as string[] })
  }
  const placeholders = ids.map(() => '?').join(',')
  const { results } = await c.env.DB.prepare(
    `SELECT a.voter_id FROM team_leader_assignments a
     JOIN voters v ON v.id = a.voter_id
     WHERE a.workspace_id = ? AND a.team_leader_id IN (${placeholders}) AND ${voterClause}`,
  )
    .bind(c.get('workspace')!.id, ...ids, ...wardParams)
    .all<{ voter_id: string }>()
  return c.json({
    admin: false,
    leaders,
    team_leader_ids: ids,
    assigned_voter_ids: (results ?? []).map((r) => r.voter_id),
  })
})

field.get('/api/field/geocode', requireUser, requireWorkspace, async (c) => {
  const lat = Number(c.req.query('lat'))
  const lng = Number(c.req.query('lng'))
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return c.json({ error: 'Invalid coordinates' }, 400)
  }
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      {
        headers: {
          'User-Agent': 'MormugaoVoterRecord/1.0 (field geotag)',
          Accept: 'application/json',
          'Accept-Language': 'en',
        },
      },
    )
    if (!res.ok) return c.json({ address: null })
    const data = (await res.json()) as { display_name?: string }
    return c.json({ address: data.display_name?.trim() || null })
  } catch {
    return c.json({ address: null })
  }
})

field.get('/api/field/geotags', requireUser, requireWorkspace, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const { clause, params: wardParams } = wardFilter(profile)
  const voterClause = `${clause.replaceAll('ward_no', 'v.ward_no')} AND ${activeVoterSql('v')}`
  const leaderId = c.req.query('team_leader_id')
  const partNo = c.req.query('part_no')

  const conditions = [`g.workspace_id = ?`, `EXISTS (
    SELECT 1 FROM voters v
    WHERE COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no) = g.family_key
      AND v.workspace_id = g.workspace_id
      AND ${voterClause}
  )`]
  const params: unknown[] = [c.get('workspace')!.id, ...wardParams]

  if (!isAdmin(profile)) {
    const leaders = await loadLeaderLinks(c.env.DB, profile.id, c.get('workspace')!.id)
    const ids = leaders.map((l) => l.team_leader_id)
    if (ids.length === 0) return c.json({ geotags: [] })
    const placeholders = ids.map(() => '?').join(',')
    conditions.push(`g.team_leader_id IN (${placeholders})`)
    params.push(...ids)
  } else if (leaderId) {
    conditions.push('g.team_leader_id = ?')
    params.push(leaderId)
  }
  if (partNo) {
    conditions.push(`EXISTS (
      SELECT 1 FROM voters v2
      WHERE COALESCE(NULLIF(TRIM(v2.family_head_epic), ''), v2.epic_no) = g.family_key
        AND v2.workspace_id = g.workspace_id
        AND v2.part_no = ?
    )`)
    params.push(Number(partNo))
  }

  const { results } = await c.env.DB.prepare(
    `SELECT g.*,
            head.name AS head_name,
            head.house_no,
            head.part_no,
            head.section,
            head.photo_url
     FROM family_geotags g
     LEFT JOIN voters head ON head.epic_no = g.family_key AND head.workspace_id = g.workspace_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY g.tagged_at DESC`,
  )
    .bind(...params)
    .all()

  return c.json({ geotags: results ?? [] })
})

field.get('/api/field/geotags/untagged', requireUser, requireWorkspace, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const { clause, params: wardParams } = wardFilter(profile)
  const voterClause = `${clause.replaceAll('ward_no', 'v.ward_no')} AND ${activeVoterSql('v')}`
  const leaderIdParam = c.req.query('team_leader_id')

  let leaderIds: string[] = []
  if (isAdmin(profile)) {
    if (leaderIdParam) leaderIds = [leaderIdParam]
  } else {
    leaderIds = (await loadLeaderLinks(c.env.DB, profile.id, c.get('workspace')!.id)).map((l) => l.team_leader_id)
  }

  if (leaderIds.length === 0 && !isAdmin(profile)) {
    return c.json({ untagged: [], count: 0 })
  }

  if (leaderIds.length === 0) {
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM (
         SELECT DISTINCT COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no) AS family_key
         FROM voters v
         WHERE ${voterClause}
       ) f
       LEFT JOIN family_geotags g ON g.family_key = f.family_key AND g.workspace_id = ?
       WHERE g.family_key IS NULL`,
    )
      .bind(...wardParams, c.get('workspace')!.id)
      .first<{ count: number }>()
    return c.json({ untagged: [], count: Number(row?.count ?? 0) })
  }

  const placeholders = leaderIds.map(() => '?').join(',')
  const { results } = await c.env.DB.prepare(
    `SELECT f.family_key, head.name AS head_name, head.house_no, head.part_no, head.section
     FROM (
       SELECT DISTINCT COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no) AS family_key
       FROM team_leader_assignments a
       JOIN voters v ON v.id = a.voter_id
       WHERE a.workspace_id = ? AND a.team_leader_id IN (${placeholders}) AND ${voterClause}
     ) f
     LEFT JOIN family_geotags g ON g.family_key = f.family_key AND g.workspace_id = ?
     LEFT JOIN voters head ON head.epic_no = f.family_key AND head.workspace_id = ?
     WHERE g.family_key IS NULL
     ORDER BY head.name
     LIMIT 500`,
  )
    .bind(c.get('workspace')!.id, ...leaderIds, ...wardParams, c.get('workspace')!.id, c.get('workspace')!.id)
    .all()

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM (
       SELECT DISTINCT COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no) AS family_key
       FROM team_leader_assignments a
       JOIN voters v ON v.id = a.voter_id
       WHERE a.workspace_id = ? AND a.team_leader_id IN (${placeholders}) AND ${voterClause}
     ) f
     LEFT JOIN family_geotags g ON g.family_key = f.family_key AND g.workspace_id = ?
     WHERE g.family_key IS NULL`,
  )
    .bind(c.get('workspace')!.id, ...leaderIds, ...wardParams, c.get('workspace')!.id)
    .first<{ count: number }>()

  return c.json({ untagged: results ?? [], count: Number(countRow?.count ?? 0) })
})

field.get('/api/field/geotags/:familyKey/members', requireUser, requireWorkspace, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const familyKey = decodeURIComponent(c.req.param('familyKey') ?? '')
  const { clause, params: wardParams } = wardFilter(profile)
  const voterClause = `${clause.replaceAll('ward_no', 'v.ward_no')} AND ${activeVoterSql('v')}`

  if (!isAdmin(profile)) {
    const leaders = await loadLeaderLinks(c.env.DB, profile.id, c.get('workspace')!.id)
    const assigned = await familyAssignedToLeaders(
      c.env.DB,
      familyKey,
      leaders.map((l) => l.team_leader_id),
      c.get('workspace')!.id,
    )
    if (!assigned) return c.json({ error: 'Forbidden' }, 403)
  }

  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.name, v.epic_no, v.age, v.gender, v.house_no, v.part_no, v.section, v.photo_url, v.family_head_epic
     FROM voters v
     WHERE (v.epic_no = ? OR v.family_head_epic = ?) AND ${voterClause}
     ORDER BY v.display_order, v.name`,
  )
    .bind(familyKey, familyKey, ...wardParams)
    .all()

  const pin = await c.env.DB.prepare('SELECT * FROM family_geotags WHERE workspace_id = ? AND family_key = ?')
    .bind(c.get('workspace')!.id, familyKey)
    .first()

  return c.json({ members: results ?? [], geotag: pin })
})

field.post('/api/field/geotags', requireUser, requireWorkspace, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const parsed = geotagSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
  const body = parsed.data

  const existingEvent = await c.env.DB.prepare(
    'SELECT * FROM family_geotags WHERE workspace_id = ? AND client_event_id = ?',
  )
    .bind(c.get('workspace')!.id, body.event_id)
    .first()
  if (existingEvent) return c.json({ ok: true, duplicate: true, geotag: existingEvent })

  const resolved = await resolveFamilyKey(c.env.DB, profile, body.voter_id, body.family_key)
  if (!resolved) return c.json({ error: 'Voter or family not found' }, 404)

  let teamLeaderId: string | null
  if (isAdmin(profile)) {
    const assigned = await c.env.DB.prepare(
      `SELECT a.team_leader_id
       FROM team_leader_assignments a
       JOIN voters v ON v.id = a.voter_id
       WHERE a.workspace_id = ? AND COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no) = ?
       LIMIT 1`,
    )
      .bind(c.get('workspace')!.id, resolved.family_key)
      .first<{ team_leader_id: string }>()
    teamLeaderId = assigned?.team_leader_id ?? null
  } else {
    const leaders = await loadLeaderLinks(c.env.DB, profile.id, c.get('workspace')!.id)
    const ids = leaders.map((l) => l.team_leader_id)
    const assigned = await familyAssignedToLeaders(c.env.DB, resolved.family_key, ids, c.get('workspace')!.id)
    if (!assigned) return c.json({ error: 'Family is not assigned to you' }, 403)
    teamLeaderId = assigned
  }

  const current = await c.env.DB.prepare('SELECT * FROM family_geotags WHERE workspace_id = ? AND family_key = ?')
    .bind(c.get('workspace')!.id, resolved.family_key)
    .first<{
      family_key: string
      lat: number
      lng: number
      accuracy_m: number | null
      altitude: number | null
      tagged_at: string
      tagged_by: string
      team_leader_id: string | null
      source: string
      note: string | null
      address: string | null
      client_event_id: string
      place_club_id: string | null
    }>()

  if (current && !isAdmin(profile) && current.team_leader_id && current.team_leader_id !== teamLeaderId) {
    return c.json({ error: 'Family already tagged by another leader' }, 403)
  }

  const now = new Date().toISOString()
  const place = await c.env.DB.prepare(
    'SELECT place_club_id FROM family_place_clubs WHERE workspace_id = ? AND family_head_epic = ?',
  )
    .bind(c.get('workspace')!.id, resolved.family_key)
    .first<{ place_club_id: string }>()

  if (current) {
    await c.env.DB.prepare(
      `INSERT INTO family_geotag_history
        (id, org_id, workspace_id, family_key, lat, lng, accuracy_m, altitude, tagged_at, tagged_by, team_leader_id, source, note, address, client_event_id, place_club_id, replaced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        c.get('workspace')!.org_id,
        c.get('workspace')!.id,
        current.family_key,
        current.lat,
        current.lng,
        current.accuracy_m,
        current.altitude,
        current.tagged_at,
        current.tagged_by,
        current.team_leader_id,
        current.source,
        current.note,
        current.address,
        current.client_event_id,
        current.place_club_id,
        now,
      )
      .run()

    await c.env.DB.prepare(
      `UPDATE family_geotags
       SET lat = ?, lng = ?, accuracy_m = ?, altitude = ?, tagged_at = ?, tagged_by = ?,
           team_leader_id = ?, source = ?, note = ?, address = ?, client_event_id = ?, place_club_id = ?, updated_at = ?
       WHERE workspace_id = ? AND family_key = ?`,
    )
      .bind(
        body.lat,
        body.lng,
        body.accuracy_m ?? null,
        body.altitude ?? null,
        now,
        profile.id,
        teamLeaderId,
        body.source ?? 'gps',
        body.note ?? null,
        body.address ?? null,
        body.event_id,
        place?.place_club_id ?? current.place_club_id,
        now,
        c.get('workspace')!.id,
        resolved.family_key,
      )
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO family_geotags
        (org_id, workspace_id, family_key, lat, lng, accuracy_m, altitude, tagged_at, tagged_by, team_leader_id, source, note, address, client_event_id, place_club_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        c.get('workspace')!.org_id,
        c.get('workspace')!.id,
        resolved.family_key,
        body.lat,
        body.lng,
        body.accuracy_m ?? null,
        body.altitude ?? null,
        now,
        profile.id,
        teamLeaderId,
        body.source ?? 'gps',
        body.note ?? null,
        body.address ?? null,
        body.event_id,
        place?.place_club_id ?? null,
        now,
      )
      .run()
  }

  await logActivity(c.env, c.get('workspace'), profile.id, current ? 'family_geotag_update' : 'family_geotag', 'family_geotags', resolved.family_key, {
    lat: body.lat,
    lng: body.lng,
    accuracy_m: body.accuracy_m,
    source: body.source ?? 'gps',
    address: body.address ?? null,
  })

  const geotag = await c.env.DB.prepare('SELECT * FROM family_geotags WHERE workspace_id = ? AND family_key = ?')
    .bind(c.get('workspace')!.id, resolved.family_key)
    .first()
  return c.json({ ok: true, geotag }, current ? 200 : 201)
})

field.delete('/api/field/geotags/:familyKey', requireUser, requireWorkspace, requireAdmin, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const familyKey = decodeURIComponent(c.req.param('familyKey') ?? '')
  const current = await c.env.DB.prepare('SELECT * FROM family_geotags WHERE workspace_id = ? AND family_key = ?')
    .bind(c.get('workspace')!.id, familyKey)
    .first<{
      family_key: string
      lat: number
      lng: number
      accuracy_m: number | null
      altitude: number | null
      tagged_at: string
      tagged_by: string
      team_leader_id: string | null
      source: string
      note: string | null
      address: string | null
      client_event_id: string
      place_club_id: string | null
    }>()
  if (!current) return c.json({ error: 'Not found' }, 404)

  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO family_geotag_history
      (id, org_id, workspace_id, family_key, lat, lng, accuracy_m, altitude, tagged_at, tagged_by, team_leader_id, source, note, address, client_event_id, place_club_id, replaced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      c.get('workspace')!.org_id,
      c.get('workspace')!.id,
      current.family_key,
      current.lat,
      current.lng,
      current.accuracy_m,
      current.altitude,
      current.tagged_at,
      current.tagged_by,
      current.team_leader_id,
      current.source,
      current.note,
      current.address,
      current.client_event_id,
      current.place_club_id,
      now,
    )
    .run()

  await c.env.DB.prepare('DELETE FROM family_geotags WHERE workspace_id = ? AND family_key = ?')
    .bind(c.get('workspace')!.id, familyKey)
    .run()
  await logActivity(c.env, c.get('workspace'), profile.id, 'family_geotag_clear', 'family_geotags', familyKey, null)
  return c.json({ success: true })
})
