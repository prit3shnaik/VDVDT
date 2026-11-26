import { platformDb, type Env } from '../env'
import { createAuth } from '../auth'

/**
 * Links a Better Auth credential to an app profile.
 *
 * The migrated `users` rows came from Supabase and carry Supabase auth ids, and their
 * password hashes could not be migrated. So a profile can legitimately exist with no
 * Better Auth account behind it. This creates that account (or resets the password on
 * an existing one) and repoints `users.auth_user_id` at it.
 *
 * Password hashing is always delegated to Better Auth — never hashed by hand, or
 * sign-in verification will not match.
 */
export async function linkCredential(
  env: Env,
  email: string,
  password: string,
  displayName: string
): Promise<{ authUserId: string; created: boolean }> {
  const auth = createAuth(env)
  const db = platformDb(env)
  const normalized = email.toLowerCase().trim()

  const existing = await db.prepare('SELECT id FROM [user] WHERE email = ?')
    .bind(normalized)
    .first<{ id: string }>()

  const ctx = await auth.$context
  const hash = await ctx.password.hash(password)

  if (existing) {
    await ctx.internalAdapter.updatePassword(existing.id, hash)
    await db.prepare('DELETE FROM session WHERE userId = ?').bind(existing.id).run()
    return { authUserId: existing.id, created: false }
  }

  // Create the auth user + credential through the adapter, not signUpEmail.
  // signUpEmail auto-creates a session and tries to set cookies, which fails
  // (and can clobber the admin session) when called from a Worker API handler.
  const createdUser = await ctx.internalAdapter.createUser(
    { email: normalized, name: displayName, emailVerified: true },
    { method: 'admin' },
  )
  if (!createdUser?.id) throw new Error('Better Auth did not return a user id')

  await ctx.internalAdapter.linkAccount({
    userId: createdUser.id,
    providerId: 'credential',
    accountId: createdUser.id,
    password: hash,
  })

  return { authUserId: createdUser.id, created: true }
}
