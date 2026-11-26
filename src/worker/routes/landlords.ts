import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, wardFilter, type AuthedVars } from '../middleware/auth'
import { logActivity } from './activity-logs'
import { ensureVotersSchema } from '../lib/schema-ensure'
import {
  attachVoters,
  canWrite,
  landlordWardClause,
  likePattern,
  loadScopedLandlord,
  loadTenantCounts,
  normalizeEpic,
  numericParam,
  optionalNumber,
  optionalText,
  queryVoterCandidates,
  tenantWardClause,
  type LandlordRow,
  type Profile,
  type VoterRow,
} from '../lib/tenant-landlords'

export const landlords = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

async function tenantLinkForEpic(db: Env['DB'], epic: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM tenant_links WHERE tenant_epic = ?').bind(epic).first()
  return Boolean(row)
}

async function landlordForVoterId(db: Env['DB'], voterId: string, excludeId?: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM landlords WHERE voter_id = ? AND (? IS NULL OR id <> ?)')
    .bind(voterId, excludeId ?? null, excludeId ?? null)
    .first()
  return Boolean(row)
}

async function loadVoterForProfile(db: Env['DB'], profile: Profile, voterId: string): Promise<VoterRow | null> {
  const { clause, params } = wardFilter(profile)
  return db
    .prepare(`SELECT * FROM voters WHERE id = ? AND COALESCE(is_active, 1) = 1 AND ${clause}`)
    .bind(voterId, ...params)
    .first<VoterRow>()
}

function validateOffRollWard(profile: Profile, wardNo: number | null): string | null {
  if (wardFilter(profile).clause === '1=1') return null
  if (wardNo == null) return 'Ward is required for an off-roll landlord.'
  if (!profile.allowed_wards.includes(wardNo)) return 'Ward is not in your allowed wards.'
  return null
}

landlords.get('/api/landlords', requireUser, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  const url = new URL(c.req.url)
  const q = (url.searchParams.get('q') ?? '').trim()
  const ward = numericParam(url.searchParams.get('ward_no'))
  const part = numericParam(url.searchParams.get('part_no'))
  const section = numericParam(url.searchParams.get('section'))
  const house = (url.searchParams.get('house_no') ?? '').trim()
  const kind = (url.searchParams.get('kind') ?? 'all').toLowerCase()
  const hasTenants = (url.searchParams.get('has_tenants') ?? 'all').toLowerCase()
  const candidateForTenant = normalizeEpic(url.searchParams.get('candidate_for_tenant'))
  const excludeId = (url.searchParams.get('exclude_id') ?? '').trim()
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 500) || 500, 500)

  const landlordWard = landlordWardClause(profile)
  const tenantWard = tenantWardClause(profile, 'te')
  const conditions = [landlordWard.clause]
  const params: unknown[] = [...tenantWard.params, ...landlordWard.params]

  if (kind === 'on_roll') conditions.push('l.voter_id IS NOT NULL')
  else if (kind === 'off_roll') conditions.push('l.voter_id IS NULL')

  if (hasTenants === 'with') conditions.push('COALESCE(tc.tenant_count, 0) > 0')
  else if (hasTenants === 'without') conditions.push('COALESCE(tc.tenant_count, 0) = 0')

  if (excludeId) {
    conditions.push('l.id <> ?')
    params.push(excludeId)
  }

  if (candidateForTenant) {
    const voter = await c.env.DB
      .prepare('SELECT id FROM voters WHERE epic_no = ?')
      .bind(candidateForTenant)
      .first<{ id: string }>()
    if (voter) {
      conditions.push('(l.voter_id IS NULL OR l.voter_id <> ?)')
      params.push(voter.id)
    }
  }

  if (ward != null) {
    conditions.push('COALESCE(v.ward_no, l.ward_no) = ?')
    params.push(ward)
  }
  if (part != null) {
    conditions.push('COALESCE(v.part_no, l.part_no) = ?')
    params.push(part)
  }
  if (section != null) {
    conditions.push('COALESCE(v.section, l.section) = ?')
    params.push(section)
  }
  if (house) {
    conditions.push('COALESCE(v.house_no, l.house_no) = ?')
    params.push(house)
  }
  for (const token of q.split(/\s+/).filter(Boolean)) {
    const like = likePattern(token)
    conditions.push('(l.display_name LIKE ? OR l.house_no LIKE ? OR l.contact LIKE ? OR v.name LIKE ? OR v.epic_no LIKE ? OR v.house_no LIKE ?)')
    params.push(like, like, like, like, like, like)
  }

  const { results } = await c.env.DB
    .prepare(`
      SELECT l.*, COALESCE(tc.tenant_count, 0) AS tenant_count
      FROM landlords l
      LEFT JOIN voters v ON v.id = l.voter_id
      LEFT JOIN (
        SELECT t.landlord_id, COUNT(*) AS tenant_count
        FROM tenant_links t
        JOIN voters te ON te.epic_no = t.tenant_epic
        WHERE COALESCE(te.is_active, 1) = 1 AND ${tenantWard.clause}
        GROUP BY t.landlord_id
      ) tc ON tc.landlord_id = l.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY l.display_name COLLATE NOCASE ASC
      LIMIT ?
    `)
    .bind(...params, limit)
    .all<LandlordRow>()

  const rows = await attachVoters(c.env.DB, results ?? [])
  const counts = candidateForTenant || excludeId
    ? { landlords: 0, tenants: 0, unlinked: 0, onRoll: 0, offRoll: 0 }
    : await loadTenantCounts(c.env.DB, profile)

  return c.json({ landlords: rows, counts })
})

