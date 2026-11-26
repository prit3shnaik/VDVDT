import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'
import { platformDb, type Env } from './env'

// Better Auth owns `user` / `session` / `account` / `verification` only, and
// those live in the platform database. Tenancy (orgs/workspaces/memberships)
// is a separate model; never merge it into the auth tables.
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
    database: platformDb(env),
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
