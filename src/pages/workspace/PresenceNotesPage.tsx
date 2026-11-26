import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ArrowLeft, ChevronLeft, ChevronRight, ClipboardPaste, Download, Loader2, X } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { FamilyWorkbenchRow } from '../../components/places/FamilyWorkbenchRow'
import { PlacePresenceFilterBar } from '../../components/places/PlacePresenceFilters'
import type { PlaceClub } from '../../lib/types'
import { useAuth } from '../../hooks/useAuth'
import { usePersistentState } from '../../hooks/usePersistentState'
import { presenceLabel, presenceNoteOf } from '../../lib/presence'
import { exportRowsToExcel, type ReportFieldDef } from '../../lib/reportBuilder'
import {
  clubFamilies,
  familyGroupHeadKey,
  familyHeadKey,
  familyPlaceMap,
  fetchFamilyPlaceClubs,
  fetchPlaceClubs,
  fetchVotersByEpics,
  fetchVotersByFamilyHeads,
  isOutsidePlaceClub,
  parseEpicList,
  placeClubFullLabel,
  placeClubLabel,
  SLIM_FAMILY_VOTER_COLUMNS,
} from '../../lib/placeClubs'
import {
  PAGE_SIZE,
  matchesLeader,
  matchesPart,
  matchesPlace,
  matchesPresence,
  matchesSearch,
  parseLeaderFilter,
  parseNotesFilter,
  parsePage,
  parsePlaceFilter,
  parsePresenceFilter,
  setOrDeleteParam,
} from '../../lib/placePresenceFilters'
import {
  buildSlimFamilies,
  completeFamiliesFromMatches,
  distinctPartsFromFamilies,
  familyLeaderId,
  fetchAssignmentMap,
  fetchSlimVoters,
  type SlimFamily,
} from '../../lib/placeWorkbench'
import { fetchTeamLeadersFromApi, resolveTeamLeaderName, specialLeaderIdSet } from '../../lib/teamLeaderCache'

interface NoteRow {
  key: string
  name: string
  epic: string
  part: string
  members: number
  presence: string
  presenceNote: string
  place: string
}

interface PasteFamilyHit {
  family: SlimFamily
  headKey: string
  epics: string[]
  placeId: string | null
  placeLabel: string
}

interface EpicPastePreview {
  matched: PasteFamilyHit[]
  alreadyThere: PasteFamilyHit[]
  unknown: string[]
  otherPlace: PasteFamilyHit[]
}

const HIDE_CLUBBED_KEY = 'vote:presence-notes:hide-clubbed'

