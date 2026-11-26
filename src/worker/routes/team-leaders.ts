import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireAdmin, requireWorkspace, wardFilter, workspaceFilter, type AuthedVars } from '../middleware/auth'
import { ensureVotersSchema } from '../lib/schema-ensure'

export const teamLeaders = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

function canWrite(profile: AuthedVars['profile']): boolean {
  return profile.role === 'admin' || profile.role === 'sub-admin' || profile.can_edit
}

const UNASSIGNED_COUNTING_SETTING_KEY = 'unassigned_counting_leader_ids'

function parseLeaderIdList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return Array.from(new Set(parsed.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)))
  } catch {
    return []
  }
}

async function loadUnassignedCountingLeaderIds(db: Env['DB'], workspaceId: string): Promise<string[]> {
  await ensureVotersSchema(db)
  const row = await db.prepare('SELECT value FROM app_settings WHERE workspace_id = ? AND key = ?')
    .bind(workspaceId, UNASSIGNED_COUNTING_SETTING_KEY)
    .first<{ value: string }>()
  return parseLeaderIdList(row?.value)
}

// Ward ACL is carried by the linked voter row. LEFT JOIN keeps unlinked/sentinel
// leader rows (__OFFICE__ / __SHIFTED__) visible, since they have no ward of their own.
function leaderWardClause(profile: AuthedVars['profile']) {
  // Workspace is mandatory even for unlinked special buckets: a sentinel row
  // belongs to exactly one workspace.
  const ws = workspaceFilter(profile, 'tl')
  const admin = profile.is_platform_admin
    || profile.workspace_role === 'candidate'
    || profile.workspace_role === 'incharge'
  if (admin) return ws
  const wards = profile.allowed_wards.length > 0 ? profile.allowed_wards : [-1]
  const placeholders = wards.map(() => '?').join(',')
  return {
    clause: `${ws.clause} AND (tl.voter_id IS NULL OR v.id IS NULL OR v.ward_no IS NULL OR v.ward_no IN (${placeholders}))`,
    params: [...ws.params, ...wards],
  }
}

