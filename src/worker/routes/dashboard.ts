import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireAdmin, type AuthedVars } from '../middleware/auth'
import { refreshDashboardStats } from '../lib/dashboard-stats'

export const dashboard = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

dashboard.get('/api/dashboard-stats', requireUser, async (c) => {
  let row = await c.env.DB.prepare('SELECT * FROM dashboard_stats WHERE id = 1').first<{ refreshed_at?: string | null }>()
  if (!row || !row.refreshed_at) {
    await refreshDashboardStats(c.env.DB)
    row = await c.env.DB.prepare('SELECT * FROM dashboard_stats WHERE id = 1').first()
  }
  return c.json({ stats: row })
})

// Recomputes the singleton stats row. Call after imports/bulk writes, not on every page load.
dashboard.post('/api/dashboard-stats/refresh', requireUser, requireAdmin, async (c) => {
  const refreshedAt = await refreshDashboardStats(c.env.DB)
  return c.json({ ok: true, refreshed_at: refreshedAt })
})
