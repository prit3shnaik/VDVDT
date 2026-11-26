import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import * as XLSX from 'xlsx'
import { Download, Eye, Loader2, Printer, RefreshCcw, X } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { StatCard } from '../../components/common/StatCard'
import { ReportConfigModal, type ReportFieldItem } from '../../components/common/ReportConfigModal'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import type { Voter, VoterCategory } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { openPrintWindow, downloadPdfTable, type PrintStyleOptions } from '../../lib/reportBuilder'
import { useAuth } from '../../hooks/useAuth'
import { usePersistentState } from '../../hooks/usePersistentState'
import { fetchVotersForScope } from '../../hooks/useMeetingData'
import { buildWardScope, FAST_NAV_CACHE_MAX_AGE_MS, readCachedVoters } from '../../lib/voterCache'
import { buildFamilies, initials, type FamilyGroup } from '../../lib/searchUtils'
import { VOTER_CATEGORY_OPTIONS, normalizeVoterCategory, voterCategoryLabel, withNormalizedVoterCategories } from '../../lib/voterCategory'
import {
  assignFamilyToLeader,
  clearTeamLeaderDetailCache,
  clearTeamLeadersListCache,
  fetchAllAssignmentLinks,
  fetchTeamLeadersFromApi,
  isRentedLeader,
  isSpecialLeader,
  resolveTeamLeaderName,
  specialLeaderIdSet,
  transferFamilyToLeader,
  type UnassignedLeaderOption,
} from '../../lib/teamLeaderCache'
import { formatNumber } from '../../lib/utils'
import { forEachInChunk } from '../../lib/d1Query'

const VOTERS_CACHE_KEY = 'vote:category-status:voters-cache'
const PRINT_FIELDS_KEY = 'vote:category-status:printFields:v2'
const PRINT_FONT_SIZE_KEY = 'vote:category-status:printFontSize:v2'
const PRINT_BOLD_KEY = 'vote:category-status:printBold'

type CategoryPrintKey =
  | 'srNo'
  | 'photo'
  | 'name'
  | 'epicNo'
  | 'category'
  | 'relativeName'
  | 'relation'
  | 'houseNo'
  | 'partNo'
  | 'section'
  | 'age'
  | 'gender'
  | 'contact1'
  | 'familyMembers'

interface CategoryPrintFieldDef {
  key: CategoryPrintKey
  label: string
  description?: string
  isPhoto?: boolean
}

interface CategoryPrintFieldState {
  key: CategoryPrintKey
  enabled: boolean
}

const PRINT_FIELD_DEFS: CategoryPrintFieldDef[] = [
  { key: 'srNo', label: 'Sr No' },
  { key: 'photo', label: 'Photo', isPhoto: true },
  { key: 'name', label: 'Name' },
  { key: 'epicNo', label: 'EPIC' },
  { key: 'category', label: 'Category' },
  { key: 'relativeName', label: 'Relative Name' },
  { key: 'relation', label: 'Relation' },
  { key: 'houseNo', label: 'House No' },
  { key: 'partNo', label: 'Part No' },
  { key: 'section', label: 'Section' },
  { key: 'age', label: 'Age' },
  { key: 'gender', label: 'Gender' },
  { key: 'contact1', label: 'Contact' },
  { key: 'familyMembers', label: 'Family Members' },
]

const DEFAULT_PRINT_FIELDS: CategoryPrintFieldState[] = [
  { key: 'srNo', enabled: true },
  { key: 'photo', enabled: true },
  { key: 'name', enabled: true },
  { key: 'epicNo', enabled: false },
  { key: 'category', enabled: false },
  { key: 'relativeName', enabled: false },
  { key: 'relation', enabled: false },
  { key: 'houseNo', enabled: false },
  { key: 'partNo', enabled: false },
  { key: 'section', enabled: false },
  { key: 'age', enabled: false },
  { key: 'gender', enabled: false },
  { key: 'contact1', enabled: true },
  { key: 'familyMembers', enabled: false },
]

