import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { AlertCircle, CheckCircle2, Clock3, FileUp, FileSpreadsheet, Loader2, XCircle } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { supabase } from '../../lib/supabase'
import type { ImportBatch } from '../../lib/types'
import { FAST_NAV_CACHE_MAX_AGE_MS, readCachedCollection, writeCachedCollection } from '../../lib/voterCache'
import { fetchApiJson } from '../../lib/d1Query'
import { invalidateVoterCache } from '../../lib/voterDataset'
import { parseWorkbook } from '../../worker/lib/xlsx-workbook'

const IMPORT_BATCHES_CACHE_KEY = 'vote:admin:import-batches'

const ROLL_UPDATE_TEMPLATE_CSV =
  'PART NO,VoterSerial,EPIC NO,NAME,RELATIVE NAME,HOUSE NO,SECTION,SECTION NAME,AGE,GENDER\n' +
  '1,1,ABC1234567,Sample Voter,Relative Name,3/1,1,Sample Section,32,MALE\n'

const FULL_IMPORT_TEMPLATE_CSV =
  'SECTION NAME,PART NO,SECTION,SR AS PER ROLL,PHOTO,NAME,RELATIVE NAME,RELATIVE RELATION,EPIC NO,HOUSE NO.,AGE,DATE OF BIRTH,CONTACT NO 1,CONTACT NO 2 (OLD DATA),GENDER,RELIGION,STATE,family status\n' +
  'Sample Section,12,3,101,,Sample Voter,Relative Name,FATHER,ABC1234567,3/1,32,1994-01-20,9876543210,,MALE,HINDU,State Name,ABC1234567\n'

/**
 * The import runs as a client-driven loop. Workers cap CPU per request, so the server
 * exposes parse/commit/photos steps that each handle one chunk and report the next
 * offset; this walks those steps to completion.
 */
async function importApi<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!res.ok) {
    throw new Error((payload as { error?: string } | null)?.error ?? `Request failed (${res.status})`)
  }

  return payload as T
}

async function runChunked(
  path: string,
  batchId: string,
  onProgress: (offset: number, total: number) => void
): Promise<void> {
  let offset = 0
  for (;;) {
    const result = await importApi<{ done: boolean; nextOffset: number; total?: number }>(path, {
      batchId,
      offset,
    })
    offset = result.nextOffset
    onProgress(offset, result.total ?? 0)
    if (result.done) return
  }
}

const phaseOrder = ['queued', 'uploaded', 'downloading', 'parsing', 'extracting_images', 'validating', 'awaiting_confirmation', 'writing', 'done', 'cancelled']

function phaseState(current: string, phase: string): 'done' | 'active' | 'upcoming' {
  const currentIndex = phaseOrder.indexOf(current)
  const phaseIndex = phaseOrder.indexOf(phase)
  if (phaseIndex < 0 || currentIndex < 0) {
    return 'upcoming'
  }

  if (phaseIndex < currentIndex) {
    return 'done'
  }
  if (phaseIndex === currentIndex) {
    return 'active'
  }
  return 'upcoming'
}

