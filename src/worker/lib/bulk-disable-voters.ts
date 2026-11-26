import type { D1Database } from '@cloudflare/workers-types'
import { compactEpic, parseEpicList } from './bulk-delete-voters'

export const BULK_DISABLE_MAX_EPICS = 2000
const IN_CHUNK = 80

export interface DisableVoterRow {
  id: string
  epic_no: string
  name: string
  part_no: number | null
  section: number | null
  ward_no: number | null
  is_active: number | null
}

export interface BulkDisablePlan {
  requested: number
  found: number
  notFound: string[]
  alreadyDisabled: DisableVoterRow[]
  toChange: DisableVoterRow[]
}

async function selectIn<T>(db: D1Database, sqlPrefix: string, values: string[]): Promise<T[]> {
  if (!values.length) return []
  const out: T[] = []
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db.prepare(`${sqlPrefix} (${placeholders})`).bind(...chunk).all()
    if (results?.length) out.push(...(results as T[]))
  }
  return out
}

async function loadVotersByCompactEpics(db: D1Database, compactEpics: string[]): Promise<DisableVoterRow[]> {
  const found: DisableVoterRow[] = []
  const seenIds = new Set<string>()
  const unmatched = new Set(compactEpics)

  const exact = await selectIn<DisableVoterRow>(
    db,
    `SELECT id, epic_no, name, part_no, section, ward_no, is_active
     FROM voters WHERE epic_no IN`,
    compactEpics,
  )
  for (const row of exact) {
    if (seenIds.has(row.id)) continue
    seenIds.add(row.id)
    found.push(row)
    unmatched.delete(compactEpic(row.epic_no))
  }

  if (!unmatched.size) return found

  const still = Array.from(unmatched)
  for (let i = 0; i < still.length; i += IN_CHUNK) {
    const chunk = still.slice(i, i + IN_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db
      .prepare(
        `SELECT id, epic_no, name, part_no, section, ward_no, is_active
         FROM voters
         WHERE REPLACE(REPLACE(REPLACE(UPPER(epic_no), ' ', ''), '-', ''), '/', '') IN (${placeholders})`,
      )
      .bind(...chunk)
      .all()
    for (const row of ((results ?? []) as unknown as DisableVoterRow[])) {
      const compact = compactEpic(row.epic_no)
      if (!unmatched.has(compact) || seenIds.has(row.id)) continue
      seenIds.add(row.id)
      found.push(row)
      unmatched.delete(compact)
    }
  }

  return found
}

function isActiveRow(row: DisableVoterRow): boolean {
  return row.is_active === null || row.is_active === 1
}

export async function planBulkDisable(db: D1Database, compactEpics: string[]): Promise<BulkDisablePlan> {
  const listed = await loadVotersByCompactEpics(db, compactEpics)
  const foundCompact = new Set(listed.map((row) => compactEpic(row.epic_no)))
  const notFound = compactEpics.filter((epic) => !foundCompact.has(epic))
  const alreadyDisabled = listed.filter((row) => !isActiveRow(row))
  const toChange = listed.filter((row) => isActiveRow(row))
  return {
    requested: compactEpics.length,
    found: listed.length,
    notFound,
    alreadyDisabled,
    toChange,
  }
}

export async function planBulkEnable(db: D1Database, compactEpics: string[]): Promise<BulkDisablePlan> {
  const listed = await loadVotersByCompactEpics(db, compactEpics)
  const foundCompact = new Set(listed.map((row) => compactEpic(row.epic_no)))
  const notFound = compactEpics.filter((epic) => !foundCompact.has(epic))
  const alreadyDisabled = listed.filter((row) => isActiveRow(row))
  const toChange = listed.filter((row) => !isActiveRow(row))
  return {
    requested: compactEpics.length,
    found: listed.length,
    notFound,
    alreadyDisabled,
    toChange,
  }
}

export async function executeBulkDisable(
  db: D1Database,
  ids: string[],
  reason: string | null,
  profileId: string | null,
): Promise<void> {
  if (!ids.length) return
  const now = new Date().toISOString()
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    await db
      .prepare(
        `UPDATE voters
         SET is_active = 0, disabled_at = ?, disabled_reason = ?, updated_at = ?, updated_by = ?
         WHERE id IN (${placeholders})`,
      )
      .bind(now, reason, now, profileId, ...chunk)
      .run()
  }
}

export async function executeBulkEnable(db: D1Database, ids: string[], profileId: string | null): Promise<void> {
  if (!ids.length) return
  const now = new Date().toISOString()
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    await db
      .prepare(
        `UPDATE voters
         SET is_active = 1, disabled_at = NULL, disabled_reason = NULL, updated_at = ?, updated_by = ?
         WHERE id IN (${placeholders})`,
      )
      .bind(now, profileId, ...chunk)
      .run()
  }
}

export function disablePreviewPayload(plan: BulkDisablePlan, mode: 'disable' | 'enable') {
  const alreadyLabel = mode === 'disable' ? 'alreadyDisabled' : 'alreadyActive'
  return {
    requested: plan.requested,
    found: plan.found,
    notFound: plan.notFound,
    [alreadyLabel]: plan.alreadyDisabled.length,
    alreadyDisabled: mode === 'disable' ? plan.alreadyDisabled.length : undefined,
    alreadyActive: mode === 'enable' ? plan.alreadyDisabled.length : undefined,
    changeCount: plan.toChange.length,
    disableCount: mode === 'disable' ? plan.toChange.length : undefined,
    enableCount: mode === 'enable' ? plan.toChange.length : undefined,
    voters: plan.toChange.map((row) => ({
      id: row.id,
      epic_no: row.epic_no,
      name: row.name,
      part_no: row.part_no,
      section: row.section,
      ward_no: row.ward_no,
    })),
  }
}

export { parseEpicList }
