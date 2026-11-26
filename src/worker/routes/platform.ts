import { Hono } from 'hono'
import type { Env } from '../env'
import { platformDb } from '../env'
import { requireUser, type AuthedVars } from '../middleware/auth'
import {
  DEFAULT_PRESENCE_OPTIONS,
  DEFAULT_SPECIAL_LEADER_BUCKETS,
  listCategories,
  listPresenceOptions,
  listSpecialLeaderBuckets,
  seedWorkspaceDefaults,
} from '../lib/workspace-config'

export const platform = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

type OrgRole = 'owner' | 'billing_admin' | 'org_admin'
type WorkspaceRole = 'candidate' | 'incharge' | 'operator' | 'booth_agent' | 'field'

const ORG_ADMIN_ROLES: OrgRole[] = ['owner', 'org_admin']
const BILLING_ROLES: OrgRole[] = ['owner', 'billing_admin']

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || crypto.randomUUID().slice(0, 8)
}

async function orgMembership(
  db: ReturnType<typeof platformDb>,
  orgId: string,
  userId: string,
): Promise<OrgRole | null> {
  const row = await db
    .prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?')
    .bind(orgId, userId)
    .first<{ role: OrgRole }>()
  return row?.role ?? null
}

async function assertOrgRole(
  c: { env: Env; get: (key: 'profile') => AuthedVars['profile'] },
  orgId: string,
  allowed: OrgRole[],
): Promise<OrgRole> {
  const profile = c.get('profile')
  if (profile.is_platform_admin) return 'owner'
  const role = await orgMembership(platformDb(c.env), orgId, profile.id)
  if (!role || !allowed.includes(role)) throw new Error('Forbidden')
  return role
}

async function audit(
  db: ReturnType<typeof platformDb>,
  actorUserId: string,
  action: string,
  orgId: string | null,
  workspaceId: string | null,
  details?: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO platform_activity_logs (id, actor_user_id, org_id, workspace_id, action, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      actorUserId,
      orgId,
      workspaceId,
      action,
      details ? JSON.stringify(details) : null,
      new Date().toISOString(),
    )
    .run()
}

async function orgQuota(db: ReturnType<typeof platformDb>, orgId: string) {
  const subscription = await db
    .prepare(
      `SELECT workspace_quota, seat_count, photo_gb_quota, status
       FROM subscriptions WHERE org_id = ? AND status IN ('trialing', 'active', 'past_due')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(orgId)
    .first<{ workspace_quota: number; seat_count: number; photo_gb_quota: number; status: string }>()

  const workspaceCount = await db
    .prepare("SELECT COUNT(*) AS c FROM workspaces WHERE org_id = ? AND status = 'active'")
    .bind(orgId)
    .first<{ c: number }>()

  return {
    workspaceQuota: subscription?.workspace_quota ?? 1,
    seatQuota: subscription?.seat_count ?? 5,
    photoGbQuota: subscription?.photo_gb_quota ?? 2,
    status: subscription?.status ?? 'trialing',
    workspaceCount: workspaceCount?.c ?? 0,
  }
}

async function mirrorWorkspace(
  campaign: Env['DB'],
  org: { id: string; name: string },
  workspace: { id: string; name: string; slug: string; status: string },
): Promise<void> {
  await campaign
    .prepare(
      `INSERT INTO orgs (id, name, status, synced_at) VALUES (?, ?, 'active', ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, synced_at = excluded.synced_at`,
    )
    .bind(org.id, org.name, new Date().toISOString())
    .run()
  await campaign
    .prepare(
      `INSERT INTO workspaces (id, org_id, name, slug, status, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         org_id = excluded.org_id, name = excluded.name, slug = excluded.slug,
         status = excluded.status, synced_at = excluded.synced_at`,
    )
    .bind(workspace.id, org.id, workspace.name, workspace.slug, workspace.status, new Date().toISOString())
    .run()
}

// ---------------------------------------------------------------------------
// Org + workspace provisioning
// ---------------------------------------------------------------------------
platform.get('/api/platform/orgs', requireUser, async (c) => {
  const profile = c.get('profile')
  const db = platformDb(c.env)
  const { results } = await db
    .prepare(
      `SELECT o.id, o.name, o.slug, o.status, o.display_name, o.plan_id,
              m.role AS my_role,
              (SELECT COUNT(*) FROM workspaces w WHERE w.org_id = o.id AND w.status = 'active') AS workspace_count
       FROM orgs o
       JOIN org_members m ON m.org_id = o.id AND m.user_id = ?
       ORDER BY o.created_at ASC`,
    )
    .bind(profile.id)
    .all()
  return c.json({ orgs: results ?? [] })
})

platform.post('/api/platform/orgs', requireUser, async (c) => {
  const profile = c.get('profile')
  const db = platformDb(c.env)
  const body = await c.req.json<{ name?: string; slug?: string; billingEmail?: string; displayName?: string }>()
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name is required' }, 400)

  const slug = slugify(body.slug || name)
  const existing = await db.prepare('SELECT id FROM orgs WHERE slug = ?').bind(slug).first()
  if (existing) return c.json({ error: 'That org slug is already taken' }, 409)

  const now = new Date().toISOString()
  const orgId = crypto.randomUUID()
  const plan = await db.prepare("SELECT id FROM plans WHERE code = 'booth_ops'").first<{ id: string }>()

  await db.batch([
    db.prepare(
      `INSERT INTO orgs (id, name, slug, status, plan_id, display_name, billing_email, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    ).bind(orgId, name, slug, plan?.id ?? null, body.displayName?.trim() || name, body.billingEmail?.trim() || profile.email, now, now),
    db.prepare(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', ?, ?)`,
    ).bind(crypto.randomUUID(), orgId, profile.id, now, now),
    db.prepare(
      `INSERT INTO subscriptions (id, org_id, plan_id, status, seat_count, workspace_quota, photo_gb_quota, created_at, updated_at)
       VALUES (?, ?, ?, 'trialing', 10, 1, 5, ?, ?)`,
    ).bind(crypto.randomUUID(), orgId, plan?.id ?? null, now, now),
  ])

  await audit(db, profile.id, 'org_create', orgId, null, { name, slug })
  return c.json({ org: { id: orgId, name, slug, status: 'active' } }, 201)
})

