import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { exportWorkbookToExcel, type ExcelWorkbookSheet, type PrintStyleOptions } from '../../lib/reportBuilder'
import { ChevronDown, ChevronUp, Cog, Merge, Phone, Scissors, SlidersHorizontal, Trash2, UserPlus, Download, Printer, Loader2, X, FileSpreadsheet } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/Button'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import type { PlaceClub, PresenceStatus, TeamLeader, Voter } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { usePersistentState } from '../../hooks/usePersistentState'
import { buildWardScope, clearCachedCollection, FAST_NAV_CACHE_MAX_AGE_MS, readCachedVoters, writeCachedVoters } from '../../lib/voterCache'
import { VOTER_CATEGORY_OPTIONS, migrateRetiredCategoryFilter, voterCategoryLabel, withNormalizedVoterCategories } from '../../lib/voterCategory'
import { familyPresence, hasPresenceOverride, presenceLabel, presenceNoteOf } from '../../lib/presence'
import { PresencePicker } from '../../components/families/PresencePicker'
import { familyHeadKey, familyPlaceMap, fetchFamilyPlaceClubs, fetchPlaceClubs } from '../../lib/placeClubs'
import { FloatingDropdown } from '../../components/common/FloatingDropdown'
import { MobileSheet } from '../../components/common/MobileSheet'
import { BulkAddFamilyMembersModal } from '../../components/families/BulkAddFamilyMembersModal'
import { AddNewFamilyVoterModal } from '../../components/families/AddNewFamilyVoterModal'
import { ClassificationBadges } from '../../components/families/ClassificationBadges'
import {
  assignFamilyToLeader,
  buildTeamLeaderScope,
  clearTeamLeaderDetailCache,
  clearTeamLeadersListCache,
  clearUnassignedDataCache,
  fetchAllAssignmentLinks,
  fetchTeamLeadersFromApi,
  isOfficeLeader,
  isShiftedLeader,
  isRentedLeader,
  isUnresolvedLeaderName,
  resolveTeamLeaderName,
  readTeamLeaderCache,
  reconcileFamilyAssignments,
  specialLeaderIdSet,
  transferFamilyToLeader,
  dedupeSpecialLeaders,
  consolidateSpecialLeaders,
  type UnassignedLeaderOption,
} from '../../lib/teamLeaderCache'
import { forEachInChunk } from '../../lib/d1Query'

interface FamilyGroup {
  key: string
  head: string
  headVoter: Voter | null
  members: Voter[]
}

type FamilyPanel = 'none' | 'manage' | 'change-head' | 'break' | 'merge'

type RowColorKey = 'blue' | 'green' | 'amber' | 'rose' | 'violet' | 'teal' | 'slate'

const FAMILY_CACHE_KEY = 'vote:families:voters-cache'
const FAMILY_WARM_CACHE_KEY = 'vote:families:warm-cache'

function readWarmFamiliesCache(): Voter[] | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(FAMILY_WARM_CACHE_KEY)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as { rows?: unknown }
    if (!parsed || !Array.isArray(parsed.rows)) {
      return null
    }

    return parsed.rows as Voter[]
  } catch {
    return null
  }
}

function writeWarmFamiliesCache(rows: Voter[]): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(
      FAMILY_WARM_CACHE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        rows,
      }),
    )
  } catch {
    // Ignore storage quota and private mode failures.
  }
}

const PHOTO_URL_CACHE_KEY = 'vote:families:photo-url-cache'
// Signed URLs are requested with a 60-minute TTL - treat cached entries as
// stale a bit before that so we never hand back a URL that's about to
// expire. Each entry carries its OWN expiry (set when it was signed)
// rather than one shared cache timestamp, so an entry signed an hour ago
// can't be kept "fresh" just because a sibling entry was added moments ago.
const PHOTO_URL_ENTRY_TTL_MS = 50 * 60 * 1000

interface PhotoUrlCacheEntry {
  url: string
  expiresAt: number
}

function readPhotoUrlCache(): Record<string, PhotoUrlCacheEntry> {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(PHOTO_URL_CACHE_KEY)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as Record<string, PhotoUrlCacheEntry> | null
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    const now = Date.now()
    const valid: Record<string, PhotoUrlCacheEntry> = {}
    for (const [path, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.url === 'string' && typeof entry.expiresAt === 'number' && entry.expiresAt > now) {
        valid[path] = entry
      }
    }
    return valid
  } catch {
    return {}
  }
}

function writePhotoUrlCache(entries: Record<string, PhotoUrlCacheEntry>): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(PHOTO_URL_CACHE_KEY, JSON.stringify(entries))
  } catch {
    // Ignore storage quota and private mode failures.
  }
}

const ROW_COLOR_OPTIONS: Array<{
  key: RowColorKey
  label: string
  swatchClass: string
  rowClass: string
}> = [
  { key: 'blue', label: 'Sky', swatchClass: 'border-sky-500 bg-sky-400', rowClass: 'bg-sky-200/60' },
  { key: 'green', label: 'Emerald', swatchClass: 'border-emerald-500 bg-emerald-400', rowClass: 'bg-emerald-200/60' },
  { key: 'amber', label: 'Amber', swatchClass: 'border-amber-500 bg-amber-400', rowClass: 'bg-amber-200/65' },
  { key: 'rose', label: 'Rose', swatchClass: 'border-rose-500 bg-rose-400', rowClass: 'bg-rose-200/60' },
  { key: 'violet', label: 'Violet', swatchClass: 'border-violet-500 bg-violet-400', rowClass: 'bg-violet-200/60' },
  { key: 'teal', label: 'Teal', swatchClass: 'border-teal-500 bg-teal-400', rowClass: 'bg-teal-200/60' },
  { key: 'slate', label: 'Slate', swatchClass: 'border-slate-500 bg-slate-400', rowClass: 'bg-slate-200/60' },
]

function isRowColorKey(value: string | null | undefined): value is RowColorKey {
  return ROW_COLOR_OPTIONS.some((option) => option.key === value)
}

function rowColorClass(value: string | null | undefined): string {
  const option = ROW_COLOR_OPTIONS.find((item) => item.key === value)
  return option?.rowClass ?? ''
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

// Filters the team-leader picker list by name or EPIC as the user types.
// Shared by the per-family combobox and the global "assign to" search bar.
function filterLeaderOptions(options: UnassignedLeaderOption[], query: string): UnassignedLeaderOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter((option) => option.name.toLowerCase().includes(q) || option.epicNo.toLowerCase().includes(q))
}

// Builds the sorted team-leader picker options from a set of team_leaders
// rows. `nameById` (e.g. the cached "Office"/"Shifted" special-row labels)
// wins over the live voter lookup; otherwise Office/Shifted rows are labelled
// directly and every other row falls back to the leader's voter name, then
// the leader id.
function buildLeaderOptions(
  leaders: TeamLeader[],
  voterById: (id: string) => { name?: string | null; epic_no?: string | null } | undefined,
  nameById: Record<string, string>,
): UnassignedLeaderOption[] {
  const options: UnassignedLeaderOption[] = leaders.filter((tl) => !isRentedLeader(tl)).map((tl) => {
    const leaderVoter = tl.voter_id ? voterById(tl.voter_id) : undefined
    return {
      id: tl.id,
      name: (() => {
        const cached = nameById[tl.id]
        if (cached && !isUnresolvedLeaderName(cached)) return cached
        return resolveTeamLeaderName(tl, leaderVoter, '')
      })(),
      epicNo: leaderVoter?.epic_no ?? '',
      part_no: tl.part_no,
      section: tl.section,
      notes: tl.notes ?? null,
    }
  })
  options.sort((a, b) => {
    const aSpecial = isOfficeLeader(a) || isShiftedLeader(a)
    const bSpecial = isOfficeLeader(b) || isShiftedLeader(b)
    if (aSpecial !== bSpecial) return aSpecial ? 1 : -1
    return a.name.localeCompare(b.name)
  })
  return options
}

// Network fallback for the team-leader picker used on a cold cache: fetches
// the team_leaders rows plus the voter names behind each leader's voter_id so
// the assign UI shows real names on the very first page load instead of
// waiting for the team-leaders cache to be populated by another page.
async function fetchLeaderOptions(): Promise<UnassignedLeaderOption[]> {
  const rows = await fetchTeamLeadersFromApi()
  return rows
    .filter((tl) => !isRentedLeader(tl))
    .map((tl) => ({
      id: tl.id,
      name: resolveTeamLeaderName(tl, tl.voter_name ? { name: tl.voter_name } : null, ''),
      epicNo: tl.epic_no ?? '',
      part_no: tl.part_no,
      section: tl.section,
      notes: tl.notes ?? null,
    }))
    .sort((a, b) => {
      const aSpecial = isOfficeLeader(a) || isShiftedLeader(a)
      const bSpecial = isOfficeLeader(b) || isShiftedLeader(b)
      if (aSpecial !== bSpecial) return aSpecial ? 1 : -1
      return a.name.localeCompare(b.name)
    })
}

function formatFamilyCandidateLabel(voter: Voter): string {
  const location = [voter.ward_no ? `Ward ${voter.ward_no}` : null, voter.part_no ? `Part ${voter.part_no}` : null]
    .filter(Boolean)
    .join(' - ')

  return location ? `${voter.name} (${voter.epic_no}) - ${location}` : `${voter.name} (${voter.epic_no})`
}

function normalizeLookupValue(value: string | number | null | undefined): string {
  return (value ?? '').toString().toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function tokenizeLookup(value: string): string[] {
  return normalizeLookupValue(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)
}

function compactLookupValue(value: string | number | null | undefined): string {
  return normalizeLookupValue(value).replace(/\s+/g, '')
}

function isLikelyEpicToken(value: string): boolean {
  const compact = compactLookupValue(value)
  return compact.length >= 6 && /[0-9]/.test(compact) && /^[A-Z0-9]+$/.test(compact)
}

function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function matchesLookupTokens(lookupText: string, tokens: string[]): boolean {
  if (!tokens.length) {
    return true
  }

  const compactLookup = lookupText.replace(/\s+/g, '')
  return tokens.every((token) => {
    const compactToken = token.replace(/\s+/g, '')
    return lookupText.includes(token) || compactLookup.includes(compactToken)
  })
}

function memberFamilyStatus(member: Voter, familyHeadEpic: string): string {
  const ownEpic = normalizeGroupingValue(member.epic_no)
  const linkedHead = normalizeGroupingValue(member.family_head_epic)

  if (ownEpic && ownEpic === familyHeadEpic) {
    return 'Head'
  }

  if (linkedHead && linkedHead !== ownEpic) {
    return 'Member'
  }

  return 'Unlinked'
}

function buildVoterLookupText(voter: Voter): string {
  return normalizeLookupValue(
    [
      voter.name,
      voter.epic_no,
      voter.relative_name,
      voter.relative_relation,
      voter.house_no,
      voter.contact_no_1,
      voter.contact_no_2,
      voter.section_name,
      voter.family_head_epic,
      voter.family_label,
      voter.family_color,
      voter.row_color,
    ]
      .filter(Boolean)
      .join(' '),
  )
}

// Precomputed, normalized search entry for a voter row. Building the lookup
// string (and compact EPIC/name) once per row - instead of recomputing it on
// every keystroke in the "add member" / "create family" pickers - is what
// keeps those searches fast on workspaces with thousands of voters.
interface SearchableVoter {
  row: Voter
  lookupText: string
  compactEpic: string
  compactName: string
}

function buildSearchableIndex(voters: Voter[]): SearchableVoter[] {
  return voters.map((row) => ({
    row,
    lookupText: buildVoterLookupText(row),
    compactEpic: compactLookupValue(row.epic_no),
    compactName: compactLookupValue(row.name),
  }))
}

function buildFamilyLookupText(family: FamilyGroup): string {
  return normalizeLookupValue(
    [
      family.head,
      family.headVoter?.name ?? '',
      family.headVoter?.epic_no ?? '',
      family.headVoter?.family_head_epic ?? '',
      family.headVoter?.family_label ?? '',
      family.headVoter?.part_no ?? '',
      family.headVoter?.ward_no ?? '',
      family.headVoter?.section ?? '',
      ...family.members.flatMap((member) => [
        member.name,
        member.epic_no,
        member.relative_name ?? '',
        member.relative_relation ?? '',
        member.family_head_epic ?? '',
        member.family_label ?? '',
        member.contact_no_1 ?? '',
        member.contact_no_2 ?? '',
        member.house_no ?? '',
        member.part_no ?? '',
        member.ward_no ?? '',
        member.section ?? '',
      ]),
    ].join(' '),
  )
}

function familyContainsEpic(family: FamilyGroup, epic: string): boolean {
  const target = compactLookupValue(epic)
  if (!target) {
    return false
  }

  return family.members.some((member) => {
    return (
      compactLookupValue(member.epic_no) === target ||
      compactLookupValue(member.family_head_epic) === target ||
      compactLookupValue(family.head) === target
    )
  })
}

function familyMatchesSearch(family: FamilyGroup, tokens: string[], lookupTextIndex?: Map<string, string>): boolean {
  if (!tokens.length) {
    return true
  }

  if (tokens.length === 1 && isLikelyEpicToken(tokens[0])) {
    return familyContainsEpic(family, tokens[0])
  }

  const lookupText = lookupTextIndex?.get(family.key) ?? buildFamilyLookupText(family)
  if (matchesLookupTokens(lookupText, tokens)) {
    return true
  }

  return tokens.length === 1 && familyContainsEpic(family, tokens[0])
}

function uniqueNumberList(values: Array<number | null | undefined>): number[] {
  return Array.from(new Set(values.filter((value): value is number => value != null))).sort((a, b) => a - b)
}

// A voter row matches the currently active Part/Section/Ward filters when
// every active filter (not set to 'all') matches the row's own part/section/
// ward. Used to scope the "Add member" and "Create New Family" search boxes
// to the same filters the family table itself is already scoped to.
function matchesActiveScopeFilters(
  row: Voter,
  scope: { partFilter: string; sectionFilter: string; wardFilter: string },
): boolean {
  if (scope.partFilter !== 'all' && String(row.part_no ?? '') !== scope.partFilter) {
    return false
  }
  if (scope.sectionFilter !== 'all' && String(row.section ?? '') !== scope.sectionFilter) {
    return false
  }
  if (scope.wardFilter !== 'all' && String(row.ward_no ?? '') !== scope.wardFilter) {
    return false
  }
  return true
}

function normalizeGroupingValue(value: string | number | null | undefined): string {
  return (value ?? '').toString().trim().toUpperCase()
}

// Sort key used for family ordering: the head's full name when a head voter
// exists, otherwise the grouping EPIC (same fallback the old sort used).
function familyHeadSortName(family: FamilyGroup): string {
  return family.headVoter?.name?.trim() ?? family.head
}

// Extracts the surname (last whitespace-separated token) of a name. Names
// with a single token are treated as surname-only so they still sort into
// the same bucket rather than being pushed to the end.
function surnameOf(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean)
  if (tokens.length <= 1) {
    return name.trim()
  }
  return tokens[tokens.length - 1]
}

/**
 * Database-driven family grouping.
 *
 * The ONLY source of truth is `family_head_epic`. Voters sharing the same
 * family_head_epic belong to the same family. A voter with a NULL
 * family_head_epic is treated as a single-member family (headed by itself).
 * The family head is the voter whose epic_no equals the group's
 * family_head_epic; if no such voter is present in the data, the first
 * member is shown as the display head. No inference, matching, or scoring
 * of any kind is performed.
 */
function buildFamilies(rows: Voter[]): FamilyGroup[] {
  const groups = new Map<string, Voter[]>()

  for (const row of rows) {
    const linkedHead = normalizeGroupingValue(row.family_head_epic)
    const key = linkedHead || normalizeGroupingValue(row.epic_no)
    const members = groups.get(key)
    if (members) {
      members.push(row)
    } else {
      groups.set(key, [row])
    }
  }

  const families: FamilyGroup[] = Array.from(groups.entries()).map(([headEpic, members]) => {
    const sortedMembers = [...members].sort((a, b) => {
      const aIsHead = normalizeGroupingValue(a.epic_no) === headEpic
      const bIsHead = normalizeGroupingValue(b.epic_no) === headEpic
      if (aIsHead && !bIsHead) return -1
      if (!aIsHead && bIsHead) return 1
      if (a.display_order != null && b.display_order != null) return a.display_order - b.display_order
      if (a.display_order != null) return -1
      if (b.display_order != null) return 1
      // Fallback only applies to members who have never been through the
      // addMemberToFamily flow since it started assigning explicit
      // display_order values (e.g. very old, never-touched families).
      // Once a family is touched by an add, every member in it gets a real
      // display_order and this fallback stops applying to them entirely.
      const aTime = a.updated_at ?? a.created_at ?? ''
      const bTime = b.updated_at ?? b.created_at ?? ''
      return aTime.localeCompare(bTime)
    })

    const headVoter = sortedMembers.find((member) => normalizeGroupingValue(member.epic_no) === headEpic) ?? sortedMembers[0] ?? null

    return {
      key: `GROUP|${headEpic}`,
      head: headEpic,
      headVoter,
      members: sortedMembers,
    }
  })

  // Families are ordered by the head's surname first, then by the full name
  // (case-insensitive) as a tiebreaker, then by the grouping EPIC for total
  // stability when two heads share the same name. The table, search
  // highlight, and export/print reports all consume this same ordering.
  families.sort((a, b) => {
    const aName = familyHeadSortName(a)
    const bName = familyHeadSortName(b)
    const bySurname = surnameOf(aName).localeCompare(surnameOf(bName), undefined, { sensitivity: 'base' })
    if (bySurname !== 0) {
      return bySurname
    }
    const byName = aName.localeCompare(bName, undefined, { sensitivity: 'base' })
    if (byName !== 0) {
      return byName
    }
    return a.head.localeCompare(b.head)
  })

  return families
}

function memberMatchesSearch(member: Voter, tokens: string[]): boolean {
  return tokens.length > 0 && matchesLookupTokens(buildVoterLookupText(member), tokens)
}

function buildMemberRowClass(member: Voter, tokens: string[]): string {
  const classes: string[] = []
  if (isRowColorKey(member.row_color)) {
    classes.push(rowColorClass(member.row_color))
  }
  if (memberMatchesSearch(member, tokens)) {
    classes.push('bg-amber-50 ring-2 ring-inset ring-amber-300')
  }
  return classes.join(' ')
}

type ReportFieldKey =
  | 'srNo'
  | 'srNoRoll'
  | 'photo'
  | 'name'
  | 'epic'
  | 'status'
  | 'relativeName'
  | 'relation'
  | 'houseNo'
  | 'age'
  | 'gender'
  | 'religion'
  | 'state'
  | 'ward'
  | 'part'
  | 'section'
  | 'sectionName'
  | 'contact1'
  | 'contact2'
  | 'familyLabel'
  | 'totalMembers'
  | 'category'

interface ReportFieldOption {
  key: ReportFieldKey
  label: string
}

const REPORT_FIELD_OPTIONS: ReportFieldOption[] = [
  { key: 'srNo', label: 'Sr. No. (per table)' },
  { key: 'srNoRoll', label: 'Voter Sr No (sr_no_roll)' },
  { key: 'photo', label: 'Photo' },
  { key: 'name', label: 'Name' },
  { key: 'epic', label: 'EPIC No.' },
  { key: 'status', label: 'Status (Head / Member)' },
  { key: 'relativeName', label: 'Relative Name' },
  { key: 'relation', label: 'Relation' },
  { key: 'houseNo', label: 'House No.' },
  { key: 'age', label: 'Age' },
  { key: 'gender', label: 'Gender' },
  { key: 'religion', label: 'Religion' },
  { key: 'state', label: 'State' },
  { key: 'contact1', label: 'Contact No. 1' },
  { key: 'contact2', label: 'Contact No. 2' },
  { key: 'ward', label: 'Ward No.' },
  { key: 'part', label: 'Part No.' },
  { key: 'section', label: 'Section' },
  { key: 'sectionName', label: 'Section Name' },
  { key: 'familyLabel', label: 'Family Label' },
  { key: 'totalMembers', label: 'Total Family Members' },
  { key: 'category', label: 'Category' },
]

const DEFAULT_REPORT_FIELD_KEYS: ReportFieldKey[] = [
  'srNo',
  'sectionName',
  'part',
  'section',
  'srNoRoll',
  'photo',
  'name',
  'relativeName',
  'totalMembers',
  'contact1',
  'contact2',
]

function defaultReportFields(): Record<ReportFieldKey, boolean> {
  const map = {} as Record<ReportFieldKey, boolean>
  for (const option of REPORT_FIELD_OPTIONS) {
    map[option.key] = DEFAULT_REPORT_FIELD_KEYS.includes(option.key)
  }
  return map
}

type TableColumnKey =
  | 'srNo'
  | 'srNoRoll'
  | 'name'
  | 'epic'
  | 'status'
  | 'relativeName'
  | 'relation'
  | 'houseNo'
  | 'age'
  | 'gender'
  | 'religion'
  | 'state'
  | 'ward'
  | 'part'
  | 'section'
  | 'sectionName'
  | 'contact1'
  | 'contact2'
  | 'dob'
  | 'familyLabel'

interface TableColumnOption {
  key: TableColumnKey
  label: string
}

const TABLE_COLUMN_OPTIONS: TableColumnOption[] = [
  { key: 'srNo', label: 'Sr No' },
  { key: 'srNoRoll', label: 'Voter Sr No' },
  { key: 'name', label: 'Name' },
  { key: 'epic', label: 'EPIC' },
  { key: 'status', label: 'Status' },
  { key: 'relativeName', label: 'Relative' },
  { key: 'relation', label: 'Relation' },
  { key: 'houseNo', label: 'House' },
  { key: 'age', label: 'Age' },
  { key: 'gender', label: 'Gender' },
  { key: 'religion', label: 'Religion' },
  { key: 'state', label: 'State' },
  { key: 'ward', label: 'Ward' },
  { key: 'part', label: 'Part' },
  { key: 'section', label: 'Section' },
  { key: 'sectionName', label: 'Section Name' },
  { key: 'contact1', label: 'Contact 1' },
  { key: 'contact2', label: 'Contact 2' },
  { key: 'dob', label: 'DOB' },
  { key: 'familyLabel', label: 'Family Label' },
]

const DEFAULT_TABLE_COLUMNS: TableColumnKey[] = [
  'srNo',
  'name',
  'epic',
  'status',
  'relativeName',
  'relation',
  'houseNo',
  'age',
  'ward',
  'part',
  'section',
]

function tableColumnCell(member: Voter, family: FamilyGroup, key: TableColumnKey): string {
  switch (key) {
    case 'srNo':
      return ''
    case 'srNoRoll':
      return member.sr_no_roll != null ? String(member.sr_no_roll) : '-'
    case 'name':
      return member.name
    case 'epic':
      return member.epic_no
    case 'status':
      return memberFamilyStatus(member, family.head)
    case 'relativeName':
      return member.relative_name ?? '-'
    case 'relation':
      return member.relative_relation ?? '-'
    case 'houseNo':
      return member.house_no ?? '-'
    case 'age':
      return member.age != null ? String(member.age) : '-'
    case 'gender':
      return member.gender ?? '-'
    case 'religion':
      return member.religion ?? '-'
    case 'state':
      return member.state ?? '-'
    case 'ward':
      return member.ward_no != null ? String(member.ward_no) : '-'
    case 'part':
      return member.part_no != null ? String(member.part_no) : '-'
    case 'section':
      return member.section != null ? String(member.section) : '-'
    case 'sectionName':
      return member.section_name ?? '-'
    case 'contact1':
      return member.contact_no_1 ?? '-'
    case 'contact2':
      return member.contact_no_2 ?? '-'
    case 'dob':
      return member.date_of_birth ?? '-'
    case 'familyLabel':
      return member.family_label ?? family.headVoter?.family_label ?? '-'
  }
}

function tableColumnIsBold(key: TableColumnKey): boolean {
  return key === 'name'
}

function tableColumnIsCenter(key: TableColumnKey): boolean {
  return key === 'srNo' || key === 'srNoRoll' || key === 'age'
}

const FAMILY_SIZE_BUCKET_OPTIONS = ['1', '2', '3', '4', '5', '6', '7+']