teamLeaders.get('/api/team-leaders', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const url = new URL(c.req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 500) || 500, 500)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
  const q = url.searchParams.get('q')?.trim()
  const partNo = url.searchParams.get('part')

  const { clause, params } = leaderWardClause(profile)
  const { clause: voterClause, params: voterParams } = wardFilter(profile, 'vv')
  const unassignedCountingLeaderIds = await loadUnassignedCountingLeaderIds(c.env.DB, c.get('workspace')!.id)
  const extraUnassignedClause = unassignedCountingLeaderIds.length
    ? ` AND tl.id NOT IN (${unassignedCountingLeaderIds.map(() => '?').join(',')})`
    : ''
  const conditions = [clause]
  const sqlParams: unknown[] = [...params]

  if (q) {
    conditions.push('(tl.display_name LIKE ? OR v.name LIKE ? OR v.epic_no LIKE ?)')
    sqlParams.push(`%${q}%`, `%${q}%`, `%${q}%`)
  }
  if (partNo) {
    conditions.push('tl.part_no = ?')
    sqlParams.push(Number(partNo))
  }

  const statsWhere = voterClause
  const uniqueStmt = await c.env.DB.prepare(
    `WITH assigned AS (
        SELECT
          a.team_leader_id,
          COALESCE(NULLIF(TRIM(vv.family_head_epic), ''), vv.epic_no) AS family_key,
          UPPER(COALESCE(vv.gender, '')) AS gender
        FROM team_leader_assignments a
        JOIN voters vv ON vv.id = a.voter_id
        JOIN team_leaders tl ON tl.id = a.team_leader_id
        WHERE ${statsWhere}
          AND (tl.notes IS NULL OR (tl.notes <> '__OFFICE__' AND tl.notes <> '__SHIFTED__' AND tl.notes <> '__RENTED__'))
          ${extraUnassignedClause}
      ),
      family_stats AS (
        SELECT family_key, COUNT(*) AS members, COUNT(DISTINCT team_leader_id) AS leader_count
        FROM assigned
        WHERE family_key IS NOT NULL AND TRIM(family_key) <> ''
        GROUP BY family_key
      )
      SELECT
        (SELECT COUNT(*) FROM assigned) AS voters,
        (SELECT COUNT(*) FROM family_stats) AS families,
        (SELECT SUM(CASE WHEN gender = 'MALE' THEN 1 ELSE 0 END) FROM assigned) AS male,
        (SELECT SUM(CASE WHEN gender = 'FEMALE' THEN 1 ELSE 0 END) FROM assigned) AS female,
        (SELECT COUNT(*) FROM family_stats WHERE members = 1) AS singles,
        (SELECT COUNT(*) FROM family_stats WHERE members > 1) AS multiFamilies,
        (SELECT COUNT(*) FROM family_stats WHERE leader_count > 1) AS splitFamilies`,
  ).bind(...voterParams, ...unassignedCountingLeaderIds).first()
  const { results } = await c.env.DB.prepare(
    `SELECT tl.*,
            v.name AS voter_name, v.epic_no, v.ward_no, v.photo_url,
            v.relative_name, v.relative_relation, v.house_no, v.age, v.date_of_birth,
            v.gender, v.religion, v.contact_no_1, v.contact_no_2,
            v.part_no AS voter_part_no, v.section AS voter_section, v.section_name, v.sr_no_roll,
            av.name AS assistant_name, av.epic_no AS assistant_epic_no, av.photo_url AS assistant_photo_url,
            COALESCE(stats.assignment_count, 0) AS assignment_count,
            COALESCE(stats.family_count, 0) AS family_count,
            COALESCE(stats.male_count, 0) AS male_count,
            COALESCE(stats.female_count, 0) AS female_count
     FROM team_leaders tl
     LEFT JOIN voters v ON v.id = tl.voter_id
     LEFT JOIN voters av ON av.id = tl.assistant_voter_id
     LEFT JOIN (
       SELECT a.team_leader_id,
              COUNT(*) AS assignment_count,
              COUNT(DISTINCT COALESCE(NULLIF(TRIM(vv.family_head_epic), ''), vv.epic_no)) AS family_count,
              SUM(CASE WHEN UPPER(COALESCE(vv.gender, '')) = 'MALE' THEN 1 ELSE 0 END) AS male_count,
              SUM(CASE WHEN UPPER(COALESCE(vv.gender, '')) = 'FEMALE' THEN 1 ELSE 0 END) AS female_count
       FROM team_leader_assignments a
       JOIN voters vv ON vv.id = a.voter_id
       WHERE ${statsWhere}
       GROUP BY a.team_leader_id
     ) stats ON stats.team_leader_id = tl.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(tl.display_name, v.name) ASC
     LIMIT ? OFFSET ?`
  )
    .bind(...voterParams, ...sqlParams, limit, offset)
    .all()

  return c.json({
    teamLeaders: results ?? [],
    uniqueAssigned: {
      voters: Number(uniqueStmt?.voters ?? 0),
      families: Number(uniqueStmt?.families ?? 0),
      male: Number(uniqueStmt?.male ?? 0),
      female: Number(uniqueStmt?.female ?? 0),
      singles: Number(uniqueStmt?.singles ?? 0),
      multiFamilies: Number(uniqueStmt?.multiFamilies ?? 0),
      splitFamilies: Number(uniqueStmt?.splitFamilies ?? 0),
    },
  })
})

teamLeaders.get('/api/team-leaders/unassigned-counting', requireUser, requireWorkspace, async (c) => {
  const leaderIds = await loadUnassignedCountingLeaderIds(c.env.DB, c.get('workspace')!.id)
  return c.json({ leaderIds })
})

