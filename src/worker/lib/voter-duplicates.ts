export const VOTER_DUPLICATE_MODES = ['name_house', 'name_house_relative', 'name_relative', 'name_age_gender', 'name'] as const
export type VoterDuplicateMode = (typeof VOTER_DUPLICATE_MODES)[number]

export interface VoterDuplicateGroupResult {
  key: string
  label: string
  match: VoterDuplicateMode
  voters: Array<Record<string, unknown>>
}

export interface VoterDuplicateGroupingResult {
  groups: VoterDuplicateGroupResult[]
  totalGroups: number
  totalVoters: number
  truncated: boolean
}

export function parseDuplicateMode(value: string | null): VoterDuplicateMode {
  return (VOTER_DUPLICATE_MODES as readonly string[]).includes(value ?? '')
    ? (value as VoterDuplicateMode)
    : 'name_house'
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function normalizeToken(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, '')
}

function keyFor(row: Record<string, unknown>, mode: VoterDuplicateMode): string | null {
  const name = normalizeText(row.name)
  if (!name) return null
  if (mode === 'name') return `name:${name}`

  const house = normalizeToken(row.house_no)
  if (mode === 'name_house') return house ? `name_house:${name}|${house}` : null

  if (mode === 'name_house_relative') {
    const relative = normalizeText(row.relative_name)
    return house && relative ? `name_house_relative:${name}|${house}|${relative}` : null
  }

  if (mode === 'name_relative') {
    const relative = normalizeText(row.relative_name)
    return relative ? `name_relative:${name}|${relative}` : null
  }

  const age = row.age != null ? String(row.age) : ''
  const gender = normalizeToken(row.gender)
  return age && gender ? `name_age_gender:${name}|${age}|${gender}` : null
}

export function groupDuplicateVoters(
  rows: Array<Record<string, unknown>>,
  mode: VoterDuplicateMode,
  limit: number,
): VoterDuplicateGroupingResult {
  const buckets = new Map<string, Array<Record<string, unknown>>>()

  for (const row of rows) {
    const key = keyFor(row, mode)
    if (!key) continue
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }

  const sorted = [...buckets.entries()]
    .filter(([, voters]) => voters.length > 1)
    .sort((a, b) => {
      const bySize = b[1].length - a[1].length
      if (bySize) return bySize
      return String(a[1][0]?.name ?? '').localeCompare(String(b[1][0]?.name ?? ''))
    })

  const totalGroups = sorted.length
  const totalVoters = sorted.reduce((sum, [, voters]) => sum + voters.length, 0)
  const limited = sorted.slice(0, limit)

  const groups = limited.map(([key, voters]) => {
    const ordered = [...voters].sort((a, b) => {
      const byName = String(a.name ?? '').localeCompare(String(b.name ?? ''))
      return byName || String(a.epic_no ?? '').localeCompare(String(b.epic_no ?? ''))
    })
    const first = ordered[0] ?? {}
    const name = String(first.name ?? '').replace(/\s+/g, ' ').trim()
    const house = String(first.house_no ?? '').trim()
    const relative = String(first.relative_name ?? '').replace(/\s+/g, ' ').trim()
    let label = name
    if (mode === 'name_house' || mode === 'name_house_relative') {
      label = `${name} · House ${house || '—'}`
      if (mode === 'name_house_relative') {
        label += ` · ${relative || '—'}`
      }
    } else if (mode === 'name_relative') {
      label = `${name} · ${relative || '—'}`
    } else if (mode === 'name_age_gender') {
      label = `${name} · ${first.age ?? '—'} · ${String(first.gender ?? '—')}`
    }
    return { key, label, match: mode, voters: ordered }
  })

  return { groups, totalGroups, totalVoters, truncated: totalGroups > groups.length }
}