function familyMatchesSizeFilter(family: FamilyGroup, sizeSelections: string[]): boolean {
  if (!sizeSelections.length) {
    return true
  }
  const count = family.members.length
  const bucket = count >= 7 ? '7+' : String(count)
  return sizeSelections.includes(bucket)
}

/**
 * Resolves the value used to group families for print/export when grouping
 * by ward, part, section, religion, or gender. Always reads from the FAMILY
 * HEAD, never from individual members. This keeps a family intact within a
 * single group even when members are individually registered under a
 * different ward/part/section - avoiding split or duplicated families across
 * printed sections.
 */
function familyGroupKey(family: FamilyGroup, groupBy: string): string {
  const head = family.headVoter
  switch (groupBy) {
    case 'ward':
      return head?.ward_no != null ? `Ward ${head.ward_no}` : 'Ward - (unassigned)'
    case 'part':
      return head?.part_no != null ? `Part ${head.part_no}` : 'Part - (unassigned)'
    case 'section':
      return head?.section != null ? `Section ${head.section}` : 'Section - (unassigned)'
    case 'religion':
      return head?.religion?.trim() ? head.religion.trim() : 'Religion - (unspecified)'
    case 'gender':
      return head?.gender?.trim() ? head.gender.trim() : 'Gender - (unspecified)'
    default:
      return ''
  }
}

function findInheritedContact(family: FamilyGroup, headEpic: string, excludeNumbers: string[]): { number: string; viaName: string; viaRelation: string } | null {
  const headKey = compactLookupValue(headEpic)
  const excludeSet = new Set(excludeNumbers.filter(Boolean))
  for (const m of family.members) {
    if (compactLookupValue(m.epic_no) === headKey) continue
    const c1 = (m.contact_no_1 ?? '').trim()
    if (c1 && !excludeSet.has(c1)) {
      return { number: c1, viaName: m.name, viaRelation: m.relative_relation ?? '' }
    }
    const c2 = (m.contact_no_2 ?? '').trim()
    if (c2 && c2 !== c1 && !excludeSet.has(c2)) {
      return { number: c2, viaName: m.name, viaRelation: m.relative_relation ?? '' }
    }
  }
  return null
}

function inheritedContactLabel(info: { number: string; viaName: string; viaRelation: string }): string {
  const via = info.viaRelation ? `${info.viaName}, ${info.viaRelation}` : info.viaName
  return `${info.number} (via ${via})`
}

function fieldValueForMember(member: Voter, family: FamilyGroup, key: ReportFieldKey, photoUrl: string): string {
  switch (key) {
    case 'srNoRoll':
      return member.sr_no_roll != null ? String(member.sr_no_roll) : ''
    case 'photo':
      return photoUrl ?? ''
    case 'name':
      return member.name ?? ''
    case 'epic':
      return member.epic_no ?? ''
    case 'status':
      return memberFamilyStatus(member, family.head)
    case 'relativeName':
      return member.relative_name ?? ''
    case 'relation':
      return member.relative_relation ?? ''
    case 'houseNo':
      return member.house_no ?? ''
    case 'age':
      return member.age != null ? String(member.age) : ''
    case 'gender':
      return member.gender ?? ''
    case 'religion':
      return member.religion ?? ''
    case 'state':
      return member.state ?? ''
    case 'ward':
      return member.ward_no != null ? String(member.ward_no) : ''
    case 'part':
      return member.part_no != null ? String(member.part_no) : ''
    case 'section':
      return member.section != null ? String(member.section) : ''
    case 'sectionName':
      return member.section_name ?? ''
    case 'contact1': {
      const own = (member.contact_no_1 ?? '').trim()
      if (own) return own
      const isHead = compactLookupValue(member.epic_no) === compactLookupValue(family.head)
      if (!isHead) return ''
      const inherited = findInheritedContact(family, family.head, [])
      return inherited ? inheritedContactLabel(inherited) : ''
    }
    case 'contact2': {
      const own = (member.contact_no_2 ?? '').trim()
      if (own) return own
      const isHead = compactLookupValue(member.epic_no) === compactLookupValue(family.head)
      if (!isHead) return ''
      const contact1Val = (member.contact_no_1 ?? '').trim()
      const exclude = contact1Val ? [contact1Val] : (() => {
        const c1 = findInheritedContact(family, family.head, [])
        return c1 ? [c1.number] : []
      })()
      const inherited = findInheritedContact(family, family.head, exclude)
      return inherited ? inheritedContactLabel(inherited) : ''
    }
    case 'familyLabel':
      return member.family_label ?? family.headVoter?.family_label ?? ''
    case 'totalMembers':
      return String(family.members.length)
    case 'category':
      return voterCategoryLabel(member.voter_category) ?? ''
    default:
      return ''
  }
}

