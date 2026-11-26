import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Meeting, MeetingInvitee, Voter } from '../lib/types'
import { supabase } from '../lib/supabase'
import { useAuth } from './useAuth'
import { buildFamilies, normalizeGroupingValue, type FamilyGroup } from '../lib/searchUtils'
import { buildWardScope, FAST_NAV_CACHE_MAX_AGE_MS, readCachedVoters, writeCachedVoters } from '../lib/voterCache'
import { withNormalizedVoterCategories } from '../lib/voterCategory'
import { D1_IN_CHUNK } from '../lib/d1Query'

export const MEETING_VOTERS_CACHE_KEY = 'vote:meeting-detail:voters-cache'

// Mirrors the SQL rule in supabase/migrations/202608060001_global_meeting_merge.sql:
// the single global meeting is the one with the earliest meeting_date (then
// earliest created_at, then earliest id). The frontend and the migration use
// this same rule so the app works even before the old rows are cleaned up.
export function pickGlobalMeeting(meetings: Meeting[]): Meeting | null {
  if (!meetings.length) return null
  return [...meetings].sort((a, b) => {
    const dateCompare = (a.meeting_date ?? '').localeCompare(b.meeting_date ?? '')
    if (dateCompare !== 0) return dateCompare
    const createdCompare = (a.created_at ?? '').localeCompare(b.created_at ?? '')
    if (createdCompare !== 0) return createdCompare
    return a.id.localeCompare(b.id)
  })[0]
}

export async function fetchGlobalMeeting(): Promise<{ meeting: Meeting | null; meetings: Meeting[] }> {
  const { data, error } = await supabase
    .from('meetings')
    .select('*')
    .order('meeting_date', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) return { meeting: null, meetings: [] }
  const meeting = (data as Meeting | null) ?? null
  const all = meeting ? [meeting] : []
  return { meeting, meetings: all }
}

export async function ensureGlobalMeeting(): Promise<Meeting | null> {
  const { meeting } = await fetchGlobalMeeting()
  if (meeting) return meeting

  const { data, error } = await supabase
    .from('meetings')
    .insert({
      title: null,
      meeting_date: new Date().toISOString().slice(0, 10),
      location: null,
      part_no: null,
      notes: null,
    })
    .select('*')
    .single()

  if (error) return null
  return (data as Meeting) ?? null
}

export interface PagedFetchResult<T> {
  rows: T[]
  /** False when a page request errored, meaning `rows` is truncated. */
  complete: boolean
}

export async function fetchAllPagesResult<T>(
  buildQuery: (from: number, to: number) => Promise<{ data: unknown; error: unknown }>,
  batchSize = 400,
): Promise<PagedFetchResult<T>> {
  const out: T[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await buildQuery(offset, offset + batchSize - 1)
    if (error) return { rows: out, complete: false }
    const batch = (data as T[] | null) ?? []
    out.push(...batch)
    if (batch.length < batchSize) break
    offset += batchSize
  }
  return { rows: out, complete: true }
}

export async function fetchAllPages<T>(
  buildQuery: (from: number, to: number) => Promise<{ data: unknown; error: unknown }>,
  batchSize = 400,
): Promise<T[]> {
  const { rows } = await fetchAllPagesResult<T>(buildQuery, batchSize)
  return rows
}

async function fetchAllVoterPages(
  buildQuery: (from: number, to: number) => Promise<{ data: unknown; error: unknown }>,
): Promise<PagedFetchResult<Voter>> {
  return fetchAllPagesResult<Voter>(buildQuery, 400)
}

export interface FetchVotersForScopeOptions {
  cacheKey: string
  wardScope: string
  hasWardRestriction: boolean
  allowedWards: number[]
  scopePart?: string | null
  maxAgeMs?: number
}

export async function fetchVotersForScope(options: FetchVotersForScopeOptions): Promise<Voter[]> {
  const { cacheKey, wardScope, hasWardRestriction, allowedWards, scopePart, maxAgeMs = FAST_NAV_CACHE_MAX_AGE_MS } = options
  const effectivePart = typeof scopePart === 'string' ? scopePart : null
  const cacheScope = `${wardScope}|part:${effectivePart ?? 'all'}`
  const cached = readCachedVoters(cacheKey, cacheScope, maxAgeMs)
  if (cached) return withNormalizedVoterCategories(cached)

  let base = supabase.from('voters').select('*')
  if (effectivePart != null) {
    base = effectivePart === '' ? base.is('part_no', null) : base.eq('part_no', effectivePart)
  }
  if (hasWardRestriction) base = base.in('ward_no', allowedWards)
  const partResult = await fetchAllVoterPages(async (from, to) => base.range(from, to))
  const partVoters = partResult.rows
  let complete = partResult.complete

  const merged = new Map<string, Voter>()
  for (const v of partVoters) merged.set(v.id, v)

  if (effectivePart != null) {
    const familyKeys = new Set<string>()
    for (const v of partVoters) {
      const key = normalizeGroupingValue(v.family_head_epic) || normalizeGroupingValue(v.epic_no)
      if (key) familyKeys.add(key)
    }
    const keys = Array.from(familyKeys)
    for (let i = 0; i < keys.length; i += D1_IN_CHUNK) {
      const chunk = keys.slice(i, i + D1_IN_CHUNK)
      let extraQuery = supabase
        .from('voters')
        .select('*')
        .or(`epic_no.in.(${chunk.join(',')}),family_head_epic.in.(${chunk.join(',')})`)
      if (hasWardRestriction) extraQuery = extraQuery.in('ward_no', allowedWards)
      const extra = await fetchAllVoterPages(async (from, to) => extraQuery.range(from, to))
      if (!extra.complete) complete = false
      for (const v of extra.rows) merged.set(v.id, v)
    }
  }

  const rows = withNormalizedVoterCategories(Array.from(merged.values()))
  // Caching a truncated set would keep hiding voters for the whole cache lifetime.
  if (complete) writeCachedVoters(cacheKey, cacheScope, rows)
  return rows
}

