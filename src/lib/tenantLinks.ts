import { fetchApiJson } from './d1Query'
import type {
  Landlord,
  LandlordGroup,
  TenantCounts,
  TenantLink,
  TenantLinkRow,
  TenantVoter,
  Voter,
} from './types'

export type { TenantCounts } from './types'
export type TenantScope = 'with' | 'without' | 'unlinked'
export type LandlordKind = 'all' | 'on_roll' | 'off_roll'

export interface TenantListResponse {
  links: TenantLinkRow[]
  voters: Voter[]
  counts: TenantCounts
}

export interface LandlordListResponse {
  landlords: Landlord[]
  counts: TenantCounts
}

export interface TenantFilterParams {
  q?: string
  ward_no?: string | number | null
  part_no?: string | number | null
  section?: string | number | null
  house_no?: string | null
  landlord_id?: string | null
  kind?: LandlordKind
  has_tenants?: 'all' | 'with' | 'without'
  unlinked?: boolean
  assignable_to?: string | null
  limit?: number
}

export interface LandlordFilterParams {
  q?: string
  ward_no?: string | number | null
  part_no?: string | number | null
  section?: string | number | null
  house_no?: string | null
  kind?: LandlordKind
  has_tenants?: 'all' | 'with' | 'without'
  candidate_for_tenant?: string | null
  exclude_id?: string | null
  limit?: number
}

export interface LandlordInput {
  display_name: string
  voter_id?: string | null
  house_no?: string | null
  contact?: string | null
  ward_no?: number | null
  part_no?: number | null
  section?: number | null
  notes?: string | null
}

const EMPTY_COUNTS: TenantCounts = { landlords: 0, tenants: 0, unlinked: 0, onRoll: 0, offRoll: 0 }

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

export async function fetchTenantList(params: TenantFilterParams = {}): Promise<TenantListResponse> {
  const body = await fetchApiJson<Partial<TenantListResponse>>(`/api/tenants${buildQuery(params)}`)
  return {
    links: body.links ?? [],
    voters: body.voters ?? [],
    counts: body.counts ?? EMPTY_COUNTS,
  }
}

export async function fetchLandlords(params: LandlordFilterParams = {}): Promise<LandlordListResponse> {
  const body = await fetchApiJson<Partial<LandlordListResponse>>(`/api/landlords${buildQuery(params)}`)
  return {
    landlords: body.landlords ?? [],
    counts: body.counts ?? EMPTY_COUNTS,
  }
}

export async function searchAssignableVoters(landlordId: string, q: string): Promise<Voter[]> {
  if (!q.trim()) return []
  const body = await fetchApiJson<{ voters?: Voter[] }>(
    `/api/tenants${buildQuery({ assignable_to: landlordId, q, limit: 20 })}`,
  )
  return body.voters ?? []
}

export async function searchVoterCandidates(q: string): Promise<Voter[]> {
  if (!q.trim()) return []
  const body = await fetchApiJson<{ voters?: Voter[] }>(
    `/api/landlords/voter-candidates${buildQuery({ q, limit: 20 })}`,
  )
  return body.voters ?? []
}

export async function searchLandlordCandidates(
  q: string,
  tenantEpic: string,
  excludeId?: string,
): Promise<Landlord[]> {
  if (!q.trim()) return []
  const body = await fetchApiJson<{ landlords?: Landlord[] }>(
    `/api/landlords${buildQuery({
      q,
      candidate_for_tenant: tenantEpic,
      exclude_id: excludeId,
      limit: 20,
    })}`,
  )
  return body.landlords ?? []
}

export async function assignTenant(params: {
  landlordId: string
  tenantEpic: string
  roomNo?: string | null
  notes?: string | null
}): Promise<TenantLink> {
  const body = await fetchApiJson<{ link: TenantLink }>('/api/tenants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      landlord_id: params.landlordId,
      tenant_epic: params.tenantEpic,
      room_no: params.roomNo ?? null,
      notes: params.notes ?? null,
    }),
  })
  return body.link
}

export async function updateTenantLink(
  id: string,
  patch: { landlord_id?: string; room_no?: string | null; notes?: string | null },
): Promise<void> {
  await fetchApiJson(`/api/tenants/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export async function moveTenant(id: string, landlordId: string): Promise<void> {
  await updateTenantLink(id, { landlord_id: landlordId })
}

export async function removeTenantLink(id: string): Promise<void> {
  await fetchApiJson(`/api/tenants/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function createLandlord(input: LandlordInput): Promise<Landlord> {
  const body = await fetchApiJson<{ landlord: Landlord }>('/api/landlords', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return body.landlord
}

export async function updateLandlord(id: string, input: Partial<LandlordInput>): Promise<Landlord> {
  const body = await fetchApiJson<{ landlord: Landlord }>(`/api/landlords/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return body.landlord
}

export async function deleteLandlord(id: string): Promise<void> {
  await fetchApiJson(`/api/landlords/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function landlordHouseNo(landlord: Landlord): string | null {
  const house = landlord.voter?.house_no ?? landlord.house_no
  return (house ?? '').trim() || null
}

export function landlordEpic(landlord: Landlord): string | null {
  return landlord.voter?.epic_no ?? null
}

export function landlordIsOffRoll(landlord: Landlord): boolean {
  return !landlord.voter_id
}

export function landlordWard(landlord: Landlord): number | null {
  return landlord.voter?.ward_no ?? landlord.ward_no
}

export function landlordPart(landlord: Landlord): number | null {
  return landlord.voter?.part_no ?? landlord.part_no
}

export function landlordSection(landlord: Landlord): number | null {
  return landlord.voter?.section ?? landlord.section
}

export function landlordContact(landlord: Landlord): string | null {
  return landlord.contact ?? landlord.voter?.contact_no_1 ?? null
}

export function groupTenantLinks(links: TenantLinkRow[]): LandlordGroup[] {
  const groups = new Map<string, LandlordGroup>()
  for (const link of links) {
    if (!link.landlord || !link.tenant) continue
    const tenant: TenantVoter = {
      ...link.tenant,
      linkId: link.id,
      room_no: link.room_no,
      notes: link.notes,
    }
    const existing = groups.get(link.landlord.id)
    if (existing) {
      existing.tenants.push(tenant)
      continue
    }
    groups.set(link.landlord.id, {
      landlord: link.landlord,
      houseNo: landlordHouseNo(link.landlord),
      tenants: [tenant],
    })
  }

  const list = Array.from(groups.values())
  for (const group of list) {
    group.tenants.sort((a, b) => a.name.localeCompare(b.name))
  }
  return list.sort((a, b) => a.landlord.display_name.localeCompare(b.landlord.display_name))
}

export function tenantGroupHeading(group: Pick<LandlordGroup, 'landlord' | 'houseNo' | 'tenants'>): string {
  const house = group.houseNo ? `House ${group.houseNo}` : 'No house no.'
  const offRoll = landlordIsOffRoll(group.landlord) ? ' · Off-roll' : ''
  const count = group.tenants.length
  return `${group.landlord.display_name}${offRoll} · ${house} · ${count} tenant${count === 1 ? '' : 's'}`
}
