import type { D1Database } from '@cloudflare/workers-types'

/**
 * Tenancy scope helpers.
 *
 * This is the single place that builds the org/workspace predicate used by every
 * campaign query. If a caller cannot provide a resolved workspace, the predicate
 * fails closed (`1=0`) rather than returning unfiltered rows.
 */

export type WorkspaceRole = 'candidate' | 'incharge' | 'operator' | 'booth_agent' | 'field'
export type OrgRole = 'owner' | 'billing_admin' | 'org_admin'
export type ScopeRole = WorkspaceRole | 'platform_admin'

export interface WorkspaceRef {
  id: string
  org_id: string
  name: string
  slug: string | null
  status: string
}

export interface WorkspaceAccess {
  workspace: WorkspaceRef
  /** null only when a platform admin opens a workspace they are not a member of. */
  role: WorkspaceRole | null
  allowedWards: number[]
  canEdit: boolean
  isPlatformAdmin: boolean
  isWorkspaceAdmin: boolean
}

export interface MembershipSummary {
  workspace: WorkspaceRef
  role: WorkspaceRole
}

export class WorkspaceAccessError extends Error {
  status: 401 | 403 | 404
  constructor(message: string, status: 401 | 403 | 404 = 403) {
    super(message)
    this.status = status
  }
}

const WORKSPACE_COLUMNS = 'id, org_id, name, slug, status'

function parseWards(value: unknown): number[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : []
  } catch {
    return []
  }
}

export function isWorkspaceAdminRole(role: WorkspaceRole | null): boolean {
  return role === 'candidate' || role === 'incharge'
}

/** Roles that may write campaign data. */
export function roleCanEdit(role: WorkspaceRole | null, memberCanEdit: boolean): boolean {
  if (role === 'candidate' || role === 'incharge' || role === 'operator') return true
  return memberCanEdit
}

/**
 * Resolve a user's access to one workspace. The platform database is the source
 * of truth for membership; the campaign database is never trusted for this.
 */
export async function resolveWorkspaceAccess(
  platform: D1Database,
  userId: string,
  workspaceId: string,
  isPlatformAdmin: boolean,
): Promise<WorkspaceAccess> {
  const workspace = await platform
    .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?`)
    .bind(workspaceId)
    .first<WorkspaceRef>()

  if (!workspace) throw new WorkspaceAccessError('Workspace not found', 404)

  const member = await platform
    .prepare(
      `SELECT role, allowed_wards, can_edit
       FROM workspace_members
       WHERE workspace_id = ? AND user_id = ?`,
    )
    .bind(workspaceId, userId)
    .first<{ role: WorkspaceRole; allowed_wards: string; can_edit: number }>()

  if (!member && !isPlatformAdmin) {
    throw new WorkspaceAccessError('You do not have access to this workspace', 403)
  }

  const role = member?.role ?? null
  return {
    workspace,
    role,
    allowedWards: parseWards(member?.allowed_wards),
    canEdit: isPlatformAdmin || roleCanEdit(role, Boolean(member?.can_edit)),
    isPlatformAdmin,
    isWorkspaceAdmin: isPlatformAdmin || isWorkspaceAdminRole(role),
  }
}

/** All workspaces a user can switch to, for the workspace switcher. */
export async function listWorkspaceMemberships(
  platform: D1Database,
  userId: string,
): Promise<MembershipSummary[]> {
  const { results } = await platform
    .prepare(
      `SELECT w.id, w.org_id, w.name, w.slug, w.status, m.role
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ? AND w.status = 'active'
       ORDER BY w.name ASC`,
    )
    .bind(userId)
    .all<WorkspaceRef & { role: WorkspaceRole }>()

  return (results ?? []).map((row) => ({
    workspace: {
      id: row.id,
      org_id: row.org_id,
      name: row.name,
      slug: row.slug,
      status: row.status,
    },
    role: row.role,
  }))
}

/** Assert that an already-resolved session may act on `workspaceId`. */
export function assertWorkspaceAccess(
  access: WorkspaceAccess | null,
  workspaceId: string,
): WorkspaceAccess {
  if (!access || access.workspace.id !== workspaceId) {
    throw new WorkspaceAccessError('You do not have access to this workspace', 403)
  }
  return access
}

/**
 * Build the SQL predicate that scopes a campaign query to one workspace.
 *
 * The org/workspace pair always comes first. Ward filtering is applied after it
 * for non-admin workspace roles, so a ward filter can never widen the workspace
 * boundary.
 */
export function buildWorkspaceScope(
  workspace: Pick<WorkspaceRef, 'id' | 'org_id'>,
  role: ScopeRole,
  allowedWards: number[],
  options: { prefix?: string; includeWards?: boolean } = {},
): { clause: string; params: unknown[] } {
  if (!workspace?.id || !workspace?.org_id) {
    return { clause: '1=0', params: [] }
  }

  const prefix = options.prefix ? `${options.prefix}.` : ''
  const params: unknown[] = [workspace.org_id, workspace.id]
  let clause = `${prefix}org_id = ? AND ${prefix}workspace_id = ?`

  const includeWards = options.includeWards !== false
  const admin = role === 'candidate' || role === 'incharge' || role === 'platform_admin'
  if (includeWards && !admin) {
    const wards = allowedWards.length > 0 ? allowedWards : [-1]
    const placeholders = wards.map(() => '?').join(',')
    clause += ` AND (${prefix}ward_no IS NULL OR ${prefix}ward_no IN (${placeholders}))`
    params.push(...wards)
  }

  return { clause, params }
}

/** Workspace-only predicate for tables that have no ward column. */
export function buildWorkspacePredicate(
  workspace: Pick<WorkspaceRef, 'id' | 'org_id'> | null,
  prefix = '',
): { clause: string; params: unknown[] } {
  if (!workspace?.id || !workspace?.org_id) return { clause: '1=0', params: [] }
  const p = prefix ? `${prefix}.` : ''
  return {
    clause: `${p}org_id = ? AND ${p}workspace_id = ?`,
    params: [workspace.org_id, workspace.id],
  }
}

/** R2 key prefix for one workspace. Never store photos under a global key. */
export function r2WorkspacePrefix(
  orgId: string,
  workspaceId: string,
  kind: 'photos' | 'imports',
): string {
  return `org/${orgId}/workspace/${workspaceId}/${kind}/`
}

/** Returns the workspace-relative key, or throws if the key escapes the prefix. */
export function stripWorkspacePrefix(
  orgId: string,
  workspaceId: string,
  kind: 'photos' | 'imports',
  key: string,
): string {
  const clean = key.replace(/^\/+/, '')
  const prefix = r2WorkspacePrefix(orgId, workspaceId, kind)
  if (!clean.startsWith(prefix)) {
    throw new WorkspaceAccessError('Object is outside this workspace', 403)
  }
  const rest = clean.slice(prefix.length)
  if (!rest || rest.includes('..')) {
    throw new WorkspaceAccessError('Invalid object key', 403)
  }
  return rest
}

/** True when a stored key belongs to the given workspace. */
export function keyBelongsToWorkspace(
  key: string | null | undefined,
  orgId: string,
  workspaceId: string,
  kind: 'photos' | 'imports',
): boolean {
  if (!key) return false
  return key.replace(/^\/+/, '').startsWith(r2WorkspacePrefix(orgId, workspaceId, kind))
}