landlords.get('/api/landlords/voter-candidates', requireUser, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  const url = new URL(c.req.url)
  const q = (url.searchParams.get('q') ?? '').trim()
  const voters = await queryVoterCandidates(c.env.DB, profile, {
    excludeTenants: true,
    excludeLandlords: true,
    q,
    ward: numericParam(url.searchParams.get('ward_no')),
    part: numericParam(url.searchParams.get('part_no')),
    section: numericParam(url.searchParams.get('section')),
    house: (url.searchParams.get('house_no') ?? '').trim(),
    limit: 20,
  })
  return c.json({ voters })
})

landlords.post('/api/landlords', requireUser, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const displayName = optionalText(body.display_name)
  if (!displayName) return c.json({ error: 'Landlord name is required.' }, 400)

  const voterId = optionalText(body.voter_id)
  let voter: VoterRow | null = null
  if (voterId) {
    voter = await loadVoterForProfile(c.env.DB, profile, voterId)
    if (!voter) return c.json({ error: 'Voter not found in your wards.' }, 400)
    if (await tenantLinkForEpic(c.env.DB, voter.epic_no)) {
      return c.json({ error: 'This voter is already a tenant. A voter cannot be both landlord and tenant.' }, 409)
    }
    if (await landlordForVoterId(c.env.DB, voter.id)) {
      return c.json({ error: 'This voter is already a landlord.' }, 409)
    }
  } else {
    const wardError = validateOffRollWard(profile, optionalNumber(body.ward_no))
    if (wardError) return c.json({ error: wardError }, 400)
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const houseNo = optionalText(body.house_no) ?? (voter ? (voter.house_no as string | null) : null)
  const contact = optionalText(body.contact) ?? (voter ? (voter.contact_no_1 as string | null) : null)
  const wardNo = voter ? (voter.ward_no as number | null) : optionalNumber(body.ward_no)
  const partNo = voter ? (voter.part_no as number | null) : optionalNumber(body.part_no)
  const section = voter ? (voter.section as number | null) : optionalNumber(body.section)

  try {
    await c.env.DB
      .prepare(`
        INSERT INTO landlords (id, voter_id, display_name, house_no, contact, ward_no, part_no, section, notes, created_at, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        voter?.id ?? null,
        displayName,
        houseNo,
        contact,
        wardNo,
        partNo,
        section,
        optionalText(body.notes),
        now,
        profile.id,
        now,
      )
      .run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/unique/i.test(message)) return c.json({ error: 'This voter is already a landlord.' }, 409)
    throw err
  }

  await logActivity(c.env, profile.id, 'landlord_add', 'landlords', id, {
    voter_id: voter?.id ?? null,
    display_name: displayName,
  })

  const landlord = await loadScopedLandlord(c.env.DB, profile, id)
  return c.json({ landlord }, 201)
})

landlords.patch('/api/landlords/:id', requireUser, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const id = c.req.param('id') ?? ''
  const landlord = await loadScopedLandlord(c.env.DB, profile, id)
  if (!landlord) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const updates: string[] = []
  const values: unknown[] = []
  let claimed = false
  let nextVoterId = landlord.voter_id
  let nextWard = landlord.ward_no

  if ('display_name' in body) {
    const displayName = optionalText(body.display_name)
    if (!displayName) return c.json({ error: 'Landlord name is required.' }, 400)
    updates.push('display_name = ?')
    values.push(displayName)
  }
  if ('house_no' in body) {
    updates.push('house_no = ?')
    values.push(optionalText(body.house_no))
  }
  if ('contact' in body) {
    updates.push('contact = ?')
    values.push(optionalText(body.contact))
  }
  if ('notes' in body) {
    updates.push('notes = ?')
    values.push(optionalText(body.notes))
  }
  if ('ward_no' in body) {
    nextWard = optionalNumber(body.ward_no)
    updates.push('ward_no = ?')
    values.push(nextWard)
  }
  if ('part_no' in body) {
    updates.push('part_no = ?')
    values.push(optionalNumber(body.part_no))
  }
  if ('section' in body) {
    updates.push('section = ?')
    values.push(optionalNumber(body.section))
  }

  if ('voter_id' in body) {
    const requested = optionalText(body.voter_id)
    if (requested && requested !== landlord.voter_id) {
      if (landlord.voter_id) {
        return c.json({ error: 'This landlord is already linked to a voter.' }, 409)
      }
      const voter = await loadVoterForProfile(c.env.DB, profile, requested)
      if (!voter) return c.json({ error: 'Voter not found in your wards.' }, 400)
      if (await tenantLinkForEpic(c.env.DB, voter.epic_no)) {
        return c.json({ error: 'This voter is already a tenant. A voter cannot be both landlord and tenant.' }, 409)
      }
      if (await landlordForVoterId(c.env.DB, voter.id, id)) {
        return c.json({ error: 'This voter is already a landlord.' }, 409)
      }
      const sameTenant = await c.env.DB
        .prepare('SELECT 1 FROM tenant_links WHERE landlord_id = ? AND tenant_epic = ?')
        .bind(id, voter.epic_no)
        .first()
      if (sameTenant) {
        return c.json({ error: 'A landlord cannot also be one of their tenants.' }, 400)
      }
      updates.push('voter_id = ?')
      values.push(voter.id)
      nextVoterId = voter.id
      claimed = true
    } else if (!requested && landlord.voter_id) {
      updates.push('voter_id = ?')
      values.push(null)
      nextVoterId = null
    }
  }

  if (!nextVoterId) {
    const wardError = validateOffRollWard(profile, nextWard)
    if (wardError) return c.json({ error: wardError }, 400)
  }

  if (!updates.length) return c.json({ error: 'No fields to update.' }, 400)

  updates.push('updated_at = ?')
  values.push(new Date().toISOString())

  try {
    await c.env.DB.prepare(`UPDATE landlords SET ${updates.join(', ')} WHERE id = ?`).bind(...values, id).run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/unique/i.test(message)) return c.json({ error: 'This voter is already a landlord.' }, 409)
    throw err
  }

  await logActivity(c.env, profile.id, claimed ? 'landlord_claim' : 'landlord_update', 'landlords', id, {
    voter_id: nextVoterId,
  })

  const updated = await loadScopedLandlord(c.env.DB, profile, id)
  return c.json({ landlord: updated })
})

landlords.delete('/api/landlords/:id', requireUser, async (c) => {
  await ensureVotersSchema(c.env.DB)
  const profile = c.get('profile')
  if (!canWrite(profile)) return c.json({ error: 'Forbidden' }, 403)

  const id = c.req.param('id') ?? ''
  const landlord = await loadScopedLandlord(c.env.DB, profile, id)
  if (!landlord) return c.json({ error: 'Not found' }, 404)

  const countRow = await c.env.DB
    .prepare('SELECT COUNT(*) AS c FROM tenant_links WHERE landlord_id = ?')
    .bind(id)
    .first<{ c: number }>()
  if (Number(countRow?.c ?? 0) > 0) {
    return c.json({ error: 'Remove or move this landlord\'s tenants before deleting it.' }, 409)
  }

  await c.env.DB.prepare('DELETE FROM landlords WHERE id = ?').bind(id).run()
  await logActivity(c.env, profile.id, 'landlord_remove', 'landlords', id, {
    voter_id: landlord.voter_id,
    display_name: landlord.display_name,
  })
  return c.body(null, 204)
})
