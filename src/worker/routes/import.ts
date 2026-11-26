import { Hono } from 'hono'
import JSZip from 'jszip'
import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env } from '../env'
import { requireUser, requireAdmin, requireWorkspace, type AuthedVars } from '../middleware/auth'
import { r2WorkspacePrefix, type WorkspaceRef } from '../lib/scope'
import type { ParsedRow } from '../lib/xlsx-parse'
import { parseWorkbook } from '../lib/xlsx-workbook'
import { indexEmbeddedImages, readImageBytes, type EmbeddedImage } from '../lib/xlsx-images'
import { makeThumbnail } from '../lib/photos'
import { refreshDashboardStats } from '../lib/dashboard-stats'
import { ensureVotersSchema } from '../lib/schema-ensure'

export const importRoutes = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

/**
 * Chunked xlsx import.
 *
 * Workers have a hard CPU limit per request, so a 16k-row sheet with embedded photos
 * cannot be processed in one call. The client drives a loop instead:
 *   parse -> (review duplicates) -> commit(offset...) -> photos(offset...)
 * Parsed rows are staged in R2 so each commit chunk does not re-parse the workbook,
 * which is both the main CPU cost and the main source of repeated R2 reads.
 */

const COMMIT_CHUNK = 400
const PHOTO_CHUNK = 20
const EPIC_LOOKUP_CHUNK = 80

