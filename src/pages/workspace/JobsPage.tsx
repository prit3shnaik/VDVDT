import { useEffect, useMemo, useState, useRef, type ReactNode } from 'react'
import toast from 'react-hot-toast'
import { BadgeCheck, Briefcase, CheckSquare, ChevronDown, ChevronUp, Clock, Cog, FileSpreadsheet, Filter, Layers, Loader2, MoreHorizontal, Phone, Plus, Printer, RefreshCw, Search, Square, Trash2, Users, X } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { StatCard } from '../../components/common/StatCard'
import { JobRecordsExcelImportModal } from '../../components/common/JobRecordsExcelImportModal'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import { exportRowsToExcel, buildPrintHtml, openPrintWindow, type ReportFieldDef, type PrintStyleOptions } from '../../lib/reportBuilder'
import { ReportConfigModal, type ReportFieldItem } from '../../components/common/ReportConfigModal'
import { usePersistentState } from '../../hooks/usePersistentState'
import { supabase } from '../../lib/supabase'
import { fetchInChunks, forEachInChunk } from '../../lib/d1Query'
import { useAuth } from '../../hooks/useAuth'
import { buildWardScope, readCachedVoters, writeCachedVoters, FAST_NAV_CACHE_MAX_AGE_MS } from '../../lib/voterCache'
import { withNormalizedVoterCategories } from '../../lib/voterCategory'
import { matchesLookupTokens, tokenizeLookup, compactLookupValue, isLikelyEpicToken, highlightMatch } from '../../lib/searchUtils'
import type { Voter } from '../../lib/types'

const VOTER_CACHE_KEY = 'vote:jobs:voters-cache-v3'
const PHOTO_BATCH_SIZE = 80

type JobStatus = 'applied_govt' | 'applied_private' | 'appointed_govt' | 'appointed_private' | 'pending'

type JobRow = {
  id: string
  voter_id: string
  job: {
    id: string
    department_name: string
    status: JobStatus
    note: string
    created_at: string
    updated_at: string
  }
  voter: Voter | null
}

type FamilyJobGroup = {
  groupKey: string
  headName: string
  headEpic: string
  houseNo: string
  memberNames: string[]
  memberCount: number
  jobs: JobRow[]
}

const JOB_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'applied_govt', label: 'Applied - Govt' },
  { value: 'applied_private', label: 'Applied - Private' },
  { value: 'appointed_govt', label: 'Appointed - Govt' },
  { value: 'appointed_private', label: 'Appointed - Private' },
]

type ReportFieldKey = 'srNo' | 'name' | 'epic' | 'status' | 'department' | 'note' | 'ward' | 'part' | 'contact1' | 'contact2' | 'section' | 'relativeName' | 'relation' | 'houseNo' | 'age' | 'gender' | 'photo'

const REPORT_FIELD_OPTIONS: ReportFieldDef<JobRow>[] = [
  { key: 'srNo', label: 'Sr No', getValue: () => '' },
  { key: 'name', label: 'Voter Name', getValue: (jr) => jr.voter?.name ?? '' },
  { key: 'epic', label: 'EPIC No', getValue: (jr) => jr.voter?.epic_no ?? '' },
  { key: 'status', label: 'Job Status', getValue: (jr) => jr.job.status },
  { key: 'department', label: 'Department', getValue: (jr) => jr.job.department_name },
  { key: 'note', label: 'Notes', getValue: (jr) => jr.job.note ?? '' },
  { key: 'ward', label: 'Ward', getValue: (jr) => String(jr.voter?.ward_no ?? '') },
  { key: 'part', label: 'Part', getValue: (jr) => String(jr.voter?.part_no ?? '') },
  { key: 'section', label: 'Section', getValue: (jr) => String(jr.voter?.section ?? '') },
  { key: 'relativeName', label: 'Relative Name', getValue: (jr) => jr.voter?.relative_name ?? '' },
  { key: 'relation', label: 'Relation', getValue: (jr) => jr.voter?.relative_relation ?? '' },
  { key: 'houseNo', label: 'House No', getValue: (jr) => jr.voter?.house_no ?? '' },
  { key: 'age', label: 'Age', getValue: (jr) => String(jr.voter?.age ?? '') },
  { key: 'gender', label: 'Gender', getValue: (jr) => jr.voter?.gender ?? '' },
  { key: 'contact1', label: 'Contact No. 1', getValue: (jr) => jr.voter?.contact_no_1 ?? '' },
  { key: 'contact2', label: 'Contact No. 2', getValue: (jr) => jr.voter?.contact_no_2 ?? '' },
  { key: 'photo', label: 'Photo (URL)', getValue: (jr) => jr.voter?.photo_url ?? '' },
]

const INITIAL_REPORT_FIELDS: Record<string, boolean> = {
  srNo: true,
  name: true,
  epic: false,
  status: false,
  department: false,
  note: false,
  ward: false,
  part: false,
  section: false,
  relativeName: false,
  relation: false,
  houseNo: false,
  age: false,
  gender: false,
  contact1: true,
  contact2: false,
  photo: true,
}

const DEFAULT_REPORT_FIELD_ORDER: ReportFieldKey[] = [
  'srNo', 'photo', 'name', 'contact1', 'epic', 'status', 'department', 'note', 'ward', 'part', 'section',
  'relativeName', 'relation', 'houseNo', 'age', 'gender', 'contact2',
]

type TableColumnKey =
  | 'epic'
  | 'status'
  | 'department'
  | 'note'
  | 'section'
  | 'relativeName'
  | 'relation'
  | 'houseNo'
  | 'age'
  | 'gender'
  | 'ward'
  | 'part'
  | 'contact1'
  | 'contact2'
  | 'actions'

interface TableColumnOption {
  key: TableColumnKey
  label: string
}

const TABLE_COLUMN_OPTIONS: TableColumnOption[] = [
  { key: 'epic', label: 'EPIC' },
  { key: 'status', label: 'Status' },
  { key: 'department', label: 'Department' },
  { key: 'note', label: 'Notes' },
  { key: 'section', label: 'Section' },
  { key: 'relativeName', label: 'Relative' },
  { key: 'relation', label: 'Relation' },
  { key: 'houseNo', label: 'House' },
  { key: 'age', label: 'Age' },
  { key: 'gender', label: 'Gender' },
  { key: 'ward', label: 'Ward' },
  { key: 'part', label: 'Part' },
  { key: 'contact1', label: 'Contact 1' },
  { key: 'contact2', label: 'Contact 2' },
  { key: 'actions', label: 'Actions' },
]

const DEFAULT_TABLE_COLUMNS: TableColumnKey[] = [
  'status',
  'department',
  'note',
  'ward',
  'part',
  'contact1',
  'actions',
]

function jobSearchText(jr: JobRow): string {
  return [
    jr.voter?.name ?? '',
    jr.voter?.epic_no ?? '',
    jr.voter?.relative_name ?? '',
    jr.voter?.relative_relation ?? '',
    jr.voter?.house_no ?? '',
    jr.voter?.contact_no_1 ?? '',
    jr.voter?.contact_no_2 ?? '',
    jr.voter?.section ?? '',
    jr.voter?.gender ?? '',
    jr.job.department_name ?? '',
    jr.job.note ?? '',
    jr.job.status ?? '',
    String(jr.voter?.ward_no ?? ''),
    String(jr.voter?.part_no ?? ''),
    String(jr.voter?.age ?? ''),
  ].join(' ').toUpperCase()
}

function statusBadgeClasses(status: JobStatus): string {
  switch (status) {
    case 'appointed_govt':
    case 'appointed_private':
      return 'border border-[var(--success-border)] bg-[var(--success-fill)] text-[var(--success)]'
    case 'applied_govt':
    case 'applied_private':
      return 'border border-brand-100 bg-brand-50 text-brand-700'
    case 'pending':
    default:
      return 'border border-[var(--warning-border)] bg-[var(--warning-fill)] text-[var(--warning)]'
  }
}

