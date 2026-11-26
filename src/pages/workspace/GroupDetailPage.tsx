import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Columns3,
  Download,
  Eye,
  GripVertical,
  Loader2,
  MoreVertical,
  Phone,
  Printer,
  Search,
  Trash2,
  UserCheck,
  Users,
  UserPlus,
  ClipboardPaste,
  X,
} from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/Button'
import { ReportConfigModal, type ReportFieldItem } from '../../components/common/ReportConfigModal'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import {
  exportRowsToExcel,
  openPrintWindow,
  type ReportFieldDef,
  type PrintStyleOptions,
} from '../../lib/reportBuilder'
import type { Group, GroupMember, Voter } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { usePersistentState } from '../../hooks/usePersistentState'
import { fetchInChunks } from '../../lib/d1Query'
import { loadAllVoters } from '../../lib/voterDataset'
import {
  buildWardScope,
  readCachedCollection,
  writeCachedCollection,
  clearCachedCollection,
} from '../../lib/voterCache'
import { voterCategoryLabel } from '../../lib/voterCategory'
import {
  initials,
  compactLookupValue,
  tokenizeLookup,
  matchesLookupTokens,
  normalizeGroupingValue,
  escapeIlikePattern,
  isLikelyEpicToken,
  highlightMatch,
} from '../../lib/searchUtils'

const GROUPS_CACHE_KEY = 'vote:groupdetail:groups-cache'
const GROUP_MEMBERS_CACHE_KEY = 'vote:groupdetail:group-members-cache'
const ATTENDED_CACHE_KEY = 'vote:groupdetail:attended-cache'
// Groups / memberships / attendance refresh quickly enough that a short TTL
// keeps the page feeling instant when tab-hopping without ever serving data
// that is stale for long.
const COLLECTION_CACHE_MAX_AGE_MS = 1000 * 60 * 5
const VISIBLE_COLUMNS_KEY = 'vote:groupdetail:visibleColumns'
const PAGE_SIZE_KEY = 'vote:groupdetail:pageSize'
const PRINT_FIELDS_KEY = 'vote:groupdetail:printFields:v2'
const REPORT_FONT_SIZE_KEY = 'vote:groupdetail:printFontSize:v2'
const REPORT_BOLD_KEY = 'vote:groupdetail:printBold'
const REPORT_BORDERS_KEY = 'vote:groupdetail:exportBorders'
const REPORT_ROW_HEIGHT_KEY = 'vote:groupdetail:exportRowHeight'
const REPORT_COL_WIDTH_KEY = 'vote:groupdetail:exportColWidth'

type GroupRow = Group & {
  parent_group_id: string | null
  exclusive_subgroups: boolean
}

interface MembershipEntry {
  groupId: string
  groupName: string
  parentGroupId: string | null
}

type MembershipConflict = { type: 'sibling'; groupName: string } | { type: 'other'; groupNames: string[] }

function getMembershipConflict(
  voterId: string,
  targetGroup: { id: string | null; parent_group_id: string | null },
  membershipByVoterId: Map<string, MembershipEntry[]>,
  groupsById: Map<string, GroupRow>,
): MembershipConflict | null {
  const memberships = membershipByVoterId.get(voterId) ?? []
  const relevant = memberships.filter((m) => m.groupId !== targetGroup.id)
  if (!relevant.length) return null

  if (targetGroup.parent_group_id) {
    const sibling = relevant.find((m) => m.parentGroupId === targetGroup.parent_group_id)
    if (sibling) {
      const parentGroup = groupsById.get(targetGroup.parent_group_id)
      if (parentGroup?.exclusive_subgroups !== false) {
        return { type: 'sibling', groupName: sibling.groupName }
      }
    }
  }

  return { type: 'other', groupNames: relevant.map((m) => m.groupName) }
}

type MemberColumnKey =
  | 'srNo'
  | 'photo'
  | 'ward'
  | 'partNo'
  | 'section'
  | 'name'
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
  | 'sectionName'
  | 'category'
  | 'familyMembersCount'
  | 'family'
  | 'otherGroups'

interface MemberColumnDef {
  key: MemberColumnKey
  label: string
  headerClass?: string
  sortable?: boolean
}

const MEMBER_COLUMNS: MemberColumnDef[] = [
  { key: 'srNo', label: 'Sr No', headerClass: 'w-14', sortable: false },
  { key: 'photo', label: 'Photo', headerClass: 'w-14', sortable: false },
  { key: 'name', label: 'Name', headerClass: 'min-w-[180px]', sortable: true },
  { key: 'epicNo', label: 'EPIC', headerClass: 'w-28', sortable: true },
  { key: 'relativeName', label: 'Relative', headerClass: 'min-w-[180px]', sortable: true },
  { key: 'relation', label: 'Relation', headerClass: 'w-24', sortable: true },
  { key: 'houseNo', label: 'House No', headerClass: 'w-24', sortable: true },
  { key: 'age', label: 'Age', headerClass: 'w-16', sortable: true },
  { key: 'ward', label: 'Ward', headerClass: 'w-20', sortable: true },
  { key: 'partNo', label: 'Part No', headerClass: 'w-20', sortable: true },
  { key: 'section', label: 'Section', headerClass: 'w-20', sortable: true },
  { key: 'voterSrNo', label: 'Voter Sr No', headerClass: 'w-28', sortable: true },
  { key: 'gender', label: 'Gender', headerClass: 'w-20', sortable: true },
  { key: 'religion', label: 'Religion', headerClass: 'w-24', sortable: true },
  { key: 'sectionName', label: 'Section Name', headerClass: 'min-w-[160px]', sortable: true },
  { key: 'contact1', label: 'Contact No 1', headerClass: 'w-32', sortable: true },
  { key: 'contact2', label: 'Contact No 2', headerClass: 'w-32', sortable: true },
  { key: 'dob', label: 'DOB', headerClass: 'w-28', sortable: true },
  { key: 'familyMembersCount', label: 'Family Members Count', headerClass: 'w-28', sortable: true },
  { key: 'familyLabel', label: 'Family Label', headerClass: 'w-28', sortable: true },
  { key: 'category', label: 'Category', headerClass: 'w-24', sortable: true },
  { key: 'family', label: 'Family', headerClass: 'min-w-[160px]', sortable: true },
  { key: 'otherGroups', label: 'In Other Groups', headerClass: 'min-w-[180px]', sortable: true },
]

const DEFAULT_VISIBLE_COLUMNS: MemberColumnKey[] = [
  'srNo',
  'photo',
  'name',
  'epicNo',
  'relativeName',
  'houseNo',
  'partNo',
  'section',
  'contact1',
  'category',
  'familyMembersCount',
  'otherGroups',
]

type PrintFieldKey =
  | 'srNo'
  | 'voterSrNo'
  | 'photo'
  | 'name'
  | 'epicNo'
  | 'relativeName'
  | 'relation'
  | 'houseNo'
  | 'ward'
  | 'partNo'
  | 'section'
  | 'age'
  | 'gender'
  | 'contact1'
  | 'contact2'
  | 'religion'
  | 'dob'
  | 'familyLabel'
  | 'sectionName'
  | 'familyMembersCount'
  | 'family'
  | 'otherGroups'
  | 'meetingStatus'

interface PrintFieldDef {
  key: PrintFieldKey
  label: string
  description?: string
  isPhoto?: boolean
  isSequentialSrNo?: boolean
}

interface PrintFieldState {
  key: PrintFieldKey
  enabled: boolean
}

const PRINT_FIELD_DEFS: PrintFieldDef[] = [
  { key: 'srNo', label: 'Sr No', description: 'Sequential counter (1, 2, 3 ...)', isSequentialSrNo: true },
  { key: 'voterSrNo', label: 'Voter Sr No', description: 'From sr_no_roll in the database' },
  { key: 'photo', label: 'Photo', isPhoto: true },
  { key: 'name', label: 'Name' },
  { key: 'epicNo', label: 'EPIC' },
  { key: 'relativeName', label: 'Relative' },
  { key: 'relation', label: 'Relation' },
  { key: 'houseNo', label: 'House No' },
  { key: 'ward', label: 'Ward' },
  { key: 'partNo', label: 'Part No' },
  { key: 'section', label: 'Section' },
  { key: 'age', label: 'Age' },
  { key: 'gender', label: 'Gender' },
  { key: 'contact1', label: 'Contact No 1' },
  { key: 'contact2', label: 'Contact No 2' },
  { key: 'religion', label: 'Religion' },
  { key: 'dob', label: 'DOB' },
  { key: 'familyLabel', label: 'Family Label' },
  { key: 'sectionName', label: 'Section Name' },
  { key: 'familyMembersCount', label: 'Family Members Count' },
  { key: 'family', label: 'Family' },
  { key: 'otherGroups', label: 'In Other Groups' },
  { key: 'meetingStatus', label: 'Meeting Status' },
]

const DEFAULT_PRINT_FIELDS: PrintFieldState[] = [
  { key: 'srNo', enabled: true },
  { key: 'voterSrNo', enabled: false },
  { key: 'photo', enabled: true },
  { key: 'name', enabled: true },
  { key: 'epicNo', enabled: false },
  { key: 'relativeName', enabled: false },
  { key: 'houseNo', enabled: false },
  { key: 'ward', enabled: false },
  { key: 'partNo', enabled: false },
  { key: 'section', enabled: false },
  { key: 'age', enabled: false },
  { key: 'contact1', enabled: true },
  { key: 'relation', enabled: false },
  { key: 'gender', enabled: false },
  { key: 'contact2', enabled: false },
  { key: 'religion', enabled: false },
  { key: 'dob', enabled: false },
  { key: 'familyLabel', enabled: false },
  { key: 'sectionName', enabled: false },
  { key: 'familyMembersCount', enabled: false },
  { key: 'family', enabled: false },
  { key: 'otherGroups', enabled: false },
  { key: 'meetingStatus', enabled: false },
]

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

type SortDir = 'asc' | 'desc'

