import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, wardFilter, type AuthedVars } from '../middleware/auth'

export const jobRecords = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

const JOB_STATUSES = [
  'applied_govt',
  'applied_private',
  'appointed_govt',
  'appointed_private',
  'pending',
] as const
type JobStatus = (typeof JOB_STATUSES)[number]

function canWrite(profile: AuthedVars['profile']): boolean {
  return profile.role === 'admin' || profile.role === 'sub-admin' || profile.can_edit
}

// Job records hang off a voter, so they inherit that voter's ward ACL.
jobRecords.get('/api/job-records', requireUser, async (c) => {
  const profile = c.get('profile')
  const url = new URL(c.req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
  const status = url.searchParams.get('status')
  const voterId = url.searchParams.get('voter_id')

  const { clause, params } = wardFilter(profile)
  const conditions = [clause.replaceAll('ward_no', 'v.ward_no')]
  const sqlParams: unknown[] = [...params]

  if (status) {
    if (!JOB_STATUSES.includes(status as JobStatus)) {
      return c.json({ error: `status must be one of ${JOB_STATUSES.join(', ')}` }, 400)
    }
    conditions.push('j.status = ?')
    sqlParams.push(status)
  }
  if (voterId) {
    conditions.push('j.voter_id = ?')
    sqlParams.push(voterId)
  }

  const { results } = await c.env.DB.prepare(
    `SELECT j.*, v.name, v.epic_no, v.ward_no, v.part_no, v.contact_no_1
     FROM job_records j
     JOIN voters v ON v.id = j.voter_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY j.updated_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...sqlParams, limit, offset)
    .all()

  return c.json({ jobRecords: results ?? [] })
})

jobRecords.get('/api/job-records/:id', requireUser, async (c) => {
  const profile = c.get('profile')
  const { clause, params } = wardFilter(profile)

  const job = await c.env.DB.prepare(
    `SELECT j.*, v.name, v.epic_no, v.ward_no, v.part_no
     FROM job_records j
     JOIN voters v ON v.id = j.voter_id
     WHERE j.id = ? AND ${clause.replaceAll('ward_no', 'v.ward_no')}`
  )
    .bind(c.req.param('id'), ...params)
    .first()

  if (!job) return c.json({ error: 'Not found' }, 404)
  return c.json({ job })
})

jobRecords.post('/api/job-records', requireUser, async (c) => {
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{
    voter_id?: string
    status?: JobStatus
    department_name?: string | null
    note?: string | null
  }>()

  if (!body.voter_id) return c.json({ error: 'voter_id is required' }, 400)
  if (!body.status || !JOB_STATUSES.includes(body.status)) {
    return c.json({ error: `status must be one of ${JOB_STATUSES.join(', ')}` }, 400)
  }

  // Don't let a ward-restricted user attach records to voters they cannot see.
  const { clause, params } = wardFilter(profile)
  const voter = await c.env.DB.prepare(`SELECT id FROM voters WHERE id = ? AND ${clause}`)
    .bind(body.voter_id, ...params)
    .first()
  if (!voter) return c.json({ error: 'Voter not found' }, 404)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO job_records (id, voter_id, status, department_name, note, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      body.voter_id,
      body.status,
      body.department_name?.trim() || null,
      body.note?.trim() || null,
      profile.id,
      profile.id,
      now,
      now
    )
    .run()

  return c.json({ id }, 201)
})

jobRecords.patch('/api/job-records/:id', requireUser, async (c) => {
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const id = c.req.param('id')
  const { clause, params } = wardFilter(profile)
  const existing = await c.env.DB.prepare(
    `SELECT j.id FROM job_records j JOIN voters v ON v.id = j.voter_id
     WHERE j.id = ? AND ${clause.replaceAll('ward_no', 'v.ward_no')}`
  )
    .bind(id, ...params)
    .first()
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<{
    status?: JobStatus
    department_name?: string | null
    note?: string | null
  }>()

  const updates: string[] = []
  const values: unknown[] = []

  if (body.status !== undefined) {
    if (!JOB_STATUSES.includes(body.status)) {
      return c.json({ error: `status must be one of ${JOB_STATUSES.join(', ')}` }, 400)
    }
    updates.push('status = ?')
    values.push(body.status)
  }
  if (body.department_name !== undefined) {
    updates.push('department_name = ?')
    values.push(body.department_name ?? null)
  }
  if (body.note !== undefined) {
    updates.push('note = ?')
    values.push(body.note ?? null)
  }

  if (updates.length === 0) return c.json({ success: true })

  updates.push('updated_by = ?', 'updated_at = ?')
  values.push(profile.id, new Date().toISOString(), id)

  await c.env.DB.prepare(`UPDATE job_records SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()

  return c.json({ success: true })
})

jobRecords.delete('/api/job-records/:id', requireUser, async (c) => {
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const { clause, params } = wardFilter(profile)
  const existing = await c.env.DB.prepare(
    `SELECT j.id FROM job_records j JOIN voters v ON v.id = j.voter_id
     WHERE j.id = ? AND ${clause.replaceAll('ward_no', 'v.ward_no')}`
  )
    .bind(c.req.param('id'), ...params)
    .first()
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await c.env.DB.prepare('DELETE FROM job_records WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ success: true })
})