function departmentBadgeClasses(department: string): string {
  const colors = [
    'bg-blue-100 text-blue-800',
    'bg-purple-100 text-purple-800',
    'bg-teal-100 text-teal-800',
    'bg-orange-100 text-orange-800',
    'bg-pink-100 text-pink-800',
    'bg-cyan-100 text-cyan-800',
    'bg-indigo-100 text-indigo-800',
    'bg-lime-100 text-lime-800',
  ]
  let hash = 0
  for (let i = 0; i < department.length; i++) {
    hash = department.charCodeAt(i) + ((hash << 5) - hash)
  }
  return colors[Math.abs(hash) % colors.length]
}

// ---------------------------------------------------------------------------
// Family-grouped voter search - mirrors the Families/Meetings "Add" search so
// the Job Record modal can show candidates grouped by family, with photos,
// instead of a flat single-line list.
// ---------------------------------------------------------------------------

interface VoterFamilyGroup {
  key: string
  head: string
  headVoter: Voter | null
  members: Voter[]
}

function normalizeGroupingValue(value: string | number | null | undefined): string {
  return (value ?? '').toString().trim().toUpperCase()
}

function initials(name: string | null | undefined): string {
  return (name || '')
    .split(' ')
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function buildVoterLookupText(voter: Voter): string {
  return [
    voter.name,
    voter.epic_no,
    voter.relative_name,
    voter.relative_relation,
    voter.house_no,
    voter.contact_no_1,
    voter.contact_no_2,
    voter.section_name,
    voter.family_head_epic,
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase()
}

function buildFamilyLookupText(family: VoterFamilyGroup): string {
  return [
    family.head,
    family.headVoter?.name ?? '',
    family.headVoter?.epic_no ?? '',
    ...family.members.flatMap((member) => [
      member.name,
      member.epic_no,
      member.relative_name ?? '',
      member.relative_relation ?? '',
      member.contact_no_1 ?? '',
      member.contact_no_2 ?? '',
      member.house_no ?? '',
    ]),
  ].join(' ').toUpperCase()
}

function familyContainsEpic(family: VoterFamilyGroup, epic: string): boolean {
  const target = compactLookupValue(epic)
  if (!target) return false
  return family.members.some((member) => (
    compactLookupValue(member.epic_no) === target ||
    compactLookupValue(member.family_head_epic) === target ||
    compactLookupValue(family.head) === target
  ))
}

function familyMatchesSearch(family: VoterFamilyGroup, tokens: string[]): boolean {
  if (!tokens.length) return false
  if (tokens.length === 1 && isLikelyEpicToken(tokens[0])) {
    return familyContainsEpic(family, tokens[0])
  }
  if (matchesLookupTokens(buildFamilyLookupText(family), tokens)) return true
  return tokens.length === 1 && familyContainsEpic(family, tokens[0])
}

function memberMatchesSearch(member: Voter, tokens: string[]): boolean {
  return tokens.length > 0 && matchesLookupTokens(buildVoterLookupText(member), tokens)
}

/** Same family-grouping rule used across the app: `family_head_epic` is the only source of truth. */
function buildVoterFamilies(rows: Voter[]): VoterFamilyGroup[] {
  const groups = new Map<string, Voter[]>()
  for (const row of rows) {
    const linkedHead = normalizeGroupingValue(row.family_head_epic)
    const key = linkedHead || normalizeGroupingValue(row.epic_no)
    const members = groups.get(key)
    if (members) members.push(row)
    else groups.set(key, [row])
  }

  const families: VoterFamilyGroup[] = Array.from(groups.entries()).map(([headEpic, members]) => {
    const sortedMembers = [...members].sort((a, b) => {
      const aIsHead = normalizeGroupingValue(a.epic_no) === headEpic
      const bIsHead = normalizeGroupingValue(b.epic_no) === headEpic
      if (aIsHead && !bIsHead) return -1
      if (!aIsHead && bIsHead) return 1
      return (a.name ?? '').localeCompare(b.name ?? '')
    })
    const headVoter = sortedMembers.find((member) => normalizeGroupingValue(member.epic_no) === headEpic) ?? sortedMembers[0] ?? null
    return { key: `GROUP|${headEpic}`, head: headEpic, headVoter, members: sortedMembers }
  })

  families.sort((a, b) => (a.headVoter?.name ?? a.head).localeCompare(b.headVoter?.name ?? b.head))
  return families
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
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-ink-tertiary opacity-0 transition group-hover:opacity-100 hover:bg-muted hover:text-ink-secondary focus:opacity-100"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-44 rounded-xl border border-line bg-white p-1.5 shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

// GitHub-style delete confirmation - the red button stays disabled until the
// exact voter name is typed. Prevents accidental one-click deletions.
function DeleteJobModal({ row, onClose, onConfirm }: {
  row: JobRow | null
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)

  useEffect(() => { setConfirmName('') }, [row])

  if (!row) return null
  const voterName = row.voter?.name ?? 'Unknown voter'
  const matches = confirmName.trim().toLowerCase() === voterName.trim().toLowerCase()

  const confirm = async () => {
    if (!matches || deleting) return
    setDeleting(true)
    await onConfirm()
    setDeleting(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
              <Trash2 className="h-4 w-4" />
            </span>
            <h3 className="text-lg font-semibold text-ink">Delete job record</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-sm leading-6 text-ink-secondary">
          This permanently deletes the job record for <span className="font-semibold text-ink">&ldquo;{voterName}&rdquo;</span>
          {row.voter?.epic_no ? <span> (EPIC {row.voter.epic_no})</span> : null}. This cannot be undone. To confirm, type the voter&rsquo;s name below.
        </p>
        <label className="mt-4 block text-sm text-ink-secondary">
          Type <span className="font-semibold text-ink">&ldquo;{voterName}&rdquo;</span> to confirm
          <input autoFocus className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
            value={confirmName} onChange={(e) => setConfirmName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void confirm() }} />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted">Cancel</button>
          <button type="button" disabled={!matches || deleting} onClick={() => void confirm()}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-rose-600 px-5 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50">
            {deleting && <Loader2 className="h-4 w-4 animate-spin" />} Delete job record
          </button>
        </div>
      </div>
    </div>
  )
}

export function JobsPage() {
  const { profile } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [jobRows, setJobRows] = useState<JobRow[]>([])
  const [voters, setVoters] = useState<Voter[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = usePersistentState<string>('jobs_status_filter', '')
  const [partFilter, setPartFilter] = usePersistentState<string>('jobs_part_filter', '')
  const [wardFilter, setWardFilter] = usePersistentState<string>('jobs_ward_filter', '')
  const [sectionFilter, setSectionFilter] = usePersistentState<string>('jobs_section_filter', '')
  const [departmentFilter, setDepartmentFilter] = usePersistentState<string>('jobs_department_filter', '')
  const [viewMode, setViewMode] = usePersistentState<'flat' | 'family'>('jobs_view_mode', 'flat')

  const [tableColumns, setTableColumns] = usePersistentState<TableColumnKey[]>('jobs_table_columns_v2', [...DEFAULT_TABLE_COLUMNS])
  const [tableColumnsOpen, setTableColumnsOpen] = useState(false)

  const [showPrintConfig, setShowPrintConfig] = useState(false)
  const [showExportConfig, setShowExportConfig] = useState(false)
  const [reportGroupBy, setReportGroupBy] = useState<'none' | 'status' | 'ward' | 'department' | 'family' | 'section'>('none')
  const [reportScope, setReportScope] = useState<'filtered' | 'all'>('filtered')
  const [reportFields, setReportFieldsState] = useState<Record<string, boolean>>({ ...INITIAL_REPORT_FIELDS })
  const [reportFieldOrder, setReportFieldOrder] = useState<ReportFieldKey[]>([...DEFAULT_REPORT_FIELD_ORDER])
  const [reportFontSize, setReportFontSize] = usePersistentState<number>('jobs_print_font_size:v2', 20)
  const [reportBold, setReportBold] = usePersistentState<boolean>('jobs_print_bold', false)
  const [reportBorders, setReportBorders] = usePersistentState<boolean>('jobs_export_borders', true)
  const [reportRowHeight, setReportRowHeight] = usePersistentState<number>('jobs_export_row_height', 18)
  const [reportColWidth, setReportColWidth] = usePersistentState<number>('jobs_export_col_width', 16)

  const [showModal, setShowModal] = useState(false)
  const [showJobImport, setShowJobImport] = useState(false)
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [editingJob, setEditingJob] = useState<JobRow | null>(null)
  const [formState, setFormState] = useState<{ department_name: string; status: JobStatus; note: string }>({
    department_name: '',
    status: 'pending',
    note: '',
  })
  const [voterSearchQuery, setVoterSearchQuery] = useState('')
  const [voterBrowsePart, setVoterBrowsePart] = useState('')
  const [voterBrowseVisibleCount, setVoterBrowseVisibleCount] = useState(30)

  const [detailDrawerVoter, setDetailDrawerVoter] = useState<Voter | null>(null)
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>({})

  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set())
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<JobRow | null>(null)

  const searchTokens = useMemo(() => tokenizeLookup(searchQuery), [searchQuery])
  const hasActiveSearch = searchTokens.length > 0

  const uniqueWards = useMemo(() => {
    const wards = new Set<number>()
    jobRows.forEach((jr) => { if (jr.voter?.ward_no != null) wards.add(jr.voter.ward_no) })
    return Array.from(wards).sort((a, b) => a - b)
  }, [jobRows])

  const uniqueParts = useMemo(() => {
    const parts = new Set<number>()
    jobRows.forEach((jr) => { if (jr.voter?.part_no != null) parts.add(jr.voter.part_no) })
    return Array.from(parts).sort((a, b) => a - b)
  }, [jobRows])

  const sectionOptions = useMemo(() => {
    if (!partFilter) return uniqueNumberList(jobRows.map((jr) => jr.voter?.section))
    return uniqueNumberList(
      jobRows.filter((jr) => String(jr.voter?.part_no ?? '') === partFilter).map((jr) => jr.voter?.section)
    )
  }, [jobRows, partFilter])

  const uniqueDepartments = useMemo(() => {
    const depts = new Set<string>()
    jobRows.forEach((jr) => { if (jr.job.department_name) depts.add(jr.job.department_name) })
    return Array.from(depts).sort()
  }, [jobRows])

  const filteredJobs = useMemo(() => {
    return jobRows.filter((jr) => {
      if (statusFilter && jr.job.status !== statusFilter) return false
      if (departmentFilter && jr.job.department_name !== departmentFilter) return false
      if (partFilter && String(jr.voter?.part_no ?? '') !== partFilter) return false
      if (wardFilter && String(jr.voter?.ward_no ?? '') !== wardFilter) return false
      if (sectionFilter && String(jr.voter?.section ?? '') !== sectionFilter) return false

      if (hasActiveSearch) {
        if (searchTokens.length === 1 && isLikelyEpicToken(searchTokens[0])) {
          const epicToken = compactLookupValue(searchTokens[0])
          const voterEpic = compactLookupValue(jr.voter?.epic_no)
          if (voterEpic !== epicToken && !voterEpic.includes(epicToken)) {
            return false
          }
        } else {
          const searchText = jobSearchText(jr)
          if (!matchesLookupTokens(searchText, searchTokens)) return false
        }
      }
      return true
    })
  }, [jobRows, statusFilter, departmentFilter, partFilter, wardFilter, sectionFilter, hasActiveSearch, searchTokens])

  const familyGroups = useMemo((): FamilyJobGroup[] => {
    if (viewMode !== 'family') return []
    const groups = new Map<string, JobRow[]>()
    for (const jr of filteredJobs) {
      const headKey = (jr.voter?.family_head_epic || jr.voter?.epic_no || `unknown-${jr.voter_id}`).trim().toUpperCase()
      const list = groups.get(headKey)
      if (list) list.push(jr)
      else groups.set(headKey, [jr])
    }
    return Array.from(groups.entries())
      .map(([key, jobs]) => {
        const headVoter = jobs.find((j) => j.voter?.epic_no?.trim().toUpperCase() === key)?.voter ?? jobs[0]?.voter
        const memberNames = Array.from(new Set(jobs.map((j) => j.voter?.name).filter((n): n is string => Boolean(n))))
        return {
          groupKey: key,
          headName: headVoter?.name ?? key,
          headEpic: headVoter?.epic_no ?? key,
          houseNo: headVoter?.house_no ?? '-',
          memberNames,
          memberCount: memberNames.length,
          jobs,
        }
      })
      .sort((a, b) => a.headName.localeCompare(b.headName))
  }, [filteredJobs, viewMode])

  const wardScope = useMemo(() => buildWardScope(profile?.role, profile?.allowed_wards), [profile?.role, profile?.allowed_wards])

  const allowedWards = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((w) => Number.isFinite(w))))
    return wards.sort((a, b) => a - b)
  }, [profile?.allowed_wards])

  const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0

  const jobStats = useMemo(() => {
    const statusCounts: Record<string, number> = {}
    const deptCounts: Record<string, number> = {}
    let appointed = 0
    let applied = 0
    let pending = 0
    for (const jr of jobRows) {
      const st = jr.job.status
      statusCounts[st] = (statusCounts[st] ?? 0) + 1
      if (st.startsWith('appointed')) appointed += 1
      else if (st.startsWith('applied')) applied += 1
      else if (st === 'pending') pending += 1
      const dept = jr.job.department_name || 'Unspecified'
      deptCounts[dept] = (deptCounts[dept] ?? 0) + 1
    }
    return {
      total: jobRows.length,
      statusCounts,
      deptCounts,
      appointed,
      applied,
      pending,
      topDepartments: Object.entries(deptCounts).sort((a, b) => b[1] - a[1]).slice(0, 8),
    }
  }, [jobRows])

  const loadData = async () => {
    setLoading(true)
    try {
      const cached = withNormalizedVoterCategories(readCachedVoters(VOTER_CACHE_KEY, wardScope, FAST_NAV_CACHE_MAX_AGE_MS) ?? [])
      let voterRows: Voter[] = cached
      if (cached.length) {
        setVoters(cached)
      } else {
        const allowedWards = profile?.allowed_wards ?? []
        const hasWardRestriction = profile?.role !== 'admin' && allowedWards.length > 0

        // Supabase/PostgREST caps a single request at ~1000 rows - fetch in
        // batches so constituencies with more voters than that don't get
        // silently truncated. An explicit `.order('id')` is required here:
        // without a stable sort, Postgres doesn't guarantee the same row
        // order across separate paginated requests, so pages can silently
        // skip or duplicate rows - this was the actual cause of specific
        // voters (e.g. one family member) randomly going missing.
        voterRows = []
        let offset = 0
        const batchSize = 500
        let fetchFailed = false

        for (;;) {
          let batch: Voter[] | null = null
          for (let attempt = 0; attempt < 3 && batch === null; attempt++) {
            let request = supabase
              .from('voters')
              .select('*')
              .order('id', { ascending: true })
              .range(offset, offset + batchSize - 1)

            if (hasWardRestriction) {
              request = request.in('ward_no', allowedWards)
            }

            const { data, error } = await request
            if (!error) {
              batch = withNormalizedVoterCategories((data ?? []) as Voter[])
            } else if (attempt === 2) {
              toast.error(`Failed to load full voter list: ${error.message}. Showing partial data - please refresh to retry.`)
              fetchFailed = true
            }
          }

          if (batch === null) break
          voterRows.push(...batch)
          if (batch.length < batchSize) break
          offset += batchSize
        }

        setVoters(voterRows)
        // Only cache a fetch that completed cleanly - caching a partial list
        // would keep reproducing the missing-voter bug until the cache expired.
        if (!fetchFailed) {
          writeCachedVoters(VOTER_CACHE_KEY, wardScope, voterRows)
        }
      }

      const voterList = cached.length ? cached : voterRows
      const voterById = new Map(voterList.map((voter) => [voter.id, voter]))

      const { data: jobsData, error: jobsError } = await supabase
        .from('job_records')
        .select('*')
        .order('created_at', { ascending: false })

      if (jobsError) throw jobsError

      const missingVoterIds = Array.from(new Set(
        (jobsData || [])
          .map((j: { voter_id?: string }) => j.voter_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0 && !voterById.has(id)),
      ))
      if (missingVoterIds.length) {
        const extraVoters = await fetchInChunks<Voter>(
          missingVoterIds,
          (chunk) => supabase.from('voters').select('*').in('id', chunk),
        )
        for (const voter of withNormalizedVoterCategories(extraVoters)) voterById.set(voter.id, voter)
      }

      const rows: JobRow[] = (jobsData || []).map((j: any) => ({
        id: j.id,
        voter_id: j.voter_id,
        job: {
          id: j.id,
          department_name: j.department_name,
          status: j.status,
          note: j.note || '',
          created_at: j.created_at,
          updated_at: j.updated_at,
        },
        voter: voterById.get(j.voter_id) ?? null,
      }))

      setJobRows(rows)
    } catch (err: any) {
      toast.error(`Failed to load jobs: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData()
  }, [])

  const allVoterFamilies = useMemo(() => buildVoterFamilies(voters), [voters])
  const voterSearchTokens = useMemo(() => tokenizeLookup(voterSearchQuery), [voterSearchQuery])
  const SEARCH_FAMILY_LIMIT = 15
  const allMatchingVoterFamilies = useMemo(() => {
    if (!voterSearchTokens.length) return []
    return allVoterFamilies.filter((family) => familyMatchesSearch(family, voterSearchTokens))
  }, [allVoterFamilies, voterSearchTokens])
  const visibleMatchingVoterFamilies = allMatchingVoterFamilies.slice(0, SEARCH_FAMILY_LIMIT)

  // "Browse by part" - an alternative to typing a search: pick a part and
  // see every family in it, family-wise, same as the search results below.
  const voterPickerPartOptions = useMemo(() => {
    const parts = new Set<number>()
    voters.forEach((voter) => { if (voter.part_no != null) parts.add(voter.part_no) })
    return Array.from(parts).sort((a, b) => a - b)
  }, [voters])
  const familiesForBrowsePart = useMemo(() => {
    if (!voterBrowsePart) return []
    return allVoterFamilies
      .filter((family) => String(family.headVoter?.part_no ?? '') === voterBrowsePart)
      .sort((a, b) => (a.headVoter?.name ?? '').localeCompare(b.headVoter?.name ?? ''))
  }, [allVoterFamilies, voterBrowsePart])
  const visibleBrowseFamilies = familiesForBrowsePart.slice(0, voterBrowseVisibleCount)

  // Search takes priority if both are somehow active; otherwise fall back
  // to the part-browse list. Selecting one clears the other in the UI.
  const isBrowseMode = voterSearchTokens.length === 0 && voterBrowsePart !== ''
  const activeFamiliesForPicker = voterSearchTokens.length > 0 ? visibleMatchingVoterFamilies : isBrowseMode ? visibleBrowseFamilies : []
  const activeFamiliesTotalCount = voterSearchTokens.length > 0 ? allMatchingVoterFamilies.length : familiesForBrowsePart.length

  const visiblePhotoPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const jr of jobRows) if (jr.voter?.photo_url) paths.add(jr.voter.photo_url)
    for (const family of visibleMatchingVoterFamilies) {
      for (const member of family.members) if (member.photo_url) paths.add(member.photo_url)
    }
    if (selectedVoter?.photo_url) paths.add(selectedVoter.photo_url)
    return Array.from(paths)
  }, [jobRows, visibleMatchingVoterFamilies, selectedVoter])

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      const missingPaths = visiblePhotoPaths.filter((path) => !photoUrlByPath[path])
      if (!missingPaths.length) return

      for (let start = 0; start < missingPaths.length; start += PHOTO_BATCH_SIZE) {
        if (cancelled) return
        const batch = missingPaths.slice(start, start + PHOTO_BATCH_SIZE)
        const { data, error } = await supabase.storage.from('voter-photos').createSignedUrls(batch, 60 * 60)

        if (cancelled) return
        if (error || !data) continue

        const next: Record<string, string> = {}
        for (let i = 0; i < batch.length; i++) {
          const path = batch[i]
          const signed = data[i]?.signedUrl
          if (signed) next[path] = signed
        }

        if (Object.keys(next).length) {
          setPhotoUrlByPath((current) => ({ ...current, ...next }))
        }
      }
    }

    void run()
    return () => { cancelled = true }
  }, [visiblePhotoPaths])

  const photoUrlsByVoterId = useMemo(() => {
    const map: Record<string, string> = {}
    for (const jr of jobRows) {
      const v = jr.voter
      if (v?.photo_url && photoUrlByPath[v.photo_url]) {
        map[v.id] = photoUrlByPath[v.photo_url]
      }
    }
    return map
  }, [photoUrlByPath, jobRows])

  useEffect(() => {
    if (!partFilter && sectionFilter) setSectionFilter('')
  }, [partFilter, sectionFilter, setSectionFilter])

  useEffect(() => {
    if (sectionFilter && !sectionOptions.some((s) => String(s) === sectionFilter)) {
      setSectionFilter('')
    }
  }, [sectionFilter, sectionOptions, setSectionFilter])

  useEffect(() => {
    if (departmentFilter && !uniqueDepartments.some((d) => d === departmentFilter)) {
      setDepartmentFilter('')
    }
  }, [departmentFilter, uniqueDepartments, setDepartmentFilter])

  const handleSaveJob = async () => {
    if (!selectedVoter) return
    setSaving(true)
    try {
      if (editingJob) {
        const { error } = await supabase
          .from('job_records')
          .update({
            department_name: formState.department_name,
            status: formState.status,
            note: formState.note,
          })
          .eq('id', editingJob.id)
        if (error) throw error
        toast.success('Job record updated')
      } else {
        const { error } = await supabase.from('job_records').insert({
          voter_id: selectedVoter.id,
          department_name: formState.department_name,
          status: formState.status,
          note: formState.note,
        })
        if (error) throw error
        toast.success('Job record created')
      }
      setShowModal(false)
      setSelectedVoter(null)
      setEditingJob(null)
      void loadData()
    } catch (err: any) {
      toast.error(err.message || 'Operation failed')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteJob = async (id: string) => {
    try {
      const { error } = await supabase.from('job_records').delete().eq('id', id)
      if (error) throw error
      toast.success('Job record deleted')
      setSelectedJobIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      void loadData()
    } catch (err: any) {
      toast.error(`Delete failed: ${err.message}`)
    }
  }

  const handleBulkStatusUpdate = async (newStatus: JobStatus) => {
    if (!selectedJobIds.size) return
    setSaving(true)
    try {
      const ids = Array.from(selectedJobIds)
      await forEachInChunk(ids, async (chunk) => {
        const { error } = await supabase
          .from('job_records')
          .update({ status: newStatus })
          .in('id', chunk)
        if (error) throw error
      })
      toast.success(`Updated ${ids.length} job record(s) to "${newStatus}"`)
      setSelectedJobIds(new Set())
      setBulkStatusOpen(false)
      void loadData()
    } catch (err: any) {
      toast.error(`Bulk update failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const openAddModal = () => {
    setEditingJob(null)
    setSelectedVoter(null)
    setFormState({ department_name: '', status: 'pending', note: '' })
    setVoterSearchQuery('')
    setVoterBrowsePart('')
    setVoterBrowseVisibleCount(30)
    setShowModal(true)
  }

  const openEditModal = (row: JobRow) => {
    setEditingJob(row)
    setSelectedVoter(row.voter)
    setFormState({
      department_name: row.job.department_name,
      status: row.job.status,
      note: row.job.note,
    })
    setVoterSearchQuery('')
    setShowModal(true)
  }

  const closeModal = () => {
    setShowModal(false)
    setSelectedVoter(null)
    setEditingJob(null)
    setVoterSearchQuery('')
    setVoterBrowsePart('')
    setVoterBrowseVisibleCount(30)
  }

  const reportSourceRows = reportScope === 'all' ? jobRows : filteredJobs

  const resolvePhotoUrl = (jr: JobRow): string => {
    const v = jr.voter
    if (!v?.photo_url) return ''
    return photoUrlByPath[v.photo_url] ?? ''
  }

  const handleExportExcel = (style: PrintStyleOptions) => {
    const orderedKeys = reportFieldOrder.filter((key) => reportFields[key])
    if (!orderedKeys.length) {
      toast.error('Select at least one field to export.')
      return
    }

    const fields = REPORT_FIELD_OPTIONS.filter((f) => orderedKeys.includes(f.key as ReportFieldKey))
    const srById = new Map<string, number>()
    reportSourceRows.forEach((row, index) => srById.set(row.id, index + 1))
    const orderedFields = orderedKeys.map((key) => fields.find((f) => f.key === key)!).filter(Boolean)
      .map((f) => f.key === 'srNo' ? { ...f, getValue: (jr: JobRow) => String(srById.get(jr.id) ?? '') } : f)

    const photoFields = orderedFields.map((f) => f.key === 'photo' ? { ...f, getValue: (jr: JobRow) => resolvePhotoUrl(jr) } : f)

    const config = {
      rows: reportSourceRows,
      fields: photoFields,
      fileName: 'Job_Records',
      title: 'Job Records',
      layout: { type: 'flat' as const },
      ...(reportGroupBy !== 'none'
        ? {
            groupBy: {
              groupBy: reportGroupBy,
              resolve: (row: JobRow) => {
                switch (reportGroupBy) {
                  case 'status': return row.job.status
                  case 'ward': return row.voter?.ward_no != null ? `Ward ${row.voter.ward_no}` : 'Ward -'
                  case 'department': return row.job.department_name || '-'
                  case 'family': {
                    const epic = row.voter?.family_head_epic || row.voter?.epic_no || '-'
                    return `Family: ${row.voter?.name ?? epic}`
                  }
                  case 'section': return row.voter?.section != null ? `Section ${row.voter.section}` : 'Section -'
                  default: return ''
                }
              },
            },
          }
        : {}),
    }

    void exportRowsToExcel(config, style)
    setShowExportConfig(false)
  }

  const handlePrint = (style: PrintStyleOptions) => {
    const orderedKeys = reportFieldOrder.filter((key) => reportFields[key])
    if (!orderedKeys.length) {
      toast.error('Select at least one field to print.')
      return
    }

    const fields = REPORT_FIELD_OPTIONS.filter((f) => orderedKeys.includes(f.key as ReportFieldKey))
    const srById = new Map<string, number>()
    reportSourceRows.forEach((row, index) => srById.set(row.id, index + 1))
    const orderedFields = orderedKeys.map((key) => fields.find((f) => f.key === key)!).filter(Boolean)
      .map((f) => f.key === 'srNo' ? { ...f, getValue: (jr: JobRow) => String(srById.get(jr.id) ?? '') } : f)

    const hasPhoto = orderedKeys.includes('photo')
    const photoResolver = hasPhoto ? (jr: JobRow) => resolvePhotoUrl(jr) : undefined

    const html = buildPrintHtml({
      rows: reportSourceRows,
      fields: orderedFields,
      title: 'Job Records Report',
      meta: `Generated ${new Date().toLocaleString()} • ${reportSourceRows.length} records`,
      photoResolver,
      ...(reportGroupBy !== 'none'
        ? {
            groupBy: {
              groupBy: reportGroupBy,
              resolve: (row: JobRow) => {
                switch (reportGroupBy) {
                  case 'status': return row.job.status
                  case 'ward': return row.voter?.ward_no != null ? `Ward ${row.voter.ward_no}` : 'Ward -'
                  case 'department': return row.job.department_name || '-'
                  case 'family': {
                    const epic = row.voter?.family_head_epic || row.voter?.epic_no || '-'
                    return `Family: ${row.voter?.name ?? epic}`
                  }
                  case 'section': return row.voter?.section != null ? `Section ${row.voter.section}` : 'Section -'
                  default: return ''
                }
              },
            },
          }
        : {}),
    }, style)
    openPrintWindow(html)
    setShowPrintConfig(false)
  }

  const toggleAllJobs = () => {
    if (selectedJobIds.size === filteredJobs.length) {
      setSelectedJobIds(new Set())
    } else {
      setSelectedJobIds(new Set(filteredJobs.map((jr) => jr.id)))
    }
  }

  const toggleJobSelection = (id: string) => {
    setSelectedJobIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const isAllSelected = filteredJobs.length > 0 && selectedJobIds.size === filteredJobs.length

  const renderJobRow = (jr: JobRow, _index: number) => {
    const v = jr.voter
    const photoUrl = v ? photoUrlsByVoterId[v.id] : undefined
    const isSelected = selectedJobIds.has(jr.id)

    return (
      <tr key={jr.id} className={`group hover:bg-muted transition-colors ${isSelected ? 'bg-indigo-50/70' : ''}`}>
        <td className="px-2 py-3">
          <button
            type="button"
            onClick={() => toggleJobSelection(jr.id)}
            className="text-ink-tertiary hover:text-indigo-500 transition-colors"
          >
            {isSelected ? <CheckSquare className="h-4 w-4 text-indigo-500" /> : <Square className="h-4 w-4" />}
          </button>
        </td>

        <td className="px-2 py-3">
          {photoUrl ? (
            <img src={photoUrl} alt={v?.name ?? ''} className="h-9 w-9 rounded-full border border-line object-cover" />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-ink-tertiary">
              <span className="text-xs font-bold">{v?.name?.charAt(0) || '?'}</span>
            </div>
          )}
        </td>

        <td className="px-3 py-3">
          <button
            type="button"
            onClick={() => { if (v) setDetailDrawerVoter(v) }}
            className="text-left hover:text-indigo-600 transition-colors"
          >
            <div className="text-sm font-medium text-ink hover:underline">
              {hasActiveSearch ? highlightMatch(v?.name ?? 'Unknown', searchTokens) : (v?.name ?? 'Unknown')}
            </div>
          </button>
          <div className="text-xs text-ink-tertiary mt-0.5">
            EPIC: {hasActiveSearch ? highlightMatch(v?.epic_no ?? '-', searchTokens) : (v?.epic_no ?? '-')}
            {v?.house_no ? ` • H.No: ${v.house_no}` : ''}
          </div>
        </td>

        {tableColumns.includes('epic') && (
          <td className="px-3 py-3 text-sm text-ink-secondary font-mono text-xs">{v?.epic_no ?? '-'}</td>
        )}

        {tableColumns.includes('status') && (
          <td className="px-3 py-3">
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClasses(jr.job.status)}`}>
              {jr.job.status}
            </span>
          </td>
        )}

        {tableColumns.includes('department') && (
          <td className="px-3 py-3">
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${departmentBadgeClasses(jr.job.department_name || '-')}`}>
              {hasActiveSearch ? highlightMatch(jr.job.department_name || '-', searchTokens) : (jr.job.department_name || '-')}
            </span>
          </td>
        )}

        {tableColumns.includes('note') && (
          <td className="px-3 py-3 text-sm text-ink-secondary max-w-xs truncate" title={jr.job.note}>
            {hasActiveSearch ? highlightMatch(jr.job.note || '-', searchTokens) : (jr.job.note || '-')}
          </td>
        )}

        {tableColumns.includes('section') && (
          <td className="px-3 py-3 text-sm text-ink-secondary">{v?.section != null ? v.section : '-'}</td>
        )}

        {tableColumns.includes('relativeName') && (
          <td className="px-3 py-3 text-sm text-ink-secondary">{v?.relative_name ?? '-'}</td>
        )}

        {tableColumns.includes('relation') && (
          <td className="px-3 py-3 text-sm text-ink-secondary">{v?.relative_relation ?? '-'}</td>
        )}

        {tableColumns.includes('houseNo') && (
          <td className="px-3 py-3 text-sm text-ink-secondary">{v?.house_no ?? '-'}</td>
        )}

        {tableColumns.includes('age') && (
          <td className="px-3 py-3 text-sm text-ink-secondary text-center">{v?.age != null ? v.age : '-'}</td>
        )}

        {tableColumns.includes('gender') && (
          <td className="px-3 py-3 text-sm text-ink-secondary">{v?.gender ?? '-'}</td>
        )}

        {tableColumns.includes('ward') && (
          <td className="px-3 py-3 text-sm text-ink-secondary">{v?.ward_no != null ? `Ward ${v.ward_no}` : '-'}</td>
        )}

        {tableColumns.includes('part') && (
          <td className="px-3 py-3 text-sm text-ink-secondary">{v?.part_no != null ? `Part ${v.part_no}` : '-'}</td>
        )}

        {tableColumns.includes('contact1') && (
          <td className="px-3 py-3 text-sm text-ink-secondary">
            {v?.contact_no_1 ? (
              <a href={`tel:${v.contact_no_1}`} className="text-indigo-600 hover:text-indigo-800 hover:underline inline-flex items-center gap-1">
                <Phone className="h-3 w-3" />
                {v.contact_no_1}
              </a>
            ) : '-'}
          </td>
        )}

        {tableColumns.includes('contact2') && (
          <td className="px-3 py-3 text-sm text-ink-secondary">
            {v?.contact_no_2 ? (
              <a href={`tel:${v.contact_no_2}`} className="text-indigo-600 hover:text-indigo-800 hover:underline inline-flex items-center gap-1">
                <Phone className="h-3 w-3" />
                {v.contact_no_2}
              </a>
            ) : '-'}
          </td>
        )}

        {tableColumns.includes('actions') && (
          <td className="px-3 py-3 text-right text-sm font-medium">
            <div className="flex items-center justify-end gap-1">
              <button
                onClick={() => openEditModal(jr)}
                className="text-indigo-600 hover:text-indigo-900 mr-2"
              >
                Edit
              </button>
              <MoreMenu>
                {(close) => (
                  <button
                    onClick={() => { close(); setDeleteTarget(jr) }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-rose-600 transition hover:bg-rose-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                )}
              </MoreMenu>
            </div>
          </td>
        )}
      </tr>
    )
  }

  const columnLabel = (key: TableColumnKey): string => {
    const opt = TABLE_COLUMN_OPTIONS.find((o) => o.key === key)
    return opt?.label ?? key
  }

  const resetAllFilters = () => {
    setStatusFilter('')
    setWardFilter('')
    setPartFilter('')
    setSectionFilter('')
    setDepartmentFilter('')
    setSearchQuery('')
  }

  const hasAnyFilter = statusFilter || partFilter || wardFilter || sectionFilter || departmentFilter || hasActiveSearch

  return (
    <div className="space-y-4 pb-6">
      <PageHeader
        title="Job Records"
        description="Manage voter job applications, appointments, and status tracking"
        action={
          <div className="flex items-center gap-2">
            {selectedJobIds.size > 0 && (
              <div className="relative">
                <button
                  onClick={() => setBulkStatusOpen(!bulkStatusOpen)}
                  className="inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100"
                >
                  <Layers className="h-4 w-4" />
                  {selectedJobIds.size} selected
                  {bulkStatusOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
                {bulkStatusOpen && (
                  <div className="absolute right-0 z-30 mt-1 w-52 rounded-xl border border-line bg-white p-2 shadow-lg">
                    <p className="px-2 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Change Status To</p>
                    {JOB_STATUS_OPTIONS.filter((o) => o.value).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={saving}
                        onClick={() => void handleBulkStatusUpdate(opt.value as JobStatus)}
                        className="block w-full rounded-lg px-2 py-1.5 text-left text-sm text-ink-secondary hover:bg-muted disabled:opacity-50"
                      >
                        {opt.label}
                      </button>
                    ))}
                    <div className="mt-1 border-t border-line pt-1">
                      <button
                        type="button"
                        onClick={() => { setSelectedJobIds(new Set()); setBulkStatusOpen(false) }}
                        className="block w-full rounded-lg px-2 py-1.5 text-left text-xs text-ink-tertiary hover:text-ink-secondary"
                      >
                        Clear selection
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => setTableColumns([...DEFAULT_TABLE_COLUMNS])}
              className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-muted"
              title="Reset Column Visibility"
            >
              <RefreshCw className="h-4 w-4" />
              Reset View
            </button>
            <button
              onClick={() => {
                setReportScope('filtered')
                setShowPrintConfig(true)
              }}
              className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-muted"
            >
              <Printer className="h-4 w-4" />
              Print
            </button>
            <button
              onClick={() => {
                setReportScope('filtered')
                setShowExportConfig(true)
              }}
              className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-muted"
            >
              Export to Excel
            </button>
            <button
              onClick={() => setShowJobImport(true)}
              className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-muted"
            >
              <FileSpreadsheet className="h-4 w-4" />
              Import Job Records
            </button>
            <button
              onClick={openAddModal}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-500"
            >
              <Plus className="h-4 w-4" />
              Add Job Record
            </button>
          </div>
        }
      />

      {/* Filters Bar */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-white p-4 shadow-sm md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
            <input
              type="text"
              placeholder="Search by name, EPIC, dept, note, mobile..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-md border border-line pl-10 pr-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            {hasActiveSearch && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-tertiary hover:text-ink-secondary"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <Filter className="h-4 w-4 text-ink-tertiary" />
            <span className="text-sm font-medium text-ink-secondary">Filters:</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border border-line bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {JOB_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          <select
            value={wardFilter}
            onChange={(e) => setWardFilter(e.target.value)}
            className="rounded-md border border-line bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="">All Wards</option>
            {uniqueWards.map((w) => (
              <option key={w} value={w}>Ward {w}</option>
            ))}
          </select>

          <select
            value={partFilter}
            onChange={(e) => setPartFilter(e.target.value)}
            className="rounded-md border border-line bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="">All Parts</option>
            {uniqueParts.map((p) => (
              <option key={p} value={p}>Part {p}</option>
            ))}
          </select>

          <select
            value={sectionFilter}
            onChange={(e) => setSectionFilter(e.target.value)}
            disabled={!partFilter}
            className="rounded-md border border-line bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-muted disabled:text-ink-tertiary"
            title={!partFilter ? 'Select a Part first to filter by Section' : 'Filter by Section'}
          >
            <option value="">{!partFilter ? 'Sections (pick a part)' : 'All Sections'}</option>
            {sectionOptions.map((s) => (
              <option key={s} value={s}>Section {s}</option>
            ))}
          </select>

          <select
            value={departmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
            className="rounded-md border border-line bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="">All Departments</option>
            {uniqueDepartments.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>

          <button
            onClick={resetAllFilters}
            className="ml-2 text-xs font-medium text-indigo-600 hover:text-indigo-800 underline"
          >
            Clear All
          </button>
        </div>
      </div>

      {/* Dashboard stats */}
      {!loading && jobRows.length > 0 && (
        <section className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard title="Total Job Records" value={String(jobStats.total)} icon={<Briefcase className="h-5 w-5 text-indigo-500" />} />
            <StatCard title="Applied" value={String(jobStats.applied)} icon={<FileSpreadsheet className="h-5 w-5 text-blue-500" />} />
            <StatCard title="Appointed" value={String(jobStats.appointed)} icon={<BadgeCheck className="h-5 w-5 text-emerald-500" />} />
            <StatCard title="Pending" value={String(jobStats.pending)} icon={<Clock className="h-5 w-5 text-amber-500" />} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Status:</span>
            {JOB_STATUS_OPTIONS.filter((o) => o.value).map((opt) => {
              const count = jobStats.statusCounts[opt.value] ?? 0
              const active = statusFilter === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setStatusFilter(active ? '' : opt.value)}
                  title="Toggle status filter"
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                    active
                      ? 'border-indigo-500 bg-indigo-600 text-white'
                      : 'border-line bg-white text-ink-secondary hover:border-indigo-300 hover:text-indigo-700'
                  }`}
                >
                  {opt.label}
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${active ? 'bg-white/20' : 'bg-muted text-ink-tertiary'}`}>{count}</span>
                </button>
              )
            })}
          </div>

          {jobStats.topDepartments.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Departments:</span>
              {jobStats.topDepartments.map(([dept, count]) => {
                const active = departmentFilter === dept
                return (
                  <button
                    key={dept}
                    type="button"
                    onClick={() => setDepartmentFilter(active ? '' : dept)}
                    title="Toggle department filter"
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                      active
                        ? 'border-indigo-500 bg-indigo-600 text-white'
                        : 'border-line bg-white text-ink-secondary hover:border-indigo-300 hover:text-indigo-700'
                    }`}
                  >
                    {dept}
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${active ? 'bg-white/20' : 'bg-muted text-ink-tertiary'}`}>{count}</span>
                  </button>
                )
              })}
            </div>
          )}
        </section>
      )}

      {/* View Mode Toggle */}
      <div className="flex items-center gap-3">
        <div className="relative">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm font-medium text-ink-secondary transition hover:bg-muted"
            onClick={() => setTableColumnsOpen((c) => !c)}
          >
            <Cog className="h-4 w-4" />
            Columns
          </button>
          {tableColumnsOpen && (
            <div className="absolute left-0 z-30 mt-2 w-72 rounded-xl border border-line bg-white p-3 shadow-lg">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                Table Columns (Photo, Name & Checkbox are locked)
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
                <button type="button" className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
                  onClick={() => { setTableColumns([...DEFAULT_TABLE_COLUMNS]); setTableColumnsOpen(false) }}>
                  Reset to default
                </button>
                <button type="button" className="ml-auto text-xs font-semibold text-ink-tertiary hover:text-ink-secondary"
                  onClick={() => setTableColumnsOpen(false)}>
                  Done
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="inline-flex rounded-lg border border-line bg-white p-0.5">
          <button
            type="button"
            onClick={() => setViewMode('flat')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${viewMode === 'flat' ? 'bg-indigo-600 text-white shadow-sm' : 'text-ink-secondary hover:text-ink'}`}
          >
            <Layers className="h-3.5 w-3.5" />
            Flat List
          </button>
          <button
            type="button"
            onClick={() => setViewMode('family')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${viewMode === 'family' ? 'bg-indigo-600 text-white shadow-sm' : 'text-ink-secondary hover:text-ink'}`}
          >
            <Users className="h-3.5 w-3.5" />
            Family View
          </button>
        </div>

        {hasAnyFilter && (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
            Filters active
          </span>
        )}
        {viewMode === 'family' && (
          <span className="text-xs text-ink-tertiary">{familyGroups.length} families matching</span>
        )}
      </div>

      {/* Results: Flat Table View */}
      {viewMode === 'flat' && (
        <div className="overflow-hidden rounded-lg border border-line bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-line">
              <thead className="bg-muted">
                <tr>
                  <th scope="col" className="px-2 py-3">
                    <button type="button" onClick={toggleAllJobs} className="text-ink-tertiary hover:text-indigo-500">
                      {isAllSelected ? <CheckSquare className="h-4 w-4 text-indigo-500" /> : <Square className="h-4 w-4" />}
                    </button>
                  </th>
                  <th scope="col" className="px-2 py-3">
                    <span className="sr-only">Photo</span>
                  </th>
                  <th scope="col" className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
                    Voter Details
                  </th>
                  {tableColumns.map((key) => (
                    <th key={key} scope="col" className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
                      {columnLabel(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line bg-white">
                {loading ? (
                  <tr>
                    <td colSpan={3 + tableColumns.length} className="px-3 py-8 text-center text-sm text-ink-tertiary">
                      Loading job records...
                    </td>
                  </tr>
                ) : filteredJobs.length === 0 ? (
                  <tr>
                    <td colSpan={3 + tableColumns.length} className="px-3 py-8 text-center text-sm text-ink-tertiary">
                      No job records found matching your filters.
                    </td>
                  </tr>
                ) : (
                  filteredJobs.map((jr, i) => renderJobRow(jr, i))
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line bg-muted px-3 py-2">
            <p className="text-xs text-ink-tertiary">
              Showing {filteredJobs.length} of {jobRows.length} records
            </p>
          </div>
        </div>
      )}

      {/* Results: Family-Grouped View */}
      {viewMode === 'family' && (
        <div className="space-y-4">
          {loading ? (
            <p className="text-sm text-ink-tertiary">Loading job records...</p>
          ) : familyGroups.length === 0 ? (
            <p className="text-sm text-ink-tertiary">No family groups match your filters.</p>
          ) : (
            familyGroups.map((group) => (
              <section
                key={group.groupKey}
                className="overflow-hidden rounded-xl border border-line bg-white shadow-sm"
              >
                <div className="border-b bg-muted/70 px-4 py-3">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                      <span className="text-sm font-bold">{group.headName.charAt(0)}</span>
                    </div>
                    <div className="min-w-[200px] flex-1">
                      <p className="text-sm font-semibold text-ink">{group.headName}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-tertiary">
                        <span>EPIC: {group.headEpic}</span>
                        {group.houseNo !== '-' && <span>House: {group.houseNo}</span>}
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-ink-secondary">
                          {group.memberCount} member{group.memberCount !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </div>
                    <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
                      {group.jobs.length} job{group.jobs.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-line">
                    <tbody className="divide-y divide-line bg-white">
                      {group.jobs.map((jr, i) => renderJobRow(jr, i))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))
          )}
          <div className="flex items-center justify-between rounded-lg border border-line bg-muted px-3 py-2">
            <p className="text-xs text-ink-tertiary">
              {familyGroups.length} families • {filteredJobs.length} of {jobRows.length} records
            </p>
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 p-4 pt-[6vh] overflow-y-auto">
          <div className={`w-full rounded-xl bg-white p-6 shadow-2xl transition-all ${!selectedVoter ? 'max-w-4xl' : 'max-w-lg'}`}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-ink">
                {editingJob ? 'Edit Job Record' : 'Add New Job Record'}
              </h3>
              <button
                type="button"
                className="text-ink-tertiary hover:text-ink-secondary"
                onClick={closeModal}
              >
                ✕
              </button>
            </div>

            {!selectedVoter && (
              <div className="space-y-3">
                <p className="text-sm text-ink-secondary">
                  Search and select a voter to associate a job record - results are grouped family-wise, just like the Families and Meetings pages.
                </p>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
                  <input
                    type="text"
                    autoFocus
                    placeholder="Search by name, EPIC, relative name, house, ward, part, section, contact..."
                    value={voterSearchQuery}
                    onChange={(e) => {
                      setVoterSearchQuery(e.target.value)
                      if (e.target.value.trim()) setVoterBrowsePart('')
                    }}
                    className="h-12 w-full rounded-xl border border-line pl-10 pr-3 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <div className="h-px flex-1 bg-slate-200" />
                  <span className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">or</span>
                  <div className="h-px flex-1 bg-slate-200" />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink-secondary">Browse all families in a part:</span>
                  <select
                    value={voterBrowsePart}
                    onChange={(e) => {
                      setVoterBrowsePart(e.target.value)
                      setVoterBrowseVisibleCount(30)
                      if (e.target.value) setVoterSearchQuery('')
                    }}
                    className="h-9 rounded-xl border border-line bg-white px-3 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  >
                    <option value="">Select a part…</option>
                    {voterPickerPartOptions.map((part) => (
                      <option key={part} value={String(part)}>
                        Part {part}
                      </option>
                    ))}
                  </select>
                  {voterBrowsePart ? (
                    <button
                      type="button"
                      onClick={() => setVoterBrowsePart('')}
                      className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>

                {voterSearchTokens.length === 0 && !isBrowseMode ? (
                  <p className="py-6 text-center text-sm text-ink-tertiary">
                    Start typing a name, EPIC, or house number to search voters, or pick a part above to browse every family in it - grouped family-wise either way.
                  </p>
                ) : !activeFamiliesTotalCount ? (
                  <p className="py-6 text-center text-sm text-ink-tertiary">
                    {isBrowseMode ? `No families found in Part ${voterBrowsePart}.` : 'No voters found.'}
                  </p>
                ) : (
                  <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
                    <p className="text-xs text-ink-tertiary">
                      {activeFamiliesTotalCount} matching famil{activeFamiliesTotalCount === 1 ? 'y' : 'ies'}
                      {voterSearchTokens.length > 0 && allMatchingVoterFamilies.length > SEARCH_FAMILY_LIMIT
                        ? ` \u00b7 showing first ${SEARCH_FAMILY_LIMIT} - refine your search for more`
                        : ''}
                      {isBrowseMode && familiesForBrowsePart.length > voterBrowseVisibleCount
                        ? ` \u00b7 showing first ${voterBrowseVisibleCount}`
                        : ''}
                    </p>
                    {activeFamiliesForPicker.map((family) => (
                      <div key={family.key} className="overflow-hidden rounded-xl border border-line bg-white shadow-sm">
                        <div className="flex flex-wrap items-start gap-3 border-b border-line bg-muted/70 px-4 py-3">
                          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-white">
                            {family.headVoter?.photo_url && photoUrlByPath[family.headVoter.photo_url] ? (
                              <img src={photoUrlByPath[family.headVoter.photo_url]} alt={family.headVoter.name} className="h-full w-full object-cover" />
                            ) : (
                              <span className="text-xs font-bold text-indigo-600">{initials(family.headVoter?.name ?? 'NA')}</span>
                            )}
                          </div>
                          <div className="min-w-[200px] flex-1">
                            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700">Family Head</span>
                            <p className="mt-1 text-sm font-semibold text-ink">{family.headVoter?.name ?? 'Unknown'}</p>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-tertiary">
                              <span>EPIC: {family.head}</span>
                              <span>Ward: {family.headVoter?.ward_no ?? '-'}</span>
                              <span>Part: {family.headVoter?.part_no ?? '-'}</span>
                              <span>Section: {family.headVoter?.section ?? '-'}</span>
                              <span className="rounded-full bg-slate-200 px-2 py-0.5 font-medium text-ink-secondary">
                                {family.members.length} member{family.members.length !== 1 ? 's' : ''}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="divide-y divide-line">
                          {family.members.map((member) => {
                            const isMatch = voterSearchTokens.length > 0 && memberMatchesSearch(member, voterSearchTokens)
                            return (
                              <button
                                key={member.id}
                                type="button"
                                onClick={() => setSelectedVoter(member)}
                                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-indigo-50/60 ${isMatch ? 'bg-amber-50/70' : ''}`}
                              >
                                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-muted">
                                  {member.photo_url && photoUrlByPath[member.photo_url] ? (
                                    <img src={photoUrlByPath[member.photo_url]} alt={member.name} className="h-full w-full object-cover" />
                                  ) : (
                                    <span className="text-[10px] font-semibold text-indigo-600">{initials(member.name)}</span>
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-medium text-ink">{member.name}</p>
                                  <p className="truncate text-xs text-ink-tertiary">
                                    EPIC: {member.epic_no}
                                    {member.relative_name ? ` \u00b7 ${member.relative_relation ? `${member.relative_relation}. ` : ''}${member.relative_name}` : ''}
                                    {member.house_no ? ` \u00b7 House ${member.house_no}` : ''}
                                  </p>
                                </div>
                                <span className="flex-shrink-0 text-xs font-semibold text-indigo-600">Select →</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                    {isBrowseMode && familiesForBrowsePart.length > voterBrowseVisibleCount ? (
                      <button
                        type="button"
                        onClick={() => setVoterBrowseVisibleCount((count) => count + 30)}
                        className="w-full rounded-xl border border-dashed border-line py-2 text-sm font-semibold text-indigo-600 hover:bg-indigo-50/60"
                      >
                        Load 30 more families
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            )}

            {selectedVoter && (
              <>
                <div className="rounded-md bg-muted p-3 text-sm mb-4">
                  <p><strong>Voter:</strong> {selectedVoter.name}</p>
                  <p><strong>EPIC:</strong> {selectedVoter.epic_no}</p>
                  <p><strong>Ward/Part:</strong> {selectedVoter.ward_no ?? '-'} / {selectedVoter.part_no ?? '-'}</p>
                  {!editingJob && (
                    <button
                      type="button"
                      onClick={() => setSelectedVoter(null)}
                      className="mt-1 text-xs text-indigo-600 hover:text-indigo-800"
                    >
                      Change voter
                    </button>
                  )}
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-ink-secondary">Department Name *</label>
                    <input
                      type="text"
                      value={formState.department_name}
                      onChange={(e) => setFormState({ ...formState, department_name: e.target.value })}
                      className="mt-1 block w-full rounded-md border border-line px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      placeholder="e.g. Police, Health, Education"
                      list="department-suggestions"
                    />
                    <datalist id="department-suggestions">
                      {uniqueDepartments.map((d) => <option key={d} value={d} />)}
                    </datalist>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-ink-secondary">Status</label>
                    <select
                      value={formState.status}
                      onChange={(e) => setFormState({ ...formState, status: e.target.value as JobStatus })}
                      className="mt-1 block w-full rounded-md border border-line px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    >
                      {JOB_STATUS_OPTIONS.filter((o) => o.value).map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-ink-secondary">Notes</label>
                    <textarea
                      value={formState.note}
                      onChange={(e) => setFormState({ ...formState, note: e.target.value })}
                      rows={3}
                      className="mt-1 block w-full rounded-md border border-line px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      placeholder="Additional details about the application or appointment..."
                    />
                  </div>
                </div>

                <div className="mt-6 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="h-11 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={saving || !selectedVoter || !formState.department_name.trim()}
                    onClick={() => void handleSaveJob()}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
                  >
                    {saving && <RefreshCw className="h-4 w-4 animate-spin" />}
                    {editingJob ? 'Update Record' : 'Create Record'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showJobImport ? (
        <JobRecordsExcelImportModal
          wardRestriction={hasWardRestriction ? allowedWards : undefined}
          profileId={profile?.id}
          defaultStatus="pending"
          onCommit={async (rows, status) => {
            if (!rows.length) return null
            for (let index = 0; index < rows.length; index += 500) {
              const chunk = rows.slice(index, index + 500)
              const { error } = await supabase.from('job_records').insert(
                chunk.map((row) => ({
                  voter_id: row.voter_id,
                  department_name: row.department_name,
                  status,
                  note: null,
                })),
              )
              if (error) return error.message
            }
            return null
          }}
          onImported={loadData}
          onClose={() => setShowJobImport(false)}
        />
      ) : null}

      <DeleteJobModal
        row={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return
          await handleDeleteJob(deleteTarget.id)
          setDeleteTarget(null)
        }}
      />

      {/* Print / Export Config Modal */}
      {(showPrintConfig || showExportConfig) && (
        <ReportConfigModal
          title="Job Records"
          open
          mode={showPrintConfig ? 'print' : 'export'}
          fieldDefs={REPORT_FIELD_OPTIONS}
          fields={reportFieldOrder.map((key) => ({ key, enabled: reportFields[key] ?? false }))}
          defaultFields={DEFAULT_REPORT_FIELD_ORDER.map((key) => ({ key, enabled: INITIAL_REPORT_FIELDS[key] ?? false }))}
          fontSize={reportFontSize}
          boldText={reportBold}
          exportBorders={reportBorders}
          exportRowHeight={reportRowHeight}
          exportColWidth={reportColWidth}
          extraControls={
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Scope</label>
                <select
                  className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                  value={reportScope}
                  onChange={(e) => setReportScope(e.target.value as 'filtered' | 'all')}
                >
                  <option value="filtered">Current filtered view ({filteredJobs.length} records)</option>
                  <option value="all">All records ({jobRows.length} records)</option>
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
                  <option value="status">Group by Status</option>
                  <option value="ward">Group by Ward</option>
                  <option value="department">Group by Department</option>
                  <option value="family">Group by Family</option>
                  <option value="section">Group by Section</option>
                </select>
              </div>
            </div>
          }
          onClose={() => { setShowPrintConfig(false); setShowExportConfig(false) }}
          onConfirm={(fields: ReportFieldItem[], _layout: boolean, style: PrintStyleOptions) => {
            const order = fields.map((f) => f.key as ReportFieldKey)
            const map: Record<string, boolean> = {}
            for (const f of fields) map[f.key] = f.enabled
            setReportFieldOrder(order)
            setReportFieldsState(map)
            if (showPrintConfig) {
              setReportFontSize(style.fontSize)
              setReportBold(style.boldText)
              handlePrint(style)
            } else {
              setReportBorders(style.exportBorders)
              setReportRowHeight(style.exportRowHeight)
              setReportColWidth(style.exportColWidth)
              handleExportExcel(style)
            }
          }}
        />
      )}

      <VoterDetailDrawer
        voter={detailDrawerVoter}
        onClose={() => setDetailDrawerVoter(null)}
        onSaved={async () => {
          await loadData()
          if (detailDrawerVoter?.id) {
            const { data } = await supabase.from('voters').select('*').eq('id', detailDrawerVoter.id).maybeSingle()
            setDetailDrawerVoter((data as Voter | null) ?? null)
          }
        }}
      />
    </div>
  )
}

function uniqueNumberList(values: Array<number | null | undefined>): number[] {
  return Array.from(new Set(values.filter((value): value is number => value != null))).sort((a, b) => a - b)
}
