# Supabase to Cloudflare Migration Guide

Hands-on commands to move this project's Postgres, Auth, Storage, and Edge Functions onto D1, Better Auth, R2, and Workers.

Read `docs/CLOUDFLARE_ROADMAP.md` first for why each step exists. This file is the runbook.

SQL assets:

- `docs/d1/001_schema.sql`
- `docs/d1/002_fts_triggers.sql`
- `docs/d1/003_worker_sql_snippets.sql`
- `docs/d1/postgres_export.sql`
- `docs/d1/csv_to_d1.sql`

---

## 0. Prerequisites

- Cloudflare account on Workers Paid ($5) unless the voter roll is tiny
- Wrangler authenticated: `npx wrangler login`
- Access to the live Supabase project (dashboard SQL editor or `psql` with the database URL)
- Node 20+
- Optional: rclone, `psql`, sqlite3 CLI

Create a working directory outside git for dumps (they contain PII):

```bash
mkdir -p /tmp/voterdata-export/exports
cd /tmp/voterdata-export
```

Do not commit CSVs or photos into this repository.

---

## 1. Inventory the live database

This repo's migrations do not create `groups`, `group_members`, `meetings`, `meeting_invitees`, `team_leaders`, `team_leader_assignments`, or `job_records`. Confirm they exist and capture any extra columns.

In the Supabase SQL editor:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY 1;

SELECT table_name, column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;
```

If a live column is missing from `docs/d1/001_schema.sql`, add it before loading data.

Also dump the true schema:

```bash
npx supabase db dump --schema public -f /tmp/voterdata-export/live_schema.sql
```

---

## 2. Export Postgres to CSV (type-converted)

Copy `docs/d1/postgres_export.sql` next to an `exports/` folder, then:

```bash
cd /tmp/voterdata-export
mkdir -p exports
cp /workspace/docs/d1/postgres_export.sql .

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f postgres_export.sql
ls -lh exports
```

`$DATABASE_URL` is the Supabase connection string (Project Settings → Database). Use the session pooler or direct connection, not the transaction pooler, for `\copy`.

The SELECT list already converts:

| Postgres | CSV / D1 |
| --- | --- |
| uuid | text |
| timestamptz | `YYYY-MM-DDTHH:MM:SS.MSZ` |
| date | `YYYY-MM-DD` |
| boolean | 0/1 |
| int[] | JSON array text `[1,2,3]` |
| jsonb | JSON text |

If `\copy` fails on a missing table, comment that block out and continue.

Row-count check (run on Postgres, save the numbers):

```sql
SELECT 'users' AS t, COUNT(*) FROM public.users
UNION ALL SELECT 'voters', COUNT(*) FROM public.voters
UNION ALL SELECT 'activity_logs', COUNT(*) FROM public.activity_logs
UNION ALL SELECT 'import_batches', COUNT(*) FROM public.import_batches
UNION ALL SELECT 'custom_fields', COUNT(*) FROM public.custom_fields
UNION ALL SELECT 'custom_field_values', COUNT(*) FROM public.custom_field_values
UNION ALL SELECT 'saved_filter_presets', COUNT(*) FROM public.saved_filter_presets
UNION ALL SELECT 'family_merge_events', COUNT(*) FROM public.family_merge_events
UNION ALL SELECT 'groups', COUNT(*) FROM public.groups
UNION ALL SELECT 'group_members', COUNT(*) FROM public.group_members
UNION ALL SELECT 'team_leaders', COUNT(*) FROM public.team_leaders
UNION ALL SELECT 'team_leader_assignments', COUNT(*) FROM public.team_leader_assignments
UNION ALL SELECT 'meetings', COUNT(*) FROM public.meetings
UNION ALL SELECT 'meeting_invitees', COUNT(*) FROM public.meeting_invitees
UNION ALL SELECT 'job_records', COUNT(*) FROM public.job_records;
```

---

## 3. Create D1 and apply schema

From the repo root:

```bash
npx wrangler d1 create voterdata
```

Copy `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "voterdata"
database_id = "<id>"
```

Apply schema (remote):

```bash
npx wrangler d1 execute voterdata --remote --file=./docs/d1/001_schema.sql
```

If you are about to import existing `team_leaders` rows that already include `__OFFICE__` / `__SHIFTED__`, the sentinel INSERTs at the bottom of `001_schema.sql` are `INSERT OR IGNORE` and will no-op when a matching notes value exists. If you load team_leaders first via sqlite `.import`, skip re-running those INSERTs.

Local (for a dry run):

```bash
npx wrangler d1 execute voterdata --local --file=./docs/d1/001_schema.sql
```

---

## 4. Load CSV into D1

Wrangler will not ingest CSV. Two workable paths.

### Path A: sqlite3 `.import` on a local D1 file (preferred for large voters)

1. Apply schema locally (command above).
2. Find the local sqlite file Wrangler created (under `.wrangler/state/v3/d1/`).
3. Import in foreign-key order:

```bash
sqlite3 /path/to/db.sqlite
```

```sql
PRAGMA foreign_keys = OFF;
.mode csv
.headers on