function contentTypeFor(path: string): string {
  const lowered = path.toLowerCase()
  if (lowered.endsWith('.png')) return 'image/png'
  if (lowered.endsWith('.webp')) return 'image/webp'
  if (lowered.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

function stagingKey(workspace: WorkspaceRef, batchId: string): string {
  return `${r2WorkspacePrefix(workspace.org_id, workspace.id, 'imports')}staging/${batchId}.json`
}

interface StagedData {
  rows: ParsedRow[]
  images: EmbeddedImage[]
  sheetName: string
}

async function loadStaged(env: Env, workspace: WorkspaceRef, batchId: string): Promise<StagedData | null> {
  const object = await env.IMPORT_TEMP.get(stagingKey(workspace, batchId))
  if (!object) return null
  return JSON.parse(await object.text()) as StagedData
}

async function setProgress(
  env: Env,
  workspace: WorkspaceRef,
  batchId: string,
  phase: string,
  percent: number,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const columns = ['progress_phase = ?', 'progress_percent = ?']
  const values: unknown[] = [phase, Math.max(0, Math.min(100, Math.round(percent)))]

  for (const [key, value] of Object.entries(extra)) {
    columns.push(`${key} = ?`)
    values.push(value)
  }

  // Never resurrect a batch the user cancelled mid-run.
  await env.DB.prepare(
    `UPDATE import_batches SET ${columns.join(', ')} WHERE id = ? AND workspace_id = ? AND status != 'cancelled'`
  )
    .bind(...values, batchId, workspace.id)
    .run()
}

async function assertActive(env: Env, workspace: WorkspaceRef, batchId: string): Promise<{ storage_path: string } | null> {
  const row = await env.DB.prepare(
    "SELECT storage_path, status FROM import_batches WHERE id = ? AND workspace_id = ?"
  )
    .bind(batchId, workspace.id)
    .first<{ storage_path: string | null; status: string }>()

  if (!row || row.status === 'cancelled' || !row.storage_path) return null
  return { storage_path: row.storage_path }
}

// ---------------------------------------------------------------------------
// 1. Parse + duplicate preview
// ---------------------------------------------------------------------------
importRoutes.post('/api/import/parse', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const { batchId } = await c.req.json<{ batchId?: string }>()
  if (!batchId) return c.json({ error: 'batchId is required' }, 400)

  const batch = await assertActive(c.env, workspace, batchId)
  if (!batch) return c.json({ error: 'Batch not found or cancelled' }, 404)
  await ensureVotersSchema(c.env.DB)

  try {
    await setProgress(c.env, workspace, batchId, 'reading', 10, { status: 'running' })

    const file = await c.env.IMPORT_TEMP.get(batch.storage_path)
    if (!file) return c.json({ error: 'Uploaded file is no longer in storage' }, 404)

    const bytes = new Uint8Array(await file.arrayBuffer())
    await setProgress(c.env, workspace, batchId, 'parsing', 35)
    const parsed = parseWorkbook(bytes)
    const sheetName = parsed.sheetName

    if (parsed.rows.length === 0) {
      await setProgress(c.env, workspace, batchId, 'failed', 100, {
        status: 'failed',
        error_report: JSON.stringify(parsed.errors.slice(0, 500)),
      })
      return c.json({ error: parsed.errors[0]?.reason ?? 'No valid rows found', errors: parsed.errors }, 400)
    }

    // Index photos now (cheap: XML only, no image bytes) so commit/photo steps can
    // work from the staged index.
    let images: EmbeddedImage[] = []
    try {
      const zip = await JSZip.loadAsync(bytes)
      images = await indexEmbeddedImages(zip, sheetName)
    } catch (err) {
      console.error('image index failed', err)
    }

    await c.env.IMPORT_TEMP.put(
      stagingKey(workspace, batchId),
      JSON.stringify({ rows: parsed.rows, images, sheetName } satisfies StagedData),
      { httpMetadata: { contentType: 'application/json' } }
    )

    await setProgress(c.env, workspace, batchId, 'checking-duplicates', 60)

    type ExistingVoter = {
      epic_no: string
      name: string
      relative_name: string | null
      date_of_birth: string | null
      contact_no_1: string | null
      part_no: number | null
      section: number | null
      section_name: string | null
      sr_no_roll: number | null
      house_no: string | null
      age: number | null
      gender: string | null
      photo_url: string | null
      is_active: number | null
    }
    const existingByEpic = new Map<string, ExistingVoter>()
    const epics = parsed.rows.map((row) => row.epic_no)

    for (let i = 0; i < epics.length; i += EPIC_LOOKUP_CHUNK) {
      const slice = epics.slice(i, i + EPIC_LOOKUP_CHUNK)
      const placeholders = slice.map(() => '?').join(',')
      const { results } = await c.env.DB.prepare(
        `SELECT epic_no, name, relative_name, date_of_birth, contact_no_1, part_no, section,
                section_name, sr_no_roll, house_no, age, gender, photo_url, is_active
         FROM voters WHERE workspace_id = ? AND epic_no IN (${placeholders})`
      )
        .bind(workspace.id, ...slice)
        .all<ExistingVoter>()

      for (const row of results ?? []) existingByEpic.set(row.epic_no, row)
    }

    const sameText = (a: string | null | undefined, b: string | null | undefined) =>
      (a ?? '').trim() === (b ?? '').trim()
    const sameNum = (a: number | null | undefined, b: number | null | undefined) => (a ?? null) === (b ?? null)

    const duplicates = parsed.rows
      .filter((row) => existingByEpic.has(row.epic_no))
      .slice(0, 500)
      .map((row) => {
        const existing = existingByEpic.get(row.epic_no)!
        const identical =
          existing.name === row.name &&
          sameText(existing.relative_name, row.relative_name) &&
          sameNum(existing.part_no, row.part_no) &&
          sameNum(existing.section, row.section) &&
          sameText(existing.section_name, row.section_name) &&
          sameNum(existing.sr_no_roll, row.sr_no_roll) &&
          sameText(existing.house_no, row.house_no) &&
          sameNum(existing.age, row.age) &&
          sameText(existing.gender, row.gender)

        return {
          row: row.rowNumber,
          epic_no: row.epic_no,
          match_type: identical ? 'exact_duplicate' : 'will_update',
          incoming_name: row.name,
          existing_name: existing.name,
          incoming_dob: row.date_of_birth,
          existing_dob: existing.date_of_birth,
          incoming_contact_no_1: row.contact_no_1,
          existing_contact_no_1: existing.contact_no_1,
          incoming_part_no: row.part_no,
          existing_part_no: existing.part_no,
          incoming_section: row.section,
          existing_section: existing.section,
          will_reactivate: existing.is_active === 0,
        }
      })

    const newVoters = parsed.rows.filter((row) => !existingByEpic.has(row.epic_no))
    const updateCount = parsed.rows.filter((row) => existingByEpic.has(row.epic_no)).length
    const unchangedCount = duplicates.filter((row) => row.match_type === 'exact_duplicate').length
    const changedCount = updateCount - unchangedCount
    const reactivateCount = duplicates.filter((row) => row.will_reactivate).length
    const newVotersCsv = [
      'EPIC NO,NAME,PART NO,SECTION,SR AS PER ROLL,HOUSE NO,GENDER,AGE',
      ...newVoters.map((row) =>
        [row.epic_no, row.name, row.part_no ?? '', row.section ?? '', row.sr_no_roll ?? '', row.house_no ?? '', row.gender ?? '', row.age ?? '']
          .map((value) => `"${String(value).replaceAll('"', '""')}"`)
          .join(','),
      ),
    ].join('\n')

    await setProgress(c.env, workspace, batchId, 'awaiting-confirmation', 70, {
      status: 'awaiting_confirmation',
      total_rows: parsed.rows.length,
      error_report: JSON.stringify(parsed.errors.slice(0, 500)),
      duplicate_preview: JSON.stringify({
        new_count: newVoters.length,
        update_count: changedCount,
        duplicate_count: unchangedCount,
        reactivate_count: reactivateCount,
      }),
      success_report: JSON.stringify({
        parsed_rows: parsed.rows.length,
        total_data_rows: parsed.totalDataRows,
        new_rows: newVoters.length,
        update_rows: changedCount,
        unchanged_rows: unchangedCount,
        reactivate_rows: reactivateCount,
        embedded_photos: images.length,
        warnings: parsed.warnings.slice(0, 200),
        preview_duplicates: duplicates,
        new_voters: newVoters.slice(0, 2000).map((row) => ({
          epic_no: row.epic_no,
          name: row.name,
          part_no: row.part_no,
          section: row.section,
          sr_no_roll: row.sr_no_roll,
        })),
        new_voters_csv: newVotersCsv,
      }),
    })

    return c.json({
      ok: true,
      parsedRows: parsed.rows.length,
      newRows: newVoters.length,
      updateRows: changedCount,
      unchangedRows: unchangedCount,
      reactivateRows: reactivateCount,
      photos: images.length,
      errors: parsed.errors.length,
      warnings: parsed.warnings.length,
    })
  } catch (err) {
    console.error('import parse failed', err)
    await setProgress(c.env, workspace, batchId, 'failed', 100, {
      status: 'failed',
      error_report: JSON.stringify([{ row: 0, reason: err instanceof Error ? err.message : 'Parse failed' }]),
    })
    return c.json({ error: err instanceof Error ? err.message : 'Parse failed' }, 500)
  }
})

// ---------------------------------------------------------------------------
// 2. Commit rows (one chunk per call)
// ---------------------------------------------------------------------------
const UPSERT_COLUMNS = [
  'epic_no', 'name', 'relative_name', 'relative_relation', 'section_name', 'part_no',
  'section', 'sr_no_roll', 'house_no', 'age', 'date_of_birth', 'contact_no_1',
  'contact_no_2', 'gender', 'religion', 'state', 'family_head_epic',
] as const

importRoutes.post('/api/import/commit', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const profile = c.get('profile')
  const { batchId, offset = 0 } = await c.req.json<{ batchId?: string; offset?: number }>()
  if (!batchId) return c.json({ error: 'batchId is required' }, 400)

  const batch = await assertActive(c.env, workspace, batchId)
  if (!batch) return c.json({ error: 'Batch not found or cancelled' }, 404)
  await ensureVotersSchema(c.env.DB)

  const staged = await loadStaged(c.env, workspace, batchId)
  if (!staged) return c.json({ error: 'Staged data missing; re-run parse' }, 409)

  const slice = staged.rows.slice(offset, offset + COMMIT_CHUNK)
  if (slice.length === 0) {
    return c.json({ done: true, nextOffset: offset, written: 0 })
  }

  const now = new Date().toISOString()

  // COALESCE keeps existing values when the sheet leaves a field blank, so a partial
  // sheet cannot wipe contacts, family, category, or photos already on the voter.
  // A voter who reappears on the roll is reactivated without touching assignments.
  const updateSet = UPSERT_COLUMNS.filter((col) => col !== 'epic_no')
    .map((col) => (col === 'name' ? 'name = excluded.name' : `${col} = COALESCE(excluded.${col}, voters.${col})`))
    .join(', ')

  const sql = `INSERT INTO voters (id, org_id, workspace_id, ${UPSERT_COLUMNS.join(', ')}, is_active, disabled_at, disabled_reason, created_at, updated_at, updated_by)
     VALUES (${['?', '?', '?', ...UPSERT_COLUMNS.map(() => '?'), '1', 'NULL', 'NULL', '?', '?', '?'].join(', ')})
     ON CONFLICT(workspace_id, epic_no) DO UPDATE SET ${updateSet}, is_active = 1, disabled_at = NULL, disabled_reason = NULL, updated_at = excluded.updated_at, updated_by = excluded.updated_by`

  const statement = c.env.DB.prepare(sql)
  const batchStatements = slice.map((row) =>
    statement.bind(
      crypto.randomUUID(),
      workspace.org_id,
      workspace.id,
      ...UPSERT_COLUMNS.map((col) => (row as unknown as Record<string, unknown>)[col] ?? null),
      now,
      now,
      profile.id
    )
  )

  try {
    await c.env.DB.batch(batchStatements)
  } catch (err) {
    console.error('import commit failed', err)
    await setProgress(c.env, workspace, batchId, 'failed', 100, {
      status: 'failed',
      error_report: JSON.stringify([{ row: offset, reason: err instanceof Error ? err.message : 'Commit failed' }]),
    })
    return c.json({ error: err instanceof Error ? err.message : 'Commit failed' }, 500)
  }

  const nextOffset = offset + slice.length
  const done = nextOffset >= staged.rows.length
  const percent = 70 + Math.round((nextOffset / Math.max(staged.rows.length, 1)) * 20)

  await setProgress(c.env, workspace, batchId, done ? 'rows-committed' : 'committing', percent, {
    success_count: nextOffset,
  })

  return c.json({
    done,
    nextOffset,
    written: slice.length,
    total: staged.rows.length,
    photos: staged.images.length,
  })
})

