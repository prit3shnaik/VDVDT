import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ArrowLeft,
  ArrowLeftRight,
  Check,
  Eye,
  Loader2,
  Printer,
  Search,
  UserPlus,
  X,
} from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { ReportConfigModal, type ReportFieldItem } from '../../components/common/ReportConfigModal'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import type { PlaceClub, Voter } from '../../lib/types'
import { presenceNoteOf, presenceTabLabel } from '../../lib/presence'
import { openPrintWindow, downloadPdfTable, type PrintStyleOptions } from '../../lib/reportBuilder'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { usePersistentState } from '../../hooks/usePersistentState'
import { fetchVotersForScope } from '../../hooks/useMeetingData'
import { buildWardScope, FAST_NAV_CACHE_MAX_AGE_MS, readCachedVoters } from '../../lib/voterCache'
import { withNormalizedVoterCategories } from '../../lib/voterCategory'
import {
  buildFamilies,
  familyMatchesSearch,
  initials,
  matchesLookupTokens,
  normalizeLookupValue,
  tokenizeLookup,
  type FamilyGroup,
} from '../../lib/searchUtils'
import {
  assignFamilyToLeader,
  clearTeamLeaderDetailCache,
  clearTeamLeadersListCache,
  resolveTeamLeaderName,
  readUnassignedData,
  specialLeaderIdSet,
  COUNT_SHIFTED_AS_ASSIGNED_KEY,
  countingSpecialLeaderIdSet,
  fetchUnassignedCountingLeaderIds,
  transferFamilyToLeader,
  fetchAllAssignmentLinks,
  fetchTeamLeadersFromApi,
  dedupeSpecialLeaders,
  consolidateSpecialLeaders,
  UNASSIGNED_DATA_TTL_MS,
  writeUnassignedData,
  type UnassignedLeaderOption,
} from '../../lib/teamLeaderCache'
import { ClassificationBadges } from '../../components/families/ClassificationBadges'
import { familyHeadKey, familyPlaceMap, fetchFamilyPlaceClubs, fetchPlaceClubs } from '../../lib/placeClubs'

const VOTERS_CACHE_KEY = 'vote:teamleaders:unassigned:voters-cache'
const PRINT_FIELDS_KEY = 'vote:teamleaders:unassigned:printFields:v5'
const PRINT_FONT_SIZE_KEY = 'vote:teamleaders:unassigned:printFontSize:v2'
const PRINT_BOLD_KEY = 'vote:teamleaders:unassigned:printBold'
const SIZE_FILTER_KEY = 'vote:teamleaders:unassigned:sizeFilter'

type SizeFilter = 'all' | 'singles' | 'multi'

type UnassignedPrintKey =
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

interface UnassignedPrintFieldDef {
  key: UnassignedPrintKey
  label: string
  description?: string
  isPhoto?: boolean
}

interface UnassignedPrintFieldState {
  key: UnassignedPrintKey
  enabled: boolean
}

const PRINT_FIELD_DEFS: UnassignedPrintFieldDef[] = [
  { key: 'srNo', label: 'Sr No', description: 'Sequential counter (1, 2, 3 ...)' },
  { key: 'voterSrNo', label: 'Voter Sr No', description: 'From sr_no_roll in the database' },
  { key: 'photo', label: 'Photo', isPhoto: true },
  { key: 'name', label: 'Name' },
  { key: 'epicNo', label: 'EPIC' },
  { key: 'status', label: 'Status' },
  { key: 'relativeName', label: 'Relative Name' },
  { key: 'houseNo', label: 'House No' },
  { key: 'ward', label: 'Ward' },
  { key: 'partNo', label: 'Part No' },
  { key: 'section', label: 'Section' },
  { key: 'sectionName', label: 'Section Name' },
  { key: 'age', label: 'Age' },
  { key: 'contact1', label: 'Contact No 1' },
  { key: 'relation', label: 'Relation' },
  { key: 'gender', label: 'Gender' },
  { key: 'contact2', label: 'Contact No 2' },
  { key: 'religion', label: 'Religion' },
  { key: 'dob', label: 'Date of Birth' },
  { key: 'familyLabel', label: 'Family Label' },
  { key: 'familyMembers', label: 'Family Members' },
  { key: 'presence', label: 'Presence' },
]

const DEFAULT_PRINT_FIELDS: UnassignedPrintFieldState[] = [
  { key: 'srNo', enabled: true },
  { key: 'voterSrNo', enabled: false },
  { key: 'photo', enabled: true },
  { key: 'name', enabled: true },
  { key: 'epicNo', enabled: false },
  { key: 'status', enabled: false },
  { key: 'relativeName', enabled: false },
  { key: 'houseNo', enabled: false },
  { key: 'ward', enabled: false },
  { key: 'partNo', enabled: false },
  { key: 'section', enabled: false },
  { key: 'sectionName', enabled: false },
  { key: 'age', enabled: false },
  { key: 'contact1', enabled: true },
  { key: 'relation', enabled: false },
  { key: 'gender', enabled: false },
  { key: 'contact2', enabled: false },
  { key: 'religion', enabled: false },
  { key: 'dob', enabled: false },
  { key: 'familyLabel', enabled: false },
  { key: 'familyMembers', enabled: false },
  { key: 'presence', enabled: false },
]

function formatPrintDate(value: unknown): string {
  if (!value) return '-'
  try {
    const d = new Date(value as string)
    if (Number.isNaN(d.getTime())) return '-'
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return '-'
  }
}