const INVITED_ANYWHERE_CACHE_MAX_AGE_MS = 60_000
let invitedAnywhereCache: { savedAt: number; ids: string[] } | null = null

export async function fetchInvitedAnywhereVoterIds(): Promise<Set<string>> {
  if (invitedAnywhereCache && Date.now() - invitedAnywhereCache.savedAt < INVITED_ANYWHERE_CACHE_MAX_AGE_MS) {
    return new Set(invitedAnywhereCache.ids)
  }

  const ids = new Set<string>()
  let offset = 0
  const batchSize = 1000
  for (;;) {
    const { data, error } = await supabase
      .from('meeting_invitees')
      .select('voter_id')
      .range(offset, offset + batchSize - 1)
    if (error) break
    const batch = (data as Array<{ voter_id: string }> | null) ?? []
    for (const row of batch) ids.add(row.voter_id)
    if (batch.length < batchSize) break
    offset += batchSize
  }

  invitedAnywhereCache = { savedAt: Date.now(), ids: Array.from(ids) }
  return ids
}

export interface MeetingData {
  loading: boolean
  notFound: boolean
  meeting: Meeting | null
  voters: Voter[]
  invitees: MeetingInvitee[]
  reload: () => void
  voterById: Map<string, Voter>
  allFamilies: FamilyGroup[]
  inviteeVoterIds: Set<string>
  inviteeRows: Array<{ invitee: MeetingInvitee; voter: Voter | null }>
  wardScope: string
  allowedWards: number[]
  hasWardRestriction: boolean
}

export function useMeetingData(meetingId: string | undefined, options?: { scopePart?: string }): MeetingData {
  const { profile } = useAuth()
  const scopePart = options?.scopePart

  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [voters, setVoters] = useState<Voter[]>([])
  const [invitees, setInvitees] = useState<MeetingInvitee[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const wardScope = buildWardScope(profile?.role, profile?.allowed_wards)
  const allowedWards = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((w) => Number.isFinite(w))))
    wards.sort((a, b) => a - b)
    return wards
  }, [profile?.allowed_wards])
  const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0

  const load = useCallback(async () => {
    if (!meetingId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setNotFound(false)

    const [mRes, iRes] = await Promise.all([
      supabase.from('meetings').select('*').eq('id', meetingId).single(),
      supabase.from('meeting_invitees').select('*').eq('meeting_id', meetingId),
    ])

    if (mRes.error) {
      setNotFound(true)
      setMeeting(null)
      setLoading(false)
      return
    }
    setMeeting(mRes.data as Meeting)
    setInvitees((iRes.data as MeetingInvitee[] | null) ?? [])

    const voterRows = await fetchVotersForScope({
      cacheKey: MEETING_VOTERS_CACHE_KEY,
      wardScope,
      hasWardRestriction,
      allowedWards,
      scopePart,
    })

    setVoters(voterRows)
    setLoading(false)
  }, [meetingId, wardScope, hasWardRestriction, allowedWards, scopePart])

  useEffect(() => { void load() }, [load, reloadKey])

  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  const voterById = useMemo(() => {
    const map = new Map<string, Voter>()
    for (const v of voters) map.set(v.id, v)
    return map
  }, [voters])

  const allFamilies = useMemo(() => buildFamilies(voters), [voters])

  const inviteeVoterIds = useMemo(() => new Set(invitees.map((i) => i.voter_id)), [invitees])

  const inviteeRows = useMemo(() => {
    return invitees.map((inv) => ({ invitee: inv, voter: voterById.get(inv.voter_id) ?? null }))
  }, [invitees, voterById])

  return {
    loading,
    notFound,
    meeting,
    voters,
    invitees,
    reload,
    voterById,
    allFamilies,
    inviteeVoterIds,
    inviteeRows,
    wardScope,
    allowedWards,
    hasWardRestriction,
  }
}

export function groupFamiliesByPart(families: FamilyGroup[]): Array<{ part: string; families: FamilyGroup[] }> {
  const map = new Map<string, { part: string; families: FamilyGroup[] }>()
  for (const family of families) {
    const part = String(family.headVoter?.part_no ?? '')
    const existing = map.get(part)
    if (existing) existing.families.push(family)
    else map.set(part, { part, families: [family] })
  }
  return Array.from(map.values())
    .sort((a, b) => Number(a.part || 0) - Number(b.part || 0))
    .map((g) => ({
      ...g,
      families: [...g.families].sort((a, b) => (a.headVoter?.name ?? '').localeCompare(b.headVoter?.name ?? '')),
    }))
}

export function notInvitedEligibleMembers(family: FamilyGroup, inviteeVoterIds: Set<string>): Voter[] {
  return family.members.filter((m) => !inviteeVoterIds.has(m.id))
}

export function partPathParam(part: string): string {
  return part === '' ? 'unassigned' : encodeURIComponent(part)
}

export function decodePartPathParam(partNo: string | undefined): string {
  if (partNo == null) return ''
  return partNo === 'unassigned' ? '' : decodeURIComponent(partNo)
}
