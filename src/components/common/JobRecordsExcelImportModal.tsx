import { useState } from 'react'
import toast from 'react-hot-toast'
import * as XLSX from 'xlsx'
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react'
import type { JobStatus } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { compactLookupValue } from '../../lib/searchUtils'

export interface JobRecordsExcelImportModalProps {
  title?: string
  description?: string
  // Status applied to every valid imported row. Picked by the user before upload.
  defaultStatus?: JobStatus
  // When set, voter lookups are restricted to these ward numbers.
  wardRestriction?: number[]
  profileId?: string | null
  // Performs the actual job_records insert. Returns an error message on
  // failure, or null on success.
  onCommit: (
    rows: Array<{ voter_id: string; epic_no: string; department_name: string }>,
    status: JobStatus,
  ) => Promise<string | null>
  // Called after a successful commit so the parent can reload its data.
  onImported: () => Promise<void>
  onClose: () => void
}

const JOB_STATUS_OPTIONS: Array<{ value: JobStatus; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'applied_govt', label: 'Applied - Govt' },
  { value: 'applied_private', label: 'Applied - Private' },
  { value: 'appointed_govt', label: 'Appointed - Govt' },
  { value: 'appointed_private', label: 'Appointed - Private' },
]

const LOOKUP_CHUNK = 80
const PREVIEW_LIMIT = 200

type Phase = 'pick' | 'validating' | 'preview' | 'importing' | 'report'

interface RawRow {
  row: number
  epic_no: string
  department: string
}

type RowResult = 'ok' | 'duplicate' | 'not_found' | 'invalid'

interface PreviewRow {
  row: number
  epic_no: string
  voter_name: string
  department: string
  result: RowResult
  reason?: string
  voter_id?: string
}

interface ImportResult {
  total: number
  imported: number
  duplicate: number
  invalid: number
  notFound: number
  notFoundEpics: string[]
}

const EPIC_HEADER_ALIASES = ['EPIC NO', 'EPIC NO.', 'EPIC_NO', 'EPIC ID', 'VOTER ID', 'EPIC', 'ELECTORAL PHOTO IDENTITY CARD']
const DEPARTMENT_HEADER_ALIASES = ['DEPARTMENT NAME', 'DEPARTMENT', 'DEPT NAME', 'DEPT', 'DEPARTMENT_NAME']

function normalizeHeader(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
}

// Reads the EPIC NO + Department Name columns of the first sheet in an .xlsx
// file. Headers are matched via aliases, blank rows are skipped, and values
// are trimmed. EPIC numbers are uppercased so they match the voters table.
function parseJobFile(file: File): Promise<{ rows: RawRow[]; errors: string[] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('file-read-failed'))
    reader.onload = (event) => {
      try {
        const workbook = XLSX.read(event.target?.result, { type: 'array' })
        const sheet = workbook.Sheets[workbook.SheetNames[0]]
        if (!sheet) {
          resolve({ rows: [], errors: ['The workbook does not contain any sheets.'] })
          return
        }

        const all = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][]
        if (!all.length) {
          resolve({ rows: [], errors: ['The workbook is empty.'] })
          return
        }

        const headerRow = all[0].map((value) => normalizeHeader(value))
        let epicIdx = -1
        let deptIdx = -1
        headerRow.forEach((header, index) => {
          if (epicIdx === -1 && EPIC_HEADER_ALIASES.includes(header)) epicIdx = index
          if (deptIdx === -1 && DEPARTMENT_HEADER_ALIASES.includes(header)) deptIdx = index
        })

        if (epicIdx === -1 || deptIdx === -1) {
          const missing: string[] = []
          if (epicIdx === -1) missing.push('EPIC NO')
          if (deptIdx === -1) missing.push('Department Name')
          resolve({
            rows: [],
            errors: [`Missing required column(s): ${missing.join(', ')}. Expected headers "EPIC NO" and "Department Name".`],
          })
          return
        }

        const rows: RawRow[] = []
        for (let i = 1; i < all.length; i += 1) {
          const source = all[i]
          if (!Array.isArray(source)) continue
          const isEntirelyBlank = source.every((cell) => String(cell ?? '').trim() === '')
          if (isEntirelyBlank) continue
          const epicNo = String(source[epicIdx] ?? '').trim().toUpperCase()
          const department = String(source[deptIdx] ?? '').trim().replace(/\s+/g, ' ')
          rows.push({ row: i + 1, epic_no: epicNo, department })
        }

        resolve({ rows, errors: [] })
      } catch {
        reject(new Error('parse-failed'))
      }
    }
    reader.readAsArrayBuffer(file)
  })
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

