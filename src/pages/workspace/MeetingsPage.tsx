import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Users, ArrowRight, Loader2, Plus } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { StatCard } from '../../components/common/StatCard'
import { Button } from '../../components/ui/Button'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import type { Meeting, MeetingInvitee, Voter } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { usePersistentState } from '../../hooks/usePersistentState'
import { buildWardScope, FAST_NAV_CACHE_MAX_AGE_MS, readCachedVoters, writeCachedVoters } from '../../lib/voterCache'
import { withNormalizedVoterCategories } from '../../lib/voterCategory'
import { ensureGlobalMeeting, fetchGlobalMeeting, MEETING_VOTERS_CACHE_KEY, partPathParam } from '../../hooks/useMeetingData'

function uniqueNumberList(values: Array<number | null | undefined>): number[] {
  return Array.from(new Set(values.filter((v): v is number => v != null))).sort((a, b) => a - b)
}

export function MeetingsPage() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const [voters, setVoters] = useState<Voter[]>([])
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [invitees, setInvitees] = useState<MeetingInvitee[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)

  const [partFilter, setPartFilter] = usePersistentState('vote:meetings:partFilter', 'all')
  const [sectionFilter, setSectionFilter] = usePersistentState('vote:meetings:sectionFilter', 'all')

  const wardScope = buildWardScope(profile?.role, profile?.allowed_wards)
  const allowedWards = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((w) => Number.isFinite(w))))
    wards.sort((a, b) => a - b)
    return wards
  }, [profile?.allowed_wards])
  const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0

  const load = useCallback(async () => {
    setLoading(true)

    const cached = withNormalizedVoterCategories(readCachedVoters(MEETING_VOTERS_CACHE_KEY, wardScope, FAST_NAV_CACHE_MAX_AGE_MS) ?? [])
    const voterRows: Voter[] = [...cached]

    if (!cached.length) {
      let offset = 0
      const batchSize = 400
      for (;;) {
        let req = supabase.from('voters').select('*').range(offset, offset + batchSize - 1)
        if (hasWardRestriction) req = req.in('ward_no', allowedWards)
        const { data, error } = await req
        if (error) { toast.error(error.message); break }
        const batch = withNormalizedVoterCategories((data as Voter[] | null) ?? [])
        voterRows.push(...batch)
        if (batch.length < batchSize) break
        offset += batchSize
      }
      writeCachedVoters(MEETING_VOTERS_CACHE_KEY, wardScope, voterRows)
    }

    setVoters(voterRows)

    const global = await fetchGlobalMeeting()

    let inviteeRows: MeetingInvitee[] = []
    if (global.meeting) {
      const iRes = await supabase.from('meeting_invitees').select('*').eq('meeting_id', global.meeting.id)
      if (iRes.error) toast.error(iRes.error.message)
      inviteeRows = (iRes.data as MeetingInvitee[] | null) ?? []
    }

    setMeeting(global.meeting)
    setInvitees(inviteeRows)
    setLoading(false)
  }, [wardScope, hasWardRestriction, allowedWards])

  useEffect(() => { void load() }, [load])

  const partOptions = useMemo(() => uniqueNumberList(voters.map((v) => v.part_no)), [voters])

  const sectionOptions = useMemo(() => {
    if (partFilter === 'all') return []
    return uniqueNumberList(voters.filter((v) => String(v.part_no ?? '') === partFilter).map((v) => v.section))
  }, [voters, partFilter])

  useEffect(() => {
    if (partFilter !== 'all' && !partOptions.some((part) => String(part) === partFilter)) {
      setPartFilter('all')
    }
  }, [partFilter, partOptions, setPartFilter])

  useEffect(() => {
    if (partFilter === 'all' && sectionFilter !== 'all') {
      setSectionFilter('all')
      return
    }
    if (sectionFilter !== 'all' && !sectionOptions.some((section) => String(section) === sectionFilter)) {
      setSectionFilter('all')
    }
  }, [partFilter, sectionFilter, sectionOptions, setSectionFilter])

  const inviteeVoterIds = useMemo(() => new Set(invitees.map((i) => i.voter_id)), [invitees])

  const progress = useMemo(() => {
    const invitedVoters = invitees.length
    const attended = invitees.filter((i) => i.attendance_status === 'attended').length
    const pending = invitees.filter((i) => i.attendance_status === 'pending').length
    const called = invitees.filter((i) => i.attendance_status === 'called').length
    const calledConfirmed = invitees.filter((i) => i.attendance_status === 'called_confirmed').length
    const absent = invitees.filter((i) => i.attendance_status === 'absent').length
    const notAttended = invitees.filter((i) => i.attendance_status === 'not_attended').length
    return { invitedVoters, attended, pending, called, calledConfirmed, absent, notAttended }
  }, [invitees])

  const createMeeting = async () => {
    setCreating(true)
    const created = await ensureGlobalMeeting()
    setCreating(false)
    if (!created) { toast.error('Could not start the global meeting.'); return }
    toast.success('Global meeting started.')
    setMeeting(created)
  }

  const openDetail = () => {
    if (!meeting) return
    const params = new URLSearchParams()
    if (partFilter !== 'all') params.set('part', partFilter)
    if (sectionFilter !== 'all') params.set('section', sectionFilter)
    const qs = params.toString()
    navigate(qs ? `/meetings/${meeting.id}?${qs}` : `/meetings/${meeting.id}`)
  }

  return (
    <div className="space-y-4 pb-6">
      <PageHeader title="Meetings" description="One global meeting - invite families, filter by part and section, and track attendance." />

      <section className="rounded-xl border border-line bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[140px]">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-tertiary">Part</span>
            <select
              className="h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              value={partFilter}
              onChange={(e) => setPartFilter(e.target.value)}
            >
              <option value="all">All Parts</option>
              {partOptions.map((p) => (
                <option key={p} value={String(p)}>Part {p}</option>
              ))}
            </select>
          </label>
          <label className="min-w-[140px]">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-tertiary">Section</span>
            <select
              className="h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary"
              value={sectionFilter}
              aria-label="Filter by section"
              title={partFilter === 'all' ? 'Select a part first to filter by section' : 'Filter by section'}
              disabled={partFilter === 'all'}
              onChange={(e) => setSectionFilter(e.target.value)}
            >
              <option value="all">{partFilter === 'all' ? 'All Sections (pick a part)' : 'All Sections'}</option>
              {sectionOptions.map((section) => (
                <option key={section} value={String(section)}>Section {section}</option>
              ))}
            </select>
          </label>
          {meeting ? (
            <Button onClick={openDetail}>
              <ArrowRight className="h-4 w-4" /> Open meeting
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => navigate(partFilter === 'all' ? '/not-yet-invited' : `/not-yet-invited/part/${partPathParam(partFilter)}`)}
          >
            <Users className="h-4 w-4" /> View not invited
          </Button>
        </div>
      </section>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-ink-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading global meeting...
        </p>
      ) : meeting ? (
        <>
          <section className="rounded-xl border border-line bg-white p-4 md:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-brand-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-700">
                    Global Meeting
                  </span>
                </div>
                <p className="mt-1 text-lg font-semibold text-ink">Global Meeting</p>
                <p className="mt-1 text-xs text-ink-secondary">
                  {new Date(meeting.meeting_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  {meeting.location ? ` · ${meeting.location}` : ''}
                </p>
              </div>
              <Button onClick={openDetail}>
                <ArrowRight className="h-4 w-4" /> Open Global Meeting
              </Button>
            </div>
          </section>

          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard title="Invited" value={String(progress.invitedVoters)} featured />
            <StatCard title="Attended" value={String(progress.attended)} />
            <StatCard title="Pending" value={String(progress.pending)} />
            <StatCard title="Called / Confirmed" value={String(progress.called + progress.calledConfirmed)} />
            <StatCard title="Absent / Not Attended" value={String(progress.absent + progress.notAttended)} />
          </div>
          {inviteeVoterIds.size > 0 ? (
            <p className="text-xs text-ink-tertiary">{inviteeVoterIds.size} unique voter(s) invited across the global meeting.</p>
          ) : null}
        </>
      ) : (
        <section className="rounded-xl border border-line bg-white p-4 md:p-5">
          <h2 className="text-lg font-semibold text-ink">No global meeting yet</h2>
          <p className="mt-1 text-sm text-ink-secondary">Start the single global meeting to begin inviting families and tracking attendance.</p>
          <Button className="mt-4" disabled={creating} loading={creating} onClick={() => void createMeeting()}>
            <Plus className="h-4 w-4" /> Start Global Meeting
          </Button>
        </section>
      )}

      <VoterDetailDrawer
        voter={selectedVoter}
        onClose={() => setSelectedVoter(null)}
        onSaved={async () => { await load(); setSelectedVoter(null) }}
      />
    </div>
  )
}
