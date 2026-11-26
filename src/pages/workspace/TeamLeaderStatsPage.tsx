import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ArrowLeft, ArrowLeftRight, Download, Eye, Loader2, Printer, RefreshCcw, UserPlus, X } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { StatCard } from '../../components/common/StatCard'
import { ReportConfigModal } from '../../components/common/ReportConfigModal'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import type { Voter } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { exportRowsToExcel, openPrintWindow, buildPrintHtml, downloadPdfTable, type ReportFieldDef, type PrintStyleOptions } from '../../lib/reportBuilder'
import { useAuth } from '../../hooks/useAuth'
import { usePersistentState } from '../../hooks/usePersistentState'
import { fetchVotersForScope } from '../../hooks/useMeetingData'
import { buildWardScope, FAST_NAV_CACHE_MAX_AGE_MS, readCachedVoters } from '../../lib/voterCache'
import { withNormalizedVoterCategories } from '../../lib/voterCategory'
import { buildFamilies, initials, type FamilyGroup } from '../../lib/searchUtils'
import {
  assignFamilyToLeader,
  clearTeamLeaderDetailCache,
  clearTeamLeadersListCache,
  dedupeSpecialLeaders,
  fetchAllAssignmentLinks,
  fetchTeamLeadersFromApi,
  isOfficeLeader,
  isShiftedLeader,
  isRentedLeader,
  isSpecialLeader,
  consolidateSpecialLeaders,
  readUnassignedData,
  resolveTeamLeaderName,
  specialLeaderIdSet,
  COUNT_SHIFTED_AS_ASSIGNED_KEY,
  countingSpecialLeaderIdSet,
  fetchUnassignedCountingLeaderIds,
  transferFamilyToLeader,
  UNASSIGNED_DATA_TTL_MS,
  writeUnassignedData,
  type UnassignedLeaderOption,
} from '../../lib/teamLeaderCache'

const VOTERS_CACHE_KEY = 'vote:teamleaders:unassigned:voters-cache'
const PRINT_FONT_SIZE_KEY = 'vote:teamleaders:stats:printFontSize:v2'
const PRINT_BOLD_KEY = 'vote:teamleaders:stats:printBold'

interface StatsRow {
  key: string
  label: string
  part: number | null
  voters: number
  families: number
  assignedFamilies: number
  assignedFamiliesVoters: number
  assignedSingles: number
  assignedSinglesVoters: number
  unassignedFamilies: number
  unassignedFamiliesVoters: number
  unassignedSingles: number
  unassignedSinglesVoters: number
}

function emptyCounts() {
  return {
    voters: 0,
    families: 0,
    assignedFamilies: 0,
    assignedFamiliesVoters: 0,
    assignedSingles: 0,
    assignedSinglesVoters: 0,
    unassignedFamilies: 0,
    unassignedFamiliesVoters: 0,
    unassignedSingles: 0,
    unassignedSinglesVoters: 0,
  }
}

type Counts = ReturnType<typeof emptyCounts>
type FamilyKind = 'assigned' | 'unassigned' | 'parked'
type StatColumnKey = keyof Omit<StatsRow, 'key' | 'part'>
type StatColumn = { key: StatColumnKey; label: string; align?: 'left' | 'right' }
type DrillSection = 'field' | 'office' | 'shifted' | 'overall'
type AssignmentFilter = 'all' | 'assigned' | 'unassigned'
type SizeFilter = 'all' | 'families' | 'singles'

interface Drilldown {
  section: DrillSection
  partKey: string
  part: number | null
  assignment: AssignmentFilter
  size: SizeFilter
  column: StatColumnKey
}

interface TaggedFamily {
  family: FamilyGroup
  part: number | null
  partKey: string
  section: DrillSection
  assignment: FamilyKind
}

function familyHeadSortName(family: FamilyGroup): string {
  return family.headVoter?.name?.trim() ?? family.head
}

function surnameOf(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean)
  if (tokens.length <= 1) return name.trim()
  return tokens[tokens.length - 1]
}

function sortFamiliesBySurname(families: FamilyGroup[]): FamilyGroup[] {
  return [...families].sort((a, b) => {
    const aName = familyHeadSortName(a)
    const bName = familyHeadSortName(b)
    const bySurname = surnameOf(aName).localeCompare(surnameOf(bName), undefined, { sensitivity: 'base' })
    if (bySurname !== 0) return bySurname
    const byName = aName.localeCompare(bName, undefined, { sensitivity: 'base' })
    if (byName !== 0) return byName
    return a.head.localeCompare(b.head)
  })
}

function drillFromColumn(section: DrillSection, column: StatColumnKey): { assignment: AssignmentFilter; size: SizeFilter } {
  if (column === 'assignedFamilies') return { assignment: 'assigned', size: 'families' }
  if (column === 'assignedSingles') return { assignment: 'assigned', size: 'singles' }
  if (column === 'unassignedFamilies') return { assignment: 'unassigned', size: 'families' }
  if (column === 'unassignedSingles') return { assignment: 'unassigned', size: 'singles' }
  if (section !== 'field' && section !== 'overall') return { assignment: 'assigned', size: 'all' }
  return { assignment: 'all', size: 'all' }
}

function drillHeading(drill: Drilldown): string {
  const part = partLabel(drill.part)
  const section = drill.section === 'overall' ? 'Overall · ' : drill.section === 'field' ? '' : drill.section === 'office' ? 'Shifted · ' : 'Single · '
  const assignment = drill.assignment === 'all' ? '' : drill.assignment === 'assigned' ? 'Assigned ' : 'Unassigned '
  const size = drill.size === 'all' ? 'Families' : drill.size === 'families' ? 'Families' : 'Singles'
  return `${section}${part} · ${assignment}${size}`.replace(/\s+/g, ' ').trim()
}

function partLabel(part: number | null): string {
  return part != null ? `Part ${part}` : 'Unassigned Part'
}

