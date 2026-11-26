import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireAdmin, requireWorkspace, type AuthedVars } from '../middleware/auth'

export const customFields = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

customFields.get('/api/custom-fields', requireUser, requireWorkspace, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM custom_fields WHERE workspace_id = ? ORDER BY position ASC')
    .bind(c.get('workspace')!.id)
    .all()
  return c.json({ fields: results })
})

customFields.post('/api/custom-fields', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const body = await c.req.json<Record<string, unknown>>()
  if (!body.name || !body.label || !body.field_type) {
    return c.json({ error: 'name, label, field_type are required' }, 400)
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const profile = c.get('profile')

  await c.env.DB.prepare(
    `INSERT INTO custom_fields
       (id, org_id, workspace_id, name, label, field_type, options, required, show_in_card, allow_custom_note, position, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      workspace.org_id,
      workspace.id,
      body.name,
      body.label,
      body.field_type,
      body.options ? JSON.stringify(body.options) : null,
      body.required ? 1 : 0,
      body.show_in_card ? 1 : 0,
      body.allow_custom_note ? 1 : 0,
      Number(body.position ?? 0),
      now,
      now,
      profile.id
    )
    .run()

  return c.json({ id }, 201)
})

customFields.delete('/api/custom-fields/:id', requireUser, requireWorkspace, requireAdmin, async (c) => {
  await c.env.DB.prepare('DELETE FROM custom_fields WHERE workspace_id = ? AND id = ?')
    .bind(c.get('workspace')!.id, c.req.param('id'))
    .run()
  return c.json({ ok: true })
})

// Upserts one or more (voter_id, field_id) values in a single request.
customFields.put('/api/custom-field-values', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  if (profile.role !== 'admin' && profile.role !== 'sub-admin' && !profile.can_edit) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const rows = await c.req.json<Array<{ voter_id: string; field_id: string; value: unknown }>>()
  if (!Array.isArray(rows) || rows.length === 0) return c.json({ error: 'Expected a non-empty array' }, 400)

  const voterIds = Array.from(new Set(rows.map((row) => row.voter_id)))
  const fieldIds = Array.from(new Set(rows.map((row) => row.field_id)))
  const ownedVoters = await c.env.DB.prepare(
    `SELECT id FROM voters WHERE workspace_id = ? AND id IN (${voterIds.map(() => '?').join(',')})`,
  ).bind(workspace.id, ...voterIds).all<{ id: string }>()
  const ownedFields = await c.env.DB.prepare(
    `SELECT id FROM custom_fields WHERE workspace_id = ? AND id IN (${fieldIds.map(() => '?').join(',')})`,
  ).bind(workspace.id, ...fieldIds).all<{ id: string }>()
  const voters = new Set((ownedVoters.results ?? []).map((row) => row.id))
  const fields = new Set((ownedFields.results ?? []).map((row) => row.id))
  const allowed = rows.filter((row) => voters.has(row.voter_id) && fields.has(row.field_id))

  const now = new Date().toISOString()
  const statements = allowed.map((row) =>
    c.env.DB.prepare(
      `INSERT INTO custom_field_values (id, org_id, workspace_id, voter_id, field_id, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(voter_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), workspace.org_id, workspace.id, row.voter_id, row.field_id, JSON.stringify(row.value ?? null), now, now)
  )

  if (statements.length) await c.env.DB.batch(statements)
  return c.json({ ok: true, count: allowed.length })
})
