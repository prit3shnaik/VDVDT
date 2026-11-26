import type { AuthedVars } from '../middleware/auth'
import { buildWorkspaceScope } from './scope'

type Profile = AuthedVars['profile']

/**
 * Access policy for the PostgREST-compatible shim (`/rest/v1/*`).
 *
 * SECURITY: this is an allowlist. A table that is not listed here is not reachable
 * through the shim at all. Every campaign table MUST declare
 * `workspaceScope: 'required'`; the shim injects `org_id`/`workspace_id` from the
 * session before any filter is applied. A table without that declaration is
 * rejected, so adding a policy cannot silently create a cross-workspace leak.
 */
export type WardScope =
  // Table has its own ward_no column.
  | 'own'
  // Table hangs off a voter; scope through voters.id.
  | { via: string }
  // Table is workspace-scoped but has no ward dimension (config/metadata).
  | 'none'

export type Access = 'authenticated' | 'can_edit' | 'admin'
export type WorkspaceScope = 'required'

export interface TablePolicy {
  read: Access
  write: Access | 'deny'
  workspaceScope: WorkspaceScope
  wardScope: WardScope
  /** Columns that may never be written through the shim. */
  immutableColumns?: string[]
  /**
   * Columns stored as JSON text in D1 that were real arrays/objects in Postgres.
   * They must be parsed on read and stringified on write, or the frontend gets a
   * string where it expects an array (e.g. `allowed_wards.join(...)` throws).
   */
  jsonColumns?: string[]
  /** Columns stored as INTEGER 0/1 in D1 that were booleans in Postgres. */
  boolColumns?: string[]
  /** If false, POST will not inject a UUID `id`. Default true. */
  autoId?: boolean
}

export const TABLE_POLICIES: Record<string, TablePolicy> = {
  voters: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: 'own',
    immutableColumns: ['id', 'created_at', 'org_id', 'workspace_id'],
    boolColumns: ['is_active'],
  },
  custom_field_values: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: { via: 'voter_id' },
    immutableColumns: ['org_id', 'workspace_id'],
  },
  custom_fields: {
    read: 'authenticated',
    write: 'admin',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
    jsonColumns: ['options'],
    boolColumns: ['required', 'show_in_card', 'allow_custom_note'],
  },
  groups: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
    boolColumns: ['exclusive_subgroups'],
  },
  group_members: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: { via: 'voter_id' },
    immutableColumns: ['org_id', 'workspace_id'],
  },
  team_leaders: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
  },
  team_leader_assignments: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: { via: 'voter_id' },
    immutableColumns: ['org_id', 'workspace_id'],
    boolColumns: ['is_direct'],
  },
  team_leader_users: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
  },
  meetings: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
  },
  meeting_invitees: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: { via: 'voter_id' },
    immutableColumns: ['org_id', 'workspace_id'],
  },
  job_records: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: { via: 'voter_id' },
    immutableColumns: ['org_id', 'workspace_id'],
  },
  family_merge_events: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
    jsonColumns: ['merged_voter_ids', 'details'],
  },
  dashboard_stats: {
    read: 'authenticated',
    write: 'deny',
    workspaceScope: 'required',
    wardScope: 'none',
    jsonColumns: [
      'religion_breakdown',
      'part_breakdown',
      'age_band_breakdown',
      'birthday_month_breakdown',
    ],
  },
  activity_logs: {
    read: 'admin',
    write: 'deny',
    workspaceScope: 'required',
    wardScope: 'none',
    jsonColumns: ['details'],
  },
  import_batches: {
    read: 'admin',
    write: 'admin',
    workspaceScope: 'required',
    wardScope: 'none',
    jsonColumns: ['error_report', 'success_report', 'photo_match_report', 'duplicate_preview'],
  },
  saved_filter_presets: {
    read: 'admin',
    write: 'deny',
    workspaceScope: 'required',
    wardScope: 'none',
    jsonColumns: ['filters'],
  },
  place_clubs: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
  },
  family_place_clubs: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
    autoId: false,
  },
  family_geotags: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
    autoId: false,
  },
  family_geotag_history: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
  },
  shifted_parking_backup: {
    read: 'admin',
    write: 'admin',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
    jsonColumns: ['raw_leader_json', 'raw_voter_json'],
    boolColumns: ['is_direct'],
  },
  landlords: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: 'own',
    immutableColumns: ['org_id', 'workspace_id'],
  },
  tenant_links: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
  },
  elections: {
    read: 'authenticated',
    write: 'admin',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
  },
  booths: {
    read: 'authenticated',
    write: 'admin',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
  },
  booth_agents: {
    read: 'authenticated',
    write: 'admin',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
  },
  voter_turnout: {
    read: 'authenticated',
    write: 'can_edit',
    workspaceScope: 'required',
    wardScope: { via: 'voter_id' },
    immutableColumns: ['org_id', 'workspace_id'],
  },
  app_settings: {
    read: 'authenticated',
    write: 'admin',
    workspaceScope: 'required',
    wardScope: 'none',
    immutableColumns: ['org_id', 'workspace_id'],
  },
}

