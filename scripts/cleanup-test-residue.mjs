#!/usr/bin/env node

/**
 * Finds (and with --delete, removes) any leftover rows created by the verification
 * scripts. A crashed test run can exit before its cleanup step.
 *
 * Usage:
 *   node scripts/cleanup-test-residue.mjs           # report only
 *   node scripts/cleanup-test-residue.mjs --delete  # actually delete
 */

const BASE = process.env.VERIFY_BASE_URL || 'https://app.milindsagunnaik.in'
const ORIGIN = process.env.VERIFY_ORIGIN || BASE
const EMAIL = process.env.VERIFY_EMAIL
const PASSWORD = process.env.VERIFY_PASSWORD
const DO_DELETE = process.argv.includes('--delete')

if (!EMAIL || !PASSWORD) {
  console.error('Set VERIFY_EMAIL and VERIFY_PASSWORD before running.')
  process.exit(1)
}

async function main() {
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

  const api = async (path, init = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
        cookie,
        Origin: ORIGIN,
      },
    })
    const text = await r.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* ignore */
    }
    return { status: r.status, json, text }
  }

  let found = 0

  // 1. Test user accounts.
  const users = await api('/api/admin/users?limit=500')
  const testUsers = (users.json?.users ?? []).filter(
    (u) => typeof u.email === 'string' && u.email.endsWith('@local.invalid')
  )
  for (const u of testUsers) {
    found++
    console.log(`user     ${u.email} (${u.id})`)
    if (DO_DELETE) {
      const d = await api(`/api/admin/users/${u.id}`, { method: 'DELETE' })
      console.log(`   deleted -> ${d.status}`)
    }
  }

  // 2. Test voters.
  for (const prefix of ['SMOKETEST', 'WARDPROBE']) {
    const voters = await api(`/rest/v1/voters?select=id,epic_no,name&epic_no=like.${prefix}*`)
    for (const v of voters.json ?? []) {
      found++
      console.log(`voter    ${v.epic_no} (${v.id})`)
      if (DO_DELETE) {
        const d = await api(`/rest/v1/voters?id=eq.${v.id}`, { method: 'DELETE' })
        console.log(`   deleted -> ${d.status}`)
      }
    }
  }

  // 3. Test groups / leaders / meetings.
  const groups = await api('/rest/v1/groups?select=id,name&name=like.smoke-test*')
  for (const g of groups.json ?? []) {
    found++
    console.log(`group    ${g.name} (${g.id})`)
    if (DO_DELETE) console.log(`   deleted -> ${(await api(`/api/groups/${g.id}`, { method: 'DELETE' })).status}`)
  }

  const leaders = await api('/rest/v1/team_leaders?select=id,display_name&display_name=like.smoke-test*')
  for (const l of leaders.json ?? []) {
    found++
    console.log(`leader   ${l.display_name} (${l.id})`)
    if (DO_DELETE) console.log(`   deleted -> ${(await api(`/api/team-leaders/${l.id}`, { method: 'DELETE' })).status}`)
  }

  const meetings = await api('/rest/v1/meetings?select=id,title&title=like.smoke-test*')
  for (const m of meetings.json ?? []) {
    found++
    console.log(`meeting  ${m.title} (${m.id})`)
    if (DO_DELETE) console.log(`   deleted -> ${(await api(`/api/meetings/${m.id}`, { method: 'DELETE' })).status}`)
  }

  console.log(`\n${found} leftover row(s) ${DO_DELETE ? 'processed' : 'found (run with --delete to remove)'}.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
