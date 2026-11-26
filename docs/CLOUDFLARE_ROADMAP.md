 

# Cloudflare Migration Roadmap

VoterData Management: leave Supabase entirely and run on Cloudflare Pages + Workers + D1 + R2.

This document is specific to this repository. It is not a generic Cloudflare tutorial.

Companion files:

- `docs/SUPABASE_TO_CLOUDFLARE_MIGRATION.md` step-by-step dump, convert, load
- `docs/d1/001_schema.sql` D1 SQLite schema
- `docs/d1/002_fts_triggers.sql` FTS5 search (replaces tsvector + pg_trgm)
- `docs/d1/003_worker_sql_snippets.sql` Worker SQL replacing RPCs and the materialized view
- `docs/d1/postgres_export.sql` Postgres COPY statements with type conversion
- `docs/d1/csv_to_d1.sql` load order notes

---

## Cost target

Goal: stop Supabase bill overages and stay on Cloudflare Workers Paid at $5/month (or Free if the roll is tiny).

| Plan            | Why it matters here                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| Workers Free    | Will not survive`select('*')` of a constituency voter roll from the browser.                                      |
| Workers Paid $5 | Correct default. Included D1 rows-read is still easy to blow if the SPA keeps downloading the full`voters` table. |
| R2              | Egress is free. This kills Supabase Storage + Image Transformation cost.                                            |

Do not bind D1 to the browser. Do not put D1 tokens in `VITE_*` env vars.

---

## PART 1: PROJECT ANALYSIS

### 1. Stack

| Layer         | What this repo uses                                                                          |
| ------------- | -------------------------------------------------------------------------------------------- |
| Frontend      | React 18 + TypeScript + Vite 8 + Tailwind + React Router 6                                   |
| Table/UI      | TanStack Table, Recharts, ExcelJS, jsPDF, PapaParse, JSZip                                   |
| Hosting today | Cloudflare Pages (`wrangler.toml`, `npm run deploy:pages`, `functions/_middleware.js`) |
| Backend today | None of your own. The browser is the API client.                                             |
| Data          | Supabase Postgres + RLS                                                                      |
| Auth          | Supabase Auth (email/password)                                                               |
| Files         | Supabase Storage (`voter-photos`, `import-temp`)                                         |
| Heavy jobs    | 4 Supabase Edge Functions                                                                    |
| PWA           | `vite-plugin-pwa` in `vite.config.ts`                                                    |

`package.json` name is `vote`. README name is VoterData Management. Light theme only.

Critical architecture fact: the UI does `select('*')` of large voter sets in the browser (Dashboard, Voters, Families, Groups, Meetings, Team Leaders) and caches them in `localStorage` (`src/lib/voterCache.ts`). That pattern will blow D1 read quotas if you keep it.

There is no Next.js, no Node server, no Prisma, no Drizzle today.

### 2. Files that import or use `@supabase/supabase-js`

Client factory:

- `src/lib/supabase.ts` — `createClient` from `@supabase/supabase-js`

Auth:

