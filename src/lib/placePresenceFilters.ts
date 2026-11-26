import type { PresenceStatus } from './types'
import { PRESENCE_OPTIONS } from './presence'
import { UNLABELLED_PLACE_ID, type PlaceScope } from './placeClubs'

export type PresenceFilter = 'all' | PresenceStatus | 'blank'
export type NotesFilter = 'all' | 'yes'
export type LeaderFilter = 'all' | 'unassigned' | string
export type SizeFilter = 'all' | 'singles' | 'multi'

export const PAGE_SIZE = 50

export const PRESENCE_FILTER_CHIPS: Array<{ value: PresenceFilter; label: string }> = [
  { value: 'all', label: 'All' },
  ...PRESENCE_OPTIONS.map((option) => ({ value: option.value as PresenceFilter, label: option.label })),
  { value: 'blank', label: 'Blank' },
]

export const PLACE_SCOPE_CHIPS: Array<{ value: PlaceScope; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'local', label: 'Local' },
  { value: 'outside', label: 'Outside' },
]

export function parsePresenceFilter(value: string | null, fallback: PresenceFilter = 'all'): PresenceFilter {
  if (value === 'all' || value === 'blank' || value === 'IN_MORMUGAO' || value === 'OUTSIDE_MORMUGAO' || value === 'ABROAD') {
    return value
  }
  return fallback
}

export function parsePlaceScope(value: string | null, fallback: PlaceScope = 'all'): PlaceScope {
  if (value === 'local' || value === 'outside' || value === 'all') return value
  return fallback
}

export function parseNotesFilter(value: string | null, fallback: NotesFilter = 'all'): NotesFilter {
  if (value === 'yes' || value === 'all') return value
  return fallback
}

export function parsePlaceFilter(value: string | null, fallback = 'all'): string {
  return value && value.trim() ? value : fallback
}

export function parseLeaderFilter(value: string | null, fallback: LeaderFilter = 'all'): LeaderFilter {
  return (value && value.trim() ? value : fallback) as LeaderFilter
}

export function parseSizeFilter(value: string | null, fallback: SizeFilter = 'all'): SizeFilter {
  if (value === 'singles' || value === 'multi' || value === 'all') return value
  return fallback
}

export function parsePage(value: string | null, fallback = 1): number {
  const next = Number(value)
  return Number.isInteger(next) && next > 0 ? next : fallback
}

export function setOrDeleteParam(params: URLSearchParams, key: string, value: string, blank = ''): void {
  if (!value || value === blank) params.delete(key)
  else params.set(key, value)
}

export function matchesPresence(status: PresenceStatus | null | undefined, filter: PresenceFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'blank') return !status
  return status === filter
}

export function matchesPlace(placeClubId: string | null | undefined, filter: string): boolean {
  if (!filter || filter === 'all') return true
  if (filter === 'unlabelled' || filter === UNLABELLED_PLACE_ID) return !placeClubId
  return placeClubId === filter
}

export function matchesPart(part: number | null | undefined, filter: string): boolean {
  if (!filter) return true
  if (filter === 'blank') return part == null
  return String(part ?? '') === filter
}

export function matchesLeader(leaderId: string | null | undefined, filter: LeaderFilter, specialIds?: Set<string>): boolean {
  if (!filter || filter === 'all') return true
  const realId = leaderId && specialIds?.has(leaderId) ? null : leaderId
  if (filter === 'unassigned') return !realId
  return realId === filter
}

export function matchesSearch(haystack: string, query: string): boolean {
  const token = query.trim().toLowerCase()
  if (!token) return true
  return haystack.toLowerCase().includes(token)
}

export function matchesSize(memberCount: number, filter: SizeFilter): boolean {
  if (!filter || filter === 'all') return true
  if (filter === 'singles') return memberCount === 1
  return memberCount > 1
}