function rowsFromPartMap(map: Map<string, { part: number | null; counts: Counts }>): StatsRow[] {
  return Array.from(map.entries())
    .sort((a, b) => {
      if (a[1].part == null) return 1
      if (b[1].part == null) return -1
      return a[1].part - b[1].part
    })
    .map(([key, value]) => ({
      key,
      label: partLabel(value.part),
      part: value.part,
      ...value.counts,
    }))
}

function bumpPart(map: Map<string, { part: number | null; counts: Counts }>, part: number | null, family: FamilyGroup, kind: FamilyKind) {
  const key = part == null ? 'unassigned' : String(part)
  const acc = map.get(key) ?? { part, counts: emptyCounts() }
  addFamily(acc.counts, family, kind)
  map.set(key, acc)
}

function addFamily(acc: Counts, family: FamilyGroup, kind: FamilyKind) {
  const memberCount = family.members.length
  acc.families += 1
  acc.voters += memberCount
  const isSingle = memberCount === 1
  if (kind === 'parked') return
  if (kind === 'assigned') {
    if (isSingle) {
      acc.assignedSingles += 1
      acc.assignedSinglesVoters += memberCount
    } else {
      acc.assignedFamilies += 1
      acc.assignedFamiliesVoters += memberCount
    }
  } else if (isSingle) {
    acc.unassignedSingles += 1
    acc.unassignedSinglesVoters += memberCount
  } else {
    acc.unassignedFamilies += 1
    acc.unassignedFamiliesVoters += memberCount
  }
}

function sumRows(rows: StatsRow[], key: string, label: string): StatsRow {
  return rows.reduce(
    (acc, row) => ({
      key,
      label,
      part: null,
      voters: acc.voters + row.voters,
      families: acc.families + row.families,
      assignedFamilies: acc.assignedFamilies + row.assignedFamilies,
      assignedFamiliesVoters: acc.assignedFamiliesVoters + row.assignedFamiliesVoters,
      assignedSingles: acc.assignedSingles + row.assignedSingles,
      assignedSinglesVoters: acc.assignedSinglesVoters + row.assignedSinglesVoters,
      unassignedFamilies: acc.unassignedFamilies + row.unassignedFamilies,
      unassignedFamiliesVoters: acc.unassignedFamiliesVoters + row.unassignedFamiliesVoters,
      unassignedSingles: acc.unassignedSingles + row.unassignedSingles,
      unassignedSinglesVoters: acc.unassignedSinglesVoters + row.unassignedSinglesVoters,
    }),
    { key, label, part: null, ...emptyCounts() },
  )
}

const DUAL_COUNT_COLUMNS = new Set<StatColumnKey>([
  'assignedFamilies',
  'assignedSingles',
  'unassignedFamilies',
  'unassignedSingles',
])

function voterCountForColumn(row: StatsRow, key: StatColumnKey): number {
  if (key === 'assignedFamilies') return row.assignedFamiliesVoters
  if (key === 'assignedSingles') return row.assignedSinglesVoters
  if (key === 'unassignedFamilies') return row.unassignedFamiliesVoters
  if (key === 'unassignedSingles') return row.unassignedSinglesVoters
  if (key === 'families') return row.voters
  return row.voters
}

function familyTotalRow(total: StatsRow): StatsRow {
  return { ...total, key: `${total.key}-families`, label: 'Total · Families' }
}

function voterTotalRow(total: StatsRow): StatsRow {
  return {
    ...total,
    key: `${total.key}-voters`,
    label: 'Total · Voters',
    families: total.voters,
    assignedFamilies: total.assignedFamiliesVoters,
    assignedSingles: total.assignedSinglesVoters,
    unassignedFamilies: total.unassignedFamiliesVoters,
    unassignedSingles: total.unassignedSinglesVoters,
  }
}

function totalExportRows(total: StatsRow): StatsRow[] {
  return [familyTotalRow(total), voterTotalRow(total)]
}

const STAT_COLUMNS: StatColumn[] = [
  { key: 'label', label: 'Part', align: 'left' },
  { key: 'voters', label: 'Voters', align: 'right' },
  { key: 'families', label: 'Families', align: 'right' },
  { key: 'assignedFamilies', label: 'Assigned Families', align: 'right' },
  { key: 'assignedSingles', label: 'Assigned Singles', align: 'right' },
  { key: 'unassignedFamilies', label: 'Unassigned Families', align: 'right' },
  { key: 'unassignedSingles', label: 'Unassigned Singles', align: 'right' },
]

const PARKED_COLUMNS: StatColumn[] = [
  { key: 'label', label: 'Part', align: 'left' },
  { key: 'voters', label: 'Voters', align: 'right' },
  { key: 'families', label: 'Families', align: 'right' },
  { key: 'assignedFamilies', label: 'Assigned Families', align: 'right' },
  { key: 'assignedSingles', label: 'Assigned Singles', align: 'right' },
]

function fieldsFromColumns(columns: StatColumn[]): ReportFieldDef<StatsRow>[] {
  return columns.map((col) => ({
    key: col.key,
    label: col.label,
    getValue: (row) => (col.key === 'label' ? row.label : String(row[col.key])),
  }))
}

const EXPORT_FIELDS = fieldsFromColumns(STAT_COLUMNS)
const PARKED_EXPORT_FIELDS = fieldsFromColumns(PARKED_COLUMNS)

function formatCell(row: StatsRow, key: StatColumnKey): string {
  if (key === 'label') return row.label
  return Number(row[key]).toLocaleString()
}

function DualCount({ families, voters }: { families: number; voters: number }) {
  return (
    <span className="block text-right tabular-nums">
      <span className="block text-sm font-semibold">{families.toLocaleString()}</span>
      <span className="block text-[11px] font-medium opacity-80">{voters.toLocaleString()} voters</span>
    </span>
  )
}

