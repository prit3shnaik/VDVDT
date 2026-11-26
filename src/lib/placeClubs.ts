import { supabase } from './supabase'
import type { FamilyPlaceClub, PlaceClub, Voter } from './types'
import { fetchInChunks } from './d1Query'

export function normalizePlacePart(value: string | null | undefined): string | null {
  const text = (value ?? '').trim()
  return text ? text : null
}

export function placeClubLabel(club: Pick<PlaceClub, 'area' | 'chawl' | 'building'> | null | undefined): string {
  if (!club) return 'Unlabelled'
  const parts = [club.building, club.chawl, club.area].map((part) => (part ?? '').trim()).filter(Boolean)
  return parts[0] || club.area || 'Unlabelled'
}

export function placeClubFullLabel(club: Pick<PlaceClub, 'area' | 'chawl' | 'building'> | null | undefined): string {
  if (!club) return 'Unlabelled'
  return [club.area, club.chawl, club.building].map((part) => (part ?? '').trim()).filter(Boolean).join(' / ') || club.area
}

export function familyHeadKey(voter: { family_head_epic?: string | null; epic_no?: string | null } | null | undefined): string {
  const linked = (voter?.family_head_epic ?? '').trim()
  if (linked) return linked
  return (voter?.epic_no ?? '').trim()
}

export async function fetchPlaceClubs(): Promise<PlaceClub[]> {
  const { data, error } = await supabase.from('place_clubs').select('*').order('area')
  if (error) throw new Error(error.message)
  return (data as PlaceClub[] | null) ?? []
}

export async function fetchFamilyPlaceClubs(): Promise<FamilyPlaceClub[]> {
  const rows: FamilyPlaceClub[] = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('family_place_clubs')
      .select('*')
      .range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const page = (data as FamilyPlaceClub[] | null) ?? []
    rows.push(...page)
    if (page.length < pageSize) break
  }
  return rows
}

export function familyPlaceMap(rows: FamilyPlaceClub[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = (row.family_head_epic ?? '').trim()
    if (key) out[key] = row.place_club_id
  }
  return out
}

export async function upsertPlaceClub(params: {
  area: string
  chawl?: string | null
  building?: string | null
  createdBy: string | null
}): Promise<PlaceClub> {
  const area = normalizePlacePart(params.area)
  if (!area) throw new Error('Area is required.')
  const chawl = normalizePlacePart(params.chawl)
  const building = normalizePlacePart(params.building)

  const { data: existing, error: existingError } = await supabase.from('place_clubs').select('*')
  if (existingError) throw new Error(existingError.message)
  const match = ((existing as PlaceClub[] | null) ?? []).find((row) =>
    row.area === area && normalizePlacePart(row.chawl) === chawl && normalizePlacePart(row.building) === building,
  )
  if (match) return match

  const { data, error } = await supabase
    .from('place_clubs')
    .insert({ area, chawl, building, created_by: params.createdBy })
    .select('*')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Could not create place.')
  return data as PlaceClub
}

export async function clubFamilies(familyHeadEpics: string[], placeClubId: string): Promise<void> {
  const heads = Array.from(new Set(familyHeadEpics.map((epic) => epic.trim()).filter(Boolean)))
  if (!heads.length) return
  const now = new Date().toISOString()
  await fetchInChunks(heads, async (chunk) => {
    const payload = chunk.map((family_head_epic) => ({ family_head_epic, place_club_id: placeClubId, updated_at: now }))
    return supabase.from('family_place_clubs').upsert(payload, { onConflict: 'family_head_epic' })
  })
}

export async function unclubFamilies(familyHeadEpics: string[]): Promise<void> {
  const heads = Array.from(new Set(familyHeadEpics.map((epic) => epic.trim()).filter(Boolean)))
  if (!heads.length) return
  await fetchInChunks(heads, (chunk) => supabase.from('family_place_clubs').delete().in('family_head_epic', chunk))
}

export function familyGroupHeadKey(family: {
  head: string
  headVoter?: { epic_no?: string | null; family_head_epic?: string | null } | null
  members?: Array<{ epic_no?: string | null; family_head_epic?: string | null } | unknown>
}): string {
  const member = family.members?.[0]
  const memberKey = member && typeof member === 'object' ? familyHeadKey(member as { epic_no?: string | null; family_head_epic?: string | null }) : ''
  return familyHeadKey(family.headVoter ?? { epic_no: family.head, family_head_epic: family.head }) || memberKey || family.head
}

export const UNLABELLED_PLACE_ID = '__unlabelled__'
export const OUTSIDE_MORMUGAO_AREA = 'Outside Mormugao'
export const SLIM_FAMILY_VOTER_COLUMNS = 'id,epic_no,name,family_head_epic,part_no,ward_no,presence_status,presence_note'
export const PLACE_FAMILY_VOTER_COLUMNS = 'id,epic_no,name,family_head_epic,part_no,ward_no,presence_status,presence_note,relative_name,relative_relation,section_name,section,sr_no_roll,house_no,age,date_of_birth,contact_no_1,contact_no_2,gender,religion,state,voter_category,family_label,photo_url'