function formatDate(value: unknown): string {
  if (!value) return '-'
  try {
    const d = new Date(value as string)
    if (Number.isNaN(d.getTime())) return '-'
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return '-' }
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

function getVoterFieldValue(v: Voter, key: MemberColumnKey): string {
  switch (key) {
    case 'srNo': return vf(v, 'sr_no_roll') || '-'
    case 'photo': return ''
    case 'ward': { const n = vfNum(v, 'ward_no'); return n != null ? String(n) : '-' }
    case 'partNo': { const n = vfNum(v, 'part_no'); return n != null ? String(n) : '-' }
    case 'section': return vf(v, 'section') || '-'
    case 'name': return vf(v, 'name') || '-'
    case 'relativeName': return vf(v, 'relative_name') || '-'
    case 'relation': return vf(v, 'relative_relation') || '-'
    case 'epicNo': return vf(v, 'epic_no') || '-'
    case 'houseNo': return vf(v, 'house_no') || '-'
    case 'age': { const n = vfNum(v, 'age'); return n != null ? String(n) : '-' }
    case 'dob': return formatDate(vf(v, 'date_of_birth')) || '-'
    case 'contact1': return vf(v, 'contact_no_1') || '-'
    case 'contact2': return vf(v, 'contact_no_2') || '-'
    case 'gender': return vf(v, 'gender') || '-'
    case 'religion': return vf(v, 'religion') || '-'
    case 'familyLabel': return vf(v, 'family_label') || '-'
    case 'voterSrNo': return vf(v, 'sr_no_roll') || '-'
    case 'sectionName': return vf(v, 'section_name') || '-'
    case 'category': return voterCategoryLabel(v.voter_category) ?? '-'
    case 'familyMembersCount': return vf(v, 'familyMembersCount') || '-'
    case 'family': return ''
    case 'otherGroups': return ''
    default: return '-'
  }
}

function getPrintFieldValue(v: Voter, key: PrintFieldKey): string {
  switch (key) {
    case 'voterSrNo': return vf(v, 'sr_no_roll') || '-'
    case 'photo': return ''
    case 'name': return vf(v, 'name') || '-'
    case 'epicNo': return vf(v, 'epic_no') || '-'
    case 'relativeName': return vf(v, 'relative_name') || '-'
    case 'relation': return vf(v, 'relative_relation') || '-'
    case 'houseNo': return vf(v, 'house_no') || '-'
    case 'ward': { const n = vfNum(v, 'ward_no'); return n != null ? String(n) : '-' }
    case 'partNo': { const n = vfNum(v, 'part_no'); return n != null ? String(n) : '-' }
    case 'section': return vf(v, 'section') || '-'
    case 'age': { const n = vfNum(v, 'age'); return n != null ? String(n) : '-' }
    case 'gender': return vf(v, 'gender') || '-'
    case 'contact1': return vf(v, 'contact_no_1') || '-'
    case 'contact2': return vf(v, 'contact_no_2') || '-'
    case 'religion': return vf(v, 'religion') || '-'
    case 'dob': return formatDate(vf(v, 'date_of_birth')) || '-'
    case 'familyLabel': return vf(v, 'family_label') || '-'
    case 'sectionName': return vf(v, 'section_name') || '-'
    case 'familyMembersCount': return vf(v, 'familyMembersCount') || '-'
    case 'family': return ''
    case 'otherGroups': return ''
    case 'meetingStatus': return ''
    case 'srNo': return ''
    default: return '-'
  }
}

function getPrintColumnStyle(key: PrintFieldKey): string {
  switch (key) {
    case 'srNo': return 'width:46px;text-align:center;white-space:nowrap'
    case 'voterSrNo': return 'width:64px;text-align:center;white-space:nowrap'
    case 'photo': return 'width:64px;text-align:center;white-space:nowrap'
    case 'name': return 'min-width:130px'
    case 'epicNo': return 'width:90px;white-space:nowrap'
    case 'relativeName': return 'min-width:130px'
    case 'houseNo': return 'width:60px;text-align:center;white-space:nowrap'
    case 'ward': return 'width:50px;text-align:center;white-space:nowrap'
    case 'partNo': return 'width:54px;text-align:center;white-space:nowrap'
    case 'section': return 'width:60px;white-space:nowrap'
    case 'age': return 'width:44px;text-align:center;white-space:nowrap'
    case 'gender': return 'width:60px;white-space:nowrap'
    case 'contact1': return 'width:90px;white-space:nowrap'
    case 'contact2': return 'width:90px;white-space:nowrap'
    case 'religion': return 'width:80px;white-space:nowrap'
    case 'dob': return 'width:88px;white-space:nowrap'
    case 'familyLabel': return 'width:90px;white-space:nowrap'
    case 'relation': return 'width:72px;white-space:nowrap'
    case 'sectionName': return 'min-width:120px'
    case 'familyMembersCount': return 'width:80px;text-align:center;white-space:nowrap'
    case 'family': return 'min-width:150px'
    case 'otherGroups': return 'min-width:160px'
    case 'meetingStatus': return 'width:90px;white-space:nowrap'
    default: return ''
  }
}

function voterSearchText(v: Voter): string {
  return [
    vf(v, 'name'), vf(v, 'epic_no'), vf(v, 'relative_name'), vf(v, 'relative_relation'),
    vf(v, 'contact_no_1'), vf(v, 'contact_no_2'), vf(v, 'section'), vf(v, 'house_no'),
    vf(v, 'gender'), vf(v, 'religion'), vf(v, 'family_label'), vf(v, 'section_name'),
    String(vfNum(v, 'ward_no') ?? ''), String(vfNum(v, 'part_no') ?? ''), String(vfNum(v, 'age') ?? ''),
  ].join(' ').toUpperCase()
}

function buildFamilyHeadEpic(voter: Voter): string {
  // Must return the RAW stored value - it is used in
  // .or('family_head_epic.eq.KEY,epic_no.eq.KEY') database filters, and
  // normalization that strips special characters (e.g. "ABC/123456" ->
  // "ABC 123456") would make those filters match nothing in the DB.
  if (voter.family_head_epic) return voter.family_head_epic.trim()
  return voter.epic_no.trim()
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
  const base = 'inline-flex h-9 w-9 items-center justify-center rounded-xl border transition disabled:cursor-not-allowed disabled:opacity-50'
  const styles =
    variant === 'danger' ? 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100'
    : variant === 'primary' ? 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100'
    : 'border-line bg-white text-ink-secondary hover:bg-muted'
  return <button type="button" title={title} onClick={onClick} disabled={disabled} className={`${base} ${styles}`}>{children}</button>
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
    const next = visibleSet.has(key)
      ? visible.filter((k) => k !== key)
      : [...visible, key]
    if (next.length < 1) { toast.error('At least one column must remain visible.'); return }
    onChange(next)
  }

  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir
    if (target < 0 || target >= visible.length) return
    const next = visible.slice()
    ;[next[idx], next[target]] = [next[target], next[idx]]
    onChange(next)
  }

  const visibleDefs = visible
    .map((k) => MEMBER_COLUMNS.find((c) => c.key === k))
    .filter((d): d is MemberColumnDef => Boolean(d))
  const hiddenDefs = MEMBER_COLUMNS.filter((c) => !visibleSet.has(c.key))

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted">
        <Columns3 className="h-3.5 w-3.5" /> Display Columns
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-2 w-80 rounded-2xl border border-line bg-white p-4 md:left-auto md:right-0">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Show / Hide &amp; Order Columns</p>
          <div className="max-h-[60vh] space-y-0.5 overflow-y-auto">
            {visibleDefs.map((col, idx) => (
              <div key={col.key} className="flex items-center gap-1 rounded-xl bg-brand-50 px-2 py-1.5">
                <GripVertical className="h-4 w-4 flex-shrink-0 text-ink-tertiary" />
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm font-medium text-brand-800">
                  <CheckboxUI checked onChange={() => toggle(col.key)} />
                  <span className="truncate">{col.label}</span>
                </label>
                <div className="flex flex-shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    title="Move up"
                    onClick={() => move(idx, -1)}
                    disabled={idx === 0}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-tertiary transition hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    onClick={() => move(idx, 1)}
                    disabled={idx === visible.length - 1}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-tertiary transition hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
            {hiddenDefs.map((col) => (
              <label key={col.key} className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-sm text-ink-secondary transition hover:bg-muted">
                <CheckboxUI checked={false} onChange={() => toggle(col.key)} />
                <span>{col.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function RemoveMemberModal({ member, onClose, onConfirm }: {
  member: Voter | null
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [confirmName, setConfirmName] = useState('')
  const [removing, setRemoving] = useState(false)
  useEffect(() => { setConfirmName('') }, [member])
  if (!member) return null

  const memberName = member.name
  const matches = confirmName.trim().toLowerCase() === memberName.trim().toLowerCase()

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
            <h3 className="text-lg font-semibold text-ink">Remove member</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-sm leading-6 text-ink-secondary">
          This removes <span className="font-semibold text-ink">&ldquo;{memberName}&rdquo;</span> from this group. This cannot be undone. To confirm, type the member&rsquo;s name below.
        </p>
        <label className="mt-4 block text-sm text-ink-secondary">
          Type <span className="font-semibold text-ink">&ldquo;{memberName}&rdquo;</span> to confirm
          <input autoFocus className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
            value={confirmName} onChange={(e) => setConfirmName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void confirm() }} />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
          <button type="button" disabled={!matches || removing} onClick={() => void confirm()}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-rose-600 px-5 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50">
            {removing && <Loader2 className="h-4 w-4 animate-spin" />} Remove member
          </button>
        </div>
      </div>
    </div>
  )
}

export function GroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const { profile, isAdminAreaAllowed } = useAuth()
  const [voters, setVoters] = useState<Voter[]>([])
  const [memberVoters, setMemberVoters] = useState<Voter[]>([])
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>({})
  const [visibleColumns, setVisibleColumns] = usePersistentState<MemberColumnKey[]>(VISIBLE_COLUMNS_KEY, [...DEFAULT_VISIBLE_COLUMNS])
  const [expandedFamilyVoterId, setExpandedFamilyVoterId] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<MemberColumnKey | null>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = usePersistentState<number>(PAGE_SIZE_KEY, 25)
  const [showAdd, setShowAdd] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<Voter | null>(null)
  const [addSearch, setAddSearch] = useState('')
  const [addSearching, setAddSearching] = useState(false)
  const [addFamilyVoters, setAddFamilyVoters] = useState<Voter[]>([])
  const [addSelectedIds, setAddSelectedIds] = useState<Set<string>>(new Set())
  const [addSaving, setAddSaving] = useState(false)
  const [addBrowsePart, setAddBrowsePart] = useState('')
  const [addBrowseVisibleCount, setAddBrowseVisibleCount] = useState(20)
  const [showBulkEpic, setShowBulkEpic] = useState(false)
  const [bulkEpicText, setBulkEpicText] = useState('')
  const [bulkEpicBusy, setBulkEpicBusy] = useState(false)
  const [bulkEpicResult, setBulkEpicResult] = useState<{
    toAdd: Array<{ voter_id: string; epic_no: string; name: string }>
    alreadyIn: string[]
    sibling: Array<{ epic_no: string; name: string; groupName: string }>
    notFound: string[]
  } | null>(null)
  const [printFields, setPrintFields] = usePersistentState<PrintFieldState[]>(PRINT_FIELDS_KEY, DEFAULT_PRINT_FIELDS.map((f) => ({ ...f })))
  const [printConfigOpen, setPrintConfigOpen] = useState(false)
  const [exportConfigOpen, setExportConfigOpen] = useState(false)
  const [printFontSize, setPrintFontSize] = usePersistentState<number>(REPORT_FONT_SIZE_KEY, 20)
  const [printBold, setPrintBold] = usePersistentState<boolean>(REPORT_BOLD_KEY, false)
  const [exportBorders, setExportBorders] = usePersistentState<boolean>(REPORT_BORDERS_KEY, true)
  const [exportRowHeight, setExportRowHeight] = usePersistentState<number>(REPORT_ROW_HEIGHT_KEY, 18)
  const [exportColWidth, setExportColWidth] = usePersistentState<number>(REPORT_COL_WIDTH_KEY, 16)
  const [attendedVoterIds, setAttendedVoterIds] = useState<Set<string>>(new Set())
  const [meetingFilter, setMeetingFilter] = useState<'off' | 'attended' | 'familyAttended'>('off')
  const addRef = useRef<HTMLDivElement>(null)

  const addPartOptions = useMemo(() => {
    return Array.from(new Set(voters.filter((v) => v.part_no != null).map((v) => v.part_no))).sort((a, b) => a! - b!)
  }, [voters])

  // Built only when the Add Members panel is open - grouping the entire voter
  // set on every mount was a big part of the page's startup lag.
  const addAllFamilies = useMemo(() => {
    if (!showAdd) return []
    const map = new Map<string, Voter[]>()
    for (const v of voters) {
      if (v.is_active === false || v.is_active === 0) continue
      const key = buildFamilyHeadEpic(v)
      const list = map.get(key)
      if (list) list.push(v)
      else map.set(key, [v])
    }
    return Array.from(map.entries()).map(([headEpic, members]) => ({
      headEpic,
      headVoter: members.find((m) => normalizeGroupingValue(m.epic_no) === normalizeGroupingValue(headEpic)) ?? members[0] ?? null,
      members,
    }))
  }, [voters, showAdd])

  const addFamiliesInBrowsePart = useMemo(() => {
    if (!addBrowsePart) return []
    return addAllFamilies
      .filter((family) => String(family.headVoter?.part_no ?? '') === addBrowsePart)
      .sort((a, b) => (a.headVoter?.name ?? '').localeCompare(b.headVoter?.name ?? ''))
  }, [addAllFamilies, addBrowsePart])

  const addVisibleBrowseFamilies = addFamiliesInBrowsePart.slice(0, addBrowseVisibleCount)

  const wardScope = buildWardScope(profile?.role, profile?.allowed_wards)

  const load = useCallback(async () => {
    const cachedGroups = readCachedCollection<GroupRow>(GROUPS_CACHE_KEY, wardScope, COLLECTION_CACHE_MAX_AGE_MS)
    const cachedGroupMembers = readCachedCollection<GroupMember>(GROUP_MEMBERS_CACHE_KEY, wardScope, COLLECTION_CACHE_MAX_AGE_MS)
    const cachedAttended = readCachedCollection<{ voter_id: string }>(ATTENDED_CACHE_KEY, wardScope, COLLECTION_CACHE_MAX_AGE_MS)
    const collectionsCached = Boolean(cachedGroups && cachedGroupMembers && cachedAttended)
    setLoading(true)

    let groupRows = cachedGroups ?? []
    let memberRows = cachedGroupMembers ?? []
    let attendedRows = cachedAttended ?? []

    if (!collectionsCached) {
      const [grRes, gmRes, attRes] = await Promise.all([
        supabase.from('groups').select('*').order('created_at', { ascending: false }),
        supabase.from('group_members').select('*'),
        supabase.from('meeting_invitees').select('voter_id, attendance_status').eq('attendance_status', 'attended'),
      ])
      if (grRes.error) toast.error(grRes.error.message)
      if (gmRes.error) toast.error(gmRes.error.message)
      if (attRes.error) toast.error(attRes.error.message)
      groupRows = (grRes.data as GroupRow[] | null) ?? []
      memberRows = (gmRes.data as GroupMember[] | null) ?? []
      attendedRows = (attRes.data as Array<{ voter_id: string }> | null) ?? []
      writeCachedCollection(GROUPS_CACHE_KEY, wardScope, groupRows)
      writeCachedCollection(GROUP_MEMBERS_CACHE_KEY, wardScope, memberRows)
      writeCachedCollection(ATTENDED_CACHE_KEY, wardScope, attendedRows)
    }

    setGroups(groupRows)
    setGroupMembers(memberRows)
    const attended = new Set<string>()
    for (const row of attendedRows) attended.add(row.voter_id)
    setAttendedVoterIds(attended)

    const relatedGroupIds = new Set<string>()
    if (groupId) {
      relatedGroupIds.add(groupId)
      for (const g of groupRows) {
        if (g.parent_group_id === groupId) relatedGroupIds.add(g.id)
      }
    }
    const relatedVoterIds = Array.from(new Set(
      memberRows.filter((gm) => relatedGroupIds.has(gm.group_id)).map((gm) => gm.voter_id),
    ))
    const currentGroup = groupRows.find((g) => g.id === groupId) ?? null

    try {
      const rows: Voter[] = relatedVoterIds.length
        ? await fetchInChunks<Voter>(relatedVoterIds, (chunk) =>
            supabase.from('voters').select('*').in('id', chunk),
          )
        : []

      if (currentGroup?.group_type === 'part_wise' && currentGroup.part_no != null) {
        const { data, error } = await supabase.from('voters').select('*').eq('part_no', currentGroup.part_no)
        if (error) toast.error(error.message)
        else rows.push(...((data as Voter[] | null) ?? []))
      }

      const seen = new Set<string>()
      const deduped: Voter[] = []
      for (const row of rows) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        deduped.push(row)
      }
      setMemberVoters(deduped)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load group members')
      setMemberVoters([])
    }

    setLoading(false)

    void loadAllVoters({
      role: profile?.role,
      allowedWards: profile?.allowed_wards,
      onFirstBatch: (rows) => setVoters(rows),
    })
      .then((rows) => setVoters(rows))
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Voter load failed')
      })
  }, [wardScope, groupId, profile?.role, profile?.allowed_wards])

  useEffect(() => { void load() }, [load])

  const voterById = useMemo(() => {
    const m = new Map<string, Voter>()
    for (const v of memberVoters) m.set(v.id, v)
    for (const v of voters) m.set(v.id, v)
    return m
  }, [memberVoters, voters])
  const groupsById = useMemo(() => { const m = new Map<string, GroupRow>(); for (const g of groups) m.set(g.id, g); return m }, [groups])

  const group = useMemo(() => groupsById.get(groupId ?? '') ?? null, [groupsById, groupId])

  const members = useMemo(() => {
    if (!group) return []
    if (group.group_type === 'part_wise' && group.part_no != null) {
      const source = voters.length ? voters : memberVoters
      return source.filter((v) => v.part_no === group.part_no && v.is_active !== false && v.is_active !== 0)
    }
    const ids = new Set<string>()
    for (const gm of groupMembers) {
      if (gm.group_id === group.id) ids.add(gm.voter_id)
    }
    const result: Voter[] = []
    for (const id of ids) { const v = voterById.get(id); if (v) result.push(v) }
    return result.filter((v) => v.is_active !== false && v.is_active !== 0)
  }, [group, groupMembers, voterById, voters, memberVoters])

  const customGroupMembershipByVoterId = useMemo(() => {
    const map = new Map<string, MembershipEntry[]>()
    for (const gm of groupMembers) {
      const g = groupsById.get(gm.group_id)
      if (!g || g.group_type !== 'custom') continue
      const entry: MembershipEntry = { groupId: g.id, groupName: g.name, parentGroupId: g.parent_group_id }
      const list = map.get(gm.voter_id)
      if (list) list.push(entry)
      else map.set(gm.voter_id, [entry])
    }
    return map
  }, [groupMembers, groupsById])

  const parentGroup = useMemo(() => {
    if (!group?.parent_group_id) return null
    return groupsById.get(group.parent_group_id) ?? null
  }, [group, groupsById])

  const subgroups = useMemo(() => {
    if (!group) return []
    const countByGroupId = new Map<string, number>()
    for (const gm of groupMembers) {
      countByGroupId.set(gm.group_id, (countByGroupId.get(gm.group_id) ?? 0) + 1)
    }
    return groups
      .filter((g) => g.parent_group_id === group.id)
      .map((g) => ({ group: g, memberCount: countByGroupId.get(g.id) ?? 0 }))
  }, [group, groups, groupMembers])

  const familyIndex = useMemo(() => {
    const source = voters.length ? voters : memberVoters
    const grouped = new Map<string, Voter[]>()
    for (const v of source) {
      const key = buildFamilyHeadEpic(v)
      const list = grouped.get(key)
      if (list) list.push(v)
      else grouped.set(key, [v])
    }
    const familyMembersCountByVoterId = new Map<string, number>()
    const familyGroupByVoterId = new Map<string, { headEpic: string; headVoter: Voter | null; members: Voter[] }>()
    for (const [key, familyMembers] of grouped) {
      const headVoter = familyMembers.find((m) => normalizeGroupingValue(m.epic_no) === normalizeGroupingValue(key)) ?? familyMembers[0] ?? null
      const count = familyMembers.length
      for (const v of familyMembers) {
        familyMembersCountByVoterId.set(v.id, count)
        familyGroupByVoterId.set(v.id, { headEpic: key, headVoter, members: familyMembers })
      }
    }
    return { familyMembersCountByVoterId, familyGroupByVoterId }
  }, [voters, memberVoters])

  const familyMembersCountByVoterId = familyIndex.familyMembersCountByVoterId
  const familyGroupByVoterId = familyIndex.familyGroupByVoterId

  const otherGroupsByVoterId = useMemo(() => {
    const map = new Map<string, string[]>()
    if (!group) return map
    for (const [voterId, entries] of customGroupMembershipByVoterId) {
      const others = entries
        .filter((e) => e.groupId !== group.id)
        .map((e) => e.groupName)
      if (others.length) map.set(voterId, others)
    }
    return map
  }, [customGroupMembershipByVoterId, group])

  const familyAttendedVoterIds = useMemo(() => {
    const set = new Set<string>()
    for (const v of members) {
      const family = familyGroupByVoterId.get(v.id)
      if (!family) continue
      if (family.members.some((fm) => attendedVoterIds.has(fm.id))) set.add(v.id)
    }
    return set
  }, [members, familyGroupByVoterId, attendedVoterIds])

  const meetingStatusFor = (voterId: string): string => {
    if (attendedVoterIds.has(voterId)) return 'Attended'
    if (familyAttendedVoterIds.has(voterId)) return 'Family'
    return ''
  }

  const meetingFiltered = useMemo(() => {
    if (meetingFilter === 'attended') return members.filter((m) => attendedVoterIds.has(m.id))
    if (meetingFilter === 'familyAttended') return members.filter((m) => familyAttendedVoterIds.has(m.id))
    return members
  }, [members, meetingFilter, attendedVoterIds, familyAttendedVoterIds])

  const photoColumnVisible = visibleColumns.includes('photo')

  const reloadAfterAction = useCallback(async () => {
    const { data } = await supabase.from('group_members').select('*')
    const rows = (data as GroupMember[] | null) ?? []
    setGroupMembers(rows)
    writeCachedCollection(GROUP_MEMBERS_CACHE_KEY, wardScope, rows)
    if (!groupId) return
    const neededIds = Array.from(new Set(rows.filter((gm) => gm.group_id === groupId).map((gm) => gm.voter_id)))
    if (!neededIds.length) return
    try {
      const extra = await fetchInChunks<Voter>(neededIds, (chunk) =>
        supabase.from('voters').select('*').in('id', chunk),
      )
      setMemberVoters((current) => {
        const seen = new Set(current.map((v) => v.id))
        const next = [...current]
        for (const row of extra) {
          if (seen.has(row.id)) continue
          seen.add(row.id)
          next.push(row)
        }
        return next
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to refresh members')
    }
  }, [wardScope, groupId])

  const removeMember = async (voterId: string) => {
    const { error } = await supabase.from('group_members').delete().eq('group_id', groupId).eq('voter_id', voterId)
    if (error) { toast.error(error.message); return }
    toast.success('Member removed.')
    clearCachedCollection(GROUP_MEMBERS_CACHE_KEY)
    await reloadAfterAction()
  }

  const tokens = useMemo(() => tokenizeLookup(query), [query])

  // Precompute each member's search text once (per data change) so filtering
  // on every keystroke doesn't rebuild the string across the whole group.
  const memberSearchIndex = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of meetingFiltered) map.set(m.id, voterSearchText(m))
    return map
  }, [meetingFiltered])

  const filtered = useMemo(() => {
    if (!tokens.length) return meetingFiltered
    return meetingFiltered.filter((m) => {
      const text = memberSearchIndex.get(m.id)
      if (text == null) return false
      return matchesLookupTokens(text, tokens)
    })
  }, [meetingFiltered, tokens, memberSearchIndex])

  const sorted = useMemo(() => {
    if (!sortKey || sortKey === 'srNo' || sortKey === 'photo') return filtered
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortKey === 'familyMembersCount') {
      const arr = [...filtered]
      arr.sort((a, b) => {
        const ac = familyMembersCountByVoterId.get(a.id) ?? 0
        const bc = familyMembersCountByVoterId.get(b.id) ?? 0
        return (ac - bc) * dir
      })
      return arr
    }
    if (sortKey === 'family') {
      const arr = [...filtered]
      arr.sort((a, b) => {
        const ah = familyGroupByVoterId.get(a.id)?.headVoter?.name ?? ''
        const bh = familyGroupByVoterId.get(b.id)?.headVoter?.name ?? ''
        return ah.localeCompare(bh) * dir
      })
      return arr
    }
    if (sortKey === 'otherGroups') {
      const arr = [...filtered]
      arr.sort((a, b) => {
        const an = (otherGroupsByVoterId.get(a.id) ?? []).join(', ')
        const bn = (otherGroupsByVoterId.get(b.id) ?? []).join(', ')
        return an.localeCompare(bn) * dir
      })
      return arr
    }
    const arr = [...filtered]
    arr.sort((a, b) => {
      const av = getVoterFieldValue(a, sortKey); const bv = getVoterFieldValue(b, sortKey)
      const an = Number(av); const bn = Number(bv)
      if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir
      return av.localeCompare(bv) * dir
    })
    return arr
  }, [filtered, sortKey, sortDir, familyMembersCountByVoterId, familyGroupByVoterId, otherGroupsByVoterId])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageRows = useMemo(() => sorted.slice((safePage - 1) * pageSize, safePage * pageSize), [sorted, safePage, pageSize])

  useEffect(() => { setPage(1) }, [query, pageSize])

  // Only sign photo URLs for what is actually rendered: the current page's
  // rows (when the photo column is visible), the expanded family reveal, and
  // the add-member results. Previously every photo across the whole group was
  // signed on each mount, which made tab-hopping very slow.
  const neededPhotoPaths = useMemo(() => {
    const set = new Set<string>()
    if (photoColumnVisible) {
      for (const m of pageRows) if (m.photo_url) set.add(m.photo_url)
    }
    const expanded = expandedFamilyVoterId ? familyGroupByVoterId.get(expandedFamilyVoterId) : null
    if (expanded) for (const m of expanded.members) if (m.photo_url) set.add(m.photo_url)
    if (showAdd) {
      for (const m of addFamilyVoters) if (m.photo_url) set.add(m.photo_url)
      for (const f of addVisibleBrowseFamilies) {
        if (f.headVoter?.photo_url) set.add(f.headVoter.photo_url)
        for (const m of f.members) if (m.photo_url) set.add(m.photo_url)
      }
    }
    return Array.from(set)
  }, [photoColumnVisible, pageRows, expandedFamilyVoterId, familyGroupByVoterId, showAdd, addFamilyVoters, addVisibleBrowseFamilies])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const missing = neededPhotoPaths.filter((p) => !photoUrlByPath[p])
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
  }, [photoUrlByPath, neededPhotoPaths])

  const toggleSort = (key: MemberColumnKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  const executePrint = async (config: PrintFieldState[], style?: PrintStyleOptions) => {
    const enabledFields = config.filter((f) => f.enabled)
    if (enabledFields.length === 0) { toast.error('Enable at least one field to print.'); return }

    const fontSize = style?.fontSize ?? 10
    const bold = style?.boldText ?? false
    const photoSize = Math.round(40 * (fontSize / 10))

    const fields: { key: PrintFieldKey; label: string; def: PrintFieldDef }[] = enabledFields.map((f) => {
      const def = PRINT_FIELD_DEFS.find((d) => d.key === f.key) ?? { key: f.key, label: f.key }
      return { key: f.key, label: def.label, def }
    })

    const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const now = new Date().toLocaleString()

    const showPhoto = fields.some((f) => f.def.isPhoto)

    // Photo URLs are only signed for the visible page rows; when printing with
    // photos enabled, sign any remaining photos for the printed rows on demand.
    let urls = photoUrlByPath
    if (showPhoto) {
      const missing = Array.from(new Set(sorted.map((r) => r.photo_url).filter((p): p is string => Boolean(p)))).filter((p) => !urls[p])
      if (missing.length) {
        const signed: Record<string, string> = {}
        for (let i = 0; i < missing.length; i += 80) {
          const batch = missing.slice(i, i + 80)
          const { data } = await supabase.storage.from('voter-photos').createSignedUrls(batch, 3600)
          if (!data) continue
          for (let j = 0; j < batch.length; j++) { const url = data[j]?.signedUrl; if (url) signed[batch[j]] = url }
        }
        if (Object.keys(signed).length) {
          urls = { ...urls, ...signed }
          setPhotoUrlByPath(urls)
        }
      }
    }

    const getPrintRowValue = (row: Voter, fkey: PrintFieldKey): string => {
      if (fkey === 'familyMembersCount') return String(familyMembersCountByVoterId.get(row.id) ?? '0')
      if (fkey === 'family') return familyGroupByVoterId.get(row.id)?.headVoter?.name ?? '-'
      if (fkey === 'otherGroups') return (otherGroupsByVoterId.get(row.id) ?? []).join(', ') || '-'
      if (fkey === 'meetingStatus') return meetingStatusFor(row.id)
      return getPrintFieldValue(row, fkey)
    }

    const headerHtml = fields.map((f) => `<th style="${escapeHtml(getPrintColumnStyle(f.key))}">${escapeHtml(f.label)}</th>`).join('')
    const rowsHtml = sorted.map((row, idx) => {
      const cells = fields.map((f) => {
        if (f.def.isPhoto) {
          const p = row.photo_url ? urls[row.photo_url] : undefined
          return `<td style="${escapeHtml(getPrintColumnStyle(f.key))}">${p ? `<img class="photo" src="${escapeHtml(p)}" onerror="this.style.display='none'" />` : '<span class="ph">-</span>'}</td>`
        }
        if (f.def.isSequentialSrNo) {
          return `<td style="${escapeHtml(getPrintColumnStyle(f.key))}">${idx + 1}</td>`
        }
        return `<td style="${escapeHtml(getPrintColumnStyle(f.key))}">${escapeHtml(getPrintRowValue(row, f.key))}</td>`
      }).join('')
      return `<tr>${cells}</tr>`
    }).join('')

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(group?.name ?? 'Group')}</title><style>
@page{size:A4;margin:12mm}body{font-family:Arial,sans-serif;color:#111;padding:0;margin:0}
.hdr{margin-bottom:16px;padding-bottom:8px;border-bottom:2px solid #333}
.hdr h1{font-size:18px;margin:0 0 4px}.hdr .meta{font-size:11px;color:#555}
 table{width:100%;border-collapse:collapse;font-size:${fontSize}px;table-layout:auto}thead{display:table-header-group}
th,td{border:1px solid #ccc;padding:5px 6px;text-align:left;vertical-align:middle}th{background:#f0f0f0;font-weight:600;font-size:${fontSize}px}
${bold ? 'th,td{font-weight:700}' : ''}
.photo{width:${photoSize}px;height:${photoSize}px;object-fit:cover;border-radius:50%;display:block;margin:0 auto}
.ph{display:inline-flex;width:${photoSize}px;height:${photoSize}px;align-items:center;justify-content:center;font-size:${Math.max(11, Math.round(fontSize * 0.9))}px;color:#999;border:1px dashed #ccc;border-radius:50%;margin:0 auto}
@media print{tr{break-inside:avoid}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
${showPhoto ? 'th:first-child,td:first-child{}' : ''}
</style></head><body><div class="hdr"><h1>${escapeHtml(group?.name ?? 'Group')}</h1><div class="meta">Total Members: ${sorted.length} &middot; Printed: ${now}</div></div><table><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table><script>
(function(){var imgs=document.querySelectorAll('img.photo');var loaded=0;var total=imgs.length;
if(total===0){window.print();return}
imgs.forEach(function(img){if(img.complete&&img.naturalWidth>0){loaded++;if(loaded===total)window.print();return}
img.addEventListener('load',function(){loaded++;if(loaded===total)setTimeout(function(){window.print()},100)})
img.addEventListener('error',function(){img.style.display='none';loaded++;if(loaded===total)setTimeout(function(){window.print()},100)})})
if(loaded===total)window.print()})()</script></body></html>`

    openPrintWindow(html)
  }

  const handleExport = (style?: PrintStyleOptions) => {
    try {
      const dataCols = visibleColumns.filter((k) => k !== 'srNo' && k !== 'photo')
      const exportFields: ReportFieldDef<Voter>[] = dataCols.map((k) => {
        const label = MEMBER_COLUMNS.find((c) => c.key === k)?.label ?? k
        return {
          key: k,
          label,
          getValue: (row: Voter) => {
            if (k === 'familyMembersCount') return String(familyMembersCountByVoterId.get(row.id) ?? '0')
            if (k === 'family') return familyGroupByVoterId.get(row.id)?.headVoter?.name ?? '-'
            if (k === 'otherGroups') return (otherGroupsByVoterId.get(row.id) ?? []).join(', ') || '-'
            return getVoterFieldValue(row, k)
          },
        }
      })
      if (!exportFields.length) { toast.error('Enable at least one data column to export.'); return }

      exportFields.push({
        key: 'meetingStatus',
        label: 'Meeting Status',
        getValue: (row: Voter) => meetingStatusFor(row.id),
      })

      // Truncate title to max 31 characters and remove invalid sheet characters to satisfy Excel limits
      const rawTitle = group?.name ?? 'Group'
      const safeTitle = rawTitle.replace(/[\\/?*:[\]]/g, '').slice(0, 31) || 'Group'

      exportRowsToExcel({ rows: sorted, fields: exportFields, fileName: `group-${groupId}`, title: safeTitle }, style)
    } catch (error) {
      console.error('Group export failed', error)
      toast.error('Export failed. Please try again.')
    }
  }

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members])
  const addTokens = useMemo(() => tokenizeLookup(addSearch), [addSearch])

  useEffect(() => {
    if (!addSearch.trim()) { setAddFamilyVoters([]); return }
    let cancelled = false
    const run = async () => {
      setAddSearching(true)
      const trimmed = addSearch.trim(); const localTokens = tokenizeLookup(trimmed)
      if (localTokens.length === 1 && isLikelyEpicToken(localTokens[0])) {
        const epicToken = compactLookupValue(localTokens[0])
        const { data: exactRow } = await supabase.from('voters').select('*').eq('epic_no', epicToken).maybeSingle()
        if (cancelled) return
        if (exactRow) {
          const voter = exactRow as Voter; const headEpic = buildFamilyHeadEpic(voter)
          const { data: fr } = await supabase.from('voters').select('*').or(`family_head_epic.eq.${headEpic},epic_no.eq.${headEpic}`)
          if (cancelled) return
          const all = (fr as Voter[] | null) ?? []; const seen = new Set<string>(); const deduped: Voter[] = []
          for (const row of all) { const k = compactLookupValue(row.epic_no); if (k && !seen.has(k)) { seen.add(k); deduped.push(row) } }
          setAddFamilyVoters(deduped); setAddSearching(false); return
        }
        setAddFamilyVoters([]); setAddSearching(false); return
      }
      const sp = `%${escapeIlikePattern(trimmed).replace(/\s+/g, '%')}%`
      const { data: mr } = await supabase.from('voters').select('*').or([`name.ilike.${sp}`,`relative_name.ilike.${sp}`,`epic_no.ilike.${sp}`,`contact_no_1.ilike.${sp}`,`house_no.ilike.${sp}`].join(',')).limit(20)
      if (cancelled) return
      const matches = (mr as Voter[] | null) ?? []
      if (!matches.length) { setAddFamilyVoters([]); setAddSearching(false); return }
      const seedRow = matches[0]; const headEpic = buildFamilyHeadEpic(seedRow)
      const { data: fr } = await supabase.from('voters').select('*').or(`family_head_epic.eq.${headEpic},epic_no.eq.${headEpic}`)
      if (cancelled) return
      const all = (fr as Voter[] | null) ?? []; const seen = new Set<string>(); const deduped: Voter[] = []
      for (const row of all) { const k = compactLookupValue(row.epic_no); if (k && !seen.has(k)) { seen.add(k); deduped.push(row) } }
      setAddFamilyVoters(deduped); setAddSearching(false)
    }
    void run(); return () => { cancelled = true }
  }, [addSearch])

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (addRef.current && !addRef.current.contains(e.target as Node)) setShowAdd(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const toggleAddMember = (id: string) => {
    if (memberIds.has(id)) return
    if (!group) return
    const conflict = getMembershipConflict(id, group, customGroupMembershipByVoterId, groupsById)
    if (conflict?.type === 'sibling') {
      toast.error(`This voter is already in "${conflict.groupName}", a sibling sub-group. Remove them from there first.`)
      return
    }
    const next = new Set(addSelectedIds); if (next.has(id)) next.delete(id); else next.add(id)
    setAddSelectedIds(next)
  }

  const doAddMembers = async () => {
    if (addSelectedIds.size === 0) { toast.error('Select at least one voter to add.'); return }
    if (!group) return
    const blockedNames = addFamilyVoters
      .filter((v) => addSelectedIds.has(v.id) && getMembershipConflict(v.id, group, customGroupMembershipByVoterId, groupsById)?.type === 'sibling')
      .map((v) => v.name)
    if (blockedNames.length) {
      toast.error(`${blockedNames.join(', ')} already belong to a sibling sub-group. Remove them from there first.`)
      return
    }
    setAddSaving(true)
    const rows = Array.from(addSelectedIds).map((voter_id) => ({ group_id: group.id, voter_id, added_by: profile?.id ?? null }))
    const { error } = await supabase.from('group_members').insert(rows)
    setAddSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success(`${addSelectedIds.size} member(s) added.`)
    setAddSelectedIds(new Set()); setAddSearch(''); setAddFamilyVoters([]); setShowAdd(false)
    clearCachedCollection(GROUP_MEMBERS_CACHE_KEY)
    await reloadAfterAction()
  }

  const parseBulkEpics = (text: string): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const token of text.split(/[\s,;]+/)) {
      const epic = token.trim().toUpperCase()
      if (epic.length < 3 || seen.has(epic)) continue
      seen.add(epic)
      out.push(epic)
    }
    return out
  }

  const previewBulkEpics = async () => {
    if (!group) return
    const epics = parseBulkEpics(bulkEpicText)
    if (!epics.length) {
      toast.error('Paste at least one EPIC number.')
      return
    }
    setBulkEpicBusy(true)
    try {
      const found = await fetchInChunks<{ id: string; epic_no: string; name: string }>(epics, (chunk) =>
        supabase.from('voters').select('id, epic_no, name').in('epic_no', chunk),
      )
      const byEpic = new Map<string, { id: string; epic_no: string; name: string }>()
      for (const row of found) byEpic.set(compactLookupValue(row.epic_no), row)

      const toAdd: Array<{ voter_id: string; epic_no: string; name: string }> = []
      const alreadyIn: string[] = []
      const sibling: Array<{ epic_no: string; name: string; groupName: string }> = []
      const notFound: string[] = []

      for (const epic of epics) {
        const voter = byEpic.get(compactLookupValue(epic))
        if (!voter) {
          notFound.push(epic)
          continue
        }
        if (memberIds.has(voter.id)) {
          alreadyIn.push(epic)
          continue
        }
        const conflict = getMembershipConflict(voter.id, group, customGroupMembershipByVoterId, groupsById)
        if (conflict?.type === 'sibling') {
          sibling.push({ epic_no: epic, name: voter.name, groupName: conflict.groupName })
          continue
        }
        toAdd.push({ voter_id: voter.id, epic_no: voter.epic_no, name: voter.name })
      }
      setBulkEpicResult({ toAdd, alreadyIn, sibling, notFound })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not look up EPICs.')
    } finally {
      setBulkEpicBusy(false)
    }
  }

  const commitBulkEpics = async () => {
    if (!group || !bulkEpicResult?.toAdd.length) {
      toast.error('Preview first, then add the matching voters.')
      return
    }
    setBulkEpicBusy(true)
    try {
      const rows = bulkEpicResult.toAdd.map((row) => ({ group_id: group.id, voter_id: row.voter_id, added_by: profile?.id ?? null }))
      const { error } = await supabase.from('group_members').insert(rows)
      if (error) {
        toast.error(error.message)
        return
      }
      toast.success(`${bulkEpicResult.toAdd.length} member(s) added.`)
      setBulkEpicText('')
      setBulkEpicResult(null)
      setShowBulkEpic(false)
      clearCachedCollection(GROUP_MEMBERS_CACHE_KEY)
      await reloadAfterAction()
    } finally {
      setBulkEpicBusy(false)
    }
  }

  const addHeadVoter = addFamilyVoters.length > 0 ? (addFamilyVoters.find((v) => normalizeGroupingValue(v.epic_no) === normalizeGroupingValue(buildFamilyHeadEpic(addFamilyVoters[0]))) ?? addFamilyVoters[0]) : null
  const addAllChecked = addFamilyVoters.length > 0 && addFamilyVoters.every((v) => addSelectedIds.has(v.id) || memberIds.has(v.id) || getMembershipConflict(v.id, group!, customGroupMembershipByVoterId, groupsById)?.type === 'sibling')

  const toggleFamilyExpanded = (voterId: string) => {
    setExpandedFamilyVoterId((prev) => (prev === voterId ? null : voterId))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="mr-3 h-5 w-5 animate-spin text-ink-tertiary" />
        <span className="text-sm text-ink-tertiary">Loading group...</span>
      </div>
    )
  }

  if (!group) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <p className="text-lg font-semibold text-ink-secondary">Group not found</p>
        <Link to="/groups" className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700">
          <ArrowLeft className="h-4 w-4" /> Back to Groups
        </Link>
      </div>
    )
  }

  const isPartWise = group.group_type === 'part_wise'

  return (
    <div className="space-y-5">
      <PageHeader title={group.name} description={parentGroup ? `Sub-group under "${parentGroup.name}"` : 'Group'} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/groups" className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-600 hover:text-brand-800">
              <ArrowLeft className="h-3.5 w-3.5" /> All Groups
            </Link>
            {parentGroup && (
              <Link to={`/groups/${parentGroup.id}`} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800">
                <ChevronLeft className="h-3.5 w-3.5" /> {parentGroup.name}
              </Link>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-tertiary">
            <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-brand-700">{parentGroup ? 'Sub-group' : 'Group'}</span>
            <span><span className="font-semibold text-ink">{members.length}</span> member{members.length === 1 ? '' : 's'}</span>
            {isPartWise && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-ink-secondary">Part-wise auto</span>}
            {subgroups.length > 0 && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-ink-secondary">{subgroups.length} sub-group{subgroups.length === 1 ? '' : 's'}</span>}
          </div>
        </div>
      </div>

      {subgroups.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-muted/50 p-4">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Sub-groups:</span>
          {subgroups.map((sg) => (
            <Link key={sg.group.id} to={`/groups/${sg.group.id}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1 text-xs font-semibold text-ink-secondary transition hover:border-brand-300 hover:text-brand-700">
              {sg.group.name} <span className="rounded-full bg-muted px-1.5 text-[10px] text-ink-tertiary">{sg.memberCount}</span>
            </Link>
          ))}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
            <input className="h-9 w-full rounded-lg border border-line bg-white pl-9 pr-8 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              placeholder="Search members..." value={query} onChange={(e) => setQuery(e.target.value)} />
            {query && <button type="button" onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear"><X className="h-3.5 w-3.5" /></button>}
          </div>
          <ColumnsDropdown visible={visibleColumns} onChange={setVisibleColumns} />
          <button type="button" onClick={() => setMeetingFilter((f) => (f === 'attended' ? 'off' : 'attended'))}
            className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition ${
              meetingFilter === 'attended'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                : 'border-line bg-white text-ink-secondary hover:bg-muted'
            }`}><UserCheck className="h-3.5 w-3.5" /> Attended Meetings</button>
          <button type="button" onClick={() => setMeetingFilter((f) => (f === 'familyAttended' ? 'off' : 'familyAttended'))}
            className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition ${
              meetingFilter === 'familyAttended'
                ? 'border-amber-300 bg-amber-50 text-amber-700'
                : 'border-line bg-white text-ink-secondary hover:bg-muted'
            }`}><Users className="h-3.5 w-3.5" /> Family Attended</button>
          <button type="button" onClick={() => setExportConfigOpen(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"><Download className="h-3.5 w-3.5" /> Export</button>
          <button type="button" onClick={() => setPrintConfigOpen(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"><Printer className="h-3.5 w-3.5" /> Print</button>
          {!isPartWise && <Button size="compact" onClick={() => setShowAdd((v) => !v)}><UserPlus className="h-3.5 w-3.5" /> Add Members</Button>}
          {!isPartWise && (
            <button
              type="button"
              onClick={() => { setShowBulkEpic((v) => !v); setShowAdd(false) }}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
            >
              <ClipboardPaste className="h-3.5 w-3.5" /> Paste EPICs
            </button>
          )}
        </div>

        {showBulkEpic && !isPartWise && (
          <div className="border-b border-line bg-muted/50 px-5 py-4">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Add members by EPIC list</label>
            <p className="mb-2 text-xs text-ink-tertiary">Paste EPIC numbers, one per line or comma-separated. Preview first, then confirm.</p>
            <textarea
              className="min-h-28 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              placeholder={'ABC1234567\nXYZ9876543'}
              value={bulkEpicText}
              onChange={(e) => { setBulkEpicText(e.target.value); setBulkEpicResult(null) }}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary disabled:opacity-60"
                onClick={() => void previewBulkEpics()}
                disabled={bulkEpicBusy}
              >
                {bulkEpicBusy && !bulkEpicResult ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Preview
              </button>
              <button
                type="button"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white disabled:opacity-60"
                onClick={() => void commitBulkEpics()}
                disabled={bulkEpicBusy || !bulkEpicResult?.toAdd.length}
              >
                {bulkEpicBusy && bulkEpicResult ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Add {bulkEpicResult?.toAdd.length ?? 0} member{(bulkEpicResult?.toAdd.length ?? 0) === 1 ? '' : 's'}
              </button>
              <button
                type="button"
                className="h-9 rounded-lg px-3 text-xs font-semibold text-ink-tertiary hover:text-ink"
                onClick={() => { setShowBulkEpic(false); setBulkEpicText(''); setBulkEpicResult(null) }}
              >
                Cancel
              </button>
            </div>
            {bulkEpicResult ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-4">
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-center">
                  <p className="text-lg font-bold text-emerald-700">{bulkEpicResult.toAdd.length}</p>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600">Will add</p>
                </div>
                <div className="rounded-xl border border-line bg-white px-3 py-2 text-center">
                  <p className="text-lg font-bold text-ink-secondary">{bulkEpicResult.alreadyIn.length}</p>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Already in</p>
                </div>
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-center">
                  <p className="text-lg font-bold text-rose-700">{bulkEpicResult.sibling.length}</p>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-rose-600">Sibling block</p>
                </div>
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-center">
                  <p className="text-lg font-bold text-amber-700">{bulkEpicResult.notFound.length}</p>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-600">Not found</p>
                </div>
                {bulkEpicResult.sibling.length ? (
                  <p className="sm:col-span-4 text-xs text-rose-700">
                    Sibling conflict: {bulkEpicResult.sibling.slice(0, 8).map((row) => `${row.epic_no} (${row.groupName})`).join(', ')}
                  </p>
                ) : null}
                {bulkEpicResult.notFound.length ? (
                  <p className="sm:col-span-4 text-xs text-amber-700">
                    Not found: {bulkEpicResult.notFound.slice(0, 12).join(', ')}{bulkEpicResult.notFound.length > 12 ? '…' : ''}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {showAdd && !isPartWise && (
          <div className="border-b border-line bg-muted/50 px-5 py-4">
            <div ref={addRef} className="relative">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Add Members from Family</label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
                <input className="h-9 w-full rounded-lg border border-line bg-white pl-9 pr-10 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  placeholder="Search family by name, EPIC, relative name, mobile, house number..." value={addSearch}
                  onChange={(e) => setAddSearch(e.target.value)} />
                {addSearch && <button type="button" onClick={() => { setAddSearch(''); setAddFamilyVoters([]); setAddSelectedIds(new Set()) }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear"><X className="h-3.5 w-3.5" /></button>}
              </div>

              {addSearch.trim() && addSearching && (
                <div className="mt-2 rounded-xl border border-line bg-white p-4 text-center text-sm text-ink-tertiary"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Searching...</div>
              )}

              {addSearch.trim() && !addSearching && addFamilyVoters.length > 0 && (
                <div className="mt-2 max-h-[50vh] overflow-y-auto rounded-2xl border border-line">
                  <div className="overflow-hidden bg-white">
                    <div className="border-b border-line bg-muted/70 px-4 py-4">
                      <div className="flex flex-wrap items-start gap-3">
                        <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
                          {addHeadVoter?.photo_url && photoUrlByPath[addHeadVoter.photo_url] ? (
                            <img src={photoUrlByPath[addHeadVoter.photo_url]} alt={addHeadVoter.name} className="h-full w-full object-cover" />
                          ) : <span className="text-xs font-semibold text-brand-700">{initials(addHeadVoter?.name ?? 'NA')}</span>}
                        </div>
                        <div className="min-w-[220px] flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-brand-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-700">Family Head</span>
                            {addHeadVoter?.family_label && <span className="rounded-full border border-line bg-white px-2 py-1 text-[11px] font-semibold text-ink-secondary">{addHeadVoter.family_label}</span>}
                          </div>
                          <p className="mt-1 text-lg font-semibold text-ink">{addHeadVoter?.name ?? 'Unknown'}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
                            <span>EPIC: {buildFamilyHeadEpic(addFamilyVoters[0])}</span>
                            <span>Ward: {addHeadVoter?.ward_no ?? '-'}</span>
                            <span>Part: {addHeadVoter?.part_no ?? '-'}</span>
                            <span>Section: {addHeadVoter?.section ?? '-'}</span>
                            <span>Members: {addFamilyVoters.length}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="min-w-full border-separate border-spacing-0 text-xs">
                        <thead className="bg-muted">
                          <tr>
                            <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
                              <CheckboxUI checked={addAllChecked} onChange={(v) => {
                                if (v) setAddSelectedIds(new Set(addFamilyVoters.filter((mv) => !memberIds.has(mv.id) && getMembershipConflict(mv.id, group, customGroupMembershipByVoterId, groupsById)?.type !== 'sibling').map((mv) => mv.id)))
                                else setAddSelectedIds(new Set())
                              }} />
                            </th>
                            <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Photo</th>
                            <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Name</th>
                            <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">EPIC</th>
                            <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Relative Name</th>
                            <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Relation</th>
                            <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">House No</th>
                          </tr>
                        </thead>
                        <tbody>
                          {addFamilyVoters.map((member) => {
                            const alreadyMember = memberIds.has(member.id)
                            const conflict = alreadyMember ? null : getMembershipConflict(member.id, group, customGroupMembershipByVoterId, groupsById)
                            const blocked = !alreadyMember && conflict?.type === 'sibling'
                            const checked = addSelectedIds.has(member.id) || alreadyMember
                            const photo = member.photo_url ? photoUrlByPath[member.photo_url] : undefined
                            const disabledRow = alreadyMember || blocked
                            return (
                              <tr key={member.id} className={`transition hover:bg-muted ${disabledRow ? 'opacity-50' : 'cursor-pointer'}`}
                                onClick={() => !disabledRow && toggleAddMember(member.id)}>
                                <td className="border-b border-line px-3 py-2.5">
                                  {alreadyMember ? <span className="text-[10px] font-semibold text-emerald-600">Added</span>
                                    : blocked ? <span title={`Already in ${conflict!.groupName}`} className="text-[10px] font-semibold text-rose-600">Blocked</span>
                                    : <CheckboxUI checked={checked} onChange={() => toggleAddMember(member.id)} />}
                                </td>
                                <td className="border-b border-line px-3 py-2.5"><VoterAvatar voter={member} photoUrl={photo} size="sm" /></td>
                                <td className="border-b border-line px-3 py-2.5 font-medium text-ink">
                                  {highlightMatch(member.name, addTokens)}
                                  {conflict ? (
                                    <span className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${conflict.type === 'sibling' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>
                                      {conflict.type === 'sibling' ? `In ${conflict.groupName} remove first` : `Also in: ${conflict.groupNames.join(', ')}`}
                                    </span>
                                  ) : null}
                                </td>
                                <td className="border-b border-line px-3 py-2.5 text-ink-secondary">{highlightMatch(member.epic_no, addTokens)}</td>
                                <td className="border-b border-line px-3 py-2.5 text-ink-secondary">{highlightMatch(member.relative_name ?? '-', addTokens)}</td>
                                <td className="border-b border-line px-3 py-2.5 text-ink-secondary">{member.relative_relation ?? '-'}</td>
                                <td className="border-b border-line px-3 py-2.5 text-ink-secondary">{highlightMatch(member.house_no ?? '-', addTokens)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t border-line bg-white px-4 py-3">
                    <p className="text-sm text-ink-secondary"><span className="font-semibold text-ink">{addSelectedIds.size}</span> selected</p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => { setShowAdd(false); setAddSearch(''); setAddFamilyVoters([]); setAddSelectedIds(new Set()); setAddBrowsePart('') }}
                        className="h-9 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
                      <button type="button" disabled={addSaving || addSelectedIds.size === 0} onClick={() => void doAddMembers()}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60">
                        {addSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Add Members
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* or browse a part */}
              <div className="mt-4 border-t border-line pt-4">
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
                  or Browse a Part
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="h-9 rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                    value={addBrowsePart}
                    onChange={(e) => { setAddBrowsePart(e.target.value); setAddBrowseVisibleCount(20) }}
                  >
                    <option value="">Select part...</option>
                    {addPartOptions.map((p) => (
                      <option key={p} value={String(p)}>Part {p}</option>
                    ))}
                  </select>
                  {addBrowsePart && (
                    <button type="button" onClick={() => setAddBrowsePart('')} className="text-xs font-semibold text-brand-600 hover:text-brand-800">
                      Clear
                    </button>
                  )}
                </div>

                {addBrowsePart && (
                  <div className="mt-3">
                    <p className="mb-2 text-xs text-ink-tertiary">
                      {addFamiliesInBrowsePart.length} famil{addFamiliesInBrowsePart.length === 1 ? 'y' : 'ies'} in Part {addBrowsePart}
                      {addFamiliesInBrowsePart.length > addBrowseVisibleCount ? ` showing first ${addBrowseVisibleCount}` : ''}
                    </p>

                    {!addFamiliesInBrowsePart.length ? (
                      <p className="rounded-2xl border border-line bg-muted p-4 text-center text-sm text-ink-tertiary">
                        No families found in Part {addBrowsePart}.
                      </p>
                    ) : (
                      <div className="max-h-[50vh] space-y-3 overflow-y-auto rounded-2xl border border-line p-2">
                        {addVisibleBrowseFamilies.map((family) => {
                          const familyChecked = family.members.length > 0 && family.members.every((m) => addSelectedIds.has(m.id))
                          return (
                            <div key={family.headEpic} className="overflow-hidden rounded-2xl border border-line bg-white">
                              <div className="flex flex-wrap items-start gap-3 border-b border-line bg-muted/70 px-4 py-3">
                                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-white">
                                  {family.headVoter?.photo_url && photoUrlByPath[family.headVoter.photo_url] ? (
                                    <img src={photoUrlByPath[family.headVoter.photo_url]} alt={family.headVoter.name} className="h-full w-full object-cover" />
                                  ) : (
                                    <span className="text-xs font-semibold text-brand-700">{initials(family.headVoter?.name ?? 'NA')}</span>
                                  )}
                                </div>
                                <div className="min-w-[200px] flex-1">
                                  <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-700">Family Head</span>
                                  <p className="mt-1 text-sm font-semibold text-ink">{family.headVoter?.name ?? 'Unknown'}</p>
                                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-tertiary">
                                    <span>EPIC: {family.headEpic}</span>
                                    <span>Part: {family.headVoter?.part_no ?? '-'}</span>
                                    <span>Section: {family.headVoter?.section ?? '-'}</span>
                                    <span>Members: {family.members.length}</span>
                                  </div>
                                </div>
                                <label className="flex flex-shrink-0 items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                                  <CheckboxUI
                                    checked={familyChecked}
                                    onChange={(v) => {
                                      setAddSelectedIds((prev) => {
                                        const next = new Set(prev)
                                        for (const m of family.members) {
                                          if (memberIds.has(m.id)) continue
                                          const conflict = getMembershipConflict(m.id, group, customGroupMembershipByVoterId, groupsById)
                                          if (conflict?.type === 'sibling') continue
                                          if (v) next.add(m.id); else next.delete(m.id)
                                        }
                                        return next
                                      })
                                    }}
                                  />
                                  Whole family
                                </label>
                              </div>
                              <div className="divide-y divide-line">
                                {family.members.map((member) => {
                                  const alreadyMember = memberIds.has(member.id)
                                  const conflict = alreadyMember ? null : getMembershipConflict(member.id, group, customGroupMembershipByVoterId, groupsById)
                                  const blocked = !alreadyMember && conflict?.type === 'sibling'
                                  return (
                                    <button key={member.id} type="button" disabled={blocked} onClick={() => !blocked && toggleAddMember(member.id)}
                                      className={`flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-muted ${blocked ? 'opacity-50' : ''}`}>
                                      <CheckboxUI checked={addSelectedIds.has(member.id)} onChange={() => !blocked && toggleAddMember(member.id)} />
                                      <VoterAvatar voter={member} photoUrl={member.photo_url ? photoUrlByPath[member.photo_url] : undefined} size="sm" />
                                      <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium text-ink">
                                          {member.name}
                                          {conflict ? (
                                            <span className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${conflict.type === 'sibling' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>
                                              {conflict.type === 'sibling' ? `In ${conflict.groupName}` : `Also in: ${conflict.groupNames.join(', ')}`}
                                            </span>
                                          ) : null}
                                        </p>
                                        <p className="truncate text-xs text-ink-tertiary">
                                          EPIC: {member.epic_no}{member.house_no ? ` House ${member.house_no}` : ''}
                                        </p>
                                      </div>
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {addFamiliesInBrowsePart.length > addBrowseVisibleCount && (
                      <button type="button" onClick={() => setAddBrowseVisibleCount((c) => c + 20)}
                        className="mt-3 w-full rounded-xl border border-dashed border-line py-2 text-sm font-semibold text-brand-600 hover:bg-brand-50/60">
                        Load 20 more families
                      </button>
                    )}
                  </div>
                )}
              </div>

              {addSearch.trim() && !addSearching && addFamilyVoters.length === 0 && (
                <div className="mt-2 rounded-xl border border-dashed border-line bg-white p-4 text-center text-sm text-ink-tertiary">No families found. Try a different search.</div>
              )}
            </div>
          </div>
        )}

        <div className="md:hidden">
          {sorted.length === 0 ? (
            <div className="flex items-center justify-center px-6 py-16 text-center">
              <div>
                <p className="text-sm font-medium text-ink-secondary">{members.length === 0 ? 'No members in this group yet.' : meetingFilter !== 'off' ? 'No members match the active meeting filter.' : 'No members match your search.'}</p>
                <p className="mt-1 text-xs text-ink-tertiary">{members.length === 0 && !isPartWise ? 'Click "Add Members" to start building this group.' : 'Try a different search term.'}</p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-line">
              {pageRows.map((m) => {
                const photo = m.photo_url ? photoUrlByPath[m.photo_url] : undefined
                const isExpanded = expandedFamilyVoterId === m.id
                const familyInfo = familyGroupByVoterId.get(m.id)
                const familyCount = familyMembersCountByVoterId.get(m.id) ?? 0
                const otherGroups = otherGroupsByVoterId.get(m.id) ?? []
                const selfAttended = attendedVoterIds.has(m.id)
                const famAttended = familyAttendedVoterIds.has(m.id)
                const contact = String(m.contact_no_1 || m.contact_no_2 || '').replace(/\D/g, '')
                return (
                  <div
                    key={m.id}
                    className="flex items-start gap-3 px-4 py-3 active:bg-muted"
                    onClick={() => setSelectedVoter(m)}
                  >
                    <VoterAvatar voter={m} photoUrl={photo} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate text-sm font-semibold text-ink">{m.name}</p>
                        {selfAttended && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                            <Check className="h-3 w-3" /> Attended
                          </span>
                        )}
                        {!selfAttended && famAttended && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                            <Users className="h-3 w-3" /> Family
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-tertiary">EPIC: {m.epic_no}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-secondary">
                        <span className="rounded-md bg-muted px-1.5 py-0.5">Part: {m.part_no ?? '-'}</span>
                        <span className="rounded-md bg-muted px-1.5 py-0.5">Section: {m.section ?? '-'}</span>
                        <span className="rounded-md bg-muted px-1.5 py-0.5">Sr: {m.sr_no_roll ?? '-'}</span>
                        <span className="rounded-md bg-muted px-1.5 py-0.5">House: {m.house_no ?? '-'}</span>
                        {m.age != null ? <span className="rounded-md bg-muted px-1.5 py-0.5">{m.age}</span> : null}
                        {m.gender ? <span className="rounded-md bg-muted px-1.5 py-0.5">{m.gender}</span> : null}
                      </div>
                      {familyInfo?.headVoter ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggleFamilyExpanded(m.id) }}
                          className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-white px-2 py-1 text-xs font-semibold text-ink-secondary"
                        >
                          <span className="truncate">{familyInfo.headVoter.name}</span>
                          <span className="rounded-full bg-muted px-1.5 text-[10px] text-ink-tertiary">{familyCount}</span>
                          {isExpanded ? <ChevronUp className="h-3.5 w-3.5 flex-shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />}
                        </button>
                      ) : null}
                      {otherGroups.length > 0 ? (
                        <div className="mt-1.5 flex max-w-full flex-wrap items-center gap-1">
                          {otherGroups.slice(0, 3).map((g) => (
                            <span key={g} className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">{g}</span>
                          ))}
                          {otherGroups.length > 3 && <span className="text-[10px] font-semibold text-ink-tertiary">+{otherGroups.length - 3}</span>}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-col items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      {contact ? (
                        <a
                          href={`tel:${contact}`}
                          className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 transition active:bg-emerald-100"
                          aria-label={`Call ${m.name}`}
                        >
                          <Phone className="h-4 w-4" />
                        </a>
                      ) : null}
                      {!isPartWise && isAdminAreaAllowed && (
                        <button
                          type="button"
                          onClick={() => setRemoveTarget(m)}
                          className="flex h-10 w-10 items-center justify-center rounded-full text-rose-500 transition active:bg-rose-50"
                          aria-label={`Remove ${m.name} from group`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setSelectedVoter(m)}
                        className="flex h-10 w-10 items-center justify-center rounded-full text-ink-tertiary transition active:bg-muted"
                        aria-label={`View ${m.name} details`}
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {expandedFamilyVoterId && (() => {
          const m = pageRows.find((row) => row.id === expandedFamilyVoterId)
          const familyInfo = m ? familyGroupByVoterId.get(m.id) : undefined
          if (!m || !familyInfo) return null
          return (
            <div className="mx-4 my-3 overflow-hidden rounded-xl border border-line bg-white shadow-sm md:hidden">
              <div className="flex flex-wrap items-start gap-3 border-b border-line bg-muted/70 px-4 py-4">
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
                  {familyInfo.headVoter?.photo_url && photoUrlByPath[familyInfo.headVoter.photo_url] ? (
                    <img src={photoUrlByPath[familyInfo.headVoter.photo_url]} alt={familyInfo.headVoter.name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-xs font-semibold text-brand-700">{initials(familyInfo.headVoter?.name ?? 'NA')}</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="rounded-full bg-brand-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-700">Family Head</span>
                  <p className="mt-1 text-lg font-semibold text-ink">{familyInfo.headVoter?.name ?? 'Unknown'}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
                    <span>EPIC: {familyInfo.headEpic}</span>
                    <span>Members: {familyInfo.members.length}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setExpandedFamilyVoterId(null)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-tertiary hover:bg-muted hover:text-ink-secondary"
                  aria-label="Close family"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="divide-y divide-line">
                {familyInfo.members.map((member) => {
                  const memberPhoto = member.photo_url ? photoUrlByPath[member.photo_url] : undefined
                  const contactNumbers = [member.contact_no_1, member.contact_no_2].filter(Boolean).join(', ')
                  return (
                    <div
                      key={member.id}
                      className={`flex items-center gap-3 px-4 py-2.5 active:bg-muted ${member.id === m.id ? 'bg-brand-50/40' : ''}`}
                      onClick={() => setSelectedVoter(member)}
                    >
                      <VoterAvatar voter={member} photoUrl={memberPhoto} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">{member.name}</p>
                        <p className="truncate text-xs text-ink-tertiary">
                          {member.relative_relation || '-'}{member.house_no ? ` • House ${member.house_no}` : ''}{member.age != null ? ` • ${member.age}` : ''}
                        </p>
                      </div>
                      {contactNumbers ? (
                        <a
                          href={`tel:${contactNumbers.split(',')[0].trim()}`}
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"
                          aria-label={`Call ${member.name}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Phone className="h-4 w-4" />
                        </a>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}

        <div className="hidden overflow-auto md:block">
          {sorted.length === 0 ? (
            <div className="flex items-center justify-center px-6 py-16 text-center">
              <div>
                <p className="text-sm font-medium text-ink-secondary">{members.length === 0 ? 'No members in this group yet.' : meetingFilter !== 'off' ? 'No members match the active meeting filter.' : 'No members match your search.'}</p>
                <p className="mt-1 text-xs text-ink-tertiary">{members.length === 0 && !isPartWise ? 'Click "Add Members" to start building this group.' : 'Try a different search term.'}</p>
              </div>
            </div>
          ) : (
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-10 bg-muted">
                <tr>
                  {visibleColumns.map((col) => {
                    const def = MEMBER_COLUMNS.find((c) => c.key === col)
                    const sortable = def?.sortable ?? false; const active = sortKey === col
                    return (
                      <th key={col} className={`${def?.headerClass ?? ''} border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary ${sortable ? 'cursor-pointer select-none hover:text-ink' : ''}`}
                        onClick={() => sortable && toggleSort(col)}>
                        <span className="inline-flex items-center gap-1">{def?.label ?? col}{sortable && active && (sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}</span>
                      </th>
                    )
                  })}
                  <th className="border-b border-line px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((m) => {
                  const photo = m.photo_url ? photoUrlByPath[m.photo_url] : undefined
                  const isExpanded = expandedFamilyVoterId === m.id
                  const familyInfo = familyGroupByVoterId.get(m.id)
                  const familyCount = familyMembersCountByVoterId.get(m.id) ?? 0
                  const otherGroups = otherGroupsByVoterId.get(m.id) ?? []
                  const selfAttended = attendedVoterIds.has(m.id)
                  const famAttended = familyAttendedVoterIds.has(m.id)
                  const rowHighlight = meetingFilter === 'attended' && selfAttended
                    ? 'bg-emerald-50/60'
                    : meetingFilter === 'familyAttended' && famAttended
                      ? 'bg-amber-50/60'
                      : ''
                  return (
                    <React.Fragment key={m.id}>
                      <tr className={`cursor-pointer transition hover:bg-muted ${rowHighlight}`} onClick={() => setSelectedVoter(m)}>
                        {visibleColumns.map((col) => {
                          if (col === 'photo') return (
                            <td key={col} className="border-b border-line px-3 py-2.5">
                              <VoterAvatar voter={m} photoUrl={photo} />
                            </td>
                          )
                          if (col === 'family') return (
                            <td key={col} className="border-b border-line px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                              <button type="button" onClick={() => toggleFamilyExpanded(m.id)}
                                className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-semibold transition ${
                                  isExpanded
                                    ? 'border-brand-300 bg-brand-50 text-brand-700'
                                    : 'border-line bg-white text-ink-secondary hover:border-brand-300 hover:text-brand-700'
                                }`}>
                                <span className="truncate">{familyInfo?.headVoter?.name ?? '-'}</span>
                                <span className="rounded-full bg-muted px-1.5 text-[10px] text-ink-tertiary">{familyCount}</span>
                                {isExpanded ? <ChevronUp className="h-3.5 w-3.5 flex-shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />}
                              </button>
                            </td>
                          )
                          if (col === 'otherGroups') return (
                            <td key={col} className="border-b border-line px-3 py-2.5">
                              {otherGroups.length ? (
                                <div className="flex max-w-[220px] flex-wrap items-center gap-1">
                                  {otherGroups.slice(0, 3).map((g) => (
                                    <span key={g} className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">{g}</span>
                                  ))}
                                  {otherGroups.length > 3 && <span className="text-[10px] font-semibold text-ink-tertiary">+{otherGroups.length - 3}</span>}
                                </div>
                              ) : <span className="text-ink-tertiary">-</span>}
                            </td>
                          )
                          const cellValue = col === 'familyMembersCount' ? String(familyCount) : getVoterFieldValue(m, col)
                          return (
                            <td key={col} className={`border-b border-line px-3 py-2.5 text-ink-secondary ${col === 'name' ? 'font-medium text-ink' : ''}`}>
                              {col === 'name' && selfAttended && (
                                <span className="mr-1.5 inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                                  <Check className="h-3 w-3" /> Attended
                                </span>
                              )}
                              {col === 'name' && !selfAttended && famAttended && (
                                <span className="mr-1.5 inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                                  <Users className="h-3 w-3" /> Family
                                </span>
                              )}
                              {cellValue}
                            </td>
                          )
                        })}
                        <td className="border-b border-line px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="inline-flex items-center gap-1">
                            <IconButton title={isExpanded ? 'Hide family' : 'View family'} variant="primary" onClick={() => toggleFamilyExpanded(m.id)}>
                              <Eye className="h-4 w-4" />
                            </IconButton>
                            {m.contact_no_1 && (() => { const phone = String(m.contact_no_1).replace(/\D/g, ''); return phone ? (
                              <a href={`tel:${phone}`} title="Call" className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-white text-ink-secondary transition hover:bg-muted">
                                <Phone className="h-4 w-4" />
                              </a>
                            ) : null })()}
                            {!isPartWise && isAdminAreaAllowed && (
                              <IconButton title="Remove member" variant="danger" onClick={() => setRemoveTarget(m)}>
                                <Trash2 className="h-4 w-4" />
                              </IconButton>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && familyInfo && (
                        <tr>
                          <td colSpan={visibleColumns.length + 1} className="border-b border-line p-0">
                            <div className="border-t border-line bg-muted/50 px-5 py-4">
                              <div className="overflow-hidden rounded-xl border border-line bg-white shadow-sm">
                                <div className="border-b border-line bg-muted/70 px-4 py-4">
                                  <div className="flex flex-wrap items-start gap-3">
                                    <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
                                      {familyInfo.headVoter?.photo_url && photoUrlByPath[familyInfo.headVoter.photo_url] ? (
                                        <img src={photoUrlByPath[familyInfo.headVoter.photo_url]} alt={familyInfo.headVoter.name} className="h-full w-full object-cover" />
                                      ) : (
                                        <span className="text-xs font-semibold text-brand-700">{initials(familyInfo.headVoter?.name ?? 'NA')}</span>
                                      )}
                                    </div>
                                    <div className="min-w-[220px] flex-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="rounded-full bg-brand-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-700">Family Head</span>
                                        {familyInfo.headVoter?.family_label && (
                                          <span className="rounded-full border border-line bg-white px-2 py-1 text-[11px] font-semibold text-ink-secondary">{familyInfo.headVoter.family_label}</span>
                                        )}
                                      </div>
                                      <p className="mt-1 text-lg font-semibold text-ink">{familyInfo.headVoter?.name ?? 'Unknown'}</p>
                                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
                                        <span>EPIC: {familyInfo.headEpic}</span>
                                        <span>Ward: {familyInfo.headVoter?.ward_no ?? '-'}</span>
                                        <span>Part: {familyInfo.headVoter?.part_no ?? '-'}</span>
                                        <span>Section: {familyInfo.headVoter?.section ?? '-'}</span>
                                        <span>Members: {familyInfo.members.length}</span>
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => setExpandedFamilyVoterId(null)}
                                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-tertiary hover:bg-muted hover:text-ink-secondary"
                                      aria-label="Close family"
                                    >
                                      <X className="h-4 w-4" />
                                    </button>
                                  </div>
                                </div>
                                <div className="overflow-x-auto">
                                  <table className="min-w-full border-separate border-spacing-0 text-sm">
                                    <thead className="bg-muted">
                                      <tr>
                                        <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Photo</th>
                                        <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Name</th>
                                        <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Relationship</th>
                                        <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">House No</th>
                                        <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Age</th>
                                        <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">EPIC</th>
                                        <th className="border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Contact No</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {familyInfo.members.map((member) => {
                                        const memberPhoto = member.photo_url ? photoUrlByPath[member.photo_url] : undefined
                                        const contactNumbers = [member.contact_no_1, member.contact_no_2].filter(Boolean).join(', ') || '-'
                                        return (
                                          <tr
                                            key={member.id}
                                            className={`cursor-pointer transition hover:bg-muted ${member.id === m.id ? 'bg-brand-50/40' : ''}`}
                                            onClick={() => setSelectedVoter(member)}
                                          >
                                            <td className="border-b border-line px-3 py-2.5">
                                              <VoterAvatar voter={member} photoUrl={memberPhoto} size="sm" />
                                            </td>
                                            <td className="border-b border-line px-3 py-2.5 font-medium text-ink">
                                              {member.name}
                                            </td>
                                            <td className="border-b border-line px-3 py-2.5 text-ink-secondary">
                                              {member.relative_relation || '-'}
                                            </td>
                                            <td className="border-b border-line px-3 py-2.5 text-ink-secondary">
                                              {member.house_no || '-'}
                                            </td>
                                            <td className="border-b border-line px-3 py-2.5 text-ink-secondary">
                                              {member.age != null ? String(member.age) : '-'}
                                            </td>
                                            <td className="border-b border-line px-3 py-2.5 text-ink-secondary">
                                              {member.epic_no || '-'}
                                            </td>
                                            <td className="border-b border-line px-3 py-2.5 text-ink-secondary">
                                              {contactNumbers}
                                            </td>
                                          </tr>
                                        )
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {sorted.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-sm">
            <div className="flex items-center gap-2 text-ink-secondary">
              <span>Rows per page:</span>
              <select className="h-8 rounded-lg border border-line bg-white px-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="text-ink-tertiary">{(safePage - 1) * pageSize + 1}-{Math.min(safePage * pageSize, sorted.length)} of {sorted.length}{tokens.length > 0 && ` (filtered from ${members.length})`}</span>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" disabled={safePage <= 1} onClick={() => setPage(1)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" aria-label="First page"><ChevronLeft className="h-4 w-4" /><ChevronLeft className="h-4 w-4 -ml-2" /></button>
              <button type="button" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
              <span className="px-2 text-sm text-ink-secondary">Page {safePage} of {totalPages}</span>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage(totalPages)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" aria-label="Last page"><ChevronRight className="h-4 w-4" /><ChevronRight className="h-4 w-4 -ml-2" /></button>
            </div>
          </div>
        )}
      </div>

      {(printConfigOpen || exportConfigOpen) && (
        <ReportConfigModal
          title={group?.name ?? 'Group Members'}
          open
          mode={printConfigOpen ? 'print' : 'export'}
          fieldDefs={PRINT_FIELD_DEFS}
          fields={printFields.map((f) => ({ key: f.key, enabled: f.enabled }))}
          defaultFields={DEFAULT_PRINT_FIELDS.map((f) => ({ key: f.key, enabled: f.enabled }))}
          fontSize={printFontSize}
          boldText={printBold}
          exportBorders={exportBorders}
          exportRowHeight={exportRowHeight}
          exportColWidth={exportColWidth}
          onClose={() => { setPrintConfigOpen(false); setExportConfigOpen(false) }}
          onConfirm={(fields: ReportFieldItem[], _layout: boolean, style: PrintStyleOptions) => {
            const next = printFields.map((f) => ({ ...f, enabled: fields.find((x) => x.key === f.key)?.enabled ?? false }))
            setPrintFields(next)
            if (printConfigOpen) {
              setPrintFontSize(style.fontSize)
              setPrintBold(style.boldText)
              setPrintConfigOpen(false)
              void executePrint(next, style)
            } else {
              setExportBorders(style.exportBorders)
              setExportRowHeight(style.exportRowHeight)
              setExportColWidth(style.exportColWidth)
              setExportConfigOpen(false)
              handleExport(style)
            }
          }}
        />
      )}
      <RemoveMemberModal
        member={removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={async () => {
          if (!removeTarget) return
          await removeMember(removeTarget.id)
          setRemoveTarget(null)
        }}
      />
      <VoterDetailDrawer voter={selectedVoter} onClose={() => setSelectedVoter(null)} onSaved={async () => { await reloadAfterAction(); setSelectedVoter(null) }} />
    </div>
  )
}