// ---------------------------------------------------------------------------
// 3. Photos (one chunk per call)
// ---------------------------------------------------------------------------
importRoutes.post('/api/import/photos', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const { batchId, offset = 0 } = await c.req.json<{ batchId?: string; offset?: number }>()
  if (!batchId) return c.json({ error: 'batchId is required' }, 400)

  const batch = await assertActive(c.env, workspace, batchId)
  if (!batch) return c.json({ error: 'Batch not found or cancelled' }, 404)

  const staged = await loadStaged(c.env, workspace, batchId)
  if (!staged) return c.json({ error: 'Staged data missing; re-run parse' }, 409)

  const slice = staged.images.slice(offset, offset + PHOTO_CHUNK)
  if (slice.length === 0) {
    await setProgress(c.env, workspace, batchId, 'completed', 100, { status: 'completed' })
    await c.env.IMPORT_TEMP.delete(stagingKey(workspace, batchId))
    await refreshDashboardStats(c.env.DB, workspace.id, workspace.org_id)
    return c.json({ done: true, nextOffset: offset, processed: 0 })
  }

  const file = await c.env.IMPORT_TEMP.get(batch.storage_path)
  if (!file) return c.json({ error: 'Uploaded file is no longer in storage' }, 404)

  const zip = await JSZip.loadAsync(new Uint8Array(await file.arrayBuffer()))
  const epicByRow = new Map(staged.rows.map((row) => [row.rowNumber, row.epic_no]))

  let processed = 0
  let skipped = 0
  const updates: D1PreparedStatement[] = []

  for (const image of slice) {
    const epic = epicByRow.get(image.rowNumber)
    if (!epic) {
      skipped += 1
      continue
    }

    const bytes = await readImageBytes(zip, image.path)
    if (!bytes) {
      skipped += 1
      continue
    }

    const key = `epic/${epic}.png`
    const photoPrefix = r2WorkspacePrefix(workspace.org_id, workspace.id, 'photos')

    // Some sheets embed non-raster drawings (EMF) mislabelled as images; store the
    // original rather than failing the whole import.
    let thumbnail: Uint8Array = bytes
    let thumbnailed = true
    try {
      thumbnail = makeThumbnail(bytes)
    } catch {
      thumbnailed = false
    }

    await c.env.PHOTOS.put(`${photoPrefix}orig/${key}`, bytes as unknown as ArrayBuffer, {
      httpMetadata: { contentType: contentTypeFor(image.path) },
    })
    await c.env.PHOTOS.put(`${photoPrefix}t500/${key}`, thumbnail as unknown as ArrayBuffer, {
      httpMetadata: { contentType: thumbnailed ? 'image/webp' : contentTypeFor(image.path) },
    })

    updates.push(
      c.env.DB.prepare('UPDATE voters SET photo_url = ?, updated_at = ? WHERE workspace_id = ? AND epic_no = ?').bind(
        key,
        new Date().toISOString(),
        workspace.id,
        epic
      )
    )
    processed += 1
  }

  if (updates.length > 0) await c.env.DB.batch(updates)

  const nextOffset = offset + slice.length
  const done = nextOffset >= staged.images.length
  const percent = 90 + Math.round((nextOffset / Math.max(staged.images.length, 1)) * 10)

  if (done) {
    await setProgress(c.env, workspace, batchId, 'completed', 100, { status: 'completed' })
    await c.env.IMPORT_TEMP.delete(stagingKey(workspace, batchId))
    await refreshDashboardStats(c.env.DB, workspace.id, workspace.org_id)
  } else {
    await setProgress(c.env, workspace, batchId, 'photos', percent)
  }

  return c.json({ done, nextOffset, processed, skipped, total: staged.images.length })
})