.import /tmp/voterdata-export/exports/users.csv users
.import /tmp/voterdata-export/exports/voters.csv voters
.import /tmp/voterdata-export/exports/activity_logs.csv activity_logs
.import /tmp/voterdata-export/exports/import_batches.csv import_batches
.import /tmp/voterdata-export/exports/custom_fields.csv custom_fields
.import /tmp/voterdata-export/exports/custom_field_values.csv custom_field_values
.import /tmp/voterdata-export/exports/saved_filter_presets.csv saved_filter_presets
.import /tmp/voterdata-export/exports/family_merge_events.csv family_merge_events
.import /tmp/voterdata-export/exports/groups.csv groups
.import /tmp/voterdata-export/exports/group_members.csv group_members
.import /tmp/voterdata-export/exports/team_leaders.csv team_leaders
.import /tmp/voterdata-export/exports/team_leader_assignments.csv team_leader_assignments
.import /tmp/voterdata-export/exports/meetings.csv meetings
.import /tmp/voterdata-export/exports/meeting_invitees.csv meeting_invitees
.import /tmp/voterdata-export/exports/job_records.csv job_records

PRAGMA foreign_keys = ON;
```

`.import` uses the first row as column names when `.headers on` is set. If sqlite treats the header as a data row, delete that row:

```sql
DELETE FROM users WHERE id = 'id';
```

4. Rebuild FTS:

```bash
npx wrangler d1 execute voterdata --local --file=./docs/d1/002_fts_triggers.sql
```

5. Export local DB and load remote, or re-run the same `.import` against a file you then upload with:

```bash
npx wrangler d1 execute voterdata --remote --file=./docs/d1/001_schema.sql
npx wrangler d1 execute voterdata --remote --file=./docs/d1/002_fts_triggers.sql
```

For remote bulk load, convert CSV to INSERT SQL in batches under ~100k rows / ~1MB per statement. A small Node snippet:

```js
import fs from 'node:fs'
import { parse } from 'csv-parse/sync'

