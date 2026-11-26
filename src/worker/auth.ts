import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'
import type { Env } from './env'

// Better Auth owns `user` / `session` / `account` / `verification` only.
// The app profile (role, allowed_wards, can_edit) lives in the separate `users` table,
// joined by `users.auth_user_id = user.id`. Do not merge the two.
export function createAuth(env: Env) {
  // Better Auth rejects any request whose Origin is not trusted, so every hostname the
  // app is reachable on must be listed (custom domain, pages.dev, local dev).
  const trustedOrigins = [
    env.APP_ORIGIN,
    ...(env.EXTRA_TRUSTED_ORIGINS?.split(',') ?? []),
  ]
    .map((origin) => origin.trim())
    .filter(Boolean)

  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_ORIGIN,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    session: {
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    },
    advanced: {
      // Session cookie must never be readable by JS or sent cross-site.
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.APP_ORIGIN.startsWith('https://'),
      },
    },
    plugins: [admin()],
    trustedOrigins,
  })
}

export type Auth = ReturnType<typeof createAuth>
