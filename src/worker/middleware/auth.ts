import type { Context, Next } from 'hono'
import type { Env } from '../env'
import { platformDb } from '../env'
import { createAuth } from '../auth'
import {
  buildWorkspacePredicate,
  buildWorkspaceScope,
  listWorkspaceMemberships,
  resolveWorkspaceAccess,
  type MembershipSummary,
  type WorkspaceRef,
  type WorkspaceRole,
} from '../lib/scope'

export type AuthedVars = {
  userId: string
  authUser: { id: string; email: string; name: string }
  platformUser: {
    id: string
    auth_user_id: string
    full_name: string | null
    email: string
    is_platform_admin: boolean
    password_reset_required: boolean
  }
  /**
   * Legacy-compatible profile shape used by existing routes. `role` is a
   * workspace-level mapping (candidate/incharge -> admin) and must never be
   * mistaken for a platform role; use `is_platform_admin` for that.
   */
  profile: {
    id: string
    auth_user_id: string
    full_name: string | null
    email: string
    role: 'admin' | 'sub-admin' | 'user'
    workspace_role: WorkspaceRole | null
    is_platform_admin: boolean
    org_id: string | null
    workspace_id: string | null
    allowed_wards: number[]
    can_edit: boolean
  }
  orgId: string | null
  workspace: WorkspaceRef | null
  workspaceMember: { role: WorkspaceRole | null; allowed_wards: number[]; can_edit: boolean } | null
  memberships: MembershipSummary[]
}

type Ctx = Context<{ Bindings: Env; Variables: AuthedVars }>

function requestedWorkspaceId(c: Ctx): string | null {
  const header = c.req.header('x-workspace-id')?.trim()
  if (header) return header
  const query = new URL(c.req.url).searchParams.get('workspace_id')?.trim()
  return query || null
}

function legacyRole(role: WorkspaceRole | null, isPlatformAdmin: boolean): 'admin' | 'sub-admin' | 'user' {
  if (isPlatformAdmin) return 'admin'
  if (role === 'candidate' || role === 'incharge') return 'admin'
  return 'user'
}

// Reads the Better Auth session, then resolves the platform user, memberships
// and the active workspace. Rejects with 401/403 when the caller may not use
// the requested workspace.
export async function requireUser(c: Ctx, next: Next) {
  const auth = createAuth(c.env)
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const platform = platformDb(c.env)
  const row = await platform
    .prepare(
      `SELECT id, auth_user_id, full_name, email, is_platform_admin, password_reset_required
       FROM users WHERE auth_user_id = ?`,
    )
    .bind(session.user.id)
    .first<{
      id: string
      auth_user_id: string
      full_name: string | null
      email: string
      is_platform_admin: number
      password_reset_required: number
    }>()

  if (!row) {
    return c.json({ error: 'No profile for this account' }, 403)
  }

  const isPlatformAdmin = Boolean(row.is_platform_admin)
  const memberships = await listWorkspaceMemberships(platform, row.id)

  const requested = requestedWorkspaceId(c)
  let workspace: WorkspaceRef | null = null
  let workspaceRole: WorkspaceRole | null = null
  let allowedWards: number[] = []
  let memberCanEdit = false

  if (requested) {
    const membership = memberships.find((m) => m.workspace.id === requested)
    if (membership) {
      workspace = membership.workspace
      workspaceRole = membership.role
    } else if (isPlatformAdmin) {
      try {
        const access = await resolveWorkspaceAccess(platform, row.id, requested, true)
        workspace = access.workspace
        workspaceRole = access.role
        allowedWards = access.allowedWards
        memberCanEdit = access.canEdit
      } catch {
        return c.json({ error: 'You do not have access to this workspace' }, 403)
      }
    } else {
      return c.json({ error: 'You do not have access to this workspace' }, 403)
    }
  } else if (memberships.length > 0) {
    workspace = memberships[0].workspace
    workspaceRole = memberships[0].role
  }

  // Load the full member row for the active workspace (wards + can_edit).
  if (workspace && !isPlatformAdmin) {
    const member = await platform
      .prepare(
        `SELECT role, allowed_wards, can_edit FROM workspace_members
         WHERE workspace_id = ? AND user_id = ?`,
      )
      .bind(workspace.id, row.id)
      .first<{ role: WorkspaceRole; allowed_wards: string; can_edit: number }>()
    if (member) {
      workspaceRole = member.role
      memberCanEdit = Boolean(member.can_edit)
      try {
        const parsed = JSON.parse(member.allowed_wards)
        allowedWards = Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : []
      } catch {
        allowedWards = []
      }
    }
  }

  c.set('userId', session.user.id)
  c.set('authUser', { id: session.user.id, email: session.user.email, name: session.user.name })
  c.set('platformUser', {
    id: row.id,
    auth_user_id: row.auth_user_id,
    full_name: row.full_name,
    email: row.email,
    is_platform_admin: isPlatformAdmin,
    password_reset_required: Boolean(row.password_reset_required),
  })
  c.set('orgId', workspace?.org_id ?? null)
  c.set('workspace', workspace)
  c.set('workspaceMember', workspace ? {
    role: workspaceRole,
    allowed_wards: allowedWards,
    can_edit: memberCanEdit,
  } : null)
  c.set('memberships', memberships)
  c.set('profile', {
    id: row.id,
    auth_user_id: row.auth_user_id,
    full_name: row.full_name,
    email: row.email,
    role: legacyRole(workspaceRole, isPlatformAdmin),
    workspace_role: workspaceRole,
    is_platform_admin: isPlatformAdmin,
    org_id: workspace?.org_id ?? null,
    workspace_id: workspace?.id ?? null,
    allowed_wards: allowedWards,
    can_edit: isPlatformAdmin || memberCanEdit,
  })

  await next()
}

/** Campaign routes must have a resolved workspace; fail closed otherwise. */
export function requireWorkspace(c: Ctx, next: Next) {
  if (!c.get('workspace')) {
    return c.json({ error: 'Workspace context required' }, 403)
  }
  return next()
}

export function requireAdmin(c: Ctx, next: Next) {
  const profile = c.get('profile')
  if (profile.is_platform_admin) return next()
  if (profile.workspace_role === 'candidate' || profile.workspace_role === 'incharge') return next()
  return c.json({ error: 'Forbidden' }, 403)
}

export function requireCanEdit(c: Ctx, next: Next) {
  const profile = c.get('profile')
  if (profile.is_platform_admin || profile.can_edit) return next()
  return c.json({ error: 'Forbidden' }, 403)
}

/**
 * Workspace + ward predicate. Candidate/incharge (and platform admins) see the
 * whole workspace; other roles are limited to their allowed wards. If no
 * workspace is resolved the predicate is `1=0` so a missed guard cannot leak.
 */
export function wardFilter(
  profile: AuthedVars['profile'],
  prefix = '',
): { clause: string; params: unknown[] } {
  if (!profile.workspace_id || !profile.org_id) {
    return { clause: '1=0', params: [] }
  }
  const role = profile.is_platform_admin ? 'platform_admin' : (profile.workspace_role ?? 'field')
  return buildWorkspaceScope(
    { id: profile.workspace_id, org_id: profile.org_id },
    role,
    profile.allowed_wards,
    { prefix },
  )
}

/** Workspace-only predicate for tables without a ward column. */
export function workspaceFilter(
  profile: AuthedVars['profile'],
  prefix = '',
): { clause: string; params: unknown[] } {
  return buildWorkspacePredicate(
    profile.org_id && profile.workspace_id
      ? { id: profile.workspace_id, org_id: profile.org_id }
      : null,
    prefix,
  )
}
