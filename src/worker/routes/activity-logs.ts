import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireAdmin, requireWorkspace, type AuthedVars } from '../middleware/auth'
import type { WorkspaceRef } from '../lib/scope'

export const activityLogs = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

activityLogs.get('/api/activity-logs', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const url = new URL(c.req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM activity_logs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  )
    .bind(workspace.id, limit, offset)
    .all()

  return c.json({ logs: results })
})

// Called by the Worker itself on other routes (not exposed as a public write endpoint).
export async function logActivity(
  env: Env,
  workspace: WorkspaceRef | null | undefined,
  actorUserId: string | null,
  action: string,
  targetTable: string,
  targetId: string | null,
  details?: unknown
) {
  // Activity is workspace data. If there is no workspace context, do not write a
  // global row; the caller is a platform route and should use platform audit.
  if (!workspace) return
  await env.DB.prepare(
    `INSERT INTO activity_logs (id, org_id, workspace_id, actor_user_id, action, target_table, target_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      workspace.org_id,
      workspace.id,
      actorUserId,
      action,
      targetTable,
      targetId,
      details ? JSON.stringify(details) : null,
      new Date().toISOString()
    )
    .run()
}