function resultMeta(result: RowResult): { label: string; className: string } {
  switch (result) {
    case 'ok':
      return { label: 'Valid', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' }
    case 'duplicate':
      return { label: 'Duplicate', className: 'border-amber-200 bg-amber-50 text-amber-700' }
    case 'invalid':
      return { label: 'Invalid', className: 'border-rose-200 bg-rose-50 text-rose-700' }
    case 'not_found':
      return { label: 'Not Found', className: 'border-line bg-muted text-ink-secondary' }
  }
}

export function JobRecordsExcelImportModal({
  title = 'Import Job Records from Excel',
  description = 'Upload an .xlsx file with "EPIC NO" and "Department Name" columns. The selected status is applied to every valid row.',
  defaultStatus = 'pending',
  wardRestriction,
  profileId,
  onCommit,
  onImported,
  onClose,
}: JobRecordsExcelImportModalProps) {
  const [phase, setPhase] = useState<Phase>('pick')
  const [fileName, setFileName] = useState('')
  const [status, setStatus] = useState<JobStatus>(defaultStatus)
  const [rawRows, setRawRows] = useState<RawRow[]>([])
  const [parseErrors, setParseErrors] = useState<string[]>([])
  const [preview, setPreview] = useState<PreviewRow[]>([])
  const [result, setResult] = useState<ImportResult | null>(null)

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const { rows, errors } = await parseJobFile(file)
      setFileName(file.name)
      setRawRows(rows)
      setParseErrors(errors)
      if (errors.length) {
        toast.error(errors[0])
      } else if (!rows.length) {
        toast.error('No data rows found in the file.')
      }
    } catch {
      toast.error('Could not read that file. Please use a valid .xlsx file with "EPIC NO" and "Department Name" columns.')
      setFileName('')
      setRawRows([])
      setParseErrors([])
    }
    // Allow re-selecting the same file.
    event.target.value = ''
  }

  const validateRows = async (rows: RawRow[]): Promise<PreviewRow[] | null> => {
    const previewRows: PreviewRow[] = []
    const seen = new Map<string, number>()
    const toLookup: Array<{ raw: RawRow; compact: string }> = []

    for (const raw of rows) {
      const compact = compactLookupValue(raw.epic_no)
      if (!raw.epic_no || !compact) {
        previewRows.push({ row: raw.row, epic_no: raw.epic_no, voter_name: '', department: raw.department, result: 'invalid', reason: 'EPIC is required.' })
        continue
      }

      if (seen.has(compact)) {
        previewRows.push({
          row: raw.row,
          epic_no: raw.epic_no,
          voter_name: '',
          department: raw.department,
          result: 'duplicate',
          reason: `Duplicate EPIC in file (first seen on row ${seen.get(compact)}).`,
        })
        continue
      }
      seen.set(compact, raw.row)

      if (!raw.department) {
        previewRows.push({ row: raw.row, epic_no: raw.epic_no, voter_name: '', department: raw.department, result: 'invalid', reason: 'Department Name is required.' })
        continue
      }

      toLookup.push({ raw, compact })
    }

    const epicToVoter = new Map<string, { id: string; name: string }>()
    for (let i = 0; i < toLookup.length; i += LOOKUP_CHUNK) {
      const chunk = toLookup.slice(i, i + LOOKUP_CHUNK).map((entry) => entry.compact)
      let query = supabase.from('voters').select('id, epic_no, name').in('epic_no', chunk)
      if (wardRestriction && wardRestriction.length > 0) {
        query = query.in('ward_no', wardRestriction)
      }
      const { data, error } = await query
      if (error) {
        toast.error(error.message)
        return null
      }
      for (const row of (data ?? []) as Array<{ id: string; epic_no: string; name: string }>) {
        epicToVoter.set(compactLookupValue(row.epic_no), { id: row.id, name: row.name })
      }
    }

    for (const entry of toLookup) {
      const voter = epicToVoter.get(entry.compact)
      if (!voter) {
        previewRows.push({
          row: entry.raw.row,
          epic_no: entry.raw.epic_no,
          voter_name: '',
          department: entry.raw.department,
          result: 'not_found',
          reason: 'Voter not found for this EPIC.',
        })
      } else {
        previewRows.push({
          row: entry.raw.row,
          epic_no: entry.raw.epic_no,
          voter_name: voter.name,
          department: entry.raw.department,
          result: 'ok',
          voter_id: voter.id,
        })
      }
    }

    previewRows.sort((a, b) => a.row - b.row)
    return previewRows
  }

  const runValidation = async () => {
    if (!rawRows.length) {
      toast.error('No rows to validate. Choose an .xlsx file first.')
      return
    }
    setPhase('validating')
    const validated = await validateRows(rawRows)
    if (!validated) {
      setPhase('pick')
      return
    }
    setPreview(validated)
    setPhase('preview')
  }

  const runImport = async () => {
    const rowsToImport = preview.filter((row) => row.result === 'ok')
    if (!rowsToImport.length) {
      toast.error('There are no valid rows to import.')
      return
    }
    setPhase('importing')

    const payload = rowsToImport.map((row) => ({
      voter_id: row.voter_id!,
      epic_no: row.epic_no,
      department_name: row.department,
    }))
    const commitError = await onCommit(payload, status)
    if (commitError) {
      toast.error(commitError)
      setPhase('preview')
      return
    }

    const notFoundEpics = preview.filter((row) => row.result === 'not_found').map((row) => row.epic_no)
    const duplicateCount = preview.filter((row) => row.result === 'duplicate').length
    const invalidCount = preview.filter((row) => row.result === 'invalid').length
    const notFoundCount = notFoundEpics.length

    if (profileId) {
      await supabase.from('activity_logs').insert({
        actor_user_id: profileId,
        action: 'bulk_import',
        target_table: 'job_records',
        details: {
          target_label: 'Job Records',
          imported: rowsToImport.length,
          duplicate: duplicateCount,
          invalid: invalidCount,
          not_found: notFoundCount,
          import_status: status,
          epics: payload.map((row) => row.epic_no),
          not_found_epics: notFoundEpics,
        },
      })
    }

    await onImported()
    setResult({
      total: preview.length,
      imported: rowsToImport.length,
      duplicate: duplicateCount,
      invalid: invalidCount,
      notFound: notFoundCount,
      notFoundEpics,
    })
    setPhase('report')
  }

  const downloadErrorReport = () => {
    const errorRows = preview
      .filter((row) => row.result !== 'ok')
      .map((row) => ({
        Row: row.row,
        EPIC_NO: row.epic_no,
        Department: row.department,
        Result: row.result === 'not_found' ? 'Voter Not Found' : row.result === 'duplicate' ? 'Duplicate' : 'Invalid',
        Reason: row.reason ?? '',
      }))
    if (!errorRows.length) return
    toCsvDownload(
      `job-import-errors-${new Date().toISOString().slice(0, 10)}.csv`,
      XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(errorRows)),
    )
  }

  const okCount = preview.filter((row) => row.result === 'ok').length
  const duplicateCount = preview.filter((row) => row.result === 'duplicate').length
  const invalidCount = preview.filter((row) => row.result === 'invalid').length
  const notFoundCount = preview.filter((row) => row.result === 'not_found').length
  const statusLabel = JOB_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white p-6 shadow-2xl">
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

        {phase === 'validating' || phase === 'importing' ? (
          <div className="flex flex-col items-center justify-center py-14 text-sm text-ink-tertiary">
            <Loader2 className="mb-3 h-6 w-6 animate-spin text-brand-600" />
            {phase === 'validating' ? 'Validating Excel data...' : 'Importing job records...'}
          </div>
        ) : null}

        {phase === 'report' && result ? (
          <div className="space-y-4 overflow-y-auto">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div className="rounded-2xl border border-line bg-muted px-4 py-3 text-center">
                <p className="text-xl font-bold text-ink-secondary">{result.total}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Total</p>
              </div>
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-center">
                <p className="text-xl font-bold text-emerald-700">{result.imported}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600">Imported</p>
              </div>
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-center">
                <p className="text-xl font-bold text-amber-700">{result.duplicate}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-600">Duplicate</p>
              </div>
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-center">
                <p className="text-xl font-bold text-rose-700">{result.invalid}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-rose-600">Invalid</p>
              </div>
              <div className="rounded-2xl border border-line bg-muted px-4 py-3 text-center">
                <p className="text-xl font-bold text-ink-secondary">{result.notFound}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Not Found</p>
              </div>
            </div>

            <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-3 text-sm text-emerald-800">
              Imported {result.imported} job record(s) with status "{statusLabel}".
            </div>

            {result.notFoundEpics.length > 0 ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-3">
                <p className="mb-1 text-xs font-semibold text-rose-700">
                  {result.notFoundEpics.length} EPIC number(s) not found in the voters table:
                </p>
                <p className="max-h-32 overflow-y-auto break-all text-xs text-rose-600">
                  {result.notFoundEpics.slice(0, 100).join(', ')}
                  {result.notFoundEpics.length > 100 ? ` +${result.notFoundEpics.length - 100} more` : ''}
                </p>
              </div>
            ) : null}

            {result.duplicate + result.invalid + result.notFound > 0 ? (
              <button
                type="button"
                onClick={downloadErrorReport}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-rose-200 bg-white px-3 text-xs font-semibold text-rose-700 transition hover:bg-rose-50"
              >
                <Download className="h-3.5 w-3.5" /> Download error report
              </button>
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

        {phase === 'preview' ? (
          <div className="flex min-h-0 flex-1 flex-col space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div className="rounded-2xl border border-line bg-muted px-4 py-3 text-center">
                <p className="text-xl font-bold text-ink-secondary">{preview.length}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Total Rows</p>
              </div>
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-center">
                <p className="text-xl font-bold text-emerald-700">{okCount}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600">Valid Rows</p>
              </div>
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-center">
                <p className="text-xl font-bold text-amber-700">{duplicateCount}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-600">Duplicate Rows</p>
              </div>
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-center">
                <p className="text-xl font-bold text-rose-700">{invalidCount}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-rose-600">Invalid Rows</p>
              </div>
              <div className="rounded-2xl border border-line bg-muted px-4 py-3 text-center">
                <p className="text-xl font-bold text-ink-secondary">{notFoundCount}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Not Found</p>
              </div>
            </div>

            <p className="text-sm text-ink-secondary">
              Applying status <span className="font-semibold text-ink">{statusLabel}</span> to every valid row.
            </p>

            <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-muted text-ink-tertiary">
                  <tr>
                    <th className="px-3 py-2 text-left">Row</th>
                    <th className="px-3 py-2 text-left">EPIC NO</th>
                    <th className="px-3 py-2 text-left">Voter Name</th>
                    <th className="px-3 py-2 text-left">Department</th>
                    <th className="px-3 py-2 text-left">Selected Status</th>
                    <th className="px-3 py-2 text-left">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(0, PREVIEW_LIMIT).map((row) => {
                    const meta = resultMeta(row.result)
                    return (
                      <tr key={row.row} className="border-t border-line">
                        <td className="px-3 py-1.5 text-ink-tertiary">{row.row}</td>
                        <td className="px-3 py-1.5 font-mono font-medium text-ink">{row.epic_no || '-'}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{row.voter_name || '-'}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{row.department || '-'}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{statusLabel}</td>
                        <td className="px-3 py-1.5">
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.className}`}>
                            {meta.label}
                          </span>
                          {row.reason ? (
                            <span className="ml-1.5 text-[10px] text-ink-tertiary" title={row.reason}>{row.reason}</span>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {preview.length > PREVIEW_LIMIT ? (
              <p className="text-xs text-ink-tertiary">
                Showing first {PREVIEW_LIMIT} of {preview.length} rows. Use the error report download on the result screen for the full list.
              </p>
            ) : null}

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => { setParseErrors([]); setRawRows([]); setFileName(''); setPhase('pick') }}
                className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
              >
                Back
              </button>
              <div className="flex items-center gap-2">
                {duplicateCount + invalidCount + notFoundCount > 0 ? (
                  <button
                    type="button"
                    onClick={downloadErrorReport}
                    className="inline-flex h-10 items-center gap-2 rounded-xl border border-rose-200 bg-white px-3 text-xs font-semibold text-rose-700 transition hover:bg-rose-50"
                  >
                    <Download className="h-3.5 w-3.5" /> Error report
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={okCount === 0}
                  onClick={() => void runImport()}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FileSpreadsheet className="h-4 w-4" /> Import {okCount} Valid Record{okCount === 1 ? '' : 's'}
                </button>
              </div>
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
              <span className="mt-1 text-xs text-ink-tertiary">Columns: EPIC NO (column A) and Department Name (column B).</span>
              <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => void handleFile(e)} />
            </label>

            {parseErrors.length > 0 ? (
              <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{parseErrors[0]}</span>
              </div>
            ) : null}

            {rawRows.length > 0 ? (
              <div className="rounded-2xl border border-line bg-muted px-4 py-3 text-sm">
                <p className="font-semibold text-ink">{rawRows.length} data row(s) found</p>
                <p className="mt-0.5 break-all text-xs text-ink-tertiary">
                  {rawRows.slice(0, 3).map((row) => `${row.epic_no} → ${row.department}`).join(', ')}
                  {rawRows.length > 3 ? ` ... +${rawRows.length - 3} more` : ''}
                </p>
              </div>
            ) : null}

            <label className="block text-sm text-ink-secondary">
              Job status for all imported records
              <select
                className="mt-1 h-11 w-full rounded-2xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                value={status}
                onChange={(e) => setStatus(e.target.value as JobStatus)}
              >
                {JOB_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

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
                disabled={!rawRows.length || parseErrors.length > 0}
                onClick={() => void runValidation()}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FileSpreadsheet className="h-4 w-4" /> Validate & Preview
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
