#!/usr/bin/env node
/**
 * API-level tenancy isolation checks.
 *
 * Requires a running worker with the new schema:
 *   npx wrangler d1 execute voterdata-platform --local --config wrangler.pages-dev.toml --file docs/d1/000_platform.sql
 *   npx wrangler d1 execute voterdata --local --config wrangler.pages-dev.toml --file docs/d1/001_schema.sql
 *   npx wrangler d1 execute voterdata --local --config wrangler.pages-dev.toml --file docs/d1/002_fts_triggers.sql
 *   ADMIN_SETUP_PIN=test-pin npm run dev:worker
 *
 * Env:
 *   BASE_URL   default http://127.0.0.1:8787
 *   EMAIL      default tenancy-test@example.com
 *   PASSWORD   default tenancy-test-password
 *   SETUP_PIN  default test-pin
 *   ALLOW_SKIP=1 to exit 0 when the server is unreachable.
 */

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8787'
const EMAIL = process.env.EMAIL ?? 'tenancy-test@example.com'
const PASSWORD = process.env.PASSWORD ?? 'tenancy-test-password'
const SETUP_PIN = process.env.SETUP_PIN ?? 'test-pin'
const ALLOW_SKIP = process.env.ALLOW_SKIP === '1'
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8788'

let cookie = ''
let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}

async function req(path, { method = 'GET', body, workspaceId, raw, headers = {}, useCookie = true } = {}) {
  const h = new Headers(headers)
  if (!h.has('origin')) h.set('origin', ORIGIN)
  if (body !== undefined && !(body instanceof Uint8Array)) h.set('content-type', 'application/json')
  if (workspaceId) h.set('x-workspace-id', workspaceId)
  if (useCookie && cookie) h.set('cookie', cookie)

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    redirect: 'manual',
  })

  const setCookie = res.headers.getSetCookie?.() ?? []
  if (setCookie.length) cookie = setCookie.map((value) => value.split(';')[0]).join('; ')

  let data = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  return { status: res.status, data, headers: res.headers, rawText: text }
}

