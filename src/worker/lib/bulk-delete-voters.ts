import type { D1Database, R2Bucket } from '@cloudflare/workers-types'

export const BULK_DELETE_MAX_EPICS = 500
const IN_CHUNK = 80
const BATCH_CHUNK = 40

export interface BulkDeleteVoterRow {
  id: string
  epic_no: string
  name: string
  family_head_epic: string | null
  family_label: string | null
  family_color: string | null
  display_order: number | null
  photo_url: string | null
  part_no: number | null
  ward_no: number | null
}

export interface HeadRewrite {
  fromEpic: string
  fromName: string
  toEpic: string
  toName: string
  remainingCount: number
}

export interface RemainingUpdate {
  id: string
  family_head_epic: string
  display_order: number | null
  family_label: string | null
  family_color: string | null
}

export interface BulkDeletePlan {
  requested: number
  found: number
  notFound: string[]
  deleteCount: number
  wholeFamilies: number
  memberOnly: number
  headRewrites: HeadRewrite[]
  deleteVoters: BulkDeleteVoterRow[]
  remainingUpdates: RemainingUpdate[]
  placeMoves: Array<{ fromEpic: string; toEpic: string }>
  placeDeletes: string[]
}

export function compactEpic(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function parseEpicList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of input) {
    const compact = compactEpic(String(item ?? ''))
    if (compact.length < 3) continue
    if (seen.has(compact)) continue
    seen.add(compact)
    out.push(compact)
  }
  return out
}

function familyGroupKey(voter: BulkDeleteVoterRow): string {
  const head = (voter.family_head_epic ?? '').trim()
  return head || (voter.epic_no ?? '').trim()
}

