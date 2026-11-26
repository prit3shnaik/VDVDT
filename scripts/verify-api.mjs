#!/usr/bin/env node

/**
 * End-to-end smoke test for the Cloudflare Worker API.
 * Exercises auth, every CRUD route, and the ward ACL with a restricted user.
 *
 * Usage: node scripts/verify-api.mjs
 */

const BASE = process.env.VERIFY_BASE_URL || 'http://localhost:8787'
const ORIGIN = process.env.VERIFY_ORIGIN || BASE
const ADMIN_EMAIL = process.env.VERIFY_EMAIL
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set VERIFY_EMAIL and VERIFY_PASSWORD before running.')
  process.exit(1)
}

const RESTRICTED_EMAIL = `smoke-restricted-${Date.now()}@local.invalid`
const RESTRICTED_PASSWORD = 'Restricted@12345'

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
      /* non-JSON body (e.g. image) */
    }
    return { res, status: res.status, ok: res.ok, json, text }
  }
}

async function main() {
  // --- 1. unauthenticated access is denied ---------------------------------
  for (const path of ['/api/me', '/api/voters', '/api/admin/users', '/media/t500/epic/x.png']) {
    const res = await fetch(`${BASE}${path}`)
    check(`anon ${path} is 401`, res.status === 401, `status ${res.status}`)
  }

  // --- 2. admin sign-in ----------------------------------------------------
  const admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  check('admin sign-in succeeds', admin.ok, `status ${admin.status} ${admin.ok ? '' : admin.body}`)
  if (!admin.cookie) {
    console.log('\nAborting: admin sign-in produced no session cookie.')
    process.exit(1)
  }
  const api = client(admin.cookie)

  const bad = await signIn(ADMIN_EMAIL, 'wrong-password-here')
  check('wrong password rejected', !bad.ok, `status ${bad.status}`)

  const me = await api('/api/me')
  check('admin profile role is admin', me.json?.profile?.role === 'admin', `role ${me.json?.profile?.role}`)
  const adminProfileId = me.json?.profile?.id

  // --- 3. bootstrap is locked ---------------------------------------------
  // In production the ADMIN_SETUP_PIN secret is deleted after setup, so the endpoint
  // returns 404 (disabled). Locally the PIN still exists, so a wrong PIN gives 401 and
  // a correct PIN with an admin present gives 400. All three mean "cannot be abused".
  const reboot = await fetch(`${BASE}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'x@y.test', password: 'Passw0rd!x', setupPin: ADMIN_PASSWORD }),
  })
  check(
    'bootstrap cannot create another admin',
    [400, 401, 404].includes(reboot.status),
    `status ${reboot.status}`
  )

  const wrongPin = await fetch(`${BASE}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'x@y.test', password: 'Passw0rd!x', setupPin: 'nope' }),
  })
  check('bootstrap rejects a wrong PIN', [401, 404].includes(wrongPin.status), `status ${wrongPin.status}`)

  // --- 4. read routes ------------------------------------------------------
  for (const path of [
    '/api/voters?limit=1',
    '/api/voters?q=a&limit=1',
    '/api/dashboard-stats',
    '/api/groups?limit=1',
    '/api/team-leaders?limit=1',
    '/api/team-leaders?q=a&limit=1',
    '/api/meetings?limit=1',
    '/api/job-records?limit=1',
    '/api/activity-logs?limit=1',
    '/api/custom-fields',
    '/api/admin/users?limit=5',
  ]) {
    const r = await api(path)
    check(`GET ${path}`, r.ok, `status ${r.status}${r.ok ? '' : ' ' + r.text.slice(0, 200)}`)
  }

  // Write tests run against a throwaway voter, never a real one.
  // Reusing a real voter would be destructive: assigning it to a test team leader uses
  // ON CONFLICT DO UPDATE (which would steal it from its real leader) and cleanup would
  // then delete that assignment outright.
  const tempEpic = `SMOKETEST${Date.now()}`
  const tempVoterCreate = await api('/api/voters', {
    method: 'POST',
    body: JSON.stringify({
      epic_no: tempEpic,
      name: 'SMOKE TEST VOTER',
      ward_no: 999999,
      part_no: 999,
    }),
  })
  check('temp voter created for write tests', tempVoterCreate.status === 201, `status ${tempVoterCreate.status} ${tempVoterCreate.text.slice(0, 200)}`)
  const sampleVoter = tempVoterCreate.json?.id ? { id: tempVoterCreate.json.id } : null

  // --- 5. groups CRUD ------------------------------------------------------
  const groupCreate = await api('/api/groups', {
    method: 'POST',
    body: JSON.stringify({ name: 'smoke-test-group', group_type: 'custom', description: 'temp' }),
  })
  check('POST /api/groups', groupCreate.status === 201, `status ${groupCreate.status} ${groupCreate.text.slice(0, 200)}`)
  const groupId = groupCreate.json?.id

  const badGroup = await api('/api/groups', {
    method: 'POST',
    body: JSON.stringify({ name: 'bad', group_type: 'not_a_type' }),
  })
  check('POST /api/groups rejects bad group_type', badGroup.status === 400, `status ${badGroup.status}`)

  if (groupId) {
    const g = await api(`/api/groups/${groupId}`)
    check('GET /api/groups/:id', g.ok, `status ${g.status}`)

    const patch = await api(`/api/groups/${groupId}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'updated' }),
    })
    check('PATCH /api/groups/:id', patch.ok, `status ${patch.status} ${patch.text.slice(0, 200)}`)

    if (sampleVoter?.id) {
      const addMember = await api(`/api/groups/${groupId}/members`, {
        method: 'POST',
        body: JSON.stringify({ voter_ids: [sampleVoter.id] }),
      })
      check('POST group members', addMember.ok, `status ${addMember.status} ${addMember.text.slice(0, 200)}`)

      const withMember = await api(`/api/groups/${groupId}`)
      check('group member shows up', (withMember.json?.members?.length ?? 0) > 0)

      const delMember = await api(`/api/groups/${groupId}/members/${sampleVoter.id}`, { method: 'DELETE' })
      check('DELETE group member', delMember.ok, `status ${delMember.status}`)
    }
  }

  // --- 6. team leaders CRUD ------------------------------------------------
  const tlCreate = await api('/api/team-leaders', {
    method: 'POST',
    body: JSON.stringify({ display_name: 'smoke-test-leader', part_no: 1, notes: 'temp' }),
  })
  check('POST /api/team-leaders', tlCreate.status === 201, `status ${tlCreate.status} ${tlCreate.text.slice(0, 200)}`)
  const leaderId = tlCreate.json?.id

  if (leaderId) {
    const tl = await api(`/api/team-leaders/${leaderId}`)
    check('GET /api/team-leaders/:id', tl.ok, `status ${tl.status} ${tl.text.slice(0, 200)}`)

    const tlPatch = await api(`/api/team-leaders/${leaderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes: 'updated' }),
    })
    check('PATCH /api/team-leaders/:id', tlPatch.ok, `status ${tlPatch.status} ${tlPatch.text.slice(0, 200)}`)

    if (sampleVoter?.id) {
      const assign = await api(`/api/team-leaders/${leaderId}/assignments`, {
        method: 'POST',
        body: JSON.stringify({ voter_ids: [sampleVoter.id], is_direct: true }),
      })
      check('POST leader assignments', assign.ok, `status ${assign.status} ${assign.text.slice(0, 200)}`)

      const unassign = await api(`/api/team-leaders/${leaderId}/assignments/${sampleVoter.id}`, {
        method: 'DELETE',
      })
      check('DELETE leader assignment', unassign.ok, `status ${unassign.status}`)
    }
  }

  // --- 7. meetings CRUD ----------------------------------------------------
  const meetingCreate = await api('/api/meetings', {
    method: 'POST',
    body: JSON.stringify({ title: 'smoke-test-meeting', meeting_date: '2026-01-01', part_no: 1 }),
  })
  check('POST /api/meetings', meetingCreate.status === 201, `status ${meetingCreate.status} ${meetingCreate.text.slice(0, 200)}`)
  const meetingId = meetingCreate.json?.id

  const badMeeting = await api('/api/meetings', { method: 'POST', body: JSON.stringify({ title: 'no date' }) })
  check('POST /api/meetings requires meeting_date', badMeeting.status === 400, `status ${badMeeting.status}`)

  if (meetingId) {
    const m = await api(`/api/meetings/${meetingId}`)
    check('GET /api/meetings/:id', m.ok, `status ${m.status} ${m.text.slice(0, 200)}`)

    const mPatch = await api(`/api/meetings/${meetingId}`, {
      method: 'PATCH',
      body: JSON.stringify({ location: 'updated hall' }),
    })
    check('PATCH /api/meetings/:id', mPatch.ok, `status ${mPatch.status} ${mPatch.text.slice(0, 200)}`)

    if (sampleVoter?.id) {
      const invite = await api(`/api/meetings/${meetingId}/invitees`, {
        method: 'POST',
        body: JSON.stringify({ voter_ids: [sampleVoter.id] }),
      })
      check('POST meeting invitees', invite.ok, `status ${invite.status} ${invite.text.slice(0, 200)}`)

      const setStatus = await api(`/api/meetings/${meetingId}/invitees/${sampleVoter.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ attendance_status: 'called_confirmed', call_note: 'ok' }),
      })
      check('PATCH invitee attendance', setStatus.ok, `status ${setStatus.status} ${setStatus.text.slice(0, 200)}`)

      const badStatus = await api(`/api/meetings/${meetingId}/invitees/${sampleVoter.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ attendance_status: 'bogus_status' }),
      })
      check('invalid attendance_status rejected', badStatus.status === 400, `status ${badStatus.status}`)
    }
  }

  // --- 8. job records CRUD -------------------------------------------------
  let jobId = null
  if (sampleVoter?.id) {
    const jobCreate = await api('/api/job-records', {
      method: 'POST',
      body: JSON.stringify({ voter_id: sampleVoter.id, status: 'pending', department_name: 'smoke', note: 'temp' }),
    })
    check('POST /api/job-records', jobCreate.status === 201, `status ${jobCreate.status} ${jobCreate.text.slice(0, 200)}`)
    jobId = jobCreate.json?.id

    const badJob = await api('/api/job-records', {
      method: 'POST',
      body: JSON.stringify({ voter_id: sampleVoter.id, status: 'not_a_status' }),
    })
    check('POST /api/job-records rejects bad status', badJob.status === 400, `status ${badJob.status}`)

    if (jobId) {
      const jPatch = await api(`/api/job-records/${jobId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'applied_govt' }),
      })
      check('PATCH /api/job-records/:id', jPatch.ok, `status ${jPatch.status} ${jPatch.text.slice(0, 200)}`)
    }
  }

  // --- 9. self-protection guards ------------------------------------------
  if (adminProfileId) {
    const selfDel = await api(`/api/admin/users/${adminProfileId}`, { method: 'DELETE' })
    check('admin cannot delete self', selfDel.status === 400, `status ${selfDel.status}`)

    const selfEdit = await api(`/api/admin/users/${adminProfileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'user' }),
    })
    check('admin cannot edit own permissions', selfEdit.status === 400, `status ${selfEdit.status}`)
  }

  // --- 10. user creation + ward ACL ---------------------------------------
  const createUser = await api('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email: RESTRICTED_EMAIL,
      password: RESTRICTED_PASSWORD,
      fullName: 'Smoke Restricted',
      role: 'user',
      allowedWards: [999999],
      canEdit: false,
    }),
  })
  check('POST /api/admin/users creates a user', createUser.status === 201, `status ${createUser.status} ${createUser.text.slice(0, 200)}`)
  const restrictedId = createUser.json?.id

  const restricted = await signIn(RESTRICTED_EMAIL, RESTRICTED_PASSWORD)
  check('created user can sign in', restricted.ok, `status ${restricted.status} ${restricted.ok ? '' : restricted.body}`)

  // --- 10b. admin password reset must actually change the password ----------
  if (restrictedId) {
    const NEW_PASSWORD = 'Rotated@98765'
    const reset = await api(`/api/admin/users/${restrictedId}/password`, {
      method: 'POST',
      body: JSON.stringify({ password: NEW_PASSWORD }),
    })
    check('admin can reset another user password', reset.ok, `status ${reset.status} ${reset.text.slice(0, 200)}`)

    const withNew = await signIn(RESTRICTED_EMAIL, NEW_PASSWORD)
    check('user can sign in with the new password', withNew.ok, `status ${withNew.status} ${withNew.ok ? '' : withNew.body}`)

    const withOld = await signIn(RESTRICTED_EMAIL, RESTRICTED_PASSWORD)
    check('old password no longer works after reset', !withOld.ok, `status ${withOld.status}`)

    const tooShort = await api(`/api/admin/users/${restrictedId}/password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'short' }),
    })
    check('short password is rejected', tooShort.status === 400, `status ${tooShort.status}`)
  }

  if (restricted.cookie) {
    const rApi = client(restricted.cookie)

    const rMe = await rApi('/api/me')
    check('restricted user profile role is user', rMe.json?.profile?.role === 'user', `role ${rMe.json?.profile?.role}`)

    const rAdminUsers = await rApi('/api/admin/users')
    check('restricted user blocked from /api/admin/users', rAdminUsers.status === 403, `status ${rAdminUsers.status}`)

    const rLogs = await rApi('/api/activity-logs')
    check('restricted user blocked from activity logs', rLogs.status === 403, `status ${rLogs.status}`)

    const rVoters = await rApi('/api/voters?limit=50')
    const leaked = (rVoters.json?.voters ?? []).filter((v) => v.ward_no !== null && v.ward_no !== 999999)
    check('ward ACL hides other wards from restricted user', leaked.length === 0, `${leaked.length} out-of-ward rows returned`)

    const rWrite = await rApi('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'should-fail', group_type: 'custom' }),
    })
    check('restricted read-only user cannot create groups', rWrite.status === 403, `status ${rWrite.status}`)

    if (sampleVoter?.id) {
      const rJob = await rApi('/api/job-records', {
        method: 'POST',
        body: JSON.stringify({ voter_id: sampleVoter.id, status: 'pending' }),
      })
      check('restricted user cannot create job records', rJob.status === 403, `status ${rJob.status}`)
    }
  }

  // --- 11. cleanup ---------------------------------------------------------
  if (jobId) await api(`/api/job-records/${jobId}`, { method: 'DELETE' })
  if (meetingId) await api(`/api/meetings/${meetingId}`, { method: 'DELETE' })
  if (leaderId) await api(`/api/team-leaders/${leaderId}`, { method: 'DELETE' })
  if (groupId) await api(`/api/groups/${groupId}`, { method: 'DELETE' })
  if (restrictedId) {
    const del = await api(`/api/admin/users/${restrictedId}`, { method: 'DELETE' })
    check('cleanup: temp user deleted', del.ok, `status ${del.status}`)
  }
  if (sampleVoter?.id) {
    const delVoter = await api(`/rest/v1/voters?id=eq.${sampleVoter.id}`, { method: 'DELETE' })
    check('cleanup: temp voter deleted', delVoter.status === 204, `status ${delVoter.status}`)

    const gone = await api(`/api/voters/${sampleVoter.id}`)
    check('cleanup: temp voter is really gone', gone.status === 404, `status ${gone.status}`)
  }

  const goneGroup = groupId ? await api(`/api/groups/${groupId}`) : null
  if (goneGroup) check('cleanup: temp group deleted', goneGroup.status === 404, `status ${goneGroup.status}`)

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