- `src/hooks/useAuth.tsx`
- `src/pages/auth/LoginPage.tsx`
- `src/pages/auth/BootstrapAdminPage.tsx`
- `src/pages/account/ProfilePage.tsx`
- `src/App.tsx` (env gate: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`)

Admin:

- `src/pages/admin/UsersPage.tsx`
- `src/pages/admin/WardsPage.tsx`
- `src/pages/admin/ActivityLogsPage.tsx`
- `src/pages/admin/ImportDataPage.tsx`
- `src/pages/admin/CustomFieldsPage.tsx`

Workspace pages:

- `src/pages/workspace/DashboardPage.tsx`
- `src/pages/workspace/VotersPage.tsx`
- `src/pages/workspace/FamiliesPage.tsx`
- `src/pages/workspace/BirthdaysPage.tsx`
- `src/pages/workspace/InsightsPage.tsx`
- `src/pages/workspace/GroupsPage.tsx`
- `src/pages/workspace/GroupDetailPage.tsx`
- `src/pages/workspace/TeamLeadersPage.tsx`
- `src/pages/workspace/TeamLeaderDetailPage.tsx`
- `src/pages/workspace/UnassignedFamiliesPage.tsx`
- `src/pages/workspace/MeetingsPage.tsx`
- `src/pages/workspace/MeetingsDetailPage.tsx`
- `src/pages/workspace/GlobalNotYetInvitedPage.tsx`
- `src/pages/workspace/GlobalNotYetInvitedPartPage.tsx`
- `src/pages/workspace/JobsPage.tsx`

Shared:

- `src/hooks/usePhotoUrls.ts`
- `src/hooks/useMeetingData.ts`
- `src/lib/teamLeaderCache.ts`
- `src/lib/leaderFamilyPdf.ts`
- `src/components/voters/VoterDetailDrawer.tsx`
- `src/components/common/JobRecordsExcelImportModal.tsx`
- `src/components/common/EpicExcelImportModal.tsx`
- `src/components/groups/AddMembersPanel.tsx`
- `src/components/groups/CreateHeaderGroupModal.tsx`
- `src/components/families/BulkAddFamilyMembersModal.tsx`

Deno Edge Functions (service role, not the SPA):

- `supabase/functions/import-voters/index.ts` (~1057 lines, XLSX + embedded photos)
- `supabase/functions/import-profile-images/index.ts`
- `supabase/functions/admin-user-management/index.ts`
- `supabase/functions/bootstrap-admin/index.ts`
- `supabase/functions/log-auth-event/index.ts`

Env:

- `.env.example` — `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_FIRST_ADMIN_SETUP_ENABLED`

### 3. Database surface

Tables defined in `supabase/migrations/`:

- `users`
- `voters`
- `activity_logs`
- `import_batches`
- `custom_fields`
- `custom_field_values`
- `saved_filter_presets`
- `family_merge_events`

Tables used in the app whose CREATE TABLE is not in this repo (live Supabase only — dump these before cutover):

- `groups`
- `group_members`
- `meetings`
- `meeting_invitees`
- `team_leaders`
- `team_leader_assignments`
- `job_records`

Postgres-only features that D1 cannot run:

| Postgres                                           | Used for                                  | D1 replacement                                 |
| -------------------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| `uuid` / `gen_random_uuid()`                   | primary keys                              | `TEXT` + `crypto.randomUUID()` in Worker   |
| `timestamptz`                                    | all timestamps                            | ISO-8601`TEXT`                               |
| `jsonb`                                          | logs, import reports, custom field values | `TEXT` JSON                                  |
| `int[]`                                          | `users.allowed_wards`                   | `TEXT` JSON array                            |
| `tsvector` generated column                      | `voters.search_vector`                  | FTS5 virtual table                             |
| `pg_trgm` + GIN                                  | fuzzy name/EPIC search                    | FTS5 prefix match                              |
| `search_voters()`                                | RPC search                                | FTS5 JOIN in Worker                            |
| materialized view`dashboard_stats`               | dashboard                                 | singleton table, refresh in Worker             |
| `refresh_dashboard_stats()`                      | RPC                                       | Worker SQL                                     |
| RLS (ward + role)                                  | every table                               | `requireUser()` / `assertWard()` in Worker |
| triggers`set_updated_at`, `log_voter_activity` | audit                                     | Worker writes                                  |
| `remove_team_leader`                             | RPC                                       | two DELETEs                                    |
| `shift_to_office_and_shifted`                    | RPC                                       | two UPDATEs                                    |

Hot query patterns in the UI (must become Worker endpoints, not client SQL):

- `voters.select('*')` with `.range()` batches of 400-1000
- `.in('id' | 'epic_no' | 'family_head_epic', chunk)` (chunk 150-200)
- `.or('name.ilike, epic_no.ilike, ...')` search
- upserts on `meeting_invitees` (`onConflict: 'meeting_id,voter_id'`)
- upserts on `custom_field_values`
- bulk insert/delete on `team_leader_assignments`, `group_members`

### 4. Auth today

- Email/password only in `LoginPage.tsx` (`signInWithPassword`). README mentions Google OAuth; the login UI does not implement it.
- Session persisted in the browser (`persistSession`, `autoRefreshToken`, `detectSessionInUrl`).
- App profile is `public.users` keyed by `auth_user_id`.
- Roles: `admin` | `sub-admin` | `user`.
- Ward ACL via `allowed_wards int[]`. `can_edit` flag.
- RLS enforces ward reads and admin-only deletes. D1 has no RLS — this must move into the Worker.
- Privileged auth ops go through Edge Functions:
  - create user / reset password (`admin-user-management`)
  - first-admin PIN bootstrap (`bootstrap-admin`)
  - login / profile sync audit (`log-auth-event`)
- Password change: `supabase.auth.updateUser({ password })` in `ProfilePage.tsx`.

### 5. Storage today

| Bucket           | Public  | Usage                                                               |
| ---------------- | ------- | ------------------------------------------------------------------- |
| `voter-photos` | private | signed URLs (1h), upload from`VoterDetailDrawer`, import pipeline |
| `import-temp`  | private | XLSX + folder photos for import                                     |

Signed URL call sites:

- `src/hooks/usePhotoUrls.ts`
- `src/pages/workspace/FamiliesPage.tsx` (500px Image Transformation)
- `src/pages/workspace/VotersPage.tsx`
- `src/pages/workspace/BirthdaysPage.tsx`
- `src/pages/workspace/JobsPage.tsx`
- `src/pages/workspace/GroupsPage.tsx`
- `src/pages/workspace/GroupDetailPage.tsx`
- `src/pages/workspace/TeamLeadersPage.tsx`
- `src/pages/workspace/TeamLeaderDetailPage.tsx`
- `src/pages/workspace/UnassignedFamiliesPage.tsx`
- `src/pages/workspace/MeetingsDetailPage.tsx`
- `src/lib/leaderFamilyPdf.ts`
- `src/components/voters/VoterDetailDrawer.tsx` (single signed URL + upload)

Image transformation cost is real. `FamiliesPage.tsx` calls:

```ts
createSignedUrl(path, 60 * 60, {
  transform: { width: 500, height: 500, resize: 'cover' },
})
```

That is the bill you want to kill. Do not replace it with Cloudflare Images or Image Resizing (both extra $). Generate a 500px derivative once at upload time and serve it from R2 + CDN cache.

Upload call sites:

- `VoterDetailDrawer.tsx` → `voter-photos`
- `ImportDataPage.tsx` → `import-temp` (xlsx and folder images)

### 6. Edge Functions to replace

| Function                  | Called from                | Worker replacement                         |
| ------------------------- | -------------------------- | ------------------------------------------ |
| `bootstrap-admin`       | `BootstrapAdminPage.tsx` | `POST /api/admin/bootstrap`              |
| `admin-user-management` | `UsersPage.tsx`          | `POST /api/admin/users`                  |
| `log-auth-event`        | `useAuth.tsx`            | Better Auth hook +`activity_logs` insert |
| `import-voters`         | `ImportDataPage.tsx`     | `POST /api/imports` + Queue consumer     |
| `import-profile-images` | `ImportDataPage.tsx`     | `POST /api/imports/photos`               |

`import-voters` is the hard one: XLSX parse, header alias mapping, embedded photo extraction from `drawing1.xml`, row validation, duplicate preview, batch progress on `import_batches`, CSV error reports. On Workers Paid, CPU is tens of seconds, not minutes. Split into upload → queue → chunked writes.

### 7. Target architecture

```
Vite SPA (Cloudflare Pages / Workers Assets)
        |
        | same-origin /api/*  (cookie session)
        v
Hono Worker  -- D1 (SQLite) -- auth + ward ACL in code
             -- R2 voter-photos (orig/ + t500/)
             -- R2 import-temp
             -- Queue / Workflow (xlsx import)
```

Keep Pages for the static SPA. Do not expose D1 to the client.

Recommended order:

1. Schema + dump + load D1
2. Better Auth on Worker (dual-run with Supabase for a week)
3. R2 photo copy + `/media` URLs
4. Read APIs (voters list, dashboard stats, meetings)
5. Write APIs + ACL
6. Import pipeline last
7. Delete `@supabase/supabase-js` and Edge Functions

---

## PART 2: STEP-BY-STEP ROADMAP

### Step 1: Database (Supabase Postgres to Cloudflare D1)

See `docs/SUPABASE_TO_CLOUDFLARE_MIGRATION.md` for commands.

Type map:

| Postgres                      | D1 SQLite                                  |
| ----------------------------- | ------------------------------------------ |
| `uuid`                      | `TEXT` (UUIDv4 from Worker)              |
| `timestamptz`               | `TEXT` ISO-8601                          |
| `date`                      | `TEXT` `YYYY-MM-DD`                    |
| `int[]` (`allowed_wards`) | `TEXT` JSON array                        |
| `jsonb`                     | `TEXT` JSON                              |
| `boolean`                   | `INTEGER` 0/1                            |
| `tsvector` / `pg_trgm`    | FTS5 virtual table                         |
| ENUM                          | `TEXT` + CHECK                           |
| materialized view             | normal table, refresh in Worker            |
| RLS                           | Worker`requireUser()` / `assertWard()` |

Apply:

```bash
npx wrangler d1 create voterdata
npx wrangler d1 execute voterdata --remote --file=./docs/d1/001_schema.sql
```

Then load data, then:

```bash
npx wrangler d1 execute voterdata --remote --file=./docs/d1/002_fts_triggers.sql
```

Better Auth will add its own `user`, `session`, `account`, `verification` tables. Keep `users` as the app profile (`auth_user_id` points at the Better Auth user id). Do not merge those two tables. Role and ward live on `users`.

Do not port `search_voters` as-is. Replace with FTS5 (see `docs/d1/002_fts_triggers.sql`).

Do not refresh dashboard stats on every page load. Call the Worker SQL in `docs/d1/003_worker_sql_snippets.sql` after imports.

### Step 2: Authentication (Supabase Auth to Better Auth + D1)

Use Better Auth with the D1 / Drizzle adapter. Lucia is maintenance-mode. Clerk and Auth.js add a second vendor bill.

Maps 1:1 onto this app:

| Current                                | After                                       |
| -------------------------------------- | ------------------------------------------- |
| `signInWithPassword`                 | `authClient.signIn.email`                 |
| `updateUser({ password })`           | `authClient.changePassword`               |
| `admin-user-management` create/reset | Better Auth admin plugin                    |
| `bootstrap-admin` PIN                | Worker route, secret in Wrangler            |
| `log-auth-event`                     | insert`activity_logs` in the sign-in hook |
| `getSession` / `onAuthStateChange` | `authClient.useSession()`                 |

Worker init sketch:

```ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { drizzle } from 'drizzle-orm/d1'

export function createAuth(env: Env) {
  const db = drizzle(env.DB)
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_ORIGIN,
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    session: { cookieCache: { enabled: true, maxAge: 60 * 5 } },
    plugins: [admin()],
    trustedOrigins: [env.APP_ORIGIN],
  })
}
```

Frontend client (replaces `src/lib/supabase.ts` for auth):

```ts
import { createAuthClient } from 'better-auth/react'
export const authClient = createAuthClient({ baseURL: '/api/auth' })
```

`useAuth.tsx`: drop `Session` from `@supabase/supabase-js`. After session, `GET /api/me` which joins Better Auth user to `users` (`role`, `allowed_wards`, `can_edit`). Keep `isAdminAreaAllowed` as-is.

Put `BETTER_AUTH_SECRET` and `ADMIN_SETUP_PIN` in Wrangler secrets, never `VITE_*`.

Password hashes cannot be copied from `auth.users` into Better Auth. Recreate accounts (admin invite or forced reset). Export emails from `auth.users` via `docs/d1/postgres_export.sql`.

Google OAuth: skip unless you actually add a button. The current `LoginPage.tsx` is email/password only.

### Step 3: Storage (Supabase Storage to R2)

```bash
npx wrangler r2 bucket create voter-photos
npx wrangler r2 bucket create import-temp
```

Copy objects, preserving keys so `voters.photo_url` stays valid. See the migration guide for rclone / wrangler loops.

Kill image transformation cost. At upload time in the Worker, write two keys:

- `orig/{path}`
- `t500/{path}` (500x500 cover, generate once with `imagescript` / wasm)

Serve via Worker `/media/:size/:key` with session cookie + `Cache-Control: public, max-age=86400`. First hit is R2 Class B; later hits are CDN. That is how you get free-ish egress.

Do not use Cloudflare Images. Do not use Image Resizing.

Replace every `createSignedUrls` / `createSignedUrl` with:

```ts
export function photoUrl(path: string, size: 'orig' | 't500' = 't500') {
  return `/media/${size}/${path}`
}
```

`import-temp`: browser `PUT /api/imports/upload` to Worker `env.IMPORT_TEMP.put(...)`. Bucket stays private.

### Step 4: Backend API (Cloudflare Workers)

Keep Pages for the SPA. Add a Hono Worker (or Pages Function `functions/api/[[path]].ts`) with D1 + R2 bindings.

`wrangler.toml` additions:

```toml
name = "voterdata-management"
compatibility_date = "2026-07-04"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = "dist"

[[d1_databases]]
binding = "DB"
database_name = "voterdata"
database_id = "<id-from-wrangler-d1-create>"

[[r2_buckets]]
binding = "PHOTOS"
bucket_name = "voter-photos"

[[r2_buckets]]
binding = "IMPORT_TEMP"
bucket_name = "import-temp"

[vars]
APP_ORIGIN = "https://your-pages-domain.pages.dev"
```

Secrets (never commit):

```bash
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put ADMIN_SETUP_PIN
```

ACL copied from current RLS (see `supabase/migrations/202607040001_initial_schema.sql` and follow-ups):

- `admin` / `sub-admin`: all wards, all reads
- `user`: `ward_no IS NULL OR ward_no IN allowed_wards`
- writes: `role in (admin, sub-admin) OR can_edit = 1`
- user delete: admin only
- import batches: admin / sub-admin
- activity logs: admin / sub-admin
- saved filter presets: owner only

Suggested route map:

| Method                | Path                                                    | Replaces                                 |
| --------------------- | ------------------------------------------------------- | ---------------------------------------- |
| *                     | `/api/auth/*`                                         | Supabase Auth                            |
| GET                   | `/api/me`                                             | `users` profile fetch                  |
| GET                   | `/api/voters`                                         | `voters.select` + search + ward filter |
| GET                   | `/api/voters/:id`                                     | single voter                             |
| PATCH                 | `/api/voters/:id`                                     | voter update                             |
| POST                  | `/api/voters`                                         | insert                                   |
| DELETE                | `/api/voters`                                         | admin wipe / by part                     |
| GET                   | `/api/dashboard-stats`                                | materialized view                        |
| POST                  | `/api/dashboard-stats/refresh`                        | `refresh_dashboard_stats`              |
| GET/POST/PATCH/DELETE | `/api/groups`, `/api/group-members`                 | groups                                   |
| GET/POST/PATCH/DELETE | `/api/team-leaders`, `/api/team-leader-assignments` | team leaders                             |
| DELETE                | `/api/team-leaders/:id`                               | `remove_team_leader`                   |
| POST                  | `/api/team-leaders/shift-office`                      | `shift_to_office_and_shifted`          |
| GET/PUT               | `/api/meetings`, `/api/meetings/:id/invitees`       | meetings upsert                          |
| GET/POST/PATCH/DELETE | `/api/job-records`                                    | jobs                                     |
| GET/POST/DELETE       | `/api/custom-fields`                                  | custom fields                            |
| PUT                   | `/api/custom-field-values`                            | upsert values                            |
| GET                   | `/api/activity-logs`                                  | admin logs                               |
| POST                  | `/api/admin/users`                                    | create / reset password                  |
| POST                  | `/api/admin/bootstrap`                                | first admin PIN                          |
| PUT                   | `/api/photos/:key`                                    | photo upload                             |
| GET                   | `/media/:size/:key`                                   | photo serve (cached)                     |
| PUT                   | `/api/imports/upload`                                 | import-temp                              |
| POST                  | `/api/imports`                                        | import-voters preview/commit             |
| POST                  | `/api/imports/photos`                                 | import-profile-images                    |

CORS: same-origin in production (Pages + Worker on one hostname) is simplest. If you split origins, allow only `APP_ORIGIN` with credentials, never `*`.

Local Vite proxy (required while the SPA and Worker are two processes):

```ts
server: {
  allowedHosts: ['.monkeycode-ai.live'],
  proxy: {
    '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    '/media': { target: 'http://127.0.0.1:8787', changeOrigin: true },
  },
}
```

Import split (do not run the 1057-line function in one request):

1. Browser uploads xlsx to R2.
2. Worker inserts `import_batches` row, enqueues a job.
3. Queue consumer parses in row chunks of 200, writes D1 batches, updates `progress_percent`.
4. Preview (`previewOnly: true`) stays; commit is a second job.

If a single xlsx is huge, use Cloudflare Workflows.

### Step 5: Frontend refactoring

Delete `@supabase/supabase-js`. Replace `src/lib/supabase.ts` with:

```ts
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? res.statusText)
  }
  return res.json()
}
```

`src/App.tsx`: stop gating on `VITE_SUPABASE_*`. Same-origin `/api` is enough.

Do not port Dashboard `select('*')` + range loop. Serve `GET /api/dashboard-stats` and paginated `/api/voters`. If you keep the localStorage voter cache, you will still burn D1 reads on every cold cache.

#### Before / after (actual calls in this repo)

Login (`src/pages/auth/LoginPage.tsx`):

```ts
await supabase.auth.signInWithPassword({ email, password })
await authClient.signIn.email({ email, password })
```

Session + profile (`src/hooks/useAuth.tsx`):

```ts
supabase.auth.getSession()
supabase.from('users').select('...').eq('auth_user_id', userId)
supabase.functions.invoke('log-auth-event', { body: { action: 'login' } })

authClient.useSession()
await api('/api/me')
```

Dashboard (`src/pages/workspace/DashboardPage.tsx`):

```ts
supabase.from('voters').select('*').order('updated_at', { ascending: false }).range(offset, offset + 399)
await api(`/api/voters?limit=100&offset=${offset}`)
```

Search (`TeamLeaderDetailPage`, `GroupDetailPage`, `AddMembersPanel`):

```ts
.from('voters').select('*').or(`name.ilike.${sp},epic_no.ilike.${sp},...`).limit(20)
await api(`/api/voters?q=${encodeURIComponent(q)}&limit=20`)
```

Voter update + photo (`VoterDetailDrawer.tsx`):

```ts
await supabase.from('voters').update(payload).eq('id', voter.id)
await supabase.from('custom_field_values').upsert(upsertRows, { onConflict: 'voter_id,field_id' })
await supabase.storage.from('voter-photos').upload(photoPath, blob)

await api(`/api/voters/${voter.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
await api('/api/custom-field-values', { method: 'PUT', body: JSON.stringify(upsertRows) })
await fetch(`/api/photos/${photoPath}`, { method: 'PUT', body: blob, credentials: 'include' })
```

Photos (`usePhotoUrls.ts` and every `createSignedUrls` site):

```ts
await supabase.storage.from('voter-photos').createSignedUrls(batch, 3600)
const url = `/media/t500/${path}`
```

Meetings upsert:

```ts
supabase.from('meeting_invitees').upsert(rows, { onConflict: 'meeting_id,voter_id' })
await api(`/api/meetings/${id}/invitees`, { method: 'PUT', body: JSON.stringify(rows) })
```

Admin create user:

```ts
supabase.functions.invoke('admin-user-management', { body: { action: 'create_user', ... } })
await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ action: 'create_user', ... }) })
```

Import:

```ts
supabase.storage.from('import-temp').upload(filePath, file)
supabase.functions.invoke('import-voters', { body: { batchId, storagePath, previewOnly: true } })

await fetch('/api/imports/upload', { method: 'PUT', body: file, credentials: 'include' })
await api('/api/imports', { method: 'POST', body: JSON.stringify({ storagePath, previewOnly: true }) })
```

RPCs:

```ts
supabase.rpc('refresh_dashboard_stats')
supabase.rpc('remove_team_leader', { p_leader_id })

await api('/api/dashboard-stats/refresh', { method: 'POST' })
await api(`/api/team-leaders/${leaderId}`, { method: 'DELETE' })
```

Files to touch for the first frontend pass (auth + api helper only):

- `src/lib/supabase.ts` → `src/lib/api.ts` + `src/lib/auth-client.ts`
- `src/hooks/useAuth.tsx`
- `src/pages/auth/LoginPage.tsx`
- `src/pages/auth/BootstrapAdminPage.tsx`
- `src/pages/account/ProfilePage.tsx`
- `src/App.tsx`
- `.env.example`

Then replace remaining `import { supabase }` files listed in Part 1.

---

## Sequence that stays on $5

1. Dump live Supabase, including tables not in `supabase/migrations/`.
2. Create D1, apply `docs/d1/001_schema.sql`, import CSVs, apply `docs/d1/002_fts_triggers.sql`.
3. Stand up Better Auth on a Worker. Dual-write profile for one week if needed.
4. Copy R2. Generate `t500/` thumbnails once. Point photos at `/media`.
5. Move reads (voters list, dashboard stats, meetings) to `/api`. Leave writes on Supabase until reads are stable.
6. Move writes + ACL into the Worker. Delete RLS dependency.
7. Port import last (Queue / Workflow).
8. Remove `@supabase/supabase-js`, Edge Functions, `VITE_SUPABASE_*`.
9. Watch D1 rows-read in the Cloudflare dashboard. If dashboard still does full-table `select *`, you will exceed the $5 included reads.

Do not treat D1 as PostgREST. The current client is a PostgREST client. The Worker is the new database.

---

## Out of scope / do not do

- Do not use Hyperdrive to keep talking to Supabase Postgres. That is not leaving Supabase.
- Do not use Cloudflare Images or Image Resizing.
- Do not put service credentials in `VITE_*`.
- Do not enable D1 public access.
- Do not copy Supabase password hashes into Better Auth.
- Do not run `import-voters` as a single Worker request on a large xlsx.
- Do not port `pg_trgm` similarity thresholds; FTS5 prefix search is the replacement.
- Do not keep `functions/_middleware.js` Sentry DSN hardcoded when you rewrite Workers (move to a secret if you still want error reporting).
