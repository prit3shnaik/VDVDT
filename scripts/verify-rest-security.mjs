#!/usr/bin/env node

/**
 * Security tests for the PostgREST-compatible shim (/rest/v1/*).
 *
 * The shim is the app's row-level-security layer, so these checks exist to prove a
 * restricted user cannot escape their ward scope, reach admin-only tables, or perform
 * unfiltered destructive writes.
 *
 * Usage: node scripts/verify-rest-security.mjs
 */

const BASE = process.env.VERIFY_BASE_URL || 'http://localhost:8787'
const ORIGIN = process.env.VERIFY_ORIGIN || BASE
const ADMIN_EMAIL = process.env.VERIFY_EMAIL
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set VERIFY_EMAIL and VERIFY_PASSWORD before running.')
  process.exit(1)
}

const TEMP_EMAIL = `shim-test-${Date.now()}@local.invalid`
const TEMP_PASSWORD = 'ShimTest@12345'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -> ${detail}` : ''}`)
  if (!ok) failures++
}

function cookiesFrom(res) {
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
}

async function signIn(email, password) {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  })
  return { ok: res.ok, status: res.status, cookie: cookiesFrom(res), body: await res.text() }
}

function client(cookie) {
  return async (path, init = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
        cookie,
        Origin: ORIGIN,
      },
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* ignore */
    }
    return { status: res.status, ok: res.ok, json, text, headers: res.headers }
  }
}

