import type { D1Database, R2Bucket } from '@cloudflare/workers-types'

export interface Env {
  DB: D1Database
  PHOTOS: R2Bucket
  IMPORT_TEMP: R2Bucket
  BETTER_AUTH_SECRET: string
  APP_ORIGIN: string
  /** Comma-separated additional origins Better Auth should trust (e.g. the pages.dev URL). */
  EXTRA_TRUSTED_ORIGINS?: string
  ADMIN_SETUP_PIN?: string
}