const table = process.argv[2]
const file = process.argv[3]
const rows = parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true })
const cols = Object.keys(rows[0] ?? {})
const chunk = 200
for (let i = 0; i < rows.length; i += chunk) {
  const slice = rows.slice(i, i + chunk)
  const values = slice.map((r) => {
    const cells = cols.map((c) => {
      const v = r[c]
      if (v === '' || v === undefined) return 'NULL'
      return `'${String(v).replaceAll("'", "''")}'`
    })
    return `(${cells.join(',')})`
  })
  console.log(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')};`)
}
```

```bash
node csv_to_insert.js voters /tmp/voterdata-export/exports/voters.csv > /tmp/voters.sql
npx wrangler d1 execute voterdata --remote --file=/tmp/voters.sql
```

### Path B: wrangler `--command` per batch

Only for small tables (`users`, `custom_fields`, `meetings`). Do not use this for `voters`.

### Verify counts

```bash
npx wrangler d1 execute voterdata --remote --command="SELECT COUNT(*) AS c FROM voters;"
npx wrangler d1 execute voterdata --remote --command="SELECT COUNT(*) AS c FROM users;"
npx wrangler d1 execute voterdata --remote --command="SELECT COUNT(*) AS c FROM team_leader_assignments;"
```

Match against the Postgres counts from step 2.

Spot-check JSON:

```sql
SELECT id, allowed_wards, can_edit FROM users LIMIT 5;
SELECT id, epic_no, date_of_birth, photo_url FROM voters LIMIT 5;
```

`allowed_wards` must look like `[1,2]` not `{1,2}`.

---

## 5. FTS rebuild

After any bulk import that may have bypassed triggers:

```bash
npx wrangler d1 execute voterdata --remote --file=./docs/d1/002_fts_triggers.sql
```

Test:

```sql
SELECT v.epic_no, v.name
FROM voters v
JOIN voters_fts f ON f.rowid = v.rowid
WHERE voters_fts MATCH 'ram*'
LIMIT 10;
```

---

## 6. Auth users (Better Auth)

You cannot copy `auth.users.encrypted_password` into Better Auth.

Export emails (already in `postgres_export.sql` → `exports/auth_users.csv`).

After Better Auth is running:

1. Keep `public.users` rows as-is (`id`, `role`, `allowed_wards`, `can_edit`).
2. Create a Better Auth account per email (admin plugin or a one-off Worker script) with a temporary password.
3. Set `users.auth_user_id` to the new Better Auth user id.
4. Force password reset (`password_reset_required = 1` is already the default on new profiles).

Do not put `BETTER_AUTH_SECRET` in `.env` files that Vite bundles.

```bash
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put ADMIN_SETUP_PIN
```

Generate the secret with:

```bash
openssl rand -base64 32
```

---

## 7. Storage: Supabase to R2

Create buckets:

```bash
npx wrangler r2 bucket create voter-photos
npx wrangler r2 bucket create import-temp
```

Add to `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "PHOTOS"
bucket_name = "voter-photos"

[[r2_buckets]]
binding = "IMPORT_TEMP"
bucket_name = "import-temp"
```

### Copy with rclone (best)

Configure a Supabase S3-compatible source (Project Settings → Storage → S3 keys) and an R2 destination (R2 → Manage R2 API tokens).

```bash
rclone copy supabase:voter-photos r2:voter-photos --progress
rclone copy supabase:import-temp r2:import-temp --progress
```

Preserve object keys. `voters.photo_url` stores the storage path, not a signed URL.

### Copy with a signed-list loop (fallback)

```bash
npx supabase storage ls voter-photos --recursive > /tmp/photos.txt
while IFS= read -r key; do
  npx wrangler r2 object put "voter-photos/${key}" --file="/tmp/obj" || true
done < /tmp/photos.txt
```

You must download each object first (service role or signed URL). Keep keys identical.

### Thumbnails (kill Image Transformation)

Once objects are in R2, run a one-off Worker or local script that for each `orig` key writes `t500/{same-key}` at 500x500 cover. Serve `/media/t500/...` with a long Cache-Control.

Do not enable Cloudflare Images. Do not enable Image Resizing.

Verify:

```bash
npx wrangler r2 object list voter-photos
```

---

## 8. Worker + Pages wiring

Keep `pages_build_output_dir = "dist"`.

Same-origin is the goal: Pages serves the SPA, the Worker handles `/api/*` and `/media/*`. On Cloudflare, attach the Worker as the Pages Functions backend or use a Worker route on the same custom domain.

Local:

```bash
npx wrangler dev
npm run dev
```

Vite must proxy `/api` and `/media` to wrangler (see roadmap). Also set:

```ts
server: {
  allowedHosts: ['.monkeycode-ai.live'],
}
```

Pages env: delete `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` after cutover. Do not add D1 tokens as Vite env.

---

## 9. Cutover sequence

1. Freeze writes on Supabase (or accept a short dual-write window).
2. Re-export tables that changed since the first dump (at least `voters`, `team_leader_assignments`, `meeting_invitees`).
3. Load the delta into D1.
4. Point the production Pages project at the Worker API.
5. Smoke test: login, dashboard counts, voter search, one photo, one voter edit, one meeting upsert.
6. Disable Supabase Auth providers.
7. After 7 days of clean traffic, delete the Supabase project.

Rollback: keep the old Pages deployment and Supabase project until step 7. DNS / Pages rollback is faster than restoring D1.

---

## 10. SQL replacements cheat sheet

Full statements live in `docs/d1/003_worker_sql_snippets.sql`.

| Postgres | D1 / Worker |
| --- | --- |
| `search_voters($q,$limit,$offset)` | FTS5 `MATCH` join |
| `refresh_dashboard_stats()` | `INSERT ... ON CONFLICT(id) DO UPDATE` plus JSON breakdowns in JS |
| `remove_team_leader($id)` | `DELETE assignments; DELETE team_leaders` |
| `shift_to_office_and_shifted()` | two `UPDATE ... WHERE voter_id IN (family-size subquery)` |
| `upsert meeting_invitees on (meeting_id, voter_id)` | `INSERT ... ON CONFLICT(meeting_id, voter_id) DO UPDATE` |
| `upsert custom_field_values on (voter_id, field_id)` | `INSERT ... ON CONFLICT(voter_id, field_id) DO UPDATE` |
| RLS `voters_select_by_ward` | `WHERE ward_no IS NULL OR ward_no IN (...)` in Worker |
| `gen_random_uuid()` | `crypto.randomUUID()` |
| `now()` | `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` |

---

## 11. Post-load sanity queries

```sql
SELECT COUNT(*) FROM voters;
SELECT COUNT(*) FROM voters_fts;
SELECT role, COUNT(*) FROM users GROUP BY role;
SELECT notes, COUNT(*) FROM team_leaders GROUP BY notes;
SELECT attendance_status, COUNT(*) FROM meeting_invitees GROUP BY 1;
SELECT id, total_voters, male_count, refreshed_at FROM dashboard_stats;
```

Refresh stats once after load (from a Worker, or paste the INSERT in `003_worker_sql_snippets.sql`).

---

## 12. What not to migrate

- `search_vector` generated column
- `pg_trgm` indexes
- RLS policies
- `storage.buckets` / `storage.objects`
- `auth.*` schema
- Deno Edge Function secrets `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_ANON_KEY`

Those are Postgres/Supabase infrastructure. The Worker + D1 + R2 + Better Auth stack replaces them.