export type SlimFamilyVoter = Pick<
  Voter,
  'id' | 'epic_no' | 'name' | 'family_head_epic' | 'part_no' | 'ward_no' | 'presence_status' | 'presence_note'
> & Partial<Pick<
  Voter,
  | 'relative_name'
  | 'relative_relation'
  | 'section_name'
  | 'section'
  | 'sr_no_roll'
  | 'house_no'
  | 'age'
  | 'date_of_birth'
  | 'contact_no_1'
  | 'contact_no_2'
  | 'gender'
  | 'religion'
  | 'state'
  | 'voter_category'
  | 'family_label'
  | 'photo_url'
>>

export type PlaceScope = 'all' | 'local' | 'outside'

export function isOutsidePlaceArea(area: string | null | undefined): boolean {
  return (area ?? '').trim().toLowerCase() === OUTSIDE_MORMUGAO_AREA.toLowerCase()
}

export function isOutsidePlaceClub(club: Pick<PlaceClub, 'area'> | null | undefined): boolean {
  return isOutsidePlaceArea(club?.area)
}

export function filterPlaceDirectoryByScope(nodes: PlaceDirectoryNode[], scope: PlaceScope): PlaceDirectoryNode[] {
  if (scope === 'all') return nodes
  return nodes.filter((node) => {
    if (node.kind === 'unlabelled') return true
    const outside = isOutsidePlaceArea(node.label) || isOutsidePlaceClub(node.club)
    return scope === 'outside' ? outside : !outside
  })
}

export function parseEpicList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[\s,;]+/)) {
    const epic = raw.trim().toUpperCase()
    if (!epic || seen.has(epic)) continue
    seen.add(epic)
    out.push(epic)
  }
  return out
}

export async function fetchVotersByEpics(epics: string[], columns = SLIM_FAMILY_VOTER_COLUMNS): Promise<SlimFamilyVoter[]> {
  const unique = Array.from(new Set(epics.map((epic) => epic.trim()).filter(Boolean)))
  if (!unique.length) return []
  return fetchInChunks<SlimFamilyVoter>(unique, (chunk) => (
    supabase.from('voters').select(columns).in('epic_no', chunk) as unknown as PromiseLike<{ data: SlimFamilyVoter[] | null; error: { message: string } | null }>
  ))
}

export async function fetchVotersByFamilyHeads(heads: string[], columns = SLIM_FAMILY_VOTER_COLUMNS): Promise<SlimFamilyVoter[]> {
  const unique = Array.from(new Set(heads.map((head) => head.trim()).filter(Boolean)))
  if (!unique.length) return []
  const byHead = await fetchInChunks<SlimFamilyVoter>(unique, (chunk) => (
    supabase.from('voters').select(columns).in('family_head_epic', chunk) as unknown as PromiseLike<{ data: SlimFamilyVoter[] | null; error: { message: string } | null }>
  ))
  const byEpic = await fetchInChunks<SlimFamilyVoter>(unique, (chunk) => (
    supabase.from('voters').select(columns).in('epic_no', chunk) as unknown as PromiseLike<{ data: SlimFamilyVoter[] | null; error: { message: string } | null }>
  ))
  const seen = new Set<string>()
  const merged: SlimFamilyVoter[] = []
  for (const row of [...byHead, ...byEpic]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    merged.push(row)
  }
  return merged
}

export type PlaceDirectoryKind = 'area' | 'chawl' | 'building' | 'unlabelled'

export interface PlaceDirectoryNode {
  key: string
  kind: PlaceDirectoryKind
  label: string
  club: PlaceClub | null
  clubIds: string[]
  familyCount: number
  voterCount: number
  children: PlaceDirectoryNode[]
}

function sumClubCounts(clubIds: string[], counts: Map<string, number>): number {
  return clubIds.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0)
}

