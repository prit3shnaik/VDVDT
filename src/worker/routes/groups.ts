import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireAdmin, type AuthedVars } from '../middleware/auth'
import { activeVoterSql } from '../lib/voter-active'

export const groups = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

const GROUP_TYPES = ['part_wise', 'booth_wise', 'custom'] as const
type GroupType = (typeof GROUP_TYPES)[number]

function canWrite(profile: AuthedVars['profile']): boolean {
  return profile.role === 'admin' || profile.role === 'sub-admin' || profile.can_edit
}

groups.get('/api/groups', requireUser, async (c) => {
  const url = new URL(c.req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
  const q = url.searchParams.get('q')?.trim()
  const parentId = url.searchParams.get('parent_group_id')

  const conditions: string[] = []
  const params: unknown[] = []

  if (q) {
    conditions.push('name LIKE ?')
    params.push(`%${q}%`)
  }
  if (parentId) {
    conditions.push('parent_group_id = ?')
    params.push(parentId)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM groups ${where} ORDER BY name ASC LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all()

  return c.json({ groups: results ?? [] })
})

groups.get('/api/groups/:id', requireUser, async (c) => {
  const group = await c.env.DB.prepare('SELECT * FROM groups WHERE id = ?')
    .bind(c.req.param('id'))
    .first()
  if (!group) return c.json({ error: 'Not found' }, 404)

  const members = await c.env.DB.prepare(
    `SELECT gm.id, gm.voter_id, gm.added_at, v.name, v.epic_no, v.ward_no, v.part_no
     FROM group_members gm JOIN voters v ON v.id = gm.voter_id
     WHERE gm.group_id = ? AND ${activeVoterSql('v')} ORDER BY v.name ASC`
  )
    .bind(c.req.param('id'))
    .all()

  return c.json({ group, members: members.results ?? [] })
})

groups.post('/api/groups', requireUser, async (c) => {
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{
    name?: string
    group_type?: GroupType
    part_no?: number | null
    description?: string | null
    parent_group_id?: string | null
    exclusive_subgroups?: boolean
  }>()

  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
  if (!body.group_type || !GROUP_TYPES.includes(body.group_type)) {
    return c.json({ error: `group_type must be one of ${GROUP_TYPES.join(', ')}` }, 400)
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO groups (id, name, group_type, part_no, description, created_by, parent_group_id, exclusive_subgroups, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      body.name.trim(),
      body.group_type,
      body.part_no ?? null,
      body.description?.trim() || null,
      profile.id,
      body.parent_group_id ?? null,
      body.exclusive_subgroups === false ? 0 : 1,
      now,
      now
    )
    .run()

  return c.json({ id }, 201)
})

groups.patch('/api/groups/:id', requireUser, async (c) => {
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const id = c.req.param('id')
  const existing = await c.env.DB.prepare('SELECT id FROM groups WHERE id = ?').bind(id).first()
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<Record<string, unknown>>()
  const updates: string[] = []
  const values: unknown[] = []

  if (typeof body.name === 'string') {
    if (!body.name.trim()) return c.json({ error: 'name cannot be empty' }, 400)
    updates.push('name = ?')
    values.push(body.name.trim())
  }
  if (body.group_type !== undefined) {
    if (!GROUP_TYPES.includes(body.group_type as GroupType)) {
      return c.json({ error: `group_type must be one of ${GROUP_TYPES.join(', ')}` }, 400)
    }
    updates.push('group_type = ?')
    values.push(body.group_type)
  }
  if (body.part_no !== undefined) {
    updates.push('part_no = ?')
    values.push(body.part_no ?? null)
  }
  if (body.description !== undefined) {
    updates.push('description = ?')
    values.push(body.description ?? null)
  }
  if (body.exclusive_subgroups !== undefined) {
    updates.push('exclusive_subgroups = ?')
    values.push(body.exclusive_subgroups ? 1 : 0)
  }

  if (updates.length === 0) return c.json({ success: true })

  updates.push('updated_at = ?')
  values.push(new Date().toISOString(), id)

  await c.env.DB.prepare(`UPDATE groups SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run()
  return c.json({ success: true })
})

groups.delete('/api/groups/:id', requireUser, requireAdmin, async (c) => {
  const id = c.req.param('id')
  const existing = await c.env.DB.prepare('SELECT id FROM groups WHERE id = ?').bind(id).first()
  if (!existing) return c.json({ error: 'Not found' }, 404)

  // group_members and child groups cascade via FK ON DELETE CASCADE.
  await c.env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// --- members -----------------------------------------------------------------

groups.post('/api/groups/:id/members', requireUser, async (c) => {
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const groupId = c.req.param('id')
  const group = await c.env.DB.prepare('SELECT id FROM groups WHERE id = ?').bind(groupId).first()
  if (!group) return c.json({ error: 'Not found' }, 404)

  const { voter_ids } = await c.req.json<{ voter_ids?: string[] }>()
  if (!Array.isArray(voter_ids) || voter_ids.length === 0) {
    return c.json({ error: 'voter_ids is required' }, 400)
  }

  const now = new Date().toISOString()
  const stmt = c.env.DB.prepare(
    'INSERT OR IGNORE INTO group_members (id, group_id, voter_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)'
  )
  await c.env.DB.batch(
    voter_ids.map((voterId) => stmt.bind(crypto.randomUUID(), groupId, voterId, profile.id, now))
  )

  return c.json({ success: true, added: voter_ids.length })
})

groups.delete('/api/groups/:id/members/:voterId', requireUser, async (c) => {
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  await c.env.DB.prepare('DELETE FROM group_members WHERE group_id = ? AND voter_id = ?')
    .bind(c.req.param('id'), c.req.param('voterId'))
    .run()

  return c.json({ success: true })
})
