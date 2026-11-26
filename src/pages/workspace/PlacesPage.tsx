import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ArrowLeft, ChevronDown, Download, Loader2, MapPin, MoreHorizontal, Plus, Printer, Search, SlidersHorizontal, UserPlus, X } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { MobileSheet } from '../../components/common/MobileSheet'
import { usePersistentState } from '../../hooks/usePersistentState'
import { ReportConfigModal, type ReportFieldDef as ReportModalFieldDef, type ReportFieldItem } from '../../components/common/ReportConfigModal'
import { PlaceFamilyRoster } from '../../components/places/PlaceFamilyRoster'
import { FilterChip, PlaceScopeChips, PresenceFilterChips } from '../../components/places/PlacePresenceFilters'
import { useIsMobile } from '../../hooks/useIsMobile'
import type { PlaceClub, PresenceStatus } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import {
  OUTSIDE_MORMUGAO_AREA,
  PLACE_FAMILY_VOTER_COLUMNS,
  UNLABELLED_PLACE_ID,
  clubFamilies,
  familyGroupHeadKey,
  familyHeadKey,
  familyPlaceMap,
  fetchFamilyPlaceClubs,
  fetchPlaceClubs,
  fetchVotersByFamilyHeads,
  isOutsidePlaceArea,
  isOutsidePlaceClub,
  placeClubFullLabel,
  placeClubLabel,
  unclubFamilies,
  upsertPlaceClub,
  type SlimFamilyVoter,
} from '../../lib/placeClubs'
import {
  compactLookupValue,
  escapeIlikePattern,
  isLikelyEpicToken,
  tokenizeLookup,
} from '../../lib/searchUtils'
import {
  PAGE_SIZE,
  matchesLeader,
  matchesPart,
  matchesPresence,
  matchesSearch,
  matchesSize,
  parseLeaderFilter,
  parsePage,
  parsePlaceScope,
  parsePresenceFilter,
  parseSizeFilter,
  setOrDeleteParam,
} from '../../lib/placePresenceFilters'
import {
  buildSlimFamilies,
  distinctPartsFromFamilies,
  familyLeaderId,
  fetchAssignmentMap,
  fetchFamilyHeadIndex,
  unlabelledHeadsFromIndex,
  type SlimFamily,
} from '../../lib/placeWorkbench'
import {
  IN_MORMUGAO_NOTE_HELP,
  PRESENCE_NOTE_MAX_LENGTH,
  PRESENCE_OPTIONS,
  hasPresenceOverride,
  presenceLabel,
  presenceNoteOf,
  presenceNotePlaceholder,
} from '../../lib/presence'
import { forEachInChunk } from '../../lib/d1Query'
import {
  downloadPdfTable,
  exportRowsToExcel,
  handlePrint,
  type PrintStyleOptions,
  type ReportFieldDef,
} from '../../lib/reportBuilder'
import {
  fetchTeamLeadersFromApi,
  resolveTeamLeaderName,
  specialLeaderIdSet,
  type UnassignedLeaderOption,
} from '../../lib/teamLeaderCache'
import { voterCategoryLabel } from '../../lib/voterCategory'

interface PlaceReportRow {
  family: string
  role: string
  photo: string
  photoPath: string
  name: string
  epic: string
  part: string
  section: string
  house: string
  contact: string
  leader: string
  presence: string
  presenceNote: string
  category: string
  age: string
  gender: string
  relative: string
  relation: string
  sectionName: string
  ward: string
  contact2: string
}

const PLACE_REPORT_FIELD_DEFS: ReportModalFieldDef[] = [
  { key: 'family', label: 'Family' },
  { key: 'role', label: 'Role' },
  { key: 'photo', label: 'Photo' },
  { key: 'name', label: 'Name' },
  { key: 'epic', label: 'EPIC' },
  { key: 'part', label: 'Part' },
  { key: 'section', label: 'Section' },
  { key: 'house', label: 'House' },
  { key: 'contact', label: 'Contact' },
  { key: 'leader', label: 'Team leader' },
  { key: 'presence', label: 'Presence' },
  { key: 'presenceNote', label: 'Presence note' },
  { key: 'category', label: 'Category' },
  { key: 'age', label: 'Age' },
  { key: 'gender', label: 'Gender' },
  { key: 'relative', label: 'Relative' },
  { key: 'relation', label: 'Relation' },
  { key: 'sectionName', label: 'Section name' },
  { key: 'ward', label: 'Ward' },
  { key: 'contact2', label: 'Contact 2' },
]

const DEFAULT_PLACE_REPORT_FIELDS: ReportFieldItem[] = [
  { key: 'family', enabled: true },
  { key: 'role', enabled: true },
  { key: 'photo', enabled: true },
  { key: 'name', enabled: true },
  { key: 'epic', enabled: true },
  { key: 'part', enabled: true },
  { key: 'section', enabled: false },
  { key: 'house', enabled: false },
  { key: 'contact', enabled: true },
  { key: 'leader', enabled: true },
  { key: 'presence', enabled: true },
  { key: 'presenceNote', enabled: true },
  { key: 'category', enabled: false },
  { key: 'age', enabled: false },
  { key: 'gender', enabled: false },
  { key: 'relative', enabled: false },
  { key: 'relation', enabled: false },
  { key: 'sectionName', enabled: false },
  { key: 'ward', enabled: false },
  { key: 'contact2', enabled: false },
]

const PLACE_REPORT_GETTERS: Record<string, (row: PlaceReportRow) => string> = {
  family: (row) => row.family,
  role: (row) => row.role,
  photo: (row) => row.photo,
  name: (row) => row.name,
  epic: (row) => row.epic,
  part: (row) => row.part,
  section: (row) => row.section,
  house: (row) => row.house,
  contact: (row) => row.contact,
  leader: (row) => row.leader,
  presence: (row) => row.presence,
  presenceNote: (row) => row.presenceNote,
  category: (row) => row.category,
  age: (row) => row.age,
  gender: (row) => row.gender,
  relative: (row) => row.relative,
  relation: (row) => row.relation,
  sectionName: (row) => row.sectionName,
  ward: (row) => row.ward,
  contact2: (row) => row.contact2,
}

const HIDE_ASSIGNED_KEY = 'vote:places:hide-assigned-to-leaders'
const CLUBBED_MEMBER_COLUMNS = 'id,epic_no,family_head_epic'

async function signPlacePhotoUrls(paths: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(paths.filter(Boolean)))
  const resolved: Record<string, string> = {}
  for (let i = 0; i < unique.length; i += 80) {
    const batch = unique.slice(i, i + 80)
    const { data } = await supabase.storage.from('voter-photos').createSignedUrls(batch, 3600)
    if (!data) continue
    for (let j = 0; j < batch.length; j++) {
      const url = data[j]?.signedUrl
      if (url) resolved[batch[j]] = url
    }
  }
  return resolved
}

