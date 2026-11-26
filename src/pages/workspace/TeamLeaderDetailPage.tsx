import React, { Fragment, useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ArrowLeft,
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  Columns3,
  Download,
  Eye,
  GripVertical,
  Loader2,
  MapPin,
  MoreHorizontal,
  Phone,
  Printer,
  RefreshCcw,
  RotateCcw,
  Search,
  Tags,
  Trash2,
  UserCog,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { ReportConfigModal, type ReportFieldItem } from '../../components/common/ReportConfigModal'
import { TransferFamilyConfirmModal, BulkTransferModal, formatLeaderNames } from '../../components/common/TransferFamilyConfirmModal'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import {
  saveBlob,
  openPrintWindow,
  type PrintStyleOptions,
} from '../../lib/reportBuilder'
import {
  fetchLeaderFamilies,
  buildLeaderPdfBlob,
  buildLeaderPrintSectionHtml,
  wrapLeaderPrintDocument,
  mergePrintFieldsForLeader,
  printFieldDefsForLeader,
  defaultPrintFieldsForLeader,
  DEFAULT_PRINT_FIELDS,
  type PrintFieldKey,
  type PrintFieldState,
  type LeaderFamiliesData,
} from '../../lib/leaderFamilyPdf'
import type { PlaceClub, TeamLeader, Voter } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { usePersistentState } from '../../hooks/usePersistentState'
import { fetchAllPages } from '../../hooks/useMeetingData'
import {
  buildTeamLeaderDetailScope,
  readTeamLeaderDetailCache,
  writeTeamLeaderDetailCache,
  clearTeamLeadersListCache,
  clearTeamLeaderDetailCache,
  clearUnassignedDataCache,
  isOfficeLeader,
  isShiftedLeader,
  isRentedLeader,
  isSpecialLeader,
  resolveTeamLeaderName,
  ensureOfficeLeader,
  ensureShiftedLeader,
  consolidateSpecialLeaders,
  canonicalSpecialLeaders,
  patchTeamLeadersListCacheForLeaders,
  specialLeaderIdSet,
  transferAssignments,
  assignFamilyToLeader,
  fetchAllAssignmentLinks,
  fetchTeamLeadersFromApi,
  teamLeaderFromApi,
  voterFromApiLeader,
  D1_IN_CHUNK,
  chunksOf,
  REFRESH_SKIP_MS,
} from '../../lib/teamLeaderCache'
import { fetchInChunks } from '../../lib/d1Query'
import { VOTER_CATEGORY_OPTIONS, voterCategoryLabel } from '../../lib/voterCategory'
import { FloatingDropdown } from '../../components/common/FloatingDropdown'
import {
  initials,
  compactLookupValue,
  tokenizeLookup,
  matchesLookupTokens,
  normalizeLookupValue,
  escapeIlikePattern,
  isLikelyEpicToken,
  highlightMatch,
} from '../../lib/searchUtils'
import { clubFamilies, familyGroupHeadKey, familyHeadKey, familyPlaceMap, fetchFamilyPlaceClubs, fetchPlaceClubs, groupFamiliesByPlace, placeClubFullLabel, placeClubLabel, unclubFamilies, upsertPlaceClub } from '../../lib/placeClubs'
import { PRESENCE_OPTIONS, familyPresence, hasPresenceOverride, presenceLabel, presenceNoteOf, presenceTabLabel } from '../../lib/presence'
import { PresencePicker } from '../../components/families/PresencePicker'
import type { PresenceStatus } from '../../lib/types'

const VISIBLE_COLUMNS_KEY = 'vote:teamleaderdetail:visibleColumns:v4'
const PAGE_SIZE_KEY = 'vote:teamleaderdetail:pageSize'
const PRINT_FIELDS_KEY = 'vote:teamleaderdetail:printFields:v7'
const INCLUDE_FAMILY_MEMBERS_KEY = 'vote:teamleaderdetail:includeFamilyMembers'
const PRINT_FONT_SIZE_KEY = 'vote:teamleaderdetail:printFontSize:v2'
const PRINT_BOLD_KEY = 'vote:teamleaderdetail:printBold:v2'
const PRINT_SHOW_HEADER_KEY = 'vote:teamleaderdetail:printShowHeaderDetails'
const EXPORT_BORDERS_KEY = 'vote:teamleaderdetail:exportBorders'
const EXPORT_ROW_HEIGHT_KEY = 'vote:teamleaderdetail:exportRowHeight'
const EXPORT_COL_WIDTH_KEY = 'vote:teamleaderdetail:exportColWidth'
const EXPORT_INCLUDE_PHOTOS_KEY = 'vote:teamleaderdetail:exportIncludePhotos'
const EXPORT_PHOTO_CONCURRENCY = 6
const EXPORT_PHOTO_WARN_ROW_COUNT = 80
const COLUMN_WIDTHS_KEY = 'vote:teamleaderdetail:columnWidths'
const COLUMN_RESIZE_MIN_WIDTH = 40

type MemberColumnKey =
  | 'srNo'
  | 'photo'
  | 'ward'
  | 'partNo'
  | 'section'
  | 'sectionName'
  | 'name'
  | 'status'
  | 'relativeName'
  | 'relation'
  | 'epicNo'
  | 'houseNo'
  | 'age'
  | 'dob'
  | 'contact1'
  | 'contact2'
  | 'gender'
  | 'religion'
  | 'familyLabel'
  | 'voterSrNo'
  | 'familyMembers'
  | 'category'
  | 'presence'

interface MemberColumnDef {
  key: MemberColumnKey
  label: string
  headerClass?: string
  sortable?: boolean
}

const MEMBER_COLUMNS: MemberColumnDef[] = [
  { key: 'srNo', label: 'Sr No', headerClass: 'w-14', sortable: false },
  { key: 'photo', label: 'Photo', headerClass: 'w-14', sortable: false },
  { key: 'ward', label: 'Ward', headerClass: 'w-20', sortable: true },
  { key: 'partNo', label: 'Part No', headerClass: 'w-20', sortable: true },
  { key: 'section', label: 'Section', headerClass: 'w-20', sortable: true },
  { key: 'sectionName', label: 'Section Name', headerClass: 'w-32', sortable: true },
  { key: 'name', label: 'Name', headerClass: 'min-w-[180px]', sortable: true },
  { key: 'status', label: 'Status', headerClass: 'w-20', sortable: false },
  { key: 'relativeName', label: 'Relative Name', headerClass: 'min-w-[180px]', sortable: true },
  { key: 'relation', label: 'Relation', headerClass: 'w-24', sortable: true },
  { key: 'epicNo', label: 'EPIC', headerClass: 'w-28', sortable: true },
  { key: 'houseNo', label: 'House No', headerClass: 'w-24', sortable: true },
  { key: 'age', label: 'Age', headerClass: 'w-16', sortable: true },
  { key: 'dob', label: 'Date of Birth', headerClass: 'w-28', sortable: true },
  { key: 'contact1', label: 'Contact No 1', headerClass: 'w-32', sortable: true },
  { key: 'contact2', label: 'Contact No 2', headerClass: 'w-32', sortable: true },
  { key: 'gender', label: 'Gender', headerClass: 'w-20', sortable: true },
  { key: 'religion', label: 'Religion', headerClass: 'w-24', sortable: true },
  { key: 'familyLabel', label: 'Family Label', headerClass: 'w-28', sortable: true },
  { key: 'voterSrNo', label: 'Voter Sr No', headerClass: 'w-20', sortable: true },
  { key: 'familyMembers', label: 'Family Members', headerClass: 'w-24', sortable: false },
  { key: 'category', label: 'Category', headerClass: 'min-w-[160px]', sortable: true },
  { key: 'presence', label: 'Presence', headerClass: 'min-w-[160px] max-w-[14rem]', sortable: true },
]

// Baseline pixel width per column, used to restore the default width when a
// column is dragged back to its starting size (mirrors the headerClass widths).
const DEFAULT_COLUMN_WIDTHS: Record<MemberColumnKey, number> = {
  srNo: 56,
  photo: 56,
  ward: 80,
  partNo: 80,
  section: 80,
  sectionName: 128,
  name: 180,
  status: 80,
  relativeName: 180,
  relation: 96,
  epicNo: 112,
  houseNo: 96,
  age: 64,
  dob: 112,
  contact1: 128,
  contact2: 128,
  gender: 80,
  religion: 96,
  familyLabel: 112,
  voterSrNo: 80,
  familyMembers: 96,
  category: 160,
  presence: 260,
}

const DEFAULT_VISIBLE_COLUMNS: MemberColumnKey[] = [
  'srNo',
  'photo',
  'name',
  'status',
  'category',
  'relativeName',
  'epicNo',
  'houseNo',
  'partNo',
  'section',
  'contact1',
  'familyMembers',
  'presence',
]

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

type SortDir = 'asc' | 'desc'

interface FamilyGroup {
  key: string
  head: string
  headVoter: Voter | null
  members: Voter[]
}

/**
 * Database-driven family grouping - the ONLY source of truth is
 * `family_head_epic`. Voters sharing the same family_head_epic belong to the
 * same family. A voter with a NULL family_head_epic is treated as a
 * single-member family headed by itself. The family head is the voter whose
 * epic_no equals the group's family_head_epic; if no such voter is present,
 * the first member is shown as the display head. Mirrors FamiliesPage.
 */
function buildFamilies(rows: Voter[]): FamilyGroup[] {
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

function formatDate(value: unknown): string {
  if (!value) return '-'
  try {
    const d = new Date(value as string)
    if (Number.isNaN(d.getTime())) return '-'
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return '-' }
}

interface FetchedExcelImage {
  base64: string
  extension: 'jpeg' | 'png' | 'gif'
  width: number
  height: number
}

// Fetches an image for embedding in an .xlsx export. Voter photos are served
// as webp (`t500`); ExcelJS only embeds jpeg/png/gif, so re-encode through a
// canvas the same way PDF export does. Returns null on any failure so callers
// can skip that cell quietly.
async function fetchImageForExcel(url: string): Promise<FetchedExcelImage | null> {
  if (!url) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    const bitmap = await createImageBitmap(blob)
    const maxPx = 200
    const scale = Math.min(maxPx / bitmap.width, maxPx / bitmap.height, 1)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close?.()
      return null
    }
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82)
    const comma = dataUrl.indexOf(',')
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
    if (!base64) return null
    return { base64, extension: 'jpeg', width, height }
  } catch {
    return null
  }
}

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

// Resolve the best contact number for a voter. Falls back to a family member's
// number (head first, then by family display order) when the voter's own
// numbers are empty. Returns the number and the name of its owner.
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

function getVoterFieldValue(v: Voter, key: MemberColumnKey, family?: FamilyGroup): string {
  switch (key) {
    case 'srNo': return ''
    case 'photo': return ''
    case 'ward': { const n = vfNum(v, 'ward_no'); return n != null ? String(n) : '-' }
    case 'partNo': { const n = vfNum(v, 'part_no'); return n != null ? String(n) : '-' }
    case 'section': return vf(v, 'section') || '-'
    case 'sectionName': return vf(v, 'section_name') || '-'
    case 'name': return vf(v, 'name') || '-'
    case 'status': return ''
    case 'relativeName': return vf(v, 'relative_name') || '-'
    case 'relation': return vf(v, 'relative_relation') || '-'
    case 'epicNo': return vf(v, 'epic_no') || '-'
    case 'houseNo': return vf(v, 'house_no') || '-'
    case 'age': { const n = vfNum(v, 'age'); return n != null ? String(n) : '-' }
    case 'dob': return formatDate(vf(v, 'date_of_birth')) || '-'
    case 'contact1': { const contact = resolveContact(v, family); return contact.number || '-' }
    case 'contact2': return vf(v, 'contact_no_2') || '-'
    case 'gender': return vf(v, 'gender') || '-'
    case 'religion': return vf(v, 'religion') || '-'
    case 'familyLabel': return vf(v, 'family_label') || family?.headVoter?.family_label || '-'
    case 'voterSrNo': return vf(v, 'sr_no_roll') || '-'
    case 'familyMembers': return family ? String(family.members.length) : ''
    case 'category': return voterCategoryLabel(v.voter_category) ?? '-'
    case 'presence': return presenceTabLabel(v.presence_status, presenceNoteOf(v))
    default: return '-'
  }
}

// Slim drag handle on the right edge of a table header that lets the user
// resize the column. The width is applied live to the <th> during the drag
// and committed to the parent via onResize on release.
function ColumnResizeHandle({ columnKey, onResize }: {
  columnKey: MemberColumnKey
  onResize: (key: MemberColumnKey, width: number) => void
}) {
  const startDrag = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const th = (event.currentTarget as HTMLElement).closest('th') as HTMLElement | null
    if (!th) return
    const startX = event.clientX
    const startWidth = th.getBoundingClientRect().width
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(COLUMN_RESIZE_MIN_WIDTH, Math.round(startWidth + ev.clientX - startX))
      th.style.width = `${next}px`
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      onResize(columnKey, Math.round(th.getBoundingClientRect().width))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
  }

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${columnKey} column`}
      onMouseDown={startDrag}
      className="absolute right-0 top-0 flex h-full w-3.5 cursor-col-resize items-center justify-center text-ink-tertiary opacity-0 transition hover:bg-brand-100/60 hover:text-brand-500 group-hover:opacity-100"
    >
      <GripVertical className="h-3.5 w-3.5" />
    </span>
  )
}

function voterSearchText(v: Voter): string {
  return [
    vf(v, 'name'), vf(v, 'epic_no'), vf(v, 'relative_name'), vf(v, 'relative_relation'),
    vf(v, 'contact_no_1'), vf(v, 'contact_no_2'), vf(v, 'section'), vf(v, 'section_name'), vf(v, 'house_no'),
    vf(v, 'gender'), vf(v, 'religion'), vf(v, 'family_label'), vf(v, 'voter_category'),
    vf(v, 'parked_address'), vf(v, 'presence_status'), vf(v, 'presence_note'),
    String(vfNum(v, 'ward_no') ?? ''), String(vfNum(v, 'part_no') ?? ''), String(vfNum(v, 'age') ?? ''),
  ].join(' ').toUpperCase()
}

function buildFamilyHeadEpic(voter: Voter): string {
  if (voter.family_head_epic) return normalizeLookupValue(voter.family_head_epic)
  return normalizeLookupValue(voter.epic_no)
}

function CheckboxUI({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border transition ${
        checked
          ? 'border-brand-500 bg-brand-500 text-white'
          : 'border-line bg-white hover:border-brand-400'
      }`}
      aria-checked={checked}
      role="checkbox"
    >
      {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
    </button>
  )
}

function VoterAvatar({ voter, photoUrl, size = 'md' }: { voter: Voter; photoUrl?: string; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'h-7 w-7 text-[9px]' : 'h-9 w-9 text-[10px]'
  if (photoUrl) {
    return <img src={photoUrl} alt={vf(voter, 'name')} className={`${dim} flex-shrink-0 rounded-full border border-line object-cover`} />
  }
  return (
    <span className={`${dim} inline-flex flex-shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700`}>
      {initials(vf(voter, 'name'))}
    </span>
  )
}

function IconButton({ onClick, title, variant = 'default', children, disabled }: {
  onClick: (e?: React.MouseEvent) => void; title: string; variant?: 'default' | 'danger' | 'primary'; children: React.ReactNode; disabled?: boolean
}) {
  const base = 'inline-flex h-9 w-9 items-center justify-center rounded-xl border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100 disabled:cursor-not-allowed disabled:opacity-50'
  const styles =
    variant === 'danger' ? 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100'
    : variant === 'primary' ? 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100'
    : 'border-line bg-white text-ink-secondary hover:bg-muted'
  return <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled} className={`${base} ${styles}`}>{children}</button>
}

