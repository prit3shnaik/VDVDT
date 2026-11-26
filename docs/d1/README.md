# D1 schema apply order (SaaS baseline)

Fresh install:

```bash
# Control plane
npx wrangler d1 execute voterdata-platform --remote --file=docs/d1/000_platform.sql

# Campaign data plane
npx wrangler d1 execute voterdata --remote --file=docs/d1/001_schema.sql
npx wrangler d1 execute voterdata --remote --file=docs/d1/002_fts_triggers.sql
```

`004_better_auth_schema.sql` is retained for old runbooks but is already included
in `000_platform.sql`. Apply it to `PLATFORM_DB` only, never to the campaign DB.

## Superseded files

The following files describe the pre-SaaS single-constituency schema. Their
changes are folded into `001_schema.sql` / `002_fts_triggers.sql` and they must
not be applied to a fresh SaaS database:

`003_worker_sql_snippets.sql`, `005_dataset_version.sql`,
`006_rented_voter_fields.sql`, `007_voter_description.sql`,
`008_presence_place_backup.sql`, `009_merge_side_open_drop_shift.sql`,
`010_booth_management.sql`, `011_app_settings.sql`, `012_voter_is_active.sql`,
`013_*`, `014_landlords.sql`, `015_voter_category_mn_away_discussion.sql`.

They remain in the tree as history. Do not add new numbered files that assume a
global `epic_no`, a global `users.role`, or a global `dashboard_stats` row.

## Verify

```bash
node scripts/verify-d1-schema.mjs
```

This executes the real SQL files against SQLite (the engine D1 uses) and asserts
the tenancy invariants. Run it after any schema edit.