function VoterAvatar({ voter, photoUrl, size = 'md' }: { voter: Voter; photoUrl?: string; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'h-12 w-12 text-xs' : 'h-14 w-14 text-sm'
  if (photoUrl) {
    return <img src={photoUrl} alt={voter.name} className={`${dim} flex-shrink-0 rounded-full border border-line object-cover`} />
  }
  return (
    <span className={`${dim} inline-flex flex-shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700`}>
      {initials(voter.name)}
    </span>
  )
}

function StatsTable({
  rows,
  total,
  emptyMessage,
  labelHeader,
  columns = STAT_COLUMNS,
  activeKey,
  onCellClick,
}: {
  rows: StatsRow[]
  total?: StatsRow
  emptyMessage: string
  labelHeader: string
  columns?: StatColumn[]
  activeKey?: string | null
  onCellClick?: (row: StatsRow, column: StatColumnKey) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0 text-sm">
        <thead className="bg-muted">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={`sticky top-0 z-10 border-b border-line bg-muted px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary ${
                  column.align === 'right' ? 'text-right' : 'text-left'
                }`}
              >
                {column.key === 'label' ? labelHeader : column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-6 py-10 text-center text-sm text-ink-tertiary">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const active = activeKey === row.key
              return (
                <tr key={row.key} className={`transition ${active ? 'bg-brand-50/70' : 'hover:bg-muted'}`}>
                  {columns.map((column) => {
                    const dual = DUAL_COUNT_COLUMNS.has(column.key)
                    const content = dual
                      ? <DualCount families={Number(row[column.key])} voters={voterCountForColumn(row, column.key)} />
                      : formatCell(row, column.key)
                    return (
                    <td
                      key={column.key}
                      className={`border-b border-line px-4 py-2.5 tabular-nums ${
                        column.align === 'right' ? 'text-right text-ink-secondary' : 'text-left font-semibold text-ink'
                      }`}
                    >
                      {onCellClick ? (
                        <button
                          type="button"
                          onClick={() => onCellClick(row, column.key)}
                          className={`rounded-md px-1.5 py-0.5 transition hover:bg-brand-100 hover:text-brand-800 ${
                            active ? 'text-brand-800' : ''
                          }`}
                        >
                          {content}
                        </button>
                      ) : (
                        content
                      )}
                    </td>
                    )
                  })}
                </tr>
              )
            })
          )}
        </tbody>
        {total && rows.length > 0 ? (
          <tfoot>
            <tr className="bg-muted">
              {columns.map((column) => (
                <td
                  key={`families-${column.key}`}
                  className={`border-t border-line px-4 py-2.5 text-sm font-bold tabular-nums text-ink ${
                    column.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  {column.key === 'label' ? 'Total · Families' : Number(total[column.key]).toLocaleString()}
                </td>
              ))}
            </tr>
            <tr className="bg-muted">
              {columns.map((column) => (
                <td
                  key={`voters-${column.key}`}
                  className={`border-t border-line px-4 py-2.5 text-sm font-bold tabular-nums text-ink ${
                    column.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  {column.key === 'label'
                    ? 'Total · Voters'
                    : column.key === 'voters'
                      ? total.voters.toLocaleString()
                      : voterCountForColumn(total, column.key).toLocaleString()}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  )
}

export function TeamLeaderStatsPage() {
  const { profile, loading: authLoading } = useAuth()

  const allowedWards = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((w) => Number.isFinite(w))))
    wards.sort((a, b) => a - b)
    return wards
  }, [profile?.allowed_wards])
  const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0
  const wardScope = useMemo(() => buildWardScope(profile?.role, profile?.allowed_wards), [profile?.role, profile?.allowed_wards])

  const initialDerived = useMemo(() => readUnassignedData(wardScope), [wardScope])
  const initialVoters = useMemo(() => {
    if (typeof window === 'undefined') return []
    return withNormalizedVoterCategories(readCachedVoters(VOTERS_CACHE_KEY, `${wardScope}|part:all`, FAST_NAV_CACHE_MAX_AGE_MS) ?? [])
  }, [wardScope])

  const [voters, setVoters] = useState<Voter[]>(initialVoters)
  const [assignedIds, setAssignedIds] = useState<Set<string>>(() => new Set(initialDerived?.assignedVoterIds ?? []))
  const [voterToLeaderId, setVoterToLeaderId] = useState<Record<string, string>>(() => initialDerived?.voterToLeaderId ?? {})
  const [leaders, setLeaders] = useState<UnassignedLeaderOption[]>(() => initialDerived?.leaders ?? [])
  const [loading, setLoading] = useState(initialDerived == null || initialVoters.length === 0)
  const [refreshing, setRefreshing] = useState(false)
  const [printModalOpen, setPrintModalOpen] = useState(false)
  const [printFontSize, setPrintFontSize] = usePersistentState<number>(PRINT_FONT_SIZE_KEY, 20)
  const [printBold, setPrintBold] = usePersistentState<boolean>(PRINT_BOLD_KEY, false)
  const [countShiftedAsAssigned] = usePersistentState<boolean>(COUNT_SHIFTED_AS_ASSIGNED_KEY, false)
  const [unassignedCountingLeaderIds, setUnassignedCountingLeaderIds] = useState<string[]>([])
  const [drill, setDrill] = useState<Drilldown | null>(null)
  const [sizeOverride, setSizeOverride] = useState<SizeFilter | null>(null)
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>({})
  const [cardLeaderByKey, setCardLeaderByKey] = useState<Record<string, string>>({})
  const [assigning, setAssigning] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    const forceRefresh = opts?.forceRefresh ?? false
    const cached = readUnassignedData(wardScope)
    if (!cached) setLoading(true)
    else if (forceRefresh) setRefreshing(true)
    try {
      const consolidation = await consolidateSpecialLeaders()
      if (consolidation.changed) {
        clearTeamLeadersListCache()
        clearTeamLeaderDetailCache()
      }
      const voterRows = await fetchVotersForScope({
        cacheKey: VOTERS_CACHE_KEY,
        wardScope,
        hasWardRestriction,
        allowedWards,
        maxAgeMs: forceRefresh ? 0 : undefined,
      })
      setVoters(voterRows)

      const countingIdsPromise = fetchUnassignedCountingLeaderIds().catch(() => [] as string[])
      if (!forceRefresh && !consolidation.changed && cached && Date.now() - cached.savedAt < UNASSIGNED_DATA_TTL_MS) {
        setAssignedIds(new Set(cached.assignedVoterIds))
        setVoterToLeaderId(cached.voterToLeaderId)
        setLeaders(cached.leaders)
        setUnassignedCountingLeaderIds(await countingIdsPromise)
        return
      }

      const [assignedRes, apiRows, countingIds] = await Promise.all([
        fetchAllAssignmentLinks(),
        fetchTeamLeadersFromApi(),
        countingIdsPromise,
      ])
      setUnassignedCountingLeaderIds(countingIds)
      if (assignedRes.error) throw new Error(assignedRes.error)

      const assignedRows = assignedRes.data.map((r) => r.voter_id).filter(Boolean)
      setAssignedIds(new Set(assignedRows))

      const voterToLeader: Record<string, string> = {}
      for (const link of assignedRes.data) {
        if (link.voter_id && link.team_leader_id) voterToLeader[link.voter_id] = link.team_leader_id
      }
      setVoterToLeaderId(voterToLeader)

      const nextLeaders: UnassignedLeaderOption[] = apiRows.map((tl) => {
        const name = resolveTeamLeaderName(tl, tl.voter_name ? { name: tl.voter_name } : null, '')
        return { id: tl.id, name, epicNo: tl.epic_no ?? '', part_no: tl.part_no, section: tl.section, notes: tl.notes, voter_id: tl.voter_id }
      }).sort((a, b) => a.name.localeCompare(b.name))
      setLeaders(nextLeaders)
      writeUnassignedData(wardScope, assignedRows, voterToLeader, nextLeaders)
    } catch (error) {
      console.error('Failed to load team leader stats', error)
      toast.error(`Could not load team leader stats: ${(error as Error).message}`)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [wardScope, hasWardRestriction, allowedWards])

  useEffect(() => {
    if (authLoading) return
    void load()
  }, [load, authLoading])

  const allFamilies = useMemo(() => buildFamilies(voters), [voters])
  const specialLeaderIds = useMemo(() => specialLeaderIdSet(leaders), [leaders])
  const countingSpecialIds = useMemo(
    () => countingSpecialLeaderIdSet(leaders, countShiftedAsAssigned, unassignedCountingLeaderIds),
    [leaders, countShiftedAsAssigned, unassignedCountingLeaderIds],
  )
  const extraUnassignedLeaderIds = useMemo(() => new Set(unassignedCountingLeaderIds), [unassignedCountingLeaderIds])
  const officeLeaderIds = useMemo(() => new Set(leaders.filter((l) => isOfficeLeader(l)).map((l) => l.id)), [leaders])
  const shiftedLeaderIds = useMemo(() => new Set(leaders.filter((l) => isShiftedLeader(l)).map((l) => l.id)), [leaders])

  const realAssignedIds = useMemo(() => {
    const set = new Set<string>()
    for (const voterId of assignedIds) {
      const leaderId = voterToLeaderId[voterId]
      if (leaderId && !specialLeaderIds.has(leaderId)) set.add(voterId)
    }
    return set
  }, [assignedIds, voterToLeaderId, specialLeaderIds])

  const classified = useMemo(() => {
    const partMap = new Map<string, { part: number | null; counts: Counts }>()
    const overallMap = new Map<string, { part: number | null; counts: Counts }>()
    const officeMap = new Map<string, { part: number | null; counts: Counts }>()
    const shiftedMap = new Map<string, { part: number | null; counts: Counts }>()
    const tagged: TaggedFamily[] = []

    for (const family of allFamilies) {
      const hasReal = family.members.some((m) => realAssignedIds.has(m.id))
      const hasAnyAssignment = family.members.some((m) => assignedIds.has(m.id))
      const part = family.headVoter?.part_no ?? null
      const partKey = part == null ? 'unassigned' : String(part)

      const countedAssigned = family.members.some((m) => {
        const leaderId = voterToLeaderId[m.id]
        return leaderId && !countingSpecialIds.has(leaderId)
      })
      const overallKind: FamilyKind = countedAssigned ? 'assigned' : 'unassigned'

      if (hasReal) {
        bumpPart(overallMap, part, family, overallKind)
        bumpPart(partMap, part, family, overallKind)
        tagged.push({ family, part, partKey, section: 'field', assignment: overallKind })
        continue
      }

      if (!hasAnyAssignment) {
        bumpPart(overallMap, part, family, 'unassigned')
        bumpPart(partMap, part, family, 'unassigned')
        tagged.push({ family, part, partKey, section: 'field', assignment: 'unassigned' })
        continue
      }

      const extraCount = family.members.filter((m) => extraUnassignedLeaderIds.has(voterToLeaderId[m.id] ?? '')).length
      const officeCount = family.members.filter((m) => officeLeaderIds.has(voterToLeaderId[m.id] ?? '')).length
      const shiftedCount = family.members.filter((m) => shiftedLeaderIds.has(voterToLeaderId[m.id] ?? '')).length
      if (extraCount >= officeCount && extraCount >= shiftedCount) {
        bumpPart(overallMap, part, family, 'unassigned')
        bumpPart(partMap, part, family, 'unassigned')
        tagged.push({ family, part, partKey, section: 'field', assignment: 'unassigned' })
        continue
      }
      const parkedSection: DrillSection = officeCount >= shiftedCount ? 'office' : 'shifted'
      const parkedMap = parkedSection === 'office' ? officeMap : shiftedMap
      bumpPart(overallMap, part, family, 'parked')
      bumpPart(parkedMap, part, family, 'assigned')
      tagged.push({ family, part, partKey, section: parkedSection, assignment: 'parked' })
    }

    return {
      overallRows: rowsFromPartMap(overallMap),
      partRows: rowsFromPartMap(partMap),
      officeRows: rowsFromPartMap(officeMap),
      shiftedRows: rowsFromPartMap(shiftedMap),
      tagged,
    }
  }, [allFamilies, assignedIds, realAssignedIds, extraUnassignedLeaderIds, officeLeaderIds, shiftedLeaderIds, voterToLeaderId, countingSpecialIds])

  const overallTotal = useMemo(() => sumRows(classified.overallRows, 'overall-total', 'Total'), [classified.overallRows])
  const partTotal = useMemo(() => sumRows(classified.partRows, 'total', 'Total'), [classified.partRows])
  const officeTotal = useMemo(() => sumRows(classified.officeRows, 'office-total', 'Total'), [classified.officeRows])
  const shiftedTotal = useMemo(() => sumRows(classified.shiftedRows, 'shifted-total', 'Total'), [classified.shiftedRows])

  const appendSectionHtml = (baseHtml: string, extraHtml: string): string => {
    const bodyStart = extraHtml.indexOf('<body>')
    const bodyEnd = extraHtml.indexOf('</body>')
    const extraBody = bodyStart >= 0 && bodyEnd > bodyStart ? extraHtml.slice(bodyStart + 6, bodyEnd) : extraHtml
    return baseHtml.replace('</body>', `${extraBody}</body>`)
  }

  const executePrint = (style: PrintStyleOptions) => {
    const overallHtml = buildPrintHtml({
      rows: [...classified.overallRows, ...totalExportRows(overallTotal)],
      fields: EXPORT_FIELDS,
      title: 'Team Leader Stats - Overall',
      meta: 'All families including Shifted and Single, by part. Shifted and Single are parked only (not assigned, not unassigned). Totals are families then voters.',
    }, style)
    const partHtml = buildPrintHtml({
      rows: [...classified.partRows, ...totalExportRows(partTotal)],
      fields: EXPORT_FIELDS,
      title: 'Team Leader Stats - Parts',
      meta: 'Shifted and Single families are excluded from this table. Totals are families then voters.',
    }, style)
    const officeHtml = buildPrintHtml({
      rows: [...classified.officeRows, ...totalExportRows(officeTotal)],
      fields: PARKED_EXPORT_FIELDS,
      title: 'Shifted',
      meta: 'Families parked under Shifted, by part. Totals are families then voters.',
    }, style)
    const shiftedHtml = buildPrintHtml({
      rows: [...classified.shiftedRows, ...totalExportRows(shiftedTotal)],
      fields: PARKED_EXPORT_FIELDS,
      title: 'Single',
      meta: 'Families parked under Single, by part. Totals are families then voters.',
    }, style)
    openPrintWindow(appendSectionHtml(appendSectionHtml(appendSectionHtml(overallHtml, partHtml), officeHtml), shiftedHtml))
  }

  const printTableRows = (rows: StatsRow[], columns: StatColumn[]): string[][] =>
    rows.map((row) => columns.map((col) => formatCell(row, col.key)))

  const handlePrintConfirm = (_fields: unknown, _layout: boolean, style: PrintStyleOptions) => {
    setPrintFontSize(style.fontSize)
    setPrintBold(style.boldText)
    setPrintModalOpen(false)
    executePrint(style)
  }

  const handlePdfDownload = (_fields: unknown, _layout: boolean, style: PrintStyleOptions) => {
    setPrintFontSize(style.fontSize)
    setPrintBold(style.boldText)
    setPrintModalOpen(false)
    const blank = STAT_COLUMNS.map(() => '')
    void downloadPdfTable({
      title: 'Team Leader Stats',
      summary: [
        ['Parts', String(classified.partRows.length)],
        ['Generated', new Date().toLocaleString()],
      ],
      headers: STAT_COLUMNS.map((col) => col.label),
      rows: [
        ['Overall', '', '', '', '', '', ''],
        ...printTableRows(classified.overallRows, STAT_COLUMNS),
        ...printTableRows(totalExportRows(overallTotal), STAT_COLUMNS),
        blank,
        ['Parts (excludes Shifted / Single)', '', '', '', '', '', ''],
        ...printTableRows(classified.partRows, STAT_COLUMNS),
        ...printTableRows(totalExportRows(partTotal), STAT_COLUMNS),
        blank,
        ['Shifted', '', '', '', '', '', ''],
        ...printTableRows(classified.officeRows, STAT_COLUMNS),
        ...printTableRows(totalExportRows(officeTotal), STAT_COLUMNS),
        blank,
        ['Single', '', '', '', '', '', ''],
        ...printTableRows(classified.shiftedRows, STAT_COLUMNS),
        ...printTableRows(totalExportRows(shiftedTotal), STAT_COLUMNS),
      ],
      fontSize: style.fontSize,
      boldText: style.boldText,
      fileName: `team-leader-stats-${new Date().toISOString().slice(0, 10)}.pdf`,
    })
  }

  const openDrill = (section: DrillSection, row: StatsRow, column: StatColumnKey) => {
    const next = { section, partKey: row.key, part: row.part, column, ...drillFromColumn(section, column) }
    setDrill(next)
    setSizeOverride(null)
    setCardLeaderByKey({})
    requestAnimationFrame(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const clearDrill = () => {
    setDrill(null)
    setSizeOverride(null)
    setCardLeaderByKey({})
  }

  const effectiveSize: SizeFilter = sizeOverride ?? drill?.size ?? 'all'

  const drillFamilies = useMemo(() => {
    if (!drill) return []
    const matched = classified.tagged.filter((item) => {
      if (drill.section !== 'overall' && item.section !== drill.section) {
        return false
      }
      if (item.partKey !== drill.partKey) return false
      const itemAssignment = item.assignment === 'parked' && drill.section !== 'overall' ? 'assigned' : item.assignment
      if (drill.assignment !== 'all' && itemAssignment !== drill.assignment) return false
      if (effectiveSize === 'singles' && item.family.members.length !== 1) return false
      if (effectiveSize === 'families' && item.family.members.length < 2) return false
      return true
    })
    return sortFamiliesBySurname(matched.map((item) => item.family))
  }, [classified.tagged, drill, effectiveSize])

  const drillVoterCount = useMemo(
    () => drillFamilies.reduce((sum, family) => sum + family.members.length, 0),
    [drillFamilies],
  )

  const leaderById = useMemo(() => new Map(leaders.map((l) => [l.id, l])), [leaders])
  const assignableLeaders = useMemo(() => dedupeSpecialLeaders(leaders).filter((l) => !isSpecialLeader(l) && !isRentedLeader(l)), [leaders])

  const familyLeaderId = useCallback((family: FamilyGroup): string | null => {
    for (const member of family.members) {
      const lid = voterToLeaderId[member.id]
      if (lid) return lid
    }
    return null
  }, [voterToLeaderId])

  const visiblePhotoPaths = useMemo(() => {
    const set = new Set<string>()
    for (const family of drillFamilies) {
      for (const member of family.members) if (member.photo_url) set.add(member.photo_url)
    }
    return Array.from(set)
  }, [drillFamilies])

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
        for (let j = 0; j < batch.length; j++) {
          const url = data[j]?.signedUrl
          if (url) next[batch[j]] = url
        }
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

  const assignFamilies = async (familiesToAssign: FamilyGroup[], leaderId: string) => {
    if (!familiesToAssign.length || !leaderId) return
    setAssigning(true)
    try {
      const seenIds = new Set<string>()
      const voterIds: string[] = []
      const isDirectVoterIds = new Set<string>()
      for (const family of familiesToAssign) {
        const direct = family.headVoter ?? family.members[0]
        for (const member of family.members) {
          if (seenIds.has(member.id)) continue
          seenIds.add(member.id)
          voterIds.push(member.id)
          if (direct && member.id === direct.id) isDirectVoterIds.add(member.id)
        }
      }
      const result = await assignFamilyToLeader({
        voterIds,
        toLeaderId: leaderId,
        assignedBy: profile?.id ?? null,
        isDirectVoterIds,
        specialLeaderIds,
      })
      const assignedLeader = leaderById.get(leaderId)?.name ?? 'selected leader'
      toast.success(`Assigned ${result.voterIds.length} voter${result.voterIds.length === 1 ? '' : 's'} to ${assignedLeader}.`)
      setAssignedIds((prev) => {
        const next = new Set(prev)
        for (const id of result.voterIds) next.add(id)
        return next
      })
      setVoterToLeaderId((prev) => {
        const next = { ...prev }
        for (const id of result.voterIds) next[id] = leaderId
        return next
      })
      setCardLeaderByKey((prev) => {
        const next = { ...prev }
        for (const family of familiesToAssign) delete next[family.key]
        return next
      })
      const existing = readUnassignedData(wardScope)
      if (existing) writeUnassignedData(wardScope, Array.from(new Set([...existing.assignedVoterIds, ...result.voterIds])), { ...existing.voterToLeaderId, ...Object.fromEntries(result.voterIds.map((id) => [id, leaderId])) }, existing.leaders)
      clearTeamLeadersListCache()
      clearTeamLeaderDetailCache()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setAssigning(false)
    }
  }

  const reassignFamily = async (family: FamilyGroup, newLeaderId: string) => {
    const currentLeaderId = familyLeaderId(family)
    if (!currentLeaderId || currentLeaderId === newLeaderId) return
    const memberIds = family.members.filter((m) => voterToLeaderId[m.id]).map((m) => m.id)
    if (!memberIds.length) return
    setAssigning(true)
    try {
      await transferFamilyToLeader({
        voterIds: memberIds,
        toLeaderId: newLeaderId,
        assignedBy: profile?.id ?? null,
      })
      const assignedLeader = leaderById.get(newLeaderId)?.name ?? 'selected leader'
      toast.success(`Moved family of ${family.headVoter?.name ?? family.head} to ${assignedLeader}.`)
      setVoterToLeaderId((prev) => {
        const next = { ...prev }
        for (const id of memberIds) next[id] = newLeaderId
        return next
      })
      setCardLeaderByKey((prev) => {
        const next = { ...prev }
        delete next[family.key]
        return next
      })
      const existing = readUnassignedData(wardScope)
      if (existing) {
        const nextVoterToLeader = { ...existing.voterToLeaderId }
        for (const id of memberIds) nextVoterToLeader[id] = newLeaderId
        writeUnassignedData(wardScope, existing.assignedVoterIds, nextVoterToLeader, existing.leaders)
      }
      clearTeamLeadersListCache()
      clearTeamLeaderDetailCache()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setAssigning(false)
    }
  }

  const handleExport = () => {
    exportRowsToExcel({
      rows: [
        { key: 'overall-header', label: 'Overall', part: null, ...emptyCounts() },
        ...classified.overallRows,
        ...totalExportRows(overallTotal),
        { key: 'blank-0', label: '', part: null, ...emptyCounts() },
        { key: 'parts-header', label: 'Parts (excludes Shifted / Single)', part: null, ...emptyCounts() },
        ...classified.partRows,
        ...totalExportRows(partTotal),
        { key: 'blank-1', label: '', part: null, ...emptyCounts() },
        { key: 'office-header', label: 'Shifted', part: null, ...emptyCounts() },
        ...classified.officeRows,
        ...totalExportRows(officeTotal),
        { key: 'blank-2', label: '', part: null, ...emptyCounts() },
        { key: 'shifted-header', label: 'Single', part: null, ...emptyCounts() },
        ...classified.shiftedRows,
        ...totalExportRows(shiftedTotal),
      ],
      fields: EXPORT_FIELDS,
      fileName: `team-leader-stats-${new Date().toISOString().slice(0, 10)}`,
      title: 'Team Leader Stats',
      meta: 'Overall totals (including Shifted and Single), then field parts, Shifted, and Single by part',
    })
  }

  return (
    <div className="space-y-5 pb-10">
      <Link to="/team-leaders" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-tertiary transition hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> Back to Team Leaders
      </Link>

      <PageHeader
        title="Team Leader Stats"
        description="Unique families. Shifted and Single are parked only: not assigned and not unassigned. Admin-marked custom leaders count as unassigned."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void load({ forceRefresh: true })}
              disabled={loading || refreshing}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />} Refresh
            </button>
            <button
              type="button"
              onClick={() => setPrintModalOpen(true)}
              disabled={loading}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Printer className="h-3.5 w-3.5" /> Print
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={loading}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" /> Export
            </button>
          </div>
        }
      />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard
          title="Voters"
          value={loading ? '...' : (partTotal.voters + officeTotal.voters + shiftedTotal.voters).toLocaleString()}
          featured
        />
        <StatCard
          title="Families"
          value={loading ? '...' : (partTotal.families + officeTotal.families + shiftedTotal.families).toLocaleString()}
          meta="Assigned + unassigned + parked"
        />
        <StatCard
          title="Assigned"
          value={loading ? '...' : (partTotal.assignedFamilies + partTotal.assignedSingles).toLocaleString()}
          meta={`${partTotal.assignedFamilies.toLocaleString()} families · ${partTotal.assignedSingles.toLocaleString()} singles`}
        />
        <StatCard
          title="Unassigned"
          value={loading ? '...' : (partTotal.unassignedFamilies + partTotal.unassignedSingles).toLocaleString()}
          meta={`${partTotal.unassignedFamilies.toLocaleString()} families · ${partTotal.unassignedSingles.toLocaleString()} singles`}
        />
        <StatCard
          title="Parked"
          value={loading ? '...' : (officeTotal.families + shiftedTotal.families).toLocaleString()}
          meta={`${officeTotal.families.toLocaleString()} shifted · ${shiftedTotal.families.toLocaleString()} single`}
        />
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold text-ink">Overall</h2>
          <p className="text-xs text-ink-tertiary">All families including Shifted and Single. Shifted and Single add to Voters and Families only, not Assigned or Unassigned. Admin-marked custom leaders count as unassigned. Count cells show families on top and voters below. Footer is Total · Families then Total · Voters. Click a cell to list those families.</p>
        </div>
        {loading ? (
          <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading stats...
          </div>
        ) : (
          <StatsTable
            rows={classified.overallRows}
            total={overallTotal}
            emptyMessage="No voter data found."
            labelHeader="Part"
            activeKey={drill?.section === 'overall' ? drill.partKey : null}
            onCellClick={(row, column) => openDrill('overall', row, column)}
          />
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold text-ink">Part-wise Stats</h2>
          <p className="text-xs text-ink-tertiary">Excludes families parked under Shifted or Single. Families = assigned + unassigned groups (including singles).</p>
        </div>
        {loading ? (
          <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading stats...
          </div>
        ) : (
          <StatsTable
            rows={classified.partRows}
            total={partTotal}
            emptyMessage="No part data found."
            labelHeader="Part"
            activeKey={drill?.section === 'field' ? drill.partKey : null}
            onCellClick={(row, column) => openDrill('field', row, column)}
          />
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold text-ink">Shifted</h2>
          <p className="text-xs text-ink-tertiary">Families parked under Shifted, broken down by part.</p>
        </div>
        {loading ? (
          <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading stats...
          </div>
        ) : (
          <StatsTable
            rows={classified.officeRows}
            total={officeTotal}
            emptyMessage="No Shifted families."
            labelHeader="Part"
            columns={PARKED_COLUMNS}
            activeKey={drill?.section === 'office' ? drill.partKey : null}
            onCellClick={(row, column) => openDrill('office', row, column)}
          />
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold text-ink">Single</h2>
          <p className="text-xs text-ink-tertiary">Families parked under Single, broken down by part.</p>
        </div>
        {loading ? (
          <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading stats...
          </div>
        ) : (
          <StatsTable
            rows={classified.shiftedRows}
            total={shiftedTotal}
            emptyMessage="No Single families."
            labelHeader="Part"
            columns={PARKED_COLUMNS}
            activeKey={drill?.section === 'shifted' ? drill.partKey : null}
            onCellClick={(row, column) => openDrill('shifted', row, column)}
          />
        )}
      </section>

      {drill && (
        <section ref={listRef} className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <h2 className="text-base font-semibold text-ink">{drillHeading(drill)}</h2>
              <p className="text-xs text-ink-tertiary">
                {drillFamilies.length} famil{drillFamilies.length === 1 ? 'y' : 'ies'} · {drillVoterCount} voter{drillVoterCount === 1 ? '' : 's'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-xl border border-line bg-muted p-0.5">
                {(['all', 'families', 'singles'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setSizeOverride(mode)}
                    className={`h-8 rounded-lg px-3 text-xs font-semibold transition ${
                      effectiveSize === mode ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-tertiary hover:text-ink'
                    }`}
                  >
                    {mode === 'all' ? 'All' : mode === 'families' ? 'Families' : 'Singles'}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={clearDrill}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-tertiary transition hover:bg-muted"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </button>
            </div>
          </div>

          {drillFamilies.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-ink-tertiary">No families match this selection.</div>
          ) : (
            <div className="space-y-4 p-5">
              {drillFamilies.map((family) => {
                const head = family.headVoter ?? family.members[0] ?? null
                const currentLeaderId = familyLeaderId(family)
                const currentLeader = currentLeaderId ? leaderById.get(currentLeaderId) : undefined
                const cardLeaderValue = cardLeaderByKey[family.key] ?? ''
                const canAssign = (drill.section === 'field' || drill.section === 'overall') && drill.assignment !== 'assigned'
                const canReassign = Boolean(currentLeaderId)
                return (
                  <section key={family.key} className="overflow-hidden rounded-xl border border-line bg-white">
                    <div className="flex flex-wrap items-center gap-3 border-b border-line bg-muted/70 px-4 py-4 sm:px-5">
                      {head && <VoterAvatar voter={head} photoUrl={resolvePhotoUrl(head)} />}
                      <div className="min-w-[200px] flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-700">Family Head</span>
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                            {family.members.length} member{family.members.length === 1 ? '' : 's'}
                          </span>
                          {currentLeader && (
                            <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                              {currentLeader.name}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-base font-semibold text-ink">{head?.name ?? 'Unknown head'}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-tertiary">
                          <span>EPIC: {head?.epic_no || '-'}</span>
                          <span>Part: {head?.part_no ?? '-'}</span>
                          <span>Sec: {head?.section ?? '-'}</span>
                        </div>
                      </div>
                      {(canAssign || canReassign) && assignableLeaders.length > 0 && (
                        <div className="ml-auto flex flex-wrap items-center gap-2">
                          <select
                            className="h-8 w-44 rounded-lg border border-line bg-white px-2 text-[11px] font-semibold text-ink-secondary outline-none focus:border-brand-300"
                            aria-label={`Assign family of ${head?.name ?? family.head} to team leader`}
                            value={cardLeaderValue}
                            onChange={(e) => setCardLeaderByKey((prev) => ({ ...prev, [family.key]: e.target.value }))}
                          >
                            <option value="">{canReassign && !canAssign ? 'Reassign to...' : 'Assign to...'}</option>
                            {assignableLeaders.map((tl) => (
                              <option key={tl.id} value={tl.id}>
                                {tl.name}{tl.epicNo ? ` (${tl.epicNo})` : ''}{tl.part_no != null ? ` · Part ${tl.part_no}` : ''}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => {
                              const leaderId = cardLeaderByKey[family.key]
                              if (!leaderId) { toast.error('Select a team leader for this family first.'); return }
                              if (canReassign && currentLeaderId) void reassignFamily(family, leaderId)
                              else void assignFamilies([family], leaderId)
                            }}
                            disabled={assigning || !cardLeaderValue}
                            className="inline-flex h-8 items-center gap-1 rounded-lg bg-brand-600 px-2.5 text-[11px] font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {assigning ? <Loader2 className="h-3 w-3 animate-spin" /> : canReassign && !canAssign ? <ArrowLeftRight className="h-3 w-3" /> : <UserPlus className="h-3 w-3" />}
                            {canReassign && !canAssign ? 'Reassign' : 'Assign'}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full border-separate border-spacing-0 text-xs">
                        <thead className="bg-muted">
                          <tr>
                            <th className="w-10 border-b border-line px-3 py-2.5 text-center font-semibold text-ink-tertiary">#</th>
                            <th className="w-16 border-b border-line px-3 py-2.5 text-left font-semibold text-ink-tertiary">Photo</th>
                            <th className="min-w-[170px] border-b border-line px-3 py-2.5 text-left font-semibold text-ink-tertiary">Name</th>
                            <th className="w-28 border-b border-line px-3 py-2.5 text-left font-semibold text-ink-tertiary">EPIC</th>
                            <th className="w-24 border-b border-line px-3 py-2.5 text-left font-semibold text-ink-tertiary">Part / Sec</th>
                            <th className="min-w-[150px] border-b border-line px-3 py-2.5 text-left font-semibold text-ink-tertiary">Relative</th>
                            <th className="w-12 border-b border-line px-3 py-2.5 text-right font-semibold text-ink-tertiary"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {family.members.map((m, memberIndex) => {
                            const isHead = head != null && m.id === head.id
                            return (
                              <tr key={m.id} className={`transition hover:bg-muted ${isHead ? 'bg-brand-50/40' : ''}`}>
                                <td className="border-b border-line px-3 py-2.5 text-center text-ink-tertiary">{memberIndex + 1}</td>
                                <td className="border-b border-line px-3 py-2.5">
                                  {m.photo_url ? (
                                    <VoterAvatar voter={m} photoUrl={resolvePhotoUrl(m)} size="sm" />
                                  ) : (
                                    <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                                      {initials(m.name)}
                                    </span>
                                  )}
                                </td>
                                <td className="border-b border-line px-3 py-2.5">
                                  <div className="flex items-center gap-1.5">
                                    {isHead && (
                                      <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">Head</span>
                                    )}
                                    <span className="truncate font-medium text-ink">{m.name}</span>
                                  </div>
                                </td>
                                <td className="border-b border-line px-3 py-2.5 text-ink-tertiary">{m.epic_no || '-'}</td>
                                <td className="border-b border-line px-3 py-2.5 text-ink-tertiary">Part {m.part_no ?? '-'} / Sec {m.section ?? '-'}</td>
                                <td className="border-b border-line px-3 py-2.5 text-ink-tertiary">
                                  {m.relative_name ? `${m.relative_name}${m.relative_relation ? ` (${m.relative_relation})` : ''}` : '-'}
                                </td>
                                <td className="border-b border-line px-3 py-2.5">
                                  <div className="flex items-center justify-end">
                                    <button
                                      type="button"
                                      title="View voter"
                                      onClick={() => setSelectedVoter(m)}
                                      className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-line bg-white text-ink-tertiary transition hover:bg-muted"
                                    >
                                      <Eye className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
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
            </div>
          )}
        </section>
      )}

      <ReportConfigModal
        title="Team Leader Stats"
        open={printModalOpen}
        mode="print"
        fontSize={printFontSize}
        boldText={printBold}
        printDescription="Set font size and bold text, then print or download a PDF of the Overall, part-wise, and Shifted/Single tables."
        printActionLabel="Open print preview"
        onClose={() => setPrintModalOpen(false)}
        onConfirm={handlePrintConfirm}
        onDownloadPdf={handlePdfDownload}
      />

      <VoterDetailDrawer
        voter={selectedVoter}
        onClose={() => setSelectedVoter(null)}
        onSaved={async () => { await load({ forceRefresh: true }) }}
      />
    </div>
  )
}
