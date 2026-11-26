import type { D1Database } from '@cloudflare/workers-types'
import { ensureVotersSchema } from './schema-ensure'
import { ACTIVE_VOTER_SQL } from './voter-active'

/**
 * Recomputes the singleton `dashboard_stats` row (id = 1).
 * Shared by POST /api/dashboard-stats/refresh and the `refresh_dashboard_stats` RPC
 * so the two cannot drift apart.
 */
export async function refreshDashboardStats(db: D1Database): Promise<string> {
  await ensureVotersSchema(db)
  const now = new Date().toISOString()

  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN gender = 'MALE' THEN 1 ELSE 0 END) AS male,
              SUM(CASE WHEN gender = 'FEMALE' THEN 1 ELSE 0 END) AS female,
              SUM(CASE WHEN gender = 'OTHER' THEN 1 ELSE 0 END) AS other,
              COALESCE(AVG(age), 0) AS avg_age
       FROM voters
       WHERE ${ACTIVE_VOTER_SQL}`
    )
    .first<{ total: number; male: number; female: number; other: number; avg_age: number }>()

  const toJsonBreakdown = async (sql: string) => {
    const { results } = await db.prepare(sql).all<{ k: string; c: number }>()
    return JSON.stringify(Object.fromEntries((results ?? []).map((r) => [r.k, r.c])))
  }

  const religionBreakdown = await toJsonBreakdown(
    `SELECT COALESCE(NULLIF(religion, ''), 'UNKNOWN') AS k, COUNT(*) AS c FROM voters WHERE ${ACTIVE_VOTER_SQL} GROUP BY 1`
  )
  const partBreakdown = await toJsonBreakdown(
    `SELECT COALESCE(CAST(part_no AS TEXT), 'UNKNOWN') AS k, COUNT(*) AS c FROM voters WHERE ${ACTIVE_VOTER_SQL} GROUP BY 1`
  )
  const ageBandBreakdown = await toJsonBreakdown(
    `SELECT CASE
       WHEN age IS NULL THEN 'UNKNOWN'
       WHEN age BETWEEN 18 AND 25 THEN '18-25'
       WHEN age BETWEEN 26 AND 35 THEN '26-35'
       WHEN age BETWEEN 36 AND 50 THEN '36-50'
       WHEN age BETWEEN 51 AND 65 THEN '51-65'
       ELSE '66+'
     END AS k, COUNT(*) AS c
      FROM voters WHERE ${ACTIVE_VOTER_SQL} GROUP BY 1`
  )
  const birthdayMonthBreakdown = await toJsonBreakdown(
    `SELECT printf('%02d', CAST(strftime('%m', date_of_birth) AS INTEGER)) AS k, COUNT(*) AS c
     FROM voters WHERE date_of_birth IS NOT NULL AND ${ACTIVE_VOTER_SQL} GROUP BY 1`
  )

  await db
    .prepare(
      `INSERT INTO dashboard_stats (id, total_voters, male_count, female_count, other_count, avg_age,
         religion_breakdown, part_breakdown, age_band_breakdown, birthday_month_breakdown, refreshed_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         total_voters = excluded.total_voters,
         male_count = excluded.male_count,
         female_count = excluded.female_count,
         other_count = excluded.other_count,
         avg_age = excluded.avg_age,
         religion_breakdown = excluded.religion_breakdown,
         part_breakdown = excluded.part_breakdown,
         age_band_breakdown = excluded.age_band_breakdown,
         birthday_month_breakdown = excluded.birthday_month_breakdown,
         refreshed_at = excluded.refreshed_at`
    )
    .bind(
      totals?.total ?? 0,
      totals?.male ?? 0,
      totals?.female ?? 0,
      totals?.other ?? 0,
      totals?.avg_age ?? 0,
      religionBreakdown,
      partBreakdown,
      ageBandBreakdown,
      birthdayMonthBreakdown,
      now
    )
    .run()

  return now
}