export function buildPlaceDirectory(
  clubs: PlaceClub[],
  counts: Map<string, number>,
  unlabelledCount = 0,
  voterCounts: Map<string, number> = new Map(),
  unlabelledVoterCount = 0,
): PlaceDirectoryNode[] {
  const areaMap = new Map<string, PlaceClub[]>()
  for (const club of clubs) {
    const area = (club.area ?? '').trim() || 'Unlabelled'
    const list = areaMap.get(area)
    if (list) list.push(club)
    else areaMap.set(area, [club])
  }

  const areas: PlaceDirectoryNode[] = Array.from(areaMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([area, areaClubs]) => {
      const chawlMap = new Map<string, PlaceClub[]>()
      const areaOnly: PlaceClub[] = []
      for (const club of areaClubs) {
        const chawl = (club.chawl ?? '').trim()
        if (!chawl) {
          areaOnly.push(club)
          continue
        }
        const list = chawlMap.get(chawl)
        if (list) list.push(club)
        else chawlMap.set(chawl, [club])
      }

      const children: PlaceDirectoryNode[] = []
      for (const club of areaOnly.sort((a, b) => placeClubLabel(a).localeCompare(placeClubLabel(b)))) {
        const building = (club.building ?? '').trim()
        if (!building) continue
        children.push({
          key: club.id,
          kind: 'building',
          label: building,
          club,
          clubIds: [club.id],
          familyCount: counts.get(club.id) ?? 0,
          voterCount: voterCounts.get(club.id) ?? 0,
          children: [],
        })
      }

      for (const [chawl, chawlClubs] of Array.from(chawlMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        const chawlChildren: PlaceDirectoryNode[] = []
        let chawlLeaf: PlaceClub | null = null
        for (const club of chawlClubs.sort((a, b) => placeClubLabel(a).localeCompare(placeClubLabel(b)))) {
          const building = (club.building ?? '').trim()
          if (!building) {
            chawlLeaf = club
            continue
          }
          chawlChildren.push({
            key: club.id,
            kind: 'building',
            label: building,
            club,
            clubIds: [club.id],
            familyCount: counts.get(club.id) ?? 0,
            voterCount: voterCounts.get(club.id) ?? 0,
            children: [],
          })
        }
        const chawlClubIds = chawlClubs.map((club) => club.id)
        children.push({
          key: chawlLeaf?.id ?? `chawl:${area}:${chawl}`,
          kind: 'chawl',
          label: chawl,
          club: chawlLeaf,
          clubIds: chawlClubIds,
          familyCount: sumClubCounts(chawlClubIds, counts),
          voterCount: sumClubCounts(chawlClubIds, voterCounts),
          children: chawlChildren,
        })
      }

      const areaClubIds = areaClubs.map((club) => club.id)
      const areaLeaf = areaOnly.find((club) => !(club.building ?? '').trim() && !(club.chawl ?? '').trim()) ?? null
      return {
        key: areaLeaf?.id ?? `area:${area}`,
        kind: 'area' as const,
        label: area,
        club: areaLeaf,
        clubIds: areaClubIds,
        familyCount: sumClubCounts(areaClubIds, counts),
        voterCount: sumClubCounts(areaClubIds, voterCounts),
        children,
      }
    })

  return [
    {
      key: UNLABELLED_PLACE_ID,
      kind: 'unlabelled',
      label: 'Unlabelled',
      club: null,
      clubIds: [],
      familyCount: unlabelledCount,
      voterCount: unlabelledVoterCount,
      children: [],
    },
    ...areas,
  ]
}

export function placeNodeSelfMatches(node: PlaceDirectoryNode, token: string): boolean {
  if (!token) return true
  if (node.label.toLowerCase().includes(token)) return true
  return Boolean(node.club && placeClubFullLabel(node.club).toLowerCase().includes(token))
}

export function placeDirectoryMatches(node: PlaceDirectoryNode, token: string): boolean {
  if (!token) return true
  if (placeNodeSelfMatches(node, token)) return true
  return node.children.some((child) => placeDirectoryMatches(child, token))
}

export function filterPlaceDirectory(nodes: PlaceDirectoryNode[], token: string): PlaceDirectoryNode[] {
  const needle = token.trim().toLowerCase()
  if (!needle) return nodes
  const walk = (list: PlaceDirectoryNode[]): PlaceDirectoryNode[] => {
    const out: PlaceDirectoryNode[] = []
    for (const node of list) {
      if (node.kind === 'unlabelled') {
        if ('unlabelled'.includes(needle) || node.label.toLowerCase().includes(needle)) out.push(node)
        continue
      }
      if (placeNodeSelfMatches(node, needle)) {
        out.push(node)
        continue
      }
      const children = walk(node.children)
      if (children.length) out.push({ ...node, children })
    }
    return out
  }
  return walk(nodes)
}

export function placeDirectoryLeafCount(nodes: PlaceDirectoryNode[]): number {
  const ids = new Set<string>()
  const walk = (list: PlaceDirectoryNode[]) => {
    for (const node of list) {
      for (const id of node.clubIds) ids.add(id)
      walk(node.children)
    }
  }
  walk(nodes)
  return ids.size
}

export function groupFamiliesByPlace<T extends { head: string; headVoter?: { epic_no?: string | null; family_head_epic?: string | null } | null; members: unknown[] }>(
  families: T[],
  familyPlaceByHead: Record<string, string>,
  clubsById: Map<string, PlaceClub>,
): Array<{ clubId: string | null; club: PlaceClub | null; label: string; families: T[] }> {
  const groups = new Map<string, T[]>()
  const unlabelled: T[] = []
  for (const family of families) {
    const key = familyGroupHeadKey(family)
    const clubId = familyPlaceByHead[key]
    if (!clubId) {
      unlabelled.push(family)
      continue
    }
    const list = groups.get(clubId)
    if (list) list.push(family)
    else groups.set(clubId, [family])
  }
  const labelled: Array<{ clubId: string | null; club: PlaceClub | null; label: string; families: T[] }> = Array.from(groups.entries()).map(([clubId, list]) => {
    const club = clubsById.get(clubId) ?? null
    return { clubId, club, label: placeClubLabel(club), families: list }
  }).sort((a, b) => a.label.localeCompare(b.label))
  if (unlabelled.length) labelled.push({ clubId: null, club: null, label: 'Unlabelled', families: unlabelled })
  return labelled
}
