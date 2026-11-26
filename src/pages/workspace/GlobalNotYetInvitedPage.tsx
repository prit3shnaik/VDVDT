import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronRight, Download, Printer } from 'lucide-react'
import type { Voter } from '../../lib/types'
import { PageHeader } from '../../components/common/PageHeader'
import { NotInvitedReportModal } from '../../components/meetings/NotInvitedReportModal'
import { groupFamiliesByPart, notInvitedEligibleMembers, partPathParam } from '../../hooks/useMeetingData'
import { useGlobalNotInvited } from '../../hooks/useGlobalNotInvited'
import { normalizeGroupingValue } from '../../lib/searchUtils'

export function GlobalNotYetInvitedPage() {
  const navigate = useNavigate()
  const { loading, families, invitedVoterIds, voterById, hasWardRestriction } = useGlobalNotInvited()

  const [reportMode, setReportMode] = useState<'export' | 'print' | null>(null)

  const partGroups = useMemo(() => groupFamiliesByPart(families), [families])

  const totalVoters = useMemo(() => {
    return families.reduce((sum, f) => sum + notInvitedEligibleMembers(f, invitedVoterIds).length, 0)
  }, [families, invitedVoterIds])

  const epicToVoter = useMemo(() => {
    const map = new Map<string, Voter>()
    for (const v of voterById.values()) {
      const key = normalizeGroupingValue(v.epic_no)
      if (key) map.set(key, v)
    }
    return map
  }, [voterById])

  const partScopeOptions = useMemo(() => [
    { value: 'all', label: `All not-yet-invited parts (${families.length} families)` },
    ...partGroups.map((group) => ({
      value: group.part,
      label: `Part ${group.part || 'Unassigned'} (${group.families.length} families)`,
    })),
  ], [partGroups, families.length])

  if (loading) {
    return <div className="p-8 text-sm text-ink-secondary">Loading not-yet-invited coverage...</div>
  }

  return (
    <div className="space-y-4 pb-6">
      <div className="mb-4">
        <button
          type="button"
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
          onClick={() => navigate('/meetings')}
        >
          <ArrowLeft className="h-4 w-4" /> Back to Meetings
        </button>
      </div>

      <PageHeader
        title="Not Yet Invited"
        description="Families where no member has been invited to any meeting, across all meetings."
      />

      <section className="rounded-xl border border-line bg-white p-4 md:p-5">
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3">
            <p className="text-xs font-semibold text-indigo-700">Families</p>
            <p className="text-2xl font-bold text-indigo-900">{families.length.toLocaleString()}</p>
          </div>
          <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3">
            <p className="text-xs font-semibold text-blue-700">Voters</p>
            <p className="text-2xl font-bold text-blue-900">{totalVoters.toLocaleString()}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs font-semibold text-emerald-700">Parts</p>
            <p className="text-2xl font-bold text-emerald-900">{partGroups.length.toLocaleString()}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-ink-tertiary">
            Families with no members invited to any meeting.
            {hasWardRestriction ? ' Restricted to accessible wards.' : ''}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!families.length}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => setReportMode('export')}
            >
              <Download className="h-4 w-4" /> Export
            </button>
            <button
              type="button"
              disabled={!families.length}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => setReportMode('print')}
            >
              <Printer className="h-4 w-4" /> Print
            </button>
          </div>
        </div>

        {!partGroups.length ? (
          <p className="mt-4 rounded-2xl border border-dashed border-line px-4 py-6 text-sm text-ink-secondary">
            Every family has at least one invited member - nothing left to invite.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-xs">
              <thead className="bg-muted">
                <tr>
                  <th className="border-b border-line px-4 py-3 text-left font-semibold text-ink-secondary">Part</th>
                  <th className="border-b border-line px-4 py-3 text-center font-semibold text-ink-secondary">Families Not Invited</th>
                  <th className="border-b border-line px-4 py-3 text-center font-semibold text-ink-secondary">Voters</th>
                  <th className="border-b border-line px-4 py-3 text-right font-semibold text-ink-secondary"></th>
                </tr>
              </thead>
              <tbody>
                {partGroups.map((group) => {
                  const eligible = group.families.reduce((sum, f) => sum + notInvitedEligibleMembers(f, invitedVoterIds).length, 0)
                  return (
                    <tr key={group.part} className="transition hover:bg-muted">
                      <td className="border-b border-line px-4 py-3 font-medium text-ink">
                        Part {group.part || 'Unassigned'}
                      </td>
                      <td className="border-b border-line px-4 py-3 text-center text-ink-secondary">{group.families.length}</td>
                      <td className="border-b border-line px-4 py-3 text-center text-ink-secondary">{eligible}</td>
                      <td className="border-b border-line px-4 py-3 text-right">
                        <button
                          type="button"
                          className="inline-flex h-9 items-center gap-1 rounded-xl border border-line bg-white px-3 text-xs font-semibold text-brand-600 transition hover:bg-brand-50"
                          onClick={() => navigate(`/not-yet-invited/part/${partPathParam(group.part)}`)}
                        >
                          View families <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <NotInvitedReportModal
        mode={reportMode}
        onClose={() => setReportMode(null)}
        meeting={null}
        coverageFamilies={families}
        epicToVoter={epicToVoter}
        partScopeOptions={partScopeOptions}
        headingOverride="Not Yet Invited - All Parts"
      />
    </div>
  )
}
