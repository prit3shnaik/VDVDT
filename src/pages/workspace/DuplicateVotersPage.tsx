import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import toast from 'react-hot-toast'
import { AlertTriangle, Copy, Download, Loader2, Search, Users } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import { Button } from '../../components/ui/Button'
import { useAuth } from '../../hooks/useAuth'
import { usePersistentState } from '../../hooks/usePersistentState'
import { usePhotoUrls } from '../../hooks/usePhotoUrls'
import { initials } from '../../lib/searchUtils'
import { presenceLabel } from '../../lib/presence'
import { DEFAULT_PRINT_STYLE, exportRowsToExcel, type ReportFieldDef } from '../../lib/reportBuilder'
import type { Voter, VoterDuplicateGroup, VoterDuplicateMode } from '../../lib/types'
import {
  VOTER_DUPLICATE_MODES,
  duplicateModeLabel,
  fetchVoterDuplicates,
} from '../../lib/voterDuplicates'

type StatusFilter = 'all' | 'active' | 'disabled'

interface DuplicateReportRow {
  group: string
  srNo: string
  name: string
  epicNo: string
  houseNo: string
  ward: string
  part: string
  section: string
  age: string
  gender: string
  relativeName: string
  relation: string
  contact1: string
  contact2: string
  presence: string
  status: string
}

const REPORT_FIELDS: Array<ReportFieldDef<DuplicateReportRow>> = [
  { key: 'srNo', label: 'Sr No', getValue: (row) => row.srNo },
  { key: 'name', label: 'Name', getValue: (row) => row.name },
  { key: 'epicNo', label: 'EPIC', getValue: (row) => row.epicNo },
  { key: 'houseNo', label: 'House no', getValue: (row) => row.houseNo },
  { key: 'ward', label: 'Ward', getValue: (row) => row.ward },
  { key: 'part', label: 'Part', getValue: (row) => row.part },
  { key: 'section', label: 'Section', getValue: (row) => row.section },
  { key: 'age', label: 'Age', getValue: (row) => row.age },
  { key: 'gender', label: 'Gender', getValue: (row) => row.gender },
  { key: 'relativeName', label: 'Relative name', getValue: (row) => row.relativeName },
  { key: 'relation', label: 'Relation', getValue: (row) => row.relation },
  { key: 'contact1', label: 'Contact 1', getValue: (row) => row.contact1 },
  { key: 'contact2', label: 'Contact 2', getValue: (row) => row.contact2 },
  { key: 'presence', label: 'Presence', getValue: (row) => row.presence },
  { key: 'status', label: 'Status', getValue: (row) => row.status },
]

function isVoterActive(voter: Voter): boolean {
  const value = voter.is_active
  return value !== false && value !== 0 && String(value ?? '') !== '0'
}

function Avatar({ name, photoUrl }: { name: string; photoUrl?: string }) {
  if (photoUrl) {
    return <img src={photoUrl} alt={name} className="h-9 w-9 flex-shrink-0 rounded-full border border-line object-cover" />
  }
  return (
    <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-[11px] font-semibold text-brand-700">
      {initials(name)}
    </span>
  )
}