/**
 * D1 stores JSON as TEXT and booleans as INTEGER, but the frontend was written against
 * Postgres/PostgREST types. Convert on the way out so call sites keep working.
 */
export function decodeRow(policy: TablePolicy, row: Record<string, unknown>): Record<string, unknown> {
  if (!policy.jsonColumns && !policy.boolColumns) return row

  const out = { ...row }

  for (const column of policy.jsonColumns ?? []) {
    const value = out[column]
    if (typeof value === 'string') {
      try {
        out[column] = JSON.parse(value)
      } catch {
        // Leave malformed JSON as-is rather than throwing on a read.
      }
    }
  }

  for (const column of policy.boolColumns ?? []) {
    const value = out[column]
    if (typeof value === 'number') out[column] = value !== 0
  }

  return out
}

/** Inverse of decodeRow, applied to inserts/updates. */
export function encodeRow(policy: TablePolicy, row: Record<string, unknown>): Record<string, unknown> {
  if (!policy.jsonColumns && !policy.boolColumns) return row

  const out = { ...row }

  for (const column of policy.jsonColumns ?? []) {
    const value = out[column]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      out[column] = JSON.stringify(value)
    }
  }

  for (const column of policy.boolColumns ?? []) {
    const value = out[column]
    if (typeof value === 'boolean') out[column] = value ? 1 : 0
  }

  return out
}

export function isAdmin(profile: Profile): boolean {
  return profile.is_platform_admin
    || profile.workspace_role === 'candidate'
    || profile.workspace_role === 'incharge'
}

export function satisfies(profile: Profile, required: Access): boolean {
  switch (required) {
    case 'authenticated':
      return true
    case 'can_edit':
      return isAdmin(profile) || profile.can_edit
    case 'admin':
      return isAdmin(profile)
  }
}

/**
 * Returns the SQL fragment that restricts a query to the caller's workspace,
 * then to their allowed wards. The workspace predicate is always first.
 */
export function scopeClause(
  profile: Profile,
  policy: TablePolicy,
): { clause: string; params: unknown[] } {
  if (policy.workspaceScope !== 'required') return { clause: '1=0', params: [] }
  if (!profile.workspace_id || !profile.org_id) return { clause: '1=0', params: [] }

  const workspace = { id: profile.workspace_id, org_id: profile.org_id }
  const role = profile.is_platform_admin ? 'platform_admin' : (profile.workspace_role ?? 'field')
  const admin = role === 'candidate' || role === 'incharge' || role === 'platform_admin'

  if (policy.wardScope === 'none' || admin) {
    return buildWorkspaceScope(workspace, role, profile.allowed_wards, { includeWards: false })
  }

  const wards = profile.allowed_wards.length > 0 ? profile.allowed_wards : [-1]
  const placeholders = wards.map(() => '?').join(',')

  if (policy.wardScope === 'own') {
    return {
      clause: `org_id = ? AND workspace_id = ? AND (ward_no IS NULL OR ward_no IN (${placeholders}))`,
      params: [workspace.org_id, workspace.id, ...wards],
    }
  }

  const column = policy.wardScope.via
  return {
    clause: `org_id = ? AND workspace_id = ? AND ${column} IN (
      SELECT id FROM voters
      WHERE org_id = ? AND workspace_id = ? AND (ward_no IS NULL OR ward_no IN (${placeholders}))
    )`,
    params: [workspace.org_id, workspace.id, workspace.org_id, workspace.id, ...wards],
  }
}

/** Backwards-compatible alias for callers that only need the combined clause. */
export function wardScopeClause(profile: Profile, policy: TablePolicy) {
  return scopeClause(profile, policy)
}
