import type { D1Database } from '@cloudflare/workers-types'

/**
 * Workspace-configurable product data.
 *
 * Category codes, presence labels and special leader buckets are rows, not
 * platform enums. Defaults are seeded per workspace; a workspace may rename or
 * add codes without a schema migration.
 */

export interface CategoryOption {
  code: string
  label: string
  color?: string | null
  position: number
}

export interface PresenceOption {
  code: string
  label: string
  color?: string | null
}

export interface SpecialLeaderBucket {
  code: string
  label: string
}

export const DEFAULT_CATEGORIES: CategoryOption[] = [
  { code: 'HOME', label: 'Home', color: '#2563eb', position: 0 },
  { code: 'OPEN', label: 'Open', color: '#0891b2', position: 1 },
  { code: 'AWAY', label: 'Away', color: '#7c3aed', position: 2 },
  { code: 'BJP', label: 'BJP', color: '#ea580c', position: 3 },
  { code: 'CONGRESS', label: 'Congress', color: '#16a34a', position: 4 },
  { code: 'MN_DISCUSSION', label: 'MN Discussion', color: '#db2777', position: 5 },
  { code: 'AWAY_DISCUSSION', label: 'Away Discussion', color: '#9333ea', position: 6 },
]

export const DEFAULT_PRESENCE_OPTIONS: PresenceOption[] = [
  { code: 'IN_CONSTITUENCY', label: 'In constituency', color: '#16a34a' },
  { code: 'OUTSIDE_CONSTITUENCY', label: 'Outside constituency', color: '#d97706' },
  { code: 'ABROAD', label: 'Abroad', color: '#dc2626' },
]

export const DEFAULT_SPECIAL_LEADER_BUCKETS: SpecialLeaderBucket[] = [
  { code: '__OFFICE__', label: 'Office' },
  { code: '__SHIFTED__', label: 'Shifted' },
  { code: '__RENTED__', label: 'Rented' },
]

export class WorkspaceConfigError extends Error {}

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export async function listCategories(
  platform: D1Database,
  workspaceId: string,
): Promise<CategoryOption[]> {
  const { results } = await platform
    .prepare(
      `SELECT code, label, color, position FROM workspace_categories
       WHERE workspace_id = ? AND is_active = 1
       ORDER BY position ASC, label ASC`,
    )
    .bind(workspaceId)
    .all<CategoryOption>()
  return results ?? []
}

export async function listPresenceOptions(
  platform: D1Database,
  workspaceId: string,
): Promise<PresenceOption[]> {
  const row = await platform
    .prepare('SELECT presence_options FROM workspace_settings WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ presence_options: string }>()
  return safeJson<PresenceOption[]>(row?.presence_options, DEFAULT_PRESENCE_OPTIONS)
}

export async function listSpecialLeaderBuckets(
  platform: D1Database,
  workspaceId: string,
): Promise<SpecialLeaderBucket[]> {
  const row = await platform
    .prepare('SELECT special_leader_buckets FROM workspace_settings WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ special_leader_buckets: string }>()
  return safeJson<SpecialLeaderBucket[]>(row?.special_leader_buckets, DEFAULT_SPECIAL_LEADER_BUCKETS)
}

/** Validate a category code against the workspace's own category list. */
export async function assertCategoryCode(
  platform: D1Database,
  workspaceId: string,
  code: unknown,
): Promise<void> {
  if (code === null || code === undefined || code === '') return
  if (typeof code !== 'string') throw new WorkspaceConfigError('Invalid voter category')
  const categories = await listCategories(platform, workspaceId)
  if (categories.length === 0) return // workspace not seeded yet; accept for migration
  if (!categories.some((category) => category.code === code)) {
    throw new WorkspaceConfigError(`Unknown category for this workspace: ${code}`)
  }
}

/** Validate a presence code against the workspace's own presence options. */
export async function assertPresenceCode(
  platform: D1Database,
  workspaceId: string,
  code: unknown,
): Promise<void> {
  if (code === null || code === undefined || code === '') return
  if (typeof code !== 'string') throw new WorkspaceConfigError('Invalid presence status')
  const options = await listPresenceOptions(platform, workspaceId)
  if (options.length === 0) return
  if (!options.some((option) => option.code === code)) {
    throw new WorkspaceConfigError(`Unknown presence status for this workspace: ${code}`)
  }
}

/**
 * Seed categories, presence options, special leader buckets and the stats row
 * for a new workspace. Safe to re-run.
 */
export async function seedWorkspaceDefaults(
  platform: D1Database,
  campaign: D1Database,
  workspaceId: string,
  orgId: string,
): Promise<void> {
  const now = new Date().toISOString()

  await platform
    .prepare(
      `INSERT INTO workspace_settings (workspace_id, branding, presence_options, special_leader_buckets, print_templates, updated_at)
       VALUES (?, '{}', ?, ?, '{}', ?)
       ON CONFLICT(workspace_id) DO NOTHING`,
    )
    .bind(
      workspaceId,
      JSON.stringify(DEFAULT_PRESENCE_OPTIONS),
      JSON.stringify(DEFAULT_SPECIAL_LEADER_BUCKETS),
      now,
    )
    .run()

  const existing = await platform
    .prepare('SELECT COUNT(*) AS c FROM workspace_categories WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ c: number }>()
  if ((existing?.c ?? 0) === 0) {
    await platform.batch(
      DEFAULT_CATEGORIES.map((category) =>
        platform
          .prepare(
            `INSERT INTO workspace_categories (id, workspace_id, code, label, color, position, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            workspaceId,
            category.code,
            category.label,
            category.color ?? null,
            category.position,
            now,
            now,
          ),
      ),
    )
  }

  // The campaign-side workspace mirror is written by the workspace-create route,
  // which has the name/slug values from the platform row.
  await campaign
    .prepare(
      `INSERT INTO dashboard_stats (workspace_id, org_id) VALUES (?, ?)
       ON CONFLICT(workspace_id) DO NOTHING`,
    )
    .bind(workspaceId, orgId)
    .run()
    .catch(() => {})

  // Special leader buckets are rows in this workspace, never global sentinels.
  for (const bucket of DEFAULT_SPECIAL_LEADER_BUCKETS) {
    await campaign
      .prepare(
        `INSERT INTO team_leaders (id, org_id, workspace_id, voter_id, display_name, notes, bucket_code)
         SELECT ?, ?, ?, NULL, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM team_leaders WHERE workspace_id = ? AND bucket_code = ?
         )`,
      )
      .bind(
        crypto.randomUUID(),
        orgId,
        workspaceId,
        bucket.label,
        bucket.code,
        bucket.code,
        workspaceId,
        bucket.code,
      )
      .run()
      .catch(() => {})
  }
}
