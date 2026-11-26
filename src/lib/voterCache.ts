import type { Voter } from './types'

const CACHE_VERSION = 1
export const DEFAULT_CACHE_MAX_AGE_MS = 1000 * 60 * 15
export const FAST_NAV_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 6

interface CachePayload<T> {
  version: number
  savedAt: number
  scope: string
  rows: T[]
}

export function buildWardScope(role: string | null | undefined, allowedWards: number[] | null | undefined): string {
  const normalizedRole = (role ?? 'user').trim().toLowerCase()
  const wards = Array.from(new Set((allowedWards ?? []).filter((ward) => Number.isFinite(ward)))).sort((a, b) => a - b)
  const wardLabel = wards.length ? wards.join(',') : 'all'
  return `${normalizedRole}|${wardLabel}`
}

export function readCachedCollection<T>(cacheKey: string, scope: string, maxAgeMs = DEFAULT_CACHE_MAX_AGE_MS): T[] | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(cacheKey)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as CachePayload<T>
    if (!parsed || parsed.version !== CACHE_VERSION || parsed.scope !== scope || !Array.isArray(parsed.rows) || typeof parsed.savedAt !== 'number') {
      return null
    }

    if (Date.now() - parsed.savedAt > maxAgeMs) {
      return null
    }

    return parsed.rows
  } catch {
    return null
  }
}

export function writeCachedCollection<T>(cacheKey: string, scope: string, rows: T[]): void {
  if (typeof window === 'undefined') {
    return
  }

  const payload: CachePayload<T> = {
    version: CACHE_VERSION,
    savedAt: Date.now(),
    scope,
    rows,
  }

  try {
    window.localStorage.setItem(cacheKey, JSON.stringify(payload))
  } catch {
    // Ignore storage quota and private mode failures.
  }
}

export function readCachedVoters(cacheKey: string, wardScope: string, maxAgeMs = DEFAULT_CACHE_MAX_AGE_MS): Voter[] | null {
  return readCachedCollection<Voter>(cacheKey, wardScope, maxAgeMs)
}

export function writeCachedVoters(cacheKey: string, wardScope: string, rows: Voter[]): void {
  writeCachedCollection<Voter>(cacheKey, wardScope, rows)
}

export function clearCachedCollection(cacheKey: string): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.removeItem(cacheKey)
  } catch {
    // Ignore storage failures.
  }
}
