import { Hono } from 'hono'
import type { Env } from '../env'
import { linkCredential } from '../lib/link-credential'
import { requireUser, requireAdmin, type AuthedVars } from '../middleware/auth'

export const userManagement = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

const ROLES = ['admin', 'sub-admin', 'user'] as const
type Role = (typeof ROLES)[number]

interface UserRow {
  id: string
  auth_user_id: string
  full_name: string | null
  email: string
  role: Role
  allowed_wards: string
  can_edit: number
  password_reset_required: number
  created_at: string
}

function shape(row: UserRow) {
  return {
    ...row,
    allowed_wards: JSON.parse(row.allowed_wards) as number[],
    can_edit: Boolean(row.can_edit),
    password_reset_required: Boolean(row.password_reset_required),
  }
}

function normalizeWards(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const wards = value.map(Number).filter((n) => Number.isInteger(n))
  return JSON.stringify(wards)
}

userManagement.get('/api/admin/users', requireUser, requireAdmin, async (c) => {
  const url = new URL(c.req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)

  const { results } = await c.env.DB.prepare(
    `SELECT id, auth_user_id, full_name, email, role, allowed_wards, can_edit, password_reset_required, created_at
     FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(limit, offset)
    .all<UserRow>()

  return c.json({ users: (results ?? []).map(shape) })
})

userManagement.get('/api/admin/users/:id', requireUser, requireAdmin, async (c) => {
  const user = await c.env.DB.prepare(
    `SELECT id, auth_user_id, full_name, email, role, allowed_wards, can_edit, password_reset_required, created_at
     FROM users WHERE id = ?`
  )
    .bind(c.req.param('id'))
    .first<UserRow>()

  if (!user) return c.json({ error: 'Not found' }, 404)
  return c.json({ user: shape(user) })
})

/**
 * Creates the Better Auth account and the app profile together.
 * Password hashing is owned by Better Auth — never hash by hand here, or
 * sign-in verification will not match.
 */
userManagement.post('/api/admin/users', requireUser, requireAdmin, async (c) => {
  const actor = c.get('profile')
  const body = await c.req.json<{
    email?: string
    password?: string
    fullName?: string
    role?: Role
    allowedWards?: number[]
    canEdit?: boolean
  }>()

  const email = body.email?.toLowerCase().trim()
  if (!email || !body.password) {
    return c.json({ error: 'email and password are required' }, 400)
  }
  if (body.password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  const role: Role = body.role && ROLES.includes(body.role) ? body.role : 'user'
  // Only a full admin may mint another admin; sub-admins cannot escalate.
  if (role === 'admin' && actor.role !== 'admin') {
    return c.json({ error: 'Only an admin can create an admin' }, 403)
  }

  const existing = await c.env.DB.prepare('SELECT id, auth_user_id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; auth_user_id: string }>()

  const displayName = body.fullName?.trim() || email.split('@')[0]

  try {
    // A migrated profile can exist with no usable password (Supabase hashes could not be
    // migrated). In that case, attach a credential to it instead of refusing as duplicate.
    if (existing) {
      const hasCredential = await c.env.DB.prepare(
        'SELECT a.id FROM account a JOIN [user] u ON u.id = a.userId WHERE u.email = ? AND a.password IS NOT NULL'
      )
        .bind(email)
        .first()

      if (hasCredential) {
        return c.json({ error: 'A user with this email already exists' }, 400)
      }

      const { authUserId } = await linkCredential(c.env, email, body.password, displayName)
      await c.env.DB.prepare(
        'UPDATE users SET auth_user_id = ?, full_name = ?, password_reset_required = 1, updated_at = ? WHERE id = ?'
      )
        .bind(authUserId, displayName, new Date().toISOString(), existing.id)
        .run()

      return c.json({ id: existing.id, email, role, linked: true }, 201)
    }

    const { authUserId } = await linkCredential(c.env, email, body.password, displayName)

    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    await c.env.DB.prepare(
      `INSERT INTO users (id, auth_user_id, full_name, email, role, allowed_wards, can_edit, password_reset_required, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
      .bind(
        id,
        authUserId,
        displayName,
        email,
        role,
        normalizeWards(body.allowedWards) ?? '[]',
        body.canEdit ? 1 : 0,
        now,
        now
      )
      .run()

    return c.json({ id, email, role }, 201)
  } catch (err) {
    console.error('Create user error:', err)
    return c.json({ error: err instanceof Error ? err.message : 'Failed to create user' }, 500)
  }
})

userManagement.patch('/api/admin/users/:id', requireUser, requireAdmin, async (c) => {
  const actor = c.get('profile')
  const id = c.req.param('id')

  // Prevents an admin locking themselves out or self-escalating.
  if (id === actor.id) {
    return c.json({ error: 'Cannot edit your own permissions' }, 400)
  }

  const target = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: string; role: Role }>()
  if (!target) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<{
    fullName?: string
    role?: Role
    allowedWards?: number[]
    canEdit?: boolean
  }>()

  const updates: string[] = []
  const values: unknown[] = []

  if (body.fullName !== undefined) {
    updates.push('full_name = ?')
    values.push(body.fullName?.trim() || null)
  }

  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) {
      return c.json({ error: `role must be one of ${ROLES.join(', ')}` }, 400)
    }
    // Only a full admin may grant or revoke admin.
    if ((body.role === 'admin' || target.role === 'admin') && actor.role !== 'admin') {
      return c.json({ error: 'Only an admin can change admin role' }, 403)
    }
    if (target.role === 'admin' && body.role !== 'admin') {
      const row = await c.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'admin'"
      ).first<{ count: number }>()
      if ((row?.count ?? 0) <= 1) return c.json({ error: 'Cannot demote the last admin' }, 400)
    }
    updates.push('role = ?')
    values.push(body.role)
  }

  if (body.allowedWards !== undefined) {
    const wards = normalizeWards(body.allowedWards)
    if (wards === null) return c.json({ error: 'allowedWards must be an array of numbers' }, 400)
    updates.push('allowed_wards = ?')
    values.push(wards)
  }

  if (body.canEdit !== undefined) {
    updates.push('can_edit = ?')
    values.push(body.canEdit ? 1 : 0)
  }

  if (updates.length === 0) return c.json({ success: true })

  updates.push('updated_at = ?')
  values.push(new Date().toISOString(), id)

  await c.env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run()
  return c.json({ success: true })
})