function toCsvDownload(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function isDuplicatePreviewRow(value: unknown): value is {
  row: number
  epic_no: string
  match_type: 'exact_duplicate' | 'will_update'
  incoming_name: string
  existing_name: string | null
  incoming_dob: string | null
  existing_dob: string | null
  incoming_contact_no_1: string | null
  existing_contact_no_1: string | null
  incoming_part_no: number | null
  existing_part_no: number | null
  incoming_section: number | null
  existing_section: number | null
} {
  if (!value || typeof value !== 'object') {
    return false
  }

  const row = value as Record<string, unknown>
  return typeof row.row === 'number' && typeof row.epic_no === 'string' && typeof row.match_type === 'string'
}

export function ImportDataPage() {
  const [file, setFile] = useState<File | null>(null)
  const [imageFiles, setImageFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadingImages, setUploadingImages] = useState(false)
  const [imageImportProgress, setImageImportProgress] = useState({
    phase: 'idle' as 'idle' | 'uploading' | 'importing' | 'done' | 'failed',
    totalSelected: 0,
    uploadedTemp: 0,
    queuedForImport: 0,
    chunkIndex: 0,
    chunkTotal: 0,
    processed: 0,
    matched: 0,
    failed: 0,
  })
  const [imageImportLog, setImageImportLog] = useState<Array<{ epicNo: string; status: string; message?: string }>>([])
  const [batches, setBatches] = useState<ImportBatch[]>([])
  const [loadingBatches, setLoadingBatches] = useState(true)
  const [cancellingBatchId, setCancellingBatchId] = useState<string | null>(null)
  const [disableEpicText, setDisableEpicText] = useState('')
  const [disableReason, setDisableReason] = useState('Removed from electoral roll')
  const [disablePreview, setDisablePreview] = useState<{
    requested: number
    found: number
    notFound: string[]
    alreadyDisabled?: number
    changeCount: number
    voters: Array<{ epic_no: string; name: string; part_no: number | null; section: number | null }>
  } | null>(null)
  const [disableBusy, setDisableBusy] = useState<'preview' | 'disable' | null>(null)

  const parseEpicTokens = (text: string): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const token of text.split(/[\s,;]+/)) {
      const epic = token.trim().toUpperCase()
      if (epic.length < 3 || seen.has(epic)) continue
      seen.add(epic)
      out.push(epic)
    }
    return out
  }

  useEffect(() => {
    const cached = readCachedCollection<ImportBatch>(IMPORT_BATCHES_CACHE_KEY, 'global', FAST_NAV_CACHE_MAX_AGE_MS)
    if (cached) {
      setBatches(cached)
      setLoadingBatches(false)
    }
  }, [])

  const extractEpicFromFileName = (name: string) => {
    const base = name.replace(/\.[^.]+$/, '').trim().toUpperCase()
    const compact = base.replace(/[^A-Z0-9]/g, '')
    const strictEpic = compact.match(/[A-Z]{3}\d{7}/)
    if (strictEpic) {
      return strictEpic[0]
    }

    return compact
  }

  const loadBatches = async () => {
    setLoadingBatches(true)
    const { data, error } = await supabase
      .from('import_batches')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) {
      toast.error(error.message)
      setLoadingBatches(false)
      return
    }

    const rows = (data as ImportBatch[] | null) ?? []
    setBatches(rows)
    writeCachedCollection<ImportBatch>(IMPORT_BATCHES_CACHE_KEY, 'global', rows)
    setLoadingBatches(false)
  }

  useEffect(() => {
    void loadBatches()
  }, [])

  const activeBatch = useMemo(
    () => batches.find((batch) => batch.status === 'running' || batch.status === 'awaiting_confirmation' || batch.status === 'queued'),
    [batches],
  )

  const activeBatchDuplicateRows = useMemo(() => {
    if (!activeBatch?.success_report?.preview_duplicates || !Array.isArray(activeBatch.success_report.preview_duplicates)) {
      return []
    }

    return activeBatch.success_report.preview_duplicates.filter(isDuplicatePreviewRow)
  }, [activeBatch])

  useEffect(() => {
    if (!activeBatch) {
      return
    }

    const timer = setInterval(() => {
      void loadBatches()
    }, 3000)

    return () => clearInterval(timer)
  }, [activeBatch, activeBatch?.id])

  const handleUpload = async () => {
    if (!file) {
      toast.error('Select an .xlsx file first.')
      return
    }

    setUploading(true)

    try {
      const bytes = await file.arrayBuffer()
      const localParsed = parseWorkbook(bytes)
      if (!localParsed.rows.length) {
        throw new Error(localParsed.errors[0]?.reason ?? 'No valid rows found')
      }

      const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_')
      const filePath = `imports-temp/${Date.now()}-${safeName}`
      const uploadRes = await fetch(`/storage/v1/object/import-temp/${filePath}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        body: file,
      })
      if (!uploadRes.ok) {
        const payload = await uploadRes.json().catch(() => null) as { message?: string; error?: string } | null
        throw new Error(payload?.message ?? payload?.error ?? `Upload failed (${uploadRes.status})`)
      }

      const { data: batch, error: batchError } = await supabase
        .from('import_batches')
        .insert({
          id: crypto.randomUUID(),
          file_name: file.name,
          storage_path: filePath,
          status: 'queued',
          progress_percent: 5,
          progress_phase: 'uploaded',
        })
        .select('id')
        .single()

      if (batchError || !batch) throw new Error(batchError?.message ?? 'Unable to create import batch.')

      const summary = await importApi<{
        parsedRows: number
        newRows: number
        updateRows: number
        unchangedRows?: number
        photos: number
      }>('/api/import/parse', { batchId: batch.id })

      toast.success(
        `Parsed ${summary.parsedRows} rows (${summary.newRows} new, ${summary.updateRows} updates, ${summary.unchangedRows ?? 0} unchanged). Review and confirm below.`
      )
      await loadBatches()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const confirmCommit = async (batch: ImportBatch) => {
    const progressToast = toast.loading('Writing voters...')

    try {
      await runChunked('/api/import/commit', batch.id, (offset, total) => {
        toast.loading(`Writing voters ${offset}/${total || '?'}...`, { id: progressToast })
      })

      toast.loading('Importing embedded photos...', { id: progressToast })
      await runChunked('/api/import/photos', batch.id, (offset, total) => {
        toast.loading(`Photos ${offset}/${total || '?'}...`, { id: progressToast })
      })

      toast.success('Import completed.', { id: progressToast })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed', { id: progressToast })
    }

    await loadBatches()
  }

  const cancelBatch = async (batch: ImportBatch) => {
    if (batch.status === 'completed' || batch.status === 'failed') {
      return
    }

    setCancellingBatchId(batch.id)
    try {
      await importApi('/api/import/cancel', { batchId: batch.id })
      toast.success(`Cancelled import for ${batch.file_name}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Cancel failed')
    } finally {
      setCancellingBatchId(null)
    }

    await loadBatches()
  }

  const handleImageFolderImport = async () => {
    if (!imageFiles.length) {
      toast.error('Select an image folder first.')
      return
    }

    setUploadingImages(true)
    setImageImportLog([])

    const candidates = imageFiles
      .filter((entry) => entry.type.startsWith('image/'))
      .map((entry) => {
        const relativeName = (entry as File & { webkitRelativePath?: string }).webkitRelativePath || entry.name
        const fileName = relativeName.split('/').pop() || entry.name
        return { entry, epicNo: extractEpicFromFileName(fileName) }
      })
      .filter((item) => Boolean(item.epicNo))

    setImageImportProgress({
      phase: 'importing',
      totalSelected: imageFiles.length,
      uploadedTemp: 0,
      queuedForImport: candidates.length,
      chunkIndex: 0,
      chunkTotal: candidates.length,
      processed: 0,
      matched: 0,
      failed: 0,
    })

    if (candidates.length === 0) {
      setUploadingImages(false)
      setImageImportProgress((current) => ({ ...current, phase: 'failed' }))
      toast.error('No image files with a recognisable EPIC in the filename.')
      return
    }

    let matchedTotal = 0
    let failedTotal = 0
    let processedTotal = 0
    let cursor = 0

    // Bounded concurrency: enough to keep the pipeline busy without opening hundreds
    // of parallel Worker invocations (which is what drives cost up).
    const CONCURRENCY = 4

    const worker = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= candidates.length) return

        const { entry, epicNo } = candidates[index]

        try {
          const res = await fetch(`/api/import/photo/${encodeURIComponent(epicNo)}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': entry.type || 'application/octet-stream' },
            body: entry,
          })

          if (res.ok) {
            matchedTotal += 1
          } else {
            failedTotal += 1
            const payload = await res.json().catch(() => null)
            const message = res.status === 404 ? 'No voter with this EPIC' : payload?.error ?? `HTTP ${res.status}`
            setImageImportLog((current) => [{ epicNo, status: 'failed', message }, ...current].slice(0, 30))
          }
        } catch (error) {
          failedTotal += 1
          setImageImportLog((current) =>
            [{ epicNo, status: 'failed', message: error instanceof Error ? error.message : 'Upload failed' }, ...current].slice(0, 30)
          )
        }

        processedTotal += 1
        setImageImportProgress((current) => ({
          ...current,
          chunkIndex: processedTotal,
          processed: processedTotal,
          matched: matchedTotal,
          failed: failedTotal,
        }))
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker))

    setUploadingImages(false)
    setImageImportProgress((current) => ({ ...current, phase: 'done' }))
    toast.success(`Image import done. Matched ${matchedTotal}, failed ${failedTotal}.`)
    await loadBatches()
  }

  const handleDisablePreview = async () => {
    const epics = parseEpicTokens(disableEpicText)
    if (!epics.length) {
      toast.error('Paste at least one EPIC number.')
      return
    }
    setDisableBusy('preview')
    try {
      const preview = await fetchApiJson<{
        requested: number
        found: number
        notFound: string[]
        alreadyDisabled?: number
        changeCount: number
        voters: Array<{ epic_no: string; name: string; part_no: number | null; section: number | null }>
      }>('/api/voters/bulk-disable/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epics }),
      })
      setDisablePreview(preview)
      if (!preview.changeCount) {
        toast.error(preview.notFound.length ? `None active. Missing: ${preview.notFound.slice(0, 8).join(', ')}` : 'Those EPICs are already disabled.')
        return
      }
      toast.success(`Ready to disable ${preview.changeCount} voter${preview.changeCount === 1 ? '' : 's'}. Team-leader assignments stay.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not preview disable.')
    } finally {
      setDisableBusy(null)
    }
  }

  const handleDisableEpics = async () => {
    const epics = parseEpicTokens(disableEpicText)
    if (!epics.length) {
      toast.error('Paste at least one EPIC number.')
      return
    }
    setDisableBusy('disable')
    try {
      const preview = disablePreview ?? await fetchApiJson<{
        requested: number
        found: number
        notFound: string[]
        alreadyDisabled?: number
        changeCount: number
        voters: Array<{ epic_no: string; name: string; part_no: number | null; section: number | null }>
      }>('/api/voters/bulk-disable/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epics }),
      })
      setDisablePreview(preview)
      if (!preview.changeCount) {
        toast.error('None of those EPICs are active.')
        setDisableBusy(null)
        return
      }
      if (!window.confirm(`Disable ${preview.changeCount} voter${preview.changeCount === 1 ? '' : 's'}? They stay in the database with assignments intact.`)) {
        setDisableBusy(null)
        return
      }
      const result = await fetchApiJson<{ changeCount: number }>('/api/voters/bulk-disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epics, reason: disableReason }),
      })
      await invalidateVoterCache()
      toast.success(`Disabled ${result.changeCount} voter${result.changeCount === 1 ? '' : 's'}.`)
      setDisableEpicText('')
      setDisablePreview(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Disable failed')
    } finally {
      setDisableBusy(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Import Data"
        description="Part-wise roll update by EPIC. Existing voters keep family, team-leader, contacts, and photos. Disabled voters who reappear are reactivated."
      />

      <section className="rounded-xl border border-line bg-white p-4">
        <div className="rounded-xl border border-dashed border-line bg-muted p-6">
          <p className="text-sm font-semibold text-ink">Part-wise roll update</p>
          <p className="mt-1 text-sm text-ink-secondary">
            Upload one part at a time. Match is by EPIC. Blank cells do not wipe existing data. Photos are not required in this file.
          </p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-white">
            <table className="min-w-full text-xs">
              <thead className="bg-muted text-ink-tertiary">
                <tr>
                  <th className="px-2 py-1.5 text-left">Your column</th>
                  <th className="px-2 py-1.5 text-left">Header to use</th>
                  <th className="px-2 py-1.5 text-left">Required</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Part_No', 'PART NO', 'Yes'],
                  ['VoterSerial', 'VoterSerial or SR AS PER ROLL', 'Yes'],
                  ['EPIC', 'EPIC NO', 'Yes (match key)'],
                  ['Name', 'NAME', 'Yes'],
                  ['Relative', 'RELATIVE NAME', 'Yes'],
                  ['House No', 'HOUSE NO', 'Recommended'],
                  ['Section No', 'SECTION', 'Yes'],
                  ['Section Name', 'SECTION NAME', 'Yes'],
                  ['Age', 'AGE', 'Yes'],
                  ['Gender', 'GENDER (MALE / FEMALE / OTHER)', 'Yes'],
                ].map(([from, header, required]) => (
                  <tr key={header} className="border-t border-line">
                    <td className="px-2 py-1 text-ink-secondary">{from}</td>
                    <td className="px-2 py-1 font-medium text-ink">{header}</td>
                    <td className="px-2 py-1 text-ink-secondary">{required}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm">
              <FileSpreadsheet className="h-4 w-4" />
              Choose .xlsx
              <input
                className="hidden"
                type="file"
                accept=".xlsx"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <span className="text-sm text-ink-secondary">{file?.name ?? 'No file selected'}</span>
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white disabled:opacity-60"
              onClick={handleUpload}
              disabled={uploading}
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
              {uploading ? 'Uploading...' : 'Upload + Run Preview'}
            </button>
            <button
              type="button"
              className="inline-flex h-11 items-center rounded-xl border border-line px-4 text-sm"
              onClick={() => toCsvDownload('voter-roll-update-template.csv', ROLL_UPDATE_TEMPLATE_CSV)}
            >
              Download roll-update template
            </button>
            <button
              type="button"
              className="inline-flex h-11 items-center rounded-xl border border-line px-4 text-sm"
              onClick={() => toCsvDownload('voter-import-template.csv', FULL_IMPORT_TEMPLATE_CSV)}
            >
              Full import template
            </button>
          </div>
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white p-4">
        <div className="rounded-xl border border-dashed border-line bg-muted p-6">
          <p className="text-sm font-semibold text-ink">Bulk Profile Image Import</p>
          <p className="mt-1 text-sm text-ink-secondary">
            Choose a folder of images where file name is EPIC number. Example: ABC1234567.jpg
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm">
              <FileUp className="h-4 w-4" />
              Choose image folder
              <input
                className="hidden"
                type="file"
                multiple
                accept="image/*"
                onChange={(event) => setImageFiles(Array.from(event.target.files ?? []))}
                webkitdirectory=""
                directory=""
              />
            </label>
            <span className="text-sm text-ink-secondary">{imageFiles.length ? `${imageFiles.length} images selected` : 'No folder selected'}</span>
          </div>

          <div className="mt-4">
            <button
              type="button"
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white disabled:opacity-60"
              onClick={handleImageFolderImport}
              disabled={uploadingImages}
            >
              {uploadingImages ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
              {uploadingImages ? 'Uploading images...' : 'Import Folder Images'}
            </button>
          </div>

          {imageImportProgress.phase !== 'idle' ? (
            <div className="mt-4 rounded-xl border border-line bg-white p-3">
              <p className="text-sm font-semibold text-ink">Live Bulk Image Import</p>
              <p className="mt-1 text-sm text-ink-secondary">
                Status: {imageImportProgress.phase} · Uploaded to temp: {imageImportProgress.uploadedTemp}/{imageImportProgress.totalSelected}
              </p>
              <p className="text-sm text-ink-secondary">
                Queue: {imageImportProgress.processed}/{imageImportProgress.queuedForImport} · Matched: {imageImportProgress.matched} · Failed: {imageImportProgress.failed}
              </p>
              {imageImportProgress.chunkTotal > 0 ? (
                <p className="text-xs text-ink-tertiary">
                  Chunk {imageImportProgress.chunkIndex}/{imageImportProgress.chunkTotal}
                </p>
              ) : null}

              {imageImportProgress.queuedForImport > 0 ? (
                <progress className="mt-2 h-2 w-full" value={imageImportProgress.processed} max={imageImportProgress.queuedForImport} />
              ) : null}

              {imageImportLog.length ? (
                <div className="mt-3 max-h-40 overflow-auto rounded-lg border border-line">
                  <table className="min-w-full text-xs">
                    <thead className="bg-muted text-ink-tertiary">
                      <tr>
                        <th className="px-2 py-1 text-left">EPIC</th>
                        <th className="px-2 py-1 text-left">Status</th>
                        <th className="px-2 py-1 text-left">Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {imageImportLog.map((item, index) => (
                        <tr key={`${item.epicNo}-${item.status}-${index}`} className="border-t border-line">
                          <td className="px-2 py-1 text-ink-secondary">{item.epicNo}</td>
                          <td className="px-2 py-1 text-ink-secondary">{item.status}</td>
                          <td className="px-2 py-1 text-ink-tertiary">{item.message ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white p-4">
        <div className="rounded-xl border border-dashed border-line bg-muted p-6">
          <p className="text-sm font-semibold text-ink">Disable voters by EPIC</p>
          <p className="mt-1 text-sm text-ink-secondary">
            Paste EPICs removed from the roll. They stay in the database with family, groups, and team-leader assignments. They drop out of live lists and counts.
          </p>
          <textarea
            className="mt-3 min-h-28 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
            placeholder={'ABC1234567\nXYZ9876543'}
            value={disableEpicText}
            onChange={(event) => {
              setDisableEpicText(event.target.value)
              setDisablePreview(null)
            }}
          />
          <input
            className="mt-2 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm"
            placeholder="Reason (optional)"
            value={disableReason}
            onChange={(event) => setDisableReason(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="h-10 rounded-lg border border-line bg-white px-3 text-sm font-semibold text-ink-secondary disabled:opacity-60"
              onClick={() => void handleDisablePreview()}
              disabled={disableBusy !== null}
            >
              {disableBusy === 'preview' ? 'Previewing...' : 'Preview'}
            </button>
            <button
              type="button"
              className="h-10 rounded-lg border border-amber-200 bg-amber-50 px-3 text-sm font-semibold text-amber-800 disabled:opacity-60"
              onClick={() => void handleDisableEpics()}
              disabled={disableBusy !== null}
            >
              {disableBusy === 'disable' ? 'Disabling...' : 'Disable EPICs'}
            </button>
          </div>
          {disablePreview ? (
            <div className="mt-3 rounded-lg border border-line bg-white p-3 text-sm text-ink-secondary">
              <p>
                {disablePreview.changeCount} voter{disablePreview.changeCount === 1 ? '' : 's'} will be disabled
                {disablePreview.alreadyDisabled ? ` · ${disablePreview.alreadyDisabled} already disabled` : ''}
                {disablePreview.notFound.length ? ` · ${disablePreview.notFound.length} not found` : ''}.
              </p>
              {disablePreview.voters.length ? (
                <p className="mt-2 text-xs text-ink-tertiary">
                  {disablePreview.voters.slice(0, 12).map((row) => row.epic_no).join(', ')}
                  {disablePreview.voters.length > 12 ? '…' : ''}
                </p>
              ) : null}
              {disablePreview.notFound.length ? (
                <p className="mt-2 text-amber-700">Not found: {disablePreview.notFound.slice(0, 12).join(', ')}{disablePreview.notFound.length > 12 ? '…' : ''}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white p-4">
        <h2 className="text-lg font-semibold text-ink">Live Import Timeline</h2>
        {!activeBatch ? <p className="mt-2 text-sm text-ink-secondary">No active import job.</p> : null}

        {activeBatch ? (
          <div className="mt-3 space-y-3">
            <div className="flex justify-end">
              {activeBatch.status === 'running' || activeBatch.status === 'awaiting_confirmation' || activeBatch.status === 'queued' ? (
                <button
                  type="button"
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 text-xs font-semibold text-rose-700 disabled:opacity-60"
                  onClick={() => void cancelBatch(activeBatch)}
                  disabled={cancellingBatchId === activeBatch.id}
                >
                  {cancellingBatchId === activeBatch.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                  {cancellingBatchId === activeBatch.id ? 'Cancelling...' : 'Cancel Import'}
                </button>
              ) : null}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-brand-500" style={{ width: `${activeBatch.progress_percent}%` }} />
            </div>
            <p className="text-sm text-ink-secondary">
              {activeBatch.progress_phase} · {activeBatch.progress_percent}%
            </p>

            {activeBatch.photo_match_report ? (
              <div className="rounded-xl border border-line bg-muted p-3">
                <p className="text-sm font-semibold text-ink">Image Import Queue</p>
                <p className="mt-1 text-sm text-ink-secondary">
                  Total: {activeBatch.photo_match_report.total ?? activeBatch.photo_match_report.matched_rows ?? 0} · Queued: {activeBatch.photo_match_report.queued ?? 0} · Processed: {activeBatch.photo_match_report.processed ?? 0}
                </p>
                <p className="text-sm text-ink-secondary">
                  Matched: {activeBatch.photo_match_report.matched ?? 0} · Failed: {activeBatch.photo_match_report.failed ?? 0}
                </p>
              </div>
            ) : null}

            <ol className="flex flex-wrap items-center gap-2">
              {phaseOrder.filter((phase) => phase !== 'cancelled').map((phase, index, list) => {
                const state = phaseState(activeBatch.progress_phase, phase)
                return (
                  <li key={phase} className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.04em] ${
                        state === 'active'
                          ? 'border-brand-200 bg-brand-50 text-brand-700'
                          : state === 'done'
                            ? 'border-[var(--success-border)] bg-[var(--success-fill)] text-[var(--success)]'
                            : 'border-line bg-white text-ink-tertiary'
                      }`}
                    >
                      {state === 'done' ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
                      {state === 'active' ? <Clock3 className="h-3.5 w-3.5" /> : null}
                      {phase.replace(/_/g, ' ')}
                    </span>
                    {index < list.length - 1 ? <span className="text-ink-tertiary">/</span> : null}
                  </li>
                )
              })}
            </ol>

            {activeBatch.status === 'awaiting_confirmation' ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm font-medium text-amber-800">Roll update preview</p>
                <p className="mt-1 text-sm text-amber-700">
                  New: {activeBatch.success_report?.new_rows ?? activeBatch.duplicate_preview?.new_count ?? 0}
                  {' '}· Updates: {activeBatch.success_report?.update_rows ?? activeBatch.duplicate_preview?.update_count ?? 0}
                  {' '}· Unchanged: {activeBatch.success_report?.unchanged_rows ?? activeBatch.duplicate_preview?.duplicate_count ?? 0}
                  {' '}· Reactivate: {activeBatch.success_report?.reactivate_rows ?? activeBatch.duplicate_preview?.reactivate_count ?? 0}
                </p>
                {activeBatch.success_report?.new_voters_csv ? (
                  <button
                    type="button"
                    className="mt-2 mr-2 inline-flex h-9 items-center rounded-lg border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-800"
                    onClick={() =>
                      toCsvDownload(
                        `new-voters-need-photos-${activeBatch.id}.csv`,
                        activeBatch.success_report?.new_voters_csv ?? '',
                      )
                    }
                  >
                    Download new voters (need photos)
                  </button>
                ) : null}
                {activeBatch.success_report?.preview_duplicates_csv ? (
                  <button
                    type="button"
                    className="mt-2 inline-flex h-9 items-center rounded-lg border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-800"
                    onClick={() =>
                      toCsvDownload(
                        `duplicate-preview-${activeBatch.id}.csv`,
                        activeBatch.success_report?.preview_duplicates_csv ?? '',
                      )
                    }
                  >
                    Download Duplicate Preview CSV
                  </button>
                ) : null}

                {activeBatchDuplicateRows.length ? (
                  <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-amber-200 bg-white">
                    <table className="min-w-full text-xs">
                      <thead className="bg-amber-100 text-amber-900">
                        <tr>
                          <th className="px-2 py-1 text-left">Row</th>
                          <th className="px-2 py-1 text-left">EPIC</th>
                          <th className="px-2 py-1 text-left">Type</th>
                          <th className="px-2 py-1 text-left">Incoming</th>
                          <th className="px-2 py-1 text-left">Existing</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeBatchDuplicateRows.slice(0, 200).map((item) => (
                          <tr key={`${item.epic_no}-${item.row}-${item.match_type}`} className="border-t border-amber-100">
                            <td className="px-2 py-1 text-ink-secondary">{item.row}</td>
                            <td className="px-2 py-1 font-medium text-ink">{item.epic_no}</td>
                            <td className="px-2 py-1 text-ink-secondary">{item.match_type === 'exact_duplicate' ? 'Exact Duplicate' : 'Will Update'}</td>
                            <td className="px-2 py-1 text-ink-secondary">
                              {item.incoming_name}
                              <br />
                              DOB: {item.incoming_dob ?? '-'} · Phone: {item.incoming_contact_no_1 ?? '-'}
                              <br />
                              Part: {item.incoming_part_no ?? '-'} · Sec: {item.incoming_section ?? '-'}
                            </td>
                            <td className="px-2 py-1 text-ink-secondary">
                              {item.existing_name ?? '-'}
                              <br />
                              DOB: {item.existing_dob ?? '-'} · Phone: {item.existing_contact_no_1 ?? '-'}
                              <br />
                              Part: {item.existing_part_no ?? '-'} · Sec: {item.existing_section ?? '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                <button
                  type="button"
                  className="mt-3 inline-flex h-10 items-center gap-2 rounded-lg bg-brand-500 px-3 text-sm font-semibold text-white"
                  onClick={() => void confirmCommit(activeBatch)}
                >
                  Confirm and Commit Import
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white p-4">
        <h2 className="text-lg font-semibold text-ink">Import History</h2>
        {loadingBatches ? <p className="mt-2 text-sm text-ink-secondary">Loading history...</p> : null}
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-ink-tertiary">
                <th className="py-2">File</th>
                <th className="py-2">Status</th>
                <th className="py-2">Progress</th>
                <th className="py-2">Rows</th>
                <th className="py-2">Reports</th>
                <th className="py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id} className="border-t border-line">
                  <td className="py-2 text-ink">{batch.file_name}</td>
                  <td className="py-2 capitalize text-ink-secondary">{batch.status.replace('_', ' ')}</td>
                  <td className="py-2 text-ink-secondary">
                    <div>{batch.progress_phase} ({batch.progress_percent}%)</div>
                    {batch.photo_match_report ? (
                      <div className="text-xs text-ink-tertiary">
                        Img: {batch.photo_match_report.processed ?? 0}/{batch.photo_match_report.total ?? batch.photo_match_report.matched_rows ?? 0} · ok {batch.photo_match_report.matched ?? 0} · fail {batch.photo_match_report.failed ?? 0}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 text-ink-secondary">{batch.success_count}/{batch.total_rows} ok · {batch.failed_count} failed</td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-2">
                      {batch.error_report?.csv ? (
                        <button
                          type="button"
                          className="rounded-md border border-line px-2 py-1 text-xs"
                          onClick={() => toCsvDownload(`import-errors-${batch.id}.csv`, batch.error_report?.csv ?? '')}
                        >
                          Errors CSV
                        </button>
                      ) : null}
                      {batch.success_report?.csv ? (
                        <button
                          type="button"
                          className="rounded-md border border-line px-2 py-1 text-xs"
                          onClick={() => toCsvDownload(`import-success-${batch.id}.csv`, batch.success_report?.csv ?? '')}
                        >
                          Success CSV
                        </button>
                      ) : null}
                      {batch.success_report?.preview_duplicates_csv ? (
                        <button
                          type="button"
                          className="rounded-md border border-line px-2 py-1 text-xs"
                          onClick={() => toCsvDownload(`duplicate-preview-${batch.id}.csv`, batch.success_report?.preview_duplicates_csv ?? '')}
                        >
                          Duplicate CSV
                        </button>
                      ) : null}
                      {batch.photo_match_report?.csv ? (
                        <button
                          type="button"
                          className="rounded-md border border-line px-2 py-1 text-xs"
                          onClick={() => toCsvDownload(`photo-report-${batch.id}.csv`, batch.photo_match_report?.csv ?? '')}
                        >
                          Photo CSV
                        </button>
                      ) : null}
                      {batch.success_report?.new_voters_csv ? (
                        <button
                          type="button"
                          className="rounded-md border border-line px-2 py-1 text-xs"
                          onClick={() => toCsvDownload(`new-voters-need-photos-${batch.id}.csv`, batch.success_report?.new_voters_csv ?? '')}
                        >
                          New voters CSV
                        </button>
                      ) : null}
                    </div>
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-2">
                      {batch.status === 'awaiting_confirmation' ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-2 py-1 text-xs font-semibold text-white"
                          onClick={() => void confirmCommit(batch)}
                        >
                          <AlertCircle className="h-3.5 w-3.5" />
                          Confirm
                        </button>
                      ) : null}
                      {batch.status === 'queued' || batch.status === 'running' || batch.status === 'awaiting_confirmation' ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700 disabled:opacity-60"
                          onClick={() => void cancelBatch(batch)}
                          disabled={cancellingBatchId === batch.id}
                        >
                          {cancellingBatchId === batch.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                          Cancel
                        </button>
                      ) : null}
                      {batch.status !== 'awaiting_confirmation' && batch.status !== 'queued' && batch.status !== 'running' ? (
                        <span className="text-xs text-ink-tertiary">-</span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
