#!/usr/bin/env node

/**
 * End-to-end test for the chunked xlsx import pipeline.
 *
 * Builds a real .xlsx (with an embedded, row-anchored image), pushes it through
 * upload -> parse -> commit -> photos, then verifies the voters and photo landed
 * correctly and cleans everything up.
 *
 * Defaults to the LOCAL worker so production data is never touched.
 * Usage: node scripts/verify-import.mjs
 */

import ExcelJS from 'exceljs'

const BASE = process.env.VERIFY_BASE_URL || 'http://localhost:8787'
const ORIGIN = process.env.VERIFY_ORIGIN || BASE
const EMAIL = process.env.VERIFY_EMAIL
const PASSWORD = process.env.VERIFY_PASSWORD

if (!EMAIL || !PASSWORD) {
  console.error('Set VERIFY_EMAIL and VERIFY_PASSWORD before running.')
  process.exit(1)
}

// This test WRITES voters. Refuse to run against anything but localhost unless the
// caller explicitly opts in, so a stale VERIFY_BASE_URL in the shell cannot silently
// point it at production.
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(BASE)
if (!isLocal && !process.argv.includes('--allow-remote')) {
  console.error(
    `Refusing to run against non-local target "${BASE}".\n` +
      'This test creates and deletes voter rows. Unset VERIFY_BASE_URL to use localhost, ' +
      'or pass --allow-remote if you really mean it.'
  )
  process.exit(1)
}
console.log(`Target: ${BASE}\n`)

const STAMP = Date.now()
const EPICS = [`IMPTST${STAMP}A`, `IMPTST${STAMP}B`, `IMPTST${STAMP}C`]

// 8x8 solid PNG — small but a genuinely decodable raster so the thumbnailer runs.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVQoz2NkYPjPQApgYhhVMKpgVMGoAmIVAAASfgEBb+G7AwAAAABJRU5ErkJggg=='

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -> ${detail}` : ''}`)
  if (!ok) failures++
}

async function buildWorkbook() {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')

  ws.addRow(['SECTION NAME', 'PART NO', 'SECTION', 'SR NO', 'PHOTO', 'NAME', 'RELATIVE NAME', 'EPIC NO', 'AGE', 'GENDER', 'MOBILE'])
  ws.addRow(['TEST SECTION', 501, 1, 1, '', 'IMPORT TEST ALPHA', 'FATHER ALPHA', EPICS[0], 34, 'MALE', '9876543210'])
  // part/section intentionally blank to exercise carry-forward down the sheet.
  ws.addRow(['', '', '', 2, '', 'IMPORT TEST BETA', 'FATHER BETA', EPICS[1], 41, 'FEMALE', '9876543211'])
  ws.addRow(['', '', '', 3, '', 'IMPORT TEST GAMMA', '', EPICS[2], '', 'OTHER', ''])
  // duplicate EPIC in the same file -> must merge, not create a second voter.
  ws.addRow(['', '', '', 4, '', 'IMPORT TEST ALPHA', '', EPICS[0], '', '', '9998887777'])

  const imageId = wb.addImage({ base64: PNG_BASE64, extension: 'png' })
  // Anchor to row index 1 (0-based) = sheet row 2 = the ALPHA voter.
  ws.addImage(imageId, { tl: { col: 4, row: 1 }, ext: { width: 40, height: 40 } })

  return Buffer.from(await wb.xlsx.writeBuffer())
}

