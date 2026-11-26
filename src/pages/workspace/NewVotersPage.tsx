import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Camera, Download, Loader2, RefreshCw, Search, UserCheck } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { StatCard } from '../../components/common/StatCard'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import { Button } from '../../components/ui/Button'
import { FilterChip } from '../../components/ui/FilterChip'
import { fetchApiJson } from '../../lib/d1Query'
import { matchesLookupTokens, normalizeLookupValue, tokenizeLookup } from '../../lib/searchUtils'
import { invalidateVoterCache } from '../../lib/voterDataset'
import { resolveTeamLeaderName } from '../../lib/teamLeaderCache'
import type { NewVoterRow, Voter } from '../../lib/types'
import { formatDate, formatNumber } from '../../lib/utils'

type LeaderFilter = 'all' | 'assigned' | 'unassigned'
type FamilyFilter = 'all' | 'family' | 'single'
type RangePreset = 'today' | '7' | '30' | 'custom'

function toIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function todayIso(): string {
  return toIsoDate(new Date())
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + days)
  return toIsoDate(date)
}

function csvEscape(value: unknown): string {
  const text = String(value ?? '')
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

function leaderLabel(row: NewVoterRow): string {
  if (!row.team_leader_id) return ''
  return resolveTeamLeaderName(
    { notes: row.team_leader_notes, display_name: row.team_leader_display_name },
    row.team_leader_voter_name ? { name: row.team_leader_voter_name } : null,
    row.team_leader_display_name?.trim() || 'Team Leader',
  )
}

function familySize(row: NewVoterRow): number {
  const size = Number(row.family_size)
  return Number.isFinite(size) && size > 0 ? size : 1
}

function isInFamily(row: NewVoterRow): boolean {
  const head = (row.family_head_epic ?? '').trim()
  return Boolean(head) || familySize(row) > 1
}

function familySummary(row: NewVoterRow): { title: string; meta: string } {
  const size = familySize(row)
  const headEpic = (row.family_head_epic ?? '').trim()
  const ownEpic = (row.epic_no ?? '').trim()
  const isHead = !headEpic || headEpic.toUpperCase() === ownEpic.toUpperCase()
  const label = (row.family_label ?? '').trim()

  if (!isInFamily(row)) {
    return { title: 'Single', meta: 'Not part of a family' }
  }

  const headName = (row.family_head_name ?? '').trim() || headEpic || ownEpic
  if (isHead) {
    return {
      title: label || 'Family head',
      meta: `${size} member${size === 1 ? '' : 's'}`,
    }
  }

  return {
    title: label || `Family of ${headName}`,
    meta: `Head ${headEpic || headName} · ${size} member${size === 1 ? '' : 's'}`,
  }
}

export function NewVotersPage() {
  const [rows, setRows] = useState<NewVoterRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [partFilter, setPartFilter] = useState('all')
  const [leaderFilter, setLeaderFilter] = useState<LeaderFilter>('all')
  const [familyFilter, setFamilyFilter] = useState<FamilyFilter>('all')
  const [preset, setPreset] = useState<RangePreset>('7')
  const [fromDate, setFromDate] = useState(() => addDays(todayIso(), -6))
  const [toDate, setToDate] = useState(() => todayIso())
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        limit: '5000',
        from: fromDate,
        to: toDate,
      })
      const data = await fetchApiJson<{ voters: NewVoterRow[]; total: number }>(`/api/voters/missing-photos?${params}`)
      setRows(data.voters ?? [])
      setTotal(data.total ?? data.voters?.length ?? 0)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load new voters.')
    } finally {
      setLoading(false)
    }
  }, [fromDate, toDate])

  useEffect(() => {
    void load()
  }, [load])

  const applyPreset = (next: RangePreset) => {
    setPreset(next)
    const today = todayIso()
    if (next === 'today') {
      setFromDate(today)
      setToDate(today)
    } else if (next === '7') {
      setFromDate(addDays(today, -6))
      setToDate(today)
    } else if (next === '30') {
      setFromDate(addDays(today, -29))
      setToDate(today)
    }
  }

  const partOptions = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.part_no).filter((value): value is number => value != null))).sort((a, b) => a - b)
  }, [rows])

  const searchTokens = useMemo(() => tokenizeLookup(query), [query])

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (partFilter !== 'all' && String(row.part_no ?? '') !== partFilter) return false
      if (leaderFilter === 'assigned' && !row.team_leader_id) return false
      if (leaderFilter === 'unassigned' && row.team_leader_id) return false
      if (familyFilter === 'family' && !isInFamily(row)) return false
      if (familyFilter === 'single' && isInFamily(row)) return false
      if (!searchTokens.length) return true
      const lookup = normalizeLookupValue([
        row.name,
        row.epic_no,
        row.relative_name,
        row.family_head_epic,
        row.family_head_name,
        row.family_label,
        row.house_no,
        leaderLabel(row),
        row.team_leader_epic_no,
      ].join(' '))
      return matchesLookupTokens(lookup, searchTokens)
    })
  }, [rows, partFilter, leaderFilter, familyFilter, searchTokens])

  const assignedCount = useMemo(() => rows.filter((row) => Boolean(row.team_leader_id)).length, [rows])
  const familyCount = useMemo(() => rows.filter((row) => isInFamily(row)).length, [rows])

  const handleOpen = async (row: NewVoterRow) => {
    setOpeningId(row.id)
    try {
      const data = await fetchApiJson<{ voter: Voter }>(`/api/voters/${row.id}`)
      setSelectedVoter(data.voter)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not open voter.')
    } finally {
      setOpeningId(null)
    }
  }

  const exportCsv = () => {
    if (!filtered.length) {
      toast.error('Nothing to export.')
      return
    }

    const headers = ['Name', 'EPIC', 'Relative', 'Part', 'Ward', 'Family', 'Team leader', 'Added date']
    const lines = filtered.map((row) => {
      const family = familySummary(row)
      const leader = leaderLabel(row)
      const relative = row.relative_name
        ? `${row.relative_relation ? `${row.relative_relation} of ` : ''}${row.relative_name}`
        : ''
      return [
        row.name,
        row.epic_no,
        relative,
        row.part_no ?? '',
        row.ward_no ?? '',
        family.title,
        leader || 'Not assigned',
        formatDate(row.created_at),
      ].map(csvEscape)
    })
    const csv = [headers, ...lines].map((line) => (Array.isArray(line) ? line.join(',') : line)).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'new-voters-missing-photos.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const filtersActive = Boolean(query) || partFilter !== 'all' || leaderFilter !== 'all' || familyFilter !== 'all'

  return (
    <div>
      <PageHeader
        title="New voters"
        description="Recently added voters who still have no photo. They leave this list once a photo is saved."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/voters"
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
            >
              Active roll
            </Link>
            <Button variant="secondary" onClick={exportCsv} disabled={loading || !filtered.length}>
              <Download className="h-4 w-4" />
              Export
            </Button>
            <Button variant="secondary" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Missing photo" value={formatNumber(total)} icon={<Camera className="h-4 w-4" />} tone="neutral" featured />
        <StatCard title="With team leader" value={formatNumber(assignedCount)} icon={<UserCheck className="h-4 w-4" />} tone="brand" />
        <StatCard title="In a family" value={formatNumber(familyCount)} meta="Linked by family head" />
        <StatCard title="Showing" value={formatNumber(filtered.length)} meta={filtersActive ? 'Filtered list' : 'Current date range'} />
      </div>

      <section className="mb-3 rounded-xl border border-line bg-white p-3 shadow-soft">
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip active={preset === 'today'} onClick={() => applyPreset('today')}>Today</FilterChip>
          <FilterChip active={preset === '7'} onClick={() => applyPreset('7')}>Last 7 days</FilterChip>
          <FilterChip active={preset === '30'} onClick={() => applyPreset('30')}>Last 30 days</FilterChip>
          <FilterChip active={preset === 'custom'} onClick={() => applyPreset('custom')}>Custom</FilterChip>
          {preset === 'custom' ? (
            <>
              <input
                className="h-10 rounded-lg border border-line bg-white px-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
                type="date"
                value={fromDate}
                aria-label="From date"
                onChange={(event) => setFromDate(event.target.value)}
              />
              <input
                className="h-10 rounded-lg border border-line bg-white px-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
                type="date"
                value={toDate}
                aria-label="To date"
                onChange={(event) => setToDate(event.target.value)}
              />
            </>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
            <input
              className="h-10 w-full rounded-lg border border-line bg-muted/40 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-200"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, EPIC, family, or team leader"
            />
          </div>
          <select
            className="h-10 rounded-lg border border-line bg-white px-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            value={partFilter}
            aria-label="Filter by part"
            onChange={(event) => setPartFilter(event.target.value)}
          >
            <option value="all">All Parts</option>
            {partOptions.map((part) => (
              <option key={part} value={String(part)}>
                Part {part}
              </option>
            ))}
          </select>
          <FilterChip active={leaderFilter === 'all'} onClick={() => setLeaderFilter('all')}>All leaders</FilterChip>
          <FilterChip active={leaderFilter === 'assigned'} onClick={() => setLeaderFilter('assigned')}>Had team leader</FilterChip>
          <FilterChip active={leaderFilter === 'unassigned'} onClick={() => setLeaderFilter('unassigned')}>No team leader</FilterChip>
          <FilterChip active={familyFilter === 'all'} onClick={() => setFamilyFilter('all')}>All families</FilterChip>
          <FilterChip active={familyFilter === 'family'} onClick={() => setFamilyFilter('family')}>In a family</FilterChip>
          <FilterChip active={familyFilter === 'single'} onClick={() => setFamilyFilter('single')}>Single</FilterChip>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-white shadow-soft">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-10 text-sm text-ink-secondary">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading new voters...
          </div>
        ) : !filtered.length ? (
          <p className="px-4 py-10 text-sm text-ink-secondary">
            {rows.length ? 'No recently added voters match these filters.' : 'No recently added voters are missing a photo.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="border-b border-line px-4 py-3 text-left text-xs font-semibold text-ink-secondary">Voter</th>
                  <th className="border-b border-line px-4 py-3 text-left text-xs font-semibold text-ink-secondary">Part / Ward</th>
                  <th className="border-b border-line px-4 py-3 text-left text-xs font-semibold text-ink-secondary">Family</th>
                  <th className="border-b border-line px-4 py-3 text-left text-xs font-semibold text-ink-secondary">Team leader</th>
                  <th className="border-b border-line px-4 py-3 text-left text-xs font-semibold text-ink-secondary">Added date</th>
                  <th className="border-b border-line px-4 py-3 text-right text-xs font-semibold text-ink-secondary">Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const family = familySummary(row)
                  const leader = leaderLabel(row)
                  return (
                    <tr key={row.id} className="align-top hover:bg-muted/60">
                      <td className="border-b border-line px-4 py-3">
                        <button type="button" className="text-left" onClick={() => void handleOpen(row)}>
                          <p className="font-semibold text-ink">{row.name}</p>
                          <p className="mt-0.5 font-mono text-xs text-ink-tertiary">{row.epic_no}</p>
                          {row.relative_name ? (
                            <p className="mt-0.5 text-xs text-ink-tertiary">
                              {row.relative_relation ? `${row.relative_relation} of ` : ''}
                              {row.relative_name}
                            </p>
                          ) : null}
                        </button>
                      </td>
                      <td className="border-b border-line px-4 py-3 text-ink-secondary">
                        <p>{row.part_no != null ? `Part ${row.part_no}` : 'Part -'}</p>
                        <p className="text-xs text-ink-tertiary">
                          {row.ward_no != null ? `Ward ${row.ward_no}` : 'Ward -'}
                          {row.section != null ? ` · Sec ${row.section}` : ''}
                        </p>
                      </td>
                      <td className="border-b border-line px-4 py-3">
                        <p className="font-medium text-ink">{family.title}</p>
                        <p className="text-xs text-ink-tertiary">{family.meta}</p>
                      </td>
                      <td className="border-b border-line px-4 py-3">
                        {leader ? (
                          <>
                            <p className="font-medium text-ink">{leader}</p>
                            <p className="text-xs text-ink-tertiary">
                              {row.team_leader_epic_no ? row.team_leader_epic_no : 'Named / parked leader'}
                              {row.team_leader_part_no != null ? ` · Part ${row.team_leader_part_no}` : ''}
                            </p>
                            {row.team_leader_id ? (
                              <Link to={`/team-leaders/${row.team_leader_id}`} className="mt-1 inline-block text-xs font-semibold text-brand-700 hover:underline">
                                Open leader
                              </Link>
                            ) : null}
                          </>
                        ) : (
                          <p className="text-ink-tertiary">Not assigned</p>
                        )}
                      </td>
                      <td className="border-b border-line px-4 py-3 text-ink-secondary">
                        <p>{formatDate(row.created_at)}</p>
                      </td>
                      <td className="border-b border-line px-4 py-3 text-right">
                        <Button
                          size="compact"
                          variant="secondary"
                          disabled={openingId === row.id}
                          loading={openingId === row.id}
                          onClick={() => void handleOpen(row)}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <VoterDetailDrawer
        voter={selectedVoter}
        onClose={() => setSelectedVoter(null)}
        onSaved={async () => {
          await invalidateVoterCache()
          await load()
          if (!selectedVoter?.id) return
          try {
            const data = await fetchApiJson<{ voter: Voter }>(`/api/voters/${selectedVoter.id}`)
            setSelectedVoter(data.voter)
          } catch {
            setSelectedVoter(null)
          }
        }}
      />
    </div>
  )
}
