import type { D1Database } from '@cloudflare/workers-types'
import { wardFilter, type AuthedVars } from '../middleware/auth'
import { activeVoterSql } from './voter-active'

export type Profile = AuthedVars['profile']
export type VoterRow = Record<string, unknown> & { id: string; epic_no: string; name: string }

const D1_CHUNK = 80

export interface LandlordRow {
  id: string
  voter_id: string | null
  display_name: string
  house_no: string | null
  contact: string | null
  ward_no: number | null
  part_no: number | null
  section: number | null
  notes: string | null
  created_at: string
  created_by: string | null
  updated_at: string
  tenant_count?: number
}

export interface LandlordWithVoter extends LandlordRow {
  voter: VoterRow | null
}

export interface TenantCounts {
  landlords: number
  tenants: number
  unlinked: number
  onRoll: number
  offRoll: number
}

export function canWrite(profile: Profile): boolean {
  return profile.role === 'admin' || profile.role === 'sub-admin' || profile.can_edit
}

export function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`
}

export function numericParam(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function normalizeEpic(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

export function landlordWardClause(profile: Profile): { clause: string; params: unknown[] } {
  const { clause, params } = wardFilter(profile)
  if (clause === '1=1') return { clause: '1=1', params: [] }

  const voterClause = clause.replaceAll('ward_no', 'v.ward_no')
  const landlordClause = clause.replaceAll('ward_no', 'l.ward_no')
  return {
    clause: `(l.voter_id IS NULL OR ${voterClause}) AND (l.voter_id IS NOT NULL OR l.ward_no IS NULL OR ${landlordClause})`,
    params: [...params, ...params],
  }
}

export function tenantWardClause(profile: Profile, alias: string): { clause: string; params: unknown[] } {
  const { clause, params } = wardFilter(profile)
  return { clause: clause.replaceAll('ward_no', `${alias}.ward_no`), params }
}

export async function loadVotersByIds(db: D1Database, ids: string[]): Promise<Map<string, VoterRow>> {
  const unique = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)))
  const map = new Map<string, VoterRow>()
  for (let i = 0; i < unique.length; i += D1_CHUNK) {
    const chunk = unique.slice(i, i + D1_CHUNK)
    const { results } = await db
      .prepare(`SELECT * FROM voters WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<VoterRow>()
    for (const row of results ?? []) map.set(row.id, row)
  }
  return map
}

