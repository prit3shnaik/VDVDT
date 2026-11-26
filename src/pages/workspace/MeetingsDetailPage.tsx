import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ArrowLeft, Check, CheckSquare, Cog, Copy, Download, Eye, FileSpreadsheet, Minus, Phone, Plus, Printer, Square, Trash2, UserPlus, Users } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { StatCard } from '../../components/common/StatCard'
import { Button } from '../../components/ui/Button'
import { ReportConfigModal, type ReportFieldItem } from '../../components/common/ReportConfigModal'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import { EpicExcelImportModal } from '../../components/common/EpicExcelImportModal'
import { exportWorkbookToExcel, type PrintStyleOptions } from '../../lib/reportBuilder'
import type { Meeting, MeetingInvitee, MeetingAttendanceStatus, Voter } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { forEachInChunk } from '../../lib/d1Query'
import { useAuth } from '../../hooks/useAuth'
import { usePersistentState } from '../../hooks/usePersistentState'
import { buildWardScope, FAST_NAV_CACHE_MAX_AGE_MS, readCachedVoters, writeCachedVoters } from '../../lib/voterCache'
import { voterCategoryLabel, withNormalizedVoterCategories } from '../../lib/voterCategory'
import {
  ATTENDANCE_STATUS_OPTIONS,
  DEFAULT_REPORT_FIELD_KEYS,
  DEFAULT_TABLE_COLUMNS,
  GROUP_BY_OPTIONS,
  MEETING_FIELD_OPTIONS,
  REPORT_FIELD_OPTIONS,
  defaultReportFields,
  fieldIsBold,
  fieldIsCenter,
  fieldTextValue,
  groupReportRows,
  reportRowCellValue,
  type GroupByValue,
  type MeetingFieldKey,
  type ReportFieldKey,
  type ReportRow,
} from '../../lib/meetingReport'
import { MEETING_VOTERS_CACHE_KEY, fetchInvitedAnywhereVoterIds, notInvitedEligibleMembers, fetchGlobalMeeting } from '../../hooks/useMeetingData'
import {
  buildFamilies,
  buildFamilyLookupText,
  buildVoterLookupText,
  familyMatchesSearch,
  initials,
  matchesLookupTokens,
  memberMatchesSearch,
  normalizeGroupingValue,
  tokenizeLookup,
  type FamilyGroup,
} from '../../lib/searchUtils'

interface InviteeRow {
  invitee: MeetingInvitee
  voter: Voter | null
}

const BULK_STATUS_OPTIONS: Array<{ value: MeetingAttendanceStatus; label: string }> = [
  { value: 'pending', label: 'Mark as Pending' },
  { value: 'attended', label: 'Mark as Attended' },
  { value: 'called', label: 'Mark as Called' },
  { value: 'called_confirmed', label: 'Mark as Called-Confirmed' },
  { value: 'called_notreceived', label: 'Mark as Called-Not Received' },
  { value: 'called_suspense', label: 'Mark as Called-Suspense' },
  { value: 'absent', label: 'Mark as Absent' },
  { value: 'not_attended', label: 'Mark as Not Attended' },
  { value: 'personal_call', label: 'Mark as Personal Call' },
]

const STATUS_COLORS: Record<MeetingAttendanceStatus, string> = {
  pending: 'bg-muted text-ink-secondary border-line',
  attended: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  next_meeting: 'bg-blue-100 text-blue-700 border-blue-200',
  absent: 'bg-rose-100 text-rose-700 border-rose-200',
  not_attended: 'bg-rose-100 text-rose-700 border-rose-200',
  called: 'bg-amber-100 text-amber-700 border-amber-200',
  called_confirmed: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  called_notreceived: 'bg-rose-100 text-rose-700 border-rose-200',
  called_suspense: 'bg-amber-100 text-amber-700 border-amber-200',
  personal_call: 'bg-violet-100 text-violet-700 border-violet-200',
}

const FAMILY_SIZE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All Family Sizes' },
  { value: '1', label: '1 Member' },
  { value: '2-3', label: '2-3 Members' },
  { value: '4-5', label: '4-5 Members' },
  { value: '6plus', label: '6+ Members' },
]

const PHOTO_URL_CACHE_KEY = 'vote:meeting-photo-urls'


