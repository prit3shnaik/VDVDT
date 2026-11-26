import { supabase } from './supabase'
import { fetchInChunks } from './d1Query'
import { fetchAllPages } from '../hooks/useMeetingData'
import {
  SLIM_FAMILY_VOTER_COLUMNS,
  fetchVotersByFamilyHeads,
  familyHeadKey,
  type SlimFamilyVoter,
} from './placeClubs'
import type { PresenceFilter } from './placePresenceFilters'
import type { Voter } from './types'

export interface SlimFamily {
  key: string
  head: string
  headVoter: SlimFamilyVoter | null
  members: SlimFamilyVoter[]
}

export function buildSlimFamilies(rows: SlimFamilyVoter[]): SlimFamily[] {
  const groups = new Map<string, SlimFamilyVoter[]>()
  for (const row of rows) {
    const key = familyHeadKey(row)
    if (!key) continue
    const members = groups.get(key)
    if (members) members.push(row)
    else groups.set(key, [row])
  }

  const families: SlimFamily[] = Array.from(groups.entries()).map(([head, members]) => {
    const sorted = [...members].sort((a, b) => {
      const aHead = a.epic_no.trim() === head
      const bHead = b.epic_no.trim() === head
      if (aHead && !bHead) return -1
      if (!aHead && bHead) return 1
      return a.name.localeCompare(b.name)
    })
    const headVoter = sorted.find((member) => member.epic_no.trim() === head) ?? sorted[0] ?? null
    return { key: `GROUP|${head}`, head, headVoter, members: sorted }
  })
  families.sort((a, b) => (a.headVoter?.name ?? a.head).localeCompare(b.headVoter?.name ?? b.head))
  return families
}

export async function fetchSlimVoters(options: {
  presence: PresenceFilter
  part: string
  hasWardRestriction: boolean
  allowedWards: number[]
}): Promise<SlimFamilyVoter[]> {
  const rows = await fetchAllPages<SlimFamilyVoter>(async (from, to) => {
    let query = supabase.from('voters').select(SLIM_FAMILY_VOTER_COLUMNS)
    if (options.presence === 'blank') query = query.is('presence_status', null)
    else if (options.presence !== 'all') query = query.eq('presence_status', options.presence)
    if (options.part) {
      const partNum = Number(options.part)
      query = Number.isFinite(partNum) && String(partNum) === options.part
        ? query.eq('part_no', partNum)
        : query.eq('part_no', options.part)
    }
    if (options.hasWardRestriction) query = query.in('ward_no', options.allowedWards)
    return query.range(from, to)
  }, 1000)
  return rows
}

export async function fetchFamiliesForHeads(heads: string[]): Promise<SlimFamily[]> {
  const rows = await fetchVotersByFamilyHeads(heads)
  return buildSlimFamilies(rows)
}

export async function completeFamiliesFromMatches(matches: SlimFamilyVoter[]): Promise<SlimFamily[]> {
  const heads = Array.from(new Set(matches.map((row) => familyHeadKey(row)).filter(Boolean)))
  if (!heads.length) return []
  return fetchFamiliesForHeads(heads)
}

export async function fetchFamilyHeadIndex(): Promise<Array<{ id: string; head: string }>> {
  const rows = await fetchAllPages<{ id: string; epic_no: string | null; family_head_epic: string | null }>(async (from, to) => (
    supabase.from('voters').select('id,epic_no,family_head_epic').range(from, to)
  ), 1000)
  const out: Array<{ id: string; head: string }> = []
  for (const row of rows) {
    const head = familyHeadKey(row)
    if (!head || !row.id) continue
    out.push({ id: row.id, head })
  }
  return out
}

export function unlabelledHeadsFromIndex(
  index: Array<{ id: string; head: string }>,
  familyPlaceByHead: Record<string, string>,
): { heads: string[]; voterIdsByHead: Record<string, string[]>; familyCount: number; voterCount: number } {
  const voterIdsByHead: Record<string, string[]> = {}
  for (const row of index) {
    if (familyPlaceByHead[row.head]) continue
    const list = voterIdsByHead[row.head]
    if (list) list.push(row.id)
    else voterIdsByHead[row.head] = [row.id]
  }
  const heads = Object.keys(voterIdsByHead)
  let voterCount = 0
  for (const ids of Object.values(voterIdsByHead)) voterCount += ids.length
  return { heads, voterIdsByHead, familyCount: heads.length, voterCount }
}

export async function fetchAssignmentMap(voterIds: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(voterIds.filter(Boolean)))
  if (!unique.length) return {}
  const rows = await fetchInChunks<{ voter_id: string; team_leader_id: string }>(
    unique,
    (chunk) => supabase.from('team_leader_assignments').select('voter_id, team_leader_id').in('voter_id', chunk),
  )
  const map: Record<string, string> = {}
  for (const row of rows) {
    if (row.voter_id) map[row.voter_id] = row.team_leader_id
  }
  return map
}

export function familyLeaderId(
  family: SlimFamily,
  voterToLeaderId: Record<string, string>,
  specialIds: Set<string>,
): string | null {
  for (const member of family.members) {
    const id = voterToLeaderId[member.id]
    if (id && !specialIds.has(id)) return id
  }
  return null
}

export function familyAssignedToRealLeader(
  voterIds: string[],
  voterToLeaderId: Record<string, string>,
  specialIds: Set<string>,
): boolean {
  for (const voterId of voterIds) {
    const id = voterToLeaderId[voterId]
    if (id && !specialIds.has(id)) return true
  }
  return false
}

export function distinctPartsFromFamilies(families: SlimFamily[]): string[] {
  const set = new Set<string>()
  for (const family of families) {
    const part = family.headVoter?.part_no ?? family.members[0]?.part_no
    if (part != null) set.add(String(part))
  }
  return Array.from(set).sort((a, b) => Number(a) - Number(b))
}

export function toPlaceVoter(row: SlimFamilyVoter): Voter {
  return {
    id: row.id,
    epic_no: row.epic_no,
    name: row.name,
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
    gender: row.gender ?? null,
    religion: row.religion ?? null,
    state: row.state ?? null,
    voter_category: row.voter_category ?? null,
    family_head_epic: row.family_head_epic ?? null,
    family_label: row.family_label ?? null,
    family_color: null,
    row_color: null,
    photo_url: row.photo_url ?? null,
    display_order: null,
    parked_address: null,
    presence_status: row.presence_status ?? null,
    presence_note: row.presence_note ?? null,
    created_at: '',
    updated_at: '',
  }
}