teamLeaders.put('/api/team-leaders/unassigned-counting', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  if (profile.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await ensureVotersSchema(c.env.DB)
  const body = await c.req.json<{ leaderIds?: unknown }>().catch(() => ({} as { leaderIds?: unknown }))
  const requested = parseLeaderIdList(JSON.stringify(Array.isArray(body.leaderIds) ? body.leaderIds : []))

  let leaderIds: string[] = []
  if (requested.length) {
    const placeholders = requested.map(() => '?').join(',')
    const { results } = await c.env.DB.prepare(
      `SELECT id FROM team_leaders
       WHERE workspace_id = ? AND id IN (${placeholders})
         AND voter_id IS NULL
         AND bucket_code IS NULL
         AND (notes IS NULL OR (notes <> '__OFFICE__' AND notes <> '__SHIFTED__' AND notes <> '__RENTED__'))`,
    ).bind(workspace.id, ...requested).all<{ id: string }>()
    const allowed = new Set((results ?? []).map((row) => row.id))
    leaderIds = requested.filter((id) => allowed.has(id))
  }

  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO app_settings (org_id, workspace_id, key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(workspace.org_id, workspace.id, UNASSIGNED_COUNTING_SETTING_KEY, JSON.stringify(leaderIds), now, profile.id).run()

  return c.json({ leaderIds })
})

teamLeaders.get('/api/team-leaders/:id', requireUser, async (c) => {
  const profile = c.get('profile')
  const { clause, params } = leaderWardClause(profile)

  const teamLeader = await c.env.DB.prepare(
    `SELECT tl.*, v.name AS voter_name, v.epic_no, v.ward_no, v.photo_url,
            v.relative_name, v.relative_relation, v.house_no, v.age, v.date_of_birth,
            v.gender, v.religion, v.contact_no_1, v.contact_no_2,
            v.part_no AS voter_part_no, v.section AS voter_section, v.section_name, v.sr_no_roll
     FROM team_leaders tl
     LEFT JOIN voters v ON v.id = tl.voter_id
     WHERE tl.id = ? AND ${clause}`
  )
    .bind(c.req.param('id'), ...params)
    .first()

  if (!teamLeader) return c.json({ error: 'Not found' }, 404)

  await ensureVotersSchema(c.env.DB)
  const { clause: voterClause, params: voterParams } = wardFilter(profile, 'vv')
  const assignmentSelect = `SELECT a.id, a.voter_id, a.assigned_at, a.is_direct,
            v.id AS voter_row_id, v.name, v.epic_no, v.ward_no, v.part_no, v.section,
            v.family_head_epic, v.gender, v.photo_url, v.relative_name, v.relative_relation,
            v.house_no, v.age, v.date_of_birth, v.contact_no_1, v.contact_no_2, v.sr_no_roll,
            v.section_name, v.religion, v.voter_category, v.family_label, v.family_color, v.row_color`
  const assignmentFrom = `
     FROM team_leader_assignments a
     JOIN voters v ON v.id = a.voter_id
     WHERE a.workspace_id = ? AND a.team_leader_id = ? AND ${voterClause}
     ORDER BY v.name ASC`
  let assignments
  try {
    assignments = await c.env.DB.prepare(
      `${assignmentSelect},
            v.parked_address, v.presence_status, v.presence_note${assignmentFrom}`,
    )
      .bind(c.get('workspace')!.id, c.req.param('id'), ...voterParams)
      .all()
  } catch {
    assignments = await c.env.DB.prepare(`${assignmentSelect}${assignmentFrom}`)
      .bind(c.get('workspace')!.id, c.req.param('id'), ...voterParams)
      .all()
  }

  return c.json({ teamLeader, assignments: assignments.results ?? [] })
})

teamLeaders.post('/api/team-leaders', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)
  await ensureVotersSchema(c.env.DB)

  const body = await c.req.json<{
    voter_id?: string | null
    display_name?: string | null
    part_no?: number | null
    section?: number | null
    notes?: string | null
    assistant_voter_id?: string | null
  }>()

  if (!body.voter_id && !body.display_name?.trim()) {
    return c.json({ error: 'voter_id or display_name is required' }, 400)
  }

  if (body.voter_id) {
    const owned = await c.env.DB.prepare('SELECT id FROM voters WHERE workspace_id = ? AND id = ?')
      .bind(workspace.id, body.voter_id)
      .first()
    if (!owned) return c.json({ error: 'Voter not found in this workspace' }, 404)
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO team_leaders (id, org_id, workspace_id, voter_id, display_name, part_no, section, notes, assistant_voter_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      workspace.org_id,
      workspace.id,
      body.voter_id ?? null,
      body.display_name?.trim() || null,
      body.part_no ?? null,
      body.section ?? null,
      body.notes?.trim() || null,
      body.assistant_voter_id ?? null,
      profile.id,
      now,
      now
    )
    .run()

  return c.json({ id }, 201)
})

