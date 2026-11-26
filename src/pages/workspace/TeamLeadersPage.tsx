import { useCallback, useEffect, useMemo, useState, useRef, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  Check,
  ArrowLeftRight,
  ChevronDown,
  Columns3,
  Download,
  FileArchive,
  Loader2,
  MoreHorizontal,
  Pencil,
  Printer,
  Search,
  Trash2,
  UserCog,
  UserPlus,
  Users,
  BarChart3,
  X,
} from 'lucide-react'
import JSZip from 'jszip'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/Button'
import { ReportConfigModal, type ReportFieldItem } from '../../components/common/ReportConfigModal'
import { TransferFamilyConfirmModal, formatLeaderNames } from '../../components/common/TransferFamilyConfirmModal'
import type { TeamLeader, Voter } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { usePersistentState } from '../../hooks/usePersistentState'
import { fetchAllPages } from '../../hooks/useMeetingData'
import {
  fetchLeaderFamilies,
  buildLeaderPdfBlob,
  buildLeaderPrintSectionHtml,
  wrapLeaderPrintDocument,
  resolvePhotoUrlsByPath,
  readDetailPdfSettings,
  mergePrintFieldsForLeader,
} from '../../lib/leaderFamilyPdf'
import {
  buildTeamLeaderScope,
  assignFamilyToLeader,
  clearTeamLeaderDetailCache,
  clearTeamLeadersListCache,
  clearUnassignedDataCache,
  ensureOfficeLeader,
  ensureShiftedLeader,
  isOfficeLeader,
  isShiftedLeader,
  isRentedLeader,
  isSpecialLeader,
  pickCanonicalSpecialLeader,
  consolidateSpecialLeaders,
  readTeamLeaderCache,
  writeTeamLeaderCache,
  fetchAllAssignmentLinks,
  computeLeaderStats,
  chunksOf,
  D1_IN_CHUNK,
  specialLeaderIdSet,
  COUNT_SHIFTED_AS_ASSIGNED_KEY,
  ensureShiftedParkingBackup,
  fetchUnassignedCountingLeaderIds,
  isCustomNamedLeader,
  saveUnassignedCountingLeaderIds,
  transferAssignments,
  resolveTeamLeaderName,
  fetchTeamLeadersSummaryFromApi,
  teamLeaderFromApi,
  voterFromApiLeader,
  statsFromApiLeader,
  emptyLeaderStats,
  emptyUniqueAssignmentCounts,
  type AssignmentLink,
  type LeaderFamilyStats,
  REFRESH_SKIP_MS,
} from '../../lib/teamLeaderCache'
import { fetchInChunks } from '../../lib/d1Query'
import {
  exportRowsToExcel,
  buildPrintHtml,
  openPrintWindow,
  downloadPdfTable,
  saveBlob,
  type ReportFieldDef,
  type PrintStyleOptions,
} from '../../lib/reportBuilder'
import {
  initials,
  compactLookupValue,
  tokenizeLookup,
  normalizeLookupValue,
  escapeIlikePattern,
  isLikelyEpicToken,
  highlightMatch,
  matchesLookupTokens,
} from '../../lib/searchUtils'

const VISIBLE_COLUMNS_KEY = 'vote:teamleaders:visibleColumns:v2'
const REPORT_FONT_SIZE_KEY = 'vote:teamleaders:printFontSize:v2'
const REPORT_BOLD_KEY = 'vote:teamleaders:printBold'
const REPORT_FIELDS_KEY = 'vote:teamleaders:printFields:v2'
const REPORT_FIELD_ORDER_KEY = 'vote:teamleaders:printFieldOrder:v2'
const REPORT_SCOPE_KEY = 'vote:teamleaders:printScope'
const REPORT_GROUP_KEY = 'vote:teamleaders:printGroupBy'
const REPORT_BORDERS_KEY = 'vote:teamleaders:exportBorders'
const REPORT_ROW_HEIGHT_KEY = 'vote:teamleaders:exportRowHeight'
const REPORT_COL_WIDTH_KEY = 'vote:teamleaders:exportColWidth'
const CUSTOM_UNASSIGNED_PANEL_KEY = 'vote:teamleaders:customUnassignedOpen'

interface TeamLeaderWithVoter extends TeamLeader {
  voter?: Voter
  assistantVoter?: Voter
  assignedCount: number
  familyCount: number
}

type LeaderColumnKey =
  | 'srNo'
  | 'photo'
  | 'name'
  | 'epicNo'
  | 'leaderPart'
  | 'leaderSection'
  | 'assignedCount'
  | 'familyCount'
  | 'assistant'
  | 'notes'
  | 'created'
  | 'relativeName'
  | 'relation'
  | 'houseNo'
  | 'age'
  | 'dob'
  | 'gender'
  | 'religion'
  | 'contact1'
  | 'contact2'
  | 'ward'
  | 'voterPart'
  | 'voterSection'
  | 'sectionName'
  | 'voterSrNo'

interface LeaderColumnDef {
  key: LeaderColumnKey
  label: string
  headerClass?: string
}

const LEADER_COLUMNS: LeaderColumnDef[] = [
  { key: 'srNo', label: 'Sr No', headerClass: 'w-14' },
  { key: 'photo', label: 'Photo', headerClass: 'w-14' },
  { key: 'name', label: 'Name', headerClass: 'min-w-[160px]' },
  { key: 'epicNo', label: 'EPIC', headerClass: 'w-28' },
  { key: 'leaderPart', label: 'Part No', headerClass: 'w-20' },
  { key: 'leaderSection', label: 'Section', headerClass: 'w-20' },
  { key: 'assignedCount', label: 'Assigned Voters', headerClass: 'w-28' },
  { key: 'familyCount', label: 'Families', headerClass: 'w-24' },
  { key: 'assistant', label: 'Assistant', headerClass: 'min-w-[140px]' },
  { key: 'notes', label: 'Notes', headerClass: 'min-w-[160px]' },
  { key: 'created', label: 'Created', headerClass: 'w-28' },
  { key: 'relativeName', label: 'Relative', headerClass: 'min-w-[160px]' },
  { key: 'relation', label: 'Relation', headerClass: 'w-24' },
  { key: 'houseNo', label: 'House', headerClass: 'w-24' },
  { key: 'age', label: 'Age', headerClass: 'w-16' },
  { key: 'dob', label: 'DOB', headerClass: 'w-28' },
  { key: 'gender', label: 'Gender', headerClass: 'w-20' },
  { key: 'religion', label: 'Religion', headerClass: 'w-24' },
  { key: 'contact1', label: 'Contact 1', headerClass: 'w-32' },
  { key: 'contact2', label: 'Contact 2', headerClass: 'w-32' },
  { key: 'ward', label: 'Ward', headerClass: 'w-20' },
  { key: 'voterPart', label: 'Voter Part', headerClass: 'w-24' },
  { key: 'voterSection', label: 'Voter Section', headerClass: 'w-24' },
  { key: 'sectionName', label: 'Section Name', headerClass: 'min-w-[140px]' },
  { key: 'voterSrNo', label: 'Voter Sr No', headerClass: 'w-24' },
]

const DEFAULT_LEADER_COLUMNS: LeaderColumnKey[] = [
  'srNo',
  'photo',
  'name',
  'epicNo',
  'leaderPart',
  'leaderSection',
  'assignedCount',
  'familyCount',
  'notes',
  'created',
]

const REPORT_FIELD_LABELS: Record<string, string> = Object.fromEntries(LEADER_COLUMNS.map((c) => [c.key, c.label]))

const REPORT_FIELD_DEFS: Array<{ key: string; label: string }> = LEADER_COLUMNS.map((c) => ({ key: c.key, label: c.label }))

const DEFAULT_REPORT_FIELD_ORDER: LeaderColumnKey[] = [
  'srNo', 'photo', 'name', 'epicNo', 'leaderPart', 'leaderSection',
  'assignedCount', 'familyCount', 'assistant', 'notes', 'created',
  'relativeName', 'relation', 'houseNo', 'age', 'dob', 'gender', 'religion',
  'contact1', 'contact2', 'ward', 'voterPart', 'voterSection', 'sectionName', 'voterSrNo',
]

const INITIAL_REPORT_FIELDS: Record<string, boolean> = {
  srNo: true,
  photo: true,
  name: true,
  epicNo: false,
  leaderPart: false,
  leaderSection: false,
  assignedCount: false,
  familyCount: false,
  assistant: false,
  notes: false,
  created: false,
  relativeName: false,
  relation: false,
  houseNo: false,
  age: false,
  dob: false,
  gender: false,
  religion: false,
  contact1: true,
  contact2: false,
  ward: false,
  voterPart: false,
  voterSection: false,
  sectionName: false,
  voterSrNo: false,
}

function vf(v: Voter | undefined, field: string): string {
  if (!v) return ''
  const value = (v as unknown as Record<string, unknown>)[field]
  return value === null || value === undefined ? '' : String(value)
}

function compareLeadersByPart(a: TeamLeaderWithVoter, b: TeamLeaderWithVoter) {
  const aPart = a.part_no ?? Number.MAX_SAFE_INTEGER
  const bPart = b.part_no ?? Number.MAX_SAFE_INTEGER
  if (aPart !== bPart) return aPart - bPart
  const aSection = a.section ?? Number.MAX_SAFE_INTEGER
  const bSection = b.section ?? Number.MAX_SAFE_INTEGER
  if (aSection !== bSection) return aSection - bSection
  const aName = resolveTeamLeaderName(a, a.voter, '')
  const bName = resolveTeamLeaderName(b, b.voter, '')
  return aName.localeCompare(bName)
}

