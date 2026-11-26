import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Download, Printer, Search, SlidersHorizontal, UserPlus } from 'lucide-react'
import toast from 'react-hot-toast'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../components/common/PageHeader'
import { MobileSheet } from '../../components/common/MobileSheet'
import { ReportConfigModal, type ReportFieldItem } from '../../components/common/ReportConfigModal'
import { Button } from '../../components/ui/Button'
import { FilterChip } from '../../components/ui/FilterChip'
import { readUiSettings } from '../../lib/uiSettings'
import { VotersTable } from '../../components/voters/VotersTable'
import { VotersCards } from '../../components/voters/VotersCards'
import { VotersByPart } from '../../components/voters/VotersByPart'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import type { CustomField, Voter } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { useIsMobile } from '../../hooks/useIsMobile'
import { usePersistentState } from '../../hooks/usePersistentState'
import { buildPrintHtml, openPrintWindow, type PrintStyleOptions, type ReportFieldDef } from '../../lib/reportBuilder'
import { buildWardScope } from '../../lib/voterCache'
import { loadAllVoters } from '../../lib/voterDataset'
import { voterCategoryLabel } from '../../lib/voterCategory'

type VoterView = 'card' | 'table' | 'part'
type SortField = 'sr_no_roll' | 'name' | 'age' | 'part_no' | 'epic_no'
type SortDirection = 'asc' | 'desc'
type SearchMode = 'specific' | 'generic'
type ReportFieldKey =
  | 'srNo'
  | 'srNoRoll'
  | 'photo'
  | 'name'
  | 'epic'
  | 'relativeName'
  | 'relation'
  | 'houseNo'
  | 'age'
  | 'gender'
  | 'religion'
  | 'state'
  | 'contact1'
  | 'contact2'
  | 'ward'
  | 'part'
  | 'section'
  | 'sectionName'
  | 'category'
type ReportGroupBy = 'none' | 'part' | 'section' | 'ward' | 'religion' | 'gender' | 'state'

const REPORT_FIELD_OPTIONS: ReportFieldDef<Voter>[] = [
  { key: 'srNo', label: 'Sr. No.', getValue: () => '' },
  { key: 'srNoRoll', label: 'Voter Sr No', getValue: (v) => String(v.sr_no_roll ?? '') },
  { key: 'photo', label: 'Photo', getValue: (v) => v.photo_url ?? '' },
  { key: 'name', label: 'Name', getValue: (v) => v.name ?? '' },
  { key: 'epic', label: 'EPIC No.', getValue: (v) => v.epic_no ?? '' },
  { key: 'relativeName', label: 'Relative Name', getValue: (v) => v.relative_name ?? '' },
  { key: 'relation', label: 'Relation', getValue: (v) => v.relative_relation ?? '' },
  { key: 'houseNo', label: 'House No.', getValue: (v) => v.house_no ?? '' },
  { key: 'age', label: 'Age', getValue: (v) => String(v.age ?? '') },
  { key: 'gender', label: 'Gender', getValue: (v) => v.gender ?? '' },
  { key: 'religion', label: 'Religion', getValue: (v) => v.religion ?? '' },
  { key: 'state', label: 'State', getValue: (v) => v.state ?? '' },
  { key: 'contact1', label: 'Contact No. 1', getValue: (v) => v.contact_no_1 ?? '' },
  { key: 'contact2', label: 'Contact No. 2', getValue: (v) => v.contact_no_2 ?? '' },
  { key: 'ward', label: 'Ward No.', getValue: (v) => String(v.ward_no ?? '') },
  { key: 'part', label: 'Part No.', getValue: (v) => String(v.part_no ?? '') },
  { key: 'section', label: 'Section', getValue: (v) => String(v.section ?? '') },
  { key: 'sectionName', label: 'Section Name', getValue: (v) => v.section_name ?? '' },
  { key: 'category', label: 'Category', getValue: (v) => voterCategoryLabel(v.voter_category) ?? '' },
]

const DEFAULT_REPORT_FIELD_ORDER: ReportFieldKey[] = [
  'srNo',
  'srNoRoll',
  'photo',
  'name',
  'epic',
  'relativeName',
  'relation',
  'houseNo',
  'age',
  'gender',
  'religion',
  'state',
  'contact1',
  'contact2',
  'ward',
  'part',
  'section',
  'sectionName',
  'category',
]

const INITIAL_REPORT_FIELDS: Record<ReportFieldKey, boolean> = {
  srNo: true,
  srNoRoll: false,
  photo: true,
  name: true,
  epic: false,
  relativeName: false,
  relation: false,
  houseNo: false,
  age: false,
  gender: false,
  religion: false,
  state: false,
  contact1: true,
  contact2: false,
  ward: false,
  part: false,
  section: false,
  sectionName: false,
  category: false,
}