function getCategoryPrintValue(voter: Voter, key: CategoryPrintKey, family: FamilyGroup, sr: number): string {
  switch (key) {
    case 'srNo': return String(sr)
    case 'photo': return voter.photo_url ? 'Photo' : ''
    case 'name': return voter.name || '-'
    case 'epicNo': return voter.epic_no || '-'
    case 'category': return voterCategoryLabel(voter.voter_category) ?? 'Unassigned'
    case 'relativeName': return voter.relative_name || '-'
    case 'relation': return voter.relative_relation || '-'
    case 'houseNo': return voter.house_no || '-'
    case 'partNo': return voter.part_no != null ? String(voter.part_no) : '-'
    case 'section': return voter.section != null ? String(voter.section) : '-'
    case 'age': return voter.age != null ? String(voter.age) : '-'
    case 'gender': return voter.gender || '-'
    case 'contact1': return voter.contact_no_1 || '-'
    case 'familyMembers': return String(family.members.length)
    default: return '-'
  }
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

type ViewMode = 'part' | 'section'
type DrillKind = VoterCategory | 'UNASSIGNED'

interface CategoryCounts {
  families: number
  voters: number
}

interface StatsRow {
  key: string
  label: string
  part: number | null
  section: number | null
  totalFamilies: number
  totalVoters: number
  unassigned: CategoryCounts
  byCategory: Record<VoterCategory, CategoryCounts>
}

interface TaggedFamily {
  family: FamilyGroup
  part: number | null
  partKey: string
  section: number | null
  sectionKey: string
  category: VoterCategory | null
}

interface Drilldown {
  mode: ViewMode
  rowKey: string
  label: string
  kind: DrillKind
}

function emptyCategoryCounts(): CategoryCounts {
  return { families: 0, voters: 0 }
}

function emptyByCategory(): Record<VoterCategory, CategoryCounts> {
  return Object.fromEntries(
    VOTER_CATEGORY_OPTIONS.map((option) => [option.value, emptyCategoryCounts()]),
  ) as Record<VoterCategory, CategoryCounts>
}

function emptyStatsRow(key: string, label: string, part: number | null, section: number | null): StatsRow {
  return {
    key,
    label,
    part,
    section,
    totalFamilies: 0,
    totalVoters: 0,
    unassigned: emptyCategoryCounts(),
    byCategory: emptyByCategory(),
  }
}

function familyCategory(family: FamilyGroup): VoterCategory | null {
  return normalizeVoterCategory(family.headVoter?.voter_category)
}

function partKeyOf(part: number | null): string {
  return part == null ? 'unassigned' : String(part)
}

function sectionKeyOf(part: number | null, section: number | null): string {
  return `${partKeyOf(part)}::${section == null ? 'unassigned' : String(section)}`
}

function partLabel(part: number | null): string {
  return part != null ? `Part ${part}` : 'Unassigned Part'
}

function sectionLabel(part: number | null, section: number | null): string {
  const sectionText = section != null ? `Section ${section}` : 'Unassigned Section'
  return `${partLabel(part)} · ${sectionText}`
}

function bumpCounts(target: CategoryCounts, family: FamilyGroup) {
  target.families += 1
  target.voters += family.members.length
}

function addFamilyToRow(row: StatsRow, family: FamilyGroup, category: VoterCategory | null) {
  row.totalFamilies += 1
  row.totalVoters += family.members.length
  if (category && row.byCategory[category]) bumpCounts(row.byCategory[category], family)
  else bumpCounts(row.unassigned, family)
}

function sortPartRows(rows: StatsRow[]): StatsRow[] {
  return [...rows].sort((a, b) => {
    if (a.part == null) return 1
    if (b.part == null) return -1
    return a.part - b.part
  })
}

function sortSectionRows(rows: StatsRow[]): StatsRow[] {
  return [...rows].sort((a, b) => {
    if (a.part == null && b.part != null) return 1
    if (a.part != null && b.part == null) return -1
    if (a.part != null && b.part != null && a.part !== b.part) return a.part - b.part
    if (a.section == null) return 1
    if (b.section == null) return -1
    return a.section - b.section
  })
}

function sumRows(rows: StatsRow[], key: string, label: string): StatsRow {
  const total = emptyStatsRow(key, label, null, null)
  for (const row of rows) {
    total.totalFamilies += row.totalFamilies
    total.totalVoters += row.totalVoters
    total.unassigned.families += row.unassigned.families
    total.unassigned.voters += row.unassigned.voters
    for (const option of VOTER_CATEGORY_OPTIONS) {
      total.byCategory[option.value].families += row.byCategory[option.value].families
      total.byCategory[option.value].voters += row.byCategory[option.value].voters
    }
  }
  return total
}

function countsForKind(row: StatsRow, kind: DrillKind): CategoryCounts {
  if (kind === 'UNASSIGNED') return row.unassigned
  return row.byCategory[kind]
}

function kindLabel(kind: DrillKind): string {
  if (kind === 'UNASSIGNED') return 'Unassigned'
  return voterCategoryLabel(kind) ?? kind
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

function CountCell({
  counts,
  active,
  onClick,
  tone = 'default',
}: {
  counts: CategoryCounts
  active?: boolean
  onClick: () => void
  tone?: 'default' | 'warn'
}) {
  const empty = counts.families === 0 && counts.voters === 0
  const toneClass =
    tone === 'warn'
      ? empty
        ? 'text-ink-tertiary'
        : 'text-rose-700 hover:bg-rose-50'
      : empty
        ? 'text-ink-tertiary hover:bg-muted'
        : 'text-ink-secondary hover:bg-brand-50 hover:text-brand-800'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-md px-1.5 py-0.5 text-right tabular-nums transition ${toneClass} ${active ? 'bg-brand-100 text-brand-800' : ''}`}
    >
      <span className="block text-sm font-semibold">{formatNumber(counts.families)}</span>
      <span className="block text-[11px] font-medium opacity-80">{formatNumber(counts.voters)} voters</span>
    </button>
  )
}

export function CategoryStatusPage() {
  const { profile, loading: authLoading } = useAuth()

  const allowedWards = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((w) => Number.isFinite(w))))
    wards.sort((a, b) => a - b)
    return wards
  }, [profile?.allowed_wards])
  const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0
  const wardScope = useMemo(() => buildWardScope(profile?.role, profile?.allowed_wards), [profile?.role, profile?.allowed_wards])

  const initialVoters = useMemo(() => {
    if (typeof window === 'undefined') return []
    return withNormalizedVoterCategories(readCachedVoters(VOTERS_CACHE_KEY, `${wardScope}|part:all`, FAST_NAV_CACHE_MAX_AGE_MS) ?? [])
  }, [wardScope])

  const [voters, setVoters] = useState<Voter[]>(initialVoters)
  const [loading, setLoading] = useState(initialVoters.length === 0)
  const [refreshing, setRefreshing] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('part')
  const [drill, setDrill] = useState<Drilldown | null>(null)
  const [unassignedPart, setUnassignedPart] = useState('')
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>({})
  const [printModalOpen, setPrintModalOpen] = useState(false)
  const [printTarget, setPrintTarget] = useState<'drill' | 'unassigned'>('drill')
  const [printFields, setPrintFields] = usePersistentState<CategoryPrintFieldState[]>(PRINT_FIELDS_KEY, DEFAULT_PRINT_FIELDS.map((f) => ({ ...f })))
  const [printFontSize, setPrintFontSize] = usePersistentState<number>(PRINT_FONT_SIZE_KEY, 20)
  const [printBold, setPrintBold] = usePersistentState<boolean>(PRINT_BOLD_KEY, false)
  const [includeMembers, setIncludeMembers] = useState(true)
  const [savingCategoryKey, setSavingCategoryKey] = useState<string | null>(null)
  const [voterToLeaderId, setVoterToLeaderId] = useState<Record<string, string>>({})
  const [leaderOptions, setLeaderOptions] = useState<UnassignedLeaderOption[]>([])
  const [leaderSelectByKey, setLeaderSelectByKey] = useState<Record<string, string>>({})
  const [assigningLeaderKey, setAssigningLeaderKey] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const unassignedRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    const forceRefresh = opts?.forceRefresh ?? false
    if (forceRefresh) setRefreshing(true)
    try {
      const voterRows = await fetchVotersForScope({
        cacheKey: VOTERS_CACHE_KEY,
        wardScope,
        hasWardRestriction,
        allowedWards,
        maxAgeMs: forceRefresh ? 0 : undefined,
      })
      setVoters(voterRows)
    } catch (error) {
      console.error('Failed to load category status', error)
      toast.error(`Could not load category status: ${(error as Error).message}`)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [allowedWards, hasWardRestriction, wardScope])

  useEffect(() => {
    if (authLoading) return
    void load()
  }, [authLoading, load])

  useEffect(() => {
    if (authLoading) return
    let cancelled = false
    void (async () => {
      try {
        const [{ data, error }, rows] = await Promise.all([fetchAllAssignmentLinks(), fetchTeamLeadersFromApi()])
        if (cancelled) return
        if (error) {
          toast.error(error)
          return
        }
        const next: Record<string, string> = {}
        for (const link of data) {
          if (!link.voter_id || !link.team_leader_id) continue
          if (!(link.voter_id in next)) next[link.voter_id] = link.team_leader_id
        }
        setVoterToLeaderId(next)
        setLeaderOptions(
          rows
            .map((leader) => ({
              id: leader.id,
              name: resolveTeamLeaderName(leader, leader.voter_name ? { name: leader.voter_name } : null, ''),
              epicNo: leader.epic_no ?? '',
              part_no: leader.part_no,
              section: leader.section,
              notes: leader.notes ?? null,
              voter_id: leader.voter_id,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
      } catch (error) {
        console.error('Failed to load team leaders', error)
        if (!cancelled) toast.error('Could not load team leaders.')
      }
    })()
    return () => { cancelled = true }
  }, [authLoading])

  const specialLeaderIds = useMemo(() => specialLeaderIdSet(leaderOptions), [leaderOptions])
  const assignableLeaders = useMemo(
    () => leaderOptions.filter((leader) => !isSpecialLeader(leader) && !isRentedLeader(leader)),
    [leaderOptions],
  )
  const leaderById = useMemo(() => new Map(leaderOptions.map((leader) => [leader.id, leader])), [leaderOptions])

  const familyLeaderId = useCallback((family: FamilyGroup): string => {
    for (const member of family.members) {
      const leaderId = voterToLeaderId[member.id]
      if (leaderId) return leaderId
    }
    return ''
  }, [voterToLeaderId])

  const allFamilies = useMemo(() => buildFamilies(voters), [voters])

  const classified = useMemo(() => {
    const partMap = new Map<string, StatsRow>()
    const sectionMap = new Map<string, StatsRow>()
    const tagged: TaggedFamily[] = []

    for (const family of allFamilies) {
      const part = family.headVoter?.part_no ?? null
      const section = family.headVoter?.section ?? null
      const pKey = partKeyOf(part)
      const sKey = sectionKeyOf(part, section)
      const category = familyCategory(family)

      const partRow = partMap.get(pKey) ?? emptyStatsRow(pKey, partLabel(part), part, null)
      addFamilyToRow(partRow, family, category)
      partMap.set(pKey, partRow)

      const sectionRow = sectionMap.get(sKey) ?? emptyStatsRow(sKey, sectionLabel(part, section), part, section)
      addFamilyToRow(sectionRow, family, category)
      sectionMap.set(sKey, sectionRow)

      tagged.push({ family, part, partKey: pKey, section, sectionKey: sKey, category })
    }

    return {
      partRows: sortPartRows(Array.from(partMap.values())),
      sectionRows: sortSectionRows(Array.from(sectionMap.values())),
      tagged,
    }
  }, [allFamilies])

  const partTotal = useMemo(() => sumRows(classified.partRows, 'part-total', 'Total'), [classified.partRows])
  const sectionTotal = useMemo(() => sumRows(classified.sectionRows, 'section-total', 'Total'), [classified.sectionRows])
  const tableRows = viewMode === 'part' ? classified.partRows : classified.sectionRows
  const tableTotal = viewMode === 'part' ? partTotal : sectionTotal

  const partOptions = useMemo(
    () => classified.partRows.map((row) => ({ value: row.key, label: row.label, unassigned: row.unassigned })),
    [classified.partRows],
  )

  const openDrill = (row: StatsRow, kind: DrillKind) => {
    setDrill({
      mode: viewMode,
      rowKey: row.key,
      label: row.label,
      kind,
    })
    requestAnimationFrame(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const drillFamilies = useMemo(() => {
    if (!drill) return []
    const matched = classified.tagged.filter((item) => {
      const rowMatch = drill.mode === 'part' ? item.partKey === drill.rowKey : item.sectionKey === drill.rowKey
      if (!rowMatch) return false
      if (drill.kind === 'UNASSIGNED') return item.category == null
      return item.category === drill.kind
    })
    return sortFamiliesBySurname(matched.map((item) => item.family))
  }, [classified.tagged, drill])

  const drillVoterCount = useMemo(
    () => drillFamilies.reduce((sum, family) => sum + family.members.length, 0),
    [drillFamilies],
  )

  const unassignedFamilies = useMemo(() => {
    if (!unassignedPart) return []
    const matched = classified.tagged.filter((item) => item.partKey === unassignedPart && item.category == null)
    return sortFamiliesBySurname(matched.map((item) => item.family))
  }, [classified.tagged, unassignedPart])

  const unassignedVoterCount = useMemo(
    () => unassignedFamilies.reduce((sum, family) => sum + family.members.length, 0),
    [unassignedFamilies],
  )

  const handleUnassignedPartChange = (value: string) => {
    setUnassignedPart(value)
    if (value) {
      requestAnimationFrame(() => unassignedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }

  const photoFamilies = useMemo(() => {
    const seen = new Set<string>()
    const list: FamilyGroup[] = []
    for (const family of [...drillFamilies, ...unassignedFamilies]) {
      if (seen.has(family.key)) continue
      seen.add(family.key)
      list.push(family)
    }
    return list
  }, [drillFamilies, unassignedFamilies])

  const visiblePhotoPaths = useMemo(() => {
    const set = new Set<string>()
    for (const family of photoFamilies) {
      for (const member of family.members) if (member.photo_url) set.add(member.photo_url)
    }
    return Array.from(set)
  }, [photoFamilies])

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

  const assignCategoryToFamily = async (family: FamilyGroup, category: VoterCategory | null, applyToAll: boolean) => {
    const currentCategory = familyCategory(family)
    if (category && currentCategory && category !== currentCategory) {
      const count = family.members.length
      const confirmed = window.confirm(
        `Move ${count} member${count === 1 ? '' : 's'} from ${voterCategoryLabel(currentCategory)} to ${voterCategoryLabel(category)}?`,
      )
      if (!confirmed) return
    }
    const targets = applyToAll ? family.members : (family.headVoter ? [family.headVoter] : family.members.slice(0, 1))
    const memberIds = targets.map((member) => member.id)
    if (!memberIds.length) {
      toast.error('This family has no members.')
      return
    }
    setSavingCategoryKey(family.key)
    try {
      await forEachInChunk(memberIds, async (chunk) => {
        const { error } = await supabase.from('voters').update({ voter_category: category }).in('id', chunk)
        if (error) throw new Error(error.message)
      })
      const updatedIds = new Set(memberIds)
      setVoters((current) => current.map((row) => (updatedIds.has(row.id) ? { ...row, voter_category: category } : row)))
      toast.success(category ? `Assigned ${voterCategoryLabel(category)} to ${applyToAll ? 'family' : 'family head'}.` : 'Category cleared.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update category.')
    } finally {
      setSavingCategoryKey(null)
    }
  }

  const assignFamilyLeader = async (family: FamilyGroup, toLeaderId: string) => {
    if (!toLeaderId) return
    const currentLeaderId = familyLeaderId(family)
    const hasRealLeader = Boolean(currentLeaderId && !specialLeaderIds.has(currentLeaderId))
    setAssigningLeaderKey(family.key)
    try {
      const voterIds = family.members.map((member) => member.id)
      const directVoter = family.headVoter ?? family.members[0]
      const result = hasRealLeader
        ? await transferFamilyToLeader({ voterIds, toLeaderId, assignedBy: profile?.id ?? null })
        : await assignFamilyToLeader({
            voterIds,
            toLeaderId,
            assignedBy: profile?.id ?? null,
            isDirectVoterIds: new Set(directVoter ? [directVoter.id] : []),
            specialLeaderIds,
          })
      const changed = result.voterIds.length ? result.voterIds : voterIds
      setVoterToLeaderId((current) => {
        const next = { ...current }
        for (const id of changed) next[id] = toLeaderId
        return next
      })
      setLeaderSelectByKey((current) => ({ ...current, [family.key]: '' }))
      clearTeamLeadersListCache()
      clearTeamLeaderDetailCache()
      toast.success(`Family ${family.head} assigned to ${leaderById.get(toLeaderId)?.name ?? toLeaderId}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update team leader.')
    } finally {
      setAssigningLeaderKey(null)
    }
  }

  const printTitle = printTarget === 'unassigned'
    ? `Unassigned · ${partOptions.find((option) => option.value === unassignedPart)?.label ?? 'Part'}`
    : drill
      ? `${drill.label} · ${kindLabel(drill.kind)}`
      : 'Category Status'

  const executePrint = async (fields: CategoryPrintFieldState[], include: boolean, style: PrintStyleOptions) => {
    const familiesToPrint = printTarget === 'unassigned' ? unassignedFamilies : drillFamilies
    if (!familiesToPrint.length) {
      toast.error('No families to print.')
      return
    }

    const enabled = fields.filter((f) => f.enabled)
    const headerLabels = enabled.map((f) => PRINT_FIELD_DEFS.find((d) => d.key === f.key)!.label)
    const escapeHtml = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const fontSize = style.fontSize
    const bold = style.boldText
    const photoSize = Math.max(36, Math.round(56 * (fontSize / 11)))

    let urls = photoUrlByPath
    if (enabled.some((f) => PRINT_FIELD_DEFS.find((d) => d.key === f.key)?.isPhoto)) {
      const rowsToPrint = include
        ? familiesToPrint.flatMap((f) => f.members)
        : familiesToPrint.map((f) => f.headVoter ?? f.members[0] ?? null).filter((v): v is Voter => v != null)
      const missing = Array.from(new Set(rowsToPrint.map((v) => v.photo_url).filter((p): p is string => Boolean(p)))).filter((p) => !urls[p])
      if (missing.length) {
        const signed: Record<string, string> = {}
        for (let i = 0; i < missing.length; i += 80) {
          const batch = missing.slice(i, i + 80)
          const { data } = await supabase.storage.from('voter-photos').createSignedUrls(batch, 3600)
          if (!data) continue
          for (let j = 0; j < batch.length; j++) {
            const url = data[j]?.signedUrl
            if (url) signed[batch[j]] = url
          }
        }
        if (Object.keys(signed).length) {
          urls = { ...urls, ...signed }
          setPhotoUrlByPath(urls)
        }
      }
    }

    const renderRow = (voter: Voter, family: FamilyGroup, sr: number, isHead: boolean) => {
      const cells = enabled.map((f) => {
        if (f.key === 'photo') {
          const url = voter.photo_url ? urls[voter.photo_url] : undefined
          return `<td>${url ? `<img class="photo" src="${escapeHtml(url)}" onerror="this.style.display='none'" />` : ''}</td>`
        }
        if (f.key === 'name') {
          const name = escapeHtml(voter.name || '-')
          return `<td>${isHead ? `<b>${name}</b>` : name}</td>`
        }
        return `<td>${escapeHtml(getCategoryPrintValue(voter, f.key, family, sr))}</td>`
      }).join('')
      return `<tr class="${isHead ? 'head-row' : ''}">${cells}</tr>`
    }

    let bodyHtml = ''
    let sr = 1
    let totalVoters = 0
    for (const family of familiesToPrint) {
      const head = family.headVoter ?? family.members[0] ?? null
      const rows = include ? family.members : (head ? [head] : [])
      if (!rows.length) continue
      totalVoters += rows.length
      bodyHtml += '<div class="family">'
      bodyHtml += `<div class="family-hdr"><b>${escapeHtml(head?.name ?? 'Family')}</b>`
      bodyHtml += `<span>EPIC: ${escapeHtml(head?.epic_no ?? family.head)}</span>`
      bodyHtml += `<span>Part ${head?.part_no ?? '-'} / Sec ${head?.section ?? '-'}</span>`
      bodyHtml += `<span>${voterCategoryLabel(familyCategory(family)) ?? 'Unassigned'}</span>`
      bodyHtml += `<span>${family.members.length} member${family.members.length === 1 ? '' : 's'}</span>`
      bodyHtml += '</div>'
      bodyHtml += `<table><thead><tr>${headerLabels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>`
      for (const member of rows) {
        const isHead = head != null && member.id === head.id
        bodyHtml += renderRow(member, family, sr, isHead)
        sr += 1
      }
      bodyHtml += '</tbody></table></div>'
    }

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(printTitle)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #111; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { font-size: 12px; color: #555; margin-bottom: 16px; }
  .family { margin-bottom: 18px; }
  .family-hdr { display: flex; flex-wrap: wrap; gap: 4px 24px; font-size: 13px; color: #333; margin-bottom: 4px; }
  .family-hdr b { font-size: 14px; color: #111; }
  table { width: 100%; border-collapse: collapse; font-size: ${fontSize}px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: middle; }
  th { background: #f0f0f0; }
  ${bold ? 'th, td { font-weight: 700; }' : ''}
  .photo { width: ${photoSize}px; height: ${photoSize}px; object-fit: cover; border-radius: 50%; }
  .head-row { background: #f7f7f7; }
  @media print { tr { break-inside: avoid; } .family { break-inside: avoid; } }
</style>
</head>
<body>
  <h1>${escapeHtml(printTitle)}</h1>
  <div class="meta">${familiesToPrint.length} famil${familiesToPrint.length === 1 ? 'y' : 'ies'} &middot; ${totalVoters} voter${totalVoters === 1 ? '' : 's'} &middot; Printed: ${new Date().toLocaleString()}</div>
  ${bodyHtml}
</body>
</html>`

    openPrintWindow(html)
  }

  const handlePrintConfirm = (fields: ReportFieldItem[], include: boolean, style: PrintStyleOptions) => {
    const nextFields: CategoryPrintFieldState[] = fields.map((f) => ({ key: f.key as CategoryPrintKey, enabled: f.enabled }))
    setPrintFields(nextFields.map((f) => ({ ...f })))
    setIncludeMembers(include)
    setPrintFontSize(style.fontSize)
    setPrintBold(style.boldText)
    setPrintModalOpen(false)
    void executePrint(nextFields, include, style)
  }

  const handlePdfDownload = (fields: ReportFieldItem[], include: boolean, style: PrintStyleOptions) => {
    const nextFields: CategoryPrintFieldState[] = fields.map((f) => ({ key: f.key as CategoryPrintKey, enabled: f.enabled }))
    setPrintFields(nextFields.map((f) => ({ ...f })))
    setIncludeMembers(include)
    setPrintFontSize(style.fontSize)
    setPrintBold(style.boldText)
    setPrintModalOpen(false)
    const enabled = nextFields.filter((f) => f.enabled)
    const familiesToPrint = printTarget === 'unassigned' ? unassignedFamilies : drillFamilies
    const rows: string[][] = []
    let sr = 1
    for (const family of familiesToPrint) {
      const head = family.headVoter ?? family.members[0] ?? null
      const rowVoters = include ? family.members : (head ? [head] : [])
      for (const voter of rowVoters) {
        rows.push(enabled.map((f) => getCategoryPrintValue(voter, f.key, family, sr)))
        sr += 1
      }
    }
    void downloadPdfTable({
      title: printTitle,
      summary: [
        ['Families', String(familiesToPrint.length)],
        ['Generated', new Date().toLocaleString()],
      ],
      headers: enabled.map((f) => PRINT_FIELD_DEFS.find((d) => d.key === f.key)!.label),
      rows,
      fontSize: style.fontSize,
      boldText: style.boldText,
      fileName: `category-status-${new Date().toISOString().slice(0, 10)}.pdf`,
    })
  }

  const exportStatsTable = () => {
    if (!tableRows.length) {
      toast.error('No category stats to export.')
      return
    }
    const groupLabels = ['Total', 'Unassigned', ...VOTER_CATEGORY_OPTIONS.map((option) => option.label)]
    const topHeader: Array<string | number> = [viewMode === 'part' ? 'Part' : 'Section']
    const subHeader: Array<string | number> = ['']
    for (const label of groupLabels) {
      topHeader.push(label, '')
      subHeader.push('Family', 'Voter')
    }
    const countPair = (counts: CategoryCounts): Array<string | number> => [counts.families, counts.voters]
    const rowValues = (row: StatsRow): Array<string | number> => [
      row.label,
      row.totalFamilies,
      row.totalVoters,
      ...countPair(row.unassigned),
      ...VOTER_CATEGORY_OPTIONS.flatMap((option) => countPair(row.byCategory[option.value])),
    ]
    const aoa = [topHeader, subHeader, ...tableRows.map(rowValues), rowValues(tableTotal)]
    const worksheet = XLSX.utils.aoa_to_sheet(aoa)
    const merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [
      { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
    ]
    for (let i = 0; i < groupLabels.length; i++) {
      const start = 1 + i * 2
      merges.push({ s: { r: 0, c: start }, e: { r: 0, c: start + 1 } })
    }
    worksheet['!merges'] = merges
    worksheet['!cols'] = [{ wch: 22 }, ...groupLabels.flatMap(() => [{ wch: 10 }, { wch: 10 }])]
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, viewMode === 'part' ? 'Part-wise Stats' : 'Section-wise Stats')
    XLSX.writeFile(workbook, `category-status-${viewMode}-${new Date().toISOString().slice(0, 10)}.xlsx`)
    toast.success('Category stats exported.')
  }

  const openPrint = (target: 'drill' | 'unassigned') => {
    const familiesToPrint = target === 'unassigned' ? unassignedFamilies : drillFamilies
    if (!familiesToPrint.length) {
      toast.error('No families to print.')
      return
    }
    setPrintTarget(target)
    setPrintModalOpen(true)
  }

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="Category Status"
        description="Part-wise and section-wise family and voter assignment across Home, Open, Away, BJP, Congress, MN Discussion, and Away Discussion. Click a category count to see the families."
        action={
          <button
            type="button"
            onClick={() => void load({ forceRefresh: true })}
            disabled={loading || refreshing}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />} Refresh
          </button>
        }
      />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatCard
          title="Families"
          value={loading ? '...' : formatNumber(partTotal.totalFamilies)}
          meta={`${formatNumber(partTotal.totalVoters)} voters`}
          featured
        />
        <StatCard
          title="Unassigned"
          value={loading ? '...' : formatNumber(partTotal.unassigned.families)}
          meta={`${formatNumber(partTotal.unassigned.voters)} voters`}
        />
        {VOTER_CATEGORY_OPTIONS.map((option) => (
          <StatCard
            key={option.value}
            title={option.label}
            value={loading ? '...' : formatNumber(partTotal.byCategory[option.value].families)}
            meta={`${formatNumber(partTotal.byCategory[option.value].voters)} voters`}
          />
        ))}
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">
              {viewMode === 'part' ? 'Part-wise Category Stats' : 'Section-wise Category Stats'}
            </h2>
            <p className="text-xs text-ink-tertiary">
              Each category cell shows families on top and voters below. Click a cell to list those families.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={exportStatsTable}
              disabled={loading || !tableRows.length}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" /> Export
            </button>
            <div className="flex items-center gap-1 rounded-xl border border-line bg-muted p-0.5">
              {([
                { value: 'part', label: 'Part wise' },
                { value: 'section', label: 'Section wise' },
              ] as const).map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => {
                    setViewMode(mode.value)
                    setDrill(null)
                  }}
                  className={`h-8 rounded-lg px-3 text-xs font-semibold transition ${
                    viewMode === mode.value ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-tertiary hover:text-ink'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading category stats...
          </div>
        ) : (
          <div className="max-h-[calc(100vh-12rem)] overflow-auto">
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="sticky left-0 top-0 z-30 border-b border-line bg-muted px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
                    {viewMode === 'part' ? 'Part' : 'Section'}
                  </th>
                  <th className="sticky top-0 z-20 border-b border-line bg-muted px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Total</th>
                  <th className="sticky top-0 z-20 border-b border-line bg-muted px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-rose-600">Unassigned</th>
                  {VOTER_CATEGORY_OPTIONS.map((option) => (
                    <th
                      key={option.value}
                      className="sticky top-0 z-20 border-b border-line bg-muted px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary"
                    >
                      {option.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.length === 0 ? (
                  <tr>
                    <td colSpan={3 + VOTER_CATEGORY_OPTIONS.length} className="px-6 py-10 text-center text-sm text-ink-tertiary">
                      No voter data found.
                    </td>
                  </tr>
                ) : (
                  tableRows.map((row) => {
                    const active = drill?.rowKey === row.key
                    return (
                      <tr key={row.key} className={`transition ${active ? 'bg-brand-50/70' : 'hover:bg-muted'}`}>
                        <td className="sticky left-0 z-10 border-b border-line bg-white px-4 py-2.5 font-semibold text-ink">
                          {row.label}
                        </td>
                        <td className="border-b border-line px-4 py-2.5 text-right tabular-nums text-ink-secondary">
                          <span className="block text-sm font-semibold">{formatNumber(row.totalFamilies)}</span>
                          <span className="block text-[11px] text-ink-tertiary">{formatNumber(row.totalVoters)} voters</span>
                        </td>
                        <td className="border-b border-line px-2 py-1.5">
                          <CountCell
                            counts={row.unassigned}
                            tone="warn"
                            active={active && drill?.kind === 'UNASSIGNED'}
                            onClick={() => openDrill(row, 'UNASSIGNED')}
                          />
                        </td>
                        {VOTER_CATEGORY_OPTIONS.map((option) => (
                          <td key={option.value} className="border-b border-line px-2 py-1.5">
                            <CountCell
                              counts={row.byCategory[option.value]}
                              active={active && drill?.kind === option.value}
                              onClick={() => openDrill(row, option.value)}
                            />
                          </td>
                        ))}
                      </tr>
                    )
                  })
                )}
              </tbody>
              {tableRows.length > 0 ? (
                <tfoot>
                  <tr className="bg-muted">
                    <td className="sticky left-0 z-10 border-t border-line bg-muted px-4 py-3 text-sm font-bold text-ink">
                      {tableTotal.label}
                    </td>
                    <td className="border-t border-line px-4 py-3 text-right text-sm font-bold tabular-nums text-ink">
                      <span className="block">{formatNumber(tableTotal.totalFamilies)}</span>
                      <span className="block text-[11px] font-medium text-ink-tertiary">{formatNumber(tableTotal.totalVoters)} voters</span>
                    </td>
                    <td className="border-t border-line px-4 py-3 text-right text-sm font-bold tabular-nums text-rose-700">
                      <span className="block">{formatNumber(tableTotal.unassigned.families)}</span>
                      <span className="block text-[11px] font-medium text-rose-500">{formatNumber(tableTotal.unassigned.voters)} voters</span>
                    </td>
                    {VOTER_CATEGORY_OPTIONS.map((option) => {
                      const counts = countsForKind(tableTotal, option.value)
                      return (
                        <td key={option.value} className="border-t border-line px-4 py-3 text-right text-sm font-bold tabular-nums text-ink">
                          <span className="block">{formatNumber(counts.families)}</span>
                          <span className="block text-[11px] font-medium text-ink-tertiary">{formatNumber(counts.voters)} voters</span>
                        </td>
                      )
                    })}
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        )}
      </section>

      {drill ? (
        <section ref={listRef} className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <h2 className="text-base font-semibold text-ink">
                {drill.label} · {kindLabel(drill.kind)}
              </h2>
              <p className="text-xs text-ink-tertiary">
                {drillFamilies.length} famil{drillFamilies.length === 1 ? 'y' : 'ies'} · {drillVoterCount} voter{drillVoterCount === 1 ? '' : 's'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => openPrint('drill')}
                disabled={!drillFamilies.length}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
              <button
                type="button"
                onClick={() => setDrill(null)}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-tertiary transition hover:bg-muted"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </button>
            </div>
          </div>
          <FamilyList
            families={drillFamilies}
            onViewVoter={setSelectedVoter}
            emptyMessage="No families match this selection."
            resolvePhotoUrl={resolvePhotoUrl}
            onAssignCategory={assignCategoryToFamily}
            savingCategoryKey={savingCategoryKey}
            leader={{
              options: assignableLeaders,
              byId: leaderById,
              specialIds: specialLeaderIds,
              currentId: familyLeaderId,
              selectByKey: leaderSelectByKey,
              savingKey: assigningLeaderKey,
              onSelect: (familyKey, leaderId) => setLeaderSelectByKey((current) => ({ ...current, [familyKey]: leaderId })),
              onAssign: (family, leaderId) => void assignFamilyLeader(family, leaderId),
            }}
          />
        </section>
      ) : null}

      <section ref={unassignedRef} className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">Not assigned to any category</h2>
            <p className="text-xs text-ink-tertiary">Select a part to list families whose head has no category assigned.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {unassignedPart ? (
              <button
                type="button"
                onClick={() => openPrint('unassigned')}
                disabled={!unassignedFamilies.length}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
            ) : null}
            <label className="flex flex-col gap-1 text-xs font-semibold text-ink-secondary">
            Part
            <select
              className="h-10 min-w-[220px] rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink outline-none focus:border-brand-300"
              value={unassignedPart}
              onChange={(event) => handleUnassignedPartChange(event.target.value)}
              aria-label="Select part to view unassigned families"
            >
              <option value="">Select a part</option>
              {partOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} ({formatNumber(option.unassigned.families)} families)
                </option>
              ))}
            </select>
          </label>
          </div>
        </div>

        {!unassignedPart ? (
          <div className="px-6 py-12 text-center text-sm text-ink-tertiary">
            Choose a part above to view families not assigned to any category.
          </div>
        ) : (
          <>
            <div className="border-b border-line px-5 py-3 text-xs text-ink-tertiary">
              {unassignedFamilies.length} famil{unassignedFamilies.length === 1 ? 'y' : 'ies'} · {unassignedVoterCount} voter{unassignedVoterCount === 1 ? '' : 's'} not assigned
            </div>
            <FamilyList
              families={unassignedFamilies}
              onViewVoter={setSelectedVoter}
              emptyMessage="Every family in this part has a category assigned."
              resolvePhotoUrl={resolvePhotoUrl}
              onAssignCategory={assignCategoryToFamily}
              savingCategoryKey={savingCategoryKey}
              leader={{
                options: assignableLeaders,
                byId: leaderById,
                specialIds: specialLeaderIds,
                currentId: familyLeaderId,
                selectByKey: leaderSelectByKey,
                savingKey: assigningLeaderKey,
                onSelect: (familyKey, leaderId) => setLeaderSelectByKey((current) => ({ ...current, [familyKey]: leaderId })),
                onAssign: (family, leaderId) => void assignFamilyLeader(family, leaderId),
              }}
            />
          </>
        )}
      </section>

      <ReportConfigModal
        title={printTitle}
        open={printModalOpen}
        mode="print"
        fieldDefs={PRINT_FIELD_DEFS}
        fields={printFields.map((f) => ({ key: f.key, enabled: f.enabled }))}
        defaultFields={DEFAULT_PRINT_FIELDS.map((f) => ({ key: f.key, enabled: f.enabled }))}
        showLayout
        layout={includeMembers}
        layoutTrueLabel="All members - every voter in each family"
        layoutFalseLabel="Family heads only"
        fontSize={printFontSize}
        boldText={printBold}
        printDescription="Print the currently listed families. Choose columns, photos, and heads-only or full family."
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

interface FamilyListLeaderControls {
  options: UnassignedLeaderOption[]
  byId: Map<string, UnassignedLeaderOption>
  specialIds: Set<string>
  currentId: (family: FamilyGroup) => string
  selectByKey: Record<string, string>
  savingKey: string | null
  onSelect: (familyKey: string, leaderId: string) => void
  onAssign: (family: FamilyGroup, leaderId: string) => void
}

function FamilyList({
  families,
  onViewVoter,
  emptyMessage,
  resolvePhotoUrl,
  onAssignCategory,
  savingCategoryKey,
  leader,
}: {
  families: FamilyGroup[]
  onViewVoter: (voter: Voter) => void
  emptyMessage: string
  resolvePhotoUrl: (voter: Voter | null | undefined) => string
  onAssignCategory: (family: FamilyGroup, category: VoterCategory | null, applyToAll: boolean) => void
  savingCategoryKey: string | null
  leader: FamilyListLeaderControls
}) {
  if (families.length === 0) {
    return <div className="px-6 py-16 text-center text-sm text-ink-tertiary">{emptyMessage}</div>
  }

  return (
    <div className="space-y-4 p-5">
      {families.map((family) => {
        const head = family.headVoter ?? family.members[0] ?? null
        const category = familyCategory(family)
        const saving = savingCategoryKey === family.key
        const currentLeaderId = leader.currentId(family)
        const realLeaderId = currentLeaderId && !leader.specialIds.has(currentLeaderId) ? currentLeaderId : ''
        const currentLeaderName = realLeaderId ? (leader.byId.get(realLeaderId)?.name ?? realLeaderId) : ''
        const leaderSelectValue = leader.selectByKey[family.key] ?? ''
        const savingLeader = leader.savingKey === family.key
        const partLeaders = head?.part_no != null
          ? leader.options.filter((option) => option.part_no === head.part_no)
          : []
        const leaderChoices = partLeaders.length ? partLeaders : leader.options
        return (
          <section key={family.key} className="overflow-hidden rounded-xl border border-line bg-white">
            <div className="flex flex-wrap items-center gap-3 border-b border-line bg-muted/70 px-4 py-4 sm:px-5">
              {head ? <VoterAvatar voter={head} photoUrl={resolvePhotoUrl(head)} /> : (
                <span className="inline-flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">NA</span>
              )}
              <div className="min-w-[200px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-700">Family Head</span>
                  <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                    {family.members.length} member{family.members.length === 1 ? '' : 's'}
                  </span>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    category ? 'bg-brand-50 text-brand-700' : 'bg-rose-50 text-rose-700'
                  }`}>
                    {voterCategoryLabel(category) ?? 'No category'}
                  </span>
                  {currentLeaderName ? (
                    <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                      {currentLeaderName}
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full border border-dashed border-line px-2 py-0.5 text-[11px] font-medium text-ink-tertiary">
                      No team leader
                    </span>
                  )}
                </div>
                <p className="mt-1 text-base font-semibold text-ink">{head?.name ?? 'Unknown head'}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-tertiary">
                  <span>EPIC: {head?.epic_no || '-'}</span>
                  <span>Part: {head?.part_no ?? '-'}</span>
                  <span>Sec: {head?.section ?? '-'}</span>
                  {head?.house_no ? <span>House: {head.house_no}</span> : null}
                </div>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <select
                  className="h-8 w-40 rounded-lg border border-line bg-white px-2 text-[11px] font-semibold text-ink-secondary outline-none focus:border-brand-300"
                  aria-label={`${category ? 'Transfer' : 'Assign'} category for ${head?.name ?? family.head}`}
                  defaultValue=""
                  disabled={saving || savingLeader}
                  onChange={(event) => {
                    const value = event.target.value
                    if (!value) return
                    onAssignCategory(family, value as VoterCategory, true)
                    event.target.value = ''
                  }}
                >
                  <option value="">{category ? 'Transfer to...' : 'Assign category...'}</option>
                  {VOTER_CATEGORY_OPTIONS.filter((option) => option.value !== category).map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-tertiary" /> : null}
                {leader.options.length ? (
                  <>
                    <select
                      className="h-8 w-44 rounded-lg border border-line bg-white px-2 text-[11px] font-semibold text-ink-secondary outline-none focus:border-brand-300"
                      aria-label={`${realLeaderId ? 'Reassign' : 'Assign'} team leader for ${head?.name ?? family.head}`}
                      value={leaderSelectValue}
                      disabled={savingLeader || saving}
                      onChange={(event) => leader.onSelect(family.key, event.target.value)}
                    >
                      <option value="">{realLeaderId ? 'Reassign to...' : 'Assign to...'}</option>
                      {leaderChoices.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}{option.part_no != null ? ` · Part ${option.part_no}` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => leader.onAssign(family, leaderSelectValue)}
                      disabled={!leaderSelectValue || savingLeader || saving}
                      className="inline-flex h-8 items-center gap-1 rounded-lg bg-brand-600 px-2.5 text-[11px] font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {savingLeader ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      {savingLeader ? 'Saving…' : realLeaderId ? 'Reassign' : 'Assign'}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="max-h-[min(70vh,calc(100dvh-14rem))] overflow-auto overscroll-contain">
              <table className="min-w-full border-separate border-spacing-0 text-xs">
                <thead className="sticky top-0 z-10 bg-muted">
                  <tr>
                    <th className="w-10 border-b border-line px-3 py-2.5 text-center font-semibold text-ink-tertiary">#</th>
                    <th className="w-16 border-b border-line px-3 py-2.5 text-left font-semibold text-ink-tertiary">Photo</th>
                    <th className="min-w-[170px] border-b border-line px-3 py-2.5 text-left font-semibold text-ink-tertiary">Name</th>
                    <th className="w-28 border-b border-line px-3 py-2.5 text-left font-semibold text-ink-tertiary">EPIC</th>
                    <th className="w-24 border-b border-line px-3 py-2.5 text-left font-semibold text-ink-tertiary">Category</th>
                    <th className="w-24 border-b border-line px-3 py-2.5 text-left font-semibold text-ink-tertiary">Part / Sec</th>
                    <th className="min-w-[150px] border-b border-line px-3 py-2.5 text-left font-semibold text-ink-tertiary">Relative</th>
                    <th className="w-12 border-b border-line px-3 py-2.5 text-right font-semibold text-ink-tertiary"></th>
                  </tr>
                </thead>
                <tbody>
                  {family.members.map((member, memberIndex) => {
                    const isHead = head != null && member.id === head.id
                    return (
                      <tr key={member.id} className={`transition hover:bg-muted ${isHead ? 'bg-brand-50/40' : ''}`}>
                        <td className="border-b border-line px-3 py-2.5 text-center text-ink-tertiary">{memberIndex + 1}</td>
                        <td className="border-b border-line px-3 py-2.5">
                          <VoterAvatar voter={member} photoUrl={resolvePhotoUrl(member)} size="sm" />
                        </td>
                        <td className="border-b border-line px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            {isHead ? (
                              <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">Head</span>
                            ) : null}
                            <span className="truncate font-medium text-ink">{member.name}</span>
                          </div>
                        </td>
                        <td className="border-b border-line px-3 py-2.5 text-ink-tertiary">{member.epic_no || '-'}</td>
                        <td className="border-b border-line px-3 py-2.5">
                          <span className={`inline-flex rounded-md px-1.5 py-0.5 font-medium ${
                            member.voter_category ? 'bg-brand-50 text-brand-700' : 'bg-muted text-ink-tertiary'
                          }`}>
                            {voterCategoryLabel(member.voter_category) ?? 'No category'}
                          </span>
                        </td>
                        <td className="border-b border-line px-3 py-2.5 text-ink-tertiary">
                          Part {member.part_no ?? '-'} / Sec {member.section ?? '-'}
                        </td>
                        <td className="border-b border-line px-3 py-2.5 text-ink-tertiary">
                          {member.relative_name ? `${member.relative_name}${member.relative_relation ? ` (${member.relative_relation})` : ''}` : '-'}
                        </td>
                        <td className="border-b border-line px-3 py-2.5">
                          <div className="flex items-center justify-end">
                            <button
                              type="button"
                              title="View voter"
                              onClick={() => onViewVoter(member)}
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
  )
}
