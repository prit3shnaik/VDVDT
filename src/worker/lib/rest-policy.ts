import type { AuthedVars } from '../middleware/auth'

type Profile = AuthedVars['profile']

/**
 * Access policy for the PostgREST-compatible shim (`/rest/v1/*`).
 *
 * SECURITY: this is an allowlist. A table that is not listed here is not reachable
 * through the shim at all. Never add a table with `wardScope: 'none'` unless its rows
 * are genuinely safe for every authenticated user to see, because the shim otherwise
 * has no row-level security of its own — this file *is* the RLS layer.
 */
export type WardScope =
  // Table has its own ward_no column.
  | 'own'
  // Table hangs off a voter; scope through voters.id.
  | { via: string }
  // Table is not ward-scoped (org-level config/metadata).
  | 'none'

export type Access = 'authenticated' | 'can_edit' | 'admin'

export interface TablePolicy {
  read: Access
  write: Access | 'deny'
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
    wardScope: 'own',
    immutableColumns: ['id', 'created_at'],
    boolColumns: ['is_active'],
  },
  custom_field_values: {
    read: 'authenticated',
    write: 'can_edit',
    wardScope: { via: 'voter_id' },
  },
  custom_fields: {
    read: 'authenticated',
    write: 'admin',
    wardScope: 'none',
    jsonColumns: ['options'],
    boolColumns: ['required', 'show_in_card', 'allow_custom_note'],
  },
  groups: {
    read: 'authenticated',
    write: 'can_edit',
    wardScope: 'none',
    boolColumns: ['exclusive_subgroups'],
  },
  group_members: {
    read: 'authenticated',
    write: 'can_edit',
    wardScope: { via: 'voter_id' },
  },
  team_leaders: {
    read: 'authenticated',
    write: 'can_edit',
    wardScope: 'none',
  },
  team_leader_assignments: {
    read: 'authenticated',
    write: 'can_edit',
    wardScope: { via: 'voter_id' },
    boolColumns: ['is_direct'],
  },
  meetings: {
    read: 'authenticated',
    write: 'can_edit',
    wardScope: 'none',
  },
  meeting_invitees: {
    read: 'authenticated',
    write: 'can_edit',
    wardScope: { via: 'voter_id' },
  },
  job_records: {
    read: 'authenticated',
    write: 'can_edit',
    wardScope: { via: 'voter_id' },
  },
  family_merge_events: {
    read: 'authenticated',
    write: 'can_edit',
    wardScope: 'none',
    jsonColumns: ['merged_voter_ids', 'details'],
  },
  dashboard_stats: {
    read: 'authenticated',
    write: 'deny',
    wardScope: 'none',
    jsonColumns: [
      'religion_breakdown',
      'part_breakdown',
      'age_band_breakdown',
      'birthday_month_breakdown',
    ],
  },
  // Admin-only surfaces. `users` is readable by admins only — it holds role and
  // ward grants, so exposing it to normal users would disclose the ACL itself.
  users: {
    read: 'admin',
    write: 'deny',
    wardScope: 'none',
    immutableColumns: ['id', 'auth_user_id', 'role', 'allowed_wards', 'can_edit'],
    jsonColumns: ['allowed_wards'],
    boolColumns: ['can_edit', 'password_reset_required'],
  },
  activity_logs: {
    read: 'admin',
    write: 'deny',
    wardScope: 'none',
    jsonColumns: ['details'],
  },
  import_batches: {
    read: 'admin',
    write: 'admin',
    wardScope: 'none',
    jsonColumns: ['error_report', 'success_report', 'photo_match_report', 'duplicate_preview'],
  },
  saved_filter_presets: {
    read: 'admin',
    write: 'deny',
    wardScope: 'none',
    jsonColumns: ['filters'],
  },
  place_clubs: {
    read: 'authenticated',
    write: 'can_edit',
    wardScope: 'none',
  },
  family_place_clubs: {
    read: 'authenticated',
    write: 'can_edit',
    wardScope: 'none',
    autoId: false,
  },
  shifted_parking_backup: {
    read: 'admin',
    write: 'admin',
    wardScope: 'none',
    jsonColumns: ['raw_leader_json', 'raw_voter_json'],
    boolColumns: ['is_direct'],
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
  return profile.role === 'admin' || profile.role === 'sub-admin'
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
 * Returns the SQL fragment that restricts a query to the caller's allowed wards.
 * Admins and sub-admins are unrestricted. Everyone else is limited to their wards,
 * with ward_no IS NULL rows treated as globally visible (matches wardFilter()).
 */
export function wardScopeClause(
  profile: Profile,
  policy: TablePolicy
): { clause: string; params: unknown[] } {
  if (isAdmin(profile)) return { clause: '', params: [] }
  if (policy.wardScope === 'none') return { clause: '', params: [] }

  const wards = profile.allowed_wards.length > 0 ? profile.allowed_wards : [-1]
  const placeholders = wards.map(() => '?').join(',')

  if (policy.wardScope === 'own') {
    return {
      clause: `(ward_no IS NULL OR ward_no IN (${placeholders}))`,
      params: wards,
    }
  }

  const column = policy.wardScope.via
  return {
    clause: `${column} IN (SELECT id FROM voters WHERE ward_no IS NULL OR ward_no IN (${placeholders}))`,
    params: wards,
  }
}