export async function loadVotersByEpics(db: D1Database, epics: string[]): Promise<Map<string, VoterRow>> {
  const unique = Array.from(new Set(epics.map((epic) => epic.trim()).filter(Boolean)))
  const map = new Map<string, VoterRow>()
  for (let i = 0; i < unique.length; i += D1_CHUNK) {
    const chunk = unique.slice(i, i + D1_CHUNK)
    const { results } = await db
      .prepare(`SELECT * FROM voters WHERE epic_no IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<VoterRow>()
    for (const row of results ?? []) map.set(row.epic_no, row)
  }
  return map
}

export async function attachVoters(db: D1Database, landlords: LandlordRow[]): Promise<LandlordWithVoter[]> {
  const voters = await loadVotersByIds(
    db,
    landlords.map((landlord) => landlord.voter_id).filter((id): id is string => Boolean(id)),
  )
  return landlords.map((landlord) => ({
    ...landlord,
    voter: landlord.voter_id ? voters.get(landlord.voter_id) ?? null : null,
  }))
}

export async function loadLandlordsByIds(db: D1Database, ids: string[]): Promise<Map<string, LandlordWithVoter>> {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  const map = new Map<string, LandlordWithVoter>()
  for (let i = 0; i < unique.length; i += D1_CHUNK) {
    const chunk = unique.slice(i, i + D1_CHUNK)
    const { results } = await db
      .prepare(`SELECT * FROM landlords WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<LandlordRow>()
    const withVoters = await attachVoters(db, results ?? [])
    for (const row of withVoters) map.set(row.id, row)
  }
  return map
}

export async function loadScopedLandlord(
  db: D1Database,
  profile: Profile,
  id: string,
): Promise<LandlordWithVoter | null> {
  const { clause, params } = landlordWardClause(profile)
  const row = await db
    .prepare(`
      SELECT l.* FROM landlords l
      LEFT JOIN voters v ON v.id = l.voter_id
      WHERE l.id = ? AND ${clause}
    `)
    .bind(id, ...params)
    .first<LandlordRow>()
  if (!row) return null
  const [withVoter] = await attachVoters(db, [row])
  return withVoter ?? null
}

export async function loadTenantCounts(db: D1Database, profile: Profile): Promise<TenantCounts> {
  const landlordWard = landlordWardClause(profile)
  const tenantWard = tenantWardClause(profile, 'te')

  const landlordRow = await db
    .prepare(`
      SELECT
        COUNT(*) AS landlords,
        COALESCE(SUM(CASE WHEN l.voter_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS on_roll,
        COALESCE(SUM(CASE WHEN l.voter_id IS NULL THEN 1 ELSE 0 END), 0) AS off_roll
      FROM landlords l
      LEFT JOIN voters v ON v.id = l.voter_id
      WHERE ${landlordWard.clause}
    `)
    .bind(...landlordWard.params)
    .first<{ landlords: number; on_roll: number; off_roll: number }>()

  const tenantRow = await db
    .prepare(`
      SELECT COUNT(*) AS tenants
      FROM tenant_links t
      JOIN landlords l ON l.id = t.landlord_id
      LEFT JOIN voters v ON v.id = l.voter_id
      JOIN voters te ON te.epic_no = t.tenant_epic
      WHERE ${activeVoterSql('te')}
        AND ${tenantWard.clause}
        AND ${landlordWard.clause}
    `)
    .bind(...tenantWard.params, ...landlordWard.params)
    .first<{ tenants: number }>()

  const voterWard = tenantWardClause(profile, 'v')
  const unlinkedRow = await db
    .prepare(`
      SELECT COUNT(*) AS c FROM voters v
      WHERE ${activeVoterSql('v')}
        AND ${voterWard.clause}
        AND NOT EXISTS (SELECT 1 FROM tenant_links t WHERE t.tenant_epic = v.epic_no)
    `)
    .bind(...voterWard.params)
    .first<{ c: number }>()

  return {
    landlords: Number(landlordRow?.landlords ?? 0),
    tenants: Number(tenantRow?.tenants ?? 0),
    unlinked: Number(unlinkedRow?.c ?? 0),
    onRoll: Number(landlordRow?.on_roll ?? 0),
    offRoll: Number(landlordRow?.off_roll ?? 0),
  }
}

export interface VoterCandidateOptions {
  excludeEpic?: string
  excludeVoterId?: string | null
  excludeTenants: boolean
  excludeLandlords: boolean
  q: string
  ward: number | null
  part: number | null
  section: number | null
  house: string
  limit: number
}

export async function queryVoterCandidates(
  db: D1Database,
  profile: Profile,
  options: VoterCandidateOptions,
): Promise<VoterRow[]> {
  const ward = tenantWardClause(profile, 'v')
  const conditions = [activeVoterSql('v'), ward.clause]
  const params: unknown[] = [...ward.params]

  if (options.excludeEpic) {
    conditions.push('v.epic_no <> ?')
    params.push(options.excludeEpic)
  }
  if (options.excludeVoterId) {
    conditions.push('v.id <> ?')
    params.push(options.excludeVoterId)
  }
  if (options.excludeTenants) {
    conditions.push('NOT EXISTS (SELECT 1 FROM tenant_links t WHERE t.tenant_epic = v.epic_no)')
  }
  if (options.excludeLandlords) {
    conditions.push('NOT EXISTS (SELECT 1 FROM landlords l WHERE l.voter_id = v.id)')
  }
  if (options.ward != null) {
    conditions.push('v.ward_no = ?')
    params.push(options.ward)
  }
  if (options.part != null) {
    conditions.push('v.part_no = ?')
    params.push(options.part)
  }
  if (options.section != null) {
    conditions.push('v.section = ?')
    params.push(options.section)
  }
  if (options.house) {
    conditions.push('v.house_no = ?')
    params.push(options.house)
  }
  for (const token of options.q.split(/\s+/).filter(Boolean)) {
    const like = likePattern(token)
    conditions.push('(v.name LIKE ? OR v.epic_no LIKE ? OR v.house_no LIKE ? OR v.relative_name LIKE ? OR v.contact_no_1 LIKE ?)')
    params.push(like, like, like, like, like)
  }

  const { results } = await db
    .prepare(`
      SELECT v.* FROM voters v
      WHERE ${conditions.join(' AND ')}
      ORDER BY v.name COLLATE NOCASE ASC
      LIMIT ?
    `)
    .bind(...params, options.limit)
    .all<VoterRow>()
  return results ?? []
}