async function main() {
  // Anonymous access must never reach the shim.
  const anon = await fetch(`${BASE}/rest/v1/voters?select=id`)
  check('anon cannot read /rest/v1/voters', anon.status === 401, `status ${anon.status}`)

  const admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  if (!admin.cookie) {
    console.log('Aborting: admin sign-in failed.')
    process.exit(1)
  }
  const api = client(admin.cookie)

  // --- allowlist ------------------------------------------------------------
  const unknownTable = await api('/rest/v1/sqlite_master?select=name')
  check('unlisted table is rejected', unknownTable.status === 400, `status ${unknownTable.status}`)

  const authTable = await api('/rest/v1/user?select=id')
  check('better-auth user table is not exposed', authTable.status === 400, `status ${authTable.status}`)

  const sessionTable = await api('/rest/v1/session?select=id')
  check('session table is not exposed', sessionTable.status === 400, `status ${sessionTable.status}`)

  const accountTable = await api('/rest/v1/account?select=password')
  check('account/password table is not exposed', accountTable.status === 400, `status ${accountTable.status}`)

  // --- read-only tables -----------------------------------------------------
  const writeStats = await api('/rest/v1/dashboard_stats?id=eq.1', {
    method: 'PATCH',
    body: JSON.stringify({ total_voters: 0 }),
  })
  check('dashboard_stats is read-only', writeStats.status === 403, `status ${writeStats.status}`)

  const writeLogs = await api('/rest/v1/activity_logs', {
    method: 'POST',
    body: JSON.stringify({ id: 'x' }),
  })
  check('activity_logs is not writable', writeLogs.status === 403, `status ${writeLogs.status}`)

  // --- destructive guards ---------------------------------------------------
  const blindDelete = await api('/rest/v1/voters', { method: 'DELETE' })
  check('unfiltered DELETE is refused', blindDelete.status === 400, `status ${blindDelete.status}`)

  const blindPatch = await api('/rest/v1/voters', {
    method: 'PATCH',
    body: JSON.stringify({ name: 'overwritten' }),
  })
  check('unfiltered PATCH is refused', blindPatch.status === 400, `status ${blindPatch.status}`)

  // --- injection attempts ---------------------------------------------------
  const injectedSelect = await api('/rest/v1/voters?select=id,(SELECT password FROM account)')
  check('subquery in select is refused', injectedSelect.status === 400, `status ${injectedSelect.status}`)

  const injectedOrder = await api('/rest/v1/voters?order=id;DROP TABLE voters')
  check('injection in order is refused', injectedOrder.status === 400, `status ${injectedOrder.status}`)

  const injectedFilter = await api('/rest/v1/voters?id%3BDROP=eq.1')
  check('injection in filter column is refused', injectedFilter.status === 400, `status ${injectedFilter.status}`)

  const unsupportedOp = await api('/rest/v1/voters?id=fts.something')
  check('unsupported operator is refused', unsupportedOp.status === 400, `status ${unsupportedOp.status}`)

  // --- immutable columns ----------------------------------------------------
  const sample = await api('/rest/v1/voters?select=id,ward_no&limit=1')
  const voter = sample.json?.[0]

  if (voter?.id) {
    const touchId = await api(`/rest/v1/voters?id=eq.${voter.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ id: 'hijacked' }),
    })
    check('immutable column cannot be patched', touchId.status === 400, `status ${touchId.status}`)
  } else {
    console.log('SKIP  immutable column test (no voter rows in this database)')
  }

  // --- restricted user ------------------------------------------------------
  const created = await api('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email: TEMP_EMAIL,
      password: TEMP_PASSWORD,
      fullName: 'Shim Test',
      role: 'user',
      allowedWards: [999999],
      canEdit: false,
    }),
  })
  check('temp restricted user created', created.status === 201, `status ${created.status} ${created.text.slice(0, 200)}`)
  const tempId = created.json?.id

  const temp = await signIn(TEMP_EMAIL, TEMP_PASSWORD)
  if (temp.cookie) {
    const t = client(temp.cookie)

    const readUsers = await t('/rest/v1/users?select=id,role,allowed_wards')
    check('restricted user cannot read users table', readUsers.status === 403, `status ${readUsers.status}`)

    const readLogs = await t('/rest/v1/activity_logs?select=id')
    check('restricted user cannot read activity_logs', readLogs.status === 403, `status ${readLogs.status}`)

    const readBatches = await t('/rest/v1/import_batches?select=id')
    check('restricted user cannot read import_batches', readBatches.status === 403, `status ${readBatches.status}`)

    const writeVoters = await t('/rest/v1/voters', {
      method: 'POST',
      body: JSON.stringify({ id: crypto.randomUUID(), epic_no: 'SHIM1', name: 'nope' }),
    })
    check('read-only user cannot insert voters', writeVoters.status === 403, `status ${writeVoters.status}`)

    const voters = await t('/rest/v1/voters?select=id,ward_no&limit=200')
    const leaked = (voters.json ?? []).filter((v) => v.ward_no !== null && v.ward_no !== 999999)
    check('ward scope enforced on voters', leaked.length === 0, `${leaked.length} out-of-ward rows`)

    // Voter-linked child tables must be scoped through their voter.
    //
    // Semantics note: a NULL ward_no means "visible to everyone". That is deliberate
    // parity with the original Supabase RLS
    // (`or ward_no is null or ward_no = any(allowed_wards_for_user())`).
    // So the correct assertion is not "restricted sees fewer rows" — it is that every
    // row the restricted user sees belongs to a voter with a NULL or allowed ward.
    const invitees = await t('/rest/v1/meeting_invitees?select=voter_id&limit=200')
    const inviteeVoterIds = (invitees.json ?? []).map((r) => r.voter_id).filter(Boolean)

    if (inviteeVoterIds.length > 0) {
      const idList = inviteeVoterIds.slice(0, 25).join(',')
      const owners = await api(`/rest/v1/voters?select=id,ward_no&id=in.(${idList})`)
      const ownerRows = Array.isArray(owners.json) ? owners.json : null

      if (!ownerRows) {
        check('child-table ward ownership lookup succeeded', false, `status ${owners.status} ${owners.text.slice(0, 200)}`)
      } else {
        const offending = ownerRows.filter((v) => v.ward_no !== null && v.ward_no !== 999999)
        check(
          'child-table rows all belong to NULL or allowed wards',
          offending.length === 0,
          `${offending.length} rows from a disallowed ward`
        )
      }
    } else {
      check('child-table rows all belong to NULL or allowed wards', true, 'no rows to check')
    }

    // A restricted user must not escape scope by filtering for another ward.
    const probe = await t('/rest/v1/voters?select=id,ward_no&ward_no=eq.1&limit=50')
    const probeLeak = (probe.json ?? []).filter((v) => v.ward_no !== 999999)
    check('ward scope survives an explicit cross-ward filter', probeLeak.length === 0, `${probeLeak.length} rows leaked`)

    // Proves the ward filter actually bites when a ward IS set, rather than only
    // appearing to pass because production data has no wards populated.
    const probeEpic = `WARDPROBE${Date.now()}`
    const probeVoter = await api('/api/voters', {
      method: 'POST',
      body: JSON.stringify({ epic_no: probeEpic, name: 'WARD PROBE', ward_no: 12345, part_no: 999 }),
    })

    if (probeVoter.status === 201) {
      const visibleToAdmin = await api(`/rest/v1/voters?select=id&epic_no=eq.${probeEpic}`)
      check('admin sees the ward-12345 probe voter', (Array.isArray(visibleToAdmin.json) ? visibleToAdmin.json : []).length === 1, `status ${visibleToAdmin.status}`)

      const visibleToRestricted = await t(`/rest/v1/voters?select=id&epic_no=eq.${probeEpic}`)
      const restrictedRows = Array.isArray(visibleToRestricted.json) ? visibleToRestricted.json : []
      check(
        'restricted user CANNOT see a voter in a ward they lack',
        restrictedRows.length === 0,
        `saw ${restrictedRows.length} rows`
      )

      await api(`/rest/v1/voters?id=eq.${probeVoter.json.id}`, { method: 'DELETE' })
    } else {
      check('ward probe voter created', false, `status ${probeVoter.status}`)
    }
  }

  // --- PostgREST type fidelity ---------------------------------------------
  // D1 stores JSON as TEXT and booleans as INTEGER. The frontend was written against
  // Postgres types, so the shim must convert. Regression guard for the crash
  // "allowed_wards.join is not a function".
  const usersRows = await api('/rest/v1/users?select=id,allowed_wards,can_edit&limit=3')
  const userRow = Array.isArray(usersRows.json) ? usersRows.json[0] : null

  if (userRow) {
    check('allowed_wards is an array, not a JSON string', Array.isArray(userRow.allowed_wards), `got ${typeof userRow.allowed_wards}`)
    check('can_edit is a boolean, not 0/1', typeof userRow.can_edit === 'boolean', `got ${typeof userRow.can_edit}`)
  } else {
    check('users row available for type check', false, `status ${usersRows.status}`)
  }

  const statsRow = await api('/rest/v1/dashboard_stats?select=religion_breakdown&limit=1')
  const stats = Array.isArray(statsRow.json) ? statsRow.json[0] : null
  if (stats) {
    check(
      'dashboard breakdown is an object, not a JSON string',
      typeof stats.religion_breakdown === 'object' && stats.religion_breakdown !== null,
      `got ${typeof stats.religion_breakdown}`
    )
  }

  const fieldsRow = await api('/rest/v1/custom_fields?select=id,options,required&limit=1')
  const field = Array.isArray(fieldsRow.json) ? fieldsRow.json[0] : null
  if (field) {
    check('custom_fields.required is a boolean', typeof field.required === 'boolean', `got ${typeof field.required}`)
  }

  // --- cleanup --------------------------------------------------------------
  if (tempId) {
    const del = await api(`/api/admin/users/${tempId}`, { method: 'DELETE' })
    check('cleanup: temp user removed', del.ok, `status ${del.status}`)
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
