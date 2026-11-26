import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ArrowLeft, CheckSquare, Download, Plus, Printer, Square, UserPlus } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { NotInvitedReportModal } from '../../components/meetings/NotInvitedReportModal'
import { decodePartPathParam, notInvitedEligibleMembers, ensureGlobalMeeting, fetchGlobalMeeting } from '../../hooks/useMeetingData'
import { useGlobalNotInvited } from '../../hooks/useGlobalNotInvited'
import { usePhotoUrls } from '../../hooks/usePhotoUrls'
import { initials, normalizeGroupingValue, familyMatchesSearch, memberMatchesSearch, tokenizeLookup, type FamilyGroup } from '../../lib/searchUtils'
import type { Meeting, Voter, MeetingAttendanceStatus } from '../../lib/types'
import { supabase } from '../../lib/supabase'

export function GlobalNotYetInvitedPartPage() {
  const { partNo } = useParams<{ partNo: string }>()
  const navigate = useNavigate()
  const partValue = decodePartPathParam(partNo)

  const { loading, families, invitedVoterIds, voterById, reload } = useGlobalNotInvited({ scopePart: partValue })

  const [search, setSearch] = useState('')
  const [selectedVoterIds, setSelectedVoterIds] = useState<Set<string>>(new Set())
  const [reportMode, setReportMode] = useState<'export' | 'print' | null>(null)

  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [selectedMeetingId, setSelectedMeetingId] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    void fetchGlobalMeeting().then(({ meeting }) => {
      if (cancelled) return
      setMeetings(meeting ? [meeting] : [])
      setSelectedMeetingId((current) => current || (meeting?.id ?? ''))
    })
    return () => { cancelled = true }
  }, [])

  const searchTokens = useMemo(() => tokenizeLookup(search), [search])

  const filteredFamilies = useMemo(() => {
    if (!searchTokens.length) return families
    return families.filter((family) => familyMatchesSearch(family, searchTokens))
  }, [families, searchTokens])

  const eligibleCount = useMemo(() => {
    let count = 0
    for (const family of filteredFamilies) count += notInvitedEligibleMembers(family, invitedVoterIds).length
    return count
  }, [filteredFamilies, invitedVoterIds])

  const selectedCount = useMemo(() => {
    let count = 0
    for (const family of filteredFamilies) {
      for (const member of notInvitedEligibleMembers(family, invitedVoterIds)) {
        if (selectedVoterIds.has(member.id)) count += 1
      }
    }
    return count
  }, [filteredFamilies, invitedVoterIds, selectedVoterIds])

  const photoPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const family of families) {
      for (const member of family.members) if (member.photo_url) paths.add(member.photo_url)
    }
    for (const vid of selectedVoterIds) {
      const v = voterById.get(vid)
      if (v?.photo_url) paths.add(v.photo_url)
    }
    return Array.from(paths)
  }, [families, selectedVoterIds, voterById])

  const photoUrlByPath = usePhotoUrls(photoPaths)

  const epicToVoter = useMemo(() => {
    const map = new Map<string, Voter>()
    for (const v of voterById.values()) {
      const key = normalizeGroupingValue(v.epic_no)
      if (key) map.set(key, v)
    }
    return map
  }, [voterById])

  const toggleVoterSelected = (id: string) => {
    if (invitedVoterIds.has(id)) return
    setSelectedVoterIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const familyFullySelected = (family: FamilyGroup) => {
    const eligible = notInvitedEligibleMembers(family, invitedVoterIds)
    return eligible.length > 0 && eligible.every((m) => selectedVoterIds.has(m.id))
  }

  const toggleFamilySelection = (family: FamilyGroup) => {
    const eligible = notInvitedEligibleMembers(family, invitedVoterIds)
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

  const selectAllFiltered = () => {
    setSelectedVoterIds((prev) => {
      const next = new Set(prev)
      for (const family of filteredFamilies) {
        for (const member of notInvitedEligibleMembers(family, invitedVoterIds)) next.add(member.id)
      }
      return next
    })
  }

  const deselectAllFiltered = () => {
    setSelectedVoterIds((prev) => {
      const next = new Set(prev)
      for (const family of filteredFamilies) {
        for (const member of notInvitedEligibleMembers(family, invitedVoterIds)) next.delete(member.id)
      }
      return next
    })
  }

  const addInvitees = async () => {
    if (selectedVoterIds.size === 0) { toast.error('Select voters to add.'); return }
    const globalMeeting = await ensureGlobalMeeting()
    if (!globalMeeting) { toast.error('Could not start the global meeting.'); return }
    const rows = Array.from(selectedVoterIds).map((vid) => ({
      meeting_id: globalMeeting.id,
      voter_id: vid,
      attendance_status: 'pending' as MeetingAttendanceStatus,
    }))
    const { error } = await supabase.from('meeting_invitees').upsert(rows, { onConflict: 'meeting_id,voter_id' })
    if (error) { toast.error(error.message); return }
    toast.success(`Added ${rows.length} invitee(s).`)
    setSelectedVoterIds(new Set())
    setMeetings([globalMeeting])
    setSelectedMeetingId(globalMeeting.id)
    await reload()
  }

  const createMeetingAndAddSelected = async () => {
    if (selectedVoterIds.size === 0) { toast.error('Select voters to add.'); return }
    await addInvitees()
    if (selectedMeetingId) navigate(`/meetings/${selectedMeetingId}`)
  }

  if (loading) {
    return <div className="p-8 text-sm text-ink-secondary">Loading not-yet-invited families...</div>
  }

  return (
    <div className="space-y-4 pb-6">
      <div className="mb-4">
        <button
          type="button"
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
          onClick={() => navigate('/not-yet-invited')}
        >
          <ArrowLeft className="h-4 w-4" /> Back to Not Yet Invited Coverage
        </button>
      </div>

      <PageHeader
        title={`Not Yet Invited - Part ${partValue || 'Unassigned'}`}
        description="Families with no members invited to any meeting, by part"
      />

      <section className="rounded-xl border border-line bg-white p-4 md:p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3">
            <p className="text-xs font-semibold text-indigo-700">Families</p>
            <p className="text-2xl font-bold text-indigo-900">{families.length.toLocaleString()}</p>
          </div>
          <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3">
            <p className="text-xs font-semibold text-blue-700">Voters</p>
            <p className="text-2xl font-bold text-blue-900">{eligibleCount.toLocaleString()}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs font-semibold text-emerald-700">Selected</p>
            <p className="text-2xl font-bold text-emerald-900">{selectedCount.toLocaleString()}</p>
          </div>
        </div>

        <div className="sticky top-0 z-10 mt-4 flex flex-col gap-3 rounded-xl border border-line bg-white/95 px-4 py-3 backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="h-10 min-w-[220px] flex-1 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              placeholder="Search by name, EPIC, house, contact..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              type="button"
              disabled={!filteredFamilies.length}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              onClick={selectAllFiltered}
            >
              <CheckSquare className="h-4 w-4" /> Select All
            </button>
            <button
              type="button"
              disabled={selectedCount === 0}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              onClick={deselectAllFiltered}
            >
              <Square className="h-4 w-4" /> Deselect All
            </button>
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
              onClick={() => setReportMode('export')}
            >
              <Download className="h-4 w-4" /> Export
            </button>
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
              onClick={() => setReportMode('print')}
            >
              <Printer className="h-4 w-4" /> Print
            </button>
            <span className="rounded-full bg-brand-50 px-3 py-2 text-xs font-semibold text-brand-800">
              Selected: {selectedCount.toLocaleString()} / {eligibleCount.toLocaleString()}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
            <span className="text-sm font-semibold text-brand-800">
              {selectedCount} of {eligibleCount} voter(s) selected
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-brand-800">
                {selectedCount} of {eligibleCount} voter(s) selected
              </span>
              <button
                type="button"
                disabled={selectedCount === 0}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void addInvitees()}
                title="Add the selected voters to the single global meeting"
              >
                <UserPlus className="h-4 w-4" /> Add {selectedCount} Voter(s) to Global Meeting
              </button>
              <button
                type="button"
                disabled={selectedCount === 0 || !meetings.length}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void createMeetingAndAddSelected()}
                title="Add the selected voters to the global meeting and open it"
              >
                <Plus className="h-4 w-4" /> Add &amp; Open Global Meeting
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4">
          {!filteredFamilies.length ? (
            <p className="text-sm text-ink-secondary">No not-yet-invited families match this search.</p>
          ) : (
            <div className="space-y-4">
              {filteredFamilies.map((family) => {
                const eligible = notInvitedEligibleMembers(family, invitedVoterIds)
                const fullySelected = familyFullySelected(family)
                return (
                  <div key={family.key} className="overflow-hidden rounded-xl border border-line bg-white">
                    <div className="flex flex-wrap items-start gap-3 border-b border-line bg-muted/70 px-4 py-4 sm:px-5">
                      <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-white shadow-sm">
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
                      </div>
                      <button
                        type="button"
                        disabled={!eligible.length}
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={() => toggleFamilySelection(family)}
                      >
                        {fullySelected ? 'Unselect family' : `Select whole family (${eligible.length})`}
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
                            const covered = invitedVoterIds.has(member.id)
                            const checked = selectedVoterIds.has(member.id)
                            const isMatch = searchTokens.length > 0 && memberMatchesSearch(member, searchTokens)
                            return (
                              <tr key={member.id} className={`${isMatch ? 'bg-amber-50' : ''} ${covered ? 'opacity-60' : ''}`}>
                                <td className="border-b border-line px-2 py-2 text-center">
                                  <input
                                    type="checkbox"
                                    disabled={covered}
                                    checked={covered || checked}
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
                                  {covered ? (
                                    <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Already invited</span>
                                  ) : null}
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
        </div>
      </section>

      <NotInvitedReportModal
        mode={reportMode}
        onClose={() => setReportMode(null)}
        meeting={null}
        coverageFamilies={families}
        epicToVoter={epicToVoter}
        fixedPartScope={partValue}
        headingOverride={`Not Yet Invited - Part ${partValue || 'Unassigned'}`}
        selectedVoterIds={selectedVoterIds}
      />
    </div>
  )
}
