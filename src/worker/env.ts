import type { D1Database, R2Bucket } from '@cloudflare/workers-types'

export interface Env {
  /** Campaign data plane: voters, families, leaders, field, booth, imports. */
  DB: D1Database
  /**
   * Control plane: Better Auth, app users, orgs, workspaces, memberships,
   * plans, subscriptions, invites. Static binding (Pages cannot pick a DB per
   * request). Falls back to DB only for pre-SaaS local installs.
   */
  PLATFORM_DB: D1Database
  PHOTOS: R2Bucket
  IMPORT_TEMP: R2Bucket
  BETTER_AUTH_SECRET: string
  APP_ORIGIN: string
  /** Comma-separated additional origins Better Auth should trust (e.g. the pages.dev URL). */
  EXTRA_TRUSTED_ORIGINS?: string
  ADMIN_SETUP_PIN?: string
  /** Optional Stripe secret used by the billing webhook stub. */
  STRIPE_WEBHOOK_SECRET?: string
}

/** Control-plane database. Keeps a single fallback for old local installs. */
export function platformDb(env: Env): D1Database {
  return env.PLATFORM_DB ?? env.DB
}
