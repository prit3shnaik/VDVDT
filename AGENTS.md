# AGENTS.md

## What this repo is

Multi-org SaaS constituency operating system on Cloudflare Pages + D1 + R2 +
Better Auth. React 18 + Vite frontend, Hono Worker backend.

## Vocabulary (do not break)

- `org` = paying customer (campaign / candidate office).
- `workspace` = one constituency / seat inside an org.
- `tenant` = rental tenant of a landlord only (`tenant_links`, `landlords`).
  Never use `tenant` for a SaaS customer.

## Databases

- `PLATFORM_DB` (`voterdata-platform`): Better Auth tables, app `users`, `orgs`,
  `workspaces`, `org_members`, `workspace_members`, `workspace_settings`,
  `workspace_categories`, `plans`, `subscriptions`, `invoices`, `invites`,
  `platform_activity_logs`.
- `DB` (`voterdata`): campaign data. Every business table has `org_id` and
  `workspace_id`. `PLATFORM_DB` falls back to `DB` for single-database local
  installs.

Schema files: `docs/d1/000_platform.sql`, `docs/d1/001_schema.sql`,
`docs/d1/002_fts_triggers.sql`. These are the baseline; old 005–015 migrations
are folded in and should not be re-applied.

## Isolation invariants

1. Resolve workspace only through `src/worker/middleware/auth.ts` +
   `src/worker/lib/scope.ts`. Browser sends `X-Workspace-Id`; server checks
   `workspace_members` (platform admins may open any workspace).
2. Every campaign query includes `org_id = ? AND workspace_id = ?`. Use
   `wardFilter(profile, alias)` / `workspaceFilter(profile, alias)`; never build
   a bare query against a campaign table.
3. `src/worker/lib/rest-policy.ts` is the RLS allowlist. Tables absent from it
   are unreachable via `/rest/v1`. Business tables must be
   `workspaceScope: 'required'`.
4. FTS5 is database-wide: `voters_fts.workspace_id` is UNINDEXED, and searches
   also filter `v.workspace_id = ?`.
5. R2 keys are prefixed `org/{org}/workspace/{ws}/photos/...` and
   `.../imports/...`. `voters.photo_url` stores a workspace-relative key.
6. Frontend cache keys/scopes include the workspace id
   (`src/lib/workspace.ts`, `buildWardScope`). Do not add a global cache key for
   voter data.
7. Categories/presence are workspace data (`workspace_categories`,
   `workspace_settings.presence_options`). No party/geography CHECK constraints
   in the platform schema.

## D1 rules

SQLite only. TEXT UUID PKs, INTEGER 0/1 booleans, ISO-8601 TEXT timestamps.
No Postgres types/functions. Composite unique indexes, e.g.
`UNIQUE (workspace_id, epic_no)` on voters. Changing a CHECK requires an explicit
numbered table rebuild; `schema-ensure.ts` may add columns but must not rewrite
product logic per request. Imports stay chunked (`/api/import/parse` +
`/api/import/commit`).

## Commands

```bash
npm run dev:full       # vite + worker
npm run build          # tsc -b && vite build
npm run verify:schema  # node:sqlite schema + DB isolation
npm run verify:tenancy # API isolation (needs local Worker; see docs/TENANCY.md)
```

Local API test setup:

```bash
npx wrangler d1 execute voterdata-platform --local --config wrangler.pages-dev.toml --file docs/d1/000_platform.sql
npx wrangler d1 execute voterdata --local --config wrangler.pages-dev.toml --file docs/d1/001_schema.sql
npx wrangler d1 execute voterdata --local --config wrangler.pages-dev.toml --file docs/d1/002_fts_triggers.sql
ADMIN_SETUP_PIN=test-pin npx wrangler dev src/worker/dev-entry.ts --config wrangler.pages-dev.toml --port 8787
npm run verify:tenancy
```

Better Auth checks `Origin` against `APP_ORIGIN` (`http://localhost:8788`), so
API tests must send `Origin: http://localhost:8788` even when calling port 8787.