interface CustomFieldValueRow {
  voter_id: string
  field_id: string
  value: unknown
}

function scheduleIdleWork(task: () => void) {
  if (typeof window === 'undefined') {
    task()
    return
  }

  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  }

  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(task, { timeout: 1200 })
    return
  }

  window.setTimeout(task, 120)
}

async function fetchCustomFieldsForTable() {
  const primary = await supabase
    .from('custom_fields')
    .select('id,name,label,field_type,options,required,show_in_card,allow_custom_note,position')
    .order('position', { ascending: true })

  if (primary.error?.code === '42703') {
    const fallback = await supabase
      .from('custom_fields')
      .select('id,name,label,field_type,options,required,show_in_card,position')
      .order('position', { ascending: true })

    if (fallback.error) {
      return { data: null as CustomField[] | null, error: fallback.error }
    }

    const legacyFields = ((fallback.data as Omit<CustomField, 'allow_custom_note'>[] | null) ?? []).map((field) => ({
      ...field,
      allow_custom_note: false,
    }))

    return { data: legacyFields as CustomField[], error: null }
  }

  return {
    data: (primary.data as CustomField[] | null) ?? [],
    error: primary.error,
  }
}

function normalizeLookupValue(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function tokenizeLookup(value: string): string[] {
  return normalizeLookupValue(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)
}

function matchesLookupTokens(lookupText: string, tokens: string[]): boolean {
  if (!tokens.length) {
    return true
  }

  const compactLookup = lookupText.replace(/\s+/g, '')
  return tokens.every((token) => {
    const compactToken = token.replace(/\s+/g, '')
    return lookupText.includes(token) || compactLookup.includes(compactToken)
  })
}

interface PartMultiSelectProps {
  options: number[]
  selected: string[]
  onChange: (next: string[]) => void
}

function PartMultiSelect({ options, selected, onChange }: PartMultiSelectProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const label =
    selected.length === 0
      ? 'All Parts'
      : selected.length === 1
        ? `Part ${selected[0]}`
        : `${selected.length} Parts Selected`

  const toggleAll = () => onChange([])
  const togglePart = (part: string) => {
    if (selected.includes(part)) {
      onChange(selected.filter((value) => value !== part))
    } else {
      onChange([...selected, part])
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        className="flex h-10 items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-sm shadow-sm"
        aria-label="Filter by part"
        title="Filter by part"
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <ChevronDown className="h-3.5 w-3.5 text-ink-tertiary" />
      </button>

      {open ? (
        <div className="absolute left-0 top-11 z-20 max-h-64 w-40 overflow-y-auto rounded-lg border border-line bg-white p-1 shadow-popover">
          <button
            type="button"
            onClick={toggleAll}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
          >
            <span
              className={`flex h-4 w-4 items-center justify-center rounded border ${
                selected.length === 0 ? 'border-brand-600 bg-brand-600' : 'border-line'
              }`}
            >
              {selected.length === 0 ? <Check className="h-3 w-3 text-white" /> : null}
            </span>
            All Parts
          </button>

          <div className="my-1 border-t border-line" />

          {options.map((part) => {
            const value = String(part)
            const checked = selected.includes(value)
            return (
              <button
                key={value}
                type="button"
                onClick={() => togglePart(value)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded border ${
                    checked ? 'border-brand-600 bg-brand-600' : 'border-line'
                  }`}
                >
                  {checked ? <Check className="h-3 w-3 text-white" /> : null}
                </span>
                Part {part}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function VotersPage() {
  const [voters, setVoters] = useState<Voter[]>([])
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [customFieldValuesByVoterId, setCustomFieldValuesByVoterId] = useState<Record<string, Record<string, unknown>>>({})
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = usePersistentState('vote:voters:query', '')
  const [searchMode, setSearchMode] = usePersistentState<SearchMode>('vote:voters:searchMode', 'specific')
  const [mobileSearchMode, setMobileSearchMode] = usePersistentState<SearchMode>('vote:voters:mobileSearchMode', 'generic')
  const [view, setView] = usePersistentState<VoterView>('vote:voters:view', readUiSettings().defaultView)
  const [mobileView, setMobileView] = usePersistentState<VoterView>('vote:voters:mobileView', 'card')
  const [selectedParts, setSelectedParts] = usePersistentState<string[]>('vote:voters:selectedParts', [])
  const [selectedSection, setSelectedSection] = useState('all')
  const [sortField, setSortField] = usePersistentState<SortField>('vote:voters:sortField', 'sr_no_roll')
  const [sortDirection, setSortDirection] = usePersistentState<SortDirection>('vote:voters:sortDirection', 'asc')
  const [religionFilter, setReligionFilter] = usePersistentState<string>('vote:voters:religionFilter', 'all')
  const [genderFilter, setGenderFilter] = usePersistentState<string>('vote:voters:genderFilter', 'all')
  const [stateFilter, setStateFilter] = usePersistentState<string>('vote:voters:stateFilter', 'all')
  const [pageSize, setPageSize] = usePersistentState<number>('vote:voters:pageSize', readUiSettings().pageSize)
  const uiDensity = readUiSettings().density
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>({})
  const [loadedCustomValueVoterIds, setLoadedCustomValueVoterIds] = useState<Record<string, true>>({})
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
  const [showPrintModal, setShowPrintModal] = useState(false)
  const [reportScope, setReportScope] = useState<'filtered' | 'all'>('filtered')
  const [reportGroupBy, setReportGroupBy] = useState<ReportGroupBy>('none')
  const [reportFields, setReportFields] = useState<Record<ReportFieldKey, boolean>>({ ...INITIAL_REPORT_FIELDS })
  const [reportFieldOrder, setReportFieldOrder] = useState<ReportFieldKey[]>([...DEFAULT_REPORT_FIELD_ORDER])
  const [reportFontSize, setReportFontSize] = usePersistentState<number>('vote:voters:printFontSize:v2', 20)
  const [reportBold, setReportBold] = usePersistentState<boolean>('vote:voters:printBold', false)
  const isMobile = useIsMobile()
  const effectiveView = isMobile ? mobileView : view
  const setEffectiveView = (next: VoterView) => {
    if (isMobile) {
      setMobileView(next)
    } else {
      setView(next)
    }
  }
  const effectiveSearchMode = isMobile ? mobileSearchMode : searchMode
  const setEffectiveSearchMode = (next: SearchMode) => {
    if (isMobile) {
      setMobileSearchMode(next)
    } else {
      setSearchMode(next)
    }
  }
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { profile, isAdminAreaAllowed } = useAuth()
  const wardScope = buildWardScope(profile?.role, profile?.allowed_wards)
  const searchTokens = useMemo(() => tokenizeLookup(query), [query])
  const hasActiveSearch = searchTokens.length > 0

  useEffect(() => {
    const urlQuery = searchParams.get('q')
    if (urlQuery && query === '') {
      setQuery(urlQuery)
    }
  }, [query, searchParams, setQuery])

  const activeFilterCount =
    (selectedParts.length > 0 ? 1 : 0) +
    (selectedSection !== 'all' ? 1 : 0) +
    (religionFilter !== 'all' ? 1 : 0) +
    (genderFilter !== 'all' ? 1 : 0) +
    (stateFilter !== 'all' ? 1 : 0)

  const partOptions = useMemo(() => {
    return Array.from(new Set(voters.map((voter) => voter.part_no).filter((value): value is number => value !== null))).sort((a, b) => a - b)
  }, [voters])

  const sectionOptions = useMemo(() => {
    if (selectedParts.length === 0) {
      return []
    }
    const partSet = new Set(selectedParts)
    const source = voters.filter((voter) => partSet.has(String(voter.part_no ?? '')))
    return Array.from(new Set(source.map((voter) => voter.section).filter((value): value is number => value !== null))).sort((a, b) => a - b)
  }, [selectedParts, voters])

  const religionOptions = useMemo(() => {
    return Array.from(new Set(voters.map((voter) => (voter.religion ?? '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))
  }, [voters])

  const genderOptions = useMemo(() => {
    return Array.from(new Set(voters.map((voter) => voter.gender).filter((value): value is NonNullable<Voter['gender']> => Boolean(value))))
  }, [voters])

  const stateOptions = useMemo(() => {
    return Array.from(new Set(voters.map((voter) => (voter.state ?? '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))
  }, [voters])

  const load = useCallback(async () => {
    setLoading(true)

    try {
      const allRows = await loadAllVoters({
        role: profile?.role,
        allowedWards: profile?.allowed_wards,
        onFirstBatch: (rows: Voter[]) => {
          setVoters(rows)
          setLoading(false)
        },
      })

      setVoters(allRows)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Voter load failed')
    } finally {
      setLoading(false)
    }

    try {
      const customFieldRes = await fetchCustomFieldsForTable()
      if (customFieldRes.error) {
        toast.error(customFieldRes.error.message)
        setCustomFields([])
      } else {
        setCustomFields(customFieldRes.data ?? [])
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load custom field values.'
      toast.error(message)
      setCustomFields([])
    }

    setLoading(false)
  }, [profile?.allowed_wards, profile?.role, wardScope])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (selectedParts.length === 0 && selectedSection !== 'all') {
      setSelectedSection('all')
    }
  }, [selectedParts, selectedSection])

  useEffect(() => {
    if (selectedParts.length === 0) {
      return
    }
    const validParts = selectedParts.filter((part) => partOptions.some((option) => String(option) === part))
    if (validParts.length !== selectedParts.length) {
      setSelectedParts(validParts)
    }
  }, [partOptions, selectedParts, setSelectedParts])

  useEffect(() => {
    if (selectedSection !== 'all' && !sectionOptions.some((section) => String(section) === selectedSection)) {
      setSelectedSection('all')
    }
  }, [sectionOptions, selectedSection])

  useEffect(() => {
    if (religionFilter !== 'all' && !religionOptions.includes(religionFilter)) {
      setReligionFilter('all')
    }
  }, [religionFilter, religionOptions, setReligionFilter])

  useEffect(() => {
    if (genderFilter !== 'all' && !genderOptions.includes(genderFilter as NonNullable<Voter['gender']>)) {
      setGenderFilter('all')
    }
  }, [genderFilter, genderOptions, setGenderFilter])

  useEffect(() => {
    if (stateFilter !== 'all' && !stateOptions.includes(stateFilter)) {
      setStateFilter('all')
    }
  }, [setStateFilter, stateFilter, stateOptions])

  const filtered = useMemo(() => {
    const base = voters.filter((voter) => {
      if (selectedParts.length > 0 && !selectedParts.includes(String(voter.part_no ?? ''))) {
        return false
      }

      if (selectedParts.length > 0 && selectedSection !== 'all' && String(voter.section ?? '') !== selectedSection) {
        return false
      }

      if (religionFilter !== 'all' && (voter.religion ?? '').toUpperCase() !== religionFilter.toUpperCase()) {
        return false
      }

      if (genderFilter !== 'all' && (voter.gender ?? '').toUpperCase() !== genderFilter.toUpperCase()) {
        return false
      }

      if (stateFilter !== 'all' && (voter.state ?? '').toUpperCase() !== stateFilter.toUpperCase()) {
        return false
      }

      if (!searchTokens.length) {
        return true
      }

      if (effectiveSearchMode === 'specific') {
        return normalizeLookupValue(voter.name) === normalizeLookupValue(query)
      }
      const lookupText = normalizeLookupValue(
        [
          voter.name,
          voter.epic_no,
          voter.contact_no_1,
          voter.contact_no_2,
          voter.section_name,
          voter.relative_name,
          voter.relative_relation,
          voter.house_no,
          voter.family_head_epic,
          String(voter.ward_no ?? ''),
          String(voter.part_no ?? ''),
          String(voter.section ?? ''),
        ].join(' '),
      )

      return matchesLookupTokens(lookupText, searchTokens)
    })

    const sorted = [...base].sort((a, b) => {
      const dir = sortDirection === 'asc' ? 1 : -1

      if (sortField === 'name' || sortField === 'epic_no') {
        const aValue = String(a[sortField] ?? '').toUpperCase()
        const bValue = String(b[sortField] ?? '').toUpperCase()
        return aValue.localeCompare(bValue) * dir
      }

      const aValue = Number(a[sortField] ?? Number.MAX_SAFE_INTEGER)
      const bValue = Number(b[sortField] ?? Number.MAX_SAFE_INTEGER)
      if (aValue === bValue) {
        return String(a.name ?? '').localeCompare(String(b.name ?? '')) * dir
      }
      return (aValue - bValue) * dir
    })

    return sorted
  }, [
    hasActiveSearch,
    searchTokens,
    voters,
    selectedParts,
    selectedSection,
    religionFilter,
    genderFilter,
    stateFilter,
    effectiveSearchMode,
    query,
    sortField,
    sortDirection,
  ])

  const pagedRows = useMemo(() => {
    if (hasActiveSearch) {
      return filtered
    }
    return filtered.slice(0, pageSize)
  }, [filtered, hasActiveSearch, pageSize])

  useEffect(() => {
    if (!customFields.length || !pagedRows.length) {
      return
    }

    const idsToLoad = pagedRows
      .map((voter) => voter.id)
      .filter((id) => !loadedCustomValueVoterIds[id])

    if (!idsToLoad.length) {
      return
    }

    let cancelled = false

    const run = async () => {
      const chunkSize = 80
      const rows: CustomFieldValueRow[] = []

      for (let start = 0; start < idsToLoad.length; start += chunkSize) {
        const batch = idsToLoad.slice(start, start + chunkSize)
        const { data, error } = await supabase.from('custom_field_values').select('voter_id,field_id,value').in('voter_id', batch)

        if (cancelled) {
          return
        }

        if (error) {
          toast.error(error.message)
          return
        }

        rows.push(...(((data as CustomFieldValueRow[] | null) ?? []) as CustomFieldValueRow[]))
      }

      if (cancelled) {
        return
      }

      const groupedValues = rows.reduce<Record<string, Record<string, unknown>>>((acc, row) => {
        if (!acc[row.voter_id]) {
          acc[row.voter_id] = {}
        }
        acc[row.voter_id][row.field_id] = row.value
        return acc
      }, {})

      setCustomFieldValuesByVoterId((current) => ({ ...current, ...groupedValues }))
      setLoadedCustomValueVoterIds((current) => {
        const next = { ...current }
        for (const id of idsToLoad) {
          next[id] = true
        }
        return next
      })
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [customFields.length, loadedCustomValueVoterIds, pagedRows])

  useEffect(() => {
    const photoPaths = Array.from(new Set(pagedRows.map((voter) => voter.photo_url).filter(Boolean))) as string[]
    const missingPaths = photoPaths.filter((path) => !photoUrlByPath[path])

    if (!missingPaths.length) {
      return
    }

    scheduleIdleWork(() => {
      supabase.storage
        .from('voter-photos')
        .createSignedUrls(missingPaths, 60 * 60)
        .then(({ data, error }) => {
          if (error || !data) {
            return
          }

          const next: Record<string, string> = {}
          for (let index = 0; index < missingPaths.length; index += 1) {
            const path = missingPaths[index]
            const signed = data[index]?.signedUrl
            if (signed) {
              next[path] = signed
            }
          }

          if (Object.keys(next).length) {
            setPhotoUrlByPath((current) => ({ ...current, ...next }))
          }
        })
    })
  }, [pagedRows, photoUrlByPath])

  const photoUrlsByVoterId = useMemo(() => {
    const map: Record<string, string> = {}
    for (const voter of pagedRows) {
      if (voter.photo_url && photoUrlByPath[voter.photo_url]) {
        map[voter.id] = photoUrlByPath[voter.photo_url]
      }
    }
    return map
  }, [pagedRows, photoUrlByPath])

  const resetFilters = () => {
    setQuery('')
    setEffectiveSearchMode('generic')
    setSelectedParts([])
    setSelectedSection('all')
    setSortField('sr_no_roll')
    setSortDirection('asc')
    setReligionFilter('all')
    setGenderFilter('all')
    setStateFilter('all')
    setPageSize(20)
  }

  const exportCsv = () => {
    if (!filtered.length) {
      toast.error('Nothing to export.')
      return
    }

    const headers = ['EPIC', 'Name', 'Part', 'Section', 'Mobile', 'Gender']
    const lines = filtered.map((row) => [row.epic_no, row.name, row.part_no ?? '', row.section ?? '', row.contact_no_1 ?? '', row.gender ?? ''])
    const csv = [headers, ...lines].map((line) => line.join(',')).join('\n')

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'voters-export.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const reportSourceRows = reportScope === 'filtered' ? filtered : voters

  const resolveGroupLabel = (voter: Voter, groupBy: ReportGroupBy): string => {
    switch (groupBy) {
      case 'part':
        return voter.part_no != null ? `Part ${voter.part_no}` : 'Part -'
      case 'section':
        return voter.section != null ? `Section ${voter.section}` : 'Section -'
      case 'ward':
        return voter.ward_no != null ? `Ward ${voter.ward_no}` : 'Ward -'
      case 'religion':
        return (voter.religion ?? '').trim() || 'Religion -'
      case 'gender':
        return voter.gender ?? 'Gender -'
      case 'state':
        return (voter.state ?? '').trim() || 'State -'
      default:
        return ''
    }
  }

  const handlePrint = async (style: PrintStyleOptions, items?: ReportFieldItem[]) => {
    const workingFields = items ?? reportFieldOrder.map((key) => ({ key, enabled: reportFields[key] ?? false }))
    const orderedKeys = workingFields.filter((item) => item.enabled).map((item) => item.key as ReportFieldKey)
    if (!orderedKeys.length) {
      toast.error('Select at least one field to print.')
      return
    }

    if (!reportSourceRows.length) {
      toast.error('Nothing to print.')
      return
    }

    let urls = photoUrlByPath
    if (orderedKeys.includes('photo')) {
      const missing = Array.from(
        new Set(reportSourceRows.map((voter) => voter.photo_url).filter((path): path is string => Boolean(path))),
      ).filter((path) => !urls[path])
      if (missing.length) {
        const signed: Record<string, string> = {}
        for (let i = 0; i < missing.length; i += 80) {
          const batch = missing.slice(i, i + 80)
          const { data } = await supabase.storage.from('voter-photos').createSignedUrls(batch, 3600)
          if (!data) continue
          for (let j = 0; j < batch.length; j += 1) {
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

    const srById = new Map<string, number>()
    reportSourceRows.forEach((voter, index) => {
      srById.set(voter.id, index + 1)
    })

    const orderedFields = orderedKeys
      .map((key) => {
        const def = REPORT_FIELD_OPTIONS.find((option) => option.key === key)
        if (!def) return null
        if (key === 'srNo') {
          return { ...def, getValue: (voter: Voter) => String(srById.get(voter.id) ?? '') }
        }
        return def
      })
      .filter((field): field is ReportFieldDef<Voter> => Boolean(field))

    const html = buildPrintHtml(
      {
        rows: reportSourceRows,
        fields: orderedFields,
        title: 'Voters Report',
        meta: `Generated ${new Date().toLocaleString()} · ${reportSourceRows.length} voters`,
        photoResolver: orderedKeys.includes('photo')
          ? (voter) => (voter.photo_url ? urls[voter.photo_url] ?? '' : '')
          : undefined,
        ...(reportGroupBy !== 'none'
          ? {
              groupBy: {
                groupBy: reportGroupBy,
                resolve: (voter: Voter) => resolveGroupLabel(voter, reportGroupBy),
              },
            }
          : {}),
      },
      style,
    )

    openPrintWindow(html)
    setShowPrintModal(false)
  }

  return (
    <div>
      <PageHeader
        title="Voters"
        description={`${filtered.length} voters found`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {isAdminAreaAllowed ? (
              <Button onClick={() => navigate('/voters/new')}>
                <UserPlus className="h-4 w-4" />
                Add voter
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                setReportScope('filtered')
                setShowPrintModal(true)
              }}
            >
              <Printer className="h-4 w-4" />
              Print
            </Button>
            <Button variant="secondary" onClick={exportCsv}>
              <Download className="h-4 w-4" />
              Export
            </Button>
          </div>
        }
      />

      <section className="mb-3 hidden rounded-xl border border-line bg-white p-3 shadow-soft md:block">
        {hasActiveSearch ? (
          <p className="mb-2 text-xs text-ink-tertiary">
            {searchMode === 'specific'
              ? 'Specific search: exact matches from the voter name column.'
              : 'Generic search: matched across voter and relative details.'}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
            <input
              className="h-10 w-full rounded-lg border border-line bg-muted/40 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-200"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchMode === 'specific' ? 'Search exact voter name' : 'Search by name, EPIC, mobile, relative'}
            />
          </div>

          <select
            className="h-10 rounded-lg border border-line bg-white px-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            value={searchMode}
            aria-label="Search mode"
            title="Search mode"
            onChange={(event) => setSearchMode(event.target.value as SearchMode)}
          >
            <option value="specific">Specific (Exact Name)</option>
            <option value="generic">Generic (All Fields)</option>
          </select>

          <PartMultiSelect
            options={partOptions}
            selected={selectedParts}
            onChange={(next) => {
              setSelectedParts(next)
              setSelectedSection('all')
            }}
          />

          <select
            className="h-10 rounded-lg border border-line bg-white px-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
            value={selectedSection}
            aria-label="Filter by section"
            title={selectedParts.length === 0 ? 'Select a part to filter by section' : 'Filter by section'}
            disabled={selectedParts.length === 0}
            onChange={(event) => setSelectedSection(event.target.value)}
          >
            <option value="all">All Sections</option>
            {sectionOptions.map((section) => (
              <option key={section} value={String(section)}>
                Section {section}
              </option>
            ))}
          </select>

          <select
            className="h-10 rounded-lg border border-line bg-white px-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            value={sortField}
            aria-label="Sort field"
            title="Sort field"
            onChange={(event) => setSortField(event.target.value as SortField)}
          >
            <option value="sr_no_roll">Sort: Serial No</option>
            <option value="name">Sort: Name</option>
            <option value="age">Sort: Age</option>
            <option value="part_no">Sort: Part No</option>
            <option value="epic_no">Sort: EPIC No</option>
          </select>

          <select
            className="h-10 rounded-lg border border-line bg-white px-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            value={sortDirection}
            aria-label="Sort direction"
            title="Sort direction"
            onChange={(event) => setSortDirection(event.target.value as SortDirection)}
          >
            <option value="asc">Asc</option>
            <option value="desc">Desc</option>
          </select>

          <select
            className="h-10 rounded-lg border border-line bg-white px-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            value={religionFilter}
            aria-label="Filter by religion"
            title="Filter by religion"
            onChange={(event) => setReligionFilter(event.target.value)}
          >
            <option value="all">All Religions</option>
            {religionOptions.map((religion) => (
              <option key={religion} value={religion}>
                {religion}
              </option>
            ))}
          </select>

          <select
            className="h-10 rounded-lg border border-line bg-white px-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            value={genderFilter}
            aria-label="Filter by gender"
            title="Filter by gender"
            onChange={(event) => setGenderFilter(event.target.value)}
          >
            <option value="all">All Genders</option>
            {genderOptions.map((gender) => (
              <option key={gender} value={gender}>
                {gender}
              </option>
            ))}
          </select>

          <select
            className="h-10 rounded-lg border border-line bg-white px-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            value={stateFilter}
            aria-label="Filter by state"
            title="Filter by state"
            onChange={(event) => setStateFilter(event.target.value)}
          >
            <option value="all">All States</option>
            {stateOptions.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>

          <Button variant="ghost" size="compact" onClick={resetFilters}>
            Reset
          </Button>

          <div className="inline-flex rounded-lg border border-line bg-muted/50 p-0.5">
            {(['card', 'table', 'part'] as VoterView[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setEffectiveView(item)}
                className={`h-8 rounded-md px-2.5 text-xs font-medium capitalize ${
                  item === effectiveView ? 'bg-brand-600 text-white' : 'text-ink-secondary'
                }`}
              >
                {item === 'part' ? 'By Part' : item}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mb-3 md:hidden">
        <div className="sticky top-[4.5rem] z-20 rounded-xl border border-line bg-white/95 p-2 shadow-soft backdrop-blur-md">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
              <input
                className="h-11 w-full rounded-lg border border-line bg-muted/40 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-200"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name, EPIC, mobile, relative"
              />
            </div>
            <button
              type="button"
              onClick={() => setFilterSheetOpen(true)}
              className="relative flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-medium text-ink-secondary"
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span>Filter</span>
              {activeFilterCount > 0 ? (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1 text-[11px] font-bold text-white">
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
          </div>

          {activeFilterCount > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {selectedParts.map((part) => (
                <FilterChip key={part} onDismiss={() => setSelectedParts((current) => current.filter((value) => value !== part))}>
                  Part {part}
                </FilterChip>
              ))}
              {selectedSection !== 'all' ? (
                <FilterChip onDismiss={() => setSelectedSection('all')}>Section {selectedSection}</FilterChip>
              ) : null}
              {religionFilter !== 'all' ? (
                <FilterChip onDismiss={() => setReligionFilter('all')}>{religionFilter}</FilterChip>
              ) : null}
              {genderFilter !== 'all' ? (
                <FilterChip onDismiss={() => setGenderFilter('all')}>{genderFilter}</FilterChip>
              ) : null}
              {stateFilter !== 'all' ? (
                <FilterChip onDismiss={() => setStateFilter('all')}>{stateFilter}</FilterChip>
              ) : null}
            </div>
          ) : null}

          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="inline-flex rounded-lg border border-line bg-muted/50 p-0.5">
              {(['card', 'part'] as VoterView[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setEffectiveView(item)}
                  className={`h-9 rounded-md px-3 text-xs font-medium capitalize ${
                    item === effectiveView ? 'bg-brand-600 text-white' : 'text-ink-secondary'
                  }`}
                >
                  {item === 'part' ? 'By Part' : 'Cards'}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setEffectiveView(effectiveView === 'table' ? 'card' : 'table')}
              className={`h-9 rounded-lg border px-3 text-xs font-medium ${
                effectiveView === 'table' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-ink-secondary'
              }`}
            >
              Table
            </button>
          </div>
        </div>
      </section>

      <MobileSheet
        open={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        title="Filter & Sort"
        footer={
          <div className="flex gap-3">
            <Button variant="secondary" className="h-11 flex-1" onClick={resetFilters}>
              Reset all
            </Button>
            <Button className="h-11 flex-1" onClick={() => setFilterSheetOpen(false)}>
              Apply
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Search mode</p>
            <div className="inline-flex rounded-lg border border-line bg-muted/50 p-0.5">
              {(['specific', 'generic'] as SearchMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setEffectiveSearchMode(mode)}
                  className={`h-9 rounded-md px-3 text-xs font-medium capitalize ${
                    mode === effectiveSearchMode ? 'bg-brand-600 text-white' : 'text-ink-secondary'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-ink-tertiary">
              {effectiveSearchMode === 'specific'
                ? 'Exact matches from voter Name column only.'
                : 'Matched across name, EPIC, mobile, relative details.'}
            </p>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Parts</p>
            <div className="flex flex-wrap gap-1.5">
              <FilterChip
                active={selectedParts.length === 0}
                onClick={() => {
                  setSelectedParts([])
                  setSelectedSection('all')
                }}
              >
                All
              </FilterChip>
              {partOptions.map((part) => {
                const value = String(part)
                const active = selectedParts.includes(value)
                return (
                  <FilterChip
                    key={value}
                    active={active}
                    onClick={() => {
                      setSelectedParts((current) =>
                        active ? current.filter((item) => item !== value) : [...current, value],
                      )
                      setSelectedSection('all')
                    }}
                  >
                    Part {part}
                  </FilterChip>
                )
              })}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Section</p>
            <select
              className="h-11 w-full rounded-lg border border-line px-3 text-sm disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
              value={selectedSection}
              disabled={selectedParts.length === 0}
              onChange={(event) => setSelectedSection(event.target.value)}
            >
              <option value="all">All Sections</option>
              {sectionOptions.map((section) => (
                <option key={section} value={String(section)}>
                  Section {section}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Sort by</p>
            <div className="grid grid-cols-2 gap-2">
              <select
                className="h-11 rounded-lg border border-line px-3 text-sm"
                value={sortField}
                onChange={(event) => setSortField(event.target.value as SortField)}
              >
                <option value="sr_no_roll">Serial No</option>
                <option value="name">Name</option>
                <option value="age">Age</option>
                <option value="part_no">Part No</option>
                <option value="epic_no">EPIC No</option>
              </select>
              <select
                className="h-11 rounded-lg border border-line px-3 text-sm"
                value={sortDirection}
                onChange={(event) => setSortDirection(event.target.value as SortDirection)}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Religion</p>
            <select
              className="h-11 w-full rounded-lg border border-line px-3 text-sm"
              value={religionFilter}
              onChange={(event) => setReligionFilter(event.target.value)}
            >
              <option value="all">All Religions</option>
              {religionOptions.map((religion) => (
                <option key={religion} value={religion}>
                  {religion}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Gender</p>
            <select
              className="h-11 w-full rounded-lg border border-line px-3 text-sm"
              value={genderFilter}
              onChange={(event) => setGenderFilter(event.target.value)}
            >
              <option value="all">All Genders</option>
              {genderOptions.map((gender) => (
                <option key={gender} value={gender}>
                  {gender}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">State</p>
            <select
              className="h-11 w-full rounded-lg border border-line px-3 text-sm"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value)}
            >
              <option value="all">All States</option>
              {stateOptions.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </div>
        </div>
      </MobileSheet>

      {loading ? <p className="text-sm text-ink-secondary">Loading voters...</p> : null}
      {!loading && effectiveView === 'table' ? (
        <VotersTable
          voters={filtered}
          photoUrls={photoUrlsByVoterId}
          onSelectVoter={setSelectedVoter}
          customFields={customFields}
          customFieldValuesByVoterId={customFieldValuesByVoterId}
          pageSize={pageSize}
          onPageSizeChange={setPageSize}
          density={uiDensity}
        />
      ) : null}
      {!loading && effectiveView === 'card' ? (
        <VotersCards voters={pagedRows} photoUrls={photoUrlsByVoterId} onSelectVoter={setSelectedVoter} />
      ) : null}
      {!loading && effectiveView === 'part' ? <VotersByPart voters={pagedRows} onSelectVoter={setSelectedVoter} /> : null}

      <VoterDetailDrawer
        voter={selectedVoter}
        onClose={() => setSelectedVoter(null)}
        onSaved={async () => {
          await load()
          if (selectedVoter?.id) {
            const { data } = await supabase.from('voters').select('*').eq('id', selectedVoter.id).maybeSingle()
            setSelectedVoter((data as Voter | null) ?? null)
          }
        }}
      />

      {showPrintModal ? (
        <ReportConfigModal
          title="Voters"
          open
          mode="print"
          fieldDefs={REPORT_FIELD_OPTIONS}
          fields={reportFieldOrder.map((key) => ({ key, enabled: reportFields[key] ?? false }))}
          defaultFields={DEFAULT_REPORT_FIELD_ORDER.map((key) => ({ key, enabled: INITIAL_REPORT_FIELDS[key] ?? false }))}
          fontSize={reportFontSize}
          boldText={reportBold}
          printDescription="Choose columns, grouping, and font, then print or save as PDF from the browser dialog."
          extraControls={
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Scope</label>
                <select
                  className="h-10 w-full rounded-lg border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                  value={reportScope}
                  onChange={(event) => setReportScope(event.target.value as 'filtered' | 'all')}
                >
                  <option value="filtered">Current filtered view ({filtered.length} voters)</option>
                  <option value="all">All voters ({voters.length} voters)</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Group by</label>
                <select
                  className="h-10 w-full rounded-lg border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                  value={reportGroupBy}
                  onChange={(event) => setReportGroupBy(event.target.value as ReportGroupBy)}
                >
                  <option value="none">No grouping</option>
                  <option value="part">Part-wise</option>
                  <option value="section">Section-wise</option>
                  <option value="ward">Ward-wise</option>
                  <option value="religion">Religion-wise</option>
                  <option value="gender">Gender-wise</option>
                  <option value="state">State-wise</option>
                </select>
              </div>
            </div>
          }
          onClose={() => setShowPrintModal(false)}
          onConfirm={(fields: ReportFieldItem[], _layout: boolean, style: PrintStyleOptions) => {
            const order = fields.map((item) => item.key as ReportFieldKey)
            const map = { ...INITIAL_REPORT_FIELDS }
            for (const item of fields) {
              map[item.key as ReportFieldKey] = item.enabled
            }
            setReportFieldOrder(order)
            setReportFields(map)
            setReportFontSize(style.fontSize)
            setReportBold(style.boldText)
            void handlePrint(style, fields)
          }}
        />
      ) : null}
    </div>
  )
}