/** Resets another user's password. Better Auth owns the hashing. */
userManagement.post('/api/admin/users/:id/password', requireUser, requireAdmin, async (c) => {
  const actor = c.get('profile')
  const id = c.req.param('id')

  const target = await c.env.DB.prepare('SELECT id, auth_user_id, email, full_name, role FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: string; auth_user_id: string; email: string; full_name: string | null; role: Role }>()
  if (!target) return c.json({ error: 'Not found' }, 404)

  if (target.role === 'admin' && actor.role !== 'admin') {
    return c.json({ error: 'Only an admin can reset an admin password' }, 403)
  }

  const { password } = await c.req.json<{ password?: string }>()
  if (!password || password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  try {
    // linkCredential creates the credential if the profile never had one (migrated user),
    // otherwise it resets the password. Either way Better Auth owns the hashing.
    const { authUserId } = await linkCredential(c.env, target.email, password, target.full_name ?? target.email)

    await c.env.DB.prepare(
      'UPDATE users SET auth_user_id = ?, password_reset_required = 1, updated_at = ? WHERE id = ?'
    )
      .bind(authUserId, new Date().toISOString(), id)
      .run()

    return c.json({ success: true })
  } catch (err) {
    console.error('Password reset error:', err)
    return c.json({ error: 'Failed to reset password' }, 500)
  }
})

userManagement.delete('/api/admin/users/:id', requireUser, requireAdmin, async (c) => {
  const actor = c.get('profile')
  const id = c.req.param('id')

  if (id === actor.id) {
    return c.json({ error: 'Cannot delete yourself' }, 400)
  }

  const target = await c.env.DB.prepare('SELECT id, auth_user_id, role FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: string; auth_user_id: string; role: Role }>()
  if (!target) return c.json({ error: 'Not found' }, 404)

  if (target.role === 'admin' && actor.role !== 'admin') {
    return c.json({ error: 'Only an admin can delete an admin' }, 403)
  }
  if (target.role === 'admin') {
    const row = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE role = 'admin'"
    ).first<{ count: number }>()
    if ((row?.count ?? 0) <= 1) return c.json({ error: 'Cannot delete the last admin' }, 400)
  }

  try {
    await c.env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS saved_filter_presets (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        filters TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (owner_id, name)
      )
    `).run()

    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE voters SET updated_by = NULL WHERE updated_by = ?').bind(id),
      c.env.DB.prepare('UPDATE import_batches SET imported_by = NULL WHERE imported_by = ?').bind(id),
      c.env.DB.prepare('UPDATE custom_fields SET updated_by = NULL WHERE updated_by = ?').bind(id),
      c.env.DB.prepare('UPDATE family_merge_events SET merged_by = NULL WHERE merged_by = ?').bind(id),
      c.env.DB.prepare('UPDATE groups SET created_by = NULL WHERE created_by = ?').bind(id),
      c.env.DB.prepare('UPDATE group_members SET added_by = NULL WHERE added_by = ?').bind(id),
      c.env.DB.prepare('UPDATE team_leaders SET created_by = NULL WHERE created_by = ?').bind(id),
      c.env.DB.prepare('UPDATE team_leader_assignments SET assigned_by = NULL WHERE assigned_by = ?').bind(id),
      c.env.DB.prepare('UPDATE meetings SET created_by = NULL WHERE created_by = ?').bind(id),
      c.env.DB.prepare('UPDATE meeting_invitees SET updated_by = NULL WHERE updated_by = ?').bind(id),
      c.env.DB.prepare('UPDATE job_records SET created_by = NULL, updated_by = NULL WHERE created_by = ? OR updated_by = ?').bind(id, id),
      c.env.DB.prepare('UPDATE activity_logs SET actor_user_id = NULL WHERE actor_user_id = ?').bind(id),
      c.env.DB.prepare('UPDATE place_clubs SET created_by = NULL WHERE created_by = ?').bind(id),
      c.env.DB.prepare('UPDATE elections SET created_by = NULL WHERE created_by = ?').bind(id),
      c.env.DB.prepare('UPDATE booth_agents SET assigned_by = NULL WHERE assigned_by = ?').bind(id),
      c.env.DB.prepare('UPDATE team_leader_users SET assigned_by = NULL WHERE assigned_by = ?').bind(id),
      c.env.DB.prepare('UPDATE app_settings SET updated_by = NULL WHERE updated_by = ?').bind(id),
      c.env.DB.prepare('UPDATE voter_turnout SET overridden_by = NULL WHERE overridden_by = ?').bind(id),
      c.env.DB.prepare('UPDATE voter_turnout SET marked_by = ? WHERE marked_by = ?').bind(actor.id, id),
      c.env.DB.prepare('UPDATE family_geotags SET tagged_by = ? WHERE tagged_by = ?').bind(actor.id, id),
      c.env.DB.prepare('DELETE FROM booth_agents WHERE user_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM team_leader_users WHERE user_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM saved_filter_presets WHERE owner_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM session WHERE userId = ?').bind(target.auth_user_id),
      c.env.DB.prepare('DELETE FROM account WHERE userId = ?').bind(target.auth_user_id),
      c.env.DB.prepare('DELETE FROM [user] WHERE id = ?').bind(target.auth_user_id),
    ])
  } catch (err) {
    console.error('Delete user error:', err)
    return c.json({ error: err instanceof Error ? err.message : 'Failed to delete user' }, 500)
  }

  return c.json({ success: true })
})
