import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Voter } from '../lib/types'
import { buildFamilies, type FamilyGroup } from '../lib/searchUtils'
import { buildWardScope } from '../lib/voterCache'
import { useAuth } from './useAuth'
import { fetchInvitedAnywhereVoterIds, fetchVotersForScope } from './useMeetingData'

export const GLOBAL_NOT_INVITED_CACHE_KEY = 'vote:global-not-invited:voters-cache'

export interface GlobalNotInvitedData {
  loading: boolean
  families: FamilyGroup[]
  invitedVoterIds: Set<string>
  voterById: Map<string, Voter>
  reload: () => void
  wardScope: string
  allowedWards: number[]
  hasWardRestriction: boolean
}

export function useGlobalNotInvited(options?: { scopePart?: string | null }): GlobalNotInvitedData {
  const { profile } = useAuth()
  const scopePart = options?.scopePart ?? null

  const [voters, setVoters] = useState<Voter[]>([])
  const [invitedVoterIds, setInvitedVoterIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  const wardScope = buildWardScope(profile?.role, profile?.allowed_wards)
  const allowedWards = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((w) => Number.isFinite(w))))
    wards.sort((a, b) => a - b)
    return wards
  }, [profile?.allowed_wards])
  const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0

  const load = useCallback(async () => {
    setLoading(true)
    const [rows, invited] = await Promise.all([
      fetchVotersForScope({
        cacheKey: GLOBAL_NOT_INVITED_CACHE_KEY,
        wardScope,
        hasWardRestriction,
        allowedWards,
        scopePart,
      }),
      fetchInvitedAnywhereVoterIds(),
    ])
    setVoters(rows)
    setInvitedVoterIds(invited)
    setLoading(false)
  }, [wardScope, hasWardRestriction, allowedWards, scopePart])

  useEffect(() => { void load() }, [load, reloadKey])

  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  const voterById = useMemo(() => {
    const map = new Map<string, Voter>()
    for (const v of voters) map.set(v.id, v)
    return map
  }, [voters])

  const allFamilies = useMemo(() => buildFamilies(voters), [voters])

  const families = useMemo(() => {
    const notInvited = allFamilies.filter((f) => f.members.every((m) => !invitedVoterIds.has(m.id)))
    if (scopePart === null) return notInvited
    // fetchVotersForScope pulls in linked family members across all parts,
    // so allFamilies can contain families whose HEAD lives in another part
    // (they were reached via a member in this part). The report modal groups
    // family-wise by the head's part, so filter the same way here to keep
    // the page counts (families/voters) in sync with export/print.
    const part = String(scopePart)
    return notInvited.filter((f) => String(f.headVoter?.part_no ?? '') === part)
  }, [allFamilies, invitedVoterIds, scopePart])

  return {
    loading,
    families,
    invitedVoterIds,
    voterById,
    reload,
    wardScope,
    allowedWards,
    hasWardRestriction,
  }
}
