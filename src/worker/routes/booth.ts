import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../env'
import { requireUser, requireAdmin, wardFilter, type AuthedVars } from '../middleware/auth'
import { ensureBoothSchema } from '../lib/schema-ensure'
import { logActivity } from './activity-logs'
import { activeVoterSql } from '../lib/voter-active'

export const booth = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

function isAdmin(profile: AuthedVars['profile']): boolean {
  return profile.role === 'admin' || profile.role === 'sub-admin'
}

const electionCreateSchema = z.object({
  name: z.string().trim().min(1),
  poll_date: z.string().trim().min(1),
  status: z.enum(['draft', 'open', 'closed']).optional(),
})

const electionPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  poll_date: z.string().trim().min(1).optional(),
  status: z.enum(['draft', 'open', 'closed']).optional(),
})

const boothCreateSchema = z.object({
  election_id: z.string().min(1),
  part_no: z.number().int(),
  section: z.number().int().nullable().optional(),
  name: z.string().trim().nullable().optional(),
  location: z.string().trim().nullable().optional(),
})

const agentAssignSchema = z.object({
  booth_id: z.string().min(1),
  user_id: z.string().min(1),
})

const attendanceSchema = z.object({
  event_id: z.string().min(1),
  election_id: z.string().min(1),
  booth_id: z.string().min(1).optional(),
  voter_id: z.string().min(1).optional(),
  epic_no: z.string().trim().optional(),
  sr_no_roll: z.number().int().optional(),
  name: z.string().trim().optional(),
  source: z.enum(['sr_no', 'epic', 'name']).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
})

const overrideSchema = z.object({
  event_id: z.string().min(1),
  election_id: z.string().min(1),
  voter_id: z.string().min(1),
  booth_id: z.string().min(1).optional(),
  status: z.enum(['voted', 'not_voted']),
  note: z.string().trim().optional(),
})

type AgentBooth = {
  id: string
  election_id: string
  part_no: number
  section: number | null
  name: string | null
  location: string | null
  election_status: string
}

async function loadAgentBooths(
  db: Env['DB'],
  userId: string,
  electionId?: string,
): Promise<AgentBooth[]> {
  const params: unknown[] = [userId]
  let extra = ''
  if (electionId) {
    extra = 'AND b.election_id = ?'
    params.push(electionId)
  }
  const { results } = await db
    .prepare(
      `SELECT b.id, b.election_id, b.part_no, b.section, b.name, b.location, e.status AS election_status
       FROM booth_agents ba
       JOIN booths b ON b.id = ba.booth_id
       JOIN elections e ON e.id = b.election_id
       WHERE ba.user_id = ? ${extra}`,
    )
    .bind(...params)
    .all<AgentBooth>()
  return results ?? []
}

function voterInBooth(voter: { part_no: number | null; section: number | null }, boothRow: AgentBooth): boolean {
  if (voter.part_no !== boothRow.part_no) return false
  if (boothRow.section != null && voter.section !== boothRow.section) return false
  return true
}

function ageBandSql(alias = 'v'): string {
  return `CASE
    WHEN ${alias}.age IS NULL OR ${alias}.age < 18 THEN 'Unknown/Under 18'
    WHEN ${alias}.age <= 25 THEN '18-25'
    WHEN ${alias}.age <= 35 THEN '26-35'
    WHEN ${alias}.age <= 45 THEN '36-45'
    WHEN ${alias}.age <= 60 THEN '46-60'
    ELSE '60+'
  END`
}

booth.get('/api/booth/elections', requireUser, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM elections ORDER BY poll_date DESC, created_at DESC',
  ).all()
  return c.json({ elections: results ?? [] })
})

