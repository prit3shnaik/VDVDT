import { Hono } from 'hono'
import type { Env } from '../env'
import { platformDb } from '../env'
import { linkCredential } from '../lib/link-credential'
import { requireUser, requireAdmin, requireWorkspace, type AuthedVars } from '../middleware/auth'

export const userManagement = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

const WORKSPACE_ROLES = ['candidate', 'incharge', 'operator', 'booth_agent', 'field'] as const
type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

interface MemberRow {
  membership_id: string
  user_id: string
  email: string
  full_name: string | null
  role: WorkspaceRole
  allowed_wards: string
  can_edit: number
  created_at: string
}

function shape(row: MemberRow) {
  let wards: number[]
  try {
    const parsed = JSON.parse(row.allowed_wards)
    wards = Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : []
  } catch {
    wards = []
  }
  return {
    id: row.user_id,
    membership_id: row.membership_id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    allowed_wards: wards,
    can_edit: Boolean(row.can_edit),
    created_at: row.created_at,
  }
}

function normalizeWards(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  return JSON.stringify(value.map(Number).filter((n) => Number.isInteger(n)))
}

async function mirrorUser(env: Env, userId: string, email: string, fullName: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, full_name, synced_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, full_name = excluded.full_name, synced_at = excluded.synced_at`,
  )
    .bind(userId, email, fullName, new Date().toISOString())
    .run()
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// Workspace members (not platform identity). A user can belong to many
// workspaces; this route manages the membership for the active workspace only.
// ---------------------------------------------------------------------------
userManagement.get('/api/admin/users', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const url = new URL(c.req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)

  const { results } = await platformDb(c.env)
    .prepare(
      `SELECT m.id AS membership_id, m.user_id, u.email, u.full_name, m.role,
              m.allowed_wards, m.can_edit, m.created_at
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ?
       ORDER BY m.created_at ASC LIMIT ? OFFSET ?`,
    )
    .bind(workspace.id, limit, offset)
    .all<MemberRow>()

  return c.json({ users: (results ?? []).map(shape) })
})

userManagement.post('/api/admin/users', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const db = platformDb(c.env)
  const body = await c.req.json<{
    email?: string
    password?: string
    fullName?: string
    role?: WorkspaceRole
    allowedWards?: number[]
    canEdit?: boolean
  }>()

  const email = body.email?.toLowerCase().trim()
  if (!email) return c.json({ error: 'email is required' }, 400)
  if (body.password && body.password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  const role: WorkspaceRole = body.role && WORKSPACE_ROLES.includes(body.role) ? body.role : 'operator'
  const displayName = body.fullName?.trim() || email.split('@')[0]

  const existing = await db
    .prepare('SELECT id, email, full_name FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; email: string; full_name: string | null }>()

  try {
    let userId: string
    if (existing) {
      userId = existing.id
      if (body.password) await linkCredential(c.env, email, body.password, displayName)
    } else {
      if (!body.password) return c.json({ error: 'password is required for a new user' }, 400)
      const { authUserId } = await linkCredential(c.env, email, body.password, displayName)
      userId = crypto.randomUUID()
      const now = new Date().toISOString()
      await db
        .prepare(
          `INSERT INTO users (id, auth_user_id, full_name, email, is_platform_admin, password_reset_required, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 1, ?, ?)`,
        )
        .bind(userId, authUserId, displayName, email, now, now)
        .run()
    }

    await db
      .prepare(
        `INSERT INTO workspace_members (id, org_id, workspace_id, user_id, role, allowed_wards, can_edit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET
           role = excluded.role, allowed_wards = excluded.allowed_wards,
           can_edit = excluded.can_edit, updated_at = excluded.updated_at`,
      )
      .bind(
        crypto.randomUUID(),
        workspace.org_id,
        workspace.id,
        userId,
        role,
        normalizeWards(body.allowedWards) ?? '[]',
        body.canEdit === false || role === 'field' || role === 'booth_agent' ? 0 : 1,
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run()

    await mirrorUser(c.env, userId, email, existing?.full_name ?? displayName)
    return c.json({ id: userId, email, role }, 201)
  } catch (err) {
    console.error('Create member error:', err)
    return c.json({ error: err instanceof Error ? err.message : 'Failed to create member' }, 500)
  }
})

userManagement.patch('/api/admin/users/:id', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const actor = c.get('profile')
  const userId = c.req.param('id')
  const db = platformDb(c.env)

  if (userId === actor.id) return c.json({ error: 'Cannot edit your own membership' }, 400)

  const body = await c.req.json<{
    fullName?: string
    role?: WorkspaceRole
    allowedWards?: number[]
    canEdit?: boolean
  }>()

  const updates: string[] = []
  const values: unknown[] = []

  if (body.role !== undefined) {
    if (!WORKSPACE_ROLES.includes(body.role)) {
      return c.json({ error: `role must be one of ${WORKSPACE_ROLES.join(', ')}` }, 400)
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

  if (updates.length) {
    updates.push('updated_at = ?')
    values.push(new Date().toISOString(), workspace.id, userId)
    await db
      .prepare(`UPDATE workspace_members SET ${updates.join(', ')} WHERE workspace_id = ? AND user_id = ?`)
      .bind(...values)
      .run()
  }

  if (body.fullName !== undefined) {
    await db
      .prepare('UPDATE users SET full_name = ?, updated_at = ? WHERE id = ?')
      .bind(body.fullName?.trim() || null, new Date().toISOString(), userId)
      .run()
  }

  return c.json({ success: true })
})

/** Resets a member's password. Better Auth owns the hashing. */
userManagement.post('/api/admin/users/:id/password', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const userId = c.req.param('id')
  const db = platformDb(c.env)

  const member = await db
    .prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(workspace.id, userId)
    .first()
  if (!member) return c.json({ error: 'Not found' }, 404)

  const target = await db
    .prepare('SELECT id, email, full_name FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; full_name: string | null }>()
  if (!target) return c.json({ error: 'Not found' }, 404)

  const { password } = await c.req.json<{ password?: string }>()
  if (!password || password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  try {
    await linkCredential(c.env, target.email, password, target.full_name ?? target.email)
    await db
      .prepare('UPDATE users SET password_reset_required = 1, updated_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), userId)
      .run()
    return c.json({ success: true })
  } catch (err) {
    console.error('Password reset error:', err)
    return c.json({ error: 'Failed to reset password' }, 500)
  }
})

/** Removes a member from this workspace. The platform account is kept. */
userManagement.delete('/api/admin/users/:id', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const actor = c.get('profile')
  const userId = c.req.param('id')

  if (userId === actor.id) return c.json({ error: 'Cannot remove yourself' }, 400)

  await platformDb(c.env)
    .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(workspace.id, userId)
    .run()

  return c.json({ success: true })
})
