-- ===========================================================================
-- 000_platform.sql — Control-plane schema (PLATFORM_DB binding)
--
-- Apply:
--   npx wrangler d1 execute voterdata-platform --remote --file=./docs/d1/000_platform.sql
--
-- This database owns identity and tenancy:
--   * Better Auth tables (user/session/account/verification) — platform-global
--   * app users (platform profile) — NOT constituency users
--   * orgs (paying customer) / workspaces (one constituency per org)
--   * memberships, plans, subscriptions, invoices, invites
--
-- Naming contract: "org" = paying customer, "workspace" = constituency inside an
-- org. The word "tenant" is reserved for the rental-tenants module in the campaign
-- database and must never mean a SaaS customer.
--
-- D1 is SQLite. No Postgres types, no enums, no gen_random_uuid(), no NOW().
-- Booleans are INTEGER 0/1. Timestamps are ISO-8601 TEXT.
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Better Auth core tables (unchanged shape; identity is platform-global)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "image" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "role" TEXT,
  "banned" INTEGER DEFAULT 0,
  "banReason" TEXT,
  "banExpires" TEXT
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY,
  "expiresAt" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "impersonatedBy" TEXT
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TEXT,
  "refreshTokenExpiresAt" TEXT,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "createdAt" TEXT,
  "updatedAt" TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_userId ON "session"("userId");
CREATE INDEX IF NOT EXISTS idx_account_userId ON "account"("userId");
CREATE INDEX IF NOT EXISTS idx_verification_identifier ON "verification"("identifier");

-- ---------------------------------------------------------------------------
-- App users (platform profile)
--
-- A row exists for every human who can sign in. It is deliberately NOT a
-- constituency user: what a person can see is decided by org_members and
-- workspace_members. `is_platform_admin` is your staff, never a customer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  auth_user_id TEXT NOT NULL UNIQUE,
  full_name TEXT,
  email TEXT NOT NULL UNIQUE,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  password_reset_required INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_platform_admin ON users(is_platform_admin);

-- ---------------------------------------------------------------------------
-- Plans (catalog). Selling unit is per workspace / year; add-ons are separate
-- plan codes so a subscription can be composed without schema changes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  interval TEXT NOT NULL DEFAULT 'year' CHECK (interval IN ('month', 'year')),
  workspace_quota INTEGER NOT NULL DEFAULT 1,
  seat_quota INTEGER NOT NULL DEFAULT 5,
  photo_gb_quota INTEGER NOT NULL DEFAULT 2,
  features TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Orgs = paying customers (campaign / candidate office)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  plan_id TEXT REFERENCES plans(id),
  display_name TEXT,
  billing_email TEXT,
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_orgs_status ON orgs(status);
CREATE INDEX IF NOT EXISTS idx_orgs_stripe ON orgs(stripe_customer_id);

-- ---------------------------------------------------------------------------
-- Workspaces = one constituency / seat inside an org
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  state TEXT,
  constituency_label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  dataset_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (org_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(org_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);

-- ---------------------------------------------------------------------------
-- Org membership (owner / billing_admin / org_admin)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_members (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'billing_admin', 'org_admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);

-- ---------------------------------------------------------------------------
-- Workspace membership (candidate / incharge / operator / booth_agent / field)
-- allowed_wards is JSON text, e.g. [1,2,3]
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_members (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('candidate', 'incharge', 'operator', 'booth_agent', 'field')),
  allowed_wards TEXT NOT NULL DEFAULT '[]',
  can_edit INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_org ON workspace_members(org_id);

-- ---------------------------------------------------------------------------
-- Workspace settings: branding, presence options, special leader buckets,
-- print templates, product display name. All JSON is TEXT parsed in the Worker.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  branding TEXT NOT NULL DEFAULT '{}',
  presence_options TEXT NOT NULL DEFAULT '[]',
  special_leader_buckets TEXT NOT NULL DEFAULT '[]',
  print_templates TEXT NOT NULL DEFAULT '{}',
  product_display_name TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT REFERENCES users(id)
);

-- ---------------------------------------------------------------------------
-- Workspace categories: replaces the platform-level category enum.
-- Codes are free-form per workspace (e.g. MN_DISCUSSION, AWAY_DISCUSSION).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_categories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workspace_id, code)
);

CREATE INDEX IF NOT EXISTS idx_workspace_categories_ws ON workspace_categories(workspace_id, position);

-- ---------------------------------------------------------------------------
-- Subscriptions / invoices. Stripe is the only payment processor; these rows
-- mirror its state and hold quotas that the Worker enforces.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  seat_count INTEGER NOT NULL DEFAULT 5,
  workspace_quota INTEGER NOT NULL DEFAULT 1,
  photo_gb_quota INTEGER NOT NULL DEFAULT 2,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  current_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON subscriptions(org_id);
-- One live subscription per org. Partial unique index keeps history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_org_current
  ON subscriptions(org_id) WHERE status IN ('trialing', 'active', 'past_due');

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  stripe_invoice_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  period_start TEXT,
  period_end TEXT,
  hosted_invoice_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Invites. Replaces the global ADMIN_SETUP_PIN user-creation model. The token
-- is single-use and scoped to an org (and optionally a workspace).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  allowed_wards TEXT NOT NULL DEFAULT '[]',
  token TEXT NOT NULL UNIQUE,
  invited_by TEXT REFERENCES users(id),
  accepted_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
CREATE INDEX IF NOT EXISTS idx_invites_org ON invites(org_id);

-- ---------------------------------------------------------------------------
-- Platform audit trail (org/workspace lifecycle, billing, invites). Campaign
-- activity lives in the campaign database.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_activity_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  org_id TEXT,
  workspace_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_platform_activity_org ON platform_activity_logs(org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Seed plan catalog. Booth Ops is the base; Field and Poll-day are add-ons.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO plans (id, code, name, description, price_cents, interval, workspace_quota, seat_quota, photo_gb_quota, features)
VALUES
  ('plan_booth_ops', 'booth_ops', 'Booth Ops', 'Booth control, worker accountability and war-room numbers for one constituency.', 2400000, 'year', 1, 10, 5, '["roll","families","categories","team_leaders","booth"]'),
  ('plan_field', 'field', 'Field add-on', 'Presence, places and geotagging for field workers.', 900000, 'year', 1, 25, 10, '["field","presence","places","geotag"]'),
  ('plan_war_room', 'war_room', 'War Room', 'Multi-constituency command with insights and print/PDF packs.', 6000000, 'year', 5, 50, 50, '["insights","prints","multi_workspace"]');
