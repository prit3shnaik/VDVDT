import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Clock3, Search, Undo2, WifiOff } from 'lucide-react'
import toast from 'react-hot-toast'
import { PageHeader } from '../../components/common/PageHeader'
import { useAuth } from '../../hooks/useAuth'
import { usePhotoUrls } from '../../hooks/usePhotoUrls'
import { useFieldOutboxCount } from '../../hooks/useFieldOutbox'
import { loadAllVoters } from '../../lib/voterDataset'
import {
  buildVoterLookupText,
  compactLookupValue,
  initials,
  isLikelyEpicToken,
  matchesLookupTokens,
  tokenizeLookup,
} from '../../lib/searchUtils'
import { enqueueOutbox, flushOutbox, newEventId, removeOutbox, startOutboxSync } from '../../lib/fieldOutbox'
import { fetchApiJson } from '../../lib/d1Query'
import type { Election, Voter } from '../../lib/types'

interface AgentBooth {
  id: string
  election_id: string
  part_no: number
  section: number | null
  name: string | null
  election_status: string
  election_name?: string
  poll_date?: string
}

interface MarkInfo {
  voter_id: string
  booth_id: string
  marked_at: string
  source: string | null
  status: string
  marked_by_name: string | null
}

const UNDO_MS = 10000

function detectSource(query: string): 'sr_no' | 'epic' | 'name' {
  const compact = compactLookupValue(query)
  if (/^\d+$/.test(compact)) return 'sr_no'
  if (isLikelyEpicToken(query)) return 'epic'
  return 'name'
}

