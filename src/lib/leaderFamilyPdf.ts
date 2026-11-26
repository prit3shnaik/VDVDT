import type { TeamLeader, Voter } from './types'
import { supabase } from './supabase'
import { resolveTeamLeaderName, fetchTeamLeaderFromApi, teamLeaderFromApi, voterFromApiLeader, voterFromApiAssignment } from './teamLeaderCache'
import { fetchInChunks } from './d1Query'
import { compactLookupValue, normalizeLookupValue } from './searchUtils'
import { buildPdfTable } from './reportBuilder'

// ── Print field definitions ───────────────────────────────────────────
// Single source of truth shared by the team-leader detail page and the batch
// "Download All (ZIP)" flow so both produce identical PDFs.

export type PrintFieldKey =
  | 'srNo'
  | 'voterSrNo'
  | 'photo'
  | 'name'
  | 'epicNo'
  | 'status'
  | 'relativeName'
  | 'relation'
  | 'houseNo'
  | 'ward'
  | 'partNo'
  | 'section'
  | 'sectionName'
  | 'age'
  | 'gender'
  | 'contact1'
  | 'contact2'
  | 'religion'
  | 'dob'
  | 'familyLabel'
  | 'familyMembers'
  | 'presence'

export interface PrintFieldDef {
  key: PrintFieldKey
  label: string
  description?: string
  isPhoto?: boolean
  isSequentialSrNo?: boolean
}

export interface PrintFieldState {
  key: PrintFieldKey
  enabled: boolean
}

export const PRINT_FIELD_DEFS: PrintFieldDef[] = [
  { key: 'srNo', label: 'Sr No', description: 'Sequential counter (1, 2, 3 ...)', isSequentialSrNo: true },
  { key: 'voterSrNo', label: 'Voter Sr No', description: 'From sr_no_roll in the database' },
  { key: 'photo', label: 'Photo', isPhoto: true },
  { key: 'name', label: 'Name' },
  { key: 'epicNo', label: 'EPIC' },
  { key: 'status', label: 'Status' },
  { key: 'relativeName', label: 'Relative Name' },
  { key: 'relation', label: 'Relation' },
  { key: 'houseNo', label: 'House No' },
  { key: 'ward', label: 'Ward' },
  { key: 'partNo', label: 'Part No' },
  { key: 'section', label: 'Section' },
  { key: 'sectionName', label: 'Section Name' },
  { key: 'age', label: 'Age' },
  { key: 'gender', label: 'Gender' },
  { key: 'contact1', label: 'Contact No 1' },
  { key: 'contact2', label: 'Contact No 2' },
  { key: 'religion', label: 'Religion' },
  { key: 'dob', label: 'Date of Birth' },
  { key: 'familyLabel', label: 'Family Label' },
  { key: 'familyMembers', label: 'Family Members' },
  { key: 'presence', label: 'Presence' },
]

export const DEFAULT_PRINT_FIELDS: PrintFieldState[] = [
  { key: 'srNo', enabled: true },
  { key: 'photo', enabled: true },
  { key: 'name', enabled: true },
  { key: 'contact1', enabled: true },
  { key: 'relativeName', enabled: false },
  { key: 'voterSrNo', enabled: false },
  { key: 'epicNo', enabled: false },
  { key: 'status', enabled: false },
  { key: 'houseNo', enabled: false },
  { key: 'ward', enabled: false },
  { key: 'partNo', enabled: false },
  { key: 'section', enabled: false },
  { key: 'sectionName', enabled: false },
  { key: 'age', enabled: false },
  { key: 'relation', enabled: false },
  { key: 'gender', enabled: false },
  { key: 'contact2', enabled: false },
  { key: 'religion', enabled: false },
  { key: 'dob', enabled: false },
  { key: 'familyLabel', enabled: false },
  { key: 'familyMembers', enabled: false },
  { key: 'presence', enabled: false },
]

export const EXTRA_PRINT_FIELD_KEYS: PrintFieldKey[] = []

export function extraPrintFieldKeysForLeader(_leader: { notes?: string | null } | null | undefined): PrintFieldKey[] {
  return []
}

