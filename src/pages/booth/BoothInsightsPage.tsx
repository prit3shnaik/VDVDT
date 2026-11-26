import { useCallback, useEffect, useState } from 'react'
import { RefreshCcw } from 'lucide-react'
import toast from 'react-hot-toast'
import { PageHeader } from '../../components/common/PageHeader'
import { StatCard } from '../../components/common/StatCard'
import { useAuth } from '../../hooks/useAuth'
import { fetchApiJson } from '../../lib/d1Query'
import type { Election, TurnoutSummary } from '../../lib/types'
import { formatNumber } from '../../lib/utils'

interface AgentBooth {
  id: string
  election_id: string
  part_no: number
  name: string | null
}

const emptySummary: TurnoutSummary = {
  election_id: '',
  total_voters: 0,
  voted: 0,
  remaining: 0,
  turnout_pct: 0,
  by_part: [],
  by_booth: [],
  by_section: [],
  by_gender: [],
  by_age_band: [],
  hourly: [],
  last_marks: [],
}

export function BoothInsightsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin' || profile?.role === 'sub-admin'
  const [elections, setElections] = useState<Election[]>([])
  const [electionId, setElectionId] = useState('')
  const [booths, setBooths] = useState<AgentBooth[]>([])
  const [partNo, setPartNo] = useState('')
  const [boothId, setBoothId] = useState('')
  const [summary, setSummary] = useState<TurnoutSummary>(emptySummary)
  const [unmarked, setUnmarked] = useState<Array<{ sr_no_roll: number | null; name: string; epic_no: string }>>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetchApiJson<{ elections: Election[] }>('/api/booth/elections')
      .then((data) => {
        if (cancelled) return
        setElections(data.elections)
        const open = data.elections.find((e) => e.status === 'open') ?? data.elections[0]
        if (open) setElectionId(open.id)
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Failed to load elections'))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!electionId) return
    void fetchApiJson<{ booths: AgentBooth[] }>(`/api/booth/booths?election_id=${electionId}`)
      .then((data) => setBooths(data.booths))
      .catch(() => setBooths([]))
  }, [electionId])

  const load = useCallback(async () => {
    if (!electionId) return
    setLoading(true)
    try {
      const qs = new URLSearchParams({ election_id: electionId })
      if (partNo) qs.set('part_no', partNo)
      if (boothId) qs.set('booth_id', boothId)
      const data = await fetchApiJson<TurnoutSummary>(`/api/booth/attendance/summary?${qs}`)
      setSummary(data)
      if (partNo) {
        const um = await fetchApiJson<{ unmarked: Array<{ sr_no_roll: number | null; name: string; epic_no: string }> }>(
          `/api/booth/attendance/unmarked?election_id=${electionId}&part_no=${partNo}`,
        )
        setUnmarked(um.unmarked)
      } else {
        setUnmarked([])
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load summary')
    } finally {
      setLoading(false)
    }
  }, [electionId, partNo, boothId])

  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 12000)
    return () => window.clearInterval(id)
  }, [load])

  const parts = Array.from(new Set(booths.map((b) => b.part_no))).sort((a, b) => a - b)

  return (
    <div>
      <PageHeader
        title="Booth insights"
        description="Turnout by booth, part, gender and hour. Polls every 12 seconds."
        action={
          <button
            type="button"
            className="inline-flex h-11 items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm font-semibold"
            onClick={() => void load()}
          >
            <RefreshCcw className="h-4 w-4" /> Refresh
          </button>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <select className="h-12 rounded-xl border border-line bg-white px-3" value={electionId} onChange={(e) => setElectionId(e.target.value)}>
          {elections.map((el) => (
            <option key={el.id} value={el.id}>{el.name} ({el.status})</option>
          ))}
        </select>
        <select className="h-12 rounded-xl border border-line bg-white px-3" value={partNo} onChange={(e) => setPartNo(e.target.value)}>
          <option value="">All parts</option>
          {parts.map((p) => (
            <option key={p} value={String(p)}>Part {p}</option>
          ))}
        </select>
        {isAdmin ? (
          <select className="h-12 rounded-xl border border-line bg-white px-3" value={boothId} onChange={(e) => setBoothId(e.target.value)}>
            <option value="">All booths</option>
            {booths.map((b) => (
              <option key={b.id} value={b.id}>{b.name || `Part ${b.part_no}`}</option>
            ))}
          </select>
        ) : <div />}
      </div>

      {loading && !summary.election_id ? <p className="text-sm text-ink-secondary">Loading...</p> : null}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatCard title="Voted" value={formatNumber(summary.voted)} />
        <StatCard title="Remaining" value={formatNumber(summary.remaining)} />
        <StatCard title="Roll" value={formatNumber(summary.total_voters)} />
        <StatCard title="Turnout" value={`${summary.turnout_pct}%`} />
      </div>

      <section className="mb-5 rounded-xl border border-line bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">By part</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-ink-tertiary">
              <tr><th className="py-2">Part</th><th>Voted</th><th>Remaining</th><th>Total</th></tr>
            </thead>
            <tbody>
              {summary.by_part.map((row) => (
                <tr key={String(row.part_no)} className="border-t border-line">
                  <td className="py-2">{row.part_no ?? '-'}</td>
                  <td>{row.voted}</td>
                  <td>{row.remaining}</td>
                  <td>{row.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mb-5 grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">Gender</h2>
          {summary.by_gender.map((row) => (
            <p key={row.gender} className="flex justify-between py-1 text-sm">
              <span>{row.gender}</span>
              <span>{row.voted} / {row.total}</span>
            </p>
          ))}
        </section>
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">Age band</h2>
          {summary.by_age_band.map((row) => (
            <p key={row.band} className="flex justify-between py-1 text-sm">
              <span>{row.band}</span>
              <span>{row.voted} / {row.total}</span>
            </p>
          ))}
        </section>
      </div>

      <section className="mb-5 rounded-xl border border-line bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">Hourly marks</h2>
        {summary.hourly.length === 0 ? <p className="text-sm text-ink-tertiary">No marks yet.</p> : null}
        {summary.hourly.map((row) => (
          <p key={row.hour} className="flex justify-between py-1 text-sm">
            <span>{new Date(row.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span>{row.count}</span>
          </p>
        ))}
      </section>

      <section className="mb-5 rounded-xl border border-line bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">Last 20 marks</h2>
        <div className="space-y-2">
          {summary.last_marks.map((row) => (
            <div key={`${row.voter_id}-${row.marked_at}`} className="flex justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{row.name}</p>
                <p className="text-xs text-ink-tertiary">{row.epic_no} · Sr {row.sr_no_roll ?? '-'}</p>
              </div>
              <p className="shrink-0 text-xs text-ink-tertiary">
                {new Date(row.marked_at).toLocaleTimeString()} · {row.marked_by_name}
              </p>
            </div>
          ))}
        </div>
      </section>

      {partNo ? (
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">Unmarked serials · Part {partNo}</h2>
          <div className="max-h-80 overflow-y-auto text-sm">
            {unmarked.map((row) => (
              <p key={row.epic_no} className="flex justify-between border-t border-line py-1.5">
                <span>Sr {row.sr_no_roll ?? '-'} · {row.name}</span>
                <span className="text-ink-tertiary">{row.epic_no}</span>
              </p>
            ))}
            {!unmarked.length ? <p className="text-ink-tertiary">All serials marked.</p> : null}
          </div>
        </section>
      ) : (
        <p className="text-sm text-ink-tertiary">Select a part to see unmarked serial gaps.</p>
      )}
    </div>
  )
}
