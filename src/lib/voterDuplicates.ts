import { fetchApiJson } from './d1Query'
import type { VoterDuplicateMode, VoterDuplicateResponse } from './types'

export interface VoterDuplicateParams {
  q?: string
  mode?: VoterDuplicateMode
  ward_no?: string
  part_no?: string
  section?: string
  house_no?: string
  status?: 'all' | 'active' | 'disabled'
  limit?: number
}

export const VOTER_DUPLICATE_MODES: Array<{ value: VoterDuplicateMode; label: string; description: string }> = [
  { value: 'name_house', label: 'Name + house', description: 'Same normalized name and house number.' },
  { value: 'name_house_relative', label: 'Name + house + relative', description: 'Same name, house, and relative name.' },
  { value: 'name_relative', label: 'Name + relative', description: 'Same name and relative name, even if the house number differs.' },
  { value: 'name_age_gender', label: 'Name + age + gender', description: 'Same name, age, and gender.' },
  { value: 'name', label: 'Name only', description: 'Broadest match; review every group carefully.' },
]

export function duplicateModeLabel(mode: VoterDuplicateMode): string {
  return VOTER_DUPLICATE_MODES.find((option) => option.value === mode)?.label ?? mode
}

function buildQuery(params: object): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (typeof value === 'boolean') {
      if (value) search.set(key, '1')
      continue
    }
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

export async function fetchVoterDuplicates(params: VoterDuplicateParams): Promise<VoterDuplicateResponse> {
  return fetchApiJson<VoterDuplicateResponse>(`/api/voters/duplicates${buildQuery(params)}`)
}
