import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireAdmin, type AuthedVars } from '../middleware/auth'

export const activityLogs = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

activityLogs.get('/api/activity-logs', requireUser, requireAdmin, async (c) => {
  const url = new URL(c.req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ? OFFSET ?'
  )
    .bind(limit, offset)
    .all()

  return c.json({ logs: results })
})

// Called by the Worker itself on other routes (not exposed as a public write endpoint).
export async function logActivity(
  env: Env,
  actorUserId: string | null,
  action: string,
  targetTable: string,
  targetId: string | null,
  details?: unknown
) {
  await env.DB.prepare(
    `INSERT INTO activity_logs (id, actor_user_id, action, target_table, target_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      actorUserId,
      action,
      targetTable,
      targetId,
      details ? JSON.stringify(details) : null,
      new Date().toISOString()
    )
    .run()
}