export function PlacesPage() {
  const { profile } = useAuth()
  const canEdit = profile?.role === 'admin' || profile?.can_edit === true
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  const scope = parsePlaceScope(searchParams.get('scope'))
  const presence = parsePresenceFilter(searchParams.get('presence'))
  const part = searchParams.get('part') ?? ''
  const leader = parseLeaderFilter(searchParams.get('leader'))
  const sizeFilter = parseSizeFilter(searchParams.get('size'))
  const familyQuery = searchParams.get('q') ?? ''
  const page = parsePage(searchParams.get('page'))
  const selectedKey = searchParams.get('place') || null
  const isUnlabelled = selectedKey === UNLABELLED_PLACE_ID || selectedKey === 'unlabelled'

  const patchParams = useCallback((updates: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(updates)) {
      setOrDeleteParam(next, key, value ?? '')
    }
    if (resetPage && !('page' in updates)) next.delete('page')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const [clubs, setClubs] = useState<PlaceClub[]>([])
  const [familyPlaceByHead, setFamilyPlaceByHead] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [placeQuery, setPlaceQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [newArea, setNewArea] = useState('')
  const [newChawl, setNewChawl] = useState('')
  const [newBuilding, setNewBuilding] = useState('')
  const [families, setFamilies] = useState<SlimFamily[]>([])
  const [familyLoading, setFamilyLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savingPresenceKey, setSavingPresenceKey] = useState<string | null>(null)
  const [voterToLeaderId, setVoterToLeaderId] = useState<Record<string, string>>({})
  const [leaderNameById, setLeaderNameById] = useState<Record<string, string>>({})
  const [leaderOptions, setLeaderOptions] = useState<UnassignedLeaderOption[]>([])
  const [specialIds, setSpecialIds] = useState<Set<string>>(new Set())
  const [selectedFamilyKeys, setSelectedFamilyKeys] = useState<Set<string>>(new Set())
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [placesSheetOpen, setPlacesSheetOpen] = useState(false)
  const [printOpen, setPrintOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [reportSelectedOnly, setReportSelectedOnly] = useState(false)
  const [reportFields, setReportFields] = useState<ReportFieldItem[]>(DEFAULT_PLACE_REPORT_FIELDS)
  const [hideAssigned, setHideAssigned] = usePersistentState<boolean>(HIDE_ASSIGNED_KEY, true)
  const [clubbedVoterIdsByHead, setClubbedVoterIdsByHead] = useState<Record<string, string[]>>({})
  const [headIndex, setHeadIndex] = useState<Array<{ id: string; head: string }>>([])
  const [actionsOpen, setActionsOpen] = useState(false)

  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(2)
  const [wizardSearch, setWizardSearch] = useState('')
  const [wizardResults, setWizardResults] = useState<SlimFamily[]>([])
  const [wizardLoading, setWizardLoading] = useState(false)
  const [wizardSelected, setWizardSelected] = useState<Set<string>>(new Set())
  const [wizardPresenceStatus, setWizardPresenceStatus] = useState<PresenceStatus | null>(null)
  const [wizardNote, setWizardNote] = useState('')
  const [wizardSkipPresence, setWizardSkipPresence] = useState(false)
  const [wizardMoveConfirm, setWizardMoveConfirm] = useState<{ heads: string[]; movingCount: number } | null>(null)
  const [wizardSaving, setWizardSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nextClubs, links, apiRows] = await Promise.all([
        fetchPlaceClubs(),
        fetchFamilyPlaceClubs(),
        fetchTeamLeadersFromApi(),
      ])
      setClubs(nextClubs)
      setFamilyPlaceByHead(familyPlaceMap(links))
      const names: Record<string, string> = {}
      const options: UnassignedLeaderOption[] = []
      const special = specialLeaderIdSet(apiRows)
      for (const row of apiRows) {
        const name = resolveTeamLeaderName(row, row.voter_name ? { name: row.voter_name } : null, '')
        if (name) names[row.id] = name
        if (!special.has(row.id) && name) {
          options.push({
            id: row.id,
            name,
            epicNo: row.epic_no ?? '',
            part_no: row.part_no ?? row.voter_part_no ?? null,
            section: row.section ?? row.voter_section ?? null,
            notes: row.notes ?? null,
          })
        }
      }
      options.sort((a, b) => a.name.localeCompare(b.name))
      setLeaderNameById(names)
      setLeaderOptions(options)
      setSpecialIds(special)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load places.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const index = await fetchFamilyHeadIndex()
        if (!cancelled) setHeadIndex(index)
      } catch {
        if (!cancelled) setHeadIndex([])
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const heads = Object.keys(familyPlaceByHead)
    if (!heads.length) {
      setClubbedVoterIdsByHead({})
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const rows = await fetchVotersByFamilyHeads(heads, CLUBBED_MEMBER_COLUMNS)
        if (cancelled) return
        const byHead: Record<string, string[]> = {}
        for (const row of rows) {
          const head = familyHeadKey(row)
          if (!head) continue
          const list = byHead[head]
          if (list) list.push(row.id)
          else byHead[head] = [row.id]
        }
        setClubbedVoterIdsByHead(byHead)
      } catch {
        if (!cancelled) setClubbedVoterIdsByHead({})
      }
    })()
    return () => { cancelled = true }
  }, [familyPlaceByHead])

  const unlabelledIndex = useMemo(
    () => unlabelledHeadsFromIndex(headIndex, familyPlaceByHead),
    [headIndex, familyPlaceByHead],
  )

  const clubsById = useMemo(() => new Map(clubs.map((club) => [club.id, club])), [clubs])

  const totalFamilyCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const clubId of Object.values(familyPlaceByHead)) {
      map.set(clubId, (map.get(clubId) ?? 0) + 1)
    }
    return map
  }, [familyPlaceByHead])

  const totalVoterCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const [head, clubId] of Object.entries(familyPlaceByHead)) {
      const count = clubbedVoterIdsByHead[head]?.length || 1
      map.set(clubId, (map.get(clubId) ?? 0) + count)
    }
    return map
  }, [familyPlaceByHead, clubbedVoterIdsByHead])

  const scopedClubs = useMemo(() => clubs.filter((club) => {
    if (scope === 'all') return true
    return scope === 'outside' ? isOutsidePlaceClub(club) : !isOutsidePlaceClub(club)
  }), [clubs, scope])

  const areaSuggestions = useMemo(() => (
    Array.from(new Set(scopedClubs.map((club) => (club.area ?? '').trim()).filter(Boolean))).slice(0, 6)
  ), [scopedClubs])

  const placeRows = useMemo(() => {
    type PlaceRow = {
      key: string
      kind: 'unlabelled' | 'club'
      label: string
      fullLabel: string
      families: number
      voters: number
      club: PlaceClub | null
    }
    const token = placeQuery.trim().toLowerCase()
    const matches = (text: string) => !token || text.toLowerCase().includes(token)
    const unlabelled: PlaceRow = {
      key: UNLABELLED_PLACE_ID,
      kind: 'unlabelled',
      label: 'Unlabelled',
      fullLabel: 'Unlabelled',
      families: unlabelledIndex.familyCount,
      voters: unlabelledIndex.voterCount,
      club: null,
    }
    const clubRows: PlaceRow[] = scopedClubs
      .map((club) => ({
        key: club.id,
        kind: 'club' as const,
        label: placeClubLabel(club),
        fullLabel: placeClubFullLabel(club),
        families: totalFamilyCounts.get(club.id) ?? 0,
        voters: totalVoterCounts.get(club.id) ?? 0,
        club,
      }))
      .filter((row) => matches(row.label) || matches(row.fullLabel) || matches(row.club?.area ?? ''))
      .sort((a, b) => {
        const diff = b.families - a.families
        if (diff) return diff
        return a.fullLabel.localeCompare(b.fullLabel)
      })
    return matches('Unlabelled') ? [unlabelled, ...clubRows] : clubRows
  }, [placeQuery, scopedClubs, totalFamilyCounts, totalVoterCounts, unlabelledIndex.familyCount, unlabelledIndex.voterCount])

  const selectedClub = !isUnlabelled && selectedKey ? clubsById.get(selectedKey) ?? null : null
  const hasSelection = isUnlabelled || Boolean(selectedClub)
  const heading = isUnlabelled
    ? 'Unlabelled'
    : selectedClub
      ? placeClubFullLabel(selectedClub)
      : 'Pick a place'

  useEffect(() => {
    if (!hasSelection) {
      setFamilies([])
      setSelectedFamilyKeys(new Set())
      setFamilyLoading(false)
      setVoterToLeaderId({})
      return
    }
    const heads = isUnlabelled
      ? unlabelledIndex.heads
      : selectedClub
        ? Object.entries(familyPlaceByHead).filter(([, clubId]) => clubId === selectedClub.id).map(([head]) => head)
        : []
    if (!heads.length) {
      setFamilies([])
      setSelectedFamilyKeys(new Set())
      setFamilyLoading(false)
      setVoterToLeaderId({})
      return
    }
    let cancelled = false
    setFamilyLoading(true)
    void (async () => {
      try {
        const rows = await fetchVotersByFamilyHeads(heads, PLACE_FAMILY_VOTER_COLUMNS)
        if (cancelled) return
        const nextFamilies = buildSlimFamilies(rows)
        setFamilies(nextFamilies)
        const map = await fetchAssignmentMap(nextFamilies.flatMap((family) => family.members.map((member) => member.id)))
        if (!cancelled) setVoterToLeaderId(map)
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Could not load place families.')
      } finally {
        if (!cancelled) setFamilyLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [hasSelection, familyPlaceByHead, isUnlabelled, selectedClub, unlabelledIndex.heads])

  const searchVoterFamilies = useCallback(async (trimmed: string): Promise<SlimFamily[]> => {
    const tokens = tokenizeLookup(trimmed)
    let matches: SlimFamilyVoter[]
    if (tokens.length === 1 && isLikelyEpicToken(tokens[0])) {
      const epicToken = compactLookupValue(tokens[0])
      const { data: exactRow, error } = await supabase.from('voters').select(PLACE_FAMILY_VOTER_COLUMNS).eq('epic_no', epicToken).maybeSingle()
      if (error) throw new Error(error.message)
      matches = exactRow ? [exactRow as unknown as SlimFamilyVoter] : []
    } else {
      const sp = `%${escapeIlikePattern(trimmed).replace(/\s+/g, '%')}%`
      const filters = [
        `name.ilike.${sp}`,
        `epic_no.ilike.${sp}`,
        `family_head_epic.ilike.${sp}`,
        `relative_name.ilike.${sp}`,
        `house_no.ilike.${sp}`,
        `contact_no_1.ilike.${sp}`,
        `contact_no_2.ilike.${sp}`,
      ]
      const partNum = Number(trimmed)
      const namedReq = supabase.from('voters').select(PLACE_FAMILY_VOTER_COLUMNS).or(filters.join(',')).limit(40)
      if (Number.isInteger(partNum) && String(partNum) === trimmed) {
        const [{ data: named, error: namedError }, { data: parted, error: partError }] = await Promise.all([
          namedReq,
          supabase.from('voters').select(PLACE_FAMILY_VOTER_COLUMNS).eq('part_no', partNum).limit(40),
        ])
        if (namedError) throw new Error(namedError.message)
        if (partError) throw new Error(partError.message)
        matches = [...((named as unknown as SlimFamilyVoter[] | null) ?? []), ...((parted as unknown as SlimFamilyVoter[] | null) ?? [])]
      } else {
        const { data, error } = await namedReq
        if (error) throw new Error(error.message)
        matches = (data as unknown as SlimFamilyVoter[] | null) ?? []
      }
    }
    const keys = Array.from(new Set(matches.map((voter) => (voter.family_head_epic ? voter.family_head_epic.trim() : voter.epic_no).trim()).filter(Boolean)))
    const related = keys.length ? await fetchVotersByFamilyHeads(keys, PLACE_FAMILY_VOTER_COLUMNS) : []
    return buildSlimFamilies(related.length ? related : matches)
  }, [])

  useEffect(() => {
    const trimmed = wizardSearch.trim()
    if (!trimmed || !wizardOpen) {
      setWizardResults([])
      setWizardLoading(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        setWizardLoading(true)
        try {
          const grouped = await searchVoterFamilies(trimmed)
          if (!cancelled) setWizardResults(grouped)
        } catch (error) {
          if (!cancelled) toast.error(error instanceof Error ? error.message : 'Could not search families.')
        } finally {
          if (!cancelled) setWizardLoading(false)
        }
      })()
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [wizardSearch, wizardOpen, searchVoterFamilies])

  const createPlace = async () => {
    if (!newArea.trim()) {
      toast.error('Area is required.')
      return
    }
    setSaving(true)
    try {
      const club = await upsertPlaceClub({
        area: newArea,
        chawl: newChawl,
        building: newBuilding,
        createdBy: profile?.id ?? null,
      })
      setClubs((current) => current.some((row) => row.id === club.id) ? current : [...current, club].sort((a, b) => placeClubFullLabel(a).localeCompare(placeClubFullLabel(b))))
      patchParams({
        place: club.id,
        scope: isOutsidePlaceArea(club.area) ? 'outside' : scope === 'outside' ? 'all' : scope,
        q: null,
        presence: null,
        part: null,
        leader: null,
        size: null,
      })
      setNewArea('')
      setNewChawl('')
      setNewBuilding('')
      setCreateOpen(false)
      toast.success('Place saved.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create place.')
    } finally {
      setSaving(false)
    }
  }

  const filteredFamilies = useMemo(() => {
    const token = familyQuery.trim()
    return families.filter((family) => {
      const head = family.headVoter ?? family.members[0]
      const leaderId = familyLeaderId(family, voterToLeaderId, specialIds)
      if (!isUnlabelled && hideAssigned && leaderId) return false
      if (!matchesPresence(head?.presence_status, presence)) return false
      if (!matchesPart(head?.part_no, part)) return false
      if (!matchesLeader(leaderId, leader, specialIds)) return false
      if (!matchesSize(family.members.length, sizeFilter)) return false
      if (!matchesSearch(
        family.members.flatMap((member) => [
          member.name,
          member.epic_no,
          member.part_no,
          member.relative_name,
          member.house_no,
          member.contact_no_1,
          member.contact_no_2,
          presenceNoteOf(member),
        ]).join(' '),
        token,
      )) return false
      return true
    })
  }, [families, familyQuery, hideAssigned, isUnlabelled, leader, part, presence, sizeFilter, specialIds, voterToLeaderId])

  const parts = useMemo(() => distinctPartsFromFamilies(families), [families])
  const pageCount = Math.max(1, Math.ceil(filteredFamilies.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pagedFamilies = filteredFamilies.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const selectedPlaceFamilies = filteredFamilies.filter((family) => selectedFamilyKeys.has(family.key))
  const placeStats = useMemo(() => {
    let voters = 0
    let unassigned = 0
    for (const family of filteredFamilies) {
      voters += family.members.length
      if (!familyLeaderId(family, voterToLeaderId, specialIds)) unassigned += 1
    }
    return { voters, unassigned }
  }, [filteredFamilies, specialIds, voterToLeaderId])

  const activeFilterCount = (presence !== 'all' ? 1 : 0) + (part ? 1 : 0) + (leader !== 'all' ? 1 : 0) + (sizeFilter !== 'all' ? 1 : 0) + (!isUnlabelled && !hideAssigned ? 1 : 0)

  const unclubSelected = async () => {
    if (!selectedPlaceFamilies.length) {
      toast.error('Select one or more families first.')
      return
    }
    const heads = selectedPlaceFamilies.map((family) => familyGroupHeadKey(family)).filter(Boolean)
    setSaving(true)
    try {
      await unclubFamilies(heads)
      setFamilyPlaceByHead((current) => {
        const next = { ...current }
        for (const head of heads) delete next[head]
        return next
      })
      setSelectedFamilyKeys(new Set())
      toast.success(`Unclubbed ${heads.length} famil${heads.length === 1 ? 'y' : 'ies'}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not unclub families.')
    } finally {
      setSaving(false)
    }
  }

  const moveSelected = async (placeClubId: string) => {
    if (!selectedPlaceFamilies.length) {
      toast.error('Select one or more families first.')
      return
    }
    const heads = selectedPlaceFamilies.map((family) => familyGroupHeadKey(family)).filter(Boolean)
    setSaving(true)
    try {
      await clubFamilies(heads, placeClubId)
      setFamilyPlaceByHead((current) => {
        const next = { ...current }
        for (const head of heads) next[head] = placeClubId
        return next
      })
      setSelectedFamilyKeys(new Set())
      toast.success(`Moved ${heads.length} famil${heads.length === 1 ? 'y' : 'ies'}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not move families.')
    } finally {
      setSaving(false)
    }
  }

  const unclubFamily = async (family: SlimFamily) => {
    const head = familyGroupHeadKey(family)
    if (!head) return
    setSaving(true)
    try {
      await unclubFamilies([head])
      setFamilyPlaceByHead((current) => {
        const next = { ...current }
        delete next[head]
        return next
      })
      setSelectedFamilyKeys((current) => {
        const next = new Set(current)
        next.delete(family.key)
        return next
      })
      toast.success('Unclubbed 1 family.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not unclub family.')
    } finally {
      setSaving(false)
    }
  }

  const moveFamily = async (family: SlimFamily, placeClubId: string) => {
    const head = familyGroupHeadKey(family)
    if (!head) return
    setSaving(true)
    try {
      await clubFamilies([head], placeClubId)
      setFamilyPlaceByHead((current) => ({ ...current, [head]: placeClubId }))
      toast.success('Moved 1 family.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not move family.')
    } finally {
      setSaving(false)
    }
  }

  const patchVoter = (voterId: string, patch: Partial<SlimFamilyVoter>) => {
    setFamilies((current) => current.map((family) => ({
      ...family,
      headVoter: family.headVoter?.id === voterId ? { ...family.headVoter, ...patch } : family.headVoter,
      members: family.members.map((member) => (member.id === voterId ? { ...member, ...patch } : member)),
    })))
  }

  const patchFamilyPresence = (familyKey: string, targetIds: string[], status: PresenceStatus | null, note: string | null) => {
    const ids = new Set(targetIds)
    setFamilies((current) => current.map((family) => {
      if (family.key !== familyKey) return family
      return {
        ...family,
        headVoter: family.headVoter && ids.has(family.headVoter.id)
          ? { ...family.headVoter, presence_status: status, presence_note: note }
          : family.headVoter,
        members: family.members.map((member) => (
          ids.has(member.id) ? { ...member, presence_status: status, presence_note: note } : member
        )),
      }
    }))
  }

  const saveFamilyPresence = async (family: SlimFamily, status: PresenceStatus | null, note: string) => {
    const head = family.headVoter ?? family.members[0]
    if (!head) {
      toast.error('This family has no members.')
      return
    }
    const trimmed = status ? note.trim() : ''
    const patch = { presence_status: status, presence_note: trimmed || null }
    const targets = family.members.filter((member) => member.id === head.id || !hasPresenceOverride(member, head))
    setSavingPresenceKey(family.key)
    try {
      await forEachInChunk(targets.map((member) => member.id), async (chunk) => {
        const { error } = await supabase.from('voters').update(patch).in('id', chunk)
        if (error) throw new Error(error.message)
      })
      patchFamilyPresence(family.key, targets.map((member) => member.id), status, trimmed || null)
      toast.success(status ? `Presence set to ${presenceLabel(status)}.` : 'Presence cleared.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update presence.')
    } finally {
      setSavingPresenceKey(null)
    }
  }

  const openWizard = () => {
    if (!canEdit || !selectedClub || isUnlabelled) return
    setWizardOpen(true)
    setWizardStep(2)
    setWizardSearch('')
    setWizardResults([])
    setWizardSelected(new Set())
    setWizardMoveConfirm(null)
  }

  const closeWizard = () => {
    setWizardOpen(false)
    setWizardSearch('')
    setWizardResults([])
    setWizardSelected(new Set())
    setWizardMoveConfirm(null)
    setWizardPresenceStatus(null)
    setWizardNote('')
    setWizardSkipPresence(false)
  }

  const selectedWizardFamilies = wizardResults.filter((family) => wizardSelected.has(family.key))

  const goToWizardPresence = () => {
    if (!selectedWizardFamilies.length) return
    const heads = selectedWizardFamilies.map((family) => familyGroupHeadKey(family)).filter(Boolean)
    const movingCount = heads.filter((head) => familyPlaceByHead[head] && familyPlaceByHead[head] !== selectedClub?.id).length
    if (movingCount) {
      setWizardMoveConfirm({ heads, movingCount })
      return
    }
    setWizardStep(3)
  }

  const addWizardFamilies = async () => {
    if (!selectedClub || !selectedWizardFamilies.length) return
    if (!wizardPresenceStatus && !wizardSkipPresence) {
      toast.error('Choose presence or skip presence.')
      return
    }
    const heads = selectedWizardFamilies.map((family) => familyGroupHeadKey(family)).filter(Boolean)
    if (!heads.length) return
    setWizardSaving(true)
    try {
      await clubFamilies(heads, selectedClub.id)
      let presenceError: string | null = null
      if (!wizardSkipPresence && wizardPresenceStatus) {
        const trimmed = wizardNote.trim()
        const patch = { presence_status: wizardPresenceStatus, presence_note: trimmed || null }
        const targetIds: string[] = []
        for (const family of selectedWizardFamilies) {
          const head = family.headVoter ?? family.members[0]
          for (const member of family.members) {
            if (member.id === head?.id || !hasPresenceOverride(member, head)) targetIds.push(member.id)
          }
        }
        try {
          await forEachInChunk(targetIds, async (chunk) => {
            const { error } = await supabase.from('voters').update(patch).in('id', chunk)
            if (error) throw new Error(error.message)
          })
        } catch (error) {
          presenceError = error instanceof Error ? error.message : 'Could not update presence.'
        }
      }
      setFamilyPlaceByHead((current) => {
        const next = { ...current }
        for (const head of heads) next[head] = selectedClub.id
        return next
      })
      if (presenceError) {
        toast.error(`Families added, but presence was not saved: ${presenceError}`)
      } else {
        toast.success(`Added ${heads.length} famil${heads.length === 1 ? 'y' : 'ies'} to ${placeClubLabel(selectedClub)}.`)
      }
      setWizardStep(2)
      setWizardSearch('')
      setWizardResults([])
      setWizardSelected(new Set())
      setWizardMoveConfirm(null)
      setSelectedFamilyKeys(new Set())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add families.')
    } finally {
      setWizardSaving(false)
    }
  }

  const buildReportRows = useCallback((includeMembers: boolean, selectedOnly: boolean, photoUrls: Record<string, string> = {}): PlaceReportRow[] => {
    const source = selectedOnly && selectedPlaceFamilies.length ? selectedPlaceFamilies : filteredFamilies
    const rows: PlaceReportRow[] = []
    for (const family of source) {
      const head = family.headVoter ?? family.members[0]
      const familyName = head?.name ?? family.head
      const leaderId = familyLeaderId(family, voterToLeaderId, specialIds)
      const leaderName = leaderId ? (leaderNameById[leaderId] || 'Team leader') : 'Unassigned'
      const members = includeMembers ? family.members : (head ? [head] : [])
      for (const member of members) {
        const isHead = head != null && member.id === head.id
        const photoPath = member.photo_url ?? ''
        rows.push({
          family: familyName,
          role: isHead ? 'Head' : 'Member',
          photo: photoPath ? (photoUrls[photoPath] ?? '') : '',
          photoPath,
          name: member.name,
          epic: member.epic_no || '',
          part: member.part_no != null ? String(member.part_no) : '',
          section: member.section != null ? String(member.section) : '',
          house: member.house_no || '',
          contact: member.contact_no_1 || member.contact_no_2 || '',
          leader: leaderName,
          presence: presenceLabel(member.presence_status) ?? 'Not set',
          presenceNote: presenceNoteOf(member),
          category: voterCategoryLabel(member.voter_category) ?? '',
          age: member.age != null ? String(member.age) : '',
          gender: member.gender ?? '',
          relative: member.relative_name ?? '',
          relation: member.relative_relation ?? '',
          sectionName: member.section_name ?? '',
          ward: member.ward_no != null ? String(member.ward_no) : '',
          contact2: member.contact_no_2 ?? '',
        })
      }
    }
    return rows
  }, [filteredFamilies, leaderNameById, selectedPlaceFamilies, specialIds, voterToLeaderId])

  const reportMeta = `${filteredFamilies.length} families · ${placeStats.voters} voters · ${placeStats.unassigned} unassigned`

  const enabledReportFields = (items: ReportFieldItem[]): ReportFieldDef<PlaceReportRow>[] =>
    items.filter((item) => item.enabled).map((item) => ({
      key: item.key,
      label: PLACE_REPORT_FIELD_DEFS.find((def) => def.key === item.key)?.label ?? item.key,
      getValue: PLACE_REPORT_GETTERS[item.key] ?? ((row) => (row as unknown as Record<string, string>)[item.key] ?? ''),
    }))

  const closeReportModals = () => {
    setPrintOpen(false)
    setExportOpen(false)
  }

  const handlePrintConfirm = (fields: ReportFieldItem[], includeMembers: boolean, style: PrintStyleOptions) => {
    setReportFields(fields)
    const includePhotos = fields.some((item) => item.key === 'photo' && item.enabled)
    closeReportModals()
    void (async () => {
      const draft = buildReportRows(includeMembers, reportSelectedOnly)
      if (!draft.length) {
        toast.error('No families to print.')
        return
      }
      const photoUrls = includePhotos ? await signPlacePhotoUrls(draft.map((row) => row.photoPath)) : {}
      const rows = includePhotos ? buildReportRows(includeMembers, reportSelectedOnly, photoUrls) : draft
      handlePrint({
        rows,
        fields: enabledReportFields(fields),
        title: heading,
        meta: `${reportMeta} · ${new Date().toLocaleString()}`,
        photoResolver: includePhotos ? (row) => row.photo : undefined,
        groupBy: { groupBy: 'family', resolve: (row) => row.family },
      }, style)
    })()
  }

  const handlePdfDownload = (fields: ReportFieldItem[], includeMembers: boolean, style: PrintStyleOptions) => {
    setReportFields(fields)
    const includePhotos = fields.some((item) => item.key === 'photo' && item.enabled)
    closeReportModals()
    void (async () => {
      const draft = buildReportRows(includeMembers, reportSelectedOnly)
      if (!draft.length) {
        toast.error('No families to download.')
        return
      }
      const photoUrls = includePhotos ? await signPlacePhotoUrls(draft.map((row) => row.photoPath)) : {}
      const rows = includePhotos ? buildReportRows(includeMembers, reportSelectedOnly, photoUrls) : draft
      const enabled = enabledReportFields(fields)
      await downloadPdfTable({
        title: heading,
        summary: [
          ['Place', heading],
          ['Families', String(filteredFamilies.length)],
          ['Voters', String(rows.length)],
          ['Generated', new Date().toLocaleString()],
        ],
        headers: enabled.map((field) => field.label),
        rows: rows.map((row) => enabled.map((field) => field.getValue(row))),
        fieldKeys: enabled.map((field) => field.key),
        fontSize: style.fontSize,
        boldText: style.boldText,
        fileName: `place-${heading.replace(/[^\w]+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf`,
      })
      toast.success('PDF downloaded.')
    })()
  }

  const handleExportConfirm = (fields: ReportFieldItem[], includeMembers: boolean, style: PrintStyleOptions) => {
    setReportFields(fields)
    const rows = buildReportRows(includeMembers, reportSelectedOnly)
    if (!rows.length) {
      toast.error('No families to export.')
      return
    }
    closeReportModals()
    const exportFields = enabledReportFields(fields).map((field) => (
      field.key === 'photo' ? { ...field, getValue: (row: PlaceReportRow) => (row.photoPath ? 'Photo' : '') } : field
    ))
    void exportRowsToExcel({
      rows,
      fields: exportFields,
      fileName: `place-${heading.replace(/[^\w]+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}`,
      title: heading,
      meta: reportMeta,
      groupBy: { groupBy: 'family', resolve: (row) => row.family },
    }, style)
  }

  const selectPlace = (key: string) => {
    patchParams({ place: key, q: null, presence: null, part: null, leader: null, size: null })
    setPlacesSheetOpen(false)
    setFiltersOpen(false)
    setWizardOpen(false)
    setActionsOpen(false)
    setSelectedFamilyKeys(new Set())
    setWizardPresenceStatus(null)
    setWizardNote('')
    setWizardSkipPresence(false)
  }

  const changePlace = () => {
    setWizardOpen(false)
    setWizardPresenceStatus(null)
    setWizardNote('')
    setWizardSkipPresence(false)
    if (isMobile) setPlacesSheetOpen(true)
  }

  const reportExtra = (
    <label className="flex h-9 cursor-pointer select-none items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm text-ink-secondary">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-line text-brand-600"
        checked={reportSelectedOnly}
        onChange={(event) => setReportSelectedOnly(event.target.checked)}
        disabled={!selectedPlaceFamilies.length}
      />
      Selected families only{selectedPlaceFamilies.length ? ` (${selectedPlaceFamilies.length})` : ''}
    </label>
  )

  const placePicker = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-line p-3">
        <div className="flex items-center justify-between gap-2">
          <PlaceScopeChips value={scope} onChange={(value) => patchParams({ scope: value === 'all' ? null : value, place: null })} />
          {canEdit ? (
            <button
              type="button"
              onClick={() => setCreateOpen((open) => !open)}
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition ${createOpen ? 'border-brand-600 bg-brand-600 text-white' : 'border-line text-ink-secondary hover:bg-muted'}`}
              aria-label="New place"
              title="New place"
            >
              {createOpen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            </button>
          ) : null}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
          <input
            className="h-9 w-full rounded-lg border border-line bg-white pl-8 pr-3 text-sm outline-none focus:border-brand-300"
            placeholder="Search places"
            value={placeQuery}
            onChange={(event) => setPlaceQuery(event.target.value)}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-medium text-ink-tertiary">Showing {placeRows.length} of {scopedClubs.length + 1} places</p>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-tertiary" /> : null}
        </div>
        {canEdit && createOpen ? (
          <div className="space-y-2 rounded-lg border border-line bg-muted p-2.5">
            <input className="h-8 w-full rounded-md border border-line px-2.5 text-sm outline-none" placeholder={`Area (${OUTSIDE_MORMUGAO_AREA} or local)`} value={newArea} onChange={(event) => setNewArea(event.target.value)} />
            <input className="h-8 w-full rounded-md border border-line px-2.5 text-sm outline-none" placeholder="Chawl / locality" value={newChawl} onChange={(event) => setNewChawl(event.target.value)} />
            <input className="h-8 w-full rounded-md border border-line px-2.5 text-sm outline-none" placeholder="Building" value={newBuilding} onChange={(event) => setNewBuilding(event.target.value)} />
            <button
              type="button"
              disabled={saving}
              onClick={() => void createPlace()}
              className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-brand-600 px-3 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Save place
            </button>
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {placeRows.map((row) => {
          const active = row.kind === 'unlabelled' ? isUnlabelled : selectedKey === row.key
          return (
            <button
              key={row.key}
              type="button"
              onClick={() => selectPlace(row.key)}
              className={`mb-0.5 flex w-full items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                active
                  ? row.kind === 'unlabelled' ? 'bg-amber-50 ring-1 ring-amber-200' : 'bg-brand-50 ring-1 ring-brand-200'
                  : row.kind === 'unlabelled' ? 'hover:bg-amber-50' : 'hover:bg-muted'
              }`}
            >
              <span className="min-w-0">
                <span className={`block truncate text-sm ${active ? 'font-semibold' : 'font-medium'} ${row.kind === 'unlabelled' ? 'text-amber-800' : active ? 'text-brand-800' : 'text-ink'}`} title={row.label}>
                  {row.label}
                </span>
                {row.kind === 'club' && row.fullLabel !== row.label ? (
                  <span className="mt-0.5 block truncate text-[10px] text-ink-tertiary" title={row.fullLabel}>{row.fullLabel}</span>
                ) : null}
              </span>
              <span className="shrink-0 pt-0.5 text-[11px] font-semibold tabular-nums text-ink-tertiary">
                {row.families} fam · {row.voters} vot
              </span>
            </button>
          )
        })}
        {!placeRows.length ? (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
            {clubs.length ? 'No places match search.' : 'No places yet.'}
          </p>
        ) : null}
      </div>
    </div>
  )

  return (
    <div className="space-y-4 pb-10">
      <Link to="/team-leaders" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-tertiary transition hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> Back to Team Leaders
      </Link>

      <PageHeader
        title="Places"
        description="Pick a place, add families, then set presence and a full address note. Unlabelled is the inbox of families with no place yet."
      />

      <section className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start">
        <aside className="hidden min-w-0 overflow-hidden rounded-xl border border-line bg-white lg:sticky lg:top-4 lg:flex lg:h-[calc(100vh-7rem)] lg:max-h-[calc(100vh-7rem)] lg:min-h-0 lg:flex-col">
          {placePicker}
        </aside>

        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="border-b border-line px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPlacesSheetOpen(true)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-semibold text-ink-secondary lg:hidden"
                  >
                    <MapPin className="h-3.5 w-3.5" /> Places
                  </button>
                  <h2 className="truncate text-base font-semibold text-ink">{heading}</h2>
                </div>
                {hasSelection ? (
                  <p className="mt-0.5 text-xs text-ink-tertiary">
                    {filteredFamilies.length.toLocaleString()} families · {placeStats.voters.toLocaleString()} voters · {placeStats.unassigned.toLocaleString()} unassigned
                    {isUnlabelled ? ' · select families to move them' : ''}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-ink-tertiary">Pick a place from the list.</p>
                )}
              </div>
              {hasSelection ? (
                <div className="flex items-center gap-2">
                  {canEdit && selectedClub && !isUnlabelled ? (
                    <button
                      type="button"
                      onClick={openWizard}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-2.5 text-xs font-semibold text-white transition hover:bg-brand-700"
                    >
                      <UserPlus className="h-3.5 w-3.5" /> Add families
                    </button>
                  ) : null}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setActionsOpen((open) => !open)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" /> Report
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    {actionsOpen ? (
                      <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-line bg-white py-1">
                        <button
                          type="button"
                          disabled={!filteredFamilies.length}
                          onClick={() => { setActionsOpen(false); setReportSelectedOnly(false); setPrintOpen(true) }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-secondary hover:bg-muted disabled:opacity-50"
                        >
                          <Printer className="h-3.5 w-3.5" /> Print
                        </button>
                        <button
                          type="button"
                          disabled={!filteredFamilies.length}
                          onClick={() => { setActionsOpen(false); setReportSelectedOnly(false); setExportOpen(true) }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-secondary hover:bg-muted disabled:opacity-50"
                        >
                          <Download className="h-3.5 w-3.5" /> Export
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
            {hasSelection ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div className="relative min-w-[12rem] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
                  <input
                    className="h-8 w-full rounded-lg border border-line bg-white pl-8 pr-3 text-sm outline-none focus:border-brand-300"
                    placeholder="Search name, EPIC, note"
                    value={familyQuery}
                    onChange={(event) => patchParams({ q: event.target.value || null })}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setFiltersOpen((open) => !open)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition ${filtersOpen || activeFilterCount ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-white text-ink-secondary hover:bg-muted'}`}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Filters
                  {activeFilterCount ? <span className="rounded-full bg-white/20 px-1.5">{activeFilterCount}</span> : null}
                </button>
                {isUnlabelled ? <span className="text-xs text-ink-tertiary">Select families, then use Move to a place.</span> : null}
              </div>
            ) : null}
            {filtersOpen && hasSelection ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2">
                <PresenceFilterChips value={presence} onChange={(value) => patchParams({ presence: value === 'all' ? null : value })} />
                <select
                  className="h-8 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary outline-none"
                  value={part}
                  onChange={(event) => patchParams({ part: event.target.value || null })}
                >
                  <option value="">All parts</option>
                  {parts.map((value) => (
                    <option key={value} value={value}>Part {value}</option>
                  ))}
                </select>
                <select
                  className="h-8 min-w-[10rem] rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary outline-none"
                  value={leader}
                  onChange={(event) => patchParams({ leader: event.target.value === 'all' ? null : event.target.value })}
                >
                  <option value="all">All leaders</option>
                  <option value="unassigned">Unassigned</option>
                  {leaderOptions.map((row) => (
                    <option key={row.id} value={row.id}>{row.name}</option>
                  ))}
                </select>
                <select
                  className="h-8 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary outline-none"
                  value={sizeFilter}
                  onChange={(event) => patchParams({ size: event.target.value === 'all' ? null : event.target.value })}
                >
                  <option value="all">All sizes</option>
                  <option value="singles">Singles</option>
                  <option value="multi">Multi</option>
                </select>
                {!isUnlabelled ? (
                  <label className="inline-flex h-8 cursor-pointer select-none items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-line text-brand-600"
                      checked={hideAssigned}
                      onChange={(event) => setHideAssigned(event.target.checked)}
                    />
                    Hide assigned
                  </label>
                ) : null}
                {activeFilterCount ? (
                  <FilterChip active={false} onClick={() => {
                    patchParams({ presence: null, part: null, leader: null, size: null })
                    setHideAssigned(true)
                  }}>
                    Clear
                  </FilterChip>
                ) : null}
              </div>
            ) : null}
          </div>

          {!hasSelection ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-ink-tertiary">
              <MapPin className="h-8 w-8 text-ink-tertiary" />
              <p className="text-sm">Pick a place.</p>
              {isMobile ? (
                <button
                  type="button"
                  onClick={() => setPlacesSheetOpen(true)}
                  className="mt-1 inline-flex h-9 items-center rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white"
                >
                  Browse places
                </button>
              ) : null}
            </div>
          ) : familyLoading ? (
            <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading families...
            </div>
          ) : pagedFamilies.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-ink-tertiary">{isUnlabelled ? 'No unlabelled families match these filters.' : 'No families match these filters.'}</p>
          ) : (
            <PlaceFamilyRoster
              families={pagedFamilies}
              canEdit={canEdit}
              selectedFamilyKeys={selectedFamilyKeys}
              onToggleFamily={(key) => {
                setSelectedFamilyKeys((current) => {
                  const next = new Set(current)
                  if (next.has(key)) next.delete(key)
                  else next.add(key)
                  return next
                })
              }}
              onSelectAll={(keys) => setSelectedFamilyKeys(new Set(keys))}
              allMatchingCount={filteredFamilies.length}
              onSelectAllMatching={() => setSelectedFamilyKeys(new Set(filteredFamilies.map((family) => family.key)))}
              voterToLeaderId={voterToLeaderId}
              specialIds={specialIds}
              leaderNameById={leaderNameById}
              leaderOptions={leaderOptions}
              assignedBy={profile?.id ?? null}
              placeClub={selectedClub}
              clubs={clubs}
              saving={saving}
              unlabelledMode={isUnlabelled}
              onMove={(placeClubId) => { void moveSelected(placeClubId) }}
              onUnclub={() => { void unclubSelected() }}
              onUnclubFamily={(family) => { void unclubFamily(family) }}
              onMoveFamily={(family, placeClubId) => { void moveFamily(family, placeClubId) }}
              onLeaderAssigned={(voterIds, leaderId) => {
                setVoterToLeaderId((current) => {
                  const next = { ...current }
                  for (const id of voterIds) next[id] = leaderId
                  return next
                })
              }}
              onVoterPatched={patchVoter}
              onPresenceSaved={(family, status, note) => { void saveFamilyPresence(family, status, note) }}
              savingPresenceKey={savingPresenceKey}
              areaSuggestions={areaSuggestions}
            />
          )}
          {!familyLoading && filteredFamilies.length > PAGE_SIZE ? (
            <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs font-semibold text-ink-secondary">
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => patchParams({ page: String(safePage - 1) }, false)}
                className="inline-flex h-8 items-center rounded-lg border border-line px-3 disabled:opacity-40"
              >
                Prev
              </button>
              <span>Page {safePage} of {pageCount}</span>
              <button
                type="button"
                disabled={safePage >= pageCount}
                onClick={() => patchParams({ page: String(safePage + 1) }, false)}
                className="inline-flex h-8 items-center rounded-lg border border-line px-3 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <MobileSheet
        open={placesSheetOpen}
        onClose={() => setPlacesSheetOpen(false)}
        title="Places"
        breakpoint="lg"
        maxHeightClassName="h-[92vh] max-h-[92vh]"
        contentClassName="flex min-h-0 flex-col overflow-hidden"
      >
        <div className="-mx-4 flex min-h-0 flex-1 flex-col">{placePicker}</div>
      </MobileSheet>

      {wizardOpen && selectedClub ? (
        <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-slate-900/50 backdrop-blur-sm sm:items-center sm:p-4">
          <div className="flex h-full w-full flex-col overflow-hidden bg-white sm:h-auto sm:max-h-[90vh] sm:max-w-3xl sm:rounded-xl sm:shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-ink">Add families to {placeClubLabel(selectedClub)}</h3>
                <p className="mt-1 text-xs text-ink-tertiary">{placeClubFullLabel(selectedClub)}</p>
              </div>
              <button type="button" onClick={closeWizard} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1 border-b border-line px-5 py-3">
              {[
                { step: 1 as const, label: 'Place' },
                { step: 2 as const, label: 'People' },
                { step: 3 as const, label: 'Presence' },
              ].map((item) => (
                <button
                  key={item.step}
                  type="button"
                  onClick={() => {
                    if (item.step === 1) setWizardStep(1)
                    else if (item.step === 2) setWizardStep(2)
                    else if (wizardStep === 3) setWizardStep(3)
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold transition ${
                    wizardStep === item.step ? 'bg-brand-50 text-brand-700' : 'text-ink-tertiary hover:bg-muted'
                  }`}
                >
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${wizardStep >= item.step ? 'bg-brand-600 text-white' : 'bg-muted text-ink-tertiary'}`}>
                    {item.step}
                  </span>
                  {item.label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {wizardStep === 1 ? (
                <div className="space-y-3">
                  <p className="text-sm text-ink-secondary">These families will be added to:</p>
                  <div className="rounded-xl border border-line bg-muted px-4 py-3">
                    <p className="font-semibold text-ink">{placeClubFullLabel(selectedClub)}</p>
                    <p className="mt-0.5 text-xs text-ink-tertiary">{placeClubLabel(selectedClub)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={changePlace}
                    className="inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
                  >
                    Change place
                  </button>
                </div>
              ) : wizardStep === 2 ? (
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
                    <input
                      className="h-9 w-full rounded-lg border border-line bg-white pl-8 pr-3 text-sm outline-none focus:border-brand-300"
                      placeholder="Search voter name, EPIC, house, contact"
                      value={wizardSearch}
                      onChange={(event) => {
                        setWizardSearch(event.target.value)
                        setWizardSelected(new Set())
                        setWizardMoveConfirm(null)
                      }}
                    />
                  </div>
                  {wizardMoveConfirm ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <p>{wizardMoveConfirm.movingCount} famil{wizardMoveConfirm.movingCount === 1 ? 'y' : 'ies'} from other places will move into {placeClubLabel(selectedClub)} when you add them.</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setWizardMoveConfirm(null)
                            setWizardStep(3)
                          }}
                          className="h-8 rounded-md bg-amber-700 px-2.5 text-[11px] font-semibold text-white"
                        >
                          Continue
                        </button>
                        <button
                          type="button"
                          onClick={() => setWizardMoveConfirm(null)}
                          className="h-8 rounded-md px-2.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {wizardLoading ? (
                    <div className="flex items-center py-4 text-sm text-ink-tertiary">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Searching voters...
                    </div>
                  ) : !wizardSearch.trim() ? (
                    <p className="py-2 text-sm text-ink-tertiary">Search a voter name, EPIC, house, or contact. The whole family is added.</p>
                  ) : wizardResults.length === 0 ? (
                    <p className="py-2 text-sm text-ink-tertiary">No voter on this roll.</p>
                  ) : (
                    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                      {wizardResults.map((family) => {
                        const head = family.headVoter ?? family.members[0]
                        const headKey = familyGroupHeadKey(family)
                        const currentPlaceId = familyPlaceByHead[headKey]
                        const currentClub = currentPlaceId ? clubsById.get(currentPlaceId) ?? null : null
                        const alreadyHere = currentPlaceId === selectedClub.id
                        const memberNames = family.members.map((member) => member.name).filter(Boolean)
                        return (
                          <label key={family.key} className={`flex items-start gap-3 px-4 py-3 ${alreadyHere ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-muted'}`}>
                            <input
                              type="checkbox"
                              className="mt-1 h-4 w-4 rounded border-line text-brand-600"
                              disabled={alreadyHere}
                              checked={wizardSelected.has(family.key)}
                              onChange={() => {
                                setWizardMoveConfirm(null)
                                setWizardSelected((current) => {
                                  const next = new Set(current)
                                  if (next.has(family.key)) next.delete(family.key)
                                  else next.add(family.key)
                                  return next
                                })
                              }}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="truncate text-sm font-semibold text-ink">{head?.name ?? family.head}</span>
                                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-ink-tertiary">
                                  {family.members.length} member{family.members.length === 1 ? '' : 's'}
                                </span>
                                {alreadyHere ? (
                                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Already here</span>
                                ) : currentClub ? (
                                  <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">{placeClubLabel(currentClub)}</span>
                                ) : currentPlaceId ? (
                                  <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">Another place</span>
                                ) : (
                                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Unlabelled</span>
                                )}
                              </span>
                              <span className="mt-0.5 block text-xs text-ink-tertiary">
                                EPIC {head?.epic_no ?? family.head}
                                {head?.house_no ? ` · House ${head.house_no}` : ''}
                                {head?.part_no != null ? ` · Part ${head.part_no}` : ''}
                              </span>
                              {memberNames.length ? <span className="mt-0.5 block truncate text-[11px] text-ink-tertiary">{memberNames.join(', ')}</span> : null}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid gap-1 sm:grid-cols-3">
                    {PRESENCE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          setWizardPresenceStatus(option.value)
                          setWizardSkipPresence(false)
                        }}
                        className={`h-10 rounded-lg border px-3 text-sm font-semibold transition ${
                          wizardPresenceStatus === option.value
                            ? 'border-brand-600 bg-brand-50 text-brand-700'
                            : 'border-line bg-white text-ink-secondary hover:bg-muted'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setWizardPresenceStatus(null)
                      setWizardSkipPresence(true)
                    }}
                    className={`h-9 rounded-lg border px-3 text-xs font-semibold transition ${
                      wizardSkipPresence
                        ? 'border-amber-400 bg-amber-50 text-amber-800'
                        : 'border-line bg-white text-ink-secondary hover:bg-muted'
                    }`}
                  >
                    Skip presence (club only)
                  </button>
                  {wizardPresenceStatus ? (
                    <div className="space-y-1.5">
                      <label htmlFor="place-wizard-note" className="block text-xs font-semibold text-ink-secondary">Address / location</label>
                      <textarea
                        id="place-wizard-note"
                        rows={4}
                        maxLength={PRESENCE_NOTE_MAX_LENGTH}
                        className="min-h-[6.5rem] w-full resize-y rounded-xl border border-line px-3 py-2 text-sm leading-relaxed outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                        placeholder={presenceNotePlaceholder(wizardPresenceStatus)}
                        value={wizardNote}
                        onChange={(event) => setWizardNote(event.target.value)}
                      />
                      {wizardPresenceStatus === 'IN_MORMUGAO' ? (
                        <p className="text-[11px] text-ink-tertiary">{IN_MORMUGAO_NOTE_HELP}</p>
                      ) : null}
                      <p className="text-right text-[10px] text-ink-tertiary">{wizardNote.length}/{PRESENCE_NOTE_MAX_LENGTH}</p>
                    </div>
                  ) : null}
                  <p className="text-xs text-ink-tertiary">
                    {selectedWizardFamilies.length} famil{selectedWizardFamilies.length === 1 ? 'y' : 'ies'} selected. Presence applies to the head and members without an override.
                  </p>
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-5 py-3">
              <button
                type="button"
                onClick={() => {
                  if (wizardStep === 1) setWizardStep(2)
                  else if (wizardStep === 2) closeWizard()
                  else setWizardStep(2)
                }}
                className="inline-flex h-9 items-center rounded-lg px-3 text-xs font-semibold text-ink-tertiary transition hover:bg-muted hover:text-ink-secondary"
              >
                {wizardStep === 1 ? 'Back to people' : wizardStep === 2 ? 'Cancel' : 'Back'}
              </button>
              {wizardStep === 1 ? (
                <button
                  type="button"
                  onClick={() => setWizardStep(2)}
                  className="inline-flex h-9 items-center rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white transition hover:bg-brand-700"
                >
                  People
                </button>
              ) : wizardStep === 2 ? (
                <button
                  type="button"
                  disabled={!selectedWizardFamilies.length}
                  onClick={goToWizardPresence}
                  className="inline-flex h-9 items-center rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next: presence
                </button>
              ) : (
                <button
                  type="button"
                  disabled={wizardSaving || (!wizardPresenceStatus && !wizardSkipPresence)}
                  onClick={() => void addWizardFamilies()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {wizardSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                  Add to {placeClubLabel(selectedClub)}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <ReportConfigModal
        title={heading}
        open={printOpen}
        mode="print"
        fieldDefs={PLACE_REPORT_FIELD_DEFS}
        fields={reportFields}
        defaultFields={DEFAULT_PLACE_REPORT_FIELDS}
        showLayout
        layout
        layoutTrueLabel="All members"
        layoutFalseLabel="Family heads only"
        extraControls={reportExtra}
        printDescription="Print or download a PDF of families in this place."
        printActionLabel="Open print preview"
        onClose={() => setPrintOpen(false)}
        onConfirm={handlePrintConfirm}
        onDownloadPdf={handlePdfDownload}
      />

      <ReportConfigModal
        title={heading}
        open={exportOpen}
        mode="export"
        fieldDefs={PLACE_REPORT_FIELD_DEFS}
        fields={reportFields}
        defaultFields={DEFAULT_PLACE_REPORT_FIELDS}
        showLayout
        layout
        layoutTrueLabel="All members"
        layoutFalseLabel="Family heads only"
        extraControls={reportExtra}
        onClose={() => setExportOpen(false)}
        onConfirm={handleExportConfirm}
      />
    </div>
  )
}
