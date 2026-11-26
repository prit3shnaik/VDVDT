import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireWorkspace, type AuthedVars } from '../middleware/auth'
import { ensureVotersSchema } from '../lib/schema-ensure'

export const shiftedBackup = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

const OFFICE_NOTES_MARKER = '__OFFICE__'
const SHIFTED_NOTES_MARKER = '__SHIFTED__'

function canWrite(profile: AuthedVars['profile']): boolean {
  return profile.role === 'admin' || profile.role === 'sub-admin' || profile.can_edit
}

function csvEscape(value: unknown): string {
  const text = value == null ? '' : String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

shiftedBackup.post('/api/shifted-parking-backup', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  const workspace = c.get('workspace')!
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  await ensureVotersSchema(c.env.DB)
  const db = c.env.DB

  const existingCountRow = await db.prepare('SELECT COUNT(*) AS n FROM shifted_parking_backup WHERE workspace_id = ?').bind(workspace.id).first<{ n: number }>()
  const existingCount = Number(existingCountRow?.n ?? 0)
  if (existingCount > 0) {
    return c.json({
      ok: true,
      alreadyBackedUp: true,
      backupCount: existingCount,
      liveCount: existingCount,
    })
  }

  const { results: leaders } = await db.prepare(
    `SELECT * FROM team_leaders WHERE workspace_id = ? AND (bucket_code IN (?, ?) OR notes IN (?, ?))`,
  ).bind(workspace.id, OFFICE_NOTES_MARKER, SHIFTED_NOTES_MARKER, OFFICE_NOTES_MARKER, SHIFTED_NOTES_MARKER).all<Record<string, unknown>>()

  const parkingLeaders = leaders ?? []
  const leaderIds = parkingLeaders.map((row) => String(row.id ?? '')).filter(Boolean)
  if (!leaderIds.length) {
    return c.json({ ok: true, alreadyBackedUp: false, backupCount: 0, liveCount: 0 })
  }

  const placeholders = leaderIds.map(() => '?').join(',')
  const { results: assignments } = await db.prepare(
    `SELECT a.id AS assignment_id, a.team_leader_id, a.voter_id, a.assigned_at, a.assigned_by, a.is_direct,
            v.epic_no, v.name AS voter_name, v.family_head_epic, v.ward_no, v.part_no, v.section, v.parked_address,
            v.id AS voter_row_id
     FROM team_leader_assignments a
     JOIN voters v ON v.id = a.voter_id
     WHERE a.workspace_id = ? AND a.team_leader_id IN (${placeholders})`,
  ).bind(workspace.id, ...leaderIds).all<Record<string, unknown>>()

  const liveRows = assignments ?? []
  const liveCount = liveRows.length
  const backedUpAt = new Date().toISOString()
  const leaderById = new Map(parkingLeaders.map((row) => [String(row.id), row]))

  const statements = liveRows.map((row) => {
    const leader = leaderById.get(String(row.team_leader_id)) ?? {}
    const notes = String(leader.notes ?? '')
    const parkingKind = notes === OFFICE_NOTES_MARKER ? 'shifted' : 'single'
    return db.prepare(
      `INSERT INTO shifted_parking_backup (
        id, org_id, workspace_id, backed_up_at, parking_kind, leader_id, leader_notes, leader_created_at,
        voter_id, epic_no, voter_name, family_head_epic, ward_no, part_no, section, parked_address,
        assignment_id, assigned_at, assigned_by, is_direct, raw_leader_json, raw_voter_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      workspace.org_id,
      workspace.id,
      backedUpAt,
      parkingKind,
      String(row.team_leader_id),
      notes || null,
      (leader.created_at as string | null) ?? null,
      (row.voter_id as string | null) ?? null,
      (row.epic_no as string | null) ?? null,
      (row.voter_name as string | null) ?? null,
      (row.family_head_epic as string | null) ?? null,
      row.ward_no ?? null,
      row.part_no ?? null,
      row.section ?? null,
      (row.parked_address as string | null) ?? null,
      (row.assignment_id as string | null) ?? null,
      (row.assigned_at as string | null) ?? null,
      (row.assigned_by as string | null) ?? null,
      row.is_direct ?? null,
      JSON.stringify(leader),
      JSON.stringify(row),
    )
  })

  if (statements.length) {
    await db.batch(statements)
  }

  const backupCountRow = await db.prepare('SELECT COUNT(*) AS n FROM shifted_parking_backup WHERE workspace_id = ?').bind(workspace.id).first<{ n: number }>()
  const backupCount = Number(backupCountRow?.n ?? 0)
  if (backupCount !== liveCount) {
    return c.json({
      error: 'Backup count mismatch. Migrate aborted.',
      backupCount,
      liveCount,
    }, 409)
  }

  const copyStatements = liveRows
    .filter((row) => row.voter_id && row.parked_address)
    .map((row) =>
      db.prepare(
        `UPDATE voters SET presence_note = CASE
           WHEN presence_note IS NULL OR TRIM(presence_note) = '' THEN ?
           ELSE presence_note
         END
         WHERE workspace_id = ? AND id = ?`,
      ).bind(String(row.parked_address), workspace.id, String(row.voter_id)),
    )
  if (copyStatements.length) {
    await db.batch(copyStatements)
  }

  return c.json({ ok: true, alreadyBackedUp: false, backupCount, liveCount })
})

shiftedBackup.get('/api/shifted-parking-backup', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  if (profile.role !== 'admin' && profile.role !== 'sub-admin') return c.json({ error: 'Forbidden' }, 403)
  await ensureVotersSchema(c.env.DB)

  const format = (new URL(c.req.url).searchParams.get('format') ?? 'json').toLowerCase()
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM shifted_parking_backup WHERE workspace_id = ? ORDER BY backed_up_at, parking_kind, leader_id',
  ).bind(c.get('workspace')!.id).all<Record<string, unknown>>()
  const rows = results ?? []

  if (format === 'csv') {
    const headers = [
      'id', 'backed_up_at', 'parking_kind', 'leader_id', 'leader_notes', 'leader_created_at',
      'voter_id', 'epic_no', 'voter_name', 'family_head_epic', 'ward_no', 'part_no', 'section',
      'parked_address', 'assignment_id', 'assigned_at', 'assigned_by', 'is_direct',
    ]
    const lines = [headers.join(',')]
    for (const row of rows) {
      lines.push(headers.map((key) => csvEscape(row[key])).join(','))
    }
    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="shifted-parking-backup.csv"',
      },
    })
  }

  return c.json({ rows, count: rows.length })
})
