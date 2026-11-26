import type { TeamLeader, Voter } from './types'
import { buildWardScope } from './voterCache'
import { supabase } from './supabase'
import { D1_IN_CHUNK, chunksOf, fetchApiJson, fetchInChunks, forEachInChunk } from './d1Query'
import { normalizeVoterCategory } from './voterCategory'

export { chunksOf, D1_IN_CHUNK }

export interface LeaderFamilyStats {
  families: number
  members: number
  male: number
  female: number
}

export interface UniqueAssignmentCounts {
  voters: number
  families: number
  male: number
  female: number
  multiFamilies: number
  singles: number
  splitFamilies: number
}

export function emptyUniqueAssignmentCounts(): UniqueAssignmentCounts {
  return { voters: 0, families: 0, male: 0, female: 0, multiFamilies: 0, singles: 0, splitFamilies: 0 }
}

export function familyHeadKeyOf(voter: Pick<Voter, 'family_head_epic' | 'epic_no'>): string {
  return (voter.family_head_epic || voter.epic_no || '').trim()
}

export function summarizeUniqueAssignments(
  voters: Array<Pick<Voter, 'id' | 'family_head_epic' | 'epic_no' | 'gender'>>,
  voterToLeaderId: Record<string, string>,
  countedLeaderIds: Set<string> | null,
): UniqueAssignmentCounts {
  const familyMembers = new Map<string, number>()
  const familyLeaders = new Map<string, Set<string>>()
  const out = emptyUniqueAssignmentCounts()
  for (const voter of voters) {
    const leaderId = voterToLeaderId[voter.id]
    if (!leaderId) continue
    if (countedLeaderIds && !countedLeaderIds.has(leaderId)) continue
    out.voters += 1
    const gender = (voter.gender ?? '').toLowerCase()
    if (gender === 'male') out.male += 1
    else if (gender === 'female') out.female += 1
    const familyKey = familyHeadKeyOf(voter)
    if (!familyKey) continue
    familyMembers.set(familyKey, (familyMembers.get(familyKey) ?? 0) + 1)
    let leaders = familyLeaders.get(familyKey)
    if (!leaders) {
      leaders = new Set()
      familyLeaders.set(familyKey, leaders)
    }
    leaders.add(leaderId)
  }
  for (const [key, count] of familyMembers) {
    out.families += 1
    if (count === 1) out.singles += 1
    else out.multiFamilies += 1
    if ((familyLeaders.get(key)?.size ?? 0) > 1) out.splitFamilies += 1
  }
  return out
}

export interface TeamLeaderCacheData {
  leaders: TeamLeader[]
  voterToLeaderId: Record<string, string>
  leaderStats: Record<string, LeaderFamilyStats>
  leaderDisplayNameById: Record<string, string>
  voters: Voter[]
  uniqueAssigned?: UniqueAssignmentCounts
}

export interface TeamLeaderDetailCacheData {
  leader: TeamLeader | null
  leaderVoter: Voter | null
  rows: Voter[]
  familyRows: Voter[]
  directVoterIds: string[]
  voterToLeaderId: Record<string, string>
}

export interface TeamLeaderCacheEntry<T> {
  data: T
  savedAt: number
}

export const TEAM_LEADERS_CACHE_KEY = 'vote:team-leaders:data-cache:v1'
export const TEAM_LEADER_DETAIL_CACHE_KEY = 'vote:teamleaderdetail:data-cache:v1'
export const CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 6
export const REFRESH_SKIP_MS = 1000 * 60 * 5

const LIST_CACHE_VERSION = 6
const DETAIL_CACHE_VERSION = 4

interface CachePayload<T> {
  version: number
  savedAt: number
  scope: string
  data: T
}

export function buildTeamLeaderScope(role: string | null | undefined, allowedWards: number[] | null | undefined): string {
  return buildWardScope(role, allowedWards)
}

export function buildTeamLeaderDetailScope(leaderId: string, role: string | null | undefined, allowedWards: number[] | null | undefined): string {
  return `${leaderId}:${buildWardScope(role, allowedWards)}`
}

function readEntry<T>(key: string, scope: string, version: number, maxAgeMs: number): TeamLeaderCacheEntry<T> | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as CachePayload<T>
    if (
      !parsed ||
      parsed.version !== version ||
      parsed.scope !== scope ||
      !parsed.data ||
      typeof parsed.savedAt !== 'number'
    ) {
      return null
    }

    if (Date.now() - parsed.savedAt > maxAgeMs) {
      return null
    }

    return { data: parsed.data, savedAt: parsed.savedAt }
  } catch {
    return null
  }
}

function writeEntry<T>(key: string, scope: string, version: number, data: T): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const payload: CachePayload<T> = {
      version,
      savedAt: Date.now(),
      scope,
      data,
    }
    window.localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    // Ignore storage quota and private mode failures.
  }
}

export function readTeamLeaderCache(scope: string): TeamLeaderCacheEntry<TeamLeaderCacheData> | null {
  return readEntry<TeamLeaderCacheData>(TEAM_LEADERS_CACHE_KEY, scope, LIST_CACHE_VERSION, CACHE_MAX_AGE_MS)
}

export function writeTeamLeaderCache(scope: string, data: TeamLeaderCacheData): void {
  writeEntry<TeamLeaderCacheData>(TEAM_LEADERS_CACHE_KEY, scope, LIST_CACHE_VERSION, {
    ...data,
    leaderDisplayNameById: sanitizeLeaderDisplayNames(data.leaderDisplayNameById),
  })
}

export function readTeamLeaderDetailCache(scope: string): TeamLeaderCacheEntry<TeamLeaderDetailCacheData> | null {
  return readEntry<TeamLeaderDetailCacheData>(TEAM_LEADER_DETAIL_CACHE_KEY, scope, DETAIL_CACHE_VERSION, CACHE_MAX_AGE_MS)
}

