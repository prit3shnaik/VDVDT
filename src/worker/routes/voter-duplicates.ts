import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireWorkspace, wardFilter, type AuthedVars } from '../middleware/auth'
import { ensureVotersSchema } from '../lib/schema-ensure'
import { groupDuplicateVoters, parseDuplicateMode } from '../lib/voter-duplicates'

export const voterDuplicates = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

const MAX_SCAN = 20000
const MAX_GROUPS = 500

function optionalNumber(value: string | null): number | null {
  if (value == null || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function likeValue(value: string): string {
  return `%${value.replace(/[%_]/g, '')}%`
}

function searchText(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function matchesQuery(row: Record<string, unknown>, tokens: string[]): boolean {
  const haystack = [
    row.name,
    row.epic_no,
    row.house_no,
    row.relative_name,
    row.contact_no_1,
    row.contact_no_2,
  ].map(searchText).join(' ')
  return tokens.every((token) => haystack.includes(token))
}

voterDuplicates.get('/api/voters/duplicates', requireUser, requireWorkspace, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  const url = new URL(c.req.url)

  const mode = parseDuplicateMode(url.searchParams.get('mode'))
  const q = (url.searchParams.get('q') ?? '').trim()
  const status = (url.searchParams.get('status') ?? 'all').toLowerCase()
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 200) || 200, 1), MAX_GROUPS)

  const { clause: wardClause, params: wardParams } = wardFilter(profile)
  const conditions = [wardClause]
  const params: unknown[] = [...wardParams]

  const wardNo = optionalNumber(url.searchParams.get('ward_no'))
  if (wardNo != null) {
    conditions.push('ward_no = ?')
    params.push(wardNo)
  }

  const partNo = optionalNumber(url.searchParams.get('part_no'))
  if (partNo != null) {
    conditions.push('part_no = ?')
    params.push(partNo)
  }

  const section = optionalNumber(url.searchParams.get('section'))
  if (section != null) {
    conditions.push('section = ?')
    params.push(section)
  }

  const houseNo = (url.searchParams.get('house_no') ?? '').trim()
  if (houseNo) {
    conditions.push('house_no LIKE ?')
    params.push(likeValue(houseNo))
  }

  if (status === 'active') conditions.push('COALESCE(is_active, 1) = 1')
  else if (status === 'disabled') conditions.push('COALESCE(is_active, 1) = 0')

  const sql = `SELECT * FROM voters WHERE ${conditions.join(' AND ')} ORDER BY name COLLATE NOCASE ASC, epic_no ASC LIMIT ?`
  const { results } = await c.env.DB.prepare(sql).bind(...params, MAX_SCAN).all()
  const rows = (results ?? []) as Array<Record<string, unknown>>
  const grouped = groupDuplicateVoters(rows, mode, Number.MAX_SAFE_INTEGER)

  // Search after grouping so an EPIC/name search still returns the whole group.
  const tokens = q.split(/\s+/).map(searchText).filter(Boolean)
  const groups = tokens.length
    ? grouped.groups.filter((group) => group.voters.some((voter) => matchesQuery(voter, tokens)))
    : grouped.groups
  const totalGroups = groups.length
  const totalVoters = groups.reduce((sum, group) => sum + group.voters.length, 0)
  const limited = groups.slice(0, limit)

  return c.json({
    groups: limited,
    totalGroups,
    totalVoters,
    truncated: totalGroups > limited.length,
    mode,
    scanned: rows.length,
    scanLimited: rows.length >= MAX_SCAN,
  })
})
