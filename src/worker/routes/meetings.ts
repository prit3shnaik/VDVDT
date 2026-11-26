import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireAdmin, requireWorkspace, wardFilter, type AuthedVars } from '../middleware/auth'

export const meetings = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

// Must stay in sync with MeetingAttendanceStatus in src/lib/types.ts.
const ATTENDANCE_STATUSES = [
  'pending',
  'called_confirmed',
  'called_notreceived',
  'called_suspense',
  'attended',
  'not_attended',
  'next_meeting',
  'absent',
  'called',
  'personal_call',
] as const

function canWrite(profile: AuthedVars['profile']): boolean {
  return profile.role === 'admin' || profile.role === 'sub-admin' || profile.can_edit
}

meetings.get('/api/meetings', requireUser, requireWorkspace, async (c) => {
  const url = new URL(c.req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
  const partNo = url.searchParams.get('part')

  const workspace = c.get('workspace')!
  const params: unknown[] = [workspace.id]
  let where = 'WHERE m.workspace_id = ?'
  if (partNo) {
    where += ' AND m.part_no = ?'
    params.push(Number(partNo))
  }

  const { results } = await c.env.DB.prepare(
    `SELECT m.*, (SELECT COUNT(*) FROM meeting_invitees i WHERE i.meeting_id = m.id AND i.workspace_id = m.workspace_id) AS invitee_count
     FROM meetings m ${where} ORDER BY m.meeting_date DESC LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all()

  return c.json({ meetings: results ?? [] })
})

meetings.get('/api/meetings/:id', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  const meeting = await c.env.DB.prepare('SELECT * FROM meetings WHERE workspace_id = ? AND id = ?')
    .bind(workspace.id, c.req.param('id'))
    .first()
  if (!meeting) return c.json({ error: 'Not found' }, 404)

  // Invitees are voter rows, so they are ward-scoped for restricted users.
  const { clause, params } = wardFilter(profile, 'v')
  const invitees = await c.env.DB.prepare(
    `SELECT i.id, i.voter_id, i.attendance_status, i.call_note, i.updated_at,
            v.name, v.epic_no, v.ward_no, v.part_no, v.contact_no_1
     FROM meeting_invitees i
     JOIN voters v ON v.id = i.voter_id
     WHERE i.workspace_id = ? AND i.meeting_id = ? AND ${clause}
     ORDER BY v.name ASC`
  )
    .bind(workspace.id, c.req.param('id'), ...params)
    .all()

  return c.json({ meeting, invitees: invitees.results ?? [] })
})

meetings.post('/api/meetings', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{
    title?: string | null
    meeting_date?: string
    location?: string | null
    part_no?: number | null
    notes?: string | null
  }>()

  if (!body.meeting_date) return c.json({ error: 'meeting_date is required' }, 400)

  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO meetings (id, org_id, workspace_id, title, meeting_date, location, part_no, notes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      workspace.org_id,
      workspace.id,
      body.title?.trim() || null,
      body.meeting_date,
      body.location?.trim() || null,
      body.part_no ?? null,
      body.notes?.trim() || null,
      profile.id,
      new Date().toISOString()
    )
    .run()

  return c.json({ id }, 201)
})

meetings.patch('/api/meetings/:id', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const id = c.req.param('id')
  const existing = await c.env.DB.prepare('SELECT id FROM meetings WHERE workspace_id = ? AND id = ?').bind(workspace.id, id).first()
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<Record<string, unknown>>()
  const updates: string[] = []
  const values: unknown[] = []

  for (const col of ['title', 'meeting_date', 'location', 'part_no', 'notes']) {
    if (body[col] !== undefined) {
      if (col === 'meeting_date' && !body[col]) {
        return c.json({ error: 'meeting_date cannot be null' }, 400)
      }
      updates.push(`${col} = ?`)
      values.push(body[col] ?? null)
    }
  }

  if (updates.length === 0) return c.json({ success: true })
  values.push(id)

  // NOTE: the meetings table has no updated_at column.
  await c.env.DB.prepare(`UPDATE meetings SET ${updates.join(', ')} WHERE workspace_id = ? AND id = ?`).bind(...values.slice(0, -1), workspace.id, values[values.length - 1]).run()
  return c.json({ success: true })
})

meetings.delete('/api/meetings/:id', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const id = c.req.param('id')
  const workspace = c.get('workspace')!
  const existing = await c.env.DB.prepare('SELECT id FROM meetings WHERE workspace_id = ? AND id = ?').bind(workspace.id, id).first()
  if (!existing) return c.json({ error: 'Not found' }, 404)

  // meeting_invitees cascade via FK ON DELETE CASCADE.
  await c.env.DB.prepare('DELETE FROM meetings WHERE workspace_id = ? AND id = ?').bind(workspace.id, id).run()
  return c.json({ success: true })
})

// --- invitees ----------------------------------------------------------------

meetings.post('/api/meetings/:id/invitees', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const meetingId = c.req.param('id')
  const meeting = await c.env.DB.prepare('SELECT id FROM meetings WHERE workspace_id = ? AND id = ?').bind(workspace.id, meetingId).first()
  if (!meeting) return c.json({ error: 'Not found' }, 404)

  const { voter_ids } = await c.req.json<{ voter_ids?: string[] }>()
  if (!Array.isArray(voter_ids) || voter_ids.length === 0) {
    return c.json({ error: 'voter_ids is required' }, 400)
  }

  const owned = await c.env.DB.prepare(
    `SELECT id FROM voters WHERE workspace_id = ? AND id IN (${voter_ids.map(() => '?').join(',')})`,
  ).bind(workspace.id, ...voter_ids).all<{ id: string }>()
  const allowed = new Set((owned.results ?? []).map((row) => row.id))
  const insertable = voter_ids.filter((id) => allowed.has(id))
  const now = new Date().toISOString()
  const stmt = c.env.DB.prepare(
    `INSERT OR IGNORE INTO meeting_invitees (id, org_id, workspace_id, meeting_id, voter_id, attendance_status, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  )
  await c.env.DB.batch(
    insertable.map((voterId) => stmt.bind(crypto.randomUUID(), workspace.org_id, workspace.id, meetingId, voterId, profile.id, now))
  )

  return c.json({ success: true, added: insertable.length })
})

meetings.patch('/api/meetings/:id/invitees/:voterId', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const { attendance_status, call_note } = await c.req.json<{
    attendance_status?: string
    call_note?: string | null
  }>()

  const updates: string[] = []
  const values: unknown[] = []

  if (attendance_status !== undefined) {
    if (!ATTENDANCE_STATUSES.includes(attendance_status as (typeof ATTENDANCE_STATUSES)[number])) {
      return c.json({ error: `attendance_status must be one of ${ATTENDANCE_STATUSES.join(', ')}` }, 400)
    }
    updates.push('attendance_status = ?')
    values.push(attendance_status)
  }
  if (call_note !== undefined) {
    updates.push('call_note = ?')
    values.push(call_note ?? null)
  }

  if (updates.length === 0) return c.json({ success: true })

  updates.push('updated_by = ?', 'updated_at = ?')
  values.push(profile.id, new Date().toISOString(), c.get('workspace')!.id, c.req.param('id'), c.req.param('voterId'))

  const result = await c.env.DB.prepare(
    `UPDATE meeting_invitees SET ${updates.join(', ')} WHERE workspace_id = ? AND meeting_id = ? AND voter_id = ?`
  )
    .bind(...values)
    .run()

  if (!result.meta.changes) return c.json({ error: 'Not found' }, 404)
  return c.json({ success: true })
})

meetings.delete('/api/meetings/:id/invitees/:voterId', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  await c.env.DB.prepare('DELETE FROM meeting_invitees WHERE workspace_id = ? AND meeting_id = ? AND voter_id = ?')
    .bind(c.get('workspace')!.id, c.req.param('id'), c.req.param('voterId'))
    .run()

  return c.json({ success: true })
})
