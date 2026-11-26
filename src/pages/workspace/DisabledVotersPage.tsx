import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Loader2, RefreshCw, Search, UserCheck, UserX } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { StatCard } from '../../components/common/StatCard'
import { Button } from '../../components/ui/Button'
import { FilterChip } from '../../components/ui/FilterChip'
import { useAuth } from '../../hooks/useAuth'
import { fetchApiJson } from '../../lib/d1Query'
import { matchesLookupTokens, normalizeLookupValue, tokenizeLookup } from '../../lib/searchUtils'
import { invalidateVoterCache } from '../../lib/voterDataset'
import { resolveTeamLeaderName } from '../../lib/teamLeaderCache'
import type { DisabledVoterRow } from '../../lib/types'
import { formatDate, formatNumber } from '../../lib/utils'

type LeaderFilter = 'all' | 'assigned' | 'unassigned'
type FamilyFilter = 'all' | 'family' | 'single'

function leaderLabel(row: DisabledVoterRow): string {
  if (!row.team_leader_id) return ''
  return resolveTeamLeaderName(
    { notes: row.team_leader_notes, display_name: row.team_leader_display_name },
    row.team_leader_voter_name ? { name: row.team_leader_voter_name } : null,
    row.team_leader_display_name?.trim() || 'Team Leader',
  )
}

function familySize(row: DisabledVoterRow): number {
  const size = Number(row.family_size)
  return Number.isFinite(size) && size > 0 ? size : 1
}

function isInFamily(row: DisabledVoterRow): boolean {
  const head = (row.family_head_epic ?? '').trim()
  return Boolean(head) || familySize(row) > 1
}

function familySummary(row: DisabledVoterRow): { title: string; meta: string } {
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

export function DisabledVotersPage() {
  const { isAdminAreaAllowed } = useAuth()
  const [rows, setRows] = useState<DisabledVoterRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [partFilter, setPartFilter] = useState('all')
  const [leaderFilter, setLeaderFilter] = useState<LeaderFilter>('all')
  const [familyFilter, setFamilyFilter] = useState<FamilyFilter>('all')
  const [enablingEpic, setEnablingEpic] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchApiJson<{ voters: DisabledVoterRow[]; total: number }>('/api/voters/disabled?limit=5000')
      setRows(data.voters ?? [])
      setTotal(data.total ?? data.voters?.length ?? 0)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load disabled voters.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

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
        row.disabled_reason,
        leaderLabel(row),
        row.team_leader_epic_no,
      ].join(' '))
      return matchesLookupTokens(lookup, searchTokens)
    })
  }, [rows, partFilter, leaderFilter, familyFilter, searchTokens])

  const assignedCount = useMemo(() => rows.filter((row) => Boolean(row.team_leader_id)).length, [rows])
  const familyCount = useMemo(() => rows.filter((row) => isInFamily(row)).length, [rows])

  const handleEnable = async (row: DisabledVoterRow) => {
    if (!isAdminAreaAllowed) return
    if (!window.confirm(`Re-enable ${row.name} (${row.epic_no})? They will appear on the active roll again.`)) return
    setEnablingEpic(row.epic_no)
    try {
      await fetchApiJson('/api/voters/bulk-enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epics: [row.epic_no] }),
      })
      await invalidateVoterCache()
      setRows((current) => current.filter((item) => item.id !== row.id))
      setTotal((current) => Math.max(0, current - 1))
      toast.success(`Re-enabled ${row.name}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not re-enable voter.')
    } finally {
      setEnablingEpic(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Disabled voters"
        description="Voters removed from the electoral roll. Family links and team-leader assignments are kept."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/voters"
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
            >
              Active roll
            </Link>
            <Button variant="secondary" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Disabled" value={formatNumber(total)} icon={<UserX className="h-4 w-4" />} tone="neutral" featured />
        <StatCard title="With team leader" value={formatNumber(assignedCount)} meta="Assignments kept on disable" icon={<UserCheck className="h-4 w-4" />} tone="brand" />
        <StatCard title="In a family" value={formatNumber(familyCount)} meta="Linked by family head" />
        <StatCard title="Showing" value={formatNumber(filtered.length)} meta={query || partFilter !== 'all' || leaderFilter !== 'all' || familyFilter !== 'all' ? 'Filtered list' : 'All disabled voters'} />
      </div>

      <section className="mb-3 rounded-xl border border-line bg-white p-3 shadow-soft">
        <div className="flex flex-wrap items-center gap-2">
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
            Loading disabled voters...
          </div>
        ) : !filtered.length ? (
          <p className="px-4 py-10 text-sm text-ink-secondary">
            {rows.length ? 'No disabled voters match these filters.' : 'No disabled voters yet. Disable from Dashboard or Import Data keeps them here.'}
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
                  <th className="border-b border-line px-4 py-3 text-left text-xs font-semibold text-ink-secondary">Disabled</th>
                  {isAdminAreaAllowed ? <th className="border-b border-line px-4 py-3 text-right text-xs font-semibold text-ink-secondary">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const family = familySummary(row)
                  const leader = leaderLabel(row)
                  return (
                    <tr key={row.id} className="align-top hover:bg-muted/60">
                      <td className="border-b border-line px-4 py-3">
                        <p className="font-semibold text-ink">{row.name}</p>
                        <p className="mt-0.5 font-mono text-xs text-ink-tertiary">{row.epic_no}</p>
                        {row.relative_name ? (
                          <p className="mt-0.5 text-xs text-ink-tertiary">
                            {row.relative_relation ? `${row.relative_relation} of ` : ''}
                            {row.relative_name}
                          </p>
                        ) : null}
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
                        <p>{formatDate(row.disabled_at)}</p>
                        <p className="text-xs text-ink-tertiary">{row.disabled_reason || 'Removed from electoral roll'}</p>
                      </td>
                      {isAdminAreaAllowed ? (
                        <td className="border-b border-line px-4 py-3 text-right">
                          <Button
                            size="compact"
                            variant="secondary"
                            disabled={enablingEpic === row.epic_no}
                            loading={enablingEpic === row.epic_no}
                            onClick={() => void handleEnable(row)}
                          >
                            Re-enable
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
