import type { VoterCategory } from './types'

export const VOTER_CATEGORY_OPTIONS: Array<{ value: VoterCategory; label: string }> = [
  { value: 'HOME', label: 'Home' },
  { value: 'OPEN', label: 'Open' },
  { value: 'AWAY', label: 'Away' },
  { value: 'BJP', label: 'BJP' },
  { value: 'CONGRESS', label: 'Congress' },
  { value: 'MN_DISCUSSION', label: 'MN Discussion' },
  { value: 'AWAY_DISCUSSION', label: 'Away Discussion' },
]

const CATEGORY_VALUES = new Set<string>(VOTER_CATEGORY_OPTIONS.map((option) => option.value))

export function normalizeVoterCategory(category: string | null | undefined): VoterCategory | null {
  if (!category) return null
  if (category === 'SIDE') return 'OPEN'
  if (category === 'SHIFT') return null
  return CATEGORY_VALUES.has(category) ? (category as VoterCategory) : null
}

export function withNormalizedVoterCategory<T extends { voter_category?: string | null }>(row: T): T {
  const next = normalizeVoterCategory(row.voter_category)
  if (next === (row.voter_category ?? null)) return row
  return { ...row, voter_category: next }
}

export function withNormalizedVoterCategories<T extends { voter_category?: string | null }>(rows: T[]): T[] {
  return rows.map(withNormalizedVoterCategory)
}

export function voterCategoryLabel(category: VoterCategory | string | null | undefined): string | null {
  const normalized = normalizeVoterCategory(category)
  if (!normalized) return null
  return VOTER_CATEGORY_OPTIONS.find((option) => option.value === normalized)?.label ?? normalized
}

export function migrateRetiredCategoryFilter(filter: string, shiftFallback = 'unassigned'): string {
  if (filter === 'SIDE') return 'OPEN'
  if (filter === 'SHIFT') return shiftFallback
  return filter
}