export function writeTeamLeaderDetailCache(scope: string, data: TeamLeaderDetailCacheData): void {
  writeEntry<TeamLeaderDetailCacheData>(TEAM_LEADER_DETAIL_CACHE_KEY, scope, DETAIL_CACHE_VERSION, data)
}

// ── Cross-page cache invalidation ─────────────────────────────────────────
//
// Assigning/unassigning families on one page must make the other pages'
// cached numbers refresh. Each page writes only its own cache, so after a
// mutation the OTHER pages' caches are cleared here; the mutating page keeps
// its own cache and rewrites it via load(true).

function removeLocalStorageKey(key: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Ignore storage failures.
  }
}

export function clearTeamLeadersListCache(): void {
  removeLocalStorageKey(TEAM_LEADERS_CACHE_KEY)
}

export function clearTeamLeaderDetailCache(): void {
  removeLocalStorageKey(TEAM_LEADER_DETAIL_CACHE_KEY)
}

// ── Unassigned families cache ─────────────────────────────────────────────
//
// The Not-Assigned page caches the full set of assigned voter ids plus the
// team-leader list. It is kept here (not in the page) so any page can clear
// it when assignments change elsewhere.

export const UNASSIGNED_DATA_CACHE_KEY = 'vote:teamleaders:unassigned:data-cache'
export const UNASSIGNED_DATA_TTL_MS = 1000 * 60 * 5
export const UNASSIGNED_DATA_VERSION = 6

export interface UnassignedLeaderOption {
  id: string
  name: string
  epicNo: string
  part_no: number | null
  section: number | null
  notes: string | null
  voter_id?: string | null
}

interface UnassignedDataCachePayload {
  version: number
  savedAt: number
  scope: string
  assignedVoterIds: string[]
  voterToLeaderId: Record<string, string>
  leaders: UnassignedLeaderOption[]
}

let unassignedMemoryCache: Pick<UnassignedDataCachePayload, 'scope' | 'savedAt' | 'assignedVoterIds' | 'voterToLeaderId' | 'leaders'> | null = null

export function readUnassignedData(scope: string): Pick<UnassignedDataCachePayload, 'savedAt' | 'assignedVoterIds' | 'voterToLeaderId' | 'leaders'> | null {
  if (unassignedMemoryCache && unassignedMemoryCache.scope === scope) {
    return { savedAt: unassignedMemoryCache.savedAt, assignedVoterIds: unassignedMemoryCache.assignedVoterIds, voterToLeaderId: unassignedMemoryCache.voterToLeaderId, leaders: unassignedMemoryCache.leaders }
  }
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(UNASSIGNED_DATA_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as UnassignedDataCachePayload
    if (
      !parsed || parsed.version !== UNASSIGNED_DATA_VERSION || parsed.scope !== scope ||
      !Array.isArray(parsed.assignedVoterIds) || !Array.isArray(parsed.leaders) ||
      typeof parsed.savedAt !== 'number'
    ) {
      return null
    }
    unassignedMemoryCache = { scope, savedAt: parsed.savedAt, assignedVoterIds: parsed.assignedVoterIds, voterToLeaderId: parsed.voterToLeaderId ?? {}, leaders: parsed.leaders }
    return { savedAt: parsed.savedAt, assignedVoterIds: parsed.assignedVoterIds, voterToLeaderId: parsed.voterToLeaderId ?? {}, leaders: parsed.leaders }
  } catch {
    return null
  }
}