export function mergePrintFieldsForLeader(
  fields: Array<{ key: string; enabled: boolean }>,
  leader: { notes?: string | null } | null | undefined,
): PrintFieldState[] {
  const extraKeys = extraPrintFieldKeysForLeader(leader)
  const extraSet = new Set<string>(extraKeys)
  const seen = new Set<string>()
  const merged: PrintFieldState[] = []
  for (const field of fields) {
    if (seen.has(field.key)) continue
    if (EXTRA_PRINT_FIELD_KEYS.includes(field.key as PrintFieldKey) && !extraSet.has(field.key)) continue
    seen.add(field.key)
    merged.push({
      key: field.key as PrintFieldKey,
      enabled: field.enabled,
    })
  }
  for (const key of extraKeys) {
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ key, enabled: false })
  }
  return merged
}

export function printFieldDefsForLeader(leader: { notes?: string | null } | null | undefined): PrintFieldDef[] {
  const extraSet = new Set<string>(extraPrintFieldKeysForLeader(leader))
  return PRINT_FIELD_DEFS.filter((def) => !EXTRA_PRINT_FIELD_KEYS.includes(def.key) || extraSet.has(def.key))
}

export function defaultPrintFieldsForLeader(leader: { notes?: string | null } | null | undefined): PrintFieldState[] {
  return mergePrintFieldsForLeader(DEFAULT_PRINT_FIELDS, leader)
}

// ── Family grouping ────────────────────────────────────────────────────
// Mirrors the team-leader detail page grouping exactly: the only source of
// truth is `family_head_epic`, a voter with a NULL family_head_epic is a
// single-member family headed by itself, and members are sorted head-first
// then by display_order then by last update time.

export interface FamilyGroup {
  key: string
  head: string
  headVoter: Voter | null
  members: Voter[]
}

export function buildFamilies(rows: Voter[]): FamilyGroup[] {
  const groups = new Map<string, Voter[]>()

  for (const row of rows) {
    const linkedHead = normalizeLookupValue(row.family_head_epic)
    const key = linkedHead || normalizeLookupValue(row.epic_no)
    const members = groups.get(key)
    if (members) {
      members.push(row)
    } else {
      groups.set(key, [row])
    }
  }

  const families: FamilyGroup[] = Array.from(groups.entries()).map(([headEpic, members]) => {
    const sortedMembers = [...members].sort((a, b) => {
      const aIsHead = normalizeLookupValue(a.epic_no) === headEpic
      const bIsHead = normalizeLookupValue(b.epic_no) === headEpic
      if (aIsHead && !bIsHead) return -1
      if (!aIsHead && bIsHead) return 1
      if (a.display_order != null && b.display_order != null) return a.display_order - b.display_order
      if (a.display_order != null) return -1
      if (b.display_order != null) return 1
      const aTime = a.updated_at ?? a.created_at ?? ''
      const bTime = b.updated_at ?? b.created_at ?? ''
      return aTime.localeCompare(bTime)
    })

    const headVoter = sortedMembers.find((member) => normalizeLookupValue(member.epic_no) === headEpic) ?? sortedMembers[0] ?? null

    return {
      key: `GROUP|${headEpic}`,
      head: headEpic,
      headVoter,
      members: sortedMembers,
    }
  })

  families.sort((a, b) => (a.headVoter?.name ?? a.head).localeCompare(b.headVoter?.name ?? b.head))

  return families
}

// ── Cell value helpers ─────────────────────────────────────────────────

function vf(v: Voter, field: string): string {
  const value = (v as unknown as Record<string, unknown>)[field]
  return value === null || value === undefined ? '' : String(value)
}

