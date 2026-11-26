import type { Context, Next } from 'hono'
import type { Env } from '../env'
import { createAuth } from '../auth'

export type AuthedVars = {
  userId: string
  authUser: { id: string; email: string; name: string }
  profile: {
    id: string
    auth_user_id: string
    full_name: string | null
    email: string
    role: 'admin' | 'sub-admin' | 'user'
    allowed_wards: number[]
    can_edit: boolean
  }
}

// Reads the Better Auth session cookie, then loads the app profile row (role/wards/can_edit).
// Rejects with 401 if there is no session or no matching `users` profile.
export async function requireUser(c: Context<{ Bindings: Env; Variables: AuthedVars }>, next: Next) {
  const auth = createAuth(c.env)
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const row = await c.env.DB.prepare(
    'SELECT id, auth_user_id, full_name, email, role, allowed_wards, can_edit FROM users WHERE auth_user_id = ?'
  )
    .bind(session.user.id)
    .first<{
      id: string
      auth_user_id: string
      full_name: string | null
      email: string
      role: 'admin' | 'sub-admin' | 'user'
      allowed_wards: string
      can_edit: number
    }>()

  if (!row) {
    return c.json({ error: 'No profile for this account' }, 403)
  }

  c.set('userId', session.user.id)
  c.set('authUser', { id: session.user.id, email: session.user.email, name: session.user.name })
  c.set('profile', {
    ...row,
    allowed_wards: JSON.parse(row.allowed_wards) as number[],
    can_edit: Boolean(row.can_edit),
  })

  await next()
}

export function requireAdmin(c: Context<{ Bindings: Env; Variables: AuthedVars }>, next: Next) {
  const profile = c.get('profile')
  if (profile.role !== 'admin' && profile.role !== 'sub-admin') {
    return c.json({ error: 'Forbidden' }, 403)
  }
  return next()
}

// Ward ACL used by voter reads/writes: admin/sub-admin see everything,
// other users are limited to ward_no IS NULL OR ward_no IN allowed_wards.
export function wardFilter(profile: AuthedVars['profile']): { clause: string; params: unknown[] } {
  if (profile.role === 'admin' || profile.role === 'sub-admin') {
    return { clause: '1=1', params: [] }
  }
  const wards = profile.allowed_wards.length > 0 ? profile.allowed_wards : [-1]
  const placeholders = wards.map(() => '?').join(',')
  return {
    clause: `(ward_no IS NULL OR ward_no IN (${placeholders}))`,
    params: wards,
  }
}