export function writeUnassignedData(scope: string, assignedVoterIds: string[], voterToLeaderId: Record<string, string>, leaders: UnassignedLeaderOption[]): void {
  const payload: UnassignedDataCachePayload = {
    version: UNASSIGNED_DATA_VERSION,
    savedAt: Date.now(),
    scope,
    assignedVoterIds,
    voterToLeaderId,
    leaders: leaders.filter((leader) => !isUnresolvedLeaderName(leader.name)),
  }
  unassignedMemoryCache = { scope, savedAt: payload.savedAt, assignedVoterIds, voterToLeaderId, leaders }
  try {
    window.localStorage.setItem(UNASSIGNED_DATA_CACHE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore storage quota / private-mode failures.
  }
}

export function clearUnassignedDataCache(): void {
  unassignedMemoryCache = null
  removeLocalStorageKey(UNASSIGNED_DATA_CACHE_KEY)
}

export interface AssignmentLink {
  team_leader_id: string
  voter_id: string
}

export async function fetchAllAssignmentLinks(): Promise<{ data: AssignmentLink[]; error: string | null }> {
  const rows: AssignmentLink[] = []
  const pageSize = 1000
  const waveSize = 6

  const first = await supabase.from('team_leader_assignments').select('team_leader_id, voter_id').range(0, pageSize - 1)
  if (first.error) return { data: [], error: first.error.message }
  const firstBatch = (first.data as AssignmentLink[] | null) ?? []
  rows.push(...firstBatch)
  if (firstBatch.length < pageSize) return { data: rows, error: null }

  let offset = pageSize
  for (;;) {
    const offsets = Array.from({ length: waveSize }, (_, index) => offset + index * pageSize)
    const results = await Promise.all(
      offsets.map((pageOffset) =>
        supabase.from('team_leader_assignments').select('team_leader_id, voter_id').range(pageOffset, pageOffset + pageSize - 1),
      ),
    )
    let shortPageSeen = false
    for (const result of results) {
      if (result.error) return { data: [], error: result.error.message }
      const page = (result.data as AssignmentLink[] | null) ?? []
      rows.push(...page)
      if (page.length < pageSize) shortPageSeen = true
    }
    if (shortPageSeen) break
    offset += waveSize * pageSize
  }

  return { data: rows, error: null }
}

export interface TransferAssignmentsResult {
  rows: AssignmentLink[]
  moved: number
  skipped: number
}

// Moves voters from one or more source team leaders to a target team leader in
// one operation: the source assignment rows are deleted and re-inserted for the
// target, preserving each voter's is_direct flag. Voters already assigned to
// the target leader are skipped. Used by the inline "Transfer" action on the
// family search results so an already-assigned family can be moved fast
// without visiting the other leader's page.
export async function transferAssignments(params: {
  voterIds: string[]
  fromLeaderIds: string[]
  toLeaderId: string
  assignedBy: string | null
}): Promise<TransferAssignmentsResult> {
  const { voterIds, fromLeaderIds, toLeaderId, assignedBy } = params

  if (!voterIds.length || !fromLeaderIds.length) {
    return { rows: [], moved: 0, skipped: voterIds.length }
  }

  const existing: Array<{ voter_id: string; team_leader_id: string; is_direct: boolean }> = []
  for (const leaderChunk of chunksOf(fromLeaderIds, D1_IN_CHUNK)) {
    existing.push(
      ...await fetchInChunks(
        voterIds,
        (chunk) => supabase
          .from('team_leader_assignments')
          .select('voter_id, team_leader_id, is_direct')
          .in('voter_id', chunk)
          .in('team_leader_id', leaderChunk),
      ),
    )
  }

  const toMove = existing.filter((r) => r.team_leader_id !== toLeaderId)
  const skipped = voterIds.length - toMove.length

  if (toMove.length) {
    for (const leaderChunk of chunksOf(fromLeaderIds, D1_IN_CHUNK)) {
      await forEachInChunk(toMove.map((r) => r.voter_id), async (chunk) => {
        const { error: delError } = await supabase
          .from('team_leader_assignments')
          .delete()
          .in('voter_id', chunk)
          .in('team_leader_id', leaderChunk)
        if (delError) throw new Error(delError.message)
      })
    }

    const { error: insError } = await supabase
      .from('team_leader_assignments')
      .insert(toMove.map((r) => ({
        team_leader_id: toLeaderId,
        voter_id: r.voter_id,
        assigned_by: assignedBy,
        is_direct: r.is_direct === true,
      })))
    if (insError) throw new Error(insError.message)
  }

  return {
    rows: toMove.map((r) => ({ voter_id: r.voter_id, team_leader_id: toLeaderId })),
    moved: toMove.length,
    skipped,
  }
}

export interface AssignFamilyResult {
  inserted: number
  moved: number
  skipped: number
  voterIds: string[]
}

// Assigns voters to a team leader, treating Shifted/Single (special) leaders as
// "not really assigned":
//   - voters with no assignment row get inserted,
//   - voters currently parked under a special leader get their row moved to the
//     new leader (is_direct preserved),
//   - voters already assigned to a real team leader are skipped (a family
//     assigned elsewhere must be transferred instead).
// Returns the ids that now sit under `toLeaderId` so callers can patch local
// state immediately.
export async function assignFamilyToLeader(params: {
  voterIds: string[]
  toLeaderId: string
  assignedBy: string | null
  isDirectVoterIds: Set<string>
  specialLeaderIds: Set<string>
}): Promise<AssignFamilyResult> {
  const { voterIds, toLeaderId, assignedBy, isDirectVoterIds, specialLeaderIds } = params
  const result: AssignFamilyResult = { inserted: 0, moved: 0, skipped: 0, voterIds: [] }
  if (!voterIds.length) return result

  const existing = new Map<string, { team_leader_id: string; is_direct: boolean }>()
  const existingRows = await fetchInChunks<{ voter_id: string; team_leader_id: string; is_direct: boolean | null }>(
    voterIds,
    (chunk) => supabase.from('team_leader_assignments').select('voter_id, team_leader_id, is_direct').in('voter_id', chunk),
  )
  for (const row of existingRows) {
    if (row.voter_id) existing.set(row.voter_id, { team_leader_id: row.team_leader_id, is_direct: row.is_direct === true })
  }

  const toInsert: Array<{ team_leader_id: string; voter_id: string; assigned_by: string | null; is_direct: boolean }> = []
  const toMove: Array<{ voter_id: string; is_direct: boolean }> = []
  for (const voterId of voterIds) {
    const row = existing.get(voterId)
    if (!row) {
      toInsert.push({ team_leader_id: toLeaderId, voter_id: voterId, assigned_by: assignedBy, is_direct: isDirectVoterIds.has(voterId) })
      result.inserted += 1
    } else if (row.team_leader_id === toLeaderId) {
      result.skipped += 1
    } else if (specialLeaderIds.has(row.team_leader_id)) {
      toMove.push({ voter_id: voterId, is_direct: row.is_direct || isDirectVoterIds.has(voterId) })
      result.moved += 1
    } else {
      result.skipped += 1
    }
  }

  if (toMove.length) {
    await forEachInChunk(toMove.map((r) => r.voter_id), async (chunk) => {
      const { error: moveError } = await supabase
        .from('team_leader_assignments')
        .update({ team_leader_id: toLeaderId, assigned_by: assignedBy })
        .in('voter_id', chunk)
      if (moveError) throw new Error(moveError.message)
    })
    const directMoves = toMove.filter((r) => r.is_direct)
    if (directMoves.length) {
      await forEachInChunk(directMoves.map((r) => r.voter_id), async (chunk) => {
        const { error: flagError } = await supabase
          .from('team_leader_assignments')
          .update({ is_direct: true })
          .in('voter_id', chunk)
        if (flagError) throw new Error(flagError.message)
      })
    }
  }
  if (toInsert.length) {
    const { error: insertError } = await supabase.from('team_leader_assignments').insert(toInsert)
    if (insertError) throw new Error(insertError.message)
  }

  result.voterIds = [...toInsert.map((r) => r.voter_id), ...toMove.map((r) => r.voter_id)]
  return result
}

// Moves every current assignment row for the given voters to a new team leader
// in one operation: existing rows are deleted and re-inserted under the target,
// preserving each voter's is_direct flag. Unlike transferAssignments, rows are
// moved regardless of which leader they currently belong to - used to transfer
// a whole family between leaders from the family's own card.
export async function transferFamilyToLeader(params: {
  voterIds: string[]
  toLeaderId: string
  assignedBy: string | null
}): Promise<{ moved: number; voterIds: string[] }> {
  const { voterIds, toLeaderId, assignedBy } = params
  if (!voterIds.length) return { moved: 0, voterIds: [] }

  const rows = (await fetchInChunks<{ voter_id: string; is_direct: boolean | null }>(
    voterIds,
    (chunk) => supabase.from('team_leader_assignments').select('voter_id, is_direct').in('voter_id', chunk),
  )).map((row) => ({ voter_id: row.voter_id, is_direct: row.is_direct === true }))
  if (!rows.length) return { moved: 0, voterIds: [] }

  await forEachInChunk(rows.map((r) => r.voter_id), async (chunk) => {
    const { error: delError } = await supabase
      .from('team_leader_assignments')
      .delete()
      .in('voter_id', chunk)
    if (delError) throw new Error(delError.message)
  })

  const { error: insError } = await supabase.from('team_leader_assignments').insert(
    rows.map((r) => ({
      team_leader_id: toLeaderId,
      voter_id: r.voter_id,
      assigned_by: assignedBy,
      is_direct: r.is_direct,
    })),
  )
  if (insError) throw new Error(insError.message)

  return { moved: rows.length, voterIds: rows.map((r) => r.voter_id) }
}

export interface ReconcileFamilyAssignmentsParams {
  voterIds: string[]
  familyLeaderId: string
  specialLeaderIds: Set<string>
  assignedBy: string | null
}

export interface ReconcileFamilyAssignmentsResult {
  moved: number
  unassigned: number
  changedVoterIds: string[]
}

// Makes a voter's assignment follow the family it now belongs to, after a
// family-structure edit (merge / add member) changed its family_head_epic.
// Only voters currently parked under a Shifted/Single/Rented (special) leader are
// reconciled - real-leader assignments are intentionally left untouched:
//   - family owned by a real team leader   -> the voter is moved to that leader
//   - family parked under a special leader -> the voter is moved to that leader
//   - family is unassigned                 -> the voter's parking row is deleted
// This prevents a parked voter that was merged into another family from
// still appearing under the parking leader AND inside its new family.
export async function reconcileFamilyAssignments(
  params: ReconcileFamilyAssignmentsParams,
): Promise<ReconcileFamilyAssignmentsResult> {
  const { voterIds, familyLeaderId, specialLeaderIds, assignedBy } = params
  if (!voterIds.length || specialLeaderIds.size === 0) return { moved: 0, unassigned: 0, changedVoterIds: [] }

  const existing = new Map<string, { team_leader_id: string; is_direct: boolean }>()
  const existingRows = await fetchInChunks<{ voter_id: string; team_leader_id: string; is_direct: boolean | null }>(
    voterIds,
    (chunk) => supabase.from('team_leader_assignments').select('voter_id, team_leader_id, is_direct').in('voter_id', chunk),
  )
  for (const row of existingRows) {
    if (row.voter_id) existing.set(row.voter_id, { team_leader_id: row.team_leader_id, is_direct: row.is_direct === true })
  }

  const parked = voterIds.filter((id) => {
    const row = existing.get(id)
    return !!row && specialLeaderIds.has(row.team_leader_id) && row.team_leader_id !== familyLeaderId
  })
  if (!parked.length) return { moved: 0, unassigned: 0, changedVoterIds: [] }

  if (familyLeaderId) {
    // Family has a single known owner (real leader or another special leader):
    // move the parked voters there, preserving their is_direct flag.
    const { moved } = await transferFamilyToLeader({ voterIds: parked, toLeaderId: familyLeaderId, assignedBy })
    return { moved, unassigned: 0, changedVoterIds: parked }
  }

  // Family is unassigned - drop the parking assignment so the voter follows
  // the family as unassigned instead of staying parked under Shifted/Single/Rented.
  const specialIds = Array.from(specialLeaderIds)
  for (const leaderChunk of chunksOf(specialIds, D1_IN_CHUNK)) {
    await forEachInChunk(parked, async (chunk) => {
      const { error: delError } = await supabase
        .from('team_leader_assignments')
        .delete()
        .in('voter_id', chunk)
        .in('team_leader_id', leaderChunk)
      if (delError) throw new Error(delError.message)
    })
  }
  return { moved: 0, unassigned: parked.length, changedVoterIds: parked }
}

function buildFamilyHeadEpic(voter: Pick<Voter, 'family_head_epic' | 'epic_no'>): string {
  if (voter.family_head_epic) return voter.family_head_epic.trim()
  return (voter.epic_no ?? '').trim()
}

export interface ApiTeamLeaderRow extends TeamLeader {
  voter_name?: string | null
  epic_no?: string | null
  ward_no?: number | null
  photo_url?: string | null
  relative_name?: string | null
  relative_relation?: string | null
  house_no?: string | null
  age?: number | null
  date_of_birth?: string | null
  gender?: Voter['gender'] | string | null
  religion?: string | null
  contact_no_1?: string | null
  contact_no_2?: string | null
  voter_part_no?: number | null
  voter_section?: number | null
  section_name?: string | null
  sr_no_roll?: number | null
  assistant_name?: string | null
  assistant_epic_no?: string | null
  assistant_photo_url?: string | null
  assignment_count?: number | null
  family_count?: number | null
  male_count?: number | null
  female_count?: number | null
}

export interface ApiTeamLeaderAssignmentRow {
  id: string
  voter_id: string
  assigned_at?: string | null
  is_direct?: boolean | number | null
  voter_row_id?: string | null
  name?: string | null
  epic_no?: string | null
  ward_no?: number | null
  part_no?: number | null
  section?: number | null
  family_head_epic?: string | null
  gender?: Voter['gender'] | string | null
  photo_url?: string | null
  relative_name?: string | null
  relative_relation?: string | null
  house_no?: string | null
  age?: number | null
  date_of_birth?: string | null
  contact_no_1?: string | null
  contact_no_2?: string | null
  sr_no_roll?: number | null
  section_name?: string | null
  religion?: string | null
  voter_category?: Voter['voter_category'] | null
  family_label?: string | null
  family_color?: string | null
  row_color?: string | null
  parked_address?: string | null
  presence_status?: Voter['presence_status'] | null
  presence_note?: string | null
}

export function emptyLeaderStats(): LeaderFamilyStats {
  return { families: 0, members: 0, male: 0, female: 0 }
}

export function statsFromApiLeader(row: ApiTeamLeaderRow): LeaderFamilyStats {
  return {
    families: Number(row.family_count ?? 0),
    members: Number(row.assignment_count ?? 0),
    male: Number(row.male_count ?? 0),
    female: Number(row.female_count ?? 0),
  }
}

export function teamLeaderFromApi(row: ApiTeamLeaderRow): TeamLeader {
  return {
    id: row.id,
    voter_id: row.voter_id ?? null,
    display_name: row.display_name ?? null,
    part_no: row.part_no ?? null,
    section: row.section ?? null,
    notes: row.notes ?? null,
    assistant_voter_id: row.assistant_voter_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function voterFromApiLeader(row: ApiTeamLeaderRow): Voter | undefined {
  if (!row.voter_id) return undefined
  if (!row.voter_name && !row.epic_no && !row.photo_url) return undefined
  return {
    id: row.voter_id,
    epic_no: row.epic_no ?? '',
    name: row.voter_name ?? '',
    relative_name: row.relative_name ?? null,
    relative_relation: row.relative_relation ?? null,
    section_name: row.section_name ?? null,
    ward_no: row.ward_no ?? null,
    part_no: row.voter_part_no ?? null,
    section: row.voter_section ?? null,
    sr_no_roll: row.sr_no_roll ?? null,
    house_no: row.house_no ?? null,
    age: row.age ?? null,
    date_of_birth: row.date_of_birth ?? null,
    contact_no_1: row.contact_no_1 ?? null,
    contact_no_2: row.contact_no_2 ?? null,
    gender: (row.gender as Voter['gender']) ?? null,
    religion: row.religion ?? null,
    state: null,
    voter_category: null,
    family_head_epic: null,
    family_label: null,
    family_color: null,
    row_color: null,
    photo_url: row.photo_url ?? null,
    display_order: null,
    parked_address: null,
    presence_status: null,
    presence_note: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function voterFromApiAssignment(row: ApiTeamLeaderAssignmentRow): Voter {
  const id = row.voter_row_id || row.voter_id
  return {
    id,
    epic_no: row.epic_no ?? '',
    name: row.name ?? '',
    relative_name: row.relative_name ?? null,
    relative_relation: row.relative_relation ?? null,
    section_name: row.section_name ?? null,
    ward_no: row.ward_no ?? null,
    part_no: row.part_no ?? null,
    section: row.section ?? null,
    sr_no_roll: row.sr_no_roll ?? null,
    house_no: row.house_no ?? null,
    age: row.age ?? null,
    date_of_birth: row.date_of_birth ?? null,
    contact_no_1: row.contact_no_1 ?? null,
    contact_no_2: row.contact_no_2 ?? null,
    gender: (row.gender as Voter['gender']) ?? null,
    religion: row.religion ?? null,
    state: null,
    voter_category: normalizeVoterCategory(row.voter_category),
    family_head_epic: row.family_head_epic ?? null,
    family_label: row.family_label ?? null,
    family_color: row.family_color ?? null,
    row_color: row.row_color ?? null,
    photo_url: row.photo_url ?? null,
    display_order: null,
    parked_address: row.parked_address ?? null,
    presence_status: row.presence_status ?? null,
    presence_note: row.presence_note ?? null,
    created_at: '',
    updated_at: '',
  }
}

export async function fetchTeamLeadersFromApi(): Promise<ApiTeamLeaderRow[]> {
  const pageSize = 500
  const rows: ApiTeamLeaderRow[] = []
  for (let offset = 0; ; offset += pageSize) {
    const data = await fetchApiJson<{ teamLeaders: ApiTeamLeaderRow[] }>(
      `/api/team-leaders?limit=${pageSize}&offset=${offset}`,
    )
    const page = data.teamLeaders ?? []
    rows.push(...page)
    if (page.length < pageSize) break
  }
  return rows
}

export async function fetchTeamLeadersSummaryFromApi(): Promise<{
  teamLeaders: ApiTeamLeaderRow[]
  uniqueAssigned: UniqueAssignmentCounts
}> {
  const pageSize = 500
  const rows: ApiTeamLeaderRow[] = []
  let uniqueAssigned = emptyUniqueAssignmentCounts()
  for (let offset = 0; ; offset += pageSize) {
    const data = await fetchApiJson<{ teamLeaders: ApiTeamLeaderRow[]; uniqueAssigned?: Partial<UniqueAssignmentCounts> }>(
      `/api/team-leaders?limit=${pageSize}&offset=${offset}`,
    )
    if (offset === 0 && data.uniqueAssigned) {
      uniqueAssigned = {
        ...emptyUniqueAssignmentCounts(),
        voters: Number(data.uniqueAssigned.voters ?? 0),
        families: Number(data.uniqueAssigned.families ?? 0),
        male: Number(data.uniqueAssigned.male ?? 0),
        female: Number(data.uniqueAssigned.female ?? 0),
        singles: Number(data.uniqueAssigned.singles ?? 0),
        multiFamilies: Number(data.uniqueAssigned.multiFamilies ?? 0),
        splitFamilies: Number(data.uniqueAssigned.splitFamilies ?? 0),
      }
    }
    const page = data.teamLeaders ?? []
    rows.push(...page)
    if (page.length < pageSize) break
  }
  return { teamLeaders: rows, uniqueAssigned }
}

export async function fetchTeamLeaderFromApi(leaderId: string): Promise<{
  teamLeader: ApiTeamLeaderRow
  assignments: ApiTeamLeaderAssignmentRow[]
}> {
  return fetchApiJson(`/api/team-leaders/${encodeURIComponent(leaderId)}`)
}

export async function computeLeaderStats(
  links: AssignmentLink[],
  opts: { hasWardRestriction: boolean; allowedWards: number[] },
  onlyLeaderIds?: string | string[],
): Promise<Record<string, LeaderFamilyStats>> {
  const stats: Record<string, LeaderFamilyStats> = {}
  const affected = onlyLeaderIds
    ? (Array.isArray(onlyLeaderIds) ? onlyLeaderIds : [onlyLeaderIds])
    : null
  const linksForLeaders = affected ? links.filter((a) => affected.includes(a.team_leader_id)) : links
  for (const id of affected ?? []) stats[id] = emptyLeaderStats()

  const assignedVoterIds = Array.from(new Set(linksForLeaders.map((a) => a.voter_id).filter(Boolean)))
  if (!assignedVoterIds.length) return stats

  const assigned = await fetchInChunks<Pick<Voter, 'id' | 'epic_no' | 'family_head_epic' | 'gender'>>(
    assignedVoterIds,
    (chunk) => {
      let req = supabase.from('voters').select('id, epic_no, family_head_epic, gender').in('id', chunk)
      if (opts.hasWardRestriction) req = req.in('ward_no', opts.allowedWards)
      return req
    },
  )
  const assignedById = new Map(assigned.map((v) => [v.id, v]))

  const buckets = new Map<string, { members: number; male: number; female: number; families: Set<string> }>()
  for (const a of linksForLeaders) {
    const v = assignedById.get(a.voter_id)
    if (!v) continue
    let bucket = buckets.get(a.team_leader_id)
    if (!bucket) {
      bucket = { members: 0, male: 0, female: 0, families: new Set() }
      buckets.set(a.team_leader_id, bucket)
    }
    bucket.members += 1
    const g = (v.gender ?? '').toLowerCase()
    if (g === 'male') bucket.male += 1
    else if (g === 'female') bucket.female += 1
    const key = buildFamilyHeadEpic(v)
    if (key) bucket.families.add(key)
  }

  for (const [leaderId, bucket] of buckets) {
    stats[leaderId] = {
      families: bucket.families.size,
      members: bucket.members,
      male: bucket.male,
      female: bucket.female,
    }
  }
  return stats
}

// Recomputes the cached list-page data after a detail-page mutation so the
// team leaders list shows fresh counts without needing a full refetch. It
// refreshes the stats for the affected leaders, the voter->leader map, and
// the affected leader rows (e.g. a changed primary voter). Safe no-op when
// the list cache is missing.
export async function patchTeamLeadersListCacheForLeaders(
  role: string | null | undefined,
  allowedWards: number[] | null | undefined,
  affectedLeaderIds: string[],
): Promise<void> {
  if (!affectedLeaderIds.length) return
  const scope = buildTeamLeaderScope(role, allowedWards)
  const cached = readTeamLeaderCache(scope)
  if (!cached) return

  const data = cached.data
  const hasWardRestriction = (role ?? 'user') !== 'admin' && (allowedWards?.length ?? 0) > 0
  const wardOpts = { hasWardRestriction, allowedWards: allowedWards ?? [] }

  const [linksRes, leaderRows] = await Promise.all([
    fetchAllAssignmentLinks(),
    fetchInChunks<TeamLeader>(
      affectedLeaderIds,
      (chunk) => supabase.from('team_leaders').select('*').in('id', chunk),
    ),
  ])
  const links = linksRes.data
  const patchedStats = await computeLeaderStats(links, wardOpts, affectedLeaderIds)

  const nextVoterToLeader: Record<string, string> = {}
  for (const a of links) {
    if (a.voter_id) nextVoterToLeader[a.voter_id] = a.team_leader_id
  }

  const leadersById = new Map(leaderRows.map((tl) => [tl.id, tl]))
  const nextLeaders = data.leaders.map((tl) => (leadersById.has(tl.id) ? leadersById.get(tl.id)! : tl))

  writeTeamLeaderCache(scope, {
    ...data,
    leaders: nextLeaders,
    voterToLeaderId: nextVoterToLeader,
    leaderStats: { ...data.leaderStats, ...patchedStats },
  })
}

// ── Special parking leaders ───────────────────────────────────────────────
//
// Global parking assignees are modelled as special team_leaders rows with a
// NULL voter_id and a reserved notes marker. Families assigned to them are
// tracked exactly like normal leader assignments (so they count as assigned
// everywhere) while the row stays hidden from the normal leader table.
// Identity is team_leaders.id. Special-ness is notes. Display names are
// painted by resolveTeamLeaderName():
//   __OFFICE__  → UI "Shifted"
//   __SHIFTED__ → UI "Single"
// Legacy __RENTED__ rows are hidden from the leader table.

export const OFFICE_NOTES_MARKER = '__OFFICE__'
export const SHIFTED_NOTES_MARKER = '__SHIFTED__'
export const RENTED_NOTES_MARKER = '__RENTED__'

export function isOfficeLeader(tl: { notes?: string | null } | null | undefined): boolean {
  return !!tl && tl.notes === OFFICE_NOTES_MARKER
}

export function isShiftedLeader(tl: { notes?: string | null } | null | undefined): boolean {
  return !!tl && tl.notes === SHIFTED_NOTES_MARKER
}

export function isRentedLeader(tl: { notes?: string | null } | null | undefined): boolean {
  return !!tl && tl.notes === RENTED_NOTES_MARKER
}

export function isSpecialLeader(tl: { notes?: string | null } | null | undefined): boolean {
  return isOfficeLeader(tl) || isShiftedLeader(tl)
}

export function isCustomNamedLeader(
  tl: { voter_id?: string | null; notes?: string | null } | null | undefined,
): boolean {
  if (!tl || tl.voter_id) return false
  return !isSpecialLeader(tl) && !isRentedLeader(tl)
}

export function specialLeaderMarker(tl: { notes?: string | null } | null | undefined): string | null {
  if (isOfficeLeader(tl)) return OFFICE_NOTES_MARKER
  if (isShiftedLeader(tl)) return SHIFTED_NOTES_MARKER
  return null
}

export function dedupeSpecialLeaders<T extends { id: string; notes?: string | null }>(leaders: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const leader of leaders) {
    const key = specialLeaderMarker(leader) ?? leader.id
    if (seen.has(key)) continue
    seen.add(key)
    out.push(leader)
  }
  return out
}

export function pickCanonicalSpecialLeader<T extends { id: string; notes?: string | null; created_at?: string }>(
  leaders: T[],
  isMatch: (leader: T) => boolean,
  stats?: Record<string, { members?: number }>,
): T | undefined {
  const matches = leaders.filter(isMatch)
  if (!matches.length) return undefined
  return [...matches].sort((a, b) => {
    const byCount = (stats?.[b.id]?.members ?? 0) - (stats?.[a.id]?.members ?? 0)
    if (byCount !== 0) return byCount
    const byCreated = (a.created_at ?? '').localeCompare(b.created_at ?? '')
    if (byCreated !== 0) return byCreated
    return a.id.localeCompare(b.id)
  })[0]
}

export function canonicalSpecialLeaders<T extends { id: string; notes?: string | null; created_at?: string }>(
  leaders: T[],
  stats?: Record<string, { members?: number }>,
): T[] {
  const office = pickCanonicalSpecialLeader(leaders, isOfficeLeader, stats)
  const shifted = pickCanonicalSpecialLeader(leaders, isShiftedLeader, stats)
  const rest = leaders.filter((leader) => !isSpecialLeader(leader) && !isRentedLeader(leader))
  const out: T[] = []
  if (office) out.push(office)
  if (shifted) out.push(shifted)
  out.push(...rest)
  return out
}

export interface ConsolidateSpecialLeaderResult {
  winnerId: string | null
  deletedIds: string[]
  merged: number
  deleted: number
}

export interface ConsolidateSpecialLeadersResult {
  office: ConsolidateSpecialLeaderResult
  shifted: ConsolidateSpecialLeaderResult
  rented: ConsolidateSpecialLeaderResult
  changed: boolean
}

function emptyConsolidateResult(): ConsolidateSpecialLeaderResult {
  return { winnerId: null, deletedIds: [], merged: 0, deleted: 0 }
}

async function listSpecialLeadersByMarker(marker: string): Promise<TeamLeader[]> {
  const { data, error } = await supabase.from('team_leaders').select('*').eq('notes', marker)
  if (error) throw new Error(error.message)
  return (data as TeamLeader[] | null) ?? []
}

async function assignmentVoterIdsForLeader(leaderId: string): Promise<string[]> {
  const rows: string[] = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('team_leader_assignments')
      .select('voter_id')
      .eq('team_leader_id', leaderId)
      .range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const page = (data as Array<{ voter_id: string | null }> | null) ?? []
    for (const row of page) if (row.voter_id) rows.push(row.voter_id)
    if (page.length < pageSize) break
  }
  return rows
}

async function consolidateMarker(marker: string): Promise<ConsolidateSpecialLeaderResult> {
  const rows = await listSpecialLeadersByMarker(marker)
  if (!rows.length) return emptyConsolidateResult()
  if (rows.length === 1) return { winnerId: rows[0].id, deletedIds: [], merged: 0, deleted: 0 }

  const counts = new Map<string, number>()
  for (const row of rows) {
    const voterIds = await assignmentVoterIdsForLeader(row.id)
    counts.set(row.id, voterIds.length)
  }

  const ranked = [...rows].sort((a, b) => {
    const byCount = (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0)
    if (byCount !== 0) return byCount
    const byCreated = (a.created_at ?? '').localeCompare(b.created_at ?? '')
    if (byCreated !== 0) return byCreated
    return a.id.localeCompare(b.id)
  })
  const winner = ranked[0]
  const losers = ranked.slice(1)
  let merged = 0
  const deletedIds: string[] = []

  for (const loser of losers) {
    const voterIds = await assignmentVoterIdsForLeader(loser.id)
    if (voterIds.length) {
      const result = await transferAssignments({
        voterIds,
        fromLeaderIds: [loser.id],
        toLeaderId: winner.id,
        assignedBy: null,
      })
      merged += result.moved
    }
    const remaining = await assignmentVoterIdsForLeader(loser.id)
    if (remaining.length) continue
    const { error } = await supabase.from('team_leaders').delete().eq('id', loser.id)
    if (error) throw new Error(error.message)
    deletedIds.push(loser.id)
  }

  return { winnerId: winner.id, deletedIds, merged, deleted: deletedIds.length }
}

let consolidateSpecialLeadersPromise: Promise<ConsolidateSpecialLeadersResult> | null = null

async function runConsolidateSpecialLeaders(): Promise<ConsolidateSpecialLeadersResult> {
  try {
    const office = await consolidateMarker(OFFICE_NOTES_MARKER)
    const shifted = await consolidateMarker(SHIFTED_NOTES_MARKER)
    const retiredRented = await retireRentedLeaders()
    return {
      office,
      shifted,
      rented: emptyConsolidateResult(),
      changed:
        office.merged > 0 || office.deleted > 0 ||
        shifted.merged > 0 || shifted.deleted > 0 ||
        retiredRented,
    }
  } catch {
    return {
      office: emptyConsolidateResult(),
      shifted: emptyConsolidateResult(),
      rented: emptyConsolidateResult(),
      changed: false,
    }
  }
}

export function consolidateSpecialLeaders(): Promise<ConsolidateSpecialLeadersResult> {
  if (!consolidateSpecialLeadersPromise) {
    consolidateSpecialLeadersPromise = runConsolidateSpecialLeaders().finally(() => {
      consolidateSpecialLeadersPromise = null
    })
  }
  return consolidateSpecialLeadersPromise
}

export function isUnresolvedLeaderName(name: string | null | undefined): boolean {
  const value = (name ?? '').trim()
  if (!value) return true
  const lower = value.toLowerCase()
  return lower === 'team leader' || lower === 'unknown leader' || lower === 'this leader' || lower === 'selected leader' || lower === 'leader'
}

export function sanitizeLeaderDisplayNames(names: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, name] of Object.entries(names ?? {})) {
    if (!isUnresolvedLeaderName(name)) out[id] = name
  }
  return out
}

export function resolveTeamLeaderName(
  leader: { notes?: string | null; display_name?: string | null } | null | undefined,
  voter?: { name?: string | null } | null,
  fallback = 'Team Leader',
): string {
  if (isOfficeLeader(leader)) return 'Shifted'
  if (isShiftedLeader(leader)) return 'Single'
  const voterName = voter?.name?.trim()
  if (voterName) return voterName
  const customName = leader?.display_name?.trim()
  if (customName) return customName
  return fallback
}

// Ids of every special parking leader row. Assignments pointing at these are
// treated as "not really assigned" everywhere - a family parked under
// Shifted/Single still counts as unassigned. Legacy Rented rows are excluded
// so they can be retired without counting as a field leader.
export function specialLeaderIdSet(leaders: Array<{ id: string; notes: string | null }>): Set<string> {
  return new Set(leaders.filter((leader) => isSpecialLeader(leader)).map((leader) => leader.id))
}

export const COUNT_SHIFTED_AS_ASSIGNED_KEY = 'vote:team-leaders:count-shifted-as-assigned'

export function officeLeaderIdSet(leaders: Array<{ id: string; notes: string | null }>): Set<string> {
  return new Set(leaders.filter((leader) => isOfficeLeader(leader)).map((leader) => leader.id))
}

export function countingSpecialLeaderIdSet(
  leaders: Array<{ id: string; notes: string | null }>,
  countShiftedAsAssigned: boolean,
  extraUnassignedLeaderIds?: Iterable<string>,
): Set<string> {
  const ids = countShiftedAsAssigned
    ? new Set(leaders.filter((leader) => isShiftedLeader(leader)).map((leader) => leader.id))
    : specialLeaderIdSet(leaders)
  const customIds = new Set(
    leaders.filter((leader) => isCustomNamedLeader(leader)).map((leader) => leader.id),
  )
  for (const id of extraUnassignedLeaderIds ?? []) {
    if (id && (customIds.size === 0 || customIds.has(id))) ids.add(id)
  }
  return ids
}

export async function fetchUnassignedCountingLeaderIds(): Promise<string[]> {
  const data = await fetchApiJson<{ leaderIds?: string[] }>('/api/team-leaders/unassigned-counting')
  return Array.isArray(data.leaderIds) ? data.leaderIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
}

export async function saveUnassignedCountingLeaderIds(leaderIds: string[]): Promise<string[]> {
  const data = await fetchApiJson<{ leaderIds?: string[] }>('/api/team-leaders/unassigned-counting', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaderIds }),
  })
  return Array.isArray(data.leaderIds) ? data.leaderIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
}