function getUnassignedPrintValue(voter: Voter, key: UnassignedPrintKey, family: FamilyGroup, sr: number): string {
  switch (key) {
    case 'srNo': return String(sr)
    case 'voterSrNo': return voter.sr_no_roll != null ? String(voter.sr_no_roll) : '-'
    case 'photo': return voter.photo_url ? 'Photo' : ''
    case 'name': return voter.name || '-'
    case 'epicNo': return voter.epic_no || '-'
    case 'status': return voter.voter_category || '-'
    case 'relativeName': return voter.relative_name || '-'
    case 'relation': return voter.relative_relation || '-'
    case 'houseNo': return voter.house_no || '-'
    case 'ward': return voter.ward_no != null ? String(voter.ward_no) : '-'
    case 'partNo': return voter.part_no != null ? String(voter.part_no) : '-'
    case 'section': return voter.section != null ? String(voter.section) : '-'
    case 'sectionName': return voter.section_name || '-'
    case 'age': return voter.age != null ? String(voter.age) : '-'
    case 'gender': return voter.gender || '-'
    case 'contact1': return voter.contact_no_1 || '-'
    case 'contact2': return voter.contact_no_2 || '-'
    case 'religion': return voter.religion || '-'
    case 'dob': return formatPrintDate(voter.date_of_birth)
    case 'familyLabel': return voter.family_label || family.headVoter?.family_label || '-'
    case 'familyMembers': return String(family.members.length)
    case 'presence': return presenceTabLabel(voter.presence_status, presenceNoteOf(voter))
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

function familyHeadSortName(family: FamilyGroup): string {
  return family.headVoter?.name?.trim() ?? family.head
}

// Extracts the surname (last whitespace-separated token) of a name. Names
// with a single token are treated as surname-only so they still sort into
// the same bucket rather than being pushed to the end.
function surnameOf(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean)
  if (tokens.length <= 1) return name.trim()
  return tokens[tokens.length - 1]
}

// Orders families by the head's surname first, then full name (case
// insensitive), then the grouping EPIC for stability - matches FamiliesPage.
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

export function UnassignedFamiliesPage() {
  const { profile, loading: authLoading } = useAuth()

  const allowedWards = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((w) => Number.isFinite(w))))
    wards.sort((a, b) => a - b)
    return wards
  }, [profile?.allowed_wards])
  const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0
  const wardScope = useMemo(() => buildWardScope(profile?.role, profile?.allowed_wards), [profile?.role, profile?.allowed_wards])

  // Render straight from the caches on mount so switching tabs back to this
  // page is instant - the full-page spinner only appears on a true cold start.
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
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>({})

  const [viewMode, setViewMode] = useState<'unassigned' | 'assigned'>('unassigned')
  const [partFilter, setPartFilter] = useState('')
  const [sectionFilter, setSectionFilter] = useState('')
  const [familyQuery, setFamilyQuery] = useState('')
  const [sizeFilter, setSizeFilter] = usePersistentState<SizeFilter>(SIZE_FILTER_KEY, 'all')

  const [selectedFamilyKeys, setSelectedFamilyKeys] = useState<Set<string>>(new Set())
  const [targetLeaderId, setTargetLeaderId] = useState('')
  const [cardLeaderByKey, setCardLeaderByKey] = useState<Record<string, string>>({})
  const [leaderSearch, setLeaderSearch] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const [printFields, setPrintFields] = usePersistentState<UnassignedPrintFieldState[]>(PRINT_FIELDS_KEY, DEFAULT_PRINT_FIELDS.map((f) => ({ ...f })))
  const [printFontSize, setPrintFontSize] = usePersistentState<number>(PRINT_FONT_SIZE_KEY, 20)
  const [printBold, setPrintBold] = usePersistentState<boolean>(PRINT_BOLD_KEY, false)
  const [includeMembers, setIncludeMembers] = useState(true)
  const [printModalOpen, setPrintModalOpen] = useState(false)
  const [countShiftedAsAssigned] = usePersistentState<boolean>(COUNT_SHIFTED_AS_ASSIGNED_KEY, false)
  const [unassignedCountingLeaderIds, setUnassignedCountingLeaderIds] = useState<string[]>([])
  const [placeClubs, setPlaceClubs] = useState<PlaceClub[]>([])
  const [familyPlaceByHead, setFamilyPlaceByHead] = useState<Record<string, string>>({})

  const load = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    const forceRefresh = opts?.forceRefresh ?? false
    const cached = readUnassignedData(wardScope)
    // Only block the whole page when we have nothing cached to render.
    if (!cached) setLoading(true)
    try {
      const consolidation = await consolidateSpecialLeaders()
      if (consolidation.changed) {
        clearTeamLeadersListCache()
        clearTeamLeaderDetailCache()
      }
      // A force refresh (e.g. a voter was just edited) must bypass the 6h
      // voters cache so the counts reflect the latest rows.
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
      const assignedLinks = assignedRes.data

      const assignedRows = assignedLinks.map((r) => r.voter_id).filter(Boolean)
      setAssignedIds(new Set(assignedRows))

      const voterToLeader: Record<string, string> = {}
      for (const link of assignedLinks) {
        if (link.voter_id && link.team_leader_id) voterToLeader[link.voter_id] = link.team_leader_id
      }
      setVoterToLeaderId(voterToLeader)

      const leaders: UnassignedLeaderOption[] = apiRows.map((tl) => {
        const name = resolveTeamLeaderName(tl, tl.voter_name ? { name: tl.voter_name } : null, '')
        return { id: tl.id, name, epicNo: tl.epic_no ?? '', part_no: tl.part_no, section: tl.section, notes: tl.notes, voter_id: tl.voter_id }
      }).sort((a, b) => a.name.localeCompare(b.name))
      setLeaders(leaders)
      writeUnassignedData(wardScope, assignedRows, voterToLeader, leaders)
    } catch (error) {
      // Never silently degrade to "no assignments" when the fetch fails -
      // keep the last known data and tell the user the load was incomplete.
      console.error('Failed to load team leader assignment data', error)
      toast.error(`Could not load team leader assignments: ${(error as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [wardScope, hasWardRestriction, allowedWards])

  useEffect(() => {
    if (authLoading) return
    void load()
  }, [load, authLoading])

  useEffect(() => {
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
  }, [])

  const allFamilies = useMemo(() => sortFamiliesBySurname(buildFamilies(voters)), [voters])

  // Shifted/Single are special "parking" leaders, not real team leaders. They
  // are counted in the summary tally but families parked under them are never
  // listed on this page.
  const specialLeaderIds = useMemo(() => specialLeaderIdSet(leaders), [leaders])
  const countingSpecialIds = useMemo(
    () => countingSpecialLeaderIdSet(leaders, countShiftedAsAssigned, unassignedCountingLeaderIds),
    [leaders, countShiftedAsAssigned, unassignedCountingLeaderIds],
  )
  const placeClubById = useMemo(() => {
    const map = new Map<string, PlaceClub>()
    for (const club of placeClubs) map.set(club.id, club)
    return map
  }, [placeClubs])

  // Voters whose only assignment is to a Shifted/Single parking leader.
  const parkedIds = useMemo(() => {
    const set = new Set<string>()
    for (const voterId of assignedIds) {
      const leaderId = voterToLeaderId[voterId]
      if (leaderId && specialLeaderIds.has(leaderId)) set.add(voterId)
    }
    return set
  }, [assignedIds, voterToLeaderId, specialLeaderIds])

  const countedAssignedIds = useMemo(() => {
    const set = new Set<string>()
    for (const voterId of assignedIds) {
      const leaderId = voterToLeaderId[voterId]
      if (leaderId && !countingSpecialIds.has(leaderId)) set.add(voterId)
    }
    return set
  }, [assignedIds, voterToLeaderId, countingSpecialIds])

  // Voters genuinely assigned to a real team leader.
  const realAssignedIds = useMemo(() => {
    const set = new Set<string>()
    for (const voterId of assignedIds) {
      const leaderId = voterToLeaderId[voterId]
      if (leaderId && !specialLeaderIds.has(leaderId)) set.add(voterId)
    }
    return set
  }, [assignedIds, voterToLeaderId, specialLeaderIds])

  // A family is "assigned" when at least one of its members is genuinely
  // assigned to a real team leader.
  const assignedFamilies = useMemo(
    () => allFamilies.filter((f) => f.members.some((m) => countedAssignedIds.has(m.id) && !parkedIds.has(m.id))),
    [allFamilies, countedAssignedIds, parkedIds],
  )

  const parkedFamilies = useMemo(
    () => allFamilies.filter(
      (f) => f.members.some((m) => parkedIds.has(m.id)) && f.members.every((m) => !realAssignedIds.has(m.id)),
    ),
    [allFamilies, parkedIds, realAssignedIds],
  )

  const unassignedFamilies = useMemo(
    () => allFamilies.filter((f) => f.members.every((m) => !countedAssignedIds.has(m.id) && !parkedIds.has(m.id))),
    [allFamilies, countedAssignedIds, parkedIds],
  )

  const viewFamilies = viewMode === 'assigned' ? assignedFamilies : unassignedFamilies

  const sizeSplit = (families: typeof assignedFamilies) => {
    let multi = 0
    let singles = 0
    for (const family of families) {
      if (family.members.length === 1) singles += 1
      else multi += 1
    }
    return { multi, singles }
  }
  const assignedSplit = useMemo(() => sizeSplit(assignedFamilies), [assignedFamilies])
  const unassignedSplit = useMemo(() => sizeSplit(unassignedFamilies), [unassignedFamilies])
  const parkedSplit = useMemo(() => sizeSplit(parkedFamilies), [parkedFamilies])

  const partBreakdown = useMemo(() => {
    const map = new Map<string, { part: number | null; families: FamilyGroup[]; sections: Set<number>; singleFamilies: number; multiFamilies: number }>()
    for (const f of viewFamilies) {
      const part = f.headVoter?.part_no ?? null
      const key = part == null ? 'unassigned' : String(part)
      const acc = map.get(key) ?? { part, families: [], sections: new Set<number>(), singleFamilies: 0, multiFamilies: 0 }
      acc.families.push(f)
      if (f.members.length === 1) acc.singleFamilies += 1
      else acc.multiFamilies += 1
      if (f.headVoter?.section != null) acc.sections.add(f.headVoter.section)
      map.set(key, acc)
    }
    return Array.from(map.values())
      .map((acc) => ({ ...acc, sections: Array.from(acc.sections).sort((a, b) => a - b) }))
      .sort((a, b) => (a.part ?? Number.MAX_SAFE_INTEGER) - (b.part ?? Number.MAX_SAFE_INTEGER))
  }, [viewFamilies])

  const partOptions = useMemo(() => {
    const parts = new Set(viewFamilies.map((f) => f.headVoter?.part_no).filter((p): p is number => p != null))
    const list = Array.from(parts).sort((a, b) => a - b).map((p) => ({ value: String(p), label: `Part ${p}` }))
    if (viewFamilies.some((f) => f.headVoter?.part_no == null)) {
      list.push({ value: 'unassigned', label: 'Unassigned Part' })
    }
    return list
  }, [viewFamilies])

  const matchesPart = useCallback((f: FamilyGroup, pf: string) => {
    if (!pf) return true
    if (pf === 'unassigned') return f.headVoter?.part_no == null
    return String(f.headVoter?.part_no ?? '') === pf
  }, [])

  const matchesSize = useCallback((f: FamilyGroup, size: SizeFilter) => {
    if (size === 'all') return true
    if (size === 'singles') return f.members.length === 1
    return f.members.length > 1
  }, [])

  const sectionOptions = useMemo(() => {
    if (!partFilter) return []
    const sections = new Set<number>()
    for (const f of viewFamilies) {
      if (!matchesPart(f, partFilter)) continue
      if (f.headVoter?.section != null) sections.add(f.headVoter.section)
    }
    return Array.from(sections).sort((a, b) => a - b)
  }, [viewFamilies, partFilter, matchesPart])

  const sizedViewFamilies = useMemo(
    () => viewFamilies.filter((f) => matchesSize(f, sizeFilter)),
    [viewFamilies, sizeFilter, matchesSize],
  )

  const familyTokens = useMemo(() => tokenizeLookup(familyQuery), [familyQuery])

  const reportFamilies = useMemo(() => {
    const scoped = sizedViewFamilies.filter((f) => {
      if (partFilter && !matchesPart(f, partFilter)) return false
      if (sectionFilter && String(f.headVoter?.section ?? '') !== sectionFilter) return false
      return true
    })
    if (!familyTokens.length) return scoped
    return scoped.filter((f) => familyMatchesSearch(f, familyTokens))
  }, [sizedViewFamilies, partFilter, sectionFilter, familyTokens, matchesPart])

  const filteredFamilies = useMemo(() => {
    // Families are only shown once a specific part is selected, except for
    // singles which can be listed across every part in one print-ready view.
    if (!partFilter && sizeFilter !== 'singles') return []
    if (!partFilter && sizeFilter === 'singles') {
      return [...reportFamilies].sort((a, b) => {
        const ap = a.headVoter?.part_no ?? Number.MAX_SAFE_INTEGER
        const bp = b.headVoter?.part_no ?? Number.MAX_SAFE_INTEGER
        if (ap !== bp) return ap - bp
        const as = a.headVoter?.section ?? Number.MAX_SAFE_INTEGER
        const bs = b.headVoter?.section ?? Number.MAX_SAFE_INTEGER
        if (as !== bs) return as - bs
        return 0
      })
    }
    return reportFamilies
  }, [partFilter, sizeFilter, reportFamilies])

  const displayFamilies = filteredFamilies

  const displayVoterCount = useMemo(
    () => displayFamilies.reduce((sum, f) => sum + f.members.length, 0),
    [displayFamilies],
  )

  // Rank leaders by how well they match the selected part/section, but keep
  // the user's manual choice if it is still valid.
  const sortedLeaders = useMemo(() => {
    const searchTokens = tokenizeLookup(leaderSearch)
    const uniqueLeaders = dedupeSpecialLeaders(leaders)
    const list = searchTokens.length
      ? uniqueLeaders.filter((l) => matchesLookupTokens(normalizeLookupValue(`${l.name} ${l.epicNo} ${l.part_no ?? ''} ${l.section ?? ''}`), searchTokens))
      : uniqueLeaders
    const partNum = partFilter === 'unassigned' ? null : partFilter ? Number(partFilter) : null
    const sectionNum = sectionFilter ? Number(sectionFilter) : null
    const score = (l: UnassignedLeaderOption) => {
      let s = 0
      if (partNum != null && l.part_no === partNum) s += 2
      if (sectionNum != null && l.section === sectionNum) s += 1
      return s
    }
    return [...list].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
  }, [leaders, leaderSearch, partFilter, sectionFilter])

  const targetLeader = sortedLeaders.find((l) => l.id === targetLeaderId)

  const leaderById = useMemo(() => new Map(leaders.map((l) => [l.id, l])), [leaders])

  // The leader this family is currently assigned to (from the first assigned
  // member - families are always assigned as a whole so every member shares
  // the same leader).
  const familyLeaderId = useCallback((family: FamilyGroup): string | null => {
    for (const member of family.members) {
      const lid = voterToLeaderId[member.id]
      if (lid) return lid
    }
    return null
  }, [voterToLeaderId])

  const visiblePhotoPaths = useMemo(() => {
    const set = new Set<string>()
    for (const f of displayFamilies) {
      for (const m of f.members) if (m.photo_url) set.add(m.photo_url)
    }
    return Array.from(set)
  }, [displayFamilies])

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

  const selectedFamilies = useMemo(
    () => displayFamilies.filter((f) => selectedFamilyKeys.has(f.key)),
    [displayFamilies, selectedFamilyKeys],
  )

  const toggleFamily = (key: string) => {
    setSelectedFamilyKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const allDisplayedSelected = displayFamilies.length > 0 && displayFamilies.every((f) => selectedFamilyKeys.has(f.key))

  const assignFamilies = async (familiesToAssign: FamilyGroup[], leaderId?: string) => {
    if (!familiesToAssign.length) return
    const effectiveLeaderId = leaderId ?? targetLeaderId
    if (!effectiveLeaderId) {
      toast.error('Select a team leader to assign to first.')
      return
    }
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
      if (!voterIds.length) { toast.error('No voters to assign.'); return }

      // team_leader_assignments has a UNIQUE constraint on voter_id, so a
      // voter can belong to only one team leader. Voters already assigned to a
       // real leader are skipped; voters parked under Shifted/Single are moved
        // to the target leader instead.
      const result = await assignFamilyToLeader({
        voterIds,
        toLeaderId: effectiveLeaderId,
        assignedBy: profile?.id ?? null,
        isDirectVoterIds,
        specialLeaderIds,
      })
      const assignedLeader = leaders.find((l) => l.id === effectiveLeaderId)?.name ?? 'selected leader'
      const assignedCount = result.voterIds.length
      toast.success(
        `Assigned ${assignedCount} voter${assignedCount === 1 ? '' : 's'} from ${familiesToAssign.length} famil${familiesToAssign.length === 1 ? 'y' : 'ies'} to ${assignedLeader}${
          result.skipped ? ` (${result.skipped} skipped - already assigned)` : ''
        }.`,
      )
      setSelectedFamilyKeys(new Set())
      // Reflect the assignment immediately instead of re-fetching the whole
      // table - the newly assigned voters are no longer unassigned.
      const newlyAssigned = result.voterIds
      setAssignedIds((prev) => {
        const next = new Set(prev)
        for (const id of newlyAssigned) next.add(id)
        return next
      })
      setVoterToLeaderId((prev) => {
        const next = { ...prev }
        for (const id of newlyAssigned) next[id] = effectiveLeaderId
        return next
      })
      setCardLeaderByKey((prev) => {
        const next = { ...prev }
        for (const family of familiesToAssign) delete next[family.key]
        return next
      })
      const existing = readUnassignedData(wardScope)
      if (existing) writeUnassignedData(wardScope, Array.from(new Set([...existing.assignedVoterIds, ...newlyAssigned])), { ...existing.voterToLeaderId, ...Object.fromEntries(newlyAssigned.map((id) => [id, effectiveLeaderId])) }, existing.leaders)
      // Assignments changed - the Team Leaders list/detail pages cache the
      // per-leader counts, so force them to refetch on their next visit.
      clearTeamLeadersListCache()
      clearTeamLeaderDetailCache()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setAssigning(false)
    }
  }

  // Re-assigns an already-assigned family to a different team leader. Only the
  // given family is affected. Direct (primary) voter status is preserved, and
  // the local state updates instantly without a page refresh.
  const reassignFamily = async (family: FamilyGroup, newLeaderId: string) => {
    if (!newLeaderId) {
      toast.error('Select a team leader to assign to first.')
      return
    }
    const currentLeaderId = familyLeaderId(family)
    if (!currentLeaderId) {
      toast.error('This family is not assigned to any team leader.')
      return
    }
    if (currentLeaderId === newLeaderId) return

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
      toast.success(`Assigned ${memberIds.length} voter${memberIds.length === 1 ? '' : 's'} (family of ${family.headVoter?.name ?? family.head}) to ${assignedLeader}.`)

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

  const handlePartSelect = (value: string) => {
    setPartFilter(value)
    setSectionFilter('')
  }

  const sizeLabel = sizeFilter === 'singles' ? 'Single Voters' : sizeFilter === 'multi' ? 'Multi-member Families' : 'Families'
  const listLabel = `${viewMode === 'assigned' ? 'Assigned' : 'Unassigned'} ${sizeLabel}`
  const printFlatSingles = sizeFilter === 'singles'

  // Prints the families matching the active size/part/section/search filters.
  // Singles across all parts print as a flat table (one row per voter).
  const executePrint = async (fields: UnassignedPrintFieldState[], include: boolean, style: PrintStyleOptions) => {
    const familiesToPrint = reportFamilies
    if (!familiesToPrint.length) { toast.error('No families to print.'); return }

    const enabled = fields.filter((f) => f.enabled)
    const headerLabels = enabled.map((f) => PRINT_FIELD_DEFS.find((d) => d.key === f.key)!.label)
    const escapeHtml = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const fontSize = style.fontSize
    const bold = style.boldText
    const photoSize = Math.max(36, Math.round(56 * (fontSize / 11)))

    // Photos are only signed for the currently visible rows; when printing
    // with photos enabled, sign any remaining photos for the printed rows on
    // demand so the print window isn't missing images.
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
        return `<td>${escapeHtml(getUnassignedPrintValue(voter, f.key, family, sr))}</td>`
      }).join('')
      return `<tr class="${isHead ? 'head-row' : ''}">${cells}</tr>`
    }

    let bodyHtml = ''
    let sr = 1
    let totalVoters = 0
    if (printFlatSingles) {
      bodyHtml += `<table><thead><tr>${headerLabels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>`
      for (const family of familiesToPrint) {
        const head = family.headVoter ?? family.members[0] ?? null
        if (!head) continue
        totalVoters += 1
        bodyHtml += renderRow(head, family, sr, true)
        sr += 1
      }
      bodyHtml += '</tbody></table>'
    } else {
      for (const family of familiesToPrint) {
        const head = family.headVoter ?? family.members[0] ?? null
        const rows = include ? family.members : (head ? [head] : [])
        if (!rows.length) continue
        totalVoters += rows.length
        bodyHtml += '<div class="family">'
        bodyHtml += `<div class="family-hdr"><b>${escapeHtml(head?.name ?? 'Family')}</b>`
        bodyHtml += `<span>EPIC: ${escapeHtml(head?.epic_no ?? family.head)}</span>`
        bodyHtml += `<span>Part ${head?.part_no ?? '-'} / Sec ${head?.section ?? '-'}</span>`
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
    }

    const scopeText = partFilter ? `Part ${partFilter === 'unassigned' ? 'Unassigned' : partFilter}` : 'All Parts'
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(listLabel)} - ${escapeHtml(scopeText)}</title>
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
  <h1>${escapeHtml(listLabel)}</h1>
  <div class="meta">${escapeHtml(scopeText)} &middot; ${familiesToPrint.length} ${printFlatSingles ? `single voter${familiesToPrint.length === 1 ? '' : 's'}` : `famil${familiesToPrint.length === 1 ? 'y' : 'ies'}`} &middot; ${totalVoters} voter${totalVoters === 1 ? '' : 's'} &middot; Printed: ${new Date().toLocaleString()}</div>
  ${bodyHtml}
</body>
</html>`

    openPrintWindow(html)
  }

  // Builds the same report as executePrint as a downloadable PDF file, using
  // the dependency-free table writer shared with the team leader detail page.
  const buildPdfRows = (fields: UnassignedPrintFieldState[], include: boolean): string[][] => {
    const familiesToPrint = reportFamilies
    const enabled = fields.filter((f) => f.enabled)
    const rows: string[][] = []
    let sr = 1
    for (const family of familiesToPrint) {
      const head = family.headVoter ?? family.members[0] ?? null
      const rowVoters = printFlatSingles || !include ? (head ? [head] : []) : family.members
      for (const voter of rowVoters) {
        rows.push(enabled.map((f) => getUnassignedPrintValue(voter, f.key, family, sr)))
        sr += 1
      }
    }
    return rows
  }

  const handlePdfDownload = (fields: ReportFieldItem[], include: boolean, style: PrintStyleOptions) => {
    const nextFields: UnassignedPrintFieldState[] = fields.map((f) => ({ key: f.key as UnassignedPrintKey, enabled: f.enabled }))
    setPrintFields(nextFields.map((f) => ({ ...f })))
    setIncludeMembers(include)
    setPrintFontSize(style.fontSize)
    setPrintBold(style.boldText)
    setPrintModalOpen(false)
    const familiesToPrint = reportFamilies
    if (!familiesToPrint.length) { toast.error('No families to download.'); return }
    const enabled = nextFields.filter((f) => f.enabled)
    const scopeText = partFilter ? `Part ${partFilter === 'unassigned' ? 'Unassigned' : partFilter}` : 'All Parts'
    const sizeSlug = sizeFilter === 'singles' ? 'singles' : sizeFilter === 'multi' ? 'multi' : 'families'
    downloadPdfTable({
      title: `${listLabel} - ${scopeText}`,
      summary: ([
        ['Scope', scopeText],
        ['Filter', sizeLabel],
        ['Families', String(familiesToPrint.length)],
        ['Voters', String(buildPdfRows(nextFields, include).length)],
        ['Generated', new Date().toLocaleString()],
      ] as Array<[string, string]>).filter(([, value]) => Boolean(value)),
      headers: enabled.map((f) => PRINT_FIELD_DEFS.find((d) => d.key === f.key)!.label),
      rows: buildPdfRows(nextFields, include),
      fieldKeys: enabled.map((f) => f.key),
      fontSize: style.fontSize,
      boldText: style.boldText,
      fileName: `${viewMode === 'assigned' ? 'assigned' : 'unassigned'}-${sizeSlug}-${new Date().toISOString().slice(0, 10)}.pdf`,
    })
    toast.success('PDF downloaded.')
  }

  const handlePrintConfirm = (fields: ReportFieldItem[], include: boolean, style: PrintStyleOptions) => {
    const nextFields: UnassignedPrintFieldState[] = fields.map((f) => ({ key: f.key as UnassignedPrintKey, enabled: f.enabled }))
    setPrintFields(nextFields.map((f) => ({ ...f })))
    setIncludeMembers(include)
    setPrintFontSize(style.fontSize)
    setPrintBold(style.boldText)
    setPrintModalOpen(false)
    void executePrint(nextFields, include, style)
  }

  const clearFilters = () => {
    setPartFilter('')
    setSectionFilter('')
    setFamilyQuery('')
    setSizeFilter('all')
  }

  const scrollToList = () => {
    listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="space-y-5 pb-10">
      <Link to="/team-leaders" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-tertiary transition hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> Back to Team Leaders
      </Link>

      <PageHeader
        title={viewMode === 'assigned' ? 'Assigned Families' : 'Not Assigned Families'}
        description={viewMode === 'assigned'
          ? 'Families where at least one member is assigned to a team leader. Review part-wise assigned families, see the leader each family belongs to, or move a family to another leader right from this page.'
          : 'Families with no field team leader. Shifted and Single parking leaders stay parked (not listed here). Use Singles to list 1-member families across every part and print them. Select a part/section below, then assign families to a team leader right from this page.'}
      />

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-rose-100 bg-rose-50/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-rose-600">Unassigned Families</p>
          <p className="mt-1 text-2xl font-bold text-ink">{unassignedFamilies.length.toLocaleString()}</p>
          <p className="text-[11px] text-ink-tertiary">{unassignedSplit.multi.toLocaleString()} families · {unassignedSplit.singles.toLocaleString()} singles</p>
        </div>
        <div className="rounded-2xl border border-amber-100 bg-amber-50/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-600">Shifted / Single (parked)</p>
          <p className="mt-1 text-2xl font-bold text-ink">{parkedFamilies.length.toLocaleString()}</p>
          <p className="text-[11px] text-ink-tertiary">{parkedSplit.multi.toLocaleString()} families · {parkedSplit.singles.toLocaleString()} singles · not assigned, not unassigned</p>
        </div>
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600">Assigned Families</p>
          <p className="mt-1 text-2xl font-bold text-ink">{assignedFamilies.length.toLocaleString()}</p>
          <p className="text-[11px] text-ink-tertiary">{assignedSplit.multi.toLocaleString()} families · {assignedSplit.singles.toLocaleString()} singles</p>
        </div>
        <div className="rounded-2xl border border-blue-100 bg-blue-50/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-600">Parts</p>
          <p className="mt-1 text-2xl font-bold text-ink">{partBreakdown.length.toLocaleString()}</p>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-muted/70 px-4 py-3 text-center text-xs font-medium text-ink-tertiary">
        Tally: {unassignedFamilies.length.toLocaleString()} unassigned + {parkedFamilies.length.toLocaleString()} parked (Shifted/Single) + {assignedFamilies.length.toLocaleString()} assigned = {allFamilies.length.toLocaleString()} total families
      </section>

      <section className="rounded-xl border border-line bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-1 rounded-xl border border-line bg-muted p-0.5">
              {(['unassigned', 'assigned'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => { setViewMode(mode); setPartFilter(''); setSectionFilter(''); setFamilyQuery(''); setSelectedFamilyKeys(new Set()) }}
                  className={`h-8 rounded-lg px-3.5 text-xs font-semibold transition ${viewMode === mode ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-tertiary hover:text-ink'}`}
                >
                  {mode === 'assigned' ? 'Assigned' : 'Unassigned'}
                </button>
              ))}
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink">Part-wise {viewMode === 'assigned' ? 'Assigned' : 'Unassigned'} Families</h2>
              <p className="text-xs text-ink-tertiary">Click a part to filter the list below. Singles are 1-member families, not the parked Single leader.</p>
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-line bg-muted p-0.5">
              {([
                { value: 'all' as const, label: 'All' },
                { value: 'singles' as const, label: `Singles (${viewMode === 'assigned' ? assignedSplit.singles : unassignedSplit.singles})` },
                { value: 'multi' as const, label: `Multi (${viewMode === 'assigned' ? assignedSplit.multi : unassignedSplit.multi})` },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { setSizeFilter(opt.value); if (opt.value !== 'singles') setSelectedFamilyKeys(new Set()) }}
                  className={`h-8 rounded-lg px-3 text-xs font-semibold transition ${sizeFilter === opt.value ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-tertiary hover:text-ink'}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {(partFilter || sectionFilter || sizeFilter !== 'all') && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
            >
              <X className="h-3.5 w-3.5" /> Clear Filters
            </button>
          )}
        </div>
        {partBreakdown.length === 0 ? (
          <p className="mt-4 text-sm text-ink-tertiary">{viewMode === 'assigned' ? 'No assigned families found.' : 'No unassigned families found.'}</p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {partBreakdown.map((g) => {
              const active = (g.part == null ? 'unassigned' : String(g.part)) === partFilter
              const votersCount = g.families.reduce((s, f) => s + f.members.length, 0)
              const singleCount = g.singleFamilies
              const multiVoters = g.families.reduce((s, f) => s + (f.members.length >= 2 ? f.members.length : 0), 0)
              return (
                <button
                  key={g.part == null ? 'unassigned' : String(g.part)}
                  type="button"
                  onClick={() => { handlePartSelect(active ? '' : (g.part == null ? 'unassigned' : String(g.part))); scrollToList() }}
                  className={`rounded-2xl border p-4 text-left transition ${active ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-100' : 'border-line bg-white hover:border-brand-300 hover:bg-brand-50/40'}`}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">{g.part != null ? `Part ${g.part}` : 'Unassigned Part'}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${g.families.length ? 'bg-rose-50 text-rose-600' : 'bg-muted text-ink-tertiary'}`}>
                      {g.families.length} famil{g.families.length === 1 ? 'y' : 'ies'}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                    <span className="font-semibold text-ink">{votersCount} voter{votersCount === 1 ? '' : 's'}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSizeFilter('singles')
                        handlePartSelect(g.part == null ? 'unassigned' : String(g.part))
                        scrollToList()
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return
                        e.preventDefault()
                        e.stopPropagation()
                        setSizeFilter('singles')
                        handlePartSelect(g.part == null ? 'unassigned' : String(g.part))
                        scrollToList()
                      }}
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${sizeFilter === 'singles' && active ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}
                    >
                      {singleCount} single
                    </span>
                    <span className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                      {g.multiFamilies} multi-family ({multiVoters} voters)
                    </span>
                  </div>
                  {g.sections.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {g.sections.map((s) => (
                        <span key={s} className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-ink-secondary">Sec {s}</span>
                      ))}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </section>

      <section ref={listRef} className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">
              {viewMode === 'assigned' ? 'Assigned Families' : 'Unassigned Families'}
              {partFilter ? ` · Part ${partFilter === 'unassigned' ? 'Unassigned' : partFilter}` : sizeFilter === 'singles' ? ' · All Parts' : ''}
              {sectionFilter ? ` / Sec ${sectionFilter}` : ''}
              {sizeFilter === 'singles' ? ' · Singles' : sizeFilter === 'multi' ? ' · Multi' : ''}
            </h2>
            <p className="text-xs text-ink-tertiary">
              {partFilter || sizeFilter === 'singles'
                ? `${displayFamilies.length.toLocaleString()} ${sizeFilter === 'singles' ? 'single voter' : `famil${displayFamilies.length === 1 ? 'y' : 'ies'}`}${displayFamilies.length === 1 && sizeFilter === 'singles' ? '' : sizeFilter === 'singles' ? 's' : ''} · ${displayVoterCount.toLocaleString()} voter${displayVoterCount === 1 ? '' : 's'}${!partFilter && sizeFilter === 'singles' ? ' across all parts' : ''}`
                : `${sizedViewFamilies.length.toLocaleString()} ${viewMode === 'assigned' ? 'assigned' : 'unassigned'} famil${sizedViewFamilies.length === 1 ? 'y' : 'ies'} across all parts`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary outline-none"
              aria-label="Filter by part"
              value={partFilter}
              onChange={(e) => handlePartSelect(e.target.value)}
            >
              <option value="">Select a part</option>
              {partOptions.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <select
              className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary outline-none disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
              aria-label="Filter by section"
              value={sectionFilter}
              disabled={!partFilter}
              onChange={(e) => setSectionFilter(e.target.value)}
            >
              <option value="">All Sections</option>
              {sectionOptions.map((s) => (
                <option key={s} value={String(s)}>Section {s}</option>
              ))}
            </select>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
              <input
                className="h-9 w-52 rounded-lg border border-line bg-white pl-8 pr-8 text-xs outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                placeholder="Search families..."
                value={familyQuery}
                onChange={(e) => setFamilyQuery(e.target.value)}
              />
              {familyQuery && (
                <button type="button" onClick={() => setFamilyQuery('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-ink-tertiary hover:text-ink-secondary" aria-label="Clear search">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {(partFilter || sectionFilter || familyQuery || sizeFilter !== 'all') && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-tertiary transition hover:bg-muted"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </button>
            )}
            <button
              type="button"
              disabled={reportFamilies.length === 0}
              onClick={() => setPrintModalOpen(true)}
              title={sizeFilter === 'singles'
                ? `Print ${reportFamilies.length} single voter${reportFamilies.length === 1 ? '' : 's'}${partFilter ? ` in Part ${partFilter === 'unassigned' ? 'Unassigned' : partFilter}` : ' across all parts'}`
                : partFilter
                  ? `Print the ${displayFamilies.length} ${viewMode === 'assigned' ? 'assigned' : 'unassigned'} famil${displayFamilies.length === 1 ? 'y' : 'ies'} shown for Part ${partFilter === 'unassigned' ? 'Unassigned' : partFilter}`
                  : `Print all ${viewMode === 'assigned' ? 'assigned' : 'unassigned'} families (no part selected)`}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Printer className="h-3.5 w-3.5" /> {sizeFilter === 'singles' ? 'Print Singles' : 'Print'}
            </button>
          </div>
        </div>

        {(partFilter || sizeFilter === 'singles') && viewMode === 'unassigned' && (
          <div className="flex flex-wrap items-end gap-3 border-b border-line bg-muted/50 px-5 py-4">
            <div className="min-w-[240px] flex-1">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Assign to Team Leader</label>
              {leaders.length === 0 ? (
                <p className="h-10 rounded-xl border border-line bg-white px-3 text-sm leading-10 text-ink-tertiary">No team leaders yet.</p>
              ) : (
                <div className="flex items-center gap-2">
                  <select
                    value={targetLeaderId}
                    onChange={(e) => setTargetLeaderId(e.target.value)}
                    className="h-10 flex-1 rounded-xl border border-line bg-white px-3 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="">Select a team leader...</option>
                    {sortedLeaders.map((tl) => (
                      <option key={tl.id} value={tl.id}>
                        {tl.name}{tl.epicNo ? ` (${tl.epicNo})` : ''}{tl.part_no != null ? ` · Part ${tl.part_no}` : ''}{tl.section != null ? ` / Sec ${tl.section}` : ''}
                      </option>
                    ))}
                  </select>
                  <div className="relative flex-shrink-0">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
                    <input
                      className="h-10 w-44 rounded-xl border border-line bg-white pl-8 pr-2 text-xs outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                      placeholder="Search leaders..."
                      value={leaderSearch}
                      onChange={(e) => setLeaderSearch(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {displayFamilies.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedFamilyKeys(allDisplayedSelected ? new Set() : new Set(displayFamilies.map((f) => f.key)))}
                  className="inline-flex h-9 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
                >
                  {allDisplayedSelected ? 'Clear Selection' : 'Select All'}
                </button>
              )}
              <button
                type="button"
                disabled={assigning || selectedFamilies.length === 0}
                onClick={() => void assignFamilies(selectedFamilies)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {assigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />} Assign Selected
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading {viewMode === 'assigned' ? 'assigned' : 'unassigned'} families...</div>
        ) : !partFilter && sizeFilter !== 'singles' ? (
          <div className="px-6 py-16 text-center text-sm text-ink-tertiary">
            {viewMode === 'assigned'
              ? (assignedFamilies.length === 0 ? 'No families have been assigned yet.' : 'Select a part above to view its assigned families, or choose Singles to list 1-member families across all parts.')
              : (unassignedFamilies.length === 0 ? 'Every family is either assigned to a team leader or parked under Shifted/Single.' : 'Select a part above to view its unassigned families, or choose Singles to list 1-member families across all parts.')}
          </div>
        ) : displayFamilies.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-ink-tertiary">
            No {viewMode === 'assigned' ? 'assigned' : 'unassigned'} {sizeFilter === 'singles' ? 'single voters' : 'families'} match the selected filters.
          </div>
        ) : (
          <div className="p-5">
            <p className="mb-4 text-xs text-ink-tertiary">
              {displayFamilies.length} {viewMode === 'assigned' ? 'assigned' : 'unassigned'} {sizeFilter === 'singles' ? `single voter${displayFamilies.length === 1 ? '' : 's'}` : `famil${displayFamilies.length === 1 ? 'y' : 'ies'}`} · {displayVoterCount} voter{displayVoterCount === 1 ? '' : 's'}
              {viewMode === 'unassigned' && targetLeader ? ` · Assigning to ${targetLeader.name}` : ''}
              {!partFilter && sizeFilter === 'singles' ? ' · grouped by part' : ''}
            </p>
            <div className="space-y-4">
              {displayFamilies.map((family, familyIndex) => {
                const head = family.headVoter ?? family.members[0] ?? null
                const selected = selectedFamilyKeys.has(family.key)
                const familyCurrentLeaderId = familyLeaderId(family)
                const familyCurrentLeader = familyCurrentLeaderId ? leaderById.get(familyCurrentLeaderId) : undefined
                const cardLeaderValue = cardLeaderByKey[family.key] ?? ''
                const showPartHeader = !partFilter && sizeFilter === 'singles' && (
                  familyIndex === 0 ||
                  (displayFamilies[familyIndex - 1]?.headVoter?.part_no ?? null) !== (head?.part_no ?? null)
                )
                return (
                  <div key={family.key} className="space-y-2">
                    {showPartHeader ? (
                      <p className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
                        {head?.part_no != null ? `Part ${head.part_no}` : 'Unassigned Part'}
                      </p>
                    ) : null}
                  <section
                    className={`overflow-hidden rounded-xl border bg-white transition ${selected ? 'border-brand-400 ring-2 ring-brand-100' : 'border-line'}`}
                  >
                    <div className={`flex flex-wrap items-center gap-3 border-b px-4 py-4 sm:px-5 ${selected ? 'bg-brand-50/60' : 'bg-muted/70'}`}>
                      <CheckboxUI checked={selected} onChange={() => toggleFamily(family.key)} />
                      {head && <VoterAvatar voter={head} photoUrl={resolvePhotoUrl(head)} />}
                      <div className="min-w-[200px] flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-700">
                            Family Head
                          </span>
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                            {family.members.length} member{family.members.length === 1 ? '' : 's'}
                          </span>
                          {viewMode === 'assigned' && familyCurrentLeader && (
                            <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                              Team Leader: {familyCurrentLeader.name}
                            </span>
                          )}
                          <ClassificationBadges
                            members={family.members}
                            head={head}
                            placeClub={placeClubById.get(familyPlaceByHead[familyHeadKey(head ?? family.members[0])] ?? '') ?? null}
                          />
                        </div>
                        <p className="mt-1 text-base font-semibold text-ink">{head?.name ?? 'Unknown head'}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-tertiary">
                          <span>EPIC: {head?.epic_no || '-'}</span>
                          <span>Part: {head?.part_no ?? '-'}</span>
                          <span>Sec: {head?.section ?? '-'}</span>
                        </div>
                      </div>
                      <div className="ml-auto flex flex-wrap items-center gap-2">
                        {leaders.length === 0 ? (
                          <p className="text-[11px] text-ink-tertiary">No team leaders yet.</p>
                        ) : (
                          <>
                            <select
                              className="h-8 w-44 rounded-lg border border-line bg-white px-2 text-[11px] font-semibold text-ink-secondary outline-none focus:border-brand-300"
                              aria-label={`Assign family of ${head?.name ?? family.head} to team leader`}
                              value={cardLeaderValue}
                              onChange={(e) => setCardLeaderByKey((prev) => ({ ...prev, [family.key]: e.target.value }))}
                            >
                              <option value="">{viewMode === 'assigned' ? 'Reassign to...' : 'Assign to...'}</option>
                              {sortedLeaders.map((tl) => (
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
                                if (viewMode === 'assigned') void reassignFamily(family, leaderId)
                                else void assignFamilies([family], leaderId)
                              }}
                              disabled={assigning || !cardLeaderValue}
                              className="inline-flex h-8 items-center gap-1 rounded-lg bg-brand-600 px-2.5 text-[11px] font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {assigning ? <Loader2 className="h-3 w-3 animate-spin" /> : viewMode === 'assigned' ? <ArrowLeftRight className="h-3 w-3" /> : <UserPlus className="h-3 w-3" />}
                              {viewMode === 'assigned' ? 'Reassign' : 'Assign'}
                            </button>
                          </>
                        )}
                      </div>
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
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </section>

      <ReportConfigModal
        title={listLabel}
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
        printDescription="Select columns and layout once. Download PDF saves the file immediately; Open print preview lets you choose a printer or Save as PDF."
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