function FilterSelect({ label, value, onChange, children }: {
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <label className="flex min-w-[8.5rem] flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
      {label}
      <select
        className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold normal-case tracking-normal text-ink-secondary outline-none focus:border-brand-300"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  )
}

export function DuplicateVotersPage() {
  const { profile } = useAuth()

  const [mode, setMode] = usePersistentState<VoterDuplicateMode>('vote:duplicates:mode', 'name_house')
  const [query, setQuery] = usePersistentState<string>('vote:duplicates:q', '')
  const [wardFilter, setWardFilter] = usePersistentState<string>('vote:duplicates:ward', 'all')
  const [partFilter, setPartFilter] = usePersistentState<string>('vote:duplicates:part', 'all')
  const [sectionFilter, setSectionFilter] = usePersistentState<string>('vote:duplicates:section', 'all')
  const [houseFilter, setHouseFilter] = usePersistentState<string>('vote:duplicates:house', '')
  const [statusFilter, setStatusFilter] = usePersistentState<StatusFilter>('vote:duplicates:status', 'all')

  const [groups, setGroups] = useState<VoterDuplicateGroup[]>([])
  const [totals, setTotals] = useState({ groups: 0, voters: 0, scanned: 0, truncated: false, scanLimited: false })
  const [loading, setLoading] = useState(true)
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [debouncedQuery, setDebouncedQuery] = useState(query)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetchVoterDuplicates({
        q: debouncedQuery.trim() || undefined,
        mode,
        ward_no: wardFilter === 'all' ? undefined : wardFilter,
        part_no: partFilter === 'all' ? undefined : partFilter,
        section: sectionFilter === 'all' ? undefined : sectionFilter,
        house_no: houseFilter.trim() || undefined,
        status: statusFilter,
      })
      setGroups(response.groups ?? [])
      setTotals({
        groups: response.totalGroups ?? 0,
        voters: response.totalVoters ?? 0,
        scanned: response.scanned ?? 0,
        truncated: response.truncated === true,
        scanLimited: response.scanLimited === true,
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load duplicate voters.')
    } finally {
      setLoading(false)
    }
  }, [debouncedQuery, houseFilter, mode, partFilter, sectionFilter, statusFilter, wardFilter])

  useEffect(() => {
    void load()
  }, [load])

  const photoPaths = useMemo(() => {
    const paths: string[] = []
    for (const group of groups) {
      for (const voter of group.voters) if (voter.photo_url) paths.push(voter.photo_url)
    }
    return Array.from(new Set(paths))
  }, [groups])
  const photoUrls = usePhotoUrls(photoPaths)

  const wardOptions = useMemo(() => {
    const set = new Set<number>()
    for (const ward of profile?.allowed_wards ?? []) set.add(ward)
    for (const group of groups) {
      for (const voter of group.voters) if (voter.ward_no != null) set.add(voter.ward_no)
    }
    if (wardFilter !== 'all' && Number.isFinite(Number(wardFilter))) set.add(Number(wardFilter))
    return Array.from(set).sort((a, b) => a - b)
  }, [groups, profile?.allowed_wards, wardFilter])

  const partOptions = useMemo(() => {
    const set = new Set<number>()
    for (const group of groups) {
      for (const voter of group.voters) if (voter.part_no != null) set.add(voter.part_no)
    }
    if (partFilter !== 'all' && Number.isFinite(Number(partFilter))) set.add(Number(partFilter))
    return Array.from(set).sort((a, b) => a - b)
  }, [groups, partFilter])

  const sectionOptions = useMemo(() => {
    const set = new Set<number>()
    for (const group of groups) {
      for (const voter of group.voters) if (voter.section != null) set.add(voter.section)
    }
    if (sectionFilter !== 'all' && Number.isFinite(Number(sectionFilter))) set.add(Number(sectionFilter))
    return Array.from(set).sort((a, b) => a - b)
  }, [groups, sectionFilter])

  const activeFilterCount =
    (mode !== 'name_house' ? 1 : 0) +
    (wardFilter !== 'all' ? 1 : 0) +
    (partFilter !== 'all' ? 1 : 0) +
    (sectionFilter !== 'all' ? 1 : 0) +
    (houseFilter.trim() ? 1 : 0) +
    (statusFilter !== 'all' ? 1 : 0)

  const clearFilters = () => {
    setMode('name_house')
    setWardFilter('all')
    setPartFilter('all')
    setSectionFilter('all')
    setHouseFilter('')
    setStatusFilter('all')
  }

  const reportRows = useMemo(() => {
    const rows: DuplicateReportRow[] = []
    let sr = 0
    for (const group of groups) {
      for (const voter of group.voters) {
        sr += 1
        rows.push({
          group: group.label,
          srNo: String(sr),
          name: voter.name || '',
          epicNo: voter.epic_no || '',
          houseNo: voter.house_no ?? '',
          ward: voter.ward_no != null ? String(voter.ward_no) : '',
          part: voter.part_no != null ? String(voter.part_no) : '',
          section: voter.section != null ? String(voter.section) : '',
          age: voter.age != null ? String(voter.age) : '',
          gender: voter.gender ?? '',
          relativeName: voter.relative_name ?? '',
          relation: voter.relative_relation ?? '',
          contact1: voter.contact_no_1 ?? '',
          contact2: voter.contact_no_2 ?? '',
          presence: presenceLabel(voter.presence_status) ?? '',
          status: isVoterActive(voter) ? 'Active' : 'Disabled',
        })
      }
    }
    return rows
  }, [groups])

  const handleExport = async () => {
    if (!reportRows.length) {
      toast.error('No duplicate voters to export.')
      return
    }
    try {
      await exportRowsToExcel({
        rows: reportRows,
        fields: REPORT_FIELDS,
        fileName: 'duplicate-voters',
        title: 'Duplicate voters',
        meta: `${groups.length} groups · ${reportRows.length} voters · ${duplicateModeLabel(mode)}${totals.truncated ? ' · first page' : ''}`,
        groupBy: { groupBy: 'group', resolve: (row) => row.group },
        showMeta: true,
      }, { ...DEFAULT_PRINT_STYLE, includePhotos: false })
      toast.success('Excel downloaded.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not export duplicate voters.')
    }
  }

  const copyEpics = async (group: VoterDuplicateGroup) => {
    try {
      await navigator.clipboard.writeText(group.voters.map((voter) => voter.epic_no).join('\n'))
      toast.success(`Copied ${group.voters.length} EPIC${group.voters.length === 1 ? '' : 's'}.`)
    } catch {
      toast.error('Could not copy EPICs.')
    }
  }

  const modeDescription = VOTER_DUPLICATE_MODES.find((option) => option.value === mode)?.description ?? ''

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Duplicate voters"
        description="EPIC numbers are unique, so duplicates are matched by name plus house, relative, or age/gender. Review each group before editing."
        action={
          <Button variant="secondary" onClick={() => void handleExport()} disabled={!reportRows.length}>
            <Download className="h-4 w-4" /> Excel
          </Button>
        }
      />

      <section className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-white px-3 py-3 sm:grid-cols-4 sm:gap-3 sm:px-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">Duplicate groups</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{totals.groups.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">Voters in groups</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{totals.voters.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">Match rule</p>
          <p className="mt-1 text-sm font-semibold text-ink">{duplicateModeLabel(mode)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">Voters scanned</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{totals.scanned.toLocaleString()}</p>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-white">
        <div className="space-y-3 border-b border-line px-4 py-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="relative min-w-[14rem] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
              <input
                className="h-9 w-full rounded-lg border border-line bg-white pl-8 pr-3 text-sm outline-none focus:border-brand-300"
                placeholder="Search name, EPIC, house, relative, or contact"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <FilterSelect label="Match rule" value={mode} onChange={(value) => setMode(value as VoterDuplicateMode)}>
              {VOTER_DUPLICATE_MODES.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </FilterSelect>
            <FilterSelect label="Status" value={statusFilter} onChange={(value) => setStatusFilter(value as StatusFilter)}>
              <option value="all">All statuses</option>
              <option value="active">Active only</option>
              <option value="disabled">Disabled only</option>
            </FilterSelect>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <FilterSelect label="Ward" value={wardFilter} onChange={setWardFilter}>
              <option value="all">All wards</option>
              {wardOptions.map((ward) => (
                <option key={ward} value={String(ward)}>Ward {ward}</option>
              ))}
            </FilterSelect>
            <FilterSelect label="Part" value={partFilter} onChange={setPartFilter}>
              <option value="all">All parts</option>
              {partOptions.map((part) => (
                <option key={part} value={String(part)}>Part {part}</option>
              ))}
            </FilterSelect>
            <FilterSelect label="Section" value={sectionFilter} onChange={setSectionFilter}>
              <option value="all">All sections</option>
              {sectionOptions.map((section) => (
                <option key={section} value={String(section)}>Section {section}</option>
              ))}
            </FilterSelect>
            <label className="flex min-w-[8.5rem] flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
              House no
              <input
                className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold normal-case tracking-normal text-ink-secondary outline-none focus:border-brand-300"
                placeholder="Any house"
                value={houseFilter}
                onChange={(event) => setHouseFilter(event.target.value)}
              />
            </label>
            {activeFilterCount ? (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
              >
                Clear filters
              </button>
            ) : null}
          </div>

          <p className="text-[11px] text-ink-tertiary">{modeDescription}</p>
          {totals.scanLimited ? (
            <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              Scanned the first 20,000 voters. Narrow the filters for a complete result.
            </p>
          ) : null}
          <p className="text-xs text-ink-tertiary">
            {totals.groups.toLocaleString()} groups · {totals.voters.toLocaleString()} voters
            {totals.truncated ? ` · showing the first ${groups.length.toLocaleString()} groups` : ''}
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Finding duplicate voters...
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-ink-tertiary">
            <Users className="h-8 w-8" />
            <p className="text-sm">
              {activeFilterCount || query.trim()
                ? 'No duplicate voters match these filters.'
                : 'No duplicate voters found with this match rule.'}
            </p>
            <p className="max-w-md text-xs">
              Try “Name + relative” or “Name + age + gender”, or broaden the ward/part filters.
            </p>
          </div>
        ) : (
          <div className="space-y-3 p-3">
            {groups.map((group) => {
              const epics = new Set(
                group.voters
                  .map((voter) => (voter.epic_no ?? '').trim().toUpperCase())
                  .filter(Boolean),
              )
              const differentEpics = epics.size > 1
              return (
                <article key={group.key} className="overflow-hidden rounded-xl border border-line bg-white">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">{group.label}</p>
                      <p className="mt-0.5 text-[11px] text-ink-tertiary">
                        {group.voters.length} voters · {duplicateModeLabel(group.match)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {differentEpics ? (
                        <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-amber-700">
                          Different EPICs · {epics.size}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void copyEpics(group)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
                      >
                        <Copy className="h-3.5 w-3.5" /> Copy EPICs
                      </button>
                    </div>
                  </div>

                  <div className="divide-y divide-line">
                    {group.voters.map((voter) => {
                      const photoUrl = voter.photo_url ? photoUrls[voter.photo_url] : undefined
                      const active = isVoterActive(voter)
                      return (
                        <div key={voter.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                          <Avatar name={voter.name} photoUrl={photoUrl} />
                          <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-2 truncate text-sm font-medium text-ink">
                              {voter.name}
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${
                                active ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-ink-tertiary'
                              }`}>
                                {active ? 'Active' : 'Disabled'}
                              </span>
                            </p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-tertiary">
                              <span className="font-mono">{voter.epic_no}</span>
                              <span>House {voter.house_no || '—'}</span>
                              <span>Part {voter.part_no ?? '—'}</span>
                              <span>Section {voter.section ?? '—'}</span>
                              {voter.ward_no != null ? <span>Ward {voter.ward_no}</span> : null}
                            </p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-tertiary">
                              <span>{[voter.age, voter.gender].filter(Boolean).join(' · ') || 'Age/gender not set'}</span>
                              <span>{voter.relative_name ? `${voter.relative_relation ? `${voter.relative_relation} of ` : ''}${voter.relative_name}` : 'No relative'}</span>
                              <span>{voter.contact_no_1 || voter.contact_no_2 || 'No contact'}</span>
                              <span>{presenceLabel(voter.presence_status) ?? 'Presence not set'}</span>
                            </p>
                          </div>
                          <Button size="compact" variant="secondary" onClick={() => setSelectedVoter(voter)}>
                            View
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {selectedVoter ? (
        <VoterDetailDrawer
          voter={selectedVoter}
          onClose={() => setSelectedVoter(null)}
          onSaved={load}
        />
      ) : null}
    </div>
  )
}