export function PresenceNotesPage() {
  const { profile, loading: authLoading } = useAuth()
  const canEdit = profile?.role === 'admin' || profile?.can_edit === true
  const allowedWards = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((w) => Number.isFinite(w))))
    wards.sort((a, b) => a - b)
    return wards
  }, [profile?.allowed_wards])
  const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0

  const [searchParams, setSearchParams] = useSearchParams()
  const presence = parsePresenceFilter(searchParams.get('presence'), 'OUTSIDE_MORMUGAO')
  const place = parsePlaceFilter(searchParams.get('place'), 'unlabelled')
  const part = searchParams.get('part') ?? ''
  const leader = parseLeaderFilter(searchParams.get('leader'))
  const query = searchParams.get('q') ?? ''
  const notes = parseNotesFilter(searchParams.get('notes'))
  const page = parsePage(searchParams.get('page'))

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
  const [families, setFamilies] = useState<SlimFamily[]>([])
  const [voterToLeaderId, setVoterToLeaderId] = useState<Record<string, string>>({})
  const [leaderNameById, setLeaderNameById] = useState<Record<string, string>>({})
  const [leaderOptions, setLeaderOptions] = useState<Array<{ id: string; name: string }>>([])
  const [specialIds, setSpecialIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [clubTarget, setClubTarget] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pastePreview, setPastePreview] = useState<EpicPastePreview | null>(null)
  const [pasteLoading, setPasteLoading] = useState(false)
  const [moveAnywayOpen, setMoveAnywayOpen] = useState(false)
  const [hideClubbed, setHideClubbed] = usePersistentState<boolean>(HIDE_CLUBBED_KEY, true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nextClubs, links, apiRows, slimRows] = await Promise.all([
        fetchPlaceClubs(),
        fetchFamilyPlaceClubs(),
        fetchTeamLeadersFromApi(),
        fetchSlimVoters({
          presence,
          part,
          hasWardRestriction,
          allowedWards,
        }),
      ])
      setClubs(nextClubs)
      setFamilyPlaceByHead(familyPlaceMap(links))
      const names: Record<string, string> = {}
      const options: Array<{ id: string; name: string }> = []
      const special = specialLeaderIdSet(apiRows)
      for (const row of apiRows) {
        const name = resolveTeamLeaderName(row, row.voter_name ? { name: row.voter_name } : null, '')
        if (name) names[row.id] = name
        if (!special.has(row.id) && name) options.push({ id: row.id, name })
      }
      options.sort((a, b) => a.name.localeCompare(b.name))
      setLeaderNameById(names)
      setLeaderOptions(options)
      setSpecialIds(special)
      const nextFamilies = presence === 'all' && !part
        ? buildSlimFamilies(slimRows)
        : await completeFamiliesFromMatches(slimRows)
      setFamilies(nextFamilies)
      const map = await fetchAssignmentMap(nextFamilies.flatMap((family) => family.members.map((member) => member.id)))
      setVoterToLeaderId(map)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load notes.')
    } finally {
      setLoading(false)
    }
  }, [allowedWards, hasWardRestriction, part, presence])

  useEffect(() => {
    if (authLoading) return
    void load()
  }, [authLoading, load])

  const clubsMap = useMemo(() => new Map(clubs.map((club) => [club.id, club])), [clubs])

  const clubbedHiddenCount = useMemo(() => {
    if (!hideClubbed) return 0
    return families.filter((family) => Boolean(familyPlaceByHead[familyGroupHeadKey(family)])).length
  }, [families, familyPlaceByHead, hideClubbed])

  const filteredFamilies = useMemo(() => {
    const token = query.trim()
    return families.filter((family) => {
      const head = family.headVoter ?? family.members[0]
      const headKey = familyGroupHeadKey(family)
      const placeId = familyPlaceByHead[headKey] ?? null
      if (hideClubbed && placeId) return false
      if (!matchesPlace(placeId, hideClubbed ? 'unlabelled' : place)) return false
      if (!matchesPresence(head?.presence_status, presence)) return false
      if (!matchesPart(head?.part_no, part)) return false
      const note = presenceNoteOf(head)
      if (notes === 'yes' && !note) return false
      const leaderId = familyLeaderId(family, voterToLeaderId, specialIds)
      if (!matchesLeader(leaderId, leader, specialIds)) return false
      if (!matchesSearch(
        [head?.name, head?.epic_no, head?.part_no, note, presenceLabel(head?.presence_status)].join(' '),
        token,
      )) return false
      return true
    })
  }, [families, familyPlaceByHead, hideClubbed, leader, notes, part, place, presence, query, specialIds, voterToLeaderId])

  const parts = useMemo(() => distinctPartsFromFamilies(families), [families])
  const pageCount = Math.max(1, Math.ceil(filteredFamilies.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pagedFamilies = filteredFamilies.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const selectedFamilies = pagedFamilies.filter((family) => selectedKeys.has(family.key))

  const outsideClubs = useMemo(
    () => clubs.filter((club) => isOutsidePlaceClub(club)).sort((a, b) => placeClubFullLabel(a).localeCompare(placeClubFullLabel(b))),
    [clubs],
  )
  const localClubs = useMemo(
    () => clubs.filter((club) => !isOutsidePlaceClub(club)).sort((a, b) => placeClubLabel(a).localeCompare(placeClubLabel(b))),
    [clubs],
  )

  const handleExport = () => {
    const rows: NoteRow[] = filteredFamilies.map((family) => {
      const head = family.headVoter ?? family.members[0]
      const placeId = familyPlaceByHead[familyGroupHeadKey(family)]
      const club = placeId ? clubsMap.get(placeId) ?? null : null
      return {
        key: family.key,
        name: head?.name ?? family.head,
        epic: head?.epic_no ?? family.head,
        part: head?.part_no != null ? String(head.part_no) : '-',
        members: family.members.length,
        presence: presenceLabel(head?.presence_status) ?? 'Not set',
        presenceNote: presenceNoteOf(head),
        place: club ? placeClubFullLabel(club) : 'Unlabelled',
      }
    })
    const fields: ReportFieldDef<NoteRow>[] = [
      { key: 'name', label: 'Family Head', getValue: (row) => row.name },
      { key: 'epic', label: 'EPIC', getValue: (row) => row.epic },
      { key: 'part', label: 'Part', getValue: (row) => row.part },
      { key: 'members', label: 'Members', getValue: (row) => String(row.members) },
      { key: 'presence', label: 'Presence', getValue: (row) => row.presence },
      { key: 'place', label: 'Place', getValue: (row) => row.place },
      { key: 'presenceNote', label: 'Presence Note', getValue: (row) => row.presenceNote },
    ]
    void exportRowsToExcel({
      rows,
      fields,
      fileName: `presence-notes-${new Date().toISOString().slice(0, 10)}`,
      title: 'Presence Notes',
    })
  }

  const closePaste = () => {
    setPasteOpen(false)
    setPasteText('')
    setPastePreview(null)
    setMoveAnywayOpen(false)
  }

  const previewPasteEpics = async () => {
    if (!clubTarget) {
      toast.error('Pick a place first.')
      return
    }
    const epics = parseEpicList(pasteText)
    if (!epics.length) {
      toast.error('Paste one or more EPICs first.')
      return
    }
    setPasteLoading(true)
    try {
      const matches = await fetchVotersByEpics(epics, SLIM_FAMILY_VOTER_COLUMNS)
      const foundEpics = new Set(matches.map((row) => row.epic_no.trim().toUpperCase()))
      const unknown = epics.filter((epic) => !foundEpics.has(epic))
      const allowedMatches = hasWardRestriction
        ? matches.filter((row) => row.ward_no != null && allowedWards.includes(row.ward_no))
        : matches
      const blocked = matches.filter((row) => !allowedMatches.includes(row))
      for (const row of blocked) {
        const epic = row.epic_no.trim().toUpperCase()
        if (epic && !unknown.includes(epic)) unknown.push(epic)
      }
      const heads = Array.from(new Set(allowedMatches.map((row) => familyHeadKey(row)).filter(Boolean)))
      const related = heads.length ? await fetchVotersByFamilyHeads(heads, SLIM_FAMILY_VOTER_COLUMNS) : []
      const families = buildSlimFamilies(related)
      const epicToFamily = new Map<string, SlimFamily>()
      for (const family of families) {
        for (const member of family.members) {
          const epic = member.epic_no.trim().toUpperCase()
          if (epic) epicToFamily.set(epic, family)
        }
      }
      const grouped = new Map<string, PasteFamilyHit>()
      for (const epic of epics) {
        const family = epicToFamily.get(epic)
        if (!family) continue
        const headKey = familyGroupHeadKey(family)
        const existing = grouped.get(headKey)
        if (existing) {
          if (!existing.epics.includes(epic)) existing.epics.push(epic)
          continue
        }
        const placeId = familyPlaceByHead[headKey] ?? null
        const club = placeId ? clubsMap.get(placeId) ?? null : null
        grouped.set(headKey, {
          family,
          headKey,
          epics: [epic],
          placeId,
          placeLabel: club ? placeClubFullLabel(club) : 'Unlabelled',
        })
      }
      const matched: PasteFamilyHit[] = []
      const alreadyThere: PasteFamilyHit[] = []
      const otherPlace: PasteFamilyHit[] = []
      for (const hit of grouped.values()) {
        if (hit.placeId === clubTarget) alreadyThere.push(hit)
        else if (hit.placeId) otherPlace.push(hit)
        else matched.push(hit)
      }
      setPastePreview({ matched, alreadyThere, unknown, otherPlace })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not look up EPICs.')
    } finally {
      setPasteLoading(false)
    }
  }

  const confirmPasteEpics = async (includeOtherPlace: boolean) => {
    if (!clubTarget || !pastePreview) return
    const toClub = [
      ...pastePreview.matched,
      ...(includeOtherPlace ? pastePreview.otherPlace : []),
    ]
    const heads = toClub.map((hit) => hit.headKey).filter(Boolean)
    setSaving(true)
    try {
      if (heads.length) {
        await clubFamilies(heads, clubTarget)
        setFamilyPlaceByHead((current) => {
          const next = { ...current }
          for (const head of heads) next[head] = clubTarget
          return next
        })
      }
      const already = pastePreview.alreadyThere.length
      const unknown = pastePreview.unknown.length
      const skippedOther = includeOtherPlace ? 0 : pastePreview.otherPlace.length
      const parts = [
        `${heads.length} clubbed`,
        already ? `${already} already there` : null,
        unknown ? `${unknown} unknown` : null,
        skippedOther ? `${skippedOther} already in another place` : null,
      ].filter(Boolean)
      toast.success(parts.join(', '))
      closePaste()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not club families.')
    } finally {
      setSaving(false)
      setMoveAnywayOpen(false)
    }
  }

  const clubSelected = async () => {
    if (!clubTarget) {
      toast.error('Pick a place first.')
      return
    }
    const heads = selectedFamilies.map((family) => familyGroupHeadKey(family)).filter(Boolean)
    if (!heads.length) {
      toast.error('Select one or more families first.')
      return
    }
    setSaving(true)
    try {
      await clubFamilies(heads, clubTarget)
      setFamilyPlaceByHead((current) => {
        const next = { ...current }
        for (const head of heads) next[head] = clubTarget
        return next
      })
      setSelectedKeys(new Set())
      toast.success(`Clubbed ${heads.length} famil${heads.length === 1 ? 'y' : 'ies'}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not club families.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5 pb-10">
      <Link to="/team-leaders" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-tertiary transition hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> Back to Team Leaders
      </Link>

      <PageHeader
        title="Description and Presence Notes"
        description="Outside families that are not yet in a place. Search a locality, then club into Dabolim or another outside area."
        action={
          <button
            type="button"
            onClick={handleExport}
            disabled={loading || !filteredFamilies.length}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" /> Export
          </button>
        }
      />

      <PlacePresenceFilterBar
        presence={presence}
        onPresence={(value) => patchParams({ presence: value === 'OUTSIDE_MORMUGAO' ? null : value })}
        place={place}
        onPlace={(value) => patchParams({ place: value === 'unlabelled' ? null : value })}
        clubs={clubs}
        part={part}
        onPart={(value) => patchParams({ part: value || null })}
        parts={parts}
        leader={leader}
        onLeader={(value) => patchParams({ leader: value === 'all' ? null : value })}
        leaders={leaderOptions}
        query={query}
        onQuery={(value) => patchParams({ q: value || null })}
        notes={notes}
        onNotes={(value) => patchParams({ notes: value === 'all' ? null : value })}
        showNotesChip
        showPlace={!hideClubbed}
        extra={
          <>
            <label className="inline-flex h-8 cursor-pointer select-none items-center gap-1.5 rounded-full border border-line bg-white px-3 text-xs font-semibold text-ink-secondary">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded border-line text-brand-600"
                checked={hideClubbed}
                onChange={(event) => setHideClubbed(event.target.checked)}
              />
              Hide clubbed into places
            </label>
            <p className="text-xs text-ink-tertiary">
              {filteredFamilies.length.toLocaleString()} families{hideClubbed && clubbedHiddenCount ? ` · ${clubbedHiddenCount.toLocaleString()} clubbed hidden` : ''}
            </p>
          </>
        }
      />

      {canEdit ? (
        <section className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white px-4 py-3">
          <p className="text-xs font-semibold text-ink-secondary">{selectedFamilies.length} selected</p>
          <select
            className="h-8 min-w-[14rem] rounded-full border border-line bg-white px-3 text-xs font-semibold text-ink-secondary outline-none"
            value={clubTarget}
            onChange={(event) => setClubTarget(event.target.value)}
          >
            <option value="">Club into place</option>
            {outsideClubs.length ? (
              <optgroup label="Outside Mormugao">
                {outsideClubs.map((club) => (
                  <option key={club.id} value={club.id}>{placeClubFullLabel(club)}</option>
                ))}
              </optgroup>
            ) : null}
            {localClubs.length ? (
              <optgroup label="Local">
                {localClubs.map((club) => (
                  <option key={club.id} value={club.id}>{placeClubFullLabel(club)}</option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <button
            type="button"
            disabled={saving || !selectedFamilies.length || !clubTarget}
            onClick={() => void clubSelected()}
            className="inline-flex h-8 items-center rounded-full bg-violet-700 px-3 text-xs font-semibold text-white transition hover:bg-violet-800 disabled:opacity-50"
          >
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Club selected
          </button>
          <button
            type="button"
            disabled={saving || !clubTarget}
            onClick={() => { setPasteOpen(true); setPastePreview(null); setPasteText('') }}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:opacity-50"
          >
            <ClipboardPaste className="h-3.5 w-3.5" /> Paste EPICs
          </button>
          {!outsideClubs.length ? (
            <Link to="/places" className="text-xs font-semibold text-violet-700 hover:underline">
              Create Outside Mormugao / Dabolim in Places
            </Link>
          ) : null}
        </section>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-line bg-white">
        {loading ? (
          <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading notes...
          </div>
        ) : pagedFamilies.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-tertiary">No matching families.</p>
        ) : (
          <div className="divide-y divide-line">
            {pagedFamilies.map((family) => {
              const headKey = familyGroupHeadKey(family)
              const placeId = familyPlaceByHead[headKey]
              const club = placeId ? clubsMap.get(placeId) ?? null : null
              const leaderId = familyLeaderId(family, voterToLeaderId, specialIds)
              return (
                <FamilyWorkbenchRow
                  key={family.key}
                  family={family}
                  selectable={canEdit}
                  checked={selectedKeys.has(family.key)}
                  onToggle={() => {
                    setSelectedKeys((current) => {
                      const next = new Set(current)
                      if (next.has(family.key)) next.delete(family.key)
                      else next.add(family.key)
                      return next
                    })
                  }}
                  placeLabel={club ? placeClubLabel(club) : 'Unlabelled'}
                  leaderName={leaderId ? (leaderNameById[leaderId] || 'Team leader') : 'Unassigned'}
                  expanded={expandedKeys.has(family.key)}
                  onExpand={() => {
                    setExpandedKeys((current) => {
                      const next = new Set(current)
                      if (next.has(family.key)) next.delete(family.key)
                      else next.add(family.key)
                      return next
                    })
                  }}
                />
              )
            })}
          </div>
        )}
        {!loading && filteredFamilies.length > PAGE_SIZE ? (
          <div className="flex items-center justify-between border-t border-line px-5 py-3 text-xs font-semibold text-ink-secondary">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => patchParams({ page: String(safePage - 1) }, false)}
              className="inline-flex h-8 items-center gap-1 rounded-full border border-line px-3 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </button>
            <span>Page {safePage} of {pageCount}</span>
            <button
              type="button"
              disabled={safePage >= pageCount}
              onClick={() => patchParams({ page: String(safePage + 1) }, false)}
              className="inline-flex h-8 items-center gap-1 rounded-full border border-line px-3 disabled:opacity-40"
            >
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </section>

      {pasteOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-ink">Paste EPICs</h3>
                <p className="mt-1 text-xs text-ink-tertiary">
                  Club matched families into {clubTarget ? placeClubFullLabel(clubsMap.get(clubTarget) ?? null) : 'the selected place'}. One EPIC per line, or comma/space separated.
                </p>
              </div>
              <button type="button" onClick={closePaste} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
              <textarea
                className="h-32 w-full rounded-xl border border-line px-3 py-2 font-mono text-xs outline-none focus:border-brand-300"
                placeholder="ABC1234567&#10;XYZ9876543"
                value={pasteText}
                onChange={(event) => { setPasteText(event.target.value); setPastePreview(null) }}
              />
              {pastePreview ? (
                <div className="space-y-3 text-sm">
                  <div className="rounded-xl border border-line bg-muted px-3 py-2 text-xs text-ink-secondary">
                    {pastePreview.matched.length} matched · {pastePreview.alreadyThere.length} already there · {pastePreview.unknown.length} unknown · {pastePreview.otherPlace.length} already in another place
                  </div>
                  {pastePreview.matched.length ? (
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Matched families</p>
                      <ul className="space-y-1">
                        {pastePreview.matched.map((hit) => (
                          <li key={hit.headKey} className="rounded-lg border border-line px-3 py-2 text-xs text-ink-secondary">
                            {(hit.family.headVoter ?? hit.family.members[0])?.name ?? hit.headKey} · {hit.epics.join(', ')}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {pastePreview.alreadyThere.length ? (
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Already in that place</p>
                      <ul className="space-y-1">
                        {pastePreview.alreadyThere.map((hit) => (
                          <li key={hit.headKey} className="rounded-lg border border-line px-3 py-2 text-xs text-ink-secondary">
                            {(hit.family.headVoter ?? hit.family.members[0])?.name ?? hit.headKey}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {pastePreview.otherPlace.length ? (
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Already in another place</p>
                      <ul className="space-y-1">
                        {pastePreview.otherPlace.map((hit) => (
                          <li key={hit.headKey} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                            {(hit.family.headVoter ?? hit.family.members[0])?.name ?? hit.headKey} · already in {hit.placeLabel}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {pastePreview.unknown.length ? (
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Unknown EPIC</p>
                      <p className="rounded-lg border border-line px-3 py-2 font-mono text-xs text-ink-secondary">{pastePreview.unknown.join(', ')}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-4">
              <button type="button" onClick={closePaste} className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary">Cancel</button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={pasteLoading || saving || !pasteText.trim()}
                  onClick={() => void previewPasteEpics()}
                  className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary disabled:opacity-50"
                >
                  {pasteLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Preview
                </button>
                <button
                  type="button"
                  disabled={saving || !pastePreview || (!pastePreview.matched.length && !pastePreview.otherPlace.length)}
                  onClick={() => {
                    if (pastePreview?.otherPlace.length) setMoveAnywayOpen(true)
                    else void confirmPasteEpics(false)
                  }}
                  className="inline-flex h-10 items-center rounded-xl bg-violet-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                  Confirm
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {moveAnywayOpen && pastePreview ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-ink">Move anyway?</h3>
            <p className="mt-2 text-sm text-ink-secondary">
              {pastePreview.otherPlace.length} famil{pastePreview.otherPlace.length === 1 ? 'y is' : 'ies are'} already in another place. They will not be moved unless you confirm.
            </p>
            <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto text-xs text-ink-secondary">
              {pastePreview.otherPlace.map((hit) => (
                <li key={hit.headKey}>{(hit.family.headVoter ?? hit.family.members[0])?.name ?? hit.headKey} · {hit.placeLabel}</li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => { setMoveAnywayOpen(false); void confirmPasteEpics(false) }}
                className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary disabled:opacity-50"
              >
                Skip those
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void confirmPasteEpics(true)}
                className="h-10 rounded-xl bg-amber-600 px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                Move anyway
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