function sortFamilyMembers(a: BulkDeleteVoterRow, b: BulkDeleteVoterRow): number {
  if (a.display_order != null && b.display_order != null) return a.display_order - b.display_order
  if (a.display_order != null) return -1
  if (b.display_order != null) return 1
  return (a.name ?? '').localeCompare(b.name ?? '')
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

async function loadVotersByCompactEpics(db: D1Database, compactEpics: string[]): Promise<BulkDeleteVoterRow[]> {
  const found: BulkDeleteVoterRow[] = []
  const seenIds = new Set<string>()
  const unmatched = new Set(compactEpics)

  const exact = await selectIn<BulkDeleteVoterRow>(
    db,
    `SELECT id, epic_no, name, family_head_epic, family_label, family_color, display_order, photo_url, part_no, ward_no
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
        `SELECT id, epic_no, name, family_head_epic, family_label, family_color, display_order, photo_url, part_no, ward_no
         FROM voters
         WHERE REPLACE(REPLACE(REPLACE(UPPER(epic_no), ' ', ''), '-', ''), '/', '') IN (${placeholders})`,
      )
      .bind(...chunk)
      .all()
    for (const row of ((results ?? []) as unknown as BulkDeleteVoterRow[])) {
      const compact = compactEpic(row.epic_no)
      if (!unmatched.has(compact) || seenIds.has(row.id)) continue
      seenIds.add(row.id)
      found.push(row)
      unmatched.delete(compact)
    }
  }

  return found
}

async function loadFamilyMembers(db: D1Database, seeds: BulkDeleteVoterRow[]): Promise<BulkDeleteVoterRow[]> {
  const keys = Array.from(new Set(seeds.map(familyGroupKey).filter(Boolean)))
  if (!keys.length) return [...seeds]
  const [byHead, byEpic] = await Promise.all([
    selectIn<BulkDeleteVoterRow>(
      db,
      `SELECT id, epic_no, name, family_head_epic, family_label, family_color, display_order, photo_url, part_no, ward_no
       FROM voters WHERE family_head_epic IN`,
      keys,
    ),
    selectIn<BulkDeleteVoterRow>(
      db,
      `SELECT id, epic_no, name, family_head_epic, family_label, family_color, display_order, photo_url, part_no, ward_no
       FROM voters WHERE epic_no IN`,
      keys,
    ),
  ])
  const byId = new Map<string, BulkDeleteVoterRow>()
  for (const row of [...seeds, ...byHead, ...byEpic]) byId.set(row.id, row)
  return Array.from(byId.values())
}

export async function planBulkDelete(db: D1Database, compactEpics: string[]): Promise<BulkDeletePlan> {
  const listed = await loadVotersByCompactEpics(db, compactEpics)
  const foundCompact = new Set(listed.map((row) => compactEpic(row.epic_no)))
  const notFound = compactEpics.filter((epic) => !foundCompact.has(epic))
  const listedIds = new Set(listed.map((row) => row.id))

  const members = await loadFamilyMembers(db, listed)
  const families = new Map<string, BulkDeleteVoterRow[]>()
  for (const row of members) {
    const key = familyGroupKey(row)
    const group = families.get(key)
    if (group) group.push(row)
    else families.set(key, [row])
  }

  const deleteVoters: BulkDeleteVoterRow[] = []
  const remainingUpdates: RemainingUpdate[] = []
  const headRewrites: HeadRewrite[] = []
  const placeMoves: Array<{ fromEpic: string; toEpic: string }> = []
  const placeDeletes: string[] = []
  let wholeFamilies = 0
  let memberOnly = 0

  for (const [key, group] of families) {
    const sorted = [...group].sort(sortFamilyMembers)
    const toDelete = sorted.filter((row) => listedIds.has(row.id))
    const remaining = sorted.filter((row) => !listedIds.has(row.id))
    if (!toDelete.length) continue

    if (!remaining.length) {
      wholeFamilies += 1
      deleteVoters.push(...toDelete)
      placeDeletes.push(key)
      continue
    }

    const head = sorted.find((row) => compactEpic(row.epic_no) === compactEpic(key)) ?? sorted[0]
    const headDeleted = Boolean(head && listedIds.has(head.id))
    deleteVoters.push(...toDelete)

    if (headDeleted) {
      const nextHead = remaining[0]
      headRewrites.push({
        fromEpic: head.epic_no,
        fromName: head.name,
        toEpic: nextHead.epic_no,
        toName: nextHead.name,
        remainingCount: remaining.length,
      })
      placeMoves.push({ fromEpic: head.epic_no, toEpic: nextHead.epic_no })
      remaining.forEach((row, index) => {
        remainingUpdates.push({
          id: row.id,
          family_head_epic: nextHead.epic_no,
          display_order: index + 1,
          family_label: row.id === nextHead.id ? (head.family_label ?? row.family_label) : (row.family_label ?? null),
          family_color: row.id === nextHead.id ? (head.family_color ?? row.family_color) : (row.family_color ?? null),
        })
      })
    } else {
      memberOnly += toDelete.length
      remaining.forEach((row, index) => {
        remainingUpdates.push({
          id: row.id,
          family_head_epic: row.family_head_epic || head.epic_no,
          display_order: index + 1,
          family_label: row.family_label ?? null,
          family_color: row.family_color ?? null,
        })
      })
    }
  }

  const uniqueDeletes = new Map(deleteVoters.map((row) => [row.id, row]))
  const uniqueDeleteVoters = Array.from(uniqueDeletes.values())

  return {
    requested: compactEpics.length,
    found: listed.length,
    notFound,
    deleteCount: uniqueDeleteVoters.length,
    wholeFamilies,
    memberOnly,
    headRewrites,
    deleteVoters: uniqueDeleteVoters,
    remainingUpdates,
    placeMoves,
    placeDeletes: Array.from(new Set(placeDeletes)),
  }
}

async function runBatches(db: D1Database, statements: ReturnType<D1Database['prepare']>[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    const chunk = statements.slice(i, i + BATCH_CHUNK)
    if (chunk.length) await db.batch(chunk)
  }
}

export async function executeBulkDelete(
  db: D1Database,
  photos: R2Bucket | undefined,
  plan: BulkDeletePlan,
): Promise<void> {
  const now = new Date().toISOString()
  const statements: ReturnType<D1Database['prepare']>[] = []

  for (const update of plan.remainingUpdates) {
    statements.push(
      db.prepare(
        `UPDATE voters
         SET family_head_epic = ?, display_order = ?, family_label = ?, family_color = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        update.family_head_epic,
        update.display_order,
        update.family_label,
        update.family_color,
        now,
        update.id,
      ),
    )
  }

  for (const move of plan.placeMoves) {
    statements.push(
      db.prepare(
        `INSERT INTO family_place_clubs (family_head_epic, place_club_id, updated_at)
         SELECT ?, place_club_id, ?
         FROM family_place_clubs
         WHERE family_head_epic = ?
         ON CONFLICT(family_head_epic) DO UPDATE SET
           place_club_id = excluded.place_club_id,
           updated_at = excluded.updated_at`,
      ).bind(move.toEpic, now, move.fromEpic),
    )
    statements.push(
      db.prepare('DELETE FROM family_place_clubs WHERE family_head_epic = ?').bind(move.fromEpic),
    )
  }

  for (const headEpic of plan.placeDeletes) {
    statements.push(db.prepare('DELETE FROM family_place_clubs WHERE family_head_epic = ?').bind(headEpic))
  }

  const deleteIds = plan.deleteVoters.map((row) => row.id)
  for (let i = 0; i < deleteIds.length; i += IN_CHUNK) {
    const chunk = deleteIds.slice(i, i + IN_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    statements.push(
      db.prepare(`UPDATE team_leaders SET voter_id = NULL, updated_at = ? WHERE voter_id IN (${placeholders})`).bind(now, ...chunk),
    )
    statements.push(
      db.prepare(`UPDATE team_leaders SET assistant_voter_id = NULL, updated_at = ? WHERE assistant_voter_id IN (${placeholders})`).bind(now, ...chunk),
    )
    statements.push(
      db.prepare(
        `DELETE FROM team_leader_assignments WHERE voter_id IN (${placeholders})`,
      ).bind(...chunk),
    )
    statements.push(
      db.prepare(`DELETE FROM group_members WHERE voter_id IN (${placeholders})`).bind(...chunk),
    )
    statements.push(
      db.prepare(`DELETE FROM meeting_invitees WHERE voter_id IN (${placeholders})`).bind(...chunk),
    )
    statements.push(
      db.prepare(`DELETE FROM job_records WHERE voter_id IN (${placeholders})`).bind(...chunk),
    )
    statements.push(
      db.prepare(`DELETE FROM custom_field_values WHERE voter_id IN (${placeholders})`).bind(...chunk),
    )
    statements.push(
      db.prepare(`DELETE FROM voters WHERE id IN (${placeholders})`).bind(...chunk),
    )
  }

  await runBatches(db, statements)

  if (photos) {
    const photoKeys = plan.deleteVoters.map((row) => row.photo_url).filter((key): key is string => Boolean(key))
    for (let i = 0; i < photoKeys.length; i += 20) {
      const chunk = photoKeys.slice(i, i + 20)
      await Promise.all(
        chunk.flatMap((key) => [
          photos.delete(`orig/${key}`).catch(() => undefined),
          photos.delete(`t500/${key}`).catch(() => undefined),
        ]),
      )
    }
  }
}

export function previewPayload(plan: BulkDeletePlan) {
  return {
    requested: plan.requested,
    found: plan.found,
    notFound: plan.notFound,
    deleteCount: plan.deleteCount,
    wholeFamilies: plan.wholeFamilies,
    memberOnly: plan.memberOnly,
    headRewrites: plan.headRewrites,
    voters: plan.deleteVoters.map((row) => ({
      id: row.id,
      epic_no: row.epic_no,
      name: row.name,
      part_no: row.part_no,
      ward_no: row.ward_no,
      family_head_epic: row.family_head_epic,
    })),
  }
}