booth.post('/api/booth/elections', requireUser, requireAdmin, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const parsed = electionCreateSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
  const profile = c.get('profile')
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const status = parsed.data.status ?? 'draft'
  await c.env.DB.prepare(
    `INSERT INTO elections (id, name, poll_date, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, parsed.data.name, parsed.data.poll_date, status, profile.id, now, now)
    .run()
  await logActivity(c.env, profile.id, 'election_create', 'elections', id, parsed.data)
  return c.json({ id, status }, 201)
})

booth.patch('/api/booth/elections/:id', requireUser, requireAdmin, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const id = c.req.param('id') ?? ''
  const existing = await c.env.DB.prepare('SELECT id FROM elections WHERE id = ?').bind(id).first()
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const parsed = electionPatchSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
  const updates: string[] = []
  const values: unknown[] = []
  for (const col of ['name', 'poll_date', 'status'] as const) {
    if (parsed.data[col] !== undefined) {
      updates.push(`${col} = ?`)
      values.push(parsed.data[col])
    }
  }
  if (updates.length === 0) return c.json({ success: true })
  const now = new Date().toISOString()
  updates.push('updated_at = ?')
  values.push(now, id)
  await c.env.DB.prepare(`UPDATE elections SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run()
  const profile = c.get('profile')
  await logActivity(c.env, profile.id, 'election_update', 'elections', id, parsed.data)
  return c.json({ success: true })
})

booth.get('/api/booth/booths', requireUser, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const electionId = c.req.query('election_id')
  if (!electionId) return c.json({ error: 'election_id is required' }, 400)

  if (isAdmin(profile)) {
    const { results } = await c.env.DB.prepare(
      `SELECT b.*,
              (SELECT COUNT(*) FROM booth_agents ba WHERE ba.booth_id = b.id) AS agent_count
       FROM booths b WHERE b.election_id = ? ORDER BY b.part_no, b.section`,
    )
      .bind(electionId)
      .all()
    return c.json({ booths: results ?? [] })
  }

  const rows = await loadAgentBooths(c.env.DB, profile.id, electionId)
  return c.json({ booths: rows })
})

booth.post('/api/booth/booths', requireUser, requireAdmin, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const parsed = boothCreateSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
  const election = await c.env.DB.prepare('SELECT id FROM elections WHERE id = ?')
    .bind(parsed.data.election_id)
    .first()
  if (!election) return c.json({ error: 'Election not found' }, 404)
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO booths (id, election_id, part_no, section, name, location, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      parsed.data.election_id,
      parsed.data.part_no,
      parsed.data.section ?? null,
      parsed.data.name?.trim() || null,
      parsed.data.location?.trim() || null,
      new Date().toISOString(),
    )
    .run()
  return c.json({ id }, 201)
})

booth.get('/api/booth/agents', requireUser, requireAdmin, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const boothId = c.req.query('booth_id')
  const electionId = c.req.query('election_id')
  if (boothId) {
    const { results } = await c.env.DB.prepare(
      `SELECT ba.*, u.full_name, u.email
       FROM booth_agents ba JOIN users u ON u.id = ba.user_id
       WHERE ba.booth_id = ? ORDER BY u.full_name`,
    )
      .bind(boothId)
      .all()
    return c.json({ agents: results ?? [] })
  }
  if (electionId) {
    const { results } = await c.env.DB.prepare(
      `SELECT ba.*, u.full_name, u.email, b.part_no, b.name AS booth_name
       FROM booth_agents ba
       JOIN users u ON u.id = ba.user_id
       JOIN booths b ON b.id = ba.booth_id
       WHERE b.election_id = ? ORDER BY b.part_no, u.full_name`,
    )
      .bind(electionId)
      .all()
    return c.json({ agents: results ?? [] })
  }
  return c.json({ error: 'booth_id or election_id is required' }, 400)
})

booth.post('/api/booth/agents', requireUser, requireAdmin, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const parsed = agentAssignSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
  const boothRow = await c.env.DB.prepare('SELECT id FROM booths WHERE id = ?')
    .bind(parsed.data.booth_id)
    .first()
  if (!boothRow) return c.json({ error: 'Booth not found' }, 404)
  const userRow = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(parsed.data.user_id)
    .first()
  if (!userRow) return c.json({ error: 'User not found' }, 404)
  const id = crypto.randomUUID()
  try {
    await c.env.DB.prepare(
      `INSERT INTO booth_agents (id, booth_id, user_id, assigned_by, assigned_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(id, parsed.data.booth_id, parsed.data.user_id, profile.id, new Date().toISOString())
      .run()
  } catch {
    return c.json({ error: 'Already assigned' }, 409)
  }
  await logActivity(c.env, profile.id, 'booth_agent_assign', 'booth_agents', id, parsed.data)
  return c.json({ id }, 201)
})

booth.delete('/api/booth/agents/:id', requireUser, requireAdmin, async (c) => {
  await ensureBoothSchema(c.env.DB)
  await c.env.DB.prepare('DELETE FROM booth_agents WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ success: true })
})

booth.get('/api/booth/me', requireUser, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  if (isAdmin(profile)) {
    const { results } = await c.env.DB.prepare(
      `SELECT b.id, b.election_id, b.part_no, b.section, b.name, b.location, e.status AS election_status,
              e.name AS election_name, e.poll_date
       FROM booths b JOIN elections e ON e.id = b.election_id
       ORDER BY e.poll_date DESC, b.part_no`,
    ).all()
    return c.json({ admin: true, booths: results ?? [] })
  }
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.election_id, b.part_no, b.section, b.name, b.location, e.status AS election_status,
            e.name AS election_name, e.poll_date
     FROM booth_agents ba
     JOIN booths b ON b.id = ba.booth_id
     JOIN elections e ON e.id = b.election_id
     WHERE ba.user_id = ?
     ORDER BY e.poll_date DESC, b.part_no`,
  )
    .bind(profile.id)
    .all()
  return c.json({ admin: false, booths: results ?? [] })
})