export function BoothAttendancePage() {
  const { profile } = useAuth()
  const pending = useFieldOutboxCount()
  const [elections, setElections] = useState<Election[]>([])
  const [electionId, setElectionId] = useState('')
  const [booths, setBooths] = useState<AgentBooth[]>([])
  const [boothId, setBoothId] = useState('')
  const [voters, setVoters] = useState<Voter[]>([])
  const [marks, setMarks] = useState<Record<string, MarkInfo>>({})
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Voter | null>(null)
  const [undoUntil, setUndoUntil] = useState<number>(0)
  const [undoEventId, setUndoEventId] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const undoTimer = useRef<number | null>(null)

  const isAdmin = profile?.role === 'admin' || profile?.role === 'sub-admin'
  const boothsForElection = booths.filter((b) => !electionId || b.election_id === electionId)
  const activeBooth = boothsForElection.find((b) => b.id === boothId) ?? boothsForElection[0] ?? null
  const electionOpen = elections.find((e) => e.id === electionId)?.status === 'open'
  const noElection = !electionId
  const noBoothAssigned = Boolean(electionId) && boothsForElection.length === 0

  useEffect(() => {
    startOutboxSync()
  }, [])

  useEffect(() => {
    if (!undoUntil) return
    const id = window.setInterval(() => setTick(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [undoUntil])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const [el, me] = await Promise.all([
          fetchApiJson<{ elections: Election[] }>('/api/booth/elections'),
          fetchApiJson<{ admin: boolean; booths: AgentBooth[] }>('/api/booth/me'),
        ])
        if (cancelled) return
        setElections(el.elections)
        setBooths(me.booths)
        const open = el.elections.find((e) => e.status === 'open') ?? el.elections[0]
        if (open) setElectionId(open.id)
        const forOpen = me.booths.filter((b) => !open || b.election_id === open.id)
        if (forOpen[0]) setBoothId(forOpen[0].id)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to load booth')
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!electionId) return
    const match = booths.find((b) => b.election_id === electionId)
    if (match && match.id !== boothId) setBoothId(match.id)
  }, [electionId, booths, boothId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      try {
        const rows = await loadAllVoters({
          role: profile?.role,
          allowedWards: profile?.allowed_wards,
          onFirstBatch: (first) => {
            if (!cancelled) setVoters(first)
          },
        })
        if (!cancelled) setVoters(rows)
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Failed to load roll')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [profile?.role, profile?.allowed_wards])

  const refreshMarks = useCallback(async () => {
    if (!electionId) return
    const qs = new URLSearchParams({ election_id: electionId })
    if (boothId && !isAdmin) qs.set('booth_id', boothId)
    try {
      const data = await fetchApiJson<{ marks: MarkInfo[] }>(`/api/booth/attendance/marked?${qs}`)
      const next: Record<string, MarkInfo> = {}
      for (const mark of data.marks) next[mark.voter_id] = mark
      setMarks(next)
    } catch {
      // offline: keep local marks
    }
  }, [electionId, boothId, isAdmin])

  useEffect(() => {
    void refreshMarks()
    const id = window.setInterval(() => void refreshMarks(), 15000)
    return () => window.clearInterval(id)
  }, [refreshMarks])

  const scopedVoters = useMemo(() => {
    if (!activeBooth && !isAdmin) return []
    return voters.filter((v) => {
      if (!activeBooth) return true
      if (v.part_no !== activeBooth.part_no) return false
      if (activeBooth.section != null && v.section !== activeBooth.section) return false
      return true
    })
  }, [voters, activeBooth, isAdmin])

  const tokens = useMemo(() => tokenizeLookup(query), [query])

  const results = useMemo(() => {
    if (!tokens.length) return [] as Voter[]
    const compact = compactLookupValue(query)
    const source = detectSource(query)
    return scopedVoters
      .filter((v) => {
        if (source === 'sr_no') return String(v.sr_no_roll ?? '') === compact
        if (source === 'epic') return compactLookupValue(v.epic_no).includes(compact)
        return matchesLookupTokens(buildVoterLookupText(v), tokens)
      })
      .sort((a, b) => (a.sr_no_roll ?? 0) - (b.sr_no_roll ?? 0))
      .slice(0, 40)
  }, [scopedVoters, tokens, query])

  const photoPaths = useMemo(
    () => results.map((v) => v.photo_url).filter((p): p is string => Boolean(p)),
    [results],
  )
  const photos = usePhotoUrls(photoPaths)
  const selectedPhoto = selected?.photo_url ? photos[selected.photo_url] : undefined

  const remainingUndo = undoUntil > tick ? Math.ceil((undoUntil - tick) / 1000) : 0

  const markVoted = async (voter: Voter) => {
    if (noElection) {
      toast.error('No election selected')
      return
    }
    if (noBoothAssigned) {
      toast.error(isAdmin ? 'This election has no booths. Create one in Booth Config.' : 'No booth assigned to you. Ask an admin to assign a booth.')
      return
    }
    if (!activeBooth) {
      toast.error('Select a booth before marking')
      return
    }
    if (!electionOpen && !isAdmin) {
      toast.error('Marking is closed')
      return
    }
    const existing = marks[voter.id]
    if (existing && existing.status === 'voted') {
      setSelected(voter)
      return
    }
    const eventId = newEventId()
    const payload = {
      event_id: eventId,
      election_id: electionId,
      booth_id: activeBooth.id,
      voter_id: voter.id,
      epic_no: voter.epic_no,
      source: detectSource(query || voter.epic_no),
    }
    setMarks((cur) => ({
      ...cur,
      [voter.id]: {
        voter_id: voter.id,
        booth_id: activeBooth.id,
        marked_at: new Date().toISOString(),
        source: payload.source,
        status: 'voted',
        marked_by_name: profile?.full_name ?? 'You',
      },
    }))
    await enqueueOutbox({ type: 'attendance', event_id: eventId, payload })
    const until = Date.now() + UNDO_MS
    setUndoEventId(eventId)
    setUndoUntil(until)
    setTick(Date.now())
    if (undoTimer.current) window.clearTimeout(undoTimer.current)
    undoTimer.current = window.setTimeout(() => {
      setUndoUntil(0)
      setUndoEventId(null)
      void flushOutbox()
    }, UNDO_MS)
    toast.success('Marked voted')
    setSelected(voter)
    void flushOutbox()
  }

  const undoMark = async () => {
    if (!undoEventId || !selected) return
    await removeOutbox(undoEventId)
    setMarks((cur) => {
      const next = { ...cur }
      delete next[selected.id]
      return next
    })
    setUndoEventId(null)
    setUndoUntil(0)
    toast('Mark undone')
  }

  const closed = !electionOpen && !isAdmin

  return (
    <div>
      <PageHeader
        title="Booth attendance"
        description="Find a voter by serial, EPIC or name and mark voted."
        action={
          pending > 0 ? (
            <span className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--warning-border)] bg-[var(--warning-fill)] px-3 text-sm font-semibold text-[var(--warning)]">
              <WifiOff className="h-4 w-4" />
              {pending} pending sync
            </span>
          ) : null
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-ink-secondary">
          Election
          <select
            className="mt-1 h-12 w-full rounded-xl border border-line bg-white px-3 text-base"
            value={electionId}
            onChange={(e) => setElectionId(e.target.value)}
          >
            {elections.map((el) => (
              <option key={el.id} value={el.id}>
                {el.name} ({el.status})
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-ink-secondary">
          Booth
          <select
            className="mt-1 h-12 w-full rounded-xl border border-line bg-white px-3 text-base"
            value={boothId}
            onChange={(e) => setBoothId(e.target.value)}
          >
            {boothsForElection.length === 0 ? (
              <option value="">No booth assigned</option>
            ) : null}
            {boothsForElection.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name || `Part ${b.part_no}`} {b.section != null ? `Sec ${b.section}` : ''}
                </option>
              ))}
          </select>
        </label>
      </div>

      {noElection ? (
        <p className="mb-4 rounded-xl border border-[var(--warning-border)] bg-[var(--warning-fill)] px-4 py-3 text-sm text-[var(--warning)]">
          No election is available yet. Ask an admin to create one in Booth Config.
        </p>
      ) : noBoothAssigned ? (
        <p className="mb-4 rounded-xl border border-[var(--warning-border)] bg-[var(--warning-fill)] px-4 py-3 text-sm text-[var(--warning)]">
          {isAdmin
            ? 'This election has no booths. Create a booth and assign agents in Booth Config before marking attendance.'
            : 'No booth is assigned to your account for this election. Ask an admin to assign you a booth in Booth Config.'}
        </p>
      ) : closed ? (
        <p className="mb-4 rounded-xl border border-[var(--warning-border)] bg-[var(--warning-fill)] px-4 py-3 text-sm text-[var(--warning)]">
          Marking is closed for this election.
        </p>
      ) : null}

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-tertiary" />
        <input
          type="search"
          inputMode="search"
          autoComplete="off"
          className="h-14 w-full rounded-2xl border border-line bg-white pl-12 pr-4 text-lg outline-none focus:border-brand-500"
          placeholder="Serial, EPIC or name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && !voters.length ? <p className="text-sm text-ink-secondary">Loading roll...</p> : null}

      <div className="space-y-2">
        {results.map((voter) => {
          const mark = marks[voter.id]
          const photo = voter.photo_url ? photos[voter.photo_url] : undefined
          return (
            <button
              key={voter.id}
              type="button"
              onClick={() => setSelected(voter)}
              className="flex w-full items-center gap-3 rounded-xl border border-line bg-white p-3 text-left active:bg-muted"
            >
              {photo ? (
                <img src={photo} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" />
              ) : (
                <div className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-brand-100 text-sm font-bold text-brand-700">
                  {initials(voter.name)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-ink">{voter.name}</p>
                <p className="truncate text-sm text-ink-secondary">
                  {voter.epic_no} · Sr {voter.sr_no_roll ?? '-'} · Part {voter.part_no ?? '-'}
                </p>
                <p className="text-xs text-ink-tertiary">
                  Sec {voter.section ?? '-'} · {voter.age ?? '-'} yrs · {voter.gender ?? '-'} · H {voter.house_no ?? '-'}
                </p>
              </div>
              {mark?.status === 'voted' ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">
                  <Check className="h-3 w-3" /> Voted
                </span>
              ) : (
                <span className="text-xs font-semibold text-ink-tertiary">Open</span>
              )}
            </button>
          )
        })}
        {query && !results.length && !loading ? (
          <p className="rounded-xl border border-line bg-white px-4 py-6 text-center text-sm text-ink-secondary">
            No voters in this booth match that search.
          </p>
        ) : null}
      </div>

      {selected ? (
        <div className="fixed inset-0 z-50">
          <button type="button" className="absolute inset-0 bg-slate-900/40" onClick={() => setSelected(null)} aria-label="Close" />
          <div className="absolute inset-x-0 bottom-0 rounded-t-xl border-t border-line bg-white p-5 pb-8">
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-muted" />
            <div className="flex items-start gap-3">
              {selectedPhoto ? (
                <img src={selectedPhoto} alt="" className="h-16 w-16 rounded-xl object-cover" />
              ) : (
                <div className="inline-flex h-16 w-16 items-center justify-center rounded-xl bg-brand-100 font-bold text-brand-700">
                  {initials(selected.name)}
                </div>
              )}
              <div className="min-w-0">
                <p className="text-lg font-semibold text-ink">{selected.name}</p>
                <p className="text-sm text-ink-secondary">{selected.epic_no}</p>
                <p className="text-sm text-ink-tertiary">
                  Sr {selected.sr_no_roll ?? '-'} · Part {selected.part_no ?? '-'} · Sec {selected.section ?? '-'}
                </p>
              </div>
            </div>

            {marks[selected.id]?.status === 'voted' ? (
              <div className="mt-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Already marked by {marks[selected.id].marked_by_name ?? 'someone'} at{' '}
                {new Date(marks[selected.id].marked_at).toLocaleTimeString()}
                {remainingUndo && undoEventId ? (
                  <button
                    type="button"
                    className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-emerald-300 bg-white font-semibold"
                    onClick={() => void undoMark()}
                  >
                    <Undo2 className="h-4 w-4" /> Undo ({remainingUndo}s)
                  </button>
                ) : isAdmin ? (
                  <button
                    type="button"
                    className="mt-3 flex h-12 w-full items-center justify-center rounded-xl border border-rose-200 bg-white font-semibold text-rose-700"
                    onClick={() => {
                      void fetchApiJson('/api/booth/attendance/override', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          event_id: newEventId(),
                          election_id: electionId,
                          voter_id: selected.id,
                          booth_id: boothId || undefined,
                          status: 'not_voted',
                          note: 'cleared from booth app',
                        }),
                      }).then(() => {
                        setMarks((cur) => {
                          const next = { ...cur }
                          delete next[selected.id]
                          return next
                        })
                        toast.success('Mark cleared')
                      }).catch((err) => toast.error(err instanceof Error ? err.message : 'Override failed'))
                    }}
                  >
                    Override / clear mark
                  </button>
                ) : null}
              </div>
            ) : (
              <button
                type="button"
                disabled={closed || noElection || noBoothAssigned || !activeBooth}
                className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 text-lg font-semibold text-white disabled:opacity-50"
                onClick={() => void markVoted(selected)}
              >
                <Check className="h-5 w-5" /> Mark voted
              </button>
            )}
            <p className="mt-3 flex items-center justify-center gap-1 text-xs text-ink-tertiary">
              <Clock3 className="h-3 w-3" /> 10 second undo after a new mark
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
