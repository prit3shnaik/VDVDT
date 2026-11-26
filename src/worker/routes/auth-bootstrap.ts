import { Hono } from 'hono'
import type { Env } from '../env'
import { platformDb } from '../env'
import { linkCredential } from '../lib/link-credential'

export const authBootstrap = new Hono<{ Bindings: Env }>()

/**
 * POST /api/auth/bootstrap
 * One-time *platform operator* setup, guarded by ADMIN_SETUP_PIN.
 *
 * This creates your staff account (users.is_platform_admin = 1). It does not
 * create a customer org or workspace; customers are provisioned from the
 * onboarding flow and receive invites, never a shared global PIN.
 *
 * Refuses once a platform admin exists, so it cannot take over a live install.
 * Delete ADMIN_SETUP_PIN after setup.
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
  const db = platformDb(c.env)

  try {
    const existingAdmin = await db
      .prepare('SELECT id FROM users WHERE is_platform_admin = 1 LIMIT 1')
      .first()

    if (existingAdmin) {
      return c.json({ error: 'A platform admin already exists' }, 400)
    }

    const existingProfile = await db
      .prepare('SELECT id, auth_user_id FROM users WHERE email = ?')
      .bind(normalized)
      .first<{ id: string; auth_user_id: string }>()

    const { authUserId } = await linkCredential(c.env, normalized, password, displayName)
    const now = new Date().toISOString()

    let profileId = existingProfile?.id
    if (existingProfile) {
      await db
        .prepare(
          `UPDATE users SET auth_user_id = ?, is_platform_admin = 1, password_reset_required = 0, updated_at = ?
           WHERE id = ?`,
        )
        .bind(authUserId, now, existingProfile.id)
        .run()
    } else {
      profileId = crypto.randomUUID()
      await db
        .prepare(
          `INSERT INTO users (id, auth_user_id, full_name, email, is_platform_admin, password_reset_required, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
        )
        .bind(profileId, authUserId, displayName, normalized, now, now)
        .run()
    }

    await c.env.DB.prepare(
      `INSERT INTO users (id, email, full_name, synced_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, full_name = excluded.full_name, synced_at = excluded.synced_at`,
    )
      .bind(profileId, normalized, displayName, now)
      .run()
      .catch(() => {})

    return c.json({
      success: true,
      mode: 'platform-admin-created',
      user: { id: authUserId, email: normalized, name: displayName },
      profile: { id: profileId, is_platform_admin: true },
    })
  } catch (err) {
    console.error('Bootstrap error:', err)
    return c.json({ error: err instanceof Error ? err.message : 'Bootstrap failed' }, 500)
  }
})