teamLeaders.patch('/api/team-leaders/:id', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)
  await ensureVotersSchema(c.env.DB)

  const id = c.req.param('id')
  const workspace = c.get('workspace')!
  const existing = await c.env.DB.prepare('SELECT id FROM team_leaders WHERE workspace_id = ? AND id = ?').bind(workspace.id, id).first()
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<Record<string, unknown>>()
  const updates: string[] = []
  const values: unknown[] = []

  for (const col of ['voter_id', 'display_name', 'part_no', 'section', 'notes', 'assistant_voter_id']) {
    if (body[col] !== undefined) {
      updates.push(`${col} = ?`)
      values.push(body[col] ?? null)
    }
  }

  if (updates.length === 0) return c.json({ success: true })

  updates.push('updated_at = ?')
  values.push(new Date().toISOString(), id)

  await c.env.DB.prepare(`UPDATE team_leaders SET ${updates.join(', ')} WHERE workspace_id = ? AND id = ?`)
    .bind(...values.slice(0, -1), workspace.id, values[values.length - 1])
    .run()

  return c.json({ success: true })
})

teamLeaders.delete('/api/team-leaders/:id', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const id = c.req.param('id')
  const workspace = c.get('workspace')!
  const existing = await c.env.DB.prepare('SELECT id FROM team_leaders WHERE workspace_id = ? AND id = ?').bind(workspace.id, id).first()
  if (!existing) return c.json({ error: 'Not found' }, 404)

  // team_leader_assignments cascade via FK ON DELETE CASCADE.
  await c.env.DB.prepare('DELETE FROM team_leaders WHERE workspace_id = ? AND id = ?').bind(workspace.id, id).run()
  return c.json({ success: true })
})

// --- assignments -------------------------------------------------------------

// A voter can only be assigned to one leader (UNIQUE(voter_id)), so this reassigns.
teamLeaders.post('/api/team-leaders/:id/assignments', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const leaderId = c.req.param('id')
  const leader = await c.env.DB.prepare('SELECT id FROM team_leaders WHERE workspace_id = ? AND id = ?').bind(workspace.id, leaderId).first()
  if (!leader) return c.json({ error: 'Not found' }, 404)

  const { voter_ids, is_direct } = await c.req.json<{ voter_ids?: string[]; is_direct?: boolean }>()
  if (!Array.isArray(voter_ids) || voter_ids.length === 0) {
    return c.json({ error: 'voter_ids is required' }, 400)
  }

  const now = new Date().toISOString()
  const stmt = c.env.DB.prepare(
    `INSERT INTO team_leader_assignments (id, org_id, workspace_id, team_leader_id, voter_id, assigned_by, assigned_at, is_direct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, voter_id) DO UPDATE SET team_leader_id = excluded.team_leader_id,
       assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at, is_direct = excluded.is_direct`
  )

  await c.env.DB.batch(
    voter_ids.map((voterId) =>
      stmt.bind(crypto.randomUUID(), workspace.org_id, workspace.id, leaderId, voterId, profile.id, now, is_direct ? 1 : 0)
    )
  )

  return c.json({ success: true, assigned: voter_ids.length })
})

teamLeaders.delete('/api/team-leaders/:id/assignments/:voterId', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  await c.env.DB.prepare(
    'DELETE FROM team_leader_assignments WHERE workspace_id = ? AND team_leader_id = ? AND voter_id = ?'
  )
    .bind(c.get('workspace')!.id, c.req.param('id'), c.req.param('voterId'))
    .run()

  return c.json({ success: true })
})
