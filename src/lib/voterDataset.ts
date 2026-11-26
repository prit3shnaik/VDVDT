import { supabase } from './supabase'
import type { Voter } from './types'
import { buildWardScope } from './voterCache'
import { idbDelete, idbGet, idbSet } from './idbCache'
import { withNormalizedVoterCategories } from './voterCategory'

/**
 * Shared loader for "the whole voter roll".
 *
 * Several pages need the full roll client-side. Naively each visit re-paginated all
 * ~16k rows, which was the single largest driver of D1 row reads, Worker invocations
 * and page latency.
 *
 * Two things make that cheap:
 *  1. A server-side change stamp (one row read). If it matches what the cached copy
 *     was built from, the cached rows are returned and zero voter rows are read.
 *  2. The cache lives in IndexedDB, not localStorage — the roll is several MB and
 *     silently exceeded the localStorage quota, so nothing was ever actually cached.
 */

const CACHE_KEY = 'voters:rows'
const STAMP_KEY = 'voters:stamp'
const CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 12
const BATCH_SIZE = 2000

export interface DatasetStamp {
  version: number
  rowCount: number
  updatedAt: string | null
}

interface CachedRoll {
  scope: string
  savedAt: number
  stamp: DatasetStamp | null
  rows: Voter[]
}

export async function fetchVoterStamp(): Promise<DatasetStamp | null> {
  try {
    const res = await fetch('/api/voters/version', { credentials: 'include' })
    if (!res.ok) return null
    return (await res.json()) as DatasetStamp
  } catch {
    return null
  }
}

function sameStamp(a: DatasetStamp | null, b: DatasetStamp | null): boolean {
  return Boolean(a && b && a.version === b.version && a.rowCount === b.rowCount)
}

export interface LoadVotersOptions {
  role?: string | null
  allowedWards?: number[] | null
  /** Called with cached/first rows so the UI can paint before the full roll arrives. */
  onFirstBatch?: (rows: Voter[]) => void
  /** Skip the cache and force a full refetch. */
  force?: boolean
}

export async function loadAllVoters(options: LoadVotersOptions = {}): Promise<Voter[]> {
  const scope = buildWardScope(options.role, options.allowedWards)

  const cached = options.force ? null : await idbGet<CachedRoll>(CACHE_KEY)
  const usable =
    cached && cached.scope === scope && Date.now() - cached.savedAt < CACHE_MAX_AGE_MS ? cached : null

  if (usable?.rows.length) options.onFirstBatch?.(withNormalizedVoterCategories(usable.rows))

  const stamp = await fetchVoterStamp()

  // Nothing changed server-side: reuse the cached roll and read zero voter rows.
  if (usable?.rows.length && sameStamp(stamp, usable.stamp)) {
    return withNormalizedVoterCategories(usable.rows)
  }

  const rows: Voter[] = []
  let offset = 0
  let painted = Boolean(usable?.rows.length)

  for (;;) {
    const { data, error } = await supabase
      .from('voters')
      .select('*')
      .order('updated_at', { ascending: false })
      .range(offset, offset + BATCH_SIZE - 1)

    if (error) throw new Error(error.message)

    const batch = (data as Voter[] | null) ?? []
    rows.push(...batch)

    if (!painted && batch.length) {
      options.onFirstBatch?.([...rows])
      painted = true
    }

    if (batch.length < BATCH_SIZE) break
    offset += BATCH_SIZE
  }

  const normalizedRows = withNormalizedVoterCategories(rows)
  await idbSet(CACHE_KEY, { scope, savedAt: Date.now(), stamp, rows: normalizedRows } satisfies CachedRoll)
  await idbSet(STAMP_KEY, stamp)

  return normalizedRows
}

/** Call after any voter write so the next load refetches instead of trusting the cache. */
export async function invalidateVoterCache(): Promise<void> {
  await idbDelete(CACHE_KEY)
  await idbDelete(STAMP_KEY)
}