async function main() {
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (!signIn.ok) {
    console.error(`Sign-in failed (${signIn.status}). Is the worker running at ${BASE}?`)
    process.exit(1)
  }
  const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

  const api = async (path, init = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
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
    return { status: r.status, ok: r.ok, json, text }
  }

  // --- upload ---------------------------------------------------------------
  const xlsx = await buildWorkbook()
  const storagePath = `imports-temp/${STAMP}-import-test.xlsx`

  const upload = await api(`/storage/v1/object/import-temp/${storagePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    body: xlsx,
  })
  check('workbook uploaded to R2', upload.ok, `status ${upload.status} ${upload.text.slice(0, 150)}`)

  // --- create batch ---------------------------------------------------------
  const batchId = crypto.randomUUID()
  const created = await api('/rest/v1/import_batches', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      id: batchId,
      file_name: 'import-test.xlsx',
      storage_path: storagePath,
      status: 'queued',
      progress_percent: 5,
      progress_phase: 'uploaded',
    }),
  })
  check('import batch row created', created.status === 201, `status ${created.status} ${created.text.slice(0, 150)}`)

  // --- parse ----------------------------------------------------------------
  const parsed = await api('/api/import/parse', {
    method: 'POST',
    body: JSON.stringify({ batchId }),
  })
  check('parse succeeded', parsed.ok, `status ${parsed.status} ${parsed.text.slice(0, 250)}`)
  check('3 unique rows parsed (duplicate EPIC merged)', parsed.json?.parsedRows === 3, `got ${parsed.json?.parsedRows}`)
  check('embedded photo detected', (parsed.json?.photos ?? 0) >= 1, `got ${parsed.json?.photos}`)

  // --- commit ---------------------------------------------------------------
  let offset = 0
  let guard = 0
  for (;;) {
    const r = await api('/api/import/commit', { method: 'POST', body: JSON.stringify({ batchId, offset }) })
    if (!r.ok) {
      check('commit chunk succeeded', false, `status ${r.status} ${r.text.slice(0, 250)}`)
      break
    }
    offset = r.json.nextOffset
    if (r.json.done || ++guard > 50) break
  }
  check('all rows committed', offset === 3, `committed ${offset}`)

  // --- photos ---------------------------------------------------------------
  offset = 0
  guard = 0
  for (;;) {
    const r = await api('/api/import/photos', { method: 'POST', body: JSON.stringify({ batchId, offset }) })
    if (!r.ok) {
      check('photo chunk succeeded', false, `status ${r.status} ${r.text.slice(0, 250)}`)
      break
    }
    offset = r.json.nextOffset
    if (r.json.done || ++guard > 50) break
  }

  // --- verify ---------------------------------------------------------------
  const list = await api(`/rest/v1/voters?select=id,epic_no,name,part_no,section,section_name,age,gender,contact_no_1,photo_url&epic_no=in.(${EPICS.join(',')})`)
  const rows = Array.isArray(list.json) ? list.json : []
  check('3 voters exist after import', rows.length === 3, `found ${rows.length}`)

  const alpha = rows.find((r) => r.epic_no === EPICS[0])
  const beta = rows.find((r) => r.epic_no === EPICS[1])

  check('alpha mapped correctly', alpha?.name === 'IMPORT TEST ALPHA' && alpha?.part_no === 501, `name=${alpha?.name} part=${alpha?.part_no}`)
  check('duplicate row merged into alpha (contact filled)', alpha?.contact_no_1 === '9998887777' || alpha?.contact_no_1 === '9876543210', `contact=${alpha?.contact_no_1}`)
  check('blank part/section carried forward to beta', beta?.part_no === 501 && beta?.section === 1, `part=${beta?.part_no} section=${beta?.section}`)
  check('section name carried forward', beta?.section_name === 'TEST SECTION', `section_name=${beta?.section_name}`)
  check('gender parsed', beta?.gender === 'FEMALE', `gender=${beta?.gender}`)
  check('photo attached to the anchored row', Boolean(alpha?.photo_url), `photo_url=${alpha?.photo_url}`)

  if (alpha?.photo_url) {
    const img = await fetch(`${BASE}/media/t500/${alpha.photo_url}`, { headers: { cookie } })
    check('imported photo is served from R2', img.ok, `status ${img.status} type ${img.headers.get('content-type')}`)
  }

  const batch = await api(`/rest/v1/import_batches?select=status,progress_percent&id=eq.${batchId}`)
  const batchRow = Array.isArray(batch.json) ? batch.json[0] : null
  check('batch marked completed', batchRow?.status === 'completed', `status=${batchRow?.status}`)

  // --- cleanup --------------------------------------------------------------
  for (const row of rows) {
    await api(`/rest/v1/voters?id=eq.${row.id}`, { method: 'DELETE' })
  }
  await api(`/rest/v1/import_batches?id=eq.${batchId}`, { method: 'DELETE' })

  const after = await api(`/rest/v1/voters?select=id&epic_no=in.(${EPICS.join(',')})`)
  check('cleanup: test voters removed', (Array.isArray(after.json) ? after.json.length : -1) === 0)

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
