# Tenancy model

This app is a multi-org SaaS. The old build was one constituency in one database.
The redesign separates a control plane from a data plane and makes every campaign
row belong to exactly one workspace.

## Vocabulary (read this first)

| Term | Meaning | Never means |
| --- | --- | --- |
| `org` | Paying customer: a campaign or candidate office | a constituency |
| `workspace` | One constituency / seat inside an org | the whole customer |
| `tenant` | Rental tenant of a landlord (the rental module only, `tenant_links`) | a SaaS customer |

Do not introduce `tenant` for a customer. The rental module already uses the word
correctly; reusing it for SaaS tenancy is the naming collision this design avoids.

## Two D1 databases

Cloudflare Pages has static bindings, so the design uses two fixed databases
instead of one database per customer.

| Binding | Database | Owns |
| --- | --- | --- |
| `PLATFORM_DB` | `voterdata-platform` | Better Auth tables, app `users`, `orgs`, `workspaces`, memberships, plans, subscriptions, invoices, invites, platform audit |
| `DB` | `voterdata` | Campaign data: voters, families, leaders, meetings, field, booth, imports, campaign activity |

`docs/d1/000_platform.sql` creates the control plane. `docs/d1/001_schema.sql`
plus `docs/d1/002_fts_triggers.sql` create the data plane.

The campaign database contains small mirror rows for `orgs`, `workspaces`, and
`users`. SQLite cannot enforce a foreign key across databases, so these mirrors
make `REFERENCES workspaces(id)` real. The platform database remains the source
of truth; the Worker writes the mirror when an org/workspace/user is created or
renamed.

### Why not one D1 per customer in v1

A D1 binding in `wrangler.toml` is static. Per-customer databases need Workers for
Platforms or dispatch namespaces, which is too much machinery for the first SaaS
release. The schema is still shaped so a single workspace can be exported and
restored into a dedicated database later.

## Isolation contract

1. The browser never picks a workspace that the server has not authorised.
   The active workspace comes from `X-Workspace-Id` (or `?workspace_id=`), and the
   Worker checks `workspace_members` before any campaign query.
2. Every `/api/*` and `/rest/v1/*` campaign query injects
   `org_id = ? AND workspace_id = ?` from the resolved session.
3. `src/worker/lib/scope.ts` is the only place that builds that predicate.
   `buildWorkspaceScope(workspace, role, allowedWards)` adds the org/workspace
   pair first, then the ward ACL.
4. `src/worker/lib/rest-policy.ts` is the allowlist. Tables not listed there are
   unreachable through the shim. Business tables are marked
   `workspaceScope: 'required'`; a policy without it is a security bug.
5. FTS5 is database-wide. `voters_fts` stores `workspace_id` as an UNINDEXED
   column and every search also filters `v.workspace_id = ?`.
6. R2 keys are prefixed `org/{org_id}/workspace/{workspace_id}/...`. A photo
   request is rejected unless its prefix matches the resolved workspace.
7. IndexedDB cache keys include the workspace id, so two workspaces never share a
   cached roll on one browser.

## Roles

Platform staff are `users.is_platform_admin = 1`. Customers are never platform
admins.

Org roles (`org_members.role`): `owner`, `billing_admin`, `org_admin`.

Workspace roles (`workspace_members.role`):

| Role | Can do |
| --- | --- |
| `candidate` | Everything in the workspace, including user administration |
| `incharge` | Ops, leaders, categories, imports, audit log |
| `operator` | Data entry; no user administration |
| `booth_agent` | Poll-day turnout only |
| `field` | Geotag and presence only |

`workspace_members.allowed_wards` is JSON text (`[1,2,3]`) and is applied after
the workspace predicate. `can_edit` is an INTEGER 0/1.

## Configurable product data

Hard-coded geography and party names are gone from the platform layer.

- `workspace_categories(workspace_id, code, label, position)` replaces the
  `HOME | OPEN | AWAY | BJP | CONGRESS` CHECK on `voters.voter_category`.
  `voters.voter_category` is plain TEXT, validated in the Worker.
- `workspace_settings.presence_options` replaces the hard-coded
  `IN_MORMUGAO | OUTSIDE_MORMUGAO | ABROAD` labels.
- `workspace_settings.special_leader_buckets` replaces global `__OFFICE__` /
  `__SHIFTED__` / `__RENTED__` sentinel rows. The rows are inserted per workspace
  and identified by `team_leaders.bucket_code`.
- Branding, constituency label, allowed parts/wards and product display name live
  in `workspace_settings` / `workspaces`, not in build-time constants.

Default categories seeded per workspace: Home, Open, Away, BJP, Congress,
MN Discussion, Away Discussion. These are data, not enums.

## D1 rules that the schema follows

- TEXT primary keys (UUID strings), INTEGER 0/1 booleans, ISO-8601 TEXT dates.
- No Postgres types or functions: no UUID, JSONB, TIMESTAMPTZ, BOOLEAN,
  `gen_random_uuid()`, `NOW()`, `ILIKE`, enums, materialized views or RLS.
- Composite unique indexes: `UNIQUE (workspace_id, epic_no)` on voters, never a
  global EPIC unique.
- CHECK constraints are only used for genuinely global domains (gender, status
  enums owned by the product). Customer-configurable values have no CHECK.
- Changing a CHECK requires a table rebuild; that is an explicit numbered
  migration, never a per-request `schema-ensure` rewrite.
- FTS5 uses `content='voters'`, `content_rowid='rowid'`, and triggers that use
  `new.rowid` / `old.rowid`.
- Imports stay chunked (`/api/import/parse`, `/api/import/commit`); no single
  multi-thousand-row INSERT.

## Migration path for an existing single-constituency install

1. Apply `000_platform.sql` to a new platform database.
2. Create one org and one workspace for the existing constituency.
3. Apply `001_schema.sql` + `002_fts_triggers.sql` to a fresh campaign database.
4. Export the old tables and import them with `org_id` and `workspace_id` set to
   the new org/workspace. Do not apply the old 005–015 migrations to the new
   baseline; their changes are folded into 001/002.
5. Copy R2 objects from `orig/{key}` to
   `org/{org_id}/workspace/{workspace_id}/photos/orig/{key}` and rewrite
   `voters.photo_url`.

`scripts/verify-d1-schema.mjs` proves the new schema executes and that two
workspaces can share an EPIC without cross-reading.

## Verification

Two checks run without deploying:

```bash
# 1. SQL + schema isolation (node:sqlite, no server)
npm run verify:schema

# 2. API isolation against a local Worker
npx wrangler d1 execute voterdata-platform --local --config wrangler.pages-dev.toml --file docs/d1/000_platform.sql
npx wrangler d1 execute voterdata --local --config wrangler.pages-dev.toml --file docs/d1/001_schema.sql
npx wrangler d1 execute voterdata --local --config wrangler.pages-dev.toml --file docs/d1/002_fts_triggers.sql
ADMIN_SETUP_PIN=test-pin npx wrangler dev src/worker/dev-entry.ts --config wrangler.pages-dev.toml --port 8787
npm run verify:tenancy
```

`verify:tenancy` creates two orgs and two workspaces, inserts the same EPIC in
both, and asserts: lists and FTS never mix, cross-workspace read/update returns
nothing, categories are workspace-validated, dashboard stats and special
`__OFFICE__` buckets are per workspace, an R2 key from org A is 403 for org B,
and a field member cannot import or read another workspace.

The test is destructive only to the two orgs it creates; it never deletes
customer data. Set `ALLOW_SKIP=1` to treat an unreachable local server as a skip.
