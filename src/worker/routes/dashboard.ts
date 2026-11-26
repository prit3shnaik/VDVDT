import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireWorkspace, requireAdmin, type AuthedVars } from '../middleware/auth'
import { refreshDashboardStats } from '../lib/dashboard-stats'

export const dashboard = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

dashboard.get('/api/dashboard-stats', requireUser, requireWorkspace, async (c) => {
  const workspace = c.get('workspace')!
  let row = await c.env.DB.prepare('SELECT * FROM dashboard_stats WHERE workspace_id = ?')
    .bind(workspace.id)
    .first<{ refreshed_at?: string | null }>()
  if (!row || !row.refreshed_at) {
    await refreshDashboardStats(c.env.DB, workspace.id, workspace.org_id)
    row = await c.env.DB.prepare('SELECT * FROM dashboard_stats WHERE workspace_id = ?')
      .bind(workspace.id)
      .first()
  }
  return c.json({ stats: row })
})

// Recomputes this workspace's stats row. Call after imports/bulk writes.
dashboard.post('/api/dashboard-stats/refresh', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const refreshedAt = await refreshDashboardStats(c.env.DB, workspace.id, workspace.org_id)
  return c.json({ ok: true, refreshed_at: refreshedAt })
})