function getLeaderColumnValue(tl: TeamLeaderWithVoter, key: LeaderColumnKey, rowIndex: number): string {
  switch (key) {
    case 'srNo': return String(rowIndex + 1)
    case 'photo': return ''
    case 'name': return resolveTeamLeaderName(tl, tl.voter, '-')
    case 'epicNo': return vf(tl.voter, 'epic_no') || '-'
    case 'leaderPart': return tl.part_no != null ? String(tl.part_no) : '-'
    case 'leaderSection': return tl.section != null ? String(tl.section) : '-'
    case 'assignedCount': return String(tl.assignedCount)
    case 'familyCount': return String(tl.familyCount)
    case 'assistant': return tl.assistantVoter?.name || '-'
    case 'notes': return tl.notes ?? '-'
    case 'created': return formatDate(tl.created_at)
    case 'relativeName': return vf(tl.voter, 'relative_name') || '-'
    case 'relation': return vf(tl.voter, 'relative_relation') || '-'
    case 'houseNo': return vf(tl.voter, 'house_no') || '-'
    case 'age': return vf(tl.voter, 'age') || '-'
    case 'dob': return tl.voter?.date_of_birth ? formatDate(tl.voter.date_of_birth) : '-'
    case 'gender': return vf(tl.voter, 'gender') || '-'
    case 'religion': return vf(tl.voter, 'religion') || '-'
    case 'contact1': return vf(tl.voter, 'contact_no_1') || '-'
    case 'contact2': return vf(tl.voter, 'contact_no_2') || '-'
    case 'ward': return vf(tl.voter, 'ward_no') || '-'
    case 'voterPart': return vf(tl.voter, 'part_no') || '-'
    case 'voterSection': return vf(tl.voter, 'section') || '-'
    case 'sectionName': return vf(tl.voter, 'section_name') || '-'
    case 'voterSrNo': return vf(tl.voter, 'sr_no_roll') || '-'
    default: return '-'
  }
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

function MoreMenu({ children }: { children: (close: () => void) => ReactNode }) {
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
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-ink-tertiary transition hover:bg-muted hover:text-ink-secondary"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-56 rounded-xl border border-line bg-white p-1.5 shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function ColumnsDropdown({ visible, onChange }: { visible: LeaderColumnKey[]; onChange: (next: LeaderColumnKey[]) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const visibleSet = new Set(visible)

  const toggle = (key: LeaderColumnKey) => {
    const next = new Set(visibleSet)
    if (next.has(key)) {
      if (next.size <= 1) { toast.error('At least one column must remain visible.'); return }
      next.delete(key)
    } else { next.add(key) }
    onChange(LEADER_COLUMNS.map((c) => c.key).filter((k) => next.has(k)))
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted">
        <Columns3 className="h-3.5 w-3.5" /> Display Columns
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-72 rounded-2xl border border-line bg-white p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Show / Hide Columns</p>
          <div className="max-h-[60vh] space-y-0.5 overflow-y-auto">
            {LEADER_COLUMNS.map((col) => {
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

function formatDate(value: unknown): string {
  if (!value) return '-'
  try {
    const d = new Date(value as string)
    if (Number.isNaN(d.getTime())) return '-'
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return '-' }
}

interface FamilyGroup {
  key: string
  head: string
  headVoter: Voter | null
  members: Voter[]
}

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

function VoterAvatar({ voter, photoUrl, size = 'md' }: { voter: Voter; photoUrl?: string; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'h-7 w-7 text-[9px]' : 'h-9 w-9 text-[10px]'
  if (photoUrl) {
    return <img src={photoUrl} alt={voter.name} className={`${dim} flex-shrink-0 rounded-full border border-line object-cover`} />
  }
  return (
    <span className={`${dim} inline-flex flex-shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700`}>
      {initials(voter.name)}
    </span>
  )
}

function RemoveLeaderModal({ leader, onClose, onConfirm }: {
  leader: TeamLeaderWithVoter | null
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [confirmName, setConfirmName] = useState('')
  const [removing, setRemoving] = useState(false)
  useEffect(() => { setConfirmName('') }, [leader])
  if (!leader) return null

  const leaderName = resolveTeamLeaderName(leader, leader.voter, 'this leader')
  const normalizeName = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
  const matches = normalizeName(confirmName) === normalizeName(leaderName)

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
            <h3 className="text-lg font-semibold text-ink">Remove team leader</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-sm leading-6 text-ink-secondary">
          This removes <span className="font-semibold text-ink">&ldquo;{leaderName}&rdquo;</span> as a team leader; their assigned voters will be unlinked. This cannot be undone. To confirm, type the leader&rsquo;s name below.
        </p>
        <label className="mt-4 block text-sm text-ink-secondary">
          Type <span className="font-semibold text-ink">&ldquo;{leaderName}&rdquo;</span> to confirm
          <input autoFocus className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
            value={confirmName} onChange={(e) => setConfirmName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void confirm() }} />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
          <button type="button" disabled={!matches || removing} onClick={() => void confirm()}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-rose-600 px-5 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50">
            {removing && <Loader2 className="h-4 w-4 animate-spin" />} Remove team leader
          </button>
        </div>
      </div>
    </div>
  )
}

// ── ConfirmZipModal ──────────────────────────────────────────────────────
// Asks for confirmation before generating one PDF per filtered team leader and
// bundling them into a single ZIP download (avoids multi-download blocking).

function ConfirmZipModal({ open, leaderCount, filterLabel, downloading, onClose, onConfirm }: {
  open: boolean
  leaderCount: number
  filterLabel: string
  downloading: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
              <FileArchive className="h-4 w-4" />
            </span>
            <h3 className="text-lg font-semibold text-ink">Download All (ZIP)</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-sm leading-6 text-ink-secondary">
          Download {leaderCount} separate PDF{leaderCount === 1 ? '' : 's'} as a ZIP for these {filterLabel ? `${filterLabel} ` : ''}team leader{leaderCount === 1 ? '' : 's'}?
        </p>
        <p className="mt-2 text-xs leading-5 text-ink-tertiary">
          Each PDF uses the print fields and layout saved on a leader&rsquo;s detail page. Leaders with no assigned families are skipped.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
          <button
            type="button"
            disabled={downloading || leaderCount === 0}
            onClick={onConfirm}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileArchive className="h-4 w-4" />} Download
          </button>
        </div>
      </div>
    </div>
  )
}

// ── ConfirmPrintAllModal ────────────────────────────────────────────────
// Asks for confirmation before fetching every filtered leader's assigned
// families and opening one combined print preview (one leader per page).

function ConfirmPrintAllModal({ open, leaderCount, filterLabel, printing, onClose, onConfirm }: {
  open: boolean
  leaderCount: number
  filterLabel: string
  printing: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
              <Printer className="h-4 w-4" />
            </span>
            <h3 className="text-lg font-semibold text-ink">Print All Families</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-sm leading-6 text-ink-secondary">
          Print assigned families for {leaderCount} {filterLabel ? `${filterLabel} ` : ''}team leader{leaderCount === 1 ? '' : 's'} in one print job?
        </p>
        <p className="mt-2 text-xs leading-5 text-ink-tertiary">
          Uses the print fields and layout saved on a leader&rsquo;s detail page. Each leader starts on a new page. Leaders with no assigned families are skipped.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
          <button
            type="button"
            disabled={printing || leaderCount === 0}
            onClick={onConfirm}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {printing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />} Print
          </button>
        </div>
      </div>
    </div>
  )
}

// ── EditLeaderModal ────────────────────────────────────────────────────

function EditLeaderModal({ leader, hasWardRestriction, allowedWards, onClose, onConfirm }: {
  leader: TeamLeaderWithVoter | null
  hasWardRestriction: boolean
  allowedWards: number[]
  onClose: () => void
  onConfirm: (partNo: string, section: string, notes: string, displayName: string, voterId: string | null) => Promise<void>
}) {
  const [partNo, setPartNo] = useState('')
  const [section, setSection] = useState('')
  const [notes, setNotes] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<Voter[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [linkedVoter, setLinkedVoter] = useState<Voter | null>(null)
  const [takenVoterIds, setTakenVoterIds] = useState<Set<string>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (leader) {
      setPartNo(leader.part_no != null ? String(leader.part_no) : '')
      setSection(leader.section != null ? String(leader.section) : '')
      setNotes(leader.notes ?? '')
      setDisplayName(leader.display_name ?? '')
      setLinkedVoter(leader.voter ?? null)
      setQuery('')
      setResults([])
    }
  }, [leader])

  useEffect(() => {
    if (!leader) return
    let cancelled = false
    const run = async () => {
      const { data } = await supabase.from('team_leaders').select('voter_id')
      if (cancelled) return
      const taken = new Set<string>()
      for (const tl of (data as Array<{ voter_id: string | null }> | null) ?? []) {
        if (tl.voter_id && tl.voter_id !== leader.voter_id) taken.add(tl.voter_id)
      }
      setTakenVoterIds(taken)
    }
    void run()
    return () => { cancelled = true }
  }, [leader])

  useEffect(() => {
    if (!query.trim()) { setResults([]); setSearching(false); return }
    let cancelled = false
    const run = async () => {
      setSearching(true)
      const trimmed = query.trim()
      const tokens = tokenizeLookup(trimmed)
      if (tokens.length === 1 && isLikelyEpicToken(tokens[0])) {
        const epicToken = compactLookupValue(tokens[0])
        let req = supabase.from('voters').select('*').eq('epic_no', epicToken)
        if (hasWardRestriction) req = req.in('ward_no', allowedWards)
        const { data: exactRow } = await req.maybeSingle()
        if (cancelled) return
        setResults(exactRow ? [exactRow as Voter] : [])
        setSearching(false)
        return
      }
      const sp = `%${escapeIlikePattern(trimmed).replace(/\s+/g, '%')}%`
      let req = supabase.from('voters').select('*').or([`name.ilike.${sp}`,`relative_name.ilike.${sp}`,`epic_no.ilike.${sp}`,`contact_no_1.ilike.${sp}`,`house_no.ilike.${sp}`].join(',')).limit(20)
      if (hasWardRestriction) req = req.in('ward_no', allowedWards)
      const { data: matches } = await req
      if (cancelled) return
      setResults((matches as Voter[] | null) ?? [])
      setSearching(false)
    }
    void run()
    return () => { cancelled = true }
  }, [query, hasWardRestriction, allowedWards])

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(e.target as Node)) setShowDropdown(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (!leader) return null
  const leaderName = resolveTeamLeaderName(leader, leader.voter, 'this leader')
  const tokens = tokenizeLookup(query)

  const choose = (v: Voter) => {
    if (takenVoterIds.has(v.id)) { toast.error('This voter is already a team leader.'); return }
    setLinkedVoter(v)
    if (!displayName.trim()) setDisplayName(leader.display_name ?? '')
    setQuery('')
    setResults([])
    setShowDropdown(false)
  }

  const confirm = async () => {
    if (saving) return
    if (!linkedVoter && !displayName.trim()) {
      toast.error('Enter a custom name or link a voter.')
      return
    }
    setSaving(true)
    await onConfirm(partNo, section, notes, displayName, linkedVoter?.id ?? null)
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
              <Pencil className="h-4 w-4" />
            </span>
            <h3 className="text-lg font-semibold text-ink">Edit team leader</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-sm leading-6 text-ink-secondary">
          Update the name, part/section, or linked voter for <span className="font-semibold text-ink">&ldquo;{leaderName}&rdquo;</span>. Linking a voter later keeps every assigned family on this leader.
        </p>

        <div className="mt-4">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Custom name</label>
          <input className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            placeholder="Any name or label" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">{linkedVoter ? 'Linked voter' : 'Link to a voter later'}</label>
          {linkedVoter ? (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-brand-200 bg-brand-50/60 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{linkedVoter.name}</p>
                <p className="truncate text-xs text-ink-tertiary">EPIC: {linkedVoter.epic_no || '-'}</p>
              </div>
              <button type="button" onClick={() => setLinkedVoter(null)}
                className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Unlink voter">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div ref={containerRef} className="relative">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
                <input
                  className="h-11 w-full rounded-xl border border-line bg-white pl-10 pr-10 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  placeholder="Search voter by name, EPIC, mobile..."
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); if (!showDropdown) setShowDropdown(true) }}
                  onFocus={() => { if (query.trim()) setShowDropdown(true) }}
                />
                {query && (
                  <button type="button" onClick={() => { setQuery(''); setResults([]) }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear search">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              {showDropdown && query.trim() && searching && (
                <div className="absolute z-20 mt-2 w-full rounded-2xl border border-line bg-white p-4 text-center text-sm text-ink-tertiary">
                  <div className="flex items-center justify-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Searching...</div>
                </div>
              )}
              {showDropdown && query.trim() && !searching && results.length > 0 && (
                <div className="absolute z-20 mt-2 max-h-[40vh] w-full overflow-y-auto rounded-2xl border border-line bg-white">
                  <div className="divide-y divide-line">
                    {results.map((v) => {
                      const isTaken = takenVoterIds.has(v.id)
                      return (
                        <button
                          key={v.id}
                          type="button"
                          disabled={isTaken}
                          onClick={() => choose(v)}
                          className={`flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-muted ${isTaken ? 'opacity-50' : ''}`}
                        >
                          <VoterAvatar voter={v} size="sm" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-ink">
                              {highlightMatch(v.name, tokens)}
                              {isTaken && <span className="ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Already a Leader</span>}
                            </p>
                            <p className="truncate text-xs text-ink-tertiary">
                              EPIC: {highlightMatch(v.epic_no, tokens)}{v.part_no != null ? ` Part: ${v.part_no}` : ''}
                            </p>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {showDropdown && query.trim() && !searching && results.length === 0 && (
                <div className="absolute z-20 mt-2 w-full rounded-2xl border border-line bg-white p-4 text-center text-sm text-ink-tertiary">
                  No voters found.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Part No</label>
            <input className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              type="number" placeholder="Part number" value={partNo} onChange={(e) => setPartNo(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Section</label>
            <input className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              type="number" placeholder="Section" value={section} onChange={(e) => setSection(e.target.value)} />
          </div>
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Notes</label>
          <input className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            placeholder="Optional notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
          <button type="button" disabled={saving} onClick={() => void confirm()}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save changes
          </button>
        </div>
      </div>
    </div>
  )
}

// ── SetAssistantModal ──────────────────────────────────────────────────
// Lets the user attach a voter as the assistant team leader for an existing
// team leader. The assistant is stored on team_leaders.assistant_voter_id.

function SetAssistantModal({ leader, hasWardRestriction, allowedWards, onClose, onConfirm }: {
  leader: TeamLeaderWithVoter | null
  hasWardRestriction: boolean
  allowedWards: number[]
  onClose: () => void
  onConfirm: (assistantVoterId: string | null) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<Voter[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [selected, setSelected] = useState<Voter | null>(leader?.assistantVoter ?? null)
  const [saving, setSaving] = useState(false)
  const [takenVoterIds, setTakenVoterIds] = useState<Set<string>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setSelected(leader?.assistantVoter ?? null) }, [leader])

  useEffect(() => {
    if (!leader) return
    let cancelled = false
    const run = async () => {
      const { data } = await supabase.from('team_leaders').select('voter_id')
      if (cancelled) return
      const taken = new Set<string>()
      for (const tl of (data as Array<{ voter_id: string | null }> | null) ?? []) {
        if (tl.voter_id && tl.voter_id !== leader.voter_id) taken.add(tl.voter_id)
      }
      setTakenVoterIds(taken)
    }
    void run()
    return () => { cancelled = true }
  }, [leader])

  useEffect(() => {
    if (!query.trim()) { setResults([]); setSearching(false); return }
    let cancelled = false
    const run = async () => {
      setSearching(true)
      const trimmed = query.trim()
      const tokens = tokenizeLookup(trimmed)
      if (tokens.length === 1 && isLikelyEpicToken(tokens[0])) {
        const epicToken = compactLookupValue(tokens[0])
        let req = supabase.from('voters').select('*').eq('epic_no', epicToken)
        if (hasWardRestriction) req = req.in('ward_no', allowedWards)
        const { data: exactRow } = await req.maybeSingle()
        if (cancelled) return
        setResults(exactRow ? [exactRow as Voter] : [])
        setSearching(false)
        return
      }
      const sp = `%${escapeIlikePattern(trimmed).replace(/\s+/g, '%')}%`
      let req = supabase.from('voters').select('*').or([`name.ilike.${sp}`,`relative_name.ilike.${sp}`,`epic_no.ilike.${sp}`,`contact_no_1.ilike.${sp}`,`house_no.ilike.${sp}`].join(',')).limit(20)
      if (hasWardRestriction) req = req.in('ward_no', allowedWards)
      const { data: matches } = await req
      if (cancelled) return
      setResults((matches as Voter[] | null) ?? [])
      setSearching(false)
    }
    void run()
    return () => { cancelled = true }
  }, [query, hasWardRestriction, allowedWards])

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(e.target as Node)) setShowDropdown(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const tokens = useMemo(() => tokenizeLookup(query), [query])

  if (!leader) return null

  const leaderName = resolveTeamLeaderName(leader, leader.voter, 'this leader')

  const choose = (v: Voter) => {
    if (v.id === leader.voter_id) { toast.error('This voter is already the team leader.'); return }
    if (takenVoterIds.has(v.id)) { toast.error('This voter is already a team leader.'); return }
    setSelected(v)
    setQuery('')
    setResults([])
    setShowDropdown(false)
  }

  const confirm = async () => {
    if (saving) return
    setSaving(true)
    await onConfirm(selected?.id ?? null)
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
              <UserCog className="h-4 w-4" />
            </span>
            <h3 className="text-lg font-semibold text-ink">Assistant team leader</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-sm leading-6 text-ink-secondary">
          Attach a voter who assists <span className="font-semibold text-ink">&ldquo;{leaderName}&rdquo;</span>. The assistant is informational only - families are still assigned to the team leader.
        </p>

        {selected && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-brand-200 bg-brand-50/60 p-3">
            <div className="flex min-w-0 items-center gap-3">
              <VoterAvatar voter={selected} photoUrl={selected.photo_url ? '' : undefined} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{selected.name}</p>
                <p className="truncate text-xs text-ink-tertiary">EPIC: {selected.epic_no || '-'}</p>
              </div>
            </div>
            <button type="button" onClick={() => setSelected(null)}
              className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear selection">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="mt-4">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Search assistant voter</label>
          <div ref={containerRef} className="relative">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
              <input
                className="h-11 w-full rounded-xl border border-line bg-white pl-10 pr-10 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                placeholder="Search by name, EPIC, mobile, house number..."
                value={query}
                onChange={(e) => { setQuery(e.target.value); if (!showDropdown) setShowDropdown(true) }}
                onFocus={() => { if (query.trim()) setShowDropdown(true) }}
              />
              {query && (
                <button type="button" onClick={() => { setQuery(''); setResults([]) }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear search">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {showDropdown && query.trim() && searching && (
              <div className="absolute z-20 mt-2 w-full rounded-2xl border border-line bg-white p-4 text-center text-sm text-ink-tertiary">
                <div className="flex items-center justify-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Searching...</div>
              </div>
            )}
            {showDropdown && query.trim() && !searching && results.length > 0 && (
              <div className="absolute z-20 mt-2 max-h-[60vh] w-full overflow-y-auto rounded-2xl border border-line bg-white">
                <div className="divide-y divide-line">
                  {results.map((v) => {
                    const isCurrentLeader = v.id === leader.voter_id
                    const isTaken = takenVoterIds.has(v.id)
                    const disabled = isCurrentLeader || isTaken
                    return (
                      <button
                        key={v.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => choose(v)}
                        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-muted ${disabled ? 'opacity-50' : ''}`}
                      >
                        <VoterAvatar voter={v} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink">
                            {highlightMatch(v.name, tokens)}
                            {isCurrentLeader && <span className="ml-2 inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">Current Leader</span>}
                            {isTaken && <span className="ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Already a Leader</span>}
                          </p>
                          <p className="truncate text-xs text-ink-tertiary">
                            EPIC: {highlightMatch(v.epic_no, tokens)}{v.part_no != null ? ` Part: ${v.part_no}` : ''}{v.section != null ? ` Sec: ${v.section}` : ''}
                          </p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {showDropdown && query.trim() && !searching && results.length === 0 && (
              <div className="absolute z-20 mt-2 w-full rounded-2xl border border-line bg-white p-4 text-center text-sm text-ink-tertiary">No voters found.</div>
            )}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
          <button type="button" disabled={saving} onClick={() => void confirm()}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save assistant
          </button>
        </div>
      </div>
    </div>
  )
}

// ── ReportConfigModal ──────────────────────────────────────────────────


export function TeamLeadersPage() {
  const { profile, isAdminAreaAllowed, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const [voters, setVoters] = useState<Voter[]>([])
  const [leaders, setLeaders] = useState<TeamLeader[]>([])
  const [leaderStats, setLeaderStats] = useState<Record<string, LeaderFamilyStats>>({})
  const [uniqueAssigned, setUniqueAssigned] = useState(() => emptyUniqueAssignmentCounts())
  const [leaderStatsLoaded, setLeaderStatsLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>({})
  const [visibleColumns, setVisibleColumns] = usePersistentState<LeaderColumnKey[]>(VISIBLE_COLUMNS_KEY, [...DEFAULT_LEADER_COLUMNS])

  const [showPrintConfig, setShowPrintConfig] = useState(false)
  const [showExportConfig, setShowExportConfig] = useState(false)
  const [reportGroupBy, setReportGroupBy] = usePersistentState<'none' | 'part' | 'section'>(REPORT_GROUP_KEY, 'none')
  const [reportScope, setReportScope] = usePersistentState<'filtered' | 'all'>(REPORT_SCOPE_KEY, 'filtered')
  const [reportFields, setReportFields] = usePersistentState<Record<string, boolean>>(REPORT_FIELDS_KEY, { ...INITIAL_REPORT_FIELDS })
  const [reportFieldOrder, setReportFieldOrder] = usePersistentState<LeaderColumnKey[]>(REPORT_FIELD_ORDER_KEY, [...DEFAULT_REPORT_FIELD_ORDER])
  const [reportFontSize, setReportFontSize] = usePersistentState<number>(REPORT_FONT_SIZE_KEY, 20)
  const [reportBold, setReportBold] = usePersistentState<boolean>(REPORT_BOLD_KEY, false)
  const [reportBorders, setReportBorders] = usePersistentState<boolean>(REPORT_BORDERS_KEY, true)
  const [reportRowHeight, setReportRowHeight] = usePersistentState<number>(REPORT_ROW_HEIGHT_KEY, 18)
  const [reportColWidth, setReportColWidth] = usePersistentState<number>(REPORT_COL_WIDTH_KEY, 16)

  const [searchParams, setSearchParams] = useSearchParams()

  const [partSummaryOpen, setPartSummaryOpen] = useState(false)

  const [zipConfirmOpen, setZipConfirmOpen] = useState(false)
  const [zipDownloading, setZipDownloading] = useState(false)
  const [printAllConfirmOpen, setPrintAllConfirmOpen] = useState(false)
  const [printAllPrinting, setPrintAllPrinting] = useState(false)
  const [countShiftedAsAssigned, setCountShiftedAsAssigned] = usePersistentState<boolean>(COUNT_SHIFTED_AS_ASSIGNED_KEY, false)
  const [unassignedCountingLeaderIds, setUnassignedCountingLeaderIds] = useState<string[]>([])
  const [savingUnassignedCounting, setSavingUnassignedCounting] = useState(false)
  const [customUnassignedOpen, setCustomUnassignedOpen] = usePersistentState<boolean>(CUSTOM_UNASSIGNED_PANEL_KEY, false)
  const isAdminOnly = profile?.role === 'admin'

  const partFilter = searchParams.get('part') ?? ''
  const sectionFilter = searchParams.get('section') ?? ''
  const leaderQuery = searchParams.get('q') ?? ''

  const setPartFilter = useCallback((value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value) next.set('part', value)
    else next.delete('part')
    next.delete('section')
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  const setSectionFilter = useCallback((value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value) next.set('section', value)
    else next.delete('section')
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  const setLeaderQuery = useCallback((value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value) next.set('q', value)
    else next.delete('q')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const [createMode, setCreateMode] = useState<'voter' | 'named'>('voter')
  const [customLeaderName, setCustomLeaderName] = useState('')
  const [voterQuery, setVoterQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<Voter[]>([])
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [showDropdown, setShowDropdown] = useState(false)
  const [partNo, setPartNo] = useState('')
  const [section, setSection] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const [selectedLeaderIds, setSelectedLeaderIds] = useState<Set<string>>(new Set())
  const [removeTarget, setRemoveTarget] = useState<TeamLeaderWithVoter | null>(null)
  const [assistantTarget, setAssistantTarget] = useState<TeamLeaderWithVoter | null>(null)
  const [editTarget, setEditTarget] = useState<TeamLeaderWithVoter | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkRows, setBulkRows] = useState<Voter[]>([])
  const [bulkTargetLeaderId, setBulkTargetLeaderId] = useState('')
  const [bulkSelectedFamilyKeys, setBulkSelectedFamilyKeys] = useState<Set<string>>(new Set())
  const [bulkAssigning, setBulkAssigning] = useState(false)

  const [voterToLeaderId, setVoterToLeaderId] = useState<Record<string, string>>({})
  const [leaderDisplayNameById, setLeaderDisplayNameById] = useState<Record<string, string>>({})

  const [familyQuery, setFamilyQuery] = useState('')
  const [familySearching, setFamilySearching] = useState(false)
  const [familySearchResults, setFamilySearchResults] = useState<Voter[]>([])
  const [familySearchRows, setFamilySearchRows] = useState<Voter[]>([])
  const [familyDropdownOpen, setFamilyDropdownOpen] = useState(false)
  const [familyAssigning, setFamilyAssigning] = useState(false)
  const [familyTransferring, setFamilyTransferring] = useState(false)
  const [transferTarget, setTransferTarget] = useState<{ family: FamilyGroup; sourceLeaderIds: string[] } | null>(null)
  const familySearchRef = useRef<HTMLDivElement>(null)

  const allowedWards = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((w) => Number.isFinite(w)))); wards.sort((a, b) => a - b); return wards
  }, [profile?.allowed_wards])
  const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0

  const load = useCallback(async (forceRefresh = false) => {
    const cacheScope = buildTeamLeaderScope(profile?.role ?? null, profile?.allowed_wards ?? null)
    const cached = forceRefresh ? null : readTeamLeaderCache(cacheScope)
    if (cached) {
      setLeaders(cached.data.leaders)
      setVoterToLeaderId(cached.data.voterToLeaderId)
      setLeaderStats(cached.data.leaderStats)
      setLeaderDisplayNameById(cached.data.leaderDisplayNameById)
      setVoters(cached.data.voters)
      if (cached.data.uniqueAssigned) setUniqueAssigned(cached.data.uniqueAssigned)
      setLeaderStatsLoaded(true)
      setLoading(false)
      void fetchUnassignedCountingLeaderIds().then(setUnassignedCountingLeaderIds).catch(() => undefined)
      if (Date.now() - cached.savedAt < REFRESH_SKIP_MS) return
    } else if (!forceRefresh) {
      setLoading(true)
      setLeaderStatsLoaded(false)
    }
    try {
      const [summary, allAssignRes, countingIds] = await Promise.all([
        fetchTeamLeadersSummaryFromApi(),
        fetchAllAssignmentLinks(),
        fetchUnassignedCountingLeaderIds().catch(() => [] as string[]),
      ])
      setUnassignedCountingLeaderIds(countingIds)
      const apiRows = summary.teamLeaders
      if (allAssignRes.error) toast.error(allAssignRes.error)

      const tls = apiRows.map(teamLeaderFromApi)
      setLeaders(tls)

      const assignments = allAssignRes.data
      const voterToLeader: Record<string, string> = {}
      for (const a of assignments) {
        if (a.voter_id) voterToLeader[a.voter_id] = a.team_leader_id
      }
      setVoterToLeaderId(voterToLeader)

      const stats: Record<string, LeaderFamilyStats> = {}
      for (const row of apiRows) stats[row.id] = statsFromApiLeader(row)
      for (const tl of tls) if (!stats[tl.id]) stats[tl.id] = emptyLeaderStats()
      setLeaderStats(stats)
      setLeaderStatsLoaded(true)

      const voterRows: Voter[] = []
      const seenVoters = new Set<string>()
      const leaderNames: Record<string, string> = {}
      for (const row of apiRows) {
        const voter = voterFromApiLeader(row)
        if (voter && !seenVoters.has(voter.id)) {
          seenVoters.add(voter.id)
          voterRows.push(voter)
        }
        const name = resolveTeamLeaderName(row, voter ?? (row.voter_name ? { name: row.voter_name } : null), '')
        if (name) leaderNames[row.id] = name
      }

      const assistantVoterIds = tls
        .map((tl) => tl.assistant_voter_id)
        .filter((id): id is string => typeof id === 'string' && !seenVoters.has(id))
      if (assistantVoterIds.length) {
        const assistants = await fetchInChunks<Voter>(assistantVoterIds, (chunk) => {
          let req = supabase.from('voters').select('*').in('id', chunk)
          if (hasWardRestriction) req = req.in('ward_no', allowedWards)
          return req
        })
        for (const v of assistants) {
          if (seenVoters.has(v.id)) continue
          seenVoters.add(v.id)
          voterRows.push(v)
        }
      }

      setVoters(voterRows)
      setLeaderDisplayNameById(leaderNames)
      setUniqueAssigned(summary.uniqueAssigned)
      setLoading(false)
      writeTeamLeaderCache(cacheScope, {
        leaders: tls,
        voterToLeaderId: voterToLeader,
        leaderStats: stats,
        leaderDisplayNameById: leaderNames,
        voters: voterRows,
        uniqueAssigned: summary.uniqueAssigned,
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load team leaders.')
      setLoading(false)
    }
  }, [profile?.role, profile?.allowed_wards, hasWardRestriction, allowedWards])

  useEffect(() => {
    if (authLoading) return
    let cancelled = false
    void (async () => {
      // The global Shifted / Single assignees must exist before the list
      // is loaded so they show up as assignable targets right away.
      try {
        await ensureShiftedParkingBackup()
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Could not backup Shifted parking data.')
      }
      if (cancelled) return
      const [office, shifted] = await Promise.all([ensureOfficeLeader(), ensureShiftedLeader()])
      if (cancelled) return
      const consolidation = await consolidateSpecialLeaders()
      if (cancelled) return
      if (office?.created || shifted?.created || consolidation.changed) {
        clearTeamLeadersListCache()
        clearTeamLeaderDetailCache()
        clearUnassignedDataCache()
      }
      await load()
    })()
    return () => { cancelled = true }
  }, [load, authLoading])

  // After assigning a family we patch local state (and the cache) instead of
  // re-running the whole heavy load: only the affected leader's stats are
  // recomputed, which makes assignment feel instant.
  const applyAssignmentPatch = useCallback(async (rows: Array<{ team_leader_id: string; voter_id: string }>, leaderIds: string | string[]) => {
    const nextVoterToLeader = { ...voterToLeaderId }
    for (const r of rows) nextVoterToLeader[r.voter_id] = r.team_leader_id
    setVoterToLeaderId(nextVoterToLeader)

    const links: AssignmentLink[] = Object.entries(nextVoterToLeader).map(([voter_id, team_leader_id]) => ({ voter_id, team_leader_id }))
    const patched = await computeLeaderStats(links, { hasWardRestriction, allowedWards }, leaderIds)
    const nextStats = { ...leaderStats, ...patched }
    setLeaderStats(nextStats)

    const cacheScope = buildTeamLeaderScope(profile?.role ?? null, profile?.allowed_wards ?? null)
    writeTeamLeaderCache(cacheScope, {
      leaders,
      voterToLeaderId: nextVoterToLeader,
      leaderStats: nextStats,
      leaderDisplayNameById,
      voters,
    })

    // Assignments changed here, so the detail page and unassigned pages must
    // refetch on their next visit instead of trusting their caches.
    clearTeamLeaderDetailCache()
    clearUnassignedDataCache()
  }, [voterToLeaderId, leaderStats, leaders, leaderDisplayNameById, voters, profile?.role, profile?.allowed_wards, hasWardRestriction, allowedWards])

  const voterById = useMemo(() => { const m = new Map<string, Voter>(); for (const v of voters) m.set(v.id, v); return m }, [voters])

  const leadersWithVoters = useMemo<TeamLeaderWithVoter[]>(() => {
    return leaders.map((tl) => ({
      ...tl,
      voter: tl.voter_id ? voterById.get(tl.voter_id) : undefined,
      assistantVoter: tl.assistant_voter_id ? voterById.get(tl.assistant_voter_id) : undefined,
      assignedCount: leaderStats[tl.id]?.members ?? 0,
      familyCount: leaderStats[tl.id]?.families ?? 0,
    }))
  }, [leaders, voterById, leaderStats])

  // Parts are the leaders' own declared part_no; sections cascade per part.
  // Special parking assignees are filtered out of these (they have no part/section).
  const partOptions = useMemo(() => {
    const parts = new Set(
      leaders.filter((tl) => !isSpecialLeader(tl)).map((tl) => tl.part_no).filter((p): p is number => p !== null && p !== undefined),
    )
    return Array.from(parts).sort((a, b) => a - b)
  }, [leaders])

  const sectionOptions = useMemo(() => {
    if (!partFilter) return []
    const partNum = Number(partFilter)
    if (!Number.isFinite(partNum)) return []
    const sections = new Set(
      leaders.filter((tl) => !isSpecialLeader(tl) && tl.part_no === partNum).map((tl) => tl.section).filter((s): s is number => s !== null && s !== undefined),
    )
    return Array.from(sections).sort((a, b) => a - b)
  }, [leaders, partFilter])

  useEffect(() => {
    if (partFilter && sectionFilter) {
      const valid = sectionOptions.some((s) => String(s) === sectionFilter)
      if (!valid) setSectionFilter('')
    }
  }, [sectionOptions, sectionFilter, partFilter, setSectionFilter])

  const leaderSearchTokens = useMemo(() => tokenizeLookup(leaderQuery), [leaderQuery])

  const filteredLeaders = useMemo(() => {
    const filtered = leadersWithVoters.filter((tl) => {
      if (isSpecialLeader(tl) || isRentedLeader(tl)) return false
      if (partFilter) {
        if (tl.part_no == null || String(tl.part_no) !== partFilter) return false
      }
      if (sectionFilter) {
        if (tl.section == null || String(tl.section) !== sectionFilter) return false
      }
      if (leaderSearchTokens.length) {
        const lookupText = normalizeLookupValue(`${resolveTeamLeaderName(tl, tl.voter, '')} ${tl.voter?.epic_no ?? ''} ${tl.display_name ?? ''}`)
        if (!matchesLookupTokens(lookupText, leaderSearchTokens)) return false
      }
      return true
    })
    return [...filtered].sort(compareLeadersByPart)
  }, [leadersWithVoters, partFilter, sectionFilter, leaderSearchTokens])

  const reportSourceRows = reportScope === 'all'
    ? [...leadersWithVoters].sort(compareLeadersByPart)
    : filteredLeaders

  // Build the detail-page URL while preserving the current list filters, so
  // returning via the detail page's back link keeps e.g. the part filter.
  // Optionally adds the auto-download trigger param.
  const buildLeaderDetailUrl = (leaderId: string, download?: 'excel' | 'pdf'): string => {
    const next = new URLSearchParams(searchParams)
    next.delete('download')
    if (download) next.set('download', download)
    const qs = next.toString()
    return `/team-leaders/${leaderId}${qs ? `?${qs}` : ''}`
  }

  const resolveLeaderPhotoUrl = (tl: TeamLeaderWithVoter): string => {
    if (!tl.voter?.photo_url) return ''
    return photoUrlByPath[tl.voter.photo_url] ?? ''
  }

  const buildReportFields = (rows: TeamLeaderWithVoter[], orderedKeys: LeaderColumnKey[]): ReportFieldDef<TeamLeaderWithVoter>[] => {
    return orderedKeys.map((key) => ({
      key,
      label: REPORT_FIELD_LABELS[key] ?? key,
      getValue: (tl: TeamLeaderWithVoter) => {
        if (key === 'photo') return resolveLeaderPhotoUrl(tl)
        return getLeaderColumnValue(tl, key, rows.indexOf(tl))
      },
    }))
  }

  const applyReportFields = (items: ReportFieldItem[]): LeaderColumnKey[] => {
    const order = items.map((f) => f.key as LeaderColumnKey)
    const map: Record<string, boolean> = {}
    for (const f of items) map[f.key] = f.enabled
    setReportFieldOrder(order)
    setReportFields(map)
    return order.filter((key) => map[key])
  }

  const handleExportExcel = (style: PrintStyleOptions, items?: ReportFieldItem[]) => {
    const orderedKeys = items
      ? items.filter((f) => f.enabled).map((f) => f.key as LeaderColumnKey)
      : reportFieldOrder.filter((key) => reportFields[key])
    if (!orderedKeys.length) {
      toast.error('Select at least one column to export.')
      return
    }
    const fields = buildReportFields(reportSourceRows, orderedKeys)
    const meta = `Generated ${new Date().toLocaleString()} • ${reportSourceRows.length} team leaders${partFilter ? ` • Part ${partFilter}` : ''}${sectionFilter ? ` • Section ${sectionFilter}` : ''}`
    void exportRowsToExcel({
      rows: reportSourceRows,
      fields,
      fileName: 'team-leaders',
      title: partFilter ? `PART ${partFilter}` : 'Team Leaders',
      meta,
      ...(reportGroupBy !== 'none'
        ? {
            groupBy: {
              groupBy: reportGroupBy,
              resolve: (tl: TeamLeaderWithVoter) => reportGroupBy === 'part'
                ? (tl.part_no != null ? `Part ${tl.part_no}` : 'Part -')
                : (tl.section != null ? `Section ${tl.section}` : 'Section -'),
            },
          }
        : {}),
    }, style)
    setShowExportConfig(false)
  }

  const handlePrint = (style: PrintStyleOptions, items?: ReportFieldItem[]) => {
    const orderedKeys = items
      ? items.filter((f) => f.enabled).map((f) => f.key as LeaderColumnKey)
      : reportFieldOrder.filter((key) => reportFields[key])
    if (!orderedKeys.length) {
      toast.error('Select at least one column to print.')
      return
    }
    const fields = buildReportFields(reportSourceRows, orderedKeys)
    const hasPhoto = orderedKeys.includes('photo')
    const title = (reportScope === 'filtered' && partFilter)
      ? `PART ${partFilter}${sectionFilter ? `  ·  Section ${sectionFilter}` : ''}`
      : 'Team Leaders Report'
    const meta = `Generated ${new Date().toLocaleString()} • ${reportSourceRows.length} team leaders${partFilter ? ` • Part ${partFilter}` : ''}${sectionFilter ? ` • Section ${sectionFilter}` : ''}`
    let votersAssigned = 0
    let familiesAssigned = 0
    for (const tl of reportSourceRows) {
      votersAssigned += tl.assignedCount
      familiesAssigned += tl.familyCount
    }
    const footer = `Total Voters Assigned: ${votersAssigned}    |    Total Families Assigned: ${familiesAssigned}`
    const html = buildPrintHtml({
      rows: reportSourceRows,
      fields,
      title,
      meta,
      footer,
      photoResolver: hasPhoto ? (tl: TeamLeaderWithVoter) => resolveLeaderPhotoUrl(tl) : undefined,
      ...(reportGroupBy !== 'none'
        ? {
            groupBy: {
              groupBy: reportGroupBy,
              resolve: (tl: TeamLeaderWithVoter) => reportGroupBy === 'part'
                ? (tl.part_no != null ? `Part ${tl.part_no}` : 'Part -')
                : (tl.section != null ? `Section ${tl.section}` : 'Section -'),
            },
          }
        : {}),
    }, style)
    openPrintWindow(html)
    setShowPrintConfig(false)
  }

  const handleQuickPdfDownload = async () => {
    const orderedKeys = reportFieldOrder.filter((key) => reportFields[key])
    if (!orderedKeys.length) {
      toast.error('Select at least one column in Print settings first.')
      setShowPrintConfig(true)
      return
    }

    const fields = buildReportFields(reportSourceRows, orderedKeys)
    const rows = reportSourceRows.map((row) => fields.map((field) => field.getValue(row)))
    const scopeLabel = reportScope === 'all' ? 'all team leaders' : 'current filtered view'
    const groupLabel = reportGroupBy === 'none' ? '' : ` • grouped by ${reportGroupBy}`
    const fileName = `team-leaders-${new Date().toISOString().slice(0, 10)}.pdf`

    const pdfToast = toast.loading('Preparing PDF...')
    try {
      await downloadPdfTable({
        title: (reportScope === 'filtered' && partFilter)
          ? `PART ${partFilter}${sectionFilter ? `  ·  Section ${sectionFilter}` : ''}`
          : 'Team Leaders Report',
        summary: [
          ['Scope', `${scopeLabel}${groupLabel}`],
          ['Total', String(reportSourceRows.length)],
          ['Generated', new Date().toLocaleString()],
        ],
        headers: fields.map((field) => field.label),
        rows,
        fieldKeys: orderedKeys,
        fontSize: reportFontSize,
        boldText: reportBold,
        fileName,
      })
      toast.success(`PDF downloaded (${reportSourceRows.length} team leaders).`, { id: pdfToast })
    } catch {
      toast.error('Could not generate the PDF.', { id: pdfToast })
    }
  }

  // Label of the active part/section filter, used in the ZIP confirm message
  // and the ZIP file name so the batch download reflects what is on screen.
  const zipFilterLabel = useMemo(() => {
    if (partFilter) return sectionFilter ? `Part ${partFilter} / Section ${sectionFilter}` : `Part ${partFilter}`
    if (sectionFilter) return `Section ${sectionFilter}`
    return ''
  }, [partFilter, sectionFilter])

  // Downloads one ZIP containing one PDF per currently filtered team leader.
  // Each PDF is generated with the exact same logic and persisted settings as
  // the detail page's "Download PDF", so a filtered batch matches what users
  // see per leader. Leaders are processed sequentially so the photo images of
  // one PDF are released before the next leader's are fetched (keeping peak
  // memory bounded), and leaders with no assigned families are skipped.
  const handleDownloadAllZip = async () => {
    if (!filteredLeaders.length || zipDownloading) return
    setZipDownloading(true)
    const settings = readDetailPdfSettings()
    const zip = new JSZip()
    const date = new Date().toISOString().slice(0, 10)
    const total = filteredLeaders.length
    let added = 0
    let skipped = 0
    const zipToast = toast.loading(`Adding 0/${total} - preparing...`)
    try {
      for (const tl of filteredLeaders) {
        const data = await fetchLeaderFamilies(tl.id, { hasWardRestriction, allowedWards })
        if (data.families.length === 0) {
          skipped += 1
          continue
        }
        const photoMap = await resolvePhotoUrlsByPath([
          ...(data.leaderVoter ? [data.leaderVoter] : []),
          ...data.rows,
          ...data.familyRows,
        ])
        const resolvePhotoUrl = (v: Voter | null | undefined) => (v?.photo_url ? photoMap[v.photo_url] ?? '' : '')
        const blob = await buildLeaderPdfBlob({
          leader: data.leader,
          leaderVoter: data.leaderVoter,
          families: data.families,
          settings: {
            fields: mergePrintFieldsForLeader(settings.fields, data.leader),
            includeFamilyMembers: settings.includeFamilyMembers,
            fontSize: settings.fontSize,
            boldText: settings.boldText,
            showHeaderDetails: settings.showHeaderDetails,
            assignedVoterIds: new Set(data.rows.map((r) => r.id)),
            directVoterIds: new Set(data.directVoterIds),
            resolvePhotoUrl,
          },
        })
        const leaderName = resolveTeamLeaderName(data.leader, data.leaderVoter)
        const slug = leaderName.trim().replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'team-leader'
        zip.file(`${slug}-assigned-voters-${date}.pdf`, blob)
        added += 1
        toast.loading(`Adding ${added}/${total} - ${leaderName}...`, { id: zipToast })
      }

      if (added === 0) {
        toast.error('None of the filtered team leaders have assigned families to download.', { id: zipToast })
        return
      }

      const content = await zip.generateAsync({ type: 'blob' })
      const filterName = partFilter
        ? `part-${partFilter}${sectionFilter ? `-section-${sectionFilter}` : ''}`
        : sectionFilter
          ? `section-${sectionFilter}`
          : ''
      const zipName = filterName ? `team-leaders-${filterName}-${date}.zip` : `team-leaders-${date}.zip`
      saveBlob(content, zipName)
      toast.success(
        `Downloaded ${added} PDF${added === 1 ? '' : 's'} as ${zipName}${skipped ? ` (${skipped} skipped - no assigned families)` : ''}.`,
        { id: zipToast },
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the ZIP download.', { id: zipToast })
    } finally {
      setZipDownloading(false)
    }
  }

  const handlePrintAllFamilies = async () => {
    if (!filteredLeaders.length || printAllPrinting) return
    setPrintAllPrinting(true)
    const settings = readDetailPdfSettings()
    const total = filteredLeaders.length
    let added = 0
    let skipped = 0
    const sections: string[] = []
    const printToast = toast.loading(`Preparing 0/${total} - fetching families...`)
    try {
      for (const tl of filteredLeaders) {
        const data = await fetchLeaderFamilies(tl.id, { hasWardRestriction, allowedWards })
        if (data.families.length === 0) {
          skipped += 1
          continue
        }
        const photoMap = await resolvePhotoUrlsByPath([
          ...(data.leaderVoter ? [data.leaderVoter] : []),
          ...data.rows,
          ...data.familyRows,
        ])
        const resolvePhotoUrl = (v: Voter | null | undefined) => (v?.photo_url ? photoMap[v.photo_url] ?? '' : '')
        sections.push(buildLeaderPrintSectionHtml({
          leader: data.leader,
          leaderVoter: data.leaderVoter,
          families: data.families,
          settings: {
            fields: mergePrintFieldsForLeader(settings.fields, data.leader),
            includeFamilyMembers: settings.includeFamilyMembers,
            fontSize: settings.fontSize,
            boldText: settings.boldText,
            showHeaderDetails: settings.showHeaderDetails,
            assignedVoterIds: new Set(data.rows.map((r) => r.id)),
            directVoterIds: new Set(data.directVoterIds),
            resolvePhotoUrl,
          },
        }))
        added += 1
        const leaderName = resolveTeamLeaderName(data.leader, data.leaderVoter)
        toast.loading(`Preparing ${added}/${total} - ${leaderName}...`, { id: printToast })
      }

      if (added === 0) {
        toast.error('None of the filtered team leaders have assigned families to print.', { id: printToast })
        return
      }

      const title = zipFilterLabel
        ? `Team Leaders ${zipFilterLabel} - Assigned Families`
        : 'Team Leaders - Assigned Families'
      openPrintWindow(wrapLeaderPrintDocument(sections.join(''), settings.fontSize, settings.boldText, title))
      toast.success(
        `Opened print preview for ${added} leader${added === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped - no assigned families)` : ''}.`,
        { id: printToast },
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not prepare the print preview.', { id: printToast })
    } finally {
      setPrintAllPrinting(false)
    }
  }

  const visiblePhotoPaths = useMemo(() => {
    const set = new Set<string>()
    for (const tl of leadersWithVoters) {
      if (tl.voter?.photo_url) set.add(tl.voter.photo_url)
    }
    for (const v of familySearchRows) {
      if (v.photo_url) set.add(v.photo_url)
    }
    for (const v of searchResults) {
      if (v.photo_url) set.add(v.photo_url)
    }
    if (selectedVoter?.photo_url) set.add(selectedVoter.photo_url)
    return Array.from(set)
  }, [familySearchRows, leadersWithVoters, searchResults, selectedVoter])

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
    void run(); return () => { cancelled = true }
  }, [photoUrlByPath, visiblePhotoPaths])

  const leaderIds = useMemo(() => new Set(leaders.map((tl) => tl.voter_id)), [leaders])

  // Map of leader id -> leader name for resolving "already assigned to X".
  const leaderNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const [leaderId, name] of Object.entries(leaderDisplayNameById)) m.set(leaderId, name)
    for (const tl of leadersWithVoters) {
      m.set(tl.id, resolveTeamLeaderName(tl, tl.voter, m.get(tl.id) ?? 'Team Leader'))
    }
    return m
  }, [leaderDisplayNameById, leadersWithVoters])

  const tokens = useMemo(() => tokenizeLookup(voterQuery), [voterQuery])

  useEffect(() => {
    if (!voterQuery.trim()) { setSearchResults([]); return }
    let cancelled = false
    const run = async () => {
      setSearching(true)
      const trimmed = voterQuery.trim()
      const searchTokens = tokenizeLookup(trimmed)

      if (searchTokens.length === 0) {
        setSearchResults([]); setSearching(false); return
      }

      if (searchTokens.length === 1 && isLikelyEpicToken(searchTokens[0])) {
        const epicToken = compactLookupValue(searchTokens[0])
        let exactReq = supabase.from('voters').select('*').eq('epic_no', epicToken)
        if (hasWardRestriction) exactReq = exactReq.in('ward_no', allowedWards)
        const { data: exactRow } = await exactReq.maybeSingle()
        if (cancelled) return
        if (exactRow) {
          setSearchResults([exactRow as Voter])
          setSearching(false)
          return
        }
        setSearchResults([]); setSearching(false); return
      }

      // Match across tokens in ANY order - each token must appear in at least
      // one searchable field, so multi-word names like "RAVI KUMAR" resolve
      // even when stored in a different word order.
      let req = supabase.from('voters').select('*')
      for (const token of searchTokens) {
        const sp = `%${escapeIlikePattern(token)}%`
        req = req.or([`name.ilike.${sp}`,`relative_name.ilike.${sp}`,`epic_no.ilike.${sp}`,`contact_no_1.ilike.${sp}`,`contact_no_2.ilike.${sp}`,`house_no.ilike.${sp}`].join(','))
      }
      if (hasWardRestriction) req = req.in('ward_no', allowedWards)
      req = req.limit(20)
      const { data: matches } = await req
      if (cancelled) return
      setSearchResults((matches as Voter[] | null) ?? [])
      setSearching(false)
    }
    void run(); return () => { cancelled = true }
  }, [voterQuery, hasWardRestriction, allowedWards])

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(e.target as Node)) setShowDropdown(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (familySearchRef.current && !familySearchRef.current.contains(e.target as Node)) setFamilyDropdownOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selectVoter = (v: Voter) => {
    if (leaderIds.has(v.id)) {
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

  const resetCreateForm = () => {
    setSelectedVoter(null)
    setCustomLeaderName('')
    setPartNo('')
    setSection('')
    setNotes('')
    setVoterQuery('')
    setSearchResults([])
  }

  const createLeader = async () => {
    const namedLabel = customLeaderName.trim()
    if (createMode === 'named') {
      if (!namedLabel) { toast.error('Enter a name for this team leader.'); return }
    } else if (!selectedVoter) {
      toast.error('Select a voter first.')
      return
    }
    setSaving(true)
    const payload = {
      voter_id: createMode === 'voter' ? selectedVoter!.id : null,
      display_name: namedLabel || (createMode === 'named' ? namedLabel : null),
      part_no: partNo ? Number(partNo) : null,
      section: section ? Number(section) : null,
      notes: notes.trim() || null,
      created_by: profile?.id ?? null,
    }
    const { data, error } = await supabase.from('team_leaders').insert(payload).select('*').maybeSingle()
    let created = (data as TeamLeader | null) ?? null
    if (error) {
      const isDuplicate = error.message.includes('team_leaders_voter_id_key') || error.code === '23505'
      if (!isDuplicate || !selectedVoter) {
        setSaving(false)
        toast.error(error.message)
        return
      }
      const existing = await supabase.from('team_leaders').select('*').eq('voter_id', selectedVoter.id).maybeSingle()
      created = (existing.data as TeamLeader | null) ?? null
      if (!created) {
        setSaving(false)
        toast.error(error.message)
        return
      }
    }
    const createdName = resolveTeamLeaderName(created, selectedVoter, namedLabel || 'Team Leader')
    if (created) {
      setLeaders((current) => current.some((tl) => tl.id === created!.id) ? current : [created!, ...current])
      if (selectedVoter) {
        setVoters((current) => current.some((v) => v.id === selectedVoter.id) ? current : [...current, selectedVoter])
      }
      setLeaderDisplayNameById((current) => ({ ...current, [created!.id]: createdName }))
    }
    toast.success(`${createdName} assigned as team leader.`)
    resetCreateForm()
    clearTeamLeadersListCache()
    clearTeamLeaderDetailCache()
    clearUnassignedDataCache()
    setSaving(false)
    await load(true)
  }

  const removeLeader = async (leaderId: string): Promise<boolean> => {
    // 0-family leaders have no assignment rows. Do not treat "0 rows deleted"
    // (RPC false / empty delete) as failure — only a remaining leader row is.
    const rpc = await supabase.rpc('remove_team_leader', { p_leader_id: leaderId })
    if (rpc.error) {
      const unlink = await supabase.from('team_leader_assignments').delete().eq('team_leader_id', leaderId)
      if (unlink.error) { toast.error(unlink.error.message); return false }
      const del = await supabase.from('team_leaders').delete().eq('id', leaderId)
      if (del.error) { toast.error(del.error.message); return false }
    }

    const { data: stillThere, error: checkError } = await supabase
      .from('team_leaders')
      .select('id')
      .eq('id', leaderId)
      .maybeSingle()
    if (checkError) { toast.error(checkError.message); return false }
    if (stillThere) {
      toast.error('Could not remove this team leader.')
      return false
    }

    toast.success('Team leader removed.')
    clearTeamLeadersListCache()
    clearTeamLeaderDetailCache()
    clearUnassignedDataCache()
    await load(true)
    return true
  }

  const updateLeader = async (leaderId: string, partNo: string, section: string, notes: string, displayName: string, voterId: string | null) => {
    const { error } = await supabase.from('team_leaders').update({
      part_no: partNo ? Number(partNo) : null,
      section: section ? Number(section) : null,
      notes: notes.trim() || null,
      display_name: displayName.trim() || null,
      voter_id: voterId,
    }).eq('id', leaderId)
    if (error) { toast.error(error.message); return }
    toast.success('Team leader updated.')
    setEditTarget(null)
    clearTeamLeadersListCache()
    clearTeamLeaderDetailCache()
    clearUnassignedDataCache()
    await load(true)
  }

  const setAssistant = async (leaderId: string, voterId: string | null) => {
    const target = leaders.find((tl) => tl.id === leaderId)
    if (!target) return
    const voter = voterId ? voterById.get(voterId) : undefined
    const targetName = resolveTeamLeaderName(target, target.voter_id ? voterById.get(target.voter_id) : undefined)
    const { error } = await supabase.from('team_leaders').update({ assistant_voter_id: voterId }).eq('id', leaderId)
    if (error) { toast.error(error.message); return }
    toast.success(`Assistant set for ${targetName ?? 'team leader'}${voter ? ` to ${voter.name}` : ' (none)'}.`)
    setAssistantTarget(null)
    const nextLeaders = leaders.map((tl) => (tl.id === leaderId ? { ...tl, assistant_voter_id: voterId } : tl))
    setLeaders(nextLeaders)
    const cacheScope = buildTeamLeaderScope(profile?.role ?? null, profile?.allowed_wards ?? null)
    const cachedEntry = readTeamLeaderCache(cacheScope)
    if (cachedEntry) {
      writeTeamLeaderCache(cacheScope, { ...cachedEntry.data, leaders: nextLeaders })
    }
    clearTeamLeaderDetailCache()
    clearUnassignedDataCache()
  }

  // Dashboard totals respect the active part/section filter - computed only
  // from the currently filtered team leaders.
  const filteredTotals = useMemo(() => {
    let voters = 0
    let families = 0
    let male = 0
    let female = 0
    for (const tl of filteredLeaders) {
      const s = leaderStats[tl.id]
      voters += s?.members ?? 0
      families += s?.families ?? 0
      male += s?.male ?? 0
      female += s?.female ?? 0
    }
    return { voters, families, male, female }
  }, [filteredLeaders, leaderStats])

  // Special parking assignees are tracked as their own leader rows but kept out
  // of the leader table; surface their counts here so admin can see how many
  // voters/families are parked under Shifted / Single.
  const officeLeader = useMemo(() => pickCanonicalSpecialLeader(leaders, isOfficeLeader, leaderStats), [leaders, leaderStats])
  const officeStats = useMemo(() => (officeLeader ? leaderStats[officeLeader.id] : undefined), [officeLeader, leaderStats])

  const shiftedLeader = useMemo(() => pickCanonicalSpecialLeader(leaders, isShiftedLeader, leaderStats), [leaders, leaderStats])
  const shiftedStats = useMemo(() => (shiftedLeader ? leaderStats[shiftedLeader.id] : undefined), [shiftedLeader, leaderStats])
  const customNamedLeaders = useMemo(
    () => leadersWithVoters.filter((tl) => isCustomNamedLeader(tl)).sort((a, b) => resolveTeamLeaderName(a, a.voter, '').localeCompare(resolveTeamLeaderName(b, b.voter, ''))),
    [leadersWithVoters],
  )
  const unassignedCountingIdSet = useMemo(() => new Set(unassignedCountingLeaderIds), [unassignedCountingLeaderIds])

  const toggleUnassignedCountingLeader = async (leaderId: string, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...unassignedCountingLeaderIds, leaderId]))
      : unassignedCountingLeaderIds.filter((id) => id !== leaderId)
    setUnassignedCountingLeaderIds(next)
    setSavingUnassignedCounting(true)
    try {
      const saved = await saveUnassignedCountingLeaderIds(next)
      setUnassignedCountingLeaderIds(saved)
      clearUnassignedDataCache()
      const summary = await fetchTeamLeadersSummaryFromApi().catch(() => null)
      if (summary) setUniqueAssigned(summary.uniqueAssigned)
      toast.success(checked ? 'This leader now counts as unassigned.' : 'This leader now counts as assigned.')
    } catch (error) {
      setUnassignedCountingLeaderIds(unassignedCountingLeaderIds)
      toast.error(error instanceof Error ? error.message : 'Could not save unassigned counting.')
    } finally {
      setSavingUnassignedCounting(false)
    }
  }

  const assignedTotals = useMemo(() => {
    if (partFilter || sectionFilter) return filteredTotals
    const base = uniqueAssigned.families > 0 || uniqueAssigned.voters > 0
      ? {
          voters: uniqueAssigned.voters,
          families: uniqueAssigned.families,
          male: uniqueAssigned.male,
          female: uniqueAssigned.female,
        }
      : filteredTotals
    if (!countShiftedAsAssigned || !officeStats) return base
    return {
      voters: base.voters + (officeStats.members ?? 0),
      families: base.families + (officeStats.families ?? 0),
      male: base.male + (officeStats.male ?? 0),
      female: base.female + (officeStats.female ?? 0),
    }
  }, [countShiftedAsAssigned, officeStats, partFilter, sectionFilter, filteredTotals, uniqueAssigned])
  const splitFamilyCount = uniqueAssigned.splitFamilies
  const perLeaderFamilySum = filteredTotals.families

  // Special parking ids - families parked under them still count as unassigned,
  // so the "remaining families" / bulk-assign lists must ignore those rows.
  const specialLeaderIds = useMemo(() => specialLeaderIdSet(leaders), [leaders])

  // Part-wise summary for the dashboard - one card per part (clickable to filter).
  const partSummary = useMemo(() => {
    const map = new Map<number | null, { leaders: number; voters: number; families: number; male: number; female: number }>()
    for (const tl of leadersWithVoters) {
      if (isSpecialLeader(tl) || isRentedLeader(tl)) continue
      const key = tl.part_no ?? null
      const acc = map.get(key) ?? (map.set(key, { leaders: 0, voters: 0, families: 0, male: 0, female: 0 }).get(key)!)
      acc.leaders += 1
      const s = leaderStats[tl.id]
      acc.voters += s?.members ?? 0
      acc.families += s?.families ?? 0
      acc.male += s?.male ?? 0
      acc.female += s?.female ?? 0
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] ?? Number.MAX_SAFE_INTEGER) - (b[0] ?? Number.MAX_SAFE_INTEGER))
  }, [leadersWithVoters, leaderStats])

  const selectedLeaders = useMemo(
    () => filteredLeaders.filter((tl) => selectedLeaderIds.has(tl.id)),
    [filteredLeaders, selectedLeaderIds],
  )

  const toggleLeaderSelection = (id: string) => {
    setSelectedLeaderIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allFilteredSelected = filteredLeaders.length > 0 && filteredLeaders.every((tl) => selectedLeaderIds.has(tl.id))

  const loadBulk = useCallback(async () => {
    if (!selectedLeaders.length) return
    setBulkOpen(true)
    setBulkLoading(true)
    setBulkTargetLeaderId(selectedLeaders[0]?.id ?? '')
    setBulkSelectedFamilyKeys(new Set())
    try {
      const assignedRows = await fetchAllPages<{ voter_id: string; team_leader_id: string | null }>(async (from, to) => supabase.from('team_leader_assignments').select('voter_id, team_leader_id').range(from, to), 1000)
      const assignedSet = new Set(
        assignedRows
          .filter((a) => a.team_leader_id && !specialLeaderIds.has(a.team_leader_id))
          .map((a) => a.voter_id)
          .filter(Boolean),
      )

      const parts = new Set<number>()
      const partSections = new Map<number, Set<number>>()
      for (const tl of selectedLeaders) {
        if (tl.part_no == null) continue
        parts.add(tl.part_no)
        if (tl.section != null) {
          if (!partSections.has(tl.part_no)) partSections.set(tl.part_no, new Set())
          partSections.get(tl.part_no)!.add(tl.section)
        }
      }

      const rows: Voter[] = []
      for (const part of Array.from(parts)) {
        let req = supabase.from('voters').select('*').eq('part_no', part)
        const sections = partSections.get(part)
        if (sections && sections.size) req = req.in('section', Array.from(sections))
        if (hasWardRestriction) req = req.in('ward_no', allowedWards)
        const { data, error } = await req
        if (error) { toast.error(error.message); continue }
        rows.push(...((data as Voter[] | null) ?? []))
      }

      const remaining: Voter[] = []
      const groups = new Map<string, Voter[]>()
      for (const v of rows) {
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
      setBulkRows(remaining)
    } finally {
      setBulkLoading(false)
    }
  }, [selectedLeaders, hasWardRestriction, allowedWards, specialLeaderIds])

  const bulkFamilies = useMemo(() => {
    if (!bulkRows.length) return []
    return buildFamilies(bulkRows)
  }, [bulkRows])

  const bulkSelectedFamilies = useMemo(() => {
    if (!bulkSelectedFamilyKeys.size) return []
    return bulkFamilies.filter((family) => bulkSelectedFamilyKeys.has(family.key))
  }, [bulkFamilies, bulkSelectedFamilyKeys])

  const toggleBulkFamilySelection = (familyKey: string) => {
    setBulkSelectedFamilyKeys((prev) => {
      const next = new Set(prev)
      if (next.has(familyKey)) next.delete(familyKey)
      else next.add(familyKey)
      return next
    })
  }

  const assignBulkFamilies = async () => {
    if (!bulkTargetLeaderId || !bulkSelectedFamilies.length) return
    setBulkAssigning(true)
    try {
      const seenIds = new Set<string>()
      const voterIds: string[] = []
      const isDirectVoterIds = new Set<string>()
      for (const family of bulkSelectedFamilies) {
        const directVoter = family.headVoter ?? family.members[0]
        for (const member of family.members) {
          if (seenIds.has(member.id)) continue
          seenIds.add(member.id)
          voterIds.push(member.id)
          if (directVoter && member.id === directVoter.id) isDirectVoterIds.add(member.id)
        }
      }
      if (!voterIds.length) { toast.error('No voters to assign.'); return }

      const result = await assignFamilyToLeader({
        voterIds,
        toLeaderId: bulkTargetLeaderId,
        assignedBy: profile?.id ?? null,
        isDirectVoterIds,
        specialLeaderIds,
      })
      if (!result.voterIds.length) { toast.error('Selected families are already assigned.'); return }
      const assignedRows = result.voterIds.map((voter_id) => ({ voter_id, team_leader_id: bulkTargetLeaderId }))
      toast.success(`Assigned ${result.voterIds.length} voter${result.voterIds.length === 1 ? '' : 's'} from ${bulkSelectedFamilies.length} famil${bulkSelectedFamilies.length === 1 ? 'y' : 'ies'}.`)
      setBulkSelectedFamilyKeys(new Set())
      await applyAssignmentPatch(assignedRows, bulkTargetLeaderId)
      if (bulkOpen) await loadBulk()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBulkAssigning(false)
    }
  }

  const selectedSearchLeader = selectedLeaders.length === 1 ? selectedLeaders[0] : null
  const familyAssignTokens = useMemo(() => tokenizeLookup(familyQuery), [familyQuery])

  useEffect(() => {
    if (!familyQuery.trim() || !selectedSearchLeader) { setFamilySearchResults([]); setFamilySearchRows([]); return }
    let cancelled = false
    const run = async () => {
      setFamilySearching(true)
      const trimmed = familyQuery.trim()
      const searchTokens = tokenizeLookup(trimmed)

      if (searchTokens.length === 1 && isLikelyEpicToken(searchTokens[0])) {
        const epicToken = compactLookupValue(searchTokens[0])
        let exactReq = supabase.from('voters').select('*').eq('epic_no', epicToken)
        if (hasWardRestriction) exactReq = exactReq.in('ward_no', allowedWards)
        const { data: exactRow } = await exactReq.maybeSingle()
        if (cancelled) return
        setFamilySearchResults(exactRow ? [exactRow as Voter] : [])
        setFamilySearching(false)
        return
      }

      const sp = `%${escapeIlikePattern(trimmed).replace(/\s+/g, '%')}%`
      let req = supabase.from('voters').select('*').or([`name.ilike.${sp}`,`relative_name.ilike.${sp}`,`epic_no.ilike.${sp}`,`contact_no_1.ilike.${sp}`,`house_no.ilike.${sp}`].join(',')).limit(20)
      if (hasWardRestriction) req = req.in('ward_no', allowedWards)
      const { data: matches } = await req
      if (cancelled) return
      setFamilySearchResults((matches as Voter[] | null) ?? [])
      setFamilySearching(false)
    }
    void run()
    return () => { cancelled = true }
  }, [allowedWards, familyQuery, hasWardRestriction, selectedSearchLeader])

  useEffect(() => {
    if (!familySearchResults.length) { setFamilySearchRows([]); return }
    let cancelled = false
    const run = async () => {
      const keys = Array.from(new Set(familySearchResults.map((v) => normalizeLookupValue(v.family_head_epic) || normalizeLookupValue(v.epic_no)).filter(Boolean)))
      const members: Voter[] = []
      for (let i = 0; i < keys.length; i += D1_IN_CHUNK) {
        const chunk = keys.slice(i, i + D1_IN_CHUNK)
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
      setFamilySearchRows(members.filter((voter) => {
        if (seen.has(voter.id)) return false
        seen.add(voter.id)
        return true
      }))
    }
    void run()
    return () => { cancelled = true }
  }, [allowedWards, familySearchResults, hasWardRestriction])

  const familySearchFamilies = useMemo(() => {
    if (!familySearchResults.length) return []
    const searchedIds = new Set(familySearchResults.map((v) => v.id))
    const seen = new Set<string>()
    const merged: Voter[] = []
    for (const voter of [...familySearchResults, ...familySearchRows]) {
      if (seen.has(voter.id)) continue
      seen.add(voter.id)
      merged.push(voter)
    }
    return buildFamilies(merged).filter((family) => family.members.some((member) => searchedIds.has(member.id)))
  }, [familySearchResults, familySearchRows])

  const assignSearchedFamily = async (family: FamilyGroup, directVoter?: Voter | null) => {
    if (!selectedSearchLeader) { toast.error('Select exactly one team leader first.'); return }
    setFamilyAssigning(true)
    try {
      const rowsToInsert: Array<{ team_leader_id: string; voter_id: string; assigned_by: string | null; is_direct: boolean }> = []
      const direct = directVoter ?? family.headVoter ?? family.members[0]
      const seenIds = new Set<string>()
      for (const member of family.members) {
        if (seenIds.has(member.id)) continue
        seenIds.add(member.id)
        rowsToInsert.push({
          team_leader_id: selectedSearchLeader.id,
          voter_id: member.id,
          assigned_by: profile?.id ?? null,
          is_direct: direct ? member.id === direct.id : false,
        })
      }
      if (!rowsToInsert.length) { toast.error('No voters to assign.'); return }

      const assignedElsewhere = new Map<string, string>()
      for (const chunk of chunksOf(rowsToInsert.map((r) => r.voter_id), D1_IN_CHUNK)) {
        const { data, error } = await supabase
          .from('team_leader_assignments')
          .select('voter_id, team_leader_id')
          .in('voter_id', chunk)
        if (error) { toast.error(error.message); return }
        for (const row of (data as Array<{ voter_id: string; team_leader_id: string }> | null) ?? []) {
          assignedElsewhere.set(row.voter_id, row.team_leader_id)
        }
      }
      const finalRows = rowsToInsert.filter((r) => !assignedElsewhere.has(r.voter_id))
      if (!finalRows.length) {
        const assignedLeaderIds = Array.from(new Set(assignedElsewhere.values()))
        const assignedLeaderName = assignedLeaderIds.length === 1 ? leaderNameById.get(assignedLeaderIds[0]) : undefined
        toast.error(assignedLeaderName ? `Selected family is already assigned to ${assignedLeaderName}.` : 'Selected family is already assigned to another team leader.')
        return
      }

      const { error: insertError } = await supabase.from('team_leader_assignments').insert(finalRows)
      if (insertError) { toast.error(insertError.message); return }
      const skipped = rowsToInsert.length - finalRows.length
      toast.success(`Assigned ${finalRows.length} voter${finalRows.length === 1 ? '' : 's'} from ${family.members.length} family member${family.members.length === 1 ? '' : 's'} to ${resolveTeamLeaderName(selectedSearchLeader, selectedSearchLeader.voter, 'selected leader')}${skipped ? ` (${skipped} skipped - already assigned)` : ''}.`)
      setFamilyQuery('')
      setFamilySearchResults([])
      setFamilySearchRows([])
      setFamilyDropdownOpen(false)
      await applyAssignmentPatch(finalRows, selectedSearchLeader.id)
    } finally {
      setFamilyAssigning(false)
    }
  }

  // Move an already-assigned family to the currently selected leader straight
  // from the search results, so no round-trip through the other leader's page
  // is needed. Mirrors the detail-page transfer behaviour.
  const handleTransferSearchedFamily = async (family: FamilyGroup, sourceLeaderIds: string[]) => {
    if (!selectedSearchLeader) { toast.error('Select exactly one team leader first.'); return }
    setFamilyTransferring(true)
    try {
      const voterIds = family.members.map((m) => m.id)
      const result = await transferAssignments({
        voterIds,
        fromLeaderIds: sourceLeaderIds,
        toLeaderId: selectedSearchLeader.id,
        assignedBy: profile?.id ?? null,
      })
      const remainingIds = voterIds.filter((id) => voterToLeaderId[id] !== selectedSearchLeader.id && !result.rows.some((row) => row.voter_id === id))
      const assigned = remainingIds.length
        ? await assignFamilyToLeader({
            voterIds: remainingIds,
            toLeaderId: selectedSearchLeader.id,
            assignedBy: profile?.id ?? null,
            isDirectVoterIds: new Set(family.headVoter?.id ? [family.headVoter.id] : [family.members[0]?.id].filter(Boolean) as string[]),
            specialLeaderIds,
          })
        : { inserted: 0, moved: 0, skipped: 0, voterIds: [] as string[] }
      const nowAssignedIds = Array.from(new Set([...result.rows.map((row) => row.voter_id), ...assigned.voterIds]))
      if (!nowAssignedIds.length) {
        toast.success('All voters in this family are already assigned to the selected team leader.')
        setTransferTarget(null)
        return
      }
      const extraAssigned = assigned.inserted + assigned.moved
      toast.success(
        `Transferred ${result.moved} voter${result.moved === 1 ? '' : 's'} to ${resolveTeamLeaderName(selectedSearchLeader, selectedSearchLeader.voter, 'selected leader')}${extraAssigned ? `; assigned ${extraAssigned} more` : ''}${result.skipped || assigned.skipped ? ` (${result.skipped + assigned.skipped} already at target)` : ''}.`,
      )
      setTransferTarget(null)
      setFamilyQuery('')
      setFamilySearchResults([])
      setFamilySearchRows([])
      setFamilyDropdownOpen(false)
      await applyAssignmentPatch(
        nowAssignedIds.map((voter_id) => ({ voter_id, team_leader_id: selectedSearchLeader.id })),
        [selectedSearchLeader.id, ...sourceLeaderIds],
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Transfer failed.')
    } finally {
      setFamilyTransferring(false)
    }
  }

  const bulkTargetLeader = selectedLeaders.find((tl) => tl.id === bulkTargetLeaderId)

  return (
    <div className="space-y-5 pb-10">
      <PageHeader title="Team Leaders" description="Create team leaders from voters or a custom name, then manage their assigned families." />

      <section className="rounded-xl border border-line bg-white p-5 shadow-soft">
        <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Assign a Team Leader</h2>
        <p className="text-xs text-ink-tertiary">Create a named leader now, or search a voter. You can link a named leader to a voter later.</p>

        <div className="mt-4 inline-flex rounded-xl border border-line bg-muted p-1">
          <button
            type="button"
            onClick={() => { setCreateMode('voter'); setCustomLeaderName('') }}
            className={`h-9 rounded-lg px-3 text-xs font-semibold transition ${createMode === 'voter' ? 'bg-white text-ink shadow-sm' : 'text-ink-tertiary hover:text-ink-secondary'}`}
          >
            From voter
          </button>
          <button
            type="button"
            onClick={() => { setCreateMode('named'); setSelectedVoter(null); setVoterQuery(''); setSearchResults([]) }}
            className={`h-9 rounded-lg px-3 text-xs font-semibold transition ${createMode === 'named' ? 'bg-white text-ink shadow-sm' : 'text-ink-tertiary hover:text-ink-secondary'}`}
          >
            Custom name
          </button>
        </div>

        {createMode === 'named' && (
          <div className="mt-4 space-y-4">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Leader name</label>
              <input
                className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                placeholder="Any name or label"
                value={customLeaderName}
                onChange={(e) => setCustomLeaderName(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Part No</label>
                <input className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  type="number" placeholder="Part number" value={partNo} onChange={(e) => setPartNo(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Section</label>
                <input className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  type="number" placeholder="Section" value={section} onChange={(e) => setSection(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Notes</label>
                <input className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  placeholder="Optional notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end">
              <Button disabled={saving} loading={saving} onClick={() => void createLeader()}>
                <UserPlus className="h-4 w-4" /> Create named team leader
              </Button>
            </div>
          </div>
        )}

        {createMode === 'voter' && (
        <>
        <div className="mt-4">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Search Voter</label>
          <div ref={containerRef} className="relative">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
              <input className="h-11 w-full rounded-xl border border-line bg-white pl-10 pr-10 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                placeholder="Search by name, EPIC, relative name, mobile, house number..." value={voterQuery}
                onChange={(e) => { setVoterQuery(e.target.value); if (!showDropdown) setShowDropdown(true) }}
                onFocus={() => { if (voterQuery.trim()) setShowDropdown(true) }} />
              {voterQuery && (
                <button type="button" onClick={() => { setVoterQuery(''); setSearchResults([]) }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear search">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {showDropdown && voterQuery.trim() && searching && (
              <div className="absolute z-20 mt-2 w-full rounded-2xl border border-line bg-white p-4">
                <div className="flex items-center justify-center gap-2 text-sm text-ink-tertiary"><Loader2 className="h-4 w-4 animate-spin" /> Searching...</div>
              </div>
            )}

            {showDropdown && voterQuery.trim() && !searching && searchResults.length > 0 && (
              <div className="absolute z-20 mt-2 w-full max-h-[60vh] overflow-y-auto rounded-2xl border border-line bg-white">
                <div className="divide-y divide-line">
                  {searchResults.map((v) => {
                    const alreadyLeader = leaderIds.has(v.id)
                    const assignedLeaderId = voterToLeaderId[v.id]
                    const assignedLeaderName = assignedLeaderId ? leaderNameById.get(assignedLeaderId) : undefined
                    const photo = v.photo_url ? photoUrlByPath[v.photo_url] : undefined
                    return (
                      <button
                        key={v.id}
                        type="button"
                        disabled={alreadyLeader}
                        onClick={() => selectVoter(v)}
                        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-muted ${alreadyLeader ? 'opacity-50' : ''}`}
                      >
                        <VoterAvatar voter={v} photoUrl={photo} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink">
                            {highlightMatch(v.name, tokens)}
                            {alreadyLeader && <span className="ml-2 inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">Already Leader</span>}
                            {assignedLeaderName && <span className="ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Already assigned to {assignedLeaderName}</span>}
                          </p>
                          <p className="truncate text-xs text-ink-tertiary">
                            EPIC: {highlightMatch(v.epic_no, tokens)}{v.part_no != null ? ` Part: ${v.part_no}` : ''}{v.section != null ? ` Sec: ${v.section}` : ''}{v.house_no ? ` House: ${v.house_no}` : ''}
                          </p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {showDropdown && voterQuery.trim() && !searching && searchResults.length === 0 && (
              <div className="absolute z-20 mt-2 w-full rounded-2xl border border-line bg-white p-4 text-center text-sm text-ink-tertiary">
                No voters found.
              </div>
            )}
          </div>
        </div>

        {selectedVoter && (
          <div className="mt-4 rounded-2xl border border-line bg-muted/50 p-4">
            <div className="flex flex-wrap items-start gap-4">
              <VoterAvatar voter={selectedVoter} photoUrl={selectedVoter.photo_url ? photoUrlByPath[selectedVoter.photo_url] : undefined} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">{selectedVoter.name}</p>
                <p className="text-xs text-ink-tertiary">
                  EPIC: {selectedVoter.epic_no}
                  {selectedVoter.part_no != null ? ` Part: ${selectedVoter.part_no}` : ''}
                  {selectedVoter.section != null ? ` Section: ${selectedVoter.section}` : ''}
                </p>
                {(() => {
                  const assignedLeaderName = leaderNameById.get(voterToLeaderId[selectedVoter.id])
                  if (!assignedLeaderName) return null
                  return <p className="mt-1 text-xs font-medium text-amber-700">Already assigned to {assignedLeaderName}</p>
                })()}
              </div>
              <button type="button" onClick={() => setSelectedVoter(null)}
                className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear selection">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Part No</label>
                <input className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  type="number" placeholder="Part number" value={partNo} onChange={(e) => setPartNo(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Section</label>
                <input className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  type="number" placeholder="Section" value={section} onChange={(e) => setSection(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Notes</label>
                <input className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  placeholder="Optional notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <Button disabled={saving} loading={saving} onClick={() => void createLeader()}>
                <UserPlus className="h-4 w-4" /> Assign as Team Leader
              </Button>
            </div>
          </div>
        )}
        </>
        )}
      </section>

      <section className="rounded-xl border border-line bg-white p-5 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Search Family & Assign</h2>
            <p className="text-xs text-ink-tertiary">Select one team leader below, search a family here, and assign all family members directly from this page.</p>
          </div>
          <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${selectedSearchLeader ? 'bg-brand-50 text-brand-700' : 'bg-muted text-ink-tertiary'}`}>
            {selectedSearchLeader ? `Assigning to ${resolveTeamLeaderName(selectedSearchLeader, selectedSearchLeader.voter, 'selected leader')}` : selectedLeaderIds.size > 1 ? 'Select one leader only' : 'Select a leader'}
          </span>
        </div>

        <div ref={familySearchRef} className="relative mt-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
            <input
              className="h-11 w-full rounded-xl border border-line bg-white pl-10 pr-10 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
              placeholder={selectedSearchLeader ? 'Search family by name, EPIC, relative name, mobile, house number...' : selectedLeaderIds.size > 1 ? 'Select only one team leader to search and assign a family...' : 'Select a team leader to enable family search...'}
              value={familyQuery}
              disabled={!selectedSearchLeader}
              onChange={(e) => { setFamilyQuery(e.target.value); if (!familyDropdownOpen) setFamilyDropdownOpen(true) }}
              onFocus={() => { if (familyQuery.trim()) setFamilyDropdownOpen(true) }}
            />
            {familyQuery && (
              <button type="button" onClick={() => { setFamilyQuery(''); setFamilySearchResults([]); setFamilySearchRows([]) }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear family search">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {familyDropdownOpen && familyQuery.trim() && familySearching && (
            <div className="absolute z-20 mt-2 w-full rounded-2xl border border-line bg-white p-4">
              <div className="flex items-center justify-center gap-2 text-sm text-ink-tertiary"><Loader2 className="h-4 w-4 animate-spin" /> Searching families...</div>
            </div>
          )}

          {familyDropdownOpen && familyQuery.trim() && !familySearching && familySearchFamilies.length > 0 && (
            <div className="absolute z-20 mt-2 w-full max-h-[70vh] overflow-y-auto rounded-2xl border border-line bg-white p-3">
              <div className="space-y-3">
                {familySearchFamilies.map((family) => {
                  const head = family.headVoter ?? family.members[0]
                  const matchedMember = family.members.find((member) => familySearchResults.some((result) => result.id === member.id)) ?? head
                  const otherLeaderIds = Array.from(new Set(
                    family.members.map((m) => voterToLeaderId[m.id]).filter((id): id is string => Boolean(id) && id !== selectedSearchLeader?.id),
                  ))
                  const assignedToCurrent = family.members.length > 0 && family.members.every((m) => voterToLeaderId[m.id] === selectedSearchLeader?.id)
                  const assignedElsewhereCount = family.members.filter((m) => voterToLeaderId[m.id] && voterToLeaderId[m.id] !== selectedSearchLeader?.id).length
                  const canTransfer = otherLeaderIds.length > 0
                  const otherLeaderNames = otherLeaderIds.map((id) => leaderNameById.get(id)).filter(Boolean)
                  const otherLeaderLabel = formatLeaderNames(otherLeaderNames.length ? otherLeaderNames : otherLeaderIds.map(() => null))
                  const currentLeaderName = resolveTeamLeaderName(selectedSearchLeader, selectedSearchLeader?.voter, 'selected leader')
                  return (
                    <div key={family.key} className={`rounded-2xl border border-line p-4 ${assignedToCurrent ? 'opacity-60' : ''}`}>
                      <div className="flex items-start gap-3">
                        {head && <VoterAvatar voter={head} photoUrl={head.photo_url ? photoUrlByPath[head.photo_url] : undefined} />}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold text-ink">{highlightMatch(head?.name ?? 'Unknown head', familyAssignTokens)}</p>
                            <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                              {family.members.length} member{family.members.length === 1 ? '' : 's'}
                            </span>
                            {assignedToCurrent && (
                              <span className="inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">Already assigned to {currentLeaderName}</span>
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
                            EPIC: {highlightMatch(head?.epic_no ?? '-', familyAssignTokens)} · Part {head?.part_no ?? '-'} / Sec {head?.section ?? '-'}{head?.house_no ? ` · House ${head.house_no}` : ''}
                          </p>
                          {matchedMember?.id !== head?.id && (
                            <p className="mt-1 text-[11px] text-brand-600">Matched: {highlightMatch(matchedMember.name, familyAssignTokens)} ({matchedMember.epic_no})</p>
                          )}
                        </div>
                        {assignedToCurrent ? null : canTransfer ? (
                          <button
                            type="button"
                            disabled={familyTransferring || !selectedSearchLeader}
                            onClick={() => setTransferTarget({ family, sourceLeaderIds: otherLeaderIds })}
                            className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {familyTransferring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowLeftRight className="h-3.5 w-3.5" />} Transfer
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={familyAssigning || !selectedSearchLeader}
                            onClick={() => void assignSearchedFamily(family, matchedMember ?? head)}
                            className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {familyAssigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />} Assign
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {familyDropdownOpen && familyQuery.trim() && !familySearching && familySearchFamilies.length === 0 && (
            <div className="absolute z-20 mt-2 w-full rounded-2xl border border-line bg-white p-4 text-center text-sm text-ink-tertiary">
              No families found.
            </div>
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-white shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Team Leaders</h2>
            <p className="text-xs text-ink-tertiary">
              {filteredLeaders.length} team leader{filteredLeaders.length === 1 ? '' : 's'} total
              {(partFilter || sectionFilter) ? ' · filtered' : ''}
              {leaderQuery ? ' · search' : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
              <input
                className="h-9 w-56 rounded-lg border border-line bg-white pl-9 pr-8 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                placeholder="Search by name or EPIC..."
                value={leaderQuery}
                onChange={(e) => setLeaderQuery(e.target.value)}
              />
              {leaderQuery && (
                <button type="button" onClick={() => setLeaderQuery('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear search">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <select
              className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary outline-none"
              aria-label="Filter by part"
              title="Filter by part"
              value={partFilter}
              onChange={(e) => setPartFilter(e.target.value)}
            >
              <option value="">All Parts</option>
              {partOptions.map((p) => (
                <option key={p} value={String(p)}>Part {p}</option>
              ))}
            </select>
            <select
              className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary outline-none disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
              aria-label="Filter by section"
              title={partFilter ? 'Filter by section' : 'Select a part to filter by section'}
              value={sectionFilter}
              disabled={!partFilter}
              onChange={(e) => setSectionFilter(e.target.value)}
            >
              <option value="">All Sections</option>
              {sectionOptions.map((s) => (
                <option key={s} value={String(s)}>Section {s}</option>
              ))}
            </select>
            {(partFilter || sectionFilter) && (
              <button
                type="button"
                onClick={() => setPartFilter('')}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-tertiary transition hover:bg-muted"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </button>
            )}
            <ColumnsDropdown visible={visibleColumns} onChange={setVisibleColumns} />
            <button
              type="button"
              onClick={() => void handleQuickPdfDownload()}
              title="Quick download PDF using saved Print settings"
              aria-label="Quick download PDF using saved Print settings"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-brand-200 bg-brand-50 text-brand-700 transition hover:bg-brand-100"
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setZipConfirmOpen(true)}
              disabled={zipDownloading || printAllPrinting || filteredLeaders.length === 0}
              title={`Download all ${zipFilterLabel ? `${zipFilterLabel} ` : ''}leaders' family PDFs as a single ZIP`}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {zipDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileArchive className="h-3.5 w-3.5" />} Download All (ZIP)
            </button>
            <button
              type="button"
              onClick={() => setPrintAllConfirmOpen(true)}
              disabled={printAllPrinting || zipDownloading || filteredLeaders.length === 0}
              title={`Print all ${zipFilterLabel ? `${zipFilterLabel} ` : ''}leaders' assigned families in one print job`}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {printAllPrinting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />} Print All Families
            </button>
            <button
              type="button"
              onClick={() => { setReportScope('filtered'); setShowPrintConfig(true) }}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
            >
              <Printer className="h-3.5 w-3.5" /> Print
            </button>
            <button
              type="button"
              onClick={() => { setReportScope('filtered'); setShowExportConfig(true) }}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" /> Export
            </button>
            <button
              type="button"
              onClick={() => navigate('/team-leaders/stats')}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 text-xs font-semibold text-brand-700 transition hover:bg-brand-100"
            >
              <BarChart3 className="h-3.5 w-3.5" /> Stats
            </button>
            <button
              type="button"
              onClick={() => navigate('/places')}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 text-xs font-semibold text-violet-700 transition hover:bg-violet-100"
            >
              Places
            </button>
            <button
              type="button"
              onClick={() => navigate('/presence-notes')}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
            >
              Presence notes
            </button>
            <button
              type="button"
              onClick={() => navigate('/team-leaders/unassigned')}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 text-xs font-semibold text-rose-600 transition hover:bg-rose-100"
            >
              <Users className="h-3.5 w-3.5" /> Not Assigned Families
            </button>
            {selectedLeaderIds.size > 0 && (
              <button
                type="button"
                onClick={() => void loadBulk()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white transition hover:bg-brand-700"
              >
                <UserPlus className="h-3.5 w-3.5" /> Bulk Assign ({selectedLeaderIds.size})
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 px-5 py-4 md:grid-cols-4">
          <div className="rounded-xl border border-brand-100 bg-brand-50/60 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-600">Assigned Voters</p>
            <p className="mt-1 font-display text-2xl font-semibold tracking-[-0.03em] text-ink">{leaderStatsLoaded ? assignedTotals.voters.toLocaleString() : '...'}</p>
            {(partFilter || sectionFilter) && <p className="mt-0.5 text-[11px] text-brand-500">of {Object.values(leaderStats).reduce((s, st) => s + st.members, 0)} total</p>}
          </div>
          <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-emerald-600">Assigned Families</p>
            <p className="mt-1 font-display text-2xl font-semibold tracking-[-0.03em] text-ink">{leaderStatsLoaded ? assignedTotals.families.toLocaleString() : '...'}</p>
            {!partFilter && !sectionFilter && (uniqueAssigned.multiFamilies > 0 || uniqueAssigned.singles > 0) && (
              <p className="mt-0.5 text-[11px] text-emerald-600">
                {uniqueAssigned.multiFamilies.toLocaleString()} families · {uniqueAssigned.singles.toLocaleString()} singles
              </p>
            )}
            {(partFilter || sectionFilter) && <p className="mt-0.5 text-[11px] text-emerald-500">of {Object.values(leaderStats).reduce((s, st) => s + st.families, 0)} total</p>}
            {!partFilter && !sectionFilter && splitFamilyCount > 0 && (
              <p className="mt-0.5 text-[11px] text-amber-700">
                Unique families. {splitFamilyCount.toLocaleString()} sit under more than one leader (per-leader sum {perLeaderFamilySum.toLocaleString()}).
              </p>
            )}
          </div>
          <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-blue-600">Male Voters Assigned</p>
            <p className="mt-1 font-display text-2xl font-semibold tracking-[-0.03em] text-ink">{leaderStatsLoaded ? assignedTotals.male.toLocaleString() : '...'}</p>
          </div>
          <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-violet-600">Female Voters Assigned</p>
            <p className="mt-1 font-display text-2xl font-semibold tracking-[-0.03em] text-ink">{leaderStatsLoaded ? assignedTotals.female.toLocaleString() : '...'}</p>
          </div>
        </div>

        {officeLeader && (
          <div className="border-t border-line px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-muted/60 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-xl bg-brand-600 text-white"><Users className="h-4 w-4" /></span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-ink">Shifted</h3>
                  <p className="text-xs text-ink-tertiary">Voters/families that have shifted; capture address.</p>
                </div>
              </div>
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-ink-secondary">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-line text-brand-600"
                  checked={countShiftedAsAssigned}
                  onChange={(event) => setCountShiftedAsAssigned(event.target.checked)}
                />
                Count Shifted as assigned
              </label>
              <div className="flex flex-shrink-0 items-center gap-4 text-xs">
                <span className="text-ink-secondary"><strong className="text-sm text-ink">{leaderStatsLoaded ? officeStats?.members ?? 0 : '...'}</strong> voters</span>
                <span className="text-ink-secondary"><strong className="text-sm text-ink">{leaderStatsLoaded ? officeStats?.families ?? 0 : '...'}</strong> families</span>
                <button
                  type="button"
                  onClick={() => navigate(`/team-leaders/${officeLeader.id}`)}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
                >
                  View
                </button>
              </div>
            </div>
          </div>
        )}

        {isAdminOnly && (
          <div className="border-t border-line px-5 py-4">
            <div className="rounded-2xl border border-rose-200 bg-rose-50/50 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-ink">Count custom leaders as unassigned</h3>
                  {customUnassignedOpen ? (
                    <p className="text-xs text-ink-tertiary">Admin only. Selected custom-named leaders stay on their own page, but Stats Overall and Unassigned Families count their families as unassigned. Shifted and Single stay parked, not assigned or unassigned.</p>
                  ) : (
                    <p className="text-xs text-ink-tertiary">
                      {unassignedCountingLeaderIds.length > 0
                        ? `${unassignedCountingLeaderIds.length} custom leader${unassignedCountingLeaderIds.length === 1 ? '' : 's'} count as unassigned.`
                        : 'Hidden. Open to mark custom-named leaders as unassigned.'}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {savingUnassignedCounting && <Loader2 className="h-4 w-4 animate-spin text-rose-500" />}
                  <button
                    type="button"
                    onClick={() => setCustomUnassignedOpen((open) => !open)}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50"
                  >
                    {customUnassignedOpen ? 'Hide' : 'Show'}
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${customUnassignedOpen ? 'rotate-180' : ''}`} />
                  </button>
                </div>
              </div>
              {customUnassignedOpen ? (
                customNamedLeaders.length === 0 ? (
                  <p className="mt-3 text-xs text-ink-tertiary">No custom-named leaders yet. Create one with Custom name above.</p>
                ) : (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {customNamedLeaders.map((tl) => {
                      const name = resolveTeamLeaderName(tl, tl.voter, 'Named leader')
                      return (
                        <label key={tl.id} className="flex items-center gap-2 rounded-xl border border-rose-100 bg-white px-3 py-2 text-xs font-semibold text-ink-secondary">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-line text-brand-600"
                            checked={unassignedCountingIdSet.has(tl.id)}
                            disabled={savingUnassignedCounting}
                            onChange={(event) => void toggleUnassignedCountingLeader(tl.id, event.target.checked)}
                          />
                          <span className="min-w-0 truncate">{name}</span>
                        </label>
                      )
                    })}
                  </div>
                )
              ) : null}
            </div>
          </div>
        )}

        {shiftedLeader && (
          <div className="border-t border-line px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/60 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-xl bg-amber-500 text-white"><Users className="h-4 w-4" /></span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-ink">Single</h3>
                  <p className="text-xs text-ink-tertiary">Single voters/families moved out of field assignment.</p>
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-4 text-xs">
                <span className="text-ink-secondary"><strong className="text-sm text-ink">{leaderStatsLoaded ? shiftedStats?.members ?? 0 : '...'}</strong> voters</span>
                <span className="text-ink-secondary"><strong className="text-sm text-ink">{leaderStatsLoaded ? shiftedStats?.families ?? 0 : '...'}</strong> families</span>
                <button
                  type="button"
                  onClick={() => navigate(`/team-leaders/${shiftedLeader.id}`)}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
                >
                  View
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-line px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-violet-200 bg-violet-50/60 px-4 py-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-ink">Places</h3>
              <p className="text-xs text-ink-tertiary">Area / Chawl / Building clubs. Manage them on the Places page.</p>
            </div>
            <button
              type="button"
              onClick={() => navigate('/places')}
              className="inline-flex h-8 items-center rounded-lg border border-violet-200 bg-white px-3 text-xs font-semibold text-violet-700 transition hover:bg-violet-50"
            >
              Open Places
            </button>
          </div>
        </div>

        {partSummary.length > 0 && (
          <div className="border-t border-line">
            <div className="flex items-center justify-between gap-2 px-5 py-4">
              <button
                type="button"
                onClick={() => setPartSummaryOpen((v) => !v)}
                aria-expanded={partSummaryOpen}
                className="flex min-w-0 items-center gap-3 rounded-xl text-left transition hover:bg-muted"
              >
                <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-lg border border-line bg-white transition hover:bg-muted">
                  <ChevronDown className={`h-4 w-4 text-ink-tertiary transition-transform duration-300 ${partSummaryOpen ? 'rotate-180' : ''}`} />
                </span>
                <span className="min-w-0">
                  <h3 className="text-sm font-semibold text-ink">Part-wise Summary</h3>
                  <p className="text-xs text-ink-tertiary">Click a part to filter the table below.</p>
                </span>
              </button>
              <div className="flex flex-shrink-0 items-center gap-2">
                {(partFilter || sectionFilter) && (
                  <button type="button" onClick={() => setPartFilter('')}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted">
                    <X className="h-3.5 w-3.5" /> Clear Filter
                  </button>
                )}
              </div>
            </div>
            <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${partSummaryOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className="overflow-hidden">
                <div className="px-5 pb-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {partSummary.map(([part, s]) => {
                      const active = partFilter !== '' && Number(partFilter) === part
                      return (
                        <button
                          key={part ?? 'unassigned'}
                          type="button"
                          onClick={() => setPartFilter(active ? '' : String(part ?? ''))}
                          className={`rounded-2xl border p-4 text-left transition ${active ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-100' : 'border-line bg-white hover:border-brand-300 hover:bg-brand-50/40'}`}
                        >
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">{part != null ? `Part ${part}` : 'Unassigned'}</p>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${s.leaders > 0 ? 'bg-brand-50 text-brand-700' : 'bg-muted text-ink-tertiary'}`}>
                              {s.leaders} leader{s.leaders === 1 ? '' : 's'}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                            <span className="font-semibold text-ink">{s.voters} voters</span>
                            <span className="text-ink-tertiary">{s.families} families</span>
                          </div>
                          <div className="mt-1 text-xs text-ink-tertiary">{s.male} M · {s.female} F</div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading team leaders...</div>
        ) : filteredLeaders.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-ink-tertiary">
            {leaders.length === 0 ? 'No team leaders yet. Assign your first team leader above.' : leaderQuery ? 'No team leaders match your search.' : 'No team leaders match the selected part/section filter.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead className="bg-[#f7f9fd]">
                <tr>
                  <th className="w-12 border-b border-line px-5 py-3">
                    <CheckboxUI checked={allFilteredSelected} onChange={() => setSelectedLeaderIds(allFilteredSelected ? new Set() : new Set(filteredLeaders.map((tl) => tl.id)))} />
                  </th>
                  {LEADER_COLUMNS.filter((c) => visibleColumns.includes(c.key)).map((col) => (
                    <th key={col.key} className={`border-b border-line px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary ${col.headerClass ?? ''}`}>
                      {col.label}
                    </th>
                  ))}
                  <th className="border-b border-line px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredLeaders.map((tl, rowIndex) => (
                  <tr key={tl.id} className={`group cursor-pointer transition hover:bg-[#f5f7fd] ${selectedLeaderIds.has(tl.id) ? 'bg-brand-50/40' : ''}`} onClick={() => navigate(buildLeaderDetailUrl(tl.id))}>
                    <td className="border-b border-line px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                      <CheckboxUI checked={selectedLeaderIds.has(tl.id)} onChange={() => toggleLeaderSelection(tl.id)} />
                    </td>
                    {LEADER_COLUMNS.filter((c) => visibleColumns.includes(c.key)).map((col) => {
                      if (col.key === 'photo') {
                        const named = resolveTeamLeaderName(tl, tl.voter, '')
                        return (
                          <td key={col.key} className="border-b border-line px-5 py-3.5">
                            {tl.voter ? <VoterAvatar voter={tl.voter} photoUrl={tl.voter.photo_url ? photoUrlByPath[tl.voter.photo_url] : undefined} /> : named ? (
                              <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-ink-secondary">{initials(named)}</span>
                            ) : <span className="text-xs text-ink-tertiary">-</span>}
                          </td>
                        )
                      }
                      if (col.key === 'assignedCount') {
                        return (
                          <td key={col.key} className="border-b border-line px-5 py-3.5">
                            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${tl.assignedCount > 0 ? 'bg-brand-50 text-brand-700' : 'bg-muted text-ink-tertiary'}`}>
                              {leaderStatsLoaded ? tl.assignedCount : '...'}
                            </span>
                          </td>
                        )
                      }
                      if (col.key === 'familyCount') {
                        return (
                          <td key={col.key} className="border-b border-line px-5 py-3.5">
                            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${tl.familyCount > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-ink-tertiary'}`}>
                              {leaderStatsLoaded ? tl.familyCount : '...'}
                            </span>
                          </td>
                        )
                      }
                      const isNameCol = col.key === 'name'
                      return (
                        <td key={col.key} className={`border-b border-line px-5 py-3.5 ${isNameCol ? 'font-semibold text-ink' : 'text-ink-secondary'}`}>
                          {isNameCol ? (
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              {getLeaderColumnValue(tl, col.key, rowIndex)}
                              {!tl.voter_id && <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-ink-secondary">Named</span>}
                            </span>
                          ) : getLeaderColumnValue(tl, col.key, rowIndex)}
                        </td>
                      )
                    })}
                    <td className="border-b border-line px-5 py-3.5">
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          title="Download families (Excel)"
                           aria-label={`Download families for ${resolveTeamLeaderName(tl, tl.voter, 'this leader')} (Excel)`}
                          onClick={(e) => { e.stopPropagation(); navigate(buildLeaderDetailUrl(tl.id, 'excel')) }}
                          className="mr-1 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-ink-tertiary transition hover:bg-muted hover:text-ink-secondary"
                        >
                          <Download className="h-4 w-4" />
                        </button>
                        {isAdminAreaAllowed && (
                          <button
                            type="button"
                            title="Remove team leader"
                             aria-label={`Remove ${resolveTeamLeaderName(tl, tl.voter, 'this leader')}`}
                            onClick={(e) => { e.stopPropagation(); setRemoveTarget(tl) }}
                            className="mr-1 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-rose-500 transition hover:bg-rose-50 hover:text-rose-700"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                        <MoreMenu>
                          {(close) => (
                            <>
                              <button type="button" onClick={(e) => { e.stopPropagation(); close(); navigate(buildLeaderDetailUrl(tl.id, 'excel')) }}
                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink-secondary transition hover:bg-brand-50 hover:text-brand-700">
                                <Download className="h-3.5 w-3.5" /> Download Families (Excel)
                              </button>
                              <button type="button" onClick={(e) => { e.stopPropagation(); close(); navigate(buildLeaderDetailUrl(tl.id, 'pdf')) }}
                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink-secondary transition hover:bg-brand-50 hover:text-brand-700">
                                <Download className="h-3.5 w-3.5" /> Download Families (PDF)
                              </button>
                              <div className="my-1 border-t border-line" />
                               <button type="button" onClick={(e) => { e.stopPropagation(); close(); setEditTarget(tl) }}
                                 className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink-secondary transition hover:bg-brand-50 hover:text-brand-700">
                                 <Pencil className="h-3.5 w-3.5" /> Edit leader
                               </button>
                              <button type="button" onClick={(e) => { e.stopPropagation(); close(); setAssistantTarget(tl) }}
                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink-secondary transition hover:bg-brand-50 hover:text-brand-700">
                                <UserCog className="h-3.5 w-3.5" /> Set Assistant
                              </button>
                              {isAdminAreaAllowed && (
                                <button type="button" onClick={(e) => { e.stopPropagation(); close(); setRemoveTarget(tl) }}
                                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-rose-600 transition hover:bg-rose-50">
                                  <Trash2 className="h-3.5 w-3.5" /> Remove
                                </button>
                              )}
                            </>
                          )}
                        </MoreMenu>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {bulkOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
              <div>
                <h3 className="text-lg font-semibold text-ink">Bulk Assign Remaining Families</h3>
                <p className="mt-1 text-xs text-ink-tertiary">
                  Remaining (unassigned) families across the parts/sections of the {selectedLeaders.length} selected team leaders. Pick a target leader and assign.
                </p>
              </div>
              <button type="button" onClick={() => setBulkOpen(false)} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
            </div>

            <div className="space-y-4 border-b border-line px-6 py-4">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Assign to Team Leader</label>
                <select
                  value={bulkTargetLeaderId}
                  onChange={(e) => setBulkTargetLeaderId(e.target.value)}
                  className="h-10 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                >
                  {selectedLeaders.map((tl) => (
                    <option key={tl.id} value={tl.id}>
                      {resolveTeamLeaderName(tl, tl.voter, 'Unknown leader')}{tl.part_no != null ? ` · Part ${tl.part_no}` : ''}{tl.section != null ? ` / Sec ${tl.section}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Families to Assign</label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setBulkSelectedFamilyKeys((prev) => prev.size === bulkFamilies.length ? new Set() : new Set(bulkFamilies.map((f) => f.key)))}
                      className="inline-flex h-8 items-center rounded-lg border border-line bg-white px-2.5 text-[11px] font-semibold text-ink-secondary transition hover:bg-muted"
                    >
                      {bulkSelectedFamilyKeys.size === bulkFamilies.length ? 'Clear Selection' : 'Select All'}
                    </button>
                  </div>
                </div>
                <div className="max-h-[40vh] space-y-2 overflow-y-auto rounded-2xl border border-line p-3">
                  {bulkLoading ? (
                    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-tertiary"><Loader2 className="h-4 w-4 animate-spin" /> Loading remaining families...</div>
                  ) : bulkFamilies.length === 0 ? (
                    <p className="py-10 text-center text-sm text-ink-tertiary">
                      {selectedLeaders.every((tl) => tl.part_no == null) ? 'Selected team leaders have no part assigned yet, so remaining families cannot be computed.' : 'All families in the selected parts/sections are already assigned to a team leader.'}
                    </p>
                  ) : (
                    bulkFamilies.map((family) => {
                      const head = family.headVoter ?? family.members[0] ?? null
                      const selected = bulkSelectedFamilyKeys.has(family.key)
                      return (
                        <div key={family.key} className={`flex items-center gap-3 rounded-xl border p-3 transition ${selected ? 'border-brand-400 bg-brand-50/60 ring-2 ring-brand-100' : 'border-line'}`}>
                          <CheckboxUI checked={selected} onChange={() => toggleBulkFamilySelection(family.key)} />
                          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700">
                            {head ? initials(head.name) : '?'}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-ink">{head?.name ?? 'Unknown head'}</p>
                            <p className="truncate text-xs text-ink-tertiary">
                              {head?.epic_no ? `EPIC: ${head.epic_no} · ` : ''}Part {head?.part_no ?? '-'} / Sec {head?.section ?? '-'}
                            </p>
                          </div>
                          <span className="inline-flex flex-shrink-0 items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                            {family.members.length} member{family.members.length === 1 ? '' : 's'}
                          </span>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 px-6 py-4">
              <span className="text-xs text-ink-tertiary">
                {bulkSelectedFamilies.length} famil{bulkSelectedFamilies.length === 1 ? 'y' : 'ies'} selected{bulkTargetLeader ? ` → ${resolveTeamLeaderName(bulkTargetLeader, bulkTargetLeader.voter, 'leader')}` : ''}
              </span>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setBulkOpen(false)} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
                <button
                  type="button"
                  disabled={bulkAssigning || !bulkTargetLeaderId || bulkSelectedFamilies.length === 0}
                  onClick={() => void assignBulkFamilies()}
                  className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {bulkAssigning ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Assign
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <RemoveLeaderModal
        leader={removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={async () => {
          if (!removeTarget) return
          const ok = await removeLeader(removeTarget.id)
          if (ok) setRemoveTarget(null)
        }}
      />

      <ConfirmZipModal
        open={zipConfirmOpen}
        leaderCount={filteredLeaders.length}
        filterLabel={zipFilterLabel}
        downloading={zipDownloading}
        onClose={() => setZipConfirmOpen(false)}
        onConfirm={() => {
          setZipConfirmOpen(false)
          void handleDownloadAllZip()
        }}
      />

      <ConfirmPrintAllModal
        open={printAllConfirmOpen}
        leaderCount={filteredLeaders.length}
        filterLabel={zipFilterLabel}
        printing={printAllPrinting}
        onClose={() => setPrintAllConfirmOpen(false)}
        onConfirm={() => {
          setPrintAllConfirmOpen(false)
          void handlePrintAllFamilies()
        }}
      />

      <EditLeaderModal
        leader={editTarget}
        hasWardRestriction={hasWardRestriction}
        allowedWards={allowedWards}
        onClose={() => setEditTarget(null)}
        onConfirm={(partNo, section, notes, displayName, voterId) => {
          if (!editTarget) return Promise.resolve()
          return updateLeader(editTarget.id, partNo, section, notes, displayName, voterId)
        }}
      />

      <SetAssistantModal
        leader={assistantTarget}
        hasWardRestriction={hasWardRestriction}
        allowedWards={allowedWards}
        onClose={() => setAssistantTarget(null)}
        onConfirm={(voterId) => {
          if (!assistantTarget) return Promise.resolve()
          return setAssistant(assistantTarget.id, voterId)
        }}
      />

      <TransferFamilyConfirmModal
        open={!!transferTarget}
        headName={transferTarget?.family.headVoter?.name ?? transferTarget?.family.members[0]?.name ?? 'Unknown head'}
        memberCount={transferTarget?.family.members.length ?? 0}
        sourceLeaderName={transferTarget ? formatLeaderNames(transferTarget.sourceLeaderIds.map((id) => leaderNameById.get(id))) : undefined}
        targetLeaderName={resolveTeamLeaderName(selectedSearchLeader, selectedSearchLeader?.voter, 'selected leader')}
        transferring={familyTransferring}
        onClose={() => { if (!familyTransferring) setTransferTarget(null) }}
        onConfirm={() => {
          if (!transferTarget) return
          void handleTransferSearchedFamily(transferTarget.family, transferTarget.sourceLeaderIds)
        }}
      />

      {(showPrintConfig || showExportConfig) && (
        <ReportConfigModal
          title="Team Leaders"
          open
          mode={showPrintConfig ? 'print' : 'export'}
          fieldDefs={REPORT_FIELD_DEFS}
          fields={reportFieldOrder.map((key) => ({ key, enabled: reportFields[key] ?? false }))}
          defaultFields={DEFAULT_REPORT_FIELD_ORDER.map((key) => ({ key, enabled: INITIAL_REPORT_FIELDS[key] ?? false }))}
          fontSize={reportFontSize}
          boldText={reportBold}
          exportBorders={reportBorders}
          exportRowHeight={reportRowHeight}
          exportColWidth={reportColWidth}
          printDescription="Choose columns and layout, then print or download a PDF. The quick download icon uses these saved Print settings immediately."
          printActionLabel="Open print preview"
          extraControls={
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Scope</label>
                <select
                  className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                  value={reportScope}
                  onChange={(e) => setReportScope(e.target.value as 'filtered' | 'all')}
                >
                  <option value="filtered">Current filtered view ({filteredLeaders.length} leaders)</option>
                  <option value="all">All team leaders ({leadersWithVoters.length} leaders)</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Group by</label>
                <select
                  className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                  value={reportGroupBy}
                  onChange={(e) => setReportGroupBy(e.target.value as typeof reportGroupBy)}
                >
                  <option value="none">No grouping</option>
                  <option value="part">Group by Part</option>
                  <option value="section">Group by Section</option>
                </select>
              </div>
            </div>
          }
          onClose={() => { setShowPrintConfig(false); setShowExportConfig(false) }}
          onConfirm={(fields: ReportFieldItem[], _layout: boolean, style: PrintStyleOptions) => {
            applyReportFields(fields)
            if (showPrintConfig) {
              setReportFontSize(style.fontSize)
              setReportBold(style.boldText)
              handlePrint(style, fields)
            } else {
              setReportBorders(style.exportBorders)
              setReportRowHeight(style.exportRowHeight)
              setReportColWidth(style.exportColWidth)
              handleExportExcel(style, fields)
            }
          }}
        />
      )}
    </div>
  )
}