async function retireRentedLeaders(): Promise<boolean> {
  const rows = await listSpecialLeadersByMarker(RENTED_NOTES_MARKER)
  if (!rows.length) return false
  let changed = false
  for (const row of rows) {
    const voterIds = await assignmentVoterIdsForLeader(row.id)
    if (voterIds.length) {
      await forEachInChunk(voterIds, async (chunk) => {
        const { error } = await supabase.from('team_leader_assignments').delete().in('voter_id', chunk)
        if (error) throw new Error(error.message)
      })
      changed = true
    }
    const remaining = await assignmentVoterIdsForLeader(row.id)
    if (remaining.length) continue
    const { error } = await supabase.from('team_leaders').delete().eq('id', row.id)
    if (error) throw new Error(error.message)
    changed = true
  }
  return changed
}

function createEnsureSpecialLeader(marker: string): () => Promise<{ leader: TeamLeader | null; created: boolean }> {
  let promise: Promise<{ leader: TeamLeader | null; created: boolean }> | null = null
  return () => {
    if (!promise) {
      promise = (async () => {
        const { data, error } = await supabase
          .from('team_leaders')
          .select('*')
          .eq('notes', marker)
          .limit(1)
          .maybeSingle()
        if (error) return { leader: null, created: false }
        if (data) return { leader: data as TeamLeader, created: false }

        const { data: created, error: insertError } = await supabase
          .from('team_leaders')
          .insert({ voter_id: null, part_no: null, section: null, notes: marker })
          .select('*')
          .maybeSingle()
        if (insertError) return { leader: null, created: false }
        return { leader: (created as TeamLeader) ?? null, created: !!created }
      })()
      promise.catch(() => {
        promise = null
      })
    }
    return promise
  }
}

export const ensureOfficeLeader = createEnsureSpecialLeader(OFFICE_NOTES_MARKER)
export const ensureShiftedLeader = createEnsureSpecialLeader(SHIFTED_NOTES_MARKER)

let shiftedParkingBackupPromise: Promise<{ ok: boolean; backupCount: number; liveCount: number; alreadyBackedUp: boolean }> | null = null

export function ensureShiftedParkingBackup(): Promise<{ ok: boolean; backupCount: number; liveCount: number; alreadyBackedUp: boolean }> {
  if (!shiftedParkingBackupPromise) {
    shiftedParkingBackupPromise = fetchApiJson<{ ok?: boolean; backupCount?: number; liveCount?: number; alreadyBackedUp?: boolean; error?: string }>(
      '/api/shifted-parking-backup',
      { method: 'POST' },
    ).then((data) => {
      if (data.error) throw new Error(data.error)
      return {
        ok: data.ok !== false,
        backupCount: Number(data.backupCount ?? 0),
        liveCount: Number(data.liveCount ?? 0),
        alreadyBackedUp: data.alreadyBackedUp === true,
      }
    }).catch((err) => {
      shiftedParkingBackupPromise = null
      throw err
    })
  }
  return shiftedParkingBackupPromise
}