platform.get('/api/platform/orgs/:orgId/workspaces', requireUser, async (c) => {
  const profile = c.get('profile')
  const db = platformDb(c.env)
  const orgId = c.req.param('orgId')!
  const role = await orgMembership(db, orgId, profile.id)
  if (!role && !profile.is_platform_admin) return c.json({ error: 'Forbidden' }, 403)

  const { results } = await db
    .prepare(
      `SELECT w.id, w.org_id, w.name, w.slug, w.state, w.constituency_label, w.status, w.dataset_version,
              m.role AS my_role
       FROM workspaces w
       LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
       WHERE w.org_id = ?
       ORDER BY w.created_at ASC`,
    )
    .bind(profile.id, orgId)
    .all()
  return c.json({ workspaces: results ?? [] })
})

platform.post('/api/platform/orgs/:orgId/workspaces', requireUser, async (c) => {
  const profile = c.get('profile')
  const db = platformDb(c.env)
  const orgId = c.req.param('orgId')!

  try {
    await assertOrgRole(c, orgId, ORG_ADMIN_ROLES)
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const quota = await orgQuota(db, orgId)
  if (quota.workspaceCount >= quota.workspaceQuota) {
    return c.json(
      {
        error: 'Workspace quota reached for this plan',
        quota: { used: quota.workspaceCount, limit: quota.workspaceQuota },
      },
      402,
    )
  }

  const body = await c.req.json<{
    name?: string
    slug?: string
    state?: string
    constituencyLabel?: string
    role?: WorkspaceRole
  }>()
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name is required' }, 400)
  const slug = slugify(body.slug || name)

  const org = await db.prepare('SELECT id, name FROM orgs WHERE id = ?').bind(orgId).first<{ id: string; name: string }>()
  if (!org) return c.json({ error: 'Org not found' }, 404)

  const now = new Date().toISOString()
  const workspaceId = crypto.randomUUID()
  const role: WorkspaceRole = body.role ?? 'candidate'

  await db.batch([
    db.prepare(
      `INSERT INTO workspaces (id, org_id, name, slug, state, constituency_label, status, dataset_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
    ).bind(workspaceId, orgId, name, slug, body.state?.trim() || null, body.constituencyLabel?.trim() || name, now, now),
    db.prepare(
      `INSERT INTO workspace_members (id, org_id, workspace_id, user_id, role, allowed_wards, can_edit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '[]', 1, ?, ?)`,
    ).bind(crypto.randomUUID(), orgId, workspaceId, profile.id, role, now, now),
  ])

  await mirrorWorkspace(c.env.DB, org, { id: workspaceId, name, slug, status: 'active' })
  await seedWorkspaceDefaults(db, c.env.DB, workspaceId, orgId)
  await audit(db, profile.id, 'workspace_create', orgId, workspaceId, { name, slug })

  return c.json({ workspace: { id: workspaceId, org_id: orgId, name, slug, status: 'active' } }, 201)
})

platform.get('/api/platform/workspaces/:workspaceId/settings', requireUser, async (c) => {
  const profile = c.get('profile')
  const db = platformDb(c.env)
  const workspaceId = c.req.param('workspaceId')!
  const member = await db
    .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(workspaceId, profile.id)
    .first()
  if (!member && !profile.is_platform_admin) return c.json({ error: 'Forbidden' }, 403)

  const row = await db
    .prepare('SELECT * FROM workspace_settings WHERE workspace_id = ?')
    .bind(workspaceId)
    .first()
  return c.json({
    settings: row ?? null,
    categories: await listCategories(db, workspaceId),
    presenceOptions: await listPresenceOptions(db, workspaceId),
    specialLeaderBuckets: await listSpecialLeaderBuckets(db, workspaceId),
  })
})

platform.patch('/api/platform/workspaces/:workspaceId/settings', requireUser, async (c) => {
  const profile = c.get('profile')
  const db = platformDb(c.env)
  const workspaceId = c.req.param('workspaceId')!
  const member = await db
    .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(workspaceId, profile.id)
    .first<{ role: WorkspaceRole }>()
  if (!member && !profile.is_platform_admin) return c.json({ error: 'Forbidden' }, 403)
  if (!profile.is_platform_admin && member && !['candidate', 'incharge'].includes(member.role)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = await c.req.json<{
    branding?: unknown
    presenceOptions?: unknown
    specialLeaderBuckets?: unknown
    printTemplates?: unknown
    productDisplayName?: string | null
  }>()
  const updates: string[] = []
  const values: unknown[] = []
  if (body.branding !== undefined) {
    updates.push('branding = ?')
    values.push(JSON.stringify(body.branding))
  }
  if (body.presenceOptions !== undefined) {
    updates.push('presence_options = ?')
    values.push(JSON.stringify(body.presenceOptions))
  }
  if (body.specialLeaderBuckets !== undefined) {
    updates.push('special_leader_buckets = ?')
    values.push(JSON.stringify(body.specialLeaderBuckets))
  }
  if (body.printTemplates !== undefined) {
    updates.push('print_templates = ?')
    values.push(JSON.stringify(body.printTemplates))
  }
  if (body.productDisplayName !== undefined) {
    updates.push('product_display_name = ?')
    values.push(body.productDisplayName)
  }
  if (updates.length === 0) return c.json({ ok: true })

  updates.push('updated_at = ?', 'updated_by = ?')
  values.push(new Date().toISOString(), profile.id, workspaceId)

  await db
    .prepare(`UPDATE workspace_settings SET ${updates.join(', ')} WHERE workspace_id = ?`)
    .bind(...values)
    .run()
  await audit(db, profile.id, 'workspace_settings_update', c.get('workspace')?.org_id ?? null, workspaceId, body)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Workspace-configurable categories
// ---------------------------------------------------------------------------
platform.get('/api/platform/workspaces/:workspaceId/categories', requireUser, async (c) => {
  const db = platformDb(c.env)
  const workspaceId = c.req.param('workspaceId')!
  const member = await db
    .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(workspaceId, c.get('profile').id)
    .first()
  if (!member && !c.get('profile').is_platform_admin) return c.json({ error: 'Forbidden' }, 403)
  return c.json({ categories: await listCategories(db, workspaceId) })
})

platform.put('/api/platform/workspaces/:workspaceId/categories', requireUser, async (c) => {
  const profile = c.get('profile')
  const db = platformDb(c.env)
  const workspaceId = c.req.param('workspaceId')!
  const member = await db
    .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(workspaceId, profile.id)
    .first<{ role: WorkspaceRole }>()
  if (!profile.is_platform_admin && (!member || !['candidate', 'incharge'].includes(member.role))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = await c.req.json<{
    categories?: Array<{ code?: string; label?: string; color?: string | null; position?: number; isActive?: boolean }>
  }>()
  if (!Array.isArray(body.categories)) return c.json({ error: 'categories[] is required' }, 400)

  const now = new Date().toISOString()
  const statements = body.categories
    .filter((row) => row.code?.trim() && row.label?.trim())
    .map((row, index) =>
      db
        .prepare(
          `INSERT INTO workspace_categories (id, workspace_id, code, label, color, position, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, code) DO UPDATE SET
             label = excluded.label, color = excluded.color, position = excluded.position,
             is_active = excluded.is_active, updated_at = excluded.updated_at`,
        )
        .bind(
          crypto.randomUUID(),
          workspaceId,
          row.code!.trim().toUpperCase(),
          row.label!.trim(),
          row.color ?? null,
          Number.isInteger(row.position) ? row.position : index,
          row.isActive === false ? 0 : 1,
          now,
          now,
        ),
    )

  if (statements.length) await db.batch(statements)
  await audit(db, profile.id, 'workspace_categories_update', c.get('workspace')?.org_id ?? null, workspaceId, {
    count: statements.length,
  })
  return c.json({ ok: true, categories: await listCategories(db, workspaceId) })
})

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------
platform.post('/api/platform/orgs/:orgId/invites', requireUser, async (c) => {
  const profile = c.get('profile')
  const db = platformDb(c.env)
  const orgId = c.req.param('orgId')!
  try {
    await assertOrgRole(c, orgId, ORG_ADMIN_ROLES)
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = await c.req.json<{
    email?: string
    workspaceId?: string | null
    role?: WorkspaceRole
    allowedWards?: number[]
  }>()
  const email = body.email?.toLowerCase().trim()
  if (!email) return c.json({ error: 'email is required' }, 400)

  const role: WorkspaceRole = body.role ?? 'operator'
  const workspaceId = body.workspaceId ?? null
  if (workspaceId) {
    const ws = await db.prepare('SELECT id FROM workspaces WHERE id = ? AND org_id = ?').bind(workspaceId, orgId).first()
    if (!ws) return c.json({ error: 'Workspace not found in this org' }, 404)
  }

  const quota = await orgQuota(db, orgId)
  const seats = await db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) AS c FROM workspace_members WHERE org_id = ?`,
    )
    .bind(orgId)
    .first<{ c: number }>()
  if ((seats?.c ?? 0) >= quota.seatQuota) {
    return c.json({ error: 'Seat quota reached for this plan', quota }, 402)
  }

  const id = crypto.randomUUID()
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 72).toISOString()
  await db
    .prepare(
      `INSERT INTO invites (id, org_id, workspace_id, email, role, allowed_wards, token, invited_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      orgId,
      workspaceId,
      email,
      role,
      JSON.stringify(body.allowedWards ?? []),
      token,
      profile.id,
      expiresAt,
      new Date().toISOString(),
    )
    .run()

  await audit(db, profile.id, 'invite_create', orgId, workspaceId, { email, role })
  return c.json({ invite: { id, email, role, workspaceId, token, expiresAt } }, 201)
})

platform.post('/api/platform/invites/:token/accept', requireUser, async (c) => {
  const profile = c.get('profile')
  const db = platformDb(c.env)
  const token = c.req.param('token')!

  const invite = await db
    .prepare(
      `SELECT id, org_id, workspace_id, email, role, allowed_wards, accepted_at, expires_at
       FROM invites WHERE token = ?`,
    )
    .bind(token)
    .first<{
      id: string
      org_id: string
      workspace_id: string | null
      email: string
      role: WorkspaceRole
      allowed_wards: string
      accepted_at: string | null
      expires_at: string
    }>()

  if (!invite) return c.json({ error: 'Invite not found' }, 404)
  if (invite.accepted_at) return c.json({ error: 'Invite already used' }, 409)
  if (new Date(invite.expires_at).getTime() < Date.now()) return c.json({ error: 'Invite expired' }, 410)
  if (invite.email.toLowerCase() !== profile.email.toLowerCase()) {
    return c.json({ error: 'This invite belongs to a different email address' }, 403)
  }

  const now = new Date().toISOString()
  const statements = []
  if (invite.workspace_id) {
    statements.push(
      db.prepare(
        `INSERT INTO workspace_members (id, org_id, workspace_id, user_id, role, allowed_wards, can_edit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
      ).bind(
        crypto.randomUUID(),
        invite.org_id,
        invite.workspace_id,
        profile.id,
        invite.role,
        invite.allowed_wards,
        invite.role === 'field' || invite.role === 'booth_agent' ? 0 : 1,
        now,
        now,
      ),
    )
  }
  statements.push(
    db.prepare('UPDATE invites SET accepted_at = ? WHERE id = ?').bind(now, invite.id),
  )
  await db.batch(statements)
  await audit(db, profile.id, 'invite_accept', invite.org_id, invite.workspace_id, { email: invite.email })

  return c.json({ ok: true, orgId: invite.org_id, workspaceId: invite.workspace_id })
})

// ---------------------------------------------------------------------------
// Billing + quotas
// ---------------------------------------------------------------------------
platform.get('/api/platform/orgs/:orgId/billing', requireUser, async (c) => {
  const db = platformDb(c.env)
  const orgId = c.req.param('orgId')!
  try {
    await assertOrgRole(c, orgId, [...ORG_ADMIN_ROLES, ...BILLING_ROLES] as OrgRole[])
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const subscription = await db
    .prepare(
      `SELECT s.*, p.code AS plan_code, p.name AS plan_name
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.org_id = ? AND s.status IN ('trialing', 'active', 'past_due')
       ORDER BY s.created_at DESC LIMIT 1`,
    )
    .bind(orgId)
    .first()
  const { results: invoices } = await db
    .prepare('SELECT * FROM invoices WHERE org_id = ? ORDER BY created_at DESC LIMIT 50')
    .bind(orgId)
    .all()
  return c.json({ subscription: subscription ?? null, invoices: invoices ?? [], quota: await orgQuota(db, orgId) })
})

platform.get('/api/platform/orgs/:orgId/quota', requireUser, async (c) => {
  const db = platformDb(c.env)
  const orgId = c.req.param('orgId')!
  const role = await orgMembership(db, orgId, c.get('profile').id)
  if (!role && !c.get('profile').is_platform_admin) return c.json({ error: 'Forbidden' }, 403)
  return c.json({ quota: await orgQuota(db, orgId) })
})

/**
 * Stripe checkout is owned by the operator. We return the customer id that the
 * operator's Stripe account created; we never invent a payment processor.
 */
platform.post('/api/platform/orgs/:orgId/billing/checkout', requireUser, async (c) => {
  const db = platformDb(c.env)
  const orgId = c.req.param('orgId')!
  try {
    await assertOrgRole(c, orgId, BILLING_ROLES)
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const org = await db.prepare('SELECT stripe_customer_id FROM orgs WHERE id = ?').bind(orgId).first<{
    stripe_customer_id: string | null
  }>()
  if (!org?.stripe_customer_id) {
    return c.json(
      {
        error: 'Billing is not configured for this org yet',
        hint: 'Set orgs.stripe_customer_id from the operator Stripe account, then retry.',
      },
      501,
    )
  }
  return c.json({ stripeCustomerId: org.stripe_customer_id, checkoutUrl: null })
})

/**
 * Stripe webhook stub. Verify the signature when STRIPE_WEBHOOK_SECRET is set,
 * then mirror subscription status. Unknown events are acknowledged and ignored.
 */
platform.post('/api/platform/webhooks/stripe', async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET
  const raw = await c.req.text()
  if (secret) {
    const signature = c.req.header('stripe-signature')
    if (!signature) return c.json({ error: 'Missing signature' }, 401)
    const expected = await hmacHex(secret, raw)
    if (!timingSafeEqual(signature.split(',').find((p) => p.startsWith('v1='))?.slice(3) ?? '', expected)) {
      return c.json({ error: 'Invalid signature' }, 401)
    }
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(raw)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const db = platformDb(c.env)
  const object = event.data?.object ?? {}
  const customerId = String(object.customer ?? '')
  if (customerId) {
    const status =
      event.type === 'customer.subscription.deleted'
        ? 'canceled'
        : event.type === 'invoice.payment_failed'
          ? 'past_due'
          : event.type === 'customer.subscription.updated' || event.type === 'invoice.paid'
            ? 'active'
            : null
    if (status) {
      await db
        .prepare('UPDATE subscriptions SET status = ?, updated_at = ? WHERE stripe_customer_id = ?')
        .bind(status, new Date().toISOString(), customerId)
        .run()
    }
  }

  return c.json({ received: true })
})

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export { DEFAULT_PRESENCE_OPTIONS, DEFAULT_SPECIAL_LEADER_BUCKETS }