export function FamiliesPage() {
  const batchSize = 400
  const initialFamilyRenderLimit = 30
  const [rows, setRows] = useState<Voter[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingImages, setLoadingImages] = useState(false)
  const [familyRenderLimit, setFamilyRenderLimit] = useState(initialFamilyRenderLimit)
  // Team-leader assignment data for the per-family leader badge + inline
  // assign/transfer control. `voterToLeaderId` maps voter id -> team leader
  // id (a voter has at most one leader; team_leader_assignments.voter_id is
  // unique), `leaderOptions` is the sorted list of leaders to choose from.
  const [voterToLeaderId, setVoterToLeaderId] = useState<Record<string, string>>({})
  const [leaderOptions, setLeaderOptions] = useState<UnassignedLeaderOption[]>([])
  // Per-family select state: value = selected leader id ('' = unassigned).
  const [leaderSelectByFamily, setLeaderSelectByFamily] = useState<Record<string, string>>({})
  const [assigningLeaderFamily, setAssigningLeaderFamily] = useState<string | null>(null)
  // Per-family searchable leader picker: typed filter text per family, used
  // to narrow the plain <select> options below it.
  const [leaderSearchByFamily, setLeaderSearchByFamily] = useState<Record<string, string>>({})
  // Global "assign to" bar at the top of the page: pick a team leader once by
  // searching, then it stays selected ("sticky") so every family card can
  // offer a single-click "Assign to <leader>" button as the admin scrolls,
  // instead of re-picking a leader per family.
  const [globalAssignLeaderId, setGlobalAssignLeaderId] = useState('')
  const [globalLeaderSearch, setGlobalLeaderSearch] = useState('')
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [epicSearchRows, setEpicSearchRows] = useState<Voter[]>([])
  // Read the persisted photo-URL cache exactly once (React's useState lazy
  // initializer only runs on the very first render).
  const [initialPhotoCache] = useState<Record<string, PhotoUrlCacheEntry>>(() => readPhotoUrlCache())
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const [path, entry] of Object.entries(initialPhotoCache)) {
      initial[path] = entry.url
    }
    return initial
  })
  // Mirrors photoUrlByPath so the photo-signing effect can check what's
  // already known without needing photoUrlByPath itself in its dependency
  // array (which previously caused it to cancel-and-restart after every
  // single signed-URL batch came back).
  const photoUrlByPathRef = useRef<Record<string, string>>(photoUrlByPath)
  // Per-path expiry (ms epoch), seeded from the persisted cache and
  // extended as we sign new URLs, so we can persist accurate per-entry
  // TTLs rather than one shared cache-wide timestamp. Uses the
  // lazy-ref-init pattern (guard on .current) so the seeding loop only
  // ever runs once, on mount.
  const photoUrlExpiryRef = useRef<Record<string, number> | null>(null)
  if (photoUrlExpiryRef.current === null) {
    const expiry: Record<string, number> = {}
    for (const [path, entry] of Object.entries(initialPhotoCache)) {
      expiry[path] = entry.expiresAt
    }
    photoUrlExpiryRef.current = expiry
  }
  // Scroll restoration after family mutations. Records which family the user
  // was working on so the post-reload effect can bring it back into view; a
  // saved pixel offset is kept as a fallback for the rare case the family no
  // longer exists after the action (e.g. it was merged away).
  const pendingScrollFamilyKeyRef = useRef<string | null>(null)
  const pendingScrollFallbackYRef = useRef<number>(0)
  const [query, setQuery] = usePersistentState('vote:families:query', '')
  const [partFilter, setPartFilter] = usePersistentState('vote:families:partFilter', 'all')
  const [wardFilter, setWardFilter] = usePersistentState('vote:families:wardFilter', 'all')
  const [sectionFilter, setSectionFilter] = usePersistentState('vote:families:sectionFilter', 'all')
  const [religionFilter, setReligionFilter] = usePersistentState('vote:families:religionFilter', 'all')
  const [stateFilter, setStateFilter] = usePersistentState('vote:families:stateFilter', 'all')
  const [genderFilter, setGenderFilter] = usePersistentState<'all' | 'male' | 'female'>('vote:families:genderFilter', 'all')
  const [sizeFilterValues, setSizeFilterValues] = usePersistentState<string[]>('vote:families:sizeFilterValues', [])
  const [assignmentFilter, setAssignmentFilter] = usePersistentState<'all' | 'assigned' | 'unassigned' | 'shifted' | 'single'>('vote:families:assignmentFilter', 'all')
  const [categoryFilter, setCategoryFilter] = usePersistentState<string>('vote:families:categoryFilter', 'all')
  useEffect(() => {
    const migrated = migrateRetiredCategoryFilter(categoryFilter)
    if (migrated !== categoryFilter) setCategoryFilter(migrated)
  }, [categoryFilter, setCategoryFilter])
  const [sizeFilterOpen, setSizeFilterOpen] = useState(false)
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
  const [desktopFiltersOpen, setDesktopFiltersOpen] = useState(false)
  const [showPartSectionHeader, setShowPartSectionHeader] = usePersistentState('vote:families:showPartSectionHeader', true)
  const [useBigPhotos, setUseBigPhotos] = usePersistentState('vote:families:useBigPhotos', false)
  const [showExportModal, setShowExportModal] = useState(false)
  const [showPrintModal, setShowPrintModal] = useState(false)
  const [reportSelectionMode, setReportSelectionMode] = useState<'filtered' | 'all' | 'selected'>('filtered')
  const [selectedFamilyKeys, setSelectedFamilyKeys] = useState<Set<string>>(new Set())
  const [reportLayout, setReportLayout] = useState<'detailed' | 'headsOnly'>('detailed')
  const [reportGroupBy, setReportGroupBy] = useState<'none' | 'ward' | 'part' | 'section' | 'religion' | 'gender'>('none')
  const [reportFields, setReportFields] = useState<Record<ReportFieldKey, boolean>>(defaultReportFields)
  const [reportFieldOrder, setReportFieldOrder] = useState<ReportFieldKey[]>([...DEFAULT_REPORT_FIELD_KEYS])
  const [reportPaperSize, setReportPaperSize] = useState<'a4' | 'letter'>('a4')
  const [reportOrientation, setReportOrientation] = useState<'portrait' | 'landscape'>('portrait')
  const [reportPrintMode, setReportPrintMode] = useState<'table' | 'booklet'>('table')
  const [reportHeaderConstituency, setReportHeaderConstituency] = useState('')
  const [reportHeaderDate, setReportHeaderDate] = useState(new Date().toISOString().slice(0, 10))
  const [reportHeaderSignature, setReportHeaderSignature] = useState(false)
  const [reportPhotoSize, setReportPhotoSize] = useState<'small' | 'medium' | 'large' | 'xlarge' | 'jumbo'>('small')
  const [reportShowTally, setReportShowTally] = useState(true)
  const [reportSplitSheets, setReportSplitSheets] = useState(false)
  const [reportType, setReportType] = useState<'standard' | 'familyWise'>('standard')
  const [reportFontSize, setReportFontSize] = usePersistentState<number>('vote:families:printFontSize', 11)
  const [reportBold, setReportBold] = usePersistentState<boolean>('vote:families:printBold', false)
  const [reportExportBorders, setReportExportBorders] = usePersistentState<boolean>('vote:families:exportBorders', true)
  const [reportExportRowHeight, setReportExportRowHeight] = usePersistentState<number>('vote:families:exportRowHeight', 18)
  const [reportExportColWidth, setReportExportColWidth] = usePersistentState<number>('vote:families:exportColWidth', 16)
  const [tableColumns, setTableColumns] = usePersistentState<TableColumnKey[]>('vote:families:table-columns:v5', [...DEFAULT_TABLE_COLUMNS])
  const [tableColumnsOpen, setTableColumnsOpen] = useState(false)
  const [addMemberSearchByFamily, setAddMemberSearchByFamily] = useState<Record<string, string>>({})
  // Debounced mirror of addMemberSearchByFamily - the input itself stays
  // instantly responsive (bound to addMemberSearchByFamily), but the
  // expensive candidate-matching memo below reads from this debounced copy
  // so it doesn't re-run on every single keystroke.
  const [debouncedAddMemberSearchByFamily, setDebouncedAddMemberSearchByFamily] = useState<Record<string, string>>({})
  const [removeMemberEpicByFamily, setRemoveMemberEpicByFamily] = useState<Record<string, string>>({})
  const [rowColorTargetByFamily, setRowColorTargetByFamily] = useState<Record<string, string>>({})
  const [headCandidateByFamily, setHeadCandidateByFamily] = useState<Record<string, string>>({})
  const [breakSelectionByFamily, setBreakSelectionByFamily] = useState<Record<string, string[]>>({})
  const [breakHeadByFamily, setBreakHeadByFamily] = useState<Record<string, string>>({})
  const [mergeTargetByFamily, setMergeTargetByFamily] = useState<Record<string, string>>({})
  const [mergeQueryByFamily, setMergeQueryByFamily] = useState<Record<string, string>>({})
  const [mergingFamilyKey, setMergingFamilyKey] = useState<string | null>(null)
  const [openMenuFamily, setOpenMenuFamily] = useState<string | null>(null)
  const [categoryMenuFamily, setCategoryMenuFamily] = useState<string | null>(null)
  const [categoryAnchor, setCategoryAnchor] = useState<HTMLButtonElement | null>(null)
  const [presenceMenuFamily, setPresenceMenuFamily] = useState<string | null>(null)
  const [presenceAnchor, setPresenceAnchor] = useState<HTMLButtonElement | null>(null)
  const [presenceMenuMember, setPresenceMenuMember] = useState<string | null>(null)
  const [presenceMemberAnchor, setPresenceMemberAnchor] = useState<HTMLButtonElement | null>(null)
  const [savingPresenceKey, setSavingPresenceKey] = useState<string | null>(null)
  const [placeClubs, setPlaceClubs] = useState<PlaceClub[]>([])
  const [familyPlaceByHead, setFamilyPlaceByHead] = useState<Record<string, string>>({})
  const [addVoterFamilyKey, setAddVoterFamilyKey] = useState<string | null>(null)
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLButtonElement | null>(null)
  const [activePanelByFamily, setActivePanelByFamily] = useState<Record<string, FamilyPanel>>({})
  const [dragReorder, setDragReorder] = useState<{ familyKey: string; fromIndex: number } | null>(null)
  const [bulkAssignFamilyKey, setBulkAssignFamilyKey] = useState<string | null>(null)
  const { isAdminAreaAllowed, profile, loading: authLoading } = useAuth()
  const allowedWardsKey = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((ward) => Number.isFinite(ward))))
    wards.sort((a, b) => a - b)
    return wards.join(',')
  }, [profile?.allowed_wards])
  const wardScope = buildWardScope(profile?.role, profile?.allowed_wards)
  const leaderCacheScope = useMemo(() => buildTeamLeaderScope(profile?.role ?? null, profile?.allowed_wards ?? null), [profile?.role, profile?.allowed_wards])

  // Office/Shifted leader ids - a voter assigned to one of these is considered
  // "unassigned" for display purposes (parked, not really assigned to a field
  // team leader).
  const specialLeaderIds = useMemo(() => specialLeaderIdSet(leaderOptions), [leaderOptions])
  const officeLeaderIds = useMemo(() => new Set(leaderOptions.filter((option) => isOfficeLeader(option)).map((option) => option.id)), [leaderOptions])
  const shiftedLeaderIds = useMemo(() => new Set(leaderOptions.filter((option) => isShiftedLeader(option)).map((option) => option.id)), [leaderOptions])
  // Leader id -> display name, for the per-family leader chip.
  const leaderNameById = useMemo(() => {
    const names: Record<string, string> = {}
    for (const option of leaderOptions) {
      names[option.id] = option.name
    }
    return names
  }, [leaderOptions])

  // The team leader currently picked in the global "assign to" bar, if any.
  const globalAssignLeader = useMemo(
    () => (globalAssignLeaderId ? leaderOptions.find((option) => option.id === globalAssignLeaderId) ?? null : null),
    [leaderOptions, globalAssignLeaderId],
  )
  const pickerLeaderOptions = useMemo(() => dedupeSpecialLeaders(leaderOptions), [leaderOptions])
  const partLeaderOptions = useMemo(() => {
    if (partFilter === 'all') return []
    return pickerLeaderOptions.filter((option) => String(option.part_no ?? '') === partFilter)
  }, [pickerLeaderOptions, partFilter])
  const globalLeaderMatches = useMemo(() => {
    const matches = filterLeaderOptions(partLeaderOptions, globalLeaderSearch)
    if (globalAssignLeader && !matches.some((option) => option.id === globalAssignLeader.id)) {
      return [globalAssignLeader, ...matches]
    }
    return matches
  }, [partLeaderOptions, globalLeaderSearch, globalAssignLeader])

  // Load the team-leader assignment map + the leader list for the inline
  // assign/transfer control. Runs once on mount (before `load()` above) so
  // the badge is available even while the voter table is still streaming in.
  useEffect(() => {
    if (authLoading) return
    let cancelled = false
    async function run() {
      const consolidation = await consolidateSpecialLeaders()
      if (cancelled) return
      if (consolidation.changed) {
        clearTeamLeadersListCache()
        clearTeamLeaderDetailCache()
        clearUnassignedDataCache()
      }
      const { data: assignments, error } = await fetchAllAssignmentLinks()
      if (error) {
        if (!cancelled) toast.error(error)
        return
      }
      const links = assignments ?? []
      const nextMap: Record<string, string> = {}
      for (const link of links) {
        if (!link.voter_id || !link.team_leader_id) continue
        if (!(link.voter_id in nextMap)) {
          nextMap[link.voter_id] = link.team_leader_id
        }
      }
      if (!cancelled) setVoterToLeaderId(nextMap)

      // Build the leader picker from the cached team-leaders list when
      // possible. On a cold cache (first visit, cleared cache, or a scope
      // whose cache was never written) fall back to fetching the leader list
      // from the DB so names and the assign/search UI appear right away
      // instead of only after the cache gets populated by another page.
      const cacheEntry = readTeamLeaderCache(leaderCacheScope)
      const leaders = cacheEntry?.data.leaders ?? []
      let options: UnassignedLeaderOption[]
      if (leaders.length) {
        const nameById = cacheEntry?.data.leaderDisplayNameById ?? {}
        const voterById = new Map((cacheEntry?.data.voters ?? []).map((v) => [v.id, v]))
        options = buildLeaderOptions(leaders, (id) => voterById.get(id), nameById)
      } else {
        options = await fetchLeaderOptions()
        if (cancelled) {
          return
        }
      }
      if (!cancelled) setLeaderOptions(options)
    }
    void run()
    return () => { cancelled = true }
  }, [leaderCacheScope, authLoading])

  // Family's current leader: derived from the first member with an assignment
  // (all members share the leader after any assign/transfer via
  // assignFamilyToLeader/transferFamilyToLeader). Returns '' when unassigned.
  const familyLeaderId = useCallback((family: FamilyGroup): string => {
    for (const member of family.members) {
      const leaderId = voterToLeaderId[member.id]
      if (leaderId) return leaderId
    }
    return ''
  }, [voterToLeaderId])

  const familyAssignmentKind = useCallback((family: FamilyGroup): 'assigned' | 'unassigned' | 'shifted' | 'single' => {
    const leaderId = familyLeaderId(family)
    if (!leaderId) return 'unassigned'
    if (officeLeaderIds.has(leaderId)) return 'shifted'
    if (shiftedLeaderIds.has(leaderId)) return 'single'
    return 'assigned'
  }, [familyLeaderId, officeLeaderIds, shiftedLeaderIds])

  // Assign (or transfer) a whole family to a team leader.
  const setFamilyLeader = async (family: FamilyGroup, toLeaderId: string) => {
    if (!toLeaderId || toLeaderId === familyLeaderId(family)) {
      setLeaderSelectByFamily((current) => ({ ...current, [family.key]: '' }))
      return
    }
    setAssigningLeaderFamily(family.key)
    try {
      const voterIds = family.members.map((member) => member.id)
      const directVoter = family.headVoter ?? family.members[0]
      const isDirectVoterIds = new Set(directVoter ? [directVoter.id] : [])
      const currentLeaderId = familyLeaderId(family)
      const result = currentLeaderId
        ? await transferFamilyToLeader({ voterIds, toLeaderId, assignedBy: profile?.id ?? null })
        : await assignFamilyToLeader({ voterIds, toLeaderId, assignedBy: profile?.id ?? null, isDirectVoterIds, specialLeaderIds })
      const changed = result.voterIds ?? voterIds
      setVoterToLeaderId((current) => {
        const next = { ...current }
        for (const id of changed) {
          next[id] = toLeaderId
        }
        return next
      })
      setLeaderSelectByFamily((current) => ({ ...current, [family.key]: '' }))
      clearTeamLeadersListCache()
      clearTeamLeaderDetailCache()
      clearUnassignedDataCache()
      toast.success(`Family ${family.head} assigned to ${leaderNameById[toLeaderId] ?? toLeaderId}.`)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setAssigningLeaderFamily(null)
    }
  }

  useEffect(() => {
    if (authLoading) return
    let cancelled = false
    void (async () => {
      try {
        const [clubs, links] = await Promise.all([fetchPlaceClubs(), fetchFamilyPlaceClubs()])
        if (cancelled) return
        setPlaceClubs(clubs)
        setFamilyPlaceByHead(familyPlaceMap(links))
      } catch {
        if (!cancelled) {
          setPlaceClubs([])
          setFamilyPlaceByHead({})
        }
      }
    })()
    return () => { cancelled = true }
  }, [authLoading])

  const placeClubById = useMemo(() => {
    const map = new Map<string, PlaceClub>()
    for (const club of placeClubs) map.set(club.id, club)
    return map
  }, [placeClubs])

  // After a family-structure edit (merge / add member / change head / break),
  // make any affected voter that was parked under an Office/Shifted (special)
  // leader follow the family's new owner instead. The voter is moved to the
  // family's real leader when the family has one, kept parked under the
  // special leader when the family itself is parked there, or unassigned
  // (assignment row deleted) when the family has no leader. Real-leader
  // assignments are never touched. Without this, a special-assigned voter
  // merged into another family would keep appearing under the parking leader
  // AND inside its new family (fetchLeaderFamilies expands by family_head_epic).
  const reconcileVoterAssignments = async (voterIds: string[], ownerLeaderId: string, context: string): Promise<void> => {
    if (!voterIds.length || specialLeaderIds.size === 0) {
      return
    }
    const { moved, unassigned, changedVoterIds } = await reconcileFamilyAssignments({
      voterIds,
      familyLeaderId: ownerLeaderId,
      specialLeaderIds,
      assignedBy: profile?.id ?? null,
    })
    if (!changedVoterIds.length) {
      return
    }
    setVoterToLeaderId((current) => {
      const next = { ...current }
      for (const id of changedVoterIds) {
        if (ownerLeaderId) {
          next[id] = ownerLeaderId
        } else {
          delete next[id]
        }
      }
      return next
    })
    const parts: string[] = []
    if (moved > 0) {
      parts.push(`${moved} ${moved === 1 ? 'voter was' : 'voters were'} moved to ${ownerLeaderId ? (leaderNameById[ownerLeaderId] ?? ownerLeaderId) : 'the family leader'}`)
    }
    if (unassigned > 0) {
      parts.push(`${unassigned} ${unassigned === 1 ? 'voter was' : 'voters were'} unassigned`)
    }
    toast.success(`${context}: ${parts.join(', ')}.`)
  }

  const load = useCallback(async (options?: { keepExisting?: boolean }) => {
    const keepExisting = options?.keepExisting ?? false
    const cachedRows = withNormalizedVoterCategories(readCachedVoters(FAMILY_CACHE_KEY, wardScope, FAST_NAV_CACHE_MAX_AGE_MS) ?? [])
    setLoading(!cachedRows.length)
    if (!keepExisting) {
      if (cachedRows.length) {
        setRows(cachedRows)
      } else {
        const warmRows = withNormalizedVoterCategories(readWarmFamiliesCache() ?? [])
        if (warmRows.length) {
          setRows(warmRows)
          setLoading(false)
        }
      }
    }

    const allowedWards = allowedWardsKey
      .split(',')
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
    const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0

    const buildRequest = (offset: number) => {
      let request = supabase
        .from('voters')
        .select('*')
        .order('updated_at', { ascending: false })
        .order('id', { ascending: true })
        .range(offset, offset + batchSize - 1)

      if (hasWardRestriction) {
        request = request.in('ward_no', allowedWards)
      }

      return request
    }

    // Fetch the first page on its own so the UI (and the add-member /
    // create-family search boxes) has something to show as fast as
    // possible, then pull every remaining page CONCURRENTLY instead of
    // one-at-a-time. Sequentially awaiting a `range()` loop meant a large
    // voter table (thousands of rows, 400 at a time) could take 10-15s+
    // of back-to-back round trips before search results were complete.
    // Firing the remaining pages in parallel turns that into roughly a
    // single round trip's worth of wall-clock time per wave.
    const first = await buildRequest(0)
    if (first.error) {
      toast.error(first.error.message)
      setLoading(false)
      return
    }

    const firstBatch = withNormalizedVoterCategories((first.data as Voter[] | null) ?? [])
    const nextRows: Voter[] = [...firstBatch]

    if (firstBatch.length) {
      if (!keepExisting) {
        setRows([...nextRows])
        setLoading(false)
      }
    }

    if (firstBatch.length === batchSize) {
      // We don't know the exact total up front, so probe forward in
      // parallel "waves": fetch several pages at once, and only request
      // another wave while the previous one came back full (meaning
      // there's likely more data past it).
      const waveSize = 6
      let offset = batchSize
      let keepGoing = true

      while (keepGoing) {
        const offsets = Array.from({ length: waveSize }, (_, index) => offset + index * batchSize)
        const results = await Promise.all(offsets.map((pageOffset) => buildRequest(pageOffset)))

        let shortPageSeen = false
        for (const result of results) {
          if (result.error) {
            toast.error(result.error.message)
            continue
          }
          const batch = withNormalizedVoterCategories((result.data as Voter[] | null) ?? [])
          nextRows.push(...batch)
          if (batch.length < batchSize) {
            shortPageSeen = true
          }
        }

        if (!keepExisting) {
          setRows([...nextRows])
          setLoading(false)
        }

        offset += waveSize * batchSize
        keepGoing = !shortPageSeen
      }
    }

    setLoading(false)
    setRows(nextRows)
    writeCachedVoters(FAMILY_CACHE_KEY, wardScope, nextRows)
    writeWarmFamiliesCache(nextRows)
  }, [allowedWardsKey, profile?.role, wardScope])

  useEffect(() => {
    if (authLoading) return
    void load()
  }, [load, authLoading])

  // Reload the family list after a mutation while keeping the user anchored
  // to the family they were working on. The `keepExisting` flag skips the
  // mid-reload partial-batch overwrites that used to collapse the list height
  // (and reset the scroll position); after the reload finishes, the
  // pending-scroll effect below brings the edited family back into view.
  //
  // Changing a family's structure (break / merge / change head / move member)
  // can change which voters a team leader's assigned families contain, so any
  // cached team-leader pages must be invalidated here or they would keep
  // showing the pre-mutation grouping (a broken family would still appear as
  // the original merged family).
  const reloadAfterMutation = (familyKey: string) => {
    clearTeamLeaderDetailCache()
    clearTeamLeadersListCache()
    clearUnassignedDataCache()
    pendingScrollFamilyKeyRef.current = familyKey
    pendingScrollFallbackYRef.current = window.scrollY
    return load({ keepExisting: true })
  }

  // Applies known row changes to the in-memory `rows` list and the
  // localStorage caches without re-fetching the whole voter table. Mutations
  // that know exactly which rows they changed (e.g. addMemberToFamily) use
  // this instead of a full `load()` - re-pulling every page just to reflect
  // one changed row is what made add-member take 5-10s on large tables.
  const applyLocalRowUpdates = (updates: Voter[]) => {
    if (!updates.length || !rows.length) {
      return
    }
    const byId = new Map(updates.map((row) => [row.id, row]))
    const existingIds = new Set(rows.map((row) => row.id))
    const next = rows.map((row) => byId.get(row.id) ?? row)
    for (const row of updates) {
      if (!existingIds.has(row.id)) {
        next.push(row)
      }
    }
    setRows(next)
    writeCachedVoters(FAMILY_CACHE_KEY, wardScope, next)
    writeWarmFamiliesCache(next)
  }

  // Close the Voter Detail drawer on Escape, from anywhere on the page.
  useEffect(() => {
    if (!selectedVoter) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedVoter(null)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectedVoter])

  const searchTokens = useMemo(() => tokenizeLookup(query), [query])
  const hasActiveSearch = searchTokens.length > 0

  // Debounced mirror of the main search input - the input itself stays
  // instantly responsive (bound to `query`), but the expensive server-side
  // lookup effect below reads from this copy so it doesn't fire DB queries on
  // every single keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState(query)
  const debouncedSearchTokens = useMemo(() => tokenizeLookup(debouncedQuery), [debouncedQuery])
  const hasActiveDebouncedSearch = debouncedSearchTokens.length > 0

  // Precomputed, normalized search entry for every voter in the loaded
  // scope. The main family search and the "add member" picker both read from
  // this instead of rebuilding normalized strings on every keystroke - the
  // main search below can therefore resolve most queries with zero DB round
  // trips because the full table is already in `rows`.
  const searchableRowsIndex = useMemo(() => buildSearchableIndex(rows), [rows])

  useEffect(() => {
    // Clear the moment the box is emptied so the family list snaps straight
    // back to the full (unsearched) view instead of waiting out the delay.
    if (!query.trim()) {
      setDebouncedQuery('')
      setEpicSearchRows([])
      return
    }

    const timer = setTimeout(() => {
      setDebouncedQuery(query)
    }, 300)

    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      const trimmedQuery = debouncedQuery.trim()

      if (!hasActiveDebouncedSearch || !trimmedQuery) {
        setEpicSearchRows((current) => (current.length ? [] : current))
        return
      }

      const normalizedSearch = normalizeLookupValue(trimmedQuery)
      const tokens = debouncedSearchTokens

      // In-memory fast path: the loaded scope's full voter table is already
      // in `rows`, so name/EPIC/contact searches resolve from the precomputed
      // index with zero round trips. In-scope results are already rendered
      // live by `filteredFamilies` (it re-runs on every keystroke), so we
      // only clear any stale out-of-scope rows left over from a previous
      // search. The DB queries below are a pure fallback for voters that
      // live outside the loaded scope (e.g. a ward this user doesn't manage).
      if (tokens.length === 1 && isLikelyEpicToken(tokens[0])) {
        const epicToken = compactLookupValue(tokens[0])
        const local = searchableRowsIndex.find((entry) => entry.compactEpic === epicToken)
        if (local) {
          setEpicSearchRows((current) => (current.length ? [] : current))
          return
        }
      } else {
        const hasLocalMatch = searchableRowsIndex.some((entry) => matchesLookupTokens(entry.lookupText, tokens))
        if (hasLocalMatch) {
          setEpicSearchRows((current) => (current.length ? [] : current))
          return
        }
      }

      const searchPattern = `%${escapeIlikePattern(trimmedQuery).replace(/\s+/g, '%')}%`

      if (debouncedSearchTokens.length === 1 && isLikelyEpicToken(debouncedSearchTokens[0])) {
        const epicToken = compactLookupValue(debouncedSearchTokens[0])
        const { data: exactRow, error: exactError } = await supabase
          .from('voters')
          .select('*')
          .eq('epic_no', epicToken)
          .maybeSingle()

        if (cancelled) {
          return
        }

        if (exactError || !exactRow) {
          setEpicSearchRows([])
          return
        }

        const relatedOr = [
          `family_head_epic.eq.${exactRow.epic_no}`,
          `relative_name.ilike.${escapeIlikePattern(String(exactRow.name)).replace(/\s+/g, '%')}`,
          `name.ilike.${escapeIlikePattern(String(exactRow.name)).replace(/\s+/g, '%')}`,
        ].join(',')

        const { data: relatedRows } = await supabase.from('voters').select('*').or(relatedOr)
        if (cancelled) {
          return
        }

        const combined = [exactRow as Voter, ...((relatedRows as Voter[] | null) ?? [])]
        const seen = new Set<string>()
        const nextRows: Voter[] = []
        for (const row of combined) {
          const key = compactLookupValue(row.epic_no)
          if (!key || seen.has(key)) {
            continue
          }
          seen.add(key)
          nextRows.push(row)
        }

        setEpicSearchRows(nextRows)
        return
      }

      const { data: matchedRows, error } = await supabase
        .from('voters')
        .select('*')
        .or(
          [
            `name.ilike.${searchPattern}`,
            `relative_name.ilike.${searchPattern}`,
            `family_label.ilike.${searchPattern}`,
            `epic_no.ilike.${searchPattern}`,
          ].join(','),
        )
        .limit(250)

      if (cancelled) {
        return
      }

      if (error) {
        setEpicSearchRows([])
        return
      }

      const searchMatches = (matchedRows as Voter[] | null) ?? []
      if (!searchMatches.length) {
        setEpicSearchRows([])
        return
      }

      // The exact-name candidate is resolved from the rows already returned
      // by the search above instead of a second round trip - any row whose
      // normalized name equals the query is guaranteed to have matched the
      // `name.ilike` clause already.
      const exactNameMatch = searchMatches.find((row) => normalizeLookupValue(row.name) === normalizedSearch)
      const seedRow = exactNameMatch ?? searchMatches[0]
      const seedPattern = `%${escapeIlikePattern(String(seedRow.name)).replace(/\s+/g, '%')}%`

      const { data: familyRows } = await supabase
        .from('voters')
        .select('*')
        .or(
          [
            `family_head_epic.eq.${seedRow.epic_no}`,
            `relative_name.ilike.${seedPattern}`,
            `name.ilike.${seedPattern}`,
          ].join(','),
        )

      if (cancelled) {
        return
      }

      const combined = [seedRow, ...searchMatches, ...((familyRows as Voter[] | null) ?? [])]
      const seen = new Set<string>()
      const nextRows: Voter[] = []
      for (const row of combined) {
        const key = compactLookupValue(row.epic_no)
        if (!key || seen.has(key)) {
          continue
        }
        seen.add(key)
        nextRows.push(row)
      }

      setEpicSearchRows(nextRows)
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [debouncedQuery, debouncedSearchTokens, hasActiveDebouncedSearch, searchableRowsIndex])

  const visibleRows = useMemo(() => {
    if (!epicSearchRows.length) {
      return rows
    }

    const merged = [...rows, ...epicSearchRows]
    const seen = new Set<string>()
    const deduped: Voter[] = []

    for (const row of merged) {
      const key = compactLookupValue(row.epic_no)
      if (!key || seen.has(key)) {
        continue
      }
      seen.add(key)
      deduped.push(row)
    }

    return deduped
  }, [epicSearchRows, rows])

  const families = useMemo(() => buildFamilies(visibleRows), [visibleRows])

  // Precomputed normalized search text per family. `filteredFamilies` re-runs
  // on every search keystroke, and previously each pass rebuilt a lookup
  // string for every family from scratch - memoizing it here keeps typing
  // responsive on workspaces with thousands of families.
  const familyLookupTextIndex = useMemo(() => {
    const index = new Map<string, string>()
    for (const family of families) {
      index.set(family.key, buildFamilyLookupText(family))
    }
    return index
  }, [families])

  // Maps every voter's compact EPIC -> the family they currently belong to.
  // Built from `rows` (the full loaded voter set for this workspace/ward
  // scope), not just `visibleRows`, so it stays accurate even while an
  // unrelated epic/name search is temporarily injecting extra rows. This is
  // the single source of truth for "is this voter already claimed by a
  // family with other members" - used to keep already-placed voters out of
  // the add-member / create-family search results, and to badge them when
  // they still show up as a suggestion.
  const familyLookupByEpic = useMemo(() => {
    const map = new Map<string, FamilyGroup>()
    for (const family of buildFamilies(rows)) {
      for (const member of family.members) {
        const key = compactLookupValue(member.epic_no)
        if (key) {
          map.set(key, family)
        }
      }
    }
    return map
  }, [rows])

  const partOptions = useMemo(() => uniqueNumberList(rows.map((row) => row.part_no)), [rows])
  const wardOptions = useMemo(() => uniqueNumberList(rows.map((row) => row.ward_no)), [rows])

  // Sections are scoped to the currently selected part - a part's section
  // numbering is only meaningful within that part, so "All Parts" offers no
  // section list at all.
  const sectionOptions = useMemo(() => {
    if (partFilter === 'all') {
      return []
    }
    return uniqueNumberList(rows.filter((row) => String(row.part_no ?? '') === partFilter).map((row) => row.section))
  }, [rows, partFilter])

  // Religion/State filters only ever read from family heads. Like sections,
  // their option lists (and visibility) are scoped to the selected part so
  // they don't show up as noise while "All Parts" is active.
  const religionOptions = useMemo(() => {
    if (partFilter === 'all') {
      return []
    }
    const values = new Set<string>()
    for (const row of rows) {
      if (String(row.part_no ?? '') !== partFilter) continue
      const value = (row.religion ?? '').trim()
      if (value) values.add(value)
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b))
  }, [rows, partFilter])

  const stateOptions = useMemo(() => {
    if (partFilter === 'all') {
      return []
    }
    const values = new Set<string>()
    for (const row of rows) {
      if (String(row.part_no ?? '') !== partFilter) continue
      const value = (row.state ?? '').trim()
      if (value) values.add(value)
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b))
  }, [rows, partFilter])

  useEffect(() => {
    if (partFilter !== 'all' && !partOptions.some((part) => String(part) === partFilter)) {
      setPartFilter('all')
    }
  }, [partFilter, partOptions, setPartFilter])

  useEffect(() => {
    if (wardFilter !== 'all' && !wardOptions.some((ward) => String(ward) === wardFilter)) {
      setWardFilter('all')
    }
  }, [setWardFilter, wardFilter, wardOptions])

  // Reset the section filter whenever it's no longer valid - most importantly
  // when the part filter changes (sections are part-scoped) or is cleared.
  useEffect(() => {
    if (partFilter === 'all' && sectionFilter !== 'all') {
      setSectionFilter('all')
      return
    }
    if (sectionFilter !== 'all' && !sectionOptions.some((section) => String(section) === sectionFilter)) {
      setSectionFilter('all')
    }
  }, [partFilter, sectionFilter, sectionOptions, setSectionFilter])

  useEffect(() => {
    if (religionFilter !== 'all' && (partFilter === 'all' || !religionOptions.includes(religionFilter))) {
      setReligionFilter('all')
    }
  }, [partFilter, religionFilter, religionOptions, setReligionFilter])

  useEffect(() => {
    if (stateFilter !== 'all' && (partFilter === 'all' || !stateOptions.includes(stateFilter))) {
      setStateFilter('all')
    }
  }, [partFilter, stateFilter, stateOptions, setStateFilter])

  // The gender filter is part-scoped like religion/state - it's only useful
  // once a part is picked, so clear it when the part filter is removed.
  useEffect(() => {
    if (genderFilter !== 'all' && partFilter === 'all') {
      setGenderFilter('all')
    }
  }, [partFilter, genderFilter, setGenderFilter])

  // Builds a header like "PART 2 | SECTION 3 - Near Sudesh Bakery | HINDU |
  // KARNATAKA" from the currently selected part/section/religion/state
  // filters, pulling the section's display name from any matching row. Used
  // for both the on-page banner and the print/export header when the "show
  // header" toggle is on. Religion/state only ever appear here when the
  // corresponding filter is actually set (they're no-ops on "All").
  const activePartSectionLabel = useMemo(() => {
    if (partFilter === 'all') {
      return ''
    }
    let label = `PART ${partFilter}`
    if (sectionFilter !== 'all') {
      const sectionNameMatch = rows.find(
        (row) => String(row.part_no ?? '') === partFilter && String(row.section ?? '') === sectionFilter && row.section_name,
      )
      label += ` | Section ${sectionFilter}`
      if (sectionNameMatch?.section_name) {
        label += ` - ${sectionNameMatch.section_name}`
      }
    }
    if (religionFilter !== 'all') {
      label += ` | ${religionFilter.toUpperCase()}`
    }
    if (stateFilter !== 'all') {
      label += ` | ${stateFilter.toUpperCase()}`
    }
    if (genderFilter !== 'all') {
      label += ` | ${genderFilter === 'male' ? 'MALE' : 'FEMALE'}`
    }
    return label
  }, [genderFilter, partFilter, religionFilter, rows, sectionFilter, stateFilter])

  const filteredFamilies = useMemo(() => {
    return families.filter((family) => {
      // The name/EPIC search box now combines WITH the other filters
      // (AND), instead of overriding them. Previously, typing a search
      // term short-circuited every other filter, so selecting "Part 1" and
      // searching "xyz" would still surface a Part 3 or Part 6 family with
      // a matching name. Now a family must match the search AND every
      // active part/ward/section/religion/state/size filter.
      if (hasActiveSearch && !familyMatchesSearch(family, searchTokens, familyLookupTextIndex)) {
        return false
      }

      // Resolve part/ward from the FAMILY HEAD only, not any member. A family
      // stays intact under its head's part/ward even if individual members
      // are registered elsewhere - this avoids splitting or duplicating a
      // family across multiple part/ward filtered views.
      const familyMatchesPart = partFilter === 'all' || String(family.headVoter?.part_no ?? '') === partFilter
      if (!familyMatchesPart) {
        return false
      }

      const familyMatchesWard = wardFilter === 'all' || String(family.headVoter?.ward_no ?? '') === wardFilter
      if (!familyMatchesWard) {
        return false
      }

      // Section filter is resolved from the FAMILY HEAD only, never from
      // members - a family stays intact under its head's section even if
      // individual members are registered in a different section.
      const familyMatchesSection = sectionFilter === 'all' || String(family.headVoter?.section ?? '') === sectionFilter
      if (!familyMatchesSection) {
        return false
      }

      // Religion/State filters are resolved from the FAMILY HEAD only, never
      // from members - a family stays intact even if individual members
      // have a different religion/state on record.
      const familyMatchesReligion = religionFilter === 'all' || (family.headVoter?.religion ?? '').trim() === religionFilter
      if (!familyMatchesReligion) {
        return false
      }

      const familyMatchesState = stateFilter === 'all' || (family.headVoter?.state ?? '').trim() === stateFilter
      if (!familyMatchesState) {
        return false
      }

      // Gender filter matches ANY member (head or otherwise) - a family
      // appears if it has at least one member of the selected gender. The
      // member rows themselves are gender-filtered when rendered/exported
      // (see genderScopedFamilies/visibleMembersForFamily below), so a
      // "Female" view shows only the female members of each qualifying
      // family.
      const familyMatchesGender =
        genderFilter === 'all' || family.members.some((member) => (member.gender ?? '').toLowerCase() === genderFilter)
      if (!familyMatchesGender) {
        return false
      }

      if (!familyMatchesSizeFilter(family, sizeFilterValues)) {
        return false
      }

      if (assignmentFilter !== 'all' && familyAssignmentKind(family) !== assignmentFilter) {
        return false
      }

      if (categoryFilter !== 'all') {
        const familyCat = family.headVoter?.voter_category ?? null
        if (categoryFilter === 'unassigned') {
          if (familyCat != null) return false
        } else if (familyCat !== categoryFilter) {
          return false
        }
      }

      if (globalAssignLeaderId && familyLeaderId(family) !== globalAssignLeaderId) {
        return false
      }

      return true
    })
  }, [assignmentFilter, categoryFilter, families, familyAssignmentKind, familyLeaderId, familyLookupTextIndex, genderFilter, globalAssignLeaderId, hasActiveSearch, partFilter, religionFilter, searchTokens, sectionFilter, sizeFilterValues, stateFilter, wardFilter])

  const activeFilterCount =
    (partFilter !== 'all' ? 1 : 0) +
    (wardFilter !== 'all' ? 1 : 0) +
    (sectionFilter !== 'all' ? 1 : 0) +
    (religionFilter !== 'all' ? 1 : 0) +
    (stateFilter !== 'all' ? 1 : 0) +
    (genderFilter !== 'all' ? 1 : 0) +
    (assignmentFilter !== 'all' ? 1 : 0) +
    (categoryFilter !== 'all' ? 1 : 0) +
    sizeFilterValues.length

  const resetFilters = () => {
    setPartFilter('all')
    setWardFilter('all')
    setSectionFilter('all')
    setReligionFilter('all')
    setStateFilter('all')
    setGenderFilter('all')
    setAssignmentFilter('all')
    setCategoryFilter('all')
    setSizeFilterValues([])
    setGlobalAssignLeaderId('')
    setGlobalLeaderSearch('')
  }

  useEffect(() => {
    setGlobalAssignLeaderId('')
    setGlobalLeaderSearch('')
  }, [partFilter])

  useEffect(() => {
    if (!globalAssignLeaderId) return
    if (!partLeaderOptions.some((option) => option.id === globalAssignLeaderId)) {
      setGlobalAssignLeaderId('')
      setGlobalLeaderSearch('')
    }
  }, [globalAssignLeaderId, partLeaderOptions])

  useEffect(() => {
    setFamilyRenderLimit(initialFamilyRenderLimit)
  }, [assignmentFilter, categoryFilter, genderFilter, globalAssignLeaderId, initialFamilyRenderLimit, partFilter, query, religionFilter, sectionFilter, sizeFilterValues, stateFilter, wardFilter])

  const renderedFamilies = useMemo(() => filteredFamilies.slice(0, familyRenderLimit), [familyRenderLimit, filteredFamilies])
  const hasMoreFamilies = renderedFamilies.length < filteredFamilies.length

  const familyFilterCounts = useMemo(() => {
    const counts = {
      families: 0,
      voters: 0,
      assigned: 0,
      unassigned: 0,
      shifted: 0,
      single: 0,
      noCategory: 0,
      byCategory: Object.fromEntries(VOTER_CATEGORY_OPTIONS.map((option) => [option.value, 0])) as Record<string, number>,
    }
    const baseFamilies = families.filter((family) => {
      if (hasActiveSearch && !familyMatchesSearch(family, searchTokens, familyLookupTextIndex)) return false
      if (partFilter !== 'all' && String(family.headVoter?.part_no ?? '') !== partFilter) return false
      if (wardFilter !== 'all' && String(family.headVoter?.ward_no ?? '') !== wardFilter) return false
      if (sectionFilter !== 'all' && String(family.headVoter?.section ?? '') !== sectionFilter) return false
      if (religionFilter !== 'all' && (family.headVoter?.religion ?? '').trim() !== religionFilter) return false
      if (stateFilter !== 'all' && (family.headVoter?.state ?? '').trim() !== stateFilter) return false
      if (genderFilter !== 'all' && !family.members.some((member) => (member.gender ?? '').toLowerCase() === genderFilter)) return false
      if (!familyMatchesSizeFilter(family, sizeFilterValues)) return false
      return true
    })
    for (const family of baseFamilies) {
      counts.families += 1
      counts.voters += family.members.length
      const kind = familyAssignmentKind(family)
      counts[kind] += 1
      const familyCat = family.headVoter?.voter_category ?? null
      if (!familyCat) counts.noCategory += 1
      else counts.byCategory[familyCat] = (counts.byCategory[familyCat] ?? 0) + 1
    }
    return counts
  }, [families, familyAssignmentKind, familyLookupTextIndex, genderFilter, hasActiveSearch, partFilter, religionFilter, searchTokens, sectionFilter, sizeFilterValues, stateFilter, wardFilter])

  // After a mutation-triggered reload, scroll the family the user was working
  // on back into view once the refreshed list has rendered. Falls back to the
  // saved pixel offset if the family is no longer present.
  useEffect(() => {
    const familyKey = pendingScrollFamilyKeyRef.current
    if (!familyKey) {
      return
    }

    const section = document.querySelector<HTMLElement>(`[data-family-key=${JSON.stringify(familyKey)}]`)
    if (!section) {
      window.scrollTo(0, pendingScrollFallbackYRef.current)
      pendingScrollFamilyKeyRef.current = null
      return
    }

    pendingScrollFamilyKeyRef.current = null
    section.scrollIntoView({ block: 'start' })
  }, [renderedFamilies])

  // When a gender filter is active, these helpers restrict which members are
  // shown/exported. genderScopedFamilies keeps families whole for management
  // while producing gender-filtered copies for reports; visibleMembersForFamily
  // is the display-side equivalent used by the family cards.
  const genderScopedFamilies = useCallback((list: FamilyGroup[]): FamilyGroup[] => {
    if (genderFilter === 'all') return list
    return list
      .map((family) => ({
        ...family,
        members: family.members.filter((member) => (member.gender ?? '').toLowerCase() === genderFilter),
      }))
      .filter((family) => family.members.length > 0)
  }, [genderFilter])

  const visibleMembersForFamily = useCallback((family: FamilyGroup): Voter[] => {
    if (genderFilter === 'all') return family.members
    return family.members.filter((member) => (member.gender ?? '').toLowerCase() === genderFilter)
  }, [genderFilter])

  // Representative row for "heads only" reports: the family head when it
  // matches the active gender filter (or when no filter is set), otherwise
  // the first visible member of the selected gender.
  const familyRepresentative = useCallback((family: FamilyGroup): Voter | undefined => {
    const head = family.headVoter
    if (genderFilter === 'all') return head ?? family.members[0]
    if (head && (head.gender ?? '').toLowerCase() === genderFilter) return head
    return family.members.find((member) => (member.gender ?? '').toLowerCase() === genderFilter)
  }, [genderFilter])

  const visiblePhotoPaths = useMemo(() => {
    return Array.from(new Set(renderedFamilies.flatMap((family) => visibleMembersForFamily(family).map((member) => member.photo_url).filter(Boolean)))) as string[]
  }, [renderedFamilies, visibleMembersForFamily])

  useEffect(() => {
    photoUrlByPathRef.current = photoUrlByPath
  }, [photoUrlByPath])

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      const missingPaths = visiblePhotoPaths.filter((path) => !photoUrlByPathRef.current[path])
      if (!missingPaths.length) {
        setLoadingImages(false)
        return
      }

      setLoadingImages(true)

      // --- CRITICAL: request 500px transformed images ---
      // Signing is done in small concurrent waves instead of firing one
      // createSignedUrl request per visible photo at once. A cold cache on a
      // large page used to fan out hundreds of simultaneous requests, and
      // nothing was shown until EVERY one had finished, which is what made
      // photo loading feel slow. Signed URLs are published to state as each
      // wave completes so photos appear progressively rather than all at
      // once.
      const WAVE_SIZE = 10
      const next: Record<string, string> = {}

      for (let i = 0; i < missingPaths.length; i += WAVE_SIZE) {
        if (cancelled) return
        const wave = missingPaths.slice(i, i + WAVE_SIZE)
        const signedResults = await Promise.all(
          wave.map((path) =>
            supabase.storage
              .from('voter-photos')
              .createSignedUrl(path, 60 * 60, {
                transform: { width: 500, height: 500, resize: 'cover' },
              })
          )
        )

        if (cancelled) return

        for (let j = 0; j < signedResults.length; j++) {
          const result = signedResults[j]
          if (result.error || !result.data?.signedUrl) continue
          next[wave[j]] = result.data.signedUrl
        }

        if (Object.keys(next).length) {
          photoUrlByPathRef.current = { ...photoUrlByPathRef.current, ...next }
          const expiresAt = Date.now() + PHOTO_URL_ENTRY_TTL_MS
          const nextExpiry = { ...photoUrlExpiryRef.current }
          for (const path of Object.keys(next)) {
            nextExpiry[path] = expiresAt
          }
          photoUrlExpiryRef.current = nextExpiry

          setPhotoUrlByPath((current) => {
            const merged = { ...current, ...next }
            const cacheEntries: Record<string, PhotoUrlCacheEntry> = {}
            for (const [path, url] of Object.entries(merged)) {
              const entryExpiresAt = photoUrlExpiryRef.current?.[path]
              if (entryExpiresAt) {
                cacheEntries[path] = { url, expiresAt: entryExpiresAt }
              }
            }
            writePhotoUrlCache(cacheEntries)
            return merged
          })
        }
      }

      if (!cancelled) {
        setLoadingImages(false)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [visiblePhotoPaths])

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedAddMemberSearchByFamily(addMemberSearchByFamily)
    }, 220)

    return () => clearTimeout(timer)
  }, [addMemberSearchByFamily])

  const addMemberCandidatesByFamily = useMemo(() => {
    const candidatesByFamily: Record<string, Voter[]> = {}
    const scope = { partFilter, sectionFilter, wardFilter }

    for (const family of families) {
      // Only the family panel that's actually open needs candidates - this
      // is the main fix for the add-member search lag, since previously
      // every open/closed family recomputed its candidate list on every
      // keystroke in ANY family's search box.
      if ((activePanelByFamily[family.key] ?? 'none') !== 'manage') {
        continue
      }

      const search = (debouncedAddMemberSearchByFamily[family.key] ?? '').trim()
      const tokens = tokenizeLookup(search)

      if (!tokens.length) {
        candidatesByFamily[family.key] = []
        continue
      }

      const compactSearch = tokens.join('')
      const firstToken = tokens[0] ?? ''
      const existingFamilyEpics = new Set(family.members.map((member) => compactLookupValue(member.epic_no)))

      const candidates = searchableRowsIndex
        .filter((entry) => !existingFamilyEpics.has(entry.compactEpic))
        // Never suggest a voter who is already claimed by a family with
        // other members - only voters who are still their own solo
        // "family of one" are eligible to be added elsewhere. To actually
        // move a voter between families, remove them from their current
        // family first.
        .filter((entry) => {
          const existingFamily = familyLookupByEpic.get(entry.compactEpic)
          return !existingFamily || existingFamily.members.length <= 1
        })
        // Respect the active Part/Section/Ward filter - if you've filtered
        // the page down to Part 1, the add-member search should only ever
        // offer Part 1 voters.
        .filter((entry) => matchesActiveScopeFilters(entry.row, scope))
        .filter((entry) => matchesLookupTokens(entry.lookupText, tokens))
        .sort((a, b) => {
          const aScore =
            a.compactEpic === compactSearch || a.compactName === compactSearch
              ? 0
              : a.compactEpic.startsWith(firstToken) || a.compactName.startsWith(firstToken)
                ? 1
                : 2
          const bScore =
            b.compactEpic === compactSearch || b.compactName === compactSearch
              ? 0
              : b.compactEpic.startsWith(firstToken) || b.compactName.startsWith(firstToken)
                ? 1
                : 2

          if (aScore !== bScore) {
            return aScore - bScore
          }

          return a.row.name.localeCompare(b.row.name)
        })
        .slice(0, 8)
        .map((entry) => entry.row)

      candidatesByFamily[family.key] = candidates
    }

    return candidatesByFamily
  }, [activePanelByFamily, debouncedAddMemberSearchByFamily, familyLookupByEpic, families, partFilter, searchableRowsIndex, sectionFilter, wardFilter])

  const openPanel = (familyKey: string, panel: FamilyPanel) => {
    setActivePanelByFamily((current) => ({ ...current, [familyKey]: panel }))
    setOpenMenuFamily(null)
  }

  const closePanel = (familyKey: string) => {
    setActivePanelByFamily((current) => ({ ...current, [familyKey]: 'none' }))
  }

  const setFamilyHead = async (family: FamilyGroup, newHeadEpic: string) => {
    const memberIds = family.members.map((member) => member.id)
    if (!memberIds.length) {
      return
    }

    try {
      await forEachInChunk(memberIds, async (chunk) => {
        const { error } = await supabase.from('voters').update({ family_head_epic: newHeadEpic }).in('id', chunk)
        if (error) throw new Error(error.message)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update family head.')
      return
    }

    const previousLabel = family.headVoter?.family_label ?? null
    if (previousLabel && family.headVoter?.id) {
      const oldHeadUpdates: Record<string, string | null> = {}
      const newHeadUpdates: Record<string, string | null> = {}
      if (previousLabel) {
        oldHeadUpdates.family_label = null
        newHeadUpdates.family_label = previousLabel
      }
      const [{ error: clearOldError }, { error: setNewError }] = await Promise.all([
        supabase.from('voters').update(oldHeadUpdates).eq('id', family.headVoter.id),
        supabase.from('voters').update(newHeadUpdates).eq('epic_no', newHeadEpic).limit(1),
      ])

      if (clearOldError || setNewError) {
        toast.error(clearOldError?.message ?? setNewError?.message ?? 'Unable to move family annotation to new head.')
        return
      }
    }

    // The family's owner follows the head. If members were parked under
    // Office/Shifted while the family is owned by a real leader, they must be
    // moved to that leader so the family shows up in exactly one place. The
    // target owner is the NEW head's assignment (the reloaded family lists the
    // new head first, so familyLeaderId would resolve to it).
    const newHeadMember = family.members.find((member) => compactLookupValue(member.epic_no) === compactLookupValue(newHeadEpic))
    await reconcileVoterAssignments(memberIds, newHeadMember?.id ? (voterToLeaderId[newHeadMember.id] ?? '') : '', 'Family head updated')

    toast.success('Family head updated.')
    closePanel(family.key)
    await reloadAfterMutation(`GROUP|${normalizeGroupingValue(newHeadEpic)}`)
  }

  const removeMemberFromFamily = async (family: FamilyGroup, member: Voter) => {
    const { error } = await supabase
      .from('voters')
      .update({ family_head_epic: member.epic_no, family_label: null, family_color: null, row_color: null })
      .eq('id', member.id)

    if (error) {
      toast.error(error.message)
      return
    }

    toast.success('Member moved into a separate family.')
    closePanel(family.key)
    await reloadAfterMutation(family.key)
  }

  // Toggles a non-head member on/off in the "Break family" selection. The
  // new-family head defaults to the first member checked (in table order) -
  // matching the rule that the first selected voter becomes the new family
  // head - and is reset whenever the current head is unchecked.
  const toggleBreakSelection = (familyKey: string, epic: string) => {
    const epicKey = compactLookupValue(epic)
    const currentList = breakSelectionByFamily[familyKey] ?? []
    const exists = currentList.some((value) => compactLookupValue(value) === epicKey)
    const next = exists ? currentList.filter((value) => compactLookupValue(value) !== epicKey) : [...currentList, epic]

    const currentHead = breakHeadByFamily[familyKey] ?? ''
    const headStillSelected = next.some((value) => compactLookupValue(value) === compactLookupValue(currentHead))
    if (!currentHead || !headStillSelected) {
      setBreakHeadByFamily((current) => ({ ...current, [familyKey]: next[0] ?? '' }))
    }

    setBreakSelectionByFamily((current) => ({ ...current, [familyKey]: next }))
  }

  const breakMembersIntoNewFamily = async (family: FamilyGroup) => {
    const selectedEpics = breakSelectionByFamily[family.key] ?? []
    const newHeadEpic = breakHeadByFamily[family.key] ?? ''
    const headKey = compactLookupValue(newHeadEpic)
    const selectedSet = new Set(selectedEpics.map((epic) => compactLookupValue(epic)))
    const headKeyCompact = compactLookupValue(family.head)

    // family.members is already in display order (head first), so filtering
    // in place keeps the selection in table order.
    const selectedMembers = family.members.filter(
      (member) => selectedSet.has(compactLookupValue(member.epic_no)) && compactLookupValue(member.epic_no) !== headKeyCompact,
    )

    if (!selectedMembers.length) {
      toast.error('Select at least one member to break into a new family.')
      return
    }

    if (!headKey || !selectedMembers.some((member) => compactLookupValue(member.epic_no) === headKey)) {
      toast.error('Select a valid new family head from the chosen members.')
      return
    }

    const now = new Date().toISOString()
    const selectedIds = new Set(selectedMembers.map((member) => member.id))
    const remainingMembers = family.members.filter((member) => !selectedIds.has(member.id))

    // Move every selected member into the new family, headed by the chosen
    // member. The new head itself gets its own epic as family_head_epic
    // (same convention as createNewFamily / removeMemberFromFamily), and the
    // whole group is renumbered 1..n in table order.
    const breakUpdates = selectedMembers.map((member, index) =>
      supabase
        .from('voters')
        .update({
          family_head_epic: newHeadEpic,
          display_order: index + 1,
          family_label: null,
          family_color: null,
          row_color: null,
          updated_at: now,
        })
        .eq('id', member.id),
    )

    // Re-compact display_order of the members left behind in the original
    // family so there are no gaps after the break.
    const remainingNonHeadMembers = remainingMembers.filter(
      (member) => compactLookupValue(member.epic_no) !== headKeyCompact,
    )
    const compactUpdates = remainingNonHeadMembers.map((member, index) =>
      member.display_order === index + 1 ? null : supabase.from('voters').update({ display_order: index + 1 }).eq('id', member.id),
    )

    const results = await Promise.all([
      ...breakUpdates,
      ...compactUpdates.filter((update): update is NonNullable<typeof update> => update != null),
    ])
    const firstError = results.find((result) => result.error)
    if (firstError?.error) {
      toast.error(firstError.error.message)
      return
    }

    setBreakSelectionByFamily((current) => ({ ...current, [family.key]: [] }))
    setBreakHeadByFamily((current) => ({ ...current, [family.key]: '' }))
    // The selected members now form their own family headed by the chosen
    // member, so any of them parked under an Office/Shifted leader must follow
    // that new family's owner.
    const newHead = selectedMembers.find((member) => compactLookupValue(member.epic_no) === headKey)
    await reconcileVoterAssignments(
      selectedMembers.map((member) => member.id),
      newHead?.id ? (voterToLeaderId[newHead.id] ?? '') : '',
      'Family broken',
    )
    toast.success('Family broken. Selected members moved into a new family.')
    closePanel(family.key)
    await reloadAfterMutation(family.key)
  }

  // Merge the source family into another family. Every member of the source
  // family is repointed at the target family's head epic, so the two families
  // become one headed by the target's head. display_order is recompacted
  // across the merged member list and one audit row is written to
  // family_merge_events so the whole operation can be traced.
  const mergeFamilies = async (sourceFamily: FamilyGroup) => {
    const targetEpic = mergeTargetByFamily[sourceFamily.key] ?? ''
    const targetFamily = familyLookupByEpic.get(compactLookupValue(targetEpic))
    if (!targetFamily) {
      toast.error('Select a valid target family to merge into.')
      return
    }
    if (targetFamily.key === sourceFamily.key) {
      toast.error('Cannot merge a family into itself.')
      return
    }

    const targetHeadEpic = targetFamily.head
    const now = new Date().toISOString()
    const sourceMemberIds = sourceFamily.members.map((member) => member.id)
    if (!sourceMemberIds.length) return

    setMergingFamilyKey(sourceFamily.key)
    try {
    // Keep the target family's label; if only the source has a label, move it
    // onto the target head. If both have labels, the target wins.
    const sourceLabel = sourceFamily.headVoter?.family_label ?? null
    const targetLabel = targetFamily.headVoter?.family_label ?? null
    const labelUpdates: Array<PromiseLike<{ error: unknown }>> = []
    if (sourceLabel) {
      if (!targetLabel) {
        labelUpdates.push(
          supabase.from('voters').update({ family_label: sourceLabel }).eq('epic_no', targetHeadEpic).limit(1),
        )
      }
      if (sourceFamily.headVoter?.id) {
        labelUpdates.push(supabase.from('voters').update({ family_label: null }).eq('id', sourceFamily.headVoter.id))
      }
    }

    const memberUpdates = sourceMemberIds.map((id, index) =>
      supabase
        .from('voters')
        .update({
          family_head_epic: targetHeadEpic,
          display_order: targetFamily.members.length + index + 1,
          family_color: null,
          updated_at: now,
        })
        .eq('id', id),
    )

    const results = await Promise.all([...memberUpdates, ...labelUpdates])
    const firstError = results.find((result) => (result as { error?: unknown }).error)
    const firstErrorMessage = firstError ? (firstError as { error?: { message?: string } }).error?.message ?? 'Merge failed.' : null
    if (firstErrorMessage) {
      toast.error(firstErrorMessage)
      return
    }

    // The source family now belongs to the target family, so any source member
    // parked under Office/Shifted must follow the target's owner - otherwise it
    // would keep showing under the parking leader AND inside the merged family.
    await reconcileVoterAssignments(
      sourceMemberIds,
      familyLeaderId(targetFamily),
      `Merged into ${targetFamily.headVoter?.name ?? targetHeadEpic}'s family`,
    )

    const { error: auditError } = await supabase.from('family_merge_events').insert({
      merged_family_key: sourceFamily.head,
      into_family_key: targetHeadEpic,
      merged_voter_ids: sourceMemberIds,
      details: {
        merged_members: sourceFamily.members.map((m) => ({ id: m.id, epic_no: m.epic_no, name: m.name })),
        source_label: sourceLabel,
        target_label: targetLabel,
        target_head: targetHeadEpic,
      },
      merged_by: profile?.id ?? null,
    })
    if (auditError) {
      toast.error(`Family merged, but audit log could not be written: ${auditError.message}`)
    } else {
      toast.success(`Family merged into ${targetFamily.headVoter?.name ?? targetHeadEpic}'s family.`)
    }

    closePanel(sourceFamily.key)
    await reloadAfterMutation(targetFamily.key)
    } finally {
      setMergingFamilyKey(null)
    }
  }

  // Candidates for the "merge into another family" target picker - every
  // family except the source itself, optionally narrowed by a name/EPIC query.
  const mergeTargetCandidatesFor = (family: FamilyGroup): FamilyGroup[] => {
    const query = (mergeQueryByFamily[family.key] ?? '').trim()
    const tokens = tokenizeLookup(query)
    return families
      .filter((candidate) => candidate.key !== family.key)
      .filter((candidate) => {
        if (!tokens.length) return true
        const head = candidate.headVoter ?? candidate.members[0]
        return matchesLookupTokens(`${head?.name ?? ''} ${candidate.head}`, tokens)
      })
  }

  const addMemberToFamily = async (family: FamilyGroup) => {
    const search = (addMemberSearchByFamily[family.key] ?? '').trim()
    if (!search) {
      toast.error('Enter voter name or EPIC to add.')
      return
    }

    const normalizedSearch = compactLookupValue(search)
    const candidateTokens = tokenizeLookup(search)
    const existingFamilyEpics = new Set(family.members.map((member) => compactLookupValue(member.epic_no)))
    const scope = { partFilter, sectionFilter, wardFilter }
    const eligibleRows = rows
      .filter((row) => !existingFamilyEpics.has(compactLookupValue(row.epic_no)))
      .filter((row) => {
        const existingFamily = familyLookupByEpic.get(compactLookupValue(row.epic_no))
        return !existingFamily || existingFamily.members.length <= 1
      })
      .filter((row) => matchesActiveScopeFilters(row, scope))

    const exactEpicMatch = eligibleRows.find((row) => compactLookupValue(row.epic_no) === normalizedSearch)
    const exactLabelMatch = eligibleRows.find((row) => compactLookupValue(formatFamilyCandidateLabel(row)) === normalizedSearch)
    const exactNameMatches = eligibleRows.filter((row) => compactLookupValue(row.name) === normalizedSearch)
    const tokenMatches = eligibleRows.filter((row) => candidateTokens.length > 0 && matchesLookupTokens(buildVoterLookupText(row), candidateTokens))

    let member = exactEpicMatch ?? exactLabelMatch ?? null
    if (!member && exactNameMatches.length === 1) {
      member = exactNameMatches[0]
    }

    if (!member && tokenMatches.length === 1) {
      member = tokenMatches[0]
    }

    if (!member && (addMemberCandidatesByFamily[family.key]?.length ?? 0) === 1) {
      member = addMemberCandidatesByFamily[family.key][0]
    }

    if (!member) {
      if (exactNameMatches.length > 1 || tokenMatches.length > 1 || (addMemberCandidatesByFamily[family.key]?.length ?? 0) > 1) {
        toast.error('Multiple voters match. Pick a specific suggestion with EPIC.')
        return
      }

      // The voter may genuinely not exist, OR they exist but were filtered
      // out of eligibleRows above (already in another family, or outside
      // the active part/section/ward filter). Check the full `rows` list to
      // give a more useful message than a blanket "not found".
      const rawEpicMatch = rows.find((row) => compactLookupValue(row.epic_no) === normalizedSearch)
      const rawNameMatches = rows.filter((row) => compactLookupValue(row.name) === normalizedSearch)
      const rawMatch = rawEpicMatch ?? (rawNameMatches.length === 1 ? rawNameMatches[0] : null)

      if (rawMatch) {
        const existingFamily = familyLookupByEpic.get(compactLookupValue(rawMatch.epic_no))
        if (existingFamily && existingFamily.members.length > 1) {
          const headName = existingFamily.headVoter?.name ?? existingFamily.head
          toast.error(`${rawMatch.name} is already in ${headName}'s family. Remove them from that family first.`)
          return
        }

        if (!matchesActiveScopeFilters(rawMatch, scope)) {
          toast.error(`${rawMatch.name} is outside the current Part/Section/Ward filter. Clear the filter to add them.`)
          return
        }
      }

      toast.error('No voter found for that name or EPIC.')
      return
    }

    // Existing non-head members, in whatever order they're CURRENTLY shown -
    // we preserve that order exactly and leave it untouched. The new member
    // is appended after all of them (position: bottom), not pushed to the
    // top - so "add b, then c, then d" ends up a, b, c, d.
    const existingNonHeadMembers = family.members.filter(
      (existing) => compactLookupValue(existing.epic_no) !== compactLookupValue(family.head),
    )

    const reorderUpdates = existingNonHeadMembers.map((existing, index) =>
      existing.display_order === index + 1
        ? null
        : supabase.from('voters').update({ display_order: index + 1 }).eq('id', existing.id),
    )

    const [{ error }, ...reorderResults] = await Promise.all([
      supabase
        .from('voters')
        .update({
          family_head_epic: family.head,
          family_label: null,
          family_color: null,
          row_color: null,
          display_order: existingNonHeadMembers.length + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', member.id),
      ...reorderUpdates.filter((update): update is NonNullable<typeof update> => update != null),
    ])

    const reorderError = reorderResults.find((result) => result?.error)?.error

    if (error || reorderError) {
      toast.error(error?.message ?? reorderError?.message ?? 'Unable to add member.')
      return
    }

    // Mirror the DB writes locally so the family updates instantly without
    // re-fetching the entire voter table.
    const updatedRows: Voter[] = [
      {
        ...member,
        family_head_epic: family.head,
        family_label: null,
        family_color: null,
        row_color: null,
        display_order: existingNonHeadMembers.length + 1,
        updated_at: new Date().toISOString(),
      },
      ...existingNonHeadMembers
        .map((existing, index): Voter | null => (existing.display_order === index + 1 ? null : { ...existing, display_order: index + 1 }))
        .filter((row): row is Voter => row != null),
    ]

    setAddMemberSearchByFamily((current) => ({ ...current, [family.key]: '' }))
    toast.success('Member added to family.')
    // The member now belongs to this family, so if they were parked under an
    // Office/Shifted leader they must follow the family's owner - otherwise the
    // voter would appear under the parking leader AND inside the new family.
    await reconcileVoterAssignments([member.id], familyLeaderId(family), `Member added to ${family.headVoter?.name ?? family.head}'s family`)
    // Adding a member changes which family the voter belongs to, so cached
    // team-leader pages must be invalidated here (there is no full reload).
    clearTeamLeaderDetailCache()
    clearTeamLeadersListCache()
    clearUnassignedDataCache()
    // Intentionally NOT closing the panel here - keep the "manage family"
    // search bar open so multiple members can be added back-to-back
    // without having to reopen the panel each time. The panel is closed
    // only via the explicit "Close" button.
    applyLocalRowUpdates(updatedRows)
  }

  const setMemberRowColor = async (family: FamilyGroup, memberEpic: string, color: RowColorKey | null) => {
    const member = family.members.find((item) => item.epic_no === memberEpic)
    if (!member) {
      toast.error('Select a valid member first.')
      return
    }

    const { error } = await supabase.from('voters').update({ row_color: color }).eq('id', member.id)
    if (error) {
      toast.error(error.message)
      return
    }

    toast.success(color ? 'Row color updated.' : 'Row color cleared.')
    await reloadAfterMutation(family.key)
  }

  const invalidateVoterCaches = () => {
    clearCachedCollection('vote:voters:all-cache')
    try {
      window.localStorage.removeItem(FAMILY_WARM_CACHE_KEY)
    } catch {
      // Ignore storage failures.
    }
  }

  const setMemberCategory = async (family: FamilyGroup, memberEpic: string, category: Voter['voter_category'] | null) => {
    const member = family.members.find((item) => item.epic_no === memberEpic)
    if (!member) {
      toast.error('Select a valid member first.')
      return
    }

    const { error } = await supabase.from('voters').update({ voter_category: category }).eq('id', member.id)
    if (error) {
      toast.error(error.message)
      return
    }

    invalidateVoterCaches()
    // Reflect the change in-memory (and in the caches) instead of re-pulling
    // the entire voter table - the category picker updates instantly this
    // way, and the DB is already consistent.
    if (rows.length) {
      applyLocalRowUpdates([{ ...member, voter_category: category }])
    } else {
      await reloadAfterMutation(family.key)
    }
    toast.success(category ? 'Category updated.' : 'Category cleared.')
  }

  const assignCategoryToFamily = async (family: FamilyGroup, category: Voter['voter_category'] | null) => {
    const memberIds = family.members.map((member) => member.id)
    if (!memberIds.length) {
      toast.error('This family has no members.')
      return
    }

    try {
      await forEachInChunk(memberIds, async (chunk) => {
        const { error } = await supabase.from('voters').update({ voter_category: category }).in('id', chunk)
        if (error) throw new Error(error.message)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update category.')
      return
    }

    invalidateVoterCaches()
    // Reflect the change in-memory (and in the caches) instead of re-pulling
    // the entire voter table - the whole family's category updates instantly
    // this way, and the DB is already consistent.
    if (rows.length) {
      applyLocalRowUpdates(family.members.map((row) => ({ ...row, voter_category: category })))
    } else {
      await reloadAfterMutation(family.key)
    }
    toast.success(category ? `Category assigned to ${memberIds.length} member${memberIds.length === 1 ? '' : 's'}.` : 'Category cleared for all family members.')
  }

  const persistPresence = async (members: Voter[], status: PresenceStatus | null, note: string, silent = false) => {
    if (!members.length) {
      if (!silent) toast.error('This family has no members.')
      return false
    }
    const trimmedNote = status ? note.trim() : ''
    const patch = { presence_status: status, presence_note: trimmedNote || null }
    const updates: Voter[] = []
    try {
      for (const member of members) {
        const { error } = await supabase.from('voters').update(patch).eq('id', member.id)
        if (error) throw new Error(error.message)
        updates.push({ ...member, ...patch })
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update presence.')
      return false
    }
    invalidateVoterCaches()
    if (rows.length) {
      applyLocalRowUpdates(updates)
    }
    if (!silent) toast.success(status ? `Presence set to ${presenceLabel(status)}.` : 'Presence cleared.')
    return true
  }

  const assignPresenceToFamily = async (family: FamilyGroup, status: PresenceStatus | null, note: string, silent = false) => {
    const headId = family.headVoter?.id ?? family.members[0]?.id
    if (!headId) {
      if (!silent) toast.error('This family has no members.')
      return
    }
    setSavingPresenceKey(family.key)
    const targets = family.members.filter((member) => member.id === headId || !hasPresenceOverride(member, family.headVoter))
    const ok = await persistPresence(targets, status, note, silent)
    if (ok && !rows.length) await reloadAfterMutation(family.key)
    setSavingPresenceKey(null)
  }

  const assignPresenceToMember = async (member: Voter, family: FamilyGroup, status: PresenceStatus | null, note: string, silent = false) => {
    setSavingPresenceKey(member.id)
    const ok = await persistPresence([member], status, note, silent)
    if (ok && !rows.length) await reloadAfterMutation(family.key)
    setSavingPresenceKey(null)
  }

  const reorderFamilyMember = async (family: FamilyGroup, fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return

    const members = [...family.members]
    const item = members[fromIndex]
    members.splice(fromIndex, 1)
    members.splice(toIndex, 0, item)

    const results = await Promise.all(
      members.map((member, index) =>
        supabase.from('voters').update({ display_order: index + 1 }).eq('id', member.id),
      ),
    )

    const firstError = results.find((r) => r.error)
    if (firstError?.error) {
      toast.error(firstError.error.message)
      return
    }

    await reloadAfterMutation(family.key)
  }

  const reportSourceFamilies = useMemo(() => {
    const base = reportSelectionMode === 'all'
      ? families
      : reportSelectionMode === 'selected'
        ? families.filter((f) => selectedFamilyKeys.has(f.key))
        : filteredFamilies
    return genderScopedFamilies(base)
  }, [reportSelectionMode, families, filteredFamilies, genderScopedFamilies, selectedFamilyKeys])

  const groupedReportFamilies = useMemo(() => {
    const groups = new Map<string, FamilyGroup[]>()
    for (const family of reportSourceFamilies) {
      const groupKey = reportGroupBy === 'none' ? '' : familyGroupKey(family, reportGroupBy)
      const list = groups.get(groupKey)
      if (list) {
        list.push(family)
      } else {
        groups.set(groupKey, [family])
      }
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [reportGroupBy, reportSourceFamilies])

  const selectedReportKeys = useMemo(() => {
    const activeKeys = REPORT_FIELD_OPTIONS.filter((option) => reportFields[option.key]).map((option) => option.key)
    const ordered = reportFieldOrder.filter((key) => activeKeys.includes(key))
    for (const key of activeKeys) {
      if (!ordered.includes(key)) ordered.push(key)
    }
    return ordered
  }, [reportFieldOrder, reportFields])

  const resolvePhotoUrl = (voter: Voter | null | undefined): string => {
    if (!voter?.photo_url) {
      return ''
    }
    return photoUrlByPath[voter.photo_url] ?? ''
  }

  const handleExportExcel = (style?: PrintStyleOptions) => {
    if (!selectedReportKeys.length) {
      toast.error('Select at least one field to export.')
      return
    }

    const headerLabels = selectedReportKeys.map((key) => REPORT_FIELD_OPTIONS.find((option) => option.key === key)!.label)

    // Builds the data rows (heads-only or detailed, per the current layout)
    // for one set of families - shared by every sheet-building path below so
    // the row logic never drifts between the single-sheet and split-sheet
    // outputs.
    const buildGroupRows = (groupFamilies: FamilyGroup[]): string[][] => {
      const rows: string[][] = []

      if (reportLayout === 'headsOnly') {
        let sr = 1
        for (const family of groupFamilies) {
          const head = familyRepresentative(family)
          if (!head) {
            continue
          }
          const photoUrl = resolvePhotoUrl(head)
          rows.push(selectedReportKeys.map((key) => (key === 'srNo' ? String(sr) : fieldValueForMember(head, family, key, photoUrl))))
          sr += 1
        }
      } else {
        let sr = 1
        for (const family of groupFamilies) {
          for (const member of family.members) {
            const photoUrl = resolvePhotoUrl(member)
            rows.push(selectedReportKeys.map((key) => (key === 'srNo' ? String(sr) : fieldValueForMember(member, family, key, photoUrl))))
            sr += 1
          }
          rows.push([])
        }
      }

      return rows
    }

    const groupMemberCount = (groupFamilies: FamilyGroup[]) => groupFamilies.reduce((sum, family) => sum + family.members.length, 0)

    const photoWidth = reportPhotoSize === 'jumbo' ? 65 : reportPhotoSize === 'xlarge' ? 55 : reportPhotoSize === 'large' ? 42 : reportPhotoSize === 'medium' ? 35 : 28
    const columnWidths = selectedReportKeys.map((key) => ({ wch: key === 'photo' ? photoWidth : key === 'name' ? 28 : 16 }))

    const totalFamiliesCount = reportSourceFamilies.length
    const totalMembersCount = reportSourceFamilies.reduce((sum, family) => sum + family.members.length, 0)

    const workbookSheets: ExcelWorkbookSheet[] = []

    // --- Summary sheet: always first, gives an at-a-glance overview of the
    // grand total plus a per-group breakdown (when grouping is active) -
    // without it, checking counts meant manually scrolling/counting rows. ---
    const summaryRows: string[][] = [
      ['Families Report Summary'],
      [],
      ['Total Families', String(totalFamiliesCount)],
      ['Total Members', String(totalMembersCount)],
    ]
    if (reportGroupBy !== 'none') {
      summaryRows.push([])
      summaryRows.push(['Group', 'Families', 'Members'])
      for (const [groupKey, groupFamilies] of groupedReportFamilies) {
        summaryRows.push([groupKey || '(Unspecified)', String(groupFamilies.length), String(groupMemberCount(groupFamilies))])
      }
    }
    workbookSheets.push({ name: 'Summary', rows: summaryRows, colWidths: [{ wch: 30 }, { wch: 14 }, { wch: 14 }] })

    // Excel sheet names: max 31 chars, and can't contain \ / ? * [ ] : or be
    // duplicated (case-insensitively). Sanitize + de-duplicate every group
    // label before using it as a sheet name.
    const usedSheetNames = new Set<string>(['summary'])
    const uniqueSheetName = (name: string) => {
      const sanitized = name.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Group'
      let candidate = sanitized
      let counter = 2
      while (usedSheetNames.has(candidate.toLowerCase())) {
        candidate = `${sanitized} (${counter})`.slice(0, 31)
        counter += 1
      }
      usedSheetNames.add(candidate.toLowerCase())
      return candidate
    }

    const useSplitSheets = reportSplitSheets && reportGroupBy !== 'none' && groupedReportFamilies.length > 1

    if (useSplitSheets) {
      // One sheet per group (e.g. per religion, per state, per section) -
      // each with its own totals line and header row.
      for (const [groupKey, groupFamilies] of groupedReportFamilies) {
        const label = groupKey || '(Unspecified)'
        const sheetRows: string[][] = [
          [label],
          [`Total Families: ${groupFamilies.length}`, `Total Members: ${groupMemberCount(groupFamilies)}`],
          [],
          headerLabels,
          ...buildGroupRows(groupFamilies),
        ]

        workbookSheets.push({ name: uniqueSheetName(label), rows: sheetRows, colWidths: columnWidths })
      }
    } else {
      // Single sheet, all groups stacked - same as before, but now with an
      // overall totals line up top and a families/members subtotal under
      // every group heading.
      const sheetRows: string[][] = [[`Total Families: ${totalFamiliesCount}`, `Total Members: ${totalMembersCount}`], []]

      for (const [groupKey, groupFamilies] of groupedReportFamilies) {
        if (groupKey) {
          sheetRows.push([groupKey])
          sheetRows.push([`Families: ${groupFamilies.length}`, `Members: ${groupMemberCount(groupFamilies)}`])
        }
        sheetRows.push(headerLabels)
        sheetRows.push(...buildGroupRows(groupFamilies))
        sheetRows.push([])
      }

      workbookSheets.push({ name: 'Families', rows: sheetRows, colWidths: columnWidths })
    }

    void exportWorkbookToExcel(workbookSheets, `families-export-${new Date().toISOString().slice(0, 10)}.xlsx`, style)

    toast.success('Excel file exported.')
    setShowExportModal(false)
  }

  // States that get their own named bucket in the family-wise report. Any
  // family whose head has a non-blank `state` that ISN'T in this list falls
  // into the generic "OTHER STATE" bucket instead. Edit this list to change
  // which migrant-origin states get broken out individually.
  const NAMED_MIGRANT_STATES = ['Karnataka', 'Uttar Pradesh', 'Maharashtra', 'Kerala', 'Tamil Nadu', 'West Bengal', 'Bihar', 'Rajasthan']

  type FamilyBucketKind = 'religion' | 'namedState' | 'otherState' | 'single'

  // Single-pass classification (state/religion/single are mutually
  // exclusive - unlike the old export, a family now lands in exactly ONE
  // bucket, never two). Priority, based on the family HEAD only:
  //   1. Family has only one member -> SINGLE, always, regardless of
  //      religion/state.
  //   2. Head's `state` is blank -> treated as local -> bucket by religion.
  //   3. Head's `state` is set -> bucket by state: a named bucket if it
  //      matches NAMED_MIGRANT_STATES, otherwise OTHER STATE.
  const classifyFamilyBucket = (family: FamilyGroup): { kind: FamilyBucketKind; label: string } => {
    if (family.members.length <= 1) {
      return { kind: 'single', label: 'SINGLE VOTERS COMBINED' }
    }

    const stateRaw = (family.headVoter?.state ?? '').trim()
    if (!stateRaw) {
      const religion = (family.headVoter?.religion ?? '').trim()
      return { kind: 'religion', label: religion ? religion.toUpperCase() : '(UNSPECIFIED)' }
    }

    const normalizedState = stateRaw.toLowerCase() === 'up' ? 'Uttar Pradesh' : stateRaw
    const namedMatch = NAMED_MIGRANT_STATES.find((state) => state.toLowerCase() === normalizedState.toLowerCase())
    if (namedMatch) {
      return { kind: 'namedState', label: namedMatch.toUpperCase() }
    }

    return { kind: 'otherState', label: 'OTHER STATE' }
  }

  // Family-wise Excel report: scoped to whatever Part + Section (+ Ward, if
  // set) is currently selected on the page - NOT the general
  // reportSelectionMode/reportGroupBy machinery. Produces a single sheet
  // for that Part/Section, with families stacked in blocks: religion
  // buckets first (alphabetical), then named-state buckets (in
  // NAMED_MIGRANT_STATES order), then OTHER STATE, then SINGLE last. Any
  // bucket with zero families for this Part/Section is skipped entirely.
  const handleExportFamilyWiseReport = (style?: PrintStyleOptions) => {
    if (!selectedReportKeys.length) {
      toast.error('Select at least one field to export.')
      return
    }

    if (partFilter === 'all' || sectionFilter === 'all') {
      toast.error('Select a specific Part and Section on the page first, then generate the family-wise report.')
      return
    }

    const scopedFamilies = families.filter((family) => {
      const head = family.headVoter
      if (String(head?.part_no ?? '') !== partFilter) return false
      if (String(head?.section ?? '') !== sectionFilter) return false
      if (wardFilter !== 'all' && String(head?.ward_no ?? '') !== wardFilter) return false
      return true
    })

    const headerLabels = selectedReportKeys.map((key) => REPORT_FIELD_OPTIONS.find((option) => option.key === key)!.label)

    const buildRows = (groupFamilies: FamilyGroup[]): string[][] => {
      const rows: string[][] = []

      if (reportLayout === 'headsOnly') {
        let sr = 1
        for (const family of groupFamilies) {
          const head = familyRepresentative(family)
          if (!head) {
            continue
          }
          const photoUrl = resolvePhotoUrl(head)
          rows.push(selectedReportKeys.map((key) => (key === 'srNo' ? String(sr) : fieldValueForMember(head, family, key, photoUrl))))
          sr += 1
        }
      } else {
        let sr = 1
        for (const family of groupFamilies) {
          for (const member of family.members) {
            const photoUrl = resolvePhotoUrl(member)
            rows.push(selectedReportKeys.map((key) => (key === 'srNo' ? String(sr) : fieldValueForMember(member, family, key, photoUrl))))
            sr += 1
          }
          rows.push([])
        }
      }

      return rows
    }

    const memberCount = (list: FamilyGroup[]) => list.reduce((sum, family) => sum + family.members.length, 0)

    const photoWidth = reportPhotoSize === 'jumbo' ? 65 : reportPhotoSize === 'xlarge' ? 55 : reportPhotoSize === 'large' ? 42 : reportPhotoSize === 'medium' ? 35 : 28
    const columnWidths = selectedReportKeys.map((key) => ({ wch: key === 'photo' ? photoWidth : key === 'name' ? 28 : 16 }))

    // Classify every scoped family into exactly one bucket.
    interface Bucket {
      key: string
      kind: FamilyBucketKind
      label: string
      families: FamilyGroup[]
    }
    const bucketMap = new Map<string, Bucket>()
    for (const family of scopedFamilies) {
      const { kind, label } = classifyFamilyBucket(family)
      const key = `${kind}:${label}`
      const bucket = bucketMap.get(key)
      if (bucket) {
        bucket.families.push(family)
      } else {
        bucketMap.set(key, { key, kind, label, families: [family] })
      }
    }

    // Order: religion buckets (alphabetical) -> named-state buckets (in
    // NAMED_MIGRANT_STATES order) -> OTHER STATE -> SINGLE. Buckets with no
    // families simply aren't in bucketMap, so they're skipped automatically.
    const FAMILY_WISE_BUCKET_ORDER = [
      'HINDU',
      'KARNATAKA',
      'UTTAR PRADESH',
      'OTHER STATE',
      'CATHOLIC',
      'MUSLIM',
      'SINGLE VOTERS COMBINED',
    ]

    const bucketByLabel = new Map<string, Bucket>()
    for (const bucket of bucketMap.values()) {
      bucketByLabel.set(bucket.label, bucket)
    }

    const orderedBuckets: Bucket[] = []
    const addedLabels = new Set<string>()
    for (const label of FAMILY_WISE_BUCKET_ORDER) {
      const bucket = bucketByLabel.get(label)
      if (bucket) {
        orderedBuckets.push(bucket)
        addedLabels.add(label)
      }
    }

    for (const bucket of bucketMap.values()) {
      if (!addedLabels.has(bucket.label)) {
        orderedBuckets.push(bucket)
      }
    }

    const partSectionLabel = `Part ${partFilter} - Section ${sectionFilter}`

    const sheetRows: string[][] = []
    for (const bucket of orderedBuckets) {
      // Row data is gender-scoped (when a gender filter is active) so only
      // members of the selected gender are written, while the bucket
      // classification itself stays based on the full family.
      const rowsFamilies = genderScopedFamilies(bucket.families)
      sheetRows.push([`${partSectionLabel} - ${bucket.label}`])
      sheetRows.push(headerLabels)
      sheetRows.push(...buildRows(rowsFamilies))
      sheetRows.push([`Total Families: ${rowsFamilies.length}`, `Total Members: ${memberCount(rowsFamilies)}`])
      sheetRows.push([])
    }

    // Excel sheet names: max 31 chars, no \ / ? * [ ] :
    const sheetName = `Part ${partFilter} Section ${sectionFilter}`.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet1'
    void exportWorkbookToExcel(
      [{ name: sheetName, rows: sheetRows, colWidths: columnWidths }],
      `family-wise-report-part${partFilter}-section${sectionFilter}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      style,
    )

    setShowExportModal(false)
  }

  const handlePrint = (style: PrintStyleOptions) => {
    if (!selectedReportKeys.length) {
      toast.error('Select at least one field to print.')
      return
    }

    const fontSize = style.fontSize
    const bold = style.boldText

    const headerLabels = selectedReportKeys.map((key) => REPORT_FIELD_OPTIONS.find((option) => option.key === key)!.label)

    const escapeHtml = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

    const basePhoto = reportPhotoSize === 'jumbo' ? 110 : reportPhotoSize === 'xlarge' ? 90 : reportPhotoSize === 'large' ? 60 : reportPhotoSize === 'medium' ? 40 : 30
    const photoSizePx = `${Math.round(basePhoto * (fontSize / 11))}px`
    const pageWidth = reportPaperSize === 'a4' ? '210mm' : '215.9mm'
    const pageHeight = reportPaperSize === 'a4' ? '297mm' : '279.4mm'
    const pageSizeStyle = reportOrientation === 'landscape' ? `${pageHeight} ${pageWidth}` : `${pageWidth} ${pageHeight}`
    const bodyClass = reportPrintMode === 'booklet' ? 'booklet-mode' : ''

    const totalFamiliesCount = reportSourceFamilies.length
    const totalMembersCount = reportSourceFamilies.reduce((sum, family) => sum + family.members.length, 0)

    const renderHeader = () => {
      return `
        <div class="print-header">
          <h1>Families Report</h1>
          ${reportHeaderConstituency ? `<div class="constituency">${escapeHtml(reportHeaderConstituency)}</div>` : ''}
          ${
            showPartSectionHeader && reportSelectionMode === 'filtered' && activePartSectionLabel
              ? `<div class="part-section-banner">${escapeHtml(activePartSectionLabel)}</div>`
              : ''
          }
          ${
            reportShowTally
              ? `<div class="tally">Total Families: <strong>${totalFamiliesCount}</strong> &nbsp;&nbsp; Total Members: <strong>${totalMembersCount}</strong></div>`
              : ''
          }
          <div class="meta">
            ${reportLayout === 'headsOnly' ? 'Family heads only' : 'Detailed - family head and members'}
            ${reportGroupBy !== 'none' ? ` &middot; Grouped by ${reportGroupBy}` : ''}
            ${reportPrintMode === 'booklet' ? ' &middot; Booklet / voter slip mode' : ''}
            &middot; Date: ${escapeHtml(reportHeaderDate)}
            &middot; Generated ${new Date().toLocaleString()}
          </div>
          ${reportHeaderSignature ? '<div class="signature-line">Verified by: ________________________ &nbsp;&nbsp; Date: ________</div>' : ''}
        </div>`
    }

    const renderFamilyBooklet = (family: FamilyGroup): string => {
      let html = '<div class="family-card">'
      html += `<h3 class="card-title">${escapeHtml(family.headVoter?.name ?? family.head)}</h3>`
      html += '<table class="booklet-table">'
      html += `<thead><tr>${headerLabels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>`

      let sr = 1
      for (const member of family.members) {
        const photoUrl = resolvePhotoUrl(member)
        const isHead = compactLookupValue(member.epic_no) === compactLookupValue(family.head)
        const cells = selectedReportKeys
          .map((key) => {
            if (key === 'srNo') return `<td>${sr}</td>`
            if (key === 'photo') return `<td>${photoUrl ? `<img class="photo" src="${photoUrl}" />` : ''}</td>`
            return `<td>${escapeHtml(fieldValueForMember(member, family, key, photoUrl))}</td>`
          })
          .join('')
        html += `<tr class="${isHead ? 'head-row' : ''}">${cells}</tr>`
        sr += 1
      }
      html += '</tbody></table></div>'
      return html
    }

    const renderRow = (member: Voter, family: FamilyGroup, sr: number, isHead: boolean) => {
      const photoUrl = resolvePhotoUrl(member)
      const cells = selectedReportKeys
        .map((key) => {
          if (key === 'srNo') return `<td>${sr}</td>`
          if (key === 'photo') return `<td>${photoUrl ? `<img class="photo" src="${photoUrl}" />` : ''}</td>`
          return `<td>${escapeHtml(fieldValueForMember(member, family, key, photoUrl))}</td>`
        })
        .join('')
      return `<tr class="${isHead ? 'head-row' : ''}">${cells}</tr>`
    }

    let bodyHtml = ''

    if (reportPrintMode === 'booklet') {
      for (const [groupKey, groupFamilies] of groupedReportFamilies) {
        if (groupKey) {
          bodyHtml += `<h2 class="group-title">${escapeHtml(groupKey)}</h2>`
        }
        for (const family of groupFamilies) {
          bodyHtml += renderFamilyBooklet(family)
        }
      }
    } else {
      for (const [groupKey, groupFamilies] of groupedReportFamilies) {
        if (groupKey) {
          bodyHtml += `<h2 class="group-title">${escapeHtml(groupKey)}</h2>`
        }
        bodyHtml += `<table><thead><tr>${headerLabels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>`

        if (reportLayout === 'headsOnly') {
          let sr = 1
          for (const family of groupFamilies) {
            const head = familyRepresentative(family)
            if (!head) continue
            bodyHtml += renderRow(head, family, sr, true)
            sr += 1
          }
        } else {
          let sr = 1
          for (const [familyIndex, family] of groupFamilies.entries()) {
            for (const member of family.members) {
              const isHead = compactLookupValue(member.epic_no) === compactLookupValue(family.head)
              bodyHtml += renderRow(member, family, sr, isHead)
              sr += 1
            }
            if (familyIndex < groupFamilies.length - 1) {
              bodyHtml += `<tr class="family-spacer"><td colspan="${headerLabels.length}"></td></tr>`
            }
          }
        }

        bodyHtml += '</tbody></table>'
      }
    }

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Families Report</title>
<style>
  @page { size: ${pageSizeStyle}; margin: 15mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; padding: 16px; }
  .print-header { margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid #333; }
  .print-header h1 { font-size: 20px; margin: 0 0 4px; }
  .constituency { font-size: 14px; font-weight: 600; color: #444; margin-bottom: 4px; }
  .part-section-banner { font-size: 15px; font-weight: 700; letter-spacing: 0.02em; color: #111; padding: 6px 0; border-top: 1px solid #999; border-bottom: 1px solid #999; margin-bottom: 8px; text-align: center; }
  .tally { font-size: 13px; font-weight: 600; color: #222; margin-bottom: 8px; }
  .meta { font-size: 12px; color: #555; margin-bottom: 8px; }
  .signature-line { font-size: 13px; color: #333; margin-top: 8px; padding-top: 12px; border-top: 1px dashed #999; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .group-title { font-size: 15px; margin: 24px 0 8px; border-bottom: 2px solid #333; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: ${fontSize}px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: middle; }
  tbody tr:not(.family-spacer) { height: calc(${photoSizePx} + 10px); }
  th { background: #f0f0f0; }
  ${bold ? 'th, td { font-weight: 700; }' : ''}
  .head-row { background: #f6f6f6; font-weight: 700; }
  .family-spacer td { border: none !important; padding: 0; height: 14px; background: #fff; }
  .photo { width: ${photoSizePx}; height: ${photoSizePx}; object-fit: cover; border-radius: 50%; }
  .family-card { border: 1px solid #ccc; padding: 16px; margin-bottom: 16px; border-radius: 8px; page-break-inside: avoid; }
  .family-card .card-title { font-size: 16px; margin: 0 0 8px; }
  .booklet-table { font-size: ${Math.max(fontSize, 12)}px; }
  @media print {
    ${reportPrintMode === 'booklet' ? '.family-card { page-break-after: always; }' : ''}
    tr { break-inside: avoid; }
    .group-title { break-after: avoid; }
  }
</style>
</head>
<body class="${bodyClass}">
  ${renderHeader()}
  ${bodyHtml}
</body>
</html>`

    const printWindow = window.open('', '_blank')
    if (!printWindow) {
      toast.error('Popup blocked. Please allow popups for this site to print.')
      return
    }

    printWindow.document.write(html)
    printWindow.document.close()
    printWindow.focus()
    setTimeout(() => printWindow.print(), 350)
    setShowPrintModal(false)
  }

  return (
    <div className="space-y-4 pb-6">
      <PageHeader
        title="Families"
        description="Individual family tables with row colours, member management, and family-head reassignment."
      />

      <section className="rounded-xl border border-line bg-white p-4 shadow-soft md:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="h-10 min-w-[240px] flex-1 rounded-lg border border-line bg-muted/40 px-3 text-sm outline-none ring-0 transition focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-200"
            placeholder="Search families by name, EPIC, ward, part, house"
            aria-label="Search families"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            onClick={() => setFilterSheetOpen(true)}
            className="relative flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-line px-3 text-sm font-medium text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100 md:hidden"
          >
            <SlidersHorizontal className="h-4 w-4" />
            <span>Filter</span>
            {activeFilterCount > 0 ? (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1 text-[11px] font-bold text-white">
                {activeFilterCount}
              </span>
            ) : null}
          </button>
          <select
            className="hidden h-10 w-40 shrink-0 rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100 md:block"
            value={partFilter}
            aria-label="Filter families by part"
            title="Filter families by part"
            onChange={(event) => setPartFilter(event.target.value)}
          >
            <option value="all">All Parts</option>
            {partOptions.map((part) => (
              <option key={part} value={String(part)}>
                Part {part}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            className="relative hidden md:inline-flex"
            onClick={() => setDesktopFiltersOpen((open) => !open)}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
            {activeFilterCount > 0 ? (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1 text-[11px] font-bold text-white">
                {activeFilterCount}
              </span>
            ) : null}
          </Button>
          {desktopFiltersOpen ? (
            <div className="hidden w-full flex-wrap items-center gap-2 md:flex">
          <select
            className="h-10 w-40 shrink-0 rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
            value={sectionFilter}
            aria-label="Filter families by section (applies to family head only)"
            title={partFilter === 'all' ? 'Select a part first to filter by section' : 'Filter families by section (matches the family head only)'}
            disabled={partFilter === 'all'}
            onChange={(event) => setSectionFilter(event.target.value)}
          >
            <option value="all">{partFilter === 'all' ? 'All Sections (pick a part)' : 'All Sections'}</option>
            {sectionOptions.map((section) => (
              <option key={section} value={String(section)}>
                Section {section}
              </option>
            ))}
          </select>
          <select
            className="h-10 w-40 shrink-0 rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
            value={wardFilter}
            aria-label="Filter families by ward"
            title="Filter families by ward"
            onChange={(event) => setWardFilter(event.target.value)}
          >
            <option value="all">All Wards</option>
            {wardOptions.map((ward) => (
              <option key={ward} value={String(ward)}>
                Ward {ward}
              </option>
            ))}
          </select>
          <select
            className="h-10 w-48 shrink-0 rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
            value={assignmentFilter}
            aria-label="Filter families by assignment"
            title="Filter families by assignment"
            onChange={(event) => setAssignmentFilter(event.target.value as typeof assignmentFilter)}
          >
            <option value="all">All assignments ({familyFilterCounts.families})</option>
            <option value="assigned">Assigned ({familyFilterCounts.assigned})</option>
            <option value="unassigned">Unassigned ({familyFilterCounts.unassigned})</option>
            <option value="shifted">Shifted ({familyFilterCounts.shifted})</option>
            <option value="single">Single ({familyFilterCounts.single})</option>
          </select>
          <select
            className="h-10 w-48 shrink-0 rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
            value={categoryFilter}
            aria-label="Filter families by category"
            title="Filter families by category"
            onChange={(event) => setCategoryFilter(event.target.value)}
          >
            <option value="all">All categories ({familyFilterCounts.families})</option>
            <option value="unassigned">Unassigned category ({familyFilterCounts.noCategory})</option>
            {VOTER_CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} ({familyFilterCounts.byCategory[option.value] ?? 0})
              </option>
            ))}
          </select>
          {partFilter !== 'all' ? (
            <select
              className="h-10 w-40 shrink-0 rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              value={religionFilter}
              aria-label="Filter families by religion (family head only)"
              title="Filter families by religion (matches the family head only)"
              onChange={(event) => setReligionFilter(event.target.value)}
            >
              <option value="all">All Religions</option>
              {religionOptions.map((religion) => (
                <option key={religion} value={religion}>
                  {religion}
                </option>
              ))}
            </select>
          ) : null}
          {partFilter !== 'all' ? (
            <select
              className="h-10 w-40 shrink-0 rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              value={stateFilter}
              aria-label="Filter families by state (family head only)"
              title="Filter families by state (matches the family head only)"
              onChange={(event) => setStateFilter(event.target.value)}
            >
              <option value="all">All States</option>
              {stateOptions.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          ) : null}
          {partFilter !== 'all' ? (
            <select
              className="h-10 w-40 shrink-0 rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              value={genderFilter}
              aria-label="Filter families by gender (family head only)"
              title="Filter families by gender (matches the family head only)"
              onChange={(event) => setGenderFilter(event.target.value as 'all' | 'male' | 'female')}
            >
              <option value="all">All Genders</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          ) : null}
          <div className="relative shrink-0">
            <button
              type="button"
              className="flex h-11 w-40 items-center justify-between rounded-xl border border-line bg-white px-3 text-left text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              aria-label="Filter by family size"
              onClick={() => setSizeFilterOpen((current) => !current)}
            >
              <span className={sizeFilterValues.length ? 'text-ink' : 'text-ink-tertiary'}>
                {sizeFilterValues.length
                  ? `Size: ${[...sizeFilterValues].sort().join(', ')}`
                  : 'Any Family Size'}
              </span>
              <span className="ml-2 text-ink-tertiary">▾</span>
            </button>

            {sizeFilterOpen ? (
              <div className="absolute z-20 mt-2 w-64 rounded-xl border border-line bg-white p-3 shadow-lg">
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                  Select one or more sizes
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {FAMILY_SIZE_BUCKET_OPTIONS.map((bucket) => {
                    const checked = sizeFilterValues.includes(bucket)
                    return (
                      <label
                        key={bucket}
                        className={`flex h-9 cursor-pointer items-center justify-center rounded-xl border text-sm font-medium transition ${
                          checked ? 'border-brand-400 bg-brand-50 text-brand-700' : 'border-line text-ink-secondary hover:bg-muted'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={checked}
                          onChange={() =>
                            setSizeFilterValues((current) =>
                              current.includes(bucket) ? current.filter((value) => value !== bucket) : [...current, bucket],
                            )
                          }
                        />
                        {bucket === '1' ? 'Single' : bucket}
                      </label>
                    )
                  })}
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <button
                    type="button"
                    className="text-xs font-semibold text-ink-tertiary hover:text-ink-secondary"
                    onClick={() => setSizeFilterValues([])}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                     className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
                    onClick={() => setSizeFilterOpen(false)}
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : null}
          </div>
            </div>
          ) : null}
        </div>

        {activeFilterCount > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5 md:hidden">
            {partFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setPartFilter('all')}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-brand-50 px-2.5 text-xs font-medium text-brand-700"
              >
                Part {partFilter}
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {wardFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setWardFilter('all')}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-brand-50 px-2.5 text-xs font-medium text-brand-700"
              >
                Ward {wardFilter}
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {sectionFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setSectionFilter('all')}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-brand-50 px-2.5 text-xs font-medium text-brand-700"
              >
                Section {sectionFilter}
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {religionFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setReligionFilter('all')}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-brand-50 px-2.5 text-xs font-medium text-brand-700"
              >
                {religionFilter}
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {stateFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setStateFilter('all')}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-brand-50 px-2.5 text-xs font-medium text-brand-700"
              >
                {stateFilter}
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {genderFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setGenderFilter('all')}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-brand-50 px-2.5 text-xs font-medium text-brand-700"
              >
                {genderFilter === 'male' ? 'Male' : 'Female'}
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {sizeFilterValues.map((bucket) => (
              <button
                key={bucket}
                type="button"
                onClick={() => setSizeFilterValues((current) => current.filter((value) => value !== bucket))}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-brand-50 px-2.5 text-xs font-medium text-brand-700"
              >
                Size {bucket === '1' ? 'Single' : bucket}
                <X className="h-3.5 w-3.5" />
              </button>
            ))}
            {assignmentFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setAssignmentFilter('all')}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-brand-50 px-2.5 text-xs font-medium text-brand-700"
              >
                {assignmentFilter === 'assigned' ? 'Assigned' : assignmentFilter === 'unassigned' ? 'Unassigned' : assignmentFilter === 'shifted' ? 'Shifted' : 'Single'}
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {categoryFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setCategoryFilter('all')}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-brand-50 px-2.5 text-xs font-medium text-brand-700"
              >
                {categoryFilter === 'unassigned' ? 'Unassigned category' : (voterCategoryLabel(categoryFilter as Voter['voter_category']) ?? categoryFilter)}
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2 text-xs text-ink-secondary">
          <span className="rounded-full border border-line bg-white px-2.5 py-1 font-semibold text-ink">
            {partFilter === 'all' ? 'All parts' : `Part ${partFilter}`} · {familyFilterCounts.families} families · {familyFilterCounts.voters} voters
          </span>
          <span className="rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 font-medium text-blue-700">Assigned {familyFilterCounts.assigned}</span>
          <span className="rounded-full border border-rose-100 bg-rose-50 px-2.5 py-1 font-medium text-rose-700">Unassigned {familyFilterCounts.unassigned}</span>
          <span className="rounded-full border border-amber-100 bg-amber-50 px-2.5 py-1 font-medium text-amber-700">Shifted {familyFilterCounts.shifted}</span>
          <span className="rounded-full border border-violet-100 bg-violet-50 px-2.5 py-1 font-medium text-violet-700">Single {familyFilterCounts.single}</span>
          <span className="rounded-full border border-line bg-muted px-2.5 py-1 font-medium text-ink-secondary">No category {familyFilterCounts.noCategory}</span>
        </div>

        {isAdminAreaAllowed && leaderOptions.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-muted/70 p-3">
            <div className="min-w-[200px]">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary" htmlFor="global-leader-search">
                Search team leader
              </label>
              <input
                id="global-leader-search"
                type="text"
                className="h-10 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100 disabled:bg-muted disabled:text-ink-tertiary"
                placeholder={partFilter === 'all' ? 'Select a part first…' : 'Search by name or EPIC…'}
                aria-label="Search team leader in this part"
                autoComplete="off"
                disabled={partFilter === 'all'}
                value={globalLeaderSearch}
                onChange={(event) => setGlobalLeaderSearch(event.target.value)}
              />
            </div>
            <div className="min-w-[220px]">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary" htmlFor="global-leader-select">
                Team leader in this part
              </label>
              <select
                id="global-leader-select"
                className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm text-ink-secondary shadow-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100 disabled:bg-muted disabled:text-ink-tertiary"
                aria-label="Filter families by team leader in the selected part"
                disabled={partFilter === 'all'}
                value={globalAssignLeaderId}
                onChange={(event) => {
                  setGlobalAssignLeaderId(event.target.value)
                  setGlobalLeaderSearch('')
                }}
              >
                <option value="">
                  {partFilter === 'all'
                    ? 'Select a part first…'
                    : globalLeaderMatches.length
                      ? 'All leaders in this part'
                      : 'No team leaders in this part'}
                </option>
                {globalLeaderMatches.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
            {globalAssignLeader ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex h-10 items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 text-sm font-semibold text-brand-700">
                  Showing families of {globalAssignLeader.name}
                </span>
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink-secondary shadow-sm transition hover:bg-muted"
                  onClick={() => {
                    setGlobalAssignLeaderId('')
                    setGlobalLeaderSearch('')
                  }}
                >
                  Clear
                </button>
              </div>
            ) : (
              <span className="text-xs text-ink-tertiary">
                {partFilter === 'all'
                  ? 'Select a part, then pick a team leader to see only their assigned families.'
                  : 'Pick a team leader from this part to show only their assigned families.'}
              </span>
            )}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">Family Tables</h2>
            <p className="text-sm text-ink-secondary">
              Families stay intact when filtering by part, section, ward, religion, or state - all match the family head only, so a family never splits across members. Search highlights the matching member row and keeps the rest of the family visible.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hasActiveSearch ? (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                Search mode active
              </span>
            ) : null}
            <label
              className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted focus-within:ring-2 focus-within:ring-brand-100"
              title="Show a PART | SECTION header banner above the family list and in print/export when a part is selected"
            >
              <input
                type="checkbox"
                checked={showPartSectionHeader}
                onChange={(event) => setShowPartSectionHeader(event.target.checked)}
              />
              Show part/section header
            </label>
            <label
              className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted focus-within:ring-2 focus-within:ring-brand-100"
              title="Show larger voter photos on this page and in the print/export report"
            >
              <input
                type="checkbox"
                checked={useBigPhotos}
                onChange={(event) => setUseBigPhotos(event.target.checked)}
              />
              Bigger photos
            </label>
            <div className="relative">
              <button
                type="button"
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
                onClick={() => setTableColumnsOpen((c) => !c)}
              >
                <Cog className="h-4 w-4" />
                Columns
              </button>
              {tableColumnsOpen ? (
                <div className="absolute left-0 z-30 mt-2 w-72 rounded-xl border border-line bg-white p-3 shadow-lg md:left-auto md:right-0">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                    Columns (Photo is locked)
                  </p>
                  <div className="max-h-64 space-y-0.5 overflow-y-auto">
                    {tableColumns.map((key, index) => {
                      const option = TABLE_COLUMN_OPTIONS.find((o) => o.key === key)
                      if (!option) return null
                      return (
                        <div key={key} className="flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-muted">
                          <div className="flex flex-col gap-0.5">
                            <button type="button" disabled={index === 0} className="text-[10px] leading-none text-ink-tertiary hover:text-ink-secondary disabled:opacity-25"
                              onClick={() => setTableColumns((prev) => { const next = [...prev]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next })}
                            >▲</button>
                            <button type="button" disabled={index === tableColumns.length - 1} className="text-[10px] leading-none text-ink-tertiary hover:text-ink-secondary disabled:opacity-25"
                              onClick={() => setTableColumns((prev) => { const next = [...prev]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; return next })}
                            >▼</button>
                          </div>
                          <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                            <input
                              type="checkbox"
                              checked={true}
                              onChange={() => setTableColumns((prev) => prev.filter((k) => k !== key))}
                            />
                            {option.label}
                          </label>
                        </div>
                      )
                    })}
                    {TABLE_COLUMN_OPTIONS.filter((o) => !tableColumns.includes(o.key)).map((option) => (
                      <div key={option.key} className="flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-muted">
                        <div className="flex flex-col gap-0.5">
                          <button type="button" disabled className="text-[10px] leading-none text-slate-200">▲</button>
                          <button type="button" disabled className="text-[10px] leading-none text-slate-200">▼</button>
                        </div>
                        <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-ink-tertiary">
                          <input
                            type="checkbox"
                            checked={false}
                            onChange={() => setTableColumns((prev) => [...prev, option.key])}
                          />
                          {option.label}
                        </label>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button type="button" className="text-xs font-semibold text-brand-600 hover:text-brand-800"
                      onClick={() => { setTableColumns([...DEFAULT_TABLE_COLUMNS]); setTableColumnsOpen(false) }}>
                      Reset to default
                    </button>
                    <button type="button" className="ml-auto text-xs font-semibold text-ink-tertiary hover:text-ink-secondary"
                      onClick={() => setTableColumnsOpen(false)}>
                      Done
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
              onClick={() => {
                setReportSelectionMode('filtered')
                setReportPhotoSize(useBigPhotos ? 'jumbo' : 'small')
                setShowExportModal(true)
              }}
            >
              <Download className="h-4 w-4" />
              Export to Excel
            </button>
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
              onClick={() => {
                setReportSelectionMode('filtered')
                setReportType('standard')
                setReportPhotoSize(useBigPhotos ? 'jumbo' : 'small')
                setShowPrintModal(true)
              }}
            >
              <Printer className="h-4 w-4" />
              Print
            </button>
          </div>
        </div>

        {loading && !rows.length ? <p className="text-sm text-ink-tertiary">Loading voters...</p> : null}
        {!loading && loadingImages ? <p className="text-sm text-ink-tertiary">Loading family photos...</p> : null}
        {!loading && !filteredFamilies.length ? <p className="text-sm text-ink-secondary">No families match the selected filters.</p> : null}
      </section>

      {showPartSectionHeader && activePartSectionLabel && filteredFamilies.length ? (
        <div className="rounded-xl border border-line bg-white px-5 py-3 text-center text-sm font-bold tracking-[0.04em] text-ink shadow-soft">
          {activePartSectionLabel}
        </div>
      ) : null}

      <div className="space-y-4">
        {renderedFamilies.map((family) => {
          const visibleMembers = visibleMembersForFamily(family)
          const rowClassByVoterId: Record<string, string> = {}
          for (const member of visibleMembers) {
            rowClassByVoterId[member.id] = buildMemberRowClass(member, searchTokens)
          }

          const panel = activePanelByFamily[family.key] ?? 'none'
          const matchingMembers = hasActiveSearch ? visibleMembers.filter((member) => memberMatchesSearch(member, searchTokens)) : []

          const familyLeaderIdVal = familyLeaderId(family)
          const leaderOption = familyLeaderIdVal ? leaderOptions.find((o) => o.id === familyLeaderIdVal) : undefined
          const isParkedLeader = !!leaderOption && (isOfficeLeader(leaderOption) || isShiftedLeader(leaderOption))
          const leaderSelectValue = leaderSelectByFamily[family.key] ?? familyLeaderIdVal
          const isAssigningFamily = assigningLeaderFamily === family.key
          const familyLeaderSearchMatches = filterLeaderOptions(pickerLeaderOptions, leaderSearchByFamily[family.key] ?? '')
          const familySelectedOption = leaderSelectValue ? leaderOptions.find((option) => option.id === leaderSelectValue) : undefined
          const familyLeaderMatches =
            familySelectedOption && !familyLeaderSearchMatches.some((option) => option.id === familySelectedOption.id)
              ? [familySelectedOption, ...familyLeaderSearchMatches]
              : familyLeaderSearchMatches

          return (
            <section
              key={family.key}
              data-family-key={family.key}
              className={`overflow-hidden rounded-xl border bg-white shadow-soft ${matchingMembers.length ? 'border-amber-200 ring-1 ring-amber-100' : 'border-line'}`}
            >
              <div className={`border-b px-4 py-4 sm:px-5 ${matchingMembers.length ? 'bg-amber-50/70' : 'bg-[#f7f9fd]'}`}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className={`flex items-center justify-center overflow-hidden rounded-xl border border-line bg-white shadow-sm ${useBigPhotos ? 'h-20 w-20' : 'h-12 w-12'}`}>
                    {resolvePhotoUrl(family.headVoter) ? (
                      <img src={resolvePhotoUrl(family.headVoter)} alt={family.headVoter?.name ?? ''} className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-xs font-semibold text-brand-700">{initials(family.headVoter?.name ?? 'NA')}</span>
                    )}
                  </div>

                  <div className="min-w-[220px] flex-1">
                    <p className="font-display text-lg font-semibold leading-tight tracking-[-0.02em] text-ink">{family.headVoter?.name ?? 'Unknown'}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex h-5 items-center rounded-full border border-brand-200 bg-brand-50 px-2 text-[11px] font-semibold text-brand-700">Head</span>
                      {family.headVoter?.family_label ? (
                        <span className="rounded-full border border-line bg-white px-2 py-1 text-[11px] font-semibold text-ink-secondary">
                          {family.headVoter.family_label}
                        </span>
                      ) : null}
                      <ClassificationBadges
                        members={family.members}
                        head={family.headVoter}
                        placeClub={placeClubById.get(familyPlaceByHead[familyHeadKey(family.headVoter ?? family.members[0])] ?? '') ?? null}
                      />
                    </div>
                    {presenceNoteOf(family.headVoter) ? (
                      <p className="mt-0.5 text-sm font-medium text-ink-secondary">{presenceNoteOf(family.headVoter)}</p>
                    ) : null}
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-secondary">
                      <span>EPIC: {family.head}</span>
                      <span>Ward: {family.headVoter?.ward_no ?? '-'}</span>
                      <span>Part: {family.headVoter?.part_no ?? '-'}</span>
                      <span>Section: {family.headVoter?.section ?? '-'}</span>
                      <span>Members: {visibleMembers.length}</span>
                      {familyLeaderIdVal ? (
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${isParkedLeader ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'}`}>
                          {isParkedLeader ? `Parked: ${leaderOption!.name}` : `Leader: ${leaderOption?.name || familyLeaderIdVal}`}
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-dashed border-line px-2 py-0.5 text-[11px] font-medium text-ink-tertiary">
                          No team leader
                        </span>
                      )}
                    </div>
                    {matchingMembers.length ? (
                      <p className="mt-2 text-xs text-ink-tertiary">
                        Member matches: {matchingMembers.map((member) => `${member.name} (${member.epic_no})`).join(', ')}
                      </p>
                    ) : null}
                  </div>

                  {isAdminAreaAllowed ? (
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      {leaderOptions.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <input
                            type="text"
                            className="h-10 w-32 rounded-xl border border-line bg-white px-2 text-sm text-ink-secondary shadow-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100 disabled:opacity-60"
                            aria-label={`Search team leader for family ${family.head}`}
                            title="Filter the team leader list below"
                            placeholder="Search leader…"
                            autoComplete="off"
                            disabled={isAssigningFamily}
                            value={leaderSearchByFamily[family.key] ?? ''}
                            onChange={(event) => setLeaderSearchByFamily((current) => ({ ...current, [family.key]: event.target.value }))}
                          />
                          <select
                            className="h-10 w-40 rounded-xl border border-line bg-white px-2 text-sm text-ink-secondary shadow-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100 disabled:opacity-60"
                            aria-label={`Assign team leader for family ${family.head}`}
                            title="Assign or change team leader"
                            value={leaderSelectValue}
                            disabled={isAssigningFamily}
                            onChange={(event) => setLeaderSelectByFamily((current) => ({ ...current, [family.key]: event.target.value }))}
                          >
                            <option value="">{familyLeaderIdVal ? 'Change leader…' : 'Assign leader…'}</option>
                            {familyLeaderMatches.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="inline-flex h-10 items-center justify-center rounded-xl border border-brand-200 bg-brand-50 px-3 text-sm font-semibold text-brand-700 shadow-sm transition hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-50"
                            title="Apply team leader assignment"
                            disabled={!leaderSelectValue || leaderSelectValue === familyLeaderIdVal || isAssigningFamily}
                            onClick={() => void setFamilyLeader(family, leaderSelectValue)}
                          >
                            {isAssigningFamily ? 'Saving…' : 'Assign'}
                          </button>
                          {globalAssignLeader && globalAssignLeader.id !== familyLeaderIdVal ? (
                            <button
                              type="button"
                              className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-sm font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                              title={`Assign this family to ${globalAssignLeader.name}`}
                              disabled={isAssigningFamily}
                              onClick={() => void setFamilyLeader(family, globalAssignLeader.id)}
                            >
                              {isAssigningFamily ? 'Saving…' : `Assign to ${globalAssignLeader.name}`}
                            </button>
                          ) : null}
                        </div>
                      ) : null}

                      <PresencePicker
                        status={familyPresence(family.members, family.headVoter)}
                        note={presenceNoteOf(family.headVoter)}
                        heading="Classify family presence"
                        saving={savingPresenceKey === family.key}
                        open={presenceMenuFamily === family.key}
                        anchor={presenceMenuFamily === family.key ? presenceAnchor : null}
                        onToggle={(button) => {
                          setPresenceAnchor(button)
                          setPresenceMenuFamily((current) => (current === family.key ? null : family.key))
                        }}
                        onClose={() => setPresenceMenuFamily(null)}
                        onSave={(status, note) => void assignPresenceToFamily(family, status, note)}
                        onClear={() => void assignPresenceToFamily(family, null, '')}
                      />

                      <div className="relative">
                        <button
                          type="button"
                          className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink-secondary shadow-sm transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
                          aria-label={`Assign category to all members of family ${family.head}`}
                          title="Assign category to all members"
                          onClick={(event) => {
                            setCategoryAnchor(event.currentTarget)
                            setCategoryMenuFamily((current) => (current === family.key ? null : family.key))
                          }}
                        >
                          <span className="text-ink-tertiary">Family:</span>
                          <span>{voterCategoryLabel(family.headVoter?.voter_category) ?? 'No category'}</span>
                          <ChevronDown className={`h-4 w-4 text-ink-tertiary transition-transform ${categoryMenuFamily === family.key ? 'rotate-180' : ''}`} />
                        </button>

                        <FloatingDropdown
                          open={categoryMenuFamily === family.key}
                          onClose={() => setCategoryMenuFamily(null)}
                          anchor={categoryMenuFamily === family.key ? categoryAnchor : null}
                          className="w-56 overflow-hidden rounded-xl border border-line bg-white p-2"
                        >
                          <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                            Assign to all members
                          </p>
                          {VOTER_CATEGORY_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              role="menuitem"
                              className="block w-full rounded-xl px-3 py-2 text-left text-sm text-ink-secondary transition hover:bg-muted"
                              onClick={() => {
                                setCategoryMenuFamily(null)
                                void assignCategoryToFamily(family, option.value)
                              }}
                            >
                              {option.label}
                            </button>
                          ))}
                          <button
                            type="button"
                            role="menuitem"
                            className="block w-full rounded-xl px-3 py-2 text-left text-sm text-ink-tertiary transition hover:bg-muted"
                            onClick={() => {
                              setCategoryMenuFamily(null)
                              void assignCategoryToFamily(family, null)
                            }}
                          >
                            Clear category
                          </button>
                        </FloatingDropdown>
                      </div>

                      <div className="relative">
                        <button
                          type="button"
                          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-white shadow-sm transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
                          aria-label={`Open family settings for ${family.head}`}
                          title="Family settings"
                          onClick={(event) => {
                            setSettingsAnchor(event.currentTarget)
                            setOpenMenuFamily((current) => (current === family.key ? null : family.key))
                          }}
                        >
                          <Cog className="h-4 w-4 text-ink-secondary" />
                        </button>

                        <FloatingDropdown
                          open={openMenuFamily === family.key}
                          onClose={() => setOpenMenuFamily(null)}
                          anchor={openMenuFamily === family.key ? settingsAnchor : null}
                          className="w-52 overflow-hidden rounded-xl border border-line bg-white p-2"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            className="block w-full rounded-xl px-3 py-2 text-left text-sm text-ink-secondary transition hover:bg-muted"
                            onClick={() => openPanel(family.key, 'manage')}
                          >
                            Manage family members
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="block w-full rounded-xl px-3 py-2 text-left text-sm text-ink-secondary transition hover:bg-muted"
                            onClick={() => openPanel(family.key, 'change-head')}
                          >
                            Change family head
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="block w-full rounded-xl px-3 py-2 text-left text-sm text-ink-secondary transition hover:bg-muted"
                            onClick={() => openPanel(family.key, 'merge')}
                          >
                            Merge into another family
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="block w-full rounded-xl px-3 py-2 text-left text-sm text-rose-700 transition hover:bg-rose-50"
                            onClick={() => openPanel(family.key, 'break')}
                          >
                            Break family
                          </button>
                        </FloatingDropdown>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              {isAdminAreaAllowed && panel !== 'none' ? (
                <div className="border-b border-line bg-muted px-4 py-4 sm:px-5">
                  {panel === 'manage' ? (
                    <div className="space-y-3">
                      <div className="grid gap-2 lg:grid-cols-2">
                        <div className="min-w-0">
                          <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                            Add member by name or EPIC
                          </label>
                          <div className="flex gap-2">
                            <input
                              list={`family-add-member-candidates-${family.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                              className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                              placeholder="Name or EPIC to add"
                              aria-label={`Name or EPIC to add into family ${family.head}`}
                              autoComplete="off"
                              value={addMemberSearchByFamily[family.key] ?? ''}
                              onChange={(event) => setAddMemberSearchByFamily((current) => ({ ...current, [family.key]: event.target.value }))}
                            />
                            <datalist id={`family-add-member-candidates-${family.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}>
                              {(addMemberCandidatesByFamily[family.key] ?? []).map((candidate) => (
                                <option key={candidate.id} value={formatFamilyCandidateLabel(candidate)} />
                              ))}
                            </datalist>
                            <button
                              type="button"
                              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink transition hover:bg-muted"
                              onClick={() => void addMemberToFamily(family)}
                            >
                              <UserPlus className="h-4 w-4" />
                              Add
                            </button>
                          </div>
                          {(addMemberCandidatesByFamily[family.key]?.length ?? 0) > 0 ? (
                            <p className="mt-1 text-xs text-ink-tertiary">
                              Suggestions: {(addMemberCandidatesByFamily[family.key] ?? []).map((candidate) => formatFamilyCandidateLabel(candidate)).join(', ')}
                            </p>
                          ) : null}
                        </div>

                        <div className="min-w-0">
                          <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                            Remove member
                          </label>
                          <div className="flex gap-2">
                            <select
                              className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                              aria-label={`Select member to remove from family ${family.head}`}
                              value={removeMemberEpicByFamily[family.key] ?? ''}
                              onChange={(event) => setRemoveMemberEpicByFamily((current) => ({ ...current, [family.key]: event.target.value }))}
                            >
                              <option value="">Select member</option>
                              {family.members
                                .filter((member) => member.epic_no !== family.head)
                                .map((member) => (
                                  <option key={member.id} value={member.epic_no}>
                                    {member.name} ({member.epic_no})
                                  </option>
                                ))}
                            </select>
                            <button
                              type="button"
                              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-100"
                              onClick={() => {
                                const epic = removeMemberEpicByFamily[family.key]
                                const member = family.members.find((item) => item.epic_no === epic)
                                if (!member) {
                                  toast.error('Select a valid member to remove.')
                                  return
                                }
                                void removeMemberFromFamily(family, member)
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                              Remove
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          title="Paste multiple EPIC numbers copied from Excel (one per line). Only existing voters are added - no new voters are ever created."
                          className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink-secondary shadow-sm transition hover:bg-muted"
                          onClick={() => setBulkAssignFamilyKey(family.key)}
                        >
                          <FileSpreadsheet className="h-4 w-4 text-brand-600" />
                          Paste EPIC list
                        </button>
                        <button
                          type="button"
                          title="Create a new voter in this family"
                          className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink-secondary shadow-sm transition hover:bg-muted"
                          onClick={() => setAddVoterFamilyKey(family.key)}
                        >
                          <UserPlus className="h-4 w-4 text-brand-600" />
                          Add new voter
                        </button>
                        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Colour target</span>
                        <select
                          className="h-10 w-44 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                          aria-label={`Select member row to color in family ${family.head}`}
                          value={rowColorTargetByFamily[family.key] ?? ''}
                          onChange={(event) => setRowColorTargetByFamily((current) => ({ ...current, [family.key]: event.target.value }))}
                        >
                          <option value="">Select member</option>
                          {family.members.map((member) => (
                            <option key={member.id} value={member.epic_no}>
                              {member.name} ({member.epic_no})
                            </option>
                          ))}
                        </select>
                        {ROW_COLOR_OPTIONS.map((option) => (
                          <button
                            key={option.key}
                            type="button"
                            aria-label={`Set ${option.label} row color in family ${family.head}`}
                            title={option.label}
                            className={`h-8 w-8 rounded-full border ${option.swatchClass} shadow-sm transition hover:scale-105`}
                            onClick={() => {
                              const epic = rowColorTargetByFamily[family.key]
                              if (!epic) {
                                toast.error('Select a member first.')
                                return
                              }
                              void setMemberRowColor(family, epic, option.key)
                            }}
                          />
                        ))}
                        <button
                          type="button"
                          className="h-10 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
                          onClick={() => {
                            const epic = rowColorTargetByFamily[family.key]
                            if (!epic) {
                              toast.error('Select a member first.')
                              return
                            }
                            void setMemberRowColor(family, epic, null)
                          }}
                        >
                          Clear row colour
                        </button>
                        <button
                          type="button"
                          className="ml-auto h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
                          onClick={() => closePanel(family.key)}
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {panel === 'change-head' ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="min-w-[260px] flex-1">
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                          Choose new family head
                        </label>
                        <select
                          className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                          aria-label={`Select new family head for ${family.head}`}
                          value={headCandidateByFamily[family.key] ?? family.head}
                          onChange={(event) => setHeadCandidateByFamily((current) => ({ ...current, [family.key]: event.target.value }))}
                        >
                          {family.members.map((member) => (
                            <option key={member.id} value={member.epic_no}>
                              {member.name} ({member.epic_no})
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        className="h-10 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700"
                        onClick={() => void setFamilyHead(family, headCandidateByFamily[family.key] ?? family.head)}
                      >
                        Change head
                      </button>
                      <button
                        type="button"
                        className="h-11 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
                        onClick={() => closePanel(family.key)}
                      >
                        Close
                      </button>
                    </div>
                  ) : null}

                  {panel === 'break' ? (
                    <div className="space-y-4">
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                          Break family - select members to move into a new family
                        </label>
                        <p className="mb-3 text-xs text-ink-tertiary">
                          The first selected member becomes the new family head by default. You can change the head below.
                        </p>
                        <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-line bg-white p-2">
                          {family.members
                            .filter((member) => compactLookupValue(member.epic_no) !== compactLookupValue(family.head))
                            .map((member) => {
                              const epicKey = compactLookupValue(member.epic_no)
                              const checked = (breakSelectionByFamily[family.key] ?? []).some(
                                (value) => compactLookupValue(value) === epicKey,
                              )
                              return (
                                <label
                                  key={member.id}
                                  className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${
                                    checked ? 'bg-brand-50 text-ink' : 'text-ink-secondary hover:bg-muted'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4"
                                    checked={checked}
                                    onChange={() => toggleBreakSelection(family.key, member.epic_no)}
                                  />
                                  <span className="truncate">
                                    {member.name} ({member.epic_no})
                                  </span>
                                </label>
                              )
                            })}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-[260px] flex-1">
                          <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                            New family head
                          </label>
                          <select
                            className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
                            aria-label={`Select new family head for the broken-off members of ${family.head}`}
                            value={breakHeadByFamily[family.key] ?? ''}
                            disabled={(breakSelectionByFamily[family.key] ?? []).length === 0}
                            onChange={(event) =>
                              setBreakHeadByFamily((current) => ({ ...current, [family.key]: event.target.value }))
                            }
                          >
                            <option value="">Select member</option>
                            {family.members
                              .filter((member) => {
                                const epicKey = compactLookupValue(member.epic_no)
                                return (breakSelectionByFamily[family.key] ?? []).some(
                                  (value) => compactLookupValue(value) === epicKey,
                                )
                              })
                              .map((member) => (
                                <option key={member.id} value={member.epic_no}>
                                  {member.name} ({member.epic_no})
                                </option>
                              ))}
                          </select>
                        </div>
                        <button
                          type="button"
                          className="inline-flex h-11 items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 text-sm font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={(breakSelectionByFamily[family.key] ?? []).length === 0}
                          onClick={() => void breakMembersIntoNewFamily(family)}
                        >
                          <Scissors className="h-4 w-4" />
                          Break into new family
                        </button>
                        <button
                          type="button"
                          className="h-11 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
                          onClick={() => closePanel(family.key)}
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {panel === 'merge' ? (
                    <div className="space-y-4">
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                          Merge into another family
                        </label>
                        <p className="mb-3 text-xs text-ink-tertiary">
                          All {family.members.length} member{family.members.length === 1 ? '' : 's'} of this family will move into the target family under its head. Choose a target family below.
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="relative min-w-[260px] flex-1">
                            <input
                              className="h-11 w-full rounded-xl border border-line bg-white px-3 pr-8 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                              placeholder="Filter target families by name or EPIC..."
                              value={mergeQueryByFamily[family.key] ?? ''}
                              onChange={(event) => setMergeQueryByFamily((current) => ({ ...current, [family.key]: event.target.value }))}
                            />
                            {mergeQueryByFamily[family.key] ? (
                              <button
                                type="button"
                                aria-label="Clear target family filter"
                                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary"
                                onClick={() => setMergeQueryByFamily((current) => ({ ...current, [family.key]: '' }))}
                              >
                                <X className="h-4 w-4" />
                              </button>
                            ) : null}
                          </div>
                          <select
                            className="h-11 min-w-[240px] flex-1 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                            aria-label={`Select target family to merge ${family.head} into`}
                            value={mergeTargetByFamily[family.key] ?? ''}
                            onChange={(event) => setMergeTargetByFamily((current) => ({ ...current, [family.key]: event.target.value }))}
                          >
                            <option value="">Select target family...</option>
                            {mergeTargetCandidatesFor(family).map((candidate) => {
                              const head = candidate.headVoter ?? candidate.members[0]
                              return (
                                <option key={candidate.key} value={candidate.head}>
                                  {head?.name ?? 'Unknown'} ({candidate.head}) · {candidate.members.length} member{candidate.members.length === 1 ? '' : 's'}
                                </option>
                              )
                            })}
                          </select>
                        </div>
                      </div>

                      {(() => {
                        const targetEpic = mergeTargetByFamily[family.key] ?? ''
                        const targetFamily = familyLookupByEpic.get(compactLookupValue(targetEpic))
                        if (!targetFamily) return null
                        const targetHead = targetFamily.headVoter ?? targetFamily.members[0]
                        const sourceLabel = family.headVoter?.family_label ?? null
                        const targetLabel = targetFamily.headVoter?.family_label ?? null
                        const labelConflict = Boolean(sourceLabel && targetLabel && sourceLabel !== targetLabel)
                        return (
                          <div className="rounded-xl border border-line bg-white p-4">
                            <p className="text-sm font-semibold text-ink">
                              Merge preview: {family.headVoter?.name ?? 'This family'} → {targetHead?.name ?? targetEpic}'s family
                            </p>
                            <div className="mt-3 space-y-1.5">
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                                Resulting family ({targetFamily.members.length + family.members.length} members)
                              </p>
                              <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
                                {[...targetFamily.members, ...family.members].map((member) => (
                                  <div key={member.id} className="flex items-center gap-2 px-1 py-0.5 text-sm text-ink-secondary">
                                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-brand-400" />
                                    <span className="truncate">{member.name}</span>
                                    <span className="ml-auto truncate text-xs text-ink-tertiary">{member.epic_no}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                            {labelConflict ? (
                              <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                                Label conflict: both families have a family label ("{sourceLabel}" and "{targetLabel}"). The target family's label "{targetLabel}" will be kept.
                              </p>
                            ) : null}
                            <div className="mt-4 flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                                disabled={mergingFamilyKey === family.key}
                                onClick={() => void mergeFamilies(family)}
                              >
                                {mergingFamilyKey === family.key ? <Loader2 className="h-4 w-4 animate-spin" /> : <Merge className="h-4 w-4" />}
                                Merge families
                              </button>
                              <button
                                type="button"
                                className="h-11 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
                                onClick={() => closePanel(family.key)}
                              >
                                Close
                              </button>
                            </div>
                          </div>
                        )
                      })()}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="divide-y divide-line md:hidden">
                {visibleMembers.map((member, memberIndex) => {
                  const isFamilyHead = compactLookupValue(member.epic_no) === compactLookupValue(family.head)
                  const contact = member.contact_no_1 || member.contact_no_2
                  return (
                    <div
                      key={member.id}
                      className={`flex items-center gap-3 px-4 py-3 active:bg-muted ${rowClassByVoterId[member.id] ?? ''}`}
                      onClick={() => setSelectedVoter(member)}
                    >
                      {resolvePhotoUrl(member) ? (
                        <img
                          src={resolvePhotoUrl(member)}
                          alt={member.name}
                          className="h-11 w-11 shrink-0 rounded-full border border-line object-cover"
                        />
                      ) : (
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                          {initials(member.name)}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {isFamilyHead ? (
                            <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">
                              Head
                            </span>
                          ) : null}
                          <span className="truncate text-sm font-semibold text-ink">{member.name}</span>
                        </div>
                        <p className="mt-0.5 text-xs text-ink-tertiary">
                          EPIC: {member.epic_no}
                          {member.relative_name ? ` • ${member.relative_name}${member.relative_relation ? ` (${member.relative_relation})` : ''}` : ''}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-secondary">
                          <span className="rounded-md bg-muted px-1.5 py-0.5">Part: {member.part_no ?? '-'}</span>
                          <span className="rounded-md bg-muted px-1.5 py-0.5">Section: {member.section ?? '-'}</span>
                          <span className="rounded-md bg-muted px-1.5 py-0.5">Sr: {member.sr_no_roll ?? '-'}</span>
                          {member.age != null ? (
                            <span className="rounded-md bg-muted px-1.5 py-0.5">{member.age}</span>
                          ) : null}
                          {member.gender ? (
                            <span className="rounded-md bg-muted px-1.5 py-0.5">{member.gender}</span>
                          ) : null}
                          {member.house_no ? (
                            <span className="rounded-md bg-muted px-1.5 py-0.5">House: {member.house_no}</span>
                          ) : null}
                          <span className={`rounded-md px-1.5 py-0.5 font-medium ${member.voter_category ? 'bg-brand-50 text-brand-700' : 'bg-muted text-ink-tertiary'}`}>
                            {voterCategoryLabel(member.voter_category) ?? 'No category'}
                          </span>
                          <span
                            className={`rounded-md px-1.5 py-0.5 font-medium ${hasPresenceOverride(member, family.headVoter) ? 'bg-amber-50 text-amber-800' : 'bg-muted text-ink-secondary'}`}
                            title={presenceNoteOf(member) ? `${presenceLabel(member.presence_status) ?? 'Presence'} — ${presenceNoteOf(member)}` : (presenceLabel(member.presence_status) ?? 'Presence')}
                          >
                            {presenceLabel(member.presence_status) ?? 'Presence'}
                          </span>
                          {presenceNoteOf(member) ? (
                            <span className="line-clamp-2 max-w-[16rem] whitespace-pre-wrap rounded-md bg-muted px-1.5 py-0.5 text-ink-tertiary" title={presenceNoteOf(member)}>
                              {presenceNoteOf(member)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {isAdminAreaAllowed ? (
                        <div className="flex flex-col items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
                          <button
                            type="button"
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-tertiary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                            aria-label={`Move ${member.name} up`}
                            disabled={memberIndex === 0}
                            onClick={() => void reorderFamilyMember(family, memberIndex, memberIndex - 1)}
                          >
                            <ChevronUp className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-tertiary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                            aria-label={`Move ${member.name} down`}
                            disabled={memberIndex === visibleMembers.length - 1}
                            onClick={() => void reorderFamilyMember(family, memberIndex, memberIndex + 1)}
                          >
                            <ChevronDown className="h-4 w-4" />
                          </button>
                        </div>
                      ) : null}
                      {contact ? (
                        <a
                          href={`tel:${contact}`}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 transition active:bg-emerald-100"
                          aria-label={`Call ${member.name}`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Phone className="h-4 w-4" />
                        </a>
                      ) : null}
                    </div>
                  )
                })}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <table className="min-w-full border-separate border-spacing-0 text-xs">
                  <thead className="bg-[#f7f9fd]">
                    <tr>
                      {isAdminAreaAllowed ? (
                        <th className="w-8 border-b border-line px-2 py-2.5 text-center font-semibold text-ink-tertiary"></th>
                      ) : null}
                      <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Photo</th>
                      {tableColumns.map((key) => {
                        const option = TABLE_COLUMN_OPTIONS.find((o) => o.key === key)
                        const isCenter = tableColumnIsCenter(key)
                        return (
                          <th key={key} className={`border-b border-line px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary ${isCenter ? 'text-center' : 'text-left'}`}>
                            {option?.label ?? key}
                          </th>
                        )
                      })}
                      <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Category</th>
                      <th className="min-w-[10rem] max-w-[14rem] border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Presence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleMembers.map((member, memberIndex) => {
                      const isFamilyHead = compactLookupValue(member.epic_no) === compactLookupValue(family.head)
                      return (
                      <tr
                        key={member.id}
                        className={`cursor-pointer transition hover:bg-[#f5f7fd] ${rowClassByVoterId[member.id] ?? ''} ${dragReorder?.familyKey === family.key && dragReorder.fromIndex === memberIndex ? 'opacity-40' : ''}`}
                        onClick={() => setSelectedVoter(member)}
                        draggable={isAdminAreaAllowed && !isFamilyHead}
                        onDragStart={(event) => {
                          if (!isAdminAreaAllowed || isFamilyHead) return
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', member.id)
                          setDragReorder({ familyKey: family.key, fromIndex: memberIndex })
                        }}
                        onDragOver={(event) => {
                          event.preventDefault()
                          event.dataTransfer.dropEffect = 'move'
                        }}
                        onDrop={async (event) => {
                          event.preventDefault()
                          if (!dragReorder || dragReorder.familyKey !== family.key) return
                          const toIndex = memberIndex
                          setDragReorder(null)
                          if (dragReorder.fromIndex === toIndex) return
                          await reorderFamilyMember(family, dragReorder.fromIndex, toIndex)
                        }}
                        onDragEnd={() => setDragReorder(null)}
                      >
                        {isAdminAreaAllowed ? (
                          <td
                            className={`border-b border-line px-2 py-3 text-center ${isFamilyHead ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'}`}
                            onClick={(event) => event.stopPropagation()}
                            draggable={!isFamilyHead}
                            onDragStart={(event) => {
                              if (isFamilyHead) {
                                event.preventDefault()
                                return
                              }
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('text/plain', member.id)
                              setDragReorder({ familyKey: family.key, fromIndex: memberIndex })
                            }}
                          >
                            {isFamilyHead ? null : <span className="text-ink-tertiary select-none">⠿</span>}
                          </td>
                        ) : null}
                        <td className="border-b border-line px-3 py-3">
                          {resolvePhotoUrl(member) ? (
                            <img
                              src={resolvePhotoUrl(member)}
                              alt={member.name}
                              className={`rounded-full border border-line object-cover ${useBigPhotos ? 'h-16 w-16' : 'h-9 w-9'}`}
                            />
                          ) : (
                            <span
                              className={`inline-flex items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700 ${useBigPhotos ? 'h-16 w-16 text-sm' : 'h-9 w-9 text-[10px]'}`}
                            >
                              {initials(member.name)}
                            </span>
                          )}
                        </td>
                        {tableColumns.map((key) => {
                          const isBold = tableColumnIsBold(key)
                          const isCenter = tableColumnIsCenter(key)
                          const value = key === 'srNo' ? String(memberIndex + 1) : tableColumnCell(member, family, key)
                          return (
                            <td key={key} className={`border-b border-line px-3 py-3 text-ink-secondary ${isBold ? 'font-medium text-ink' : ''} ${isCenter ? 'text-center' : ''}`}>
                              {key === 'name' ? (
                                <span className="inline-flex min-w-0 max-w-[14rem] items-center gap-1.5">
                                  <span className="truncate" title={value}>{value}</span>
                                </span>
                              ) : value}
                            </td>
                          )
                        })}
                        <td className="border-b border-line px-3 py-3" onClick={(event) => event.stopPropagation()}>
                          {isAdminAreaAllowed ? (
                            <select
                              className="h-8 w-28 rounded-lg border border-line bg-white px-1.5 text-xs"
                              aria-label={`Set category for ${member.name}`}
                              title="Set category"
                              value={member.voter_category ?? ''}
                              onChange={(event) =>
                                void setMemberCategory(family, member.epic_no, (event.target.value || null) as Voter['voter_category'] | null)
                              }
                            >
                              <option value="">-</option>
                              {VOTER_CATEGORY_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-ink-secondary">{voterCategoryLabel(member.voter_category) ?? '-'}</span>
                          )}
                        </td>
                        <td className="min-w-0 overflow-hidden border-b border-line px-3 py-3 align-middle" onClick={(event) => event.stopPropagation()}>
                          <PresencePicker
                            status={member.presence_status}
                            note={presenceNoteOf(member)}
                            heading={isFamilyHead ? 'Classify family presence' : 'Classify this voter'}
                            compact
                            showPrefix={false}
                            disabled={!isAdminAreaAllowed}
                            saving={savingPresenceKey === member.id || (isFamilyHead && savingPresenceKey === family.key)}
                            open={presenceMenuMember === member.id}
                            anchor={presenceMenuMember === member.id ? presenceMemberAnchor : null}
                            onToggle={(button) => {
                              setPresenceMemberAnchor(button)
                              setPresenceMenuMember((current) => (current === member.id ? null : member.id))
                            }}
                            onClose={() => setPresenceMenuMember(null)}
                            onSave={(status, note) => {
                              if (isFamilyHead) void assignPresenceToFamily(family, status, note)
                              else void assignPresenceToMember(member, family, status, note)
                            }}
                            onClear={() => {
                              if (isFamilyHead) void assignPresenceToFamily(family, null, '')
                              else void assignPresenceToMember(member, family, null, '')
                            }}
                          />
                        </td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )
        })}

        {hasMoreFamilies ? (
          <div className="flex justify-center">
            <button
              type="button"
              className="h-11 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
              onClick={() => setFamilyRenderLimit((current) => current + initialFamilyRenderLimit)}
            >
              Load more families ({filteredFamilies.length - renderedFamilies.length} remaining)
            </button>
          </div>
        ) : null}
      </div>

      <VoterDetailDrawer
        voter={selectedVoter}
        onClose={() => setSelectedVoter(null)}
        onSaved={async () => {
          await load({ keepExisting: true })
          if (selectedVoter?.id) {
            const { data } = await supabase.from('voters').select('*').eq('id', selectedVoter.id).maybeSingle()
            setSelectedVoter((data as Voter | null) ?? null)
          }
        }}
      />

      {(() => {
        const targetFamily = bulkAssignFamilyKey ? families.find((family) => family.key === bulkAssignFamilyKey) ?? null : null
        if (!targetFamily) return null
        return (
          <BulkAddFamilyMembersModal
            headEpic={targetFamily.head}
            headName={targetFamily.headVoter?.name}
            members={targetFamily.members}
            familyLookupByEpic={familyLookupByEpic}
            profileId={profile?.id}
            onImported={() => reloadAfterMutation(targetFamily.key)}
            onClose={() => setBulkAssignFamilyKey(null)}
          />
        )
      })()}

      {(() => {
        const targetFamily = addVoterFamilyKey ? families.find((family) => family.key === addVoterFamilyKey) ?? null : null
        if (!targetFamily) return null
        const leaderId = familyLeaderId(targetFamily)
        const leaderOption = leaderId ? leaderOptions.find((option) => option.id === leaderId) : undefined
        return (
          <AddNewFamilyVoterModal
            familyHeadEpic={targetFamily.head}
            head={targetFamily.headVoter}
            members={targetFamily.members}
            allVoters={rows}
            familyLeaderId={leaderId || null}
            familyLeaderNotes={leaderOption?.notes ?? null}
            specialLeaderIds={specialLeaderIds}
            profileId={profile?.id ?? null}
            onCreated={(voter) => {
              applyLocalRowUpdates([voter])
              if (leaderId) {
                setVoterToLeaderId((current) => ({ ...current, [voter.id]: leaderId }))
              }
            }}
            onClose={() => setAddVoterFamilyKey(null)}
          />
        )
      })()}

      {showExportModal || showPrintModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-ink">
                {showExportModal ? 'Export families to Excel' : 'Print families report'}
              </h3>
              <button
                type="button"
                className="text-ink-tertiary hover:text-ink-secondary"
                onClick={() => {
                  setShowExportModal(false)
                  setShowPrintModal(false)
                }}
              >
                ✕
              </button>
            </div>

            {showExportModal ? (
              <div className="mb-4">
                <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Report type</label>
                <select
                  className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                  value={reportType}
                  onChange={(event) => setReportType(event.target.value as 'standard' | 'familyWise')}
                >
                  <option value="standard">Standard (choose scope, layout, grouping below)</option>
                  <option value="familyWise">
                    Family-wise: Part {partFilter === 'all' ? '?' : partFilter} / Section {sectionFilter === 'all' ? '?' : sectionFilter} - split by Religion &amp; State
                  </option>
                </select>
                {reportType === 'familyWise' ? (
                  <p className="mt-2 text-xs text-ink-tertiary">
                    Uses the Part/Section (and Ward, if set) currently selected on the page. Generates one sheet per
                    religion and one sheet per state (each family stays intact on its head's sheet), plus a combined
                    "Single Voters" sheet for single-member families - excluded from the religion/state sheets.
                    {partFilter === 'all' || sectionFilter === 'all' ? (
                      <span className="mt-1 block font-semibold text-amber-700">
                        Select a specific Part and Section on the page above before exporting.
                      </span>
                    ) : null}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className={`grid gap-4 ${reportType === 'familyWise' && showExportModal ? 'sm:grid-cols-1 sm:max-w-xs' : 'sm:grid-cols-3'}`}>
              {reportType === 'familyWise' && showExportModal ? null : (
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Scope</label>
                  <select
                    className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                    value={reportSelectionMode}
                    onChange={(event) => setReportSelectionMode(event.target.value as typeof reportSelectionMode)}
                  >
                    <option value="filtered">Current filtered view ({filteredFamilies.length} families)</option>
                    <option value="all">All families ({families.length} families)</option>
                    <option value="selected">Select families individually</option>
                  </select>
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                  {reportType === 'familyWise' && showExportModal ? 'Family heads only, or heads + members?' : 'Layout'}
                </label>
                <select
                  className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                  value={reportLayout}
                  onChange={(event) => setReportLayout(event.target.value as 'detailed' | 'headsOnly')}
                >
                  <option value="detailed">Detailed - family head + all members</option>
                  <option value="headsOnly">Family heads only</option>
                </select>
              </div>

              {reportType === 'familyWise' && showExportModal ? null : (
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Group by</label>
                  <select
                    className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                    value={reportGroupBy}
                    onChange={(event) => setReportGroupBy(event.target.value as typeof reportGroupBy)}
                  >
                    <option value="none">No grouping</option>
                    <option value="part">Part-wise</option>
                    <option value="ward">Ward-wise</option>
                    <option value="section">Section-wise</option>
                    <option value="religion">Religion-wise</option>
                    <option value="gender">Gender-wise</option>
                  </select>
                </div>
              )}
            </div>


            {reportSelectionMode === 'selected' && !(reportType === 'familyWise' && showExportModal) ? (
              <div className="mt-4 max-h-48 overflow-y-auto rounded-xl border border-line p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink-tertiary">Select families to include ({selectedFamilyKeys.size} selected)</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="text-xs font-semibold text-brand-600 hover:text-brand-800"
                      onClick={() => setSelectedFamilyKeys(new Set(filteredFamilies.map((f) => f.key)))}
                    >
                      Select all filtered
                    </button>
                    <button
                      type="button"
                      className="text-xs font-semibold text-rose-600 hover:text-rose-800"
                      onClick={() => setSelectedFamilyKeys(new Set())}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                {filteredFamilies.slice(0, 200).map((family) => (
                  <label
                    key={family.key}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-secondary hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={selectedFamilyKeys.has(family.key)}
                      onChange={() => {
                        setSelectedFamilyKeys((prev) => {
                          const next = new Set(prev)
                          if (next.has(family.key)) next.delete(family.key)
                          else next.add(family.key)
                          return next
                        })
                      }}
                    />
                    <span className="truncate">
                      {family.headVoter?.name ?? 'Unknown'} ({family.members.length} members)
                    </span>
                  </label>
                ))}
                {filteredFamilies.length > 200 ? (
                  <p className="mt-2 text-xs text-ink-tertiary">Showing first 200 families. Use filters to narrow down.</p>
                ) : null}
              </div>
            ) : null}

            {reportGroupBy !== 'none' && !(reportType === 'familyWise' && showExportModal) ? (
              <p className="mt-2 text-xs text-ink-tertiary">
                Grouping uses each family's <span className="font-semibold">head</span>, so a full family always stays together
                in one group even if some members are individually registered elsewhere.
              </p>
            ) : null}

            {showExportModal && reportGroupBy !== 'none' && reportType !== 'familyWise' ? (
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                <input
                  type="checkbox"
                  checked={reportSplitSheets}
                  onChange={(event) => setReportSplitSheets(event.target.checked)}
                />
                Put each {reportGroupBy} in its own sheet (instead of one combined sheet)
              </label>
            ) : null}

            {showPrintModal ? (
              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Paper size</label>
                  <select
                    className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                    value={reportPaperSize}
                    onChange={(event) => setReportPaperSize(event.target.value as 'a4' | 'letter')}
                  >
                    <option value="a4">A4</option>
                    <option value="letter">Letter</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Orientation</label>
                  <select
                    className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                    value={reportOrientation}
                    onChange={(event) => setReportOrientation(event.target.value as 'portrait' | 'landscape')}
                  >
                    <option value="landscape">Landscape</option>
                    <option value="portrait">Portrait</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Print mode</label>
                  <select
                    className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                    value={reportPrintMode}
                    onChange={(event) => setReportPrintMode(event.target.value as 'table' | 'booklet')}
                  >
                    <option value="table">Table (dense)</option>
                    <option value="booklet">Booklet / voter slip (one family per card)</option>
                  </select>
                </div>
              </div>
            ) : null}

            <div className="mt-5">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Photo size</label>
              <select
                className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                value={reportPhotoSize}
                onChange={(event) => setReportPhotoSize(event.target.value as 'small' | 'medium' | 'large' | 'xlarge' | 'jumbo')}
              >
                <option value="small">Small (30px)</option>
                <option value="medium">Medium (40px)</option>
                <option value="large">Large (60px)</option>
                <option value="xlarge">Extra Large (90px)</option>
                <option value="jumbo">Jumbo (110px)</option>
              </select>
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                <input
                  type="checkbox"
                  checked={useBigPhotos}
                  onChange={(event) => {
                    setUseBigPhotos(event.target.checked)
                    setReportPhotoSize(event.target.checked ? 'jumbo' : 'small')
                  }}
                />
                Use bigger photos (same toggle as the page view)
              </label>
            </div>

            {showPrintModal ? (
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Font size</label>
                  <select
                    className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                    value={reportFontSize}
                    onChange={(event) => setReportFontSize(Number(event.target.value))}
                  >
                    {Array.from({ length: 22 }, (_, i) => i + 7).map((size) => (
                      <option key={size} value={size}>{size}px</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Bold text</label>
                  <label className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm text-ink-secondary">
                    <input type="checkbox" checked={reportBold} onChange={(event) => setReportBold(event.target.checked)} />
                    Print in bold
                  </label>
                </div>
              </div>
            ) : (
              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Cell borders</label>
                  <label className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm text-ink-secondary">
                    <input type="checkbox" checked={reportExportBorders} onChange={(event) => setReportExportBorders(event.target.checked)} />
                    Borders
                  </label>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Row height</label>
                  <input
                    type="number"
                    min={0}
                    max={120}
                    className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                    value={reportExportRowHeight}
                    onChange={(event) => setReportExportRowHeight(Number(event.target.value))}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Column width</label>
                  <input
                    type="number"
                    min={8}
                    max={80}
                    className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                    value={reportExportColWidth}
                    onChange={(event) => setReportExportColWidth(Number(event.target.value))}
                  />
                </div>
              </div>
            )}

            {showPrintModal ? (
              <div className="mt-5 space-y-4">
                <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Header customization</h4>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs text-ink-tertiary">Constituency name</label>
                    <input
                      className="h-10 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                      placeholder="e.g. Shivajinagar Assembly"
                      value={reportHeaderConstituency}
                      onChange={(event) => setReportHeaderConstituency(event.target.value)}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-ink-tertiary">Report date</label>
                    <input
                      type="date"
                      className="h-10 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                      value={reportHeaderDate}
                      onChange={(event) => setReportHeaderDate(event.target.value)}
                    />
                  </div>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                  <input
                    type="checkbox"
                    checked={reportHeaderSignature}
                    onChange={(event) => setReportHeaderSignature(event.target.checked)}
                  />
                  Add signature / verification line
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                  <input
                    type="checkbox"
                    checked={reportShowTally}
                    onChange={(event) => setReportShowTally(event.target.checked)}
                  />
                  Show total families / total members tally at the top
                </label>
                <label
                  className="flex cursor-pointer items-center gap-2 text-sm text-ink-secondary"
                  title={
                    reportSelectionMode === 'filtered' && activePartSectionLabel
                      ? `Will show: ${activePartSectionLabel}`
                      : 'Only shown when printing the "Current filtered view" with a part selected'
                  }
                >
                  <input
                    type="checkbox"
                    checked={showPartSectionHeader}
                    onChange={(event) => setShowPartSectionHeader(event.target.checked)}
                  />
                  Show PART / SECTION header banner
                </label>
              </div>
            ) : null}

            <div className="mt-5">
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Fields to include (drag to reorder)</label>
              <div className="space-y-1">
                {reportFieldOrder.map((key, index) => {
                  const option = REPORT_FIELD_OPTIONS.find((o) => o.key === key)
                  if (!option) return null
                  return (
                    <div key={key} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
                      <div className="flex flex-col gap-0.5">
                        <button
                          type="button"
                          disabled={index === 0}
                          className="text-xs text-ink-tertiary hover:text-ink-secondary disabled:opacity-30"
                          onClick={() => {
                            setReportFieldOrder((prev) => {
                              const next = [...prev]
                              const temp = next[index - 1]
                              next[index - 1] = next[index]
                              next[index] = temp
                              return next
                            })
                          }}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          disabled={index === reportFieldOrder.length - 1}
                          className="text-xs text-ink-tertiary hover:text-ink-secondary disabled:opacity-30"
                          onClick={() => {
                            setReportFieldOrder((prev) => {
                              const next = [...prev]
                              const temp = next[index + 1]
                              next[index + 1] = next[index]
                              next[index] = temp
                              return next
                            })
                          }}
                        >
                          ▼
                        </button>
                      </div>
                      <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                        <input
                          type="checkbox"
                          checked={reportFields[option.key]}
                          onChange={() =>
                            setReportFields((current) => ({ ...current, [option.key]: !current[option.key] }))
                          }
                        />
                        {option.label}
                      </label>
                    </div>
                  )
                })}
                {REPORT_FIELD_OPTIONS.filter((o) => !reportFieldOrder.includes(o.key)).map((option) => (
                  <div key={option.key} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
                    <div className="flex flex-col gap-0.5">
                      <button type="button" disabled className="text-xs text-ink-tertiary">▲</button>
                      <button type="button" disabled className="text-xs text-ink-tertiary">▼</button>
                    </div>
                    <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                      <input
                        type="checkbox"
                        checked={reportFields[option.key]}
                        onChange={(event) => {
                          const nextChecked = event.target.checked
                          setReportFields((current) => ({ ...current, [option.key]: nextChecked }))
                          if (nextChecked) {
                            // Move it into the reorderable list so it prints/exports
                            // and can be dragged into position, instead of sitting
                            // stuck in this "not yet added" section forever.
                            setReportFieldOrder((prev) => (prev.includes(option.key) ? prev : [...prev, option.key]))
                          }
                        }}
                      />
                      {option.label}
                    </label>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex gap-3 text-xs font-semibold text-ink-tertiary">
                <button type="button" className="hover:text-ink-secondary" onClick={() => {
                  setReportFields(defaultReportFields())
                  setReportFieldOrder([...DEFAULT_REPORT_FIELD_KEYS])
                }}>
                  Reset to default
                </button>
                <button
                  type="button"
                  className="hover:text-ink-secondary"
                  onClick={() => {
                    const all = {} as Record<ReportFieldKey, boolean>
                    const order: ReportFieldKey[] = []
                    for (const option of REPORT_FIELD_OPTIONS) {
                      all[option.key] = true
                      order.push(option.key)
                    }
                    setReportFields(all)
                    setReportFieldOrder(order)
                  }}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="hover:text-ink-secondary"
                  onClick={() => {
                    const none = {} as Record<ReportFieldKey, boolean>
                    for (const option of REPORT_FIELD_OPTIONS) none[option.key] = false
                    setReportFields(none)
                  }}
                >
                  Clear all
                </button>
              </div>
            </div>

            {showExportModal ? (
              <p className="mt-4 text-xs text-ink-tertiary">
                Includes a Summary sheet with total families/members (and a per-group breakdown if grouped), plus a
                totals line and per-group subtotals in the data sheet(s). Photos export as a temporary link (valid ~1
                hour), not an embedded image thumbnail - the current Excel library doesn't support embedding images.
              </p>
            ) : (
              <p className="mt-4 text-xs text-ink-tertiary">
                Opens a print-ready page in a new tab with the selected fields and grouping, then triggers your
                browser's print dialog - use "Save as PDF" there if you want a PDF instead of a physical printout.
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                className="h-11 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
                onClick={() => {
                  setShowExportModal(false)
                  setShowPrintModal(false)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="h-10 rounded-lg bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700"
                onClick={() => {
                  const style: PrintStyleOptions = {
                    fontSize: reportFontSize,
                    boldText: reportBold,
                    exportBorders: reportExportBorders,
                    exportRowHeight: reportExportRowHeight,
                    exportColWidth: reportExportColWidth,
                  }
                  if (showExportModal && reportType === 'familyWise') {
                    handleExportFamilyWiseReport(style)
                    return
                  }
                  if (reportSelectionMode === 'selected' && selectedFamilyKeys.size === 0) {
                    toast.error('Select at least one family to export/print.')
                    return
                  }
                  if (showExportModal) handleExportExcel(style)
                  else handlePrint(style)
                }}
              >
                {showExportModal ? (reportType === 'familyWise' ? 'Export Family-wise Report' : 'Export Excel file') : 'Print'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <MobileSheet
        open={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        title="Filter families"
        footer={
          <div className="flex gap-3">
            <Button variant="secondary" className="h-11 flex-1" onClick={resetFilters}>
              Reset all
            </Button>
            <Button className="h-11 flex-1" onClick={() => setFilterSheetOpen(false)}>
              Apply
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Part</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setPartFilter('all')
                  setSectionFilter('all')
                }}
                className={`inline-flex h-9 items-center rounded-full px-3 text-xs font-medium ${
                  partFilter === 'all' ? 'bg-brand-600 text-white' : 'border border-line text-ink-secondary'
                }`}
              >
                All
              </button>
              {partOptions.map((part) => {
                const value = String(part)
                const active = partFilter === value
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setPartFilter(value)
                      setSectionFilter('all')
                    }}
                    className={`inline-flex h-9 items-center rounded-full px-3 text-xs font-medium ${
                      active ? 'bg-brand-600 text-white' : 'border border-line text-ink-secondary'
                    }`}
                  >
                    Part {part}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Section</p>
            <select
              className="h-11 w-full rounded-xl border border-line px-3 text-sm disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
              value={sectionFilter}
              disabled={partFilter === 'all'}
              onChange={(event) => setSectionFilter(event.target.value)}
            >
              <option value="all">{partFilter === 'all' ? 'All Sections (pick a part)' : 'All Sections'}</option>
              {sectionOptions.map((section) => (
                <option key={section} value={String(section)}>
                  Section {section}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Ward</p>
            <select
              className="h-11 w-full rounded-xl border border-line px-3 text-sm"
              value={wardFilter}
              onChange={(event) => setWardFilter(event.target.value)}
            >
              <option value="all">All Wards</option>
              {wardOptions.map((ward) => (
                <option key={ward} value={String(ward)}>
                  Ward {ward}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Religion</p>
            <select
              className="h-11 w-full rounded-xl border border-line px-3 text-sm disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
              value={religionFilter}
              disabled={partFilter === 'all'}
              onChange={(event) => setReligionFilter(event.target.value)}
            >
              <option value="all">All Religions</option>
              {religionOptions.map((religion) => (
                <option key={religion} value={religion}>
                  {religion}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">State</p>
            <select
              className="h-11 w-full rounded-xl border border-line px-3 text-sm disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
              value={stateFilter}
              disabled={partFilter === 'all'}
              onChange={(event) => setStateFilter(event.target.value)}
            >
              <option value="all">All States</option>
              {stateOptions.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Gender (matches any member)</p>
            <div className="grid grid-cols-3 gap-2">
              {(['all', 'male', 'female'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setGenderFilter(value)}
                  className={`h-11 rounded-xl border text-sm font-medium ${
                    genderFilter === value ? 'border-brand-400 bg-brand-50 text-brand-700' : 'border-line text-ink-secondary'
                  }`}
                >
                  {value === 'all' ? 'All' : value === 'male' ? 'Male' : 'Female'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Assignment</p>
            <select
              className="h-11 w-full rounded-xl border border-line px-3 text-sm"
              value={assignmentFilter}
              onChange={(event) => setAssignmentFilter(event.target.value as typeof assignmentFilter)}
            >
              <option value="all">All assignments ({familyFilterCounts.families})</option>
              <option value="assigned">Assigned ({familyFilterCounts.assigned})</option>
              <option value="unassigned">Unassigned ({familyFilterCounts.unassigned})</option>
              <option value="shifted">Shifted ({familyFilterCounts.shifted})</option>
              <option value="single">Single ({familyFilterCounts.single})</option>
            </select>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Category</p>
            <select
              className="h-11 w-full rounded-xl border border-line px-3 text-sm"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
            >
              <option value="all">All categories ({familyFilterCounts.families})</option>
              <option value="unassigned">Unassigned category ({familyFilterCounts.noCategory})</option>
              {VOTER_CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} ({familyFilterCounts.byCategory[option.value] ?? 0})
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Family size</p>
            <div className="grid grid-cols-4 gap-2">
              {FAMILY_SIZE_BUCKET_OPTIONS.map((bucket) => {
                const checked = sizeFilterValues.includes(bucket)
                return (
                  <label
                    key={bucket}
                    className={`flex h-11 cursor-pointer items-center justify-center rounded-xl border text-sm font-medium transition ${
                      checked ? 'border-brand-400 bg-brand-50 text-brand-700' : 'border-line text-ink-secondary'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={() =>
                        setSizeFilterValues((current) =>
                          current.includes(bucket) ? current.filter((value) => value !== bucket) : [...current, bucket],
                        )
                      }
                    />
                    {bucket === '1' ? 'Single' : bucket}
                  </label>
                )
              })}
            </div>
          </div>
        </div>
      </MobileSheet>
    </div>
  )
}