function MoreMenu({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        title="More actions"
        aria-label="More actions"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-white text-ink-tertiary transition hover:bg-muted hover:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-48 rounded-xl border border-line bg-white p-1.5 shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function ColumnsDropdown({ visible, onChange }: { visible: MemberColumnKey[]; onChange: (next: MemberColumnKey[]) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const visibleSet = new Set(visible)

  const toggle = (key: MemberColumnKey) => {
    const next = new Set(visibleSet)
    if (next.has(key)) {
      if (next.size <= 1) { toast.error('At least one column must remain visible.'); return }
      next.delete(key)
    } else { next.add(key) }
    onChange(MEMBER_COLUMNS.map((c) => c.key).filter((k) => next.has(k)))
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted">
        <Columns3 className="h-3.5 w-3.5" /> Display Columns
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-line bg-white p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Show / Hide Columns</p>
          <div className="max-h-[60vh] space-y-0.5 overflow-y-auto">
            {MEMBER_COLUMNS.map((col) => {
              const checked = visibleSet.has(col.key)
              return (
                <label key={col.key} className={`flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-sm transition ${checked ? 'bg-brand-50 text-brand-800' : 'text-ink-secondary hover:bg-muted'}`}>
                  <CheckboxUI checked={checked} onChange={() => toggle(col.key)} />
                  <span>{col.label}</span>
                </label>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}


function BulkUnassignModal({ open, familyCount, voterCount, removing, onClose, onConfirm }: {
  open: boolean
  familyCount: number
  voterCount: number
  removing: boolean
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [confirmText, setConfirmText] = useState('')
  useEffect(() => { setConfirmText('') }, [open])
  if (!open) return null

  const matches = confirmText.trim().toUpperCase() === 'UNASSIGN'

  const confirm = async () => {
    if (!matches || removing) return
    await onConfirm()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
              <Trash2 className="h-4 w-4" />
            </span>
            <h3 className="text-lg font-semibold text-ink">Unassign families</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-sm leading-6 text-ink-secondary">
          This unlinks {familyCount} famil{familyCount === 1 ? 'y' : 'ies'} ({voterCount} voter{voterCount === 1 ? '' : 's'}) from this team leader. This cannot be undone. Type <span className="font-semibold text-ink">UNASSIGN</span> to confirm.
        </p>
        <label className="mt-4 block text-sm text-ink-secondary">
          Type <span className="font-semibold text-ink">&ldquo;UNASSIGN&rdquo;</span> to confirm
          <input autoFocus className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
            value={confirmText} onChange={(e) => setConfirmText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void confirm() }} />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
          <button type="button" disabled={!matches || removing} onClick={() => void confirm()}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-rose-600 px-5 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50">
            {removing && <Loader2 className="h-4 w-4 animate-spin" />} Unassign
          </button>
        </div>
      </div>
    </div>
  )
}

// ── ChangePrimaryVoterModal ─────────────────────────────────────────────

function ChangePrimaryVoterModal({ open, family, assignedIds, directVoterIds, saving, resolvePhotoUrl, onClose, onConfirm }: {
  open: boolean
  family: FamilyGroup | null
  assignedIds: Set<string>
  directVoterIds: Set<string>
  saving: boolean
  resolvePhotoUrl: (voter: Voter | null | undefined) => string
  onClose: () => void
  onConfirm: (family: FamilyGroup, memberId: string) => void
}) {
  const members = family ? family.members.filter((m) => assignedIds.has(m.id)) : []
  const currentId = family
    ? family.members.find((m) => assignedIds.has(m.id) && directVoterIds.has(m.id))?.id
    : ''
  const [selectedId, setSelectedId] = useState<string>('')

  useEffect(() => {
    if (family) setSelectedId(currentId ?? members[0]?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family])

  if (!open || !family) return null

  const canConfirm = selectedId !== '' && selectedId !== currentId && !saving

  const confirm = () => {
    if (!selectedId) return
    onConfirm(family, selectedId)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div>
            <h3 className="text-lg font-semibold text-ink">Set Primary Member</h3>
            <p className="mt-1 text-xs text-ink-tertiary">
              Choose which family member represents this family for this team leader. Used in the table and in export/print &ldquo;heads only&rdquo;.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>

        <div className="max-h-[55vh] space-y-2 overflow-y-auto px-6 py-4">
          {members.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-tertiary">No assigned members in this family.</p>
          ) : (
            members.map((member) => {
              const isCurrent = currentId === member.id
              const selected = selectedId === member.id
              return (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => setSelectedId(member.id)}
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
                    selected ? 'border-brand-400 bg-brand-50/60 ring-2 ring-brand-100' : 'border-line hover:border-brand-300 hover:bg-brand-50/40'
                  }`}
                >
                  <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border ${selected ? 'border-brand-500 bg-brand-500' : 'border-line bg-white'}`}>
                    {selected && <span className="h-2 w-2 rounded-full bg-white" />}
                  </span>
                  <VoterAvatar voter={member} photoUrl={resolvePhotoUrl(member)} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{member.name}</p>
                    <p className="truncate text-xs text-ink-tertiary">
                      EPIC: {member.epic_no || '-'}{member.relative_name ? ` · ${member.relative_name}` : ''}{member.relative_relation ? ` (${member.relative_relation})` : ''}
                    </p>
                  </div>
                  {isCurrent && (
                    <span className="inline-flex flex-shrink-0 items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">Current</span>
                  )}
                </button>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
          <span className="text-xs text-ink-tertiary">{members.length} assigned member{members.length === 1 ? '' : 's'}</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={confirm}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCog className="h-4 w-4" />} Set Primary
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ChangeLeaderModal({
  open,
  currentLeader,
  hasWardRestriction,
  allowedWards,
  saving,
  onClose,
  onConfirm,
}: {
  open: boolean
  currentLeader: TeamLeader | null
  hasWardRestriction: boolean
  allowedWards: number[]
  saving: boolean
  onClose: () => void
  onConfirm: (newLeader: Voter, partNo: string, section: string) => void
}) {
  const [voterQuery, setVoterQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<Voter[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [partNo, setPartNo] = useState('')
  const [section, setSection] = useState('')
  const [otherLeaderVoterIds, setOtherLeaderVoterIds] = useState<Set<string>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setVoterQuery('')
    setSearchResults([])
    setSearching(false)
    setShowDropdown(false)
    setSelectedVoter(null)
    setPartNo(currentLeader?.part_no != null ? String(currentLeader.part_no) : '')
    setSection(currentLeader?.section != null ? String(currentLeader.section) : '')
    const run = async () => {
      const { data: tls } = await supabase.from('team_leaders').select('id, voter_id')
      if (cancelled) return
      const ids = new Set<string>()
      for (const tl of (tls as Array<{ id: string; voter_id: string }> | null) ?? []) {
        if (tl.id !== currentLeader?.id && tl.voter_id) ids.add(tl.voter_id)
      }
      setOtherLeaderVoterIds(ids)
    }
    void run()
    return () => { cancelled = true }
  }, [open, currentLeader])

  useEffect(() => {
    if (!voterQuery.trim()) { setSearchResults([]); setSearching(false); return }
    let cancelled = false
    const run = async () => {
      setSearching(true)
      const trimmed = voterQuery.trim()
      const searchTokens = tokenizeLookup(trimmed)

      if (searchTokens.length === 1 && isLikelyEpicToken(searchTokens[0])) {
        const epicToken = compactLookupValue(searchTokens[0])
        let exactReq = supabase.from('voters').select('*').eq('epic_no', epicToken)
        if (hasWardRestriction) exactReq = exactReq.in('ward_no', allowedWards)
        const { data: exactRow } = await exactReq.maybeSingle()
        if (cancelled) return
        setSearchResults(exactRow ? [exactRow as Voter] : [])
        setSearching(false)
        return
      }

      const sp = `%${escapeIlikePattern(trimmed).replace(/\s+/g, '%')}%`
      let req = supabase.from('voters').select('*').or([`name.ilike.${sp}`,`relative_name.ilike.${sp}`,`epic_no.ilike.${sp}`,`contact_no_1.ilike.${sp}`,`house_no.ilike.${sp}`].join(',')).limit(20)
      if (hasWardRestriction) req = req.in('ward_no', allowedWards)
      const { data: matches } = await req
      if (cancelled) return
      setSearchResults((matches as Voter[] | null) ?? [])
      setSearching(false)
    }
    void run()
    return () => { cancelled = true }
  }, [voterQuery, hasWardRestriction, allowedWards])

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(e.target as Node)) setShowDropdown(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selectVoter = (v: Voter) => {
    if (v.id === currentLeader?.voter_id) {
      toast.error('This voter is already the current team leader.')
      return
    }
    if (otherLeaderVoterIds.has(v.id)) {
      toast.error('This voter is already a team leader.')
      return
    }
    setSelectedVoter(v)
    setPartNo(v.part_no != null ? String(v.part_no) : '')
    setSection(v.section != null ? String(v.section) : '')
    setVoterQuery('')
    setSearchResults([])
    setShowDropdown(false)
  }

  const tokens = useMemo(() => tokenizeLookup(voterQuery), [voterQuery])

  const confirm = () => {
    if (!selectedVoter) { toast.error('Select a voter first.'); return }
    onConfirm(selectedVoter, partNo, section)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div>
            <h3 className="text-lg font-semibold text-ink">{currentLeader?.voter_id ? 'Change Team Leader' : 'Link Team Leader to a Voter'}</h3>
            <p className="mt-1 text-xs text-ink-tertiary">
              {currentLeader?.voter_id
                ? 'Replace the person leading this team. Assigned voters stay untouched - only the leader itself changes.'
                : 'Attach a voter to this named team leader. Assigned families stay on this leader.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-4 px-6 py-4">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">New Team Leader Voter</label>
            <div ref={containerRef} className="relative">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
                <input
                  className="h-11 w-full rounded-xl border border-line bg-white pl-10 pr-10 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  placeholder="Search by name, EPIC, relative name, mobile, house number..."
                  value={voterQuery}
                  onChange={(e) => { setVoterQuery(e.target.value); if (!showDropdown) setShowDropdown(true) }}
                  onFocus={() => { if (voterQuery.trim()) setShowDropdown(true) }}
                />
                {voterQuery && (
                  <button type="button" onClick={() => { setVoterQuery(''); setSearchResults([]) }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear search">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              {showDropdown && voterQuery.trim() && searching && (
                <div className="absolute z-20 mt-2 w-full rounded-xl border border-line bg-white p-4">
                  <div className="flex items-center justify-center gap-2 text-sm text-ink-tertiary"><Loader2 className="h-4 w-4 animate-spin" /> Searching...</div>
                </div>
              )}

              {showDropdown && voterQuery.trim() && !searching && searchResults.length > 0 && (
                <div className="absolute z-20 mt-2 w-full max-h-[50vh] overflow-y-auto rounded-xl border border-line bg-white p-3">
                  <div className="space-y-1.5">
                    {searchResults.map((v) => {
                      const isCurrent = v.id === currentLeader?.voter_id
                      const alreadyLeader = otherLeaderVoterIds.has(v.id)
                      const blocked = isCurrent || alreadyLeader
                      return (
                        <button
                          key={v.id}
                          type="button"
                          disabled={blocked}
                          onClick={() => selectVoter(v)}
                          className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${blocked ? 'cursor-not-allowed opacity-50' : 'border-line hover:border-brand-300 hover:bg-brand-50/40'}`}
                        >
                          <VoterAvatar voter={v} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-ink">
                              {highlightMatch(v.name, tokens)}
                              {isCurrent && <span className="ml-2 inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-ink-secondary">Current Leader</span>}
                              {alreadyLeader && <span className="ml-2 inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">Already Leader</span>}
                            </p>
                            <p className="truncate text-xs text-ink-tertiary">
                              EPIC: {highlightMatch(v.epic_no, tokens)}{v.part_no != null ? ` · Part ${v.part_no}` : ''}{v.section != null ? ` / Sec ${v.section}` : ''}
                            </p>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {showDropdown && voterQuery.trim() && !searching && searchResults.length === 0 && (
                <div className="absolute z-20 mt-2 w-full rounded-xl border border-line bg-white p-4 text-center text-sm text-ink-tertiary">
                  No voters found.
                </div>
              )}
            </div>
          </div>

          {selectedVoter && (
            <div className="rounded-xl border border-line bg-muted/50 p-4">
              <div className="flex flex-wrap items-start gap-4">
                <VoterAvatar voter={selectedVoter} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">{selectedVoter.name}</p>
                  <p className="text-xs text-ink-tertiary">
                    EPIC: {selectedVoter.epic_no}{selectedVoter.part_no != null ? ` Part: ${selectedVoter.part_no}` : ''}{selectedVoter.section != null ? ` Section: ${selectedVoter.section}` : ''}
                  </p>
                </div>
                <button type="button" onClick={() => setSelectedVoter(null)}
                  className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear selection">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Part No</label>
                  <input
                    className="h-10 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                    value={partNo}
                    onChange={(e) => setPartNo(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="e.g. 5"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Section</label>
                  <input
                    className="h-10 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                    value={section}
                    onChange={(e) => setSection(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="e.g. 2"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
          <span className="text-xs text-ink-tertiary">
            {selectedVoter ? `Change leader to ${selectedVoter.name}` : 'Select a voter to become the new leader.'}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
            <button
              type="button"
              disabled={!selectedVoter || saving}
              onClick={confirm}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCog className="h-4 w-4" />} {currentLeader?.voter_id ? 'Change Leader' : 'Link voter'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── RemoveAssignmentModal ──────────────────────────────────────────────

function RemoveAssignmentModal({ voter, voterCount, onClose, onConfirm }: {
  voter: Voter | null
  voterCount: number
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [confirmName, setConfirmName] = useState('')
  const [removing, setRemoving] = useState(false)
  useEffect(() => { setConfirmName('') }, [voter])
  if (!voter) return null

  const voterName = voter.name ?? ''
  const matches = confirmName.trim().toLowerCase() === voterName.trim().toLowerCase()

  const confirm = async () => {
    if (!matches || removing) return
    setRemoving(true)
    await onConfirm()
    setRemoving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
              <Trash2 className="h-4 w-4" />
            </span>
            <h3 className="text-lg font-semibold text-ink">Remove assignment</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-sm leading-6 text-ink-secondary">
          This unlinks <span className="font-semibold text-ink">&ldquo;{voterName}&rdquo;</span>
          {voterCount > 1 && <span> and their family ({voterCount} voters)</span>} from this team leader&rsquo;s assigned voters. This cannot be undone. To confirm, type the voter&rsquo;s name below.
        </p>
        <label className="mt-4 block text-sm text-ink-secondary">
          Type <span className="font-semibold text-ink">&ldquo;{voterName}&rdquo;</span> to confirm
          <input autoFocus className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
            value={confirmName} onChange={(e) => setConfirmName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void confirm() }} />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
          <button type="button" disabled={!matches || removing} onClick={() => void confirm()}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-rose-600 px-5 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50">
            {removing && <Loader2 className="h-4 w-4 animate-spin" />} Remove assignment
          </button>
        </div>
      </div>
    </div>
  )
}

export function TeamLeaderDetailPage() {
  const { leaderId } = useParams<{ leaderId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { profile, isAdminAreaAllowed, loading: authLoading } = useAuth()

  const leaderListQuery = useMemo(() => (searchParams.toString() ? `?${searchParams.toString()}` : ''), [searchParams])

  const initialCached = useMemo(() => {
    if (!leaderId) return null
    const scope = buildTeamLeaderDetailScope(leaderId, profile?.role ?? null, profile?.allowed_wards ?? null)
    return readTeamLeaderDetailCache(scope)
  }, [leaderId, profile?.role, profile?.allowed_wards])

  const [leader, setLeader] = useState<TeamLeader | null>(initialCached?.data.leader ?? null)
  const [leaderList, setLeaderList] = useState<TeamLeader[]>([])
  const [leaderVoter, setLeaderVoter] = useState<Voter | null>(initialCached?.data.leaderVoter ?? null)
  const [rows, setRows] = useState<Voter[]>(initialCached?.data.rows ?? [])
  const [familyRows, setFamilyRows] = useState<Voter[]>(initialCached?.data.familyRows ?? [])
  const [loading, setLoading] = useState(!initialCached)
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>({})
  const photoUrlByPathRef = useRef(photoUrlByPath)
  photoUrlByPathRef.current = photoUrlByPath

  const [visibleColumns, setVisibleColumns] = usePersistentState<MemberColumnKey[]>(VISIBLE_COLUMNS_KEY, [...DEFAULT_VISIBLE_COLUMNS])
  const [pageSize, setPageSize] = usePersistentState<number>(PAGE_SIZE_KEY, 25)
  const [printFields, setPrintFields] = usePersistentState<PrintFieldState[]>(PRINT_FIELDS_KEY, DEFAULT_PRINT_FIELDS.map((f) => ({ ...f })))
  const [includeFamilyMembers, setIncludeFamilyMembers] = usePersistentState<boolean>(INCLUDE_FAMILY_MEMBERS_KEY, false)
  const [printFontSize, setPrintFontSize] = usePersistentState<number>(PRINT_FONT_SIZE_KEY, 20)
  const [printBold, setPrintBold] = usePersistentState<boolean>(PRINT_BOLD_KEY, true)
  const [printShowHeader, setPrintShowHeader] = usePersistentState<boolean>(PRINT_SHOW_HEADER_KEY, false)
  const [exportBorders, setExportBorders] = usePersistentState<boolean>(EXPORT_BORDERS_KEY, true)
  const [exportRowHeight, setExportRowHeight] = usePersistentState<number>(EXPORT_ROW_HEIGHT_KEY, 18)
  const [exportColWidth, setExportColWidth] = usePersistentState<number>(EXPORT_COL_WIDTH_KEY, 16)
  const [exportIncludePhotos, setExportIncludePhotos] = usePersistentState<boolean>(EXPORT_INCLUDE_PHOTOS_KEY, false)
  const [showFamilyMembers, setShowFamilyMembers] = usePersistentState<boolean>('vote:teamleaderdetail:showFamilyMembers', false)
  const [columnWidths, setColumnWidths] = usePersistentState<Partial<Record<MemberColumnKey, number>>>(COLUMN_WIDTHS_KEY, {})

  const [remainingOpen, setRemainingOpen] = useState(false)
  const [remainingLoading, setRemainingLoading] = useState(false)
  const [remainingRows, setRemainingRows] = useState<Voter[]>([])
  const [selectedRemainingFamilyKeys, setSelectedRemainingFamilyKeys] = useState<Set<string>>(new Set())

  const [directVoterIds, setDirectVoterIds] = useState<Set<string>>(() => new Set(initialCached?.data.directVoterIds ?? []))
  const [expandedFamilyKeys, setExpandedFamilyKeys] = useState<Set<string>>(new Set())
  const [printSelectedFamilyKeys, setPrintSelectedFamilyKeys] = useState<Set<string>>(new Set())
  const [familySizeFilter, setFamilySizeFilter] = useState<number | null>(null)
  const [detailPartFilter, setDetailPartFilter] = useState('')
  const [detailSectionFilter, setDetailSectionFilter] = useState('')
  const [detailReligionFilter, setDetailReligionFilter] = useState('')
  const [detailStateFilter, setDetailStateFilter] = useState('')

  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<MemberColumnKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [page, setPage] = useState(1)

  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState<'print' | 'export'>('print')
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [changeLeaderOpen, setChangeLeaderOpen] = useState(false)
  const [savingLeader, setSavingLeader] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<Voter | null>(null)
  const [removeTargetCount, setRemoveTargetCount] = useState(1)
  const [bulkUnassignOpen, setBulkUnassignOpen] = useState(false)
  const [removingBulk, setRemovingBulk] = useState(false)
  const [primaryTarget, setPrimaryTarget] = useState<FamilyGroup | null>(null)
  const [savingPrimary, setSavingPrimary] = useState(false)

  const [assignQuery, setAssignQuery] = useState('')
  const [assignResults, setAssignResults] = useState<Voter[]>([])
  const [assignFamilyRows, setAssignFamilyRows] = useState<Voter[]>([])
  const [assignSearching, setAssignSearching] = useState(false)
  const [assignDropdownOpen, setAssignDropdownOpen] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [assignTransferring, setAssignTransferring] = useState(false)
  const [assignTransferTarget, setAssignTransferTarget] = useState<{ family: FamilyGroup; sourceLeaderIds: string[] } | null>(null)
  const [assignPresenceStatus, setAssignPresenceStatus] = useState<PresenceStatus | ''>('')
  const [assignPresenceNote, setAssignPresenceNote] = useState('')
  const [presenceMenuFamily, setPresenceMenuFamily] = useState<string | null>(null)
  const [presenceAnchor, setPresenceAnchor] = useState<HTMLButtonElement | null>(null)
  const [savingPresenceFamilyKey, setSavingPresenceFamilyKey] = useState<string | null>(null)
  const [presenceMenuMember, setPresenceMenuMember] = useState<string | null>(null)
  const [presenceMemberAnchor, setPresenceMemberAnchor] = useState<HTMLButtonElement | null>(null)
  const [categoryMenuFamily, setCategoryMenuFamily] = useState<string | null>(null)
  const [categoryAnchor, setCategoryAnchor] = useState<HTMLButtonElement | null>(null)
  const [savingCategoryFamilyKey, setSavingCategoryFamilyKey] = useState<string | null>(null)
  const [bulkCategoryMenuOpen, setBulkCategoryMenuOpen] = useState(false)
  const [bulkCategoryAnchor, setBulkCategoryAnchor] = useState<HTMLButtonElement | null>(null)
  const [savingBulkCategory, setSavingBulkCategory] = useState(false)
  const [bulkPlaceMenuOpen, setBulkPlaceMenuOpen] = useState(false)
  const [bulkPlaceAnchor, setBulkPlaceAnchor] = useState<HTMLButtonElement | null>(null)
  const [savingBulkPlace, setSavingBulkPlace] = useState(false)
  const [newPlaceArea, setNewPlaceArea] = useState('')
  const [newPlaceChawl, setNewPlaceChawl] = useState('')
  const [newPlaceBuilding, setNewPlaceBuilding] = useState('')
  const canEditVoter = profile?.role === 'admin' || profile?.can_edit === true
  const [placeClubs, setPlaceClubs] = useState<PlaceClub[]>([])
  const [familyPlaceByHead, setFamilyPlaceByHead] = useState<Record<string, string>>({})
  const [placeFilter, setPlaceFilter] = useState('all')
  const [printGroupByPlace, setPrintGroupByPlace] = usePersistentState<boolean>('vote:teamleaderdetail:printGroupByPlace', false)
  const assignRef = useRef<HTMLDivElement>(null)
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const topScrollRef = useRef<HTMLDivElement>(null)
  const topScrollInnerRef = useRef<HTMLDivElement>(null)
  const tableElRef = useRef<HTMLTableElement>(null)
  const syncingScrollRef = useRef(false)
  const [tableOverflowsX, setTableOverflowsX] = useState(false)

  const [voterToLeaderId, setVoterToLeaderId] = useState<Record<string, string>>(initialCached?.data.voterToLeaderId ?? {})
  const [leaderNameById, setLeaderNameById] = useState<Record<string, string>>({})

  const allowedWards = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((w) => Number.isFinite(w))))
    wards.sort((a, b) => a - b)
    return wards
  }, [profile?.allowed_wards])
  const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0

  const load = useCallback(async (forceRefresh = false) => {
    if (!leaderId) {
      setLoading(false)
      return
    }
    const consolidation = await consolidateSpecialLeaders()
    const redirectedId = consolidation.office.deletedIds.includes(leaderId)
      ? consolidation.office.winnerId
      : consolidation.shifted.deletedIds.includes(leaderId)
        ? consolidation.shifted.winnerId
        : null
    if (redirectedId && redirectedId !== leaderId) {
      const qs = typeof window !== 'undefined' ? window.location.search : ''
      navigate(`/team-leaders/${redirectedId}${qs}`, { replace: true })
      return
    }
    if (consolidation.changed) {
      clearTeamLeadersListCache()
      clearUnassignedDataCache()
    }
    const detailScope = buildTeamLeaderDetailScope(leaderId, profile?.role ?? null, profile?.allowed_wards ?? null)
    const cached = consolidation.changed || forceRefresh ? null : readTeamLeaderDetailCache(detailScope)
    if (cached) {
      if (isRentedLeader(cached.data.leader)) {
        navigate(`/team-leaders${typeof window !== 'undefined' ? window.location.search : ''}`, { replace: true })
        return
      }
      setLeader(cached.data.leader)
      setLeaderVoter(cached.data.leaderVoter)
      setRows(cached.data.rows)
      setFamilyRows(cached.data.familyRows)
      setDirectVoterIds(new Set(cached.data.directVoterIds))
      setVoterToLeaderId(cached.data.voterToLeaderId)
      setLoading(false)
      if (Date.now() - cached.savedAt < REFRESH_SKIP_MS) return
    } else {
      setLoading(true)
    }

    // Load the leader, their assigned voters and the complete family list
    // through the shared helper so the batch "Download All (ZIP)" flow on the
    // list page produces exactly the same data. The full assignment map is
    // still fetched here (and only here) to power the "already assigned to X"
    // hints on this page.
    let familyData: LeaderFamiliesData
    const vToL: Record<string, string> = {}
    try {
      const [allAssignRes, fam] = await Promise.all([
        fetchAllAssignmentLinks(),
        fetchLeaderFamilies(leaderId, { hasWardRestriction, allowedWards }),
      ])
      familyData = fam

      if (allAssignRes.error) toast.error(allAssignRes.error)
      for (const a of allAssignRes.data) {
        if (a.voter_id) vToL[a.voter_id] = a.team_leader_id
      }
      setVoterToLeaderId(vToL)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load team leader data.')
      setLoading(false)
      return
    }

    if (isRentedLeader(familyData.leader)) {
      navigate(`/team-leaders${typeof window !== 'undefined' ? window.location.search : ''}`, { replace: true })
      return
    }

    setLeader(familyData.leader)
    setLeaderVoter(familyData.leaderVoter)
    setRows(familyData.rows)
    setFamilyRows(familyData.familyRows)
    setDirectVoterIds(new Set(familyData.directVoterIds))

    setLoading(false)
    writeTeamLeaderDetailCache(detailScope, {
      leader: familyData.leader,
      leaderVoter: familyData.leaderVoter,
      rows: familyData.rows,
      familyRows: familyData.familyRows,
      directVoterIds: familyData.directVoterIds,
      voterToLeaderId: vToL,
    })
  }, [leaderId, profile?.role, profile?.allowed_wards, hasWardRestriction, allowedWards, navigate])

  useEffect(() => {
    if (!authLoading) void load()
  }, [load, authLoading])

  // After a mutation on this page, the team-leaders list page and the
  // not-assigned page must not show stale cached counts. Patch the list cache
  // for the affected leaders (so returning to the list is instant and correct)
  // and clear the unassigned cache so it refetches on next visit.
  const syncOtherPagesAfterMutation = useCallback(async (affectedLeaderIds: string[]) => {
    clearUnassignedDataCache()
    await patchTeamLeadersListCacheForLeaders(profile?.role ?? null, profile?.allowed_wards ?? null, affectedLeaderIds)
  }, [profile?.role, profile?.allowed_wards])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const [office, shifted] = await Promise.all([ensureOfficeLeader(), ensureShiftedLeader()])
      if (cancelled) return
      const consolidation = await consolidateSpecialLeaders()
      if (cancelled) return
      if (office?.created || shifted?.created || consolidation.changed) {
        clearTeamLeadersListCache()
        clearTeamLeaderDetailCache()
        clearUnassignedDataCache()
      }
      const apiRows = await fetchTeamLeadersFromApi()
      if (cancelled) return
      setLeaderList(apiRows.map(teamLeaderFromApi).filter((tl) => !isRentedLeader(tl)))
      const next: Record<string, string> = {}
      for (const row of apiRows) {
        next[row.id] = resolveTeamLeaderName(row, row.voter_name ? { name: row.voter_name } : voterFromApiLeader(row))
      }
      setLeaderNameById(next)
    }
    void run()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [clubs, links] = await Promise.all([fetchPlaceClubs(), fetchFamilyPlaceClubs()])
        if (cancelled) return
        setPlaceClubs(clubs)
        setFamilyPlaceByHead(familyPlaceMap(links))
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Could not load places.')
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Shifted/Single leader ids - families parked under them still count as
  // "remaining" (they have no real field team leader).
  const specialLeaderIds = useMemo(() => specialLeaderIdSet(leaderList), [leaderList])
  const navLeaders = useMemo(() => canonicalSpecialLeaders(leaderList), [leaderList])

  const leaderListIndex = useMemo(() => navLeaders.findIndex((tl) => tl.id === leaderId), [navLeaders, leaderId])
  const prevLeaderId = leaderListIndex > 0 ? navLeaders[leaderListIndex - 1]?.id : null
  const nextLeaderId = leaderListIndex >= 0 && leaderListIndex < navLeaders.length - 1 ? navLeaders[leaderListIndex + 1]?.id : null

  const families = useMemo(() => buildFamilies([...rows, ...familyRows]), [rows, familyRows])
  const placeClubById = useMemo(() => {
    const map = new Map<string, PlaceClub>()
    for (const club of placeClubs) map.set(club.id, club)
    return map
  }, [placeClubs])

  const familySizeDistribution = useMemo(() => {
    const counts = new Map<number, number>()
    for (const family of families) {
      const size = family.members.length
      counts.set(size, (counts.get(size) ?? 0) + 1)
    }
    return Array.from(counts.entries()).sort((a, b) => a[0] - b[0])
  }, [families])
  const familyByEpic = useMemo(() => {
    const m = new Map<string, FamilyGroup>()
    for (const f of families) m.set(normalizeLookupValue(f.head), f)
    return m
  }, [families])

  const familyForVoter = useCallback((v: Voter): FamilyGroup => {
    const key = buildFamilyHeadEpic(v)
    return familyByEpic.get(key) ?? { key: `GROUP|${key}`, head: key, headVoter: v, members: [v] }
  }, [familyByEpic])

  const assignedIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows])

  const familyRepresentative = useCallback((family: FamilyGroup): Voter | null => {
    return (
      family.members.find((m) => assignedIds.has(m.id) && directVoterIds.has(m.id))
      ?? (family.headVoter && assignedIds.has(family.headVoter.id) ? family.headVoter : null)
      ?? family.members.find((m) => assignedIds.has(m.id))
      ?? null
    )
  }, [assignedIds, directVoterIds])

  // "Remaining families" - voters in this team leader's part/section that have
  // not been assigned to any team leader yet. Families are identified by
  // family_head_epic and only families where NO member is assigned anywhere
  // (excluding families parked under Shifted/Single, which still count as
  // remaining) are considered remaining.
  const loadRemaining = useCallback(async () => {
    if (!leaderId || !leader) return
    setRemainingOpen(true)
    setRemainingLoading(true)
    try {
      const assignedRows = await fetchAllPages<{ voter_id: string; team_leader_id: string | null }>(async (from, to) => supabase.from('team_leader_assignments').select('voter_id, team_leader_id').range(from, to), 1000)
      const assignedSet = new Set(
        assignedRows
          .filter((a) => a.team_leader_id && !specialLeaderIds.has(a.team_leader_id))
          .map((a) => a.voter_id)
          .filter(Boolean),
      )

      let req = supabase.from('voters').select('*').eq('part_no', leader.part_no)
      if (leader.section != null) req = req.eq('section', leader.section)
      if (hasWardRestriction) req = req.in('ward_no', allowedWards)
      const { data: partVoters, error } = await req
      if (error) {
        toast.error(error.message)
        setRemainingRows([])
        return
      }
      const voters = (partVoters as Voter[] | null) ?? []

      // Only families where no member is assigned anywhere.
      const remaining: Voter[] = []
      const groups = new Map<string, Voter[]>()
      for (const v of voters) {
        const key = normalizeLookupValue(v.family_head_epic) || normalizeLookupValue(v.epic_no)
        if (!key) continue
        const arr = groups.get(key)
        if (arr) arr.push(v)
        else groups.set(key, [v])
      }
      for (const [key, members] of groups) {
        if (members.some((m) => assignedSet.has(m.id))) continue
        const sorted = [...members].sort((a, b) => {
          const aIsHead = normalizeLookupValue(a.epic_no) === key
          const bIsHead = normalizeLookupValue(b.epic_no) === key
          if (aIsHead && !bIsHead) return -1
          if (!aIsHead && bIsHead) return 1
          if (a.display_order != null && b.display_order != null) return a.display_order - b.display_order
          return (a.updated_at ?? a.created_at ?? '').localeCompare(b.updated_at ?? b.created_at ?? '')
        })
        remaining.push(...sorted)
      }
      setRemainingRows(remaining)
      setSelectedRemainingFamilyKeys(new Set())
    } finally {
      setRemainingLoading(false)
    }
  }, [leaderId, leader, hasWardRestriction, allowedWards, specialLeaderIds])

  const remainingFamilies = useMemo(() => {
    if (!remainingRows.length) return []
    return buildFamilies(remainingRows)
  }, [remainingRows])

  const selectedRemainingFamilies = useMemo(() => {
    if (!selectedRemainingFamilyKeys.size) return []
    return remainingFamilies.filter((family) => selectedRemainingFamilyKeys.has(family.key))
  }, [remainingFamilies, selectedRemainingFamilyKeys])

  const assignResultFamilies = useMemo(() => {
    if (!assignResults.length) return []
    const searchedIds = new Set(assignResults.map((v) => v.id))
    // Search results and the family-member fetch can both contain the same
    // voter (e.g. the matched head), so dedupe by voter id before grouping -
    // otherwise buildFamilies would report a voter more than once per family.
    const seen = new Set<string>()
    const merged: Voter[] = []
    for (const voter of [...assignResults, ...assignFamilyRows]) {
      if (seen.has(voter.id)) continue
      seen.add(voter.id)
      merged.push(voter)
    }
    return buildFamilies(merged).filter((family) =>
      family.members.some((member) => searchedIds.has(member.id)),
    )
  }, [assignResults, assignFamilyRows])

  const visiblePhotoPaths = useMemo(() => {
    const set = new Set<string>()
    if (leaderVoter?.photo_url) set.add(leaderVoter.photo_url)
    for (const v of [...rows, ...familyRows, ...remainingRows, ...assignFamilyRows]) {
      if (v.photo_url) set.add(v.photo_url)
    }
    return Array.from(set)
  }, [leaderVoter, rows, familyRows, remainingRows, assignFamilyRows])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const missing = visiblePhotoPaths.filter((p) => !photoUrlByPath[p])
      if (!missing.length) return
      for (let i = 0; i < missing.length; i += 80) {
        if (cancelled) return
        const batch = missing.slice(i, i + 80)
        const { data } = await supabase.storage.from('voter-photos').createSignedUrls(batch, 3600)
        if (cancelled || !data) continue
        const next: Record<string, string> = {}
        for (let j = 0; j < batch.length; j++) { const url = data[j]?.signedUrl; if (url) next[batch[j]] = url }
        if (Object.keys(next).length) setPhotoUrlByPath((c) => ({ ...c, ...next }))
      }
    }
    void run()
    return () => { cancelled = true }
  }, [photoUrlByPath, visiblePhotoPaths])

  const resolvePhotoUrl = useCallback((voter: Voter | null | undefined): string => {
    if (!voter?.photo_url) return ''
    return photoUrlByPath[voter.photo_url] ?? ''
  }, [photoUrlByPath])

  // True once every photo that this page shows has a signed URL (or there are
  // none). Used by the auto-download flow so exports with embedded photos are
  // not generated before the photos resolve.
  const allPhotosReady = useMemo(
    () => visiblePhotoPaths.every((path) => photoUrlByPath[path]),
    [visiblePhotoPaths, photoUrlByPath],
  )

  const tableColumns = useMemo(
    () => MEMBER_COLUMNS.filter((c) => visibleColumns.includes(c.key)),
    [visibleColumns],
  )

  const syncTableScrollWidth = useCallback(() => {
    const table = tableElRef.current
    const inner = topScrollInnerRef.current
    const body = tableScrollRef.current
    if (!table || !inner) return
    inner.style.width = `${table.scrollWidth}px`
    if (body) setTableOverflowsX(table.scrollWidth > body.clientWidth + 1)
  }, [])

  const onTopScroll = useCallback(() => {
    const top = topScrollRef.current
    const body = tableScrollRef.current
    if (!top || !body || syncingScrollRef.current) return
    syncingScrollRef.current = true
    body.scrollLeft = top.scrollLeft
    syncingScrollRef.current = false
  }, [])

  const onTableScroll = useCallback(() => {
    const top = topScrollRef.current
    const body = tableScrollRef.current
    if (!top || !body || syncingScrollRef.current) return
    syncingScrollRef.current = true
    top.scrollLeft = body.scrollLeft
    syncingScrollRef.current = false
  }, [])

  useEffect(() => {
    syncTableScrollWidth()
    const table = tableElRef.current
    const body = tableScrollRef.current
    if (!table) return
    const observer = new ResizeObserver(() => syncTableScrollWidth())
    observer.observe(table)
    if (body) observer.observe(body)
    window.addEventListener('resize', syncTableScrollWidth)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncTableScrollWidth)
    }
  }, [syncTableScrollWidth, tableColumns, columnWidths, showFamilyMembers, visibleColumns])

  const patchVoterLists = useCallback((voterId: string, patch: Partial<Voter>) => {
    const apply = (list: Voter[]) => list.map((row) => (row.id === voterId ? { ...row, ...patch } : row))
    setRows(apply)
    setFamilyRows(apply)
  }, [])

  const persistPresenceRows = useCallback(async (members: Voter[], status: PresenceStatus | null, note: string, silent = false) => {
    const trimmedNote = status ? note.trim() : ''
    const patch = { presence_status: status, presence_note: trimmedNote || null }
    const updatedIds: string[] = []
    for (const member of members) {
      const { error } = await supabase.from('voters').update(patch).eq('id', member.id)
      if (error) throw new Error(error.message)
      updatedIds.push(member.id)
    }
    for (const id of updatedIds) patchVoterLists(id, patch)
    if (!silent) toast.success(status ? `Presence set to ${presenceLabel(status)}.` : 'Presence cleared.')
  }, [patchVoterLists])

  const assignPresenceToFamily = useCallback(async (family: FamilyGroup, status: PresenceStatus | null, note: string, silent = false) => {
    const headId = family.headVoter?.id ?? family.members[0]?.id
    if (!headId) {
      if (!silent) toast.error('This family has no members.')
      return
    }
    setSavingPresenceFamilyKey(family.key)
    try {
      const targets = family.members.filter((member) => member.id === headId || !hasPresenceOverride(member, family.headVoter))
      await persistPresenceRows(targets, status, note, silent)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update presence.')
    } finally {
      setSavingPresenceFamilyKey(null)
    }
  }, [persistPresenceRows])

  const assignPresenceToMember = useCallback(async (member: Voter, status: PresenceStatus | null, note: string, silent = false) => {
    setSavingPresenceFamilyKey(member.id)
    try {
      await persistPresenceRows([member], status, note, silent)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update presence.')
    } finally {
      setSavingPresenceFamilyKey(null)
    }
  }, [persistPresenceRows])

  const assignCategoryToFamily = useCallback(async (family: FamilyGroup, category: Voter['voter_category'] | null) => {
    const memberIds = family.members.map((member) => member.id)
    if (!memberIds.length) {
      toast.error('This family has no members.')
      return
    }
    setSavingCategoryFamilyKey(family.key)
    try {
      for (const chunk of chunksOf(memberIds, D1_IN_CHUNK)) {
        const { error } = await supabase.from('voters').update({ voter_category: category }).in('id', chunk)
        if (error) throw new Error(error.message)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update category.')
      setSavingCategoryFamilyKey(null)
      return
    }
    for (const voterId of memberIds) patchVoterLists(voterId, { voter_category: category })
    setSavingCategoryFamilyKey(null)
    toast.success(category ? `Category assigned to ${memberIds.length} member${memberIds.length === 1 ? '' : 's'}.` : 'Category cleared for all family members.')
  }, [patchVoterLists])

  const renderVoterCells = useCallback((voter: Voter, family: FamilyGroup, sr: number | null, isMemberRow: boolean) => {
    const memberCount = family.members.length
    return tableColumns.map((col) => {
      const widthStyle = columnWidths[col.key] != null ? { width: columnWidths[col.key] } : undefined
      if (col.key === 'srNo') {
        return (
          <td key={col.key} style={widthStyle} className="border-b border-line px-5 py-3.5 text-ink-tertiary">
            {sr ?? ''}
          </td>
        )
      }
      if (col.key === 'photo') {
        return (
          <td key={col.key} style={widthStyle} className="border-b border-line px-5 py-3.5">
            {voter.photo_url ? <VoterAvatar voter={voter} photoUrl={resolvePhotoUrl(voter)} /> : <span className="text-xs text-ink-tertiary">-</span>}
          </td>
        )
      }
      if (col.key === 'familyMembers') {
        return (
          <td key={col.key} style={widthStyle} className="border-b border-line px-5 py-3.5">
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${memberCount > 0 ? 'bg-brand-50 text-brand-700' : 'bg-muted text-ink-tertiary'}`}>
              {memberCount}
            </span>
          </td>
        )
      }
      if (col.key === 'category') {
        const familyCategory = family.headVoter?.voter_category ?? voter.voter_category
        const savingFamily = savingCategoryFamilyKey === family.key
        return (
          <td key={col.key} style={widthStyle} className="border-b border-line px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
            {!isMemberRow && isAdminAreaAllowed ? (
              <div className="relative">
                <button
                  type="button"
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary shadow-sm transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={`Assign category to all members of family ${family.head}`}
                  title="Assign category to all members"
                  disabled={savingFamily}
                  onClick={(event) => {
                    setCategoryAnchor(event.currentTarget)
                    setCategoryMenuFamily((current) => (current === family.key ? null : family.key))
                  }}
                >
                  {savingFamily ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  <span className="text-ink-tertiary">Family:</span>
                  <span>{voterCategoryLabel(familyCategory) ?? 'No category'}</span>
                  <ChevronDown className={`h-3.5 w-3.5 text-ink-tertiary transition-transform ${categoryMenuFamily === family.key ? 'rotate-180' : ''}`} />
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
            ) : (
              <span className={`inline-flex rounded-md px-1.5 py-0.5 text-xs font-medium ${voter.voter_category ? 'bg-brand-50 text-brand-700' : 'bg-muted text-ink-tertiary'}`}>
                {voterCategoryLabel(voter.voter_category) ?? 'No category'}
              </span>
            )}
          </td>
        )
      }
      if (col.key === 'contact1') {
        const contact = resolveContact(voter, family)
        const ownNumber = vf(voter, 'contact_no_1') || vf(voter, 'contact_no_2')
        const viaName = !ownNumber && contact.ownerName && contact.ownerName !== vf(voter, 'name') ? contact.ownerName : ''
        return (
          <td key={col.key} style={widthStyle} className="border-b border-line px-5 py-3.5 text-ink-secondary">
            {contact.number ? (
              <span title={viaName ? `via ${viaName}` : undefined}>{contact.number}</span>
            ) : '-'}
          </td>
        )
      }
      if (col.key === 'presence') {
        const isHeadRow = !isMemberRow
        const status = isHeadRow ? familyPresence(family.members, family.headVoter) : voter.presence_status
        const savingFamily = savingPresenceFamilyKey === family.key || savingPresenceFamilyKey === voter.id
        return (
          <td key={col.key} style={widthStyle} className="min-w-0 overflow-hidden border-b border-line px-5 py-3.5 align-middle" onClick={(e) => e.stopPropagation()}>
            <PresencePicker
              status={status}
              note={isHeadRow ? presenceNoteOf(family.headVoter ?? voter) : presenceNoteOf(voter)}
              heading={isHeadRow ? 'Classify family presence' : 'Classify this voter'}
              compact
              showPrefix={false}
              disabled={!canEditVoter}
              saving={savingFamily}
              open={isHeadRow ? presenceMenuFamily === family.key : presenceMenuMember === voter.id}
              anchor={isHeadRow
                ? (presenceMenuFamily === family.key ? presenceAnchor : null)
                : (presenceMenuMember === voter.id ? presenceMemberAnchor : null)}
              onToggle={(button) => {
                if (isHeadRow) {
                  setPresenceAnchor(button)
                  setPresenceMenuFamily((current) => (current === family.key ? null : family.key))
                } else {
                  setPresenceMemberAnchor(button)
                  setPresenceMenuMember((current) => (current === voter.id ? null : voter.id))
                }
              }}
              onClose={() => {
                if (isHeadRow) setPresenceMenuFamily(null)
                else setPresenceMenuMember(null)
              }}
              onSave={(nextStatus, nextNote) => {
                if (isHeadRow) void assignPresenceToFamily(family, nextStatus, nextNote)
                else void assignPresenceToMember(voter, nextStatus, nextNote)
              }}
              onClear={() => {
                if (isHeadRow) void assignPresenceToFamily(family, null, '')
                else void assignPresenceToMember(voter, null, '')
              }}
            />
          </td>
        )
      }
      const isName = col.key === 'name'
      const placeClub = isName && !isMemberRow
        ? placeClubById.get(familyPlaceByHead[familyHeadKey(family.headVoter ?? family.members[0]) || family.head] ?? '') ?? null
        : null
      return (
        <td key={col.key} style={widthStyle} className={`border-b border-line px-5 py-3.5 ${isName ? 'font-semibold text-ink' : 'text-ink-secondary'}`}>
          {isMemberRow && isName ? (
            <span className="inline-flex min-w-0 max-w-[14rem] items-center gap-1.5">
              <span className="shrink-0 text-ink-tertiary">↳</span>
              <span className="truncate" title={getVoterFieldValue(voter, col.key, family)}>{getVoterFieldValue(voter, col.key, family)}</span>
            </span>
          ) : isName ? (
            <span className="inline-flex min-w-0 max-w-[16rem] items-center gap-1.5">
              <span className="truncate" title={getVoterFieldValue(voter, col.key, family)}>{getVoterFieldValue(voter, col.key, family)}</span>
              {placeClub ? (
                <span className="shrink-0 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-violet-700">
                  {placeClubLabel(placeClub)}
                </span>
              ) : null}
            </span>
          ) : (
            getVoterFieldValue(voter, col.key, family)
          )}
        </td>
      )
    })
  }, [assignCategoryToFamily, assignPresenceToFamily, assignPresenceToMember, canEditVoter, categoryAnchor, categoryMenuFamily, familyPlaceByHead, isAdminAreaAllowed, patchVoterLists, placeClubById, presenceAnchor, presenceMemberAnchor, presenceMenuFamily, presenceMenuMember, resolvePhotoUrl, savingCategoryFamilyKey, savingPresenceFamilyKey, tableColumns, columnWidths])

  const tokens = useMemo(() => tokenizeLookup(query), [query])

  // Filter dropdown options for the Shifted / Single views. Those
  // leaders have no part/section of their own, so the options are derived from
  // the assigned families' head voters.
  const isSpecialLeaderView = isSpecialLeader(leader)

  const detailPartOptions = useMemo(() => {
    const parts = new Set<number>()
    for (const f of families) {
      const rep = f.headVoter ?? f.members[0]
      if (rep?.part_no != null) parts.add(rep.part_no)
    }
    return Array.from(parts).sort((a, b) => a - b)
  }, [families])

  const detailSectionOptions = useMemo(() => {
    if (!detailPartFilter) return []
    const partNum = Number(detailPartFilter)
    if (!Number.isFinite(partNum)) return []
    const sections = new Set<number>()
    for (const f of families) {
      const rep = f.headVoter ?? f.members[0]
      if (rep?.part_no === partNum && rep.section != null) sections.add(rep.section)
    }
    return Array.from(sections).sort((a, b) => a - b)
  }, [families, detailPartFilter])

  const detailReligionOptions = useMemo(() => {
    const rels = new Set<string>()
    for (const f of families) {
      const rep = f.headVoter ?? f.members[0]
      if (rep?.religion) rels.add(rep.religion)
    }
    return Array.from(rels).sort((a, b) => a.localeCompare(b))
  }, [families])

  const detailStateOptions = useMemo(() => {
    const states = new Set<string>()
    for (const f of families) {
      const rep = f.headVoter ?? f.members[0]
      if (rep?.state) states.add(rep.state)
    }
    return Array.from(states).sort((a, b) => a.localeCompare(b))
  }, [families])

  useEffect(() => {
    if (detailPartFilter && detailSectionFilter) {
      const valid = detailSectionOptions.some((s) => String(s) === detailSectionFilter)
      if (!valid) setDetailSectionFilter('')
    }
  }, [detailSectionOptions, detailSectionFilter, detailPartFilter])

  // When a family size is selected in the dashboard, only families with that
  // many members are shown. When "show family members" is enabled, each family
  // is displayed as a merged block (head row + member rows below it) instead
  // of a flat list of members. Otherwise one representative per family is
  // shown (family members are assigned but hidden until revealed).
  const visibleFamilies = useMemo(() => {
    return families.filter((f) => {
      if (familySizeFilter != null && f.members.length !== familySizeFilter) return false
      const rep = f.headVoter ?? f.members[0]
      if (detailPartFilter && (rep?.part_no == null || String(rep.part_no) !== detailPartFilter)) return false
      if (detailSectionFilter && (rep?.section == null || String(rep.section) !== detailSectionFilter)) return false
      if (detailReligionFilter && (rep?.religion ?? '') !== detailReligionFilter) return false
      if (detailStateFilter && (rep?.state ?? '') !== detailStateFilter) return false
      if (placeFilter !== 'all') {
        const clubId = familyPlaceByHead[familyHeadKey(f.headVoter ?? f.members[0]) || f.head] ?? ''
        if (placeFilter === 'unlabelled') {
          if (clubId) return false
        } else if (clubId !== placeFilter) return false
      }
      return true
    })
  }, [families, familySizeFilter, detailPartFilter, detailSectionFilter, detailReligionFilter, detailStateFilter, placeFilter, familyPlaceByHead])

  // In the default (heads-only) view, one representative per family is shown.
  // Every assigned family must be listed - not just ones with a direct
  // (is_direct) voter - otherwise families assigned with no direct voter
  // would silently disappear from the table.
  const displayRows = useMemo(() => {
    if (!showFamilyMembers) {
      const out: Voter[] = []
      for (const family of visibleFamilies) {
        const rep = familyRepresentative(family)
        if (rep) out.push(rep)
      }
      return out
    }
    return visibleFamilies.map((f) => f.headVoter ?? f.members[0]).filter(Boolean) as Voter[]
  }, [showFamilyMembers, visibleFamilies, familyRepresentative])

  // Search matches the whole family, so typing a family member's name finds
  // that family's representative row too - not just the head voter.
  const filteredHeads = useMemo(() => {
    if (!tokens.length) return displayRows
    return displayRows.filter((v) => {
      const family = familyForVoter(v)
      return family.members.some((m) => matchesLookupTokens(voterSearchText(m), tokens))
    })
  }, [displayRows, tokens, familyForVoter])

  const sortedHeads = useMemo(() => {
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1
      return [...filteredHeads].sort((a, b) => {
        const va = getVoterFieldValue(a, sortKey, familyForVoter(a))
        const vb = getVoterFieldValue(b, sortKey, familyForVoter(b))
        const na = Number(va)
        const nb = Number(vb)
        if (!Number.isNaN(na) && !Number.isNaN(nb) && va !== '-' && vb !== '-' && va !== '' && vb !== '') {
          return (na - nb) * dir
        }
        return va.localeCompare(vb) * dir
      })
    }
    const order = new Map<string, number>()
    let index = 0
    for (const group of groupFamiliesByPlace(visibleFamilies, familyPlaceByHead, placeClubById)) {
      for (const family of group.families) {
        const head = showFamilyMembers ? (family.headVoter ?? family.members[0]) : familyRepresentative(family)
        if (head && !order.has(head.id)) order.set(head.id, index++)
      }
    }
    return [...filteredHeads].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }, [filteredHeads, sortKey, sortDir, familyForVoter, visibleFamilies, familyPlaceByHead, placeClubById, showFamilyMembers, familyRepresentative])

  const pageCount = Math.max(1, Math.ceil(sortedHeads.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pageStartIndex = (currentPage - 1) * pageSize
  const pageHeads = sortedHeads.slice(pageStartIndex, pageStartIndex + pageSize)

  useEffect(() => {
    const top = topScrollRef.current
    const body = tableScrollRef.current
    if (top) top.scrollLeft = 0
    if (body) body.scrollLeft = 0
    syncTableScrollWidth()
  }, [page, query, familySizeFilter, detailPartFilter, detailSectionFilter, detailReligionFilter, detailStateFilter, placeFilter, visibleColumns, showFamilyMembers, syncTableScrollWidth])

  const toggleSort = (key: MemberColumnKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const toggleFamilyExpand = (key: string) => {
    setExpandedFamilyKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const togglePrintFamily = (key: string) => {
    setPrintSelectedFamilyKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const visibleFamilyKeys = useMemo(() => visibleFamilies.map((f) => f.key), [visibleFamilies])
  const allVisiblePrintSelected = visibleFamilyKeys.length > 0 && visibleFamilyKeys.every((key) => printSelectedFamilyKeys.has(key))
  const selectedPrintFamilies = useMemo(
    () => visibleFamilies.filter((f) => printSelectedFamilyKeys.has(f.key)),
    [visibleFamilies, printSelectedFamilyKeys],
  )
  const placeGroups = useMemo(
    () => groupFamiliesByPlace(visibleFamilies, familyPlaceByHead, placeClubById),
    [visibleFamilies, familyPlaceByHead, placeClubById],
  )
  const showPlaceGroupHeaders = !sortKey && placeGroups.some((group) => group.clubId)

  useEffect(() => {
    setPrintSelectedFamilyKeys((prev) => {
      if (!prev.size) return prev
      const allowed = new Set(visibleFamilies.map((f) => f.key))
      let changed = false
      const next = new Set<string>()
      for (const key of prev) {
        if (allowed.has(key)) next.add(key)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [visibleFamilies])

  const assignCategoryToSelectedFamilies = useCallback(async (category: Voter['voter_category'] | null) => {
    if (!selectedPrintFamilies.length) {
      toast.error('Select one or more assigned voters first.')
      return
    }
    const memberIds = Array.from(new Set(selectedPrintFamilies.flatMap((family) => family.members.map((member) => member.id))))
    if (!memberIds.length) {
      toast.error('The selected families have no members.')
      return
    }
    setSavingBulkCategory(true)
    try {
      for (const chunk of chunksOf(memberIds, D1_IN_CHUNK)) {
        const { error } = await supabase.from('voters').update({ voter_category: category }).in('id', chunk)
        if (error) throw new Error(error.message)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update category.')
      setSavingBulkCategory(false)
      return
    }
    for (const voterId of memberIds) patchVoterLists(voterId, { voter_category: category })
    setSavingBulkCategory(false)
    setBulkCategoryMenuOpen(false)
    setPrintSelectedFamilyKeys(new Set())
    toast.success(
      category
        ? `Category assigned to ${memberIds.length} member${memberIds.length === 1 ? '' : 's'} across ${selectedPrintFamilies.length} famil${selectedPrintFamilies.length === 1 ? 'y' : 'ies'}.`
        : `Category cleared for ${memberIds.length} member${memberIds.length === 1 ? '' : 's'} across ${selectedPrintFamilies.length} famil${selectedPrintFamilies.length === 1 ? 'y' : 'ies'}.`,
    )
  }, [patchVoterLists, selectedPrintFamilies])

  const assignPlaceToSelectedFamilies = useCallback(async (placeClubId: string | null) => {
    if (!selectedPrintFamilies.length) {
      toast.error('Select one or more assigned families first.')
      return
    }
    const heads = Array.from(new Set(selectedPrintFamilies.map((family) => familyGroupHeadKey(family)).filter(Boolean)))
    if (!heads.length) {
      toast.error('The selected families have no family head.')
      return
    }
    setSavingBulkPlace(true)
    try {
      if (placeClubId) {
        await clubFamilies(heads, placeClubId)
        setFamilyPlaceByHead((current) => {
          const next = { ...current }
          for (const head of heads) next[head] = placeClubId
          return next
        })
      } else {
        await unclubFamilies(heads)
        setFamilyPlaceByHead((current) => {
          const next = { ...current }
          for (const head of heads) delete next[head]
          return next
        })
      }
      setBulkPlaceMenuOpen(false)
      setPrintSelectedFamilyKeys(new Set())
      toast.success(
        placeClubId
          ? `Place assigned to ${heads.length} famil${heads.length === 1 ? 'y' : 'ies'}.`
          : `Place cleared for ${heads.length} famil${heads.length === 1 ? 'y' : 'ies'}.`,
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update place.')
    } finally {
      setSavingBulkPlace(false)
    }
  }, [selectedPrintFamilies])

  const createAndAssignPlace = useCallback(async () => {
    if (!selectedPrintFamilies.length) {
      toast.error('Select one or more assigned families first.')
      return
    }
    if (!newPlaceArea.trim()) {
      toast.error('Area is required.')
      return
    }
    const heads = Array.from(new Set(selectedPrintFamilies.map((family) => familyGroupHeadKey(family)).filter(Boolean)))
    if (!heads.length) {
      toast.error('The selected families have no family head.')
      return
    }
    setSavingBulkPlace(true)
    try {
      const club = await upsertPlaceClub({
        area: newPlaceArea,
        chawl: newPlaceChawl,
        building: newPlaceBuilding,
        createdBy: profile?.id ?? null,
      })
      setPlaceClubs((current) => current.some((row) => row.id === club.id) ? current : [...current, club].sort((a, b) => a.area.localeCompare(b.area)))
      await clubFamilies(heads, club.id)
      setFamilyPlaceByHead((current) => {
        const next = { ...current }
        for (const head of heads) next[head] = club.id
        return next
      })
      setNewPlaceArea('')
      setNewPlaceChawl('')
      setNewPlaceBuilding('')
      setBulkPlaceMenuOpen(false)
      setPrintSelectedFamilyKeys(new Set())
      toast.success(`Place assigned to ${heads.length} famil${heads.length === 1 ? 'y' : 'ies'}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not assign place.')
    } finally {
      setSavingBulkPlace(false)
    }
  }, [newPlaceArea, newPlaceBuilding, newPlaceChawl, profile?.id, selectedPrintFamilies])

  // Totals follow the same part/section/religion/state filter as the table
  // (visibleFamilies), so the summary cards, export, print and PDF all reflect
  // the current filtered selection on the Shifted/Single views.
  const totalMembers = useMemo(() => visibleFamilies.reduce((sum, f) => sum + f.members.length, 0), [visibleFamilies])
  const maleCount = useMemo(
    () => visibleFamilies.reduce((sum, f) => sum + f.members.filter((m) => (m.gender ?? '').toLowerCase() === 'male').length, 0),
    [visibleFamilies],
  )
  const femaleCount = useMemo(
    () => visibleFamilies.reduce((sum, f) => sum + f.members.filter((m) => (m.gender ?? '').toLowerCase() === 'female').length, 0),
    [visibleFamilies],
  )

  const leaderDisplayName = useMemo(
    () => resolveTeamLeaderName(leader, leaderVoter),
    [leader, leaderVoter],
  )

  const leaderSlug = useMemo(() => {
    const slug = leaderDisplayName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    return slug || 'team-leader'
  }, [leaderDisplayName])

  // Fixed 9-column template that mirrors the reference export exactly:
  // merged title/contact/stats header block, a spacer row, a bold column
  // header row, then one photo-embedded row per voter. Column widths and
  // row heights are hardcoded (not user-adjustable) because they exist to
  // fit the embedded photos - the rowHeight/colWidth sliders are ignored
  // here on purpose so every export matches the template pixel-for-pixel.
  const EXPORT_TEMPLATE_COLUMNS: Array<{ key: MemberColumnKey; label: string; width: number }> = [
    { key: 'srNo', label: 'Sr No', width: 4.14 },
    { key: 'photo', label: 'Photo', width: 15.86 },
    { key: 'name', label: 'Name', width: 20.43 },
    { key: 'relativeName', label: 'Relative Name', width: 20.43 },
    { key: 'epicNo', label: 'EPIC', width: 16.29 },
    { key: 'partNo', label: 'Part', width: 7.71 },
    { key: 'section', label: 'Section', width: 7.14 },
    { key: 'contact1', label: 'Contact No 1', width: 17.57 },
    { key: 'familyMembers', label: 'Family', width: 5.29 },
    { key: 'presence' as const, label: 'Presence', width: 22 },
  ]
  const EXPORT_TITLE_ROW = 1
  const EXPORT_INFO_ROW = 2
  const EXPORT_SPACER_ROW = 3
  const EXPORT_COLUMN_HEADER_ROW = 4
  const EXPORT_FIRST_DATA_ROW = 5
  const EXPORT_DATA_ROW_HEIGHT = 80.1
  const EXPORT_INFO_ROW_HEIGHT = 82.5
  const EXPORT_SPACER_ROW_HEIGHT = 12
  const EXPORT_PHOTO_TARGET_HEIGHT_PX = 84
  const EXPORT_PHOTO_MAX_WIDTH_PX = 92
  // Every column in the reference file is centered + wrapped, so alignment
  // is applied uniformly in styleCell(); only bold varies (Sr No isn't bold).
  const EXPORT_NOT_BOLD_KEYS = new Set<MemberColumnKey>(['srNo'])
  // Optional org logo shown in the header block (column B, rows 1-2), to
  // match the reference file's letterhead. Left blank by default since no
  // logo asset is wired up yet - set this to a real URL/path to enable it.
  const EXPORT_ORG_LOGO_URL = ''

  const doExport = async (
    _fields: PrintFieldState[],
    include: boolean,
    borders: boolean,
    _rowHeight: number,
    _colWidth: number,
    includePhotos = false,
  ) => {
    const leaderName = leaderDisplayName
    const leaderContact = leaderVoter ? (resolveContact(leaderVoter).number || '-') : '-'

    // The reference file's title reads "PART <n> MN KARYAKARTA" - derive
    // <n> from the most common part number across this leader's families
    // rather than hardcoding it, so the export stays correct for any team.
    const reportTitle = (() => {
      const counts = new Map<string, number>()
      for (const family of visibleFamilies) {
        const partNo = vf(family.headVoter ?? family.members[0], 'part_no')
        if (!partNo) continue
        counts.set(partNo, (counts.get(partNo) ?? 0) + 1)
      }
      let bestPart = ''
      let bestCount = 0
      for (const [partNo, count] of counts) {
        if (count > bestCount) { bestPart = partNo; bestCount = count }
      }
      return bestPart ? `PART ${bestPart} MN KARYAKARTA` : 'MN KARYAKARTA'
    })()

    // Build the flat list of (voter, family) rows to export - either every
    // family member, or heads-only - with no blank separator rows, matching
    // the reference file.
    type ExportRow = { voter: Voter; family: FamilyGroup }
    const exportRows: ExportRow[] = []
    if (include) {
      for (const family of visibleFamilies) {
        for (const member of family.members) exportRows.push({ voter: member, family })
      }
    } else {
      for (const family of visibleFamilies) {
        const rep = familyRepresentative(family)
        if (rep) exportRows.push({ voter: rep, family })
      }
    }

    const ExcelJS = (await import('exceljs')).default
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Team Leader Report')

    // ---- Column widths (fixed, mirrors the reference template) ----
    EXPORT_TEMPLATE_COLUMNS.forEach((col, i) => {
      sheet.getColumn(i + 1).width = col.width
    })

    const exportColCount = EXPORT_TEMPLATE_COLUMNS.length
    const statsCol = Math.min(8, exportColCount)
    // ---- Merged header block: title / contact / stats ----
    sheet.mergeCells(EXPORT_TITLE_ROW, 1, EXPORT_TITLE_ROW, 3)
    sheet.mergeCells(EXPORT_TITLE_ROW, 4, EXPORT_TITLE_ROW, Math.min(7, exportColCount))
    if (exportColCount >= statsCol) sheet.mergeCells(EXPORT_TITLE_ROW, statsCol, EXPORT_TITLE_ROW, exportColCount)
    sheet.mergeCells(EXPORT_INFO_ROW, 4, EXPORT_INFO_ROW, Math.min(7, exportColCount))
    if (exportColCount >= statsCol) sheet.mergeCells(EXPORT_INFO_ROW, statsCol, EXPORT_INFO_ROW, exportColCount)

    sheet.getRow(EXPORT_TITLE_ROW).getCell(1).value = reportTitle
    sheet.getRow(EXPORT_TITLE_ROW).getCell(4).value = 'Contact'
    sheet.getRow(EXPORT_TITLE_ROW).getCell(8).value = `Total Members = ${totalMembers}`
    sheet.getRow(EXPORT_INFO_ROW).getCell(3).value = leaderName
    sheet.getRow(EXPORT_INFO_ROW).getCell(4).value = leaderContact
    sheet.getRow(EXPORT_INFO_ROW).getCell(8).value = `Assigned Families = ${visibleFamilies.length}`

    // ---- Column header row ----
    EXPORT_TEMPLATE_COLUMNS.forEach((col, i) => {
      sheet.getRow(EXPORT_COLUMN_HEADER_ROW).getCell(i + 1).value = col.label
    })

    // ---- Row heights ----
    sheet.getRow(EXPORT_TITLE_ROW).height = EXPORT_DATA_ROW_HEIGHT
    sheet.getRow(EXPORT_INFO_ROW).height = EXPORT_INFO_ROW_HEIGHT
    sheet.getRow(EXPORT_SPACER_ROW).height = EXPORT_SPACER_ROW_HEIGHT
    sheet.getRow(EXPORT_COLUMN_HEADER_ROW).height = EXPORT_DATA_ROW_HEIGHT

    // ---- Styling shared by every populated cell: thin black borders,
    // Calibri, centered + wrapped, size 16 for the title / 14 elsewhere ----
    const borderStyle = { style: 'thin' } as const
    const cellBorder = borders
      ? { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle }
      : undefined

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExcelJS is loaded via dynamic import, so its
    // cell type isn't available as a named type here; `any` mirrors how the rest of this function treats it.
    const styleCell = (cell: any, opts: { size: number; bold: boolean }) => {
      if (cellBorder) cell.border = cellBorder
      cell.font = { name: 'Calibri', size: opts.size, bold: opts.bold }
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    }

    // Columns A-G (title / contact block) are size 16; columns H-I (the
    // "Total Members" / "Assigned Families" stat cells) are size 14 -
    // matches the reference file exactly.
    for (let c = 1; c <= exportColCount; c++) {
      const size = c <= 7 ? 16 : 14
      styleCell(sheet.getRow(EXPORT_TITLE_ROW).getCell(c), { size, bold: true })
      styleCell(sheet.getRow(EXPORT_INFO_ROW).getCell(c), { size, bold: true })
    }
    for (let c = 1; c <= exportColCount; c++) styleCell(sheet.getRow(EXPORT_COLUMN_HEADER_ROW).getCell(c), { size: 14, bold: true })

    // ---- Optional org logo in the header block (column B, rows 1-2) ----
    if (EXPORT_ORG_LOGO_URL) {
      const logo = await fetchImageForExcel(EXPORT_ORG_LOGO_URL)
      if (logo) {
        const imageId = workbook.addImage({ base64: logo.base64, extension: logo.extension })
        sheet.addImage(imageId, {
          tl: { col: 1.05, row: 0.05 },
          ext: { width: 82, height: 82 },
        })
      }
    }

    if (includePhotos) {
      const neededPaths = Array.from(new Set(exportRows.map(({ voter }) => voter.photo_url).filter((path): path is string => Boolean(path))))
      const missing = neededPaths.filter((path) => !photoUrlByPathRef.current[path])
      if (missing.length) {
        const extra: Record<string, string> = {}
        for (let i = 0; i < missing.length; i += 80) {
          const batch = missing.slice(i, i + 80)
          const { data } = await supabase.storage.from('voter-photos').createSignedUrls(batch, 3600)
          if (!data) continue
          for (let j = 0; j < batch.length; j++) {
            const url = data[j]?.signedUrl
            if (url) extra[batch[j]] = url
          }
        }
        if (Object.keys(extra).length) {
          photoUrlByPathRef.current = { ...photoUrlByPathRef.current, ...extra }
          setPhotoUrlByPath((current) => ({ ...current, ...extra }))
        }
      }
      if (exportRows.length >= EXPORT_PHOTO_WARN_ROW_COUNT) {
        toast(`Embedding photos for ${exportRows.length} rows. This can take a while and the file may be large.`)
      }
    }

    const photoColIndex = EXPORT_TEMPLATE_COLUMNS.findIndex((c) => c.key === 'photo')
    const resolveExportPhotoUrl = (voter: Voter): string => {
      if (!voter.photo_url) return ''
      return photoUrlByPathRef.current[voter.photo_url] || resolvePhotoUrl(voter)
    }

    // ---- Data rows: one row per voter; photos are embedded in a later pass ----
    let sr = 1
    for (let i = 0; i < exportRows.length; i++) {
      // Yield periodically so exporting thousands of rows never freezes the tab.
      if (i > 0 && i % 200 === 0) await new Promise((resolve) => setTimeout(resolve, 0))

      const { voter, family } = exportRows[i]
      const rowNumber = EXPORT_FIRST_DATA_ROW + i
      const row = sheet.getRow(rowNumber)
      row.height = EXPORT_DATA_ROW_HEIGHT

      EXPORT_TEMPLATE_COLUMNS.forEach((col, c) => {
        const cell = row.getCell(c + 1)
        if (col.key === 'srNo') {
          cell.value = String(sr)
        } else if (col.key === 'photo') {
          cell.value = null
        } else {
          cell.value = getVoterFieldValue(voter, col.key, family) || null
        }
        styleCell(cell, { size: 14, bold: !EXPORT_NOT_BOLD_KEYS.has(col.key) })
      })
      sr += 1
    }

    let embeddedPhotoCount = 0
    if (includePhotos && photoColIndex >= 0) {
      const exportToast = toast.loading('Embedding voter photos...')
      const imageCache = new Map<string, FetchedExcelImage | null>()
      try {
        for (let i = 0; i < exportRows.length; i += EXPORT_PHOTO_CONCURRENCY) {
          const batch = exportRows.slice(i, i + EXPORT_PHOTO_CONCURRENCY)
          const images = await Promise.all(batch.map(async ({ voter }) => {
            const photoUrl = resolveExportPhotoUrl(voter)
            if (!photoUrl) return null
            if (imageCache.has(photoUrl)) return imageCache.get(photoUrl) ?? null
            try {
              const img = await fetchImageForExcel(photoUrl)
              imageCache.set(photoUrl, img)
              return img
            } catch {
              imageCache.set(photoUrl, null)
              return null
            }
          }))
          images.forEach((img, j) => {
            if (!img) return
            const rowNumber = EXPORT_FIRST_DATA_ROW + i + j
            const scale = Math.min(
              EXPORT_PHOTO_TARGET_HEIGHT_PX / img.height,
              EXPORT_PHOTO_MAX_WIDTH_PX / img.width,
              1,
            )
            const width = Math.round(img.width * scale)
            const height = Math.round(img.height * scale)
            const imageId = workbook.addImage({ base64: img.base64, extension: img.extension })
            sheet.addImage(imageId, {
              tl: { col: photoColIndex + 0.15, row: rowNumber - 1 + 0.08 },
              ext: { width, height },
            })
            embeddedPhotoCount += 1
          })
        }
        toast.dismiss(exportToast)
      } catch {
        toast.error('Some photos could not be embedded. The spreadsheet was still created.', { id: exportToast })
      }
    }

    sheet.pageSetup = {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    }

    const buffer = await workbook.xlsx.writeBuffer()
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${leaderSlug}-assigned-voters-${new Date().toISOString().slice(0, 10)}.xlsx`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast.success(includePhotos
      ? `Excel file exported with ${embeddedPhotoCount} photo${embeddedPhotoCount === 1 ? '' : 's'}.`
      : 'Excel file exported.')
  }

  const printFamilies = selectedPrintFamilies.length ? selectedPrintFamilies : visibleFamilies
  const printPlaceGroups = printGroupByPlace
    ? groupFamiliesByPlace(printFamilies, familyPlaceByHead, placeClubById).map((group) => ({ label: group.label, families: group.families }))
    : undefined

  const printHeading = useMemo(() => {
    if (detailPartFilter) {
      return `PART ${detailPartFilter}${detailSectionFilter ? `  ·  Section ${detailSectionFilter}` : ''}`
    }
    return `${leaderDisplayName} - Assigned Voters`
  }, [detailPartFilter, detailSectionFilter, leaderDisplayName])

  const doPrint = (fields: PrintFieldState[], include: boolean, fontSize: number, bold: boolean, showHeaderDetails: boolean, widths?: Partial<Record<MemberColumnKey, number>>) => {
    if (!printFamilies.length) {
      toast.error('No families to print. Select families or clear the filter.')
      return
    }
    const totalMembersPrinted = printFamilies.reduce((sum, f) => sum + f.members.length, 0)
    const sectionHtml = buildLeaderPrintSectionHtml({
      leader,
      leaderVoter,
      families: printFamilies,
      settings: {
        fields: mergePrintFieldsForLeader(fields, leader),
        includeFamilyMembers: include,
        fontSize,
        boldText: bold,
        showHeaderDetails,
        assignedVoterIds: assignedIds,
        directVoterIds,
        resolvePhotoUrl,
      },
      columnWidths: widths,
      heading: printHeading,
      footer: `Total Voters Assigned: ${totalMembersPrinted}    |    Total Families Assigned: ${printFamilies.length}`,
      placeGroups: printPlaceGroups,
    })
    openPrintWindow(wrapLeaderPrintDocument(sectionHtml, fontSize, bold, printHeading))
  }

  const doDownloadPdf = async (fields: PrintFieldState[], include: boolean, fontSize: number, bold: boolean, showHeaderDetails: boolean) => {
    if (!printFamilies.length) {
      toast.error('No families to print. Select families or clear the filter.')
      return
    }
    const leaderName = leaderDisplayName
    const pdfToast = toast.loading('Preparing PDF...')
    try {
      // Build the PDF through the shared helper so the batch "Download All
      // (ZIP)" flow on the list page produces byte-identical single-leader
      // PDFs. The filename/slug stays here, owned by the caller.
      const blob = await buildLeaderPdfBlob({
        leader,
        leaderVoter,
        families: printFamilies,
        settings: {
          fields: mergePrintFieldsForLeader(fields, leader),
          includeFamilyMembers: include,
          fontSize,
          boldText: bold,
          showHeaderDetails,
          assignedVoterIds: assignedIds,
          directVoterIds,
          resolvePhotoUrl,
        },
        heading: printHeading,
        placeGroups: printPlaceGroups,
      })
      saveBlob(blob, `${leaderName.trim().replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'team-leader'}-assigned-voters-${new Date().toISOString().slice(0, 10)}.pdf`)
      toast.success('PDF downloaded.', { id: pdfToast })
    } catch {
      toast.error('Could not generate the PDF.', { id: pdfToast })
    }
  }

  const openModalFor = (mode: 'print' | 'export') => {
    setModalMode(mode)
    setModalOpen(true)
  }

  const handleModalConfirm = (
    fields: ReportFieldItem[],
    include: boolean,
    style: PrintStyleOptions,
  ) => {
    const nextFields: PrintFieldState[] = fields.map((f) => ({ key: f.key as PrintFieldKey, enabled: f.enabled }))
    setPrintFields(nextFields.map((f) => ({ ...f })))
    setIncludeFamilyMembers(include)
    setModalOpen(false)
    if (modalMode === 'print') {
      setPrintFontSize(style.fontSize)
      setPrintBold(style.boldText)
      setPrintShowHeader(style.showHeaderDetails ?? false)
      doPrint(nextFields, include, style.fontSize, style.boldText, style.showHeaderDetails ?? false, columnWidths)
    } else {
      setExportBorders(style.exportBorders)
      setExportRowHeight(style.exportRowHeight)
      setExportColWidth(style.exportColWidth)
      setExportIncludePhotos(style.includePhotos ?? false)
      void doExport(nextFields, include, style.exportBorders, style.exportRowHeight, style.exportColWidth, style.includePhotos ?? false)
    }
  }

  const handlePdfDownload = (
    fields: ReportFieldItem[],
    include: boolean,
    style: PrintStyleOptions,
  ) => {
    const nextFields: PrintFieldState[] = fields.map((field) => ({ key: field.key as PrintFieldKey, enabled: field.enabled }))
    setPrintFields(nextFields.map((field) => ({ ...field })))
    setIncludeFamilyMembers(include)
    setPrintFontSize(style.fontSize)
    setPrintBold(style.boldText)
    setPrintShowHeader(style.showHeaderDetails ?? false)
    setModalOpen(false)
    void doDownloadPdf(nextFields, include, style.fontSize, style.boldText, style.showHeaderDetails ?? false)
  }

  // Auto-download triggered by the per-leader button on the team-leaders list
  // page (navigates here with ?download=excel or ?download=pdf). Reuses the
  // exact same export paths as the toolbar buttons with the saved settings;
  // once fired, the query param is stripped so a refresh does not re-download.
  const autoDownloadDone = useRef(false)
  const latestDoExport = useRef(doExport)
  const latestDoDownloadPdf = useRef(doDownloadPdf)

  useEffect(() => {
    latestDoExport.current = doExport
    latestDoDownloadPdf.current = doDownloadPdf
  })

  useEffect(() => {
    const mode = searchParams.get('download')
    if (!mode || loading || autoDownloadDone.current) return

    const run = () => {
      autoDownloadDone.current = true
      if (mode === 'pdf') {
        void latestDoDownloadPdf.current(printFields, includeFamilyMembers, printFontSize, printBold, printShowHeader)
      } else {
        void latestDoExport.current(printFields, includeFamilyMembers, exportBorders, exportRowHeight, exportColWidth)
      }
      const next = new URLSearchParams(searchParams)
      next.delete('download')
      setSearchParams(next, { replace: true })
    }

    if (allPhotosReady) {
      run()
      return
    }
    // Photos are still resolving - wait briefly before exporting so embedded
    // photos are not missed, but fall back to a timer so a photo that can
    // never resolve does not block the download forever.
    const timer = window.setTimeout(run, 2500)
    return () => window.clearTimeout(timer)
  }, [searchParams, loading, allPhotosReady, printFields, includeFamilyMembers, printFontSize, printBold, printShowHeader, exportBorders, exportRowHeight, exportColWidth, setSearchParams])

  const assignTokens = useMemo(() => tokenizeLookup(assignQuery), [assignQuery])

  useEffect(() => {
    if (!assignQuery.trim()) { setAssignResults([]); setAssignFamilyRows([]); return }
    let cancelled = false
    const run = async () => {
      setAssignSearching(true)
      const trimmed = assignQuery.trim()
      const searchTokens = tokenizeLookup(trimmed)

      if (searchTokens.length === 1 && isLikelyEpicToken(searchTokens[0])) {
        const epicToken = compactLookupValue(searchTokens[0])
        let exactReq = supabase.from('voters').select('*').eq('epic_no', epicToken)
        if (hasWardRestriction) exactReq = exactReq.in('ward_no', allowedWards)
        const { data: exactRow } = await exactReq.maybeSingle()
        if (cancelled) return
        setAssignResults(exactRow ? [exactRow as Voter] : [])
        setAssignSearching(false)
        return
      }

      const sp = `%${escapeIlikePattern(trimmed).replace(/\s+/g, '%')}%`
      let req = supabase.from('voters').select('*').or([`name.ilike.${sp}`,`relative_name.ilike.${sp}`,`epic_no.ilike.${sp}`,`contact_no_1.ilike.${sp}`,`house_no.ilike.${sp}`].join(',')).limit(20)
      if (hasWardRestriction) req = req.in('ward_no', allowedWards)
      const { data: matches } = await req
      if (cancelled) return
      setAssignResults((matches as Voter[] | null) ?? [])
      setAssignSearching(false)
    }
    void run()
    return () => { cancelled = true }
  }, [allowedWards, assignQuery, hasWardRestriction])

  useEffect(() => {
    if (!assignResults.length) { setAssignFamilyRows([]); return }
    let cancelled = false
    const run = async () => {
      // Use RAW stored epics for the DB lookups (same reason as in load()):
      // normalized keys would not match voters whose EPIC contains special
      // characters, causing family members/heads to be skipped.
      const keys = Array.from(new Set(assignResults.map((v) => ((v.family_head_epic ? v.family_head_epic.trim() : v.epic_no).trim())).filter(Boolean)))
      const members: Voter[] = []
      for (const chunk of chunksOf(keys, D1_IN_CHUNK)) {
        let memberReq = supabase.from('voters').select('*').in('family_head_epic', chunk)
        if (hasWardRestriction) memberReq = memberReq.in('ward_no', allowedWards)
        const { data: memberData } = await memberReq
        if (cancelled) return
        members.push(...((memberData as Voter[] | null) ?? []))

        let headReq = supabase.from('voters').select('*').in('epic_no', chunk)
        if (hasWardRestriction) headReq = headReq.in('ward_no', allowedWards)
        const { data: headData } = await headReq
        if (cancelled) return
        members.push(...((headData as Voter[] | null) ?? []))
      }
      const seen = new Set<string>()
      const deduped = members.filter((voter) => {
        if (seen.has(voter.id)) return false
        seen.add(voter.id)
        return true
      })
      setAssignFamilyRows(deduped)
    }
    void run()
    return () => { cancelled = true }
  }, [allowedWards, assignResults, hasWardRestriction])

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (assignRef.current && !assignRef.current.contains(e.target as Node)) setAssignDropdownOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const extraVoterPatch = (): Record<string, string | number | null> | null => {
    if (!isOfficeLeader(leader) || !assignPresenceStatus) return null
    return { presence_status: assignPresenceStatus, presence_note: assignPresenceNote.trim() || null }
  }

  const applyExtraVoterPatch = async (voterIds: string[]): Promise<boolean> => {
    const extraPatch = extraVoterPatch()
    if (!extraPatch || !voterIds.length) return true
    for (const chunk of chunksOf(voterIds, D1_IN_CHUNK)) {
      const { error: patchError } = await supabase.from('voters').update(extraPatch).in('id', chunk)
      if (patchError) {
        toast.error(patchError.message)
        return false
      }
    }
    return true
  }

  const writeDetailCacheNow = (
    nextRows: Voter[],
    nextFamilyRows: Voter[],
    nextDirect: Set<string>,
    nextVToL: Record<string, string>,
  ) => {
    if (!leaderId) return
    writeTeamLeaderDetailCache(
      buildTeamLeaderDetailScope(leaderId, profile?.role ?? null, profile?.allowed_wards ?? null),
      {
        leader,
        leaderVoter,
        rows: nextRows,
        familyRows: nextFamilyRows,
        directVoterIds: Array.from(nextDirect),
        voterToLeaderId: nextVToL,
      },
    )
  }

  const applyLocalAssign = (
    members: Voter[],
    assignedVoterIds: string[],
    directIdsToAdd: string[],
    extraPatch?: Record<string, string | number | null> | null,
  ) => {
    if (!leaderId) return
    const assignedSet = new Set(assignedVoterIds)
    const patched = members.map((member) => (
      assignedSet.has(member.id) && extraPatch ? { ...member, ...extraPatch } : member
    ))
    const incomingById = new Map(patched.map((member) => [member.id, member]))

    const nextRowsMap = new Map(rows.map((row) => [row.id, row]))
    for (const member of patched) {
      if (!assignedSet.has(member.id)) continue
      nextRowsMap.set(member.id, { ...(nextRowsMap.get(member.id) ?? member), ...member })
    }
    const nextRows = Array.from(nextRowsMap.values())
    const nextRowIds = new Set(nextRows.map((row) => row.id))

    const nextFamilyMap = new Map(familyRows.map((row) => [row.id, row]))
    for (const id of assignedSet) nextFamilyMap.delete(id)
    for (const member of patched) {
      if (nextRowIds.has(member.id) || nextFamilyMap.has(member.id)) continue
      nextFamilyMap.set(member.id, incomingById.get(member.id) ?? member)
    }
    const nextFamilyRows = Array.from(nextFamilyMap.values())

    const nextDirect = new Set(directVoterIds)
    for (const id of directIdsToAdd) nextDirect.add(id)

    const nextVToL = { ...voterToLeaderId }
    for (const id of assignedSet) nextVToL[id] = leaderId

    setRows(nextRows)
    setFamilyRows(nextFamilyRows)
    setDirectVoterIds(nextDirect)
    setVoterToLeaderId(nextVToL)
    setRemainingRows((prev) => prev.filter((row) => !assignedSet.has(row.id)))
    writeDetailCacheNow(nextRows, nextFamilyRows, nextDirect, nextVToL)
  }

  const applyLocalUnassign = (voterIds: string[]) => {
    const removeIds = new Set(voterIds)
    const nextRows = rows.filter((row) => !removeIds.has(row.id))
    const remainingAssignedKeys = new Set(
      nextRows.map((row) => normalizeLookupValue(row.family_head_epic) || normalizeLookupValue(row.epic_no)).filter(Boolean),
    )
    const nextRowIds = new Set(nextRows.map((row) => row.id))
    const nextFamilyRows = familyRows.filter((row) => {
      if (removeIds.has(row.id) || nextRowIds.has(row.id)) return false
      const key = normalizeLookupValue(row.family_head_epic) || normalizeLookupValue(row.epic_no)
      return Boolean(key) && remainingAssignedKeys.has(key)
    })
    const nextDirect = new Set(Array.from(directVoterIds).filter((id) => !removeIds.has(id)))
    const nextVToL = { ...voterToLeaderId }
    for (const id of removeIds) delete nextVToL[id]
    setRows(nextRows)
    setFamilyRows(nextFamilyRows)
    setDirectVoterIds(nextDirect)
    setVoterToLeaderId(nextVToL)
    writeDetailCacheNow(nextRows, nextFamilyRows, nextDirect, nextVToL)
  }

  const assignFamilies = async (familiesToAssign: FamilyGroup[], directVoterByFamilyKey?: Map<string, Voter>) => {
    if (!leaderId || !familiesToAssign.length) return

    const rowsToInsert: Array<{ team_leader_id: string; voter_id: string; assigned_by: string | null; is_direct: boolean }> = []
    const seenIds = new Set<string>()

    for (const family of familiesToAssign) {
      const directVoter = directVoterByFamilyKey?.get(family.key) ?? family.headVoter ?? family.members[0]
      for (const member of family.members) {
        if (assignedIds.has(member.id) || seenIds.has(member.id)) continue
        seenIds.add(member.id)
        rowsToInsert.push({
          team_leader_id: leaderId,
          voter_id: member.id,
          assigned_by: profile?.id ?? null,
          is_direct: directVoter ? member.id === directVoter.id : false,
        })
      }
    }

    if (rowsToInsert.length === 0) {
      toast.error('Selected family is already assigned to this team leader.')
      return
    }

    // team_leader_assignments has a UNIQUE constraint on voter_id, so a voter
    // can belong to only one team leader. Instead of letting the insert fail
    // with a 409, skip voters already assigned to a different leader and tell
    // the user how many were skipped.
    const assignedElsewhere = new Map<string, string>()
    for (const chunk of chunksOf(rowsToInsert.map((r) => r.voter_id), D1_IN_CHUNK)) {
      const { data, error } = await supabase
        .from('team_leader_assignments')
        .select('voter_id, team_leader_id')
        .in('voter_id', chunk)
      if (error) { toast.error(error.message); return }
      for (const row of (data as Array<{ voter_id: string; team_leader_id: string }> | null) ?? []) {
        if (row.team_leader_id !== leaderId) assignedElsewhere.set(row.voter_id, row.team_leader_id)
      }
    }
    const skippedElsewhere = assignedElsewhere.size
    const finalRows = rowsToInsert.filter((r) => !assignedElsewhere.has(r.voter_id))

    if (finalRows.length === 0) {
      toast.error('Selected family is already assigned to another team leader.')
      return
    }

    setAssigning(true)
    const { error: insertError } = await supabase.from('team_leader_assignments').insert(finalRows)
    if (insertError) {
      setAssigning(false)
      toast.error(insertError.message)
      return
    }

    const patched = await applyExtraVoterPatch(finalRows.map((r) => r.voter_id))
    setAssigning(false)
    if (!patched) return

    toast.success(
      `Assigned ${finalRows.length} voter${finalRows.length === 1 ? '' : 's'} from ${familiesToAssign.length} famil${familiesToAssign.length === 1 ? 'y' : 'ies'}${
        skippedElsewhere ? ` (${skippedElsewhere} skipped - already assigned to another team leader)` : ''
      }.`,
    )
    const assignedIdsNow = finalRows.map((r) => r.voter_id)
    const assignedMembers = familiesToAssign.flatMap((family) => family.members)
    applyLocalAssign(
      assignedMembers,
      assignedIdsNow,
      finalRows.filter((r) => r.is_direct).map((r) => r.voter_id),
      extraVoterPatch(),
    )
    setAssignQuery('')
    setAssignResults([])
    setAssignFamilyRows([])
    setAssignDropdownOpen(false)
    setAssignPresenceStatus('')
    setAssignPresenceNote('')
    setSelectedRemainingFamilyKeys((prev) => {
      const next = new Set(prev)
      for (const family of familiesToAssign) next.delete(family.key)
      return next
    })
    void syncOtherPagesAfterMutation([leaderId])
  }

  const assignRemainingFamily = async (family: FamilyGroup) => {
    await assignFamilies([family])
  }

  const assignSelectedRemainingFamilies = async () => {
    await assignFamilies(selectedRemainingFamilies)
  }

  // Move an already-assigned family to this team leader straight from the
  // assign search results, so no round-trip through the other leader's page is
  // needed. Mirrors the bulk Transfer modal behaviour.
  const handleTransferFromAssignSearch = async (family: FamilyGroup, sourceLeaderIds: string[]) => {
    if (!leaderId) { toast.error('Team leader not found.'); return }
    setAssignTransferring(true)
    try {
      const voterIds = family.members.map((m) => m.id)
      const result = await transferAssignments({
        voterIds,
        fromLeaderIds: sourceLeaderIds,
        toLeaderId: leaderId,
        assignedBy: profile?.id ?? null,
      })
      const remainingIds = voterIds.filter((id) => voterToLeaderId[id] !== leaderId && !result.rows.some((row) => row.voter_id === id))
      const assigned = remainingIds.length
        ? await assignFamilyToLeader({
            voterIds: remainingIds,
            toLeaderId: leaderId,
            assignedBy: profile?.id ?? null,
            isDirectVoterIds: new Set(family.headVoter?.id ? [family.headVoter.id] : [family.members[0]?.id].filter(Boolean) as string[]),
            specialLeaderIds,
          })
        : { inserted: 0, moved: 0, skipped: 0, voterIds: [] as string[] }
      const nowAssignedIds = Array.from(new Set([...result.rows.map((row) => row.voter_id), ...assigned.voterIds]))
      if (!nowAssignedIds.length) {
        toast.success('All voters in this family are already assigned to this team leader.')
        setAssignTransferTarget(null)
        return
      }
      const patched = await applyExtraVoterPatch(nowAssignedIds)
      if (!patched) return
      const extraAssigned = assigned.inserted + assigned.moved
      toast.success(
        `Transferred ${result.moved} voter${result.moved === 1 ? '' : 's'} to ${leaderDisplayName}${extraAssigned ? `; assigned ${extraAssigned} more` : ''}${result.skipped || assigned.skipped ? ` (${result.skipped + assigned.skipped} already at target)` : ''}.`,
      )
      applyLocalAssign(
        family.members,
        nowAssignedIds,
        family.headVoter?.id ? [family.headVoter.id] : [family.members[0]?.id].filter(Boolean) as string[],
        extraVoterPatch(),
      )
      setAssignTransferTarget(null)
      setAssignQuery('')
      setAssignResults([])
      setAssignFamilyRows([])
      setAssignDropdownOpen(false)
      setAssignPresenceStatus('')
      setAssignPresenceNote('')
      void syncOtherPagesAfterMutation([leaderId, ...sourceLeaderIds])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Transfer failed.')
    } finally {
      setAssignTransferring(false)
    }
  }

  const toggleRemainingFamilySelection = (familyKey: string) => {
    setSelectedRemainingFamilyKeys((prev) => {
      const next = new Set(prev)
      if (next.has(familyKey)) next.delete(familyKey)
      else next.add(familyKey)
      return next
    })
  }

  const removeAssignment = async (v: Voter) => {
    if (!leaderId) return
    // Deleting a voter also removes the whole family - since families are
    // assigned together, the family members' rows would otherwise be left
    // behind and stay assigned to this leader.
    const family = familyForVoter(v)
    const membersToRemove = family.members.filter((m) => assignedIds.has(m.id))
    // Always include the voter the user asked to remove. If the family data is
    // stale or the voter's family group is incomplete (e.g. the family was
    // broken on the Families page after this page cached the old grouping),
    // falling back to the whole-family set alone could silently do nothing for
    // that particular voter.
    const voterIdsToRemove = Array.from(new Set([
      ...membersToRemove.map((m) => m.id),
      ...(assignedIds.has(v.id) ? [v.id] : []),
    ]))
    if (!voterIdsToRemove.length) return
    try {
      await fetchInChunks(
        voterIdsToRemove,
        async (chunk) => {
          const { data, error } = await supabase
            .from('team_leader_assignments')
            .delete()
            .eq('team_leader_id', leaderId)
            .in('voter_id', chunk)
            .select('voter_id')
          return { data, error }
        },
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove voters.')
      return
    }
    toast.success(`Removed ${voterIdsToRemove.length} voter${voterIdsToRemove.length === 1 ? '' : 's'} (family of ${v.name}).`)
    applyLocalUnassign(voterIdsToRemove)
    void syncOtherPagesAfterMutation([leaderId])
  }

  const openRemoveModal = (v: Voter) => {
    const family = familyForVoter(v)
    const count = family.members.filter((m) => assignedIds.has(m.id)).length
    setRemoveTargetCount(count)
    setRemoveTarget(v)
  }

  const selectedUnassignVoterIds = useMemo(() => {
    const ids = new Set<string>()
    for (const family of selectedPrintFamilies) {
      for (const member of family.members) {
        if (assignedIds.has(member.id)) ids.add(member.id)
      }
    }
    return Array.from(ids)
  }, [selectedPrintFamilies, assignedIds])

  const removeSelectedFamilies = async () => {
    if (!leaderId) return
    if (!selectedPrintFamilies.length) {
      toast.error('Select one or more assigned families first.')
      return
    }
    const voterIdsToRemove = selectedUnassignVoterIds
    if (!voterIdsToRemove.length) {
      toast.error('Selected families have no assigned voters.')
      return
    }
    setRemovingBulk(true)
    try {
      await fetchInChunks(
        voterIdsToRemove,
        async (chunk) => {
          const { data, error } = await supabase
            .from('team_leader_assignments')
            .delete()
            .eq('team_leader_id', leaderId)
            .in('voter_id', chunk)
            .select('voter_id')
          return { data, error }
        },
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not unassign families.')
      setRemovingBulk(false)
      return
    }
    const familyCount = selectedPrintFamilies.length
    toast.success(`Unassigned ${familyCount} famil${familyCount === 1 ? 'y' : 'ies'} (${voterIdsToRemove.length} voter${voterIdsToRemove.length === 1 ? '' : 's'}).`)
    setPrintSelectedFamilyKeys(new Set())
    setBulkUnassignOpen(false)
    setRemovingBulk(false)
    applyLocalUnassign(voterIdsToRemove)
    void syncOtherPagesAfterMutation([leaderId])
  }

  const transferTargetLeaders = useMemo(() => {
    return leaderList
      .filter((tl) => tl.id !== leaderId)
      .map((tl) => ({
        id: tl.id,
        name: leaderNameById[tl.id] ?? resolveTeamLeaderName(tl, null, 'Unknown leader'),
        part_no: tl.part_no,
        section: tl.section,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [leaderList, leaderId, leaderNameById])

  const handleTransferConfirm = async (familiesToTransfer: FamilyGroup[], targetLeaderId: string) => {
    if (!leaderId || !familiesToTransfer.length || !targetLeaderId) return
    setTransferring(true)
    try {
      const votersToMove: Array<{ voter_id: string; is_direct: boolean }> = []
      const seen = new Set<string>()
      for (const family of familiesToTransfer) {
        for (const member of family.members) {
          if (!assignedIds.has(member.id) || seen.has(member.id)) continue
          seen.add(member.id)
          votersToMove.push({ voter_id: member.id, is_direct: directVoterIds.has(member.id) })
        }
      }
      if (votersToMove.length === 0) {
        toast.error('No assigned voters found in the selected families.')
        return
      }

      const existingAtTarget = await fetchInChunks<{ voter_id: string }>(
        votersToMove.map((v) => v.voter_id),
        (chunk) => supabase
          .from('team_leader_assignments')
          .select('voter_id')
          .eq('team_leader_id', targetLeaderId)
          .in('voter_id', chunk),
      )
      const atTarget = new Set(existingAtTarget.map((a) => a.voter_id))
      const rowsToMove = votersToMove.filter((v) => !atTarget.has(v.voter_id))
      const skipped = votersToMove.length - rowsToMove.length

      if (rowsToMove.length === 0) {
        toast.success('All selected voters are already assigned to the target team leader.')
        setTransferOpen(false)
        setPrintSelectedFamilyKeys(new Set())
        return
      }

      await fetchInChunks(
        rowsToMove.map((v) => v.voter_id),
        async (chunk) => {
          const { data, error } = await supabase
            .from('team_leader_assignments')
            .delete()
            .eq('team_leader_id', leaderId)
            .in('voter_id', chunk)
            .select('voter_id')
          return { data, error }
        },
      )

      const { error: insError } = await supabase
        .from('team_leader_assignments')
        .insert(rowsToMove.map((v) => ({
          team_leader_id: targetLeaderId,
          voter_id: v.voter_id,
          assigned_by: profile?.id ?? null,
          is_direct: v.is_direct,
        })))
      if (insError) { toast.error(insError.message); return }

      const targetName = transferTargetLeaders.find((tl) => tl.id === targetLeaderId)?.name
      toast.success(
        `Transferred ${rowsToMove.length} voter${rowsToMove.length === 1 ? '' : 's'} from ${familiesToTransfer.length} famil${familiesToTransfer.length === 1 ? 'y' : 'ies'}${targetName ? ` to ${targetName}` : ''}${skipped ? ` (${skipped} already at target)` : ''}.`,
      )
      setTransferOpen(false)
      setPrintSelectedFamilyKeys(new Set())
      applyLocalUnassign(rowsToMove.map((v) => v.voter_id))
      void syncOtherPagesAfterMutation([leaderId, targetLeaderId])
    } finally {
      setTransferring(false)
    }
  }

  const handleChangeLeader = async (newLeader: Voter, partNo: string, section: string) => {
    if (!leaderId) return
    setSavingLeader(true)
    const { error } = await supabase
      .from('team_leaders')
      .update({
        voter_id: newLeader.id,
        display_name: leader?.display_name ?? null,
        part_no: partNo ? Number(partNo) : null,
        section: section ? Number(section) : null,
      })
      .eq('id', leaderId)
    setSavingLeader(false)
    if (error) { toast.error(error.message); return }
    toast.success(`${newLeader.name} is now the team leader.`)
    setChangeLeaderOpen(false)
    await load(true)
    await syncOtherPagesAfterMutation([leaderId])
  }

  const handleChangePrimary = async (family: FamilyGroup, memberId: string) => {
    if (!leaderId) return
    const memberIds = family.members.filter((m) => assignedIds.has(m.id)).map((m) => m.id)
    if (!memberIds.length) return
    setSavingPrimary(true)
    try {
      await fetchInChunks(
        memberIds,
        async (chunk) => {
          const { data, error } = await supabase
            .from('team_leader_assignments')
            .update({ is_direct: false })
            .eq('team_leader_id', leaderId)
            .in('voter_id', chunk)
            .select('voter_id')
          return { data, error }
        },
      )
      const { error: setError } = await supabase
        .from('team_leader_assignments')
        .update({ is_direct: true })
        .eq('team_leader_id', leaderId)
        .eq('voter_id', memberId)
      if (setError) { toast.error(setError.message); return }
      const member = family.members.find((m) => m.id === memberId)
      toast.success(member ? `${member.name} is now the primary member.` : 'Primary member updated.')
      setPrimaryTarget(null)
      const nextDirect = new Set(directVoterIds)
      for (const id of memberIds) nextDirect.delete(id)
      nextDirect.add(memberId)
      setDirectVoterIds(nextDirect)
      writeDetailCacheNow(rows, familyRows, nextDirect, voterToLeaderId)
      void syncOtherPagesAfterMutation([leaderId])
    } finally {
      setSavingPrimary(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-5 pb-10">
        <Link to={`/team-leaders${leaderListQuery}`} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-tertiary transition hover:text-brand-600">
          <ArrowLeft className="h-4 w-4" /> Back to Team Leaders
        </Link>
        <div className="flex items-center justify-center rounded-xl border border-line bg-white px-6 py-16 text-sm text-ink-tertiary">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading team leader...
        </div>
      </div>
    )
  }

  if (!leader) {
    return (
      <div className="space-y-5 pb-10">
        <Link to={`/team-leaders${leaderListQuery}`} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-tertiary transition hover:text-brand-600">
          <ArrowLeft className="h-4 w-4" /> Back to Team Leaders
        </Link>
        <div className="rounded-xl border border-line bg-white px-6 py-16 text-center text-sm text-ink-tertiary">
          Team leader not found.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5 pb-10">
      <Link to={`/team-leaders${leaderListQuery}`} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-tertiary transition hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> Back to Team Leaders
      </Link>

      <PageHeader
        title={leaderDisplayName}
        description={isOfficeLeader(leader)
          ? 'Voters/families that have shifted; set presence when you assign.'
          : isShiftedLeader(leader)
            ? 'Single voters/families moved out of field assignment.'
            : `${leaderVoter ? `EPIC ${leaderVoter.epic_no ?? '-'}` : 'Named leader (not linked to a voter yet)'}${leader.part_no != null ? ` · Part ${leader.part_no}` : ''}${leader.section != null ? ` · Section ${leader.section}` : ''}${leader.notes ? ` · ${leader.notes}` : ''}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                title="Previous team leader"
                disabled={!prevLeaderId}
                onClick={() => { if (prevLeaderId) navigate(`/team-leaders/${prevLeaderId}${leaderListQuery}`) }}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-white text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="Next team leader"
                disabled={!nextLeaderId}
                onClick={() => { if (nextLeaderId) navigate(`/team-leaders/${nextLeaderId}${leaderListQuery}`) }}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-white text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="relative">
              <select
                value={leaderId ?? ''}
                onChange={(e) => { const id = e.target.value; if (id) navigate(`/team-leaders/${id}${leaderListQuery}`) }}
                className="h-10 appearance-none rounded-xl border border-line bg-white pl-3 pr-8 text-sm font-semibold text-ink-secondary outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              >
                {navLeaders.flatMap((tl, index) => {
                  const prev = navLeaders[index - 1]
                  const showSeparator = !!prev && isSpecialLeader(prev) && !isSpecialLeader(tl)
                  const options = []
                  if (showSeparator) options.push(<option key="special-separator" disabled value="">────────────</option>)
                  options.push(
                    <option key={tl.id} value={tl.id}>
                      {isSpecialLeader(tl) ? resolveTeamLeaderName(tl, null) : `${leaderNameById[tl.id] ?? resolveTeamLeaderName(tl, null)}${tl.part_no != null ? ` · Part ${tl.part_no}` : ''}${tl.section != null ? ` · Sec ${tl.section}` : ''}`}
                    </option>,
                  )
                  return options
                })}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
            </div>
            {!isSpecialLeader(leader) && (
              <button
                type="button"
                onClick={() => setChangeLeaderOpen(true)}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
              >
                  <UserCog className="h-4 w-4" /> {leader.voter_id ? 'Change Leader' : 'Link to voter'}
              </button>
            )}
          </div>
        }
      />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-brand-100 bg-brand-50/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-600">Assigned Families</p>
          <p className="mt-1 font-display text-2xl font-semibold tracking-[-0.03em] text-ink">{visibleFamilies.length}</p>
        </div>
        <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-emerald-600">Total Family Members</p>
          <p className="mt-1 font-display text-2xl font-semibold tracking-[-0.03em] text-ink">{totalMembers}</p>
        </div>
        <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-blue-600">Male Assigned</p>
          <p className="mt-1 font-display text-2xl font-semibold tracking-[-0.03em] text-ink">{maleCount}</p>
        </div>
        <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-violet-600">Female Assigned</p>
          <p className="mt-1 font-display text-2xl font-semibold tracking-[-0.03em] text-ink">{femaleCount}</p>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-white p-5 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">Family Size Dashboard</h2>
            <p className="text-xs text-ink-tertiary">Click a size to highlight those families in the assigned voters table below.</p>
          </div>
          {familySizeFilter != null && (
            <button
              type="button"
              onClick={() => setFamilySizeFilter(null)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
            >
              <X className="h-3.5 w-3.5" /> Clear Filter
            </button>
          )}
        </div>
        {familySizeDistribution.length === 0 ? (
          <p className="mt-4 text-sm text-ink-tertiary">No families assigned yet.</p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {familySizeDistribution.map(([size, count]) => {
              const active = familySizeFilter === size
              return (
                <button
                  key={size}
                  type="button"
                  onClick={() => setFamilySizeFilter(active ? null : size)}
                  className={`flex items-center gap-2 rounded-2xl border px-4 py-2.5 text-left transition ${
                    active
                      ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-200'
                      : 'border-line bg-white hover:border-brand-300 hover:bg-brand-50/50'
                  }`}
                >
                  <span className={`text-sm font-bold ${active ? 'text-brand-800' : 'text-ink'}`}>
                    {size === 1 ? 'Single' : `${size} Members`}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${active ? 'bg-brand-100 text-brand-800' : 'bg-muted text-ink-secondary'}`}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-line bg-white p-5">
        <h2 className="text-base font-semibold text-ink">Assign a Voter</h2>
        <p className="text-xs text-ink-tertiary">Entire family is assigned together.</p>
        <div ref={assignRef} className="relative mt-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
            <input
              className="h-11 w-full rounded-xl border border-line bg-white pl-10 pr-10 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              placeholder="Search by name, EPIC, relative name, mobile, house number..."
              value={assignQuery}
              onChange={(e) => { setAssignQuery(e.target.value); if (!assignDropdownOpen) setAssignDropdownOpen(true) }}
              onFocus={() => { if (assignQuery.trim()) setAssignDropdownOpen(true) }}
            />
            {assignQuery && (
              <button type="button" onClick={() => { setAssignQuery(''); setAssignResults([]) }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear search">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {assignDropdownOpen && assignQuery.trim() && assignSearching && (
            <div className="absolute z-20 mt-2 w-full rounded-xl border border-line bg-white p-4">
              <div className="flex items-center justify-center gap-2 text-sm text-ink-tertiary"><Loader2 className="h-4 w-4 animate-spin" /> Searching...</div>
            </div>
          )}

          {assignDropdownOpen && assignQuery.trim() && !assignSearching && assignResultFamilies.length > 0 && (
            <div className="absolute z-20 mt-2 w-full max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-white p-3">
              <div className="space-y-3">
                {assignResultFamilies.map((family) => {
                  const head = family.headVoter ?? family.members[0]
                  const alreadyAssigned = family.members.every((member) => assignedIds.has(member.id))
                  const matchedMember = family.members.find((member) => assignResults.some((result) => result.id === member.id)) ?? head
                  const otherLeaderIds = Array.from(new Set(
                    family.members.map((m) => voterToLeaderId[m.id]).filter((id): id is string => Boolean(id) && id !== leaderId),
                  ))
                  const assignedElsewhereCount = family.members.filter((m) => voterToLeaderId[m.id] && voterToLeaderId[m.id] !== leaderId).length
                  const otherLeaderNames = otherLeaderIds.map((id) => leaderNameById[id]).filter(Boolean)
                  const otherLeaderLabel = formatLeaderNames(otherLeaderNames.length ? otherLeaderNames : otherLeaderIds.map(() => null))
                  const canTransfer = otherLeaderIds.length > 0
                  const currentLeaderName = leaderDisplayName || (leaderId ? leaderNameById[leaderId] : undefined)
                  return (
                    <div key={family.key} className={`rounded-xl border border-line p-4 ${alreadyAssigned ? 'opacity-60' : ''}`}>
                      <div className="flex items-start gap-3">
                        {head && <VoterAvatar voter={head} photoUrl={resolvePhotoUrl(head)} />}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold text-ink">{highlightMatch(head?.name ?? 'Unknown head', assignTokens)}</p>
                            <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                              {family.members.length} member{family.members.length === 1 ? '' : 's'}
                            </span>
                            {alreadyAssigned && (
                              currentLeaderName ? (
                                <span className="inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">Already assigned to {currentLeaderName}</span>
                              ) : (
                                <span className="inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">Already assigned</span>
                              )
                            )}
                            {assignedElsewhereCount > 0 && (
                              <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                                {assignedElsewhereCount === family.members.length
                                  ? `Assigned to ${otherLeaderLabel}`
                                  : `${assignedElsewhereCount} member${assignedElsewhereCount === 1 ? '' : 's'} assigned to ${otherLeaderLabel}`}
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 truncate text-xs text-ink-tertiary">
                            EPIC: {highlightMatch(head?.epic_no ?? '-', assignTokens)} · Part {head?.part_no ?? '-'} / Sec {head?.section ?? '-'}{head?.house_no ? ` · House ${head.house_no}` : ''}
                          </p>
                          {matchedMember?.id !== head?.id && (
                            <p className="mt-1 text-[11px] text-brand-600">Matched: {highlightMatch(matchedMember.name, assignTokens)} ({matchedMember.epic_no})</p>
                          )}
                        </div>
                        {alreadyAssigned ? null : canTransfer ? (
                          <button
                            type="button"
                            disabled={assignTransferring || !leaderId}
                            onClick={() => setAssignTransferTarget({ family, sourceLeaderIds: otherLeaderIds })}
                            className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {assignTransferring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowLeftRight className="h-3.5 w-3.5" />} Transfer
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={assigning}
                            onClick={() => void assignFamilies([family], new Map([[family.key, matchedMember ?? head]]))}
                            className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {assigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />} Assign
                          </button>
                        )}
                      </div>
                      <div className="mt-3 space-y-1.5 border-t border-line pt-3">
                        {family.members.map((member) => {
                          const memberLeaderId = voterToLeaderId[member.id]
                          const memberLeaderName = memberLeaderId
                            ? (memberLeaderId === leaderId ? currentLeaderName : leaderNameById[memberLeaderId])
                            : undefined
                          return (
                            <div key={member.id} className="flex items-center gap-2">
                              <VoterAvatar voter={member} photoUrl={resolvePhotoUrl(member)} size="sm" />
                              <span className="min-w-0 flex-1 truncate text-xs text-ink-secondary">{highlightMatch(member.name, assignTokens)}</span>
                              {memberLeaderName && (
                                <span className={`max-w-[140px] truncate rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${memberLeaderId === leaderId ? 'bg-brand-50 text-brand-700' : 'bg-amber-50 text-amber-700'}`}>
                                  {memberLeaderName}
                                </span>
                              )}
                              <span className="truncate text-[11px] text-ink-tertiary">{highlightMatch(member.epic_no, assignTokens)}</span>
                              <IconButton title="View voter" onClick={() => setSelectedVoter(member)}>
                                <Eye className="h-3.5 w-3.5" />
                              </IconButton>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {assignDropdownOpen && assignQuery.trim() && !assignSearching && assignResults.length === 0 && (
            <div className="absolute z-20 mt-2 w-full rounded-xl border border-line bg-white p-4 text-center text-sm text-ink-tertiary">
              No voters found.
            </div>
          )}
        </div>
        {isOfficeLeader(leader) && (
          <div className="mt-4 space-y-3 rounded-xl border border-line bg-muted p-4">
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-secondary">Classify family presence</label>
              <select
                className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                value={assignPresenceStatus}
                onChange={(e) => setAssignPresenceStatus(e.target.value as PresenceStatus | '')}
              >
                <option value="">Not set</option>
                {PRESENCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            {assignPresenceStatus ? (
              <div>
                <label className="mb-1 block text-xs font-semibold text-ink-secondary">Description (optional)</label>
                <input
                  className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  placeholder="Enter location or details (optional)"
                  value={assignPresenceNote}
                  onChange={(e) => setAssignPresenceNote(e.target.value)}
                />
              </div>
            ) : null}
            <p className="text-[11px] text-ink-tertiary">Saved on the family when you assign. Leave Presence unset until you know. Edit later in the Presence column.</p>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">Assigned Voters</h2>
            <p className="text-xs text-ink-tertiary">
              {showFamilyMembers
                ? `${totalMembers} member${totalMembers === 1 ? '' : 's'} across ${visibleFamilies.length} famil${visibleFamilies.length === 1 ? 'y' : 'ies'}`
                : `${sortedHeads.length} added voter${sortedHeads.length === 1 ? '' : 's'} (expand a row to see its family)`}
              {printSelectedFamilyKeys.size > 0 ? ` · ${printSelectedFamilyKeys.size} selected` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
              <input
                className="h-9 w-56 rounded-lg border border-line bg-white pl-8 pr-8 text-xs outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                placeholder="Search assigned voters..."
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(1) }}
              />
              {query && (
                <button type="button" onClick={() => { setQuery(''); setPage(1) }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-ink-tertiary hover:text-ink-secondary" aria-label="Clear search">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {isSpecialLeaderView && (
              <>
                <select
                  className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  aria-label="Filter by part"
                  title="Filter by part"
                  value={detailPartFilter}
                  onChange={(e) => { setDetailPartFilter(e.target.value); setDetailSectionFilter(''); setPage(1) }}
                >
                  <option value="">All Parts</option>
                  {detailPartOptions.map((p) => (
                    <option key={p} value={String(p)}>Part {p}</option>
                  ))}
                </select>
                <select
                  className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
                  aria-label="Filter by section"
                  title={detailPartFilter ? 'Filter by section' : 'Select a part to filter by section'}
                  value={detailSectionFilter}
                  disabled={!detailPartFilter}
                  onChange={(e) => { setDetailSectionFilter(e.target.value); setPage(1) }}
                >
                  <option value="">All Sections</option>
                  {detailSectionOptions.map((s) => (
                    <option key={s} value={String(s)}>Section {s}</option>
                  ))}
                </select>
                <select
                  className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  aria-label="Filter by religion"
                  title="Filter by religion"
                  value={detailReligionFilter}
                  onChange={(e) => { setDetailReligionFilter(e.target.value); setPage(1) }}
                >
                  <option value="">All Religions</option>
                  {detailReligionOptions.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <select
                  className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  aria-label="Filter by state"
                  title="Filter by state"
                  value={detailStateFilter}
                  onChange={(e) => { setDetailStateFilter(e.target.value); setPage(1) }}
                >
                  <option value="">All States</option>
                  {detailStateOptions.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                {(detailPartFilter || detailSectionFilter || detailReligionFilter || detailStateFilter) && (
                  <button
                    type="button"
                    onClick={() => { setDetailPartFilter(''); setDetailSectionFilter(''); setDetailReligionFilter(''); setDetailStateFilter(''); setPage(1) }}
                    className="inline-flex h-9 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-tertiary transition hover:bg-muted"
                  >
                    <X className="h-3.5 w-3.5" /> Clear
                  </button>
                )}
              </>
            )}
            <select
              className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              aria-label="Filter by place"
              title="Filter by place"
              value={placeFilter}
              onChange={(e) => { setPlaceFilter(e.target.value); setPage(1) }}
            >
              <option value="all">All Places</option>
              {placeClubs.map((club) => (
                <option key={club.id} value={club.id}>{placeClubLabel(club)}</option>
              ))}
              <option value="unlabelled">Unlabelled</option>
            </select>
            <span className="hidden h-6 w-px bg-slate-200 sm:block" aria-hidden="true" />
            <button
              type="button"
              onClick={() => { setShowFamilyMembers((v) => !v); setPage(1) }}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100 ${
                showFamilyMembers
                  ? 'border-brand-200 bg-brand-50 text-brand-700'
                  : 'border-line bg-white text-ink-secondary hover:bg-muted'
              }`}
            >
              <Users className="h-3.5 w-3.5" /> {showFamilyMembers ? 'Show Added Voters' : 'Show Families'}
            </button>
            <ColumnsDropdown visible={visibleColumns} onChange={setVisibleColumns} />
            {Object.keys(columnWidths).length > 0 && (
              <button
                type="button"
                onClick={() => setColumnWidths({})}
                title="Reset column widths to default"
                aria-label="Reset column widths to default"
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-white text-ink-tertiary transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => openModalFor('export')}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" /> Export
            </button>
            {isAdminAreaAllowed && (
              <div className="relative">
                <button
                  type="button"
                  disabled={savingBulkCategory}
                  onClick={(event) => {
                    if (!printSelectedFamilyKeys.size) {
                      toast.error('Select one or more assigned voters first.')
                      return
                    }
                    setBulkCategoryAnchor(event.currentTarget)
                    setBulkCategoryMenuOpen((open) => !open)
                  }}
                  title={printSelectedFamilyKeys.size > 0
                    ? `Assign category to ${printSelectedFamilyKeys.size} selected famil${printSelectedFamilyKeys.size === 1 ? 'y' : 'ies'} (including family members)`
                    : 'Select assigned voters, then assign a category to all of them'}
                  className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    printSelectedFamilyKeys.size > 0
                      ? 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100'
                      : 'border-line bg-white text-ink-secondary hover:bg-muted'
                  }`}
                >
                  {savingBulkCategory ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Tags className="h-3.5 w-3.5" />}
                  {printSelectedFamilyKeys.size > 0 ? `Assign Category (${printSelectedFamilyKeys.size})` : 'Assign Category'}
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${bulkCategoryMenuOpen ? 'rotate-180' : ''}`} />
                </button>
                <FloatingDropdown
                  open={bulkCategoryMenuOpen}
                  onClose={() => setBulkCategoryMenuOpen(false)}
                  anchor={bulkCategoryMenuOpen ? bulkCategoryAnchor : null}
                  className="w-56 overflow-hidden rounded-xl border border-line bg-white p-2"
                >
                  <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                    Assign to selected families
                  </p>
                  {VOTER_CATEGORY_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitem"
                      disabled={savingBulkCategory}
                      className="block w-full rounded-xl px-3 py-2 text-left text-sm text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => { void assignCategoryToSelectedFamilies(option.value) }}
                    >
                      {option.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={savingBulkCategory}
                    className="block w-full rounded-xl px-3 py-2 text-left text-sm text-ink-tertiary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => { void assignCategoryToSelectedFamilies(null) }}
                  >
                    Clear category
                  </button>
                </FloatingDropdown>
              </div>
            )}
            {isAdminAreaAllowed && (
              <div className="relative">
                <button
                  type="button"
                  disabled={savingBulkPlace}
                  onClick={(event) => {
                    if (!printSelectedFamilyKeys.size) {
                      toast.error('Select one or more assigned families first.')
                      return
                    }
                    setBulkPlaceAnchor(event.currentTarget)
                    setBulkPlaceMenuOpen((open) => !open)
                  }}
                  title={printSelectedFamilyKeys.size > 0
                    ? `Assign place to ${printSelectedFamilyKeys.size} selected famil${printSelectedFamilyKeys.size === 1 ? 'y' : 'ies'}`
                    : 'Select assigned families, then assign a place'}
                  className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    printSelectedFamilyKeys.size > 0
                      ? 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100'
                      : 'border-line bg-white text-ink-secondary hover:bg-muted'
                  }`}
                >
                  {savingBulkPlace ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
                  {printSelectedFamilyKeys.size > 0 ? `Assign Place (${printSelectedFamilyKeys.size})` : 'Assign Place'}
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${bulkPlaceMenuOpen ? 'rotate-180' : ''}`} />
                </button>
                <FloatingDropdown
                  open={bulkPlaceMenuOpen}
                  onClose={() => setBulkPlaceMenuOpen(false)}
                  anchor={bulkPlaceMenuOpen ? bulkPlaceAnchor : null}
                  className="w-72 overflow-hidden rounded-xl border border-line bg-white p-2"
                >
                  <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                    Assign to selected families
                  </p>
                  <div className="max-h-56 overflow-y-auto">
                    {placeClubs.map((club) => (
                      <button
                        key={club.id}
                        type="button"
                        role="menuitem"
                        disabled={savingBulkPlace}
                        className="block w-full rounded-xl px-3 py-2 text-left text-sm text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => { void assignPlaceToSelectedFamilies(club.id) }}
                      >
                        {placeClubLabel(club)}
                        <span className="mt-0.5 block text-[11px] font-medium text-ink-tertiary">{placeClubFullLabel(club)}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={savingBulkPlace}
                    className="block w-full rounded-xl px-3 py-2 text-left text-sm text-ink-tertiary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => { void assignPlaceToSelectedFamilies(null) }}
                  >
                    Unclub / Clear place
                  </button>
                  <div className="mt-2 space-y-2 rounded-xl border border-line bg-muted p-2">
                    <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">New place</p>
                    <input
                      className="h-8 w-full rounded-lg border border-line px-2.5 text-xs outline-none"
                      placeholder="Area"
                      value={newPlaceArea}
                      onChange={(event) => setNewPlaceArea(event.target.value)}
                    />
                    <input
                      className="h-8 w-full rounded-lg border border-line px-2.5 text-xs outline-none"
                      placeholder="Chawl"
                      value={newPlaceChawl}
                      onChange={(event) => setNewPlaceChawl(event.target.value)}
                    />
                    <input
                      className="h-8 w-full rounded-lg border border-line px-2.5 text-xs outline-none"
                      placeholder="Building"
                      value={newPlaceBuilding}
                      onChange={(event) => setNewPlaceBuilding(event.target.value)}
                    />
                    <button
                      type="button"
                      disabled={savingBulkPlace}
                      onClick={() => { void createAndAssignPlace() }}
                      className="inline-flex h-8 w-full items-center justify-center rounded-lg bg-brand-600 px-2.5 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
                    >
                      Save and assign
                    </button>
                  </div>
                </FloatingDropdown>
              </div>
            )}
            <button
              type="button"
              disabled={removingBulk}
              onClick={() => {
                if (!printSelectedFamilyKeys.size) {
                  toast.error('Select one or more assigned families first.')
                  return
                }
                setBulkUnassignOpen(true)
              }}
              title={printSelectedFamilyKeys.size > 0
                ? `Unassign ${printSelectedFamilyKeys.size} selected famil${printSelectedFamilyKeys.size === 1 ? 'y' : 'ies'}`
                : 'Select assigned families, then unassign them'}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                printSelectedFamilyKeys.size > 0
                  ? 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                  : 'border-line bg-white text-ink-secondary hover:bg-muted'
              }`}
            >
              {removingBulk ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {printSelectedFamilyKeys.size > 0 ? `Unassign (${printSelectedFamilyKeys.size})` : 'Unassign'}
            </button>
            <button
              type="button"
              disabled={transferring}
              onClick={() => {
                if (!printSelectedFamilyKeys.size) {
                  toast.error('Select one or more assigned families first.')
                  return
                }
                setTransferOpen(true)
              }}
              title={printSelectedFamilyKeys.size > 0
                ? `Transfer ${printSelectedFamilyKeys.size} selected famil${printSelectedFamilyKeys.size === 1 ? 'y' : 'ies'} to another team leader`
                : 'Select assigned families, then choose a team leader to transfer'}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                printSelectedFamilyKeys.size > 0
                  ? 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100'
                  : 'border-line bg-white text-ink-secondary hover:bg-muted'
              }`}
            >
              {transferring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowLeftRight className="h-3.5 w-3.5" />}
              {printSelectedFamilyKeys.size > 0 ? `Transfer (${printSelectedFamilyKeys.size})` : 'Transfer'}
            </button>
            <Link
              to="/places"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 text-xs font-semibold text-violet-700 transition hover:bg-violet-100"
            >
              Places
            </Link>
            <button
              type="button"
              onClick={() => openModalFor('print')}
              title={printSelectedFamilyKeys.size > 0 ? `Print ${printSelectedFamilyKeys.size} selected famil${printSelectedFamilyKeys.size === 1 ? 'y' : 'ies'}` : 'Print all visible families'}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white transition hover:bg-brand-700"
            >
              <Printer className="h-3.5 w-3.5" /> {printSelectedFamilyKeys.size > 0 ? `Print Selected (${printSelectedFamilyKeys.size})` : 'Print / PDF'}
            </button>
          </div>
        </div>

        {tableOverflowsX ? (
          <div className="sticky top-0 z-20 border-b border-line bg-white">
            <div
              ref={topScrollRef}
              onScroll={onTopScroll}
              className="overflow-x-auto overflow-y-hidden"
              aria-label="Scroll assigned voters table horizontally"
            >
              <div ref={topScrollInnerRef} className="h-3" />
            </div>
          </div>
        ) : (
          <div ref={topScrollRef} className="hidden">
            <div ref={topScrollInnerRef} />
          </div>
        )}
        <div
          ref={tableScrollRef}
          onScroll={onTableScroll}
          className="max-h-[min(70vh,calc(100dvh-14rem))] overflow-auto overscroll-contain"
        >
          <table ref={tableElRef} className="min-w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-muted shadow-[0_1px_0_0_#e2e8f0]">
              <tr>
                <th className="w-12 border-b border-line px-5 py-3">
                  <CheckboxUI
                    checked={allVisiblePrintSelected}
                    onChange={() => {
                      if (allVisiblePrintSelected) setPrintSelectedFamilyKeys(new Set())
                      else setPrintSelectedFamilyKeys(new Set(visibleFamilyKeys))
                    }}
                  />
                </th>
                {tableColumns.map((col) => (
                  <th
                    key={col.key}
                    style={columnWidths[col.key] != null ? { width: columnWidths[col.key] } : undefined}
                    className={`group relative border-b border-line px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary ${col.headerClass ?? ''} ${col.sortable ? 'cursor-pointer select-none hover:text-brand-600' : ''}`}
                    onClick={col.sortable ? () => toggleSort(col.key) : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {sortKey === col.key ? (sortDir === 'asc' ? <ChevronsUp className="h-3.5 w-3.5" /> : <ChevronsDown className="h-3.5 w-3.5" />) : null}
                    </span>
                    <ColumnResizeHandle columnKey={col.key} onResize={(key, width) => {
                      if (width === DEFAULT_COLUMN_WIDTHS[key]) {
                        setColumnWidths((prev) => {
                          const next = { ...prev }
                          delete next[key]
                          return next
                        })
                      } else {
                        setColumnWidths((prev) => ({ ...prev, [key]: width }))
                      }
                    }} />
                  </th>
                ))}
                <th className="border-b border-line px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageHeads.map((head, rowIndex) => {
                const family = familyForVoter(head)
                const familyKey = normalizeLookupValue(family.head) || `voter:${head.id}`
                const expanded = expandedFamilyKeys.has(familyKey)
                const isHeadRow = !showFamilyMembers || family.headVoter === head
                const memberRows = showFamilyMembers
                  ? family.members.filter((m) => m.id !== head.id)
                  : (isHeadRow && expanded ? family.members.filter((m) => m.id !== head.id) : [])
                const sizeHighlighted = familySizeFilter != null && family.members.length === familySizeFilter
                const placeLabel = placeClubLabel(placeClubById.get(familyPlaceByHead[familyHeadKey(family.headVoter ?? family.members[0]) || family.head] ?? '') ?? null) || 'Unlabelled'
                const prevHead = rowIndex > 0 ? pageHeads[rowIndex - 1] : null
                const prevFamily = prevHead ? familyForVoter(prevHead) : null
                const prevPlaceLabel = prevFamily
                  ? (placeClubLabel(placeClubById.get(familyPlaceByHead[familyHeadKey(prevFamily.headVoter ?? prevFamily.members[0]) || prevFamily.head] ?? '') ?? null) || 'Unlabelled')
                  : null
                const showPlaceHeader = showPlaceGroupHeaders && placeLabel !== prevPlaceLabel
                return (
                  <Fragment key={head.id}>
                    {showPlaceHeader ? (
                      <tr>
                        <td colSpan={tableColumns.length + 2} className="border-b border-line bg-muted px-5 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
                          {placeLabel}
                          <span className="ml-2 font-medium normal-case tracking-normal text-ink-tertiary">
                            {placeGroups.find((group) => group.label === placeLabel)?.families.length ?? 0} families
                          </span>
                        </td>
                      </tr>
                    ) : null}
                    <tr className={`group transition hover:bg-muted ${sizeHighlighted ? 'bg-brand-50/60' : ''} ${printSelectedFamilyKeys.has(family.key) ? 'bg-brand-50/40' : ''}`}>
                      <td className="border-b border-line px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                        <CheckboxUI checked={printSelectedFamilyKeys.has(family.key)} onChange={() => togglePrintFamily(family.key)} />
                      </td>
                      {renderVoterCells(head, family, pageStartIndex + rowIndex + 1, false)}
                      <td className="border-b border-line px-5 py-3.5">
                        <div className="flex items-center justify-end gap-1.5">
                          {!showFamilyMembers && isHeadRow && family.members.length > 1 && (
                            <IconButton
                              title={expanded ? 'Hide family members' : 'Show family members'}
                              onClick={() => toggleFamilyExpand(familyKey)}
                            >
                              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </IconButton>
                          )}
                          <IconButton title="View voter" onClick={() => setSelectedVoter(head)}>
                            <Eye className="h-4 w-4" />
                          </IconButton>
                          {(() => {
                            const contact = resolveContact(head, family)
                            if (!contact.number) return null
                            const viaName = contact.ownerName && contact.ownerName !== vf(head, 'name') ? ` (via ${contact.ownerName})` : ''
                            return (
                              <IconButton title={`Call${viaName}`} onClick={() => { window.location.href = `tel:${contact.number}` }}>
                                <Phone className="h-4 w-4" />
                              </IconButton>
                            )
                          })()}
                          <MoreMenu>
                            {(close) => (
                              <>
                                {family.members.filter((m) => assignedIds.has(m.id)).length > 1 && (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); close(); setPrimaryTarget(family) }}
                                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink-secondary transition hover:bg-muted"
                                  >
                                    <UserCog className="h-3.5 w-3.5" /> Set primary member
                                  </button>
                                )}
                                <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); close(); openRemoveModal(head) }}
                                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-rose-600 transition hover:bg-rose-50"
                                >
                                  <Trash2 className="h-3.5 w-3.5" /> Remove assignment
                                </button>
                              </>
                            )}
                          </MoreMenu>
                        </div>
                      </td>
                    </tr>
                    {memberRows.map((member) => (
                      <tr key={member.id} className="group bg-muted/70 transition hover:bg-muted">
                        <td className="border-b border-line px-5 py-3.5" />
                        {renderVoterCells(member, family, null, true)}
                        <td className="border-b border-line px-5 py-3.5">
                          <div className="flex items-center justify-end gap-1.5">
                            <IconButton title="View voter" onClick={() => setSelectedVoter(member)}>
                              <Eye className="h-4 w-4" />
                            </IconButton>
                            {(() => {
                              const contact = resolveContact(member, family)
                              if (!contact.number) return null
                              const viaName = contact.ownerName && contact.ownerName !== vf(member, 'name') ? ` (via ${contact.ownerName})` : ''
                              return (
                                <IconButton title={`Call${viaName}`} onClick={() => { window.location.href = `tel:${contact.number}` }}>
                                  <Phone className="h-4 w-4" />
                                </IconButton>
                              )
                            })()}
                            <MoreMenu>
                              {(close) => (
                                <>
                                  {family.members.filter((m) => assignedIds.has(m.id)).length > 1 && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); close(); setPrimaryTarget(family) }}
                                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink-secondary transition hover:bg-muted"
                                    >
                                      <UserCog className="h-3.5 w-3.5" /> Set primary member
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); close(); openRemoveModal(member) }}
                                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-rose-600 transition hover:bg-rose-50"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" /> Remove assignment
                                  </button>
                                </>
                              )}
                            </MoreMenu>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          {pageHeads.length === 0 && (
            <div className="px-6 py-16 text-center text-sm text-ink-tertiary">
              No assigned voters yet. Search above to assign voters to this team leader.
            </div>
          )}
        </div>

        {sortedHeads.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
            <span className="text-xs text-ink-tertiary">
              {sortedHeads.length} voter{sortedHeads.length === 1 ? '' : 's'} · Page {currentPage} of {pageCount}
            </span>
            <div className="flex items-center gap-1.5">
              <IconButton title="Previous page" onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1}>
                <ChevronLeft className="h-4 w-4" />
              </IconButton>
              <IconButton title="Next page" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount}>
                <ChevronRight className="h-4 w-4" />
              </IconButton>
              <select
                className="h-9 rounded-lg border border-line bg-white px-2 text-xs font-semibold text-ink-secondary outline-none"
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }}
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n} per page</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </section>

      {!isSpecialLeader(leader) && (
        <section className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <h2 className="text-base font-semibold text-ink">Remaining Families</h2>
              <p className="text-xs text-ink-tertiary">
                Families in Part {leader.part_no ?? '-'}{leader.section != null ? ` / Section ${leader.section}` : ''} not yet assigned to any team leader.
              </p>
            </div>
          <div className="flex flex-wrap items-center gap-2">
            {remainingOpen && remainingFamilies.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setSelectedRemainingFamilyKeys((prev) => prev.size === remainingFamilies.length ? new Set() : new Set(remainingFamilies.map((family) => family.key)))}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
                >
                  {selectedRemainingFamilyKeys.size === remainingFamilies.length ? 'Clear Selection' : 'Select All'}
                </button>
                <button
                  type="button"
                  onClick={() => void assignSelectedRemainingFamilies()}
                  disabled={assigning || selectedRemainingFamilies.length === 0}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {assigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />} Assign Selected
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => void loadRemaining()}
              disabled={remainingLoading}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:opacity-60"
            >
              {remainingLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              {remainingLoading ? 'Loading...' : remainingOpen ? 'Refresh' : 'Show Remaining'}
            </button>
          </div>
        </div>

        {remainingOpen && (
          remainingLoading ? (
            <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading remaining families...</div>
          ) : remainingFamilies.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-ink-tertiary">
              {leader.part_no == null
                ? 'This team leader has no part assigned yet, so remaining families cannot be computed.'
                : 'All families in this part/section are already assigned to a team leader.'}
            </div>
          ) : (
            <div className="p-5">
              <p className="mb-4 text-xs text-ink-tertiary">
                {remainingFamilies.length} remaining famil{remainingFamilies.length === 1 ? 'y' : 'ies'} · {remainingRows.length} voters
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {remainingFamilies.map((family) => {
                  const head = family.headVoter ?? family.members[0] ?? null
                  const selected = selectedRemainingFamilyKeys.has(family.key)
                  return (
                    <div key={family.key} className={`rounded-2xl border p-4 transition ${selected ? 'border-brand-400 bg-brand-50/60 ring-2 ring-brand-100' : 'border-line'}`}>
                      <div className="flex items-center gap-3">
                        <CheckboxUI checked={selected} onChange={() => toggleRemainingFamilySelection(family.key)} />
                        {head && (
                          head.photo_url ? (
                            <VoterAvatar voter={head} photoUrl={resolvePhotoUrl(head)} />
                          ) : (
                            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700">
                              {head ? initials(head.name) : '?'}
                            </span>
                          )
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-ink">{head?.name ?? 'Unknown head'}</p>
                          <p className="truncate text-xs text-ink-tertiary">
                            {head?.epic_no ? `EPIC: ${head.epic_no} · ` : ''}Part {head?.part_no ?? '-'} / Sec {head?.section ?? '-'}
                          </p>
                        </div>
                        <div className="flex flex-shrink-0 flex-col items-end gap-2">
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                            {family.members.length} member{family.members.length === 1 ? '' : 's'}
                          </span>
                          <button
                            type="button"
                            onClick={() => void assignRemainingFamily(family)}
                            disabled={assigning}
                            className="inline-flex h-8 items-center gap-1 rounded-lg bg-brand-600 px-2.5 text-[11px] font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {assigning ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />} Assign
                          </button>
                        </div>
                      </div>
                      <div className="mt-3 space-y-1.5 border-t border-line pt-3">
                        {family.members.map((m) => (
                          <div key={m.id} className="flex items-center gap-2">
                            {m.photo_url ? (
                              <VoterAvatar voter={m} photoUrl={resolvePhotoUrl(m)} size="sm" />
                            ) : (
                              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-[9px] font-semibold text-brand-700">
                                {initials(m.name)}
                              </span>
                            )}
                            <span className="min-w-0 flex-1 truncate text-xs text-ink-secondary">{m.name}</span>
                            <span className="truncate text-[11px] text-ink-tertiary">{m.epic_no}</span>
                            <IconButton title="View voter" onClick={() => setSelectedVoter(m)}>
                              <Eye className="h-3.5 w-3.5" />
                            </IconButton>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        )}
      </section>
      )}

      <ChangeLeaderModal
        open={changeLeaderOpen}
        currentLeader={leader}
        hasWardRestriction={hasWardRestriction}
        allowedWards={allowedWards}
        saving={savingLeader}
        onClose={() => setChangeLeaderOpen(false)}
        onConfirm={(newLeader, partNo, section) => void handleChangeLeader(newLeader, partNo, section)}
      />

      <TransferFamilyConfirmModal
        open={assignTransferTarget !== null}
        headName={assignTransferTarget?.family.headVoter?.name ?? assignTransferTarget?.family.members[0]?.name ?? 'Unknown head'}
        memberCount={assignTransferTarget?.family.members.length ?? 0}
        sourceLeaderName={assignTransferTarget ? formatLeaderNames(assignTransferTarget.sourceLeaderIds.map((id) => leaderNameById[id])) : undefined}
        targetLeaderName={leaderDisplayName}
        transferring={assignTransferring}
        onClose={() => { if (!assignTransferring) setAssignTransferTarget(null) }}
        onConfirm={() => {
          if (!assignTransferTarget) return
          void handleTransferFromAssignSearch(assignTransferTarget.family, assignTransferTarget.sourceLeaderIds)
        }}
      />

      <BulkTransferModal
        open={transferOpen}
        familyCount={selectedPrintFamilies.length}
        voterCount={selectedUnassignVoterIds.length}
        sourceLeaderName={leaderDisplayName}
        leaders={transferTargetLeaders}
        transferring={transferring}
        onClose={() => { if (!transferring) setTransferOpen(false) }}
        onConfirm={(targetLeaderId) => { void handleTransferConfirm(selectedPrintFamilies, targetLeaderId) }}
      />

      <ReportConfigModal
        title="Assigned Voters"
        open={modalOpen}
        mode={modalMode}
        fieldDefs={printFieldDefsForLeader(leader)}
        fields={mergePrintFieldsForLeader(printFields, leader).map((f) => ({ key: f.key, enabled: f.enabled }))}
        defaultFields={defaultPrintFieldsForLeader(leader).map((f) => ({ key: f.key, enabled: f.enabled }))}
        showLayout
        layout={includeFamilyMembers}
        layoutTrueLabel="Detailed - family head + all members"
        layoutFalseLabel="Family heads only"
        fontSize={printFontSize}
        boldText={printBold}
        defaultFontSize={20}
        defaultBoldText={true}
        showHeaderDetails={printShowHeader}
        exportBorders={exportBorders}
        exportRowHeight={exportRowHeight}
        exportColWidth={exportColWidth}
        includePhotos={exportIncludePhotos}
        showIncludePhotos={modalMode === 'export'}
        printDescription={printSelectedFamilyKeys.size > 0
          ? `Printing ${printSelectedFamilyKeys.size} selected famil${printSelectedFamilyKeys.size === 1 ? 'y' : 'ies'}. Choose columns and layout, then print or download a PDF.`
          : 'Select columns and layout once. Tick families in the table first to print only those. Download PDF saves the file immediately; Open print preview lets you choose a printer or Save as PDF.'}
        extraControls={
          <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-ink-secondary">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-line text-brand-600"
              checked={printGroupByPlace}
              onChange={(event) => setPrintGroupByPlace(event.target.checked)}
            />
            Group print by place
          </label>
        }
        printActionLabel="Open print preview"
        onClose={() => setModalOpen(false)}
        onConfirm={handleModalConfirm}
        onDownloadPdf={modalMode === 'print' ? handlePdfDownload : undefined}
      />

      <RemoveAssignmentModal
        voter={removeTarget}
        voterCount={removeTargetCount}
        onClose={() => setRemoveTarget(null)}
        onConfirm={async () => {
          if (!removeTarget) return
          await removeAssignment(removeTarget)
          setRemoveTarget(null)
        }}
      />

      <BulkUnassignModal
        open={bulkUnassignOpen}
        familyCount={selectedPrintFamilies.length}
        voterCount={selectedUnassignVoterIds.length}
        removing={removingBulk}
        onClose={() => { if (!removingBulk) setBulkUnassignOpen(false) }}
        onConfirm={removeSelectedFamilies}
      />

      <ChangePrimaryVoterModal
        open={primaryTarget !== null}
        family={primaryTarget}
        assignedIds={assignedIds}
        directVoterIds={directVoterIds}
        saving={savingPrimary}
        resolvePhotoUrl={resolvePhotoUrl}
        onClose={() => setPrimaryTarget(null)}
        onConfirm={(family, memberId) => void handleChangePrimary(family, memberId)}
      />

      <VoterDetailDrawer
        voter={selectedVoter}
        onClose={() => setSelectedVoter(null)}
        onSaved={async () => { await load(true) }}
      />
    </div>
  )
}
