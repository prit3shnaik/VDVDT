import { Hono } from 'hono'
import type { Env } from '../env'
import { linkCredential } from '../lib/link-credential'

export const authBootstrap = new Hono<{ Bindings: Env }>()

/**
 * POST /api/auth/bootstrap
 * One-time admin setup, guarded by ADMIN_SETUP_PIN.
 *
 * Two supported cases:
 *  1. Fresh database with no admin at all -> create the admin profile and credential.
 *  2. A migrated admin profile exists (from Supabase) but has no usable password ->
 *     attach a Better Auth credential to it and repoint auth_user_id.
 *
 * Any other case is refused, so this cannot be used to take over a live account.
 * Delete the ADMIN_SETUP_PIN secret once setup is complete.
 */
authBootstrap.post('/api/auth/bootstrap', async (c) => {
  const pin = c.env.ADMIN_SETUP_PIN
  if (!pin) {
    return c.json({ error: 'Bootstrap is disabled' }, 404)
  }

  const { email, password, setupPin, fullName } = await c.req.json<{
    email?: string
    password?: string
    setupPin?: string
    fullName?: string
  }>()

  // Constant-ish comparison: reject before doing any work.
  if (!setupPin || setupPin !== pin) {
    return c.json({ error: 'Invalid setup PIN' }, 401)
  }

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400)
  }
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  const normalized = email.toLowerCase().trim()
  const displayName = fullName?.trim() || normalized.split('@')[0]

  try {
    const profile = await c.env.DB.prepare(
      'SELECT id, auth_user_id, role FROM users WHERE email = ?'
    )
      .bind(normalized)
      .first<{ id: string; auth_user_id: string; role: string }>()

    // Case 2: claim an existing profile, but only if it has no live credential.
    if (profile) {
      const hasCredential = await c.env.DB.prepare(
        'SELECT a.id FROM account a JOIN [user] u ON u.id = a.userId WHERE u.email = ? AND a.password IS NOT NULL'
      )
        .bind(normalized)
        .first()

      if (hasCredential) {
        return c.json(
          { error: 'This account already has a password. Use sign-in or an admin password reset.' },
          400
        )
      }

      const { authUserId } = await linkCredential(c.env, normalized, password, displayName)

      await c.env.DB.prepare(
        "UPDATE users SET auth_user_id = ?, role = 'admin', can_edit = 1, password_reset_required = 0, updated_at = ? WHERE id = ?"
      )
        .bind(authUserId, new Date().toISOString(), profile.id)
        .run()

      return c.json({
        success: true,
        mode: 'claimed-existing-profile',
        user: { id: authUserId, email: normalized, name: displayName },
        profile: { id: profile.id, role: 'admin' },
      })
    }

    // Case 1: only allowed when there is no admin at all.
    const existingAdmin = await c.env.DB.prepare(
      "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
    ).first()

    if (existingAdmin) {
      return c.json({ error: 'An admin already exists' }, 400)
    }

    const { authUserId } = await linkCredential(c.env, normalized, password, displayName)

    const profileId = crypto.randomUUID()
    const now = new Date().toISOString()

    await c.env.DB.prepare(
      `INSERT INTO users (id, auth_user_id, full_name, email, role, allowed_wards, can_edit, password_reset_required, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'admin', '[]', 1, 0, ?, ?)`
    )
      .bind(profileId, authUserId, displayName, normalized, now, now)
      .run()

    return c.json({
      success: true,
      mode: 'created-new-admin',
      user: { id: authUserId, email: normalized, name: displayName },
      profile: { id: profileId, role: 'admin' },
    })
  } catch (err) {
    console.error('Bootstrap error:', err)
    return c.json({ error: err instanceof Error ? err.message : 'Bootstrap failed' }, 500)
  }
})