booth.post('/api/booth/attendance', requireUser, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const parsed = attendanceSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
  const body = parsed.data

  const existingEvent = await c.env.DB.prepare(
    `SELECT t.*, v.name AS voter_name, v.epic_no, u.full_name AS marked_by_name
     FROM voter_turnout t
     JOIN voters v ON v.id = t.voter_id
     JOIN users u ON u.id = t.marked_by
     WHERE t.client_event_id = ?`,
  )
    .bind(body.event_id)
    .first()
  if (existingEvent) {
    return c.json({ ok: true, duplicate: true, mark: existingEvent })
  }

  const election = await c.env.DB.prepare('SELECT id, status FROM elections WHERE id = ?')
    .bind(body.election_id)
    .first<{ id: string; status: string }>()
  if (!election) return c.json({ error: 'Election not found' }, 404)
  if (election.status !== 'open' && !isAdmin(profile)) {
    return c.json({ error: 'Marking is closed for this election' }, 403)
  }

  const agentBooths = isAdmin(profile) ? [] : await loadAgentBooths(c.env.DB, profile.id, body.election_id)
  if (!isAdmin(profile) && agentBooths.length === 0) {
    return c.json({ error: 'No booth assignment' }, 403)
  }

  let boothRow: AgentBooth | null = null
  if (body.booth_id) {
    if (isAdmin(profile)) {
      const row = await c.env.DB.prepare(
        `SELECT b.id, b.election_id, b.part_no, b.section, b.name, b.location, e.status AS election_status
         FROM booths b JOIN elections e ON e.id = b.election_id WHERE b.id = ? AND b.election_id = ?`,
      )
        .bind(body.booth_id, body.election_id)
        .first<AgentBooth>()
      if (!row) return c.json({ error: 'Booth not found' }, 404)
      boothRow = row
    } else {
      boothRow = agentBooths.find((b) => b.id === body.booth_id) ?? null
      if (!boothRow) return c.json({ error: 'Booth not assigned' }, 403)
    }
  } else if (!isAdmin(profile) && agentBooths.length === 1) {
    boothRow = agentBooths[0]
  } else if (!isAdmin(profile)) {
    return c.json({ error: 'booth_id is required' }, 400)
  }

  const { clause, params: wardParams } = wardFilter(profile)
  const voterClause = `${clause.replaceAll('ward_no', 'v.ward_no')} AND ${activeVoterSql('v')}`

  type VoterHit = {
    id: string
    name: string
    epic_no: string
    part_no: number | null
    section: number | null
    sr_no_roll: number | null
    ward_no: number | null
  }

  let voter: VoterHit | null = null
  if (body.voter_id) {
    voter = await c.env.DB.prepare(
      `SELECT v.id, v.name, v.epic_no, v.part_no, v.section, v.sr_no_roll, v.ward_no
       FROM voters v WHERE v.id = ? AND ${voterClause}`,
    )
      .bind(body.voter_id, ...wardParams)
      .first<VoterHit>()
  } else if (body.epic_no) {
    voter = await c.env.DB.prepare(
      `SELECT v.id, v.name, v.epic_no, v.part_no, v.section, v.sr_no_roll, v.ward_no
       FROM voters v WHERE UPPER(REPLACE(v.epic_no, ' ', '')) = ? AND ${voterClause}`,
    )
      .bind(body.epic_no.replace(/\s+/g, '').toUpperCase(), ...wardParams)
      .first<VoterHit>()
  } else if (body.sr_no_roll != null) {
    const partNo = boothRow?.part_no
    if (partNo == null) return c.json({ error: 'part_no required for serial lookup' }, 400)
    const { results } = await c.env.DB.prepare(
      `SELECT v.id, v.name, v.epic_no, v.part_no, v.section, v.sr_no_roll, v.ward_no
       FROM voters v WHERE v.sr_no_roll = ? AND v.part_no = ? AND ${voterClause} LIMIT 2`,
    )
      .bind(body.sr_no_roll, partNo, ...wardParams)
      .all<VoterHit>()
    const hits = results ?? []
    if (hits.length > 1) return c.json({ error: 'Multiple voters match this serial' }, 409)
    voter = hits[0] ?? null
  } else if (body.name) {
    const partNo = boothRow?.part_no
    const extra = partNo != null ? 'AND v.part_no = ?' : ''
    const bind: unknown[] = [`%${body.name}%`]
    if (partNo != null) bind.push(partNo)
    const { results } = await c.env.DB.prepare(
      `SELECT v.id, v.name, v.epic_no, v.part_no, v.section, v.sr_no_roll, v.ward_no
       FROM voters v WHERE v.name LIKE ? ${extra} AND ${voterClause} LIMIT 5`,
    )
      .bind(...bind, ...wardParams)
      .all<VoterHit>()
    const hits = results ?? []
    if (hits.length > 1) {
      return c.json({ error: 'Multiple voters match this name', matches: hits }, 409)
    }
    voter = hits[0] ?? null
  }

  if (!voter) return c.json({ error: 'Voter not found' }, 404)

  if (!isAdmin(profile)) {
    const allowed = (boothRow ? [boothRow] : agentBooths).some((b) => voterInBooth(voter!, b))
    if (!allowed) return c.json({ error: 'Voter is not in your assigned booth' }, 403)
    if (!boothRow) {
      boothRow = agentBooths.find((b) => voterInBooth(voter!, b)) ?? null
    }
  }

  if (!boothRow) {
    const fallback = await c.env.DB.prepare(
      'SELECT id, election_id, part_no, section, name, location FROM booths WHERE election_id = ? AND part_no = ? LIMIT 1',
    )
      .bind(body.election_id, voter.part_no)
      .first<AgentBooth>()
    if (!fallback) return c.json({ error: 'No booth for this part' }, 400)
    boothRow = fallback
  }

  const already = await c.env.DB.prepare(
    `SELECT t.*, v.name AS voter_name, v.epic_no, u.full_name AS marked_by_name, b.name AS booth_name
     FROM voter_turnout t
     JOIN voters v ON v.id = t.voter_id
     JOIN users u ON u.id = t.marked_by
     JOIN booths b ON b.id = t.booth_id
     WHERE t.election_id = ? AND t.voter_id = ?`,
  )
    .bind(body.election_id, voter.id)
    .first()
  if (already) {
    return c.json({ error: 'already_marked', mark: already }, 409)
  }

  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const source = body.source ?? (body.epic_no ? 'epic' : body.sr_no_roll != null ? 'sr_no' : 'name')
  try {
    await c.env.DB.prepare(
      `INSERT INTO voter_turnout
        (id, election_id, voter_id, booth_id, status, marked_at, marked_by, source, client_event_id, lat, lng)
       VALUES (?, ?, ?, ?, 'voted', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        body.election_id,
        voter.id,
        boothRow.id,
        now,
        profile.id,
        source,
        body.event_id,
        body.lat ?? null,
        body.lng ?? null,
      )
      .run()
  } catch {
    const raced = await c.env.DB.prepare(
      'SELECT * FROM voter_turnout WHERE election_id = ? AND voter_id = ?',
    )
      .bind(body.election_id, voter.id)
      .first()
    if (raced) return c.json({ error: 'already_marked', mark: raced }, 409)
    const dup = await c.env.DB.prepare('SELECT * FROM voter_turnout WHERE client_event_id = ?')
      .bind(body.event_id)
      .first()
    if (dup) return c.json({ ok: true, duplicate: true, mark: dup })
    return c.json({ error: 'Failed to mark' }, 500)
  }

  await logActivity(c.env, profile.id, 'turnout_mark', 'voter_turnout', id, {
    election_id: body.election_id,
    voter_id: voter.id,
    booth_id: boothRow.id,
    source,
  })

  return c.json({
    ok: true,
    mark: {
      id,
      election_id: body.election_id,
      voter_id: voter.id,
      booth_id: boothRow.id,
      status: 'voted',
      marked_at: now,
      marked_by: profile.id,
      marked_by_name: profile.full_name,
      source,
      voter_name: voter.name,
      epic_no: voter.epic_no,
    },
  }, 201)
})

booth.post('/api/booth/attendance/override', requireUser, requireAdmin, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const parsed = overrideSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
  const body = parsed.data

  const existingEvent = await c.env.DB.prepare(
    'SELECT * FROM voter_turnout WHERE client_event_id = ?',
  )
    .bind(body.event_id)
    .first()
  if (existingEvent) return c.json({ ok: true, duplicate: true, mark: existingEvent })

  const { clause, params: wardParams } = wardFilter(profile)
  const voter = await c.env.DB.prepare(`SELECT id, part_no FROM voters WHERE id = ? AND ${clause}`)
    .bind(body.voter_id, ...wardParams)
    .first<{ id: string; part_no: number | null }>()
  if (!voter) return c.json({ error: 'Voter not found' }, 404)

  let boothId = body.booth_id
  if (!boothId) {
    const boothRow = await c.env.DB.prepare(
      'SELECT id FROM booths WHERE election_id = ? AND part_no = ? LIMIT 1',
    )
      .bind(body.election_id, voter.part_no)
      .first<{ id: string }>()
    boothId = boothRow?.id
  }
  if (!boothId) return c.json({ error: 'booth_id is required' }, 400)

  const now = new Date().toISOString()
  const current = await c.env.DB.prepare(
    'SELECT * FROM voter_turnout WHERE election_id = ? AND voter_id = ?',
  )
    .bind(body.election_id, body.voter_id)
    .first<{ id: string }>()

  if (current) {
    await c.env.DB.prepare(
      `UPDATE voter_turnout
       SET status = ?, booth_id = ?, override_note = ?, overridden_by = ?, overridden_at = ?
       WHERE id = ?`,
    )
      .bind(body.status, boothId, body.note ?? null, profile.id, now, current.id)
      .run()
    await logActivity(c.env, profile.id, 'turnout_override', 'voter_turnout', current.id, body)
    return c.json({ ok: true, id: current.id })
  }

  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO voter_turnout
      (id, election_id, voter_id, booth_id, status, marked_at, marked_by, source, client_event_id, override_note, overridden_by, overridden_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'epic', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      body.election_id,
      body.voter_id,
      boothId,
      body.status,
      now,
      profile.id,
      body.event_id,
      body.note ?? null,
      profile.id,
      now,
    )
    .run()
  await logActivity(c.env, profile.id, 'turnout_override', 'voter_turnout', id, body)
  return c.json({ ok: true, id }, 201)
})

booth.get('/api/booth/attendance/summary', requireUser, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const electionId = c.req.query('election_id')
  if (!electionId) return c.json({ error: 'election_id is required' }, 400)
  const partNo = c.req.query('part_no')
  const boothId = c.req.query('booth_id')

  if (!isAdmin(profile)) {
    const mine = await loadAgentBooths(c.env.DB, profile.id, electionId)
    if (mine.length === 0) return c.json({ error: 'Forbidden' }, 403)
    if (boothId && !mine.some((b) => b.id === boothId)) return c.json({ error: 'Forbidden' }, 403)
    if (partNo && !mine.some((b) => String(b.part_no) === partNo)) return c.json({ error: 'Forbidden' }, 403)
  }

  const { clause, params: wardParams } = wardFilter(profile)
  const voterClause = `${clause.replaceAll('ward_no', 'v.ward_no')} AND ${activeVoterSql('v')}`

  const partFilter = partNo ? 'AND v.part_no = ?' : ''
  const boothJoinFilter = boothId ? 'AND t.booth_id = ?' : ''
  const extraParams: unknown[] = []
  if (partNo) extraParams.push(Number(partNo))
  const boothParams: unknown[] = boothId ? [boothId] : []

  const rollScope = `
    v.part_no IN (SELECT DISTINCT part_no FROM booths WHERE election_id = ?)
    ${partFilter}
    AND ${voterClause}
  `
  const rollParams: unknown[] = [electionId, ...extraParams, ...wardParams]

  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM voters v WHERE ${rollScope}`,
  )
    .bind(...rollParams)
    .first<{ total: number }>()

  const votedRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS voted
     FROM voter_turnout t
     JOIN voters v ON v.id = t.voter_id
     WHERE t.election_id = ? AND t.status = 'voted' ${boothJoinFilter} ${partFilter} AND ${voterClause}`,
  )
    .bind(electionId, ...boothParams, ...extraParams, ...wardParams)
    .first<{ voted: number }>()

  const total = Number(totalRow?.total ?? 0)
  const voted = Number(votedRow?.voted ?? 0)
  const remaining = Math.max(total - voted, 0)
  const turnout_pct = total > 0 ? Math.round((voted / total) * 1000) / 10 : 0

  const byPart = await c.env.DB.prepare(
    `SELECT v.part_no,
            COUNT(*) AS total,
            SUM(CASE WHEN t.id IS NOT NULL AND t.status = 'voted' THEN 1 ELSE 0 END) AS voted
     FROM voters v
     LEFT JOIN voter_turnout t ON t.voter_id = v.id AND t.election_id = ?
     WHERE ${rollScope}
     GROUP BY v.part_no
     ORDER BY v.part_no`,
  )
    .bind(electionId, ...rollParams)
    .all()

  const byBooth = await c.env.DB.prepare(
    `SELECT b.id AS booth_id, b.name AS booth_name, b.part_no, COUNT(*) AS voted
     FROM voter_turnout t
     JOIN booths b ON b.id = t.booth_id
     JOIN voters v ON v.id = t.voter_id
     WHERE t.election_id = ? AND t.status = 'voted' ${boothJoinFilter} ${partFilter} AND ${voterClause}
     GROUP BY b.id
     ORDER BY b.part_no`,
  )
    .bind(electionId, ...boothParams, ...extraParams, ...wardParams)
    .all()

  const bySection = await c.env.DB.prepare(
    `SELECT v.section,
            COUNT(*) AS total,
            SUM(CASE WHEN t.id IS NOT NULL AND t.status = 'voted' THEN 1 ELSE 0 END) AS voted
     FROM voters v
     LEFT JOIN voter_turnout t ON t.voter_id = v.id AND t.election_id = ?
     WHERE ${rollScope}
     GROUP BY v.section
     ORDER BY v.section`,
  )
    .bind(electionId, ...rollParams)
    .all()

  const byGender = await c.env.DB.prepare(
    `SELECT COALESCE(v.gender, 'UNKNOWN') AS gender,
            COUNT(*) AS total,
            SUM(CASE WHEN t.id IS NOT NULL AND t.status = 'voted' THEN 1 ELSE 0 END) AS voted
     FROM voters v
     LEFT JOIN voter_turnout t ON t.voter_id = v.id AND t.election_id = ?
     WHERE ${rollScope}
     GROUP BY COALESCE(v.gender, 'UNKNOWN')`,
  )
    .bind(electionId, ...rollParams)
    .all()

  const byAge = await c.env.DB.prepare(
    `SELECT ${ageBandSql('v')} AS band,
            COUNT(*) AS total,
            SUM(CASE WHEN t.id IS NOT NULL AND t.status = 'voted' THEN 1 ELSE 0 END) AS voted
     FROM voters v
     LEFT JOIN voter_turnout t ON t.voter_id = v.id AND t.election_id = ?
     WHERE ${rollScope}
     GROUP BY band`,
  )
    .bind(electionId, ...rollParams)
    .all()

  const hourly = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m-%dT%H:00:00Z', t.marked_at) AS hour, COUNT(*) AS count
     FROM voter_turnout t
     JOIN voters v ON v.id = t.voter_id
     WHERE t.election_id = ? AND t.status = 'voted' ${boothJoinFilter} ${partFilter} AND ${voterClause}
     GROUP BY hour
     ORDER BY hour`,
  )
    .bind(electionId, ...boothParams, ...extraParams, ...wardParams)
    .all()

  const lastMarks = await c.env.DB.prepare(
    `SELECT t.voter_id, v.name, v.epic_no, v.sr_no_roll, t.booth_id, t.marked_at, u.full_name AS marked_by_name, t.source
     FROM voter_turnout t
     JOIN voters v ON v.id = t.voter_id
     JOIN users u ON u.id = t.marked_by
     WHERE t.election_id = ? AND t.status = 'voted' ${boothJoinFilter} ${partFilter} AND ${voterClause}
     ORDER BY t.marked_at DESC
     LIMIT 20`,
  )
    .bind(electionId, ...boothParams, ...extraParams, ...wardParams)
    .all()

  const mapRemaining = (rows: Record<string, unknown>[] | null) =>
    (rows ?? []).map((row) => {
      const tot = Number(row.total ?? 0)
      const vtd = Number(row.voted ?? 0)
      return { ...row, total: tot, voted: vtd, remaining: Math.max(tot - vtd, 0) }
    })

  return c.json({
    election_id: electionId,
    total_voters: total,
    voted,
    remaining,
    turnout_pct,
    by_part: mapRemaining((byPart.results ?? []) as Record<string, unknown>[]),
    by_booth: byBooth.results ?? [],
    by_section: mapRemaining((bySection.results ?? []) as Record<string, unknown>[]),
    by_gender: mapRemaining((byGender.results ?? []) as Record<string, unknown>[]),
    by_age_band: mapRemaining((byAge.results ?? []) as Record<string, unknown>[]),
    hourly: hourly.results ?? [],
    last_marks: lastMarks.results ?? [],
  })
})

