import { useState } from 'react'
import toast from 'react-hot-toast'
import * as XLSX from 'xlsx'
import { CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react'
import type { MeetingAttendanceStatus } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { compactLookupValue } from '../../lib/searchUtils'
import { ATTENDANCE_STATUS_OPTIONS } from '../../lib/meetingReport'

export interface EpicExcelImportModalProps {
  title: string
  description?: string
  // Table + row this import links voters into (used for the activity log).
  targetTable: string
  targetId: string
  targetLabel: string
  // Voter ids already present in the target - imported EPICs that resolve to
  // these voters are skipped (never duplicated).
  existingVoterIds: Set<string>
  // When set, voter lookups are restricted to these ward numbers.
  wardRestriction?: number[]
  profileId?: string | null
  // When provided (meetings), a default-status picker is shown before import.
  defaultStatus?: MeetingAttendanceStatus
  // Performs the actual insert (group_members / meeting_invitees). Returns an
  // error message on failure, or null on success.
  onCommit: (rows: Array<{ voter_id: string; epic_no: string }>, status: MeetingAttendanceStatus | null) => Promise<string | null>
  // Called after a successful commit so the parent can reload its data.
  onImported: () => Promise<void>
  onClose: () => void
}

type Phase = 'pick' | 'importing' | 'report'

interface ImportResult {
  added: number
  skipped: number
  notFound: string[]
}

const LOOKUP_CHUNK = 80
const NOT_FOUND_PREVIEW_LIMIT = 100

// Reads the first column of an .xlsx file as a list of EPIC numbers. Values
// are trimmed + uppercased, duplicates within the file are collapsed, and a
// header row like "EPIC" / "EPIC_NO" / "Epic No" is auto-detected and skipped.
function parseEpicFile(file: File): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('file-read-failed'))
    reader.onload = (event) => {
      try {
        const workbook = XLSX.read(event.target?.result, { type: 'array' })
        const sheet = workbook.Sheets[workbook.SheetNames[0]]
        if (!sheet) {
          resolve([])
          return
        }

        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][]
        const epics: string[] = []
        const seen = new Set<string>()

        for (const row of rows) {
          const cell = Array.isArray(row) ? row[0] : undefined
          if (cell === null || cell === undefined) continue
          const raw = String(cell).trim()
          if (!raw) continue

          const value = raw.toUpperCase()
          // Skip a header cell (EPIC / EPIC_NO / Epic No) if it's the very
          // first data-ish cell and contains no digits.
          if (seen.size === 0 && epics.length === 0 && /^EPIC/.test(value) && !/\d/.test(value)) {
            continue
          }

          if (!seen.has(value)) {
            seen.add(value)
            epics.push(value)
          }
        }

        resolve(epics)
      } catch {
        reject(new Error('parse-failed'))
      }
    }
    reader.readAsArrayBuffer(file)
  })
}