// ---------------------------------------------------------------------------
// 4. Direct photo upload by EPIC (folder import)
// ---------------------------------------------------------------------------
const MAX_PHOTO_BYTES = 10 * 1024 * 1024

/**
 * Uploads a single profile image and attaches it to the matching voter.
 * The browser posts bytes straight here, so images never make a round trip through
 * a temp bucket the way the old Edge Function required.
 */
importRoutes.put('/api/import/photo/:epic', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const epic = (c.req.param('epic') ?? '').trim().toUpperCase()
  if (!epic) return c.json({ error: 'epic is required' }, 400)

  const voter = await c.env.DB.prepare('SELECT id FROM voters WHERE workspace_id = ? AND epic_no = ?')
    .bind(workspace.id, epic)
    .first()
  if (!voter) return c.json({ status: 'not_found', epic }, 404)

  const body = await c.req.arrayBuffer()
  if (body.byteLength === 0) return c.json({ error: 'Empty file' }, 400)
  if (body.byteLength > MAX_PHOTO_BYTES) return c.json({ error: 'File too large' }, 413)

  const bytes = new Uint8Array(body)
  const key = `epic/${epic}.png`
  const photoPrefix = r2WorkspacePrefix(workspace.org_id, workspace.id, 'photos')

  let thumbnail: Uint8Array = bytes
  let thumbnailed = true
  try {
    thumbnail = makeThumbnail(bytes)
  } catch {
    thumbnailed = false
  }

  await c.env.PHOTOS.put(`${photoPrefix}orig/${key}`, bytes as unknown as ArrayBuffer, {
    httpMetadata: { contentType: c.req.header('content-type') || 'image/jpeg' },
  })
  await c.env.PHOTOS.put(`${photoPrefix}t500/${key}`, thumbnail as unknown as ArrayBuffer, {
    httpMetadata: { contentType: thumbnailed ? 'image/webp' : c.req.header('content-type') || 'image/jpeg' },
  })

  await c.env.DB.prepare('UPDATE voters SET photo_url = ?, updated_at = ? WHERE workspace_id = ? AND epic_no = ?')
    .bind(key, new Date().toISOString(), workspace.id, epic)
    .run()

  return c.json({ status: 'ok', epic, thumbnailed })
})

// ---------------------------------------------------------------------------
// 5. Cancel
// ---------------------------------------------------------------------------
importRoutes.post('/api/import/cancel', requireUser, requireWorkspace, requireAdmin, async (c) => {
  const workspace = c.get('workspace')!
  const { batchId } = await c.req.json<{ batchId?: string }>()
  if (!batchId) return c.json({ error: 'batchId is required' }, 400)

  await c.env.DB.prepare(
    "UPDATE import_batches SET status = 'cancelled', progress_phase = 'cancelled' WHERE id = ? AND workspace_id = ?"
  )
    .bind(batchId, workspace.id)
    .run()

  await c.env.IMPORT_TEMP.delete(stagingKey(workspace, batchId))
  return c.json({ ok: true })
})