booth.get('/api/booth/attendance/unmarked', requireUser, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const electionId = c.req.query('election_id')
  const partNo = c.req.query('part_no')
  if (!electionId || !partNo) return c.json({ error: 'election_id and part_no are required' }, 400)

  if (!isAdmin(profile)) {
    const mine = await loadAgentBooths(c.env.DB, profile.id, electionId)
    if (!mine.some((b) => String(b.part_no) === partNo)) return c.json({ error: 'Forbidden' }, 403)
  }

  const { clause, params: wardParams } = wardFilter(profile)
  const voterClause = `${clause.replaceAll('ward_no', 'v.ward_no')} AND ${activeVoterSql('v')}`
  const limit = Math.min(Number(c.req.query('limit') ?? 400) || 400, 500)

  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.name, v.epic_no, v.sr_no_roll, v.part_no, v.section, v.gender, v.age, v.house_no
     FROM voters v
     WHERE v.part_no = ? AND ${voterClause}
       AND v.id NOT IN (
         SELECT voter_id FROM voter_turnout WHERE election_id = ? AND status = 'voted'
       )
     ORDER BY v.sr_no_roll ASC
     LIMIT ?`,
  )
    .bind(Number(partNo), ...wardParams, electionId, limit)
    .all()

  return c.json({ unmarked: results ?? [] })
})

booth.get('/api/booth/attendance/marked', requireUser, async (c) => {
  await ensureBoothSchema(c.env.DB)
  const profile = c.get('profile')
  const electionId = c.req.query('election_id')
  if (!electionId) return c.json({ error: 'election_id is required' }, 400)
  const boothId = c.req.query('booth_id')

  if (!isAdmin(profile)) {
    const mine = await loadAgentBooths(c.env.DB, profile.id, electionId)
    if (mine.length === 0) return c.json({ error: 'Forbidden' }, 403)
    if (boothId && !mine.some((b) => b.id === boothId)) return c.json({ error: 'Forbidden' }, 403)
  }

  const { clause, params: wardParams } = wardFilter(profile)
  const voterClause = `${clause.replaceAll('ward_no', 'v.ward_no')} AND ${activeVoterSql('v')}`
  const boothFilter = boothId ? 'AND t.booth_id = ?' : ''
  const boothParams: unknown[] = boothId ? [boothId] : []

  const { results } = await c.env.DB.prepare(
    `SELECT t.voter_id, t.booth_id, t.marked_at, t.source, t.status, u.full_name AS marked_by_name
     FROM voter_turnout t
     JOIN voters v ON v.id = t.voter_id
     JOIN users u ON u.id = t.marked_by
     WHERE t.election_id = ? ${boothFilter} AND ${voterClause}
     ORDER BY t.marked_at DESC`,
  )
    .bind(electionId, ...boothParams, ...wardParams)
    .all()

  return c.json({ marks: results ?? [] })
})
