# VoterData Management

Constituency voter database web app running entirely on Cloudflare.

- React 18 + TypeScript + Vite + Tailwind CSS
- React Router 6, TanStack Table, Recharts
- Cloudflare Pages (hosting + Functions)
- Cloudflare D1 (SQLite) for data, R2 for photos
- Better Auth for sessions, stored in D1

This repository is intentionally light-theme-only. No dark mode code path is included.

## Architecture

```
browser ──► Cloudflare Pages (static SPA)
              │
              ├─ /api/*      typed Hono routes  ──► D1
              ├─ /rest/v1/*  PostgREST-compatible shim ──► D1
              ├─ /storage/v1/* Supabase-Storage-compatible shim ──► R2
              └─ /media/*    auth-gated photo serving ──► R2
```

The `/rest/v1` shim exists so the original data-access call sites keep working while
pages are migrated to typed `/api` routes. It is **not** an open table proxy: every
table, permission and ward rule is declared in `src/worker/lib/rest-policy.ts`, which
is the row-level-security boundary for the app.

## Project Structure

- `src/` frontend app (workspace, admin, account route trees)
- `src/worker/` Hono app: routes, auth middleware, D1/R2 access
- `functions/` Cloudflare Pages Functions entry points
- `docs/d1/` D1 schema, FTS triggers, and migrations
- `scripts/` verification and migration tooling
- `public/templates/voter-import-template.csv` import template download
- `wrangler.toml` Cloudflare Pages config

## Local Development

```bash
npm install
cp .env.example .env
```

Create `.dev.vars` (gitignored) with the Worker secrets:

```
BETTER_AUTH_SECRET=<32+ random bytes, base64>
ADMIN_SETUP_PIN=<only needed for first-time admin bootstrap>
```

Run the SPA and the Worker together:

```bash
npm run dev:full      # vite on 5173, worker on 8787
```

Vite proxies `/api`, `/rest`, `/storage` and `/media` to the local Worker.

## Database

Schema and migrations live in `docs/d1/` and are applied with Wrangler:

```bash
npx wrangler d1 execute voterdata --config wrangler.pages-dev.toml --file=docs/d1/001_schema.sql   # local
npx wrangler d1 execute voterdata --remote --config wrangler.pages-dev.toml --file=docs/d1/001_schema.sql
```

Order: `001_schema.sql`, `002_fts_triggers.sql`, `004_better_auth_schema.sql`,
`005_dataset_version.sql`, `006_rented_voter_fields.sql`, `007_voter_description.sql`.

## First admin

Set `ADMIN_SETUP_PIN`, then:

```bash
node scripts/bootstrap-admin.mjs
```

Delete the secret afterwards — the endpoint returns 404 without it:

```bash
npx wrangler pages secret delete ADMIN_SETUP_PIN --project-name voterdata-management
```

All other users are created from **Admin → Users** in the app.

## Importing voters

`Admin → Import Data` accepts the .xlsx roll export, including photos embedded in the
sheet. Workers cap CPU per request, so the import is a client-driven chunked loop:

```
POST /api/import/parse    → validate, dedupe, stage rows, preview duplicates
POST /api/import/commit   → upsert one chunk of rows (repeat until done)
POST /api/import/photos   → extract + attach one chunk of photos (repeat until done)
```

Blank `part_no` / `section` / `section name` cells carry forward down the sheet, and a
repeated EPIC inside one file is merged rather than duplicated.

## Verification

```bash
node scripts/verify-api.mjs             # auth, CRUD, ward ACL, privilege guards
node scripts/verify-rest-security.mjs   # shim allowlist, injection, type fidelity
node scripts/verify-import.mjs          # xlsx import end-to-end (localhost only)
node scripts/measure-load.mjs           # page-load cost measurement
node scripts/cleanup-test-residue.mjs   # remove anything a crashed test left behind
```

`verify-api` and `verify-rest-security` accept `VERIFY_BASE_URL` to target a
deployment. `verify-import` writes voter rows and refuses non-localhost targets
unless given `--allow-remote`.

## Deploy

```bash
npm run build
npx wrangler pages deploy dist --project-name voterdata-management
```

Note that Wrangler compiles `functions/` from source at deploy time, so a failing
`tsc` does **not** block a deploy — always run `npm run build` first.

## Cost and performance notes

The workspace pages hold the full voter roll client-side. To keep D1 reads and Worker
invocations low:

- `/api/voters/version` returns a trigger-maintained change stamp. The client only
  re-fetches the roll when that stamp changes, so a normal page visit costs **one row
  read** instead of ~16k.
- The roll is cached in IndexedDB, not localStorage — it is several MB and silently
  exceeded the localStorage quota, which is why it used to re-fetch every time.
- The roll pages in 2000-row batches (~9 requests, not ~41).
- Photos are served with `Cache-Control: private` and cached by the service worker,
  so repeat views do not hit R2.