function vfNum(v: Voter, field: string): number | null {
  const value = (v as unknown as Record<string, unknown>)[field]
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function formatDate(value: unknown): string {
  if (!value) return '-'
  try {
    const d = new Date(value as string)
    if (Number.isNaN(d.getTime())) return '-'
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return '-' }
}

// Resolve the best contact number for a voter. Falls back to a family member's
// number (head first, then by family display order) when the voter's own
// numbers are empty.
function resolveContact(voter: Voter, family?: FamilyGroup): { number: string; ownerName: string } {
  const own = vf(voter, 'contact_no_1') || vf(voter, 'contact_no_2')
  if (own) return { number: own, ownerName: vf(voter, 'name') || '' }
  if (family) {
    for (const member of family.members) {
      if (member.id === voter.id) continue
      const num = vf(member, 'contact_no_1') || vf(member, 'contact_no_2')
      if (num) return { number: num, ownerName: vf(member, 'name') || '' }
    }
  }
  return { number: '', ownerName: '' }
}

export function getPrintFieldValue(v: Voter, key: PrintFieldKey, family?: FamilyGroup, photoUrl?: string): string {
  switch (key) {
    case 'voterSrNo': return vf(v, 'sr_no_roll') || '-'
    case 'photo': return photoUrl ?? ''
    case 'name': return vf(v, 'name') || '-'
    case 'epicNo': return vf(v, 'epic_no') || '-'
    case 'status': return ''
    case 'relativeName': return vf(v, 'relative_name') || '-'
    case 'relation': return vf(v, 'relative_relation') || '-'
    case 'houseNo': return vf(v, 'house_no') || '-'
    case 'ward': { const n = vfNum(v, 'ward_no'); return n != null ? String(n) : '-' }
    case 'partNo': { const n = vfNum(v, 'part_no'); return n != null ? String(n) : '-' }
    case 'section': return vf(v, 'section') || '-'
    case 'sectionName': return vf(v, 'section_name') || '-'
    case 'age': { const n = vfNum(v, 'age'); return n != null ? String(n) : '-' }
    case 'gender': return vf(v, 'gender') || '-'
    case 'contact1': { const contact = resolveContact(v, family); return contact.number || '-' }
    case 'contact2': return vf(v, 'contact_no_2') || '-'
    case 'religion': return vf(v, 'religion') || '-'
    case 'dob': return formatDate(vf(v, 'date_of_birth')) || '-'
    case 'familyLabel': return vf(v, 'family_label') || family?.headVoter?.family_label || '-'
    case 'familyMembers': return family ? String(family.members.length) : ''
    case 'presence': {
      const status = v.presence_status
      const note = (v.presence_note || '').trim()
      if (status === 'ABROAD') return note ? `Abroad — ${note}` : 'Abroad'
      if (status === 'OUTSIDE_MORMUGAO') return note ? `Outside Mormugao — ${note}` : 'Outside Mormugao'
      if (status === 'IN_MORMUGAO') return note ? `In Mormugao — ${note}` : 'In Mormugao'
      return note || '-'
    }
    case 'srNo': return ''
    default: return '-'
  }
}

// ── Persisted detail-page print settings ───────────────────────────────
// The batch ZIP flow reuses the same keys the team-leader detail page saves
// its print configuration under, so the ZIP output matches what the user
// configured there.

export const DETAIL_PRINT_FIELDS_KEY = 'vote:teamleaderdetail:printFields:v7'
export const DETAIL_INCLUDE_FAMILY_MEMBERS_KEY = 'vote:teamleaderdetail:includeFamilyMembers'
export const DETAIL_PRINT_FONT_SIZE_KEY = 'vote:teamleaderdetail:printFontSize:v2'
export const DETAIL_PRINT_BOLD_KEY = 'vote:teamleaderdetail:printBold:v2'
export const DETAIL_PRINT_SHOW_HEADER_KEY = 'vote:teamleaderdetail:printShowHeaderDetails'

export interface DetailPdfSettings {
  fields: PrintFieldState[]
  includeFamilyMembers: boolean
  fontSize: number
  boldText: boolean
  showHeaderDetails: boolean
}

export function readDetailPdfSettings(storage: Pick<Storage, 'getItem'> | null = null): DetailPdfSettings {
  const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null)
  const read = <T,>(key: string, fallback: T): T => {
    if (!store) return fallback
    try {
      const raw = store.getItem(key)
      if (raw === null) return fallback
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }
  return {
    fields: read<PrintFieldState[]>(DETAIL_PRINT_FIELDS_KEY, DEFAULT_PRINT_FIELDS.map((f) => ({ ...f }))),
    includeFamilyMembers: read<boolean>(DETAIL_INCLUDE_FAMILY_MEMBERS_KEY, false),
    fontSize: read<number>(DETAIL_PRINT_FONT_SIZE_KEY, 20),
    boldText: read<boolean>(DETAIL_PRINT_BOLD_KEY, true),
    showHeaderDetails: read<boolean>(DETAIL_PRINT_SHOW_HEADER_KEY, false),
  }
}

// ── Fetch leader families ──────────────────────────────────────────────
// Moves the fetch logic that used to live in the detail page's load(): the
// leader row, its assigned voters (chunked by 150), every family member by
// family_head_epic (chunked by 200), the missing family heads by epic_no, and
// finally the merged family list. Ward restrictions are applied to the same
// queries the detail page filters (assigned voters + family members, not the
// heads lookup).

export interface FetchLeaderFamiliesOptions {
  hasWardRestriction: boolean
  allowedWards: number[]
}

export interface LeaderFamiliesData {
  leader: TeamLeader | null
  leaderVoter: Voter | null
  rows: Voter[]
  familyRows: Voter[]
  directVoterIds: string[]
  families: FamilyGroup[]
}

export async function fetchLeaderFamilies(
  leaderId: string,
  { hasWardRestriction, allowedWards }: FetchLeaderFamiliesOptions,
): Promise<LeaderFamiliesData> {
  const api = await fetchTeamLeaderFromApi(leaderId)
  const tl = teamLeaderFromApi(api.teamLeader)
  const leaderVoterRecord = voterFromApiLeader(api.teamLeader) ?? null
  const assignments = api.assignments ?? []
  const assigned = assignments.map(voterFromApiAssignment)
  const directIds = new Set(assignments.filter((a) => a.is_direct === true || a.is_direct === 1).map((a) => a.voter_id))

  // Family lookups must use the RAW stored epic values (family_head_epic /
  // epic_no), not the normalized forms - normalizing would make the .in()
  // filters match nothing for epics containing special characters. Grouping
  // happens later in buildFamilies, where normalization is safe.
  const groupKeys = new Set<string>()
  for (const v of assigned) {
    const raw = (v.family_head_epic ? v.family_head_epic.trim() : v.epic_no).trim()
    if (raw) groupKeys.add(raw)
  }
  const keys = Array.from(groupKeys)

  const members: Voter[] = keys.length
    ? await fetchInChunks<Voter>(keys, (chunk) => {
        let req = supabase.from('voters').select('*').in('family_head_epic', chunk)
        if (hasWardRestriction) req = req.in('ward_no', allowedWards)
        return req.order('family_head_epic', { ascending: true }).order('sr_no_roll', { ascending: true, nullsFirst: true })
      })
    : []

  const assignedEpics = new Set(assigned.map((v) => compactLookupValue(v.epic_no)))
  const missingHeads = keys.filter((k) => !assignedEpics.has(compactLookupValue(k)))
  const heads: Voter[] = missingHeads.length
    ? await fetchInChunks<Voter>(
        missingHeads,
        (chunk) => supabase.from('voters').select('*').in('epic_no', chunk).order('epic_no', { ascending: true }),
      )
    : []

  const seen = new Set<string>()
  const merged: Voter[] = []
  for (const v of [...members, ...heads]) {
    const key = compactLookupValue(v.epic_no)
    if (!key || seen.has(key)) continue
    if (assignedEpics.has(key)) continue
    seen.add(key)
    merged.push(v)
  }

  return {
    leader: tl,
    leaderVoter: leaderVoterRecord,
    rows: assigned,
    familyRows: merged,
    directVoterIds: Array.from(directIds),
    families: buildFamilies([...assigned, ...merged]),
  }
}

// Resolves signed photo URLs for a set of voters, mirroring how the detail
// page turns photo_url storage paths into fetchable URLs before embedding
// them in a PDF. Runs in bounded batches so it never fetches hundreds of
// signed URLs at once.
export async function resolvePhotoUrlsByPath(voters: Voter[]): Promise<Record<string, string>> {
  const paths = Array.from(new Set(voters.map((v) => v.photo_url).filter((p): p is string => Boolean(p))))
  const resolved: Record<string, string> = {}
  for (let i = 0; i < paths.length; i += 80) {
    const batch = paths.slice(i, i + 80)
    const { data } = await supabase.storage.from('voter-photos').createSignedUrls(batch, 3600)
    if (!data) continue
    for (let j = 0; j < batch.length; j++) {
      const url = data[j]?.signedUrl
      if (url) resolved[batch[j]] = url
    }
  }
  return resolved
}

// ── Build a leader PDF blob ────────────────────────────────────────────
// Reproduces the detail page's doDownloadPdf row building exactly: sequential
// Sr No, includeFamilyMembers = every member vs heads-only via the family
// representative logic, getPrintFieldValue for cell values. Returns the PDF
// as a Blob; the caller owns the filename/slug and how the file is saved.

export interface LeaderPdfSettings {
  fields: Array<{ key: string; enabled: boolean }>
  includeFamilyMembers: boolean
  fontSize: number
  boldText: boolean
  showHeaderDetails?: boolean
  assignedVoterIds: Set<string>
  directVoterIds: Set<string>
  resolvePhotoUrl: (voter: Voter | null | undefined) => string
}

export interface LeaderPdfBlobInput {
  leader: TeamLeader | null
  leaderVoter: Voter | null
  families: FamilyGroup[]
  settings: LeaderPdfSettings
  heading?: string
  placeGroups?: Array<{ label: string; families: FamilyGroup[] }>
}

function familyRepresentative(family: FamilyGroup, assignedVoterIds: Set<string>, directVoterIds: Set<string>): Voter | null {
  return (
    family.members.find((m) => assignedVoterIds.has(m.id) && directVoterIds.has(m.id))
    ?? (family.headVoter && assignedVoterIds.has(family.headVoter.id) ? family.headVoter : null)
    ?? family.members.find((m) => assignedVoterIds.has(m.id))
    ?? null
  )
}

export async function buildLeaderPdfBlob({ leader, leaderVoter, families, settings, heading, placeGroups }: LeaderPdfBlobInput): Promise<Blob> {
  const { fields, includeFamilyMembers, fontSize, boldText, assignedVoterIds, directVoterIds, resolvePhotoUrl } = settings
  const showHeaderDetails = settings.showHeaderDetails === true
  const enabled = fields.filter((field) => field.enabled)
  const leaderName = resolveTeamLeaderName(leader, leaderVoter)
  const rows: string[][] = []
  let sr = 1
  const addRow = (voter: Voter, family: FamilyGroup) => {
    rows.push(enabled.map((field) => {
      if (field.key === 'srNo') return String(sr)
      if (field.key === 'photo') return resolvePhotoUrl(voter)
      return getPrintFieldValue(voter, field.key as PrintFieldKey, family, resolvePhotoUrl(voter))
    }))
    sr += 1
  }
  const totalMembers = families.reduce((sum, f) => sum + f.members.length, 0)
  const maleCount = families.reduce((sum, f) => sum + f.members.filter((m) => (m.gender ?? '').toLowerCase() === 'male').length, 0)
  const femaleCount = families.reduce((sum, f) => sum + f.members.filter((m) => (m.gender ?? '').toLowerCase() === 'female').length, 0)

  const grouped = placeGroups?.length
    ? placeGroups
    : [{ label: '', families }]

  if (includeFamilyMembers) {
    grouped.forEach((group) => {
      if (group.label) rows.push([group.label, ...enabled.slice(1).map(() => '')])
      group.families.forEach((family) => family.members.forEach((member) => addRow(member, family)))
    })
  } else {
    grouped.forEach((group) => {
      if (group.label) rows.push([group.label, ...enabled.slice(1).map(() => '')])
      group.families.forEach((family) => {
        const representative = familyRepresentative(family, assignedVoterIds, directVoterIds)
        if (representative) addRow(representative, family)
      })
    })
  }

  return buildPdfTable({
    title: heading || `${leaderName} - Assigned Voters`,
    summary: showHeaderDetails ? ([
      ['Team Leader', leaderName],
      ['EPIC', leaderVoter?.epic_no ?? ''],
      ['Part / Section', leader ? `${leader.part_no ?? '-'} / ${leader.section ?? '-'}` : ''],
      ['Assigned Families', String(families.length)],
      ['Total Family Members', String(totalMembers)],
      ['Male / Female', `${maleCount} / ${femaleCount}`],
      ['Generated', new Date().toLocaleString()],
    ] as Array<[string, string]>).filter(([, value]) => Boolean(value)) : [],
    headers: enabled.map((field) => PRINT_FIELD_DEFS.find((definition) => definition.key === field.key)?.label ?? field.key),
    rows,
    fieldKeys: enabled.map((field) => field.key),
    fontSize,
    boldText,
    fileName: '',
    hideHeader: !showHeaderDetails,
  })
}

function escapePrintHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function getPrintColumnStyle(key: PrintFieldKey): string {
  switch (key) {
    case 'srNo': return 'width:46px;text-align:center;white-space:nowrap'
    case 'voterSrNo': return 'width:64px;text-align:center;white-space:nowrap'
    case 'photo': return 'width:64px;text-align:center;white-space:nowrap'
    case 'name': return 'min-width:130px'
    case 'epicNo': return 'width:90px;white-space:nowrap'
    case 'status': return 'width:60px;white-space:nowrap'
    case 'relativeName': return 'min-width:130px'
    case 'houseNo': return 'width:60px;text-align:center;white-space:nowrap'
    case 'ward': return 'width:50px;text-align:center;white-space:nowrap'
    case 'partNo': return 'width:54px;text-align:center;white-space:nowrap'
    case 'section': return 'width:60px;white-space:nowrap'
    case 'sectionName': return 'width:100px;white-space:nowrap'
    case 'age': return 'width:44px;text-align:center;white-space:nowrap'
    case 'gender': return 'width:60px;white-space:nowrap'
    case 'contact1': return 'width:90px;white-space:nowrap'
    case 'contact2': return 'width:90px;white-space:nowrap'
    case 'religion': return 'width:80px;white-space:nowrap'
    case 'dob': return 'width:88px;white-space:nowrap'
    case 'familyLabel': return 'width:90px;white-space:nowrap'
    case 'relation': return 'width:72px;white-space:nowrap'
    case 'familyMembers': return 'width:60px;text-align:center;white-space:nowrap'
    case 'presence': return 'min-width:140px'
    default: return ''
  }
}

export function getPrintColumnStyleWithWidths(key: PrintFieldKey, widths: Partial<Record<string, number>>): string {
  const base = getPrintColumnStyle(key)
  const width = widths[key]
  if (width == null) return base
  const withoutWidth = base
    .replace(/min-width:\d+px/, '')
    .replace(/width:\d+px/, '')
    .replace(/;;+/g, ';')
    .replace(/^;/, '')
    .replace(/;$/, '')
  return withoutWidth ? `${withoutWidth};width:${width}px` : `width:${width}px`
}

function leaderDisplayName(leader: TeamLeader | null, leaderVoter: Voter | null): string {
  return resolveTeamLeaderName(leader, leaderVoter)
}

export interface LeaderPrintSectionInput {
  leader: TeamLeader | null
  leaderVoter: Voter | null
  families: FamilyGroup[]
  settings: LeaderPdfSettings
  columnWidths?: Partial<Record<string, number>>
  heading?: string
  footer?: string
  placeGroups?: Array<{ label: string; families: FamilyGroup[] }>
}

export function buildLeaderPrintSectionHtml({
  leader,
  leaderVoter,
  families,
  settings,
  columnWidths,
  heading,
  footer,
  placeGroups,
}: LeaderPrintSectionInput): string {
  const { fields, includeFamilyMembers, assignedVoterIds, directVoterIds, resolvePhotoUrl } = settings
  const showHeaderDetails = settings.showHeaderDetails === true
  const enabled = fields.filter((field) => field.enabled)
  const widths = columnWidths ?? {}
  const leaderName = leaderDisplayName(leader, leaderVoter)
  const headerLabels = enabled.map((field) => PRINT_FIELD_DEFS.find((definition) => definition.key === field.key)?.label ?? field.key)

  const renderRow = (voter: Voter, family: FamilyGroup, sr: number, isHead: boolean) => {
    const photoUrl = resolvePhotoUrl(voter)
    const cells = enabled
      .map((field) => {
        const cellStyle = getPrintColumnStyleWithWidths(field.key as PrintFieldKey, widths)
        if (field.key === 'srNo') return `<td style="${cellStyle}">${sr}</td>`
        if (field.key === 'photo') {
          return `<td style="${cellStyle}">${photoUrl ? `<img class="photo" src="${escapePrintHtml(photoUrl)}" decoding="async" />` : ''}</td>`
        }
        return `<td style="${cellStyle}">${escapePrintHtml(getPrintFieldValue(voter, field.key as PrintFieldKey, family, photoUrl))}</td>`
      })
      .join('')
    return `<tr class="${isHead ? 'head-row' : ''}">${cells}</tr>`
  }

  const grouped = placeGroups?.length ? placeGroups : [{ label: '', families }]
  let tableHtml = ''
  let sr = 1
  for (const group of grouped) {
    if (group.label) tableHtml += `<h2 class="place-heading">${escapePrintHtml(group.label)}</h2>`
    tableHtml += `<table><thead><tr>${headerLabels.map((label) => `<th>${escapePrintHtml(label)}</th>`).join('')}</tr></thead><tbody>`
    if (includeFamilyMembers) {
      group.families.forEach((family, familyIndex) => {
        for (const member of family.members) {
          const isHead = compactLookupValue(member.epic_no) === compactLookupValue(family.head)
          tableHtml += renderRow(member, family, sr, isHead)
          sr += 1
        }
        if (familyIndex < group.families.length - 1) {
          tableHtml += `<tr class="family-spacer"><td colspan="${headerLabels.length}"></td></tr>`
        }
      })
    } else {
      for (const family of group.families) {
        const representative = familyRepresentative(family, assignedVoterIds, directVoterIds)
        if (!representative) continue
        tableHtml += renderRow(representative, family, sr, true)
        sr += 1
      }
    }
    tableHtml += '</tbody></table>'
  }

  const totalMembers = families.reduce((sum, family) => sum + family.members.length, 0)
  const maleCount = families.reduce((sum, family) => sum + family.members.filter((member) => (member.gender ?? '').toLowerCase() === 'male').length, 0)
  const femaleCount = families.reduce((sum, family) => sum + family.members.filter((member) => (member.gender ?? '').toLowerCase() === 'female').length, 0)
  const summaryItems: Array<[string, string]> = ([
    ['Team Leader', leaderName],
    ['EPIC', leaderVoter?.epic_no ?? ''],
    ['Part / Section', leader ? `${leader.part_no ?? '-'} / ${leader.section ?? '-'}` : ''],
    ['Assigned Families', String(families.length)],
    ['Total Family Members', String(totalMembers)],
    ['Male / Female', `${maleCount} / ${femaleCount}`],
    ['Generated', new Date().toLocaleString()],
  ] as Array<[string, string]>).filter(([, value]) => Boolean(value))

  const titleText = heading || `${leaderName} - Assigned Voters`
  const totalsFooter = footer ?? `Total Voters Assigned: ${totalMembers}    |    Total Families Assigned: ${families.length}`

  return `<div class="leader-section">
  <h1>${escapePrintHtml(titleText)}</h1>
  ${showHeaderDetails
    ? `<div class="summary">${summaryItems.map(([label, value]) => `<div class="summary-item"><span>${escapePrintHtml(label)}</span><strong>${escapePrintHtml(value)}</strong></div>`).join('')}</div>`
    : ''}
  ${tableHtml}
  <div class="print-footer">${escapePrintHtml(totalsFooter)}</div>
</div>`
}

export function wrapLeaderPrintDocument(sectionsHtml: string, fontSize: number, boldText: boolean, title: string): string {
  const photoSize = Math.max(10, Math.round(30 * (fontSize / 11)))
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapePrintHtml(title)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #111; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: 0.04em; }
  .summary { display: flex; flex-wrap: wrap; gap: 6px 24px; font-size: 12px; color: #333; margin-bottom: 16px; }
  .summary-item { display: flex; gap: 6px; align-items: baseline; }
  .summary-item span { color: #666; }
  .summary-item strong { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: ${fontSize}px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: middle; }
  th { background: #f0f0f0; }
  ${boldText ? 'th, td { font-weight: 700; }' : ''}
  .photo { width: ${photoSize}px; height: ${photoSize}px; object-fit: cover; border-radius: 50%; }
  .head-row { background: #f7f7f7; font-weight: 600; }
  .family-spacer td { border: none; padding: 4px; }
  .place-heading { font-size: 16px; margin: 18px 0 8px; }
  .print-footer { margin-top: 16px; padding-top: 10px; border-top: 2px solid #333; font-size: 13px; font-weight: 700; }
  .leader-section { page-break-after: always; break-after: page; }
  .leader-section:last-child { page-break-after: auto; break-after: auto; }
  @media print { tr { break-inside: avoid; } .print-footer { break-inside: avoid; } }
</style>
</head>
<body>
  ${sectionsHtml}
</body>
</html>`
}
