import { createClient } from '@supabase/supabase-js'

/**
 * The Supabase client now talks to this app's own Cloudflare Worker, not to Supabase.
 *
 * The Worker implements a PostgREST-compatible subset at `/rest/v1/*` and a Storage-
 * compatible subset at `/storage/v1/*` (see src/worker/routes/rest.ts and storage.ts),
 * so the existing query-builder call sites keep working while pages are migrated to the
 * typed `/api/*` routes one at a time.
 *
 * Auth is the Better Auth session cookie, so every request must send credentials.
 * There is no anon key or JWT involved — the placeholder key below is never validated.
 */

const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8788'

export const hasSupabaseEnv = true

export const supabase = createClient(baseUrl, 'unused-local-key', {
  auth: {
    // Better Auth owns sessions; keep supabase-js from managing or refreshing tokens.
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: {
    // Cookie-based auth: the session cookie must ride along with every request.
    fetch: (input, init = {}) => fetch(input, { ...init, credentials: 'include' }),
  },
})