export function EpicExcelImportModal({
  title,
  description,
  targetTable,
  targetId,
  targetLabel,
  existingVoterIds,
  wardRestriction,
  profileId,
  defaultStatus,
  onCommit,
  onImported,
  onClose,
}: EpicExcelImportModalProps) {
  const [phase, setPhase] = useState<Phase>('pick')
  const [fileName, setFileName] = useState('')
  const [parsedEpics, setParsedEpics] = useState<string[]>([])
  const [status, setStatus] = useState<MeetingAttendanceStatus>(defaultStatus ?? 'pending')
  const [result, setResult] = useState<ImportResult | null>(null)

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const epics = await parseEpicFile(file)
      setFileName(file.name)
      setParsedEpics(epics)
      if (!epics.length) {
        toast.error('No EPIC numbers found in the file. Put one EPIC per row in column A.')
      }
    } catch {
      toast.error('Could not read that file. Please use an .xlsx file with EPIC numbers in column A.')
      setFileName('')
      setParsedEpics([])
    }
    // Allow re-selecting the same file.
    event.target.value = ''
  }

  const runImport = async () => {
    if (!parsedEpics.length) {
      toast.error('No EPIC numbers to import.')
      return
    }
    setPhase('importing')

    const toAdd: Array<{ voter_id: string; epic_no: string }> = []
    const notFound: string[] = []
    let skipped = 0

    for (let i = 0; i < parsedEpics.length; i += LOOKUP_CHUNK) {
      const chunk = parsedEpics.slice(i, i + LOOKUP_CHUNK)
      let query = supabase.from('voters').select('id, epic_no').in('epic_no', chunk)
      if (wardRestriction && wardRestriction.length > 0) {
        query = query.in('ward_no', wardRestriction)
      }

      const { data, error } = await query
      if (error) {
        toast.error(error.message)
        setPhase('pick')
        return
      }

      const rows = (data ?? []) as Array<{ id: string; epic_no: string }>
      const foundByEpic = new Map<string, string>()
      for (const row of rows) {
        foundByEpic.set(compactLookupValue(row.epic_no), row.id)
      }

      for (const epic of chunk) {
        const voterId = foundByEpic.get(epic)
        if (!voterId) {
          notFound.push(epic)
          continue
        }
        if (existingVoterIds.has(voterId)) {
          skipped += 1
          continue
        }
        toAdd.push({ voter_id: voterId, epic_no: epic })
      }
    }

    const commitError = await onCommit(toAdd, status)
    if (commitError) {
      toast.error(commitError)
      setPhase('pick')
      return
    }

    if (profileId && targetTable && targetId) {
      await supabase.from('activity_logs').insert({
        actor_user_id: profileId,
        action: 'bulk_import',
        target_table: targetTable,
        target_id: targetId,
        details: {
          target_label: targetLabel,
          added: toAdd.length,
          skipped,
          not_found: notFound.length,
          import_status: status,
          epics: toAdd.map((row) => row.epic_no),
          not_found_epics: notFound,
        },
      })
    }

    await onImported()
    setResult({ added: toAdd.length, skipped, notFound })
    setPhase('report')
  }

  const downloadNotFound = () => {
    if (!result?.notFound.length) return
    const worksheet = XLSX.utils.json_to_sheet(result.notFound.map((epic) => ({ EPIC_NO: epic })))
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Not Found')
    XLSX.writeFile(workbook, `not-found-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <FileSpreadsheet className="h-5 w-5 text-brand-600" />
              {title}
            </h3>
            {description ? (
              <p className="mt-1 text-sm text-ink-tertiary">{description}</p>
            ) : null}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {phase === 'importing' ? (
          <div className="flex flex-col items-center justify-center py-14 text-sm text-ink-tertiary">
            <Loader2 className="mb-3 h-6 w-6 animate-spin text-brand-600" />
            Importing voters...
          </div>
        ) : null}

        {phase === 'report' && result ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-center">
                <p className="text-xl font-bold text-emerald-700">{result.added}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600">Added</p>
              </div>
              <div className="rounded-2xl border border-line bg-muted px-4 py-3 text-center">
                <p className="text-xl font-bold text-ink-secondary">{result.skipped}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Skipped</p>
              </div>
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-center">
                <p className="text-xl font-bold text-rose-700">{result.notFound.length}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-rose-600">Not found</p>
              </div>
            </div>

            {result.notFound.length > 0 ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-3">
                <p className="mb-1 text-xs font-semibold text-rose-700">
                  {result.notFound.length} EPIC number(s) not found in the voters table:
                </p>
                <p className="max-h-32 overflow-y-auto break-all text-xs text-rose-600">
                  {result.notFound.slice(0, NOT_FOUND_PREVIEW_LIMIT).join(', ')}
                  {result.notFound.length > NOT_FOUND_PREVIEW_LIMIT ? ` +${result.notFound.length - NOT_FOUND_PREVIEW_LIMIT} more` : ''}
                </p>
                <button
                  type="button"
                  onClick={downloadNotFound}
                  className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl border border-rose-200 bg-white px-3 text-xs font-semibold text-rose-700 transition hover:bg-rose-50"
                >
                  <Download className="h-3.5 w-3.5" /> Download not-found list
                </button>
              </div>
            ) : null}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700"
              >
                <CheckCircle2 className="h-4 w-4" /> Done
              </button>
            </div>
          </div>
        ) : null}

        {phase === 'pick' ? (
          <div className="space-y-4">
            <label
              className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-line bg-muted/60 px-4 py-8 text-center transition hover:border-brand-400 hover:bg-brand-50/40"
            >
              <Upload className="mb-2 h-6 w-6 text-ink-tertiary" />
              <span className="text-sm font-semibold text-ink-secondary">{fileName || 'Choose an .xlsx file'}</span>
              <span className="mt-1 text-xs text-ink-tertiary">One EPIC per row in column A (e.g. ABC1234567).</span>
              <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => void handleFile(e)} />
            </label>

            {parsedEpics.length > 0 ? (
              <div className="rounded-2xl border border-line bg-muted px-4 py-3 text-sm">
                <p className="font-semibold text-ink">{parsedEpics.length} EPIC number(s) found</p>
                <p className="mt-0.5 break-all text-xs text-ink-tertiary">
                  {parsedEpics.slice(0, 6).join(', ')}
                  {parsedEpics.length > 6 ? ` ... +${parsedEpics.length - 6} more` : ''}
                </p>
              </div>
            ) : null}

            {defaultStatus ? (
              <label className="block text-sm text-ink-secondary">
                Default status for imported voters
                <select
                  className="mt-1 h-11 w-full rounded-2xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as MeetingAttendanceStatus)}
                >
                  {ATTENDANCE_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!parsedEpics.length}
                onClick={() => void runImport()}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FileSpreadsheet className="h-4 w-4" /> Import
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
