import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { PageHeader } from '../../components/common/PageHeader'
import { supabase } from '../../lib/supabase'
import type { Voter } from '../../lib/types'
import { FAST_NAV_CACHE_MAX_AGE_MS, readCachedCollection, writeCachedCollection } from '../../lib/voterCache'

const WARDS_VOTERS_CACHE_KEY = 'vote:admin:wards-voters'

interface WardSummary {
  wardNo: number
  voters: number
  parts: number[]
}

export function WardsPage() {
  const [voters, setVoters] = useState<Voter[]>([])
  const [loading, setLoading] = useState(true)
  const [newWard, setNewWard] = useState('')
  const [bulkPart, setBulkPart] = useState('')
  const [bulkWard, setBulkWard] = useState('')
  const [individualWard, setIndividualWard] = useState('')
  const [selectedPartFilter, setSelectedPartFilter] = useState('all')
  const [searchEpic, setSearchEpic] = useState('')

  const load = useCallback(async () => {
    const cachedRows = readCachedCollection<Voter>(WARDS_VOTERS_CACHE_KEY, 'global', FAST_NAV_CACHE_MAX_AGE_MS)
    setLoading(!cachedRows)
    if (cachedRows) {
      setVoters(cachedRows)
    }

    const { data, error } = await supabase
      .from('voters')
      .select('*')
      .order('ward_no', { ascending: true, nullsFirst: true })
      .order('part_no', { ascending: true, nullsFirst: true })
      .order('section', { ascending: true, nullsFirst: true })
      .order('sr_no_roll', { ascending: true, nullsFirst: true })
      .limit(10000)

    if (error) {
      toast.error(error.message)
      setLoading(false)
      return
    }

    const rows = (data as Voter[] | null) ?? []
    setVoters(rows)
    writeCachedCollection<Voter>(WARDS_VOTERS_CACHE_KEY, 'global', rows)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const partOptions = useMemo(
    () =>
      Array.from(new Set(voters.map((voter) => voter.part_no).filter((value): value is number => value !== null))).sort(
        (a, b) => a - b,
      ),
    [voters],
  )

  const wardOptions = useMemo(
    () =>
      Array.from(new Set(voters.map((voter) => voter.ward_no).filter((value): value is number => value !== null))).sort(
        (a, b) => a - b,
      ),
    [voters],
  )

  const wardSummaries = useMemo<WardSummary[]>(() => {
    const map = new Map<number, { voters: number; partSet: Set<number> }>()
    for (const voter of voters) {
      if (voter.ward_no === null) {
        continue
      }

      if (!map.has(voter.ward_no)) {
        map.set(voter.ward_no, { voters: 0, partSet: new Set<number>() })
      }

      const current = map.get(voter.ward_no)
      if (!current) {
        continue
      }

      current.voters += 1
      if (voter.part_no !== null) {
        current.partSet.add(voter.part_no)
      }
    }

    return Array.from(map.entries())
      .map(([wardNo, summary]) => ({
        wardNo,
        voters: summary.voters,
        parts: Array.from(summary.partSet).sort((a, b) => a - b),
      }))
      .sort((a, b) => a.wardNo - b.wardNo)
  }, [voters])

  const filteredForIndividualAssign = useMemo(() => {
    return voters.filter((voter) => {
      if (selectedPartFilter !== 'all' && String(voter.part_no ?? '') !== selectedPartFilter) {
        return false
      }

      const text = searchEpic.trim().toLowerCase()
      if (!text) {
        return true
      }

      return `${voter.epic_no} ${voter.name}`.toLowerCase().includes(text)
    })
  }, [searchEpic, selectedPartFilter, voters])

  const createWardBucket = async () => {
    const ward = Number.parseInt(newWard.trim(), 10)
    if (Number.isNaN(ward)) {
      toast.error('Enter a valid ward number.')
      return
    }

    setNewWard(String(ward))
    setBulkWard(String(ward))
    setIndividualWard(String(ward))
    toast.success(`Ward ${ward} is ready to use for assignments.`)
  }

  const assignPartToWard = async () => {
    const partNo = Number.parseInt(bulkPart.trim(), 10)
    const wardNo = Number.parseInt(bulkWard.trim(), 10)

    if (Number.isNaN(partNo) || Number.isNaN(wardNo)) {
      toast.error('Select valid part and ward.')
      return
    }

    const { error } = await supabase.from('voters').update({ ward_no: wardNo }).eq('part_no', partNo)
    if (error) {
      toast.error(error.message)
      return
    }

    toast.success(`Part ${partNo} voters assigned to Ward ${wardNo}.`)
    await load()
  }

  const assignSingleVoterToWard = async (voterId: string) => {
    const wardNo = Number.parseInt(individualWard.trim(), 10)
    if (Number.isNaN(wardNo)) {
      toast.error('Select a target ward first.')
      return
    }

    const { error } = await supabase.from('voters').update({ ward_no: wardNo }).eq('id', voterId)
    if (error) {
      toast.error(error.message)
      return
    }

    toast.success('Voter ward updated.')
    await load()
  }

  return (
    <div>
      <PageHeader
        title="Wards Management"
        description="Create ward buckets, assign voters by whole part, and fine-tune voter distribution one-by-one."
      />

      <section className="rounded-xl border border-line bg-white p-4">
        <h2 className="font-semibold text-ink">Create Ward</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className="h-10 rounded-lg border border-line px-3 text-sm"
            placeholder="Ward number"
            value={newWard}
            onChange={(event) => setNewWard(event.target.value)}
          />
          <button
            type="button"
            className="h-10 rounded-lg bg-brand-500 px-3 text-sm font-semibold text-white"
            onClick={() => void createWardBucket()}
          >
            Set Ward
          </button>
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white p-4">
        <h2 className="font-semibold text-ink">Bulk Assign by Part</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Assign complete part voters to a ward, then use one-by-one assignment for cross-part adjustments.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className="h-10 rounded-lg border border-line px-3 text-sm"
            value={bulkPart}
            onChange={(event) => setBulkPart(event.target.value)}
          >
            <option value="">Select part</option>
            {partOptions.map((part) => (
              <option key={part} value={String(part)}>
                Part {part}
              </option>
            ))}
          </select>
          <select
            className="h-10 rounded-lg border border-line px-3 text-sm"
            value={bulkWard}
            onChange={(event) => setBulkWard(event.target.value)}
          >
            <option value="">Select ward</option>
            {wardOptions.map((ward) => (
              <option key={ward} value={String(ward)}>
                Ward {ward}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="h-10 rounded-lg bg-brand-500 px-3 text-sm font-semibold text-white"
            onClick={() => void assignPartToWard()}
          >
            Assign Part to Ward
          </button>
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white p-4">
        <h2 className="font-semibold text-ink">Ward Summary</h2>
        {loading ? <p className="mt-2 text-sm text-ink-secondary">Loading wards...</p> : null}
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-ink-tertiary">
                <th className="py-2">Ward</th>
                <th className="py-2">Voters</th>
                <th className="py-2">Parts Included</th>
              </tr>
            </thead>
            <tbody>
              {wardSummaries.map((summary) => (
                <tr key={summary.wardNo} className="border-t border-line">
                  <td className="py-2 text-ink">Ward {summary.wardNo}</td>
                  <td className="py-2 text-ink-secondary">{summary.voters}</td>
                  <td className="py-2 text-ink-secondary">{summary.parts.length ? summary.parts.join(', ') : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white p-4">
        <h2 className="font-semibold text-ink">Assign Voters One by One</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className="h-10 rounded-lg border border-line px-3 text-sm"
            value={selectedPartFilter}
            onChange={(event) => setSelectedPartFilter(event.target.value)}
          >
            <option value="all">All Parts</option>
            {partOptions.map((part) => (
              <option key={part} value={String(part)}>
                Part {part}
              </option>
            ))}
          </select>
          <input
            className="h-10 rounded-lg border border-line px-3 text-sm"
            placeholder="Search EPIC or Name"
            value={searchEpic}
            onChange={(event) => setSearchEpic(event.target.value)}
          />
          <select
            className="h-10 rounded-lg border border-line px-3 text-sm"
            value={individualWard}
            onChange={(event) => setIndividualWard(event.target.value)}
          >
            <option value="">Target ward</option>
            {wardOptions.map((ward) => (
              <option key={ward} value={String(ward)}>
                Ward {ward}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-3 max-h-[460px] overflow-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-ink-tertiary">
                <th className="py-2">EPIC</th>
                <th className="py-2">Name</th>
                <th className="py-2">Part</th>
                <th className="py-2">Section</th>
                <th className="py-2">Current Ward</th>
                <th className="py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredForIndividualAssign.map((voter) => (
                <tr key={voter.id} className="border-t border-line">
                  <td className="py-2 text-ink-secondary">{voter.epic_no}</td>
                  <td className="py-2 text-ink">{voter.name}</td>
                  <td className="py-2 text-ink-secondary">{voter.part_no ?? '-'}</td>
                  <td className="py-2 text-ink-secondary">{voter.section ?? '-'}</td>
                  <td className="py-2 text-ink-secondary">{voter.ward_no ?? 'Unassigned'}</td>
                  <td className="py-2">
                    <button
                      type="button"
                      className="h-8 rounded-md border border-line px-2 text-xs"
                      onClick={() => void assignSingleVoterToWard(voter.id)}
                    >
                      Assign to Ward
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