export function MeetingsDetailPage() {
  const navigate = useNavigate()
  const { profile } = useAuth()

  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [voters, setVoters] = useState<Voter[]>([])
  const [invitees, setInvitees] = useState<MeetingInvitee[]>([])
  const [globalInvitedVoterIds, setGlobalInvitedVoterIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>({})

  const [statusFilter, setStatusFilter] = usePersistentState('vote:meeting-detail:statusFilter', 'all')
  const [partFilter, setPartFilter] = usePersistentState('vote:meeting-detail:partFilter', 'all')
  const [sectionFilter, setSectionFilter] = usePersistentState('vote:meeting-detail:sectionFilter', 'all')
  const [wardFilter, setWardFilter] = usePersistentState('vote:meeting-detail:wardFilter', 'all')
  const [familySizeFilter, setFamilySizeFilter] = usePersistentState('vote:meeting-detail:familySizeFilter', 'all')
  const [showAllParts, setShowAllParts] = useState(false)

  const [selectedVoterIds, setSelectedVoterIds] = useState<Set<string>>(new Set())
  const [editingNoteByInvitee, setEditingNoteByInvitee] = useState<Record<string, string>>({})
  const [voterSearch, setVoterSearch] = useState('')
  const [voterBrowsePart, setVoterBrowsePart] = useState('')
  const [voterBrowseSection, setVoterBrowseSection] = useState('')
  const [voterBrowseVisibleCount, setVoterBrowseVisibleCount] = useState(30)
  const [addVoterMode, setAddVoterMode] = useState<'individual' | 'family'>('family')
  const [addStatus, setAddStatus] = useState<MeetingAttendanceStatus>('pending')
  const [attendeeSearch, setAttendeeSearch] = useState('')
  const [attendeeVisibleCount, setAttendeeVisibleCount] = useState(100)

  const [tableColumns, setTableColumns] = usePersistentState<MeetingFieldKey[]>('vote:meeting-detail:table-columns', [...DEFAULT_TABLE_COLUMNS])
  const [tableColumnsOpen, setTableColumnsOpen] = useState(false)

  const [showExportModal, setShowExportModal] = useState(false)
  const [showPrintModal, setShowPrintModal] = useState(false)
  const [showEpicImport, setShowEpicImport] = useState(false)
  const [reportScope, setReportScope] = useState<'filtered' | 'all'>('filtered')
  const [reportGroupBy, setReportGroupBy] = useState<GroupByValue>('family')
  const [reportFields, setReportFields] = useState<Record<ReportFieldKey, boolean>>(defaultReportFields())
  const [reportFieldOrder, setReportFieldOrder] = useState<ReportFieldKey[]>([...DEFAULT_REPORT_FIELD_KEYS])
  const [reportPaperSize, setReportPaperSize] = useState<'a4' | 'letter'>('a4')
  const [reportOrientation, setReportOrientation] = useState<'portrait' | 'landscape'>('landscape')
  const [reportPhotoSize, setReportPhotoSize] = useState<'small' | 'medium' | 'large'>('small')
  const [reportHeaderConstituency, setReportHeaderConstituency] = useState('')
  const [reportHeaderSignature, setReportHeaderSignature] = useState(false)
  const [reportIncludeFamilies, setReportIncludeFamilies] = useState(false)
  const [reportFontSize, setReportFontSize] = usePersistentState<number>('vote:meeting-detail:printFontSize:v2', 20)
  const [reportBold, setReportBold] = usePersistentState<boolean>('vote:meeting-detail:printBold', false)
  const [reportBorders, setReportBorders] = usePersistentState<boolean>('vote:meeting-detail:exportBorders', true)
  const [reportRowHeight, setReportRowHeight] = usePersistentState<number>('vote:meeting-detail:exportRowHeight', 18)
  const [reportColWidth, setReportColWidth] = usePersistentState<number>('vote:meeting-detail:exportColWidth', 16)

  const [expandedFamilyRows, setExpandedFamilyRows] = useState<Set<string>>(new Set())
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set())
  const [bulkFamilyStatusValue, setBulkFamilyStatusValue] = useState<Record<string, MeetingAttendanceStatus | ''>>({})

  const wardScope = buildWardScope(profile?.role, profile?.allowed_wards)
  const allowedWards = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((w) => Number.isFinite(w))))
    wards.sort((a, b) => a - b)
    return wards
  }, [profile?.allowed_wards])
  const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0

  const load = useCallback(async () => {
    setLoading(true)

    const global = await fetchGlobalMeeting()
    if (!global.meeting) {
      setMeeting(null)
      setInvitees([])
      setLoading(false)
      return
    }

    const iRes = await supabase.from('meeting_invitees').select('*').eq('meeting_id', global.meeting.id)
    const loadedInvitees = (iRes.data as MeetingInvitee[] | null) ?? []

    setMeeting(global.meeting)
    setInvitees(loadedInvitees)

    const invRes = await fetchInvitedAnywhereVoterIds()
    const combined = new Set(invRes)
    for (const inv of loadedInvitees) combined.add(inv.voter_id)
    setGlobalInvitedVoterIds(combined)

    const cached = withNormalizedVoterCategories(readCachedVoters(MEETING_VOTERS_CACHE_KEY, wardScope, FAST_NAV_CACHE_MAX_AGE_MS) ?? [])
    const voterRows: Voter[] = [...cached]

    if (!cached.length) {
      let offset = 0
      const batchSize = 400
      for (;;) {
        let req = supabase.from('voters').select('*').range(offset, offset + batchSize - 1)
        if (hasWardRestriction) req = req.in('ward_no', allowedWards)
        const { data, error } = await req
        if (error) break
        const batch = withNormalizedVoterCategories((data as Voter[] | null) ?? [])
        voterRows.push(...batch)
        if (batch.length < batchSize) break
        offset += batchSize
      }
      writeCachedVoters(MEETING_VOTERS_CACHE_KEY, wardScope, voterRows)
    }

    setVoters(voterRows)
    setLoading(false)
  }, [wardScope, hasWardRestriction, allowedWards])

  useEffect(() => { void load() }, [load])

  const [searchParams, setSearchParams] = useSearchParams()
  const hasAppliedUrlFilters = useMemo(() => {
    const part = searchParams.get('part')
    const section = searchParams.get('section')
    return part !== null || section !== null
  }, [searchParams])

  useEffect(() => {
    const part = searchParams.get('part')
    const section = searchParams.get('section')
    if (part !== null) setPartFilter(part)
    if (section !== null) setSectionFilter(section)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (hasAppliedUrlFilters) {
      const next = new URLSearchParams()
      if (partFilter !== 'all') next.set('part', partFilter)
      if (sectionFilter !== 'all') next.set('section', sectionFilter)
      setSearchParams(next, { replace: true })
    }
  }, [hasAppliedUrlFilters, partFilter, sectionFilter, setSearchParams])

  const voterById = useMemo(() => {
    const map = new Map<string, Voter>()
    for (const v of voters) map.set(v.id, v)
    return map
  }, [voters])

  const epicToVoter = useMemo(() => {
    const map = new Map<string, Voter>()
    for (const v of voters) {
      const key = normalizeGroupingValue(v.epic_no)
      if (key) map.set(key, v)
    }
    return map
  }, [voters])

  const partOptions = useMemo(() => {
    return Array.from(new Set(voters.filter((v) => v.part_no != null).map((v) => v.part_no))).sort((a, b) => a! - b!)
  }, [voters])

  const sectionOptions = useMemo(() => {
    if (partFilter === 'all') return []
    return Array.from(new Set(voters.filter((v) => v.part_no != null && String(v.part_no) === partFilter && v.section != null).map((v) => v.section)))
      .sort((a, b) => a! - b!)
  }, [voters, partFilter])

  useEffect(() => {
    if (partFilter !== 'all' && !partOptions.some((p) => String(p) === partFilter)) {
      setPartFilter('all')
    }
  }, [partFilter, partOptions, setPartFilter])

  useEffect(() => {
    if (partFilter === 'all' && sectionFilter !== 'all') {
      setSectionFilter('all')
      return
    }
    if (sectionFilter !== 'all' && !sectionOptions.some((s) => String(s) === sectionFilter)) {
      setSectionFilter('all')
    }
  }, [partFilter, sectionFilter, sectionOptions, setSectionFilter])

  useEffect(() => {
    setAttendeeVisibleCount(100)
  }, [attendeeSearch, statusFilter, partFilter, sectionFilter, wardFilter, familySizeFilter])

  const wardOptions = useMemo(() => {
    return Array.from(new Set(voters.filter((v) => v.ward_no != null).map((v) => v.ward_no))).sort((a, b) => a! - b!)
  }, [voters])

  const inviteeRows = useMemo((): InviteeRow[] => {
    return invitees.map((inv) => ({ invitee: inv, voter: voterById.get(inv.voter_id) ?? null }))
  }, [invitees, voterById])

  const inviteeByVoterId = useMemo(() => {
    const map = new Map<string, MeetingInvitee>()
    for (const inv of invitees) map.set(inv.voter_id, inv)
    return map
  }, [invitees])

  const inviteeById = useMemo(() => {
    const map = new Map<string, MeetingInvitee>()
    for (const inv of invitees) map.set(inv.id, inv)
    return map
  }, [invitees])

  const allFamilies = useMemo(() => buildFamilies(voters), [voters])

  const familySizeByVoterId = useMemo(() => {
    const map = new Map<string, number>()
    for (const family of allFamilies) {
      for (const member of family.members) {
        map.set(member.id, family.members.length)
      }
    }
    return map
  }, [allFamilies])

  const familyGroupByVoterId = useMemo(() => {
    const map = new Map<string, FamilyGroup>()
    for (const family of allFamilies) {
      for (const member of family.members) {
        map.set(member.id, family)
      }
    }
    return map
  }, [allFamilies])

  const inviteesByFamilyEpic = useMemo(() => {
    const map = new Map<string, InviteeRow[]>()
    for (const ir of inviteeRows) {
      const epic = normalizeGroupingValue(ir.voter?.family_head_epic || ir.voter?.epic_no)
      if (!map.has(epic)) map.set(epic, [])
      map.get(epic)!.push(ir)
    }
    return map
  }, [inviteeRows])

  const attendeeSearchTokens = useMemo(() => tokenizeLookup(attendeeSearch), [attendeeSearch])

  const inviteeMatchesAttendeeSearch = useCallback((ir: InviteeRow, tokens: string[]): boolean => {
    if (!tokens.length) return true
    if (ir.voter && matchesLookupTokens(buildVoterLookupText(ir.voter), tokens)) return true
    const family = ir.voter ? familyGroupByVoterId.get(ir.voter.id) : undefined
    return family != null && matchesLookupTokens(buildFamilyLookupText(family), tokens)
  }, [familyGroupByVoterId])

  const filteredInvitees = useMemo(() => {
    return inviteeRows.filter((ir) => {
      if (statusFilter !== 'all' && ir.invitee.attendance_status !== statusFilter) return false
      if (!inviteeMatchesAttendeeSearch(ir, attendeeSearchTokens)) return false
      const family = ir.voter ? familyGroupByVoterId.get(ir.voter.id) : undefined
      const headPart = family?.headVoter?.part_no ?? ir.voter?.part_no
      const headSection = family?.headVoter?.section ?? ir.voter?.section
      if (partFilter !== 'all' && String(headPart ?? '') !== partFilter) return false
      if (sectionFilter !== 'all' && String(headSection ?? '') !== sectionFilter) return false
      if (wardFilter !== 'all' && String(ir.voter?.ward_no ?? '') !== wardFilter) return false
      if (familySizeFilter !== 'all') {
        const fSize = ir.voter ? (familySizeByVoterId.get(ir.voter.id) ?? 0) : 0
        if (familySizeFilter === '1' && fSize !== 1) return false
        if (familySizeFilter === '2-3' && !(fSize >= 2 && fSize <= 3)) return false
        if (familySizeFilter === '4-5' && !(fSize >= 4 && fSize <= 5)) return false
        if (familySizeFilter === '6plus' && fSize < 6) return false
      }
      return true
    })
  }, [inviteeRows, statusFilter, attendeeSearchTokens, partFilter, sectionFilter, wardFilter, familySizeFilter, familySizeByVoterId, familyGroupByVoterId, inviteeMatchesAttendeeSearch])

  const visibleInvitees = useMemo(() => filteredInvitees.slice(0, attendeeVisibleCount), [filteredInvitees, attendeeVisibleCount])

  const scopedInvitees = useMemo(() => {
    return inviteeRows.filter((ir) => {
      const family = ir.voter ? familyGroupByVoterId.get(ir.voter.id) : undefined
      const headPart = family?.headVoter?.part_no ?? ir.voter?.part_no
      const headSection = family?.headVoter?.section ?? ir.voter?.section
      if (partFilter !== 'all' && String(headPart ?? '') !== partFilter) return false
      if (sectionFilter !== 'all' && String(headSection ?? '') !== sectionFilter) return false
      return true
    })
  }, [inviteeRows, partFilter, sectionFilter, familyGroupByVoterId])

  const inviteeVoterIds = useMemo(() => new Set(invitees.map((i) => i.voter_id)), [invitees])

  const coveredVoterIds = globalInvitedVoterIds

  const familyNonInvitedMembers = (family: FamilyGroup) => notInvitedEligibleMembers(family, coveredVoterIds)
  const familyFullySelected = (family: FamilyGroup) => {
    const eligible = familyNonInvitedMembers(family)
    return eligible.length > 0 && eligible.every((m) => selectedVoterIds.has(m.id))
  }
  const toggleFamilySelection = (family: FamilyGroup) => {
    const eligible = familyNonInvitedMembers(family)
    if (!eligible.length) return
    const allSelected = familyFullySelected(family)
    setSelectedVoterIds((prev) => {
      const next = new Set(prev)
      for (const member of eligible) {
        if (allSelected) next.delete(member.id)
        else next.add(member.id)
      }
      return next
    })
  }

  // ----- Meeting progress -----
  const meetingProgress = useMemo(() => ({
    invitedVoters: scopedInvitees.length,
    invitedFamilies: new Set(scopedInvitees.map((ir) => normalizeGroupingValue(ir.voter?.family_head_epic || ir.voter?.epic_no))).size,
    attended: scopedInvitees.filter((ir) => ir.invitee.attendance_status === 'attended').length,
    pending: scopedInvitees.filter((ir) => ir.invitee.attendance_status === 'pending').length,
    nextMeeting: scopedInvitees.filter((ir) => ir.invitee.attendance_status === 'next_meeting').length,
    called: scopedInvitees.filter((ir) => ir.invitee.attendance_status === 'called').length,
    calledConfirmed: scopedInvitees.filter((ir) => ir.invitee.attendance_status === 'called_confirmed').length,
    calledNotReceived: scopedInvitees.filter((ir) => ir.invitee.attendance_status === 'called_notreceived').length,
    calledSuspense: scopedInvitees.filter((ir) => ir.invitee.attendance_status === 'called_suspense').length,
    absent: scopedInvitees.filter((ir) => ir.invitee.attendance_status === 'absent').length,
    notAttended: scopedInvitees.filter((ir) => ir.invitee.attendance_status === 'not_attended').length,
    personalCall: scopedInvitees.filter((ir) => ir.invitee.attendance_status === 'personal_call').length,
    maleVoters: scopedInvitees.filter((ir) => ir.voter?.gender?.toLowerCase() === 'male').length,
    femaleVoters: scopedInvitees.filter((ir) => ir.voter?.gender?.toLowerCase() === 'female').length,
  }), [scopedInvitees])

  // ----- Part selection gate -----
  const partGateOpen = meeting != null && partFilter === 'all' && !showAllParts

  const partProgress = useMemo(() => {
    return partOptions.map((part) => {
      const key = String(part)
      const rows = inviteeRows.filter((ir) => {
        const family = ir.voter ? familyGroupByVoterId.get(ir.voter.id) : undefined
        const headPart = family?.headVoter?.part_no ?? ir.voter?.part_no
        return String(headPart ?? '') === key
      })
      return {
        part: key,
        invitedVoters: rows.length,
        invitedFamilies: new Set(rows.map((ir) => normalizeGroupingValue(ir.voter?.family_head_epic || ir.voter?.epic_no))).size,
        attended: rows.filter((ir) => ir.invitee.attendance_status === 'attended').length,
        pending: rows.filter((ir) => ir.invitee.attendance_status === 'pending').length,
        personalCall: rows.filter((ir) => ir.invitee.attendance_status === 'personal_call').length,
      }
    })
  }, [partOptions, inviteeRows, familyGroupByVoterId])

  const selectPart = (part: string, navigateTo: 'detail' | 'gate') => {
    setPartFilter(part)
    setShowAllParts(part === 'all')
    setSectionFilter('all')
    const next = new URLSearchParams()
    if (part !== 'all') next.set('part', part)
    setSearchParams(next, { replace: true })
    if (navigateTo === 'detail') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // ----- Search -----
  const searchTokens = useMemo(() => tokenizeLookup(voterSearch), [voterSearch])

  const familiesInBrowsePart = useMemo(() => {
    if (!voterBrowsePart) return []
    return allFamilies
      .filter((family) => String(family.headVoter?.part_no ?? '') === voterBrowsePart)
      .filter((family) => {
        if (voterBrowseSection && String(family.headVoter?.section ?? '') !== voterBrowseSection) return false
        return true
      })
      .filter((family) => family.members.some((m) => !coveredVoterIds.has(m.id)))
      .sort((a, b) => (a.headVoter?.name ?? '').localeCompare(b.headVoter?.name ?? ''))
  }, [allFamilies, voterBrowsePart, voterBrowseSection, coveredVoterIds])

  const isBrowsingPart = voterBrowsePart !== ''

  const browseSectionOptions = useMemo(() => {
    if (!voterBrowsePart) return []
    return Array.from(new Set(allFamilies.filter((f) => String(f.headVoter?.part_no ?? '') === voterBrowsePart && f.headVoter?.section != null).map((f) => f.headVoter!.section)))
      .sort((a, b) => a! - b!)
  }, [allFamilies, voterBrowsePart])

  const allMatchingFamilies = useMemo(() => {
    if (isBrowsingPart) {
      if (!searchTokens.length) return familiesInBrowsePart
      return familiesInBrowsePart.filter((family) => familyMatchesSearch(family, searchTokens))
    }
    if (!searchTokens.length) return []
    return allFamilies.filter(
      (family) => familyMatchesSearch(family, searchTokens) && family.members.some((m) => !coveredVoterIds.has(m.id)),
    )
  }, [allFamilies, familiesInBrowsePart, isBrowsingPart, searchTokens, coveredVoterIds])

  const matchingIndividualVoters = useMemo(() => {
    if (addVoterMode !== 'individual') return []
    if (!searchTokens.length && !isBrowsingPart) return []
    let candidates = isBrowsingPart
      ? voters.filter((v) => String(v.part_no ?? '') === voterBrowsePart)
      : voters
    if (voterBrowseSection) {
      candidates = candidates.filter((v) => String(v.section ?? '') === voterBrowseSection)
    }
    candidates = candidates.filter((v) => !coveredVoterIds.has(v.id))
    if (searchTokens.length) {
      candidates = candidates.filter((v) => matchesLookupTokens(buildVoterLookupText(v), searchTokens))
    }
    return candidates.slice(0, 200)
  }, [addVoterMode, searchTokens, isBrowsingPart, voterBrowsePart, voterBrowseSection, voters, coveredVoterIds])

  const visibleMatchingIndividualVoters = useMemo(() => {
    if (isBrowsingPart) return matchingIndividualVoters.slice(0, voterBrowseVisibleCount)
    return matchingIndividualVoters.slice(0, 100)
  }, [matchingIndividualVoters, isBrowsingPart, voterBrowseVisibleCount])

  const SEARCH_FAMILY_LIMIT = 20
  const visibleMatchingFamilies = isBrowsingPart
    ? allMatchingFamilies.slice(0, voterBrowseVisibleCount)
    : allMatchingFamilies.slice(0, SEARCH_FAMILY_LIMIT)

  const selectedVotersArray = useMemo(() => {
    return Array.from(selectedVoterIds).map((id) => voterById.get(id)).filter((v): v is Voter => v != null)
  }, [selectedVoterIds, voterById])

  const visiblePhotoPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const ir of filteredInvitees) if (ir.voter?.photo_url) paths.add(ir.voter.photo_url)
    for (const vid of selectedVoterIds) {
      const v = voterById.get(vid)
      if (v?.photo_url) paths.add(v.photo_url)
    }
    for (const family of visibleMatchingFamilies) {
      for (const member of family.members) if (member.photo_url) paths.add(member.photo_url)
    }
    for (const v of visibleMatchingIndividualVoters) if (v.photo_url) paths.add(v.photo_url)
    for (const inviteeId of expandedFamilyRows) {
      const inv = inviteeById.get(inviteeId)
      const fam = inv?.voter_id ? familyGroupByVoterId.get(inv.voter_id) : undefined
      if (fam) for (const member of fam.members) if (member.photo_url) paths.add(member.photo_url)
    }
    return Array.from(paths)
  }, [filteredInvitees, selectedVoterIds, voterById, visibleMatchingFamilies, visibleMatchingIndividualVoters, expandedFamilyRows, inviteeById, familyGroupByVoterId])

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(PHOTO_URL_CACHE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { savedAt?: number; urls?: Record<string, string> }
      if (parsed && typeof parsed.savedAt === 'number' && parsed.urls && Date.now() - parsed.savedAt < 60 * 60 * 1000) {
        setPhotoUrlByPath(parsed.urls)
      }
    } catch {
      // ignore corrupt or oversized cache
    }
  }, [])

  useEffect(() => {
    const keys = Object.keys(photoUrlByPath)
    if (!keys.length) return
    try {
      sessionStorage.setItem(PHOTO_URL_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), urls: photoUrlByPath }))
    } catch {
      // storage quota exceeded - skip persisting
    }
  }, [photoUrlByPath])

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

  const updateStatus = async (inviteeId: string, status: MeetingAttendanceStatus) => {
    const { error } = await supabase.from('meeting_invitees').update({
      attendance_status: status,
      updated_by: profile?.id ?? null,
    }).eq('id', inviteeId)
    if (error) { toast.error(error.message); return }
    setInvitees((prev) => prev.map((i) => i.id === inviteeId ? { ...i, attendance_status: status, updated_at: new Date().toISOString() } : i))
  }

  const updateCallNote = async (inviteeId: string, note: string) => {
    const { error } = await supabase.from('meeting_invitees').update({
      call_note: note || null,
      updated_by: profile?.id ?? null,
    }).eq('id', inviteeId)
    if (error) { toast.error(error.message); return }
    setInvitees((prev) => prev.map((i) => i.id === inviteeId ? { ...i, call_note: note || null } : i))
  }

  const addInvitees = async () => {
    if (selectedVoterIds.size === 0) { toast.error('Select voters to add.'); return }
    if (!meeting?.id) return
    const rows = Array.from(selectedVoterIds).map((vid) => ({
      meeting_id: meeting.id,
      voter_id: vid,
      attendance_status: addStatus,
    }))
    const { error } = await supabase.from('meeting_invitees').upsert(rows, { onConflict: 'meeting_id,voter_id' })
    if (error) { toast.error(error.message); return }
    toast.success(`Added ${rows.length} invitee(s).`)
    setSelectedVoterIds(new Set())
    await load()
  }

  const removeInvitee = async (inviteeId: string) => {
    const { error } = await supabase.from('meeting_invitees').delete().eq('id', inviteeId)
    if (error) { toast.error(error.message); return }
    toast.success('Invitee removed.')
    await load()
  }

  const toggleVoterSelected = (id: string) => {
    if (coveredVoterIds.has(id)) return
    setSelectedVoterIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAllSearchResults = () => {
    setSelectedVoterIds((prev) => {
      const next = new Set(prev)
      for (const family of visibleMatchingFamilies) {
        for (const member of familyNonInvitedMembers(family)) next.add(member.id)
      }
      return next
    })
  }

  const selectAllIndividualResults = () => {
    setSelectedVoterIds((prev) => {
      const next = new Set(prev)
      for (const voter of visibleMatchingIndividualVoters) {
        if (!coveredVoterIds.has(voter.id)) next.add(voter.id)
      }
      return next
    })
  }

  const selectAllHeadsInBrowsePart = () => {
    setSelectedVoterIds((prev) => {
      const next = new Set(prev)
      for (const family of familiesInBrowsePart) {
        const head = family.headVoter
        if (head && !coveredVoterIds.has(head.id)) next.add(head.id)
      }
      return next
    })
  }

  // ----- Bulk status updates -----
  const isAllBulkSelected = useMemo(() => {
    if (!filteredInvitees.length) return false
    return filteredInvitees.every((ir) => bulkSelectedIds.has(ir.invitee.id))
  }, [filteredInvitees, bulkSelectedIds])

  const toggleBulkSelectAll = () => {
    if (isAllBulkSelected) {
      setBulkSelectedIds(new Set())
    } else {
      setBulkSelectedIds(new Set(filteredInvitees.map((ir) => ir.invitee.id)))
    }
  }

  const toggleBulkSelect = (inviteeId: string) => {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(inviteeId)) next.delete(inviteeId)
      else next.add(inviteeId)
      return next
    })
  }

  const applyBulkStatus = async (status: MeetingAttendanceStatus) => {
    if (!bulkSelectedIds.size) { toast.error('No invitees selected'); return }
    const ids = Array.from(bulkSelectedIds)
    try {
      await forEachInChunk(ids, async (chunk) => {
        const { error } = await supabase.from('meeting_invitees').update({
          attendance_status: status,
          updated_by: profile?.id ?? null,
        }).in('id', chunk)
        if (error) throw new Error(error.message)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update invitees.')
      return
    }
    setInvitees((prev) => prev.map((i) => ids.includes(i.id) ? { ...i, attendance_status: status, updated_at: new Date().toISOString() } : i))
    setBulkSelectedIds(new Set())
    toast.success(`Updated ${ids.length} invitee(s)`)
  }

  const applyBulkFamilyStatus = async (familyHeadEpic: string, status: MeetingAttendanceStatus) => {
    const familyInvitees = invitees.filter((i) => {
      const v = voterById.get(i.voter_id)
      const epic = normalizeGroupingValue(v?.family_head_epic || v?.epic_no)
      return epic === familyHeadEpic
    })
    if (!familyInvitees.length) { toast.error('No family members invited'); return }
    const ids = familyInvitees.map((i) => i.id)
    try {
      await forEachInChunk(ids, async (chunk) => {
        const { error } = await supabase.from('meeting_invitees').update({
          attendance_status: status,
          updated_by: profile?.id ?? null,
        }).in('id', chunk)
        if (error) throw new Error(error.message)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update family invitees.')
      return
    }
    setInvitees((prev) => prev.map((i) => ids.includes(i.id) ? { ...i, attendance_status: status, updated_at: new Date().toISOString() } : i))
    setBulkFamilyStatusValue((prev) => ({ ...prev, [familyHeadEpic]: '' }))
    toast.success(`Updated ${familyInvitees.length} family member(s)`)
  }

  const copyContactNumber = async (contact: string) => {
    try {
      await navigator.clipboard.writeText(contact)
      toast.success('Contact copied')
    } catch {
      toast.error('Failed to copy')
    }
  }

  const toggleFamilyRowExpanded = (inviteeId: string) => {
    setExpandedFamilyRows((prev) => {
      const next = new Set(prev)
      if (next.has(inviteeId)) next.delete(inviteeId)
      else next.add(inviteeId)
      return next
    })
  }

  const expandAllFamilyRows = () => {
    setExpandedFamilyRows(new Set(visibleInvitees.filter((ir) => ir.voter && familyGroupByVoterId.has(ir.voter.id)).map((ir) => ir.invitee.id)))
  }

  const collapseAllFamilyRows = () => {
    setExpandedFamilyRows(new Set())
  }

  const statusBadge = (status: MeetingAttendanceStatus | undefined, className = '') => {
    if (!status) return null
    return (
      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[status]} ${className}`}>
        {ATTENDANCE_STATUS_OPTIONS.find((s) => s.value === status)?.label ?? status}
      </span>
    )
  }

  // ----- Export / Print -----
  const resolvePhotoUrl = (voter: Voter | null | undefined): string => {
    if (!voter?.photo_url) return ''
    return photoUrlByPath[voter.photo_url] ?? ''
  }

  const selectedReportKeys = useMemo(() => {
    const activeKeys = REPORT_FIELD_OPTIONS.filter((option) => reportFields[option.key]).map((option) => option.key)
    const ordered = reportFieldOrder.filter((key) => activeKeys.includes(key))
    for (const key of activeKeys) if (!ordered.includes(key)) ordered.push(key)
    return ordered
  }, [reportFieldOrder, reportFields])

  const reportSourceRows = useMemo<ReportRow[]>(() => {
    const source = reportScope === 'all' ? inviteeRows : filteredInvitees
    if (!reportIncludeFamilies) {
      return source.map((ir) => ({ invitee: ir.invitee, voter: ir.voter }))
    }
    const seen = new Set<string>()
    const out: ReportRow[] = []
    for (const ir of source) {
      const fam = ir.voter ? familyGroupByVoterId.get(ir.voter.id) : undefined
      if (!fam) {
        const key = ir.invitee.voter_id
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ invitee: ir.invitee, voter: ir.voter })
        continue
      }
      for (const member of fam.members) {
        if (seen.has(member.id)) continue
        seen.add(member.id)
        const memberInvitee = invitees.find((i) => i.voter_id === member.id) ?? null
        out.push({ invitee: memberInvitee, voter: member })
      }
    }
    return out
  }, [reportScope, filteredInvitees, inviteeRows, reportIncludeFamilies, familyGroupByVoterId, invitees])

  const handleExportExcel = (style: PrintStyleOptions) => {
    if (!selectedReportKeys.length) { toast.error('Select at least one field to export.'); return }
    const grouped = groupReportRows(reportSourceRows, reportGroupBy, epicToVoter)
    const headerLabels = selectedReportKeys.map((key) => REPORT_FIELD_OPTIONS.find((o) => o.key === key)!.label)
    const sheetRows: Array<Array<string | number>> = []
    for (const [groupLabel, rows] of grouped) {
      if (groupLabel) sheetRows.push([groupLabel])
      sheetRows.push(headerLabels)
      rows.forEach((ir, index) => {
        const photoUrl = resolvePhotoUrl(ir.voter)
        sheetRows.push(selectedReportKeys.map((key) => reportRowCellValue(ir, key, index + 1, photoUrl)))
      })
      sheetRows.push([])
    }
    const photoWidth = reportPhotoSize === 'large' ? 42 : reportPhotoSize === 'medium' ? 35 : 28
    const colWidths = selectedReportKeys.map((key) => ({ wch: key === 'photo' ? photoWidth : key === 'name' ? 28 : 16 }))
    void exportWorkbookToExcel(
      [{ name: 'Invitees', rows: sheetRows, colWidths }],
      `global-meeting-invitees-${new Date().toISOString().slice(0, 10)}.xlsx`,
      style,
    )
    setShowExportModal(false)
  }

  const handlePrint = (style: PrintStyleOptions) => {
    if (!selectedReportKeys.length) { toast.error('Select at least one field to print.'); return }
    const fontSize = style.fontSize
    const bold = style.boldText
    const grouped = groupReportRows(reportSourceRows, reportGroupBy, epicToVoter)
    const headerLabels = selectedReportKeys.map((key) => REPORT_FIELD_OPTIONS.find((o) => o.key === key)!.label)
    const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const basePhoto = reportPhotoSize === 'large' ? 60 : reportPhotoSize === 'medium' ? 40 : 30
    const photoSizePx = `${Math.round(basePhoto * (fontSize / 11))}px`
    const pageWidth = reportPaperSize === 'a4' ? '210mm' : '215.9mm'
    const pageHeight = reportPaperSize === 'a4' ? '297mm' : '279.4mm'
    const pageSizeStyle = reportOrientation === 'landscape' ? `${pageHeight} ${pageWidth}` : `${pageWidth} ${pageHeight}`
    const renderHeader = () => `
      <div class="print-header">
        <h1>Meeting Invitees Report</h1>
        ${reportHeaderConstituency ? `<div class="constituency">${escapeHtml(reportHeaderConstituency)}</div>` : ''}
        <div class="meta">
          Global Meeting
          &middot; Date: ${meeting?.meeting_date ?? '-'}
          ${reportGroupBy !== 'none' ? ` &middot; Grouped by ${GROUP_BY_OPTIONS.find((o) => o.value === reportGroupBy)?.label}` : ''}
          ${reportIncludeFamilies ? ' &middot; Includes all family members' : ''}
          &middot; Generated ${new Date().toLocaleString()}
        </div>
        ${reportHeaderSignature ? '<div class="signature-line">Verified by: ________________________ &nbsp;&nbsp; Date: ________</div>' : ''}
      </div>`
    let bodyHtml = ''
    for (const [groupLabel, rows] of grouped) {
      if (groupLabel) bodyHtml += `<h2 class="group-title">${escapeHtml(groupLabel)}</h2>`
      bodyHtml += `<table><thead><tr>${headerLabels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>`
      rows.forEach((ir, index) => {
        const photoUrl = resolvePhotoUrl(ir.voter)
        const cells = selectedReportKeys.map((key) => {
          if (key === 'photo') return `<td>${photoUrl ? `<img class="photo" src="${photoUrl}" />` : ''}</td>`
          return `<td>${escapeHtml(reportRowCellValue(ir, key, index + 1, photoUrl))}</td>`
        }).join('')
        bodyHtml += `<tr>${cells}</tr>`
      })
      bodyHtml += '</tbody></table>'
    }
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Meeting Invitees Report</title>
<style>
  @page { size: ${pageSizeStyle}; margin: 15mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; padding: 16px; }
  .print-header { margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid #333; }
  .print-header h1 { font-size: 20px; margin: 0 0 4px; }
  .constituency { font-size: 14px; font-weight: 600; color: #444; margin-bottom: 4px; }
  .meta { font-size: 12px; color: #555; margin-bottom: 8px; }
  .signature-line { font-size: 13px; color: #333; margin-top: 8px; padding-top: 12px; border-top: 1px dashed #999; }
  .group-title { font-size: 15px; margin: 24px 0 8px; border-bottom: 2px solid #333; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: ${fontSize}px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: middle; }
  th { background: #f0f0f0; }
  ${bold ? 'th, td { font-weight: 700; }' : ''}
  .photo { width: ${photoSizePx}; height: ${photoSizePx}; object-fit: cover; border-radius: 50%; }
  @media print {
    tr { break-inside: avoid; }
    .group-title { break-after: avoid; }
  }
</style>
</head>
<body>
  ${renderHeader()}
  ${bodyHtml}
</body>
</html>`
    const printWindow = window.open('', '_blank')
    if (!printWindow) { toast.error('Popup blocked. Please allow popups for this site to print.'); return }
    printWindow.document.write(html)
    printWindow.document.close()
    printWindow.focus()
    setTimeout(() => printWindow.print(), 350)
    setShowPrintModal(false)
  }

  return (
    <div className="space-y-4 pb-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="inline-flex h-10 items-center gap-2 rounded-2xl border border-line bg-white px-3 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
          onClick={() => navigate('/meetings')}
        >
          <ArrowLeft className="h-4 w-4" /> Back to Meetings
        </button>
        {meeting ? (
          <button
            type="button"
            className="inline-flex h-10 items-center gap-2 rounded-2xl border border-line bg-white px-3 text-sm font-semibold text-brand-600 transition hover:bg-brand-50"
            onClick={() => navigate('/not-yet-invited')}
          >
            <Users className="h-4 w-4" /> Not Yet Invited
          </button>
        ) : null}
      </div>

      {meeting ? (
        <PageHeader
          title="Global Meeting"
          description={`${new Date(meeting.meeting_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} \u00b7 ${inviteeRows.length} invitees`}
        />
      ) : loading ? (
        <PageHeader title="Global Meeting" description="Loading..." />
      ) : (
        <>
          <PageHeader title="Global Meeting" description="No global meeting yet." />
          <section className="rounded-xl border border-line bg-white p-4 md:p-5">
            <h2 className="text-lg font-semibold text-ink">No global meeting yet</h2>
            <p className="mt-1 text-sm text-ink-secondary">Start the global meeting from the Meetings page before adding voters.</p>
            <Button className="mt-4" onClick={() => navigate('/meetings')}>
              <ArrowLeft className="h-4 w-4" /> Go to Meetings
            </Button>
          </section>
        </>
      )}

      {/* Part selection gate */}
      {partGateOpen && (
        <section className="rounded-xl border border-line bg-white p-4 md:p-5">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Select a Part</h2>
          <p className="mb-4 text-sm text-ink-secondary">
            Choose a part to open its family-wise dashboard, or view all parts combined.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {partProgress.map((pp) => (
              <button
                key={pp.part}
                type="button"
                onClick={() => selectPart(pp.part, 'detail')}
                className="rounded-2xl border border-line bg-white p-4 text-left transition hover:border-brand-300 hover:bg-brand-50/50 "
              >
                <div className="text-sm font-semibold text-ink">Part {pp.part}</div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-ink-tertiary">Invited Families</div>
                    <div className="text-lg font-bold text-ink">{pp.invitedFamilies}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-ink-tertiary">Invited Voters</div>
                    <div className="text-lg font-bold text-ink">{pp.invitedVoters}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-ink-tertiary">Attended</div>
                    <div className="text-lg font-bold text-emerald-600">{pp.attended}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-ink-tertiary">Pending</div>
                    <div className="text-lg font-bold text-ink-secondary">{pp.pending}</div>
                  </div>
                </div>
                {pp.personalCall > 0 ? (
                  <div className="mt-2 text-[11px] text-violet-600">{pp.personalCall} personal call</div>
                ) : null}
              </button>
            ))}
            <button
              type="button"
              onClick={() => selectPart('all', 'detail')}
              className="flex min-h-[132px] flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-muted p-4 text-center transition hover:border-brand-300 hover:bg-brand-50/50"
            >
              <span className="text-sm font-semibold text-ink-secondary">All Parts Combined</span>
              <span className="mt-1 text-xs text-ink-tertiary">Full global dashboard across every part</span>
            </button>
          </div>
        </section>
      )}

      {/* Meeting Progress */}
      {meeting && !partGateOpen && (
        <section className="rounded-xl border border-line bg-white p-4 md:p-5">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
            Meeting Progress
            <span className="ml-2 font-medium normal-case tracking-normal text-ink-tertiary">
              {partFilter === 'all' ? '· All Parts' : `· Part ${partFilter}${sectionFilter !== 'all' ? ` / Section ${sectionFilter}` : ''}`}
            </span>
          </h2>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard title="Invited Voters" value={String(meetingProgress.invitedVoters)} featured />
            <StatCard title="Invited Families" value={String(meetingProgress.invitedFamilies)} />
            <StatCard title="Attended" value={String(meetingProgress.attended)} />
            <StatCard title="Pending" value={String(meetingProgress.pending)} />
            <StatCard title="Next Meeting" value={String(meetingProgress.nextMeeting)} />
            <StatCard title="Called" value={String(meetingProgress.called)} />
            <StatCard title="Called-Confirmed" value={String(meetingProgress.calledConfirmed)} />
            <StatCard title="Called-Not Received" value={String(meetingProgress.calledNotReceived)} />
            <StatCard title="Called-Suspense" value={String(meetingProgress.calledSuspense)} />
            <StatCard title="Absent" value={String(meetingProgress.absent)} />
            <StatCard title="Not Attended" value={String(meetingProgress.notAttended)} />
            <StatCard title="Personal Call" value={String(meetingProgress.personalCall)} />
            <StatCard title="Male Voters" value={String(meetingProgress.maleVoters)} />
            <StatCard title="Female Voters" value={String(meetingProgress.femaleVoters)} />
          </div>
        </section>
      )}

      {/* Add Voters */}
      {!partGateOpen && (
      <section className="rounded-xl border border-line bg-white p-4 md:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Add Voters</h2>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-ink-secondary">
              Status for added voters
              <select
                className="h-9 rounded-xl border border-line bg-white px-2 text-xs font-semibold text-ink-secondary outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                value={addStatus}
                onChange={(e) => setAddStatus(e.target.value as MeetingAttendanceStatus)}
              >
                {ATTENDANCE_STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setShowEpicImport(true)}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
            >
              <FileSpreadsheet className="h-4 w-4" /> Import from Excel
            </button>
          </div>
        </div>

        {/* Mode toggle */}
        <div className="mb-4 flex items-center gap-1 rounded-2xl border border-line bg-muted p-1 w-fit">
          <button
            type="button"
            className={`rounded-xl px-4 py-1.5 text-xs font-semibold transition ${addVoterMode === 'family' ? 'bg-white shadow-sm text-ink' : 'text-ink-tertiary hover:text-ink-secondary'}`}
            onClick={() => setAddVoterMode('family')}
          >
            <Users className="inline h-3.5 w-3.5 mr-1" />Add Entire Family
          </button>
          <button
            type="button"
            className={`rounded-xl px-4 py-1.5 text-xs font-semibold transition ${addVoterMode === 'individual' ? 'bg-white shadow-sm text-ink' : 'text-ink-tertiary hover:text-ink-secondary'}`}
            onClick={() => setAddVoterMode('individual')}
          >
            <UserPlus className="inline h-3.5 w-3.5 mr-1" />Add Individual Voter
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            className="h-11 min-w-[240px] flex-1 rounded-2xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
            placeholder={addVoterMode === 'family' ? 'Search by name, EPIC, relative name, ward, part, section, house, contact...' : 'Search by name, EPIC, relative name, house no, contact...'}
            value={voterSearch}
            onChange={(e) => setVoterSearch(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink-tertiary">or browse:</span>
            <select
              className="h-11 rounded-2xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              value={voterBrowsePart}
              onChange={(e) => {
                setVoterBrowsePart(e.target.value)
                setVoterBrowseSection('')
                setVoterBrowseVisibleCount(30)
              }}
            >
              <option value="">Select part...</option>
              {partOptions.map((p) => (
                <option key={p} value={String(p)}>
                  Part {p}
                </option>
              ))}
            </select>
            <select
              className="h-11 rounded-2xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
              value={voterBrowseSection}
              disabled={!voterBrowsePart}
              title={voterBrowsePart ? 'Filter by section (matches the family head only)' : 'Select a part first'}
              onChange={(e) => {
                setVoterBrowseSection(e.target.value)
                setVoterBrowseVisibleCount(30)
              }}
            >
              <option value="">{voterBrowsePart ? 'All Sections' : 'Select section...'}</option>
              {browseSectionOptions.map((s) => (
                <option key={s} value={String(s)}>
                  Section {s}
                </option>
              ))}
            </select>
            {isBrowsingPart ? (
              <button
                type="button"
                className="text-xs font-semibold text-brand-600 hover:text-brand-800"
                onClick={() => {
                  setVoterBrowsePart('')
                  setVoterBrowseSection('')
                  setVoterBrowseVisibleCount(30)
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        {selectedVotersArray.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-200 bg-brand-50/60 px-4 py-3">
            <span className="text-sm font-semibold text-brand-800">{selectedVotersArray.length} voter(s) selected</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
                onClick={() => setSelectedVoterIds(new Set())}
              >
                Clear selection
              </button>
              <button
                type="button"
                className="inline-flex h-9 items-center gap-2 rounded-xl bg-brand-600 px-4 text-xs font-semibold text-white transition hover:bg-brand-700"
                onClick={() => void addInvitees()}
              >
                <Users className="h-3.5 w-3.5" /> Add {selectedVoterIds.size} Voter(s)
              </button>
            </div>
          </div>
        )}

        {/* Family Mode Search Results */}
        {addVoterMode === 'family' && (searchTokens.length > 0 || isBrowsingPart) ? (
          <div className="mt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-ink-tertiary">
                {allMatchingFamilies.length} matching famil{allMatchingFamilies.length === 1 ? 'y' : 'ies'}
                {isBrowsingPart ? ` in Part ${voterBrowsePart}` : ''}
                {!isBrowsingPart && allMatchingFamilies.length > SEARCH_FAMILY_LIMIT
                  ? ` \u00b7 showing first ${SEARCH_FAMILY_LIMIT} - refine your search for more`
                  : ''}
                {isBrowsingPart && allMatchingFamilies.length > voterBrowseVisibleCount
                  ? ` \u00b7 showing first ${voterBrowseVisibleCount}`
                  : ''}
              </p>
              <div className="flex items-center gap-3">
                {isBrowsingPart && familiesInBrowsePart.length ? (
                  <button
                    type="button"
                    className="text-xs font-semibold text-brand-600 hover:text-brand-800"
                    onClick={selectAllHeadsInBrowsePart}
                    title="Adds only the family head of every family in this part, not the members"
                  >
                    Select all family heads in Part {voterBrowsePart}
                  </button>
                ) : null}
                {visibleMatchingFamilies.length ? (
                  <button type="button" className="text-xs font-semibold text-brand-600 hover:text-brand-800" onClick={selectAllSearchResults}>
                    Select all shown
                  </button>
                ) : null}
              </div>
            </div>

            {!visibleMatchingFamilies.length ? (
              <p className="text-sm text-ink-secondary">{isBrowsingPart ? `No families found in Part ${voterBrowsePart}.` : 'No voters match this search.'}</p>
            ) : (
              <div className="space-y-4">
                {visibleMatchingFamilies.map((family) => {
                  const fullySelected = familyFullySelected(family)
                  const eligible = familyNonInvitedMembers(family)
                  const coveredElsewhereMembers = family.members.filter((m) => coveredVoterIds.has(m.id) && !inviteeVoterIds.has(m.id))
                  const invitedHereMembers = family.members.filter((m) => inviteeVoterIds.has(m.id))
                  return (
                    <div key={family.key} className="overflow-hidden rounded-xl border border-line bg-white">
                      <div className="flex flex-wrap items-start gap-3 border-b border-line bg-muted/70 px-4 py-4 sm:px-5">
                        <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
                          {family.headVoter?.photo_url && photoUrlByPath[family.headVoter.photo_url] ? (
                            <img src={photoUrlByPath[family.headVoter.photo_url]} alt={family.headVoter.name} className="h-full w-full object-cover" />
                          ) : (
                            <span className="text-sm font-semibold text-brand-700">{initials(family.headVoter?.name ?? 'NA')}</span>
                          )}
                        </div>
                        <div className="min-w-[220px] flex-1">
                          <span className="rounded-full bg-brand-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-700">Family Head</span>
                          <p className="mt-1 text-lg font-semibold text-ink">{family.headVoter?.name ?? 'Unknown'}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-secondary">
                            <span>EPIC: {family.head}</span>
                            <span>Ward: {family.headVoter?.ward_no ?? '-'}</span>
                            <span>Part: {family.headVoter?.part_no ?? '-'}</span>
                            <span>Section: {family.headVoter?.section ?? '-'}</span>
                            <span>Members: {family.members.length}</span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {coveredElsewhereMembers.length > 0 ? (
                              <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800">
                                {coveredElsewhereMembers.length === 1
                                  ? `${coveredElsewhereMembers[0].name} is already invited in another meeting`
                                  : `${coveredElsewhereMembers.length} members are already invited in another meeting`}
                              </span>
                            ) : null}
                            {invitedHereMembers.length > 0 ? (
                              <div className="flex flex-wrap items-center gap-1.5">
                                {invitedHereMembers.map((m) => {
                                  const inv = inviteeByVoterId.get(m.id)
                                  const status = inv?.attendance_status
                                  return status ? (
                                    <span key={m.id} className={`inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-semibold ${STATUS_COLORS[status]}`}>
                                      {m.name}: {ATTENDANCE_STATUS_OPTIONS.find((s) => s.value === status)?.label ?? status}
                                    </span>
                                  ) : null
                                })}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={!eligible.length}
                          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => toggleFamilySelection(family)}
                        >
                          {fullySelected ? 'Unselect family' : 'Select whole family'}
                        </button>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="min-w-full border-separate border-spacing-0 text-xs">
                          <thead className="bg-muted">
                            <tr>
                              <th className="w-10 border-b border-line px-2 py-2"></th>
                              <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Photo</th>
                              <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Name</th>
                              <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">EPIC</th>
                              <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Relative</th>
                              <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">House</th>
                              <th className="border-b border-line px-3 py-2 text-center font-semibold text-ink-secondary">Age</th>
                              <th className="border-b border-line px-3 py-2 text-center font-semibold text-ink-secondary">Ward</th>
                              <th className="border-b border-line px-3 py-2 text-center font-semibold text-ink-secondary">Part</th>
                              <th className="border-b border-line px-3 py-2 text-center font-semibold text-ink-secondary">Sec</th>
                              <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Contact</th>
                            </tr>
                          </thead>
                          <tbody>
                            {family.members.map((member) => {
                              const invitedHere = inviteeVoterIds.has(member.id)
                              const coveredElsewhere = coveredVoterIds.has(member.id) && !invitedHere
                              if (coveredElsewhere) return null
                              const checked = selectedVoterIds.has(member.id)
                              const isMatch = memberMatchesSearch(member, searchTokens)
                              return (
                                <tr key={member.id} className={`${isMatch ? 'bg-amber-50' : ''} ${invitedHere ? 'opacity-60' : ''}`}>
                                  <td className="border-b border-line px-2 py-2 text-center">
                                    <input
                                      type="checkbox"
                                      disabled={invitedHere}
                                      checked={invitedHere || checked}
                                      onChange={() => toggleVoterSelected(member.id)}
                                    />
                                  </td>
                                  <td className="border-b border-line px-3 py-2">
                                    <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-line bg-muted">
                                      {member.photo_url && photoUrlByPath[member.photo_url] ? (
                                        <img src={photoUrlByPath[member.photo_url]} alt={member.name} className="h-full w-full object-cover" />
                                      ) : (
                                        <span className="text-[10px] font-semibold text-brand-700">{initials(member.name)}</span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="border-b border-line px-3 py-2 font-medium text-ink">
                                    {member.name}
                                    {invitedHere ? statusBadge(inviteeByVoterId.get(member.id)?.attendance_status, 'ml-2') : null}
                                  </td>
                                  <td className="border-b border-line px-3 py-2 text-ink-secondary">{member.epic_no}</td>
                                  <td className="border-b border-line px-3 py-2 text-ink-secondary">
                                    {member.relative_relation ? `${member.relative_relation}. ` : ''}{member.relative_name ?? '-'}
                                  </td>
                                  <td className="border-b border-line px-3 py-2 text-ink-secondary">{member.house_no ?? '-'}</td>
                                  <td className="border-b border-line px-3 py-2 text-center text-ink-secondary">{member.age ?? '-'}</td>
                                  <td className="border-b border-line px-3 py-2 text-center text-ink-secondary">{member.ward_no ?? '-'}</td>
                                  <td className="border-b border-line px-3 py-2 text-center text-ink-secondary">{member.part_no ?? '-'}</td>
                                  <td className="border-b border-line px-3 py-2 text-center text-ink-secondary">{member.section ?? '-'}</td>
                                  <td className="border-b border-line px-3 py-2 text-ink-secondary">{member.contact_no_1 ?? '-'}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {isBrowsingPart && allMatchingFamilies.length > voterBrowseVisibleCount ? (
              <button
                type="button"
                onClick={() => setVoterBrowseVisibleCount((count) => count + 30)}
                className="mt-3 w-full rounded-xl border border-dashed border-line py-2 text-sm font-semibold text-brand-600 hover:bg-brand-50/60"
              >
                Load 30 more families
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Individual Mode Search Results */}
        {addVoterMode === 'individual' && (searchTokens.length > 0 || isBrowsingPart) ? (
          <div className="mt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-ink-tertiary">
                {matchingIndividualVoters.length} matching voter{matchingIndividualVoters.length === 1 ? '' : 's'}
                {isBrowsingPart ? ` in Part ${voterBrowsePart}` : ''}
                {isBrowsingPart && matchingIndividualVoters.length > voterBrowseVisibleCount
                  ? ` \u00b7 showing first ${voterBrowseVisibleCount}`
                  : ''}
              </p>
              {visibleMatchingIndividualVoters.length ? (
                <button type="button" className="text-xs font-semibold text-brand-600 hover:text-brand-800" onClick={selectAllIndividualResults}>
                  Select all shown
                </button>
              ) : null}
            </div>

            {!visibleMatchingIndividualVoters.length ? (
              <p className="text-sm text-ink-secondary">{isBrowsingPart ? `No voters found in Part ${voterBrowsePart}.` : 'No voters match this search.'}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full border-separate border-spacing-0 text-xs">
                  <thead className="bg-muted">
                    <tr>
                      <th className="w-10 border-b border-line px-2 py-2"></th>
                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Photo</th>
                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Name</th>
                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">EPIC</th>
                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Relative</th>
                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">House</th>
                      <th className="border-b border-line px-3 py-2 text-center font-semibold text-ink-secondary">Age</th>
                      <th className="border-b border-line px-3 py-2 text-center font-semibold text-ink-secondary">Ward</th>
                      <th className="border-b border-line px-3 py-2 text-center font-semibold text-ink-secondary">Part</th>
                      <th className="border-b border-line px-3 py-2 text-center font-semibold text-ink-secondary">Sec</th>
                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Contact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleMatchingIndividualVoters.map((member) => {
                      const invited = inviteeVoterIds.has(member.id)
                      const checked = selectedVoterIds.has(member.id)
                      const isMatch = memberMatchesSearch(member, searchTokens)
                      return (
                        <tr key={member.id} className={`${isMatch ? 'bg-amber-50' : ''} ${invited ? 'opacity-60' : ''}`}>
                          <td className="border-b border-line px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              disabled={invited}
                              checked={invited || checked}
                              onChange={() => toggleVoterSelected(member.id)}
                            />
                          </td>
                          <td className="border-b border-line px-3 py-2">
                            <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-line bg-muted">
                              {member.photo_url && photoUrlByPath[member.photo_url] ? (
                                <img src={photoUrlByPath[member.photo_url]} alt={member.name} className="h-full w-full object-cover" />
                              ) : (
                                <span className="text-[10px] font-semibold text-brand-700">{initials(member.name)}</span>
                              )}
                            </div>
                          </td>
                          <td className="border-b border-line px-3 py-2 font-medium text-ink">
                            {member.name}
                            {invited ? statusBadge(inviteeByVoterId.get(member.id)?.attendance_status, 'ml-2') : null}
                          </td>
                          <td className="border-b border-line px-3 py-2 text-ink-secondary">{member.epic_no}</td>
                          <td className="border-b border-line px-3 py-2 text-ink-secondary">
                            {member.relative_relation ? `${member.relative_relation}. ` : ''}{member.relative_name ?? '-'}
                          </td>
                          <td className="border-b border-line px-3 py-2 text-ink-secondary">{member.house_no ?? '-'}</td>
                          <td className="border-b border-line px-3 py-2 text-center text-ink-secondary">{member.age ?? '-'}</td>
                          <td className="border-b border-line px-3 py-2 text-center text-ink-secondary">{member.ward_no ?? '-'}</td>
                          <td className="border-b border-line px-3 py-2 text-center text-ink-secondary">{member.part_no ?? '-'}</td>
                          <td className="border-b border-line px-3 py-2 text-center text-ink-secondary">{member.section ?? '-'}</td>
                          <td className="border-b border-line px-3 py-2 text-ink-secondary">{member.contact_no_1 ?? '-'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {isBrowsingPart && matchingIndividualVoters.length > voterBrowseVisibleCount ? (
              <button
                type="button"
                onClick={() => setVoterBrowseVisibleCount((count) => count + 50)}
                className="mt-3 w-full rounded-xl border border-dashed border-line py-2 text-sm font-semibold text-brand-600 hover:bg-brand-50/60"
              >
                Load 50 more voters
              </button>
            ) : null}
          </div>
        ) : null}

        {addVoterMode === 'family' && !searchTokens.length && !isBrowsingPart ? (
          <p className="mt-3 text-xs text-ink-tertiary">
            Start typing a name, EPIC, or house number to search voters, or pick a part above to browse every family in it - grouped family-wise either way.
          </p>
        ) : null}
        {addVoterMode === 'individual' && !searchTokens.length && !isBrowsingPart ? (
          <p className="mt-3 text-xs text-ink-tertiary">
            Start typing a name, EPIC, or house number to search individual voters, or pick a part above to browse voters in it.
          </p>
        ) : null}
      </section>
      )}

      {/* Attendance list */}
      {!partGateOpen && (
      <section className="rounded-xl border border-line bg-white p-4 md:p-5">
        {/* Filters */}
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <input
            className="h-11 rounded-2xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100 lg:col-span-2"
            placeholder="Search attendees by name, EPIC, relative, house, contact..."
            value={attendeeSearch}
            onChange={(e) => setAttendeeSearch(e.target.value)}
          />
          <select
            className="h-11 rounded-2xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All Statuses</option>
            {ATTENDANCE_STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <select
            className="h-11 rounded-2xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
            value={partFilter}
            onChange={(e) => selectPart(e.target.value, 'detail')}
          >
            <option value="all">All Parts</option>
            {partOptions.map((p) => (
              <option key={p} value={String(p)}>Part {p}</option>
            ))}
          </select>
          <select
            className="h-11 rounded-2xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
            value={sectionFilter}
            disabled={partFilter === 'all'}
            title={partFilter === 'all' ? 'Select a part first to filter by section' : 'Filter by section (matches the family head only)'}
            onChange={(e) => setSectionFilter(e.target.value)}
          >
            <option value="all">{partFilter === 'all' ? 'All Sections (pick a part)' : 'All Sections'}</option>
            {sectionOptions.map((s) => (
              <option key={s} value={String(s)}>Section {s}</option>
            ))}
          </select>
          <select
            className="h-11 rounded-2xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
            value={wardFilter}
            onChange={(e) => setWardFilter(e.target.value)}
          >
            <option value="all">All Wards</option>
            {wardOptions.map((w) => (
              <option key={w} value={String(w)}>Ward {w}</option>
            ))}
          </select>
          <select
            className="h-11 rounded-2xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
            value={familySizeFilter}
            onChange={(e) => setFamilySizeFilter(e.target.value)}
          >
            {FAMILY_SIZE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Bulk Actions */}
        {bulkSelectedIds.size > 0 && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-200 bg-brand-50/60 px-4 py-3">
            <span className="text-sm font-semibold text-brand-800">{bulkSelectedIds.size} invitee(s) selected</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
                onClick={() => setBulkSelectedIds(new Set())}
              >
                Clear selection
              </button>
              <select
                className="h-9 rounded-xl border border-line bg-white px-2 text-xs font-semibold text-ink-secondary outline-none"
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    void applyBulkStatus(e.target.value as MeetingAttendanceStatus)
                  }
                }}
              >
                <option value="">Bulk action...</option>
                {BULK_STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Attendance List</h2>
            <p className="text-xs text-ink-tertiary">{filteredInvitees.length} of {inviteeRows.length} invitees visible</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                type="button"
                className="inline-flex h-10 items-center gap-2 rounded-2xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
                onClick={() => setTableColumnsOpen((c) => !c)}
              >
                <Cog className="h-4 w-4" /> Columns
              </button>
              {tableColumnsOpen ? (
                <div className="absolute right-0 z-30 mt-2 w-72 rounded-2xl border border-line bg-white p-3 shadow-lg">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Columns (drag order with the arrows)</p>
                  <div className="max-h-64 space-y-0.5 overflow-y-auto">
                    {tableColumns.map((key, index) => {
                      const option = MEETING_FIELD_OPTIONS.find((o) => o.key === key)
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
                            <input type="checkbox" checked onChange={() => setTableColumns((prev) => prev.filter((k) => k !== key))} />
                            {option.label}
                          </label>
                        </div>
                      )
                    })}
                    {MEETING_FIELD_OPTIONS.filter((o) => !tableColumns.includes(o.key)).map((option) => (
                      <div key={option.key} className="flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-muted">
                        <div className="flex flex-col gap-0.5">
                          <button type="button" disabled className="text-[10px] leading-none text-slate-200">▲</button>
                          <button type="button" disabled className="text-[10px] leading-none text-slate-200">▼</button>
                        </div>
                        <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-ink-tertiary">
                          <input type="checkbox" checked={false} onChange={() => setTableColumns((prev) => [...prev, option.key])} />
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
                    <button type="button" className="ml-auto text-xs font-semibold text-ink-tertiary hover:text-ink-secondary" onClick={() => setTableColumnsOpen(false)}>
                      Done
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            {expandedFamilyRows.size > 0 ? (
              <button
                type="button"
                className="inline-flex h-10 items-center gap-2 rounded-2xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
                onClick={collapseAllFamilyRows}
              >
                <Minus className="h-4 w-4" /> Collapse all
              </button>
            ) : (
              <button
                type="button"
                className="inline-flex h-10 items-center gap-2 rounded-2xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
                onClick={expandAllFamilyRows}
              >
                <Plus className="h-4 w-4" /> Reveal all
              </button>
            )}
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-2xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
              onClick={() => { setReportScope('filtered'); setShowExportModal(true) }}
            >
              <Download className="h-4 w-4" /> Export
            </button>
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-2xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
              onClick={() => { setReportScope('filtered'); setShowPrintModal(true) }}
            >
              <Printer className="h-4 w-4" /> Print
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-ink-tertiary">Loading invitees...</p>
        ) : !filteredInvitees.length ? (
          <p className="text-sm text-ink-secondary">No invitees match the current filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-xs">
              <thead className="bg-muted">
                <tr>
                  <th className="border-b border-line px-2 py-3 text-center w-8">
                    <button type="button" className="text-ink-tertiary hover:text-ink-secondary" onClick={toggleBulkSelectAll}>
                      {isAllBulkSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                    </button>
                  </th>
                  {tableColumns.map((key) => (
                    <th key={key} className={`border-b border-line px-3 py-3 font-semibold text-ink-secondary ${fieldIsCenter(key) ? 'text-center' : 'text-left'}`}>
                      {MEETING_FIELD_OPTIONS.find((o) => o.key === key)?.label ?? key}
                    </th>
                  ))}
                  <th className="border-b border-line px-3 py-3 text-left font-semibold text-ink-secondary">Category</th>
                  <th className="border-b border-line px-3 py-3 text-left font-semibold text-ink-secondary">Status</th>
                  <th className="border-b border-line px-3 py-3 text-left font-semibold text-ink-secondary">Call Note</th>
                  <th className="border-b border-line px-3 py-3 text-left font-semibold text-ink-secondary">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleInvitees.map((ir, index) => {
                  const v = ir.voter
                  const noteKey = editingNoteByInvitee[ir.invitee.id]
                  const isEditingNote = noteKey !== undefined
                  const noteDraft = noteKey ?? ir.invitee.call_note ?? ''
                  const isExpanded = expandedFamilyRows.has(ir.invitee.id)
                  const familyEpic = normalizeGroupingValue(v?.family_head_epic || v?.epic_no)
                  const familyInvitees = inviteesByFamilyEpic.get(familyEpic) ?? []
                  const familyGroup = v ? familyGroupByVoterId.get(v.id) : undefined
                  const familyBulkStatus = bulkFamilyStatusValue[familyEpic] ?? ''

                  return (
                    <React.Fragment key={ir.invitee.id}>
                      <tr className={`transition hover:bg-muted ${isExpanded ? 'bg-brand-50/30' : ''}`}>
                        <td className="border-b border-line px-2 py-3 text-center">
                          <button type="button" className="text-ink-tertiary hover:text-ink-secondary" onClick={() => toggleBulkSelect(ir.invitee.id)}>
                            {bulkSelectedIds.has(ir.invitee.id) ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                          </button>
                        </td>
                        {tableColumns.map((key) => {
                          if (key === 'photo') {
                            return (
                              <td key={key} className="border-b border-line px-3 py-3">
                                <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-line bg-muted">
                                  {v?.photo_url && photoUrlByPath[v.photo_url] ? (
                                    <img src={photoUrlByPath[v.photo_url]} alt={v.name} className="h-full w-full object-cover" />
                                  ) : (
                                    <span className="text-[10px] font-semibold text-brand-700">{v ? initials(v.name) : '?'}</span>
                                  )}
                                </div>
                              </td>
                            )
                          }
                          let value: string
                          if (key === 'srNo') {
                            value = String(index + 1)
                          } else if (key === 'familyMembersCount') {
                            value = String(v ? (familySizeByVoterId.get(v.id) ?? 0) : 0)
                          } else if (key === 'status') {
                            value = ATTENDANCE_STATUS_OPTIONS.find((s) => s.value === ir.invitee.attendance_status)?.label ?? ir.invitee.attendance_status
                          } else if (key === 'callNote') {
                            value = ir.invitee.call_note ?? '-'
                          } else {
                            value = fieldTextValue(v, key)
                          }
                          return (
                            <td
                              key={key}
                              className={`border-b border-line px-3 py-3 text-ink-secondary ${fieldIsBold(key) ? 'font-medium text-ink' : ''} ${fieldIsCenter(key) ? 'text-center' : ''} ${key === 'name' ? 'cursor-pointer hover:text-brand-600' : ''}`}
                              onClick={key === 'name' && v ? () => setSelectedVoter(v) : undefined}
                            >
                              {value}
                            </td>
                          )
                        })}
                        <td className="border-b border-line px-3 py-3 text-ink-secondary">
                          {voterCategoryLabel(v?.voter_category) ?? '-'}
                        </td>
                        <td className="border-b border-line px-3 py-3">
                          <select
                            className={`h-9 rounded-xl border px-2.5 text-xs font-semibold outline-none cursor-pointer transition ${STATUS_COLORS[ir.invitee.attendance_status]}`}
                            value={ir.invitee.attendance_status}
                            onChange={(e) => void updateStatus(ir.invitee.id, e.target.value as MeetingAttendanceStatus)}
                          >
                            {ATTENDANCE_STATUS_OPTIONS.map((s) => (
                              <option key={s.value} value={s.value}>{s.label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="border-b border-line px-3 py-3">
                          {isEditingNote ? (
                            <input
                              className="h-9 w-40 rounded-xl border border-brand-300 bg-white px-2 text-xs outline-none focus:ring-2 focus:ring-brand-100"
                              placeholder="Call note..."
                              value={noteDraft}
                              onChange={(e) => setEditingNoteByInvitee((prev) => ({ ...prev, [ir.invitee.id]: e.target.value }))}
                              onBlur={() => {
                                void updateCallNote(ir.invitee.id, noteDraft)
                                setEditingNoteByInvitee((prev) => { const next = { ...prev }; delete next[ir.invitee.id]; return next })
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  void updateCallNote(ir.invitee.id, noteDraft)
                                  setEditingNoteByInvitee((prev) => { const next = { ...prev }; delete next[ir.invitee.id]; return next })
                                }
                              }}
                              autoFocus
                            />
                          ) : (
                            <span
                              className={`cursor-pointer rounded-xl px-2.5 py-1.5 text-xs transition hover:bg-muted ${ir.invitee.call_note ? 'text-ink-secondary' : 'text-ink-tertiary italic'}`}
                              onClick={() => setEditingNoteByInvitee((prev) => ({ ...prev, [ir.invitee.id]: ir.invitee.call_note ?? '' }))}
                            >
                              {ir.invitee.call_note || 'Add note...'}
                            </span>
                          )}
                        </td>
                        <td className="border-b border-line px-3 py-3">
                          <div className="flex items-center gap-0.5">
                            <button
                              type="button"
                              className={`rounded-lg p-1.5 transition ${isExpanded ? 'bg-brand-100 text-brand-600' : 'text-ink-tertiary hover:bg-brand-50 hover:text-brand-600'}`}
                              onClick={() => toggleFamilyRowExpanded(ir.invitee.id)}
                              title="View Family"
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                            {v?.contact_no_1 ? (
                              <>
                                <a
                                  href={`tel:${v.contact_no_1}`}
                                  className="rounded-lg p-1.5 text-ink-tertiary transition hover:bg-emerald-50 hover:text-emerald-600"
                                  title="Call"
                                >
                                  <Phone className="h-3.5 w-3.5" />
                                </a>
                                <button
                                  type="button"
                                  className="rounded-lg p-1.5 text-ink-tertiary transition hover:bg-amber-50 hover:text-amber-600"
                                  onClick={() => void copyContactNumber(v.contact_no_1!)}
                                  title="Copy Contact Number"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </button>
                              </>
                            ) : null}
                            <button
                              type="button"
                              className="rounded-lg p-1.5 text-ink-tertiary transition hover:bg-rose-50 hover:text-rose-600"
                              onClick={() => void removeInvitee(ir.invitee.id)}
                              title="Remove from Meeting"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded Family Row */}
                      {isExpanded && familyGroup ? (
                        <tr>
                          <td colSpan={tableColumns.length + 4} className="border-b border-line px-4 py-4">
                            <div className="rounded-2xl border border-brand-200 bg-white p-4 shadow-sm">
                              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-3">
                                  <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-line bg-muted">
                                    {familyGroup.headVoter?.photo_url && photoUrlByPath[familyGroup.headVoter.photo_url] ? (
                                      <img src={photoUrlByPath[familyGroup.headVoter.photo_url]} alt={familyGroup.headVoter.name} className="h-full w-full object-cover" />
                                    ) : (
                                      <span className="text-xs font-semibold text-brand-700">{initials(familyGroup.headVoter?.name ?? 'NA')}</span>
                                    )}
                                  </div>
                                  <div>
                                    <p className="text-sm font-semibold text-ink">Family: {familyGroup.headVoter?.name ?? 'Unknown'}</p>
                                    <p className="text-xs text-ink-tertiary">EPIC: {familyGroup.head}  &middot; {familyGroup.members.length} members</p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <select
                                    className="h-9 rounded-xl border border-line bg-white px-2 text-xs font-semibold text-ink-secondary outline-none"
                                    value={familyBulkStatus}
                                    onChange={(e) => setBulkFamilyStatusValue((prev) => ({ ...prev, [familyEpic]: e.target.value as MeetingAttendanceStatus }))}
                                  >
                                    <option value="">Family status...</option>
                                    {ATTENDANCE_STATUS_OPTIONS.map((opt) => (
                                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                  </select>
                                  {familyBulkStatus ? (
                                    <button
                                      type="button"
                                      className="rounded-xl bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-700"
                                      onClick={() => {
                                        void applyBulkFamilyStatus(familyEpic, familyBulkStatus as MeetingAttendanceStatus)
                                      }}
                                    >
                                      <Check className="inline h-3 w-3 mr-1" />Apply to invited family ({familyInvitees.length})
                                    </button>
                                  ) : null}
                                </div>
                              </div>

                              <div className="overflow-x-auto">
                                <table className="min-w-full border-separate border-spacing-0 text-xs">
                                  <thead className="bg-muted/70">
                                    <tr>
                                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Photo</th>
                                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Name</th>
                                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">EPIC</th>
                                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Relative</th>
                                      <th className="border-b border-line px-3 py-2 text-center font-semibold text-ink-secondary">Age</th>
                                      <th className="border-b border-line px-3 py-2 text-center font-semibold text-ink-secondary">Ward</th>
                                      <th className="border-b border-line px-3 py-2 text-center font-semibold text-ink-secondary">Part</th>
                                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Category</th>
                                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Contact</th>
                                      <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-secondary">Meeting Status</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {familyGroup.members.map((member) => {
                                      const memberInvitee = inviteeByVoterId.get(member.id)
                                      const status = memberInvitee?.attendance_status
                                      const statusLabel = status
                                        ? ATTENDANCE_STATUS_OPTIONS.find((s) => s.value === status)?.label ?? status
                                        : 'Not Invited'
                                      const statusColor = status
                                        ? STATUS_COLORS[status]
                                        : 'bg-muted text-ink-tertiary border-line'
                                      return (
                                        <tr key={member.id} className="transition hover:bg-muted">
                                          <td className="border-b border-line px-3 py-2">
                                            <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-line bg-muted">
                                              {member.photo_url && photoUrlByPath[member.photo_url] ? (
                                                <img src={photoUrlByPath[member.photo_url]} alt={member.name} className="h-full w-full object-cover" />
                                              ) : (
                                                <span className="text-[9px] font-semibold text-brand-700">{initials(member.name)}</span>
                                              )}
                                            </div>
                                          </td>
                                          <td
                                            className="cursor-pointer border-b border-line px-3 py-2 font-medium text-ink hover:text-brand-600"
                                            onClick={() => setSelectedVoter(member)}
                                          >{member.name}</td>
                                          <td className="border-b border-line px-3 py-2 text-ink-secondary">{member.epic_no}</td>
                                          <td className="border-b border-line px-3 py-2 text-ink-secondary">
                                            {member.relative_relation ? `${member.relative_relation}. ` : ''}{member.relative_name ?? '-'}
                                          </td>
                                          <td className="border-b border-line px-3 py-2 text-center text-ink-secondary">{member.age ?? '-'}</td>
                                          <td className="border-b border-line px-3 py-2 text-center text-ink-secondary">{member.ward_no ?? '-'}</td>
                                          <td className="border-b border-line px-3 py-2 text-center text-ink-secondary">{member.part_no ?? '-'}</td>
                                          <td className="border-b border-line px-3 py-2 text-ink-secondary">{voterCategoryLabel(member.voter_category) ?? '-'}</td>
                                          <td className="border-b border-line px-3 py-2 text-ink-secondary">{member.contact_no_1 ?? '-'}</td>
                                          <td className="border-b border-line px-3 py-2">
                                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold border ${statusColor}`}>
                                              {statusLabel}
                                            </span>
                                          </td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {!loading && filteredInvitees.length > attendeeVisibleCount ? (
          <button
            type="button"
            onClick={() => setAttendeeVisibleCount((count) => count + 100)}
            className="mt-3 w-full rounded-xl border border-dashed border-line py-2 text-sm font-semibold text-brand-600 hover:bg-brand-50/60"
          >
            Load 100 more ({filteredInvitees.length - attendeeVisibleCount} remaining)
          </button>
        ) : null}
      </section>
      )}

      <VoterDetailDrawer
        voter={selectedVoter}
        onClose={() => setSelectedVoter(null)}
        onSaved={async () => { await load(); setSelectedVoter(null) }}
      />

      {showExportModal || showPrintModal ? (
        <ReportConfigModal
          title="Meeting Invitees"
          open
          mode={showExportModal ? 'export' : 'print'}
          fieldDefs={REPORT_FIELD_OPTIONS}
          fields={reportFieldOrder.map((key) => ({ key, enabled: reportFields[key] ?? false }))}
          defaultFields={DEFAULT_REPORT_FIELD_KEYS.map((key) => ({ key, enabled: defaultReportFields()[key] ?? false }))}
          fontSize={reportFontSize}
          boldText={reportBold}
          exportBorders={reportBorders}
          exportRowHeight={reportRowHeight}
          exportColWidth={reportColWidth}
          extraControls={
            <>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Scope</label>
                  <select
                    className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                    value={reportScope}
                    onChange={(e) => setReportScope(e.target.value as 'filtered' | 'all')}
                  >
                    <option value="filtered">Current filtered view ({filteredInvitees.length} records)</option>
                    <option value="all">All invitees ({inviteeRows.length} records)</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Group by</label>
                  <select
                    className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                    value={reportGroupBy}
                    onChange={(e) => setReportGroupBy(e.target.value as GroupByValue)}
                  >
                    {GROUP_BY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {reportGroupBy === 'family' ? (
                <p className="mt-2 text-xs text-ink-tertiary">
                  Groups invitees under their family head, so a family's invited members stay together in one section - include the "Section" field below to see each member's section too.
                </p>
              ) : null}

              <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                <input type="checkbox" checked={reportIncludeFamilies} onChange={(e) => setReportIncludeFamilies(e.target.checked)} />
                Include all family members of each invited family (not just the invited voters) - uninvited members show as "Not Invited"
              </label>

              {showPrintModal ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Paper size</label>
                    <select
                      className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                      value={reportPaperSize}
                      onChange={(e) => setReportPaperSize(e.target.value as 'a4' | 'letter')}
                    >
                      <option value="a4">A4</option>
                      <option value="letter">Letter</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Orientation</label>
                    <select
                      className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                      value={reportOrientation}
                      onChange={(e) => setReportOrientation(e.target.value as 'portrait' | 'landscape')}
                    >
                      <option value="landscape">Landscape</option>
                      <option value="portrait">Portrait</option>
                    </select>
                  </div>
                </div>
              ) : null}

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Photo size</label>
                  <select
                    className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                    value={reportPhotoSize}
                    onChange={(e) => setReportPhotoSize(e.target.value as 'small' | 'medium' | 'large')}
                  >
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Constituency header (optional)</label>
                  <input
                    className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                    placeholder="e.g. 24 - Margao"
                    value={reportHeaderConstituency}
                    onChange={(e) => setReportHeaderConstituency(e.target.value)}
                  />
                </div>
              </div>

              {showPrintModal ? (
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                  <input type="checkbox" checked={reportHeaderSignature} onChange={(e) => setReportHeaderSignature(e.target.checked)} />
                  Add signature / verification line
                </label>
              ) : null}
            </>
          }
          onClose={() => { setShowExportModal(false); setShowPrintModal(false) }}
          onConfirm={(fields: ReportFieldItem[], _layout: boolean, style: PrintStyleOptions) => {
            const order = fields.map((f) => f.key as ReportFieldKey)
            const map = {} as Record<ReportFieldKey, boolean>
            for (const f of fields) map[f.key as ReportFieldKey] = f.enabled
            setReportFieldOrder(order)
            setReportFields(map)
            if (showExportModal) {
              setReportBorders(style.exportBorders)
              setReportRowHeight(style.exportRowHeight)
              setReportColWidth(style.exportColWidth)
              handleExportExcel(style)
            } else {
              setReportFontSize(style.fontSize)
              setReportBold(style.boldText)
              handlePrint(style)
            }
          }}
        />
      ) : null}

      {showEpicImport && meeting ? (
        <EpicExcelImportModal
          title="Import voters to the meeting"
          description={`Upload an .xlsx file with one EPIC per row. Matching voters are added to "${meeting.title ?? 'Global Meeting'}" with your chosen default status; voters already invited are skipped.`}
          targetTable="meeting_invitees"
          targetId={meeting.id}
          targetLabel={meeting.title ?? 'Global Meeting'}
          existingVoterIds={new Set(invitees.map((invitee) => invitee.voter_id))}
          wardRestriction={hasWardRestriction ? allowedWards : undefined}
          profileId={profile?.id}
          defaultStatus="attended"
          onCommit={async (rows, status) => {
            if (!rows.length) return null
            const { error } = await supabase.from('meeting_invitees').upsert(
              rows.map((row) => ({
                meeting_id: meeting.id,
                voter_id: row.voter_id,
                attendance_status: status ?? 'pending',
                updated_by: profile?.id ?? null,
              })),
              { onConflict: 'meeting_id,voter_id' },
            )
            return error?.message ?? null
          }}
          onImported={load}
          onClose={() => setShowEpicImport(false)}
        />
      ) : null}
    </div>
  )
}