async function main() {
  try {
    const health = await req('/api/me', { useCookie: false })
    if (health.status === 0) throw new Error('no response')
  } catch (err) {
    if (ALLOW_SKIP) {
      console.log(`SKIP  server not reachable at ${BASE_URL}: ${err.message}`)
      return
    }
    console.error(`Server not reachable at ${BASE_URL}. Start the worker first.`)
    process.exit(1)
  }

  // Platform operator bootstrap (idempotent: sign in if it already exists).
  const boot = await req('/api/auth/bootstrap', {
    method: 'POST',
    useCookie: false,
    body: { email: EMAIL, password: PASSWORD, setupPin: SETUP_PIN, fullName: 'Tenancy Test' },
  })
  if (boot.status !== 200) {
    const signIn = await req('/api/auth/sign-in/email', {
      method: 'POST',
      useCookie: false,
      body: { email: EMAIL, password: PASSWORD },
    })
    check('sign in as platform operator', signIn.status === 200, `status ${signIn.status}`)
  } else {
    check('bootstrap platform operator', true)
    const signIn = await req('/api/auth/sign-in/email', {
      method: 'POST',
      useCookie: false,
      body: { email: EMAIL, password: PASSWORD },
    })
    check('sign in as platform operator', signIn.status === 200, `status ${signIn.status}`)
  }

  const suffix = Date.now().toString(36)
  const orgA = await req('/api/platform/orgs', {
    method: 'POST',
    body: { name: `Org A ${suffix}`, slug: `org-a-${suffix}` },
  })
  const orgB = await req('/api/platform/orgs', {
    method: 'POST',
    body: { name: `Org B ${suffix}`, slug: `org-b-${suffix}` },
  })
  check('create org A', orgA.status === 201, `status ${orgA.status}`)
  check('create org B', orgB.status === 201, `status ${orgB.status}`)

  const wsA = await req(`/api/platform/orgs/${orgA.data.org.id}/workspaces`, {
    method: 'POST',
    body: { name: `Constituency A ${suffix}`, slug: `ws-a-${suffix}`, state: 'State A' },
  })
  const wsB = await req(`/api/platform/orgs/${orgB.data.org.id}/workspaces`, {
    method: 'POST',
    body: { name: `Constituency B ${suffix}`, slug: `ws-b-${suffix}`, state: 'State B' },
  })
  check('create workspace A', wsA.status === 201, `status ${wsA.status}`)
  check('create workspace B', wsB.status === 201, `status ${wsB.status}`)
  if (wsA.status !== 201 || wsB.status !== 201) return finish()

  const a = wsA.data.workspace
  const b = wsB.data.workspace
  const epic = `SAME-EPIC-${suffix}`

  const insertA = await req('/rest/v1/voters', {
    method: 'POST',
    workspaceId: a.id,
    headers: { prefer: 'return=representation' },
    body: {
      epic_no: epic,
      name: 'Alpha Voter',
      voter_category: 'HOME',
      presence_status: 'IN_CONSTITUENCY',
      part_no: 1,
      ward_no: 1,
    },
  })
  const insertB = await req('/rest/v1/voters', {
    method: 'POST',
    workspaceId: b.id,
    headers: { prefer: 'return=representation' },
    body: {
      epic_no: epic,
      name: 'Beta Voter',
      voter_category: 'OPEN',
      presence_status: 'ABROAD',
      part_no: 1,
      ward_no: 1,
    },
  })
  check('same EPIC accepted in workspace A', insertA.status === 201, `status ${insertA.status} ${insertA.rawText}`)
  check('same EPIC accepted in workspace B', insertB.status === 201, `status ${insertB.status} ${insertB.rawText}`)

  const listA = await req('/rest/v1/voters?select=id,epic_no,name', { workspaceId: a.id })
  const listB = await req('/rest/v1/voters?select=id,epic_no,name', { workspaceId: b.id })
  check('workspace A list has only Alpha', listA.data?.length === 1 && listA.data[0].name === 'Alpha Voter', JSON.stringify(listA.data))
  check('workspace B list has only Beta', listB.data?.length === 1 && listB.data[0].name === 'Beta Voter', JSON.stringify(listB.data))

  const idA = listA.data?.[0]?.id
  const idB = listB.data?.[0]?.id
  const crossRead = await req(`/rest/v1/voters?select=id&id=eq.${idA}`, { workspaceId: b.id })
  check('workspace B cannot read workspace A row by id', Array.isArray(crossRead.data) && crossRead.data.length === 0, JSON.stringify(crossRead.data))

  const crossUpdate = await req(`/rest/v1/voters?id=eq.${idA}`, {
    method: 'PATCH',
    workspaceId: b.id,
    headers: { prefer: 'return=representation' },
    body: { name: 'Hijacked' },
  })
  check('workspace B cannot update workspace A row', crossUpdate.status === 404 || (Array.isArray(crossUpdate.data) && crossUpdate.data.length === 0), JSON.stringify(crossUpdate.data))
  const alphaStill = await req('/rest/v1/voters?select=name&id=eq.' + idA, { workspaceId: a.id })
  check('workspace A row unchanged after cross-workspace PATCH', alphaStill.data?.[0]?.name === 'Alpha Voter', JSON.stringify(alphaStill.data))

  const ftsA = await req('/api/voters?q=Alpha', { workspaceId: a.id })
  const ftsB = await req('/api/voters?q=Alpha', { workspaceId: b.id })
  check('FTS finds Alpha in A', ftsA.data?.voters?.length === 1, JSON.stringify(ftsA.data))
  check('FTS does not leak Alpha into B', ftsB.data?.voters?.length === 0, JSON.stringify(ftsB.data))

  const badCategory = await req('/rest/v1/voters', {
    method: 'POST',
    workspaceId: a.id,
    body: { epic_no: `BAD-CAT-${suffix}`, name: 'Bad Category', voter_category: 'PLATFORM_ENUM_ONLY' },
  })
  check('unknown category rejected', badCategory.status === 400 || badCategory.status === 422, `status ${badCategory.status}`)

  const mnd = await req('/rest/v1/voters', {
    method: 'POST',
    workspaceId: a.id,
    body: { epic_no: `MND-${suffix}`, name: 'Discussion Voter', voter_category: 'MN_DISCUSSION' },
  })
  check('seed category MN_DISCUSSION accepted', mnd.status === 201, `status ${mnd.status} ${mnd.rawText}`)

  const statsA = await req('/api/dashboard-stats', { workspaceId: a.id })
  const statsB = await req('/api/dashboard-stats', { workspaceId: b.id })
  check('dashboard stats A counts A roll', Number(statsA.data?.stats?.total_voters ?? 0) === 2, JSON.stringify(statsA.data))
  check('dashboard stats B counts B roll', Number(statsB.data?.stats?.total_voters ?? 0) === 1, JSON.stringify(statsB.data))

  const officeA = await req('/rest/v1/team_leaders?select=id,bucket_code&bucket_code=eq.__OFFICE__', { workspaceId: a.id })
  const officeB = await req('/rest/v1/team_leaders?select=id,bucket_code&bucket_code=eq.__OFFICE__', { workspaceId: b.id })
  check('workspace A has its own __OFFICE__ bucket', officeA.data?.length === 1, JSON.stringify(officeA.data))
  check('workspace B has its own __OFFICE__ bucket', officeB.data?.length === 1, JSON.stringify(officeB.data))
  check('__OFFICE__ buckets are distinct rows', officeA.data?.[0]?.id !== officeB.data?.[0]?.id)

  const upload = await req('/api/photos/epic/tenancy-test.png', {
    method: 'PUT',
    workspaceId: a.id,
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    headers: { 'content-type': 'image/png' },
  })
  check('photo upload to A', upload.status === 200 || upload.status === 201, `status ${upload.status} ${upload.rawText}`)

  const absoluteKey = `org/${a.org_id}/workspace/${a.id}/photos/epic/tenancy-test.png`
  const crossPhoto = await req(`/media/t500/${absoluteKey}`, { workspaceId: b.id })
  check('workspace B gets 403 for workspace A absolute R2 key', crossPhoto.status === 403, `status ${crossPhoto.status}`)

  const sameRelative = await req('/media/t500/epic/tenancy-test.png', { workspaceId: b.id })
  check('workspace B cannot resolve A photo by relative key', sameRelative.status === 404, `status ${sameRelative.status}`)

  // Field role cannot import.
  const fieldEmail = `field-${suffix}@example.com`
  const fieldPassword = 'field-password-123'
  const createField = await req('/api/admin/users', {
    method: 'POST',
    workspaceId: a.id,
    body: { email: fieldEmail, password: fieldPassword, fullName: 'Field User', role: 'field' },
  })
  check('create field member in A', createField.status === 201, `status ${createField.status} ${createField.rawText}`)

  cookie = ''
  const fieldSignIn = await req('/api/auth/sign-in/email', {
    method: 'POST',
    useCookie: false,
    body: { email: fieldEmail, password: fieldPassword },
  })
  check('field user can sign in', fieldSignIn.status === 200, `status ${fieldSignIn.status}`)

  const fieldImport = await req('/api/import/parse', {
    method: 'POST',
    workspaceId: a.id,
    body: { batchId: 'x' },
  })
  check('field user cannot import', fieldImport.status === 403, `status ${fieldImport.status}`)

  const fieldOther = await req('/rest/v1/voters?select=id,name', { workspaceId: b.id })
  check('field user cannot read another workspace', fieldOther.status === 403 || fieldOther.status === 404, `status ${fieldOther.status}`)

  finish()
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
