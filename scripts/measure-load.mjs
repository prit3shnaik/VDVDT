#!/usr/bin/env node

/**
 * Measures the effect of the dataset-version fast path: how much work a workspace
 * page visit costs when nothing has changed vs a full roll fetch.
 */

const BASE = process.env.VERIFY_BASE_URL || 'https://app.milindsagunnaik.in'
const ORIGIN = process.env.VERIFY_ORIGIN || BASE
const EMAIL = process.env.VERIFY_EMAIL
const PASSWORD = process.env.VERIFY_PASSWORD

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

  const t0 = Date.now()
  const stampRes = await fetch(`${BASE}/api/voters/version`, { headers: { cookie, Origin: ORIGIN } })
  const stamp = await stampRes.json()
  const stampMs = Date.now() - t0
  console.log(`version stamp: ${JSON.stringify(stamp)}  (${stampMs} ms, 1 row read)`)

  // Old behaviour: 400-row pages over the whole roll.
  const oldPages = Math.ceil(stamp.rowCount / 400)
  const newPages = Math.ceil(stamp.rowCount / 2000)

  const t1 = Date.now()
  let fetched = 0
  let requests = 0
  for (let offset = 0; ; offset += 2000) {
    const r = await fetch(`${BASE}/rest/v1/voters?select=*&limit=2000&offset=${offset}`, {
      headers: { cookie, Origin: ORIGIN },
    })
    const rows = await r.json()
    requests += 1
    fetched += rows.length
    if (rows.length < 2000) break
  }
  const fullMs = Date.now() - t1

  console.log(`\nfull roll fetch: ${fetched} rows in ${requests} requests, ${fullMs} ms`)
  console.log(`\nper page visit, when nothing changed:`)
  console.log(`  before: ~${oldPages} requests, ${stamp.rowCount} rows read, ~${fullMs} ms`)
  console.log(`  after:  1 request, 1 row read, ~${stampMs} ms`)
  console.log(`\nwhen data DID change: ${newPages} requests instead of ${oldPages} (${(oldPages / newPages).toFixed(1)}x fewer)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
